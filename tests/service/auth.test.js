import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../helpers/db.js';
import { hashPassword, verifyPassword, createAuthService } from '../../src/services/auth.js';
import { AuthError } from '../../src/core/errors.js';

describe('auth — 工号 + 密码登录与会话（需求书 2.1）', () => {
  let db;
  let auth;

  beforeEach(async () => {
    db = await makeDb();
    auth = createAuthService(db, { sessionTtlMs: 60_000 });
    await auth.createUser({ empNo: 'admin', name: '系统管理员', level: 'L1', password: 'admin123' });
    await auth.createUser({ empNo: 'm001', name: '王经理', level: 'L2', password: 'pass1234' });
    await auth.createUser({ empNo: 's001', name: '李业务', level: 'L3', password: 'pass1234' });
  });

  afterEach(async () => { await db.close(); });

  describe('密码存储', () => {
    test('同一密码两次加密结果不同（加盐）', () => {
      const a = hashPassword('same-password');
      const b = hashPassword('same-password');
      assert.notEqual(a.hash, b.hash);
      assert.notEqual(a.salt, b.salt);
    });

    test('密码不落明文', async () => {
      const row = await db.one('select password_hash, password_salt from employee where emp_no = ?', ['admin']);
      assert.ok(row.password_hash);
      assert.notEqual(row.password_hash, 'admin123');
      assert.doesNotMatch(row.password_hash, /admin123/);
    });

    test('校验正确密码通过、错误密码不通过', () => {
      const { hash, salt } = hashPassword('correct-horse');
      assert.equal(verifyPassword('correct-horse', hash, salt), true);
      assert.equal(verifyPassword('wrong-horse', hash, salt), false);
    });

    test('盐不同则同一密码校验失败', () => {
      const a = hashPassword('same');
      const b = hashPassword('same');
      assert.equal(verifyPassword('same', a.hash, b.salt), false);
    });

    test('缺少哈希或盐时一律不通过，而不是抛错', () => {
      assert.equal(verifyPassword('x', null, null), false);
      assert.equal(verifyPassword('x', 'abc', null), false);
    });
  });

  describe('登录', () => {
    test('工号 + 正确密码登录成功', async () => {
      const result = await auth.login('admin', 'admin123');
      assert.ok(result.token, '应返回会话令牌');
      assert.equal(result.user.empNo, 'admin');
      assert.equal(result.user.name, '系统管理员');
      assert.equal(result.user.level, 'L1');
    });

    test('密码错误抛出认证错误', async () => {
      await assert.rejects(() => auth.login('admin', 'wrong'), (err) => {
        assert.ok(err instanceof AuthError);
        return true;
      });
    });

    test('工号不存在抛出认证错误，且不泄漏「用户不存在」', async () => {
      await assert.rejects(() => auth.login('nobody', 'whatever'), (err) => {
        assert.ok(err instanceof AuthError);
        assert.doesNotMatch(err.message, /不存在|未找到/);
        return true;
      });
    });

    test('密码错误的提示与工号不存在的提示一致，避免工号被枚举', async () => {
      const wrongPassword = await auth.login('admin', 'wrong').catch((e) => e.message);
      const noSuchUser = await auth.login('nobody', 'wrong').catch((e) => e.message);
      assert.equal(wrongPassword, noSuchUser);
    });

    test('离职员工不能登录', async () => {
      await auth.createUser({ empNo: 'gone', name: '已离职', level: 'L3', password: 'pass1234' });
      await db.run('update employee set is_active = 0 where emp_no = ?', ['gone']);
      await assert.rejects(() => auth.login('gone', 'pass1234'), AuthError);
    });

    test('工号前后空格被忽略', async () => {
      const result = await auth.login('  admin  ', 'admin123');
      assert.equal(result.user.empNo, 'admin');
    });

    test('登录结果不泄漏密码哈希与盐', async () => {
      const { user } = await auth.login('admin', 'admin123');
      const keys = Object.keys(user);
      assert.deepEqual(
        keys.filter((k) => /password_hash|passwordSalt|password_salt/i.test(k)),
        [],
        '不得回传 password_hash / password_salt',
      );
      const row = await db.one('select password_hash, password_salt from employee where emp_no = ?', ['admin']);
      assert.ok(!JSON.stringify(user).includes(row.password_hash));
      assert.ok(!JSON.stringify(user).includes(row.password_salt));
    });
  });

  describe('会话', () => {
    test('凭令牌可取回当前用户', async () => {
      const { token } = await auth.login('m001', 'pass1234');
      const session = await auth.resolve(token);
      assert.equal(session.user.empNo, 'm001');
      assert.equal(session.user.level, 'L2');
    });

    test('无效令牌返回 null', async () => {
      assert.equal(await auth.resolve('not-a-real-token'), null);
      assert.equal(await auth.resolve(undefined), null);
      assert.equal(await auth.resolve(''), null);
    });

    test('登出后令牌立即失效', async () => {
      const { token } = await auth.login('m001', 'pass1234');
      assert.ok(await auth.resolve(token));
      await auth.logout(token);
      assert.equal(await auth.resolve(token), null);
    });

    test('每次登录签发不同的令牌', async () => {
      const a = await auth.login('admin', 'admin123');
      const b = await auth.login('admin', 'admin123');
      assert.notEqual(a.token, b.token);
    });

    test('会话过期后失效', async () => {
      const shortLived = createAuthService(db, { sessionTtlMs: -1 });
      const { token } = await shortLived.login('admin', 'admin123');
      assert.equal(await shortLived.resolve(token), null);
    });
  });

  describe('建号', () => {
    test('工号重复时报错', async () => {
      await assert.rejects(
        () => auth.createUser({ empNo: 'admin', name: '重复', level: 'L3', password: 'x1234567' }),
        /已存在/,
      );
    });

    test('职级非法时报错', async () => {
      await assert.rejects(
        () => auth.createUser({ empNo: 'x1', name: '甲', level: 'L9', password: 'x1234567' }),
        /职级/,
      );
    });

    test('密码过短时报错', async () => {
      await assert.rejects(
        () => auth.createUser({ empNo: 'x2', name: '甲', level: 'L3', password: '123' }),
        /密码/,
      );
    });

    test('修改密码后旧密码失效、新密码可用', async () => {
      const { token } = await auth.login('s001', 'pass1234');
      await auth.changePassword(token, 'pass1234', 'newpass99');

      await assert.rejects(() => auth.login('s001', 'pass1234'), AuthError);
      const again = await auth.login('s001', 'newpass99');
      assert.ok(again.token);
    });

    test('修改密码时原密码错误则拒绝', async () => {
      const { token } = await auth.login('s001', 'pass1234');
      await assert.rejects(() => auth.changePassword(token, 'wrong', 'newpass99'), AuthError);
    });
  });

  describe('首次使用', () => {
    test('空库初始化后存在一个默认 L1 账号', async () => {
      const freshDb = await makeDb();
      const freshAuth = createAuthService(freshDb);
      const created = await freshAuth.ensureDefaultAdmin();

      assert.ok(created, '空库应创建默认管理员');
      assert.equal(created.empNo, 'admin');
      assert.equal(created.level, 'L1');
      assert.ok(created.initialPassword, '应返回初始密码以便在控制台提示用户');

      const { token } = await freshAuth.login('admin', created.initialPassword);
      const session = await freshAuth.resolve(token);
      assert.equal(session.user.mustChangePassword, true, '首次登录应要求修改密码');
      await freshDb.close();
    });

    test('已存在管理员时不重复创建', async () => {
      const created = await auth.ensureDefaultAdmin();
      assert.equal(created, null);
      const rows = await db.query("select id from employee where emp_no = 'admin'");
      assert.equal(rows.length, 1);
    });
  });
});
