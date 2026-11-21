import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { hololiveGroupChannels, rosterGroups } from './data/hololive-roster.mjs';
import { musicVideoArchives } from './data/music-video-archives.mjs';
import { isMusicVideoTitle } from './music-video-classification.mjs';

const channels = new Map([
  ...Object.entries(rosterGroups).flatMap(([channelGroup, rows]) =>
    rows.map(([id, channelName]) => [id, { channelName, channelGroup }])),
  ...hololiveGroupChannels,
]);
const channelIds = [...channels.keys()];
const batchInterval = 2 * 60 * 1000;
const collectionInterval = 6 * 60 * 60 * 1000;
const retryInterval = 15 * 60 * 1000;
const stalePremiereInterval = 24 * 60 * 60 * 1000;
const channelBatchSize = 6;
const metadataBatchSize = 50;

function musicVideo(record) {
  const { id, title, channelId, startAt, status, publishedAt, viewCount } = record;
  if (!/^[\w-]{11}$/.test(id ?? '') || !channels.has(channelId) || !title || !Number.isFinite(Date.parse(startAt)) ||
    !['upcoming', 'live', 'past'].includes(status)) return null;
  return {
    id, title, channelId, startAt, status, publishedAt: publishedAt ?? null,
    viewCount: Number.isSafeInteger(viewCount) && viewCount >= 0 ? viewCount : null,
    platform: 'youtube', url: `https://www.youtube.com/watch?v=${id}`,
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    ...channels.get(channelId),
  };
}

const seed = new Map();
for (const [id, channelId, publishedAt, title, viewCount] of musicVideoArchives) {
  const video = musicVideo({ id, channelId, title, startAt: publishedAt, publishedAt, status: 'past', viewCount });
  if (video) seed.set(id, { ...video, youtubeConfirmed: true, holoduleListed: false });
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
  let entries = new Map((saved.videos ?? []).filter((record) => musicVideo(record)).map((video) => [video.id, video]));
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

  function merge(next, record, fromHolodule) {
    const video = musicVideo(record);
    if (!video) return false;
    const previous = next.get(video.id) ?? seed.get(video.id);
    if (previous?.channelId && previous.channelId !== video.channelId) return false;
    const keepTiming = (fromHolodule && previous?.youtubeConfirmed && previous.status === 'past') ||
      (!fromHolodule && previous?.holoduleListed && previous.status === 'upcoming' && video.status === 'upcoming');
    const merged = {
      ...video,
      title: fromHolodule && previous?.youtubeConfirmed ? previous.title : video.title,
      startAt: keepTiming ? previous.startAt : video.startAt,
      status: keepTiming ? previous.status : video.status,
      publishedAt: fromHolodule ? previous?.publishedAt ?? null : video.publishedAt,
      viewCount: video.viewCount ?? previous?.viewCount ?? null,
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
      if (merge(next, { ...stream, title, channelId: stream.uploaderChannelId ?? stream.channelId }, true)) changed = true;
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
    const next = new Map(entries);
    const nextScan = { uploads, metadata };
    let failed = false;
    for (const [index, result] of results.entries()) {
      const { key, nextCursor } = checks[index];
      if (result.status === 'fulfilled') {
        for (const video of result.value) merge(next, video, false);
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
    for (const video of catalog().values()) {
      if (hidden.has(video.channelId)) continue;
      count++;
      if (!videos) continue;
      const scheduled = Date.parse(video.startAt);
      const unconfirmed = !video.holoduleListed && video.status !== 'past' &&
        scheduled <= time - (video.youtubeConfirmed ? stalePremiereInterval : 0);
      videos.push(unconfirmed ? { ...video, status: 'past', archiveUnconfirmed: true } : video);
    }
    return {
      musicVideosCount: count,
      ...(videos ? { musicVideos: videos, musicVideosWarning: warning } : {}),
    };
  }

  return { observeHolodule, refresh, snapshot };
}
