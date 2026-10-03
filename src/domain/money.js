/**
 * 金额一律以「分」为单位的整数在系统内流转。
 *
 * 原因：财务系统最怕浮点误差（0.1 + 0.2 !== 0.3）。所有金额字段在数据库中存整数分，
 * 全链路整数运算，只在前端展示时格式化为元。这也让 DDL 在四种数据库间完全可移植，
 * 不必依赖各库 DECIMAL 的行为差异。
 */

import { ValidationError } from '../core/errors.js';

const MONEY_ERROR = '金额格式不正确';

/** 金额格式错误属于入参校验问题，应映射为 422 而非 500。 */
const moneyError = () => new ValidationError(MONEY_ERROR);

/** 清理输入：去掉货币符号、千分位、空白（含全角空格）。 */
function normalize(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw moneyError();
    return String(input);
  }
  if (typeof input === 'string') {
    return input
      .replace(/[¥￥$]/g, '')
      .replace(/[,\s 　]/g, '');
  }
  throw moneyError();
}

/**
 * 把「元」解析为整数「分」。
 * 支持数字、字符串、千分位、货币符号、负数；超过两位小数按四舍五入到分。
 * null / undefined / '' 视为 0（对应可空金额字段）。
 */
export function toCents(value) {
  if (value === null || value === undefined || value === '') return 0;

  const text = normalize(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw moneyError();

  const [, sign, intPart, fracRaw = ''] = match;
  // 大整数相加绝对值，符号最后统一施加，避免 -0 与符号处理分叉
  let cents = Number(BigInt(intPart) * 100n);
  const frac = fracRaw.slice(0, 2).padEnd(2, '0');
  cents += Number(frac);
  if (fracRaw.length > 2 && fracRaw[2] >= '5') cents += 1;

  return sign === '-' ? -cents : cents;
}

/** parseCents 是 toCents 的别名，供偏好 parse 命名的调用点使用。 */
export const parseCents = toCents;

/** 整数「分」转为不带千分位的「元」字符串，固定两位小数。 */
export function fromCents(cents) {
  const n = Math.trunc(Number(cents) || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const yuan = Math.floor(abs / 100);
  const fen = abs % 100;
  return `${sign}${yuan}.${String(fen).padStart(2, '0')}`;
}

/** 整数「分」转为带千分位的「元」字符串，用于界面展示与报表。 */
export function formatCents(cents) {
  const n = Math.trunc(Number(cents) || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const yuan = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fen = String(abs % 100).padStart(2, '0');
  return `${sign}${yuan}.${fen}`;
}

/** 求和。可传取数函数，例如 sumCents(rows, r => r.amount_cents)。 */
export function sumCents(items, pick = (v) => v) {
  let total = 0;
  for (const item of items) total += Math.trunc(Number(pick(item)) || 0);
  return total;
}

/** 多项相加。 */
export function addCents(...amounts) {
  let total = 0;
  for (const a of amounts) total += Math.trunc(Number(a) || 0);
  return total;
}

/** 四舍五入，且远离零方向（Math.round(-0.5) 得 -0，不符合财务直觉）。 */
function roundHalfAwayFromZero(value) {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * 数量 × 单价（分）。数量可为小数，结果按分四舍五入。
 */
export function mulQty(unitPriceCents, quantity) {
  const price = Number(unitPriceCents) || 0;
  const qty = Number(quantity) || 0;
  const raw = price * qty;
  if (!Number.isFinite(raw)) throw moneyError();
  return roundHalfAwayFromZero(raw);
}

/**
 * 按权重把总额分摊成整数份，且各份之和恒等于原总额（最大余数法）。
 * 用于按明细金额分摊返利、运费等需要“不丢分”的场景。
 * 负总额先按绝对值分摊再取负，保证符号一致。
 */
export function allocate(totalCents, weights) {
  const total = Math.trunc(Number(totalCents) || 0);
  if (weights.length === 0) return [];
  if (total < 0) return allocate(-total, weights).map((v) => -v);

  let sumWeights = 0;
  for (const w of weights) sumWeights += Math.max(0, Number(w) || 0);

  // 权重全为零时退化为均分，避免除零
  const effective = sumWeights === 0 ? weights.map(() => 1) : weights.map((w) => Math.max(0, Number(w) || 0));
  const divisor = sumWeights === 0 ? weights.length : sumWeights;

  const parts = [];
  const remainders = [];
  let assigned = 0;

  for (let i = 0; i < effective.length; i++) {
    const exact = total * effective[i];
    const base = Math.floor(exact / divisor);
    parts.push(base);
    remainders.push({ index: i, rem: exact - base * divisor });
    assigned += base;
  }

  // 余下的分按小数部分从大到小依次补给，余数相同时按下标先后，保证结果稳定
  let leftover = total - assigned;
  remainders.sort((a, b) => (b.rem - a.rem) || (a.index - b.index));
  for (let i = 0; i < remainders.length && leftover > 0; i++, leftover--) {
    parts[remainders[i].index] += 1;
  }

  return parts;
}
