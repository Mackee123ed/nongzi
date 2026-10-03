/**
 * 统一响应封装。
 *
 * 成功：{ ok: true, data }
 * 失败：{ ok: false, error: { code, message, details? } }
 *
 * 前端与测试只依赖稳定的英文 code（AUTH_REQUIRED / FORBIDDEN / VALIDATION …），
 * message 是面向用户的中文，可以随时润色而不破坏契约。
 */

import { AppError } from '../core/errors.js';

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // 本机单机服务，禁用缓存避免界面看到过期数据
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function ok(res, data = null, status = 200) {
  sendJson(res, status, { ok: true, data });
}

export function fail(res, error) {
  const appError = error instanceof AppError
    ? error
    : new AppError(error?.message ?? '服务器内部错误', { code: 'INTERNAL', status: 500 });

  // 未预期的错误要打到控制台，否则本机排障时无从下手；
  // 但只把中文提示返回给前端，不泄漏堆栈。
  if (appError.status >= 500) {
    console.error('[错误]', appError.message, error?.stack ?? '');
  }

  sendJson(res, appError.status, { ok: false, error: appError.toJSON() });
}

/** 把处理函数的返回值统一转成响应；抛出的错误交给 fail。 */
export async function handle(res, fn) {
  try {
    const data = await fn();
    ok(res, data);
  } catch (error) {
    fail(res, error);
  }
}

/** 读取并解析 JSON 请求体，带大小上限。 */
export async function readJsonBody(req, { limitBytes = 2 * 1024 * 1024 } = {}) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      const err = new AppError('请求内容过大', { code: 'PAYLOAD_TOO_LARGE', status: 413 });
      throw err;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('请求内容不是合法的 JSON', { code: 'VALIDATION', status: 422 });
  }
}
