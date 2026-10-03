/**
 * 极简路由器。无第三方依赖，支持 :param 形式的路径参数。
 *
 * 路由表本身也是权限自检的依据：每条读接口都必须声明 scope 绑定或显式声明不需要，
 * 由测试遍历路由表来保证「权限贯穿所有模块」不是一句口号（见 tests/http/route-scope.test.js）。
 */

export function createRouter() {
  const routes = [];

  function register(method, pattern, handler, options = {}) {
    const segments = pattern.split('/').filter(Boolean);
    routes.push({
      method,
      pattern,
      segments,
      handler,
      // meta：权限码、数据范围绑定等，供中间件与自检测试读取
      meta: options,
    });
  }

  function match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);

    for (const route of routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;

      const params = {};
      let matched = true;

      for (let i = 0; i < route.segments.length; i++) {
        const segment = route.segments[i];
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(parts[i]);
        } else if (segment !== parts[i]) {
          matched = false;
          break;
        }
      }

      if (matched) return { route, params, handler: route.handler, meta: route.meta };
    }

    return null;
  }

  return {
    get: (p, h, o) => register('GET', p, h, o),
    post: (p, h, o) => register('POST', p, h, o),
    put: (p, h, o) => register('PUT', p, h, o),
    patch: (p, h, o) => register('PATCH', p, h, o),
    delete: (p, h, o) => register('DELETE', p, h, o),
    match,
    /** 供自检测试遍历。 */
    routes: () => [...routes],
  };
}
