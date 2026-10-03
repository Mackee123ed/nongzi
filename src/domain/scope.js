/**
 * 三级权限的数据可见范围（需求书 2.2）。
 *
 * 需求书只写了 L1 全部 / L2 管辖范围 / L3 仅本人，没有定义「管辖范围」的数据来源。
 * 这里补充为三个轴：
 *   区域轴  employee_scope(scope_type='region')  → 分管区域（含下级区域）
 *   品种轴  employee_scope(scope_type='variety') → 分管品种线
 *   人员轴  employee.manager_id 递归           → 本人及全部下属
 *
 * 本模块是纯函数，不做任何 I/O：区域树与员工表由调用方一次性读入。
 * 区域表很小，用 JS 求闭包比在每条报表 SQL 里写递归 CTE 更简单，
 * 也更容易测试，且对四种数据库完全一致。
 *
 * ★ 贯穿全系统的约定：范围为空时收紧为「查不到任何数据」，绝不放开为全量。
 *   一个漏配管辖范围的经理应当看到空系统，而不是整个公司的数据。
 */

/** 生成 n 个占位符。 */
const placeholders = (n) => Array.from({ length: n }, () => '?').join(', ');

const uniqueSorted = (values) => [...new Set(values)].sort((a, b) => a - b);

/** 区域向下闭包：包含所选区域自身及其全部下级。带环保护。 */
function descendantRegions(seedIds, regions) {
  const childrenOf = new Map();
  for (const region of regions) {
    if (!childrenOf.has(region.parent_id)) childrenOf.set(region.parent_id, []);
    childrenOf.get(region.parent_id).push(region.id);
  }

  const collected = new Set();
  const queue = [...seedIds];
  while (queue.length > 0) {
    const id = queue.shift();
    if (collected.has(id)) continue; // 环保护：已访问过就不再展开
    collected.add(id);
    for (const child of childrenOf.get(id) ?? []) {
      if (!collected.has(child)) queue.push(child);
    }
  }
  return uniqueSorted(collected);
}

/** 人员向下闭包：本人 + 全部下属（递归，不止直属）。带环保护。 */
function selfAndReports(employeeId, employees) {
  const reportsOf = new Map();
  for (const employee of employees) {
    if (!reportsOf.has(employee.manager_id)) reportsOf.set(employee.manager_id, []);
    reportsOf.get(employee.manager_id).push(employee.id);
  }

  const collected = new Set();
  const queue = [employeeId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (collected.has(id)) continue;
    collected.add(id);
    for (const report of reportsOf.get(id) ?? []) {
      if (!collected.has(report)) queue.push(report);
    }
  }
  return uniqueSorted(collected);
}

const EMPTY_SCOPE = Object.freeze({
  kind: 'none', selfOnly: false, employeeId: null,
  regionIds: [], varietyIds: [], employeeIds: [],
});

/**
 * 依据当前用户与组织结构，构造其数据可见范围。
 *
 * @param {{id: number, level: string}} actor 当前登录用户
 * @param {{regions: Array, employees: Array, scopes: Array}} referenceData
 */
export function buildScope(actor, { regions = [], employees = [], scopes = [] } = {}) {
  const level = actor?.level;
  const employeeId = actor?.id ?? null;

  if (level === 'L1') {
    return Object.freeze({
      kind: 'all', selfOnly: false, employeeId,
      regionIds: [], varietyIds: [], employeeIds: [],
    });
  }

  if (level === 'L3') {
    // 员工层仅有本人数据，不因 scope 配置而放宽
    return Object.freeze({
      kind: 'scoped', selfOnly: true, employeeId,
      regionIds: [], varietyIds: [], employeeIds: employeeId === null ? [] : [employeeId],
    });
  }

  if (level !== 'L2') return EMPTY_SCOPE;

  const mine = scopes.filter((s) => Number(s.employee_id) === Number(employeeId));
  const regionIds = descendantRegions(
    mine.filter((s) => s.scope_type === 'region').map((s) => Number(s.scope_value_id)),
    regions,
  );
  const varietyIds = uniqueSorted(
    mine.filter((s) => s.scope_type === 'variety').map((s) => Number(s.scope_value_id)),
  );
  const employeeIds = employeeId === null ? [] : selfAndReports(employeeId, employees);

  // 只有「管辖了区域 / 品种 / 下属」之一才算有范围。
  // 仅有本人而没有下属、又没有分管区域，视为漏配，收紧为空。
  const hasAny = regionIds.length > 0 || varietyIds.length > 0 || employeeIds.length > 1;
  if (!hasAny) return EMPTY_SCOPE;

  return Object.freeze({
    kind: 'scoped', selfOnly: false, employeeId, regionIds, varietyIds, employeeIds,
  });
}

/** 各轴的固定顺序，保证生成的 SQL 与参数顺序稳定可测。 */
const AXIS_ORDER = ['variety', 'region', 'employee', 'self'];

/**
 * 把范围翻译成可拼进 WHERE 的 SQL 片段。
 *
 * @param {object} scope buildScope 的结果
 * @param {{variety?: string, region?: string, employee?: string, self?: string}} binding
 *        各轴对应的列名。没有绑定（或该表没有该列）的轴不参与过滤。
 * @returns {{sql: string, params: Array}} sql 以 ' AND ' 开头，可直接追加到 WHERE 后
 */
export function applyScope(scope, binding = {}) {
  if (!scope || scope.kind === 'all') return { sql: '', params: [] };
  if (scope.kind === 'none') return { sql: ' AND 1=0', params: [] };

  const parts = [];
  const params = [];

  for (const axis of AXIS_ORDER) {
    const column = binding[axis];
    if (!column) continue;

    if (axis === 'self') {
      if (!scope.selfOnly || scope.employeeId === null) continue;
      parts.push(`${column} = ?`);
      params.push(scope.employeeId);
      continue;
    }

    const values = scope[`${axis}Ids`];
    if (!values || values.length === 0) continue;

    parts.push(`${column} in (${placeholders(values.length)})`);
    params.push(...values);
  }

  // 有范围，但当前查询的绑定维度一个都用不上 —— 收紧而不是放开
  if (parts.length === 0) return { sql: ' AND 1=0', params: [] };

  return { sql: ` AND (${parts.join(' or ')})`, params };
}

/** 供接口返回给前端，用于在界面上说明「当前数据范围」。 */
export function describeScope(scope) {
  switch (scope?.kind) {
    case 'all': return '全部数据';
    case 'none': return '无可查看的数据范围';
    case 'scoped':
      if (scope.selfOnly) return '仅本人相关数据';
      return '管辖范围内数据';
    default: return '未知';
  }
}

export { descendantRegions, selfAndReports };
