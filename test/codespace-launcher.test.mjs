import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { launchCodespace, parseOptions } from '../scripts/open-codespace.mjs';

const repository = 'shien0zero-ai/youtube-schedule';
const name = 'shiny-dollop-g4gpqxq5w4xv3vwxv';
const sibling = 'other-codespace-5k2z';
const port = 35123;
const url = `http://127.0.0.1:${port}/`;
const silent = () => {};

function space(name, state, repo = repository) {
  return { name, state, repository: repo };
}

function simulatedLauncher(spaces, changes = []) {
  const calls = [];
  const opened = [];
  const abort = new AbortController();
  let finish;
  let closed = false;
  const dependencies = {
    gh: async (args) => {
      calls.push(args);
      if (args[1] === 'list') return JSON.stringify(spaces);
      if (args[0] === 'api' && args.at(-1) === '.state') {
        assert.ok(changes.length, 'unexpected Codespace polling');
        return changes.shift();
      }
      return '';
    },
    forward: (args) => {
      calls.push(args);
      return {
        done: new Promise((resolve) => { finish = resolve; }),
        close: async () => { closed = true; finish({ code: 0, stderr: '' }); },
      };
    },
    probe: async (_, __, { legacy = false }) => legacy,
    portFree: async () => true,
    browser: (address) => { opened.push(address); abort.abort(); },
    signal: abort.signal,
    pause: async () => {},
    log: silent,
  };
  return { calls, opened, abort, dependencies, isClosed: () => closed };
}

test('parses configuration in argument, environment, file and default order', () => {
  const config = { codespace: name, port: 3001 };
  const env = { HAISHIN_CODESPACE: sibling, HAISHIN_LOCAL_PORT: '4000' };
  assert.deepEqual(parseOptions([], {}, {}), { codespace: undefined, port: 3000 });
  assert.deepEqual(parseOptions([], {}, config), config);
  assert.deepEqual(parseOptions([], env, config), { codespace: sibling, port: 4000 });
  assert.deepEqual(parseOptions(['-c', name, '--port=5000'], env, config), { codespace: name, port: 5000 });
  assert.deepEqual(parseOptions(['--help'], {}), { help: true });
  for (const args of [
    ['--codespace', '../bad'], ['--codespace', 'name;command'], ['--codespace', '--port'],
    ['--port', '0'], ['--port', '65536'], ['--port', '3.5'], ['--port', '3e3'],
  ]) assert.throws(() => parseOptions(args, {}));
});

test('requires an explicit selection for multiple target Codespaces and ignores other repositories', async () => {
  const launch = simulatedLauncher([
    space(name, 'Available'), space(sibling, 'Shutdown'), space('unrelated', 'Available', 'someone/other'),
  ]);
  await assert.rejects(launchCodespace({ port }, launch.dependencies), /Codespace が複数.*--codespace/s);
  await assert.rejects(launchCodespace({ port, codespace: 'unrelated' }, launch.dependencies), /見つかりません/);
  assert.deepEqual(launch.calls.map((args) => args.slice(0, 2)), [['codespace', 'list'], ['codespace', 'list']]);
  assert.equal(launch.opened.length, 0);
});

test('starts only the selected stopped Codespace, waits, then opens through an explicit loopback SSH tunnel', async () => {
  const launch = simulatedLauncher([space(sibling, 'Available'), space(name, 'Shutdown')], ['Starting', 'Available']);
  await assert.rejects(launchCodespace({ codespace: name, port }, launch.dependencies), { name: 'AbortError' });
  const [list, start, firstPoll, secondPoll, prepare, forward] = launch.calls;
  assert.deepEqual(list, ['codespace', 'list', '--repo', repository, '--limit', '100', '--json', 'name,repository,state']);
  assert.deepEqual(start, ['api', '--method', 'POST', '--silent', `/user/codespaces/${name}/start`]);
  assert.deepEqual(firstPoll, ['api', `/user/codespaces/${name}`, '--jq', '.state']);
  assert.deepEqual(secondPoll, firstPoll);
  assert.deepEqual(prepare.slice(0, 5), ['codespace', 'ssh', '-c', name, '--']);
  assert.equal(prepare.at(-1), `cd /workspaces/youtube-schedule && PORT=3000 CODESPACES=true CODESPACE_NAME=${name} bash .devcontainer/start-app.sh`);
  assert.deepEqual(forward.slice(0, 5), prepare.slice(0, 5));
  assert.ok(forward.includes('-N'));
  assert.ok(forward.includes('ExitOnForwardFailure=yes'));
  assert.deepEqual(forward.slice(-2), ['-L', `127.0.0.1:${port}:127.0.0.1:3000`]);
  assert.deepEqual(launch.opened, [url]);
  assert.equal(launch.isClosed(), true);
});

test('does not start a Codespace if the configured loopback port is unavailable', async () => {
  const launch = simulatedLauncher([space(name, 'Shutdown')]);
  await assert.rejects(launchCodespace({ port }, {
    ...launch.dependencies, portFree: async () => false,
  }), /ローカルポート.*--port 3001/);
  assert.equal(launch.calls.length, 1);
  assert.equal(launch.opened.length, 0);
});

test('reuses a live local tunnel only if the health check identifies the selected Codespace', async (t) => {
  let owner = name;
  const server = createServer((request, response) => {
    assert.equal(request.url, '/healthz');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ app: 'haishin-biyori', codespace: owner }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const opened = [];
  const gh = async (args) => {
    assert.equal(args[1], 'list');
    return JSON.stringify([space(name, 'Available')]);
  };
  const options = { port };
  const deps = { gh, browser: (address) => opened.push(address), log: silent };
  await launchCodespace(options, deps);
  assert.deepEqual(opened, [`http://127.0.0.1:${port}/`]);
  owner = sibling;
  await assert.rejects(launchCodespace(options, deps), /ローカルポート.*--port/);
  assert.equal(opened.length, 1);
});

test('reports failed tunnel startup and cleans it up without opening a browser or printing CLI output', async () => {
  const launch = simulatedLauncher([space(name, 'Available')]);
  let closed = false;
  await assert.rejects(launchCodespace({ port }, {
    ...launch.dependencies, pause: undefined, probe: async () => false,
    forward: () => ({
      done: Promise.resolve({ code: 1, stderr: 'private CLI output' }),
      close: async () => { closed = true; },
    }),
  }), { message: 'Codespace へのポート転送に失敗しました。' });
  assert.deepEqual(launch.opened, []);
  assert.equal(closed, true);
  assert.equal(launch.calls.some((args) => args[0] === 'api'), false);
});

test('accepts legacy app HTML during a new forward only', async (t) => {
  const page = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/healthz') {
      response.writeHead(404).end();
    } else {
      response.end(page);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const launch = simulatedLauncher([space(name, 'Available')]);
  const { probe: _mockProbe, portFree: _mockFreePort, ...dependencies } = launch.dependencies;
  await assert.rejects(launchCodespace({ port }, dependencies), /ローカルポート.*--port/);
  assert.deepEqual(requests, ['/healthz']);
  await assert.rejects(launchCodespace({ port }, {
    ...dependencies, portFree: async () => true,
  }), { name: 'AbortError' });
  assert.deepEqual(requests, ['/healthz', '/healthz', '/healthz', '/']);
  assert.deepEqual(launch.opened, [`http://127.0.0.1:${port}/`]);
});
