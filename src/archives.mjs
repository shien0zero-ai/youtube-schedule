import { createHash } from 'node:crypto';
import { ScheduleError } from './schedule-error.mjs';
import { youtubeVideoId } from './youtube.mjs';

const columns = ['date', 'channel', 'title', 'url'];

export function parseArchiveCsv(body) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new ScheduleError(400, 'CSV は UTF-8 で保存してください。');
  }

  const field = /(?:"((?:[^"\x00]|"")*)"|([^",\r\n\x00]*))(,|\r\n?|\n|$)/y;
  const rows = [];
  let fields = [];
  while (true) {
    const match = field.exec(text);
    if (!match) throw new ScheduleError(400, `CSV の ${rows.length + 1} 行目を読み取れませんでした。`);
    const [, quoted, unquoted, separator] = match;
    fields.push(quoted === undefined ? unquoted : quoted.replaceAll('""', '"'));
    if (separator !== ',') {
      if (fields.length !== 1 || fields[0].trim()) rows.push(fields);
      fields = [];
    }
    if (!separator || (separator !== ',' && field.lastIndex === text.length)) break;
  }

  const [header, ...entries] = rows;
  if (header?.length !== columns.length || columns.some((name, index) => header[index].trim() !== name)) {
    throw new ScheduleError(400, 'CSV の先頭行は date,channel,title,url にしてください。');
  }
  return entries.map((row, index) => {
    if (row.length !== columns.length) throw new ScheduleError(400, `CSV の ${index + 2} 行目には4列が必要です。`);
    const [date, channel, title, url] = row;
    return { date, channel, title, url };
  });
}

function archiveUrl(input) {
  try {
    const url = new URL(input);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export function prepareArchives(entries, channels, now) {
  if (!Array.isArray(entries) || !entries.length) throw new ScheduleError(400, '登録する配信を入力してください。');

  return entries.map((entry, index) => {
    const invalid = (message) => new ScheduleError(400, `${index + 1} 件目: ${message}`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid('配信を読み取れませんでした。');
    const date = typeof entry.date === 'string' ? entry.date.trim() : '';
    const midnight = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
    if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date ||
      Date.parse(`${date}T00:00:00+09:00`) > now) {
      throw invalid('日本時間で今日以前の配信日を指定してください。');
    }

    const channel = typeof entry.channel === 'string' ? entry.channel.trim() : '';
    const names = channels.filter(({ name }) => name === channel);
    const owner = channels.find(({ id }) => id === channel) ?? (names.length === 1 ? names[0] : null);
    if (!owner) throw invalid('表示中のチャンネルの名前または ID を指定してください。');

    const url = typeof entry.url === 'string' ? archiveUrl(entry.url.trim()) : null;
    if (!url) throw invalid('HTTPS のアーカイブ URL を指定してください。');
    if (entry.title != null && typeof entry.title !== 'string') throw invalid('配信タイトルを入力してください。');

    const videoId = youtubeVideoId(url);
    const id = videoId ?? 'archive-' + createHash('sha256').update(JSON.stringify([owner.id, date, url.href])).digest('hex');
    return {
      id,
      channelId: owner.id,
      title: entry.title?.trim() || `${owner.name} の配信`,
      status: 'past',
      startAt: null,
      scheduleDate: date,
      endAt: null,
      platform: videoId ? 'youtube' : url.hostname.replace(/^www\./, ''),
      url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : url.href,
      thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null,
      manualArchive: true,
    };
  });
}
