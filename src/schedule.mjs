import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { prepareArchives } from './archives.mjs';
import { isNonBroadcast, knownTitle } from './broadcasts.mjs';
import { rosterGroups } from './data/hololive-roster.mjs';
import { holoduleBroadcast } from './hololive.mjs';
import { createMusicVideoCatalog } from './music-videos.mjs';
import { ScheduleError } from './schedule-error.mjs';
import { initialSpecialLives, specialLiveChannelIds } from './special-lives.mjs';
import { isSpecialLive } from './special-lives-classification.mjs';
import { youtubeVideoId } from './youtube.mjs';

const DAY = 24 * 60 * 60 * 1000;
const REFRESH_INTERVAL = 2 * 60 * 1000;
const FORCED_REFRESH_INTERVAL = 15 * 1000;
const ARCHIVE_LOOKUP_LIMIT = 6;
const ARCHIVE_RETRY_INTERVAL = 6 * 60 * 60 * 1000;
const TITLE_LOOKUP_LIMIT = 12;
const TITLE_RETRY_INTERVAL = 6 * 60 * 1000;
const titlePriority = { live: 0, upcoming: 1, past: 2 };
const aliasesByChannel = new Map(Object.values(rosterGroups).flat().map(([id, , aliases]) => [id, aliases]));

function readState(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { roster: [], custom: [], preferences: {}, streams: [] };
  }
}

function scheduledTime({ startAt, scheduleDate }) {
  if (startAt) return Date.parse(startAt);
  return scheduleDate ? Date.parse(`${scheduleDate}T00:00:00+09:00`) + DAY : NaN;
}

export function retainStreams(streams, channels, preferences, time, holoduleIds = []) {
  const channelsById = new Map(channels.map((channel) => [channel.id, channel]));
  const listed = new Set(holoduleIds);
  return streams.filter((stream) => {
    const channel = channelsById.get(stream.channelId);
    if (!channel) return false;
    const preference = preferences[stream.channelId];
    const keepPast = preference ?? (!channel.holodule || channel.holoduleScope === 'hololive');
    if (keepPast || stream.manualArchive || listed.has(stream.id)) return true;
    if (stream.status !== 'past' && !stream.missingFromSource) return true;
    const end = stream.endAt ? Date.parse(stream.endAt) : scheduledTime(stream);
    return end > time - DAY;
  });
}

function displayStream(stream, time) {
  if (!stream.missingFromSource) return stream;
  if (!(scheduledTime(stream) <= time)) return null;
  const { missingFromSource, ...archive } = stream;
  return { ...archive, status: 'past', archiveUnconfirmed: true };
}

function withSourceTitles(stream, names) {
  const name = names.get(stream.channelId);
  return {
    ...stream,
    title: knownTitle(stream.title, name),
    ...(stream.holoduleTitle !== undefined ? { holoduleTitle: knownTitle(stream.holoduleTitle, name) } : {}),
  };
}

function mergeStreams(existing, incoming, time) {
  const merged = new Map(existing.map((stream) => [stream.id, stream]));
  for (const stream of incoming) {
    const previous = merged.get(stream.id);
    const liveEnded = previous?.status === 'live' && !previous.missingFromSource;
    const endAt = stream.endAt ?? (stream.status === 'past'
      ? previous?.endAt ?? (liveEnded ? new Date(time).toISOString() : null)
      : null);
    const mergedStream = { ...stream, endAt };
    if (!stream.endAt && endAt && (previous?.endAt ? previous.endAtEstimated : liveEnded)) {
      mergedStream.endAtEstimated = true;
    }
    if (!stream.title && previous?.title) mergedStream.title = previous.title;
    if (stream.isBroadcast == null && previous?.isBroadcast != null) mergedStream.isBroadcast = previous.isBroadcast;
    if (previous?.manualArchive) {
      mergedStream.manualArchive = true;
      if (!stream.startAt && !stream.scheduleDate && previous.scheduleDate) {
        mergedStream.scheduleDate = previous.scheduleDate;
      }
    }
    merged.set(stream.id, mergedStream);
  }
  return [...merged.values()];
}

function updateSpecialLives(saved, official, time) {
  const listedIds = new Set(official.holoduleIds);
  const savedIds = new Set(saved.map(({ id }) => id));
  const incoming = (official.streams ?? []).filter((stream) =>
    listedIds.has(stream.id) && specialLiveChannelIds.has(stream.channelId) &&
    (savedIds.has(stream.id) || initialSpecialLives.has(stream.id) || isSpecialLive(stream)));
  const incomingIds = new Set(incoming.map(({ id }) => id));
  const existing = saved.map((stream) => stream.status === 'past' || incomingIds.has(stream.id) || stream.missingFromSource
    ? stream : { ...stream, missingFromSource: true });
  return mergeStreams(existing, incoming, time);
}

export function createScheduleService({
  file, getHololive, getYouTubeChannel, getYouTubeVideos, getYouTubeTitles, normalizeChannelUrl,
  getMusicVideos, getRecentMusicVideos, now = Date.now,
}) {
  const music = createMusicVideoCatalog({ scheduleFile: file, now, getMusicVideos, getRecentMusicVideos });
  let state = { hidden: [], holoduleIds: [], specialLives: [], ...readState(file) };
  if (!state.specialLives.length && state.holoduleIds.length) {
    state.specialLives = updateSpecialLives([], state, now());
  }
  const savedNames = new Map([...state.roster, ...state.custom].map(({ id, name }) => [id, name]));
  state.streams = state.streams.map((stream) => withSourceTitles(stream, savedNames));
  state.specialLives = state.specialLives.map((stream) => withSourceTitles(stream, savedNames));
  let lastAttempt = null;
  let warnings = [];
  let refreshing;
  let fillingTitles;
  const archiveRetries = new Map();
  const titleAttempts = new Map();

  function save(next) {
    next.streams = retainStreams(next.streams, [...next.roster, ...next.custom], next.preferences, now(), next.holoduleIds);
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    state = next;
  }

  async function archiveDetails(streams) {
    const ids = [...new Set(streams.map((stream) => youtubeVideoId(URL.parse(stream.url))).filter(Boolean))];
    if (!getYouTubeVideos || !ids.length) return new Map();
    const details = await Promise.resolve().then(() => getYouTubeVideos(ids.slice(0, ARCHIVE_LOOKUP_LIMIT), { verifyBroadcast: true })).catch(() => []);
    return new Map(details.map((video) => [video.id, video]));
  }

  function recoverArchives(time) {
    if (!getYouTubeVideos) return new Map();
    for (const [id, until] of archiveRetries) if (until <= time) archiveRetries.delete(id);
    const listed = new Set(state.holoduleIds);
    const candidates = [...state.streams, ...state.specialLives.filter(({ manualArchive }) => manualArchive)].filter((stream) =>
      !isNonBroadcast(stream) && (!stream.title || stream.isBroadcast == null) &&
      (!listed.has(stream.id) || stream.isBroadcast === undefined) &&
      !archiveRetries.has(stream.id) && youtubeVideoId(URL.parse(stream.url)));
    const selected = candidates.slice(0, ARCHIVE_LOOKUP_LIMIT);
    for (const { id } of selected) archiveRetries.set(id, time + ARCHIVE_RETRY_INTERVAL);
    return archiveDetails(selected);
  }

  function withArchiveDetails(stream, video, listed = false) {
    if (!video) return stream;
    const fromHolodule = listed || stream.holoduleTitle !== undefined;
    const isBroadcast = isNonBroadcast(video) ? false
      : video.isBroadcast ?? (fromHolodule ? holoduleBroadcast(stream, video) : stream.isBroadcast);
    return {
      ...stream,
      title: stream.title ?? video.title ?? null,
      isBroadcast,
      ...(stream.manualArchive || isBroadcast !== true ? {} : {
        status: video.status ?? stream.status,
        startAt: video.startAt ?? stream.startAt,
        endAt: video.endAt ?? stream.endAt,
        ...(video.endAt && stream.endAtEstimated ? { endAtEstimated: undefined } : {}),
        missingFromSource: video.status === 'past' ? undefined : stream.missingFromSource,
      }),
    };
  }

  async function refreshSources(force) {
    lastAttempt = now();
    const registered = state.custom;
    const hololive = Promise.resolve().then(() => getHololive({ force })).catch(() => null);
    const archiveMetadata = recoverArchives(lastAttempt);
    const customStreams = [];
    const failures = [];
    const successful = new Set();
    let index = 0;

    await Promise.all(Array.from({ length: Math.min(3, registered.length) }, async () => {
      while (index < registered.length) {
        const channel = registered[index++];
        try {
          const channelData = await getYouTubeChannel(channel.url);
          if (channelData.warning) failures.push(channel);
          else successful.add(channel.id);
          for (const stream of channelData.streams) customStreams.push({ ...stream, channelId: channel.id });
        } catch {
          failures.push(channel);
        }
      }
    }));

    const official = await hololive;
    const archiveVideos = await archiveMetadata;
    const officialWarnings = official?.warnings ?? (official?.warning ? [official.warning] : []);
    const officialReady = official !== null && (official.scheduleAvailable ?? (officialWarnings.length === 0));
    const currentRoster = official?.channels?.length ? official.channels : state.roster;
    const presetIds = new Set(currentRoster.map(({ id }) => id));
    const previousHoloduleChannels = state.roster.filter(({ id, holodule }) => holodule && !presetIds.has(id));
    const roster = [...currentRoster, ...previousHoloduleChannels];
    const custom = state.custom.filter(({ id }) => !presetIds.has(id));
    const activeCustom = new Set(custom.map(({ id }) => id));
    const updatedChannels = new Set(successful);
    const officialUpdated = official?.updatedChannelIds ?? (officialReady ? presetIds : []);
    for (const id of officialUpdated) updatedChannels.add(id);
    if (officialReady) for (const { id } of previousHoloduleChannels) updatedChannels.add(id);
    const holoduleIds = officialReady ? official?.holoduleIds ?? [] : state.holoduleIds;
    const names = new Map([...roster, ...custom].map(({ id, name }) => [id, name]));
    const candidates = [
      ...customStreams.filter(({ channelId }) => activeCustom.has(channelId)),
      ...(official?.streams ?? []),
    ].map((stream) => withSourceTitles(stream, names));
    const incoming = candidates.filter((stream) => !isNonBroadcast(stream));
    const excludedIds = new Set(candidates.filter(isNonBroadcast).map(({ id }) => id));
    const incomingIds = new Set(incoming.map(({ id }) => id));
    const previouslyListed = new Set(state.holoduleIds);
    const existing = state.streams.map((saved) => {
      const wasListed = previouslyListed.has(saved.id);
      const stream = withArchiveDetails(saved, archiveVideos.get(saved.id), wasListed);
      if (excludedIds.has(stream.id)) return { ...stream, isBroadcast: false };
      if (stream.status === 'past' || stream.missingFromSource || incomingIds.has(stream.id)) return stream;
      const sourceUpdated = wasListed ? officialReady : updatedChannels.has(stream.channelId);
      return sourceUpdated ? { ...stream, missingFromSource: true } : stream;
    });
    const streams = mergeStreams(existing, incoming, now());
    const updatedAt = officialReady || official?.updatedChannelIds?.length || [...successful].some((id) => activeCustom.has(id))
      ? new Date(now()).toISOString()
      : state.updatedAt;
    const retained = retainStreams(streams, roster, state.preferences, now(), holoduleIds);
    const retainedChannels = new Set(retained.map(({ channelId }) => channelId));
    const hidden = new Set(state.hidden);
    const availableRoster = roster.filter(({ id }) =>
      presetIds.has(id) || retainedChannels.has(id) || hidden.has(id) || state.preferences[id] === true);
    const savedSpecialLives = state.specialLives.map((stream) => withArchiveDetails(stream, archiveVideos.get(stream.id)));
    const specialLives = officialReady ? updateSpecialLives(savedSpecialLives, official, now()) : savedSpecialLives;
    save({ ...state, roster: availableRoster, custom, streams, holoduleIds, updatedAt, specialLives });
    if (officialReady) music.observeHolodule(official);
    warnings = [
      ...(official === null ? ['ホロライブの配信情報を取得できませんでした。'] : officialWarnings),
      ...failures.filter(({ id }) => activeCustom.has(id))
        .map(({ name }) => `${name} の配信情報を更新できませんでした。`),
    ];
  }

  async function recoverMissingTitles(force) {
    const streams = [...state.streams, ...state.specialLives];
    if (streams.every((stream) => stream.title || stream.holoduleTitle)) {
      titleAttempts.clear();
      return;
    }
    const time = now();
    const hidden = new Set(state.hidden);
    const missing = new Map();
    const titles = new Map();
    for (const stream of streams) {
      if (hidden.has(stream.channelId) || isNonBroadcast(stream)) continue;
      const id = youtubeVideoId(URL.parse(stream.url));
      if (!id) continue;
      const title = stream.title ?? stream.holoduleTitle ?? initialSpecialLives.get(id)?.title;
      if (title) {
        titles.set(id, title);
        continue;
      }
      const priority = titlePriority[stream.status] ?? titlePriority.past;
      if (!missing.has(id) || priority < missing.get(id)) missing.set(id, priority);
    }

    const lastTry = (id) => titleAttempts.get(id) ?? -Infinity;
    for (const id of titleAttempts.keys()) if (!missing.has(id) || titles.has(id)) titleAttempts.delete(id);
    const ids = [...missing.keys()]
      .filter((id) => !titles.has(id) && (force || time - lastTry(id) >= TITLE_RETRY_INTERVAL))
      .sort((left, right) => missing.get(left) - missing.get(right) || lastTry(left) - lastTry(right))
      .slice(0, TITLE_LOOKUP_LIMIT);
    if (ids.length) {
      for (const id of ids) titleAttempts.set(id, time);
      const found = await Promise.resolve().then(() => getYouTubeTitles(ids)).catch(() => []);
      for (const { id, title } of found) if (ids.includes(id) && title) titles.set(id, title);
    }
    if (![...missing.keys()].some((id) => titles.has(id))) return;

    const names = new Map([...state.roster, ...state.custom].map(({ id, name }) => [id, name]));
    const fill = (stream) => {
      if (stream.title || stream.holoduleTitle || state.hidden.includes(stream.channelId)) return stream;
      const id = youtubeVideoId(URL.parse(stream.url));
      const title = missing.has(id) ? knownTitle(titles.get(id), names.get(stream.channelId)) : null;
      return title ? { ...stream, title } : stream;
    };
    save({ ...state, streams: state.streams.map(fill), specialLives: state.specialLives.map(fill) });
  }

  function refreshMissingTitles(force) {
    if (!getYouTubeTitles) return;
    if (fillingTitles) {
      if (!force || fillingTitles.force) return fillingTitles.promise;
      return fillingTitles.promise.then(() => refreshMissingTitles(true));
    }
    const promise = recoverMissingTitles(force).finally(() => { fillingTitles = undefined; });
    fillingTitles = { force, promise };
    return promise;
  }

  async function refresh(force = false) {
    const interval = force ? FORCED_REFRESH_INTERVAL : REFRESH_INTERVAL;
    if (!refreshing && (lastAttempt === null || now() - lastAttempt >= interval)) {
      refreshing = refreshSources(force).finally(() => { refreshing = undefined; });
    }
    await refreshing;
    await refreshMissingTitles(force);
  }

  function availableChannels() {
    // Older cached Holodule channels can be identified when the scoped feed lists them again.
    const roster = state.roster.filter(({ holodule, holoduleScope }) => !holodule || holoduleScope === 'hololive');
    return [
      ...roster.map((channel) => ({ ...channel, custom: false })),
      ...state.custom.map((channel) => ({ ...channel, custom: true })),
    ].map((channel) => ({
      ...channel,
      keepPast: state.preferences[channel.id] !== false,
      hidden: state.hidden.includes(channel.id),
      specialLiveEligible: specialLiveChannelIds.has(channel.id),
      aliases: aliasesByChannel.get(channel.id),
    }));
  }

  function snapshot({ includeSpecialLives = true, includeMusicVideos = false } = {}) {
    const channels = availableChannels();
    const time = now();
    const streams = retainStreams(state.streams, channels.filter(({ hidden }) => !hidden), state.preferences, time, state.holoduleIds);
    const specialLives = state.specialLives.length ? new Map(initialSpecialLives) : initialSpecialLives;
    for (const stream of state.specialLives) {
      const archived = specialLives.get(stream.id);
      specialLives.set(stream.id, { ...archived, ...stream, title: stream.title ?? archived?.title ?? null });
    }
    const hiddenIds = new Set(state.hidden);
    let specialLivesCount = 0;
    const visibleSpecialLives = includeSpecialLives ? [] : null;
    for (const stream of specialLives.values()) {
      if (!specialLiveChannelIds.has(stream.channelId) || hiddenIds.has(stream.channelId)) continue;
      const visible = displayStream(stream, time);
      if (!visible) continue;
      specialLivesCount++;
      visibleSpecialLives?.push(visible);
    }

    return {
      channels,
      streams: streams.filter((stream) => !isNonBroadcast(stream) && (stream.isBroadcast === true || stream.manualArchive))
        .map((stream) => displayStream(stream, time)).filter(Boolean),
      specialLivesCount,
      ...(visibleSpecialLives ? { specialLives: visibleSpecialLives } : {}),
      ...music.snapshot(hiddenIds, includeMusicVideos),
      warnings,
      updatedAt: state.updatedAt ?? null,
    };
  }

  async function addArchives(entries) {
    const time = now();
    const channels = availableChannels().filter(({ hidden }) => !hidden);
    const archives = prepareArchives(entries, channels, time);
    const known = new Map([...state.streams, ...state.specialLives].map((stream) => [stream.id, stream]));
    const details = await archiveDetails(archives.filter((archive) => known.get(archive.id)?.isBroadcast == null));
    const streams = new Map(state.streams.map((stream) => [stream.id, stream]));
    const specialLives = new Map(state.specialLives.map((stream) => [stream.id, stream]));
    let added = 0;
    for (const [index, archive] of archives.entries()) {
      const video = details.get(archive.id) ?? known.get(archive.id);
      if (video && (isNonBroadcast(video) || (video.status === 'upcoming' || video.status === 'live') && video.isBroadcast === true)) {
        throw new ScheduleError(400, `${index + 1} 件目: 公開ライブ配信のアーカイブ URL を指定してください。`);
      }
      const special = entries[index].specialLive === true;
      if (special && (!specialLiveChannelIds.has(archive.channelId) || archive.platform !== 'youtube')) {
        throw new ScheduleError(400, `${index + 1} 件目: 3Dライブにはホロライブのチャンネルと YouTube のアーカイブ URL を指定してください。`);
      }
      if (special && initialSpecialLives.has(archive.id)) continue;
      const records = special ? specialLives : streams;
      const existing = records.get(archive.id);
      if (existing && (existing.manualArchive || existing.channelId !== archive.channelId ||
        (existing.status !== 'past' && !existing.missingFromSource))) continue;
      const titled = withArchiveDetails(archive, video);
      records.set(archive.id, existing?.status === 'past'
        ? { ...existing, title: existing.title ?? titled.title, manualArchive: true }
        : titled);
      added++;
    }
    if (added) save({ ...state, streams: [...streams.values()], specialLives: [...specialLives.values()], updatedAt: new Date(time).toISOString() });
    return { added, skipped: archives.length - added };
  }

  async function addChannel(rawUrl) {
    let url;
    try {
      url = normalizeChannelUrl(rawUrl);
    } catch {
      throw new ScheduleError(400, 'YouTube のチャンネル URL を入力してください。');
    }

    if (state.custom.some((channel) => channel.url === url)) {
      throw new ScheduleError(409, 'このチャンネルはすでに登録されています。');
    }

    let result;
    try {
      result = await getYouTubeChannel(url);
    } catch (error) {
      if (error.code === 'CHANNEL_NOT_FOUND') {
        throw new ScheduleError(404, 'YouTube チャンネルが見つかりませんでした。');
      }
      throw new ScheduleError(502, 'YouTube からチャンネル情報を取得できませんでした。時間をおいて再試行してください。');
    }

    if ([...state.roster, ...state.custom].some((channel) => channel.id === result.channelId ||
      channel.url === url)) {
      if (state.hidden.includes(result.channelId)) {
        throw new ScheduleError(409, 'このチャンネルは非表示です。チャンネル設定から元に戻せます。');
      }
      throw new ScheduleError(409, 'このチャンネルはすでに登録されています。');
    }

    const channel = { id: result.channelId, name: result.name, group: '追加チャンネル', url };
    if (result.avatar) channel.avatar = result.avatar;
    const channelNames = new Map([[channel.id, channel.name]]);
    const published = result.streams.filter((stream) => !isNonBroadcast(stream))
      .map((stream) => withSourceTitles({ ...stream, channelId: channel.id }, channelNames));
    const streams = mergeStreams(state.streams, published, now());
    save({ ...state, custom: [...state.custom, channel], streams, updatedAt: new Date(now()).toISOString() });
    return { ...channel, custom: true, keepPast: true, hidden: false };
  }

  function setKeepPast(id, keepPast) {
    if (typeof keepPast !== 'boolean') throw new ScheduleError(400, '保存設定の値が無効です。');
    if (![...state.roster, ...state.custom].some((channel) => channel.id === id)) {
      throw new ScheduleError(404, 'チャンネルが見つかりませんでした。');
    }
    save({ ...state, preferences: { ...state.preferences, [id]: keepPast } });
  }

  function removeChannel(id) {
    if (state.roster.some((channel) => channel.id === id)) {
      if (!state.hidden.includes(id)) save({ ...state, hidden: [...state.hidden, id] });
      return;
    }
    if (!state.custom.some((channel) => channel.id === id)) {
      throw new ScheduleError(404, 'チャンネルが見つかりませんでした。');
    }
    const preferences = { ...state.preferences };
    delete preferences[id];
    save({ ...state, custom: state.custom.filter((channel) => channel.id !== id), preferences });
  }

  function restoreChannel(id) {
    if (!state.roster.some((channel) => channel.id === id)) {
      throw new ScheduleError(404, '初期登録チャンネルが見つかりませんでした。');
    }
    save({ ...state, hidden: state.hidden.filter((hiddenId) => hiddenId !== id) });
  }

  return {
    refresh, refreshMusicVideos: music.refresh, snapshot, addArchives, addChannel, setKeepPast, removeChannel, restoreChannel,
    hiddenChannelIds: () => new Set(state.hidden),
  };
}

export { REFRESH_INTERVAL, ScheduleError };
