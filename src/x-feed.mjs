import { rosterGroups } from './data/hololive-roster.mjs';
import { hololiveXHandles } from './data/hololive-x-accounts.mjs';
import { musicVideoMemberReadings } from './data/music-video-member-readings.mjs';

const refreshInterval = 30 * 60 * 1000;
const recentWindow = 7 * 24 * 60 * 60 * 1000;
const feedLimit = 80;
const accounts = Object.entries(rosterGroups).flatMap(([group, members]) => members
  .filter(([channelId]) => hololiveXHandles.has(channelId))
  .map(([channelId, name, aliases, avatar]) => ({
    channelId, handle: hololiveXHandles.get(channelId), name, group, avatar,
    aliases: [...new Set([...aliases, musicVideoMemberReadings.get(channelId)].filter(Boolean))],
  })));
const accountsByHandle = new Map(accounts.map((account) => [account.handle.toLowerCase(), account]));

function cleanPosts(posts, time) {
  const unique = new Map();
  for (const { id, handle, text, createdAt } of posts) {
    const account = accountsByHandle.get(typeof handle === 'string' ? handle.toLowerCase() : '');
    const published = Date.parse(createdAt);
    if (!account || typeof id !== 'string' || !/^\d{1,20}$/.test(id) || typeof text !== 'string' || !text.trim()
        || !Number.isFinite(published) || published < time - recentWindow || published > time) continue;
    unique.set(id, {
      id, handle: account.handle, text, createdAt: new Date(published).toISOString(),
      url: `https://x.com/${account.handle}/status/${id}`,
    });
  }
  return [...unique.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, feedLimit);
}

const unavailable = 'Xの投稿を取得できませんでした。時間をおいて再度お試しください。';
const apiWarnings = {
  401: 'X APIの認証に失敗しました。X_BEARER_TOKENを確認してください。',
  402: 'X APIの利用残高や上限を確認してください。',
  403: 'X APIで投稿を読む権限を確認してください。',
  429: 'X APIの取得制限に達しました。時間をおいて自動で再試行します。',
};

export function createXFeed({ getPosts, now = Date.now }) {
  const available = typeof getPosts === 'function';
  let posts = [];
  let updatedAt = null;
  let nextAttempt = -Infinity;
  let warning;
  let refreshing;

  async function refresh(time) {
    nextAttempt = time + refreshInterval;
    try {
      posts = cleanPosts(await getPosts(accounts, { now }), now());
      updatedAt = new Date(now()).toISOString();
      warning = undefined;
    } catch (error) {
      if (Number.isFinite(error?.retryAt)) nextAttempt = Math.max(nextAttempt, error.retryAt);
      if (error?.partialPosts?.length) {
        posts = cleanPosts([...posts, ...error.partialPosts], now());
        updatedAt = new Date(now()).toISOString();
      }
      warning = apiWarnings[error?.status] ?? unavailable;
    }
  }

  async function load(hidden = new Set()) {
    const visibleAccounts = accounts.filter(({ channelId }) => !hidden.has(channelId));
    const time = now();
    if (available && visibleAccounts.length && !refreshing && time >= nextAttempt) {
      refreshing = refresh(time).finally(() => { refreshing = undefined; });
    }
    await refreshing;
    const visible = new Set(visibleAccounts.map(({ handle }) => handle));
    const cutoff = new Date(now() - recentWindow).toISOString();
    return {
      available, accounts: visibleAccounts, updatedAt, warning,
      posts: posts.filter(({ handle, createdAt }) => visible.has(handle) && createdAt >= cutoff),
    };
  }

  return { load };
}
