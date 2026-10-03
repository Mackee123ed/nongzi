#!/usr/bin/env node
/**
 * 程序入口（需求书 1.2「单入口、自动拉起」）。
 *
 * 双击启动后的完整链路：
 *   1. 确定数据目录（优先程序目录，不可写则退回用户目录）
 *   2. 读取配置（没有配置文件就用默认的内嵌 SQLite）
 *   3. 打开数据库并自动建表 / 自动升级
 *   4. 空库时创建默认管理员并打印初始密码
 *   5. 监听本机端口（被占用则自动顺延）
 *   6. 用系统默认浏览器打开页面
 *
 * 整个过程不需要用户做任何配置，这条路径就是需求书 8.1「开箱即用」的实现。
 */

import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { dirname, join, isAbsolute , resolve } from 'node:path';
import { resolveDataDir, loadConfig } from './config.js';
import { openDatabase } from './db/open.js';
import { migrate } from './db/migrate.js';
import { createServices } from './services/index.js';
import { startServer, openBrowser } from './http/server.js';

const srcDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(srcDir, '..');

function resolveSqlitePath(config, dataDir) {
  const file = config.database.database;
  if (config.database.dialect !== 'sqlite') return config;
  if (!file || file === ':memory:' || isAbsolute(file)) return config;
  // 配置里写相对路径时，相对于数据目录而非进程工作目录，
  // 这样从任何位置启动程序，数据库文件都落在同一个地方。
  return { ...config, database: { ...config.database, database: join(dataDir, file) } };
}

export async function main({
  // 设 NZ_NO_BROWSER=1 可跳过自动打开浏览器。
  // 部署为后台服务、或自动化冒烟测试时会用到。
  openBrowser: shouldOpenBrowser = process.env.NZ_NO_BROWSER !== '1',
  logger = console,
} = {}) {
  // 环境变量覆盖，供自动化脚本（冒烟测试、生成文档截图）在不碰用户配置的前提下
  // 指定独立的数据目录与端口。
  let dataDir;
  if (process.env.NZ_DATA_DIR) {
    dataDir = resolve(process.env.NZ_DATA_DIR);
    mkdirSync(dataDir, { recursive: true });
  } else {
    dataDir = resolveDataDir(rootDir);
  }
  const configPath = join(rootDir, 'config.json');

  let config = loadConfig(configPath, { dataDir });
  if (process.env.NZ_PORT) {
    config = { ...config, server: { ...config.server, port: Number(process.env.NZ_PORT) } };
  }
  config = resolveSqlitePath(config, dataDir);

  logger.log('农子财务管理系统 正在启动…');
  logger.log(`  数据目录：${dataDir}`);
  logger.log(`  数据库：${config.database.dialect} · ${config.database.database ?? ''}`);

  const db = await openDatabase(config.database);

  try {
    await migrate(db);
  } catch (err) {
    logger.error(`数据库初始化失败：${err.message}`);
    await db.close();
    throw err;
  }

  const services = createServices({ db, config, configPath });

  const created = await services.ensureDefaultAdmin();
  const port = config.server?.port ?? 8787;
  void port;

  const server = await startServer({
    db,
    services,
    webRoot: join(srcDir, 'web'),
    staticMounts: {
      // 品牌资源（图标等）留在 src/pic，直接挂载，不必往 web 目录复制一份
      '/pic/': join(srcDir, 'pic'),
      // 使用说明与更新日志也只有一份（docs/ 与根目录），帮助页面直接读取，
      // 避免"文档更新了、页面里还是旧的"。顺带把截图也一并提供。
      '/docs/': join(rootDir, 'docs'),
      '/CHANGELOG.md': join(rootDir, 'CHANGELOG.md'),
    },
    config,
    logger,
  });

  logger.log('');
  logger.log('  ──────────────────────────────────────────');
  logger.log(`  系统已就绪：${server.url}`);
  logger.log('  ──────────────────────────────────────────');

  if (created) {
    logger.log('');
    logger.log('  首次使用，已创建默认管理员账号：');
    logger.log(`    工号：${created.empNo}`);
    logger.log(`    初始密码：${created.initialPassword}`);
    logger.log('  请登录后尽快修改密码。');
    logger.log('');
  }

  logger.log('  关闭此窗口即可停止服务。');
  logger.log('');

  if (shouldOpenBrowser) openBrowser(server.url);

  const shutdown = async () => {
    logger.log('\n正在退出…');
    await server.close();
    await db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { server, db, services, config, created };
}

// 作为主模块直接运行时才启动；被测试 import 时不自动运行
const invokedDirectly = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  main().catch((err) => {
    console.error('\n启动失败：', err.message);
    if (err.stack && process.env.NZ_DEBUG) console.error(err.stack);
    process.exit(1);
  });
}
