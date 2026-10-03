/**
 * 极简 Markdown 渲染器，供「使用说明」帮助页面使用。
 *
 * 存在的理由：使用说明只有 docs/使用说明.md 这一份。帮助页面直接渲染它，
 * 就不会出现「文档更新了、页面里还是旧的」这种两处说法不一致的情况。
 * 也正因如此没有引入第三方 Markdown 库——为一份文档加一个依赖不划算。
 *
 * ★ 安全约定：本模块产出的字符串会被 innerHTML 插入页面，
 *   所以**任何来自文档的文本都必须先转义**，只保留本模块自己生成的标签。
 *   渲染流程始终是「先整行转义，再做行内替换」，绝不用原始文本拼接 HTML。
 */

/** 转义 HTML 特殊字符。所有进入输出的文本都要先过这一步。 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 行内格式：`代码`、图片、链接、**加粗**。
 *
 * 代码段先抽成占位符再处理其它规则，否则 `a**b**c` 里的星号会被误当作加粗。
 * 占位符用 \u0000 包裹，这个字符不可能出现在正常文本里。
 */
function inline(escapedText) {
  const codes = [];
  let text = String(escapedText).replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  text = text
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (_m, alt, src) => `<img src="${src}" alt="${alt}">`)
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_m, label, href) => `<a href="${href}">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, (_m, content) => `<strong>${content}</strong>`);

  return text.replace(/\u0000(\d+)\u0000/g, (_m, index) => `<code>${codes[Number(index)]}</code>`);
}

const RE_HEADING = /^(#{1,6})\s+(.*)$/;
const RE_HR = /^\s*-{3,}\s*$/;
const RE_FENCE = /^\s*```\s*([A-Za-z0-9_+-]*)\s*$/;
const RE_QUOTE = /^\s*>\s?(.*)$/;
const RE_LIST_ITEM = /^(\s*)(?:([-*])|(\d+)\.)\s+(.*)$/;
const RE_TABLE_ROW = /^\s*\|.*\|\s*$/;
const RE_TABLE_SEP = /^\s*\|[\s:|-]+\|\s*$/;

/** 按缩进把扁平的列表项还原成嵌套结构。 */
function buildList(items, start, indent) {
  const ordered = Boolean(items[start].ordered);
  const tag = ordered ? 'ol' : 'ul';
  let html = `<${tag}>`;
  let pos = start;

  while (pos < items.length && items[pos].indent >= indent) {
    if (items[pos].indent > indent) {
      // 比当前层更深，交给下一层处理
      const nested = buildList(items, pos, items[pos].indent);
      html += nested.html;
      pos = nested.next;
      continue;
    }

    let entry = `<li>${inline(escapeHtml(items[pos].text))}`;
    pos += 1;

    // 紧随其后、缩进更深的项，属于当前这一项的子列表
    if (pos < items.length && items[pos].indent > indent) {
      const nested = buildList(items, pos, items[pos].indent);
      entry += nested.html;
      pos = nested.next;
    }

    html += `${entry}</li>`;
  }

  return { html: `${html}</${tag}>`, next: pos };
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function renderTable(rows) {
  const header = rows[0];
  const body = rows.slice(1);
  const head = `<thead><tr>${header.map((c) => `<th>${inline(escapeHtml(c))}</th>`).join('')}</tr></thead>`;
  const rowsHtml = body
    .map((cells) => `<tr>${cells.map((c) => `<td>${inline(escapeHtml(c))}</td>`).join('')}</tr>`)
    .join('');
  return `<table>${head}<tbody>${rowsHtml}</tbody></table>`;
}

/**
 * 把 Markdown 渲染为 HTML 字符串。
 * 仅覆盖使用说明与更新日志用到的语法；遇到不认识的写法按普通段落处理。
 */
export function renderMarkdown(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') { i += 1; continue; }

    // 围栏代码块
    const fence = RE_FENCE.exec(line);
    if (fence) {
      const lang = fence[1];
      const body = [];
      i += 1;
      while (i < lines.length && !RE_FENCE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过结束围栏
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      blocks.push(`<pre><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = RE_HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${inline(escapeHtml(heading[2].trim()))}</h${level}>`);
      i += 1;
      continue;
    }

    if (RE_HR.test(line)) {
      blocks.push('<hr>');
      i += 1;
      continue;
    }

    // 表格：当前行是表格行，且下一行是分隔行
    if (RE_TABLE_ROW.test(line) && RE_TABLE_SEP.test(lines[i + 1] ?? '')) {
      const rows = [];
      i += 1; // 先跳过表头
      i += 1; // 再跳过分隔行
      while (i < lines.length && RE_TABLE_ROW.test(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      blocks.push(renderTable([splitTableRow(line), ...rows]));
      continue;
    }

    if (RE_QUOTE.test(line)) {
      const parts = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        parts.push(RE_QUOTE.exec(lines[i])[1].trim());
        i += 1;
      }
      blocks.push(`<blockquote><p>${inline(escapeHtml(parts.join(' ')))}</p></blockquote>`);
      continue;
    }

    if (RE_LIST_ITEM.test(line)) {
      const items = [];
      while (i < lines.length) {
        const m = RE_LIST_ITEM.exec(lines[i]);
        if (!m) break;
        items.push({ indent: m[1].length, ordered: Boolean(m[3]), text: m[4] });
        i += 1;
      }
      blocks.push(buildList(items, 0, items[0].indent).html);
      continue;
    }

    // 普通段落：收集到空行或下一个块级元素为止
    const paragraph = [];
    while (i < lines.length && lines[i].trim() !== ''
      && !RE_HEADING.test(lines[i]) && !RE_HR.test(lines[i])
      && !RE_FENCE.test(lines[i]) && !RE_QUOTE.test(lines[i])
      && !RE_LIST_ITEM.test(lines[i]) && !RE_TABLE_ROW.test(lines[i])) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    if (paragraph.length > 0) {
      blocks.push(`<p>${inline(escapeHtml(paragraph.join(' ')))}</p>`);
    } else {
      i += 1; // 兜底，避免不认识的写法导致死循环
    }
  }

  return blocks.join('\n');
}
