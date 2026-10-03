/**
 * MySQL / MariaDB 驱动（可选）。
 *
 * mysql2 是第三方包，采用动态 import：只有配置里真的选了 mysql 才会加载，
 * 默认走 SQLite 的部署完全不需要安装它。
 *
 * 事务期间必须独占同一条连接，否则 BEGIN 与后续语句会落在不同连接上。
 * 本层所有操作已被 Database 的互斥锁串行化，因此用「当前事务连接」这一个字段
 * 记录即可，不会出现两个事务争抢同一条连接的情况。
 */

import { ConfigError } from '../../core/errors.js';

export async function createMysqlDriver(config = {}) {
  let mysql;
  try {
    mysql = await import('mysql2/promise');
  } catch {
    throw new ConfigError('数据库驱动 mysql2 未安装，请先运行：npm install mysql2');
  }

  const pool = mysql.createPool({
    host: config.host || '127.0.0.1',
    port: Number(config.port) || 3306,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: 10,
    // 日期/时间以字符串返回，避免驱动自行转 Date 造成时区偏移
    dateStrings: true,
    multipleStatements: false,
    charset: 'utf8mb4',
  });

  // 连接池建立是惰性的，这里主动取一次连接以便尽早暴露账号/网络问题
  try {
    const probe = await pool.getConnection();
    probe.release();
  } catch (err) {
    throw new ConfigError(`无法连接 MySQL：${err.message}`);
  }

  let txConnection = null;
  const run = async (sql, params) => {
    if (txConnection) return txConnection.execute(sql, params);
    return pool.execute(sql, params);
  };

  return {
    name: 'mysql',

    async all(sql, params = []) {
      const [rows] = await run(sql, params);
      return rows;
    },

    async run(sql, params = []) {
      const [result] = await run(sql, params);
      return {
        changes: Number(result.affectedRows ?? 0),
        lastInsertId: result.insertId ? Number(result.insertId) : null,
      };
    },

    async exec(sql) {
      // 逐条执行由上层保证，这里直接下发
      if (txConnection) await txConnection.query(sql);
      else await pool.query(sql);
    },

    async begin() {
      txConnection = await pool.getConnection();
      await txConnection.beginTransaction();
    },
    async commit() {
      await txConnection.commit();
      txConnection.release();
      txConnection = null;
    },
    async rollback() {
      await txConnection.rollback();
      txConnection.release();
      txConnection = null;
    },
    async savepoint(name) { await txConnection.query(`SAVEPOINT ${name}`); },
    async release(name) { await txConnection.query(`RELEASE SAVEPOINT ${name}`); },
    async rollbackTo(name) { await txConnection.query(`ROLLBACK TO SAVEPOINT ${name}`); },

    async columns(table) {
      const [rows] = await run(`SHOW COLUMNS FROM ${table}`);
      return rows.map((r) => ({
        name: r.Field,
        type: r.Type,
        notNull: r.Null === 'NO',
        defaultValue: r.Default,
        primaryKey: r.Key === 'PRI',
      }));
    },

    async tables() {
      const [rows] = await run(
        'select table_name as name from information_schema.tables where table_schema = database()',
      );
      return rows.map((r) => r.name);
    },

    async close() {
      if (txConnection) { txConnection.release(); txConnection = null; }
      await pool.end();
    },
  };
}
