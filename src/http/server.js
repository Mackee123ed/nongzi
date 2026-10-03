/**
 * 本地 HTTP 服务：监听、端口顺延、自动打开浏览器。
 *
 * 需求书 1.2 要求「双击启动 → 自动拉起后端 → 自动打开前端页面」。
 * 打开浏览器这一步必须由 Node 在 listen 成功之后执行：端口冲突时端口会顺延，
 * 只有 Node 知道最终端口号。若交给 .bat 先用固定端口去开浏览器，就会打开一个空页面。
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createApp } from './app.js';

const MAX_PORT_ATTEMPTS = 10;

/** 在指定端口监听；端口被占用时依次顺延。 */
export function listenWithFallback(server, host, startPort, attempts = MAX_PORT_ATTEMPTS) {
  return new Promise((resolve, reject) => {
    let port = startPort;
    let remaining = attempts;

    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && remaining > 0) {
        remaining -= 1;
        port += 1;
        server.listen(port, host);
        return;
      }
      server.removeListener('error', onError);
      reject(err);
    };

    server.on('error', onError);
    server.once('listening', () => {
      server.removeListener('error', onError);
      resolve(port);
    });

    server.listen(port, host);
  });
}

/** 用系统默认浏览器打开地址。 */
export function openBrowser(url, { platform = process.platform } = {}) {
  try {
    if (platform === 'win32') {
      // cmd 的 start 第一个参数是窗口标题，必须给空串，否则会把 URL 当标题
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      // WSL 下用 Windows 的浏览器打开；失败则退回 Linux 的 xdg-open
      spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
        .on('error', () => {
          spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
        })
        .unref();
    }
    return true;
  } catch {
    return false;
  }
}

export async function startServer({ db, services, webRoot, staticMounts = {}, config, logger = console }) {
  const handler = createApp({ db, services, webRoot, staticMounts, logger });
  const server = createServer(handler);

  const host = config.server?.host ?? '127.0.0.1';
  const port = await listenWithFallback(server, host, config.server?.port ?? 8787);
  const url = `http://${host}:${port}/`;

  return {
    server,
    port,
    url,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
