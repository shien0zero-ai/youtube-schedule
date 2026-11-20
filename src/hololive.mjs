import { rosterGroups } from './data/hololive-roster.mjs';
import { getYouTubeVideos } from './youtube.mjs';

const officialUrl = 'https://schedule.hololive.tv/';
const hour = 60 * 60 * 1000;
const day = 24 * hour;
const groups = Object.entries(rosterGroups).flatMap(([group, rows]) => rows.map(
  ([id, name, aliases, avatar, affiliation = 'active']) => ({
    aliases,
    channel: { id, name, group, affiliation, url: `https://www.youtube.com/channel/${id}`, ...(avatar ? { avatar } : {}) },
  }),
));
const roster = groups.map(({ channel }) => channel);
const channelsById = new Map(roster.map((channel) => [channel.id, channel]));
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

function findChannel(name) {
  const key = nameKey(name);
  const direct = channelsByName.get(key);
  if (direct) return direct;
  const asobiName = key.match(/(?:メラ|ソピア|つづり|ツヅリ)$/)?.[0];
  return asobiName ? channelsByName.get(asobiName) : null;
}

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

function youtubeId(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  let id;
  if (url.hostname === 'youtu.be') {
    id = url.pathname.slice(1);
  } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
    id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/live\/([^/]+)\/?$/)?.[1];
  }
  return /^[\w-]{11}$/.test(id ?? '') ? id : null;
}

function isLiveCard(attrs) {
  return /\bborder(?:-color)?\s*:[^;]*(?:\bred\b|#f00(?:000)?\b|#ff0000\b|rgb\(\s*255\s*,\s*0\s*,\s*0\s*\))/i.test(attrs.style ?? '')
    || hasClass(attrs, 'live')
    || hasClass(attrs, 'is-live')
    || ['live', 'true'].includes(attrs['data-live']);
}

export function parseOfficialSchedule(html, now = Date.now()) {
  const pane = [...html.matchAll(/<div\b[^>]*>/gi)].find((match) => {
    const attrs = attributes(match[0]);
    return attrs.id === 'all' && hasClass(attrs, 'tab-pane');
  });
  if (!pane) throw new Error('ホロジュールの配信一覧が見つかりませんでした。');

  const records = new Map();
  const content = html.slice(pane.index + pane[0].length);
  let date;
  for (const match of content.matchAll(/<(div|a)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = attributes(match[0]);
    const rest = () => content.slice(match.index + match[0].length);
    if (hasClass(attrs, 'tab-pane')) break;
    if (hasClass(attrs, 'holodule') && hasClass(attrs, 'navbar-text')) {
      const [, month, dayOfMonth] = textContent(rest().split(/<\/div>/i, 1)[0]).match(/(\d{1,2})\s*\/\s*(\d{1,2})/) ?? [];
      date = nearestTokyoDate(Number(month), Number(dayOfMonth), now);
    } else if (match[1].toLowerCase() === 'a' && hasClass(attrs, 'thumbnail')) {
      const id = youtubeId(attrs.href);
      if (!id) continue;
      const card = rest().split(/<\/a>/i, 1)[0];
      const channel = findChannel(cardField(card, 'name'));
      if (!channel) continue;
      const [, hours, minutes] = cardField(card, 'datetime').match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/) ?? [];
      if (!date || !hours) throw new Error('ホロジュールの配信日時を読み取れませんでした。');
      const ms = Date.parse(`${date}T${hours.padStart(2, '0')}:${minutes}:00+09:00`);
      const title = attrs.title?.trim();
      const record = {
        id,
        channelId: channel.id,
        title: title || `${channel.name} の配信`,
        status: isLiveCard(attrs) ? 'live' : ms > now ? 'upcoming' : 'past',
        startAt: new Date(ms).toISOString(),
        endAt: null,
        thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        url: `https://www.youtube.com/watch?v=${id}`,
      };
      if (!records.has(id) || record.status === 'live') records.set(id, record);
    }
  }
  return [...records.values()];
}

function enrichmentPriority(record, now) {
  if (record.status === 'live') return 0;
  return 1 + Math.abs(Date.parse(record.startAt) - now);
}

async function enrichAvailable(records, fetchImpl, time, apiKey) {
  const cache = videoCaches.get(fetchImpl) ?? new Map();
  videoCaches.set(fetchImpl, cache);
  const recordIds = new Set(records.map(({ id }) => id));
  for (const id of cache.keys()) {
    if (!recordIds.has(id)) cache.delete(id);
  }
  const candidates = records.filter(({ id, status, startAt }) =>
    cache.get(id)?.expiresAt > time ? false : status !== 'past' || Date.parse(startAt) > time - day);
  candidates.sort((left, right) => enrichmentPriority(left, time) - enrichmentPriority(right, time));
  const ids = candidates.slice(0, apiKey ? 50 : 12).map(({ id }) => id);
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
  const streams = records.map((record) => {
    const cached = cache.get(record.id);
    const details = cached?.video;
    if (!details?.status || (record.status === 'past' && !details.endAt)) incomplete = true;
    if (!details) return record;
    const channel = channelsById.get(details.channelId);
    const fresh = cached.expiresAt > time;
    const actualStatus = fresh || details.endAt ? details.status : null;
    return {
      ...record,
      channelId: channel?.id ?? record.channelId,
      title: details.title,
      thumbnail: details.thumbnail,
      status: actualStatus ?? record.status,
      startAt: actualStatus ? details.startAt ?? record.startAt : record.startAt,
      endAt: details.endAt,
    };
  });
  return { streams, incomplete };
}

export async function getHololive({ fetchImpl = fetch, now = Date.now, apiKey = process.env.YOUTUBE_API_KEY } = {}) {
  let records;
  const time = now();
  try {
    const response = await fetchImpl(officialUrl, {
      headers: { Accept: 'text/html', 'Accept-Language': 'ja', Cookie: 'timezone=Asia/Tokyo' },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    records = parseOfficialSchedule(await response.text(), time);
  } catch {
    return {
      channels: roster,
      streams: [],
      scheduleAvailable: false,
      warning: '公式ホロジュールに接続できないか、配信一覧を読み取れませんでした。',
    };
  }
  const { streams, incomplete } = await enrichAvailable(records, fetchImpl, time, apiKey);
  return {
    channels: roster,
    streams,
    scheduleAvailable: true,
    ...(incomplete ? { warning: '一部の配信は公式ホロジュールの時刻と配信中表示で分類しています。' } : {}),
  };
}
