import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rewritePlaceholders, splitStatements } from '../../src/db/sql/scan.js';

describe('sql scanner — 引号/注释感知的占位符重写与语句切分', () => {
  describe('rewritePlaceholders 基本改写', () => {
    test('sqlite / mysql 保持 ? 不变', () => {
      const sql = 'select * from t where a = ? and b = ?';
      assert.equal(rewritePlaceholders(sql, 'sqlite'), sql);
      assert.equal(rewritePlaceholders(sql, 'mysql'), sql);
    });

    test('postgres 改写为 $1 $2 …', () => {
      assert.equal(
        rewritePlaceholders('select * from t where a = ? and b = ?', 'pg'),
        'select * from t where a = $1 and b = $2',
      );
    });

    test('mssql 改写为 @p1 @p2 …', () => {
      assert.equal(
        rewritePlaceholders('select * from t where a = ? and b = ?', 'mssql'),
        'select * from t where a = @p1 and b = @p2',
      );
    });

    test('编号跨多行连续递增', () => {
      const sql = 'select *\nfrom t\nwhere a = ?\n  and b = ?\n  and c = ?';
      assert.equal(
        rewritePlaceholders(sql, 'pg'),
        'select *\nfrom t\nwhere a = $1\n  and b = $2\n  and c = $3',
      );
    });

    test('超过 9 个占位符编号仍正确', () => {
      const sql = Array.from({ length: 12 }, () => '?').join(',');
      const out = rewritePlaceholders(sql, 'pg');
      assert.equal(out, '$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12');
    });
  });

  describe('rewritePlaceholders 必须忽略引号与注释内的 ?', () => {
    test('单引号字符串内的 ? 不动', () => {
      const sql = "select * from t where name like '%?%' and id = ?";
      assert.equal(
        rewritePlaceholders(sql, 'pg'),
        "select * from t where name like '%?%' and id = $1",
      );
    });

    test('单引号内转义的两个单引号不结束字符串', () => {
      const sql = "select 'it''s ? here' as x, ? as y";
      assert.equal(rewritePlaceholders(sql, 'pg'), "select 'it''s ? here' as x, $1 as y");
    });

    test('双引号标识符内的 ? 不动', () => {
      const sql = 'select "we?ird" from t where a = ?';
      assert.equal(rewritePlaceholders(sql, 'pg'), 'select "we?ird" from t where a = $1');
    });

    test('反引号标识符内的 ? 不动（mysql 风格）', () => {
      const sql = 'select `a?b` from t where a = ?';
      assert.equal(rewritePlaceholders(sql, 'mssql'), 'select `a?b` from t where a = @p1');
    });

    test('行注释内的 ? 不动', () => {
      const sql = 'select * from t -- 这是注释 ? 不算\nwhere a = ?';
      assert.equal(
        rewritePlaceholders(sql, 'pg'),
        'select * from t -- 这是注释 ? 不算\nwhere a = $1',
      );
    });

    test('块注释内的 ? 不动，含多行', () => {
      const sql = 'select * from t /* 注释\n ? 还是注释 */ where a = ?';
      assert.equal(
        rewritePlaceholders(sql, 'pg'),
        'select * from t /* 注释\n ? 还是注释 */ where a = $1',
      );
    });

    test('postgres 美元引用内的 ? 不动', () => {
      const sql = 'select $$ a?b $$ as x, $1 as y';
      // $$...$$ 已自带 $ 语义，其中 ? 不参与计数
      assert.equal(rewritePlaceholders(sql, 'mysql'), 'select $$ a?b $$ as x, $1 as y');
    });

    test('中文文案与全角问号不受影响', () => {
      const sql = "select * from t where remark = '为什么？' and id = ?";
      assert.equal(
        rewritePlaceholders(sql, 'pg'),
        "select * from t where remark = '为什么？' and id = $1",
      );
    });

    test('复杂组合：字符串、注释、标识符混排', () => {
      const sql = [
        "select `品种?名`, 'a?b' as lit -- ? 注释",
        'from t /* ? */',
        'where a = ? and b = ?',
      ].join('\n');
      const out = rewritePlaceholders(sql, 'pg');
      assert.equal(out.split('$').length - 1, 2, '只应改写两个占位符');
      assert.ok(out.includes("'a?b'"), '字符串原样保留');
      assert.ok(out.includes('`品种?名`'), '标识符原样保留');
      assert.ok(out.includes('-- ? 注释'), '注释原样保留');
      assert.ok(out.includes('where a = $1 and b = $2'), '占位符正确编号');
    });
  });

  describe('splitStatements 语句切分', () => {
    test('按分号切分并去空', () => {
      assert.deepEqual(
        splitStatements('create table a(i int); create table b(i int);'),
        ['create table a(i int)', 'create table b(i int)'],
      );
    });

    test('结尾分号不产生空语句', () => {
      assert.deepEqual(splitStatements('select 1;'), ['select 1']);
      assert.deepEqual(splitStatements('select 1'), ['select 1']);
      assert.deepEqual(splitStatements('   '), []);
      assert.deepEqual(splitStatements(';;;'), []);
    });

    test('字符串内的分号不切分', () => {
      assert.deepEqual(
        splitStatements("insert into t values('a;b'); select 1;"),
        ["insert into t values('a;b')", 'select 1'],
      );
    });

    test('注释内的分号不切分', () => {
      assert.deepEqual(
        splitStatements('select 1 -- 注释; 不是结束\n; select 2;'),
        ['select 1 -- 注释; 不是结束', 'select 2'],
      );
    });

    test('多行 DDL 保持为一个语句', () => {
      const ddl = 'create table t (\n  a int,\n  b text\n);';
      assert.equal(splitStatements(ddl).length, 1);
    });
  });
});
