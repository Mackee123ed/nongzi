/**
 * 字段校验器。
 *
 * 全部抛 ValidationError，消息为面向用户的中文，且必定包含字段中文名，
 * 便于前端直接把提示挂在对应输入框上。
 */

import { ValidationError } from './errors.js';
import { toCents } from '../domain/money.js';
import { isValidDate, formatDate } from '../domain/daterange.js';

const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** 必填文本。 */
export function requireText(value, label, { maxLength = 0 } = {}) {
  if (blank(value)) throw new ValidationError(`${label}不能为空`);
  const text = String(value).trim();
  if (maxLength > 0 && text.length > maxLength) {
    throw new ValidationError(`${label}长度不能超过 ${maxLength} 个字`);
  }
  return text;
}

/** 选填文本。空值归一为 null。 */
export function optionalText(value, label, { maxLength = 0 } = {}) {
  if (blank(value)) return null;
  return requireText(value, label, { maxLength });
}

/** 必填枚举。labels 用于把内部取值翻译成中文提示。 */
export function requireEnum(value, label, allowed, labels = {}) {
  if (blank(value)) throw new ValidationError(`${label}不能为空`);
  if (!allowed.includes(value)) {
    const readable = allowed.map((a) => labels[a] ?? a).join(' / ');
    throw new ValidationError(`${label}只能是：${readable}`);
  }
  return value;
}

/** 选填枚举。 */
export function optionalEnum(value, label, allowed, labels = {}) {
  if (blank(value)) return null;
  return requireEnum(value, label, allowed, labels);
}

/** 必填正整数。 */
export function requirePositiveInt(value, label) {
  if (blank(value)) throw new ValidationError(`${label}不能为空`);
  const n = Number(value);
  if (!Number.isInteger(n)) throw new ValidationError(`${label}必须是整数`);
  if (n <= 0) throw new ValidationError(`${label}必须大于 0`);
  return n;
}

/** 选填整数。 */
export function optionalInt(value, label) {
  if (blank(value)) return null;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new ValidationError(`${label}必须是整数`);
  return n;
}

/** 必填日期，返回 'YYYY-MM-DD'。 */
export function requireDate(value, label) {
  if (blank(value)) throw new ValidationError(`${label}不能为空`);
  if (!isValidDate(String(value))) throw new ValidationError(`${label}不是合法的日期`);
  return formatDate(new Date(`${String(value).slice(0, 10)}T00:00:00`));
}

/** 选填日期。 */
export function optionalDate(value, label) {
  if (blank(value)) return null;
  return requireDate(value, label);
}

/**
 * 必填金额，返回整数「分」。
 * 之所以接受「128.00」这类字符串，是因为前端表单提交的就是字符串。
 */
export function requireMoney(value, label) {
  if (blank(value)) throw new ValidationError(`${label}不能为空`);
  try {
    return toCents(value);
  } catch {
    throw new ValidationError(`${label}格式不正确`);
  }
}

/** 选填金额；为空时返回 null 而不是 0，以区分「没填」与「填了 0」。 */
export function optionalMoney(value, label) {
  if (blank(value)) return null;
  return requireMoney(value, label);
}

/** 选填外键。 */
export function optionalId(value, label) {
  if (blank(value)) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError(`${label}不正确`);
  return n;
}

/** 在给定对象上挑出若干字段，未提供的字段不参与后续写入。 */
export function pickDefined(source, mapping) {
  const out = {};
  for (const [key, column] of Object.entries(mapping)) {
    if (source[key] !== undefined) out[column] = source[key];
  }
  return out;
}
