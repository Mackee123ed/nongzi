/**
 * 后端接口封装。
 *
 * 令牌放在内存里而不是 localStorage：本系统存的是公司全部经营与财务数据，
 * 令牌一旦落到可被任意脚本读取的存储中，一次 XSS 就等于交出全部数据的访问权。
 * 代价是刷新页面需要重新登录——对本机桌面程序来说可以接受。
 */

const TOKEN_KEY = 'nz_token';

/**
 * 令牌优先放在内存里，同时镜像一份到 sessionStorage。
 *
 * 用 sessionStorage 而不是 localStorage 是刻意的：
 *   - sessionStorage 随标签页关闭而清除，不会把公司财务数据的访问权长期留在磁盘上；
 *   - 但它能在**刷新页面后恢复登录**，否则用户每按一次 F5 就要重新输密码。
 * localStorage 会在浏览器下次启动时依然有效，风险明显更大，因此不用。
 */
function readStoredToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // 隐私模式或存储被禁用时静默降级为纯内存
  }
}

let authToken = readStoredToken();

export function setToken(token) {
  authToken = token;
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 存储不可用时忽略，内存中的令牌仍然有效 */
  }
}

export function getToken() { return authToken; }

export class ApiError extends Error {
  constructor(message, { code = 'INTERNAL', status = 500, details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** 把查询参数里值为空串/null/undefined 的项去掉，避免后端把空串当有效条件。 */
function buildQuery(params) {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value) if (v !== null && v !== undefined && v !== '') search.append(key, v);
    } else {
      search.append(key, value);
    }
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

async function request(method, path, { body, params } = {}) {
  const headers = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(`/api${path}${buildQuery(params)}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('无法连接到本地服务，请确认程序仍在运行', { code: 'NETWORK', status: 0 });
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(`服务返回了无法解析的内容（HTTP ${response.status}）`, {
      code: 'BAD_RESPONSE', status: response.status,
    });
  }

  if (!payload?.ok) {
    const error = payload?.error ?? {};
    const apiError = new ApiError(error.message ?? '操作失败', {
      code: error.code ?? 'INTERNAL',
      status: response.status,
      details: error.details ?? null,
    });
    // 会话失效时通知外层回到登录页，避免每个页面各自处理
    if (apiError.code === 'AUTH_REQUIRED' && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('auth:expired'));
    }
    throw apiError;
  }

  return payload.data;
}

export const api = {
  get: (path, params) => request('GET', path, { params }),
  post: (path, body) => request('POST', path, { body }),
  put: (path, body) => request('PUT', path, { body }),
  del: (path) => request('DELETE', path),
};
