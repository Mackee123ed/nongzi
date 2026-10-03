/**
 * SQL Server 驱动（可选）。
 *
 * mssql（基于 tedious）的事务 API 与另外三种不同：需要显式构造 Request 对象，
 * 并把事务挂到请求上。这里把它包装成与其它驱动一致的形状。
 *
 * 注意：SQL Server 不支持 RETURNING，取回自增主键要用 OUTPUT INSERTED.id，
 * 该子句由 database.js 的 insert() 负责注入。
 */

import { ConfigError } from '../../core/errors.js';

export async function createMssqlDriver(config = {}) {
  let sql;
  try {
    sql = await import('mssql');
  } catch {
    throw new ConfigError('数据库驱动 mssql 未安装，请先运行：npm install mssql');
  }

  const pool = new sql.ConnectionPool({
    server: config.host || '127.0.0.1',
    port: Number(config.port) || 1433,
    user: config.user,
    password: config.password,
    database: config.database,
    options: {
      encrypt: config.encrypt !== false,
      trustServerCertificate: config.trustServerCertificate !== false,
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  });

  try {
    await pool.connect();
  } catch (err) {
    throw new ConfigError(`无法连接 SQL Server：${err.message}`);
  }

  let tx = null;

  const query = async (text, params = []) => {
    const request = tx ? new sql.Request(tx) : pool.request();
    params.forEach((value, index) => request.input(`p${index + 1}`, value));
    return request.query(text);
  };

  return {
    name: 'mssql',

    async all(text, params = []) {
      const result = await query(text, params);
      return result.recordset ?? [];
    },

    async run(text, params = []) {
      const result = await query(text, params);
      return {
        changes: Number(result.rowsAffected?.[0] ?? 0),
        lastInsertId: result.recordset?.[0]?.id !== undefined
          ? Number(result.recordset[0].id)
          : null,
      };
    },

    async exec(text) {
      await query(text, []);
    },

    async begin() {
      tx = new sql.Transaction(pool);
      await tx.begin();
    },
    async commit() {
      await tx.commit();
      tx = null;
    },
    async rollback() {
      await tx.rollback();
      tx = null;
    },
    async savepoint(name) {
      await new sql.Request(tx).query(`SAVE TRANSACTION ${name}`);
    },
    // SQL Server 的 SAVE TRANSACTION 没有独立的释放语句，提交或回滚外层事务时
    // 自然结束，因此 release 是空操作，仅为对齐四种驱动的接口形状。
    async release() {},
    async rollbackTo(name) {
      await new sql.Request(tx).query(`ROLLBACK TRANSACTION ${name}`);
    },

    async columns(table) {
      const result = await query(
        `select column_name as name, data_type as type, is_nullable as nullable,
                column_default as defaultValue
           from information_schema.columns
          where table_name = @p1`,
        [table],
      );
      return result.recordset.map((r) => ({
        name: r.name,
        type: r.type,
        notNull: r.nullable === 'NO',
        defaultValue: r.defaultValue,
        primaryKey: false,
      }));
    },

    async tables() {
      const result = await query(
        "select table_name as name from information_schema.tables where table_type = 'BASE TABLE'",
      );
      return result.recordset.map((r) => r.name);
    },

    async close() {
      await pool.close();
    },
  };
}
