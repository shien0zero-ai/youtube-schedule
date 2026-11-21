import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/server.mjs';
import { createMusicVideoCatalog } from '../src/music-videos.mjs';
import { musicVideoArchives } from '../src/data/music-video-archives.mjs';

const miko = { id: 'UC-hM6YJuNYVAmUWxeIr9FeA', name: 'さくらみこ', group: 'ホロライブ JP' };
const officialFlowGlow = 'UCu2n3qHuOuQIygREMnWeQWg';
const outside = { id: 'UC1234567890123456789012', name: '対象外', group: 'ホロスターズ' };
const currentTime = Date.parse('2026-11-21T02:00:00Z');
const planned = { id: 'scheduledMV', channelId: miko.id, platform: 'youtube', title: '【MV】新曲',
  status: 'upcoming', startAt: '2026-11-21T11:00:00Z' };

test('MV details load only on demand and include only qualifying scoped Holodule listings', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'haishin-mv-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const concerts = { ...planned, id: 'notMusicVid', title: '【3D LIVE】生誕祭' };
  const outsiders = { ...planned, id: 'notInRoster', channelId: outside.id };
  const unlisted = { ...planned, id: 'anotherMVxx' };
  const groupUpload = { ...planned, id: 'groupVideo1', channelId: 'holodule-unit', uploaderChannelId: officialFlowGlow };
  const { server, schedule } = createApp({
    file: join(dir, 'schedule.json'), now: () => currentTime,
    providers: { getHololive: async () => ({ channels: [miko, outside],
      streams: [planned, concerts, outsiders, unlisted, groupUpload],
      holoduleIds: [planned.id, concerts.id, outsiders.id, groupUpload.id], scheduleAvailable: true,
    }) },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const read = async (query) => (await fetch(`${origin}/api/schedule${query}`)).json();

  const compact = await read('?special=0');
  assert.equal(Object.hasOwn(compact, 'musicVideos'), false);
  assert.equal(compact.musicVideosCount, musicVideoArchives.length + 2);
  const full = await read('?special=0&mv=1');
  const upcoming = full.musicVideos.filter(({ status }) => status === 'upcoming');
  assert.equal(full.musicVideosCount, full.musicVideos.length);
  assert.deepEqual(upcoming.map(({ id, channelId, viewCount }) => ({ id, channelId, viewCount })), [
    { id: planned.id, channelId: miko.id, viewCount: null },
    { id: groupUpload.id, channelId: officialFlowGlow, viewCount: null },
  ]);
  schedule.removeChannel(miko.id);
  assert.ok((await read('?mv=1')).musicVideos.every(({ channelId }) => channelId !== miko.id));
});

test('saves Holodule premieres, fills view counts from YouTube and keeps a separate fallback archive after restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'haishin-mv-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let time = currentTime;
  let uploadCalls = 0;
  const released = { ...planned, id: 'newytvideo1', title: '初公開 Official Music Video',
    status: 'past', startAt: '2026-11-20T11:00:00Z', publishedAt: '2026-11-20T11:00:00Z', viewCount: 201 };
  const [seedId, channelId, publishedAt, title] = musicVideoArchives[0];
  const options = {
    scheduleFile: join(dir, 'schedule.json'), now: () => time,
    getRecentMusicVideos: async (ids) => {
      uploadCalls++;
      assert.ok(ids.length <= 6);
      return [{ ...planned, startAt: '2026-11-21T10:00:00Z', viewCount: 0 }, released];
    },
    getMusicVideos: async (ids, { includeKnown }) => {
      assert.ok(includeKnown);
      return ids.includes(seedId) ? [{ id: seedId, channelId, title, status: 'past', startAt: publishedAt,
        publishedAt, viewCount: 999999 }] : [];
    },
  };
  const library = createMusicVideoCatalog(options);
  library.observeHolodule({ holoduleIds: [planned.id], streams: [planned] });
  await Promise.all([library.refresh(), library.refresh()]);
  await library.refresh();
  assert.equal(uploadCalls, 1);
  const latest = library.snapshot(new Set(), true).musicVideos;
  assert.equal(latest.find(({ id }) => id === planned.id).startAt, planned.startAt);
  assert.equal(latest.find(({ id }) => id === planned.id).viewCount, 0);
  assert.equal(latest.find(({ id }) => id === seedId).viewCount, 999999);

  time += 5 * 86400000;
  const restarted = createMusicVideoCatalog(options);
  restarted.observeHolodule({ holoduleIds: [], streams: [] });
  const reloaded = restarted.snapshot(new Set(), true).musicVideos;
  assert.equal(reloaded.find(({ id }) => id === seedId).viewCount, 999999);
  assert.equal(reloaded.find(({ id }) => id === released.id).viewCount, 201);
  assert.equal(reloaded.filter(({ id }) => id === planned.id).length, 1);
  assert.equal(reloaded.find(({ id }) => id === planned.id).archiveUnconfirmed, true);
});

test('ranks MV view gains using real observations on different Japanese dates within seven days', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'haishin-mv-trends-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const minute = 60_000;
  let time = Date.parse('2026-11-21T14:55:00Z');
  const video = { ...planned, title: '新曲 Official Music Video', musicKind: 'original', likeCount: 0, viewCount: 100 };
  const options = {
    scheduleFile: join(dir, 'schedule.json'), now: () => time,
    getRecentMusicVideos: async () => [video],
  };
  let library = createMusicVideoCatalog(options);
  const snapshot = () => library.snapshot(new Set(), true).musicVideos.find(({ id }) => id === video.id);
  await library.refresh();
  assert.equal(snapshot().viewGain7d, null);
  assert.equal(snapshot().likeCount, 0);
  assert.equal(snapshot().musicKind, 'original');
  assert.equal(snapshot().memberReading, 'さくらみこ');
  assert.equal(Object.hasOwn(snapshot(), 'viewHistory'), false);

  time += 2 * minute;
  video.viewCount = 120;
  await library.refresh();
  assert.equal(snapshot().viewGain7d, null);

  time += 5 * minute;
  library.observeHolodule({ holoduleIds: [video.id], streams: [{ ...video, viewCount: 1234 }] });
  assert.equal(snapshot().viewCount, 120);
  assert.equal(snapshot().viewGain7d, null);
  Object.assign(video, { viewCount: 170, likeCount: 5 });
  await library.refresh();
  assert.equal(snapshot().viewGain7d, 50);
  assert.equal(snapshot().likeCount, 5);

  library = createMusicVideoCatalog(options);
  assert.equal(snapshot().viewGain7d, 50);
  time += 2 * minute;
  Object.assign(video, { viewCount: null, likeCount: null });
  await library.refresh();
  assert.equal(snapshot().viewGain7d, 50);
  assert.equal(snapshot().likeCount, 5);

  time += 7 * 24 * 60 * minute;
  assert.equal(snapshot().viewGain7d, null);
  video.viewCount = 500;
  await library.refresh();
  assert.equal(snapshot().viewGain7d, null);
});

test('retains older MV catalogs and fills missing seed stats and song types', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'haishin-mv-legacy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const [id, channelId, publishedAt, title, , likeCount, musicKind] = musicVideoArchives[0];
  const legacy = { id, channelId, startAt: publishedAt, title, status: 'past', viewCount: 999_999, youtubeConfirmed: true };
  await writeFile(join(dir, 'schedule-mv.json'), JSON.stringify({ videos: [legacy] }));
  const library = createMusicVideoCatalog({ scheduleFile: join(dir, 'schedule.json'), now: () => currentTime });
  const video = library.snapshot(new Set(), true).musicVideos.find((video) => video.id === id);
  assert.equal(video.viewCount, legacy.viewCount);
  assert.equal(video.viewGain7d, null);
  assert.equal(video.likeCount, likeCount);
  assert.equal(video.musicKind, musicKind);
});
