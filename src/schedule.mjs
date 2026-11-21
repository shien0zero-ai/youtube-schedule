import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { prepareArchives } from './archives.mjs';
import { ScheduleError } from './schedule-error.mjs';
import { initialSpecialLives, specialLiveChannelIds } from './special-lives.mjs';
import { isSpecialLive } from './special-lives-classification.mjs';

const DAY = 24 * 60 * 60 * 1000;
const REFRESH_INTERVAL = 2 * 60 * 1000;
const FORCED_REFRESH_INTERVAL = 15 * 1000;

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

function mergeStreams(existing, incoming, time) {
  const merged = new Map(existing.map((stream) => [stream.id, stream]));
  for (const stream of incoming) {
    const previous = merged.get(stream.id);
    const liveEnded = previous?.status === 'live' && !previous.missingFromSource;
    const endAt = stream.endAt ?? (stream.status === 'past'
      ? previous?.endAt ?? (liveEnded ? new Date(time).toISOString() : null)
      : null);
    const mergedStream = { ...stream, endAt };
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

export function createScheduleService({ file, getHololive, getYouTubeChannel, normalizeChannelUrl, now = Date.now }) {
  let state = { hidden: [], holoduleIds: [], specialLives: [], ...readState(file) };
  if (!state.specialLives.length && state.holoduleIds.length) {
    state.specialLives = updateSpecialLives([], state, now());
  }
  let lastAttempt = null;
  let warnings = [];
  let refreshing;

  function save(next) {
    next.streams = retainStreams(next.streams, [...next.roster, ...next.custom], next.preferences, now(), next.holoduleIds);
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    state = next;
  }

  async function refreshSources() {
    lastAttempt = now();
    const registered = state.custom;
    const hololive = Promise.resolve().then(getHololive).catch(() => null);
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
    const incoming = [
      ...customStreams.filter(({ channelId }) => activeCustom.has(channelId)),
      ...(official?.streams ?? []),
    ];
    const incomingIds = new Set(incoming.map(({ id }) => id));
    const previouslyListed = new Set(state.holoduleIds);
    const existing = state.streams.map((stream) => {
      if (stream.status === 'past' || stream.missingFromSource || incomingIds.has(stream.id)) return stream;
      const sourceUpdated = previouslyListed.has(stream.id) ? officialReady : updatedChannels.has(stream.channelId);
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
    const specialLives = officialReady ? updateSpecialLives(state.specialLives, official, now()) : state.specialLives;
    save({ ...state, roster: availableRoster, custom, streams, holoduleIds, updatedAt, specialLives });
    warnings = [
      ...(official === null ? ['ホロライブの配信情報を取得できませんでした。'] : officialWarnings),
      ...failures.filter(({ id }) => activeCustom.has(id))
        .map(({ name }) => `${name} の配信情報を更新できませんでした。`),
    ];
  }

  async function refresh(force = false) {
    if (refreshing) return refreshing;
    const interval = force ? FORCED_REFRESH_INTERVAL : REFRESH_INTERVAL;
    if (lastAttempt !== null && now() - lastAttempt < interval) return;
    refreshing = refreshSources().finally(() => { refreshing = undefined; });
    return refreshing;
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
    }));
  }

  function snapshot({ includeSpecialLives = true } = {}) {
    const channels = availableChannels();
    const time = now();
    const streams = retainStreams(state.streams, channels.filter(({ hidden }) => !hidden), state.preferences, time, state.holoduleIds);
    const specialLives = state.specialLives.length ? new Map(initialSpecialLives) : initialSpecialLives;
    for (const stream of state.specialLives) {
      specialLives.set(stream.id, { ...specialLives.get(stream.id), ...stream });
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
      streams: streams.map((stream) => displayStream(stream, time)).filter(Boolean),
      specialLivesCount,
      ...(visibleSpecialLives ? { specialLives: visibleSpecialLives } : {}),
      warnings,
      updatedAt: state.updatedAt ?? null,
    };
  }

  function addArchives(entries) {
    const time = now();
    const channels = availableChannels().filter(({ hidden }) => !hidden);
    const archives = prepareArchives(entries, channels, time);
    const streams = new Map(state.streams.map((stream) => [stream.id, stream]));
    const specialLives = new Map(state.specialLives.map((stream) => [stream.id, stream]));
    let added = 0;
    for (const [index, archive] of archives.entries()) {
      const special = entries[index].specialLive === true;
      if (special && (!specialLiveChannelIds.has(archive.channelId) || archive.platform !== 'youtube')) {
        throw new ScheduleError(400, `${index + 1} 件目: 3Dライブにはホロライブのチャンネルと YouTube のアーカイブ URL を指定してください。`);
      }
      if (special && initialSpecialLives.has(archive.id)) continue;
      const records = special ? specialLives : streams;
      const existing = records.get(archive.id);
      if (existing && (existing.manualArchive || existing.channelId !== archive.channelId ||
        (existing.status !== 'past' && !existing.missingFromSource))) continue;
      records.set(archive.id, existing?.status === 'past' ? { ...existing, manualArchive: true } : archive);
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
    const streams = mergeStreams(state.streams, result.streams.map((stream) => ({ ...stream, channelId: channel.id })), now());
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

  return { refresh, snapshot, addArchives, addChannel, setKeepPast, removeChannel, restoreChannel };
}

export { REFRESH_INTERVAL, ScheduleError };
