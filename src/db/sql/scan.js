/**
 * 引号/注释感知的 SQL 字符扫描器。
 *
 * 这是整个数据库抽象层里最容易出静默错误的地方：业务 SQL 里合法出现 `?` 的位置
 * 不止占位符一处 —— LIKE '%?%' 的字符串、注释里的问号、标识符里的问号都很常见。
 * 用正则替换占位符迟早会在这里出错，所以这里逐字符扫描，跟踪所处状态。
 *
 * 支持的状态：
 *   '...'      单引号字符串，'' 表示转义的单引号（SQL 标准）
 *   "..."      双引号标识符，"" 转义
 *   `...`      MySQL 反引号标识符
 *   -- ...     行注释（到行尾）
 *   /* ... *\/  块注释（支持嵌套，PostgreSQL 允许嵌套）
 *   $tag$ ... $tag$  PostgreSQL 美元引用字符串
 */

const NORMAL = 'normal';
const SQUOTE = 'squote';
const DQUOTE = 'dquote';
const BACKTICK = 'backtick';
const LINE_COMMENT = 'line';
const BLOCK_COMMENT = 'block';
const DOLLAR_QUOTE = 'dollar';

/** 匹配 $tag$ 形式的美元引用定界符，tag 可为空。 */
const DOLLAR_TAG = /^\$([A-Za-z_一-龥][A-Za-z0-9_一-龥]*)?\$/;

/**
 * 返回与 sql 等长的布尔掩码，true 表示该下标处是“代码”（非字符串、非注释）。
 * 只有代码位置上的 `?` 和 `;` 才具有占位符/语句分隔符的意义。
 */
export function scanCodeMask(sql) {
  const n = sql.length;
  const isCode = new Array(n).fill(false);

  let state = NORMAL;
  let dollarTag = '';
  let blockDepth = 0;
  let i = 0;

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    switch (state) {
      case NORMAL:
        if (ch === "'") {
          state = SQUOTE;
          i += 1;
        } else if (ch === '"') {
          state = DQUOTE;
          i += 1;
        } else if (ch === '`') {
          state = BACKTICK;
          i += 1;
        } else if (ch === '-' && next === '-') {
          state = LINE_COMMENT;
          i += 2;
        } else if (ch === '/' && next === '*') {
          state = BLOCK_COMMENT;
          blockDepth = 1;
          i += 2;
        } else if (ch === '$') {
          const match = DOLLAR_TAG.exec(sql.slice(i));
          if (match) {
            state = DOLLAR_QUOTE;
            dollarTag = match[0];
            i += dollarTag.length;
          } else {
            // 形如 $1 的位置参数，属于代码
            isCode[i] = true;
            i += 1;
          }
        } else {
          isCode[i] = true;
          i += 1;
        }
        break;

      case SQUOTE:
        if (ch === "'") {
          if (next === "'") i += 2; // '' 转义，字符串继续
          else { state = NORMAL; i += 1; }
        } else {
          i += 1;
        }
        break;

      case DQUOTE:
        if (ch === '"') {
          if (next === '"') i += 2;
          else { state = NORMAL; i += 1; }
        } else {
          i += 1;
        }
        break;

      case BACKTICK:
        if (ch === '`') {
          if (next === '`') i += 2;
          else { state = NORMAL; i += 1; }
        } else {
          i += 1;
        }
        break;

      case LINE_COMMENT:
        if (ch === '\n') {
          state = NORMAL;
          isCode[i] = true;
          i += 1;
        } else {
          i += 1;
        }
        break;

      case BLOCK_COMMENT:
        if (ch === '/' && next === '*') {
          blockDepth += 1;
          i += 2;
        } else if (ch === '*' && next === '/') {
          blockDepth -= 1;
          i += 2;
          if (blockDepth === 0) state = NORMAL;
        } else {
          i += 1;
        }
        break;

      case DOLLAR_QUOTE:
        if (sql.startsWith(dollarTag, i)) {
          i += dollarTag.length;
          state = NORMAL;
        } else {
          i += 1;
        }
        break;

      default:
        i += 1;
    }
  }

  return isCode;
}

/**
 * 把业务 SQL 中统一的 `?` 占位符改写为目标数据库的方言写法。
 * 业务代码与仓储永远只写 `?`，方言差异收敛在这里。
 *
 * sqlite / mysql 原生支持 `?`，原样返回。
 */
export function rewritePlaceholders(sql, dialect) {
  if (dialect !== 'pg' && dialect !== 'mssql') return sql;

  const isCode = scanCodeMask(sql);
  let out = '';
  let index = 0;

  for (let i = 0; i < sql.length; i++) {
    if (isCode[i] && sql[i] === '?') {
      index += 1;
      out += dialect === 'pg' ? `$${index}` : `@p${index}`;
    } else {
      out += sql[i];
    }
  }

  return out;
}

/**
 * 把多语句脚本切分为单条语句，用于 exec() 执行 DDL。
 * 字符串与注释内的分号不参与切分。
 */
export function splitStatements(sql) {
  const isCode = scanCodeMask(sql);
  const statements = [];
  let start = 0;

  for (let i = 0; i < sql.length; i++) {
    if (isCode[i] && sql[i] === ';') {
      const part = sql.slice(start, i).trim();
      if (part) statements.push(part);
      start = i + 1;
    }
  }

  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);

  return statements;
}

/** 校验标识符（表名/列名）。占位符无法覆盖标识符，这里是注入防线。 */
export function assertIdentifier(name) {
  if (typeof name !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`非法的数据库标识符：${name}`);
  }
  return name;
}
