import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    id, title: id, status, isBroadcast: true,
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
  assert.deepEqual(initial.streams.map(({ id }) => id), ['old', 'recent', 'on-air', 'next']);
  assert.deepEqual(initial.streams.map(({ status }) => status), ['past', 'past', 'live', 'upcoming']);
  assert.equal(initial.channels[0].keepPast, true);

  assert.equal((await request('/api/channels/official', 'PATCH', { keepPast: true })).status, 200);
  assert.equal((await request('/api/channels', 'POST', { url: 'https://www.youtube.com/@custom' })).status, 201);
  assert.equal((await request('/api/channels', 'POST', { url: 'https://www.youtube.com/@custom' })).status, 409);
  assert.equal((await request('/api/channels', 'POST', { url: 'https://www.youtube.com/@other' })).status, 409);
  assert.equal((await request('/api/channels', 'POST', { url: 'https://example.com/@custom' })).status, 400);
  assert.equal((await request('/api/channels/official', 'DELETE')).status, 200);

  time += 2 * hour;
  const restarted = await startApp(t, options);
  const hidden = await (await restarted('/api/schedule')).json();
  assert.equal(hidden.channels.find(({ id }) => id === official.id).hidden, true);
  assert.deepEqual(hidden.streams.map(({ id }) => id), ['custom-next']);
  assert.equal((await restarted('/api/channels/official', 'PATCH', { hidden: false })).status, 200);
  const snapshot = await (await restarted('/api/schedule')).json();
  assert.equal(snapshot.channels.find(({ id }) => id === official.id).hidden, false);
  assert.equal(snapshot.channels.find(({ id }) => id === official.id).keepPast, true);
  assert.equal(snapshot.channels.find(({ id }) => id === custom.channelId).custom, true);
  assert.equal(snapshot.channels.find(({ id }) => id === custom.channelId).keepPast, true);
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

test('includes nicknames and readings for cached channels and catalog-only talent', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'youtube-schedule-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'schedule.json');
  await writeFile(file, JSON.stringify({
    roster: [
      { id: 'UCHsx4Hqa-1ORjQTh9TYDhww', name: 'Takanashi Kiara', group: 'ホロライブ EN' },
      { id: 'UCP0BspO_AMEe3aQqqpo89Dg', name: 'Moona Hoshinova', group: 'ホロライブ ID' },
      { id: 'UC1DCedRgGHBdm81E1llLhOQ', name: 'Pekora Ch.', group: 'ホロライブ JP', aliases: ['以前の別名'] },
    ],
    custom: [], preferences: {}, streams: [],
  }));
  const request = await startApp(t, { file, providers: { getHololive: async () => null } });
  const compact = await (await request('/api/schedule?special=0')).json();
  const { channels } = compact;
  assert.ok(channels[0].aliases.includes('タカナシキアラ'));
  assert.ok(channels[1].aliases.includes('ムーナ・ホシノヴァ'));
  for (const alias of ['兎田ぺこら', 'うさだぺこら', 'ぺこーら', '以前の別名']) {
    assert.ok(channels[2].aliases.includes(alias));
  }
  assert.equal(compact.catalogChannels, undefined);

  const full = await (await request('/api/schedule?mv=1')).json();
  const suiseiId = 'UC5CwaMl1eIgY8h02uZw7u8A';
  assert.deepEqual(full.channels, channels);
  assert.ok(full.specialLives.some(({ channelId }) => channelId === suiseiId));
  assert.ok(full.musicVideos.some(({ channelId }) => channelId === suiseiId));
  const suisei = full.catalogChannels.find(({ id }) => id === suiseiId);
  assert.equal(suisei.name, '星街すいせい');
  assert.ok(suisei.aliases.includes('すいちゃん'));
  assert.ok(suisei.aliases.includes('ほしまちすいせい'));
  assert.equal(full.catalogChannels.filter(({ id }) => id === suiseiId).length, 1);
});

test('shows listed older Hololive cards and preserves a saved opt-out after listings change', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'youtube-schedule-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'schedule.json');
  await writeFile(file, JSON.stringify({ roster: [official], custom: [], preferences: { [official.id]: false }, streams: [] }));
  let time = baseTime;
  let feed = 'listed';
  const unit = { id: 'holodule-regloss', name: 'ReGLOSS', group: 'ホロジュール', holodule: true, holoduleScope: 'hololive' };
  const sources = providers();
  sources.getHololive = async () => ({
    channels: feed === 'listed' ? [official, unit] : [official],
    streams: feed === 'listed' ? [
      { ...stream('unit-old', 'past', -32, -29), channelId: unit.id },
      { ...stream('official-old', 'past', -32, -28), channelId: official.id },
    ] : [],
    holoduleIds: feed === 'listed' ? ['unit-old', 'official-old'] : [],
    scheduleAvailable: feed !== 'offline',
  });

  const request = await startApp(t, { file, providers: sources, now: () => time });
  const initial = await (await request('/api/schedule')).json();
  assert.deepEqual(initial.streams.map(({ id }) => id), ['unit-old', 'official-old']);
  assert.equal(initial.channels.find(({ id }) => id === official.id).keepPast, false);

  feed = 'offline';
  time += 20_000;
  const cached = await (await request('/api/schedule?refresh=1')).json();
  assert.deepEqual(cached.streams.map(({ id }) => id), ['unit-old', 'official-old']);

  feed = 'empty';
  time += 20_000;
  const after = await (await request('/api/schedule?refresh=1')).json();
  assert.deepEqual(after.streams.map(({ id }) => id), ['unit-old']);
  assert.equal(after.channels.find(({ id }) => id === unit.id).keepPast, true);
});

test('archives elapsed listings after restart, preserves withdrawn plans, and refreshes restored entries', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'youtube-schedule-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'schedule.json');
  let time = baseTime;
  let feed = 'listed';
  const completed = { ...stream('completed', 'past', -30, -29), channelId: official.id };
  const live = { ...stream('live', 'live', -1), channelId: official.id };
  const scheduled = { ...stream('scheduled', 'upcoming', 2), channelId: official.id };
  const untimed = { ...stream('untimed', 'upcoming', 2), channelId: official.id, startAt: null, scheduleDate: '2026-11-20' };
  const original = [completed, live, scheduled, untimed];
  const published = { ...scheduled, status: 'past', endAt: new Date(baseTime + 3 * hour).toISOString() };
  const sources = providers();
  sources.getHololive = async () => {
    const streams = feed === 'listed' ? original : feed === 'published' ? [published] : [];
    return {
      channels: [official], streams, scheduleAvailable: feed !== 'offline',
      updatedChannelIds: [official.id], holoduleIds: streams.map(({ id }) => id),
    };
  };
  const options = { file, providers: sources, now: () => time };
  const request = await startApp(t, options);
  const first = await (await request('/api/schedule')).json();
  assert.deepEqual(first.streams, original);

  feed = 'offline';
  time += 20_000;
  const unavailable = await (await request('/api/schedule?refresh=1')).json();
  assert.deepEqual(unavailable.streams, original);

  feed = 'empty';
  time += 20_000;
  const noLongerListed = await (await request('/api/schedule?refresh=1')).json();
  const unconfirmedLive = { ...live, status: 'past', archiveUnconfirmed: true };
  assert.deepEqual(noLongerListed.streams, [completed, unconfirmedLive]);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).streams.find(({ id }) => id === scheduled.id), {
    ...scheduled, missingFromSource: true,
  });

  time += 4 * 24 * hour;
  const restarted = await startApp(t, options);
  const history = await (await restarted('/api/schedule')).json();
  assert.deepEqual(history.streams, [completed, unconfirmedLive,
    { ...scheduled, status: 'past', archiveUnconfirmed: true },
    { ...untimed, status: 'past', archiveUnconfirmed: true },
  ]);

  feed = 'published';
  time += 20_000;
  const updated = await (await restarted('/api/schedule?refresh=1')).json();
  assert.deepEqual(updated.streams.find(({ id }) => id === scheduled.id), published);
});

test('distinguishes the time a broadcast was seen to have ended from its actual end time', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'youtube-schedule-end-time-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let time = Date.parse('2026-11-22T14:59:00Z');
  let current = { ...stream('late-stream', 'live', 0), channelId: official.id, startAt: '2026-11-22T14:00:00.000Z' };
  const request = await startApp(t, {
    file: join(dir, 'schedule.json'), now: () => time,
    providers: { getHololive: async () => ({ channels: [official], streams: [current] }) },
  });
  const read = async () => (await (await request('/api/schedule?refresh=1')).json()).streams[0];
  await read();

  time += 2 * 60_000;
  current = { ...current, status: 'past' };
  assert.equal((await read()).endAtEstimated, true);
  time += 2 * 60_000;
  const archived = await read();
  assert.equal(archived.endAt, '2026-11-22T15:01:00.000Z');
  assert.equal(archived.endAtEstimated, true);

  time += 2 * 60_000;
  current = { ...current, endAt: '2026-11-22T14:59:30.000Z' };
  const confirmed = await read();
  assert.equal(confirmed.endAt, current.endAt);
  assert.equal(confirmed.endAtEstimated, undefined);
});

test('withholds unscoped Holodule cache and restores saved history for verified Hololive channels', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'youtube-schedule-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'schedule.json');
  const unit = { id: 'holodule-regloss', name: 'ReGLOSS', group: 'ホロジュール', holodule: true };
  const stars = { id: 'holodule-holostars', name: 'ホロスターズ', group: 'ホロジュール', holodule: true };
  await writeFile(file, JSON.stringify({
    roster: [official, unit, stars], custom: [],
    preferences: { [unit.id]: true, [stars.id]: true },
    streams: [
      { ...stream('unit-history', 'past', -32, -29), channelId: unit.id },
      { ...stream('stars-history', 'past', -32, -29), channelId: stars.id },
    ],
  }));

  let time = baseTime;
  let available = false;
  const sources = providers();
  sources.getHololive = async () => ({
    channels: available ? [official, { ...unit, holoduleScope: 'hololive' }] : [official],
    streams: [],
    scheduleAvailable: available,
  });
  const request = await startApp(t, { file, providers: sources, now: () => time });

  const cached = await (await request('/api/schedule')).json();
  assert.deepEqual(cached.channels.map(({ id }) => id), [official.id]);
  assert.deepEqual(cached.streams, []);

  available = true;
  time += 20_000;
  const updated = await (await request('/api/schedule?refresh=1')).json();
  assert.deepEqual(updated.channels.map(({ id }) => id), [official.id, unit.id]);
  assert.equal(updated.channels.find(({ id }) => id === unit.id).keepPast, true);
  assert.deepEqual(updated.streams.map(({ id }) => id), ['unit-history']);
});

test('filters cached and current uploads while recovering real broadcast titles without erasing history', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'youtube-schedule-lives-only-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'schedule.json');
  const archive = { ...stream('liveArchive', 'past', -30, -29), channelId: official.id,
    isBroadcast: undefined, title: `${official.name} の配信`, holoduleTitle: `${official.name} の配信` };
  const ordinary = { ...stream('oldUpload01', 'past', -30, -29), channelId: official.id, isBroadcast: undefined };
  const legacyShort = { ...stream('oldShort001', 'past', -30), channelId: official.id, isBroadcast: undefined, title: '切り抜き #Shorts' };
  await writeFile(file, JSON.stringify({ roster: [official], custom: [], preferences: {}, streams: [archive, ordinary, legacyShort] }));

  let now = baseTime;
  const shown = { ...stream('newActual01', 'upcoming', 2), channelId: official.id, title: '今夜のゲーム配信' };
  const premiere = { ...stream('premiere001', 'upcoming', 3), channelId: official.id, isBroadcast: false };
  const uncertain = { ...stream('notChecked1', 'upcoming', 4), channelId: official.id, isBroadcast: null };
  const request = await startApp(t, {
    file, now: () => now,
    providers: {
      getHololive: async () => ({ channels: [official], streams: [shown, premiere, uncertain],
        holoduleIds: [shown.id, premiere.id, uncertain.id], scheduleAvailable: true }),
      getYouTubeVideos: async (ids) => {
        assert.deepEqual(ids, [archive.id, ordinary.id]);
        return [
          { ...archive, title: '昔の配信タイトル', isBroadcast: null, durationSeconds: 3600 },
          { id: ordinary.id, title: '通常の投稿', isBroadcast: false },
        ];
      },
    },
  });

  const first = await (await request('/api/schedule')).json();
  assert.deepEqual(first.streams.map(({ id, title }) => [id, title]), [[archive.id, '昔の配信タイトル'], [shown.id, shown.title]]);
  assert.ok(JSON.parse(await readFile(file, 'utf8')).streams.some(({ id, isBroadcast }) => id === ordinary.id && isBroadcast === false));
  shown.title = `${official.name} の配信`;
  now += 20_000;
  const second = await (await request('/api/schedule?refresh=1')).json();
  assert.equal(second.streams.find(({ id }) => id === shown.id).title, '今夜のゲーム配信');
});

test('fills missing titles on page load and retries misses immediately on manual update', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'youtube-schedule-title-retry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'schedule.json');
  const archive = { ...stream('liveArchive', 'past', -30, -29), channelId: official.id, title: `${official.name} の配信` };
  await writeFile(file, JSON.stringify({ roster: [official], custom: [], preferences: {}, streams: [archive] }));
  const ongoing = { ...stream('noTitleLive', 'live', -1), channelId: official.id, title: null };
  const unknown = { ...stream('notVerified', 'upcoming', 3), channelId: official.id, title: null, isBroadcast: null };
  const known = { ...stream('knownTitle1', 'upcoming', 4), channelId: official.id, title: '取得済みのタイトル' };
  const attempts = [];
  const refreshes = [];
  const request = await startApp(t, {
    file, now: () => baseTime,
    providers: {
      getHololive: async ({ force }) => {
        refreshes.push(force);
        return { channels: [official], streams: [ongoing, unknown, known] };
      },
      getYouTubeTitles: async (ids) => {
        attempts.push(ids);
        return ids.length > 1 ? [
          { id: archive.id, title: 'アーカイブの正式タイトル' }, { id: unknown.id, title: '配信かどうか未確認' },
        ] : [{ id: ongoing.id, title: '配信中の正式タイトル' }];
      },
    },
  });
  const read = async (query = '') => (await (await request('/api/schedule' + query)).json()).streams;
  const first = await read();
  assert.deepEqual(attempts, [[ongoing.id, unknown.id, archive.id]]);
  assert.deepEqual(first.map(({ id, title }) => [id, title]), [
    [archive.id, 'アーカイブの正式タイトル'], [ongoing.id, null], [known.id, known.title],
  ]);
  assert.deepEqual(await read(), first);
  assert.equal(attempts.length, 1);

  const updated = await read('?refresh=1');
  assert.deepEqual(refreshes, [false]);
  assert.deepEqual(attempts.at(-1), [ongoing.id]);
  assert.equal(updated.find(({ id }) => id === ongoing.id).title, '配信中の正式タイトル');
  assert.equal(updated.find(({ id }) => id === ongoing.id).status, 'live');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).streams.find(({ id }) => id === ongoing.id).title, '配信中の正式タイトル');
});

test('queues a manual title retry behind a scheduled lookup in progress', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'youtube-schedule-title-inflight-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ongoing = { ...stream('noTitleLive', 'live', -1), channelId: official.id, title: null };
  const started = Promise.withResolvers();
  const first = Promise.withResolvers();
  let lookups = 0;
  const { schedule } = createApp({
    file: join(dir, 'schedule.json'), now: () => baseTime,
    providers: {
      getHololive: async () => ({ channels: [official], streams: [ongoing] }),
      getYouTubeTitles: async () => {
        if (++lookups === 1) {
          started.resolve();
          return first.promise;
        }
        return [{ id: ongoing.id, title: '再取得したタイトル' }];
      },
    },
  });
  const scheduled = schedule.refresh();
  await started.promise;
  const manual = schedule.refresh(true);
  first.resolve([]);
  await Promise.all([scheduled, manual]);
  assert.equal(lookups, 2);
  assert.equal(schedule.snapshot().streams[0].title, '再取得したタイトル');
});
