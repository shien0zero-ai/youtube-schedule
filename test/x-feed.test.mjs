import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/server.mjs';

const inaId = 'UCMwGHR0BTZuLsmjY_NT5Pwg';
const ina = { id: inaId, name: 'Ninomae Ina’nis' };
const listUrl = 'https://x.com/i/lists/1900123456789012345';

async function start(t, file, providers = {}) {
  const { server } = createApp({ file, providers });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options) => fetch(origin + path, options);
  return {
    request,
    get: () => request('/api/x-posts'),
    save: (payload) => request('/api/x-posts', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }),
  };
}

test('loads a saved X list and roster without fetching X or updating the schedule', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'haishin-x-feed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'schedule.json');
  let scheduleCalls = 0;
  const providers = { getHololive: async () => { scheduleCalls++; } };
  const app = await start(t, file, providers);
  const response = await app.get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { accounts, listUrl: initial } = await response.json();
  assert.equal(initial, null);
  assert.ok(accounts.length >= 60);
  assert.ok(accounts.every(({ group }) => /^(?:ホロライブ (?:JP|ID|EN)|hololive DEV_IS)$/.test(group)));
  assert.equal(new Set(accounts.map(({ handle }) => handle.toLowerCase())).size, accounts.length);
  const account = accounts.find(({ channelId }) => channelId === inaId);
  assert.equal(account.handle, 'ninomaeinanis');
  assert.ok(account.aliases.includes('Ina'));
  assert.ok(account.aliases.includes('にのまえいなにす'));

  const saved = await app.save({ url: ' https://twitter.com/i/lists/1900123456789012345/?s=20#timeline ' });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).listUrl, listUrl);
  const restarted = await start(t, file, providers);
  assert.deepEqual(await (await restarted.get()).json(), { accounts, listUrl });
  assert.equal(scheduleCalls, 0);
});

test('validates X list URLs before saving and supports replacement and removal', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'haishin-x-url-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'schedule.json');
  const app = await start(t, file);
  assert.equal((await app.save({ url: listUrl })).status, 200);

  const invalid = [
    'http://x.com/i/lists/123', 'https://x.com.evil.example/i/lists/123', 'https://x.com@evil.example/i/lists/123',
    'https://user@x.com/i/lists/123', 'https://x.com:8443/i/lists/123', 'https://x.com/ninomaeinanis',
    'https://x.com/i/lists/123/members', 'https://x.com/i/lists/0', 'https://x.com/i/lists/%31',
    'javascript:alert(1)', 123, {}, '', undefined,
  ];
  for (const url of invalid) {
    const response = await app.save({ url });
    assert.equal(response.status, 400, String(url));
    assert.match((await response.json()).error, /公開リスト/);
  }
  assert.equal((await (await app.get()).json()).listUrl, listUrl);

  const replacement = 'https://x.com/i/lists/1234567890';
  assert.equal((await (await app.save({ url: replacement })).json()).listUrl, replacement);
  assert.equal((await (await app.save({ url: null })).json()).listUrl, null);
  const restarted = await start(t, file);
  assert.equal((await (await restarted.get()).json()).listUrl, null);
});

test('the X talent roster follows the channel visibility setting without changing the list URL', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'haishin-x-visibility-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'schedule.json');
  await writeFile(file, JSON.stringify({ roster: [ina], custom: [], preferences: {}, streams: [], xListUrl: listUrl }));
  const app = await start(t, file);
  assert.equal((await app.request(`/api/channels/${inaId}`, { method: 'DELETE' })).status, 200);
  const hidden = await (await app.get()).json();
  assert.ok(hidden.accounts.every(({ channelId }) => channelId !== inaId));
  assert.equal(hidden.listUrl, listUrl);
});
