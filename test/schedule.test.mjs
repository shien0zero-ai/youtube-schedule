import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/server.mjs';

const hour = 3600000;
const baseTime = Date.parse('2026-11-20T09:30:00Z');
const official = { id: 'official', name: '公式タレント', url: 'https://www.youtube.com/@official', group: 'hololive JP' };
const custom = { name: '追加テスト', channelId: 'UCcustom' };

function stream(id, status, startOffset, endOffset = null) {
  return {
    id, title: id, status,
    startAt: new Date(baseTime + startOffset * hour).toISOString(),
    endAt: endOffset === null ? null : new Date(baseTime + endOffset * hour).toISOString(),
    url: `https://www.youtube.com/watch?v=${id}`,
  };
}

function providers() {
  return {
    getHololive: async () => ({
      channels: [official],
      streams: [
        stream('old', 'past', -30, -25),
        stream('recent', 'past', -26, -23),
        stream('on-air', 'live', -1),
        stream('next', 'upcoming', 2),
      ].map((item) => ({ ...item, channelId: official.id })),
    }),
    normalizeChannelUrl: (url) => {
      if (url !== 'https://www.youtube.com/@custom' && url !== 'https://www.youtube.com/@other') {
        throw new Error('Invalid URL');
      }
      return url;
    },
    getYouTubeChannel: async () => ({ ...custom, streams: [stream('custom-next', 'upcoming', 5)] }),
  };
}

async function startApp(t, options) {
  const { server } = createApp(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return (path, method = 'GET', payload) => fetch(origin + path, {
    method,
    ...(payload === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  });
}

test('schedule API exposes all statuses and persists selected retention and added channels', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'youtube-schedule-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'schedule.json');
  let time = baseTime;
  const options = { file, providers: providers(), now: () => time };
  const request = await startApp(t, options);

  const initial = await (await request('/api/schedule')).json();
  assert.deepEqual(initial.streams.map(({ id }) => id), ['recent', 'on-air', 'next']);
  assert.deepEqual(initial.streams.map(({ status }) => status), ['past', 'live', 'upcoming']);
  assert.equal(initial.channels[0].keepPast, false);

  assert.equal((await request('/api/channels/official', 'PATCH', { keepPast: true })).status, 200);
  assert.equal((await request('/api/channels', 'POST', { url: 'https://www.youtube.com/@custom' })).status, 201);
  assert.equal((await request('/api/channels', 'POST', { url: 'https://www.youtube.com/@custom' })).status, 409);
  assert.equal((await request('/api/channels', 'POST', { url: 'https://www.youtube.com/@other' })).status, 409);
  assert.equal((await request('/api/channels', 'POST', { url: 'https://example.com/@custom' })).status, 400);

  time += 2 * hour;
  const restarted = await startApp(t, options);
  const snapshot = await (await restarted('/api/schedule')).json();
  assert.equal(snapshot.channels.find(({ id }) => id === official.id).keepPast, true);
  assert.equal(snapshot.channels.find(({ id }) => id === custom.channelId).custom, true);
  assert.ok(snapshot.streams.some(({ id }) => id === 'recent'));
  assert.ok(snapshot.streams.some(({ id }) => id === 'custom-next'));
  assert.ok(snapshot.streams.some(({ id }) => id === 'old'));

  assert.equal((await restarted('/api/channels/official', 'PATCH', { keepPast: false })).status, 200);
  assert.equal((await restarted('/api/channels/UCcustom', 'DELETE')).status, 200);
  const after = await (await restarted('/api/schedule')).json();
  assert.deepEqual(after.streams.map(({ id }) => id), ['on-air', 'next']);
  assert.equal(after.channels.length, 1);
});

test('schedule keeps cached data and displays warnings during an upstream failure', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'youtube-schedule-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let time = baseTime;
  let available = true;
  const sources = providers();
  const { getHololive } = sources;
  sources.getHololive = async () => {
    if (!available) return { channels: [official], streams: [], scheduleAvailable: false, warning: 'source unavailable' };
    return getHololive();
  };

  const request = await startApp(t, { file: join(dir, 'schedule.json'), providers: sources, now: () => time });
  const initial = await (await request('/api/schedule')).json();
  available = false;
  time += 20_000;
  const cached = await (await request('/api/schedule?refresh=1')).json();
  assert.deepEqual(cached.warnings, ['source unavailable']);
  assert.deepEqual(cached.streams, initial.streams);
  assert.equal(cached.updatedAt, initial.updatedAt);
});
