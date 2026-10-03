import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../../src/web/js/markdown.js';

/**
 * 帮助页面直接渲染 docs/使用说明.md，因此需要一个够用的 Markdown 渲染器。
 *
 * ★ 安全性是这个模块的第一要务：它产出的字符串会被 innerHTML 插入页面，
 *   所以任何来自文档的文本都必须先转义，只保留渲染器自己生成的标签。
 *   下面的「转义」一节就是钉死这条约定的。
 */
describe('markdown — 帮助文档渲染', () => {
  describe('标题', () => {
    test('各级标题', () => {
      assert.equal(renderMarkdown('# 一级'), '<h1>一级</h1>');
      assert.equal(renderMarkdown('## 二级'), '<h2>二级</h2>');
      assert.equal(renderMarkdown('### 三级'), '<h3>三级</h3>');
      assert.equal(renderMarkdown('#### 四级'), '<h4>四级</h4>');
    });
  });

  describe('段落', () => {
    test('连续文本合成一个段落', () => {
      assert.equal(renderMarkdown('第一行\n第二行'), '<p>第一行 第二行</p>');
    });

    test('空行分隔出多个段落', () => {
      assert.equal(renderMarkdown('甲\n\n乙'), '<p>甲</p>\n<p>乙</p>');
    });
  });

  describe('行内格式', () => {
    test('加粗', () => {
      assert.equal(renderMarkdown('这是**重点**内容'), '<p>这是<strong>重点</strong>内容</p>');
    });

    test('行内代码', () => {
      assert.equal(renderMarkdown('执行 `npm test` 即可'), '<p>执行 <code>npm test</code> 即可</p>');
    });

    test('链接', () => {
      assert.equal(
        renderMarkdown('见[设计说明](设计说明.md)'),
        '<p>见<a href="设计说明.md">设计说明</a></p>',
      );
    });

    test('图片', () => {
      assert.equal(
        renderMarkdown('![登录页面](images/01-登录.png)'),
        '<p><img src="images/01-登录.png" alt="登录页面"></p>',
      );
    });

    test('行内代码内的星号不被当作加粗', () => {
      assert.equal(renderMarkdown('`a**b**c`'), '<p><code>a**b**c</code></p>');
    });
  });

  describe('列表', () => {
    test('无序列表', () => {
      assert.equal(renderMarkdown('- 甲\n- 乙'), '<ul><li>甲</li><li>乙</li></ul>');
    });

    test('有序列表', () => {
      assert.equal(renderMarkdown('1. 甲\n2. 乙'), '<ol><li>甲</li><li>乙</li></ol>');
    });

    test('列表项内的行内格式仍然生效', () => {
      assert.equal(renderMarkdown('- **甲**'), '<ul><li><strong>甲</strong></li></ul>');
    });

    test('嵌套列表', () => {
      assert.equal(
        renderMarkdown('- 甲\n  - 甲一\n- 乙'),
        '<ul><li>甲<ul><li>甲一</li></ul></li><li>乙</li></ul>',
      );
    });

    test('列表后接段落会正确断开', () => {
      assert.equal(renderMarkdown('- 甲\n\n正文'), '<ul><li>甲</li></ul>\n<p>正文</p>');
    });
  });

  describe('引用块', () => {
    test('单行引用', () => {
      assert.equal(renderMarkdown('> 注意'), '<blockquote><p>注意</p></blockquote>');
    });

    test('多行引用合成一个块', () => {
      assert.equal(
        renderMarkdown('> 第一行\n> 第二行'),
        '<blockquote><p>第一行 第二行</p></blockquote>',
      );
    });
  });

  describe('表格', () => {
    test('表头与表体', () => {
      const md = '| 职级 | 含义 |\n| --- | --- |\n| L1 | 高管 |\n| L2 | 经理 |';
      assert.equal(
        renderMarkdown(md),
        '<table><thead><tr><th>职级</th><th>含义</th></tr></thead>'
        + '<tbody><tr><td>L1</td><td>高管</td></tr><tr><td>L2</td><td>经理</td></tr></tbody></table>',
      );
    });

    test('单元格内的行内格式生效', () => {
      const md = '| a |\n| --- |\n| **粗** |';
      assert.equal(
        renderMarkdown(md),
        '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td><strong>粗</strong></td></tr></tbody></table>',
      );
    });

    test('缩进的表格也能识别（列表项内嵌表格）', () => {
      const md = '  | a |\n  | --- |\n  | 1 |';
      assert.match(renderMarkdown(md), /<table>/);
    });
  });

  describe('代码块', () => {
    test('围栏代码块', () => {
      assert.equal(
        renderMarkdown('```js\nconst a = 1;\n```'),
        '<pre><code class="language-js">const a = 1;</code></pre>',
      );
    });

    test('无语言标记的代码块', () => {
      assert.equal(renderMarkdown('```\n纯文本\n```'), '<pre><code>纯文本</code></pre>');
    });

    test('代码块内的 Markdown 语法不被解析', () => {
      assert.equal(renderMarkdown('```\n**不是加粗**\n```'), '<pre><code>**不是加粗**</code></pre>');
    });
  });

  describe('分隔线', () => {
    test('三个短横线', () => {
      assert.equal(renderMarkdown('---'), '<hr>');
    });
  });

  describe('★ 转义 —— 渲染结果会被 innerHTML 插入页面', () => {
    test('正文里的 HTML 被转义而不是执行', () => {
      const html = renderMarkdown('<script>alert(1)</script>');
      assert.doesNotMatch(html, /<script>/);
      assert.match(html, /&lt;script&gt;/);
    });

    test('行内代码里的尖括号被转义', () => {
      assert.equal(renderMarkdown('`<b>`'), '<p><code>&lt;b&gt;</code></p>');
    });

    test('代码块里的尖括号被转义', () => {
      assert.equal(renderMarkdown('```\n<img onerror=x>\n```'), '<pre><code>&lt;img onerror=x&gt;</code></pre>');
    });

    test('表格单元格里的 HTML 被转义', () => {
      const md = '| a |\n| --- |\n| <img src=x onerror=alert(1)> |';
      const html = renderMarkdown(md);
      assert.doesNotMatch(html, /<img src=x/);
      assert.match(html, /&lt;img/);
    });

    test('图片地址里的引号被转义，无法闭合属性', () => {
      const html = renderMarkdown('![a](" onerror="alert(1))');
      assert.doesNotMatch(html, /onerror="alert\(1\)"/);
    });

    test('链接地址里的引号被转义', () => {
      const html = renderMarkdown('[t](" onmouseover="alert(1))');
      assert.doesNotMatch(html, /onmouseover="alert\(1\)"/);
    });

    test('与号与引号也被转义', () => {
      assert.equal(renderMarkdown('a & b'), '<p>a &amp; b</p>');
    });
  });

  describe('真实文档', () => {
    test('能渲染 docs/使用说明.md 且不残留未替换的标记', async () => {
      const { readFileSync } = await import('node:fs');
      const { join, dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

      const md = readFileSync(join(root, 'docs', '使用说明.md'), 'utf8');
      const html = renderMarkdown(md);

      assert.match(html, /<h1>/, '应渲染出一级标题');
      assert.match(html, /<table>/, '使用说明里有表格');
      assert.match(html, /<img /, '使用说明里有截图');
      assert.doesNotMatch(html, /\*\*/, '不应残留未解析的加粗标记');
      assert.doesNotMatch(html, /^#/m, '不应残留未解析的标题标记');
    });

    test('能渲染 CHANGELOG.md', async () => {
      const { readFileSync } = await import('node:fs');
      const { join, dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

      const md = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
      const html = renderMarkdown(md);
      assert.match(html, /<h2>/, 'CHANGELOG 应含版本小节');
      assert.match(html, /<ul>/, 'CHANGELOG 应含条目列表');
    });
  });
});
