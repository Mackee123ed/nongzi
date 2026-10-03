import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/open.js';
import { ConflictError, ValidationError } from '../../src/core/errors.js';

/**
 * 全部测试使用内存 SQLite。
 * 项目所在盘为 9p/drvfs，文件级锁不可靠，落盘数据库在测试里会出现偶发锁定失败；
 * 内存库既规避了这一点，也让整套测试保持秒级。
 */
async function makeDb() {
  return openDatabase({ dialect: 'sqlite', database: ':memory:' });
}

describe('Database — 数据库无关的执行器', () => {
  let db;
  beforeEach(async () => { db = await makeDb(); });
  afterEach(async () => { await db.close(); });

  describe('基础执行', () => {
    test('exec 建表', async () => {
      await db.exec('create table t (id integer primary key autoincrement, name text)');
      const rows = await db.query("select name from sqlite_master where type='table' and name='t'");
      assert.equal(rows.length, 1);
    });

    test('exec 一次执行多条语句', async () => {
      await db.exec('create table a(i int); create table b(i int);');
      const rows = await db.query("select name from sqlite_master where type='table' and name in ('a','b')");
      assert.equal(rows.length, 2);
    });

    test('run 返回 changes 与 lastInsertId', async () => {
      await db.exec('create table t (id integer primary key autoincrement, name text)');
      const r1 = await db.run('insert into t(name) values(?)', ['甲']);
      assert.equal(r1.changes, 1);
      assert.equal(r1.lastInsertId, 1);
      const r2 = await db.run('insert into t(name) values(?)', ['乙']);
      assert.equal(r2.lastInsertId, 2);
    });

    test('query 返回全部行，one 返回单行', async () => {
      await db.exec('create table t (id integer primary key autoincrement, name text)');
      await db.run('insert into t(name) values(?)', ['甲']);
      await db.run('insert into t(name) values(?)', ['乙']);

      const rows = await db.query('select * from t order by id');
      assert.equal(rows.length, 2);
      assert.equal(rows[0].name, '甲');

      const row = await db.one('select * from t where id = ?', [1]);
      assert.equal(row.name, '甲');
    });

    test('one 无结果时返回 undefined', async () => {
      await db.exec('create table t (id integer primary key autoincrement, name text)');
      assert.equal(await db.one('select * from t where id = ?', [999]), undefined);
    });

    test('query 无结果时返回空数组而非 null', async () => {
      await db.exec('create table t (id integer primary key autoincrement, name text)');
      assert.deepEqual(await db.query('select * from t'), []);
    });

    test('聚合查询返回标量', async () => {
      await db.exec('create table t (id integer primary key autoincrement, amount integer)');
      await db.run('insert into t(amount) values(?)', [100]);
      await db.run('insert into t(amount) values(?)', [250]);
      const row = await db.one('select count(*) as c, sum(amount) as s from t');
      assert.equal(row.c, 2);
      assert.equal(row.s, 350);
    });
  });

  describe('参数归一化 — 实测 node:sqlite 对部分 JS 值的行为不安全', () => {
    beforeEach(async () => {
      await db.exec('create table p (id integer primary key autoincrement, v)');
    });

    test('undefined 转为 null（实测直接绑定会抛错）', async () => {
      await db.run('insert into p(v) values(?)', [undefined]);
      const row = await db.one('select v from p where id = ?', [1]);
      assert.equal(row.v, null);
    });

    test('Date 转为本地时间字符串（实测直接绑定会静默存成 null）', async () => {
      const when = new Date(2026, 2, 15, 10, 20, 30);
      await db.run('insert into p(v) values(?)', [when]);
      const row = await db.one('select v from p where id = ?', [1]);
      assert.equal(row.v, '2026-03-15 10:20:30');
    });

    test('布尔转为 0 / 1，各数据库行为一致', async () => {
      await db.run('insert into p(v) values(?)', [true]);
      await db.run('insert into p(v) values(?)', [false]);
      const rows = await db.query('select v from p order by id');
      assert.equal(rows[0].v, 1);
      assert.equal(rows[1].v, 0);
    });

    test('null 原样保留', async () => {
      await db.run('insert into p(v) values(?)', [null]);
      assert.equal((await db.one('select v from p where id = ?', [1])).v, null);
    });

    test('中文与特殊字符往返一致', async () => {
      const text = "玉米'杂交\"种\"—￥100%?";
      await db.run('insert into p(v) values(?)', [text]);
      assert.equal((await db.one('select v from p where id = ?', [1])).v, text);
    });

    test('省略参数数组等价于空数组', async () => {
      await db.run('insert into p(v) values(1)');
      const rows = await db.query('select v from p');
      assert.equal(rows.length, 1);
    });
  });

  describe('可移植的 insert / update / remove', () => {
    beforeEach(async () => {
      await db.exec(`create table t (
        id integer primary key autoincrement,
        name text not null,
        amount integer,
        created_at text
      )`);
    });

    test('insert 返回新主键且各驱动语义一致', async () => {
      const id1 = await db.insert('t', { name: '甲', amount: 100 });
      const id2 = await db.insert('t', { name: '乙', amount: 200 });
      assert.equal(id1, 1);
      assert.equal(id2, 2);
    });

    test('insert 自动填充 created_at', async () => {
      const id = await db.insert('t', { name: '甲' });
      const row = await db.one('select created_at from t where id = ?', [id]);
      assert.match(row.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    test('update 按条件更新并返回影响行数', async () => {
      const id = await db.insert('t', { name: '甲', amount: 100 });
      const r = await db.update('t', { amount: 999 }, { id });
      assert.equal(r.changes, 1);
      assert.equal((await db.one('select amount from t where id = ?', [id])).amount, 999);
    });

    test('update 对不存在的行返回 changes=0', async () => {
      assert.equal((await db.update('t', { amount: 1 }, { id: 999 })).changes, 0);
    });

    test('remove 按条件删除', async () => {
      const id = await db.insert('t', { name: '甲' });
      assert.equal((await db.remove('t', { id })).changes, 1);
      assert.equal(await db.one('select * from t where id = ?', [id]), undefined);
    });

    test('insert 拒绝非法表名（注入防线）', async () => {
      await assert.rejects(() => db.insert('t; drop table t', { name: 'x' }), /标识符/);
    });

    test('update 拒绝非法列名', async () => {
      await assert.rejects(() => db.update('t', { 'a=1, b': 2 }, { id: 1 }), /标识符/);
    });
  });

  describe('错误映射', () => {
    test('唯一约束冲突映射为 ConflictError', async () => {
      await db.exec('create table u (id integer primary key autoincrement, code text unique)');
      await db.insert('u', { code: 'A' });
      await assert.rejects(() => db.insert('u', { code: 'A' }), (err) => {
        assert.ok(err instanceof ConflictError, '应为 ConflictError');
        return true;
      });
    });

    test('外键约束失败被翻译为可读的业务错误', async () => {
      await db.exec(`
        create table parent (id integer primary key autoincrement);
        create table child (id integer primary key autoincrement, parent_id integer references parent(id));
      `);
      await assert.rejects(() => db.insert('child', { parent_id: 999 }), (err) => {
        assert.ok(err instanceof ValidationError, '应翻译为 ValidationError 而非泄漏驱动原文');
        assert.match(err.message, /关联/);
        return true;
      });
    });
  });

  describe('事务', () => {
    beforeEach(async () => {
      await db.exec('create table t (id integer primary key autoincrement, name text)');
    });

    test('提交后数据可见', async () => {
      await db.tx(async (t) => {
        await t.insert('t', { name: '甲' });
      });
      assert.equal((await db.query('select * from t')).length, 1);
    });

    test('抛错时整体回滚', async () => {
      await assert.rejects(
        db.tx(async (t) => {
          await t.insert('t', { name: '甲' });
          throw new Error('业务校验失败');
        }),
        /业务校验失败/,
      );
      assert.equal((await db.query('select * from t')).length, 0, '回滚后不应残留数据');
    });

    test('事务内可读到自己未提交的写入', async () => {
      await db.tx(async (t) => {
        await t.insert('t', { name: '甲' });
        const rows = await t.query('select * from t');
        assert.equal(rows.length, 1);
      });
    });

    test('嵌套事务：内层回滚不影响外层', async () => {
      await db.tx(async (t) => {
        await t.insert('t', { name: '外层' });
        await assert.rejects(
          t.tx(async (inner) => {
            await inner.insert('t', { name: '内层' });
            throw new Error('内层失败');
          }),
          /内层失败/,
        );
      });
      const rows = await db.query('select name from t');
      assert.deepEqual(rows.map((r) => r.name), ['外层']);
    });

    test('嵌套事务：内层提交随外层一起提交', async () => {
      await db.tx(async (t) => {
        await t.insert('t', { name: '外层' });
        await t.tx(async (inner) => {
          await inner.insert('t', { name: '内层' });
        });
      });
      assert.equal((await db.query('select * from t')).length, 2);
    });

    test('返回事务回调的结果', async () => {
      const result = await db.tx(async (t) => {
        await t.insert('t', { name: '甲' });
        return '返回值';
      });
      assert.equal(result, '返回值');
    });

    test('★ 并发事务必须串行，不得交错', async () => {
      // sqlite 只有一个同步句柄，而本层 API 是异步的：
      // 若事务过程中 await 让出事件循环时另一请求插进来，两个事务会读到同一个初值
      // 并互相覆盖（丢失更新）。互斥锁正是为此存在，不许移除。
      await db.exec('create table counter (id integer primary key, v integer)');
      await db.run('insert into counter(id, v) values(1, 0)');

      const bump = () => db.tx(async (t) => {
        const row = await t.one('select v from counter where id = 1');
        await new Promise((resolve) => setTimeout(resolve, 15)); // 让出事件循环
        await t.run('update counter set v = ? where id = 1', [row.v + 1]);
      });

      await Promise.all([bump(), bump(), bump(), bump(), bump()]);

      const final = await db.one('select v from counter where id = 1');
      assert.equal(final.v, 5, '并发自增必须无丢失更新');
    });

    test('★ 事务进行中，外部读取不得看到未提交数据', async () => {
      // 事务写入后回滚；期间发起的外部查询必须排队到事务结束后执行，
      // 因而看不到那一行「幽灵数据」。
      const txPromise = db.tx(async (t) => {
        await t.insert('t', { name: '未提交' });
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error('故意回滚');
      }).catch(() => {});

      const outsideRead = db.query('select * from t');

      await txPromise;
      const rows = await outsideRead;
      assert.equal(rows.length, 0, '外部读取不应看到已回滚的未提交数据');
    });

    test('★ 事务内误用 db.* 立即报错，而不是死锁', async () => {
      // 事务期间互斥锁由事务自身持有；若此刻调用 db.query，
      // 不拦截就会永久等待自己持有的锁（接口卡死且无任何报错）。
      await assert.rejects(
        db.tx(async () => {
          await db.query('select 1');
        }),
        /事务/,
      );
    });

    test('事务内使用事务句柄 t 正常可读可写', async () => {
      const rows = await db.tx(async (t) => {
        await t.insert('t', { name: '甲' });
        return t.query('select * from t');
      });
      assert.equal(rows.length, 1);
    });
  });

  describe('方言', () => {
    test('暴露当前方言信息', async () => {
      assert.equal(db.dialect.name, 'sqlite');
    });

    test('查询返回普通对象，可安全 JSON 序列化', async () => {
      // node:sqlite 返回的是 null 原型对象，直接 JSON.stringify 虽可用，
      // 但 JSON.parse(JSON.stringify()) 或展开后才是真正可用的普通对象，这里一并验证。
      await db.exec('create table t (id integer primary key autoincrement, name text)');
      await db.insert('t', { name: '甲' });
      const rows = await db.query('select * from t');
      assert.equal(JSON.stringify(rows), '[{"id":1,"name":"甲"}]');
      assert.equal(Object.getPrototypeOf(rows[0]), Object.prototype, '应为普通对象原型');
    });
  });
});
