/**
 * 时间段查询统一采用左闭右开区间 [from, to+1天)。
 *
 * 原因：需求书里几乎所有查询都是“按时间段”。若用 [from, to] 闭区间，就得处理
 * 23:59:59.999 这类边界，是典型的差一错误来源。统一把用户选的“结束日期”加一天
 * 作为开区间上界，同一天起止就自然只覆盖当天。
 *
 * 时间一律按本地时间处理并格式化为 'YYYY-MM-DD HH:MM:SS' 字符串。
 * 切勿使用 toISOString()：它按 UTC 输出，会让中国时区的日期整体前移 8 小时，
 * 跨月/跨年边界直接错位。
 */

import { ValidationError } from '../core/errors.js';

const RANGE_ERROR = '时间范围不合法';

/** 时间范围相关的错误一律是可映射为 422 的校验错误，而不是 500。 */
const rangeError = () => new ValidationError(RANGE_ERROR);

const pad2 = (n) => String(n).padStart(2, '0');

/** 格式化为本地日期 'YYYY-MM-DD'。 */
export function formatDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw rangeError();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 格式化为本地日期时间 'YYYY-MM-DD HH:MM:SS'。 */
export function formatDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw rangeError();
  return `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * 解析 'YYYY-MM-DD' 或 'YYYY-MM-DD HH:MM:SS'（也接受 T 分隔）为本地时间 Date。
 * 非法日期（如 2026-02-30）返回 null，而不是被 Date 静默滚动到下个月。
 */
export function parseDate(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (!match) return null;

  const [, y, mo, d, h = '0', mi = '0', s = '0'] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));

  // 回读各字段，拦截 2026-02-30 这类被 Date 归一化的非法日期
  if (
    date.getFullYear() !== Number(y) ||
    date.getMonth() !== Number(mo) - 1 ||
    date.getDate() !== Number(d) ||
    date.getHours() !== Number(h) ||
    date.getMinutes() !== Number(mi) ||
    date.getSeconds() !== Number(s)
  ) {
    return null;
  }
  return date;
}

export function isValidDate(input) {
  return parseDate(input) !== null;
}

/** 今天的 'YYYY-MM-DD'。 */
export function today() {
  return formatDate(new Date());
}

/** 所在月首日 'YYYY-MM-01'。 */
export function monthOf(input) {
  const d = parseDate(input);
  if (!d) throw rangeError();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-01`;
}

/** 工资/社保所属期 'YYYY-MM'。接受日期字符串或 Date。 */
export function periodOf(input) {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) throw rangeError();
    return `${input.getFullYear()}-${pad2(input.getMonth() + 1)}`;
  }
  const d = parseDate(input);
  if (!d) throw rangeError();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/**
 * 把用户输入的起止日期规范化为可直接用于 SQL 的左闭右开边界。
 * 任一端为 null/undefined/'' 表示该侧不限。
 * @returns {{from: string|null, toExclusive: string|null}}
 */
export function normalizeRange(from, to) {
  const hasFrom = from !== null && from !== undefined && from !== '';
  const hasTo = to !== null && to !== undefined && to !== '';

  const fromDate = hasFrom ? parseDate(from) : null;
  const toDate = hasTo ? parseDate(to) : null;

  if (hasFrom && !fromDate) throw rangeError();
  if (hasTo && !toDate) throw rangeError();

  if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
    throw rangeError();
  }

  return {
    from: fromDate ? `${formatDate(fromDate)} 00:00:00` : null,
    // 结束日期加一天作为开区间上界；Date 构造自动处理跨月、跨年与闰年
    toExclusive: toDate
      ? `${formatDate(new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1))} 00:00:00`
      : null,
  };
}

/**
 * 同上，但产出**日期粒度**的边界（'YYYY-MM-DD'），用于 DATE 类型的列。
 *
 * ★ 为什么必须区分：DATE 列里存的是 '2026-03-10'，而带时间的边界是
 *   '2026-03-10 00:00:00'。字符串比较下 '2026-03-10' < '2026-03-10 00:00:00'，
 *   于是 `order_date >= '2026-03-10 00:00:00'` 恒为假，区间查询会**静默地一条都查不到**。
 *   凡是 DATE 列（order_date / feedback_date / pay_date / hire_date …）都必须用本函数。
 */
export function normalizeDateRange(from, to) {
  const range = normalizeRange(from, to);
  return {
    from: range.from ? range.from.slice(0, 10) : null,
    toExclusive: range.toExclusive ? range.toExclusive.slice(0, 10) : null,
  };
}

/** 日期粒度版本的 rangeToSql。 */
export function dateRangeToSql(range, column) {
  const clauses = [];
  const params = [];
  if (range.from) {
    clauses.push(`${column} >= ?`);
    params.push(range.from);
  }
  if (range.toExclusive) {
    clauses.push(`${column} < ?`);
    params.push(range.toExclusive);
  }
  return { sql: clauses.join(' AND '), params };
}

/**
 * 把左闭右开边界翻译成 SQL 条件片段与参数，供各仓储复用。
 * @param {{from: string|null, toExclusive: string|null}} range
 * @param {string} column 时间列名（形如 t.occurred_at）
 */
export function rangeToSql(range, column) {
  const clauses = [];
  const params = [];
  if (range.from) {
    clauses.push(`${column} >= ?`);
    params.push(range.from);
  }
  if (range.toExclusive) {
    clauses.push(`${column} < ?`);
    params.push(range.toExclusive);
  }
  return { sql: clauses.join(' AND '), params };
}
