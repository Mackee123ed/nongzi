import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../helpers/db.js';
import { createSalesService } from '../../src/services/sales.js';
import { createInventoryService } from '../../src/services/inventory.js';
import { buildScope } from '../../src/domain/scope.js';
import { ValidationError } from '../../src/core/errors.js';

const ctxOf = (level = 'L1', id = 1) => ({ user: { id, level, name: '测试' }, scope: buildScope({ id, level }, {}) });

describe('sales — 销售管理（需求书 5.1 / 5.2 与跨模块联动）', () => {
  let db;
  let sales;
  let inventory;
  let ctx;
  let v1; let v2; let dealerA; let dealerB;

  beforeEach(async () => {
    db = await makeDb();
    sales = createSalesService(db);
    inventory = createInventoryService(db);
    ctx = ctxOf('L1');

    v1 = await inventory.createVariety(ctx, { kind: 'active', code: 'NZ001', name: '农子1号', nature: 'own', unitPrice: '100.00' });
    v2 = await inventory.createVariety(ctx, { kind: 'active', code: 'NZ002', name: '农子2号', nature: 'own', unitPrice: '50.00' });
    dealerA = await db.insert('dealer', { code: 'D001', company_name: '甲经销商', phone: '13800000001' });
    dealerB = await db.insert('dealer', { code: 'D002', company_name: '乙经销商', phone: '13800000002' });

    await inventory.recordMovement(ctx, { varietyId: v1, direction: 'in', quantity: 1000, occurredAt: '2026-01-01' });
    await inventory.recordMovement(ctx, { varietyId: v2, direction: 'in', quantity: 1000, occurredAt: '2026-01-01' });
  });
  afterEach(async () => { await db.close(); });

  const order = (over = {}) => ({
    orderNo: 'SO20260301001',
    dealerId: dealerA,
    orderDate: '2026-03-01',
    items: [{ varietyId: v1, quantity: 100, unitPrice: '100.00', rebate: '200.00' }],
    ...over,
  });

  describe('5.1 销售单录入', () => {
    test('录单成功并回读，品种与经销商信息自动带出', async () => {
      const id = await sales.createOrder(ctx, order());
      const detail = await sales.getOrder(ctx, id);

      assert.equal(detail.orderNo, 'SO20260301001');
      assert.equal(detail.dealerId, dealerA);
      assert.equal(detail.dealerName, '甲经销商', '经销商名称应从客户管理抓取');
      assert.equal(detail.dealerCode, 'D001');
      assert.equal(detail.dealerPhone, '13800000001', '经销商电话应自动带出');

      const line = detail.items[0];
      assert.equal(line.varietyId, v1);
      assert.equal(line.varietyName, '农子1号', '品种名称应从库存管理抓取');
      assert.equal(line.varietyCode, 'NZ001');
    });

    test('销售金额 = 数量 × 单价，全程整数分运算', async () => {
      const id = await sales.createOrder(ctx, order({
        items: [{ varietyId: v1, quantity: 3, unitPrice: '0.10' }],
      }));
      const line = (await sales.getOrder(ctx, id)).items[0];
      assert.equal(line.amountCents, 30, '0.10 元 × 3 应为 30 分，不能出现浮点误差');
    });

    test('多品种销售单，金额分别计算并汇总', async () => {
      const id = await sales.createOrder(ctx, order({
        items: [
          { varietyId: v1, quantity: 10, unitPrice: '100.00', rebate: '10.00' },
          { varietyId: v2, quantity: 20, unitPrice: '50.00', rebate: '5.00' },
        ],
      }));
      const detail = await sales.getOrder(ctx, id);
      assert.equal(detail.items.length, 2);
      assert.equal(detail.totalAmountCents, 100000 + 100000);
      assert.equal(detail.totalRebateCents, 1000 + 500);
    });

    test('返利金额可单独录入', async () => {
      const id = await sales.createOrder(ctx, order({
        items: [{ varietyId: v1, quantity: 100, unitPrice: '100.00', rebate: '1500.00' }],
      }));
      assert.equal((await sales.getOrder(ctx, id)).items[0].rebateCents, 150000);
    });

    test('订单号唯一', async () => {
      await sales.createOrder(ctx, order());
      await assert.rejects(() => sales.createOrder(ctx, order()), /已存在/);
    });

    test('未指定订单号时自动生成', async () => {
      const id = await sales.createOrder(ctx, order({ orderNo: null }));
      assert.match((await sales.getOrder(ctx, id)).orderNo, /^SO\d{8}\d+$/);
    });

    test('数量必须为正', async () => {
      await assert.rejects(
        () => sales.createOrder(ctx, order({ items: [{ varietyId: v1, quantity: 0, unitPrice: '1' }] })),
        /数量/,
      );
    });

    test('明细不能为空', async () => {
      await assert.rejects(() => sales.createOrder(ctx, order({ items: [] })), /明细/);
    });

    test('品种不存在时报错', async () => {
      await assert.rejects(
        () => sales.createOrder(ctx, order({ items: [{ varietyId: 99999, quantity: 1, unitPrice: '1' }] })),
        /品种/,
      );
    });

    test('经销商不存在时报错', async () => {
      await assert.rejects(() => sales.createOrder(ctx, order({ dealerId: 99999 })), /经销商/);
    });
  });

  describe('★ 跨模块联动：销售出库与库存（需求书 9）', () => {
    test('销售确认后自动产生出库流水，实时库存随之减少', async () => {
      const before = await inventory.getStock(ctx, { varietyId: v1 });
      assert.equal(before.quantity, 1000);

      await sales.createOrder(ctx, order());

      const after = await inventory.getStock(ctx, { varietyId: v1 });
      assert.equal(after.quantity, 900, '销售 100 后库存应减少 100');
      assert.equal(after.totalOut, 100);
    });

    test('出库流水回指销售单，便于双向追溯', async () => {
      const id = await sales.createOrder(ctx, order());
      const movements = await inventory.listMovements(ctx, { varietyId: v1 });
      const linked = movements.find((m) => m.sourceType === 'sale' && m.sourceId === id);
      assert.ok(linked, '应存在指向该销售单的出库流水');
      assert.equal(linked.direction, 'out');
      assert.equal(linked.quantity, 100);
      assert.equal(linked.dealerId, dealerA);
    });

    test('库存不足时拒绝开单', async () => {
      await assert.rejects(
        () => sales.createOrder(ctx, order({ items: [{ varietyId: v1, quantity: 5000, unitPrice: '100' }] })),
        /库存/,
      );
    });

    test('允许超卖时可强制开单', async () => {
      const id = await sales.createOrder(ctx, order({
        allowNegativeStock: true,
        items: [{ varietyId: v1, quantity: 5000, unitPrice: '100' }],
      }));
      assert.ok(id);
      assert.equal((await inventory.getStock(ctx, { varietyId: v1 })).quantity, -4000);
    });

    test('★ 事务一致性：明细非法时，销售单与出库流水一并回滚', async () => {
      // 第二条明细的品种不存在 → 整单必须失败，不能留下半张单或半条出库流水
      await assert.rejects(() => sales.createOrder(ctx, order({
        items: [
          { varietyId: v1, quantity: 10, unitPrice: '100' },
          { varietyId: 99999, quantity: 10, unitPrice: '100' },
        ],
      })));

      const orders = await db.query('select * from sales_order');
      assert.equal(orders.length, 0, '不应残留销售单头');
      const items = await db.query('select * from sales_order_item');
      assert.equal(items.length, 0, '不应残留销售单明细');
      const txn = await db.query("select * from inventory_txn where source_type = 'sale'");
      assert.equal(txn.length, 0, '不应残留出库流水');
      assert.equal((await inventory.getStock(ctx, { varietyId: v1 })).quantity, 1000, '库存不应变动');
    });

    test('作废销售单时冲回库存', async () => {
      const id = await sales.createOrder(ctx, order());
      assert.equal((await inventory.getStock(ctx, { varietyId: v1 })).quantity, 900);

      await sales.voidOrder(ctx, id, '录入错误');
      assert.equal((await inventory.getStock(ctx, { varietyId: v1 })).quantity, 1000, '作废后库存应恢复');
      assert.equal((await sales.getOrder(ctx, id)).status, 'voided');
    });

    test('已作废的单不能重复作废', async () => {
      const id = await sales.createOrder(ctx, order());
      await sales.voidOrder(ctx, id);
      await assert.rejects(() => sales.voidOrder(ctx, id), /已作废|状态/);
    });
  });

  describe('5.2 销售查询（按时间段）', () => {
    beforeEach(async () => {
      // 3 月：v1 卖给 A 100 件、卖给 B 50 件；v2 卖给 A 20 件。4 月另有一单。
      await sales.createOrder(ctx, { orderNo: 'S1', dealerId: dealerA, orderDate: '2026-03-05',
        items: [{ varietyId: v1, quantity: 100, unitPrice: '100.00', rebate: '100.00' }] });
      await sales.createOrder(ctx, { orderNo: 'S2', dealerId: dealerB, orderDate: '2026-03-10',
        items: [{ varietyId: v1, quantity: 50, unitPrice: '100.00', rebate: '50.00' }] });
      await sales.createOrder(ctx, { orderNo: 'S3', dealerId: dealerA, orderDate: '2026-03-20',
        items: [{ varietyId: v2, quantity: 20, unitPrice: '50.00', rebate: '0' }] });
      await sales.createOrder(ctx, { orderNo: 'S4', dealerId: dealerA, orderDate: '2026-04-02',
        items: [{ varietyId: v1, quantity: 10, unitPrice: '100.00', rebate: '0' }] });
    });

    describe('按品种维度', () => {
      test('① 按品种查询某经销商销售明细', async () => {
        const r = await sales.salesReport(ctx, { from: '2026-03-01', to: '2026-03-31', varietyId: v1, dealerId: dealerA, mode: 'detail' });
        assert.equal(r.rows.length, 1);
        assert.equal(r.rows[0].quantity, 100);
        assert.equal(r.rows[0].amountCents, 1000000);
      });

      test('② 按品种查询所有经销商销售明细', async () => {
        const r = await sales.salesReport(ctx, { from: '2026-03-01', to: '2026-03-31', varietyId: v1, mode: 'detail' });
        assert.equal(r.rows.length, 2);
        assert.deepEqual(
          new Set(r.rows.map((x) => x.dealerName)),
          new Set(['甲经销商', '乙经销商']),
        );
      });

      test('③ 按品种查询某经销商销售汇总', async () => {
        const r = await sales.salesReport(ctx, { from: '2026-03-01', to: '2026-03-31', varietyId: v1, dealerId: dealerA, mode: 'summary' });
        assert.equal(r.rows.length, 1);
        assert.equal(r.rows[0].totalQuantity, 100);
        assert.equal(r.rows[0].totalAmountCents, 1000000);
        assert.equal(r.rows[0].totalRebateCents, 10000);
      });

      test('④ 按品种查询所有经销商某品种销售汇总', async () => {
        const r = await sales.salesReport(ctx, { from: '2026-03-01', to: '2026-03-31', varietyId: v1, mode: 'summary', dimension: 'dealer' });
        assert.equal(r.rows.length, 2);
        const a = r.rows.find((x) => x.dealerId === dealerA);
        const b = r.rows.find((x) => x.dealerId === dealerB);
        assert.equal(a.totalQuantity, 100);
        assert.equal(b.totalQuantity, 50);
        assert.equal(r.totals.totalQuantity, 150);
      });
    });

    describe('按经销商维度', () => {
      test('⑤ 按经销商查询某品种销售明细', async () => {
        const r = await sales.salesReport(ctx, { from: '2026-03-01', to: '2026-03-31', dealerId: dealerA, varietyId: v2, mode: 'detail' });
        assert.equal(r.rows.length, 1);
        assert.equal(r.rows[0].varietyName, '农子2号');
      });

      test('⑥ 按经销商查询所有品种销售明细', async () => {
        const r = await sales.salesReport(ctx, { from: '2026-03-01', to: '2026-03-31', dealerId: dealerA, mode: 'detail' });
        assert.equal(r.rows.length, 2, '甲经销商 3 月有两张单');
      });

      test('⑦ 按经销商查询某品种销售汇总', async () => {
        const r = await sales.salesReport(ctx, { from: '2026-03-01', to: '2026-03-31', dealerId: dealerA, varietyId: v1, mode: 'summary' });
        assert.equal(r.rows.length, 1);
        assert.equal(r.rows[0].totalQuantity, 100);
      });

      test('⑧ 按经销商查询所有品种销售汇总', async () => {
        const r = await sales.salesReport(ctx, { from: '2026-03-01', to: '2026-03-31', dealerId: dealerA, mode: 'summary', dimension: 'variety' });
        assert.equal(r.rows.length, 2);
        const byName = new Map(r.rows.map((x) => [x.varietyName, x.totalQuantity]));
        assert.equal(byName.get('农子1号'), 100);
        assert.equal(byName.get('农子2号'), 20);
        assert.equal(r.totals.totalAmountCents, 1000000 + 100000);
      });
    });

    test('时间段左闭右开：起止同日只含当天', async () => {
      const r = await sales.salesReport(ctx, { from: '2026-03-10', to: '2026-03-10', mode: 'detail' });
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0].orderNo, 'S2');
    });

    test('区间外的单据不计入', async () => {
      const r = await sales.salesReport(ctx, { from: '2026-05-01', to: '2026-05-31', mode: 'detail' });
      assert.equal(r.rows.length, 0);
      assert.equal(r.totals.totalAmountCents, 0);
    });

    test('跨月区间包含两张不同月份的单据', async () => {
      const r = await sales.salesReport(ctx, { from: '2026-03-01', to: '2026-04-30', varietyId: v1, dealerId: dealerA, mode: 'detail' });
      assert.equal(r.rows.length, 2);
    });

    test('已作废的单不计入销售统计', async () => {
      const orders = await sales.listOrders(ctx, {});
      const target = orders.find((o) => o.orderNo === 'S2');
      await sales.voidOrder(ctx, target.id);

      const r = await sales.salesReport(ctx, { from: '2026-03-01', to: '2026-03-31', varietyId: v1, mode: 'detail' });
      assert.equal(r.rows.length, 1, '作废单不应出现');
      assert.equal(r.rows[0].dealerId, dealerA);
    });

    test('明细行带出订单号与日期，便于对账', async () => {
      const r = await sales.salesReport(ctx, { from: '2026-03-05', to: '2026-03-05', mode: 'detail' });
      assert.equal(r.rows[0].orderNo, 'S1');
      assert.equal(r.rows[0].orderDate, '2026-03-05');
    });
  });

  describe('权限', () => {
    test('L1 可见全部销售数据', async () => {
      await sales.createOrder(ctx, order());
      const rows = await sales.listOrders(ctxOf('L1', 1), {});
      assert.equal(rows.length, 1);
    });

    test('L3 仅可见本人经手的销售单', async () => {
      const other = ctxOf('L3', 42);
      await sales.createOrder({
        ...ctxOf('L3', 7),
        scope: buildScope({ id: 7, level: 'L3' }, {}),
      }, order());

      assert.equal((await sales.listOrders(other, {})).length, 0, 'L3 不应看到他人单据');
    });
  });
});
