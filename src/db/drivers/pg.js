/**
 * PostgreSQL 驱动（可选）。
 *
 * 与 MySQL 驱动同样采用「当前事务连接」的做法：事务期间独占一条连接，
 * 其余时候走连接池。串行化由 Database 的互斥锁保证。
 */

import { ConfigError } from '../../core/errors.js';

export async function createPostgresDriver(config = {}) {
  let pg;
  try {
    pg = await import('pg');
  } catch {
    throw new ConfigError('数据库驱动 pg 未安装，请先运行：npm install pg');
  }

  // BIGINT 默认被 pg 解析成字符串（因为可能超出 JS 安全整数范围）。
  // 本系统的 BIGINT 只用于主键，量级远小于 2^53，转成 Number 让上层拿到的
  // 数据类型与另外三种数据库一致。
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

  const pool = new pg.Pool({
    host: config.host || '127.0.0.1',
    port: Number(config.port) || 5432,
    user: config.user,
    password: config.password,
    database: config.database,
    max: 10,
  });

  try {
    const probe = await pool.connect();
    probe.release();
  } catch (err) {
    throw new ConfigError(`无法连接 PostgreSQL：${err.message}`);
  }

  let txClient = null;
  const run = (sql, params) => (txClient
    ? txClient.query(sql, params)
    : pool.query(sql, params));

  return {
    name: 'pg',

    async all(sql, params = []) {
      const result = await run(sql, params);
      return result.rows;
    },

    async run(sql, params = []) {
      const result = await run(sql, params);
      return {
        changes: Number(result.rowCount ?? 0),
        // PostgreSQL 需靠 RETURNING 取回自增主键，insert() 已自动追加该子句
        lastInsertId: result.rows?.[0]?.id !== undefined ? Number(result.rows[0].id) : null,
      };
    },

    async exec(sql) {
      await run(sql, []);
    },

    async begin() {
      txClient = await pool.connect();
      await txClient.query('BEGIN');
    },
    async commit() {
      await txClient.query('COMMIT');
      txClient.release();
      txClient = null;
    },
    async rollback() {
      await txClient.query('ROLLBACK');
      txClient.release();
      txClient = null;
    },
    async savepoint(name) { await txClient.query(`SAVEPOINT ${name}`); },
    async release(name) { await txClient.query(`RELEASE SAVEPOINT ${name}`); },
    async rollbackTo(name) { await txClient.query(`ROLLBACK TO SAVEPOINT ${name}`); },

    async columns(table) {
      const result = await run(
        `select column_name as name, data_type as type, is_nullable as nullable,
                column_default as "defaultValue"
           from information_schema.columns
          where table_name = $1 and table_schema = current_schema()`,
        [table],
      );
      return result.rows.map((r) => ({
        name: r.name,
        type: r.type,
        notNull: r.nullable === 'NO',
        defaultValue: r.defaultValue,
        primaryKey: false,
      }));
    },

    async tables() {
      const result = await run(
        "select table_name as name from information_schema.tables where table_schema = current_schema()",
      );
      return result.rows.map((r) => r.name);
    },

    async close() {
      if (txClient) { txClient.release(); txClient = null; }
      await pool.end();
    },
  };
}
