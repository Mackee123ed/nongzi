/**
 * 库存管理（需求书第 3 章）。
 *
 * 核心建模决定：出入库记为「带方向的流水」，一行一次出入库
 * （direction + quantity + occurred_at），而不是一行同时挂入库量与出库量。
 * 需求书 3.3 的字段清单是表单的形状，不是数据的形状。流水模型让 3.4 的四种查询
 * 全部退化成一次 GROUP BY，也天然支持按时间段筛选。
 *
 * 实时库存由流水推导（入库合计 − 出库合计），不额外维护冗余列，
 * 因此不存在「流水与库存对不上」的漂移问题。
 */

import { NotFoundError, ValidationError } from '../core/errors.js';
import { applyScope } from '../domain/scope.js';
import { fromCents } from '../domain/money.js';
import { formatDateTime } from '../domain/daterange.js';
import { normalizeRange, rangeToSql } from '../domain/daterange.js';
import {
  requireText, optionalText, requireEnum, optionalEnum, requirePositiveInt,
  optionalInt, optionalDate, optionalMoney, optionalId,
} from '../core/validate.js';

const VARIETY_KINDS = ['active', 'pending'];
const KIND_LABELS = { active: '在营', pending: '待营' };
const NATURES = ['general_agent', 'own'];
const NATURE_LABELS = { general_agent: '总代', own: '自有' };
const DIRECTIONS = ['in', 'out'];
const DIRECTION_LABELS = { in: '入库', out: '出库' };

/** 出入库流水在权限过滤中可绑定的列。 */
const TXN_SCOPE_BINDING = {
  variety: 't.variety_id',
  region: 'd.region_id',
  employee: 't.operator_id',
  self: 't.operator_id',
};

function toVariety(row) {
  return {
    id: row.id,
    kind: row.kind,
    kindLabel: KIND_LABELS[row.kind] ?? row.kind,
    code: row.code,
    name: row.name,
    nature: row.nature,
    natureLabel: row.nature ? (NATURE_LABELS[row.nature] ?? row.nature) : null,
    nationalApprovalNo: row.national_approval_no,
    expectedApprovalYear: row.expected_approval_year,
    suitableTempZone: row.suitable_temp_zone,
    promoRegion: row.promo_region,
    features: row.features,
    packSpec: row.pack_spec,
    pilotPackSpec: row.pilot_pack_spec,
    unitPriceCents: row.unit_price_cents,
    unitPrice: row.unit_price_cents === null ? null : fromCents(row.unit_price_cents),
    tieredRebateNote: row.tiered_rebate_note,
    policy: row.policy,
    createdAt: row.created_at,
  };
}

function toMovement(row) {
  return {
    id: row.id,
    varietyId: row.variety_id,
    varietyName: row.variety_name ?? null,
    varietyCode: row.variety_code ?? null,
    dealerId: row.dealer_id,
    dealerName: row.dealer_name ?? null,
    direction: row.direction,
    directionLabel: DIRECTION_LABELS[row.direction] ?? row.direction,
    quantity: row.quantity,
    unit: row.unit,
    unitPriceCents: row.unit_price_cents,
    amountCents: row.amount_cents,
    occurredAt: row.occurred_at,
    remark: row.remark,
    operatorId: row.operator_id,
    operatorName: row.operator_name ?? null,
    // 来源单据，用于销售出库等跨模块流水的双向追溯（需求书第 9 章）
    sourceType: row.source_type ?? null,
    sourceId: row.source_id ?? null,
    createdAt: row.created_at,
  };
}

export function createInventoryService(db) {
  /** 读取品种行；不存在或超出可见范围一律按「不存在」处理，避免泄漏其它范围的存在性。 */
  async function findVariety(ctx, id) {
    const scope = applyScope(ctx.scope, { variety: 'v.id' });
    const row = await db.one(
      `select v.* from variety v where v.id = ?${scope.sql}`,
      [id, ...scope.params],
    );
    if (!row) throw new NotFoundError('品种不存在或不在您的可见范围内');
    return row;
  }

  async function assertDealerExists(dealerId) {
    if (dealerId === null) return;
    const dealer = await db.one('select id from dealer where id = ?', [dealerId]);
    if (!dealer) throw new NotFoundError('经销商不存在');
  }

  return {
    /** 3.1 / 3.2 品种录入（在营与待营共用，kind 区分）。 */
    async createVariety(ctx, input) {
      const kind = requireEnum(input.kind, '品种类别', VARIETY_KINDS, KIND_LABELS);
      const code = requireText(input.code, '品种编码');
      const name = requireText(input.name, '品种名称');

      // 在营品种必须有品种性质与单价，待营品种这两项尚无意义
      const nature = kind === 'active'
        ? requireEnum(input.nature, '品种性质', NATURES, NATURE_LABELS)
        : optionalEnum(input.nature, '品种性质', NATURES, NATURE_LABELS);

      const unitPriceCents = kind === 'active'
        ? (optionalMoney(input.unitPrice, '单价') ?? 0)
        : optionalMoney(input.unitPrice, '单价');

      const existing = await db.one('select id from variety where code = ?', [code]);
      if (existing) throw new ValidationError(`品种编码 ${code} 已存在`);

      return db.insert('variety', {
        kind,
        code,
        name,
        nature,
        national_approval_no: optionalText(input.nationalApprovalNo, '国审编号'),
        expected_approval_year: optionalInt(input.expectedApprovalYear, '预国审年份'),
        suitable_temp_zone: optionalText(input.suitableTempZone, '适合积温带'),
        promo_region: optionalText(input.promoRegion, '推广区域'),
        features: optionalText(input.features, '品种特点'),
        pack_spec: optionalText(input.packSpec, '包装规格'),
        pilot_pack_spec: optionalText(input.pilotPackSpec, '试点包装规格'),
        unit_price_cents: unitPriceCents,
        tiered_rebate_note: optionalText(input.tieredRebateNote, '阶梯返'),
        policy: optionalText(input.policy, '政策'),
        created_by: ctx.user?.id ?? null,
      });
    },

    /** 修改品种。 */
    async updateVariety(ctx, id, input) {
      await findVariety(ctx, id);
      const patch = {};

      if (input.name !== undefined) patch.name = requireText(input.name, '品种名称');
      if (input.nature !== undefined) patch.nature = optionalEnum(input.nature, '品种性质', NATURES, NATURE_LABELS);
      if (input.nationalApprovalNo !== undefined) patch.national_approval_no = optionalText(input.nationalApprovalNo, '国审编号');
      if (input.expectedApprovalYear !== undefined) patch.expected_approval_year = optionalInt(input.expectedApprovalYear, '预国审年份');
      if (input.suitableTempZone !== undefined) patch.suitable_temp_zone = optionalText(input.suitableTempZone, '适合积温带');
      if (input.promoRegion !== undefined) patch.promo_region = optionalText(input.promoRegion, '推广区域');
      if (input.features !== undefined) patch.features = optionalText(input.features, '品种特点');
      if (input.packSpec !== undefined) patch.pack_spec = optionalText(input.packSpec, '包装规格');
      if (input.pilotPackSpec !== undefined) patch.pilot_pack_spec = optionalText(input.pilotPackSpec, '试点包装规格');
      if (input.unitPrice !== undefined) patch.unit_price_cents = optionalMoney(input.unitPrice, '单价');
      if (input.tieredRebateNote !== undefined) patch.tiered_rebate_note = optionalText(input.tieredRebateNote, '阶梯返');
      if (input.policy !== undefined) patch.policy = optionalText(input.policy, '政策');

      if (Object.keys(patch).length === 0) throw new ValidationError('没有需要更新的字段');
      await db.update('variety', patch, { id });
      return id;
    },

    /** 待营品种转在营（需求书 3.2 的品种最终会投入经营）。 */
    async promoteVariety(ctx, id, input = {}) {
      const row = await findVariety(ctx, id);
      if (row.kind === 'active') throw new ValidationError('该品种已是在营品种');

      const nature = requireEnum(input.nature, '品种性质', NATURES, NATURE_LABELS);
      const unitPriceCents = optionalMoney(input.unitPrice ?? row.unit_price_cents, '单价') ?? 0;

      await db.update('variety', {
        kind: 'active',
        nature,
        unit_price_cents: unitPriceCents,
        pack_spec: input.packSpec !== undefined
          ? optionalText(input.packSpec, '包装规格')
          : row.pack_spec,
      }, { id });
      return id;
    },

    async getVariety(ctx, id) {
      return toVariety(await findVariety(ctx, id));
    },

    /** 按类别列出品种（在营 / 待营 / 全部）。 */
    async listVarieties(ctx, { kind = null, keyword = null } = {}) {
      const scope = applyScope(ctx.scope, { variety: 'v.id' });
      const conditions = ['1=1'];
      const params = [];

      if (kind) {
        conditions.push('v.kind = ?');
        params.push(requireEnum(kind, '品种类别', VARIETY_KINDS, KIND_LABELS));
      }
      if (keyword) {
        conditions.push('(v.name like ? or v.code like ?)');
        params.push(`%${keyword}%`, `%${keyword}%`);
      }

      const rows = await db.query(
        `select v.* from variety v
          where ${conditions.join(' and ')}${scope.sql}
          order by v.code`,
        [...params, ...scope.params],
      );
      return rows.map(toVariety);
    },

    /** 3.3 出入库办理。 */
    async recordMovement(ctx, input) {
      const varietyId = optionalId(input.varietyId, '品种');
      if (!varietyId) throw new ValidationError('品种不能为空');
      await findVariety(ctx, varietyId);

      const direction = requireEnum(input.direction, '出入库方向', DIRECTIONS, DIRECTION_LABELS);
      const quantity = requirePositiveInt(input.quantity, '数量');
      const dealerId = optionalId(input.dealerId, '经销商');
      await assertDealerExists(dealerId);

      const occurredAt = input.occurredAt
        ? formatOccurredAt(input.occurredAt)
        : formatDateTime(new Date());

      const unitPriceCents = optionalMoney(input.unitPrice, '单价');
      const amountCents = input.amount !== undefined
        ? optionalMoney(input.amount, '金额')
        : (unitPriceCents === null ? null : unitPriceCents * quantity);

      return db.insert('inventory_txn', {
        variety_id: varietyId,
        dealer_id: dealerId,
        direction,
        occurred_at: occurredAt,
        quantity,
        unit: optionalText(input.unit, '单位') ?? '袋',
        unit_price_cents: unitPriceCents,
        amount_cents: amountCents,
        source_type: optionalText(input.sourceType, '来源类型'),
        source_id: optionalId(input.sourceId, '来源单据'),
        operator_id: ctx.user?.id ?? null,
        remark: optionalText(input.remark, '备注'),
        created_by: ctx.user?.id ?? null,
      });
    },

    /** 出入库流水明细。 */
    async listMovements(ctx, { from = null, to = null, varietyId = null, dealerId = null } = {}) {
      const range = normalizeRange(from, to);
      const timeFilter = rangeToSql(range, 't.occurred_at');
      const scope = applyScope(ctx.scope, TXN_SCOPE_BINDING);

      const conditions = [];
      const params = [];
      if (timeFilter.sql) { conditions.push(timeFilter.sql); params.push(...timeFilter.params); }
      if (varietyId) { conditions.push('t.variety_id = ?'); params.push(Number(varietyId)); }
      if (dealerId) { conditions.push('t.dealer_id = ?'); params.push(Number(dealerId)); }

      const where = conditions.length ? ` and ${conditions.join(' and ')}` : '';
      const rows = await db.query(
        `select t.*, v.name as variety_name, v.code as variety_code,
                d.company_name as dealer_name, e.name as operator_name
           from inventory_txn t
           join variety v on v.id = t.variety_id
           left join dealer d on d.id = t.dealer_id
           left join employee e on e.id = t.operator_id
          where 1=1${where}${scope.sql}
          order by t.occurred_at desc, t.id desc`,
        [...params, ...scope.params],
      );
      return rows.map(toMovement);
    },

    /**
     * 3.3 实时库存 = 入库合计 − 出库合计。
     * 由流水推导而非维护冗余列，因此不存在与流水对不上的可能。
     */
    async getStock(ctx, { varietyId }) {
      const scope = applyScope(ctx.scope, TXN_SCOPE_BINDING);
      const variety = await findVariety(ctx, varietyId);

      const totals = await db.one(
        `select
           coalesce(sum(case when t.direction = 'in' then t.quantity else 0 end), 0) as total_in,
           coalesce(sum(case when t.direction = 'out' then t.quantity else 0 end), 0) as total_out
         from inventory_txn t
         left join dealer d on d.id = t.dealer_id
        where t.variety_id = ?${scope.sql}`,
        [varietyId, ...scope.params],
      );

      const byDealer = await db.query(
        `select t.dealer_id, d.company_name as dealer_name,
                coalesce(sum(case when t.direction = 'in' then t.quantity else 0 end), 0) as total_in,
                coalesce(sum(case when t.direction = 'out' then t.quantity else 0 end), 0) as total_out
           from inventory_txn t
           left join dealer d on d.id = t.dealer_id
          where t.variety_id = ?${scope.sql}
          group by t.dealer_id, d.company_name`,
        [varietyId, ...scope.params],
      );

      const totalIn = Number(totals.total_in);
      const totalOut = Number(totals.total_out);

      return {
        varietyId,
        varietyName: variety.name,
        varietyCode: variety.code,
        unit: '袋',
        totalIn,
        totalOut,
        quantity: totalIn - totalOut,
        byDealer: byDealer.map((r) => ({
          dealerId: r.dealer_id,
          dealerName: r.dealer_name ?? '未指定经销商',
          totalIn: Number(r.total_in),
          totalOut: Number(r.total_out),
          quantity: Number(r.total_in) - Number(r.total_out),
        })),
      };
    },

    /**
     * 3.4 库存查询（按时间段）。四种问法共用一条聚合语句：
     *   ① 单一品种的总出入库        → 传 varietyId
     *   ② 单一品种的某经销商出入库  → 传 varietyId + dealerId
     *   ③ 某代理商的所有品种出入库  → 传 dealerId
     *   ④ 所有品种的出入库          → 都不传
     */
    async movementsReport(ctx, { from = null, to = null, varietyId = null, dealerId = null, dimension = null } = {}) {
      const range = normalizeRange(from, to);
      const timeFilter = rangeToSql(range, 't.occurred_at');
      const scope = applyScope(ctx.scope, TXN_SCOPE_BINDING);

      const conditions = [];
      const params = [];
      if (timeFilter.sql) { conditions.push(timeFilter.sql); params.push(...timeFilter.params); }
      if (varietyId) { conditions.push('t.variety_id = ?'); params.push(Number(varietyId)); }
      if (dealerId) { conditions.push('t.dealer_id = ?'); params.push(Number(dealerId)); }

      const where = conditions.length ? ` and ${conditions.join(' and ')}` : '';

      // 指定了经销商或按经销商拆解时，按「品种 + 经销商」分组；否则只按品种汇总
      const groupByDealer = Boolean(dealerId) || dimension === 'dealer';
      const groupColumns = groupByDealer
        ? 't.variety_id, v.name, v.code, t.dealer_id, d.company_name'
        : 't.variety_id, v.name, v.code';

      const rows = await db.query(
        `select t.variety_id,
                v.name as variety_name,
                v.code as variety_code,
                ${groupByDealer ? 't.dealer_id,' : 'null as dealer_id,'}
                ${groupByDealer ? 'd.company_name as dealer_name,' : 'null as dealer_name,'}
                coalesce(sum(case when t.direction = 'in' then t.quantity else 0 end), 0) as total_in,
                coalesce(sum(case when t.direction = 'out' then t.quantity else 0 end), 0) as total_out
           from inventory_txn t
           join variety v on v.id = t.variety_id
           left join dealer d on d.id = t.dealer_id
          where 1=1${where}${scope.sql}
          group by ${groupColumns}
          order by v.code${groupByDealer ? ', d.company_name' : ''}`,
        [...params, ...scope.params],
      );

      const mapped = rows.map((r) => {
        const totalIn = Number(r.total_in);
        const totalOut = Number(r.total_out);
        return {
          varietyId: r.variety_id,
          varietyName: r.variety_name,
          varietyCode: r.variety_code,
          dealerId: r.dealer_id,
          dealerName: r.dealer_name,
          totalIn,
          totalOut,
          balance: totalIn - totalOut,
        };
      });

      return {
        rows: mapped,
        totals: {
          totalIn: mapped.reduce((s, r) => s + r.totalIn, 0),
          totalOut: mapped.reduce((s, r) => s + r.totalOut, 0),
          balance: mapped.reduce((s, r) => s + r.balance, 0),
        },
        range: { from: range.from, to: range.toExclusive },
      };
    },

    /** 全部品种的实时库存汇总，供库存总览页使用。 */
    async stockOverview(ctx) {
      const scope = applyScope(ctx.scope, TXN_SCOPE_BINDING);
      const rows = await db.query(
        `select v.id as variety_id, v.code, v.name, v.kind,
                coalesce(sum(case when t.direction = 'in' then t.quantity else 0 end), 0) as total_in,
                coalesce(sum(case when t.direction = 'out' then t.quantity else 0 end), 0) as total_out
           from variety v
           left join inventory_txn t on t.variety_id = v.id
           left join dealer d on d.id = t.dealer_id
          where 1=1${scope.sql}
          group by v.id, v.code, v.name, v.kind
          order by v.code`,
        [...scope.params],
      );

      return rows.map((r) => ({
        varietyId: r.variety_id,
        code: r.code,
        name: r.name,
        kind: r.kind,
        kindLabel: KIND_LABELS[r.kind] ?? r.kind,
        totalIn: Number(r.total_in),
        totalOut: Number(r.total_out),
        quantity: Number(r.total_in) - Number(r.total_out),
      }));
    },
  };
}

/** 把 'YYYY-MM-DD' 或 'YYYY-MM-DD HH:MM:SS' 规范为存储格式。 */
function formatOccurredAt(value) {
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text} 00:00:00`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text)) {
    return text.length === 16 ? `${text}:00` : text;
  }
  throw new ValidationError('出入库时间格式不正确');
}
