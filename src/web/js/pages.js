/**
 * 页面渲染器。
 *
 * 只有四类页面：
 *   - 通用主数据页（由 resources.js 描述驱动）
 *   - 通用报表页  （由 reports.js 描述驱动）
 *   - 出入库办理
 *   - 销售单录入
 * 需求书里的几十个界面因此不需要几十份互相重复的代码。
 */

import { api } from './api.js';
import { h, clear, card, table, buildFields, readFields, modal, toast, confirmDialog, showError } from './ui.js';
import { money, qty, date, currentMonthRange, today } from './fmt.js';
import { RESOURCES, LOOKUPS } from './resources.js';
import { REPORTS } from './reports.js';
import { renderMarkdown } from './markdown.js';

/* ---------------- 下拉数据源 ---------------- */

const lookupCache = new Map();

export function clearLookupCache() { lookupCache.clear(); }

async function loadLookup(name) {
  const config = LOOKUPS[name];
  if (!config) return [];
  if (config.cache && lookupCache.has(name)) return lookupCache.get(name);

  const rows = await api.get(config.path);
  const items = (Array.isArray(rows) ? rows : rows?.rows ?? []).map((row) => ({
    value: row.id,
    label: config.label(row),
    raw: row,
  }));
  if (config.cache) lookupCache.set(name, items);
  return items;
}

/**
 * 用异步取回的候选数据填充 lookup / multilookup 下拉框。
 *
 * 编辑已有记录时，如果原值已不在候选列表里（例如品种被停用），
 * 仍然要把它补成一个选项——否则用户一保存就会把这个字段静默清空，
 * 而界面上完全看不出发生了什么。
 */
async function enhanceLookups(fields, inputs) {
  for (const field of fields) {
    if (field.type !== 'lookup' && field.type !== 'multilookup') continue;

    const select = inputs[field.key];
    if (!select) continue;

    let items = [];
    try {
      items = await loadLookup(field.lookup);
    } catch {
      items = []; // 候选数据取不到时退化为空列表，不应让整页崩掉
    }

    const isMulti = field.type === 'multilookup';
    const initial = String(select.dataset.initial ?? '');
    const selected = new Set(
      (isMulti ? initial.split(',') : [initial]).map((v) => v.trim()).filter(Boolean),
    );
    const has = (value) => selected.has(String(value));

    clear(select);
    if (!isMulti) {
      select.append(h('option', { value: '' }, field.placeholder ?? '请选择'));
    }

    for (const item of items) {
      select.append(h('option', { value: item.value, selected: has(item.value) }, item.label));
    }

    if (!isMulti && initial && !items.some((i) => String(i.value) === initial)) {
      select.append(h('option', { value: initial, selected: true }, `（原值 #${initial}）`));
    }
    if (isMulti) {
      select.size = Math.min(6, Math.max(3, select.options.length));
    }
  }
}

function readFormValues(fields, inputs) {
  const values = readFields(fields, inputs);
  for (const field of fields) {
    if (field.type === 'multilookup') {
      const el = inputs[field.key];
      values[field.key] = el
        ? Array.from(el.selectedOptions).map((o) => Number(o.value))
        : [];
    }
  }
  return values;
}

/**
 * 组装「新增」的提交体。
 *
 * 有些资源是**按类别分页**的：在营品种与待营品种共用同一个 `/varieties` 接口，
 * 靠 `kind` 区分，而 `kind` 由页面决定、**不在表单里**。这类页面上下文参数记在
 * `resource.listParams` 上，新增时必须一并提交，否则后端收不到 `kind` ——
 * 表现就是用户把该填的都填了，仍被拦下并提示「品种类别不能为空」。
 *
 * 同名时以表单值为准（用户填的优先于页面上下文）。
 */
export function buildCreatePayload(resource, values) {
  return { ...(resource.listParams ?? {}), ...values };
}

/* ---------------- 通用主数据页 ---------------- */

export function makeEntityPage(resourceKey) {
  const resource = RESOURCES[resourceKey];
  if (!resource) return () => h('div', { class: 'empty' }, `未知页面：${resourceKey}`);

  return async function render(container) {
    clear(container);
    const tableHost = h('div', {});
    const keywordInput = h('input', { type: 'text', placeholder: '输入关键字搜索…', style: { width: '220px' } });

    const openForm = (row = null) => {
      const initial = row ? mapRowToForm(resource.fields, row) : {};
      const form = buildFields(resource.fields, initial);

      // lookup 字段在渲染后异步填充选项
      modal({
        title: row ? `编辑${resource.title}` : `新增${resource.title}`,
        body: form.element,
        onSubmit: async () => {
          const values = readFormValues(resource.fields, form.inputs);
          if (row) await api.put(`${resource.path}/${row.id}`, values);
          else await api.post(resource.path, buildCreatePayload(resource, values));
          toast(row ? '已保存' : '已新增');
          clearLookupCache();
          await reload();
        },
      });

      // 回填下拉选中值需要等选项加载完
      for (const field of resource.fields) {
        if (field.type === 'lookup' || field.type === 'multilookup') {
          form.inputs[field.key].dataset.initial = initial[field.key] ?? '';
        }
      }
      enhanceLookups(resource.fields, form.inputs);
    };

    async function reload() {
      const params = { ...(resource.listParams ?? {}) };
      if (keywordInput.value.trim()) params.keyword = keywordInput.value.trim();
      await withTable(tableHost, resource, params, openForm);
    }

    container.append(
      card(resource.title,
        tableHost,
        h('button', { class: 'btn btn-primary', onclick: () => openForm(null) }, '+ 新增')),
      h('div', { class: 'card' },
        h('div', { class: 'toolbar' },
          keywordInput,
          h('button', { class: 'btn', onclick: reload }, '查询'))),
    );

    keywordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') reload(); });
    await reload();
  };
}

/** 把接口返回的行映射回表单初始值（分 → 元）。 */
function mapRowToForm(fields, row) {
  const out = {};
  for (const field of fields) {
    if (field.key.endsWith('VarietyIds')) {
      out[field.key] = (row[field.key === 'agentVarietyIds' ? 'agentVarieties' : 'pilotVarieties'] ?? [])
        .map((v) => v.id).join(',');
    } else if (field.type === 'money' && row[`${field.key}Cents`] !== undefined) {
      out[field.key] = (row[`${field.key}Cents`] / 100).toFixed(2);
    } else {
      out[field.key] = row[field.key] ?? '';
    }
  }
  return out;
}

async function withTable(host, resource, params, openForm) {
  clear(host);
  host.append(h('div', { class: 'empty' }, '加载中…'));
  try {
    const data = await api.get(resource.path, params);
    const rows = Array.isArray(data) ? data : (data.rows ?? []);

    const columns = [...resource.columns];
    columns.push({
      key: '_actions',
      title: '操作',
      format: (_v, row) => h('span', {},
        h('button', { class: 'btn btn-sm', onclick: () => openForm(row) }, '编辑'),
        resource.rowActions?.map((action) => h('button', {
          class: 'btn btn-sm',
          style: { marginLeft: '6px' },
          onclick: async () => {
            try {
              await action.run(row, {});
              toast(`${action.label}成功`);
              clearLookupCache();
              await withTable(host, resource, params, openForm);
            } catch (err) { showError(err); }
          },
        }, action.label))),
    });

    clear(host);
    host.append(table(columns, rows));
  } catch (err) {
    clear(host);
    host.append(h('div', { class: 'empty' }, `加载失败：${err.message}`));
  }
}

/* ---------------- 通用报表页 ---------------- */

export function makeReportPage(reportKey) {
  const report = REPORTS[reportKey];
  if (!report) return () => h('div', { class: 'empty' }, `未知报表：${reportKey}`);

  return async function render(container) {
    clear(container);

    // 初始筛选条件：默认取本月，但允许用 hash 里的查询串覆盖，
    // 例如 #/report:sales.summary?from=2026-10-01&to=2026-10-31。
    // 这样报表链接可以直接发给同事，也让文档截图不依赖运行机器的系统时间。
    const defaults = currentMonthRange();
    const fromUrl = new URLSearchParams(location.hash.split('?')[1] ?? '');
    const initialValues = {};
    for (const param of report.params) {
      const override = fromUrl.get(param.key);
      if (override) initialValues[param.key] = override;
      else if (param.type === 'date') initialValues[param.key] = defaults[param.key] ?? today();
    }

    const form = buildFields(report.params, initialValues);
    const resultHost = h('div', {});

    const runQuery = async () => {
      const values = readFormValues(report.params, form.inputs);
      const params = { ...(report.fixedParams ?? {}), ...values };
      for (const param of report.params) {
        if (param.required && !params[param.key]) {
          showError(new Error(`请先选择${param.label}`));
          return;
        }
      }

      clear(resultHost);
      resultHost.append(h('div', { class: 'empty' }, '查询中…'));
      try {
        const data = await api.get(report.path, params);
        clear(resultHost);

        if (report.stats) {
          // 拆成两步写，避免层层嵌套的括号里藏错
          const statCards = report.stats(data).map((s) => h('div', { class: 'stat' },
            h('div', { class: 'stat-label' }, s.label),
            h('div', { class: `stat-value ${s.negative ? 'num-neg' : ''}` }, s.value)));
          resultHost.append(h('div', { class: 'stat-row' }, statCards));
        }

        const rows = (data.rows ?? []).map((row, index) => ({ ...row, _index: index + 1 }));
        const columns = reportKey === 'inventory.stock' || reportKey === 'finance.balance'
          ? report.columns
          : [{ key: '_index', title: '#', align: 'right' }, ...report.columns];

        resultHost.append(table(columns, rows, {
          totals: data.totals ?? null,
          emptyText: '该时间段内没有符合条件的数据',
        }));
      } catch (err) {
        clear(resultHost);
        resultHost.append(h('div', { class: 'empty' }, `查询失败：${err.message}`));
      }
    };

    container.append(
      h('section', { class: 'card' },
        h('div', { class: 'card-head' },
          h('h3', { class: 'card-title' }, report.title),
          h('span', { class: 'muted' }, report.spec ?? '')),
        h('div', { class: 'toolbar' },
          form.element,
          h('button', { class: 'btn btn-primary', onclick: runQuery }, '查询')),
        report.description ? h('div', { class: 'card-body muted' }, report.description) : null),
      resultHost,
    );

    enhanceLookups(report.params, form.inputs);
    await runQuery();
  };
}

/* ---------------- 出入库办理 ---------------- */

export function renderInventoryIo() {
  return async function render(container) {
    clear(container);

    const varieties = await loadLookup('varieties');
    const dealers = await loadLookup('dealers');

    const fields = [
      {
        key: 'direction', label: '业务类型', type: 'select', required: true,
        options: [{ value: 'in', label: '入库' }, { value: 'out', label: '出库' }],
      },
      {
        key: 'varietyId', label: '品种', type: 'select', required: true,
        options: varieties.map((v) => ({ value: v.value, label: v.label })),
      },
      {
        key: 'dealerId', label: '经销商', type: 'select',
        options: dealers.map((d) => ({ value: d.value, label: d.label })),
      },
      { key: 'quantity', label: '数量', type: 'number', required: true },
      { key: 'unit', label: '单位', type: 'text', placeholder: '袋' },
      { key: 'occurredAt', label: '业务时间', type: 'date' },
      { key: 'remark', label: '备注', type: 'textarea', wide: true },
    ];

    const form = buildFields(fields, { occurredAt: today(), unit: '袋' });
    const stockHost = h('div', {});

    const refreshStock = async () => {
      const varietyId = form.inputs.varietyId.value;
      clear(stockHost);
      if (!varietyId) return;
      try {
        const stock = await api.get('/inventory/stock', { varietyId });
        stockHost.append(
          h('div', { class: 'stat-row' },
            h('div', { class: 'stat' },
              h('div', { class: 'stat-label' }, `当前库存 · ${stock.varietyName}`),
              h('div', { class: 'stat-value' }, qty(stock.quantity))),
            h('div', { class: 'stat' },
              h('div', { class: 'stat-label' }, '累计入库'),
              h('div', { class: 'stat-value' }, qty(stock.totalIn))),
            h('div', { class: 'stat' },
              h('div', { class: 'stat-label' }, '累计出库'),
              h('div', { class: 'stat-value' }, qty(stock.totalOut)))),
          h('p', { class: 'muted' }, '实时库存 = 累计入库 − 累计出库，随每次出入库自动更新。'),
        );
      } catch (err) {
        stockHost.append(h('div', { class: 'empty' }, err.message));
      }
    };

    form.inputs.varietyId.addEventListener('change', refreshStock);

    const submit = async () => {
      try {
        const values = readFormValues(fields, form.inputs);
        await api.post('/inventory/movements', values);
        toast('出入库已登记');
        form.inputs.quantity.value = '';
        form.inputs.remark.value = '';
        await refreshStock();
        await refreshRecent();
      } catch (err) { showError(err); }
    };

    const recentHost = h('div', {});
    const refreshRecent = async () => {
      clear(recentHost);
      try {
        const rows = await api.get('/inventory/movements', {});
        recentHost.append(table([
          { key: 'occurredAt', title: '时间' },
          { key: 'directionLabel', title: '类型' },
          { key: 'varietyName', title: '品种' },
          { key: 'dealerName', title: '经销商' },
          { key: 'quantity', title: '数量', align: 'right', format: qty },
          { key: 'remark', title: '备注' },
        ], rows.slice(0, 15), { emptyText: '暂无出入库记录' }));
      } catch (err) {
        recentHost.append(h('div', { class: 'empty' }, err.message));
      }
    };

    container.append(
      stockHost,
      card('出入库办理',
        h('div', {}, form.element,
          h('button', { class: 'btn btn-primary', onclick: submit }, '登记')),
        null),
      card('最近出入库记录', recentHost),
    );

    await refreshStock();
    await refreshRecent();
  };
}

/* ---------------- 销售单录入 ---------------- */

export function renderSalesOrder() {
  return async function render(container) {
    clear(container);

    const varieties = await loadLookup('varieties');
    const dealers = await loadLookup('dealers');

    const varietyById = new Map(varieties.map((v) => [String(v.value), v.raw]));
    const lines = [];

    const dealerSelect = h('select', { name: 'dealerId' },
      h('option', { value: '' }, '请选择经销商'),
      dealers.map((d) => h('option', { value: d.value }, d.label)));

    const orderNoInput = h('input', { type: 'text', placeholder: '留空则自动生成' });
    const orderDateInput = h('input', { type: 'date', value: today() });
    const remarkInput = h('textarea', { placeholder: '备注' });

    const linesHost = h('tbody', {});
    const totalHost = h('tfoot', {});

    const recalc = () => {
      let amount = 0;
      let rebate = 0;
      for (const line of lines) {
        const row = linesHost.querySelector(`tr[data-line="${line.id}"]`);
        if (!row) continue;
        const qtyValue = Number(row.querySelector('[data-f="quantity"]').value) || 0;
        const priceValue = Number(row.querySelector('[data-f="unitPrice"]').value) || 0;
        const rebateValue = Number(row.querySelector('[data-f="rebate"]').value) || 0;
        line.quantity = qtyValue;
        line.unitPrice = priceValue;
        line.rebate = rebateValue;
        amount += Math.round(qtyValue * priceValue * 100);
        rebate += Math.round(rebateValue * 100);
        row.querySelector('[data-f="amount"]').textContent = money(Math.round(qtyValue * priceValue * 100));
      }
      clear(totalHost);
      totalHost.append(h('tr', {},
        h('td', { colspan: 3 }, '合计'),
        h('td', { class: 'num' }, qty(lines.reduce((s, l) => s + (l.quantity || 0), 0))),
        h('td', { class: 'num' }, money(amount)),
        h('td', { class: 'num' }, money(rebate)),
        h('td', {})));
    };

    const addLine = () => {
      const line = { id: `${Date.now()}-${lines.length}`, varietyId: '', quantity: 1, unitPrice: 0, rebate: 0 };
      lines.push(line);

      const varietySelect = h('select', {
        'data-f': 'varietyId',
        onchange: (e) => {
          line.varietyId = e.target.value;
          const variety = varietyById.get(e.target.value);
          // 单价默认取品种档案上的单价，可再手工调整
          if (variety?.unitPriceCents != null) {
            const input = e.target.closest('tr').querySelector('[data-f="unitPrice"]');
            input.value = (variety.unitPriceCents / 100).toFixed(2);
          }
          recalc();
        },
      }, h('option', { value: '' }, '请选择品种'),
        varieties.map((v) => h('option', { value: v.value }, v.label)));

      const row = h('tr', { 'data-line': line.id },
        h('td', {}, varietySelect),
        h('td', {}, h('input', { 'data-f': 'quantity', type: 'number', value: 1, min: 1, oninput: recalc })),
        h('td', {}, h('input', { 'data-f': 'unitPrice', type: 'text', value: '0.00', oninput: recalc })),
        h('td', { class: 'num', 'data-f': 'amount' }, '0.00'),
        h('td', {}, h('input', { 'data-f': 'rebate', type: 'text', value: '0.00', oninput: recalc })),
        h('td', {}, h('button', {
          class: 'btn btn-sm btn-danger',
          onclick: () => { lines.splice(lines.indexOf(line), 1); row.remove(); recalc(); },
        }, '删除')));

      linesHost.append(row);
      recalc();
    };

    const submit = async () => {
      try {
        const items = lines
          .filter((l) => l.varietyId && l.quantity > 0)
          .map((l) => ({
            varietyId: Number(l.varietyId),
            quantity: Number(l.quantity),
            unitPrice: String(l.unitPrice ?? '0'),
            rebate: String(l.rebate ?? '0'),
          }));

        if (items.length === 0) throw new Error('请至少录入一条有效的销售明细');

        await api.post('/sales/orders', {
          orderNo: orderNoInput.value.trim() || null,
          dealerId: dealerSelect.value,
          orderDate: orderDateInput.value,
          remark: remarkInput.value.trim() || null,
          items,
        });

        toast('销售单已保存，库存已同步扣减');
        clearLookupCache();
        const orders = await api.get('/sales/orders', {});
        recentHost.replaceChildren(table([
          { key: 'orderNo', title: '销售单号' },
          { key: 'orderDate', title: '日期', format: date },
          { key: 'dealerName', title: '经销商' },
          { key: 'totalAmountCents', title: '金额', align: 'right', format: money },
          { key: 'totalRebateCents', title: '返利', align: 'right', format: money },
          { key: 'statusLabel', title: '状态' },
        ], orders.slice(0, 15)));
        lines.length = 0;
        clear(linesHost);
        clear(totalHost);
      } catch (err) { showError(err); }
    };

    const recentHost = h('div', {});

    container.append(
      card('销售单录入',
        h('div', {},
          h('div', { class: 'form-grid' },
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, '经销商', h('span', { class: 'req' }, '*')), dealerSelect),
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, '销售日期', h('span', { class: 'req' }, '*')), orderDateInput),
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, '销售单号'), orderNoInput),
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, '备注'), remarkInput)),
          h('div', { class: 'table-wrap' },
            h('table', {},
              h('thead', {}, h('tr', {},
                h('th', {}, '品种（取自库存管理）'),
                h('th', {}, '销售数量'),
                h('th', {}, '销售单价（元）'),
                h('th', {}, '销售金额'),
                h('th', {}, '返利金额（元）'),
                h('th', {}, '操作'))),
              linesHost,
              totalHost)),
          h('div', { class: 'mt-16' },
            h('button', { class: 'btn', onclick: addLine }, '+ 添加明细'),
            ' ',
            h('button', { class: 'btn btn-primary', onclick: submit }, '保存销售单'))),
        null),
      card('最近销售单', recentHost),
    );

    addLine();

    try {
      const orders = await api.get('/sales/orders', {});
      recentHost.append(table([
        { key: 'orderNo', title: '销售单号' },
        { key: 'orderDate', title: '日期', format: date },
        { key: 'dealerName', title: '经销商' },
        { key: 'totalAmountCents', title: '金额', align: 'right', format: money },
        { key: 'totalRebateCents', title: '返利', align: 'right', format: money },
        { key: 'statusLabel', title: '状态' },
      ], orders.slice(0, 15), { emptyText: '暂无销售单' }));
    } catch (err) {
      recentHost.append(h('div', { class: 'empty' }, err.message));
    }
  };
}

/* ---------------- 帮助（使用说明 / 版本更新） ---------------- */

/**
 * 文档里的图片写的是相对路径 images/xxx.png，而文档是在 /docs/ 下提供的，
 * 链接同理。这里统一补成绝对路径，否则在 SPA 里会以当前页面为基准而 404。
 */
function absolutizeDocLinks(html) {
  return html
    .replace(/src="(?!https?:|\/)/g, 'src="/docs/')
    .replace(/href="(?!https?:|\/|#)([^"]+\.md)"/g, 'href="/docs/$1"');
}

export function renderHelp() {
  const SOURCES = [
    { title: '使用说明', url: `/docs/${encodeURIComponent('使用说明.md')}` },
    { title: '版本更新', url: '/CHANGELOG.md' },
  ];

  return async function render(container) {
    clear(container);

    const tabBar = h('div', { class: 'tabs' });
    const pane = h('div', { class: 'card help-body' });
    let active = 0;

    const load = async (index) => {
      active = index;
      for (const [i, btn] of [...tabBar.children].entries()) {
        btn.classList.toggle('active', i === index);
      }
      clear(pane);
      pane.append(h('div', { class: 'empty' }, '加载中…'));
      try {
        const res = await fetch(SOURCES[index].url, { headers: { Accept: 'text/markdown' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const markdown = await res.text();
        clear(pane);
        // 渲染结果由本项目的 markdown 模块产生，其中所有来自文档的文本都已转义
        pane.innerHTML = absolutizeDocLinks(renderMarkdown(markdown));
      } catch (err) {
        clear(pane);
        pane.append(h('div', { class: 'empty' },
          `文档加载失败：${err.message}。请确认程序目录下的 docs/ 与 CHANGELOG.md 未被删除。`));
      }
    };

    for (const [i, source] of SOURCES.entries()) {
      tabBar.append(h('button', {
        class: 'tab', type: 'button', onclick: () => load(i),
      }, source.title));
    }

    container.append(tabBar, pane);
    await load(active);
  };
}

/* ---------------- 首页 ---------------- */

export function renderDashboard(session) {
  return async function render(container) {
    clear(container);

    const scopeHint = session.scopeKind === 'all' ? '全部数据'
      : (session.scopeKind === 'none' ? '无可查看范围' : '管辖范围内数据');

    container.append(
      h('div', { class: 'stat-row' },
        h('div', { class: 'stat' },
          h('div', { class: 'stat-label' }, '当前用户'),
          h('div', { class: 'stat-value', style: { fontSize: '17px' } }, session.user.name)),
        h('div', { class: 'stat' },
          h('div', { class: 'stat-label' }, '工号 / 职级'),
          h('div', { class: 'stat-value', style: { fontSize: '17px' } },
            `${session.user.empNo} · ${session.user.level}`)),
        h('div', { class: 'stat' },
          h('div', { class: 'stat-label' }, '数据可见范围'),
          h('div', { class: 'stat-value', style: { fontSize: '17px' } }, scopeHint))));

    const balanceHost = h('div', {});
    const stockHost = h('div', {});

    container.append(
      card('账户余额', balanceHost),
      card('实时库存（前 10 个品种）', stockHost),
    );

    try {
      const balance = await api.get('/reports/finance.balance');
      balanceHost.append(
        h('div', { class: 'stat-row' },
          h('div', { class: 'stat' },
            h('div', { class: 'stat-label' }, '账户余额合计'),
            h('div', { class: `stat-value ${balance.totalBalanceCents < 0 ? 'num-neg' : ''}` },
              money(balance.totalBalanceCents)))),
        table([
          { key: 'name', title: '账户' },
          { key: 'incomeCents', title: '累计收入', align: 'right', format: money },
          { key: 'expenseCents', title: '累计支出', align: 'right', format: money },
          { key: 'balanceCents', title: '当前余额', align: 'right', format: money },
        ], balance.rows ?? []));
    } catch (err) {
      balanceHost.append(h('div', { class: 'empty' }, err.message));
    }

    try {
      const stock = await api.get('/reports/inventory.stock');
      stockHost.append(table([
        { key: 'code', title: '品种编码' },
        { key: 'name', title: '品种名称' },
        { key: 'kindLabel', title: '类别' },
        { key: 'quantity', title: '当前库存', align: 'right', format: qty },
      ], (stock.rows ?? []).slice(0, 10), { emptyText: '尚未录入品种' }));
    } catch (err) {
      stockHost.append(h('div', { class: 'empty' }, err.message));
    }
  };
}

export { confirmDialog, modal, toast, showError };

/**
 * 仅供测试使用：暴露内部函数，便于在 Node + DOM 桩下直接断言。
 * 生产代码不应引用这里面的任何东西。
 */
export const __test__ = { enhanceLookups, loadLookup, withTable, mapRowToForm };
