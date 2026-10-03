import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../helpers/db.js';
import { createCustomersService } from '../../src/services/customers.js';
import { buildScope } from '../../src/domain/scope.js';

const ctxOf = (level = 'L1', id = 1) => ({ user: { id, level, name: '测试' }, scope: buildScope({ id, level }, {}) });

/**
 * 断言「以指定错误码拒绝」。
 * 只匹配中文文案是不够的：文案可以润色，错误码才是前端与接口依赖的契约。
 */
async function rejectsWith(fn, code, pattern) {
  await assert.rejects(fn, (err) => {
    assert.equal(err.code, code, `期望错误码 ${code}，实际 ${err.code}（${err.message}）`);
    assert.match(err.message, pattern);
    return true;
  });
}

describe('customers — 客户管理（需求书 6.1 ~ 6.3）', () => {
  let db;
  let customers;
  let ctx;

  beforeEach(async () => {
    db = await makeDb();
    customers = createCustomersService(db);
    ctx = ctxOf('L1');
  });
  afterEach(async () => { await db.close(); });

  const makeVariety = (code, name) => db.insert('variety', { kind: 'active', code, name });
  const makeRegion = (code, name, parentId = null) => db.insert('region', { code, name, parent_id: parentId });
  const dealerInput = (over = {}) => ({ code: 'D001', companyName: '甲种业有限公司', ...over });

  describe('6.1 经销商信息录入', () => {
    test('录全部字段并原样读回', async () => {
      const region = await makeRegion('R001', '黑龙江省');
      const v1 = await makeVariety('NZ001', '农子1号');
      const v2 = await makeVariety('NZ002', '农子2号');
      const v3 = await makeVariety('NZ900', '农子9号');

      const id = await customers.createDealer(ctx, dealerInput({
        regionId: region,
        contactName: '张三',
        phone: '13800000001',
        agentVarietyIds: [v1, v2],
        pilotVarietyIds: [v3],
      }));

      const d = await customers.getDealer(ctx, id);
      assert.equal(d.code, 'D001');
      assert.equal(d.companyName, '甲种业有限公司');
      assert.equal(d.regionId, region);
      assert.equal(d.regionName, '黑龙江省');
      assert.equal(d.contactName, '张三');
      assert.equal(d.phone, '13800000001');
      assert.equal(d.isPilot, true, '有试点品种即试点经销商');
      assert.deepEqual(d.agentVarieties, [
        { id: v1, code: 'NZ001', name: '农子1号' },
        { id: v2, code: 'NZ002', name: '农子2号' },
      ]);
      assert.deepEqual(d.pilotVarieties, [{ id: v3, code: 'NZ900', name: '农子9号' }]);
    });

    test('只填必填字段时品种关系为空数组', async () => {
      const id = await customers.createDealer(ctx, dealerInput());
      const d = await customers.getDealer(ctx, id);
      assert.deepEqual(d.agentVarieties, []);
      assert.deepEqual(d.pilotVarieties, []);
      assert.equal(d.isPilot, false);
      assert.equal(d.regionId, null);
      assert.equal(d.regionName, null);
    });

    test('编号必填且唯一', async () => {
      await rejectsWith(() => customers.createDealer(ctx, dealerInput({ code: '' })), 'VALIDATION', /编号/);
      await customers.createDealer(ctx, dealerInput());
      await rejectsWith(
        () => customers.createDealer(ctx, dealerInput({ companyName: '另一家' })),
        'VALIDATION',
        /编号.*已存在/,
      );
    });

    test('公司名称必填', async () => {
      await rejectsWith(() => customers.createDealer(ctx, dealerInput({ companyName: '  ' })), 'VALIDATION', /公司名称/);
    });

    test('所在区域必须存在', async () => {
      await rejectsWith(
        () => customers.createDealer(ctx, dealerInput({ regionId: 99999 })),
        'VALIDATION',
        /所在区域/,
      );
    });

    test('引用了不存在的品种时按品种名报错', async () => {
      await rejectsWith(
        () => customers.createDealer(ctx, dealerInput({ agentVarietyIds: [99999] })),
        'VALIDATION',
        /代理品种/,
      );
      await rejectsWith(
        () => customers.createDealer(ctx, dealerInput({ pilotVarietyIds: [99999] })),
        'VALIDATION',
        /试点品种/,
      );
    });

    test('品种的编号与名称一律从品种表解析，调用方传来的字符串被忽略', async () => {
      const v1 = await makeVariety('NZ001', '农子1号');

      const id = await customers.createDealer(ctx, dealerInput({
        agentVarietyIds: [v1],
        // 前端常把界面上显示的名称一并提交回来。名称不是真相来源：
        // 若照单全收，品种改名后经销商档案里就会留下过期的旧名。
        agentVarieties: [{ id: v1, code: '伪造编号', name: '伪造名称' }],
      }));

      const d = await customers.getDealer(ctx, id);
      assert.deepEqual(d.agentVarieties, [{ id: v1, code: 'NZ001', name: '农子1号' }]);
    });

    test('重复的品种 id 去重', async () => {
      const v1 = await makeVariety('NZ001', '农子1号');
      const id = await customers.createDealer(ctx, dealerInput({ agentVarietyIds: [v1, v1, v1] }));
      assert.equal((await customers.getDealer(ctx, id)).agentVarieties.length, 1);
    });

    test('修改经销商：整体替换品种关系而不是追加', async () => {
      const v1 = await makeVariety('NZ001', '农子1号');
      const v2 = await makeVariety('NZ002', '农子2号');
      const id = await customers.createDealer(ctx, dealerInput({ agentVarietyIds: [v1], pilotVarietyIds: [v1] }));

      await customers.updateDealer(ctx, id, { agentVarietyIds: [v2], contactName: '李四' });

      const d = await customers.getDealer(ctx, id);
      assert.deepEqual(d.agentVarieties.map((v) => v.id), [v2]);
      assert.deepEqual(d.pilotVarieties.map((v) => v.id), [v1], '未传的试点品种不受影响');
      assert.equal(d.contactName, '李四');
    });

    test('传空数组即清空对应品种关系', async () => {
      const v1 = await makeVariety('NZ001', '农子1号');
      const id = await customers.createDealer(ctx, dealerInput({ pilotVarietyIds: [v1] }));
      assert.equal((await customers.getDealer(ctx, id)).isPilot, true);

      await customers.updateDealer(ctx, id, { pilotVarietyIds: [] });

      const d = await customers.getDealer(ctx, id);
      assert.deepEqual(d.pilotVarieties, []);
      assert.equal(d.isPilot, false);
    });

    test('修改编号时同样要求唯一', async () => {
      await customers.createDealer(ctx, dealerInput({ code: 'D001' }));
      const id = await customers.createDealer(ctx, dealerInput({ code: 'D002' }));
      await rejectsWith(
        () => customers.updateDealer(ctx, id, { code: 'D001' }),
        'VALIDATION',
        /编号.*已存在/,
      );
    });

    test('没有任何可改字段时报错', async () => {
      const id = await customers.createDealer(ctx, dealerInput());
      await rejectsWith(() => customers.updateDealer(ctx, id, {}), 'VALIDATION', /没有需要更新的字段/);
    });

    test('列出与筛选经销商', async () => {
      const regionA = await makeRegion('RA', '甲区');
      const regionB = await makeRegion('RB', '乙区');
      await customers.createDealer(ctx, dealerInput({ code: 'D001', companyName: '甲区经销商', regionId: regionA }));
      await customers.createDealer(ctx, dealerInput({ code: 'D002', companyName: '乙区经销商', regionId: regionB }));

      assert.deepEqual((await customers.listDealers(ctx, {})).map((d) => d.code), ['D001', 'D002']);
      assert.deepEqual((await customers.listDealers(ctx, { regionId: regionB })).map((d) => d.code), ['D002']);
      assert.deepEqual((await customers.listDealers(ctx, { keyword: '乙区' })).map((d) => d.code), ['D002']);
      assert.deepEqual((await customers.listDealers(ctx, { keyword: 'D001' })).map((d) => d.code), ['D001']);
    });

    test('列表中的经销商带上各自的品种关系', async () => {
      const v1 = await makeVariety('NZ001', '农子1号');
      await customers.createDealer(ctx, dealerInput({ code: 'D001', agentVarietyIds: [v1] }));
      await customers.createDealer(ctx, dealerInput({ code: 'D002' }));

      const list = await customers.listDealers(ctx, {});
      assert.deepEqual(list[0].agentVarieties.map((v) => v.code), ['NZ001']);
      assert.deepEqual(list[1].agentVarieties, []);
    });
  });

  describe('6.2 经销商反馈信息录入', () => {
    let dealerId;
    let varietyId;

    beforeEach(async () => {
      varietyId = await makeVariety('NZ001', '农子1号');
      dealerId = await customers.createDealer(ctx, dealerInput());
    });

    test('录入反馈并原样读回', async () => {
      const id = await customers.recordFeedback(ctx, {
        dealerId,
        varietyId,
        feedbackDate: '2026-03-05',
        content: '出苗整齐，农户反馈良好',
      });

      const item = (await customers.listFeedback(ctx, {}))[0];
      assert.equal(item.id, id);
      assert.equal(item.dealerId, dealerId);
      assert.equal(item.dealerCode, 'D001');
      assert.equal(item.dealerName, '甲种业有限公司');
      assert.equal(item.varietyId, varietyId);
      assert.equal(item.varietyCode, 'NZ001');
      assert.equal(item.varietyName, '农子1号');
      assert.equal(item.feedbackDate, '2026-03-05', '反馈日期是 DATE 列，只存日期');
      assert.equal(item.content, '出苗整齐，农户反馈良好');
    });

    test('反馈品种可以不填', async () => {
      await customers.recordFeedback(ctx, { dealerId, feedbackDate: '2026-03-05', content: '未指明品种' });
      const item = (await customers.listFeedback(ctx, {}))[0];
      assert.equal(item.varietyId, null);
      assert.equal(item.varietyName, null);
    });

    test('经销商必填且必须存在', async () => {
      await rejectsWith(
        () => customers.recordFeedback(ctx, { feedbackDate: '2026-03-05', content: 'x' }),
        'VALIDATION',
        /经销商/,
      );
      await rejectsWith(
        () => customers.recordFeedback(ctx, { dealerId: 99999, feedbackDate: '2026-03-05', content: 'x' }),
        'NOT_FOUND',
        /经销商/,
      );
    });

    test('反馈品种不存在时按品种报错', async () => {
      await rejectsWith(
        () => customers.recordFeedback(ctx, { dealerId, varietyId: 99999, feedbackDate: '2026-03-05', content: 'x' }),
        'VALIDATION',
        /反馈品种/,
      );
    });

    test('反馈日期必填且必须是合法日期', async () => {
      await rejectsWith(
        () => customers.recordFeedback(ctx, { dealerId, content: 'x' }),
        'VALIDATION',
        /反馈日期/,
      );
      await rejectsWith(
        () => customers.recordFeedback(ctx, { dealerId, feedbackDate: '2026-02-30', content: 'x' }),
        'VALIDATION',
        /反馈日期/,
      );
    });

    test('反馈内容必填', async () => {
      await rejectsWith(
        () => customers.recordFeedback(ctx, { dealerId, feedbackDate: '2026-03-05', content: '   ' }),
        'VALIDATION',
        /反馈内容/,
      );
    });
  });

  describe('6.3 反馈查询（按时间段）', () => {
    let v1; let v2; let d1; let d2;

    beforeEach(async () => {
      v1 = await makeVariety('NZ001', '农子1号');
      v2 = await makeVariety('NZ002', '农子2号');
      d1 = await customers.createDealer(ctx, dealerInput({ code: 'D001', companyName: '甲经销商' }));
      d2 = await customers.createDealer(ctx, dealerInput({ code: 'D002', companyName: '乙经销商' }));

      await customers.recordFeedback(ctx, { dealerId: d1, varietyId: v1, feedbackDate: '2026-03-05', content: '甲反馈一' });
      await customers.recordFeedback(ctx, { dealerId: d1, varietyId: v1, feedbackDate: '2026-03-18', content: '甲反馈二' });
      await customers.recordFeedback(ctx, { dealerId: d2, varietyId: v1, feedbackDate: '2026-03-06', content: '乙反馈一' });
      await customers.recordFeedback(ctx, { dealerId: d2, varietyId: v2, feedbackDate: '2026-04-02', content: '乙反馈二' });
    });

    test('① 按品种查询所有经销商某时间段反馈', async () => {
      const report = await customers.feedbackReport(ctx, {
        from: '2026-03-01', to: '2026-03-31', varietyId: v1,
      });

      assert.equal(report.rows.length, 1, '按品种维度只出一行');
      const row = report.rows[0];
      assert.equal(row.varietyId, v1);
      assert.equal(row.varietyCode, 'NZ001');
      assert.equal(row.dealerId, null, '按品种维度不拆经销商');
      assert.equal(row.count, 3);
      assert.equal(row.feedbacks.length, 3);
      assert.equal(report.totals.count, 3);
    });

    test('② 某品种所有经销商反馈：两个经销商的反馈都在同一行里', async () => {
      const report = await customers.feedbackReport(ctx, {
        from: '2026-03-01', to: '2026-03-31', varietyId: v1,
      });

      const dealers = new Set(report.rows[0].feedbacks.map((f) => f.dealerId));
      assert.deepEqual([...dealers].sort(), [d1, d2].sort());
      assert.equal(report.totals.dealerCount, 2);
      assert.equal(report.totals.varietyCount, 1);
    });

    test('③ 某品种某经销商反馈', async () => {
      const report = await customers.feedbackReport(ctx, {
        from: '2026-03-01', to: '2026-03-31', varietyId: v1, dealerId: d1,
      });

      assert.equal(report.rows.length, 1);
      assert.equal(report.rows[0].dealerId, d1);
      assert.equal(report.rows[0].dealerName, '甲经销商');
      assert.equal(report.rows[0].count, 2);
      assert.deepEqual(report.rows[0].feedbacks.map((f) => f.content), ['甲反馈一', '甲反馈二']);
    });

    test('④ 按经销商查询所有品种某时间段反馈', async () => {
      const report = await customers.feedbackReport(ctx, {
        from: '2026-03-01', to: '2026-04-30', dealerId: d2,
      });

      assert.equal(report.rows.length, 2, '乙经销商涉及两个品种，各出一行');
      assert.deepEqual(report.rows.map((r) => r.varietyCode), ['NZ001', 'NZ002']);
      assert.equal(report.rows[0].count, 1);
      assert.equal(report.rows[1].feedbacks[0].content, '乙反馈二');
    });

    test('⑤ 某经销商对其所有品种反馈：按经销商拆解且只含该经销商', async () => {
      const report = await customers.feedbackReport(ctx, { dealerId: d2 });

      assert.equal(report.totals.count, 2);
      assert.equal(report.totals.dealerCount, 1, '只统计到乙经销商一家');
      assert.ok(report.rows.every((r) => r.dealerId === d2));
    });

    test('⑥ 某经销商对某品种反馈', async () => {
      const report = await customers.feedbackReport(ctx, { dealerId: d2, varietyId: v2 });

      assert.equal(report.rows.length, 1);
      assert.equal(report.rows[0].dealerId, d2);
      assert.equal(report.rows[0].varietyId, v2);
      assert.equal(report.rows[0].count, 1);
      assert.equal(report.rows[0].feedbacks[0].content, '乙反馈二');
    });

    test('时间段左闭右开：起止同日只含当天', async () => {
      const report = await customers.feedbackReport(ctx, {
        from: '2026-03-05', to: '2026-03-05', varietyId: v1,
      });

      assert.equal(report.totals.count, 1, '起止同日只能查到当天那条');
      assert.equal(report.rows[0].feedbacks[0].content, '甲反馈一');
    });

    test('区间外没有数据时返回空行与零合计', async () => {
      const report = await customers.feedbackReport(ctx, {
        from: '2026-06-01', to: '2026-06-30', varietyId: v1,
      });

      assert.deepEqual(report.rows, []);
      assert.deepEqual(report.totals, { count: 0, dealerCount: 0, varietyCount: 0 });
    });

    test('不传时间段即全部时间', async () => {
      const report = await customers.feedbackReport(ctx, {});
      assert.equal(report.totals.count, 4);
      assert.deepEqual(report.range, { from: null, to: null });
    });

    test('按品种维度分组并给出合计', async () => {
      const report = await customers.feedbackReport(ctx, {});

      assert.deepEqual(report.rows.map((r) => r.varietyCode), ['NZ001', 'NZ002']);
      assert.equal(report.rows[0].count, 3);
      assert.equal(report.rows[1].count, 1);
      assert.deepEqual(report.totals, { count: 4, dealerCount: 2, varietyCount: 2 });
      assert.deepEqual(report.range, { from: null, to: null });
    });

    test('dimension=dealer 时按「品种 + 经销商」拆解', async () => {
      const report = await customers.feedbackReport(ctx, { dimension: 'dealer' });

      assert.equal(report.rows.length, 3, '(一号,甲) (一号,乙) (二号,乙) 三组');
      assert.deepEqual(
        report.rows.map((r) => [r.varietyCode, r.dealerCode, r.count]),
        [['NZ001', 'D001', 2], ['NZ001', 'D002', 1], ['NZ002', 'D002', 1]],
      );
      assert.deepEqual(report.totals, { count: 4, dealerCount: 2, varietyCount: 2 });
    });

    test('非法统计维度被拒绝', async () => {
      await rejectsWith(() => customers.feedbackReport(ctx, { dimension: 'region' }), 'VALIDATION', /统计维度/);
    });

    test('未指明品种的反馈单独成组，且不计入品种数', async () => {
      await customers.recordFeedback(ctx, { dealerId: d1, feedbackDate: '2026-03-08', content: '未指明品种' });

      const report = await customers.feedbackReport(ctx, {});
      const noVariety = report.rows.find((r) => r.varietyId === null);
      assert.equal(noVariety.count, 1);
      assert.equal(noVariety.varietyName, null);
      assert.equal(report.totals.count, 5);
      assert.equal(report.totals.varietyCount, 2, '未指明品种的反馈不构成一个品种');
    });

    test('明细查询与报表共用同一套时间段与筛选语义', async () => {
      const items = await customers.listFeedback(ctx, {
        from: '2026-03-01', to: '2026-03-31', varietyId: v1,
      });
      assert.equal(items.length, 3);
      assert.deepEqual(items.map((f) => f.feedbackDate), ['2026-03-05', '2026-03-06', '2026-03-18']);
    });

    test('报表回显规范化后的时间段', async () => {
      const report = await customers.feedbackReport(ctx, { from: '2026-03-01', to: '2026-03-31' });
      assert.deepEqual(report.range, { from: '2026-03-01', to: '2026-04-01' });
    });
  });

  describe('权限（需求书 2.2）', () => {
    let regionA; let regionA1; let regionB; let l2ctx; let l3ctx;

    beforeEach(async () => {
      regionA = await makeRegion('RA', '甲区');
      regionA1 = await makeRegion('RA1', '甲区下级', regionA);
      regionB = await makeRegion('RB', '乙区');

      const regions = [
        { id: regionA, parent_id: null },
        { id: regionA1, parent_id: regionA },
        { id: regionB, parent_id: null },
      ];
      const employees = [
        { id: 1, manager_id: null },
        { id: 100, manager_id: 1 },
        { id: 200, manager_id: 100 },
      ];
      const scopes = [{ employee_id: 100, scope_type: 'region', scope_value_id: regionA }];

      l2ctx = {
        user: { id: 100, level: 'L2', name: '王经理' },
        scope: buildScope({ id: 100, level: 'L2' }, { regions, employees, scopes }),
      };
      l3ctx = ctxOf('L3', 200);
    });

    const threeDealers = async () => ({
      dA: await customers.createDealer(ctx, dealerInput({ code: 'D001', companyName: '甲区客户', regionId: regionA })),
      dA1: await customers.createDealer(ctx, dealerInput({ code: 'D002', companyName: '甲区下级客户', regionId: regionA1 })),
      dB: await customers.createDealer(ctx, dealerInput({ code: 'D003', companyName: '乙区客户', regionId: regionB })),
      dNone: await customers.createDealer(ctx, dealerInput({ code: 'D004', companyName: '未填区域客户' })),
    });

    test('L1 看到全部经销商', async () => {
      await threeDealers();
      assert.deepEqual((await customers.listDealers(ctx, {})).map((d) => d.code), ['D001', 'D002', 'D003', 'D004']);
    });

    test('L2 只看到管辖区域（含下级）的经销商', async () => {
      await threeDealers();
      assert.deepEqual(
        (await customers.listDealers(l2ctx, {})).map((d) => d.code),
        ['D001', 'D002'],
        '未填区域的客户不在任何管辖区域内，同样不可见',
      );
    });

    test('L2 读取管辖外的经销商按不存在处理', async () => {
      const { dB } = await threeDealers();
      await rejectsWith(() => customers.getDealer(l2ctx, dB), 'NOT_FOUND', /经销商/);
    });

    test('L2 看不到管辖外经销商的反馈', async () => {
      const { dA, dA1, dB } = await threeDealers();
      const v1 = await makeVariety('NZ001', '农子1号');
      await customers.recordFeedback(ctx, { dealerId: dA, varietyId: v1, feedbackDate: '2026-03-05', content: '甲区反馈' });
      await customers.recordFeedback(ctx, { dealerId: dA1, varietyId: v1, feedbackDate: '2026-03-06', content: '甲区下级反馈' });
      await customers.recordFeedback(ctx, { dealerId: dB, varietyId: v1, feedbackDate: '2026-03-07', content: '乙区反馈' });

      const report = await customers.feedbackReport(l2ctx, { from: '2026-03-01', to: '2026-03-31' });
      assert.equal(report.totals.count, 2, '乙区的反馈不应出现在 L2 的报表里');
      assert.ok(report.rows.every((r) => r.feedbacks.every((f) => f.dealerId !== dB)));

      const empty = await customers.feedbackReport(l2ctx, { dealerId: dB });
      assert.deepEqual(empty.rows, []);
      assert.equal(empty.totals.count, 0);
    });

    test('L3 只看得到自己录入的经销商与反馈', async () => {
      const { dA } = await threeDealers();
      const own = await customers.createDealer(l3ctx, dealerInput({ code: 'D900', companyName: '员工自建客户', regionId: regionB }));
      await customers.recordFeedback(l3ctx, { dealerId: own, feedbackDate: '2026-03-05', content: '员工自己的反馈' });
      await customers.recordFeedback(ctx, { dealerId: dA, feedbackDate: '2026-03-06', content: '经理录的反馈' });

      assert.deepEqual((await customers.listDealers(l3ctx, {})).map((d) => d.code), ['D900']);
      assert.deepEqual((await customers.listFeedback(l3ctx, {})).map((f) => f.dealerId), [own], '只能看到自己录的反馈');
      assert.equal((await customers.listDealers(ctx, {})).length, 5, 'L1 仍然看得到全部');
    });

    test('L2 不能把经销商建到管辖区域之外', async () => {
      await rejectsWith(
        () => customers.createDealer(l2ctx, dealerInput({ code: 'D900', companyName: '越权客户', regionId: regionB })),
        'FORBIDDEN',
        /区域/,
      );
    });

    test('L2 可以把经销商建到下级区域', async () => {
      const id = await customers.createDealer(
        l2ctx,
        dealerInput({ code: 'D900', companyName: '下级区域客户', regionId: regionA1 }),
      );
      assert.equal(id > 0, true);
    });

    test('L2 在管辖区域内新建时必须指定区域', async () => {
      await rejectsWith(
        () => customers.createDealer(l2ctx, dealerInput({ code: 'D900', companyName: '无区域客户' })),
        'VALIDATION',
        /所在区域/,
      );
    });

    test('L2 不能修改管辖外的经销商', async () => {
      const { dB } = await threeDealers();
      await rejectsWith(
        () => customers.updateDealer(l2ctx, dB, { contactName: '越权修改' }),
        'FORBIDDEN',
        /权限/,
      );
    });

    test('L2 不能把已有经销商改挂到管辖外的区域', async () => {
      const { dA } = await threeDealers();
      await rejectsWith(
        () => customers.updateDealer(l2ctx, dA, { regionId: regionB }),
        'FORBIDDEN',
        /区域/,
      );
    });

    test('L2 可以修改管辖内的经销商', async () => {
      const { dA } = await threeDealers();
      await customers.updateDealer(l2ctx, dA, { contactName: '张经理' });
      assert.equal((await customers.getDealer(l2ctx, dA)).contactName, '张经理');
    });

    test('L2 不能给管辖外的经销商录反馈', async () => {
      const { dB } = await threeDealers();
      await rejectsWith(
        () => customers.recordFeedback(l2ctx, { dealerId: dB, feedbackDate: '2026-03-05', content: '越权反馈' }),
        'FORBIDDEN',
        /权限/,
      );
    });

    test('范围为空（漏配管辖）的 L2 既看不到也写不进', async () => {
      await threeDealers();
      const emptyCtx = {
        user: { id: 300, level: 'L2', name: '漏配经理' },
        scope: buildScope({ id: 300, level: 'L2' }, { regions: [], employees: [], scopes: [] }),
      };

      assert.deepEqual(await customers.listDealers(emptyCtx, {}), []);
      await rejectsWith(
        () => customers.createDealer(emptyCtx, dealerInput({ code: 'D900', companyName: '越权客户', regionId: regionA })),
        'FORBIDDEN',
        /权限/,
      );
    });
  });
});
