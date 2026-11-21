import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArchiveCsv } from './archives.mjs';
import { getHololive } from './hololive.mjs';
import { getYouTubeChannel, normalizeChannelUrl } from './youtube.mjs';
import { createScheduleService, REFRESH_INTERVAL } from './schedule.mjs';
import { ScheduleError } from './schedule-error.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const defaultDataFile = fileURLToPath(new URL('../.data/schedule.json', import.meta.url));
const assets = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.png', 'image/png'],
  ['.woff2', 'font/woff2'],
]);

function json(response, code, body) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function contentType(request) {
  return request.headers['content-type']?.split(';')[0].trim().toLowerCase();
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      throw new ScheduleError(413, 'リクエストが大きすぎます。');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request, limit = 8192) {
  if (contentType(request) !== 'application/json') throw new ScheduleError(415, 'JSON 形式で送信してください。');
  const contents = await readBody(request, limit);
  try {
    const body = JSON.parse(contents);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected object');
    return body;
  } catch {
    throw new ScheduleError(400, 'リクエストの内容を読み取れませんでした。');
  }
}

async function serveAsset(request, response, pathname) {
  const file = pathname === '/' ? '/index.html' : pathname;
  if (!/^\/(?:assets\/)?[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(file)) return false;
  const type = assets.get(file.slice(file.lastIndexOf('.')));
  if (!type) return false;
  try {
    const body = await readFile(resolve(publicDir, `.${file}`));
    response.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : body);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function createApp({
  file = defaultDataFile,
  providers = { getHololive, getYouTubeChannel, normalizeChannelUrl },
  now,
} = {}) {
  const schedule = createScheduleService({ file, ...providers, now });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/api/schedule') {
        await schedule.refresh(url.searchParams.get('refresh') === '1');
        return json(response, 200, schedule.snapshot({ includeSpecialLives: url.searchParams.get('special') !== '0' }));
      }

      if (request.method === 'POST' && url.pathname === '/api/channels') {
        const body = await readJson(request);
        return json(response, 201, await schedule.addChannel(body.url));
      }

      if (request.method === 'POST' && url.pathname === '/api/archives') {
        const limit = 256 * 1024;
        const entries = contentType(request) === 'text/csv'
          ? parseArchiveCsv(await readBody(request, limit))
          : (await readJson(request, limit)).entries;
        return json(response, 201, schedule.addArchives(entries));
      }

      const channel = /^\/api\/channels\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (channel && request.method === 'PATCH') {
        const body = await readJson(request);
        if (body.hidden === false) schedule.restoreChannel(channel[1]);
        else schedule.setKeepPast(channel[1], body.keepPast);
        return json(response, 200, { ok: true });
      }
      if (channel && request.method === 'DELETE') {
        schedule.removeChannel(channel[1]);
        return json(response, 200, { ok: true });
      }

      if (['GET', 'HEAD'].includes(request.method) && await serveAsset(request, response, url.pathname)) return;
      json(response, 404, { error: 'ページが見つかりませんでした。' });
    } catch (error) {
      if (!(error instanceof ScheduleError)) console.error(error);
      json(response, error.statusCode ?? 500, { error: error instanceof ScheduleError ? error.message : '処理中にエラーが発生しました。' });
    }
  });

  return { server, schedule };
}

function openBrowser(url) {
  const windows = process.platform === 'win32';
  const commands = {
    darwin: ['/usr/bin/open', url],
    win32: [process.env.ComSpec || 'cmd.exe', '/d', '/s', '/c', `start "" "${url}"`],
  };
  const [command, ...args] = commands[process.platform] ?? ['xdg-open', url];
  const browser = spawn(command, args, { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: windows });
  const showAddress = () => console.error(`ブラウザの自動起動に失敗しました。${url} を開いてください。`);
  browser.on('error', showAddress);
  browser.on('exit', (code) => { if (code !== 0) showAddress(); });
  browser.unref();
}

function startServer() {
  const codespaces = process.env.CODESPACES === 'true';
  const host = process.env.HOST || (codespaces ? '0.0.0.0' : '127.0.0.1');
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('PORT に 0〜65535 の整数を指定してください。');
    process.exitCode = 1;
    return;
  }
  const { server, schedule } = createApp({ file: process.env.SCHEDULE_DATA_FILE || defaultDataFile });
  function refresh() {
    schedule.refresh().catch((error) => console.error('Schedule refresh failed:', error));
  }
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`ポート ${port} は使用中です。起動済みのアプリを開くか、PORT を変更してください。`);
    } else {
      console.error('配信日和の起動に失敗しました。', error.message);
    }
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    const { address, port: boundPort } = server.address();
    const loopback = { '0.0.0.0': '127.0.0.1', '::': '::1' };
    const localAddress = loopback[address] ?? address;
    const browserHost = localAddress.includes(':') ? `[${localAddress}]` : localAddress;
    const url = `http://${browserHost}:${boundPort}`;
    console.log(`配信日和を開くには、ブラウザで ${url} にアクセスしてください。`);
    if (codespaces) {
      const name = process.env.CODESPACE_NAME;
      const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
      if (name && domain) {
        console.log(`Codespaces でポート ${boundPort} を転送して開く URL: https://${name}-${boundPort}.${domain}`);
      }
    } else if (process.argv.includes('--open')) {
      openBrowser(url);
    }
    refresh();
  });
  const timer = setInterval(refresh, REFRESH_INTERVAL);
  timer.unref();
  server.on('close', () => clearInterval(timer));
}

if (import.meta.main) startServer();
