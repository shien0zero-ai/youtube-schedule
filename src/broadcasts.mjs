import { musicVideoArchives } from './data/music-video-archives.mjs';
import { isMusicVideoTitle, isShortVideoTitle } from './music-video-classification.mjs';

const musicVideoIds = new Set(musicVideoArchives.map(([id]) => id));

export function isNonBroadcastTitle(title, { officialMusic = false } = {}) {
  if (typeof title !== 'string') return false;
  const text = title.normalize('NFKC');
  return isShortVideoTitle(title) || isMusicVideoTitle(title, { officialMusic })
    || /^(?:\s*[【\[(「『]\s*)?(?:プレミア公開|premiere\b|ティザー|teaser\b)/iu.test(text)
    || /(?:^|[【\[(])\s*(?:切り抜き|ダイジェスト|予告編|トレーラー|trailer|highlights?|clips?)\s*(?:[】\])]|[:：]|$)/iu.test(text);
}

export function isNonBroadcast(stream) {
  return stream.isBroadcast === false || musicVideoIds.has(stream.id)
    || /^https?:\/\/(?:(?:www|m)\.)?youtube\.com\/shorts\//i.test(stream.url ?? '')
    || (stream.isBroadcast !== true && isNonBroadcastTitle(stream.title));
}

export function knownTitle(title, channelName) {
  const text = typeof title === 'string' ? title.trim() : '';
  if (!text || text === 'ホロジュールのお知らせ' ||
      (channelName && text.replace(/\s+/gu, '') === `${channelName}の配信`.replace(/\s+/gu, ''))) return null;
  return text;
}
