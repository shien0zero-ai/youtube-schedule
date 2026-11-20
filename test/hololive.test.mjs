import assert from 'node:assert/strict';
import test from 'node:test';
import { getHololive, parseOfficialSchedule } from '../src/hololive.mjs';

const now = () => Date.parse('2026-12-31T16:00:00Z');
const soraId = 'UCp6993wxpyDPHUpavwDFqgg';
const flagshipId = 'UCJFZiqLMntJufDCHc6bQixg';

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

function flagshipChannel(entries = []) {
  const data = {
    metadata: { channelMetadataRenderer: { title: 'hololive ホロライブ', externalId: flagshipId } },
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [{ tabRenderer: { title: 'Live', selected: true, content: entries } }],
      },
    },
  };
  return new Response(`<script>var ytInitialData = ${JSON.stringify(data)};</script>`);
}

test('reads all Holodule cards with JST dates across New Year and their booking sources', () => {
  const { streams: rows, channels } = parseOfficialSchedule(schedule(`
    <div class="holodule navbar-text">12/31 (木)</div>
    ${card('archive1234', 'ときのそら', '23:00', 'title="Black &amp; White"')}
    <div class="holodule navbar-text">01/01 (金)</div>
    ${card('livestream1', 'Calli', '00:30', 'style="border: 3px red solid;"')}
    ${card('future12345', 'FUWAMOCO', '07:05', '', 'https://youtu.be/future12345')}
    ${card('flagship123', 'ホロライブ', '09:00')}
    ${card('holoan12345', 'holoAN room', '09:05')}
    ${card('asobimela12', '熱千めら', '09:10')}
    ${card('holostars12', 'アステル・レダ', '08:00')}
    ${card('unitb123456', 'UNIT B', '10:00')}
    ${card('notyoutube1', '小鳥遊キアラ', '08:00', '', 'https://www.example.org/livestream')}
    <a class="thumbnail" href="https://www.example.org/announcement"><img src="https://schedule-static.hololive.tv/image/promo.jpg" alt="公演のお知らせ"></a>
    <a class="thumbnail" href="javascript:alert(1)" title="リンクが未定のお知らせ"></a>
  `), now());
  assert.deepEqual(rows.map(({ title, status, startAt }) => ({ title, status, startAt })), [
    { title: 'Black & White', status: 'past', startAt: '2026-12-31T14:00:00.000Z' },
    { title: 'Mori Calliope の配信', status: 'live', startAt: '2026-12-31T15:30:00.000Z' },
    { title: 'FUWAMOCO の配信', status: 'upcoming', startAt: '2026-12-31T22:05:00.000Z' },
    { title: 'ホロライブ公式 の配信', status: 'upcoming', startAt: '2027-01-01T00:00:00.000Z' },
    { title: 'holoAN room（ホロアナ） の配信', status: 'upcoming', startAt: '2027-01-01T00:05:00.000Z' },
    { title: '熱千めら の配信', status: 'upcoming', startAt: '2027-01-01T00:10:00.000Z' },
    { title: 'アステル・レダ の配信', status: 'upcoming', startAt: '2026-12-31T23:00:00.000Z' },
    { title: 'UNIT B の配信', status: 'upcoming', startAt: '2027-01-01T01:00:00.000Z' },
    { title: 'Takanashi Kiara の配信', status: 'upcoming', startAt: '2026-12-31T23:00:00.000Z' },
    { title: '公演のお知らせ', status: 'upcoming', startAt: null },
    { title: 'リンクが未定のお知らせ', status: 'upcoming', startAt: null },
  ]);
  assert.equal(rows[3].channelId, flagshipId);
  assert.equal(rows[4].channelId, 'UCozx5csNhCx1wsVq3SZVkBQ');
  const unit = channels.find(({ name }) => name === 'UNIT B');
  assert.equal(unit.holodule, true);
  assert.match(unit.id, /^holodule-[\w-]+$/);
  assert.equal(rows[7].channelId, unit.id);
  assert.equal(rows[8].platform, 'example.org');
  assert.equal(rows[8].url, 'https://www.example.org/livestream');
  assert.equal(rows[9].thumbnail, 'https://schedule-static.hololive.tv/image/promo.jpg');
  assert.equal(rows[10].url, null);
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
      if (url.hostname === 'www.youtube.com') return flagshipChannel();
      assert.equal(url.hostname, 'www.googleapis.com');
      if (url.pathname.endsWith('/channels')) {
        return Response.json({ items: [{
          id: flagshipId,
          snippet: { title: 'hololive ホロライブ' },
          contentDetails: { relatedPlaylists: { uploads: 'UUJFZiqLMntJufDCHc6bQixg' } },
        }] });
      }
      if (url.pathname.endsWith('/playlistItems')) return Response.json({ items: [] });
      assert.equal(url.searchParams.get('id'), id);
      return Response.json({ items: [{
        id,
        snippet: { title: '年越し配信', channelId: soraId },
        liveStreamingDetails: { actualStartTime: '2026-12-31T14:50:00Z', actualEndTime: '2026-12-31T15:30:00Z' },
      }] });
    },
  });
  assert.equal(result.scheduleAvailable, true);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.streams[0].title, '年越し配信');
  assert.equal(result.streams[0].channelId, soraId);
  assert.equal(result.streams[0].endAt, '2026-12-31T15:30:00.000Z');
  assert.deepEqual(result.holoduleIds, [id]);
});

test('enriches YouTube only and preserves the source label for newly discovered groups', async () => {
  const id = 'unitb123456';
  const markup = schedule(`
    <div class="navbar-text holodule">01/01</div>
    ${card(id, 'UNIT B', '08:00')}
    ${card('radiocard01', 'UNIT B', '09:00', '', 'https://www.joqr.co.jp/qr/program/example/')}
  `);
  const requests = [];
  const result = await getHololive({
    now,
    apiKey: null,
    async fetchImpl(url) {
      if (typeof url === 'string') return new Response(markup);
      if (url.pathname.endsWith('/streams')) return flagshipChannel();
      requests.push(url.searchParams.get('v'));
      const player = {
        videoDetails: { videoId: id, channelId: soraId, title: 'UNIT B allocates a stream' },
        microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { startTimestamp: '2027-01-01T01:00:00Z' } } },
      };
      return new Response(`<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script>`);
    },
  });
  assert.deepEqual(requests, [id]);
  const unit = result.channels.find(({ name }) => name === 'UNIT B');
  assert.equal(result.streams.length, 2);
  assert.ok(result.streams.every(({ channelId }) => channelId === unit.id));
  assert.deepEqual(result.holoduleIds, result.streams.map(({ id }) => id));
  assert.ok(result.updatedChannelIds.includes(unit.id));
  assert.equal(result.streams[1].platform, 'joqr.co.jp');
  assert.equal(
    parseOfficialSchedule(markup, now()).channels[0].id,
    parseOfficialSchedule(markup.replaceAll('UNIT B', 'unit b'), now()).channels[0].id,
  );
});

test('distinguishes valid empty listings from failure and retains the complete roster', async () => {
  const empty = await getHololive({
    apiKey: null,
    fetchImpl: async (url) => typeof url === 'string' ? new Response(schedule('')) : flagshipChannel(),
  });
  const blocked = await getHololive({ apiKey: null, fetchImpl: async () => new Response('Forbidden', { status: 403 }) });
  assert.equal(empty.scheduleAvailable, true);
  assert.equal(blocked.scheduleAvailable, false);
  assert.deepEqual(empty.streams, []);
  assert.deepEqual(blocked.streams, []);
  assert.deepEqual(empty.warnings, []);
  assert.equal(blocked.warnings.length, 2);
  assert.equal(empty.channels.length, 70);
  assert.deepEqual(blocked.channels, empty.channels);
  assert.equal(empty.channels.filter(({ name }) => name === 'FUWAMOCO').length, 1);
  assert.equal(empty.channels.find(({ id }) => id === flagshipId)?.affiliation, 'official');
  assert.equal(empty.updatedChannelIds.length, 70);
  assert.deepEqual(blocked.updatedChannelIds, []);
});

test('merges official YouTube-only streams and tracks refresh success independently', async () => {
  const sharedId = 'flagship123';
  const youtubeOnlyId = 'youtube1234';
  const officialSchedule = () => new Response(schedule(
    `<div class="holodule navbar-text">01/01</div>${card(sharedId, 'ホロライブ', '09:00')}`,
  ));
  const listing = () => flagshipChannel([sharedId, youtubeOnlyId].map((id) => ({
    videoRenderer: {
      videoId: id,
      title: { simpleText: `公式配信 ${id}` },
      upcomingEventData: { startTime: String(Date.parse('2027-01-01T00:00:00Z') / 1000) },
    },
  })));
  const fetchImpl = async (url) => {
    if (typeof url === 'string') return officialSchedule();
    if (url.pathname.endsWith('/streams')) return listing();
    return new Response('Forbidden', { status: 403 });
  };
  const merged = await getHololive({ now, apiKey: null, fetchImpl });
  assert.equal(merged.streams.length, 2);
  assert.ok(merged.streams.every(({ channelId, title }) => channelId === flagshipId && title.startsWith('公式配信')));
  assert.ok(merged.updatedChannelIds.includes(flagshipId));

  const scheduleOnly = await getHololive({
    now, apiKey: null,
    fetchImpl: async (url) => typeof url === 'string' ? officialSchedule() : new Response('Forbidden', { status: 403 }),
  });
  assert.deepEqual(scheduleOnly.streams.map(({ id }) => id), [sharedId]);
  assert.ok(!scheduleOnly.updatedChannelIds.includes(flagshipId));

  const channelOnly = await getHololive({
    now, apiKey: null,
    fetchImpl: async (url) => typeof url === 'string' ? new Response('Forbidden', { status: 403 }) : listing(),
  });
  assert.equal(channelOnly.scheduleAvailable, false);
  assert.equal(channelOnly.streams.length, 2);
  assert.deepEqual(channelOnly.updatedChannelIds, [flagshipId]);
});
