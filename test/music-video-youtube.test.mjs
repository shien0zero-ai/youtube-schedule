import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMusicVideoTitle } from '../src/music-video-classification.mjs';
import { getMusicVideos, getRecentMusicVideos } from '../src/music-video-youtube.mjs';

const talent = 'UC5CwaMl1eIgY8h02uZw7u8A';
const another = 'UCCzUftO8KOVkV4wQG1vkUvg';
const published = '2026-11-20T12:00:00Z';

function video(id, title, overrides = {}) {
  return {
    id,
    snippet: { title, channelId: talent, categoryId: '10', publishedAt: published },
    status: { privacyStatus: 'public' },
    contentDetails: { duration: 'PT3M41S' },
    ...overrides,
  };
}

test('classifies MVs and explicit covers and excludes related non-MV programs', () => {
  for (const title of ['【オリジナルＭＶ】夜空', '星の歌 Music Video', '【歌ってみた】雪の花', 'Song【Cover】', 'Song covered by Sora', 'Song (official M/V)']) {
    assert.equal(isMusicVideoTitle(title), true, title);
  }
  for (const title of [
    '【3DLIVE】生誕記念ライブ / MV公開', '【MV公開記念配信】歌ってみた解説', 'Official MV #Shorts',
    '【歌ってみた】ダイジェスト', '【MV】チラ見せ', 'Song Official Audio', 'Cover Karaoke',
    'Song Music Video Teaser', 'COVER Corporation Presents A New Event', 'Ordinary Published Video',
  ]) assert.equal(isMusicVideoTitle(title), false, title);
});

test('loads official music video metadata in bounded batches and preserves premiere timestamps', async () => {
  const requested = Array.from({ length: 53 }, (_, index) => String(index).padStart(11, '0'));
  const [regular, upcoming, live, ended, privateId, unlisted, concert, short] = requested;
  const items = [
    video(regular, 'ビビデバ / 星街すいせい(official)', { statistics: { viewCount: '194000023' } }),
    video(upcoming, '【歌ってみた】次の曲', {
      liveStreamingDetails: { scheduledStartTime: '2026-11-21T22:00:00+09:00' },
    }),
    video(live, '【MV】新曲', {
      liveStreamingDetails: { actualStartTime: '2026-11-21T13:00:17Z' },
    }),
    video(ended, '【MV】プレミア配信曲', {
      liveStreamingDetails: {
        scheduledStartTime: '2026-11-20T13:00:00Z', actualStartTime: '2026-11-20T13:05:00Z', actualEndTime: '2026-11-20T13:10:00Z',
      },
    }),
    video(privateId, 'Private song MV', { status: { privacyStatus: 'private' } }),
    video(unlisted, 'Unlisted song MV', { status: { privacyStatus: 'unlisted' } }),
    video(concert, '【3D LIVE】MV公開記念'),
    video(short, '【MV】短い版', {
      snippet: { title: '【MV】短い版', channelId: talent, publishedAt: published, description: '#ショート動画' },
      contentDetails: { duration: 'PT2M15S' },
    }),
  ];
  const batches = [];
  const actual = await getMusicVideos([...requested, 'invalid', regular], {
    apiKey: 'test-only',
    async fetchImpl(url, options) {
      assert.equal(url.pathname, '/youtube/v3/videos');
      assert.equal(options.headers['X-Goog-Api-Key'], 'test-only');
      const batch = url.searchParams.get('id').split(',');
      batches.push(batch);
      return Response.json({ items: items.filter(({ id }) => batch.includes(id)) });
    },
  });
  assert.deepEqual(batches.map(({ length }) => length), [50, 3]);
  assert.deepEqual(actual.map(({ id, status, startAt, viewCount }) => [id, status, startAt, viewCount]), [
    [regular, 'past', '2026-11-20T12:00:00.000Z', 194000023],
    [upcoming, 'upcoming', '2026-11-21T13:00:00.000Z', null],
    [live, 'live', '2026-11-21T13:00:17.000Z', null],
    [ended, 'past', '2026-11-20T13:05:00.000Z', null],
  ]);
  assert.equal(actual[3].endAt, '2026-11-20T13:10:00.000Z');
  assert.equal(actual[3].publishedAt, '2026-11-20T12:00:00.000Z');
  assert.equal(actual[0].url, `https://www.youtube.com/watch?v=${regular}`);
  assert.equal(actual[0].thumbnail, `https://i.ytimg.com/vi/${regular}/hqdefault.jpg`);
  assert.equal(actual[0].platform, 'youtube');
});

test('refreshes public known MV IDs without widening automatic discovery', async () => {
  const items = [
    video('abcdefghij1', 'Skyline / Artist', { statistics: { viewCount: '230000000' } }),
    video('abcdefghij2', 'Official MV #Shorts'),
    video('abcdefghij3', 'Private MV', { status: { privacyStatus: 'private' } }),
    video('abcdefghij4', 'Another public video'),
  ];
  const options = { apiKey: 'test-only', fetchImpl: async () => Response.json({ items }) };
  const ids = items.slice(0, 3).map(({ id }) => id);
  assert.deepEqual(await getMusicVideos(ids, options), []);
  const updated = await getMusicVideos(ids, { ...options, includeKnown: true });
  assert.deepEqual(updated.map(({ id, viewCount }) => [id, viewCount]), [['abcdefghij1', 230000000]]);
});

test('uses one recent uploads page per official channel and discards other uploaders', async () => {
  const actual = await getRecentMusicVideos([talent, talent], {
    apiKey: 'test-only',
    async fetchImpl(url) {
      if (url.pathname.endsWith('/channels')) {
        assert.equal(url.searchParams.get('id'), talent);
        return Response.json({ items: [{ id: talent, contentDetails: { relatedPlaylists: { uploads: 'UUabcdef' } } }] });
      }
      if (url.pathname.endsWith('/playlistItems')) {
        assert.equal(url.searchParams.get('playlistId'), 'UUabcdef');
        assert.equal(url.searchParams.get('maxResults'), '50');
        assert.equal(url.searchParams.has('pageToken'), false);
        return Response.json({ nextPageToken: 'not-needed', items: ['abcdefghij1', 'abcdefghij2'].map((videoId) => ({ contentDetails: { videoId } })) });
      }
      assert.equal(url.pathname, '/youtube/v3/videos');
      return Response.json({ items: [video('abcdefghij1', 'Song Music Video'), video('abcdefghij2', 'Another MV', {
        snippet: { title: 'Another MV', channelId: another, publishedAt: published },
      })] });
    },
  });
  assert.deepEqual(actual.map(({ id }) => id), ['abcdefghij1']);
});

test('reads recent public Atom MV entries without an API key', async () => {
  const entry = (id, title, channelId = talent) => `
    <entry><yt:videoId>${id}</yt:videoId><yt:channelId>${channelId}</yt:channelId>
      <title>${title}</title><published>2026-11-20T21:00:00+09:00</published>
      <media:group><media:community><media:statistics views='1051'/></media:community></media:group>
    </entry>`;
  const actual = await getRecentMusicVideos([talent, another], {
    apiKey: null,
    async fetchImpl(url, options) {
      if (url.searchParams.get('channel_id') === another) return new Response(null, { status: 403 });
      assert.equal(url.href, `https://www.youtube.com/feeds/videos.xml?channel_id=${talent}`);
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['X-Goog-Api-Key'], undefined);
      return new Response(`<?xml version="1.0" encoding="UTF-8"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
        ${entry('abcdefghij1', '【MV】Wind &amp; &#x661F;')}
        ${entry('abcdefghij1', '【MV】Duplicate')}
        ${entry('abcdefghij2', '【MV】Teaser')}
        ${entry('abcdefghij3', 'Bad channel Music Video', another)}
        ${entry('abcdefghij4', 'Unmarked / Artist (official)')}
      </feed>`);
    },
  });
  assert.deepEqual(actual.map(({ title, status, startAt, viewCount }) => ({ title, status, startAt, viewCount })), [
    { title: '【MV】Wind & 星', status: 'past', startAt: '2026-11-20T12:00:00.000Z', viewCount: 1051 },
  ]);
});

test('distinguishes unavailable or invalid sources from empty listings', async () => {
  await assert.rejects(getMusicVideos(['abcdefghij1'], { apiKey: null }), /YOUTUBE_API_KEY/);
  await assert.rejects(getMusicVideos(['abcdefghij1'], {
    apiKey: 'test-only', fetchImpl: async () => new Response(null, { status: 403 }),
  }), /HTTP 403/);
  await assert.rejects(getRecentMusicVideos([talent], {
    apiKey: null, fetchImpl: async () => new Response('<html>Consent required</html>'),
  }), /公開フィードを読み取れません/);
  await assert.rejects(getRecentMusicVideos([talent, another], {
    apiKey: null, fetchImpl: async () => new Response(null, { status: 403 }),
  }), /HTTP 403/);
  assert.deepEqual(await getRecentMusicVideos([talent], {
    apiKey: null, fetchImpl: async () => new Response('<feed></feed>'),
  }), []);
});
