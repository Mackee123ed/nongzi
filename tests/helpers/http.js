/**
 * HTTP 测试夹具：起一个真实监听端口的服务，用真实 fetch 请求它。
 *
 * 之所以不 mock 请求对象，是因为本层最容易出错的地方恰恰是端到端的那部分：
 * 会话令牌怎么取、权限范围怎么随请求走、错误怎么映射成状态码。
 * 这些用单元测试替身都测不出来。
 */

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApp } from '../../src/http/app.js';
import { createServices } from '../../src/services/index.js';
import { makeDb } from './db.js';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

export async function startTestServer() {
  const db = await makeDb();
  const services = createServices({ db, config: null, configPath: null });
  const app = createApp({
    db, services,
    webRoot: join(srcDir, 'web'),
    staticMounts: {
      '/pic/': join(srcDir, 'pic'),
      '/docs/': join(srcDir, '..', 'docs'),
      '/CHANGELOG.md': join(srcDir, '..', 'CHANGELOG.md'),
    },
  });

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  async function request(method, path, { body, token } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }

    return { status: response.status, ok: response.ok, body: payload, data: payload?.data };
  }

  const api = {
    get: (path, token) => request('GET', path, { token }),
    post: (path, body, token) => request('POST', path, { body, token }),
    put: (path, body, token) => request('PUT', path, { body, token }),
  };

  /** 登录并返回令牌；同时校验确实登录成功，避免后续断言全是 401 却看不出原因。 */
  async function login(empNo, password) {
    const res = await api.post('/api/auth/login', { empNo, password });
    if (!res.ok) throw new Error(`登录失败 ${empNo}：${res.body?.error?.message}`);
    return res.data.token;
  }

  return {
    db,
    services,
    base,
    request,
    api,
    login,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await db.close();
    },
  };
}

/**
 * 建一套标准的权限测试数据：
 *   华北(1) ─ 河北(2)
 *   华东(4)
 * 三个用户：L1 高管、L2 王经理（分管华北）、L3 李业务（王经理下属）
 */
export async function seedOrg(services) {
  const { db, auth } = services;

  const regionNorth = await db.insert('region', { code: 'R01', name: '华北' });
  const regionHebei = await db.insert('region', { code: 'R02', name: '河北', parent_id: regionNorth });
  const regionEast = await db.insert('region', { code: 'R03', name: '华东' });

  const boss = await auth.createUser({ empNo: 'boss', name: '高管', level: 'L1', password: 'pass1234' });
  const manager = await auth.createUser({ empNo: 'mgr', name: '王经理', level: 'L2', password: 'pass1234' });
  const staff = await auth.createUser({ empNo: 'staff', name: '李业务', level: 'L3', password: 'pass1234' });

  // L3 挂到 L2 名下，并让 L2 分管华北（含下级河北）
  await db.update('employee', { manager_id: manager.id }, { id: staff.id });
  await db.insert('employee_scope', {
    employee_id: manager.id, scope_type: 'region', scope_value_id: regionNorth,
  });

  return {
    regions: { north: regionNorth, hebei: regionHebei, east: regionEast },
    users: { boss, manager, staff },
    passwords: { boss: 'pass1234', manager: 'pass1234', staff: 'pass1234' },
  };
}
