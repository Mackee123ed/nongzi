/**
 * 销售管理（需求书第 5 章）。
 *
 * 本模块是跨模块联动的枢纽（需求书第 9 章）：
 *   - 品种名称及编码从库存管理抓取（sales_order_item → variety 外键）
 *   - 经销商名称及编码及电话从客户管理抓取（sales_order → dealer 外键）
 *   - 销售确认时自动写出库流水，实时库存随之减少
 *   - 可选地自动生成「销售收入」财务流水
 *
 * ★ 上述写入全部在同一次 db.tx 内完成。半张销售单、或「扣了库存却没记账」
 *   这类问题在财务系统里是不可接受的，事务是唯一的保证手段。
 */

import { NotFoundError, ValidationError, PermissionError } from '../core/errors.js';
import { applyScope } from '../domain/scope.js';
import { fromCents, mulQty } from '../domain/money.js';
import { normalizeDateRange, dateRangeToSql, formatDateTime } from '../domain/daterange.js';
import {
  requireText, optionalText, requirePositiveInt, requireDate,
  requireMoney, optionalMoney, optionalId, requireEnum,
} from '../core/validate.js';

const STATUS_LABELS = { draft: '草稿', confirmed: '已确认', voided: '已作废' };

const ORDER_SCOPE_BINDING = {
  region: 'd.region_id',
  employee: 'o.operator_id',
  self: 'o.operator_id',
};

const LINE_SCOPE_BINDING = {
  variety: 'i.variety_id',
  region: 'd.region_id',
  employee: 'o.operator_id',
  self: 'o.operator_id',
};

function toOrder(row) {
  return {
    id: row.id,
    orderNo: row.order_no,
    dealerId: row.dealer_id,
    dealerName: row.dealer_name ?? null,
    dealerCode: row.dealer_code ?? null,
    dealerPhone: row.dealer_phone ?? null,
    dealerRegionId: row.dealer_region_id ?? null,
    orderDate: row.order_date,
    totalAmountCents: row.total_amount_cents,
    totalAmount: fromCents(row.total_amount_cents),
    totalRebateCents: row.total_rebate_cents,
    totalRebate: fromCents(row.total_rebate_cents),
    status: row.status,
    statusLabel: STATUS_LABELS[row.status] ?? row.status,
    operatorId: row.operator_id,
    operatorName: row.operator_name ?? null,
    remark: row.remark,
    createdAt: row.created_at,
  };
}

function toOrderLine(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    varietyId: row.variety_id,
    varietyName: row.variety_name ?? null,
    varietyCode: row.variety_code ?? null,
    quantity: row.quantity,
    unit: row.unit ?? '袋',
    unitPriceCents: row.unit_price_cents,
    unitPrice: fromCents(row.unit_price_cents),
    amountCents: row.amount_cents,
    amount: fromCents(row.amount_cents),
    rebateCents: row.rebate_cents,
    rebate: fromCents(row.rebate_cents),
  };
}

/** 销售单明细的公共查询片段。 */
const LINE_SELECT = `
  select i.*, v.name as variety_name, v.code as variety_code,
         o.order_no, o.order_date, o.status, o.dealer_id, o.operator_id,
         d.company_name as dealer_name, d.code as dealer_code
    from sales_order_item i
    join sales_order o on o.id = i.order_id
    join variety v on v.id = i.variety_id
    left join dealer d on d.id = o.dealer_id
`;

export function createSalesService(db, { financeService = null } = {}) {
  /** 校验品种存在；在校验期间还要拿到当前库存，故接受任意执行器（db 或事务句柄 t）。 */
  async function loadVariety(exec, id) {
    const row = await exec.one('select * from variety where id = ?', [id]);
    if (!row) throw new ValidationError(`品种不存在（编号 ${id}）`);
    return row;
  }

  /**
   * 写入时的管辖校验：仅当该用户确实有分管区域时才限制其可选经销商。
   *
   * 数据可见范围（读）与可操作范围（写）不是一回事：L3 是操作层，
   * 本身没有分管区域，若照搬读范围过滤，他会连一个经销商都选不到、无法开单。
   * 因此这里只在存在区域管辖时收紧；L1 与 L3 均不做区域限制。
   */
  function regionWriteFilter(scope) {
    if (scope?.kind === 'scoped' && scope.regionIds?.length > 0) {
      return applyScope(scope, { region: 'd.region_id' });
    }
    return { sql: '', params: [] };
  }

  async function loadDealer(exec, id, scope) {
    if (!id) throw new ValidationError('经销商不能为空');
    const filter = regionWriteFilter(scope);
    const row = await exec.one(
      `select d.* from dealer d where d.id = ?${filter.sql}`,
      [id, ...filter.params],
    );
    if (!row) {
      // 区分「不存在」与「不在管辖范围内」，但都不泄漏对方的存在性
      const exists = await exec.one('select id from dealer where id = ?', [id]);
      if (exists) throw new PermissionError('该经销商不在您的管辖范围内');
      throw new ValidationError('经销商不存在');
    }
    return row;
  }

  /** 当前实时库存 = 入库合计 − 出库合计。 */
  async function currentStock(exec, varietyId) {
    const row = await exec.one(
      `select coalesce(sum(case when direction = 'in' then quantity else 0 end), 0) as total_in,
              coalesce(sum(case when direction = 'out' then quantity else 0 end), 0) as total_out
         from inventory_txn where variety_id = ?`,
      [varietyId],
    );
    return Number(row.total_in) - Number(row.total_out);
  }

  async function nextOrderNo(exec, orderDate) {
    const prefix = `SO${orderDate.replace(/-/g, '')}`;
    const row = await exec.one(
      'select count(*) as c from sales_order where order_no like ?',
      [`${prefix}%`],
    );
    return `${prefix}${String(Number(row.c) + 1).padStart(3, '0')}`;
  }

  return {
    /**
     * 5.1 销售单录入。
     * 单头 + 明细 + 出库流水（+ 可选收入流水）在同一个事务内写入。
     */
    async createOrder(ctx, input) {
      const dealerId = optionalId(input.dealerId, '经销商');
      const orderDate = requireDate(input.orderDate, '销售日期');
      const items = Array.isArray(input.items) ? input.items : [];
      if (items.length === 0) throw new ValidationError('销售明细不能为空');

      const rawOrderNo = optionalText(input.orderNo, '订单号');
      const allowNegativeStock = input.allowNegativeStock === true;
      const operatorId = ctx.user?.id ?? null;

      return db.tx(async (t) => {
        await loadDealer(t, dealerId, ctx.scope);

        const orderNo = rawOrderNo ?? await nextOrderNo(t, orderDate);
        const duplicate = await t.one('select id from sales_order where order_no = ?', [orderNo]);
        if (duplicate) throw new ValidationError(`订单号 ${orderNo} 已存在`);

        // 先把整单校验并算完，任何一处不合法都在写入之前失败
        const prepared = [];
        const requiredByVariety = new Map();

        for (const item of items) {
          const varietyId = optionalId(item.varietyId, '品种');
          if (!varietyId) throw new ValidationError('品种不能为空');
          const variety = await loadVariety(t, varietyId);

          const quantity = requirePositiveInt(item.quantity, '销售数量');
          const unitPriceCents = requireMoney(item.unitPrice, '销售单价');
          const rebateCents = optionalMoney(item.rebate, '返利金额') ?? 0;

          requiredByVariety.set(
            varietyId,
            (requiredByVariety.get(varietyId) ?? 0) + quantity,
          );

          prepared.push({
            varietyId,
            varietyName: variety.name,
            quantity,
            unit: optionalText(item.unit, '单位') ?? '袋',
            unitPriceCents,
            amountCents: mulQty(unitPriceCents, quantity),
            rebateCents,
          });
        }

        if (!allowNegativeStock) {
          for (const [varietyId, needed] of requiredByVariety) {
            const available = await currentStock(t, varietyId);
            if (available < needed) {
              const name = prepared.find((p) => p.varietyId === varietyId).varietyName;
              throw new ValidationError(
                `品种「${name}」库存不足：当前库存 ${available}，本单需要 ${needed}。`
                + '如确需超卖，请在录入时选择「允许库存为负」。',
              );
            }
          }
        }

        const totalAmountCents = prepared.reduce((s, p) => s + p.amountCents, 0);
        const totalRebateCents = prepared.reduce((s, p) => s + p.rebateCents, 0);

        const orderId = await t.insert('sales_order', {
          order_no: orderNo,
          dealer_id: dealerId,
          order_date: orderDate,
          total_amount_cents: totalAmountCents,
          total_rebate_cents: totalRebateCents,
          status: 'confirmed',
          operator_id: operatorId,
          remark: optionalText(input.remark, '备注'),
          created_by: operatorId,
        });

        for (const line of prepared) {
          await t.insert('sales_order_item', {
            order_id: orderId,
            variety_id: line.varietyId,
            quantity: line.quantity,
            unit_price_cents: line.unitPriceCents,
            amount_cents: line.amountCents,
            rebate_cents: line.rebateCents,
          });

          // 需求书 9：销售与库存联动。出库流水与销售单同事务写入。
          await t.insert('inventory_txn', {
            variety_id: line.varietyId,
            dealer_id: dealerId,
            direction: 'out',
            occurred_at: `${orderDate} 00:00:00`,
            quantity: line.quantity,
            unit: line.unit,
            unit_price_cents: line.unitPriceCents,
            amount_cents: line.amountCents,
            source_type: 'sale',
            source_id: orderId,
            operator_id: operatorId,
            remark: `销售单 ${orderNo} 出库`,
            created_by: operatorId,
          });
        }

        // 需求书 9：财务管理 ↔ 销售。按设置决定是否自动生成销售收入流水。
        if (financeService?.createFlowInTx) {
          const setting = await t.one(
            'select setting_value from app_setting where setting_key = ?',
            ['auto_create_income_on_sale'],
          );
          const enabled = !setting || setting.setting_value === '1';
          if (enabled && totalAmountCents > 0) {
            await financeService.createFlowInTx(t, {
              kind: 'income',
              categoryCode: 'sales_income',
              occurredAt: `${orderDate} 00:00:00`,
              name: `销售收入 - 销售单 ${orderNo}`,
              amountCents: totalAmountCents,
              dealerId,
              sourceType: 'sale',
              sourceId: orderId,
              operatorId,
            });
          }
        }

        return orderId;
      });
    },

    /** 作废销售单：置状态，并以反向入库流水冲回库存。 */
    async voidOrder(ctx, id, reason = null) {
      return db.tx(async (t) => {
        const order = await this._findOrderRow(t, ctx, id);
        if (order.status === 'voided') throw new ValidationError('该销售单已作废，不能重复作废');

        const lines = await t.query('select * from sales_order_item where order_id = ?', [id]);
        const operatorId = ctx.user?.id ?? null;

        for (const line of lines) {
          await t.insert('inventory_txn', {
            variety_id: line.variety_id,
            dealer_id: order.dealer_id,
            direction: 'in',
            occurred_at: formatDateTime(new Date()),
            quantity: line.quantity,
            unit: '袋',
            unit_price_cents: line.unit_price_cents,
            amount_cents: line.amount_cents,
            source_type: 'sale',
            source_id: id,
            operator_id: operatorId,
            remark: `销售单 ${order.order_no} 作废冲回${reason ? `：${reason}` : ''}`,
            created_by: operatorId,
          });
        }

        await t.update('sales_order', { status: 'voided', remark: reason ?? order.remark }, { id });
        return true;
      });
    },

    /** 内部：按主键取单头并施加权限范围。 */
    async _findOrderRow(exec, ctx, id) {
      const filter = applyScope(ctx.scope, ORDER_SCOPE_BINDING);
      const row = await exec.one(
        `select o.* from sales_order o
           left join dealer d on d.id = o.dealer_id
          where o.id = ?${filter.sql}`,
        [id, ...filter.params],
      );
      if (!row) throw new NotFoundError('销售单不存在或不在您的可见范围内');
      return row;
    },

    async getOrder(ctx, id) {
      const row = await db.one(
        `select o.*, d.company_name as dealer_name, d.code as dealer_code,
                d.phone as dealer_phone, d.region_id as dealer_region_id,
                e.name as operator_name
           from sales_order o
           left join dealer d on d.id = o.dealer_id
           left join employee e on e.id = o.operator_id
          where o.id = ?`,
        [id],
      );
      if (!row) throw new NotFoundError('销售单不存在');

      // 单头通过后再校验一次范围，避免绕过列表过滤直接按 id 取到越权单据
      await this._findOrderRow(db, ctx, id);

      const items = await db.query(
        `select i.*, v.name as variety_name, v.code as variety_code
           from sales_order_item i
           join variety v on v.id = i.variety_id
          where i.order_id = ?
          order by i.id`,
        [id],
      );

      return { ...toOrder(row), items: items.map(toOrderLine) };
    },

    async listOrders(ctx, { from = null, to = null, dealerId = null, status = null } = {}) {
      const range = normalizeDateRange(from, to);
      const timeFilter = dateRangeToSql(range, 'o.order_date');
      const filter = applyScope(ctx.scope, ORDER_SCOPE_BINDING);

      const conditions = [];
      const params = [];
      if (timeFilter.sql) { conditions.push(timeFilter.sql); params.push(...timeFilter.params); }
      if (dealerId) { conditions.push('o.dealer_id = ?'); params.push(Number(dealerId)); }
      if (status) { conditions.push('o.status = ?'); params.push(status); }

      const where = conditions.length ? ` and ${conditions.join(' and ')}` : '';
      const rows = await db.query(
        `select o.*, d.company_name as dealer_name, d.code as dealer_code,
                d.phone as dealer_phone, e.name as operator_name
           from sales_order o
           left join dealer d on d.id = o.dealer_id
           left join employee e on e.id = o.operator_id
          where 1=1${where}${filter.sql}
          order by o.order_date desc, o.id desc`,
        [...params, ...filter.params],
      );
      return rows.map(toOrder);
    },

    /**
     * 5.2 销售查询（按时间段）。
     *
     * 需求书列出 8 种问法，实际只由三个参数决定：
     *   varietyId / dealerId  → 过滤条件（按品种还是按经销商，就是看传了哪个）
     *   mode = detail | summary → 要明细还是汇总
     *   dimension             → 汇总时按哪个维度分行
     * 因此用一个方法覆盖全部 8 种组合，而不是写 8 段几乎相同的 SQL。
     */
    async salesReport(ctx, {
      from = null, to = null, varietyId = null, dealerId = null,
      mode = 'detail', dimension = null,
    } = {}) {
      const range = normalizeDateRange(from, to);
      const timeFilter = dateRangeToSql(range, 'o.order_date');
      const filter = applyScope(ctx.scope, LINE_SCOPE_BINDING);

      const conditions = ["o.status = 'confirmed'"];
      const params = [];
      if (timeFilter.sql) { conditions.push(timeFilter.sql); params.push(...timeFilter.params); }
      if (varietyId) { conditions.push('i.variety_id = ?'); params.push(Number(varietyId)); }
      if (dealerId) { conditions.push('o.dealer_id = ?'); params.push(Number(dealerId)); }

      const where = ` and ${conditions.join(' and ')}`;
      const allParams = [...params, ...filter.params];

      if (mode === 'summary') {
        const groupByDealer = dimension === 'dealer' || (!dimension && Boolean(varietyId) && !dealerId);
        const groupColumns = groupByDealer
          ? 'i.variety_id, v.name, v.code, o.dealer_id, d.company_name, d.code'
          : 'i.variety_id, v.name, v.code';

        const rows = await db.query(
          `select i.variety_id, v.name as variety_name, v.code as variety_code,
                  ${groupByDealer ? 'o.dealer_id,' : 'null as dealer_id,'}
                  ${groupByDealer ? 'd.company_name as dealer_name,' : 'null as dealer_name,'}
                  ${groupByDealer ? 'd.code as dealer_code,' : 'null as dealer_code,'}
                  sum(i.quantity) as total_quantity,
                  sum(i.amount_cents) as total_amount_cents,
                  sum(i.rebate_cents) as total_rebate_cents,
                  count(distinct o.id) as order_count
             from sales_order_item i
             join sales_order o on o.id = i.order_id
             join variety v on v.id = i.variety_id
             left join dealer d on d.id = o.dealer_id
            where 1=1${where}${filter.sql}
            group by ${groupColumns}
            order by v.code${groupByDealer ? ', d.company_name' : ''}`,
          allParams,
        );

        const mapped = rows.map((r) => ({
          varietyId: r.variety_id,
          varietyName: r.variety_name,
          varietyCode: r.variety_code,
          dealerId: r.dealer_id,
          dealerName: r.dealer_name,
          dealerCode: r.dealer_code,
          totalQuantity: Number(r.total_quantity),
          totalAmountCents: Number(r.total_amount_cents),
          totalAmount: fromCents(r.total_amount_cents),
          totalRebateCents: Number(r.total_rebate_cents),
          totalRebate: fromCents(r.total_rebate_cents),
          orderCount: Number(r.order_count),
        }));

        return {
          mode: 'summary',
          rows: mapped,
          totals: {
            totalQuantity: mapped.reduce((s, r) => s + r.totalQuantity, 0),
            totalAmountCents: mapped.reduce((s, r) => s + r.totalAmountCents, 0),
            totalRebateCents: mapped.reduce((s, r) => s + r.totalRebateCents, 0),
            orderCount: mapped.reduce((s, r) => s + r.orderCount, 0),
          },
          range: { from: range.from, to: range.toExclusive },
        };
      }

      const rows = await db.query(
        `${LINE_SELECT}
          where 1=1${where}${filter.sql}
          order by o.order_date desc, o.id desc, i.id`,
        allParams,
      );

      const mapped = rows.map((r) => ({
        ...toOrderLine(r),
        orderNo: r.order_no,
        orderDate: r.order_date,
        dealerId: r.dealer_id,
        dealerName: r.dealer_name,
        dealerCode: r.dealer_code,
      }));

      return {
        mode: 'detail',
        rows: mapped,
        totals: {
          totalQuantity: mapped.reduce((s, r) => s + r.quantity, 0),
          totalAmountCents: mapped.reduce((s, r) => s + r.amountCents, 0),
          totalRebateCents: mapped.reduce((s, r) => s + r.rebateCents, 0),
        },
        range: { from: range.from, to: range.toExclusive },
      };
    },
  };
}
