import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/server.mjs';

const channel = { id: 'official', name: '公式タレント', group: 'hololive JP' };
const time = Date.parse('2026-11-20T17:00:00Z');

async function startApp(t, options) {
  const { server } = createApp(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async () => (await fetch(`${origin}/api/schedule`)).json();
  const importArchives = (body, type = 'application/json') => fetch(`${origin}/api/archives`, {
    method: 'POST', headers: { 'Content-Type': type },
    body: type === 'application/json' ? JSON.stringify({ entries: body }) : body,
  });
  return { get, importArchives, origin };
}

test('registers old links and UTF-8 CSV archives, deduplicates video URLs, and keeps them after restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'haishin-archives-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let officialStreams = [];
  const options = {
    file: join(dir, 'schedule.json'), now: () => time,
    providers: { getHololive: async () => ({ channels: [channel], streams: officialStreams }) },
  };
  const app = await startApp(t, options);
  await app.get();
  const settings = await fetch(`${app.origin}/api/channels/official`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keepPast: false }),
  });
  assert.equal(settings.status, 200);

  const row = { date: '2020-01-31', channel: channel.id, url: 'https://youtu.be/archive1234?t=10' };
  const manual = await app.importArchives([row]);
  assert.equal(manual.status, 201);
  assert.deepEqual(await manual.json(), { added: 1, skipped: 0 });

  const csv = '\uFEFFdate,channel,title,url\r\n' +
    '2020-01-31,公式タレント,重複,https://www.youtube.com/live/archive1234\r\n' +
    '2026-11-21,公式タレント,"歌枠, ""Part 2""\nアンコール",https://example.org/archive\r\n';
  const bulk = await app.importArchives(csv, 'text/csv; charset=utf-8');
  assert.equal(bulk.status, 201);
  assert.deepEqual(await bulk.json(), { added: 1, skipped: 1 });

  officialStreams = [{
    id: 'archive1234', channelId: channel.id, title: '配信元のタイトル', url: 'https://www.youtube.com/watch?v=archive1234',
    status: 'past', startAt: null, endAt: null,
  }];
  const restarted = await startApp(t, options);
  const data = await restarted.get();
  assert.equal(data.channels[0].keepPast, false);
  assert.deepEqual(data.streams.map(({ title, scheduleDate, startAt, url }) => ({ title, scheduleDate, startAt, url })), [
    { title: '配信元のタイトル', scheduleDate: '2020-01-31', startAt: null, url: 'https://www.youtube.com/watch?v=archive1234' },
    { title: '歌枠, "Part 2"\nアンコール', scheduleDate: '2026-11-21', startAt: null, url: 'https://example.org/archive' },
  ]);
});

test('rejects invalid archive batches without saving their valid rows', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'haishin-archives-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const app = await startApp(t, {
    file: join(dir, 'schedule.json'), now: () => time,
    providers: { getHololive: async () => ({ channels: [channel], streams: [] }) },
  });
  await app.get();
  const valid = { date: '2020-01-31', channel: channel.id, url: 'https://youtu.be/archive1234' };
  for (const entry of [{ date: '2026-11-22' }, { date: '2020-02-30' }, { channel: 'unknown' }, { url: 'javascript:alert(1)' }]) {
    const response = await app.importArchives([valid, { ...valid, ...entry }]);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /2 件目/);
  }
  for (const csv of ['unexpected,header', 'date,channel,title,url\n2020-01-31,official,"unclosed', Buffer.from([255, 254, 0])]) {
    const response = await app.importArchives(csv, 'text/csv');
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /CSV/);
  }
  assert.deepEqual((await app.get()).streams, []);
});
