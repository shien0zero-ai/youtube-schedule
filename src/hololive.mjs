import { createHash } from 'node:crypto';
import { isNonBroadcastTitle } from './broadcasts.mjs';
import { officialHololiveChannelId, rosterGroups } from './data/hololive-roster.mjs';
import { getYouTubeChannel, getYouTubeVideos, youtubeVideoId } from './youtube.mjs';

const officialScheduleUrl = 'https://schedule.hololive.tv/lives/hololive';
const hour = 60 * 60 * 1000;
const groups = Object.entries(rosterGroups).flatMap(([group, rows]) => rows.map(
  ([id, name, aliases, avatar, affiliation = 'active']) => ({
    aliases,
    channel: { id, name, group, affiliation, url: `https://www.youtube.com/channel/${id}`, ...(avatar ? { avatar } : {}) },
  }),
));
const roster = groups.map(({ channel }) => channel);
const channelsById = new Map(roster.map((channel) => [channel.id, channel]));
const officialChannel = channelsById.get(officialHololiveChannelId);
const videoCaches = new WeakMap();

function decodeText(value) {
  const entities = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    if (!code.startsWith('#')) return entities[code.toLowerCase()] ?? entity;
    const point = code[1]?.toLowerCase() === 'x'
      ? Number.parseInt(code.slice(2), 16)
      : Number(code.slice(1));
    return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
}

function textContent(html) {
  return decodeText(html.replace(/<[^>]*>/g, '').trim()).replace(/\s+/g, ' ').trim();
}

function nameKey(name) {
  return name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

const channelsByName = new Map(groups.flatMap(({ channel, aliases }) =>
  [channel.name, ...aliases].map((name) => [nameKey(name), channel])));

function attributes(tag) {
  const entries = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    entries[match[1].toLowerCase()] = decodeText(match[2] ?? match[3] ?? match[4]);
  }
  return entries;
}

function hasClass(attrs, name) {
  return attrs.class?.split(/\s+/).includes(name);
}

function cardField(html, name) {
  for (const match of html.matchAll(/<(?:div|span)\b[^>]*>/gi)) {
    if (hasClass(attributes(match[0]), name)) {
      return textContent(html.slice(match.index + match[0].length).split(/<\/(?:div|span)>/i, 1)[0]);
    }
  }
  return '';
}

function nearestTokyoDate(month, date, now) {
  const currentYear = new Date(now + 9 * hour).getUTCFullYear();
  let closest;
  for (const year of [currentYear - 1, currentYear, currentYear + 1]) {
    const candidate = new Date(Date.UTC(year, month - 1, date));
    if (candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== date) continue;
    if (!closest || Math.abs(candidate - now) < Math.abs(closest - now)) closest = candidate;
  }
  return closest?.toISOString().slice(0, 10);
}

function publicUrl(value) {
  if (!value?.trim() || value.startsWith('#')) return null;
  try {
    const url = new URL(value, officialScheduleUrl);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function identifier(prefix, ...parts) {
  return prefix + createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}

function cardPicture(html) {
  for (const match of html.matchAll(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = attributes(match[0]);
    const url = publicUrl(attrs['data-src'] || attrs.src);
    if (!url || url.pathname.startsWith('/dist/images/icons/') || /^(?:yt3|yt4)\./i.test(url.hostname)) continue;
    return { url: url.href, title: attrs.alt?.trim() };
  }
  return null;
}

function isLiveCard(attrs) {
  return /\bborder(?:-color)?\s*:[^;]*(?:\bred\b|#f00(?:000)?\b|#ff0000\b|rgb\(\s*255\s*,\s*0\s*,\s*0\s*\))/i.test(attrs.style ?? '')
    || hasClass(attrs, 'live')
    || hasClass(attrs, 'is-live')
    || ['live', 'true'].includes(attrs['data-live']);
}

function linkedBroadcast(link, videoId, startAt, live) {
  if (!link) return false;
  const host = link.hostname.replace(/^www\./, '');
  const path = link.pathname;
  if (videoId) {
    if (path.startsWith('/shorts/')) return false;
    return path.startsWith('/live/') || live ? true : null;
  }
  if (['youtube.com', 'm.youtube.com', 'youtu.be', 'clips.twitch.tv'].includes(host)) return false;
  if (host === 'twitch.tv') return /^\/(?:videos\/\d+|[a-z\d_]{2,25})\/?$/i.test(path);
  if (host === 'live.nicovideo.jp') return /^\/watch\/lv\d+\/?$/.test(path);
  if (host === 'twitcasting.tv') return /^\/[\w.-]+(?:\/movie\/\d+)?\/?$/.test(path);
  return startAt ? (live ? true : null) : false;
}

export function holoduleBroadcast(record, details) {
  if (record.isBroadcast === false || details?.isBroadcast === false) return false;
  if (details?.isBroadcast === true) return true;
  if ([record.title, record.holoduleTitle, details?.title].some((title) => isNonBroadcastTitle(title))) return false;
  if (details?.durationSeconds > 0 && details.durationSeconds <= 60) return null;
  if (record.isBroadcast === true) return true;
  if (!record.startAt || !details?.startAt || !details.status) return null;

  // A timed Holodule listing can corroborate the API's broadcast metadata when the player is unavailable.
  const elapsed = Date.parse(details.endAt) - Date.parse(details.startAt);
  return details.durationSeconds > 60 || elapsed > 60 * 1000
    || (details.durationSeconds === 0 && details.status !== 'past') ? true : null;
}

export function parseOfficialSchedule(html, now = Date.now()) {
  const pane = [...html.matchAll(/<div\b[^>]*>/gi)].find((match) => {
    const attrs = attributes(match[0]);
    return attrs.id === 'all' && hasClass(attrs, 'tab-pane');
  });
  if (!pane) throw new Error('ホロジュールの配信一覧が見つかりませんでした。');

  const records = new Map();
  const channels = new Map();
  const content = html.slice(pane.index + pane[0].length);
  let date;
  let depth = 1;
  for (const match of content.matchAll(/<\/?(div|a)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const tagName = match[1].toLowerCase();
    const closing = match[0].startsWith('</');
    if (tagName === 'div') depth += closing ? -1 : 1;
    if (depth === 0) break;
    if (closing) continue;
    const attrs = attributes(match[0]);
    const rest = () => content.slice(match.index + match[0].length);
    if (hasClass(attrs, 'tab-pane')) break;
    if (hasClass(attrs, 'holodule') && hasClass(attrs, 'navbar-text')) {
      const [, month, dayOfMonth] = textContent(rest().split(/<\/div>/i, 1)[0]).match(/(\d{1,2})\s*\/\s*(\d{1,2})/) ?? [];
      date = nearestTokyoDate(Number(month), Number(dayOfMonth), now);
    } else if (tagName === 'a' && hasClass(attrs, 'thumbnail')) {
      const link = publicUrl(attrs.href);
      const videoId = youtubeVideoId(link);
      const card = rest().split(/<\/a>/i, 1)[0];
      const name = cardField(card, 'name');
      const key = nameKey(name);
      let channel = channelsByName.get(key);
      if (!channel) {
        const id = identifier('holodule-', key || name);
        channel = channels.get(id) ?? {
          id, name: name || 'ホロジュール', group: 'ホロジュール',
          holodule: true, holoduleScope: 'hololive', url: officialScheduleUrl,
        };
        channels.set(id, channel);
      }
      const [, hours, minutes] = cardField(card, 'datetime').match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/) ?? [];
      const ms = date && hours ? Date.parse(`${date}T${hours.padStart(2, '0')}:${minutes}:00+09:00`) : null;
      const startAt = ms === null ? null : new Date(ms).toISOString();
      const picture = cardPicture(card);
      const title = attrs.title?.trim() || picture?.title || null;
      const live = isLiveCard(attrs);
      // Keep non-YouTube card IDs stable when the source has no title.
      const id = videoId ?? identifier('holodule-card-', channel.id, link?.href, startAt ?? date ?? null,
        title ?? (name ? `${channel.name} の配信` : 'ホロジュールのお知らせ'), picture?.url);
      const record = {
        id,
        channelId: channel.id,
        title,
        status: live ? 'live' : ms === null || ms > now ? 'upcoming' : 'past',
        isBroadcast: linkedBroadcast(link, videoId, startAt, live),
        startAt,
        ...(!startAt && date ? { scheduleDate: date } : {}),
        endAt: null,
        platform: videoId ? 'youtube' : link?.hostname.replace(/^www\./, '') ?? null,
        thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : picture?.url ?? null,
        url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : link?.href ?? null,
      };
      if (!records.has(id) || record.status === 'live') records.set(id, record);
    }
  }
  return { streams: [...records.values()], channels: [...channels.values()] };
}

function enrichmentPriority(record, now) {
  if (record.status === 'live') return 0;
  if (record.startAt === null) return Number.MAX_SAFE_INTEGER;
  return 1 + Math.abs(Date.parse(record.startAt) - now);
}

async function enrichAvailable(records, fetchImpl, time, apiKey) {
  const cache = videoCaches.get(fetchImpl) ?? new Map();
  videoCaches.set(fetchImpl, cache);
  const recordIds = new Set(records.map(({ id }) => id));
  for (const id of cache.keys()) {
    if (!recordIds.has(id)) cache.delete(id);
  }
  const candidates = records.filter(({ id, platform }) =>
    platform === 'youtube' && !(cache.get(id)?.expiresAt > time));
  candidates.sort((left, right) => Number(cache.has(left.id)) - Number(cache.has(right.id)) ||
    enrichmentPriority(left, time) - enrichmentPriority(right, time));
  const ids = candidates.slice(0, apiKey ? 150 : 12).map(({ id }) => id);
  if (ids.length) {
    const videos = await getYouTubeVideos(ids, { fetchImpl, apiKey }).catch(() => []);
    const byId = new Map(videos.map((video) => [video.id, video]));
    for (const id of ids) {
      const video = byId.get(id);
      const delay = video?.endAt ? 6 * hour : video?.status ? 2 * 60 * 1000 : 6 * 60 * 1000;
      cache.set(id, { video, expiresAt: time + delay });
    }
  }
  let incomplete = false;
  const knownNonBroadcastIds = new Set();
  const streams = records.map((record) => {
    if (record.platform !== 'youtube') return { ...record, isBroadcast: holoduleBroadcast(record) };
    const cached = cache.get(record.id);
    const details = cached?.video;
    if (record.isBroadcast === false || details?.isBroadcast === false) knownNonBroadcastIds.add(record.id);
    const isBroadcast = holoduleBroadcast(record, details);
    if (isBroadcast !== false && (isBroadcast === null || !details?.status || (record.status === 'past' && !details.endAt))) incomplete = true;
    if (!details) return { ...record, isBroadcast };
    const channel = channelsById.has(record.channelId) ? channelsById.get(details.channelId) : null;
    const fresh = cached.expiresAt > time;
    const actualStatus = fresh || details.endAt ? details.status : null;
    return {
      ...record,
      channelId: channel?.id ?? record.channelId,
      ...(details.channelId && details.channelId !== (channel?.id ?? record.channelId) ? { uploaderChannelId: details.channelId } : {}),
      title: details.title,
      ...(record.title !== details.title ? { holoduleTitle: record.title } : {}),
      thumbnail: details.thumbnail,
      status: actualStatus ?? record.status,
      isBroadcast,
      startAt: actualStatus ? details.startAt ?? record.startAt : record.startAt,
      endAt: details.endAt,
    };
  });
  return { streams, incomplete, knownNonBroadcastIds };
}

async function readOfficialSchedule(fetchImpl, time, apiKey) {
  const response = await fetchImpl(officialScheduleUrl, {
    headers: { Accept: 'text/html', 'Accept-Language': 'ja', Cookie: 'timezone=Asia/Tokyo' },
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { channels, streams } = parseOfficialSchedule(await response.text(), time);
  return { channels, ...await enrichAvailable(streams, fetchImpl, time, apiKey) };
}

async function readOfficialChannel(fetchImpl, apiKey) {
  const channel = await getYouTubeChannel(officialChannel.url, { fetchImpl, apiKey });
  if (channel.channelId !== officialChannel.id) throw new Error('公式チャンネルのIDが一致しません。');
  return channel;
}

export async function getHololive({ fetchImpl = fetch, now = Date.now, apiKey = process.env.YOUTUBE_API_KEY } = {}) {
  const [scheduleResult, channelResult] = await Promise.allSettled([
    readOfficialSchedule(fetchImpl, now(), apiKey),
    readOfficialChannel(fetchImpl, apiKey),
  ]);
  const schedule = scheduleResult.status === 'fulfilled' ? scheduleResult.value : null;
  const channel = channelResult.status === 'fulfilled' ? channelResult.value : null;
  const warnings = [];
  if (!schedule) warnings.push('公式ホロジュールに接続できないか、配信一覧を読み取れませんでした。');
  else if (schedule.incomplete) warnings.push('一部の枠の配信状態やタイトルを確認できませんでした。');
  if (!channel || channel.warning) warnings.push('ホロライブ公式の YouTube チャンネルから配信一覧を取得できませんでした。');

  const streams = new Map((schedule?.streams ?? []).map((stream) => [stream.id, stream]));
  for (const stream of channel?.streams ?? []) {
    const listed = streams.get(stream.id);
    streams.set(stream.id, {
      ...stream, channelId: listed?.channelId ?? officialChannel.id, platform: 'youtube',
      isBroadcast: schedule?.knownNonBroadcastIds.has(stream.id) ? false
        : stream.isBroadcast ?? listed?.isBroadcast ?? (isNonBroadcastTitle(stream.title) ? false : null),
      ...(listed ? { holoduleTitle: listed.holoduleTitle ?? listed.title, uploaderChannelId: officialChannel.id } : {}),
    });
  }

  const channels = [...roster, ...(schedule?.channels ?? [])];
  const updatedChannelIds = schedule ? channels.filter(({ id }) => id !== officialChannel.id).map(({ id }) => id) : [];
  if (channel && !channel.warning) updatedChannelIds.push(officialChannel.id);

  return {
    channels,
    streams: [...streams.values()],
    holoduleIds: (schedule?.streams ?? []).map(({ id }) => id),
    scheduleAvailable: Boolean(schedule),
    updatedChannelIds,
    warnings,
  };
}
