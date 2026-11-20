import assert from 'node:assert/strict';
import test from 'node:test';
import { getYouTubeChannel, getYouTubeVideos, normalizeChannelUrl } from '../src/youtube.mjs';

const channelId = 'UC1234567890123456789012';
const upcomingId = 'upcoming123';
const liveId = 'livestream1';
const pastId = 'paststream1';
const avatar = 'https://yt3.googleusercontent.com/example=s88';
const channelUrl = 'https://www.youtube.com/@example';

function html(key, value) {
  return new Response('<script>window["' + key + '"] = ' + JSON.stringify(value) + ';</script>');
}

function streamTab(children) {
  return html('ytInitialData', {
    metadata: { channelMetadataRenderer: { title: '配信チャンネル', externalId: channelId, avatar: { thumbnails: [{ url: avatar }] } } },
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [{
          tabRenderer: {
            title: 'Live',
            selected: true,
            content: { richGridRenderer: { contents: children } },
          },
        }],
      },
    },
  });
}

function watchPage(id, liveBroadcastDetails) {
  return html('ytInitialPlayerResponse', {
    videoDetails: { videoId: id, channelId, title: '配信 {特別編} "タイトル"' },
    microformat: { playerMicroformatRenderer: { liveBroadcastDetails } },
  });
}

test('normalizes supported channel links and rejects video links or other sites', () => {
  assert.equal(normalizeChannelUrl('@example'), channelUrl);
  assert.equal(normalizeChannelUrl('http://m.youtube.com/@example/streams?view=0#section'), channelUrl);
  assert.equal(normalizeChannelUrl('youtube.com/@配信者'), 'https://www.youtube.com/@%E9%85%8D%E4%BF%A1%E8%80%85');
  assert.equal(normalizeChannelUrl('https://youtube.com/channel/' + channelId), 'https://www.youtube.com/channel/' + channelId);
  assert.equal(normalizeChannelUrl('https://youtube.com/c/example/videos/'), 'https://www.youtube.com/c/example');
  assert.equal(normalizeChannelUrl('https://youtube.com/user/example'), 'https://www.youtube.com/user/example');
  for (const input of [
    'https://www.youtube.com/watch?v=' + pastId,
    'https://youtube.com.example.org/@example',
    'https://example.org/@example',
    'https://user@www.youtube.com/@example',
    'https://www.youtube.com:9999/@example',
    'https://www.youtube.com/@example%2Fwatch',
    'https://www.youtube.com/@example/unknown',
  ]) assert.throws(() => normalizeChannelUrl(input), TypeError);
});

test('collects exact public broadcast times for upcoming, live, and past streams', async () => {
  const start = '2026-11-19T09:00:00+09:00';
  const fetchImpl = async (url) => {
    if (url.pathname.endsWith('/streams')) {
      return streamTab([
        { videoRenderer: { videoId: upcomingId, title: { runs: [{ text: '予定配信' }] }, upcomingEventData: { startTime: '1795312800' } } },
        { lockupViewModel: { contentId: liveId, metadata: { lockupMetadataViewModel: { title: { content: '放送中' } } } } },
        { gridVideoRenderer: { videoId: pastId, title: { simpleText: '過去の配信' } } },
      ]);
    }
    const id = url.searchParams.get('v');
    if (id === liveId) return watchPage(id, { isLiveNow: true, startTimestamp: start });
    if (id === pastId) return watchPage(id, { isLiveNow: false, startTimestamp: '2026-11-18T21:00:00Z', endTimestamp: '2026-11-18T22:00:00Z' });
    assert.fail('unexpected request ' + url.href);
  };
  const channel = await getYouTubeChannel(channelUrl, { fetchImpl, apiKey: null });
  assert.equal(channel.name, '配信チャンネル');
  assert.equal(channel.channelId, channelId);
  assert.equal(channel.avatar, avatar);
  assert.deepEqual(channel.streams.map(({ id, status }) => [id, status]), [
    [pastId, 'past'], [liveId, 'live'], [upcomingId, 'upcoming'],
  ]);
  assert.equal(channel.streams[0].endAt, '2026-11-18T22:00:00.000Z');
  assert.equal(channel.streams[1].startAt, '2026-11-19T00:00:00.000Z');
  assert.equal(channel.streams[1].title, '配信 {特別編} "タイトル"');
  assert.equal(channel.streams[2].startAt, new Date(1795312800 * 1000).toISOString());
});

test('distinguishes a blank listing, a missing channel, and cloud or YouTube failures', async () => {
  const fetchEmpty = async () => streamTab([]);
  assert.deepEqual((await getYouTubeChannel(channelUrl, { fetchImpl: fetchEmpty, apiKey: null })).streams, []);

  const fetch404 = async () => new Response('', { status: 404 });
  await assert.rejects(getYouTubeChannel(channelUrl, { fetchImpl: fetch404, apiKey: null }), { code: 'CHANNEL_NOT_FOUND' });

  const fetchConsent = async () => new Response('<h1>Before you continue to YouTube</h1>');
  await assert.rejects(getYouTubeChannel(channelUrl, { fetchImpl: fetchConsent, apiKey: null }), /同意画面/);

  const fetchUnavailable = async (url) => url.pathname.endsWith('/streams')
    ? streamTab([
        { gridVideoRenderer: { videoId: liveId } },
        { gridVideoRenderer: { videoId: pastId } },
      ])
    : url.searchParams.get('v') === liveId
      ? watchPage(liveId, { isLiveNow: true, startTimestamp: '2026-11-19T00:00:00Z' })
      : new Response('', { status: 502 });
  await assert.rejects(getYouTubeChannel(channelUrl, { fetchImpl: fetchUnavailable, apiKey: null }), /502/);
});

test('enriches known video IDs even if a metadata record has no broadcast information', async () => {
  const fetchImpl = async (url) => url.searchParams.get('v') === liveId
    ? watchPage(liveId)
    : new Response('', { status: 503 });
  const videos = await getYouTubeVideos([liveId, pastId, 'invalid', liveId], { fetchImpl, apiKey: null });
  assert.equal(videos.length, 1);
  assert.equal(videos[0].channelId, channelId);
  assert.equal(videos[0].status, null);
  assert.equal(videos[0].startAt, null);
});

test('uses economical Data API calls and supplements the uploads playlist from the public Streams tab', async () => {
  const apiCalls = [];
  const fetchImpl = async (url, options) => {
    if (url.hostname === 'www.youtube.com') {
      return streamTab([{ videoRenderer: { videoId: upcomingId } }]);
    }
    assert.equal(url.hostname, 'www.googleapis.com');
    assert.equal(options.headers['X-Goog-Api-Key'], 'unit-test-key');
    const endpoint = url.pathname.split('/').at(-1);
    apiCalls.push(endpoint);
    if (endpoint === 'channels') {
      assert.equal(url.searchParams.get('forHandle'), '@example');
      return Response.json({ items: [{
        id: channelId,
        snippet: { title: '配信チャンネル', thumbnails: { high: { url: avatar } } },
        contentDetails: { relatedPlaylists: { uploads: 'uploads-playlist' } },
      }] });
    }
    if (endpoint === 'playlistItems') {
      assert.equal(url.searchParams.get('playlistId'), 'uploads-playlist');
      return Response.json({ items: [{ contentDetails: { videoId: pastId } }] });
    }
    if (endpoint === 'videos') {
      assert.equal(url.searchParams.get('id'), upcomingId + ',' + pastId);
      return Response.json({ items: [
        { id: pastId, snippet: { title: 'アーカイブ', channelId }, liveStreamingDetails: { actualStartTime: '2026-11-18T21:00:00Z', actualEndTime: '2026-11-18T22:00:00Z' } },
        { id: upcomingId, snippet: { title: '予告', channelId }, liveStreamingDetails: { scheduledStartTime: '2026-11-21T02:00:00Z' } },
      ] });
    }
    assert.fail('unexpected request ' + url.href);
  };
  const channel = await getYouTubeChannel(channelUrl, { fetchImpl, apiKey: 'unit-test-key' });
  assert.deepEqual(apiCalls, ['channels', 'playlistItems', 'videos']);
  assert.deepEqual(channel.streams.map(({ status }) => status), ['past', 'upcoming']);
  assert.equal(channel.avatar, avatar);
});
