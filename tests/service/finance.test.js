import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../helpers/db.js';
import { createFinanceService } from '../../src/services/finance.js';
import { buildScope } from '../../src/domain/scope.js';

const ctxOf = (level = 'L1', id = 1) => ({ user: { id, level, name: '测试' }, scope: buildScope({ id, level }, {}) });

/** 区域树：华北(1) → 河北(2)；华东(4) 与华北平级。 */
const REGIONS = [
  { id: 1, parent_id: null, name: '华北' },
  { id: 2, parent_id: 1, name: '河北' },
  { id: 4, parent_id: null, name: '华东' },
];

/** 10 号王经理是 L2，11 号李业务是其下属；20 号外人不在其管辖内。 */
const EMPLOYEES = [
  { id: 10, manager_id: null, level: 'L2', name: '王经理' },
  { id: 11, manager_id: 10, level: 'L3', name: '李业务' },
  { id: 20, manager_id: null, level: 'L3', name: '外人' },
];

/** 与 inventory 测试一致：scope 由 buildScope + 组织结构一次性算出。 */
const scopedCtx = (id, level, scopes = []) => ({
  user: { id, level, name: '测试' },
  scope: buildScope({ id, level }, { regions: REGIONS, employees: EMPLOYEES, scopes }),
});

/** L2 分管若干区域。 */
const regionManagerCtx = (id = 10, ...regionIds) => scopedCtx(id, 'L2',
  regionIds.map((value) => ({ employee_id: id, scope_type: 'region', scope_value_id: value })));

/** 断言抛出 ValidationError，并返回该错误，便于进一步断言 code 与文案。 */
async function rejectsValidation(fn, pattern) {
  let err = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, '应当抛出错误');
  assert.match(err.message, pattern);
  assert.equal(err.code, 'VALIDATION');
  return err;
}

describe('finance — 财务收支（需求书 4.1 ~ 4.5）', () => {
  let db;
  let finance;
  let ctx;

  beforeEach(async () => {
    db = await makeDb();
    finance = createFinanceService(db);
    ctx = ctxOf('L1');
  });
  afterEach(async () => { await db.close(); });

  /** 迁移种入的默认账户 id。 */
  const defaultAccountId = async () => Number((await db.one("select id from account where code = 'default'")).id);

  /** 需求书 4.5：总代品种成本的明细（采购价格 + 运输费用）。 */
  const costFlow = (over = {}) => ({
    name: '总代品种成本',
    amount: '1000.00',
    categoryCode: 'general_agent_cost',
    occurredAt: '2026-03-05',
    components: { purchasePrice: '800.00', transportFee: '200.00' },
    ...over,
  });

  const flowsOf = async (c = ctx, filter = {}) => finance.listFlows(c, filter);

  describe('4.1 实时收入', () => {
    test('录入收入并原样读回（金额以分存储、同时给出元）', async () => {
      const id = await finance.recordIncome(ctx, {
        name: '销售收入', amount: '128.00', occurredAt: '2026-03-01 09:30:00',
        categoryCode: 'sales_income', remark: '春季现款',
      });

      const flow = (await flowsOf()).find((f) => f.id === id);
      assert.equal(flow.kind, 'income');
      assert.equal(flow.kindLabel, '收入');
      assert.equal(flow.name, '销售收入');
      assert.equal(flow.amountCents, 12800, '金额应以分存储');
      assert.equal(flow.amount, '128.00');
      assert.equal(flow.occurredAt, '2026-03-01 09:30:00');
      assert.equal(flow.categoryCode, 'sales_income');
      assert.equal(flow.categoryName, '销售收入');
      assert.equal(flow.remark, '春季现款');
    });

    test('收入名称与金额必填', async () => {
      await rejectsValidation(() => finance.recordIncome(ctx, { amount: '1.00' }), /收入名称/);
      await rejectsValidation(() => finance.recordIncome(ctx, { name: '甲' }), /收入金额/);
      await rejectsValidation(() => finance.recordIncome(ctx, { name: '甲', amount: '' }), /收入金额/);
    });

    test('金额格式不正确时报错', async () => {
      await rejectsValidation(
        () => finance.recordIncome(ctx, { name: '甲', amount: '一百块' }),
        /收入金额/,
      );
    });

    test('金额必须大于 0', async () => {
      await rejectsValidation(() => finance.recordIncome(ctx, { name: '甲', amount: '0' }), /收入金额/);
      await rejectsValidation(() => finance.recordIncome(ctx, { name: '甲', amount: '-1.00' }), /收入金额/);
    });

    test('未指定时间时取当前时间', async () => {
      const id = await finance.recordIncome(ctx, { name: '甲', amount: '1.00' });
      const flow = (await flowsOf()).find((f) => f.id === id);
      assert.match(flow.occurredAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    test('时间格式不正确时报错', async () => {
      await rejectsValidation(
        () => finance.recordIncome(ctx, { name: '甲', amount: '1.00', occurredAt: '2026/03/01' }),
        /时间/,
      );
    });

    test('未指定分类时归入「其他收入」', async () => {
      const id = await finance.recordIncome(ctx, { name: '零星收入', amount: '50.00' });
      const flow = (await flowsOf()).find((f) => f.id === id);
      assert.equal(flow.categoryCode, 'other_income');
      assert.equal(flow.categoryName, '其他收入');
    });

    test('分类必须属于收入类', async () => {
      await rejectsValidation(
        () => finance.recordIncome(ctx, { name: '甲', amount: '1.00', categoryCode: 'office' }),
        /收支分类/,
      );
      await rejectsValidation(
        () => finance.recordIncome(ctx, { name: '甲', amount: '1.00', categoryCode: '不存在' }),
        /收支分类/,
      );
    });

    test('默认来源为手工录入，并记录经办人', async () => {
      const employeeCtx = ctxOf('L3', 11);
      const id = await finance.recordIncome(employeeCtx, { name: '甲', amount: '1.00' });
      const flow = (await flowsOf()).find((f) => f.id === id);
      assert.equal(flow.sourceType, 'manual');
      assert.equal(flow.operatorId, 11);
    });

    test('生成的流水号按收支方向前缀编号', async () => {
      const first = await finance.recordIncome(ctx, { name: '甲', amount: '1.00', occurredAt: '2026-03-01' });
      const second = await finance.recordIncome(ctx, { name: '乙', amount: '1.00', occurredAt: '2026-03-02' });
      const rows = await flowsOf();
      assert.equal(rows.find((f) => f.id === first).flowNo, 'SR-20260301-0001');
      assert.equal(rows.find((f) => f.id === second).flowNo, 'SR-20260302-0002');
    });
  });

  describe('4.2 实时支出', () => {
    test('录入支出并原样读回', async () => {
      const id = await finance.recordExpense(ctx, {
        name: '办公用品', amount: '128.50', occurredAt: '2026-03-02', categoryCode: 'office',
      });
      const flow = (await flowsOf()).find((f) => f.id === id);
      assert.equal(flow.kind, 'expense');
      assert.equal(flow.kindLabel, '支出');
      assert.equal(flow.amountCents, 12850);
      assert.equal(flow.amount, '128.50');
      assert.equal(flow.categoryCode, 'office');
    });

    test('支出名称与金额必填', async () => {
      await rejectsValidation(() => finance.recordExpense(ctx, { amount: '1.00' }), /支出名称/);
      await rejectsValidation(() => finance.recordExpense(ctx, { name: '甲' }), /支出金额/);
    });

    test('未指定分类时归入「其他支出」', async () => {
      const id = await finance.recordExpense(ctx, { name: '杂项', amount: '20.00' });
      assert.equal((await flowsOf()).find((f) => f.id === id).categoryCode, 'other_expense');
    });

    test('可关联经销商、账户与备注', async () => {
      const dealerId = await db.insert('dealer', { code: 'D001', company_name: '甲经销商', region_id: 2 });
      const accountId = await defaultAccountId();
      const id = await finance.recordExpense(ctx, {
        name: '运费', amount: '300.00', categoryCode: 'other_expense',
        dealerId, accountId, remark: '代垫运费',
      });

      const flow = (await flowsOf()).find((f) => f.id === id);
      assert.equal(flow.dealerId, dealerId);
      assert.equal(flow.dealerName, '甲经销商');
      assert.equal(flow.accountId, accountId);
      assert.equal(flow.accountName, '基本账户');
      assert.equal(flow.remark, '代垫运费');
    });

    test('经销商不存在时报错', async () => {
      await assert.rejects(
        () => finance.recordExpense(ctx, { name: '甲', amount: '1.00', dealerId: 99999 }),
        /经销商/,
      );
    });
  });

  describe('4.5 分类支出明细（成本子项）', () => {
    test('明细合计等于支出金额时，流水与明细一并写入', async () => {
      const flowId = await finance.recordExpense(ctx, costFlow());

      const flow = (await flowsOf()).find((f) => f.id === flowId);
      assert.equal(flow.amountCents, 100000);
      assert.equal(flow.hasDetail, true);
      assert.deepEqual(flow.components.map((c) => c.code), ['purchase_price', 'transport_fee']);
      assert.deepEqual(flow.components.map((c) => c.amountCents), [80000, 20000]);
      assert.deepEqual(flow.components.map((c) => c.name), ['采购价格', '运输费用']);
      assert.equal(flow.components[0].amount, '800.00');
      assert.equal(flow.componentsTotalCents, 100000, '明细合计应与流水金额相等');

      const rows = await db.query(
        'select component_code, amount_cents from finance_flow_component where flow_id = ? order by component_code',
        [flowId],
      );
      assert.deepEqual(rows.map((r) => r.component_code), ['purchase_price', 'transport_fee']);
      assert.deepEqual(rows.map((r) => Number(r.amount_cents)), [80000, 20000]);
    });

    test('★ 明细合计不等于支出金额时抛 ValidationError', async () => {
      const err = await rejectsValidation(
        () => finance.recordExpense(ctx, costFlow({ components: { purchasePrice: '800.00', transportFee: '100.00' } })),
        /成本明细/,
      );
      assert.match(err.message, /900\.00/);
      assert.match(err.message, /1000\.00/);
    });

    test('★ 违反不变式时整笔都不落库（事务回滚）', async () => {
      await rejectsValidation(
        () => finance.recordExpense(ctx, costFlow({ components: { purchasePrice: '1.00' } })),
        /成本明细/,
      );
      assert.equal((await flowsOf()).length, 0, '流水本身也不该残留');
      assert.equal((await db.query('select id from finance_flow_component')).length, 0);
    });

    test('需要明细的分类未填明细时报错', async () => {
      await rejectsValidation(
        () => finance.recordExpense(ctx, { name: '总代成本', amount: '100.00', categoryCode: 'general_agent_cost' }),
        /成本明细/,
      );
    });

    test('明细键也接受组件编码', async () => {
      const flowId = await finance.recordExpense(ctx, costFlow({
        categoryCode: 'own_variety_cost',
        components: { seed_production_fee: '600.00', processing_fee: '400.00' },
      }));
      const flow = (await flowsOf()).find((f) => f.id === flowId);
      assert.deepEqual(flow.components.map((c) => c.code), ['seed_production_fee', 'processing_fee']);
      assert.equal(flow.componentsTotalCents, 100000);
    });

    test('不需要明细的分类不接受明细', async () => {
      await rejectsValidation(
        () => finance.recordExpense(ctx, {
          name: '办公用品', amount: '100.00', categoryCode: 'office',
          components: { transportFee: '100.00' },
        }),
        /费用明细/,
      );
    });

    test('明细项不存在时报错', async () => {
      await rejectsValidation(
        () => finance.recordExpense(ctx, costFlow({ components: { hotelFee: '1000.00' } })),
        /费用明细项/,
      );
    });

    test('明细为负数时报错', async () => {
      await rejectsValidation(
        () => finance.recordExpense(ctx, costFlow({ components: { purchasePrice: '-1000.00' } })),
        /采购价格/,
      );
    });
  });

  describe('4.3 财务查询与展示（按时间段）', () => {
    test('summary 汇总收入、支出与净额，并给出分类明细', async () => {
      await finance.recordIncome(ctx, { name: '销售收入A', amount: '1000.00', categoryCode: 'sales_income', occurredAt: '2026-03-01' });
      await finance.recordIncome(ctx, { name: '其他收入B', amount: '200.00', categoryCode: 'other_income', occurredAt: '2026-03-02' });
      await finance.recordExpense(ctx, { name: '办公费', amount: '300.00', categoryCode: 'office', occurredAt: '2026-03-03' });

      const summary = await finance.summary(ctx, { from: '2026-03-01', to: '2026-03-31' });
      assert.equal(summary.totalIncomeCents, 120000);
      assert.equal(summary.totalIncome, '1200.00');
      assert.equal(summary.totalExpenseCents, 30000);
      assert.equal(summary.totalExpense, '300.00');
      assert.equal(summary.netCents, 90000, '净额 = 收入 − 支出');
      assert.equal(summary.net, '900.00');

      const sales = summary.rows.find((r) => r.categoryCode === 'sales_income');
      assert.equal(sales.amountCents, 100000);
      assert.equal(sales.kind, 'income');
      assert.equal(sales.flowCount, 1);

      // 未发生的分类也要出现且为 0，界面才能照 4.4 / 4.5 的固定清单展示
      assert.equal(summary.rows.find((r) => r.categoryCode === 'travel').amountCents, 0);
      assert.equal(summary.rows.length, 8, '2 个收入分类 + 6 个支出分类，一个都不能少');
    });

    test('summary 按时间段筛选，左闭右开', async () => {
      await finance.recordIncome(ctx, { name: '区内', amount: '100.00', occurredAt: '2026-03-01' });
      await finance.recordIncome(ctx, { name: '区外', amount: '999.00', occurredAt: '2026-04-01' });
      await finance.recordIncome(ctx, { name: '同日', amount: '1.00', occurredAt: '2026-03-31 23:59:59' });

      const summary = await finance.summary(ctx, { from: '2026-03-01', to: '2026-03-31' });
      assert.equal(summary.totalIncomeCents, 10100);
      assert.equal(summary.range.from, '2026-03-01 00:00:00');
      assert.equal(summary.range.to, '2026-04-01 00:00:00', '结束日期加一天作为开区间上界');
    });

    test('不传时间段时为全部时间', async () => {
      await finance.recordIncome(ctx, { name: '甲', amount: '100.00', occurredAt: '2020-01-01' });
      await finance.recordIncome(ctx, { name: '乙', amount: '200.00', occurredAt: '2030-01-01' });
      assert.equal((await finance.summary(ctx, {})).totalIncomeCents, 30000);
    });

    test('listFlows 可按收支方向、分类、经销商与时间段筛选', async () => {
      const dealerId = await db.insert('dealer', { code: 'D001', company_name: '甲经销商' });
      await finance.recordIncome(ctx, { name: '收入甲', amount: '100.00', categoryCode: 'sales_income', dealerId, occurredAt: '2026-03-01' });
      await finance.recordIncome(ctx, { name: '收入乙', amount: '200.00', categoryCode: 'other_income', occurredAt: '2026-03-02' });
      await finance.recordExpense(ctx, { name: '支出丙', amount: '300.00', categoryCode: 'office', dealerId, occurredAt: '2026-04-02' });

      assert.equal((await flowsOf(ctx, { kind: 'income' })).length, 2);
      assert.equal((await flowsOf(ctx, { kind: 'expense' })).length, 1);
      assert.equal((await flowsOf(ctx, { categoryCode: 'other_income' })).length, 1);
      assert.equal((await flowsOf(ctx, { dealerId })).length, 2);
      assert.equal((await flowsOf(ctx, { from: '2026-03-01', to: '2026-03-31' })).length, 2);
      assert.deepEqual((await flowsOf(ctx, { kind: 'income', categoryCode: 'sales_income', dealerId })).map((f) => f.name), ['收入甲']);
    });

    test('dealerLedger 给出某经销商的收入、支出与往来余额', async () => {
      const dealerId = await db.insert('dealer', { code: 'D001', company_name: '甲经销商', region_id: 2 });
      await finance.recordIncome(ctx, { name: '销售回款', amount: '5000.00', categoryCode: 'sales_income', dealerId, occurredAt: '2026-03-01' });
      await finance.recordExpense(ctx, { name: '返利支出', amount: '1200.00', categoryCode: 'other_expense', dealerId, occurredAt: '2026-03-10' });
      await finance.recordIncome(ctx, { name: '无关往来', amount: '999.00', categoryCode: 'other_income', occurredAt: '2026-03-11' });

      const ledger = await finance.dealerLedger(ctx, { from: '2026-03-01', to: '2026-03-31', dealerId });
      assert.equal(ledger.dealerId, dealerId);
      assert.equal(ledger.dealerName, '甲经销商');
      assert.deepEqual(ledger.incomeRows.map((f) => f.name), ['销售回款']);
      assert.deepEqual(ledger.expenseRows.map((f) => f.name), ['返利支出']);
      assert.equal(ledger.totalIncomeCents, 500000);
      assert.equal(ledger.totalExpenseCents, 120000);
      assert.equal(ledger.netCents, 380000, '往来余额 = 收入 − 支出');
      assert.equal(ledger.net, '3800.00');
    });

    test('dealerLedger 的经销商必填且必须存在', async () => {
      await rejectsValidation(() => finance.dealerLedger(ctx, {}), /经销商/);
      await assert.rejects(() => finance.dealerLedger(ctx, { dealerId: 99999 }), /经销商/);
    });

    test('accountBalance = 期初余额 + 收入 − 支出', async () => {
      const accountId = await defaultAccountId();
      await finance.recordIncome(ctx, { name: '甲', amount: '1000.00', categoryCode: 'sales_income', accountId });
      await finance.recordExpense(ctx, { name: '乙', amount: '300.50', categoryCode: 'office', accountId });

      const balance = await finance.accountBalance(ctx, { accountId });
      assert.equal(balance.accountId, accountId);
      assert.equal(balance.openingBalanceCents, 0);
      assert.equal(balance.totalIncomeCents, 100000);
      assert.equal(balance.totalExpenseCents, 30050);
      assert.equal(balance.balanceCents, 69950);
      assert.equal(balance.balance, '699.50');
    });

    test('accountBalance 计入期初余额', async () => {
      const accountId = await defaultAccountId();
      await db.update('account', { opening_balance_cents: 50000 }, { id: accountId });
      await finance.recordIncome(ctx, { name: '甲', amount: '100.00', accountId });

      const balance = await finance.accountBalance(ctx, { accountId });
      assert.equal(balance.openingBalanceCents, 50000);
      assert.equal(balance.balanceCents, 60000);
      assert.equal(balance.balance, '600.00');
    });

    test('未指定账户的流水归入默认账户', async () => {
      // 4.1 / 4.2 的表单里没有账户字段；若一律存空，4.3 的「当前账户余额」将恒为期初余额
      const accountId = await defaultAccountId();
      const id = await finance.recordIncome(ctx, { name: '甲', amount: '100.00' });
      assert.equal((await flowsOf()).find((f) => f.id === id).accountId, accountId);
      assert.equal((await finance.accountBalance(ctx, { accountId })).balanceCents, 10000);
    });

    test('账户不存在时报错', async () => {
      await assert.rejects(() => finance.accountBalance(ctx, { accountId: 99999 }), /账户/);
    });

    test('省略 accountId 返回全部账户与合计', async () => {
      const accountId = await defaultAccountId();
      const secondId = await db.insert('account', {
        code: 'cash', name: '备用金', type: 'cash', opening_balance_cents: 100000,
      });
      await finance.recordIncome(ctx, { name: '甲', amount: '1000.00', accountId });
      await finance.recordExpense(ctx, { name: '乙', amount: '200.00', accountId: secondId });

      const all = await finance.accountBalance(ctx, {});
      assert.equal(all.accounts.length, 2);
      assert.equal(all.accounts.find((a) => a.accountId === accountId).balanceCents, 100000);
      // 备用金：期初 1000.00 − 支出 200.00 = 800.00
      assert.equal(all.accounts.find((a) => a.accountId === secondId).balanceCents, 80000);
      assert.equal(all.totalBalanceCents, 180000);
      assert.equal(all.totalBalance, '1800.00');
    });
  });

  describe('4.4 分类收入明细 / 4.5 分类支出明细', () => {
    test('分类收入明细按分类汇总', async () => {
      await finance.recordIncome(ctx, { name: '甲', amount: '1000.00', categoryCode: 'sales_income', occurredAt: '2026-03-01' });
      await finance.recordIncome(ctx, { name: '乙', amount: '500.00', categoryCode: 'sales_income', occurredAt: '2026-03-02' });
      await finance.recordIncome(ctx, { name: '丙', amount: '200.00', categoryCode: 'other_income', occurredAt: '2026-03-03' });
      await finance.recordExpense(ctx, { name: '丁', amount: '999.00', categoryCode: 'office', occurredAt: '2026-03-04' });

      const report = await finance.categoryReport(ctx, { from: '2026-03-01', to: '2026-03-31', kind: 'income' });
      assert.equal(report.kind, 'income');
      assert.deepEqual(report.rows.map((r) => r.categoryCode), ['sales_income', 'other_income'], '只列收入分类');
      assert.equal(report.rows[0].amountCents, 150000);
      assert.equal(report.rows[0].amount, '1500.00');
      assert.equal(report.rows[0].flowCount, 2);
      assert.equal(report.rows[1].amountCents, 20000);
      assert.equal(report.totalCents, 170000);
    });

    test('分类支出明细同时给出成本子项汇总，且子项合计等于分类合计', async () => {
      await finance.recordExpense(ctx, costFlow({
        occurredAt: '2026-03-05', components: { purchasePrice: '800.00', transportFee: '200.00' },
      }));
      await finance.recordExpense(ctx, costFlow({
        occurredAt: '2026-03-06', amount: '500.00', components: { purchasePrice: '400.00', transportFee: '100.00' },
      }));
      await finance.recordExpense(ctx, {
        name: '自有品种成本', amount: '1000.00', categoryCode: 'own_variety_cost', occurredAt: '2026-03-07',
        components: { seedProductionFee: '700.00', processingFee: '300.00' },
      });

      const report = await finance.categoryReport(ctx, { from: '2026-03-01', to: '2026-03-31', kind: 'expense' });
      const agent = report.rows.find((r) => r.categoryCode === 'general_agent_cost');
      assert.equal(agent.amountCents, 150000);
      assert.equal(agent.hasDetail, true);
      assert.deepEqual(agent.components.map((c) => [c.code, c.amountCents]), [
        ['purchase_price', 120000],
        ['transport_fee', 30000],
      ]);
      assert.equal(agent.componentsTotalCents, agent.amountCents, '子项合计必须等于分类合计');

      const own = report.rows.find((r) => r.categoryCode === 'own_variety_cost');
      assert.equal(own.amountCents, 100000);
      assert.equal(own.componentsTotalCents, own.amountCents);

      // 无明细的分类不带子项
      const office = report.rows.find((r) => r.categoryCode === 'office');
      assert.equal(office.hasDetail, false);
      assert.deepEqual(office.components, []);
      assert.equal(office.amountCents, 0);
    });

    test('分类报告同样受时间段约束', async () => {
      await finance.recordExpense(ctx, { name: '区内', amount: '100.00', categoryCode: 'office', occurredAt: '2026-03-31' });
      await finance.recordExpense(ctx, { name: '区外', amount: '900.00', categoryCode: 'office', occurredAt: '2026-04-01' });

      const report = await finance.categoryReport(ctx, { from: '2026-03-01', to: '2026-03-31', kind: 'expense' });
      assert.equal(report.rows.find((r) => r.categoryCode === 'office').amountCents, 10000);
      assert.equal(report.totalCents, 10000);
    });

    test('kind 必填且只能是收入 / 支出', async () => {
      await rejectsValidation(() => finance.categoryReport(ctx, {}), /收支方向/);
      await rejectsValidation(() => finance.categoryReport(ctx, { kind: 'both' }), /收支方向/);
    });
  });

  describe('2.2 三级权限', () => {
    let dealerA; let dealerB; let incomeA; let incomeB; let incomeNone;

    beforeEach(async () => {
      dealerA = await db.insert('dealer', { code: 'D001', company_name: '河北经销商', region_id: 2 });
      dealerB = await db.insert('dealer', { code: 'D002', company_name: '华东经销商', region_id: 4 });

      // 经办人 20 号不在 10 号经理的管辖内，确保区域轴是唯一可见性来源
      const operator = ctxOf('L3', 20);
      incomeA = await finance.recordIncome(operator, { name: '河北收入', amount: '100.00', categoryCode: 'sales_income', dealerId: dealerA, occurredAt: '2026-03-01' });
      incomeB = await finance.recordIncome(operator, { name: '华东收入', amount: '200.00', categoryCode: 'sales_income', dealerId: dealerB, occurredAt: '2026-03-02' });
      incomeNone = await finance.recordIncome(operator, { name: '无经销商收入', amount: '300.00', categoryCode: 'other_income', occurredAt: '2026-03-03' });
    });

    test('L1 可见全部流水', async () => {
      assert.equal((await flowsOf(ctxOf('L1', 99))).length, 3);
    });

    test('L2 分管华北，只能看到辖区内经销商的流水', async () => {
      const manager = regionManagerCtx(10, 1);
      const rows = await flowsOf(manager);
      assert.deepEqual(rows.map((f) => f.id), [incomeA], '华北及其下级河北的经销商可见，华东与无经销商的不可见');

      const summary = await finance.summary(manager, {});
      assert.equal(summary.totalIncomeCents, 10000);
      assert.equal((await finance.accountBalance(manager, {})).totalIncomeCents, 10000);

      const ledger = await finance.dealerLedger(manager, { dealerId: dealerA });
      assert.equal(ledger.incomeRows.length, 1);
    });

    test('L2 管辖不到的经销商的往来账被明确拒绝，而不是给出一个空账', async () => {
      // 读也走与写同一套管辖判断：静默返回空账会被误读成「该经销商没有往来」
      const manager = regionManagerCtx(10, 1);
      await rejectsValidation(() => finance.dealerLedger(manager, { dealerId: dealerB }), /管辖范围/);
      const ledger = await finance.dealerLedger(manager, { dealerId: dealerA });
      assert.equal(ledger.totalIncomeCents, 10000);
    });

    test('L3 只能看到自己经手的流水', async () => {
      const self = ctxOf('L3', 20);
      const other = ctxOf('L3', 11);

      assert.equal((await flowsOf(self)).length, 3);
      assert.equal((await flowsOf(other)).length, 0, '11 号没有经手任何流水');

      const own = await finance.recordIncome(other, { name: '李业务记的', amount: '50.00', categoryCode: 'other_income' });
      assert.deepEqual((await flowsOf(other)).map((f) => f.id), [own]);
      assert.equal((await flowsOf(self)).length, 3);
    });

    test('范围配错（L2 无任何管辖）时收紧为看不到数据', async () => {
      // buildScope 对漏配管辖范围的经理返回 kind='none'，对应 SQL 恒假
      const lost = scopedCtx(30, 'L2');
      assert.equal((await flowsOf(lost)).length, 0);
      assert.equal((await finance.summary(lost, {})).totalIncomeCents, 0);
      assert.equal((await finance.categoryReport(lost, { kind: 'income' })).totalCents, 0);
    });

    test('★ L2 不得为辖区外的经销商记账', async () => {
      const manager = regionManagerCtx(10, 1);
      const err = await rejectsValidation(
        () => finance.recordExpense(manager, { name: '运费', amount: '100.00', categoryCode: 'other_expense', dealerId: dealerB }),
        /管辖范围/,
      );
      assert.match(err.message, /华东经销商/);
      assert.equal((await flowsOf(manager)).length, 1, '被拒的支出不应落库');

      // 辖区内的经销商可以正常记账
      await finance.recordExpense(manager, { name: '运费', amount: '100.00', categoryCode: 'other_expense', dealerId: dealerA });
      assert.equal((await flowsOf(manager)).length, 2);
    });

    test('L2 记的账自己能看到（经办人轴）', async () => {
      const manager = regionManagerCtx(10, 1);
      const id = await finance.recordIncome(manager, { name: '经理自记', amount: '10.00', categoryCode: 'other_income' });
      assert.deepEqual((await flowsOf(manager)).map((f) => f.id).includes(id), true);
    });
  });

  describe('9 跨模块联动', () => {
    test('createFlowInTx 可在事务内被其它模块调用', async () => {
      const flowId = await db.tx(async (t) => finance.createFlowInTx(t, {
        kind: 'income',
        categoryCode: 'sales_income',
        occurredAt: '2026-03-08',
        name: '销售单 XS-20260308-001',
        amountCents: 250000,
        sourceType: 'sale',
        sourceId: 77,
        operatorId: 11,
      }));

      const flow = (await flowsOf()).find((f) => f.id === flowId);
      assert.equal(flow.amountCents, 250000, '跨模块调用方手里是整数分');
      assert.equal(flow.sourceType, 'sale');
      assert.equal(flow.sourceId, 77);
      assert.equal(flow.operatorId, 11);
    });

    test('createFlowInTx 也能带成本明细，且与流水同事务', async () => {
      const flowId = await db.tx(async (t) => finance.createFlowInTx(t, {
        kind: 'expense',
        categoryCode: 'general_agent_cost',
        occurredAt: '2026-03-08',
        name: '采购入库成本',
        amountCents: 100000,
        sourceType: 'purchase',
        sourceId: 12,
        components: { purchasePrice: '800.00', transportFee: '200.00' },
        operatorId: 11,
      }));

      const flow = (await flowsOf()).find((f) => f.id === flowId);
      assert.equal(flow.componentsTotalCents, 100000);
      assert.deepEqual(flow.components.map((c) => c.code), ['purchase_price', 'transport_fee']);
    });

    test('事务回滚时流水与明细一并回滚（需求书 8.5）', async () => {
      await assert.rejects(() => db.tx(async (t) => {
        await finance.createFlowInTx(t, {
          kind: 'expense', categoryCode: 'general_agent_cost', occurredAt: '2026-03-08',
          name: '采购成本', amountCents: 100000, sourceType: 'purchase', sourceId: 12,
          components: { purchasePrice: '1000.00' }, operatorId: 11,
        });
        throw new Error('后续步骤失败');
      }), /后续步骤失败/);

      assert.equal((await flowsOf()).length, 0);
      assert.equal((await db.query('select id from finance_flow_component')).length, 0);
    });

    test('来源类型只允许需求书 9 约定的取值', async () => {
      await assert.rejects(() => db.tx(async (t) => finance.createFlowInTx(t, {
        kind: 'income', categoryCode: 'sales_income', name: '甲', amountCents: 100, sourceType: 'unknown',
      })), /来源类型/);
    });
  });
});
