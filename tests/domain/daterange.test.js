import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDate, formatDateTime, parseDate, isValidDate,
  normalizeRange, today, monthOf, periodOf,
} from '../../src/domain/daterange.js';

describe('daterange — 时间段查询统一采用左闭右开 [from, to+1天)', () => {
  describe('formatDate / formatDateTime — 本地时间，非 UTC', () => {
    test('格式化日期为 YYYY-MM-DD', () => {
      assert.equal(formatDate(new Date(2026, 0, 5, 13, 30, 0)), '2026-01-05');
    });

    test('格式化日期时间为 YYYY-MM-DD HH:MM:SS', () => {
      assert.equal(formatDateTime(new Date(2026, 0, 5, 13, 30, 9)), '2026-01-05 13:30:09');
    });

    test('本地时间不被时区偏移（除夕夜等边界）', () => {
      // 若误用 toISOString 会因 UTC 偏移退到前一天
      assert.equal(formatDate(new Date(2026, 0, 1, 0, 0, 0)), '2026-01-01');
      assert.equal(formatDate(new Date(2026, 11, 31, 23, 59, 59)), '2026-12-31');
    });

    test('补零', () => {
      assert.equal(formatDateTime(new Date(2026, 8, 9, 8, 7, 6)), '2026-09-09 08:07:06');
    });
  });

  describe('parseDate', () => {
    test('解析 YYYY-MM-DD 为本地零点', () => {
      const d = parseDate('2026-03-15');
      assert.equal(d.getFullYear(), 2026);
      assert.equal(d.getMonth(), 2);
      assert.equal(d.getDate(), 15);
      assert.equal(d.getHours(), 0);
    });

    test('解析带时间的字符串', () => {
      const d = parseDate('2026-03-15 10:20:30');
      assert.equal(d.getHours(), 10);
      assert.equal(d.getMinutes(), 20);
      assert.equal(d.getSeconds(), 30);
    });

    test('非法日期返回 null', () => {
      assert.equal(parseDate('2026-13-01'), null);
      assert.equal(parseDate('2026-02-30'), null);
      assert.equal(parseDate('not-a-date'), null);
      assert.equal(parseDate(''), null);
      assert.equal(parseDate(null), null);
    });
  });

  describe('isValidDate', () => {
    test('合法与非法', () => {
      assert.equal(isValidDate('2026-03-15'), true);
      assert.equal(isValidDate('2026-02-30'), false);
      assert.equal(isValidDate('2026/03/15'), false);
      assert.equal(isValidDate(null), false);
    });
  });

  describe('normalizeRange — 左闭右开', () => {
    test('起止同日只覆盖当天', () => {
      const r = normalizeRange('2026-03-15', '2026-03-15');
      assert.equal(r.from, '2026-03-15 00:00:00');
      assert.equal(r.toExclusive, '2026-03-16 00:00:00');
    });

    test('跨日区间右端加一天', () => {
      const r = normalizeRange('2026-03-15', '2026-03-20');
      assert.equal(r.from, '2026-03-15 00:00:00');
      assert.equal(r.toExclusive, '2026-03-21 00:00:00');
    });

    test('跨月与跨年进位正确', () => {
      assert.equal(normalizeRange('2026-01-31', '2026-01-31').toExclusive, '2026-02-01 00:00:00');
      assert.equal(normalizeRange('2026-12-31', '2026-12-31').toExclusive, '2027-01-01 00:00:00');
    });

    test('闰年二月', () => {
      assert.equal(normalizeRange('2028-02-28', '2028-02-28').toExclusive, '2028-02-29 00:00:00');
      assert.equal(normalizeRange('2028-02-29', '2028-02-29').toExclusive, '2028-03-01 00:00:00');
    });

    test('缺省任一端不约束该侧（均为 null 表示不限）', () => {
      assert.deepEqual(normalizeRange(null, null), { from: null, toExclusive: null });
      assert.equal(normalizeRange('2026-03-15', null).toExclusive, null);
      assert.equal(normalizeRange(null, '2026-03-15').from, null);
    });

    test('起点晚于终点抛错', () => {
      assert.throws(() => normalizeRange('2026-03-20', '2026-03-15'), /时间/);
    });

    test('非法日期抛错', () => {
      assert.throws(() => normalizeRange('bad', '2026-03-15'), /时间/);
      assert.throws(() => normalizeRange('2026-03-15', '2026-02-30'), /时间/);
    });
  });

  describe('today / monthOf / periodOf', () => {
    test('today 为 YYYY-MM-DD', () => {
      assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
    });

    test('monthOf 取所在月首日', () => {
      assert.equal(monthOf('2026-03-15'), '2026-03-01');
      assert.equal(monthOf('2026-03-01'), '2026-03-01');
    });

    test('periodOf 为 YYYY-MM', () => {
      assert.equal(periodOf('2026-03-15'), '2026-03');
      assert.equal(periodOf(new Date(2026, 2, 15)), '2026-03');
    });
  });
});
