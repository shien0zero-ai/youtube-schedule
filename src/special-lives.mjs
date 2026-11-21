import { rosterGroups } from './data/hololive-roster.mjs';
import { specialLiveArchives } from './data/special-live-archives.mjs';

export const specialLiveChannelIds = new Set(Object.values(rosterGroups).flatMap((channels) => channels.map(([id]) => id)));

export const initialSpecialLives = new Map(specialLiveArchives.map(([id, channelId, scheduleDate, title, sourceUrl]) => {
  const url = `https://www.youtube.com/watch?v=${id}`;
  return [id, {
    id, channelId, scheduleDate, title, url,
    sourceUrl: sourceUrl ?? url,
    platform: 'youtube',
    status: 'past',
    startAt: null,
    endAt: null,
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  }];
}));
