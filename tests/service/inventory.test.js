import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../helpers/db.js';
import { createInventoryService } from '../../src/services/inventory.js';
import { buildScope } from '../../src/domain/scope.js';

const ctxOf = (level = 'L1', id = 1) => ({ user: { id, level, name: '测试' }, scope: buildScope({ id, level }, {}) });

describe('inventory — 库存管理（需求书 3.1 ~ 3.4）', () => {
  let db;
  let inventory;
  let ctx;

  beforeEach(async () => {
    db = await makeDb();
    inventory = createInventoryService(db);
    ctx = ctxOf('L1');
  });
  afterEach(async () => { await db.close(); });

  const activeVariety = (over = {}) => ({
    kind: 'active', code: 'NZ001', name: '农子1号', nature: 'own',
    nationalApprovalNo: '国审玉2026001', suitableTempZone: '第一积温带',
    promoRegion: '黑龙江、吉林', features: '耐密植', packSpec: '5kg/袋',
    unitPrice: '128.00', tieredRebateNote: '满100袋返2元/袋', policy: '现款现货',
    ...over,
  });

  describe('3.1 在营品种录入', () => {
    test('录全部字段并原样读回', async () => {
      const id = await inventory.createVariety(ctx, activeVariety());
      const v = await inventory.getVariety(ctx, id);

      assert.equal(v.kind, 'active');
      assert.equal(v.name, '农子1号');
      assert.equal(v.nature, 'own');
      assert.equal(v.nationalApprovalNo, '国审玉2026001');
      assert.equal(v.suitableTempZone, '第一积温带');
      assert.equal(v.promoRegion, '黑龙江、吉林');
      assert.equal(v.packSpec, '5kg/袋');
      assert.equal(v.unitPriceCents, 12800, '单价应以分存储');
      assert.equal(v.tieredRebateNote, '满100袋返2元/袋');
      assert.equal(v.policy, '现款现货');
    });

    test('品种性质只允许 总代 / 自有', async () => {
      await assert.rejects(
        () => inventory.createVariety(ctx, activeVariety({ nature: '其它' })),
        /品种性质/,
      );
      const id = await inventory.createVariety(ctx, activeVariety({ nature: 'general_agent' }));
      assert.equal((await inventory.getVariety(ctx, id)).nature, 'general_agent');
    });

    test('品种编码唯一', async () => {
      await inventory.createVariety(ctx, activeVariety());
      await assert.rejects(() => inventory.createVariety(ctx, activeVariety({ name: '另一个' })), /已存在/);
    });

    test('缺少必填字段时报错', async () => {
      await assert.rejects(() => inventory.createVariety(ctx, activeVariety({ name: '' })), /品种名称/);
      await assert.rejects(() => inventory.createVariety(ctx, activeVariety({ code: '' })), /品种编码/);
    });

    test('在营品种必须填品种性质', async () => {
      await assert.rejects(() => inventory.createVariety(ctx, activeVariety({ nature: null })), /品种性质/);
    });
  });

  describe('3.2 待营品种录入', () => {
    test('录待营品种，字段与在营不同', async () => {
      const id = await inventory.createVariety(ctx, {
        kind: 'pending', code: 'NZ900', name: '农子9号（待审）',
        expectedApprovalYear: 2027, suitableTempZone: '第二积温带',
        promoRegion: '吉林', features: '早熟', pilotPackSpec: '1kg/试装',
      });
      const v = await inventory.getVariety(ctx, id);
      assert.equal(v.kind, 'pending');
      assert.equal(v.expectedApprovalYear, 2027);
      assert.equal(v.pilotPackSpec, '1kg/试装');
    });

    test('待营品种不要求品种性质与单价', async () => {
      const id = await inventory.createVariety(ctx, {
        kind: 'pending', code: 'NZ901', name: '农子10号',
      });
      assert.equal((await inventory.getVariety(ctx, id)).nature, null);
    });

    test('按 kind 分列查询', async () => {
      await inventory.createVariety(ctx, activeVariety());
      await inventory.createVariety(ctx, { kind: 'pending', code: 'NZ900', name: '待营甲' });

      assert.deepEqual((await inventory.listVarieties(ctx, { kind: 'active' })).map((v) => v.code), ['NZ001']);
      assert.deepEqual((await inventory.listVarieties(ctx, { kind: 'pending' })).map((v) => v.code), ['NZ900']);
      assert.equal((await inventory.listVarieties(ctx, {})).length, 2);
    });

    test('待营品种转在营', async () => {
      const id = await inventory.createVariety(ctx, { kind: 'pending', code: 'NZ900', name: '待营甲' });
      await inventory.promoteVariety(ctx, id, { nature: 'own', unitPrice: '99.50' });

      const v = await inventory.getVariety(ctx, id);
      assert.equal(v.kind, 'active');
      assert.equal(v.nature, 'own');
      assert.equal(v.unitPriceCents, 9950);
    });
  });

  describe('3.3 出入库办理与实时库存', () => {
    let varietyId;
    beforeEach(async () => { varietyId = await inventory.createVariety(ctx, activeVariety()); });

    test('入库、出库后实时库存 = 入库量 - 出库量', async () => {
      await inventory.recordMovement(ctx, { varietyId, direction: 'in', quantity: 100, occurredAt: '2026-03-01' });
      await inventory.recordMovement(ctx, { varietyId, direction: 'in', quantity: 50, occurredAt: '2026-03-05' });
      await inventory.recordMovement(ctx, { varietyId, direction: 'out', quantity: 30, occurredAt: '2026-03-10' });

      const stock = await inventory.getStock(ctx, { varietyId });
      assert.equal(stock.totalIn, 150);
      assert.equal(stock.totalOut, 30);
      assert.equal(stock.quantity, 120, '实时库存应为 入 - 出');
    });

    test('无流水时库存为 0', async () => {
      const stock = await inventory.getStock(ctx, { varietyId });
      assert.equal(stock.quantity, 0);
    });

    test('重复办理时库存持续累加', async () => {
      await inventory.recordMovement(ctx, { varietyId, direction: 'in', quantity: 10 });
      await inventory.recordMovement(ctx, { varietyId, direction: 'in', quantity: 5 });
      assert.equal((await inventory.getStock(ctx, { varietyId })).quantity, 15);
    });

    test('数量必须为正整数', async () => {
      await assert.rejects(
        () => inventory.recordMovement(ctx, { varietyId, direction: 'in', quantity: 0 }),
        /数量/,
      );
      await assert.rejects(
        () => inventory.recordMovement(ctx, { varietyId, direction: 'in', quantity: -5 }),
        /数量/,
      );
    });

    test('方向只能是 in / out', async () => {
      await assert.rejects(
        () => inventory.recordMovement(ctx, { varietyId, direction: 'sideways', quantity: 1 }),
        /方向/,
      );
    });

    test('品种不存在时报错', async () => {
      await assert.rejects(
        () => inventory.recordMovement(ctx, { varietyId: 99999, direction: 'in', quantity: 1 }),
        /品种/,
      );
    });

    test('记录入库时间与出库时间', async () => {
      await inventory.recordMovement(ctx, { varietyId, direction: 'in', quantity: 20, occurredAt: '2026-03-01 09:30:00' });
      const rows = await inventory.listMovements(ctx, {});
      assert.equal(rows[0].occurredAt, '2026-03-01 09:30:00');
      assert.equal(rows[0].direction, 'in');
    });

    test('未指定时间时默认取当前时间', async () => {
      await inventory.recordMovement(ctx, { varietyId, direction: 'in', quantity: 1 });
      const rows = await inventory.listMovements(ctx, {});
      assert.match(rows[0].occurredAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });
  });

  describe('3.4 库存查询（按时间段）', () => {
    let v1; let v2; let dealerA; let dealerB;

    beforeEach(async () => {
      v1 = await inventory.createVariety(ctx, activeVariety({ code: 'NZ001', name: '农子1号' }));
      v2 = await inventory.createVariety(ctx, activeVariety({ code: 'NZ002', name: '农子2号' }));
      dealerA = await db.insert('dealer', { code: 'D001', company_name: '甲经销商' });
      dealerB = await db.insert('dealer', { code: 'D002', company_name: '乙经销商' });

      await inventory.recordMovement(ctx, { varietyId: v1, dealerId: dealerA, direction: 'in', quantity: 100, occurredAt: '2026-03-01' });
      await inventory.recordMovement(ctx, { varietyId: v1, dealerId: dealerA, direction: 'out', quantity: 30, occurredAt: '2026-03-10' });
      await inventory.recordMovement(ctx, { varietyId: v1, dealerId: dealerB, direction: 'out', quantity: 20, occurredAt: '2026-03-15' });
      await inventory.recordMovement(ctx, { varietyId: v2, dealerId: dealerB, direction: 'in', quantity: 80, occurredAt: '2026-04-01' });
    });

    test('① 单一品种的总出入库', async () => {
      const report = await inventory.movementsReport(ctx, {
        from: '2026-03-01', to: '2026-03-31', varietyId: v1,
      });
      const row = report.rows.find((r) => r.varietyId === v1);
      assert.equal(row.totalIn, 100);
      assert.equal(row.totalOut, 50);
      assert.equal(row.balance, 50);
    });

    test('② 单一品种的某经销商出入库', async () => {
      const report = await inventory.movementsReport(ctx, {
        from: '2026-03-01', to: '2026-03-31', varietyId: v1, dealerId: dealerA,
      });
      assert.equal(report.rows.length, 1);
      assert.equal(report.rows[0].dealerId, dealerA);
      assert.equal(report.rows[0].totalIn, 100);
      assert.equal(report.rows[0].totalOut, 30);
    });

    test('③ 某代理商的所有品种出入库', async () => {
      const report = await inventory.movementsReport(ctx, {
        from: '2026-03-01', to: '2026-04-30', dealerId: dealerB,
      });
      assert.equal(report.rows.length, 2, '乙经销商涉及两个品种');
      const v1Row = report.rows.find((r) => r.varietyId === v1);
      const v2Row = report.rows.find((r) => r.varietyId === v2);
      assert.equal(v1Row.totalOut, 20);
      assert.equal(v2Row.totalIn, 80);
    });

    test('④ 所有品种的出入库', async () => {
      const report = await inventory.movementsReport(ctx, { from: '2026-03-01', to: '2026-04-30' });
      assert.equal(report.rows.length, 2);
      const total = report.totals;
      assert.equal(total.totalIn, 180);
      assert.equal(total.totalOut, 50);
      assert.equal(total.balance, 130);
    });

    test('时间段左闭右开：起止同日只含当天', async () => {
      const report = await inventory.movementsReport(ctx, { from: '2026-03-10', to: '2026-03-10' });
      assert.equal(report.rows.length, 1);
      assert.equal(report.rows[0].totalOut, 30);
    });

    test('区间外的时间不计入', async () => {
      const report = await inventory.movementsReport(ctx, { from: '2026-05-01', to: '2026-05-31' });
      assert.equal(report.rows.length, 0);
      assert.equal(report.totals.totalIn, 0);
    });

    test('不传时间段则为全部时间', async () => {
      const report = await inventory.movementsReport(ctx, {});
      assert.equal(report.totals.totalIn, 180);
    });
  });

  describe('按经销商维度的实时库存', () => {
    test('分经销商的库存独立统计', async () => {
      const v = await inventory.createVariety(ctx, activeVariety());
      const d1 = await db.insert('dealer', { code: 'D001', company_name: '甲' });
      const d2 = await db.insert('dealer', { code: 'D002', company_name: '乙' });

      await inventory.recordMovement(ctx, { varietyId: v, dealerId: d1, direction: 'in', quantity: 100 });
      await inventory.recordMovement(ctx, { varietyId: v, dealerId: d1, direction: 'out', quantity: 40 });
      await inventory.recordMovement(ctx, { varietyId: v, dealerId: d2, direction: 'in', quantity: 60 });

      const stock = await inventory.getStock(ctx, { varietyId: v });
      assert.equal(stock.quantity, 120);
      const byDealer = new Map(stock.byDealer.map((r) => [r.dealerId, r.quantity]));
      assert.equal(byDealer.get(d1), 60);
      assert.equal(byDealer.get(d2), 60);
    });
  });
});
