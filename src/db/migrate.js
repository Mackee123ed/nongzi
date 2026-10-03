/**
 * 迁移执行器：启动时自动建表、自动升级（需求书 8.1 / 8.3）。
 *
 * 设计要点：
 *   - 迁移是 JS 模块而不是 .sql 文件。因为 MySQL 会在 DDL 时隐式提交，
 *     迁移中途失败必然留下「建了一半」的结构，所以每个动作都必须可安全重跑，
 *     而这需要读取实际表结构来判断（见 ddl.js）。纯 SQL 文件做不到这一点。
 *   - 已应用的迁移会记录函数体校验和。若某个已发布的迁移事后被改动，
 *     启动时拒绝运行——那属于数据损坏级别的事件，静默继续只会让问题更难查。
 *   - 迁移不包在事务里：MySQL 的 DDL 隐式提交会让事务形同虚设，
 *     与其给出虚假的原子性承诺，不如让每个动作幂等。
 */

import { createHash } from 'node:crypto';
import { TABLES, UNIQUE_INDEXES, INDEXES } from './schema.js';
import { createDdl } from './ddl.js';
import { ConfigError } from '../core/errors.js';
import { nowString } from './database.js';

/** 已应用的迁移记录在此表，先于一切业务表建立。 */
const MIGRATION_TABLE = 'schema_migration';

const hashMigration = (migration) => createHash('sha256')
  .update(String(migration.up))
  .digest('hex')
  .slice(0, 32);

/** 需求书 4.4 / 4.5 的收支分类。 */
const FINANCE_CATEGORIES = [
  { code: 'sales_income', name: '销售收入', kind: 'income', has_detail: 0, sort_order: 10 },
  { code: 'other_income', name: '其他收入', kind: 'income', has_detail: 0, sort_order: 20 },
  { code: 'general_agent_cost', name: '总代品种成本', kind: 'expense', has_detail: 1, sort_order: 30 },
  { code: 'own_variety_cost', name: '自有品种成本', kind: 'expense', has_detail: 1, sort_order: 40 },
  { code: 'office', name: '办公费用', kind: 'expense', has_detail: 0, sort_order: 50 },
  { code: 'travel', name: '差旅费用', kind: 'expense', has_detail: 0, sort_order: 60 },
  { code: 'hospitality', name: '招待费用', kind: 'expense', has_detail: 0, sort_order: 70 },
  { code: 'other_expense', name: '其他支出', kind: 'expense', has_detail: 0, sort_order: 80 },
];

/** 需求书 4.5 的成本明细子项。 */
const FINANCE_COMPONENTS = [
  { code: 'purchase_price', name: '采购价格', category_code: 'general_agent_cost', sort_order: 10 },
  { code: 'transport_fee', name: '运输费用', category_code: null, sort_order: 20 },
  { code: 'seed_production_fee', name: '制种费用', category_code: 'own_variety_cost', sort_order: 30 },
  { code: 'processing_fee', name: '加工费用', category_code: 'own_variety_cost', sort_order: 40 },
];

export const MIGRATIONS = [
  {
    version: 1,
    name: 'init',
    /** 建立全部业务表与索引。 */
    async up(ddl) {
      for (const [table, body] of Object.entries(TABLES)) {
        await ddl.createTableIfNotExists(table, body);
      }
      for (const [indexName, table, columns] of UNIQUE_INDEXES) {
        await ddl.createIndexIfNotExists(indexName, table, columns, { unique: true });
      }
      for (const [indexName, table, columns] of INDEXES) {
        await ddl.createIndexIfNotExists(indexName, table, columns);
      }
    },
  },
  {
    version: 2,
    name: 'seed-catalogs',
    /** 写入收支分类、费用明细子项与默认账户。 */
    async up(ddl, db) {
      for (const category of FINANCE_CATEGORIES) {
        const exists = await db.one('select id from finance_category where code = ?', [category.code]);
        if (!exists) await db.insert('finance_category', category);
      }

      for (const component of FINANCE_COMPONENTS) {
        const exists = await db.one('select id from finance_component where code = ?', [component.code]);
        if (!exists) await db.insert('finance_component', component);
      }

      const account = await db.one('select id from account where code = ?', ['default']);
      if (!account) {
        await db.insert('account', {
          code: 'default',
          name: '基本账户',
          type: 'bank',
          opening_balance_cents: 0,
          is_active: 1,
        });
      }

      const setting = await db.one('select id from app_setting where setting_key = ?', [
        'auto_create_income_on_sale',
      ]);
      if (!setting) {
        await db.insert('app_setting', {
          setting_key: 'auto_create_income_on_sale',
          setting_value: '1',
          updated_at: nowString(),
        });
      }
    },
  },
];

/**
 * 执行迁移。可反复调用，只有未应用的版本会被执行。
 */
export async function migrate(db) {
  const ddl = createDdl(db);

  await ddl.createTableIfNotExists(MIGRATION_TABLE, `
    id {{PK}},
    version {{INT}} NOT NULL,
    name {{TEXT}} NOT NULL,
    checksum {{TEXT}},
    applied_at {{DATETIME}}
  `);
  await ddl.createIndexIfNotExists(
    'ux_schema_migration_version', MIGRATION_TABLE, ['version'], { unique: true },
  );

  const applied = await db.query(`select version, checksum from ${MIGRATION_TABLE}`);
  const appliedByVersion = new Map(applied.map((r) => [Number(r.version), r.checksum]));

  const ordered = [...MIGRATIONS].sort((a, b) => a.version - b.version);

  for (const migration of ordered) {
    const checksum = hashMigration(migration);

    if (appliedByVersion.has(migration.version)) {
      if (appliedByVersion.get(migration.version) !== checksum) {
        throw new ConfigError(
          `迁移 v${migration.version}（${migration.name}）在已应用之后被修改。`
          + '已发布的迁移不允许改动，请新增一个版本号更大的迁移来实现变更；'
          + '否则各环境的表结构会不一致。',
        );
      }
      continue;
    }

    try {
      await migration.up(ddl, db);
    } catch (err) {
      throw new ConfigError(
        `执行迁移 v${migration.version}（${migration.name}）失败：${err.message}`,
      );
    }

    await db.insert(MIGRATION_TABLE, {
      version: migration.version,
      name: migration.name,
      checksum,
      applied_at: nowString(),
    });
  }
}
