/**
 * SQLite 驱动：默认数据库，开箱即用，无需安装任何第三方包。
 *
 * 使用 Node 内置的 node:sqlite。其 DatabaseSync 是同步 API，这里包成 Promise
 * 以对齐另外三种数据库（它们的驱动天然异步），业务代码因此不必区分数据库。
 */

import { DatabaseSync } from 'node:sqlite';
import { ConfigError } from '../../core/errors.js';

export async function createSqliteDriver(config = {}) {
  const file = config.database || ':memory:';

  let handle;
  try {
    handle = new DatabaseSync(file);
  } catch (err) {
    throw new ConfigError(`无法打开数据库文件 ${file}：${err.message}`);
  }

  // 实测外键约束在 node:sqlite 中默认即为开启，这里显式声明，
  // 避免将来驱动默认值变化时静默失去引用完整性保护。
  handle.exec('PRAGMA foreign_keys = ON');

  if (file !== ':memory:') {
    // WAL 提升并发读写表现；部分文件系统（如网络盘、WSL 的 9p 挂载）不支持，
    // 失败时退回默认日志模式即可，不应因此导致启动失败。
    try {
      handle.exec('PRAGMA journal_mode = WAL');
    } catch {
      /* 该文件系统不支持 WAL，忽略 */
    }
    handle.exec('PRAGMA busy_timeout = 5000');
  }

  /** 把 null 原型对象转为普通对象，使四种驱动的返回值形状完全一致。 */
  const plain = (row) => (row === undefined ? undefined : { ...row });

  return {
    name: 'sqlite',

    async all(sql, params = []) {
      return handle.prepare(sql).all(...params).map(plain);
    },

    async run(sql, params = []) {
      const result = handle.prepare(sql).run(...params);
      return {
        changes: Number(result.changes ?? 0),
        lastInsertId: result.lastInsertRowid === undefined ? null : Number(result.lastInsertRowid),
      };
    },

    async exec(sql) {
      handle.exec(sql);
    },

    async begin() { handle.exec('BEGIN'); },
    async commit() { handle.exec('COMMIT'); },
    async rollback() { handle.exec('ROLLBACK'); },
    async savepoint(name) { handle.exec(`SAVEPOINT ${name}`); },
    async release(name) { handle.exec(`RELEASE SAVEPOINT ${name}`); },
    async rollbackTo(name) { handle.exec(`ROLLBACK TO SAVEPOINT ${name}`); },

    /** 表结构 introspection，供自动建表与增量升级判断列是否已存在。 */
    async columns(table) {
      return handle.prepare(`PRAGMA table_info(${table})`).all().map((c) => ({
        name: c.name,
        type: c.type,
        notNull: c.notnull === 1,
        defaultValue: c.dflt_value,
        primaryKey: c.pk === 1,
      }));
    },

    async tables() {
      return handle
        .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
        .all()
        .map((r) => r.name);
    },

    async close() {
      handle.close();
    },
  };
}
