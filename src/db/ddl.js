/**
 * 建表 / 建索引 / 加列的辅助层。
 *
 * 这一层存在的唯一理由是：四种数据库的「不存在才创建」写法各不相同。
 *   CREATE TABLE IF NOT EXISTS    SQLite / MySQL / PostgreSQL 支持，SQL Server 不支持
 *   CREATE INDEX IF NOT EXISTS    SQLite / PostgreSQL 支持，MySQL 与 SQL Server 不支持
 * 收敛在这里之后，迁移脚本可以按同一套写法书写。
 *
 * 迁移必须幂等：MySQL 的 DDL 会隐式提交，迁移中途失败会留下「建了一半」的表结构，
 * 所以每个动作都要能安全地重复执行。
 */

import { assertIdentifier } from './sql/scan.js';

export function createDdl(db) {
  const dialect = db.dialect;
  const name = dialect.name;

  const expand = (body) => dialect.expandDdl(body);

  const quoteList = (columns) => columns.map(assertIdentifier).join(', ');

  return {
    /** 不存在才建表；body 里可写 {{TEXT}} 等逻辑类型标记。 */
    async createTableIfNotExists(table, body) {
      assertIdentifier(table);
      const columns = expand(body);

      if (name === 'mssql') {
        // SQL Server 没有 CREATE TABLE IF NOT EXISTS
        await db.exec(
          `if object_id(N'${table}', N'U') is null create table ${table} (${columns})`,
        );
        return;
      }
      await db.exec(`create table if not exists ${table} (${columns})`);
    },

    /** 不存在才建索引。 */
    async createIndexIfNotExists(indexName, table, columns, { unique = false } = {}) {
      assertIdentifier(indexName);
      assertIdentifier(table);
      const cols = quoteList(columns);
      const kind = unique ? 'unique index' : 'index';

      if (name === 'mysql') {
        // MySQL 不支持 CREATE INDEX IF NOT EXISTS，先查 information_schema
        const existing = await db.query(
          `select index_name from information_schema.statistics
            where table_schema = database() and table_name = ? and index_name = ?`,
          [table, indexName],
        );
        if (existing.length > 0) return;
        await db.exec(`create ${kind} ${indexName} on ${table} (${cols})`);
        return;
      }

      if (name === 'mssql') {
        await db.exec(
          `if not exists (select 1 from sys.indexes where name = '${indexName}'`
          + ` and object_id = object_id('${table}'))`
          + ` create ${kind} ${indexName} on ${table} (${cols})`,
        );
        return;
      }

      await db.exec(`create ${kind} if not exists ${indexName} on ${table} (${cols})`);
    },

    /**
     * 不存在才加列 —— 这是需求书 8.3「版本升级时自动完成表结构迁移」的机制：
     * 读取实际表结构，缺哪列补哪列。
     */
    async addColumnIfMissing(table, column, typeToken) {
      assertIdentifier(table);
      assertIdentifier(column);

      const existing = await db.columns(table);
      if (existing.some((c) => c.name === column)) return false;

      await db.exec(`alter table ${table} add column ${column} ${expand(typeToken)}`);
      // 表结构已变，清掉列缓存，避免后续 insert 用到过期的列信息
      db._cache?.columns.delete(table);
      return true;
    },
  };
}
