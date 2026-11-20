import assert from 'node:assert/strict';
import test from 'node:test';
import { getHololive, parseOfficialSchedule } from '../src/hololive.mjs';

const now = () => Date.parse('2026-12-31T16:00:00Z');
const soraId = 'UCp6993wxpyDPHUpavwDFqgg';

function card(id, name, time, attrs = '', href = `https://www.youtube.com/watch?v=${id}`) {
  return `<a class="thumbnail" href="${href}" ${attrs}>
    <div class="container">
      <div class="text-left datetime"><img alt=""> ${time}</div>
      <div class="text-right name">${name}</div>
    </div>
  </a>`;
}

function schedule(body) {
  return `<!doctype html><div class="tab-pane show active" id="all">${body}</div>`;
}

test('reads JST date groups across New Year, live indicators and public YouTube channel cards', () => {
  const rows = parseOfficialSchedule(schedule(`
    <div class="holodule navbar-text">12/31 (木)</div>
    ${card('archive1234', 'ときのそら', '23:00', 'title="Black &amp; White"')}
    <div class="holodule navbar-text">01/01 (金)</div>
    ${card('livestream1', 'Calli', '00:30', 'style="border: 3px red solid;"')}
    ${card('future12345', 'FUWAMOCO', '07:05', '', 'https://youtu.be/future12345')}
    ${card('exclude1234', 'アステル・レダ', '08:00')}
    ${card('notyoutube1', '小鳥遊キアラ', '08:00', '', 'https://example.org/livestream')}
  `), now());
  assert.deepEqual(rows.map(({ title, status, startAt }) => ({ title, status, startAt })), [
    { title: 'Black & White', status: 'past', startAt: '2026-12-31T14:00:00.000Z' },
    { title: 'Mori Calliope の配信', status: 'live', startAt: '2026-12-31T15:30:00.000Z' },
    { title: 'FUWAMOCO の配信', status: 'upcoming', startAt: '2026-12-31T22:05:00.000Z' },
  ]);
});

test('adds YouTube’s title and actual completion time to official cards', async () => {
  const id = 'archive1234';
  const result = await getHololive({
    now,
    apiKey: 'test',
    async fetchImpl(url) {
      if (url === 'https://schedule.hololive.tv/') {
        return new Response(schedule(`<div class="navbar-text holodule">12/31</div>${card(id, 'ときのそら', '23:00')}`));
      }
      assert.equal(url.hostname, 'www.googleapis.com');
      assert.equal(url.searchParams.get('id'), id);
      return Response.json({ items: [{
        id,
        snippet: { title: '年越し配信', channelId: soraId },
        liveStreamingDetails: { actualStartTime: '2026-12-31T14:50:00Z', actualEndTime: '2026-12-31T15:30:00Z' },
      }] });
    },
  });
  assert.equal(result.scheduleAvailable, true);
  assert.equal(result.warning, undefined);
  assert.equal(result.streams[0].title, '年越し配信');
  assert.equal(result.streams[0].channelId, soraId);
  assert.equal(result.streams[0].endAt, '2026-12-31T15:30:00.000Z');
});

test('distinguishes valid empty listings from failure and retains the complete roster', async () => {
  const empty = await getHololive({ fetchImpl: async () => new Response(schedule('')) });
  const blocked = await getHololive({ fetchImpl: async () => new Response('Forbidden', { status: 403 }) });
  assert.equal(empty.scheduleAvailable, true);
  assert.equal(blocked.scheduleAvailable, false);
  assert.deepEqual(empty.streams, []);
  assert.deepEqual(blocked.streams, []);
  assert.equal(empty.warning, undefined);
  assert.ok(blocked.warning);
  assert.equal(empty.channels.length, 68);
  assert.deepEqual(blocked.channels, empty.channels);
  assert.equal(empty.channels.filter(({ name }) => name === 'FUWAMOCO').length, 1);
});
