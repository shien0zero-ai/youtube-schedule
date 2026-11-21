import { isNonBroadcastTitle } from './broadcasts.mjs';
import { isShortVideoTitle } from './music-video-classification.mjs';

const youtubeOrigin = 'https://www.youtube.com';
const youtubeHosts = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com']);
const channelIdPattern = /^UC[A-Za-z0-9_-]{22}$/;
const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;
const channelTabs = new Set(['featured', 'videos', 'shorts', 'streams', 'playlists', 'posts', 'community', 'about']);
const avatarHosts = new Set(['yt3.googleusercontent.com', 'yt3.ggpht.com', 'lh3.googleusercontent.com']);
const recentLimit = 24;
const requestTimeoutMs = 18_000;
const supplementTimeoutMs = 5_000;
const completedVideos = new Map();
const completedVideoLimit = 512;
const completedVideoLifetimeMs = 6 * 60 * 60 * 1000;

export function youtubeVideoId(url) {
  if (!url) return null;
  let id;
  if (url.hostname === 'youtu.be') {
    id = url.pathname.match(/^\/([^/]+)\/?$/)?.[1];
  } else if (youtubeHosts.has(url.hostname)) {
    id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:live|shorts|embed)\/([^/]+)\/?$/)?.[1];
  }
  return videoIdPattern.test(id ?? '') ? id : null;
}

function channelNotFound() {
  const error = new Error('YouTubeチャンネルが見つかりませんでした。チャンネルのURLを確認してください。');
  error.code = 'CHANNEL_NOT_FOUND';
  return error;
}

export function normalizeChannelUrl(raw) {
  const invalidUrl = () => new TypeError('YouTubeのチャンネルURL（例 https://www.youtube.com/@NASA）を入力してください。');
  if (typeof raw !== 'string' || !raw.trim()) throw invalidUrl();

  const input = raw.trim();
  let url;
  try {
    if (input.startsWith('@')) {
      url = new URL(`/${input}`, youtubeOrigin);
    } else {
      url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    }
  } catch {
    throw invalidUrl();
  }
  if (!youtubeHosts.has(url.hostname) || url.port || url.username || url.password) {
    throw invalidUrl();
  }

  let segments;
  try {
    segments = url.pathname.replace(/^\/|\/$/g, '').split('/').map(decodeURIComponent);
  } catch {
    throw invalidUrl();
  }
  const [first, second] = segments;
  const namePattern = /^[\p{L}\p{M}\p{N}._·-]+$/u;
  const handle = first.startsWith('@') && namePattern.test(first.slice(1));
  if (handle && (segments.length === 1 || (segments.length === 2 && channelTabs.has(second)))) {
    return `${youtubeOrigin}/@${encodeURIComponent(first.slice(1))}`;
  }
  const namedChannel = ['c', 'user'].includes(first) && namePattern.test(second ?? '') && !/^\.{1,2}$/.test(second);
  const idChannel = first === 'channel' && channelIdPattern.test(second ?? '');
  if ((namedChannel || idChannel) && (segments.length === 2 || (segments.length === 3 && channelTabs.has(segments[2])))) {
    return `${youtubeOrigin}/${first}/${encodeURIComponent(second)}`;
  }
  throw invalidUrl();
}

async function request(url, { fetchImpl, signal }, headers = {}) {
  try {
    return await fetchImpl(url, { signal, headers, redirect: 'manual' });
  } catch (error) {
    const message = signal.aborted
      ? 'YouTubeからの応答が時間内に届きませんでした。'
      : 'YouTubeに接続できませんでした。クラウド環境の外部ネットワーク設定を確認してください。';
    throw new Error(message, { cause: error });
  }
}

async function youtubePage(url, options, { missing = 'error' } = {}) {
  let address = new URL(url);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await request(address, options, {
      Accept: 'text/html',
      'Accept-Language': 'en-US,en;q=0.9',
    });
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      address = new URL(response.headers.get('location'), address);
      if (address.protocol !== 'https:' || !youtubeHosts.has(address.hostname) || address.port || address.username || address.password) {
        throw new Error('YouTubeが同意画面またはログイン画面に転送しました。');
      }
      continue;
    }
    if (!response.ok) {
      if (response.status === 404 && missing === 'channel') throw channelNotFound();
      if (response.status === 404 && missing === 'video') return null;
      throw new Error(`YouTubeのページを取得できませんでした（HTTP ${response.status}）。`);
    }
    return { html: await response.text(), pathname: address.pathname };
  }
  throw new Error('YouTubeページを取得する際の転送回数が上限を超えました。');
}

function embeddedJson(html, name) {
  const marker = new RegExp(`(?:\\b${name}|window\\[["']${name}["']\\])\\s*=\\s*\\{`, 'g');
  for (const match of html.matchAll(marker)) {
    const start = match.index + match[0].length - 1;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < html.length; index++) {
      const character = html[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      if (character === '{') depth++;
      if (character === '}' && --depth === 0) {
        try {
          return JSON.parse(html.slice(start, index + 1));
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

function youtubeBlocked(html, reason = '') {
  return /before you continue to youtube|not a bot|unusual traffic|consent\.youtube\.com\/save/i.test(reason + html);
}

function textValue(value) {
  if (typeof value === 'string') return value;
  return value?.simpleText ?? value?.content ?? value?.runs?.map(({ text }) => text).join('') ?? '';
}

function timestamp(value) {
  if (!value || !/^\d+$|^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const parsed = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > 8.64e15) return null;
  return new Date(parsed).toISOString();
}

function stream({ id, title, status, startAt, endAt = null, channelId, isBroadcast, durationSeconds = null }) {
  return {
    id,
    title,
    status,
    startAt,
    endAt,
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    url: `${youtubeOrigin}/watch?v=${id}`,
    channelId: channelIdPattern.test(channelId ?? '') ? channelId : null,
    isBroadcast,
    durationSeconds,
  };
}

function durationInSeconds(value) {
  if (value === 'P0D') return 0;
  const match = typeof value === 'string' && value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

function hasLiveProgrammeTitle(title) {
  return /生放送|生配信|ライブ配信|実況|耐久|参加型|歌枠|カラオケ|雑談|朝活|同時視聴|3\s*d\s*(?:live|ライブ)|\b(?:live\s*stream(?:ing)?|karaoke|zatsudan|watch[ -]?along)\b/iu
    .test(title.normalize('NFKC'));
}

function avatarUrl(value) {
  if (!value) return null;
  try {
    const address = new URL(value, youtubeOrigin);
    return address.protocol === 'https:' && avatarHosts.has(address.hostname)
      && !address.port && !address.username && !address.password ? address.href : null;
  } catch {
    return null;
  }
}

function streamCards(contents) {
  const entries = new Map();
  const pending = [contents];
  while (pending.length && entries.size < recentLimit) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    const item = current.videoRenderer ?? current.gridVideoRenderer;
    const lockup = current.lockupViewModel;
    const reel = current.reelItemRenderer ?? current.shortsLockupViewModel;
    const endpoint = item?.navigationEndpoint
      ?? lockup?.rendererContext?.commandContext?.onTap?.innertubeCommand;
    const id = item?.videoId ?? lockup?.contentId ?? reel?.videoId
      ?? reel?.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId;
    if (videoIdPattern.test(id ?? '')) {
      const path = endpoint?.commandMetadata?.webCommandMetadata?.url;
      const nonBroadcast = reel || endpoint?.reelWatchEndpoint || lockup?.contentType === 'LOCKUP_CONTENT_TYPE_SHORT'
        || path?.startsWith('/shorts/') || item?.upcomingEventData?.isPremiere === true;
      entries.set(id, {
        id,
        title: textValue(item?.title ?? lockup?.metadata?.lockupMetadataViewModel?.title),
        scheduledStartAt: timestamp(item?.upcomingEventData?.startTime),
        isBroadcast: !nonBroadcast,
      });
      continue;
    }
    const children = Object.values(current);
    for (let index = children.length - 1; index >= 0; index--) {
      pending.push(children[index]);
    }
  }
  return [...entries.values()];
}

async function readPublicChannelPage(url, options) {
  const { html } = await youtubePage(`${url}/streams?hl=en`, options, { missing: 'channel' });
  const data = embeddedJson(html, 'ytInitialData');
  const metadata = data?.metadata?.channelMetadataRenderer;
  const name = metadata?.title;
  const channelId = metadata?.externalId;
  if (!name || !channelIdPattern.test(channelId ?? '')) {
    if (youtubeBlocked(html)) throw new Error('YouTubeが同意画面または本人確認画面を返しました。');
    if (data?.alerts?.some(({ alertRenderer }) => alertRenderer?.type === 'ERROR')) throw channelNotFound();
    throw new Error('YouTubeの公開チャンネル情報を読み取れませんでした。');
  }

  const avatar = avatarUrl(metadata?.avatar?.thumbnails?.[0]?.url
    ?? data.header?.c4TabbedHeaderRenderer?.avatar?.thumbnails?.[0]?.url);
  const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs;
  if (!Array.isArray(tabs)) throw new Error('YouTubeの配信一覧を読み取れませんでした。');
  const streamTab = tabs.map(({ tabRenderer }) => tabRenderer).find((tab) => {
    if (!tab) return false;
    const path = tab.endpoint?.commandMetadata?.webCommandMetadata?.url?.split('?')[0] ?? '';
    return path.endsWith('/streams') || tab.title === 'Live';
  });
  if (!streamTab) return { name, channelId, avatar, entries: [] };
  if (!streamTab.selected || !streamTab.content) throw new Error('YouTubeの配信タブを取得できませんでした。');
  return { name, channelId, avatar, entries: streamCards(streamTab.content) };
}

async function readPublicChannel(url, options) {
  const { entries, ...channel } = await readPublicChannelPage(url, options);
  const videos = await readPublicVideos(entries, options, { allowPartial: false });
  const streams = videos.filter((video) => isChannelBroadcast(video, channel.channelId));
  if (!streams.length && videos.some(({ isBroadcast, startAt }) => isBroadcast !== false && !startAt)) {
    throw new Error('YouTubeから配信日時を取得できませんでした。');
  }
  return { ...channel, streams };
}

function isChannelBroadcast({ startAt, status, isBroadcast, channelId }, expectedChannelId) {
  return isBroadcast === true && startAt && status && (!channelId || channelId === expectedChannelId);
}

async function readPublicVideos(entries, options, { allowPartial = true } = {}) {
  const streams = [];
  const failures = [];
  for (let index = 0; index < entries.length; index += 6) {
    const results = await Promise.allSettled(entries.slice(index, index + 6).map((entry) => readPublicStream(entry, options)));
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) streams.push(result.value);
      if (result.status === 'rejected') failures.push(result.reason);
    }
    if (options.signal.aborted || (!allowPartial && failures.length)) break;
  }
  if (failures.length && (!allowPartial || !streams.length)) throw failures[0];
  return streams;
}

async function readPublicStream({ id, title, scheduledStartAt, isBroadcast: streamTabEvidence }, options) {
  if (streamTabEvidence === false) return null;
  const useCache = options.fetchImpl === fetch;
  if (useCache) {
    const cached = completedVideos.get(id);
    if (cached?.expiresAt > Date.now()) return { ...cached.video };
    completedVideos.delete(id);
  }
  if (streamTabEvidence === true && title && scheduledStartAt) {
    return stream({ id, title, status: 'upcoming', startAt: scheduledStartAt, isBroadcast: true });
  }

  const page = await youtubePage(`${youtubeOrigin}/watch?v=${id}&hl=en`, options, { missing: 'video' });
  if (!page) return null;
  const { html, pathname } = page;
  const player = embeddedJson(html, 'ytInitialPlayerResponse');
  if (youtubeBlocked(player ? '' : html, player?.playabilityStatus?.reason)) {
    throw new Error('YouTubeが同意画面または本人確認画面を返しました。');
  }
  if (!player) throw new Error('YouTubeの動画情報を読み取れませんでした。');
  const details = player.videoDetails;
  if (details?.videoId && details.videoId !== id) return null;
  const microformat = player.microformat?.playerMicroformatRenderer;
  const broadcast = microformat?.liveBroadcastDetails;
  const streamability = player.playabilityStatus?.liveStreamability?.liveStreamabilityRenderer;
  const offline = streamability?.offlineSlate?.liveStreamOfflineSlateRenderer;
  const videoTitle = textValue(details?.title).trim() || textValue(microformat?.title).trim() || title;
  const channelId = details?.channelId;
  const startAt = timestamp(broadcast?.startTimestamp ?? offline?.scheduledStartTime);
  if (!videoTitle) return null;

  const nonBroadcast = pathname.startsWith('/shorts/') || /^(?:https:\/\/(?:www\.|m\.)?youtube\.com)?\/shorts\//.test(microformat?.canonicalUrl ?? '')
    || details?.isPremiere === true || broadcast?.isPremiere === true || streamability?.isPremiere === true
    || details?.isLiveContent === false;
  const liveContent = streamTabEvidence === true || details?.isLiveContent === true || details?.isLive === true;
  const isBroadcast = nonBroadcast ? false : liveContent ? true
    : isNonBroadcastTitle(videoTitle) || (!broadcast && !offline && details?.isUpcoming !== true) ? false : null;
  const durationSeconds = /^\d+$/.test(details?.lengthSeconds ?? '') ? Number(details.lengthSeconds) : null;
  const endAt = timestamp(broadcast?.endTimestamp);
  let status = null;
  if (endAt) status = 'past';
  else if (broadcast?.isLiveNow || details?.isLive) status = 'live';
  else if (offline?.scheduledStartTime || player.playabilityStatus?.status === 'LIVE_STREAM_OFFLINE' ||
      details?.isUpcoming === true || (startAt && Date.parse(startAt) > Date.now())) status = 'upcoming';
  else if (broadcast?.isLiveNow === false && startAt) status = 'past';
  const video = stream({ id, title: videoTitle, status, startAt, endAt, channelId, isBroadcast, durationSeconds });
  if (endAt) {
    if (useCache && startAt && isBroadcast !== null) {
      if (completedVideos.size === completedVideoLimit) completedVideos.delete(completedVideos.keys().next().value);
      completedVideos.set(id, { video: { ...video }, expiresAt: Date.now() + completedVideoLifetimeMs });
    }
  }
  return video;
}

export async function youtubeApi(endpoint, params, options, apiKey) {
  const address = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  address.search = new URLSearchParams(params).toString();
  const response = await request(address, options, { 'X-Goog-Api-Key': apiKey });
  if (!response.ok) {
    const hint = [401, 403].includes(response.status) ? 'APIキー、YouTube Data APIの有効化状態、割り当てを確認してください。' : '';
    throw new Error(`YouTube Data APIに接続できませんでした（HTTP ${response.status}）。${hint}`);
  }
  return response.json();
}

async function readApiChannel(url, options, apiKey) {
  const [first, second] = new URL(url).pathname.slice(1).split('/').map(decodeURIComponent);
  const publicPage = first === 'c'
    ? readPublicChannelPage(url, options)
    : readPublicChannelPage(url, { ...options, signal: AbortSignal.timeout(supplementTimeoutMs) }).catch(() => null);
  let lookup;
  if (first.startsWith('@')) lookup = { forHandle: first };
  else if (first === 'user') lookup = { forUsername: second };
  else if (first === 'channel') lookup = { id: second };
  else lookup = { id: (await publicPage).channelId };
  const api = (endpoint, params) => youtubeApi(endpoint, params, options, apiKey);
  const channel = (await api('channels', { part: 'snippet,contentDetails', ...lookup })).items?.[0];
  const channelId = channel?.id;
  const name = channel?.snippet?.title;
  if (!name || !channelIdPattern.test(channelId ?? '')) throw channelNotFound();
  const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error('YouTubeのアップロード一覧を取得できませんでした。');

  const [{ items = [] }, publicChannel] = await Promise.all([
    api('playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: '50' }),
    publicPage,
  ]);
  const entries = publicChannel?.channelId === channelId ? publicChannel.entries : [];
  const ids = [...new Set([
    ...entries.map(({ id }) => id),
    ...items.map(({ contentDetails }) => contentDetails?.videoId),
  ])].filter((id) => videoIdPattern.test(id ?? ''));
  const videos = await readApiVideos(ids, options, apiKey, entries);
  const streams = videos.filter((video) => isChannelBroadcast(video, channelId));
  const streamIds = new Set(streams.map(({ id }) => id));
  const found = new Map(videos.map((video) => [video.id, video]));
  for (const { id, title, scheduledStartAt, isBroadcast } of entries) {
    const video = found.get(id);
    if (!streamIds.has(id) && isBroadcast && video?.isBroadcast !== false &&
        (!video?.channelId || video.channelId === channelId) && (video?.title || title) && scheduledStartAt) {
      streams.push(stream({ id, title: video?.title || title, status: 'upcoming', startAt: scheduledStartAt, channelId, isBroadcast: true }));
    }
  }
  const thumbnails = channel.snippet?.thumbnails;
  const avatar = avatarUrl(thumbnails?.high?.url ?? thumbnails?.default?.url) ?? publicChannel?.avatar ?? null;
  return { name, channelId, avatar, streams };
}

function apiBroadcastEvidence(item, status, startAt, streamTabEvidence, durationSeconds) {
  const { snippet, liveStreamingDetails: details } = item;
  const shortTag = /^#?(?:shorts|youtube shorts|ショート動画)$/iu;
  const tags = Array.isArray(snippet.tags) ? snippet.tags : [];
  const isShort = isShortVideoTitle(snippet.title) || (durationSeconds > 0 && durationSeconds <= 180
    && (/#shorts\b|#ショート動画(?![\p{L}\p{N}_])/iu.test(snippet.description ?? '')
      || tags.some((tag) => typeof tag === 'string' && shortTag.test(tag.trim()))));
  if (streamTabEvidence === false || isShort) return false;
  if (streamTabEvidence === true) return true;
  if (isNonBroadcastTitle(snippet.title, { officialMusic: snippet.categoryId === '10' })) return false;
  if (status && startAt) {
    // Pending or active live streams have no uploaded runtime yet; known premieres omit this duration.
    if (status !== 'past' && durationSeconds === 0) return true;
    if ((durationSeconds === null || durationSeconds > 60) && hasLiveProgrammeTitle(snippet.title)) return true;
  }
  return !details && snippet.liveBroadcastContent === 'none' ? false : null;
}

async function readApiVideos(ids, options, apiKey, entries = []) {
  const evidence = new Map(entries.map(({ id, isBroadcast }) => [id, isBroadcast]));
  const streams = [];
  for (let index = 0; index < ids.length; index += 50) {
    const { items = [] } = await youtubeApi('videos', {
      part: 'snippet,liveStreamingDetails,contentDetails',
      id: ids.slice(index, index + 50).join(','),
    }, options, apiKey);
    for (const item of items) {
      const { id, snippet, liveStreamingDetails: details, contentDetails } = item;
      const title = snippet?.title?.trim();
      const actualStart = timestamp(details?.actualStartTime);
      const startAt = actualStart ?? timestamp(details?.scheduledStartTime);
      const endAt = timestamp(details?.actualEndTime);
      if (!videoIdPattern.test(id ?? '') || !title) continue;
      const status = endAt ? 'past' : actualStart ? 'live' : startAt ? 'upcoming' : null;
      const durationSeconds = durationInSeconds(contentDetails?.duration);
      const isBroadcast = apiBroadcastEvidence(item, status, startAt, evidence.get(id), durationSeconds);
      streams.push(stream({ id, title, status, startAt, endAt, channelId: snippet.channelId, isBroadcast, durationSeconds }));
    }
  }
  return streams;
}

export async function getYouTubeVideos(videoIds, {
  fetchImpl = fetch, apiKey = process.env.YOUTUBE_API_KEY, verifyBroadcast = false,
} = {}) {
  const ids = [...new Set(videoIds)].filter((id) => typeof id === 'string' && videoIdPattern.test(id));
  const options = { fetchImpl, signal: AbortSignal.timeout(requestTimeoutMs) };
  if (!apiKey) return readPublicVideos(ids.map((id) => ({ id })), options);

  const videos = await readApiVideos(ids, options, apiKey);
  if (!verifyBroadcast) return videos;
  const unknown = videos.filter(({ isBroadcast }) => isBroadcast === null).slice(0, 6);
  if (!unknown.length) return videos;

  const checked = await readPublicVideos(unknown, { ...options, signal: AbortSignal.timeout(supplementTimeoutMs) }).catch(() => []);
  const checksById = new Map(checked.map((video) => [video.id, video]));
  return videos.map((video) => {
    const check = checksById.get(video.id);
    if (check?.isBroadcast == null || (video.channelId && check.channelId && video.channelId !== check.channelId)) return video;
    return { ...video, isBroadcast: check.isBroadcast };
  });
}

export async function getYouTubeChannel(rawUrl, { fetchImpl = fetch, apiKey = process.env.YOUTUBE_API_KEY } = {}) {
  const url = normalizeChannelUrl(rawUrl);
  const options = { fetchImpl, signal: AbortSignal.timeout(requestTimeoutMs) };
  const channel = apiKey
    ? await readApiChannel(url, options, apiKey)
    : await readPublicChannel(url, options);
  channel.streams.sort((a, b) => a.startAt.localeCompare(b.startAt));
  return channel;
}
