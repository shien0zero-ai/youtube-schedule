import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { hololiveGroupChannels, rosterGroups } from './data/hololive-roster.mjs';
import { musicVideoArchives, musicVideoStatsObservedAt } from './data/music-video-archives.mjs';
import { musicVideoMemberReadings } from './data/music-video-member-readings.mjs';
import { classifyMusicKind, isMusicVideoTitle } from './music-video-classification.mjs';

const channels = new Map([
  ...Object.entries(rosterGroups).flatMap(([channelGroup, rows]) =>
    rows.map(([id, channelName]) => [id, { channelName, channelGroup }])),
  ...hololiveGroupChannels,
]);
const channelIds = [...channels.keys()];
const batchInterval = 2 * 60 * 1000;
const collectionInterval = 6 * 60 * 60 * 1000;
const retryInterval = 15 * 60 * 1000;
const day = 24 * 60 * 60 * 1000;
const jstOffset = 9 * 60 * 60 * 1000;
const trendWindow = 7 * day;
const channelBatchSize = 6;
const metadataBatchSize = 50;

function countOrNull(count) {
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function viewsInWindow(history, time) {
  return history.filter(([at]) => at >= time - trendWindow && at <= time);
}

function observeViews(history, count, time) {
  const today = Math.floor((time + jstOffset) / day);
  const recent = viewsInWindow(history, time);
  const last = recent.at(-1);
  if (last && Math.floor((last[0] + jstOffset) / day) === today) recent.pop();
  recent.push([time, count]);
  return recent;
}

function musicVideo(record) {
  const { id, title, channelId, startAt, status, publishedAt, viewCount, likeCount, musicKind } = record;
  if (!/^[\w-]{11}$/.test(id ?? '') || !channels.has(channelId) || !title || !Number.isFinite(Date.parse(startAt)) ||
    !['upcoming', 'live', 'past'].includes(status)) return null;
  return {
    id, title, channelId, startAt, status, publishedAt: publishedAt ?? null,
    viewCount: countOrNull(viewCount), likeCount: countOrNull(likeCount),
    musicKind: ['original', 'cover'].includes(musicKind) ? musicKind : classifyMusicKind(title),
    platform: 'youtube', url: `https://www.youtube.com/watch?v=${id}`,
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    ...channels.get(channelId),
  };
}

const seed = new Map();
const seedObservedAt = Date.parse(musicVideoStatsObservedAt);
for (const [id, channelId, publishedAt, title, viewCount, likeCount, musicKind] of musicVideoArchives) {
  const video = musicVideo({ id, channelId, title, startAt: publishedAt, publishedAt, status: 'past', viewCount, likeCount, musicKind });
  if (video) {
    const viewHistory = video.viewCount !== null && Number.isFinite(seedObservedAt) ? [[seedObservedAt, video.viewCount]] : [];
    seed.set(id, { ...video, viewHistory, youtubeConfirmed: true, holoduleListed: false });
  }
}

function readCatalog(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {};
  }
}

function batch(values, { cursor = 0 }, size) {
  const start = cursor < values.length ? cursor : 0;
  const selected = values.slice(start, start + size);
  return { selected, nextCursor: start + selected.length < values.length ? start + selected.length : 0 };
}

export function createMusicVideoCatalog({ scheduleFile, now, getMusicVideos, getRecentMusicVideos }) {
  const file = join(dirname(scheduleFile), `${basename(scheduleFile, extname(scheduleFile))}-mv.json`);
  const saved = readCatalog(file);
  let entries = new Map();
  for (const record of saved.videos ?? []) {
    const video = musicVideo(record);
    if (!video) continue;
    const archived = seed.get(video.id);
    entries.set(video.id, {
      ...video,
      viewCount: video.viewCount ?? archived?.viewCount ?? null,
      likeCount: video.likeCount ?? archived?.likeCount ?? null,
      musicKind: archived?.musicKind ?? video.musicKind,
      viewHistory: record.viewHistory ?? archived?.viewHistory ?? [],
      youtubeConfirmed: record.youtubeConfirmed === true,
      holoduleListed: record.holoduleListed === true,
    });
  }
  let uploads = saved.uploads ?? { cursor: 0, nextAt: 0 };
  let metadata = saved.metadata ?? { cursor: 0, nextAt: 0 };
  let refreshing;
  let warning;

  function save(next, nextUploads = uploads, nextMetadata = metadata) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify({ videos: [...next.values()], uploads: nextUploads, metadata: nextMetadata }), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    entries = next;
    uploads = nextUploads;
    metadata = nextMetadata;
  }

  function merge(next, record, observedAt = null) {
    const video = musicVideo(record);
    if (!video) return false;
    const fromHolodule = observedAt === null;
    const previous = next.get(video.id) ?? seed.get(video.id);
    if (previous?.channelId && previous.channelId !== video.channelId) return false;
    const keepTiming = (fromHolodule && previous?.youtubeConfirmed && previous.status === 'past') ||
      (!fromHolodule && previous?.holoduleListed && previous.status === 'upcoming' && video.status === 'upcoming');
    const history = previous?.viewHistory ?? [];
    const merged = {
      ...video,
      title: fromHolodule && previous?.youtubeConfirmed ? previous.title : video.title,
      startAt: keepTiming ? previous.startAt : video.startAt,
      status: keepTiming ? previous.status : video.status,
      publishedAt: fromHolodule ? previous?.publishedAt ?? null : video.publishedAt,
      viewCount: fromHolodule ? previous?.viewCount ?? null : video.viewCount ?? previous?.viewCount ?? null,
      likeCount: fromHolodule ? previous?.likeCount ?? null : video.likeCount ?? previous?.likeCount ?? null,
      musicKind: seed.get(video.id)?.musicKind ?? (fromHolodule && previous?.youtubeConfirmed
        ? previous.musicKind ?? video.musicKind : video.musicKind ?? previous?.musicKind ?? null),
      viewHistory: !fromHolodule && video.viewCount !== null ? observeViews(history, video.viewCount, observedAt) : history,
      youtubeConfirmed: !fromHolodule || previous?.youtubeConfirmed === true,
      holoduleListed: fromHolodule || previous?.holoduleListed === true,
    };
    if (JSON.stringify(previous) === JSON.stringify(merged)) return false;
    next.set(video.id, merged);
    return true;
  }

  function observeHolodule(official) {
    const listed = new Set(official.holoduleIds);
    const next = new Map(entries);
    let changed = false;
    for (const [id, video] of next) {
      if (video.holoduleListed && !listed.has(id)) {
        next.set(id, { ...video, holoduleListed: false });
        changed = true;
      }
    }
    for (const stream of official.streams ?? []) {
      if (stream.platform !== 'youtube' || !listed.has(stream.id)) continue;
      const known = next.get(stream.id) ?? seed.get(stream.id);
      const title = [stream.title, stream.holoduleTitle].find((name) => isMusicVideoTitle(name)) ?? known?.title;
      if (!title) continue;
      const musicKind = classifyMusicKind(stream.title) ?? classifyMusicKind(stream.holoduleTitle);
      if (merge(next, { ...stream, title, musicKind, channelId: stream.uploaderChannelId ?? stream.channelId })) changed = true;
    }
    if (changed) save(next);
  }

  function catalog() {
    return entries.size ? new Map([...seed, ...entries]) : seed;
  }

  async function refreshSources(time) {
    const checks = [];
    if (getRecentMusicVideos && time >= uploads.nextAt) {
      const { selected, nextCursor } = batch(channelIds, uploads, channelBatchSize);
      checks.push({ key: 'uploads', nextCursor, read: () => getRecentMusicVideos(selected) });
    }
    if (getMusicVideos && time >= metadata.nextAt) {
      const ids = [...catalog().keys()];
      if (ids.length) {
        const { selected, nextCursor } = batch(ids, metadata, metadataBatchSize);
        checks.push({ key: 'metadata', nextCursor, read: () => getMusicVideos(selected, { includeKnown: true }) });
      }
    }
    if (!checks.length) return;

    const results = await Promise.allSettled(checks.map(({ read }) => Promise.resolve().then(read)));
    const observedAt = now();
    const next = new Map(entries);
    const nextScan = { uploads, metadata };
    let failed = false;
    for (const [index, result] of results.entries()) {
      const { key, nextCursor } = checks[index];
      if (result.status === 'fulfilled') {
        for (const video of result.value) merge(next, video, observedAt);
        nextScan[key] = { cursor: nextCursor, nextAt: time + (nextCursor ? batchInterval : collectionInterval) };
      } else {
        nextScan[key] = { cursor: nextCursor, nextAt: time + retryInterval };
        failed = true;
      }
    }
    save(next, nextScan.uploads, nextScan.metadata);
    warning = failed ? 'YouTube のMVを一部更新できませんでした。取得済みの情報を表示しています。' : undefined;
  }

  function refresh() {
    if (refreshing) return refreshing;
    refreshing = refreshSources(now()).finally(() => { refreshing = undefined; });
    return refreshing;
  }

  function snapshot(hidden, include) {
    const videos = include ? [] : null;
    let count = 0;
    const time = now();
    for (const record of catalog().values()) {
      if (hidden.has(record.channelId)) continue;
      count++;
      if (!videos) continue;
      const { viewHistory, ...video } = record;
      const scheduled = Date.parse(video.startAt);
      const unconfirmed = !video.holoduleListed && video.status !== 'past' &&
        scheduled <= time - (video.youtubeConfirmed ? day : 0);
      const history = viewsInWindow(viewHistory, time);
      videos.push({
        ...video,
        memberReading: musicVideoMemberReadings.get(video.channelId) ?? video.channelName,
        viewGain7d: history.length >= 2 ? history.at(-1)[1] - history[0][1] : null,
        ...(unconfirmed ? { status: 'past', archiveUnconfirmed: true } : {}),
      });
    }
    return {
      musicVideosCount: count,
      ...(videos ? { musicVideos: videos, musicVideosWarning: warning } : {}),
    };
  }

  return { observeHolodule, refresh, snapshot };
}
