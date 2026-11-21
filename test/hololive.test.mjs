import assert from 'node:assert/strict';
import test from 'node:test';
import { getHololive, holoduleBroadcast, parseOfficialSchedule } from '../src/hololive.mjs';

const now = () => Date.parse('2026-12-31T16:00:00Z');
const soraId = 'UCp6993wxpyDPHUpavwDFqgg';
const flagshipId = 'UCJFZiqLMntJufDCHc6bQixg';
const hololiveScheduleUrl = 'https://schedule.hololive.tv/lives/hololive';

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

test('reads Hololive Holodule cards with JST dates across New Year and their sources', () => {
  const { streams: rows, channels } = parseOfficialSchedule(schedule(`
    <div class="holodule navbar-text">12/31 (木)</div>
    ${card('archive1234', 'ときのそら', '23:00', 'title="Black &amp; White"')}
    <div class="holodule navbar-text">01/01 (金)</div>
    ${card('livestream1', 'Calli', '00:30', 'style="border: 3px red solid;"')}
    ${card('future12345', 'FUWAMOCO', '07:05', '', 'https://youtu.be/future12345')}
    ${card('flagship123', 'ホロライブ', '09:00')}
    ${card('holoan12345', 'holoAN room', '09:05')}
    ${card('asobimela12', '熱千めら', '09:10')}
    ${card('regloss1234', 'ReGLOSS', '10:00')}
    ${card('notyoutube1', '小鳥遊キアラ', '08:00', '', 'https://www.example.org/livestream')}
    <a class="thumbnail" href="https://www.example.org/announcement"><img src="https://schedule-static.hololive.tv/image/promo.jpg" alt="公演のお知らせ"></a>
    <a class="thumbnail" href="javascript:alert(1)" title="リンクが未定のお知らせ"></a>
    <div class="holodule navbar-text">01/02 (土)</div>
    <a class="thumbnail" href="https://www.example.org/announcement"><img src="https://schedule-static.hololive.tv/image/promo.jpg" alt="公演のお知らせ"></a>
  `), now());
  assert.deepEqual(rows.map(({ title, status, startAt }) => ({ title, status, startAt })), [
    { title: 'Black & White', status: 'past', startAt: '2026-12-31T14:00:00.000Z' },
    { title: null, status: 'live', startAt: '2026-12-31T15:30:00.000Z' },
    { title: null, status: 'upcoming', startAt: '2026-12-31T22:05:00.000Z' },
    { title: null, status: 'upcoming', startAt: '2027-01-01T00:00:00.000Z' },
    { title: null, status: 'upcoming', startAt: '2027-01-01T00:05:00.000Z' },
    { title: null, status: 'upcoming', startAt: '2027-01-01T00:10:00.000Z' },
    { title: null, status: 'upcoming', startAt: '2027-01-01T01:00:00.000Z' },
    { title: null, status: 'upcoming', startAt: '2026-12-31T23:00:00.000Z' },
    { title: '公演のお知らせ', status: 'upcoming', startAt: null },
    { title: 'リンクが未定のお知らせ', status: 'upcoming', startAt: null },
    { title: '公演のお知らせ', status: 'upcoming', startAt: null },
  ]);
  assert.equal(rows[3].channelId, flagshipId);
  assert.equal(rows[4].channelId, 'UCozx5csNhCx1wsVq3SZVkBQ');
  const unit = channels.find(({ name }) => name === 'ReGLOSS');
  assert.equal(unit.holodule, true);
  assert.equal(unit.holoduleScope, 'hololive');
  assert.equal(unit.url, hololiveScheduleUrl);
  assert.match(unit.id, /^holodule-[\w-]+$/);
  assert.equal(rows[6].channelId, unit.id);
  assert.equal(rows[7].platform, 'example.org');
  assert.equal(rows[7].url, 'https://www.example.org/livestream');
  assert.equal(rows[7].scheduleDate, undefined);
  assert.equal(rows[8].thumbnail, 'https://schedule-static.hololive.tv/image/promo.jpg');
  assert.equal(rows[8].scheduleDate, '2027-01-01');
  assert.equal(rows[9].url, null);
  assert.equal(rows[9].scheduleDate, '2027-01-01');
  assert.equal(rows[10].scheduleDate, '2027-01-02');
  assert.notEqual(rows[10].id, rows[8].id);
});

test('keeps nonbroadcast Holodule entries for secondary catalogs with distinct link evidence', () => {
  const { streams } = parseOfficialSchedule(schedule(`
    <div class="holodule navbar-text">01/01</div>
    ${card('ordinary123', 'ときのそら', '10:00')}
    ${card('livelink123', 'ときのそら', '11:00', '', 'https://www.youtube.com/live/livelink123')}
    ${card('shortlink12', 'ときのそら', '12:00', '', 'https://www.youtube.com/shorts/shortlink12')}
    ${card('premiere123', 'ときのそら', '13:00', 'title="【MV】新曲" style="border: 3px red solid;"')}
    ${card('twitch', 'ときのそら', '14:00', '', 'https://www.twitch.tv/videos/123456')}
    ${card('clip', 'ときのそら', '15:00', '', 'https://clips.twitch.tv/example')}
    <a class="thumbnail" href="https://www.example.org/announcement" title="公演のお知らせ"></a>
  `), now());

  assert.deepEqual(streams.map(({ isBroadcast }) => isBroadcast), [null, true, false, true, true, false, false]);
  assert.equal(streams[2].id, 'shortlink12');
  assert.equal(streams[3].title, '【MV】新曲');
  assert.equal(holoduleBroadcast(streams[3]), false);
  assert.equal(holoduleBroadcast(streams[2], { isBroadcast: true }), false);
  assert.equal(holoduleBroadcast(streams[3], { isBroadcast: true, title: 'MVを振り返る雑談配信' }), true);
  assert.equal(holoduleBroadcast({ isBroadcast: true }, { isBroadcast: false }), false);
});

test('adds YouTube’s title and actual completion time even to an older listed card', async () => {
  const id = 'archive1234';
  const result = await getHololive({
    now,
    apiKey: 'test',
    async fetchImpl(url, options) {
      if (typeof url === 'string') {
        assert.equal(url, hololiveScheduleUrl);
        assert.equal(options.redirect, 'error');
        return new Response(schedule(`<div class="navbar-text holodule">12/30</div>${card(id, 'ときのそら', '23:00')}`));
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
        liveStreamingDetails: { actualStartTime: '2026-12-30T14:50:00Z', actualEndTime: '2026-12-30T15:30:00Z' },
      }] });
    },
  });
  assert.equal(result.scheduleAvailable, true);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.streams[0].title, '年越し配信');
  assert.equal(result.streams[0].channelId, soraId);
  assert.equal(result.streams[0].endAt, '2026-12-30T15:30:00.000Z');
  assert.equal(result.streams[0].isBroadcast, true);
  assert.deepEqual(result.holoduleIds, [id]);
});

test('uses enough YouTube metadata to recover every title across a large official listing', async () => {
  const ids = Array.from({ length: 56 }, (_, index) => `library${String(index).padStart(4, '0')}`);
  const markup = schedule(`<div class="holodule navbar-text">01/01</div>${
    ids.map((id) => card(id, 'さくらみこ', '12:00')).join('')
  }`);
  const metadataPageSizes = [];
  const result = await getHololive({
    now, apiKey: 'test',
    async fetchImpl(url) {
      if (typeof url === 'string') return new Response(markup);
      if (url.pathname.endsWith('/videos') && url.hostname === 'www.googleapis.com') {
        const batch = url.searchParams.get('id').split(',');
        metadataPageSizes.push(batch.length);
        return Response.json({ items: batch.map((id) => ({
          id, snippet: { title: `公開動画 ${id}`, channelId: soraId },
        })) });
      }
      return new Response(null, { status: 403 });
    },
  });
  assert.deepEqual(metadataPageSizes, [50, 6]);
  assert.equal(result.streams.length, ids.length);
  assert.ok(result.streams.every(({ title, isBroadcast }) => title.startsWith('公開動画 ') && isBroadcast !== true));
});

test('enriches YouTube only and preserves the source label for newly discovered groups', async () => {
  const id = 'regloss1234';
  const markup = schedule(`
    <div class="navbar-text holodule">01/01</div>
    ${card(id, 'ReGLOSS', '08:00')}
    ${card('radiocard01', 'ReGLOSS', '', '', 'https://www.joqr.co.jp/qr/program/example/')}
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
        videoDetails: { videoId: id, channelId: soraId, title: 'ReGLOSS allocates a stream' },
        microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { startTimestamp: '2027-01-01T01:00:00Z' } } },
      };
      return new Response(`<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script>`);
    },
  });
  assert.deepEqual(requests, [id]);
  const unit = result.channels.find(({ name }) => name === 'ReGLOSS');
  assert.equal(result.streams.length, 2);
  assert.ok(result.streams.every(({ channelId }) => channelId === unit.id));
  assert.deepEqual(result.holoduleIds, result.streams.map(({ id }) => id));
  assert.ok(result.updatedChannelIds.includes(unit.id));
  assert.equal(result.streams[1].platform, 'joqr.co.jp');
  assert.equal(result.streams[1].scheduleDate, '2027-01-01');
  assert.equal(
    parseOfficialSchedule(markup, now()).channels[0].id,
    parseOfficialSchedule(markup.replaceAll('ReGLOSS', 'regloss'), now()).channels[0].id,
  );
});

test('does not fall back to the mixed Holodule listing when the Hololive page is unavailable', async () => {
  const requestedPages = [];
  const result = await getHololive({
    apiKey: null,
    async fetchImpl(url) {
      if (typeof url !== 'string') return flagshipChannel();
      requestedPages.push(url);
      if (url === hololiveScheduleUrl) return new Response('Unavailable', { status: 503 });
      return new Response(schedule(`<div class="holodule navbar-text">01/01</div>${card('holostars12', 'アステル・レダ', '08:00')}`));
    },
  });
  assert.deepEqual(requestedPages, [hololiveScheduleUrl]);
  assert.equal(result.scheduleAvailable, false);
  assert.deepEqual(result.streams, []);
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
