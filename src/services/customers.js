/**
 * 客户管理（需求书第 6 章）。
 *
 * 三处建模决定：
 *
 * 1. 代理品种 / 试点品种落在 dealer_variety 关系表，而不是经销商主档上的文本列。
 *    需求书 6.1 写的是「代理品种编号」「代理品种名称」，那是**表单**的形状：
 *    同一张表单上编号与名称并排显示，看起来像两个字段，实际上是同一个品种的两种呈现。
 *    存成文本列必然出现名称改了而经销商档案里还是旧名的问题，所以只收品种 id，
 *    编号与名称一律在读取时从 variety 表解析——单一真相来源，永远不会漂移。
 *    调用方就算把界面上显示的名称一起提交回来，也一律忽略。
 *
 * 2. 6.3 的六种问法收敛为一个 feedbackReport，与 inventory.movementsReport 同构：
 *    它们只是同一张表上的不同「筛选条件 + 分组维度」组合，写六个方法只会让
 *    权限过滤与时间段处理被复制六遍，任何一处漏加 applyScope 就是一个越权漏洞。
 *
 * 3. 分组在内存里做，而不是 SQL GROUP BY。库存报表聚合的是数字，SQL 里算最省事；
 *    反馈报表的主体恰恰是**反馈正文**，GROUP BY 会把正文丢掉，还得再补一次明细查询，
 *    反而多一次往返。经销商反馈是本地单机库上的小表，一次带索引的明细查询后在内存分组
 *    更简单，也更好测。
 */

import { NotFoundError, PermissionError, ValidationError } from '../core/errors.js';
import { applyScope } from '../domain/scope.js';
import { normalizeDateRange, dateRangeToSql } from '../domain/daterange.js';
import {
  requireText, optionalText, requireDate, optionalId, optionalEnum,
} from '../core/validate.js';

/** 统计维度。为空时按「是否指定了经销商」自动推断。 */
const DIMENSIONS = ['variety', 'dealer'];
const DIMENSION_LABELS = { variety: '按品种', dealer: '按经销商' };

/**
 * 权限过滤可绑定的列。
 *
 * region / variety 两个轴是需求书 2.2 的直接落地：L2 按分管区域、品种线过滤。
 * 另外补了 self / employee 轴指向「建档人」：L3 的可见范围是「本人相关数据」，
 * 对经销商而言「本人相关」就是本人建的客户与本人录的反馈（见 dealer.created_by）。
 * 若不给 L3 这条轴，applyScope 会因为绑定维度一个都用不上而收紧成 1=0，
 * L3 将看不到自己刚录入的数据。
 */
const DEALER_SCOPE_BINDING = {
  region: 'd.region_id',
  employee: 'd.created_by',
  self: 'd.created_by',
};

/** 反馈的绑定：dealer 决定经销商维度，feedback 表自身负责品种轴与建档人轴。 */
const FEEDBACK_SCOPE_BINDING = {
  variety: 'f.variety_id',
  region: 'd.region_id',
  employee: 'f.created_by',
  self: 'f.created_by',
};

const placeholders = (n) => Array.from({ length: n }, () => '?').join(', ');

/** 反馈明细的统一取数语句，报表与明细列表共用，保证两者筛选后的行完全一致。 */
const FEEDBACK_SELECT = `
  select f.id, f.dealer_id, f.variety_id, f.feedback_date, f.content, f.created_by, f.created_at,
         d.code as dealer_code, d.company_name as dealer_name, d.region_id,
         r.name as region_name,
         v.code as variety_code, v.name as variety_name
    from dealer_feedback f
    join dealer d on d.id = f.dealer_id
    left join region r on r.id = d.region_id
    left join variety v on v.id = f.variety_id`;

function toDealer(row, links) {
  const agentVarieties = links?.agent ?? [];
  const pilotVarieties = links?.pilot ?? [];
  return {
    id: row.id,
    code: row.code,
    companyName: row.company_name,
    regionId: row.region_id,
    regionName: row.region_name ?? null,
    contactName: row.contact_name,
    phone: row.phone,
    // 是否试点由试点品种推导。dealer.is_pilot 列只是给将来 SQL 过滤用的冗余列，
    // 读取一律以关系表为准，因此即便两者短暂不一致，输出也不会错。
    isPilot: pilotVarieties.length > 0,
    agentVarieties,
    pilotVarieties,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toFeedback(row) {
  return {
    id: row.id,
    dealerId: row.dealer_id,
    dealerCode: row.dealer_code ?? null,
    dealerName: row.dealer_name ?? null,
    regionId: row.region_id,
    regionName: row.region_name ?? null,
    varietyId: row.variety_id,
    varietyCode: row.variety_code ?? null,
    varietyName: row.variety_name ?? null,
    feedbackDate: row.feedback_date,
    content: row.content,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** 两个字符串的稳定比较。不用 localeCompare：分组顺序不应随运行环境的 locale 变化。 */
const byText = (a, b) => (a === b ? 0 : (a < b ? -1 : 1));

const text = (value) => String(value ?? '');

export function createCustomersService(db) {
  /** 读取经销商；不存在或超出可见范围一律按「不存在」处理，避免泄漏其它范围的存在性。 */
  async function findDealerRow(ctx, id) {
    const scope = applyScope(ctx.scope, DEALER_SCOPE_BINDING);
    const row = await db.one(
      `select d.*, r.name as region_name
         from dealer d
         left join region r on r.id = d.region_id
        where d.id = ?${scope.sql}`,
      [id, ...scope.params],
    );
    if (!row) throw new NotFoundError('经销商不存在或不在您的可见范围内');
    return row;
  }

  /**
   * 写入前的经销商校验。
   *
   * 与读取刻意不同：越权写入必须明确报「没有权限」，而不是伪装成「不存在」。
   * 用户点了保存却被告知数据不存在，第一反应是数据被删了，会去查根本不存在的问题。
   */
  async function requireWritableDealer(ctx, id) {
    const exists = await db.one('select id from dealer where id = ?', [id]);
    if (!exists) throw new NotFoundError('经销商不存在');

    const scope = applyScope(ctx.scope, DEALER_SCOPE_BINDING);
    const visible = await db.one(
      `select d.* from dealer d where d.id = ?${scope.sql}`,
      [id, ...scope.params],
    );
    if (!visible) throw new PermissionError('没有权限操作其它范围的经销商数据');
    return visible;
  }

  /**
   * 区域归属校验。
   *
   * 只有「按区域管辖」的账号才受此约束，且此时区域必填：
   * 若允许不填区域绕过，按区域管辖的经理就能把客户建到管辖之外，而且建完之后自己也看不到，
   * 既越权又制造出谁都管不到的脏数据。L1（全部范围）与 L3（按本人过滤，没有区域轴）不受此限。
   */
  async function assertRegionWritable(ctx, regionId) {
    if (ctx.scope?.kind === 'none') {
      throw new PermissionError('您的数据范围为空，没有权限新建或修改经销商');
    }

    const regionScoped = ctx.scope?.kind === 'scoped' && ctx.scope.regionIds.length > 0;
    if (regionId === null) {
      if (regionScoped) throw new ValidationError('所在区域不能为空');
      return null;
    }

    const region = await db.one('select id, name from region where id = ?', [regionId]);
    if (!region) throw new ValidationError(`所在区域（编号 ${regionId}）不存在`);

    if (regionScoped && !ctx.scope.regionIds.includes(regionId)) {
      throw new PermissionError(`没有权限把经销商归属到区域「${region.name}」`);
    }
    return region;
  }

  /**
   * 解析品种 id 数组。未提供（undefined / null）返回 null，表示「本次不改动该关系」，
   * 调用方据此区分「没传」与「传了空数组要清空」。
   */
  async function resolveVarietyIds(value, label) {
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value)) throw new ValidationError(`${label}格式不正确，应为品种编号数组`);

    const ids = [];
    for (const raw of value) {
      const id = optionalId(raw, label);
      if (id === null) continue; // 前端清空一行时常常留下空值，跳过而不是报错
      if (ids.includes(id)) continue; // dealer_variety 没有唯一索引，重复由这里收敛
      const variety = await db.one('select id from variety where id = ?', [id]);
      if (!variety) throw new ValidationError(`${label}（编号 ${id}）不存在`);
      ids.push(id);
    }
    return ids;
  }

  /** 整体替换某类品种关系。新建时表里尚无记录，删除是空操作，因此新建与修改可共用。 */
  async function replaceVarietyLinks(t, dealerId, relation, varietyIds) {
    await t.remove('dealer_variety', { dealer_id: dealerId, relation });
    for (const varietyId of varietyIds) {
      await t.insert('dealer_variety', { dealer_id: dealerId, variety_id: varietyId, relation });
    }
  }

  /** 批量取品种关系，避免列表页按经销商逐个查询。 */
  async function loadVarietyLinks(dealerIds) {
    const map = new Map(dealerIds.map((id) => [id, { agent: [], pilot: [] }]));
    if (dealerIds.length === 0) return map;

    const rows = await db.query(
      `select dv.dealer_id, dv.relation, v.id, v.code, v.name
         from dealer_variety dv
         join variety v on v.id = dv.variety_id
        where dv.dealer_id in (${placeholders(dealerIds.length)})
        order by v.code`,
      dealerIds,
    );

    for (const row of rows) {
      const bucket = map.get(row.dealer_id);
      const list = bucket?.[row.relation];
      if (list) list.push({ id: row.id, code: row.code, name: row.name });
    }
    return map;
  }

  /** 反馈明细取数。报表与列表共用，两者对时间段、品种、经销商、权限的处理因此不可能分叉。 */
  async function queryFeedback(ctx, { range, varietyId = null, dealerId = null }) {
    const timeFilter = dateRangeToSql(range, 'f.feedback_date');
    const scope = applyScope(ctx.scope, FEEDBACK_SCOPE_BINDING);

    const conditions = [];
    const params = [];
    if (timeFilter.sql) { conditions.push(timeFilter.sql); params.push(...timeFilter.params); }
    if (varietyId) { conditions.push('f.variety_id = ?'); params.push(Number(varietyId)); }
    if (dealerId) { conditions.push('f.dealer_id = ?'); params.push(Number(dealerId)); }

    const where = conditions.length ? ` and ${conditions.join(' and ')}` : '';
    const rows = await db.query(
      `${FEEDBACK_SELECT} where 1=1${where}${scope.sql} order by f.feedback_date, f.id`,
      [...params, ...scope.params],
    );
    return rows.map(toFeedback);
  }

  return {
    /** 6.1 经销商信息录入。主档与品种关系在同一事务里写入，不会出现只建了主档的半成品。 */
    async createDealer(ctx, input) {
      const code = requireText(input.code, '编号');
      const companyName = requireText(input.companyName, '公司名称');
      const regionId = optionalId(input.regionId, '所在区域');
      await assertRegionWritable(ctx, regionId);

      const existing = await db.one('select id from dealer where code = ?', [code]);
      if (existing) throw new ValidationError(`经销商编号 ${code} 已存在`);

      const agentVarietyIds = (await resolveVarietyIds(input.agentVarietyIds, '代理品种')) ?? [];
      const pilotVarietyIds = (await resolveVarietyIds(input.pilotVarietyIds, '试点品种')) ?? [];

      return db.tx(async (t) => {
        const id = await t.insert('dealer', {
          code,
          company_name: companyName,
          region_id: regionId,
          contact_name: optionalText(input.contactName, '负责人姓名'),
          phone: optionalText(input.phone, '联系电话'),
          is_pilot: pilotVarietyIds.length > 0 ? 1 : 0,
          created_by: ctx.user?.id ?? null,
        });
        await replaceVarietyLinks(t, id, 'agent', agentVarietyIds);
        await replaceVarietyLinks(t, id, 'pilot', pilotVarietyIds);
        return id;
      });
    },

    /** 修改经销商。品种关系传了才动，传空数组表示清空。 */
    async updateDealer(ctx, id, input) {
      await requireWritableDealer(ctx, id);

      const patch = {};

      if (input.code !== undefined) {
        const code = requireText(input.code, '编号');
        const existing = await db.one('select id from dealer where code = ? and id <> ?', [code, id]);
        if (existing) throw new ValidationError(`经销商编号 ${code} 已存在`);
        patch.code = code;
      }
      if (input.companyName !== undefined) patch.company_name = requireText(input.companyName, '公司名称');
      if (input.contactName !== undefined) patch.contact_name = optionalText(input.contactName, '负责人姓名');
      if (input.phone !== undefined) patch.phone = optionalText(input.phone, '联系电话');
      if (input.regionId !== undefined) {
        const regionId = optionalId(input.regionId, '所在区域');
        await assertRegionWritable(ctx, regionId);
        patch.region_id = regionId;
      }

      const agentVarietyIds = await resolveVarietyIds(input.agentVarietyIds, '代理品种');
      const pilotVarietyIds = await resolveVarietyIds(input.pilotVarietyIds, '试点品种');

      if (Object.keys(patch).length === 0 && agentVarietyIds === null && pilotVarietyIds === null) {
        throw new ValidationError('没有需要更新的字段');
      }
      // is_pilot 随试点品种一起维护，避免出现「有试点品种却不算试点」的档案
      if (pilotVarietyIds !== null) patch.is_pilot = pilotVarietyIds.length > 0 ? 1 : 0;

      await db.tx(async (t) => {
        if (Object.keys(patch).length > 0) await t.update('dealer', patch, { id });
        if (agentVarietyIds !== null) await replaceVarietyLinks(t, id, 'agent', agentVarietyIds);
        if (pilotVarietyIds !== null) await replaceVarietyLinks(t, id, 'pilot', pilotVarietyIds);
      });
      return id;
    },

    async getDealer(ctx, id) {
      const row = await findDealerRow(ctx, id);
      const links = await loadVarietyLinks([row.id]);
      return toDealer(row, links.get(row.id));
    },

    /** 经销商列表，供销售单等模块「从客户管理抓取」经销商名称、编码与电话。 */
    async listDealers(ctx, { regionId = null, keyword = null } = {}) {
      const scope = applyScope(ctx.scope, DEALER_SCOPE_BINDING);

      const conditions = [];
      const params = [];
      if (regionId) {
        conditions.push('d.region_id = ?');
        params.push(optionalId(regionId, '所在区域'));
      }
      if (keyword) {
        conditions.push('(d.code like ? or d.company_name like ? or d.contact_name like ?)');
        const like = `%${keyword}%`;
        params.push(like, like, like);
      }

      const where = conditions.length ? ` and ${conditions.join(' and ')}` : '';
      const rows = await db.query(
        `select d.*, r.name as region_name
           from dealer d
           left join region r on r.id = d.region_id
          where 1=1${where}${scope.sql}
          order by d.code`,
        [...params, ...scope.params],
      );

      const links = await loadVarietyLinks(rows.map((r) => r.id));
      return rows.map((row) => toDealer(row, links.get(row.id)));
    },

    /** 6.2 经销商反馈信息录入。 */
    async recordFeedback(ctx, input) {
      const dealerId = optionalId(input.dealerId, '经销商');
      if (dealerId === null) throw new ValidationError('经销商不能为空');
      await requireWritableDealer(ctx, dealerId);

      const varietyId = optionalId(input.varietyId, '反馈品种');
      if (varietyId !== null) {
        const variety = await db.one('select id from variety where id = ?', [varietyId]);
        if (!variety) throw new ValidationError(`反馈品种（编号 ${varietyId}）不存在`);
      }

      return db.insert('dealer_feedback', {
        dealer_id: dealerId,
        variety_id: varietyId,
        feedback_date: requireDate(input.feedbackDate, '反馈日期'),
        content: requireText(input.content, '反馈内容'),
        created_by: ctx.user?.id ?? null,
      });
    },

    /** 反馈明细。报表看汇总，这里看每一条正文。 */
    async listFeedback(ctx, { from = null, to = null, varietyId = null, dealerId = null } = {}) {
      return queryFeedback(ctx, {
        range: normalizeDateRange(from, to),
        varietyId,
        dealerId,
      });
    },

    /**
     * 6.3 反馈查询（按时间段）。六种问法共用一条取数 + 一次内存分组：
     *   按品种维度 ① 按品种查询所有经销商某时间段反馈 → 传 varietyId
     *              ② 某品种所有经销商反馈           → 同上（②是①不带时间段的说法）
     *              ③ 某品种某经销商反馈             → 传 varietyId + dealerId
     *   按经销商维度 ④ 按经销商查询所有品种某时间段反馈 → 传 dealerId
     *              ⑤ 某经销商对其所有品种反馈       → 同上（⑤是④不带时间段的说法）
     *              ⑥ 某经销商对某品种反馈           → 传 dealerId + varietyId
     * 分组维度与 movementsReport 同规则：指定了经销商，或显式 dimension='dealer' 时，
     * 按「品种 + 经销商」拆解；否则只按品种汇总。
     */
    async feedbackReport(ctx, { from = null, to = null, varietyId = null, dealerId = null, dimension = null } = {}) {
      const range = normalizeDateRange(from, to);
      const dim = optionalEnum(dimension, '统计维度', DIMENSIONS, DIMENSION_LABELS);
      const items = await queryFeedback(ctx, { range, varietyId, dealerId });

      const groupByDealer = Boolean(dealerId) || dim === 'dealer';

      const groups = new Map();
      for (const item of items) {
        const key = groupByDealer ? `${item.varietyId ?? ''}#${item.dealerId}` : text(item.varietyId);
        if (!groups.has(key)) {
          groups.set(key, {
            varietyId: item.varietyId,
            varietyCode: item.varietyCode,
            varietyName: item.varietyName,
            dealerId: groupByDealer ? item.dealerId : null,
            dealerCode: groupByDealer ? item.dealerCode : null,
            dealerName: groupByDealer ? item.dealerName : null,
            regionId: groupByDealer ? item.regionId : null,
            regionName: groupByDealer ? item.regionName : null,
            count: 0,
            feedbacks: [],
          });
        }
        const group = groups.get(key);
        group.count += 1;
        group.feedbacks.push(item);
      }

      const rows = [...groups.values()].sort(
        (a, b) => byText(text(a.varietyCode), text(b.varietyCode))
          || byText(text(a.dealerCode), text(b.dealerCode)),
      );

      return {
        rows,
        totals: {
          count: items.length,
          dealerCount: new Set(items.map((i) => i.dealerId)).size,
          // 未指明品种的反馈不构成一个品种，故不计入品种数
          varietyCount: new Set(items.map((i) => i.varietyId).filter((id) => id !== null)).size,
        },
        range: { from: range.from, to: range.toExclusive },
      };
    },
  };
}
