import { execFile, spawn } from 'node:child_process';
import { addAbortListener } from 'node:events';
import { readFile } from 'node:fs/promises';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

const repository = 'shien0zero-ai/youtube-schedule';
const loopback = '127.0.0.1';
const remotePort = 3000;
const configFile = new URL('../.haishin-launch.json', import.meta.url);
const codespaceName = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const transitionalStates = new Set([
  'Created', 'Queued', 'Provisioning', 'Starting', 'ShuttingDown', 'Updating', 'Rebuilding', 'Exporting',
]);

const usage = `配信日和の Codespace を開きます。

node scripts/open-codespace.mjs [--codespace NAME] [--port PORT]

設定の優先順は引数、HAISHIN_CODESPACE / HAISHIN_LOCAL_PORT、.haishin-launch.json です。
ローカル接続先は既定で http://127.0.0.1:3000/ です。`;

export function parseOptions(args, env = process.env, config = {}) {
  const flags = {};
  const names = new Map([['--codespace', 'codespace'], ['-c', 'codespace'], ['--port', 'port']]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    const equals = arg.indexOf('=');
    const name = names.get(equals === -1 ? arg : arg.slice(0, equals));
    if (!name) throw new Error('引数は --codespace NAME または --port PORT を指定してください。');
    const value = equals === -1 ? args[++index] : arg.slice(equals + 1);
    if (!value || value.startsWith('-')) throw new Error(`--${name} の値を指定してください。`);
    flags[name] = value;
  }

  const codespace = flags.codespace ?? (env.HAISHIN_CODESPACE || undefined) ?? config.codespace;
  if (codespace !== undefined && (typeof codespace !== 'string' || !codespaceName.test(codespace))) {
    throw new Error('Codespace 名は GitHub CLI の一覧に表示される英小文字・数字・ハイフンの名前を指定してください。');
  }
  const port = flags.port ?? (env.HAISHIN_LOCAL_PORT || undefined) ?? config.port ?? remotePort;
  if (!['number', 'string'].includes(typeof port) || !/^\d{1,5}$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('ローカルポートは 1〜65535 の整数を指定してください。');
  }
  return { codespace, port: Number(port) };
}

async function localConfig() {
  let contents;
  try {
    contents = await readFile(configFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('.haishin-launch.json を読み込めませんでした。');
  }
  let config;
  try {
    config = JSON.parse(contents);
  } catch {
    throw new Error('.haishin-launch.json の JSON を読み取れませんでした。');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).some((key) => key !== 'codespace' && key !== 'port')) {
    throw new Error('.haishin-launch.json は codespace と port を設定できる JSON オブジェクトです。');
  }
  return config;
}

function selectCodespace(output, requested) {
  let rows;
  try {
    rows = JSON.parse(output);
    if (!Array.isArray(rows)) throw new Error();
  } catch {
    throw new Error('GitHub CLI から Codespace の一覧を読み取れませんでした。');
  }
  const choices = rows.filter((row) => row && typeof row.name === 'string' && typeof row.repository === 'string' &&
    codespaceName.test(row.name) && row.repository.toLowerCase() === repository);
  if (requested) {
    const selected = choices.find(({ name }) => name === requested);
    if (selected) return selected;
    throw new Error(`${repository} の Codespace に ${requested} が見つかりませんでした。GitHub CLI のアカウントを確認してください。`);
  }
  if (choices.length === 1) return choices[0];
  if (!choices.length) throw new Error(`${repository} の Codespace が見つかりませんでした。GitHub の Codespaces と GitHub CLI のアカウントを確認してください。`);
  throw new Error(`Codespace が複数あります。--codespace NAME または .haishin-launch.json で指定してください。\n${choices.map(({ name }) => `  ${name}`).join('\n')}`);
}

function startGh(args) {
  const windows = process.platform === 'win32';
  const child = spawn('gh', args, {
    detached: !windows,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_DEBUG: '' },
  });
  let stdout = '';
  let stderr = '';
  let error;
  let closed = false;
  const outputLimit = 128 * 1024;
  child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part.slice(0, outputLimit - stdout.length); });
  child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part.slice(0, outputLimit - stderr.length); });
  child.once('error', (failure) => { error = failure; });
  const done = new Promise((resolve) => {
    child.once('close', (code) => {
      closed = true;
      resolve({ code, stdout, stderr, error });
    });
  });

  async function close() {
    if (closed || !child.pid) return;
    if (windows) {
      await new Promise((resolve) => {
        execFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 3000 }, (failure) => {
          if (failure && !closed) child.kill();
          resolve();
        });
      });
      return;
    }
    const killGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch (failure) {
        if (failure.code !== 'ESRCH') throw failure;
      }
    };
    killGroup('SIGTERM');
    await Promise.race([done, sleep(1200, undefined, { ref: false })]);
    if (!closed) killGroup('SIGKILL');
  }
  return { done, close };
}

async function untilAborted(task, signal) {
  let listener;
  try {
    return await Promise.race([task, new Promise((_, reject) => {
      listener = addAbortListener(signal, () => reject(signal.reason));
    })]);
  } finally {
    listener[Symbol.dispose]();
  }
}

function commandError(result, action) {
  if (result.error?.code === 'ENOENT') return new Error('GitHub CLI (gh) をインストールしてください。');
  const status = Number(/\bHTTP (\d{3})\b/.exec(result.stderr)?.[1]);
  if (status === 401 || /gh auth login|not logged/i.test(result.stderr)) {
    return new Error('GitHub CLI でログインしてください。gh auth login --hostname github.com');
  }
  if (status === 402) return new Error(`${action}に失敗しました。GitHub の Codespaces 利用枠と請求設定を確認してください。`);
  if (status === 403) return new Error(`${action}に失敗しました。GitHub CLI のアカウントと Codespaces のアクセス権を確認してください。（HTTP 403）`);
  return new Error(`${action}に失敗しました${status ? `。（HTTP ${status}）` : '。'}`);
}

async function runGh(args, { action, signal, timeout = 20000, acceptConflict = false }) {
  signal.throwIfAborted();
  const deadline = AbortSignal.timeout(timeout);
  const command = startGh(args);
  try {
    const result = await untilAborted(command.done, AbortSignal.any([signal, deadline]));
    if (result.code === 0 || (acceptConflict && /\bHTTP 409\b/.test(result.stderr))) return result.stdout;
    throw commandError(result, action);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (deadline.aborted) throw new Error(`${action}が時間内に完了しませんでした。`);
    throw error;
  } finally {
    await command.close();
  }
}

function loopbackResponse(port, path, signal) {
  return new Promise((resolve) => {
    const request = get({ hostname: loopback, port, path, agent: false, signal }, (response) => {
      let body = '';
      response.setEncoding('utf8').on('data', (chunk) => {
        body += chunk;
        if (body.length > 65536) response.destroy();
      });
      response.on('end', () => resolve({ status: response.statusCode, body }));
      response.on('error', () => resolve(null));
      response.on('close', () => resolve(null));
    });
    request.on('error', () => resolve(null));
  });
}

async function isAppReady(port, name, { signal, legacy = false }) {
  const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(1200)]);
  const health = await loopbackResponse(port, '/healthz', probeSignal);
  if (health?.status === 200) {
    try {
      const result = JSON.parse(health.body);
      return result?.app === 'haishin-biyori' && result.codespace === name;
    } catch {
      return false;
    }
  }
  // Only an owned SSH tunnel can safely identify an older deployment without /healthz.
  if (legacy && health?.status === 404) {
    const page = await loopbackResponse(port, '/', probeSignal);
    return page?.status === 200 && page.body.includes('<title>配信日和｜ライブ配信スケジュール</title>') &&
      page.body.includes('<script type="module" src="/app.js"></script>') && page.body.includes('id="schedule-panel"');
  }
  return false;
}

function isPortFree(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
      else reject(error);
    });
    server.listen(port, loopback, () => server.close(() => resolve(true)));
  });
}

function openBrowser(url) {
  const windows = process.platform === 'win32';
  const commands = {
    darwin: ['/usr/bin/open', url],
    win32: ['cmd.exe', '/d', '/s', '/c', `start "" "${url}"`],
  };
  const [command, ...args] = commands[process.platform] ?? ['xdg-open', url];
  const browser = spawn(command, args, { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: windows });
  const showAddress = () => console.error(`ブラウザの自動起動に失敗しました。${url} を開いてください。`);
  browser.once('error', showAddress);
  browser.once('exit', (code) => { if (code !== 0) showAddress(); });
  browser.unref();
}

async function waitForCodespace({ name, state }, { gh, signal, pause, log }) {
  const deadline = AbortSignal.timeout(180000);
  const waitSignal = AbortSignal.any([signal, deadline]);
  const endpoint = `/user/codespaces/${name}`;
  let startRequested = false;
  let lastState;
  try {
    while (state !== 'Available') {
      if (state === 'Shutdown' && !startRequested) {
        log(`Codespace ${name} を起動しています…`);
        await gh(['api', '--method', 'POST', '--silent', `${endpoint}/start`], {
          action: 'Codespace の起動', signal: waitSignal, timeout: 60000, acceptConflict: true,
        });
        startRequested = true;
      } else if (state !== 'Shutdown' && !transitionalStates.has(state)) {
        throw new Error('この Codespace を起動できる状態か GitHub の Codespaces ページで確認してください。');
      }
      if (state !== lastState && state !== 'Shutdown') log(`Codespace の準備を待っています…（${state}）`);
      lastState = state;
      await pause(3000, undefined, { signal: waitSignal });
      state = (await gh(['api', endpoint, '--jq', '.state'], { action: 'Codespace の状態確認', signal: waitSignal })).trim();
    }
  } catch (error) {
    if (!signal.aborted && deadline.aborted) throw new Error('Codespace の準備が時間内に完了しませんでした。GitHub の Codespaces ページで状態を確認してください。');
    throw error;
  }
}

async function waitForApp(port, name, signal, probe, pause) {
  const deadline = AbortSignal.timeout(45000);
  const waitSignal = AbortSignal.any([signal, deadline]);
  try {
    while (true) {
      waitSignal.throwIfAborted();
      if (await probe(port, name, { signal: waitSignal, legacy: true })) return;
      await pause(500, undefined, { signal: waitSignal });
    }
  } catch (error) {
    if (!signal.aborted && deadline.aborted) throw new Error('転送先で配信日和の起動を確認できませんでした。Codespace のポート 3000 を確認してください。');
    throw error;
  }
}

export async function launchCodespace({ codespace, port }, {
  gh = runGh, forward = startGh, probe = isAppReady, portFree = isPortFree, browser = openBrowser,
  signal = new AbortController().signal, pause = sleep, log = console.log,
} = {}) {
  signal.throwIfAborted();
  log('GitHub CLI から Codespace を確認しています…');
  const list = await gh(['codespace', 'list', '--repo', repository, '--limit', '100', '--json', 'name,repository,state'],
    { action: 'Codespace 一覧の取得', signal });
  const selected = selectCodespace(list, codespace);
  const url = `http://${loopback}:${port}/`;
  const ready = await probe(port, selected.name, { signal });
  signal.throwIfAborted();
  if (ready) {
    log(`接続済みの配信日和を開きます。${url}`);
    browser(url);
    return;
  }
  if (!await portFree(port)) throw new Error(`ローカルポート ${port} を利用できません。--port 3001 など別の番号を指定してください。`);
  await waitForCodespace(selected, { gh, signal, pause, log });

  const ssh = ['codespace', 'ssh', '-c', selected.name, '--', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
  log(`Codespace ${selected.name} で配信日和を準備しています…`);
  const command = `cd /workspaces/youtube-schedule && PORT=${remotePort} CODESPACES=true CODESPACE_NAME=${selected.name} bash .devcontainer/start-app.sh`;
  await gh([...ssh, command], {
    action: 'Codespace 内のアプリの起動（SSH と .devcontainer/start-app.sh の設定を確認してください）',
    signal, timeout: 60000,
  });

  signal.throwIfAborted();
  log(`ポートを転送しています…（${url}）`);
  const tunnel = forward([...ssh, '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'GatewayPorts=no',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-L', `${loopback}:${port}:${loopback}:${remotePort}`]);
  const waiting = new AbortController();
  const tunnelSignal = AbortSignal.any([signal, waiting.signal]);
  const disconnected = tunnel.done.then((result) => {
    throw commandError(result, 'Codespace へのポート転送');
  });
  try {
    await Promise.race([waitForApp(port, selected.name, tunnelSignal, probe, pause), disconnected]);
    signal.throwIfAborted();
    log(`配信日和を開きます。${url}\n使い終わったら Ctrl+C でポート転送を終了できます。`);
    browser(url);
    await untilAborted(disconnected, signal);
  } finally {
    waiting.abort();
    await tunnel.close();
  }
}

async function main() {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, cancel);
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
      console.log(usage);
      return;
    }
    if (process.env.CODESPACES === 'true') throw new Error('このランチャーはお使いのパソコンで実行してください。Codespace 内ではポート 3000 の地球マークから開けます。');
    await launchCodespace(parseOptions(args, process.env, await localConfig()), { signal: abort.signal });
  } catch (error) {
    if (!abort.signal.aborted) {
      console.error(error.message);
      process.exitCode = 1;
    }
  } finally {
    for (const signal of signals) process.off(signal, cancel);
  }
}

if (import.meta.main) await main();
