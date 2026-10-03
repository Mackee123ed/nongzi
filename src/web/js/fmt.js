/**
 * 展示层格式化。
 *
 * 后端所有金额都以整数「分」传输，只在这里转成「元」显示。
 * 界面上的输入也统一以元为单位提交，由后端解析成分，避免两套精度观念混用。
 */

import { h } from './ui.js';

/** 分 → 元字符串（带千分位）。 */
export function money(cents) {
  const n = Number(cents ?? 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const yuan = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${yuan}.${String(abs % 100).padStart(2, '0')}`;
}

/** 分 → 元，带颜色（负数标红）。 */
export function moneyCell(cents) {
  const n = Number(cents ?? 0);
  return h('span', { class: n < 0 ? 'num-neg' : '' }, money(n));
}

/** 数量千分位。 */
export function qty(value) {
  const n = Number(value ?? 0);
  return n.toLocaleString('zh-CN');
}

export function date(value) {
  if (!value) return '—';
  return String(value).slice(0, 10);
}

export function dateTime(value) {
  if (!value) return '—';
  return String(value).slice(0, 16);
}

/** 枚举徽标。 */
export function tag(text, kind = '') {
  return h('span', { class: `tag ${kind}` }, text ?? '—');
}

/** 今天的 YYYY-MM-DD。 */
export function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 当月起止（用于报表默认区间）。 */
export function currentMonthRange() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const first = `${d.getFullYear()}-${p(d.getMonth() + 1)}-01`;
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { from: first, to: `${last.getFullYear()}-${p(last.getMonth() + 1)}-${p(last.getDate())}` };
}
