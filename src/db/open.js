/**
 * 数据库入口：按配置选择驱动并建立连接。
 *
 * 驱动按需动态加载 —— 默认的 SQLite 使用 Node 内置模块，因此在完全没有执行过
 * npm install 的机器上也能直接运行，这正是需求书 8.1「开箱即用」的落地方式。
 * MySQL / PostgreSQL / SQL Server 的驱动包只在真正选用时才被加载，
 * 未安装时给出明确的中文提示，而不是一个模块找不到的堆栈。
 */

import { getDialect } from './dialect.js';
import { Database } from './database.js';
import { ConfigError } from '../core/errors.js';

/** 只有这里知道驱动文件的名字。 */
const DRIVER_LOADERS = {
  sqlite: () => import('./drivers/sqlite.js').then((m) => m.createSqliteDriver),
  mysql: () => import('./drivers/mysql.js').then((m) => m.createMysqlDriver),
  pg: () => import('./drivers/pg.js').then((m) => m.createPostgresDriver),
  mssql: () => import('./drivers/mssql.js').then((m) => m.createMssqlDriver),
};

/**
 * 建立数据库连接。
 * @param {{dialect?: string, database?: string, host?: string, port?: number,
 *          user?: string, password?: string, file?: string}} config
 */
export async function openDatabase(config = {}) {
  const name = config.dialect || 'sqlite';
  const dialect = getDialect(name);

  const load = DRIVER_LOADERS[name];
  if (!load) throw new ConfigError(`不支持的数据库类型：${name}`);

  const createDriver = await load();
  const driver = await createDriver(config);
  return new Database(driver, dialect);
}
