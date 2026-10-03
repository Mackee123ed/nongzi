/**
 * 数据库执行器：业务代码唯一接触的数据库接口。
 *
 * 仓储只依赖这里的 query / one / run / insert / update / remove / tx，
 * 不 import 任何驱动，也不感知底层是哪一种数据库。配合 dialect 的占位符与类型
 * 展开，就实现了需求书 8.2「切换数据库后无需修改业务代码」。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createMutex } from './mutex.js';
import { rewritePlaceholders, assertIdentifier, splitStatements } from './sql/scan.js';
import { translateDbError, ValidationError } from '../core/errors.js';
import { formatDateTime } from '../domain/daterange.js';

/**
 * 标记「当前异步执行上下文正处于某个 Database 的事务中」。
 *
 * 用途是防呆：事务期间互斥锁被事务自己持有，此时若业务代码误用 db.query()
 * 而不是事务句柄 t.query()，就会永久等待自己持有的锁——表现为接口卡死、
 * 没有任何报错，是极难排查的故障。这里主动识别并抛出明确的错误。
 */
const activeTransaction = new AsyncLocalStorage();

/** 当前时间的存储格式，与 daterange 保持一致（本地时间，非 UTC）。 */
export const nowString = () => formatDateTime(new Date());

/**
 * 参数归一化。实测 node:sqlite 对 JS 值的处理有两处陷阱：
 *   - undefined 直接绑定会抛 "Provided value cannot be bound to SQLite parameter"
 *   - Date 直接绑定**不报错**，而是静默存成 null（比抛错更危险，会造成无声的数据丢失）
 * 加上各数据库对布尔的表示不同（BIT / TINYINT / BOOLEAN），统一在此归一。
 */
export function normalizeParams(params) {
  if (params === undefined || params === null) return [];
  if (!Array.isArray(params)) {
    throw new ValidationError('查询参数必须是数组');
  }
  return params.map((value) => {
    if (value === undefined) return null;
    if (value instanceof Date) return formatDateTime(value);
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}

/** 实际与驱动交互的一层，不含并发控制。 */
class Executor {
  constructor(driver, dialect, cache) {
    this.driver = driver;
    this.dialect = dialect;
    this._cache = cache;
  }

  _rewrite(sql) {
    return rewritePlaceholders(sql, this.dialect.name);
  }

  /**
   * 直接与驱动交互的内部方法。
   *
   * ★ 复合方法（one / insert 等）必须调用这两个 _ 前缀的方法，绝不可调用
   * this.query / this.run：在 Database 实例上，那两个是被互斥锁包了一层的覆写，
   * 事务或普通调用内部再调一次就会重复获取自己已持有的锁而死锁。
   */
  async _all(sql, params) {
    try {
      return await this.driver.all(this._rewrite(sql), normalizeParams(params));
    } catch (err) {
      throw translateDbError(err);
    }
  }

  async _run(sql, params) {
    try {
      return await this.driver.run(this._rewrite(sql), normalizeParams(params));
    } catch (err) {
      throw translateDbError(err);
    }
  }

  async _one(sql, params) {
    const rows = await this._all(sql, params);
    return rows[0];
  }

  async query(sql, params = []) {
    return this._all(sql, params);
  }

  async one(sql, params = []) {
    return this._one(sql, params);
  }

  async run(sql, params = []) {
    return this._run(sql, params);
  }

  async exec(sql) {
    try {
      // 逐条执行而非整段下发：MySQL 默认关闭多语句，逐条是四种数据库的交集
      for (const statement of splitStatements(sql)) {
        await this.driver.exec(statement);
      }
    } catch (err) {
      throw translateDbError(err);
    }
  }

  /** 表结构（带缓存），供 insert 自动填充时间戳与迁移判断列是否存在。 */
  async columns(table) {
    assertIdentifier(table);
    if (!this._cache.columns.has(table)) {
      let cols;
      try {
        cols = await this.driver.columns(table);
      } catch {
        cols = [];
      }
      this._cache.columns.set(table, cols);
    }
    return this._cache.columns.get(table);
  }

  async tables() {
    return this.driver.tables();
  }

  _invalidateColumns(table) {
    this._cache.columns.delete(table);
  }

  /**
   * 可移植的插入，返回新主键。
   * 各数据库取回自增主键的方式完全不同（见 dialect.capabilities.returning），
   * 差异全部收敛在这里，仓储调用方无需关心。
   */
  async insert(table, data = {}) {
    assertIdentifier(table);

    const row = { ...data };
    const cols = await this.columns(table);
    const names = new Set(cols.map((c) => c.name));

    if (names.has('created_at') && row.created_at === undefined) row.created_at = nowString();
    if (names.has('updated_at') && row.updated_at === undefined) row.updated_at = nowString();

    const keys = Object.keys(row);
    if (keys.length === 0) throw new ValidationError('没有需要写入的字段');
    for (const key of keys) assertIdentifier(key);

    const columnList = keys.join(', ');
    const placeholderList = keys.map(() => '?').join(', ');
    const values = normalizeParams(keys.map((k) => row[k]));

    if (this.dialect.name === 'mssql') {
      const found = await this._one(
        `insert into ${table} (${columnList}) output inserted.id values (${placeholderList})`,
        values,
      );
      return found ? Number(found.id) : null;
    }

    if (this.dialect.capabilities.returning) {
      const found = await this._one(
        `insert into ${table} (${columnList}) values (${placeholderList}) returning id`,
        values,
      );
      return found ? Number(found.id) : null;
    }

    const result = await this._run(
      `insert into ${table} (${columnList}) values (${placeholderList})`,
      values,
    );
    return result.lastInsertId;
  }

  /** 按条件更新，返回受影响行数。 */
  async update(table, data, where) {
    assertIdentifier(table);

    const row = { ...data };
    const cols = await this.columns(table);
    const names = new Set(cols.map((c) => c.name));
    if (names.has('updated_at') && row.updated_at === undefined) row.updated_at = nowString();

    const keys = Object.keys(row);
    if (keys.length === 0) throw new ValidationError('没有需要更新的字段');

    const whereKeys = Object.keys(where ?? {});
    if (whereKeys.length === 0) throw new ValidationError('更新操作必须指定条件');

    for (const key of [...keys, ...whereKeys]) assertIdentifier(key);

    const sql = `update ${table} set ${keys.map((k) => `${k} = ?`).join(', ')}`
      + ` where ${whereKeys.map((k) => `${k} = ?`).join(' and ')}`;

    const values = normalizeParams([
      ...keys.map((k) => row[k]),
      ...whereKeys.map((k) => where[k]),
    ]);

    try {
      return await this.driver.run(this._rewrite(sql), values);
    } catch (err) {
      throw translateDbError(err);
    }
  }

  /** 按条件删除，返回受影响行数。 */
  async remove(table, where) {
    assertIdentifier(table);

    const whereKeys = Object.keys(where ?? {});
    if (whereKeys.length === 0) throw new ValidationError('删除操作必须指定条件');
    for (const key of whereKeys) assertIdentifier(key);

    const sql = `delete from ${table} where ${whereKeys.map((k) => `${k} = ?`).join(' and ')}`;
    const values = normalizeParams(whereKeys.map((k) => where[k]));

    try {
      return await this.driver.run(this._rewrite(sql), values);
    } catch (err) {
      throw translateDbError(err);
    }
  }
}

/** 事务句柄。它已经处在 Database 的互斥锁内，因此不再自行加锁。 */
class Transaction extends Executor {
  constructor(database, depth) {
    super(database.driver, database.dialect, database._cache);
    this._database = database;
    this._depth = depth;
  }

  /** 嵌套事务用 SAVEPOINT 实现：内层回滚不影响外层已完成的写入。 */
  async tx(fn) {
    const name = `nz_sp_${this._depth}`;
    await this.driver.savepoint(name);
    try {
      const result = await fn(new Transaction(this._database, this._depth + 1));
      await this.driver.release(name);
      return result;
    } catch (err) {
      // ROLLBACK TO 之后保存点仍然存在，需要显式 RELEASE 释放，避免保存点堆积
      try {
        await this.driver.rollbackTo(name);
        await this.driver.release(name);
      } catch {
        /* 回滚失败时保留原始错误，它更有诊断价值 */
      }
      throw err;
    }
  }
}

export class Database extends Executor {
  constructor(driver, dialect) {
    super(driver, dialect, { columns: new Map() });
    this._acquire = createMutex();
  }

  /** 所有操作串行化。原因见 mutex.js 顶部的说明——这不是保守，是正确性所需。 */
  async _locked(operation) {
    // 事务进行中误用 db.* 会死锁在事务自己持有的锁上，这里提前拦下
    const active = activeTransaction.getStore();
    if (active === this) {
      throw new ValidationError(
        '当前正处于事务中，请在事务回调内使用传入的事务句柄 t 执行语句'
        + '（例如 t.query(...) / t.insert(...)），不要直接使用 db。',
      );
    }

    const release = await this._acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  query(sql, params) { return this._locked(() => super.query(sql, params)); }
  one(sql, params) { return this._locked(() => super.one(sql, params)); }
  run(sql, params) { return this._locked(() => super.run(sql, params)); }
  exec(sql) { return this._locked(() => super.exec(sql)); }
  insert(table, data) { return this._locked(() => super.insert(table, data)); }
  update(table, data, where) { return this._locked(() => super.update(table, data, where)); }
  remove(table, where) { return this._locked(() => super.remove(table, where)); }

  /**
   * 在事务中执行。事务期间独占数据库，保证：
   *   - 跨表写入要么全部成功要么全部回滚（需求书 8.5 事务一致性）；
   *   - 事务内的读能看到自己的写；
   *   - 外部读写排队，不会看到未提交数据。
   */
  async tx(fn) {
    return this._locked(async () => {
      await this.driver.begin();
      try {
        const result = await activeTransaction.run(this, () => fn(new Transaction(this, 0)));
        await this.driver.commit();
        return result;
      } catch (err) {
        try {
          await this.driver.rollback();
        } catch {
          /* 保留原始错误 */
        }
        throw err;
      }
    });
  }

  async close() {
    return this._locked(() => this.driver.close());
  }
}
