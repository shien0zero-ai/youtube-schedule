import { rosterGroups } from './data/hololive-roster.mjs';
import { hololiveXHandles } from './data/hololive-x-accounts.mjs';
import { musicVideoMemberReadings } from './data/music-video-member-readings.mjs';
import { ScheduleError } from './schedule-error.mjs';

const listHosts = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);
const accounts = Object.entries(rosterGroups).flatMap(([group, members]) => members
  .filter(([channelId]) => hololiveXHandles.has(channelId))
  .map(([channelId, name, aliases, avatar]) => ({
    channelId, handle: hololiveXHandles.get(channelId), name, group, avatar,
    aliases: [...new Set([...aliases, musicVideoMemberReadings.get(channelId)].filter(Boolean))],
  })));

export function getXAccounts(hiddenChannels) {
  return accounts.filter(({ channelId }) => !hiddenChannels.has(channelId));
}

export function normalizeXListUrl(value) {
  if (value === null) return null;
  const input = typeof value === 'string' ? value.trim() : '';
  const url = /^https:\/\//i.test(input) ? URL.parse(input) : null;
  const listId = url?.pathname.match(/^\/i\/lists\/([1-9]\d{0,19})\/?$/)?.[1];
  if (!listId || !listHosts.has(url.hostname) || url.username || url.password || url.port) {
    throw new ScheduleError(400, 'Xの公開リストのURL（https://x.com/i/lists/…）を入力してください。');
  }
  return `https://x.com/i/lists/${listId}`;
}
