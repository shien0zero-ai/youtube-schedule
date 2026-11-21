import { hololiveGroupChannels, rosterGroups } from './data/hololive-roster.mjs';
import { specialLiveArchives } from './data/special-live-archives.mjs';

export const specialLiveChannelIds = new Set([
  ...Object.values(rosterGroups).flatMap((channels) => channels.map(([id]) => id)),
  ...hololiveGroupChannels.keys(),
]);

export const initialSpecialLives = new Map(specialLiveArchives.map(([id, channelId, scheduleDate, title]) => {
  const url = `https://www.youtube.com/watch?v=${id}`;
  return [id, {
    id, channelId, scheduleDate, title, url,
    platform: 'youtube',
    status: 'past',
    startAt: null,
    endAt: null,
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    ...hololiveGroupChannels.get(channelId),
  }];
}));
