import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
