/**
 * 系统配置（需求书 8.4 连接配置：地址、端口、库名、账号、密码，保存后重启生效）。
 *
 * 默认配置指向内嵌 SQLite，因此首次启动无需任何配置即可跑起来（需求书 8.1）。
 * 配置写入采用「先写临时文件再改名」的方式：直接覆盖原文件时若中途断电，
 * 会留下一个半截的 JSON，下次启动直接起不来。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ConfigError } from './core/errors.js';
import { DIALECT_NAMES } from './db/dialect.js';

export const DEFAULT_PORT = 8787;

/** 默认配置。数据库文件放在数据目录下，与代码分离，便于备份与迁移。 */
export function defaultConfig(dataDir) {
  return {
    server: { host: '127.0.0.1', port: DEFAULT_PORT },
    database: {
      dialect: 'sqlite',
      database: join(dataDir, 'nongzi.db'),
      host: '127.0.0.1',
      port: null,
      user: null,
      password: null,
    },
    dataDir,
  };
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)
        && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 读取配置；文件不存在时返回默认配置而不报错（首次启动的正常路径）。
 */
export function loadConfig(configPath, { dataDir } = {}) {
  const base = defaultConfig(dataDir ?? dirname(configPath));

  if (!existsSync(configPath)) return base;

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new ConfigError(`配置文件 ${configPath} 不是合法的 JSON：${err.message}`);
  }

  const config = deepMerge(base, parsed);
  validateConfig(config);
  return config;
}

/** 原子写入配置。 */
export function saveConfig(configPath, config) {
  validateConfig(config);
  mkdirSync(dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  renameSync(tempPath, configPath);
  return config;
}

/** 校验配置合法性，返回中文错误。 */
export function validateConfig(config) {
  const problems = [];

  const dialect = config?.database?.dialect;
  if (!DIALECT_NAMES.includes(dialect)) {
    problems.push(`数据库类型必须是 ${DIALECT_NAMES.join(' / ')} 之一，当前为「${dialect ?? '空'}」`);
  }

  const port = config?.server?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`服务端口必须是 1~65535 的整数，当前为「${port ?? '空'}」`);
  }

  // 非内嵌数据库才需要连接参数；SQLite 只需文件路径
  if (dialect && dialect !== 'sqlite') {
    if (!config.database.database) problems.push('数据库名称不能为空');
    if (!config.database.host) problems.push('数据库地址不能为空');
    const dbPort = config.database.port;
    if (dbPort !== null && dbPort !== undefined && (!Number.isInteger(dbPort) || dbPort < 1)) {
      problems.push('数据库端口不正确');
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(`配置有误：${problems.join('；')}`);
  }
  return true;
}

/** 供界面展示，隐藏密码。 */
export function redactConfig(config) {
  return {
    ...config,
    database: {
      ...config.database,
      password: config.database.password ? '******' : null,
    },
  };
}

/**
 * 决定数据目录。
 * 优先使用程序目录下的 data；不可写（例如装在 C:\Program Files）时退回用户目录，
 * 这样绿色部署与常规安装两种方式都能正常工作。
 */
export function resolveDataDir(appDir) {
  const candidates = [
    join(appDir, 'data'),
    join(process.env.LOCALAPPDATA ?? join(process.env.HOME ?? '.', '.local', 'share'), '农子财务系统'),
  ];

  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      // 真正写一次才能确认可写：某些目录 mkdir 成功但写入被拒。
      // 探测完立刻删掉，不给用户目录留下无用文件。
      const probe = join(dir, '.write-probe');
      writeFileSync(probe, '');
      rmSync(probe, { force: true });
      return resolve(dir);
    } catch {
      /* 换下一个候选目录 */
    }
  }
  throw new ConfigError('找不到可写的数据目录，请检查程序所在目录的权限');
}
