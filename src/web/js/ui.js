/**
 * 界面基础组件：DOM 构造、表格、表单、弹窗、提示。
 *
 * ★ 一律使用 textContent 写入文本，绝不拼接 innerHTML。
 *   本系统里「品种特点」「反馈内容」「备注」等都是自由文本，一旦用 innerHTML
 *   渲染，任何一条含 <script> 的记录都会变成存储型 XSS。
 */

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value') el.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'selected') el[key] = Boolean(value);
    else el.setAttribute(key, value === true ? '' : value);
  }

  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

export function card(title, body, actions = null) {
  return h('section', { class: 'card' },
    title ? h('div', { class: 'card-head' },
      h('h3', { class: 'card-title' }, title),
      actions ? h('div', {}, actions) : null) : null,
    h('div', { class: 'card-body' }, body));
}

/**
 * 数据表格。
 * @param {Array<{key,title,align,format,className}>} columns
 */
export function table(columns, rows, { totals = null, emptyText = '暂无数据' } = {}) {
  if (rows.length === 0) return h('div', { class: 'empty' }, emptyText);

  const cell = (column, row) => {
    const raw = column.key.includes('.')
      ? column.key.split('.').reduce((o, k) => o?.[k], row)
      : row[column.key];
    const value = column.format ? column.format(raw, row) : raw;
    return h('td', {
      class: [column.align === 'right' ? 'num' : '', column.className ?? ''].join(' ').trim(),
    }, value === null || value === undefined || value === '' ? '—' : value);
  };

  return h('div', { class: 'table-wrap' },
    h('table', {},
      h('thead', {}, h('tr', {}, columns.map((c) => h('th', {
        class: c.align === 'right' ? 'num' : '',
      }, c.title)))),
      h('tbody', {}, rows.map((row) => h('tr', {}, columns.map((c) => cell(c, row))))),
      totals ? h('tfoot', {}, h('tr', {}, columns.map((c, i) => h('td', {
        class: c.align === 'right' ? 'num' : '',
      }, i === 0 ? '合计' : (c.total ? c.total(totals, rows) : ''))))) : null));
}

/** 表单项构造。fields 为字段描述数组。 */
export function buildFields(fields, values = {}) {
  const inputs = {};
  const grid = h('div', { class: 'form-grid' });

  for (const field of fields) {
    const id = `f-${field.key}`;
    let input;

    if (field.type === 'select' || field.type === 'lookup' || field.type === 'multilookup') {
      // lookup / multilookup 也必须建成 <select>：它们的选项由 enhanceLookups
      // 异步填充。若退化成 <input>，往里 append(<option>) 不会有任何效果，
      // 多选场景读 selectedOptions 还会直接抛错。
      // 静态选项来自 field.options；lookup 类没有 options，初始为空，稍后填充。
      const isMulti = field.type === 'multilookup';
      input = h('select', { id, name: field.key },
        ...(isMulti ? [] : [h('option', { value: '' }, field.placeholder ?? '请选择')]),
        ...(field.options ?? []).map((opt) => h('option', {
          value: opt.value,
          selected: String(values[field.key] ?? '') === String(opt.value),
        }, opt.label)));
      if (isMulti) input.multiple = true;
    } else if (field.type === 'textarea') {
      input = h('textarea', { id, name: field.key, value: values[field.key] ?? '' });
    } else {
      const type = field.type === 'money' ? 'text' : (field.type ?? 'text');
      input = h('input', {
        id,
        name: field.key,
        type,
        value: values[field.key] ?? '',
        placeholder: field.placeholder ?? '',
        step: field.step ?? null,
        autocomplete: 'off',
      });
    }

    inputs[field.key] = input;
    grid.append(h('label', { class: 'field', style: field.wide ? { gridColumn: '1 / -1' } : {} },
      h('span', { class: 'field-label' },
        field.label,
        field.required ? h('span', { class: 'req' }, '*') : null),
      input,
      field.hint ? h('span', { class: 'field-label' }, field.hint) : null));
  }

  return { element: grid, inputs, read: () => readFields(fields, inputs) };
}

export function readFields(fields, inputs) {
  const out = {};
  for (const field of fields) {
    const el = inputs[field.key];
    if (!el) continue;
    let value = el.value;
    if (typeof value === 'string') value = value.trim();
    if (value === '' && !field.required) {
      // 选填字段留空表示「不修改」，创建时由后端取默认值
      out[field.key] = field.keepEmpty ? '' : null;
    } else {
      out[field.key] = value;
    }
  }
  return out;
}

/** 弹窗。onSubmit 返回 Promise，成功则关闭。 */
export function modal({ title, body, submitText = '保存', onSubmit, width = null }) {
  const root = document.getElementById('modal-root');
  const errorBox = h('p', { class: 'form-error', hidden: true });

  const close = () => { clear(root); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  const submitBtn = h('button', {
    class: 'btn btn-primary', type: 'button', onclick: async () => {
      errorBox.hidden = true;
      submitBtn.disabled = true;
      try {
        await onSubmit();
        close();
      } catch (err) {
        errorBox.textContent = err.message ?? '操作失败';
        errorBox.hidden = false;
        submitBtn.disabled = false;
      }
    },
  }, submitText);

  const dialog = h('div', { class: 'modal', style: width ? { maxWidth: width } : {} },
    h('div', { class: 'modal-head' },
      h('h3', { class: 'modal-title' }, title),
      h('button', { class: 'modal-close', type: 'button', onclick: close }, '×')),
    h('div', { class: 'modal-body' }, errorBox, body),
    h('div', { class: 'modal-foot' },
      h('button', { class: 'btn', type: 'button', onclick: close }, '取消'),
      submitBtn));

  const mask = h('div', {
    class: 'modal-mask',
    onclick: (e) => { if (e.target === mask) close(); },
  }, dialog);

  clear(root);
  root.append(mask);
  document.addEventListener('keydown', onKey);
  return { close };
}

export function confirmDialog(message, { title = '请确认', danger = false } = {}) {
  return new Promise((resolve) => {
    const close = (result) => { clear(document.getElementById('modal-root')); resolve(result); };
    const dialog = h('div', { class: 'modal', style: { maxWidth: '420px' } },
      h('div', { class: 'modal-head' }, h('h3', { class: 'modal-title' }, title)),
      h('div', { class: 'modal-body' }, h('p', { style: { margin: 0 } }, message)),
      h('div', { class: 'modal-foot' },
        h('button', { class: 'btn', type: 'button', onclick: () => close(false) }, '取消'),
        h('button', {
          class: danger ? 'btn btn-danger' : 'btn btn-primary',
          type: 'button',
          onclick: () => close(true),
        }, '确定')));
    const root = document.getElementById('modal-root');
    clear(root);
    root.append(h('div', { class: 'modal-mask' }, dialog));
  });
}

export function toast(message, kind = 'ok') {
  const root = document.getElementById('toast-root');
  const el = h('div', { class: `toast toast-${kind}` }, message);
  root.append(el);
  setTimeout(() => el.remove(), 3200);
}

export function showError(err) {
  toast(err?.message ?? '操作失败', 'error');
}

/** 加载态包装：先显示提示，加载完替换为内容。 */
export async function withLoading(container, loader) {
  clear(container);
  container.append(h('div', { class: 'empty' }, '加载中…'));
  try {
    const content = await loader();
    clear(container);
    container.append(content);
  } catch (err) {
    clear(container);
    container.append(h('div', { class: 'empty' }, `加载失败：${err.message}`));
  }
}
