#!/usr/bin/env node
/**
 * 生成《使用说明》里的界面截图。
 *
 * 为什么要做成脚本：使用说明里的截图必须能随界面改动重新生成，否则文档很快
 * 就会和程序对不上。做法是——用一份临时数据库和示例数据真正把系统跑起来，
 * 再用无头 Chrome 逐页截图。
 *
 * 登录态怎么进截图的：临时往 web 目录写一个 _shot.html，它调用登录接口把令牌
 * 存进 sessionStorage，再跳转到目标页面；前端会从 sessionStorage 恢复会话
 * （这正是「刷新页面不掉登录」用的同一套机制）。截完立即删除，不留后门。
 *
 * 用法：node tools/screenshot.mjs
 * 产物：docs/images/*.png
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import {
  writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, readdirSync, statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(rootDir, 'src', 'web');
const imagesDir = join(rootDir, 'docs', 'images');
const helperPath = join(webDir, '_shot.html');

const PORT = Number(process.env.NZ_SHOT_PORT || 8977);
const DATA_DIR = join(tmpdir(), `nz-shots-${Date.now()}`);

const WIN_TMP = '/mnt/c/Users/Public';
const WIN_SHOTS = `${WIN_TMP}/nzshots`;

const PAGES = [
  { name: '01-登录', page: null },
  { name: '02-首页', page: 'dashboard' },
  { name: '03-在营品种', page: 'variety-active' },
  { name: '04-出入库办理', page: 'inventory-io' },
  { name: '05-实时库存', page: 'report:inventory.stock' },
  { name: '06-销售单录入', page: 'sales-order' },
  { name: '07-销售汇总', page: 'report:sales.summary' },
  { name: '08-收支流水', page: 'finance-flow' },
  { name: '09-账户余额', page: 'report:finance.balance' },
  { name: '10-经销商', page: 'dealer' },
  { name: '11-员工信息', page: 'employee' },
  // 帮助页面（使用说明 / 版本更新）。它渲染的是 Markdown 文档，截出来是长页面，
  // 因此单独用更大的窗口高度，避免只截到屏幕内的那一屏。
  { name: '12-使用说明', page: 'help', height: 1600 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('  ', ...a);

/* ---------------- 启动服务 ---------------- */

async function startServer() {
  const child = spawn(process.execPath, [join(rootDir, 'src', 'main.js')], {
    cwd: rootDir,
    env: { ...process.env, NZ_NO_BROWSER: '1', NZ_DATA_DIR: DATA_DIR, NZ_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  for (let i = 0; i < 80; i++) {
    const url = out.match(/http:\/\/127\.0\.0\.1:\d+/);
    const pw = out.match(/初始密码：(\S+)/);
    if (url && pw) return { child, base: url[0], password: pw[1] };
    if (/启动失败/.test(out)) throw new Error(out);
    await sleep(250);
  }
  throw new Error(`服务未能就绪：\n${out}`);
}

/* ---------------- 示例数据 ---------------- */

async function seed(base, token) {
  // 报表页面默认查询「本月」，示例数据也必须落在本月，
  // 否则截图里的报表全是空的。
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const day = (d) => `${ym}-${String(d).padStart(2, '0')}`;

  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(`${method} ${path} → ${json.error?.message ?? res.status}`);
    return json.data;
  };

  const north = await call('POST', '/api/regions', { code: 'R01', name: '华北' });
  await call('POST', '/api/regions', { code: 'R02', name: '河北', parentId: north });
  const east = await call('POST', '/api/regions', { code: 'R03', name: '华东' });

  await call('POST', '/api/employees', { empNo: 'm001', name: '王建军', level: 'L2', password: 'pass1234', regionIds: [north], phone: '13800000001' });
  await call('POST', '/api/employees', { empNo: 's001', name: '李海涛', level: 'L3', password: 'pass1234', phone: '13800000002' });
  await call('POST', '/api/employees', { empNo: 's002', name: '赵晓芸', level: 'L3', password: 'pass1234', phone: '13800000003' });

  const v1 = await call('POST', '/api/varieties', {
    kind: 'active', code: 'NZ001', name: '农子1号', nature: 'own', unitPrice: '128.00',
    nationalApprovalNo: '国审玉2026001', suitableTempZone: '第一积温带',
    promoRegion: '黑龙江、吉林', packSpec: '5kg/袋',
    tieredRebateNote: '满100袋返2元/袋', policy: '现款现货',
    features: '耐密植、抗倒伏，适合机械化收割',
  });
  const v2 = await call('POST', '/api/varieties', {
    kind: 'active', code: 'NZ002', name: '农子2号', nature: 'general_agent', unitPrice: '96.50',
    nationalApprovalNo: '国审玉2026002', suitableTempZone: '第二积温带',
    promoRegion: '辽宁', packSpec: '10kg/袋',
  });
  const v3 = await call('POST', '/api/varieties', {
    kind: 'active', code: 'NZ003', name: '农子5号', nature: 'own', unitPrice: '150.00',
    suitableTempZone: '第一积温带', promoRegion: '黑龙江', packSpec: '5kg/袋',
  });
  await call('POST', '/api/varieties', {
    kind: 'pending', code: 'NZ901', name: '农子9号（待审）', expectedApprovalYear: 2027,
    suitableTempZone: '第二积温带', promoRegion: '吉林', pilotPackSpec: '1kg/试装',
    features: '早熟、耐低温',
  });

  const d1 = await call('POST', '/api/dealers', {
    code: 'D001', companyName: '黑龙江丰收种业有限公司', regionId: north,
    contactName: '张伟', phone: '13900000001', agentVarietyIds: [v1, v2], pilotVarietyIds: [v3],
  });
  const d2 = await call('POST', '/api/dealers', {
    code: 'D002', companyName: '吉林金穗农资经营部', regionId: north,
    contactName: '刘敏', phone: '13900000002', agentVarietyIds: [v1],
  });
  await call('POST', '/api/dealers', {
    code: 'D003', companyName: '山东鲁丰农业科技', regionId: east,
    contactName: '陈刚', phone: '13900000003',
  });

  await call('POST', '/api/inventory/movements', { varietyId: v1, direction: 'in', quantity: 5000, occurredAt: day(1), remark: '春季铺货入库' });
  await call('POST', '/api/inventory/movements', { varietyId: v2, direction: 'in', quantity: 3200, occurredAt: day(2) });
  await call('POST', '/api/inventory/movements', { varietyId: v3, direction: 'in', quantity: 1800, occurredAt: day(5) });
  await call('POST', '/api/inventory/movements', { varietyId: v1, dealerId: d2, direction: 'out', quantity: 600, occurredAt: day(12) });
  await call('POST', '/api/inventory/movements', { varietyId: v2, direction: 'out', quantity: 400, occurredAt: day(18) });

  await call('POST', '/api/sales/orders', {
    orderNo: 'SO20260310001', dealerId: d1, orderDate: day(10),
    items: [
      { varietyId: v1, quantity: 1200, unitPrice: '128.00', rebate: '2400.00' },
      { varietyId: v2, quantity: 800, unitPrice: '96.50', rebate: '800.00' },
    ],
  });
  await call('POST', '/api/sales/orders', {
    orderNo: 'SO20260318002', dealerId: d2, orderDate: day(18),
    items: [{ varietyId: v1, quantity: 600, unitPrice: '126.00', rebate: '1200.00' }],
  });
  await call('POST', '/api/sales/orders', {
    orderNo: 'SO20260402003', dealerId: d1, orderDate: day(2),
    items: [{ varietyId: v3, quantity: 300, unitPrice: '150.00', rebate: '0' }],
  });

  await call('POST', '/api/finance/flows', {
    kind: 'expense', categoryCode: 'own_variety_cost', occurredAt: day(2),
    name: '农子1号制种费用', amount: '180000.00',
    components: { seedProductionFee: '150000.00', processingFee: '20000.00', transportFee: '10000.00' },
  });
  await call('POST', '/api/finance/flows', { kind: 'expense', categoryCode: 'office', occurredAt: day(6), name: '3月办公费用', amount: '8600.00' });
  await call('POST', '/api/finance/flows', { kind: 'expense', categoryCode: 'travel', occurredAt: day(20), name: '黑龙江市场差旅费', amount: '12400.00' });
  await call('POST', '/api/finance/flows', { kind: 'income', categoryCode: 'other_income', occurredAt: day(25), name: '技术服务收入', amount: '30000.00' });

  await call('POST', '/api/salaries', { employeeId: 2, period: '2026-03', payDate: day(31), baseSalary: '8500.00', performanceSalary: '3200.00', yearEndBonus: '0' });
  await call('POST', '/api/salaries', { employeeId: 3, period: '2026-03', payDate: day(31), baseSalary: '6200.00', performanceSalary: '1800.00', yearEndBonus: '0' });
  await call('POST', '/api/social-insurance', {
    employeeId: 2, period: '2026-03', payDate: day(15), baseAmount: '8500.00',
    companyFund: '1020.00', personalFund: '1020.00', companySocial: '2210.00', personalSocial: '850.00',
  });
}

/* ---------------- 浏览器 ---------------- */

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/**
 * 找 Windows 上的浏览器。
 * 注意：批处理文件必须是 CRLF + 纯 ASCII，否则 cmd 会用 GBK 解析中文导致失败。
 */
function findChrome() {
  const probe = join(WIN_TMP, 'nz-probe.bat');
  const lines = ['@echo off', ...CHROME_CANDIDATES.map((p) => `if exist "${p}" echo FOUND:${p}`)];
  writeFileSync(probe, `${lines.join('\r\n')}\r\n`, 'ascii');

  const out = execFileSync('cmd.exe', ['/c', 'C:\\Users\\Public\\nz-probe.bat'], {
    encoding: 'utf8', windowsHide: true,
  }).toString();
  rmSync(probe, { force: true });

  const hit = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('FOUND:'));
  return hit ? hit.slice(6) : null;
}

/**
 * 截一张图。
 *
 * 关键点：写到 Windows 侧的文件名必须**纯 ASCII**。批处理文件本身是 ASCII 的，
 * 但只要命令行里出现中文文件名，cmd 就会按 GBK 去解析这段字节，路径随即失效。
 * 因此这里统一用 shot-01.png 这类名字落地，拷回项目时再改成中文名。
 */
function shoot(chrome, url, asciiName, finalName, height = 900) {
  const batPath = join(WIN_TMP, 'nz-shot.bat');
  const produced = join(WIN_SHOTS, asciiName);

  // ★ 先删掉目标文件。Chrome 的 --headless --screenshot 会 fork 子进程后立即返回，
  //   若不等文件真正写完就拷贝，拿到的是上一张图的旧内容（表现是多张截图完全相同）。
  rmSync(produced, { force: true });

  writeFileSync(batPath, [
    '@echo off',
    `"${chrome}" --headless=new --disable-gpu --hide-scrollbars --no-sandbox `
      + `--force-device-scale-factor=1 --window-size=1440,${height} --virtual-time-budget=9000 `
      + `--screenshot="C:\\Users\\Public\\nzshots\\${asciiName}" "${url}"`,
    'echo DONE',
  ].join('\r\n') + '\r\n', 'ascii');

  spawnSync('cmd.exe', ['/c', 'C:\\Users\\Public\\nz-shot.bat'], {
    windowsHide: true, timeout: 90_000, encoding: 'utf8',
  });
  rmSync(batPath, { force: true });

  // 轮询等待文件出现且大小稳定（连续两次一致才算写完）
  let lastSize = -1;
  for (let i = 0; i < 60; i++) {
    if (existsSync(produced)) {
      const size = statSync(produced).size;
      if (size > 0 && size === lastSize) {
        copyFileSync(produced, join(imagesDir, finalName));
        return;
      }
      lastSize = size;
    }
    sleepSync(250);
  }
  throw new Error(`截图未生成或未写完：${asciiName}`);
}

/** 同步小睡，供轮询使用（本模块顶层是同步流程）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/* ---------------- 主流程 ---------------- */

const HELPER_HTML = `<!doctype html>
<meta charset="utf-8"><title>bootstrap</title>
<script>
(async () => {
  const q = new URLSearchParams(location.search);
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empNo: q.get('u'), password: q.get('p') }),
    });
    const json = await res.json();
    if (json.ok) sessionStorage.setItem('nz_token', json.data.token);
  } catch (e) { /* 落到登录页也无妨 */ }
  location.replace('/#/' + (q.get('page') || 'dashboard'));
})();
</script>
`;

async function main() {
  mkdirSync(imagesDir, { recursive: true });
  rmSync(WIN_SHOTS, { recursive: true, force: true });
  mkdirSync(WIN_SHOTS, { recursive: true });

  const chrome = findChrome();
  if (!chrome) throw new Error('未找到 Chrome 或 Edge 浏览器');
  log('浏览器：', chrome);
  log('启动服务…');
  const { child, base, password } = await startServer();
  childToKill = child;
  log('地址：', base);

  try {
    const login = await (await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empNo: 'admin', password }),
    })).json();
    if (!login.ok) throw new Error(`登录失败：${login.error?.message}`);

    log('写入示例数据…');
    await seed(base, login.data.token);

    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthStart = `${ym}-01`;
    const monthEnd = `${ym}-${new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()}`;

    log('逐页截图…');
    for (const [i, page] of PAGES.entries()) {
      process.stdout.write(`    [${String(i + 1).padStart(2)}/${PAGES.length}] ${page.name} … `);

      // 登录页直接截根路径；其余页面走临时引导页带登录态进去
      const asciiName = `shot-${String(i + 1).padStart(2, '0')}.png`;

      if (page.page === null) {
        shoot(chrome, `${base}/`, asciiName, `${page.name}.png`, page.height);
      } else {
        writeFileSync(helperPath, HELPER_HTML, 'utf8');
        // 报表页显式带上本月区间：不依赖截图机器与运行机器的时钟是否一致
        const page_ = page.page.startsWith('report:') && !page.page.endsWith('inventory.stock')
          ? `${page.page}?from=${monthStart}&to=${monthEnd}`
          : page.page;
        const url = `${base}/_shot.html?u=admin&p=${encodeURIComponent(password)}`
          + `&page=${encodeURIComponent(page_)}`;
        shoot(chrome, url, asciiName, `${page.name}.png`, page.height);
        rmSync(helperPath, { force: true });
      }
      console.log('完成');
    }

    const count = readdirSync(imagesDir).filter((f) => f.endsWith('.png')).length;
    console.log(`\n  共生成 ${count} 张截图 → docs/images/`);
  } finally {
    rmSync(helperPath, { force: true });
    rmSync(DATA_DIR, { recursive: true, force: true });
    child.kill('SIGKILL');
  }
}

// 被 Ctrl+C 或外部 kill 时也要收掉后端子进程，否则会留下孤儿服务占着端口。
// （踩过一次：kill 掉本脚本后，它启动的服务一直存活，后续截图全部落到旧进程上。）
let childToKill = null;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (childToKill && !childToKill.killed) childToKill.kill('SIGKILL');
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('\n截图失败：', err.message);
  if (childToKill && !childToKill.killed) childToKill.kill('SIGKILL');
  process.exit(1);
});
