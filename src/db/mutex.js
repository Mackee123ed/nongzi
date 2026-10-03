/**
 * 异步互斥锁（promise 链式排队）。
 *
 * ★ 为什么 SQLite 必须要这把锁，而且不许“优化”掉：
 *
 * node:sqlite 的 DatabaseSync 是同步 API，但本层的接口是异步的（为了让 MySQL /
 * PostgreSQL / SQL Server 这三个天然异步的驱动能实现同一套接口）。于是在一次
 * `await` 让出事件循环的间隙，另一个请求的语句可能被送进**同一个连接**——
 * 而那个连接正处于一个尚未提交的事务中。后果是：
 *
 *   1. 两个并发事务会互相看到对方未提交的数据（隔离性被破坏）；
 *   2. 两个事务读到同一初值再各自回写，后写的覆盖先写的（丢失更新）。
 *      对本系统而言就是库存被扣少、账目对不上。
 *
 * PostgreSQL / MySQL 之所以没这个问题，是因为它们的事务独占一条连接池连接。
 * SQLite 只有这一个句柄，所以只能靠本锁把操作串行化。
 *
 * 注意：这不只是写写之间的互斥。事务进行中的**读**也必须排队，否则同一个连接
 * 上的外部读取会看到未提交数据。因此 Database 的所有操作都经过本锁，
 * 只有已经持有锁的 Tx 内部调用才直接执行。
 */
export function createMutex() {
  let tail = Promise.resolve();

  /**
   * 获取锁，返回释放函数。用法：
   *   const release = await acquire();
   *   try { ... } finally { release(); }
   */
  return async function acquire() {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const previous = tail;
    tail = previous.then(() => gate);
    await previous;
    return release;
  };
}
