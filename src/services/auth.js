/**
 * 登录与会话（需求书 2.1）。
 *
 * 用户凭工号 + 密码登录，登录成功后识别其职级（L1/L2/L3）与数据可见范围。
 *
 * 几处刻意的取舍：
 *   - 密码用 scrypt 加随机盐，不落明文，也不使用可被彩虹表攻击的裸哈希。
 *   - 「工号不存在」与「密码错误」返回完全相同的提示，避免工号被枚举。
 *   - 会话保存在内存里。这是本机单进程桌面程序，进程重启即需重新登录，
 *     既省掉一张会话表和清理任务，也顺带满足财务系统对闲置登出的要求。
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { AuthError, ValidationError } from '../core/errors.js';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;
const MIN_PASSWORD_LENGTH = 6;
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时
const VALID_LEVELS = ['L1', 'L2', 'L3'];

/** 生成密码哈希与盐（均为 base64 字符串）。 */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('base64');
  const hash = scryptSync(password, salt, KEY_LENGTH, SCRYPT_PARAMS).toString('base64');
  return { hash, salt };
}

/** 校验密码。缺少哈希或盐时返回 false 而非抛错，便于直接用于判断。 */
export function verifyPassword(password, hash, salt) {
  if (!password || !hash || !salt) return false;
  try {
    const expected = Buffer.from(hash, 'base64');
    const candidate = scryptSync(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

/** 对外暴露的用户信息，绝不包含密码字段。 */
function toPublicUser(row) {
  return {
    id: row.id,
    empNo: row.emp_no,
    name: row.name,
    level: row.level,
    jobTitle: row.job_title ?? null,
    phone: row.phone ?? null,
    mustChangePassword: Boolean(row.must_change_password),
  };
}

/** 登录失败统一使用同一句提示，避免通过文案差异枚举工号。 */
function loginFailed() {
  return new AuthError('工号或密码不正确');
}

export function createAuthService(db, { sessionTtlMs = DEFAULT_SESSION_TTL_MS } = {}) {
  /** token → { employeeId, expiresAt } */
  const sessions = new Map();

  const now = () => Date.now();

  function issueToken(employeeId) {
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { employeeId, expiresAt: now() + sessionTtlMs });
    return token;
  }

  return {
    /** 建号。密码经校验后加密存储。 */
    async createUser({ empNo, name, level, password, jobTitle = null, managerId = null }) {
      const trimmedNo = String(empNo ?? '').trim();
      if (!trimmedNo) throw new ValidationError('工号不能为空');
      if (!name) throw new ValidationError('姓名不能为空');
      if (!VALID_LEVELS.includes(level)) {
        throw new ValidationError(`职级必须是 ${VALID_LEVELS.join(' / ')} 之一`);
      }
      if (!password || String(password).length < MIN_PASSWORD_LENGTH) {
        throw new ValidationError(`密码长度不能少于 ${MIN_PASSWORD_LENGTH} 位`);
      }

      const existing = await db.one('select id from employee where emp_no = ?', [trimmedNo]);
      if (existing) throw new ValidationError(`工号 ${trimmedNo} 已存在`);

      const { hash, salt } = hashPassword(String(password));
      const id = await db.insert('employee', {
        emp_no: trimmedNo,
        name,
        level,
        job_title: jobTitle,
        manager_id: managerId,
        password_hash: hash,
        password_salt: salt,
        must_change_password: 0,
        is_active: 1,
      });
      return { id, empNo: trimmedNo, name, level };
    },

    /** 工号 + 密码登录，成功返回令牌与用户信息。 */
    async login(empNo, password) {
      const trimmedNo = String(empNo ?? '').trim();
      if (!trimmedNo || !password) throw loginFailed();

      const row = await db.one('select * from employee where emp_no = ?', [trimmedNo]);
      if (!row) throw loginFailed();
      if (!verifyPassword(String(password), row.password_hash, row.password_salt)) {
        throw loginFailed();
      }
      if (Number(row.is_active) !== 1) throw new AuthError('该账号已停用，请联系管理员');

      return { token: issueToken(row.id), user: toPublicUser(row) };
    },

    /** 凭令牌取回会话；无效或过期返回 null。 */
    async resolve(token) {
      if (!token || typeof token !== 'string') return null;

      const session = sessions.get(token);
      if (!session) return null;

      if (session.expiresAt <= now()) {
        sessions.delete(token);
        return null;
      }

      const row = await db.one('select * from employee where id = ?', [session.employeeId]);
      // 账号被删除或停用后，已签发的会话立即失效
      if (!row || Number(row.is_active) !== 1) {
        sessions.delete(token);
        return null;
      }

      return { token, user: toPublicUser(row) };
    },

    async logout(token) {
      if (token) sessions.delete(token);
    },

    /** 修改本人密码，需验证原密码。 */
    async changePassword(token, oldPassword, newPassword) {
      const session = await this.resolve(token);
      if (!session) throw new AuthError();

      if (!newPassword || String(newPassword).length < MIN_PASSWORD_LENGTH) {
        throw new ValidationError(`密码长度不能少于 ${MIN_PASSWORD_LENGTH} 位`);
      }

      const row = await db.one('select * from employee where id = ?', [session.user.id]);
      if (!verifyPassword(String(oldPassword ?? ''), row.password_hash, row.password_salt)) {
        throw new AuthError('原密码不正确');
      }

      const { hash, salt } = hashPassword(String(newPassword));
      await db.update('employee', {
        password_hash: hash,
        password_salt: salt,
        must_change_password: 0,
      }, { id: row.id });

      // 改密后其它会话一并作废，只保留当前这一个
      for (const [otherToken, s] of sessions) {
        if (s.employeeId === row.id && otherToken !== token) sessions.delete(otherToken);
      }
      return true;
    },

    /**
     * 首次启动时若无任何账号，则创建默认管理员。
     * 返回初始密码以便在控制台提示用户，并由前端强制其首次登录后修改。
     */
    async ensureDefaultAdmin() {
      const existing = await db.one('select id from employee where level = ? limit 1', ['L1']);
      if (existing) return null;

      const initialPassword = randomBytes(6).toString('base64url');
      const { hash, salt } = hashPassword(initialPassword);

      await db.insert('employee', {
        emp_no: 'admin',
        name: '系统管理员',
        level: 'L1',
        job_title: '管理员',
        password_hash: hash,
        password_salt: salt,
        must_change_password: 1,
        is_active: 1,
      });

      return { empNo: 'admin', name: '系统管理员', level: 'L1', initialPassword };
    },

    /** 仅供测试与诊断：当前活跃会话数。 */
    sessionCount() {
      return sessions.size;
    },
  };
}
