import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  toCents, fromCents, formatCents, sumCents, mulQty, allocate, addCents, parseCents,
} from '../../src/domain/money.js';

describe('money — 以「分」为单位的整数金额运算', () => {
  describe('toCents 解析', () => {
    test('整数元', () => {
      assert.equal(toCents(12), 1200);
      assert.equal(toCents('12'), 1200);
    });

    test('两位小数', () => {
      assert.equal(toCents('12.34'), 1234);
      assert.equal(toCents(12.34), 1234);
      assert.equal(toCents('0.01'), 1);
      assert.equal(toCents('0.1'), 10);
    });

    test('带千分位与货币符号', () => {
      assert.equal(toCents('1,234.56'), 123456);
      assert.equal(toCents('¥1,234.56'), 123456);
      assert.equal(toCents(' 1 234.56 '), 123456);
    });

    test('负数', () => {
      assert.equal(toCents('-12.34'), -1234);
    });

    test('超过两位小数按四舍五入到分', () => {
      assert.equal(toCents('1.005'), 101);
      assert.equal(toCents('1.004'), 100);
    });

    test('空值视为 0（可空金额字段）', () => {
      assert.equal(toCents(null), 0);
      assert.equal(toCents(undefined), 0);
      assert.equal(toCents(''), 0);
    });

    test('非法输入抛错', () => {
      assert.throws(() => toCents('abc'), /金额/);
      assert.throws(() => toCents('1.2.3'), /金额/);
      assert.throws(() => toCents({}), /金额/);
      assert.throws(() => toCents(NaN), /金额/);
      assert.throws(() => toCents(Infinity), /金额/);
    });
  });

  describe('fromCents / formatCents 展示', () => {
    test('转为元字符串，固定两位小数', () => {
      assert.equal(fromCents(1234), '12.34');
      assert.equal(fromCents(1), '0.01');
      assert.equal(fromCents(0), '0.00');
      assert.equal(fromCents(-1234), '-12.34');
    });

    test('千分位格式', () => {
      assert.equal(formatCents(123456), '1,234.56');
      assert.equal(formatCents(100000000), '1,000,000.00');
      assert.equal(formatCents(0), '0.00');
    });

    test('往返一致', () => {
      for (const c of [0, 1, 99, 100, 12345, -6000, 999999999]) {
        assert.equal(toCents(fromCents(c)), c);
      }
    });
  });

  describe('sumCents 求和', () => {
    test('空数组为 0', () => assert.equal(sumCents([]), 0));

    test('累加整数', () => {
      assert.equal(sumCents([100, 200, 300]), 600);
      assert.equal(sumCents([100, -50]), 50);
    });

    test('接受取数函数', () => {
      assert.equal(sumCents([{ a: 100 }, { a: 200 }], (r) => r.a), 300);
    });
  });

  describe('mulQty 数量乘单价', () => {
    test('整数相乘无浮点误差', () => {
      // 0.1 * 3 用浮点会得到 0.30000000000000004
      assert.equal(mulQty(10, 3), 30);
      assert.equal(mulQty(1234, 7), 8638);
    });

    test('按分四舍五入（单价可为小数分）', () => {
      assert.equal(mulQty(100, 2.5), 250);
      assert.equal(mulQty(1, 0.5), 1); // 0.5 分 → 1 分
    });
  });

  describe('addCents', () => {
    test('多项相加', () => {
      assert.equal(addCents(1, 2, 3), 6);
      assert.equal(addCents(), 0);
      assert.equal(addCents(100, -100), 0);
    });
  });

  describe('allocate 按权重分摊且不丢分', () => {
    test('整除', () => {
      assert.deepEqual(allocate(100, [1, 1, 1, 1]), [25, 25, 25, 25]);
    });

    test('余数按最大余数法分配，合计恒等于原值', () => {
      const parts = allocate(100, [1, 1, 1]);
      assert.equal(sumCents(parts), 100);
      assert.deepEqual(parts, [34, 33, 33]);
    });

    test('任意权重合计守恒', () => {
      for (const total of [1, 7, 99, 1000, 123456]) {
        for (const w of [[1, 1, 1], [3, 5, 2], [1, 0, 1], [7, 7, 7, 7, 7]]) {
          assert.equal(sumCents(allocate(total, w)), total, `total=${total} w=${w}`);
        }
      }
    });

    test('权重全零时均分', () => {
      const parts = allocate(10, [0, 0]);
      assert.equal(sumCents(parts), 10);
    });

    test('负总额', () => {
      const parts = allocate(-100, [1, 1, 1]);
      assert.equal(sumCents(parts), -100);
    });
  });

  describe('parseCents 别名与 toCents 行为一致', () => {
    test('同名函数可互换', () => {
      assert.equal(parseCents('12.34'), toCents('12.34'));
    });
  });
});
