import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 前端资源自检。
 *
 * 这组测试的由来：曾经 pages.js 里多了一个右括号，浏览器直接白屏。
 * 而当时的接口测试只断言了 app.js / style.css 返回 HTTP 200 ——
 * 文件能取到，不等于能被浏览器解析。静态资源必须单独做一遍「可加载性」检查，
 * 否则语法错误会一路溜到用户面前才暴露。
 */

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web');
const jsDir = join(webDir, 'js');

const jsFiles = readdirSync(jsDir).filter((f) => f.endsWith('.js'));

describe('前端静态资源自检', () => {
  test('src/web/js 下有前端模块（防止目录改动后测试变成空跑）', () => {
    assert.ok(jsFiles.length >= 8, `预期至少 8 个模块，实际 ${jsFiles.length}`);
  });

  describe('语法可解析 — 白屏最常见的原因', () => {
    for (const file of jsFiles) {
      test(`${file} 无语法错误`, () => {
        // node --check 对 ESM 同样适用，能捕获括号不匹配、非法 token 等
        assert.doesNotThrow(
          () => execFileSync(process.execPath, ['--check', join(jsDir, file)], { stdio: 'pipe' }),
          `${file} 存在语法错误`,
        );
      });
    }
  });

  describe('模块可真正加载 — 覆盖语法之外的问题', () => {
    // 除 app.js 外，其余模块在顶层只做函数定义，不触碰 DOM，可直接 import。
    // import 成功即同时证明了三件事：语法正确、import 路径存在、具名导出确实存在。
    // app.js 顶层会执行 boot() 访问 document，改由下方单独做语法检查。
    const importable = jsFiles.filter((f) => f !== 'app.js');

    for (const file of importable) {
      test(`${file} 可被加载且导出完整`, async () => {
        const mod = await import(new URL(`../../src/web/js/${file}`, import.meta.url));
        assert.ok(Object.keys(mod).length > 0, `${file} 没有任何导出`);
      });
    }

    test('app.js 至少通过语法检查（顶层会访问 DOM，无法直接 import）', () => {
      assert.doesNotThrow(
        () => execFileSync(process.execPath, ['--check', join(jsDir, 'app.js')], { stdio: 'pipe' }),
      );
    });
  });

  describe('依赖关系完整', () => {
    test('所有相对 import 都指向真实存在的文件', () => {
      const missing = [];
      for (const file of jsFiles) {
        const source = readFileSync(join(jsDir, file), 'utf8');
        for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
          const target = resolve(dirname(join(jsDir, file)), match[1]);
          if (!existsSync(target)) missing.push(`${file} -> ${match[1]}`);
        }
      }
      assert.deepEqual(missing, [], `存在无法解析的 import：${missing.join('、')}`);
    });

    test('index.html 引用的资源都存在', () => {
      const html = readFileSync(join(webDir, 'index.html'), 'utf8');
      // 取静态挂载点。必须与 src/main.js 里的 staticMounts 保持一致：
      // /pic/ 下的品牌资源不在 web 目录内，直接按 web 目录去找会误报缺失。
      const mounts = { '/pic/': join(webDir, '..', 'pic') };

      const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
        .map((m) => decodeURIComponent(m[1])) // href 里的中文是百分号编码的
        .filter((ref) => ref.startsWith('/') && !ref.startsWith('//'));

      assert.ok(refs.length > 0, 'index.html 应引用至少一个资源');

      const missing = refs.filter((ref) => {
        const mount = Object.keys(mounts).find((prefix) => ref.startsWith(prefix));
        const base = mount ? mounts[mount] : webDir;
        const rest = mount ? ref.slice(mount.length) : ref.slice(1);
        return !existsSync(join(base, rest));
      });
      assert.deepEqual(missing, [], `index.html 引用了不存在的资源：${missing.join('、')}`);
    });

    test('站点图标文件确实存在且是合法的 ICO', () => {
      const ico = join(webDir, '..', 'pic', '农子.ico');
      assert.ok(existsSync(ico), '缺少图标文件 src/pic/农子.ico');
      const bytes = readFileSync(ico);
      assert.equal(bytes.readUInt16LE(0), 0);
      assert.equal(bytes.readUInt16LE(2), 1);
      assert.ok(bytes.readUInt16LE(4) >= 4, '应含多种尺寸，以适配不同 DPI');
    });

    test('index.html 引用的脚本以 type="module" 加载', () => {
      // 这些模块互相 import，必须以 ES 模块方式加载，否则浏览器报
      // "Cannot use import statement outside a module"
      const html = readFileSync(join(webDir, 'index.html'), 'utf8');
      const scripts = [...html.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
      const moduleScripts = scripts.filter((attrs) => /type="module"/.test(attrs));
      assert.ok(moduleScripts.length > 0, 'index.html 中应有 type="module" 的脚本');
    });
  });

  describe('界面元素齐全 — app.js 按 id 查找，缺一个就会白屏', () => {
    test('index.html 含 app.js 依赖的全部元素 id', () => {
      const html = readFileSync(join(webDir, 'index.html'), 'utf8');
      const appSource = readFileSync(join(jsDir, 'app.js'), 'utf8');

      const required = new Set();
      for (const match of appSource.matchAll(/getElementById\('([^']+)'\)/g)) {
        required.add(match[1]);
      }
      assert.ok(required.size > 0, '应能从 app.js 中提取到元素 id');

      const missing = [...required].filter((id) => !html.includes(`id="${id}"`));
      assert.deepEqual(missing, [], `index.html 缺少元素：${missing.join('、')}`);
    });
  });

  describe('安全性约定', () => {
    test('前端不使用 innerHTML 渲染业务数据（防存储型 XSS）', () => {
      // 唯一的例外是帮助页面：它要渲染 Markdown 文档，必须产出 HTML。
      // 但这也只允许赋值为「本项目 markdown 渲染器的输出」——该渲染器会转义
      // 文档里的所有文本（见 tests/web/markdown.test.js 的转义一节）。
      // 其余任何 innerHTML 赋值一律视为隐患。
      const ALLOWED = /absolutizeDocLinks\(\s*renderMarkdown\(/;
      const offenders = [];

      for (const file of jsFiles) {
        const source = readFileSync(join(jsDir, file), 'utf8');
        // 去掉注释后再判断，避免注释里提到 innerHTML 造成误报
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        const assignments = code.match(/[^\n]*\.innerHTML\s*=[^\n]*/g) ?? [];
        for (const line of assignments) {
          if (!ALLOWED.test(line)) offenders.push(`${file}: ${line.trim()}`);
        }
        if (/insertAdjacentHTML/.test(code)) offenders.push(`${file}: insertAdjacentHTML`);
      }

      assert.deepEqual(offenders, [],
        `以下位置用 innerHTML 渲染了未经 markdown 渲染器转义的内容：\n${offenders.join('\n')}`);
    });

    test('帮助页面的 innerHTML 只接受 markdown 渲染结果', () => {
      const source = readFileSync(join(jsDir, 'pages.js'), 'utf8');
      const assignments = source.match(/[^\n]*\.innerHTML\s*=[^\n]*/g) ?? [];
      assert.equal(assignments.length, 1, '目前应只有帮助页面这一处 innerHTML');
      assert.match(assignments[0], /renderMarkdown/);
    });
  });
});
