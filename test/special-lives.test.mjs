import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createScheduleService } from '../src/schedule.mjs';
import { initialSpecialLives, specialLiveChannelIds } from '../src/special-lives.mjs';
import { specialLiveArchives } from '../src/data/special-live-archives.mjs';

const miko = { id: 'UC-hM6YJuNYVAmUWxeIr9FeA', name: 'さくらみこ', group: 'ホロライブ JP' };
const stars = { id: 'holostars', name: 'ホロスターズ', group: 'ホロスターズ' };
const baseTime = Date.parse('2026-11-21T02:00:00Z');
const day = 86400000;

function live(id, channelId, title, status = 'upcoming') {
  return {
    id, channelId, title, status, startAt: '2026-11-21T11:00:00.000Z',
    endAt: status === 'past' ? '2026-11-21T12:00:00.000Z' : null,
    url: `https://www.youtube.com/watch?v=${id}`,
  };
}

test('the manually researched catalog has unique watch IDs, known channels, and JST dates', () => {
  assert.equal(initialSpecialLives.size, specialLiveArchives.length);
  assert.ok(initialSpecialLives.size > 20);
  for (const entry of initialSpecialLives.values()) {
    assert.match(entry.id, /^[\w-]{11}$/);
    assert.equal(entry.url, `https://www.youtube.com/watch?v=${entry.id}`);
    assert.ok(specialLiveChannelIds.has(entry.channelId));
    assert.match(entry.scheduleDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(entry.status, 'past');
  }
});

test('only qualifying Holodule listings enter the 3D tab and are kept after feed removal and restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'haishin-3d-lives-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'schedule.json');
  let time = baseTime;
  const birthday = live('birthday123', miko.id, '誕生日ライブ');
  const anniversary = live('annivers123', miko.id, '周年記念 3Dライブ');
  const karaoke = live('karaoke1234', miko.id, '3Dライブ直前の歌枠');
  const male = live('noteligible', stars.id, '生誕3Dライブ');
  const youtubeOnly = live('youtubeonly', miko.id, '大型3Dコンサート');
  let source = {
    channels: [miko, stars], streams: [birthday, anniversary, karaoke, male, youtubeOnly],
    holoduleIds: [birthday.id, anniversary.id, karaoke.id, male.id], scheduleAvailable: true,
  };
  const open = () => createScheduleService({ file, getHololive: async () => source, now: () => time });
  const schedule = open();
  await schedule.refresh();
  assert.deepEqual(schedule.snapshot().specialLives.filter(({ status }) => status === 'upcoming').map(({ id }) => id), [birthday.id, anniversary.id]);

  schedule.setKeepPast(miko.id, false);
  time += day;
  source = { ...source, streams: [live(birthday.id, miko.id, birthday.title, 'past')], holoduleIds: [birthday.id] };
  await schedule.refresh();

  time += 4 * day;
  source = { ...source, streams: [], holoduleIds: [] };
  const restarted = open();
  await restarted.refresh();
  const restored = restarted.snapshot();
  assert.equal(restored.streams.some(({ id }) => id === birthday.id), false);
  assert.equal(restored.specialLives.find(({ id }) => id === birthday.id).url, birthday.url);
  assert.equal(restored.specialLives.find(({ id }) => id === birthday.id).status, 'past');
  assert.equal(restored.specialLives.find(({ id }) => id === anniversary.id).archiveUnconfirmed, true);
  assert.ok(restored.specialLives.some(({ id }) => id === 'B3OxuRMofcM'));

  restarted.removeChannel(miko.id);
  assert.ok(restarted.snapshot().specialLives.every(({ channelId }) => channelId !== miko.id));
  restarted.restoreChannel(miko.id);
  assert.ok(restarted.snapshot().specialLives.some(({ id }) => id === birthday.id));
});

test('manual 3D uploads require an eligible channel and stay in the dedicated history', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'haishin-3d-manual-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'schedule.json');
  const open = () => createScheduleService({
    file, getHololive: async () => ({ channels: [miko, stars], streams: [], scheduleAvailable: true }), now: () => baseTime,
  });
  const schedule = open();
  await schedule.refresh();
  const archive = { date: '2024-02-09', channel: miko.id, title: '以前の3Dライブ', url: 'https://youtu.be/archive1234', specialLive: true };
  assert.throws(() => schedule.addArchives([archive, { ...archive, channel: stars.id }]), { statusCode: 400 });
  assert.equal(schedule.snapshot().specialLives.some(({ id }) => id === 'archive1234'), false);
  assert.deepEqual(schedule.addArchives([archive, archive]), { added: 1, skipped: 1 });
  assert.deepEqual(schedule.addArchives([{ ...archive, url: 'https://youtu.be/B3OxuRMofcM' }]), { added: 0, skipped: 1 });

  const restarted = open();
  await restarted.refresh();
  const snapshot = restarted.snapshot();
  assert.equal(snapshot.streams.some(({ id }) => id === 'archive1234'), false);
  const saved = snapshot.specialLives.find(({ id }) => id === 'archive1234');
  assert.equal(saved.scheduleDate, '2024-02-09');
  assert.equal(saved.title, archive.title);
  assert.equal(saved.url, 'https://www.youtube.com/watch?v=archive1234');
});
