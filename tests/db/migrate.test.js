import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/open.js';
import { migrate, MIGRATIONS } from '../../src/db/migrate.js';
import { TABLES } from '../../src/db/schema.js';

async function freshDb() {
  return openDatabase({ dialect: 'sqlite', database: ':memory:' });
}

describe('migrate — 自动建表与版本升级（需求书 8.1 / 8.3）', () => {
  test('首次启动自动建出全部业务表，无需人工建库建表', async () => {
    const db = await freshDb();
    await migrate(db);

    const existing = new Set(await db.tables());
    for (const table of Object.keys(TABLES)) {
      assert.ok(existing.has(table), `缺少数据表：${table}`);
    }
    await db.close();
  });

  test('记录迁移版本', async () => {
    const db = await freshDb();
    await migrate(db);

    const rows = await db.query('select version, name, applied_at from schema_migration order by version');
    assert.equal(rows.length, MIGRATIONS.length);
    assert.equal(rows[0].version, 1);
    assert.match(rows[0].applied_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    await db.close();
  });

  test('可重复执行（幂等）——第二次启动不会报错也不会重复记录', async () => {
    const db = await freshDb();
    await migrate(db);
    await migrate(db);
    await migrate(db);

    const rows = await db.query('select count(*) as c from schema_migration');
    assert.equal(rows[0].c, MIGRATIONS.length);
    await db.close();
  });

  test('迁移已应用后校验文件被改动 → 拒绝启动', async () => {
    const db = await freshDb();
    await migrate(db);

    // 模拟「已发布的迁移脚本被事后修改」：篡改记录中的校验和
    await db.run('update schema_migration set checksum = ? where version = 1', ['tampered']);

    await assert.rejects(() => migrate(db), /校验|checksum|被修改/i);
    await db.close();
  });

  test('基础数据随迁移写入：收支分类与默认账户', async () => {
    const db = await freshDb();
    await migrate(db);

    const categories = await db.query('select code, kind from finance_category order by id');
    const codes = categories.map((c) => c.code);
    for (const expected of [
      'sales_income', 'other_income',
      'general_agent_cost', 'own_variety_cost', 'office', 'travel', 'hospitality', 'other_expense',
    ]) {
      assert.ok(codes.includes(expected), `缺少收支分类：${expected}`);
    }

    const accounts = await db.query('select code, name from account');
    assert.ok(accounts.length >= 1, '应建有默认账户，否则「当前账户余额」无立足点');
    await db.close();
  });

  test('费用明细子项随迁移写入（需求书 4.5）', async () => {
    const db = await freshDb();
    await migrate(db);

    const components = await db.query('select code from finance_component');
    const codes = components.map((c) => c.code);
    for (const expected of ['purchase_price', 'transport_fee', 'seed_production_fee', 'processing_fee']) {
      assert.ok(codes.includes(expected), `缺少费用明细子项：${expected}`);
    }
    await db.close();
  });

  test('迁移后中文与金额字段可正常读写', async () => {
    const db = await freshDb();
    await migrate(db);

    const id = await db.insert('variety', {
      kind: 'active',
      code: 'NZ001',
      name: '农子1号',
      nature: 'own',
      features: '耐密植、抗倒伏，适合机械化收割',
      unit_price_cents: 12800,
    });
    const row = await db.one('select * from variety where id = ?', [id]);
    assert.equal(row.name, '农子1号');
    assert.equal(row.features, '耐密植、抗倒伏，适合机械化收割');
    assert.equal(row.unit_price_cents, 12800);
    await db.close();
  });

  test('唯一约束在业务表上生效', async () => {
    const db = await freshDb();
    await migrate(db);

    await db.insert('variety', { kind: 'active', code: 'NZ001', name: '甲' });
    await assert.rejects(
      () => db.insert('variety', { kind: 'active', code: 'NZ001', name: '乙' }),
      /已存在/,
    );
    await db.close();
  });

  test('kind 字段受 CHECK 约束限制', async () => {
    const db = await freshDb();
    await migrate(db);

    await assert.rejects(
      () => db.insert('variety', { kind: '不存在的状态', code: 'X', name: '甲' }),
      /取值|约束|CHECK/i,
    );
    await db.close();
  });
});
