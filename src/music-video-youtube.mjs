import { isMusicVideoTitle, isShortVideoTitle } from './music-video-classification.mjs';
import { youtubeApi } from './youtube.mjs';

const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;
const channelIdPattern = /^UC[A-Za-z0-9_-]{22}$/;
const playlistIdPattern = /^[A-Za-z0-9_-]{2,100}$/;
const metadataPageSize = 50;
const recentChannelLimit = 8;
const videoLookupLimit = recentChannelLimit * metadataPageSize;
const requestTimeoutMs = 18_000;

function uniqueIds(ids, pattern, limit) {
  const result = [...new Set(ids)].filter((id) => typeof id === 'string' && pattern.test(id));
  if (result.length > limit) throw new RangeError(`一度に読み込める YouTube の ID は ${limit} 件までです。`);
  return result;
}

function dateTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function viewCount(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value))) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : null;
}

function musicVideo({ id, title, channelId, status, startAt, endAt = null, publishedAt, views }) {
  return {
    id,
    title,
    channelId,
    status,
    startAt,
    endAt,
    publishedAt,
    url: `https://www.youtube.com/watch?v=${id}`,
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    platform: 'youtube',
    viewCount: viewCount(views),
  };
}

function itemsFrom(response) {
  if (!Array.isArray(response?.items)) throw new Error('YouTube Data API の一覧を読み取れませんでした。');
  return response.items;
}

function isShort({ snippet, contentDetails }) {
  if (isShortVideoTitle(snippet.title)) return true;
  const [, hours, minutes, seconds] = contentDetails?.duration?.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/) ?? [];
  const duration = Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
  if (duration <= 0 || duration > 180) return false;
  const tags = Array.isArray(snippet.tags) ? snippet.tags : [];
  return /#shorts\b|#ショート動画(?![\p{L}\p{N}_])/iu.test(snippet.description ?? '')
    || tags.some((tag) => typeof tag === 'string' && /^#?(?:shorts|youtube shorts|ショート動画)$/iu.test(tag.trim()));
}

function fromApi(item, includeKnown) {
  const { id, snippet, status, statistics, liveStreamingDetails } = item;
  if (!channelIdPattern.test(snippet?.channelId ?? '') || status?.privacyStatus !== 'public'
    || ['deleted', 'failed', 'rejected'].includes(status.uploadStatus)
    || typeof snippet.title !== 'string' || !snippet.title.trim() || isShort(item)
    || (!includeKnown && !isMusicVideoTitle(snippet.title, { officialMusic: snippet.categoryId === '10' }))) return null;

  const actualStart = dateTime(liveStreamingDetails?.actualStartTime);
  const scheduledStart = dateTime(liveStreamingDetails?.scheduledStartTime);
  const endAt = dateTime(liveStreamingDetails?.actualEndTime);
  const publishedAt = dateTime(snippet.publishedAt);
  const startAt = actualStart ?? scheduledStart ?? publishedAt;
  if (!startAt) return null;

  let broadcastStatus = 'past';
  if (!endAt && snippet.liveBroadcastContent !== 'none') {
    if (actualStart || snippet.liveBroadcastContent === 'live') broadcastStatus = 'live';
    else if (scheduledStart || snippet.liveBroadcastContent === 'upcoming') broadcastStatus = 'upcoming';
  }
  return musicVideo({
    id, title: snippet.title, channelId: snippet.channelId, status: broadcastStatus,
    startAt, endAt, publishedAt, views: statistics?.viewCount,
  });
}

async function readMusicVideos(ids, options, apiKey, includeKnown = false) {
  const results = [];
  for (let offset = 0; offset < ids.length; offset += metadataPageSize) {
    const batch = new Set(ids.slice(offset, offset + metadataPageSize));
    const response = await youtubeApi('videos', {
      part: 'snippet,status,contentDetails,statistics,liveStreamingDetails',
      id: [...batch].join(','),
    }, options, apiKey);
    for (const item of itemsFrom(response)) {
      if (!batch.delete(item?.id)) continue;
      const video = fromApi(item, includeKnown);
      if (video) results.push(video);
    }
  }
  return results;
}

export async function getMusicVideos(ids, { fetchImpl = fetch, apiKey = process.env.YOUTUBE_API_KEY, includeKnown = false } = {}) {
  const requested = uniqueIds(ids, videoIdPattern, videoLookupLimit);
  if (!requested.length) return [];
  if (!apiKey) throw new Error('動画の詳細を取得するには YOUTUBE_API_KEY の設定が必要です。');
  return readMusicVideos(requested, { fetchImpl, signal: AbortSignal.timeout(requestTimeoutMs) }, apiKey, includeKnown);
}

function feedText(xml, field) {
  const content = xml.match(new RegExp(`<${field}\\b[^>]*>([\\s\\S]*?)</${field}>`, 'i'))?.[1]?.trim();
  if (!content) return null;
  if (content.startsWith('<![CDATA[') && content.endsWith(']]>')) return content.slice(9, -3).trim();
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return content.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (reference, name) => {
    if (!name.startsWith('#')) return named[name.toLowerCase()];
    const point = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    return point <= 0x10ffff ? String.fromCodePoint(point) : reference;
  });
}

async function readPublicFeed(channelId, { fetchImpl, signal }) {
  const address = new URL('https://www.youtube.com/feeds/videos.xml');
  address.searchParams.set('channel_id', channelId);
  let response;
  try {
    response = await fetchImpl(address, { signal, headers: { Accept: 'application/atom+xml, application/xml' }, redirect: 'error' });
  } catch (error) {
    throw new Error('YouTube の公開フィードに接続できませんでした。', { cause: error });
  }
  if (!response.ok) throw new Error(`YouTube の公開フィードを取得できませんでした（HTTP ${response.status}）。`);
  const xml = await response.text();
  const feed = xml.match(/^\s*(?:<\?xml[^?]*\?>\s*)?<feed(?:\s[^>]*)?>([\s\S]*)<\/feed>\s*$/i)?.[1];
  if (feed === undefined) {
    throw new Error('YouTube の公開フィードを読み取れませんでした。');
  }

  const results = [];
  const seen = new Set();
  for (const [, entry] of feed.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)) {
    const id = feedText(entry, 'yt:videoId');
    const title = feedText(entry, 'title');
    const startAt = dateTime(feedText(entry, 'published'));
    if (!videoIdPattern.test(id ?? '') || seen.has(id) || feedText(entry, 'yt:channelId') !== channelId || !startAt
      || !isMusicVideoTitle(title)) continue;

    const [, doubleQuoted, singleQuoted] = entry.match(/<media:statistics\b[^>]*\sviews\s*=\s*(?:"(\d+)"|'(\d+)')/i) ?? [];
    seen.add(id);
    results.push(musicVideo({ id, title, channelId, status: 'past', startAt, publishedAt: startAt, views: doubleQuoted ?? singleQuoted }));
  }
  return results;
}

export async function getRecentMusicVideos(channelIds, { fetchImpl = fetch, apiKey = process.env.YOUTUBE_API_KEY } = {}) {
  const ids = uniqueIds(channelIds, channelIdPattern, recentChannelLimit);
  if (!ids.length) return [];
  const options = { fetchImpl, signal: AbortSignal.timeout(requestTimeoutMs) };
  if (!apiKey) {
    const feeds = await Promise.allSettled(ids.map((id) => readPublicFeed(id, options)));
    if (feeds.every(({ status }) => status === 'rejected')) throw feeds[0].reason;
    return feeds.flatMap((feed) => feed.status === 'fulfilled' ? feed.value : []);
  }

  const channels = await youtubeApi('channels', { part: 'contentDetails', id: ids.join(',') }, options, apiKey);
  const requested = new Set(ids);
  const uploads = new Set();
  for (const channel of itemsFrom(channels)) {
    const playlist = channel?.contentDetails?.relatedPlaylists?.uploads;
    if (requested.has(channel?.id) && playlistIdPattern.test(playlist ?? '')) uploads.add(playlist);
  }
  const pages = await Promise.all([...uploads].map((playlistId) => youtubeApi('playlistItems', {
    part: 'contentDetails', playlistId, maxResults: String(metadataPageSize),
  }, options, apiKey)));
  const videoIds = uniqueIds(pages.flatMap((page) => itemsFrom(page).map((item) => item?.contentDetails?.videoId)),
    videoIdPattern, videoLookupLimit);
  const videos = await readMusicVideos(videoIds, options, apiKey);
  return videos.filter(({ channelId }) => requested.has(channelId));
}
