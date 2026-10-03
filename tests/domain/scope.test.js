import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildScope, applyScope } from '../../src/domain/scope.js';

/**
 * 需求书 2.2 要求权限贯穿所有模块的数据查询、统计汇总与报表。
 * 落实方式就是：每个查询都经过 applyScope 拼出这段 SQL 条件。
 */
const REGIONS = [
  { id: 1, parent_id: null, name: '华北' },
  { id: 2, parent_id: 1, name: '河北' },
  { id: 3, parent_id: 2, name: '石家庄' },
  { id: 4, parent_id: null, name: '华东' },
];

const EMPLOYEES = [
  { id: 10, manager_id: null, level: 'L2', name: '王经理' },
  { id: 11, manager_id: 10, level: 'L3', name: '李业务' },
  { id: 12, manager_id: 11, level: 'L3', name: '赵业务' },
  { id: 13, manager_id: null, level: 'L3', name: '外人' },
  { id: 99, manager_id: null, level: 'L1', name: '高管' },
];

const scopesFor = (...pairs) => pairs.map(([type, value]) => ({
  employee_id: 10, scope_type: type, scope_value_id: value,
}));

const build = (actorId, level, scopes = []) => buildScope(
  { id: actorId, level },
  { regions: REGIONS, employees: EMPLOYEES, scopes },
);

describe('scope — L1 / L2 / L3 数据可见范围', () => {
  describe('buildScope', () => {
    test('L1 高管层：不限制，可见全部数据', () => {
      const scope = build(99, 'L1');
      assert.equal(scope.kind, 'all');
      assert.deepEqual(applyScope(scope, { region: 'd.region_id' }), { sql: '', params: [] });
    });

    test('L3 员工层：仅本人相关数据', () => {
      const scope = build(11, 'L3');
      assert.equal(scope.kind, 'scoped');
      assert.equal(scope.selfOnly, true);
      assert.deepEqual(scope.employeeIds, [11]);
    });

    test('L3 即使被授予了他人 ID 也不会扩大范围', () => {
      const scope = build(11, 'L3', [{ employee_id: 11, scope_type: 'region', scope_value_id: 1 }]);
      assert.deepEqual(scope.regionIds, [], 'L3 不应带有区域管辖');
      assert.deepEqual(scope.employeeIds, [11]);
    });

    test('L2 分管区域：包含其下级区域（区域树向下闭包）', () => {
      const scope = build(10, 'L2', scopesFor(['region', 1]));
      assert.equal(scope.kind, 'scoped');
      assert.deepEqual([...scope.regionIds].sort(), [1, 2, 3], '应含华北及其子区域河北、石家庄');
    });

    test('L2 管辖下属：包含全部下级（递归，不止直属）', () => {
      const scope = build(10, 'L2');
      assert.deepEqual([...scope.employeeIds].sort(), [10, 11, 12], '应含本人与两级下属');
    });

    test('L2 分管品种线', () => {
      const scope = build(10, 'L2', scopesFor(['variety', 7], ['variety', 8]));
      assert.deepEqual([...scope.varietyIds].sort(), [7, 8]);
    });

    test('★ L2 既无分管区域、分管品种，也无下属时，范围为空（失败时收紧而非放开）', () => {
      // 配置疏漏的管理者应当看到空系统，而不是整个系统
      const scope = buildScope(
        { id: 500, level: 'L2' },
        { regions: REGIONS, employees: EMPLOYEES, scopes: [] },
      );
      assert.equal(scope.kind, 'none');
      assert.deepEqual(applyScope(scope, { region: 'd.region_id' }), { sql: ' AND 1=0', params: [] });
    });

    test('未知职级按最严处理', () => {
      const scope = build(11, 'L9');
      assert.equal(scope.kind, 'none');
    });

    test('区域树存在环时不会死循环', () => {
      const cyclic = [
        { id: 1, parent_id: 2 },
        { id: 2, parent_id: 1 },
      ];
      const scope = buildScope(
        { id: 10, level: 'L2' },
        { regions: cyclic, employees: [], scopes: scopesFor(['region', 1]) },
      );
      assert.deepEqual([...scope.regionIds].sort(), [1, 2]);
    });
  });

  describe('applyScope 生成 SQL 条件', () => {
    test('按区域过滤', () => {
      const scope = build(10, 'L2', scopesFor(['region', 2]));
      const { sql, params } = applyScope(scope, { region: 'd.region_id' });
      assert.equal(sql, ' AND (d.region_id in (?, ?))');
      assert.deepEqual(params, [2, 3]);
    });

    test('按品种过滤', () => {
      const scope = build(10, 'L2', scopesFor(['variety', 7]));
      const { sql, params } = applyScope(scope, { variety: 'i.variety_id' });
      assert.equal(sql, ' AND (i.variety_id in (?))');
      assert.deepEqual(params, [7]);
    });

    test('按经办人过滤（L3 本人数据）', () => {
      const scope = build(11, 'L3');
      const { sql, params } = applyScope(scope, { employee: 'o.operator_id' });
      assert.equal(sql, ' AND (o.operator_id in (?))');
      assert.deepEqual(params, [11]);
    });

    test('多维度之间是「或」：管辖区域内的经销商，或本人及下属经手的单据', () => {
      const scope = build(10, 'L2', scopesFor(['region', 1]));
      const { sql, params } = applyScope(scope, {
        region: 'd.region_id',
        employee: 'o.operator_id',
      });
      assert.equal(sql, ' AND (d.region_id in (?, ?, ?) or o.operator_id in (?, ?, ?))');
      assert.deepEqual(params, [1, 2, 3, 10, 11, 12]);
    });

    test('绑定中未出现的维度不参与过滤', () => {
      const scope = build(10, 'L2', scopesFor(['region', 1], ['variety', 7]));
      const { sql, params } = applyScope(scope, { region: 'd.region_id' });
      assert.equal(sql, ' AND (d.region_id in (?, ?, ?))');
      assert.deepEqual(params, [1, 2, 3], '品种维度未绑定，不应产生参数');
    });

    test('★ 有管辖范围但绑定的维度全不适用时，收紧为 1=0（失败时收紧）', () => {
      const scope = build(10, 'L2', scopesFor(['variety', 7]));
      const { sql } = applyScope(scope, { region: 'd.region_id' });
      assert.equal(sql, ' AND 1=0', '不能因为绑不上而放开为全量');
    });

    test('L3 的 selfOnly 在只绑定 self 列时生效', () => {
      const scope = build(11, 'L3');
      const { sql, params } = applyScope(scope, { self: 'f.created_by' });
      assert.equal(sql, ' AND (f.created_by = ?)');
      assert.deepEqual(params, [11]);
    });

    test('参数顺序与 SQL 中占位符顺序一致', () => {
      const scope = build(10, 'L2', scopesFor(['region', 1], ['variety', 7]));
      const { sql, params } = applyScope(scope, { variety: 'i.variety_id', region: 'd.region_id' });
      assert.deepEqual(params, [7, 1, 2, 3], '品种在前、区域在后，与 sql 中顺序一致');
      assert.match(sql, /i\.variety_id in \(\?\) or d\.region_id in \(\?, \?, \?\)/);
    });
  });
});
