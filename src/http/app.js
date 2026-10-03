/**
 * HTTP 应用装配：静态资源托管 + API 路由 + 会话中间件。
 *
 * 安全上的两点注意（本机服务同样需要）：
 *   - 只监听 127.0.0.1。绑定 0.0.0.0 会让同一个局域网内的任何人都能访问财务数据。
 *   - 校验 Host/Origin。浏览器里的恶意网页可以向 localhost 发请求（DNS 重绑定），
 *     仅靠「监听本机」并不能阻止，必须校验来源。
 */

import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';
import { createRouter } from './router.js';
import { ok, fail, readJsonBody } from './respond.js';
import { AuthError, PermissionError, AppError } from '../core/errors.js';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // 使用说明与更新日志以 Markdown 原文提供，帮助页面 fetch 后交给前端渲染。
  // 不带 charset 会被当成二进制流，浏览器调试时看不到原文。
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 无需登录即可访问的接口。 */
const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/login']);

function extractToken(req) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();

  const cookie = req.headers.cookie;
  if (cookie) {
    for (const part of cookie.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === 'sid') return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}

export function createApp({ db, services, webRoot, staticMounts = {}, logger = console }) {
  const router = createRouter();

  router.get('/api/health', () => ({ status: 'ok', time: new Date().toISOString() }));

  // 模块路由（库存/财务/销售/客户/员工/系统）统一在此注册
  services.registerRoutes(router);

  /**
   * 读取并返回一个文件。
   * 归一化路径并确认结果仍在允许的根目录内，防止 ../ 穿越读取任意文件。
   */
  const serveFile = async (res, filePath, rootDir) => {
    const safeRoot = resolve(rootDir);
    const resolved = resolve(filePath);

    if (resolved !== safeRoot && !resolved.startsWith(safeRoot + sep)) {
      res.writeHead(403).end('Forbidden');
      return true;
    }

    try {
      const info = await stat(resolved);
      const target = info.isDirectory() ? join(resolved, 'index.html') : resolved;
      const content = await readFile(target);
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
        // 本机应用，禁用缓存以免改了页面还要用户手动强刷
        'Cache-Control': 'no-cache',
      });
      res.end(content);
      return true;
    } catch {
      return false;
    }
  };

  const serveStatic = async (req, res, pathname) => {
    const decoded = decodeURIComponent(pathname);

    // 额外挂载点，例如 /pic/ → src/pic（图标等品牌资源放在那里，
    // 不必为了能被浏览器访问而复制一份到 web 目录，避免两份文件各自漂移）
    for (const [prefix, dir] of Object.entries(staticMounts)) {
      if (decoded.startsWith(prefix)) {
        const rest = decoded.slice(prefix.length).replace(/^[/\\]+/, '');
        // 挂载点没有「回落到首页」这一说：找不到就必须明确回 404。
        // 若在此处直接 return 而不写响应，请求会永远挂起（表现为浏览器一直转圈）。
        if (!(await serveFile(res, join(dir, rest), dir))) {
          res.writeHead(404).end('Not Found');
        }
        return;
      }
    }

    if (await serveFile(res, join(webRoot, decoded), webRoot)) return;

    // 前端使用 hash 路由，未知路径一律回落到 index.html
    if (!(await serveFile(res, join(webRoot, 'index.html'), webRoot))) {
      res.writeHead(404).end('Not Found');
    }
  };

  return async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET') { res.writeHead(405).end('Method Not Allowed'); return; }
      return serveStatic(req, res, pathname);
    }

    // 写操作校验来源，挡住来自其它网页的跨站请求
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin) {
        const host = req.headers.host;
        try {
          if (new URL(origin).host !== host) {
            return fail(res, new PermissionError('请求来源不合法'));
          }
        } catch {
          return fail(res, new PermissionError('请求来源不合法'));
        }
      }
    }

    const matched = router.match(req.method, pathname);
    if (!matched) {
      return fail(res, new AppError(`接口不存在：${req.method} ${pathname}`, {
        code: 'NOT_FOUND', status: 404,
      }));
    }

    try {
      const context = {
        req,
        res,
        url,
        params: matched.params,
        query: Object.fromEntries(url.searchParams),
        body: req.method === 'GET' ? {} : await readJsonBody(req),
        user: null,
        scope: null,
      };

      if (!PUBLIC_PATHS.has(pathname)) {
        const token = extractToken(req);
        const session = await services.auth.resolve(token);
        if (!session) throw new AuthError('登录状态已失效，请重新登录');
        context.user = session.user;
        context.token = token;
        context.scope = await services.buildScopeFor(session.user);
      }

      const data = await matched.handler(context);
      // 令牌等敏感字段由处理函数自行决定是否返回
      ok(res, data ?? null);
    } catch (error) {
      fail(res, error);
    }
  };
}
