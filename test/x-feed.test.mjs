import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/server.mjs';

const baseTime = Date.parse('2026-11-23T12:00:00Z');
const inaId = 'UCMwGHR0BTZuLsmjY_NT5Pwg';
const ina = { id: inaId, name: 'Ninomae Ina’nis' };
const minute = 60_000;

async function start(t, { providers, now }) {
  const dir = await mkdtemp(join(tmpdir(), 'haishin-x-feed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'schedule.json');
  await writeFile(file, JSON.stringify({ roster: [ina], custom: [], preferences: {}, streams: [] }));
  const { server } = createApp({ file, providers, now });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return (path, options) => fetch(origin + path, options);
}

test('exposes only verified Hololive talent profiles when X is unconfigured, without loading schedules', async (t) => {
  let scheduleCalls = 0;
  const request = await start(t, { providers: { getHololive: async () => { scheduleCalls++; } } });
  const response = await request('/api/x-posts');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const payload = await response.json();
  assert.equal(payload.available, false);
  assert.equal(payload.updatedAt, null);
  assert.deepEqual(payload.posts, []);
  assert.ok(payload.accounts.length >= 60);
  for (const account of payload.accounts) assert.match(account.group, /ホロライブ (?:JP|ID|EN)|hololive DEV_IS/);
  assert.equal(new Set(payload.accounts.map(({ handle }) => handle.toLowerCase())).size, payload.accounts.length);
  const account = payload.accounts.find(({ channelId }) => channelId === inaId);
  assert.equal(account.handle, 'ninomaeinanis');
  assert.ok(account.aliases.includes('Ina'));
  assert.ok(account.aliases.includes('にのまえいなにす'));
  assert.equal(scheduleCalls, 0);
});

test('loads X posts on demand, shares a bounded cache and keeps scope on upstream failure', async (t) => {
  let time = baseTime;
  let calls = 0;
  const inaPost = { id: '1111111111111111100', handle: 'NinomaeInanis', text: '昨日の配信ありがとう', createdAt: '2026-11-23T10:00:00Z' };
  const mikoPost = { id: '1111111111111111101', handle: 'sakuramiko35', text: '今夜も配信します', createdAt: '2026-11-23T11:00:00Z' };
  const future = { ...mikoPost, id: '1111111111111111102', createdAt: '2026-11-24T10:00:00Z' };
  const expired = { ...mikoPost, id: '1111111111111111103', createdAt: '2026-11-15T10:00:00Z' };
  const request = await start(t, { now: () => time, providers: {
    getHololive: async () => null,
    getXPosts: async (accounts) => {
      assert.ok(accounts.some(({ handle }) => handle === 'ninomaeinanis'));
      if (++calls > 1) {
        throw Object.assign(new Error('internal credential data'), { status: 429, retryAt: time + 90 * minute });
      }
      return [inaPost, mikoPost, inaPost, future, expired, { ...mikoPost, id: '1', handle: 'outside' }];
    },
  } });
  const read = async (query = '') => (await (await request('/api/x-posts' + query)).json());
  await request('/api/schedule');
  assert.equal(calls, 0);
  const [initial, second] = await Promise.all([read(), read()]);
  assert.equal(calls, 1);
  assert.equal(initial.available, true);
  assert.deepEqual(initial.posts, second.posts);
  assert.deepEqual(initial.posts.map(({ id }) => id), [mikoPost.id, inaPost.id]);
  assert.equal(initial.posts[1].url, `https://x.com/ninomaeinanis/status/${inaPost.id}`);
  assert.equal(initial.updatedAt, new Date(time).toISOString());

  assert.equal((await request(`/api/channels/${inaId}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await read('?refresh=1')).posts.map(({ id }) => id), [mikoPost.id]);
  assert.equal(calls, 1);
  time += 30 * minute;
  const stale = await read();
  assert.equal(calls, 2);
  assert.match(stale.warning, /取得制限/);
  assert.equal(stale.updatedAt, initial.updatedAt);
  assert.deepEqual(stale.posts.map(({ id }) => id), [mikoPost.id]);
  time += 30 * minute;
  assert.equal((await read()).warning, stale.warning);
  assert.equal(calls, 2);
});
