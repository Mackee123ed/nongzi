import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom } from '../helpers/dom.js';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 前端组件渲染测试。
 *
 * 这组测试是为了堵住一个真实的漏洞：前端此前只被「能不能取到文件」覆盖，
 * 渲染逻辑本身没有测试，于是「lookup 字段被建成 <input> 而不是 <select>」这种
 * 一眼看不出的错误一路留到了用户面前。这里直接断言组件产出的元素结构。
 */

let ui;
let pages;

before(async () => {
  installDom();
  ui = await import('../../src/web/js/ui.js');
  pages = await import('../../src/web/js/pages.js');
});

const OPTS = [
  { value: 1, label: '甲' },
  { value: 2, label: '乙' },
];

describe('ui.buildFields — 表单控件构造', () => {
  test('select 字段建成 <select> 并带上选项', () => {
    const form = ui.buildFields(
      [{ key: 'kind', label: '类型', type: 'select', options: OPTS }],
      { kind: 2 },
    );
    const el = form.inputs.kind;
    assert.equal(el.tagName, 'SELECT');
    assert.equal(el.options.length, 3, '一个占位项 + 两个选项');
    assert.equal(el.value, '2', '初始值应被选中');
  });

  test('★ lookup 字段也必须建成 <select>（曾被建成 <input>，导致下拉框不可用）', () => {
    const form = ui.buildFields([{ key: 'varietyId', label: '品种', type: 'lookup' }], {});
    assert.equal(
      form.inputs.varietyId.tagName, 'SELECT',
      'lookup 必须是 select，否则 enhanceLookups 填充的 option 不会生效',
    );
  });

  test('★ multilookup 字段建成可多选的 <select>', () => {
    const form = ui.buildFields([{ key: 'species', label: '品种', type: 'multilookup' }], {});
    const el = form.inputs.species;
    assert.equal(el.tagName, 'SELECT');
    assert.equal(el.multiple, true);
  });

  test('money 字段建成文本框（元为单位，交给后端解析成分）', () => {
    const form = ui.buildFields([{ key: 'unitPrice', label: '单价', type: 'money' }], { unitPrice: '12.34' });
    assert.equal(form.inputs.unitPrice.tagName, 'INPUT');
    assert.equal(form.inputs.unitPrice.getAttribute('type'), 'text');
    assert.equal(form.inputs.unitPrice.value, '12.34');
  });

  test('textarea 字段建成 <textarea>', () => {
    const form = ui.buildFields([{ key: 'note', label: '备注', type: 'textarea' }], { note: '内容' });
    assert.equal(form.inputs.note.tagName, 'TEXTAREA');
    assert.equal(form.inputs.note.value, '内容');
  });

  test('date / month 字段使用原生日期控件', () => {
    const form = ui.buildFields([
      { key: 'd', label: '日期', type: 'date' },
      { key: 'm', label: '月份', type: 'month' },
    ], {});
    assert.equal(form.inputs.d.getAttribute('type'), 'date');
    assert.equal(form.inputs.m.getAttribute('type'), 'month');
  });
});

describe('ui.readFields — 表单取值', () => {
  test('必填与选填字段留空时的取值约定不同', () => {
    const fields = [
      { key: 'name', label: '名称', required: true },
      { key: 'note', label: '备注' },
    ];
    const form = ui.buildFields(fields, { name: '甲' });
    const values = ui.readFields(fields, form.inputs);
    assert.equal(values.name, '甲');
    // 选填字段留空表示「不修改」，用 null 表达，而非空字符串
    assert.equal(values.note, null);
  });

  test('文本首尾空格被去掉', () => {
    const fields = [{ key: 'name', label: '名称' }];
    const form = ui.buildFields(fields, { name: '  甲  ' });
    assert.equal(ui.readFields(fields, form.inputs).name, '甲');
  });
});

describe('ui.table — 表格渲染', () => {
  test('按列描述渲染表头与数据行', () => {
    const el = ui.table(
      [{ key: 'name', title: '名称' }, { key: 'qty', title: '数量', align: 'right' }],
      [{ name: '甲', qty: 10 }, { name: '乙', qty: 20 }],
    );
    assert.equal(el.find((e) => e.tagName === 'THEAD').children.length, 1);
    assert.equal(el.findAll((e) => e.tagName === 'TR').length, 3, '1 表头 + 2 数据行');
    assert.match(el.textContent, /甲/);
    assert.match(el.textContent, /20/);
  });

  test('空数据渲染提示而不是空表格', () => {
    const el = ui.table([{ key: 'name', title: '名称' }], [], { emptyText: '暂无数据' });
    assert.equal(el.find((e) => e.tagName === 'TABLE'), null);
    assert.match(el.textContent, /暂无数据/);
  });

  test('合计行使用各列提供的汇总函数', () => {
    const el = ui.table(
      [{ key: 'name', title: '名称' }, { key: 'amount', title: '金额', align: 'right', total: (t) => `合计${t.sum}` }],
      [{ name: '甲', amount: 1 }],
      { totals: { sum: 42 } },
    );
    assert.match(el.textContent, /合计42/);
  });

  test('★ 文本一律经 textContent 写入，不被当作 HTML 解析', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const el = ui.table([{ key: 'note', title: '备注' }], [{ note: evil }]);
    // 桩里没有 innerHTML，若实现用了 innerHTML 会在此崩溃或断言失败
    assert.equal(el.textContent.includes(evil), true);
    assert.equal(el.find((e) => e.tagName === 'IMG'), null, '不应产生真实标签');
  });
});

describe('pages.enhanceLookups — 下拉候选填充', () => {
  test('用候选数据填充 lookup 下拉框', async () => {
    const fields = [{ key: 'varietyId', label: '品种', type: 'lookup', lookup: 'varieties' }];
    const form = ui.buildFields(fields, {});
    form.inputs.varietyId.dataset.initial = '';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: [{ id: 1, code: 'A', name: '甲' }, { id: 2, code: 'B', name: '乙' }] }),
      text: async () => '',
    });

    try {
      await pages.__test__.enhanceLookups(fields, form.inputs);
      const el = form.inputs.varietyId;
      assert.equal(el.tagName, 'SELECT');
      assert.equal(el.options.length, 3, '1 个占位项 + 2 个候选');
      assert.match(el.textContent, /甲/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('★ 原值不在候选列表时保留为选项，避免编辑时被静默清空', async () => {
    const fields = [{ key: 'varietyId', label: '品种', type: 'lookup', lookup: 'varieties' }];
    const form = ui.buildFields(fields, {});
    form.inputs.varietyId.dataset.initial = '99';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: [{ id: 1, code: 'A', name: '甲' }] }),
      text: async () => '',
    });

    try {
      await pages.__test__.enhanceLookups(fields, form.inputs);
      const el = form.inputs.varietyId;
      assert.equal(el.value, '99', '原值应仍然被选中');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('候选数据取不到时退化为空列表，不抛错', async () => {
    const fields = [{ key: 'varietyId', label: '品种', type: 'lookup', lookup: 'varieties' }];
    const form = ui.buildFields(fields, {});

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('网络故障'); };

    try {
      await assert.doesNotReject(() => pages.__test__.enhanceLookups(fields, form.inputs));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('帮助页面接入', () => {
  test('pages.js 导出 renderHelp', async () => {
    const mod = await import('../../src/web/js/pages.js');
    assert.equal(typeof mod.renderHelp, 'function');
  });

  test('菜单里有「使用说明」入口，且不限制职级（新人也需要看）', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

    const source = readFileSync(join(root, 'src', 'web', 'js', 'app.js'), 'utf8');
    const entry = /key:\s*'help',\s*title:\s*'[^']+'([^}]*)}/.exec(source);
    assert.ok(entry, '菜单中应有 key 为 help 的项');
    assert.doesNotMatch(entry[1], /minLevel/, '使用说明不应限制职级');
  });

  test('路由能解析 help 页面', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

    const source = readFileSync(join(root, 'src', 'web', 'js', 'app.js'), 'utf8');
    assert.match(source, /key === 'help'/, 'resolvePage 应处理 help');
  });
});

/**
 * 帮助页面直接把 docs/使用说明.md 与 CHANGELOG.md 渲染出来，所以这两份文档
 * 一旦落后于程序，用户在页面上立刻就能看到。这里把「保持同步」这条要求
 * 变成会失败的测试，避免只写在 CLAUDE.md 里、实际没人执行。
 */
describe('帮助页面与文档保持同步', () => {
  const read = (...parts) => readFileSync(join(rootDir, ...parts), 'utf8');

  test('package.json 的 version 与 CHANGELOG 最新一节一致', () => {
    const pkg = JSON.parse(read('package.json'));
    const latest = /^##\s+(\d+\.\d+\.\d+)/m.exec(read('CHANGELOG.md'));
    assert.ok(latest, 'CHANGELOG.md 里应有形如「## 1.1.0」的版本小节');
    assert.equal(
      pkg.version, latest[1],
      `package.json 的 version（${pkg.version}）与 CHANGELOG 最新版本（${latest[1]}）不一致；`
      + '每次发版必须同步改这两处（见 CLAUDE.md【硬性要求】）',
    );
  });

  test('使用说明里介绍了「帮助 → 使用说明 / 版本更新」入口', () => {
    const manual = read('docs', '使用说明.md');
    assert.match(manual, /帮助/, '使用说明应介绍帮助页面入口，否则用户不知道系统里有说明可看');
    assert.match(manual, /版本更新/, '使用说明应说明帮助页面里可以看到版本更新记录');
  });
});

describe('reports / resources 描述表自洽性', () => {
  test('每条报表都声明了接口路径与列', async () => {
    const { REPORTS } = await import('../../src/web/js/reports.js');
    for (const [key, report] of Object.entries(REPORTS)) {
      assert.ok(report.path, `${key} 缺少 path`);
      assert.ok(report.title, `${key} 缺少 title`);
      assert.ok(Array.isArray(report.columns) && report.columns.length > 0, `${key} 缺少列定义`);
    }
  });

  test('每个主数据资源都声明了接口路径、列与必填字段的标签', async () => {
    const { RESOURCES } = await import('../../src/web/js/resources.js');
    for (const [key, resource] of Object.entries(RESOURCES)) {
      assert.ok(resource.path, `${key} 缺少 path`);
      assert.ok(Array.isArray(resource.columns) && resource.columns.length > 0, `${key} 缺少列定义`);
      for (const field of resource.fields) {
        assert.ok(field.key, `${key} 有字段缺少 key`);
        assert.ok(field.label, `${key}.${field.key} 缺少 label`);
      }
    }
  });
});
