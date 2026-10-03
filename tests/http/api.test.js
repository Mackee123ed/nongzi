import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedOrg } from '../helpers/http.js';

/**
 * 端到端接口测试：真实起服务、真实发请求。
 * 重点验证两件事——跨模块联动是否真的生效，以及权限是否真的挡得住。
 */
describe('HTTP API 端到端', () => {
  let server;
  let org;
  let tokens;

  before(async () => {
    server = await startTestServer();
    org = await seedOrg(server.services);
    tokens = {
      boss: await server.login('boss', 'pass1234'),
      manager: await server.login('mgr', 'pass1234'),
      staff: await server.login('staff', 'pass1234'),
    };
  });

  after(async () => { await server.close(); });

  describe('健康检查与鉴权', () => {
    test('健康检查无需登录', async () => {
      const res = await server.api.get('/api/health');
      assert.equal(res.status, 200);
      assert.equal(res.data.status, 'ok');
    });

    test('未登录访问业务接口返回 401', async () => {
      const res = await server.api.get('/api/varieties');
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'AUTH_REQUIRED');
    });

    test('密码错误返回 401', async () => {
      const res = await server.api.post('/api/auth/login', { empNo: 'boss', password: 'wrong' });
      assert.equal(res.status, 401);
    });

    test('无效令牌返回 401', async () => {
      const res = await server.api.get('/api/varieties', 'bogus-token');
      assert.equal(res.status, 401);
    });

    test('登出后令牌立即失效', async () => {
      const temp = await server.login('staff', 'pass1234');
      assert.equal((await server.api.get('/api/auth/me', temp)).status, 200);
      await server.api.post('/api/auth/logout', {}, temp);
      assert.equal((await server.api.get('/api/auth/me', temp)).status, 401);
    });

    test('/auth/me 返回职级与可见范围说明', async () => {
      const res = await server.api.get('/api/auth/me', tokens.manager);
      assert.equal(res.data.user.level, 'L2');
      assert.equal(res.data.scopeKind, 'scoped');
      assert.match(res.data.scopeLabel, /管辖/);
    });
  });

  describe('库存 → 销售 → 财务 全链路联动（需求书第 9 章）', () => {
    let varietyId;
    let dealerId;

    test('录入品种', async () => {
      const res = await server.api.post('/api/varieties', {
        kind: 'active', code: 'E2E001', name: '端到端品种',
        nature: 'own', unitPrice: '100.00', suitableTempZone: '第一积温带',
      }, tokens.boss);
      assert.equal(res.status, 200);
      varietyId = res.data;
      assert.ok(varietyId);

      const list = await server.api.get('/api/varieties?kind=active', tokens.boss);
      assert.ok(list.data.some((v) => v.code === 'E2E001'));
    });

    test('入库 500 件', async () => {
      const res = await server.api.post('/api/inventory/movements', {
        varietyId, direction: 'in', quantity: 500, occurredAt: '2026-03-01',
      }, tokens.boss);
      assert.equal(res.status, 200);

      const stock = await server.api.get(`/api/inventory/stock?varietyId=${varietyId}`, tokens.boss);
      assert.equal(stock.data.quantity, 500);
    });

    test('录入经销商', async () => {
      const res = await server.api.post('/api/dealers', {
        code: 'E2ED01', companyName: '端到端经销商', phone: '13900000000',
      }, tokens.boss);
      assert.equal(res.status, 200);
      dealerId = res.data;
    });

    test('录入销售单后库存自动扣减', async () => {
      const res = await server.api.post('/api/sales/orders', {
        dealerId,
        orderDate: '2026-03-10',
        items: [{ varietyId, quantity: 120, unitPrice: '100.00', rebate: '50.00' }],
      }, tokens.boss);
      assert.equal(res.status, 200);

      const stock = await server.api.get(`/api/inventory/stock?varietyId=${varietyId}`, tokens.boss);
      assert.equal(stock.data.quantity, 380, '500 入库 − 120 销售 = 380');
    });

    test('销售明细接口带出品种与经销商名称', async () => {
      const res = await server.api.get('/api/reports/sales?mode=detail', tokens.boss);
      assert.equal(res.status, 200);
      const row = res.data.rows.find((r) => r.varietyCode === 'E2E001');
      assert.ok(row, '应能查到该品种的销售明细');
      assert.equal(row.varietyName, '端到端品种');
      assert.equal(row.dealerName, '端到端经销商');
      assert.equal(row.amountCents, 1200000);
    });

    test('库存查询按时间段返回出入库', async () => {
      const res = await server.api.get(
        `/api/reports/inventory.movements?from=2026-03-01&to=2026-03-31&varietyId=${varietyId}`,
        tokens.boss,
      );
      const row = res.data.rows[0];
      assert.equal(row.totalIn, 500);
      assert.equal(row.totalOut, 120);
      assert.equal(row.balance, 380);
    });

    test('销售单已自动生成销售收入流水，账户余额同步', async () => {
      const flows = await server.api.get('/api/finance/flows?kind=income', tokens.boss);
      const income = flows.data.find((f) => f.sourceType === 'sale');
      assert.ok(income, '应存在来源为销售的收入流水');
      assert.equal(income.amountCents, 1200000);

      const balance = await server.api.get('/api/reports/finance.balance', tokens.boss);
      assert.equal(balance.data.totalBalanceCents, 1200000);
    });
  });

  describe('★ 三级权限隔离', () => {
    let northDealer;
    let eastDealer;

    before(async () => {
      northDealer = (await server.api.post('/api/dealers', {
        code: 'P-N01', companyName: '华北经销商', regionId: org.regions.north,
      }, tokens.boss)).data;
      eastDealer = (await server.api.post('/api/dealers', {
        code: 'P-E01', companyName: '华东经销商', regionId: org.regions.east,
      }, tokens.boss)).data;
    });

    test('L1 高管可见全部经销商', async () => {
      const res = await server.api.get('/api/dealers', tokens.boss);
      const codes = res.data.map((d) => d.code);
      assert.ok(codes.includes('P-N01'));
      assert.ok(codes.includes('P-E01'));
    });

    test('★ L2 经理只可见分管区域内的经销商，看不到辖区外的', async () => {
      const res = await server.api.get('/api/dealers', tokens.manager);
      const codes = res.data.map((d) => d.code);
      assert.ok(codes.includes('P-N01'), '华北在分管范围内，应可见');
      assert.ok(!codes.includes('P-E01'), '华东不在分管范围内，不应可见');
    });

    test('★ L2 分管区域包含下级区域（华北含河北）', async () => {
      const hebeiDealer = (await server.api.post('/api/dealers', {
        code: 'P-H01', companyName: '河北经销商', regionId: org.regions.hebei,
      }, tokens.boss)).data;
      assert.ok(hebeiDealer);

      const res = await server.api.get('/api/dealers', tokens.manager);
      const codes = res.data.map((d) => d.code);
      assert.ok(codes.includes('P-H01'), '河北是华北的下级区域，应可见');
    });

    test('★ L2 不得在管辖范围外新建经销商', async () => {
      const res = await server.api.post('/api/dealers', {
        code: 'P-X01', companyName: '越权经销商', regionId: org.regions.east,
      }, tokens.manager);
      assert.ok(res.status === 403 || res.status === 422, `应被拒绝，实际 ${res.status}`);
    });

    test('★ L3 员工看不到他人经手的销售单', async () => {
      // 上面的销售单由 boss 录入，L3 不应看到
      const res = await server.api.get('/api/sales/orders', tokens.staff);
      assert.equal(res.status, 200);
      assert.equal(res.data.length, 0, 'L3 不应看到他人录入的销售单');
    });

    test('★ L3 能录入销售单，且之后能看到自己那一单', async () => {
      const variety = (await server.api.post('/api/varieties', {
        kind: 'active', code: 'E2E-L3', name: 'L3测试品种', nature: 'own', unitPrice: '10.00',
      }, tokens.boss)).data;
      await server.api.post('/api/inventory/movements', {
        varietyId: variety, direction: 'in', quantity: 100,
      }, tokens.boss);

      const created = await server.api.post('/api/sales/orders', {
        dealerId: northDealer,
        orderDate: '2026-03-15',
        items: [{ varietyId: variety, quantity: 5, unitPrice: '10.00' }],
      }, tokens.staff);
      assert.equal(created.status, 200, JSON.stringify(created.body));

      const res = await server.api.get('/api/sales/orders', tokens.staff);
      assert.equal(res.data.length, 1, 'L3 应能看到自己录入的销售单');
    });

    test('★ 前端传参无法越权：L3 手工拼接 regionId 也拿不到辖区外数据', async () => {
      const res = await server.api.get(
        `/api/dealers?regionId=${org.regions.east}`,
        tokens.staff,
      );
      // 权限条件来自会话，不接受前端传参放宽
      assert.equal(res.status, 200);
      assert.ok(!res.data.some((d) => d.code === 'P-E01'), '不应因前端传参而放宽范围');
    });
  });

  describe('错误映射', () => {
    test('字段校验失败返回 422 与中文提示', async () => {
      const res = await server.api.post('/api/varieties', { kind: 'active', code: '', name: '' }, tokens.boss);
      assert.equal(res.status, 422);
      assert.equal(res.body.error.code, 'VALIDATION');
      assert.match(res.body.error.message, /品种/);
    });

    test('品种编码重复返回冲突错误', async () => {
      await server.api.post('/api/varieties', {
        kind: 'active', code: 'DUP01', name: '甲', nature: 'own', unitPrice: '1',
      }, tokens.boss);
      const res = await server.api.post('/api/varieties', {
        kind: 'active', code: 'DUP01', name: '乙', nature: 'own', unitPrice: '1',
      }, tokens.boss);
      assert.ok(res.status === 409 || res.status === 422);
      assert.match(res.body.error.message, /已存在/);
    });

    test('不存在的接口返回 404', async () => {
      const res = await server.api.get('/api/nope', tokens.boss);
      assert.equal(res.status, 404);
    });

    test('非法时间段返回 422 而非 500', async () => {
      const res = await server.api.get('/api/reports/sales?from=2026-03-31&to=2026-03-01', tokens.boss);
      assert.equal(res.status, 422, '起止日期颠倒属于入参问题，不应是服务器错误');
    });

    test('库存不足时销售单被拒绝', async () => {
      const variety = (await server.api.post('/api/varieties', {
        kind: 'active', code: 'E2E-LOW', name: '库存不足品种', nature: 'own', unitPrice: '10.00',
      }, tokens.boss)).data;
      const dealer = (await server.api.get('/api/dealers', tokens.boss)).data[0];

      const res = await server.api.post('/api/sales/orders', {
        dealerId: dealer.id,
        orderDate: '2026-03-20',
        items: [{ varietyId: variety, quantity: 9999, unitPrice: '10.00' }],
      }, tokens.boss);
      assert.equal(res.status, 422);
      assert.match(res.body.error.message, /库存/);
    });
  });

  describe('前端静态资源', () => {
    test('根路径返回页面', async () => {
      const response = await fetch(`${server.base}/`);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /农子财务系统/);
    });

    test('未知路径回落到首页（前端使用 hash 路由）', async () => {
      const response = await fetch(`${server.base}/some/deep/link`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /农子财务系统/);
    });

    test('目录穿越被拒绝', async () => {
      const response = await fetch(`${server.base}/../../../etc/passwd`);
      const text = await response.text();
      assert.doesNotMatch(text, /root:/, '不应读到 web 根目录之外的文件');
    });

    test('页面引用了站点图标', async () => {
      const html = await (await fetch(`${server.base}/`)).text();
      assert.match(html, /rel="icon"/);
      assert.match(html, /\/pic\//);
    });

    test('站点图标可从 /pic/ 挂载点取到，且类型正确', async () => {
      const response = await fetch(`${server.base}/pic/${encodeURIComponent('农子.ico')}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /image\/x-icon|image\/vnd\.microsoft\.icon/);

      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.readUInt16LE(0), 0, 'ICO 保留字段应为 0');
      assert.equal(bytes.readUInt16LE(2), 1, 'ICO 类型应为 1（图标）');
      assert.ok(bytes.readUInt16LE(4) >= 1, 'ICO 应至少含一张图像');
    });

    test('★ /pic/ 挂载点同样禁止目录穿越', async () => {
      const response = await fetch(`${server.base}/pic/..%2f..%2f..%2fetc%2fpasswd`);
      const text = await response.text();
      assert.doesNotMatch(text, /root:/, '不应越过挂载点根目录');
    });

    test('挂载点下不存在的文件返回 404，而不是回落到首页', async () => {
      const response = await fetch(`${server.base}/pic/does-not-exist.png`);
      assert.equal(response.status, 404, '图标缺失应明确 404，便于排查');
    });
  });

  /**
   * 前端页面组装的请求体，必须真的能被后端接受。
   *
   * 这条测试补的是一个真实漏洞：在营 / 待营品种共用 /api/varieties，靠 kind 区分，
   * 而 kind 由页面决定、不在表单里。此前页面新增时只发表单字段，用户把该填的都填了
   * 仍被后端拦下，提示「品种类别不能为空」——接口测试却因为都显式传了 kind 而全绿。
   * 所以这里刻意**用页面自己的组装函数**产出请求体，再打真实接口。
   */
  describe('新增品种：页面组装的请求体后端必须接受', () => {
    test('★ 在营品种（表单里没有 kind，页面必须补上）', async () => {
      const { buildCreatePayload } = await import('../../src/web/js/pages.js');
      const { RESOURCES } = await import('../../src/web/js/resources.js');

      // 用户在「在营品种」表单里实际能填的字段
      const values = {
        code: 'UI001', name: '界面录入品种', nature: 'own', unitPrice: '88.00',
        nationalApprovalNo: '国审2026001', suitableTempZone: '第一积温带',
        promoRegion: '黑龙江', packSpec: '20kg/袋', features: '抗倒伏',
      };
      const payload = buildCreatePayload(RESOURCES['variety-active'], values);
      assert.equal(payload.kind, 'active', 'kind 必须由页面上下文补上');

      const res = await server.api.post('/api/varieties', payload, tokens.boss);
      assert.equal(res.status, 200, `后端应接受页面组装的请求体：${JSON.stringify(res.body)}`);

      const list = await server.api.get('/api/varieties?kind=active', tokens.boss);
      assert.ok(list.data.some((v) => v.code === 'UI001'), '新增的品种应出现在在营列表里');
    });

    test('★ 待营品种同理', async () => {
      const { buildCreatePayload } = await import('../../src/web/js/pages.js');
      const { RESOURCES } = await import('../../src/web/js/resources.js');

      const payload = buildCreatePayload(RESOURCES['variety-pending'], {
        code: 'UI002', name: '界面录入待营品种', expectedApprovalYear: 2027, pilotPackSpec: '5kg/袋',
      });
      const res = await server.api.post('/api/varieties', payload, tokens.boss);
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });
  });

  describe('帮助页面所需的文档资源', () => {
    test('使用说明以 Markdown 形式可取到', async () => {
      const response = await fetch(`${server.base}/docs/${encodeURIComponent('使用说明.md')}`);
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.match(text, /^# 农子财务管理系统 · 使用说明/);
    });

    test('使用说明里的截图可取到，类型为图片', async () => {
      const response = await fetch(`${server.base}/docs/images/${encodeURIComponent('01-登录.png')}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /image\/png/);
    });

    test('更新日志可取到且含版本小节', async () => {
      const response = await fetch(`${server.base}/CHANGELOG.md`);
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.match(text, /^## \d+\.\d+\.\d+/m, '应含形如 ## 1.1.0 的版本小节');
    });

    test('★ 文档挂载点同样禁止目录穿越', async () => {
      const response = await fetch(`${server.base}/docs/..%2f..%2f..%2fetc%2fpasswd`);
      assert.doesNotMatch(await response.text(), /root:/);
    });

    test('帮助页面引用的每个截图文件都真实存在', async () => {
      const markdown = await (await fetch(
        `${server.base}/docs/${encodeURIComponent('使用说明.md')}`,
      )).text();

      const refs = [...markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
      assert.ok(refs.length > 0, '使用说明里应至少引用一张截图');

      for (const ref of refs) {
        const response = await fetch(`${server.base}/docs/${ref}`);
        assert.equal(response.status, 200, `文档引用的截图缺失：${ref}`);
      }
    });

    test('更新日志不包含未替换的占位符', async () => {
      const text = await (await fetch(`${server.base}/CHANGELOG.md`)).text();
      assert.doesNotMatch(text, /TODO|待补充|xxx/i);
    });
  });
});
