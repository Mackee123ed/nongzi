/**
 * 财务管理（需求书 4.1 ~ 4.5，跨模块联动见需求书 9）。
 *
 * 核心建模决定：
 *   - 收入与支出共用 finance_flow 一张表，用 kind 区分。两者的字段完全相同
 *     （时间、名称、金额 + 可选的账户/经销商/分类），分表只会让
 *     「按时间段收支明细」「账户余额 = 期初 + 收 − 支」这类查询变成两表 UNION。
 *   - 4.5 的成本子项（采购价格/运输费用/制种费用/加工费用）不落成四个列，
 *     而是 finance_flow_component 的若干行。子项集合会随业务变化，列会越加越多，
 *     而「明细合计 = 流水金额」这条不变式用行模型表达最直接。
 *   - 金额一律整数「分」，对外同时给出 fromCents 格式化的元字符串。
 *
 * 权限（需求书 2.2）：finance_flow 自身没有区域列，区域维度必须经经销商绑定
 * （LEFT JOIN dealer d → d.region_id），人员维度绑定经办人。
 */

import { NotFoundError, ValidationError } from '../core/errors.js';
import { applyScope } from '../domain/scope.js';
import { fromCents, sumCents } from '../domain/money.js';
import { formatDateTime, normalizeRange, rangeToSql } from '../domain/daterange.js';
import {
  requireText, optionalText, requireEnum, optionalEnum, requireMoney, optionalMoney, optionalId,
} from '../core/validate.js';

const FLOW_KINDS = ['income', 'expense'];
const KIND_LABELS = { income: '收入', expense: '支出' };

/** 需求书 9 约定的来源类型：流水可回指产生它的业务单据。 */
const SOURCE_TYPES = ['manual', 'sale', 'inventory', 'salary', 'social_insurance', 'purchase', 'other'];
const SOURCE_TYPE_LABELS = {
  manual: '手工录入',
  sale: '销售单',
  inventory: '出入库',
  salary: '工资',
  social_insurance: '社保',
  purchase: '采购',
  other: '其它',
};

/**
 * 费用明细子项。顺序即展示顺序，与迁移种入的 finance_component.sort_order 一致。
 * 名称在此冗余一份，是为了让校验失败的中文提示不依赖数据库读取（错误提示要能离线生成）。
 */
const COMPONENT_CODES = ['purchase_price', 'transport_fee', 'seed_production_fee', 'processing_fee'];
const COMPONENT_LABELS = {
  purchase_price: '采购价格',
  transport_fee: '运输费用',
  seed_production_fee: '制种费用',
  processing_fee: '加工费用',
};

/**
 * 明细入参的键：既接受前端字段名（purchasePrice），也接受组件编码（purchase_price）。
 * 跨模块调用方（销售、工资）手里往往只有编码，没必要再让它们记一套驼峰别名。
 */
const COMPONENT_FIELDS = {
  purchasePrice: 'purchase_price',
  transportFee: 'transport_fee',
  seedProductionFee: 'seed_production_fee',
  processingFee: 'processing_fee',
};

/** 未指定分类时按收支方向各归入「其他」一类，表单只填名称金额也能落账。 */
const DEFAULT_CATEGORY_CODE = { income: 'other_income', expense: 'other_expense' };

/** 未指定账户时归入迁移种入的默认账户，见 resolveAccountId 的说明。 */
const DEFAULT_ACCOUNT_CODE = 'default';

const FLOW_NO_PREFIX = { income: 'SR', expense: 'ZC' };

/**
 * 流水的权限绑定：区域经经销商，人员绑经办人。
 * self 与 employee 指向同一列，是为了同时覆盖 L3（selfOnly，只绑 self）
 * 与 L2（按本人及下属员工集合，只绑 employee）。
 */
const FLOW_SCOPE_BINDING = {
  region: 'd.region_id',
  employee: 'f.operator_id',
  self: 'f.operator_id',
};

/** 流水查询的公共 FROM：一并取出展示用的分类、经销商、账户、经办人名称。 */
const FLOW_FROM = `
  from finance_flow f
  join finance_category c on c.id = f.category_id
  left join dealer d on d.id = f.dealer_id
  left join account a on a.id = f.account_id
  left join employee e on e.id = f.operator_id`;

const placeholders = (n) => Array.from({ length: n }, () => '?').join(', ');

function toFlow(row, componentRows = []) {
  const components = componentRows.map((c) => ({
    code: c.component_code,
    name: c.component_name ?? COMPONENT_LABELS[c.component_code] ?? c.component_code,
    amountCents: Number(c.amount_cents),
    amount: fromCents(c.amount_cents),
  }));

  return {
    id: row.id,
    flowNo: row.flow_no,
    kind: row.kind,
    kindLabel: KIND_LABELS[row.kind] ?? row.kind,
    categoryId: row.category_id,
    categoryCode: row.category_code ?? null,
    categoryName: row.category_name ?? null,
    hasDetail: Boolean(row.has_detail),
    occurredAt: row.occurred_at,
    name: row.name,
    amountCents: Number(row.amount_cents),
    amount: fromCents(row.amount_cents),
    accountId: row.account_id,
    accountName: row.account_name ?? null,
    dealerId: row.dealer_id,
    dealerName: row.dealer_name ?? null,
    sourceType: row.source_type,
    sourceId: row.source_id,
    operatorId: row.operator_id,
    operatorName: row.operator_name ?? null,
    remark: row.remark ?? null,
    components,
    componentsTotalCents: sumCents(components, (c) => c.amountCents),
    createdAt: row.created_at,
  };
}

function toAccountBalance(account, sums) {
  const openingBalanceCents = Number(account.opening_balance_cents ?? 0);
  const totalIncomeCents = Number(sums?.income_cents ?? 0);
  const totalExpenseCents = Number(sums?.expense_cents ?? 0);
  const balanceCents = openingBalanceCents + totalIncomeCents - totalExpenseCents;

  return {
    accountId: account.id,
    code: account.code,
    name: account.name,
    type: account.type,
    openingBalanceCents,
    openingBalance: fromCents(openingBalanceCents),
    totalIncomeCents,
    totalIncome: fromCents(totalIncomeCents),
    totalExpenseCents,
    totalExpense: fromCents(totalExpenseCents),
    balanceCents,
    balance: fromCents(balanceCents),
  };
}

/** 把 'YYYY-MM-DD' 或 'YYYY-MM-DD HH:MM:SS' 规范为存储格式。 */
function formatOccurredAt(value) {
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text} 00:00:00`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text)) {
    return text.length === 16 ? `${text}:00` : text;
  }
  throw new ValidationError('收支时间格式不正确');
}

/**
 * 金额归一到整数「分」。
 * 对外接口（recordIncome / recordExpense）收前端提交的「元」字符串；
 * 进程内的跨模块调用方（销售、工资）手里已经是整数「分」。
 * 两种单位在此收敛，避免同一个字段在不同调用点含义不同。
 */
function resolveAmountCents(input, label) {
  const raw = input.amountCents;
  if (raw !== undefined && raw !== null && raw !== '') {
    const cents = Number(raw);
    if (!Number.isInteger(cents)) throw new ValidationError(`${label}必须是整数分`);
    return cents;
  }
  return requireMoney(input.amount, label);
}

/** 核对收支分类：必须存在，且方向与流水一致（收入流水不能挂支出分类）。 */
async function findCategory(handle, kind, categoryCode) {
  const code = optionalText(categoryCode, '收支分类') ?? DEFAULT_CATEGORY_CODE[kind];
  const row = await handle.one('select * from finance_category where code = ?', [code]);
  if (!row || row.kind !== kind) {
    throw new ValidationError(`收支分类 ${code} 不存在或不属于${KIND_LABELS[kind]}类`);
  }
  return row;
}

/**
 * 费用明细归一为 [{code, amountCents}]，顺序固定。
 * 值为元（与收支金额同一单位），空值视为「没填」跳过而不是写成 0，
 * 这样「只填了采购价格」和「采购价格为 0」在库里是可区分的。
 */
function normalizeComponents(raw) {
  if (raw === null || raw === undefined) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('费用明细格式不正确');

  const out = [];
  const seen = new Set();
  for (const [key, value] of Object.entries(raw)) {
    const code = COMPONENT_FIELDS[key] ?? key;
    if (!COMPONENT_CODES.includes(code)) throw new ValidationError(`费用明细项 ${key} 不存在`);
    if (seen.has(code)) throw new ValidationError(`费用明细项 ${COMPONENT_LABELS[code]} 重复`);
    seen.add(code);

    const amountCents = optionalMoney(value, COMPONENT_LABELS[code]);
    if (amountCents === null) continue;
    if (amountCents < 0) throw new ValidationError(`${COMPONENT_LABELS[code]}不能为负数`);
    out.push({ code, amountCents });
  }

  return out.sort((a, b) => COMPONENT_CODES.indexOf(a.code) - COMPONENT_CODES.indexOf(b.code));
}

/**
 * 4.5 的不变式：需要明细的分类，明细合计必须等于流水金额。
 * 差一分都要拦下——成本子项是后续分摊与利润核算的输入，允许对不上等于允许账目失衡。
 */
function assertComponentsMatch(category, components, amountCents, kindLabel) {
  const needDetail = Number(category.has_detail) === 1;

  if (!needDetail) {
    if (components.length > 0) {
      throw new ValidationError(`${category.name}不需要填写费用明细`);
    }
    return;
  }

  const total = sumCents(components, (c) => c.amountCents);
  if (components.length === 0) {
    throw new ValidationError(
      `${category.name}必须填写费用明细，且成本明细合计须等于${kindLabel}金额 `
      + `${fromCents(amountCents)} 元`,
    );
  }
  if (total !== amountCents) {
    throw new ValidationError(
      `成本明细合计 ${fromCents(total)} 元与${kindLabel}金额 ${fromCents(amountCents)} 元不一致，两者必须相等`,
    );
  }
}

/** 账户归属：显式传 null 表示确实不归属账户；未传则归入默认账户。 */
async function resolveAccountId(handle, input) {
  if (input.accountId === null) return null;

  if (input.accountId !== undefined && input.accountId !== '') {
    const id = optionalId(input.accountId, '账户');
    const account = await handle.one('select id from account where id = ?', [id]);
    if (!account) throw new NotFoundError('账户不存在');
    return id;
  }

  // 需求书 4.1 / 4.2 的表单里没有账户字段。若这类流水一律存空，
  // 4.3「当前账户余额」将恒等于期初余额，这条需求就永远落不了地，
  // 所以缺省归入迁移种入的默认账户（无默认账户时退回 null，不影响记账）。
  const fallback = await handle.one('select id from account where code = ?', [DEFAULT_ACCOUNT_CODE]);
  return fallback ? Number(fallback.id) : null;
}

/** 流水号：方向前缀 + 发生日期 + 该方向内的序号。
 *  全部写操作都在数据库互斥锁内串行执行，因此序号不会并发重复。 */
async function nextFlowNo(handle, kind, occurredAt) {
  const row = await handle.one('select count(*) as total from finance_flow where kind = ?', [kind]);
  const seq = Number(row?.total ?? 0) + 1;
  const date = String(occurredAt).slice(0, 10).replace(/-/g, '');
  return `${FLOW_NO_PREFIX[kind]}-${date}-${String(seq).padStart(4, '0')}`;
}

/** 经销商是否存在。跨模块调用方（无 ctx）走这一条。 */
async function assertDealerExists(handle, dealerId) {
  const dealer = await handle.one('select id, company_name, region_id from dealer where id = ?', [dealerId]);
  if (!dealer) throw new NotFoundError('经销商不存在');
  return dealer;
}

/**
 * 经销商是否在当前用户的管辖范围内（需求书 2.2）。
 *
 * 这里刻意不走 applyScope：applyScope 的语义是「绑不上就收紧为 1=0」，
 * 而经销商维度只能绑区域，L3 绑不到任何轴，一收紧就会导致 L3 一笔业务都记不了。
 * 真正需要拦截的只有「分管了区域的 L2 不得跨区操作」这一种情形，
 * 因此只对 scope.regionIds 做判断（L1 全量、L3 与只管品种线的 L2 不受此限）。
 */
async function assertDealerInScope(handle, ctx, dealerId) {
  const dealer = await assertDealerExists(handle, dealerId);
  const scope = ctx?.scope;

  if (scope?.kind === 'scoped' && !scope.selfOnly && scope.regionIds.length > 0) {
    const regionId = dealer.region_id === null ? null : Number(dealer.region_id);
    if (regionId === null || !scope.regionIds.includes(regionId)) {
      throw new ValidationError(`经销商 ${dealer.company_name} 不在您的管辖范围内`);
    }
  }
  return dealer;
}

export function createFinanceService(db) {
  /**
   * 按筛选条件取流水。所有读路径共用，权限过滤只写一处。
   */
  async function queryFlows(ctx, { from, to, kind, categoryCode, dealerId } = {}) {
    const range = normalizeRange(from, to);
    const timeFilter = rangeToSql(range, 'f.occurred_at');
    const scope = applyScope(ctx.scope, FLOW_SCOPE_BINDING);

    const conditions = [];
    const params = [];
    if (timeFilter.sql) { conditions.push(timeFilter.sql); params.push(...timeFilter.params); }
    if (kind) {
      conditions.push('f.kind = ?');
      params.push(requireEnum(kind, '收支方向', FLOW_KINDS, KIND_LABELS));
    }
    if (categoryCode) { conditions.push('c.code = ?'); params.push(String(categoryCode).trim()); }
    if (dealerId) { conditions.push('f.dealer_id = ?'); params.push(Number(dealerId)); }

    const where = conditions.length ? ` and ${conditions.join(' and ')}` : '';
    const rows = await db.query(
      `select f.*, c.code as category_code, c.name as category_name, c.has_detail,
              d.company_name as dealer_name, a.name as account_name, e.name as operator_name
       ${FLOW_FROM}
        where 1=1${where}${scope.sql}
        order by f.occurred_at desc, f.id desc`,
      [...params, ...scope.params],
    );

    // 明细单独取一次再回填：避免主查询因 join 明细而重复行，
    // 也让没有明细的流水不必付出 join 成本。
    const byFlow = new Map();
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const componentRows = await db.query(
        `select fc.flow_id, fc.component_code, fc.amount_cents,
                cp.name as component_name
           from finance_flow_component fc
           left join finance_component cp on cp.code = fc.component_code
          where fc.flow_id in (${placeholders(ids.length)})
          order by fc.id`,
        ids,
      );
      for (const row of componentRows) {
        const list = byFlow.get(Number(row.flow_id)) ?? [];
        list.push(row);
        byFlow.set(Number(row.flow_id), list);
      }
    }

    return rows.map((row) => toFlow(row, byFlow.get(Number(row.id)) ?? []));
  }

  /** 按分类汇总流水；时间段与权限过滤与其他读路径完全一致。 */
  async function aggregateByCategory(ctx, { from, to, kind, withComponents = false } = {}) {
    const range = normalizeRange(from, to);
    const timeFilter = rangeToSql(range, 'f.occurred_at');
    const scope = applyScope(ctx.scope, FLOW_SCOPE_BINDING);

    const kindCondition = kind ? 'f.kind = ?' : null;
    const kindParams = kind ? [kind] : [];
    const where = `1=1${kindCondition ? ` and ${kindCondition}` : ''}`
      + `${timeFilter.sql ? ` and ${timeFilter.sql}` : ''}${scope.sql}`;
    const params = [...kindParams, ...timeFilter.params, ...scope.params];

    // 分类清单单独查：用 LEFT JOIN 一次算完的话，时间段与权限条件会被塞进
    // ON 里（漏掉没流水的分类）或 WHERE 里（把没流水的分类整行滤掉），两种都不对。
    const categories = await db.query(
      `select id, code, name, kind, has_detail from finance_category
        ${kind ? 'where kind = ?' : ''}
        order by sort_order, id`,
      kindParams,
    );

    const totals = await db.query(
      `select f.category_id,
              coalesce(sum(f.amount_cents), 0) as amount_cents,
              count(*) as flow_count
         from finance_flow f
         left join dealer d on d.id = f.dealer_id
        where ${where}
        group by f.category_id`,
      params,
    );
    const totalByCategory = new Map(totals.map((r) => [Number(r.category_id), r]));

    const componentsByCategory = new Map();
    if (withComponents) {
      const detailIds = categories.filter((c) => Number(c.has_detail) === 1).map((c) => Number(c.id));
      if (detailIds.length > 0) {
        const rows = await db.query(
          `select f.category_id, fc.component_code,
                  coalesce(sum(fc.amount_cents), 0) as amount_cents,
                  cp.name as component_name
             from finance_flow_component fc
             join finance_flow f on f.id = fc.flow_id
             left join finance_component cp on cp.code = fc.component_code
             left join dealer d on d.id = f.dealer_id
            where f.category_id in (${placeholders(detailIds.length)})
              and ${where}
            group by f.category_id, fc.component_code, cp.name`,
          [...detailIds, ...params],
        );
        for (const row of rows) {
          const key = Number(row.category_id);
          const list = componentsByCategory.get(key) ?? new Map();
          const code = row.component_code;
          list.set(code, (list.get(code) ?? 0) + Number(row.amount_cents));
          componentsByCategory.set(key, list);
        }
      }
    }

    const rows = categories.map((category) => {
      const total = totalByCategory.get(Number(category.id));
      const amountCents = total ? Number(total.amount_cents) : 0;

      const componentMap = componentsByCategory.get(Number(category.id)) ?? null;
      const components = componentMap
        ? COMPONENT_CODES
          .filter((code) => componentMap.has(code))
          .map((code) => ({
            code,
            name: COMPONENT_LABELS[code],
            amountCents: componentMap.get(code),
            amount: fromCents(componentMap.get(code)),
          }))
        : [];

      return {
        categoryId: category.id,
        categoryCode: category.code,
        categoryName: category.name,
        kind: category.kind,
        kindLabel: KIND_LABELS[category.kind] ?? category.kind,
        hasDetail: Number(category.has_detail) === 1,
        amountCents,
        amount: fromCents(amountCents),
        flowCount: total ? Number(total.flow_count) : 0,
        components,
        componentsTotalCents: sumCents(components, (c) => c.amountCents),
      };
    });

    return { rows, range: { from: range.from, to: range.toExclusive } };
  }

  /**
   * 收支登记的公共实现。
   *
   * 流水与其成本明细必须同生共死（需求书 8.5），所以整体包在一个事务里；
   * 事务内一律使用句柄 t —— 用 db 会撞上「事务期间误用 db」的防呆检查并抛错，
   * 而且那样也会绕过事务边界。
   */
  async function writeFlow(ctx, kind, input = {}) {
    // 经销商可见性必须在事务内校验：既要拿 t 读，也避免校验与写入之间的竞态
    const dealerId = optionalId(input.dealerId, '经销商');

    return db.tx(async (t) => {
      if (dealerId !== null) await assertDealerInScope(t, ctx, dealerId);
      return createFlowWithinTransaction(t, {
        ...input,
        kind,
        dealerId,
        operatorId: input.operatorId ?? ctx.user?.id ?? null,
      });
    });
  }

  /**
   * 在给定事务句柄内写一笔流水（需求书 9 的跨模块写入口）。
   *
   * 销售、工资等模块在自己的事务里直接调用它，从而让「业务单据 + 财务流水」
   * 落进同一个事务；调用方负责权限判断，本函数只做字段与不变式校验。
   *
   * @param {object} t 事务句柄（db.tx 的回调参数）
   * @param {{kind: string, categoryCode?: string, occurredAt?: string, name: string,
   *          amountCents?: number, amount?: string|number, dealerId?: number|null,
   *          accountId?: number|null, sourceType?: string, sourceId?: number|null,
   *          components?: object, operatorId?: number|null, remark?: string}} input
   * @returns {Promise<number>} 新流水的 id
   */
  async function createFlowWithinTransaction(t, input = {}) {
    const kind = requireEnum(input.kind, '收支方向', FLOW_KINDS, KIND_LABELS);
    const kindLabel = KIND_LABELS[kind];

    // 需求书 4.1 的字段是「收入时间/名称/金额」，4.2 是支出同名三项，
    // 因此校验提示按方向带上对应中文名，前端可直接挂到输入框上。
    const amountCents = resolveAmountCents(input, `${kindLabel}金额`);
    if (amountCents <= 0) throw new ValidationError(`${kindLabel}金额必须大于 0`);

    const name = requireText(input.name, `${kindLabel}名称`);
    const category = await findCategory(t, kind, input.categoryCode);
    const components = normalizeComponents(input.components);
    assertComponentsMatch(category, components, amountCents, kindLabel);

    const occurredAt = input.occurredAt ? formatOccurredAt(input.occurredAt) : formatDateTime(new Date());

    const dealerId = optionalId(input.dealerId, '经销商');
    if (dealerId !== null) await assertDealerExists(t, dealerId);

    const accountId = await resolveAccountId(t, input);

    const flowId = await t.insert('finance_flow', {
      flow_no: await nextFlowNo(t, kind, occurredAt),
      kind,
      category_id: category.id,
      occurred_at: occurredAt,
      name,
      amount_cents: amountCents,
      account_id: accountId,
      dealer_id: dealerId,
      source_type: optionalEnum(input.sourceType, '来源类型', SOURCE_TYPES, SOURCE_TYPE_LABELS) ?? 'manual',
      source_id: optionalId(input.sourceId, '来源单据'),
      operator_id: optionalId(input.operatorId, '经办人'),
      remark: optionalText(input.remark, '备注'),
      created_by: optionalId(input.operatorId, '经办人'),
    });

    for (const component of components) {
      await t.insert('finance_flow_component', {
        flow_id: flowId,
        component_code: component.code,
        amount_cents: component.amountCents,
      });
    }

    return flowId;
  }

  return {
    /** 4.1 实时收入。 */
    async recordIncome(ctx, input = {}) {
      return writeFlow(ctx, 'income', input);
    },

    /** 4.2 实时支出。 */
    async recordExpense(ctx, input = {}) {
      return writeFlow(ctx, 'expense', input);
    },

    /** 收支流水明细（按时间段 / 方向 / 分类 / 经销商筛选）。 */
    async listFlows(ctx, filters = {}) {
      return queryFlows(ctx, filters);
    },

    /**
     * 4.3 按时间段收支明细。
     * 分类明细里保留所有分类（含本期为 0 的），界面才能照 4.4 / 4.5 的固定清单展示。
     */
    async summary(ctx, { from = null, to = null } = {}) {
      const { rows, range } = await aggregateByCategory(ctx, { from, to });

      const totalIncomeCents = sumCents(rows.filter((r) => r.kind === 'income'), (r) => r.amountCents);
      const totalExpenseCents = sumCents(rows.filter((r) => r.kind === 'expense'), (r) => r.amountCents);
      const netCents = totalIncomeCents - totalExpenseCents;

      return {
        totalIncomeCents,
        totalIncome: fromCents(totalIncomeCents),
        totalExpenseCents,
        totalExpense: fromCents(totalExpenseCents),
        netCents,
        net: fromCents(netCents),
        rows,
        range,
      };
    },

    /** 4.3 按时间段某经销商往来账。往来余额 = 该经销商带来的收入 − 对其的支出。 */
    async dealerLedger(ctx, { from = null, to = null, dealerId = null } = {}) {
      const id = optionalId(dealerId, '经销商');
      if (!id) throw new ValidationError('经销商不能为空');

      // 与写入用同一套判断：区域管辖之外的经销商，读也读不到
      const dealer = await assertDealerInScope(db, ctx, id);
      const range = normalizeRange(from, to);
      const rows = await queryFlows(ctx, { from, to, dealerId: id });

      const incomeRows = rows.filter((r) => r.kind === 'income');
      const expenseRows = rows.filter((r) => r.kind === 'expense');
      const totalIncomeCents = sumCents(incomeRows, (r) => r.amountCents);
      const totalExpenseCents = sumCents(expenseRows, (r) => r.amountCents);
      const netCents = totalIncomeCents - totalExpenseCents;

      return {
        dealerId: id,
        dealerName: dealer.company_name,
        dealerRegionId: dealer.region_id,
        incomeRows,
        expenseRows,
        totalIncomeCents,
        totalIncome: fromCents(totalIncomeCents),
        totalExpenseCents,
        totalExpense: fromCents(totalExpenseCents),
        netCents,
        net: fromCents(netCents),
        range: { from: range.from, to: range.toExclusive },
      };
    },

    /**
     * 4.3 当前账户余额 = 期初余额 + 收入合计 − 支出合计。
     * 省略 accountId 时返回全部账户及合计（合计为各账户余额之和）。
     */
    async accountBalance(ctx, { accountId = null } = {}) {
      const scope = applyScope(ctx.scope, FLOW_SCOPE_BINDING);
      const sums = await db.query(
        `select f.account_id,
                coalesce(sum(case when f.kind = 'income' then f.amount_cents else 0 end), 0) as income_cents,
                coalesce(sum(case when f.kind = 'expense' then f.amount_cents else 0 end), 0) as expense_cents
           from finance_flow f
           left join dealer d on d.id = f.dealer_id
          where 1=1${scope.sql}
          group by f.account_id`,
        [...scope.params],
      );
      const sumsOf = (id) => sums.find((r) => Number(r.account_id) === Number(id));

      if (accountId !== null && accountId !== undefined && accountId !== '') {
        const id = optionalId(accountId, '账户');
        const account = await db.one('select * from account where id = ?', [id]);
        if (!account) throw new NotFoundError('账户不存在');
        return toAccountBalance(account, sumsOf(id));
      }

      // 未指定账户的流水只可能来自「显式传 accountId: null」的调用，
      // 它不计入任何一个账户，因此也不进合计。
      const accounts = await db.query('select * from account order by id');
      const rows = accounts.map((account) => toAccountBalance(account, sumsOf(account.id)));
      const totalBalanceCents = sumCents(rows, (r) => r.balanceCents);

      return {
        accounts: rows,
        totalOpeningBalanceCents: sumCents(rows, (r) => r.openingBalanceCents),
        totalIncomeCents: sumCents(rows, (r) => r.totalIncomeCents),
        totalIncome: fromCents(sumCents(rows, (r) => r.totalIncomeCents)),
        totalExpenseCents: sumCents(rows, (r) => r.totalExpenseCents),
        totalExpense: fromCents(sumCents(rows, (r) => r.totalExpenseCents)),
        totalBalanceCents,
        totalBalance: fromCents(totalBalanceCents),
      };
    },

    /**
     * 4.4 分类收入明细 / 4.5 分类支出明细。
     * 需要明细的支出分类同时给出子项（采购价格/运输费用/制种费用/加工费用）汇总，
     * 由 4.5 的不变式保证子项合计恒等于该分类合计。
     */
    async categoryReport(ctx, { from = null, to = null, kind = null } = {}) {
      const kindValue = requireEnum(kind, '收支方向', FLOW_KINDS, KIND_LABELS);
      const { rows, range } = await aggregateByCategory(ctx, {
        from, to, kind: kindValue, withComponents: true,
      });
      const totalCents = sumCents(rows, (r) => r.amountCents);

      return {
        kind: kindValue,
        kindLabel: KIND_LABELS[kindValue],
        rows,
        totalCents,
        total: fromCents(totalCents),
        range,
      };
    },

    /** 需求书 9：供销售、工资等模块在自己的事务里写入关联流水。 */
    createFlowInTx: createFlowWithinTransaction,
  };
}
