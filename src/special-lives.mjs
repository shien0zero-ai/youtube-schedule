import { rosterGroups } from './data/hololive-roster.mjs';
import { specialLiveArchives } from './data/special-live-archives.mjs';

const groupChannels = new Map([
  ['UCotXwY6s8pWmuWd_snKYjhg', { channelName: 'hololive English', channelGroup: 'ホロライブ EN' }],
  ['UCfrWoRGlawPQDQxxeIDRP0Q', { channelName: 'hololive Indonesia', channelGroup: 'ホロライブ ID' }],
  ['UCu2n3qHuOuQIygREMnWeQWg', { channelName: 'FLOW GLOW', channelGroup: 'hololive DEV_IS' }],
]);

export const specialLiveChannelIds = new Set([
  ...Object.values(rosterGroups).flatMap((channels) => channels.map(([id]) => id)),
  ...groupChannels.keys(),
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
    ...groupChannels.get(channelId),
  }];
}));
