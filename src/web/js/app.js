/**
 * 前端入口：登录、导航、hash 路由。
 *
 * 导航图标按当前用户职级过滤 —— 但这只是「界面整洁」层面的处理。
 * 真正的权限判定一律在服务端：每个接口都会用会话里的职级重新算一遍可见范围，
 * 前端即便手工改 hash 直接跳到某个页面，也只会拿到 403 或空数据。
 */

import { api, setToken, getToken, ApiError } from './api.js';
import { h, clear, card, buildFields, readFields, toast, showError } from './ui.js';
import {
  makeEntityPage, makeReportPage, renderDashboard,
  renderInventoryIo, renderSalesOrder, renderHelp, clearLookupCache,
} from './pages.js';

/** 菜单：每一项对应一个页面工厂。minLevel 用于前端隐藏。 */
const MENU = [
  {
    group: null,
    items: [{ key: 'dashboard', title: '首页' }],
  },
  {
    group: '库存管理',
    items: [
      { key: 'variety-active', title: '在营品种' },
      { key: 'variety-pending', title: '待营品种' },
      { key: 'inventory-io', title: '出入库办理' },
      { key: 'report:inventory.stock', title: '实时库存' },
      { key: 'report:inventory.movements', title: '库存查询' },
    ],
  },
  {
    group: '销售管理',
    items: [
      { key: 'sales-order', title: '销售单录入' },
      { key: 'report:sales.detail', title: '销售明细' },
      { key: 'report:sales.summary', title: '销售汇总' },
    ],
  },
  {
    group: '财务管理',
    items: [
      { key: 'finance-flow', title: '收支流水' },
      { key: 'report:finance.summary', title: '收支明细' },
      { key: 'report:finance.category', title: '分类收支明细' },
      { key: 'report:finance.ledger', title: '经销商往来账' },
      { key: 'report:finance.balance', title: '账户余额' },
    ],
  },
  {
    group: '客户管理',
    items: [
      { key: 'dealer', title: '经销商' },
      { key: 'feedback', title: '经销商反馈' },
      { key: 'report:customer.feedback', title: '反馈查询' },
    ],
  },
  {
    group: '员工管理',
    items: [
      { key: 'employee', title: '员工信息' },
      { key: 'salary', title: '员工工资', minLevel: ['L1', 'L2'] },
      { key: 'social-insurance', title: '员工社保', minLevel: ['L1', 'L2'] },
      { key: 'report:payroll.salary', title: '工资发放查询', minLevel: ['L1', 'L2'] },
      { key: 'report:payroll.social', title: '五险一金查询', minLevel: ['L1', 'L2'] },
      { key: 'report:payroll.total', title: '工资社保总支出', minLevel: ['L1', 'L2'] },
    ],
  },
  {
    group: '帮助',
    // 使用说明对所有职级可见——新人不看说明没法用系统
    items: [{ key: 'help', title: '使用说明 / 版本更新' }],
  },
  {
    group: '系统',
    items: [
      { key: 'region', title: '区域维护', minLevel: ['L1'] },
      { key: 'system', title: '数据库配置', minLevel: ['L1'] },
    ],
  },
];

const state = { session: null, currentKey: null };

/* ---------------- 页面解析 ---------------- */

function resolvePage(key) {
  if (key === 'dashboard') return { title: '首页', render: renderDashboard(state.session) };
  if (key === 'inventory-io') return { title: '出入库办理', render: renderInventoryIo() };
  if (key === 'sales-order') return { title: '销售单录入', render: renderSalesOrder() };
  if (key === 'system') return { title: '数据库配置', render: renderSystemConfig() };
  if (key === 'help') return { title: '使用说明', render: renderHelp() };

  if (key.startsWith('report:')) {
    const code = key.slice('report:'.length);
    return { title: pageTitle(key), render: makeReportPage(code) };
  }

  return { title: pageTitle(key), render: makeEntityPage(key) };
}

function pageTitle(key) {
  for (const group of MENU) {
    for (const item of group.items) {
      if (item.key === key) return item.title;
    }
  }
  return '农子财务管理系统';
}

/* ---------------- 导航 ---------------- */

function renderNav() {
  const nav = document.getElementById('nav');
  clear(nav);
  const level = state.session?.user?.level;

  for (const group of MENU) {
    const visible = group.items.filter((item) => !item.minLevel || item.minLevel.includes(level));
    if (visible.length === 0) continue;

    if (group.group) nav.append(h('div', { class: 'nav-group-title' }, group.group));
    for (const item of visible) {
      nav.append(h('a', {
        class: `nav-item ${state.currentKey === item.key ? 'active' : ''}`,
        href: `#/${item.key}`,
      }, item.title));
    }
  }
}

/* ---------------- 路由 ---------------- */

async function navigate() {
  const key = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?')[0];
  state.currentKey = key;

  const title = pageTitle(key);
  document.getElementById('page-title').textContent = title;
  document.title = `${title} · 农子财务管理系统`;
  renderNav();

  const view = document.getElementById('view');
  const page = resolvePage(key);

  try {
    await page.render(view);
  } catch (err) {
    clear(view);
    view.append(h('div', { class: 'empty' }, `页面加载失败：${err.message}`));
  }
}

/* ---------------- 系统配置页 ---------------- */

function renderSystemConfig() {
  return async function render(container) {
    clear(container);
    const host = h('div', {});
    container.append(card('数据库连接配置', host));

    const config = await api.get('/system/db-config');

    const fields = [
      {
        key: 'dialect', label: '数据库类型', type: 'select', required: true,
        options: [
          { value: 'sqlite', label: 'SQLite（内嵌，默认，开箱即用）' },
          { value: 'mysql', label: 'MySQL / MariaDB' },
          { value: 'pg', label: 'PostgreSQL' },
          { value: 'mssql', label: 'SQL Server' },
        ],
      },
      { key: 'host', label: '地址' },
      { key: 'port', label: '端口' },
      { key: 'database', label: '库名 / 文件路径' },
      { key: 'user', label: '账号' },
      { key: 'password', label: '密码', type: 'password' },
    ];

    const initial = {
      dialect: config.database.dialect,
      host: config.database.host ?? '',
      port: config.database.port ?? '',
      database: config.database.database ?? '',
      user: config.database.user ?? '',
      password: '',
    };

    const form = buildFields(fields, initial);

    host.append(
      h('p', { class: 'muted' },
        '默认使用内嵌 SQLite，无需任何配置即可运行。切换到其他数据库后需重启程序生效；'
        + '对应驱动需已安装（npm install mysql2 / pg / mssql）。'),
      form.element,
      h('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          try {
            const values = readFields(fields, form.inputs);
            await api.put('/system/db-config', values);
            toast('配置已保存，重启程序后生效');
          } catch (err) { showError(err); }
        },
      }, '保存配置'),
    );
  };
}

/* ---------------- 登录 ---------------- */

function showLogin() {
  document.getElementById('login-view').hidden = false;
  document.getElementById('app-view').hidden = true;
  document.getElementById('login-empno').focus();
}

function showApp(session) {
  state.session = session;
  document.getElementById('login-view').hidden = true;
  document.getElementById('app-view').hidden = false;
  document.getElementById('current-user').textContent = `${session.user.name}（${session.user.empNo}）`;
  document.getElementById('scope-hint').textContent = session.scopeLabel ?? '';
  if (!location.hash) location.hash = '#/dashboard';
  navigate();
}

async function doLogin(event) {
  event.preventDefault();
  const errorBox = document.getElementById('login-error');
  const button = document.getElementById('login-submit');
  errorBox.hidden = true;
  button.disabled = true;

  try {
    const result = await api.post('/auth/login', {
      empNo: document.getElementById('login-empno').value,
      password: document.getElementById('login-password').value,
    });
    setToken(result.token);
    clearLookupCache();
    showApp(result);
    document.getElementById('login-password').value = '';

    if (result.mustChangePassword) {
      toast('这是初始密码，请尽快在「员工信息」中修改', 'error');
    }
  } catch (err) {
    errorBox.textContent = err instanceof ApiError ? err.message : '登录失败';
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
  }
}

/* ---------------- 启动 ---------------- */

function boot() {
  document.getElementById('login-form').addEventListener('submit', doLogin);
  document.getElementById('logout-btn').addEventListener('click', async () => {
    try { await api.post('/auth/logout', {}); } catch { /* 忽略 */ }
    setToken(null);
    clearLookupCache();
    state.session = null;
    location.hash = '';
    showLogin();
  });

  window.addEventListener('hashchange', () => { if (state.session) navigate(); });
  window.addEventListener('auth:expired', () => {
    setToken(null);
    state.session = null;
    showLogin();
    toast('登录状态已失效，请重新登录', 'error');
  });

  // 刷新页面时若本地还留着有效令牌，直接恢复登录状态，不必重新输密码
  restoreSession();
}

async function restoreSession() {
  if (!getToken()) {
    showLogin();
    return;
  }
  try {
    const session = await api.get('/auth/me');
    showApp(session);
  } catch {
    setToken(null);
    showLogin();
  }
}

boot();
