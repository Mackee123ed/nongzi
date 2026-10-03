/**
 * 极简 DOM 桩，仅覆盖前端组件实际用到的那部分 API。
 *
 * 存在的理由：前端渲染逻辑（表单构造、下拉填充、表格渲染）此前完全没有测试，
 * 结果同一个文件里连续出现「括号不匹配导致白屏」和「lookup 字段被渲染成 <input>
 * 导致下拉框不可用」两个问题，都是靠人工发现。有了这个桩就能在 Node 里直接断言
 * 组件产出的是不是正确的元素。
 *
 * 刻意不实现完整 DOM —— 只实现被测代码真正调用的方法，避免桩本身成为负担。
 */

class StubNode {}

class StubText extends StubNode {
  constructor(text) {
    super();
    this.nodeType = 3;
    this._text = String(text);
    this.parentNode = null;
  }

  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
}

class StubElement extends StubNode {
  constructor(tagName) {
    super();
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this._listeners = {};
    this._value = '';

    // select 专用状态
    this.multiple = false;
    this.size = 0;
  }

  // --- 类名 ---
  get className() { return this.attributes.class ?? ''; }
  set className(v) { this.attributes.class = String(v); }

  // --- 属性 ---
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return name in this.attributes; }

  // --- 子树 ---
  get firstChild() { return this.childNodes[0] ?? null; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }

  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  append(...nodes) {
    for (const node of nodes.flat(Infinity)) {
      if (node === null || node === undefined || node === false) continue;
      this.appendChild(node instanceof StubNode ? node : new StubText(String(node)));
    }
  }

  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }

  remove() { this.parentNode?.removeChild(this); }

  replaceChildren(...nodes) {
    while (this.childNodes.length) this.removeChild(this.childNodes[0]);
    this.append(...nodes);
  }

  // --- 文本 ---
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }

  set textContent(v) {
    while (this.childNodes.length) this.removeChild(this.childNodes[0]);
    if (v !== '' && v !== null && v !== undefined) this.appendChild(new StubText(v));
  }

  // --- 表单值 ---
  get value() {
    if (this.tagName === 'SELECT') {
      const first = this.selectedOptions[0];
      return first ? first.value : '';
    }
    return this._value;
  }

  set value(v) { this._value = v === null || v === undefined ? '' : String(v); }

  get options() { return this.children.filter((c) => c.tagName === 'OPTION'); }

  get selectedOptions() {
    const picked = this.options.filter((o) => o.selected === true);
    if (picked.length > 0) return picked;
    // 未显式选中时，浏览器行为是默认选第一项
    return this.options.length > 0 ? [this.options[0]] : [];
  }

  // --- 事件与查询（仅占位，测试不依赖） ---
  addEventListener(type, handler) {
    (this._listeners[type] ??= []).push(handler);
  }

  removeEventListener() {}

  dispatch(type, event = {}) {
    for (const handler of this._listeners[type] ?? []) handler({ target: this, ...event });
  }

  querySelector() { return null; }
  closest() { return null; }
  scrollIntoView() {}

  /** 测试辅助：按标签名递归查找。 */
  findAll(predicate, out = []) {
    for (const child of this.children) {
      if (predicate(child)) out.push(child);
      child.findAll(predicate, out);
    }
    return out;
  }

  find(predicate) { return this.findAll(predicate)[0] ?? null; }
}

/** 安装全局 document / Node，供被测组件使用。 */
export function installDom() {
  const elementsById = new Map();

  const document = {
    createElement: (tag) => new StubElement(tag),
    createTextNode: (text) => new StubText(text),
    getElementById: (id) => elementsById.get(id) ?? null,
    addEventListener: () => {},
    removeEventListener: () => {},
    body: new StubElement('body'),
    /** 测试辅助：注册一个按 id 可查的元素。 */
    _register(id, el) { elementsById.set(id, el); return el; },
  };

  globalThis.document = document;
  globalThis.Node = StubNode;
  globalThis.StubElement = StubElement;

  return { document, StubElement, StubText };
}

export { StubElement, StubText };
