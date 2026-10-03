/**
 * 测试夹具：建一个已迁移完成的内存数据库。
 *
 * 一律使用 :memory: 而非临时文件。项目所在盘是 9p/drvfs 挂载，
 * 文件级锁在该文件系统上不可靠，落盘数据库会出现偶发锁定失败；
 * 内存库既规避了这一点，也让整套测试保持在秒级。
 */

import { openDatabase } from '../../src/db/open.js';
import { migrate } from '../../src/db/migrate.js';

export async function makeDb() {
  const db = await openDatabase({ dialect: 'sqlite', database: ':memory:' });
  await migrate(db);
  return db;
}

/** 建库并返回 { db, close }，便于测试用 after() 收尾。 */
export async function makeDbWithCleanup() {
  const db = await makeDb();
  return {
    db,
    async close() {
      await db.close();
    },
  };
}
