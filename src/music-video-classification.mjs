const japaneseMusicVideo = /ミュージック[・ ]?ビデオ|歌ってみた|カバー(?:曲|動画)/iu;
const englishMusicVideo = /(?<![a-z])(?:mv|m\s*[./]\s*v\.?|music\s+video)(?![a-z])/i;
const englishCover = /(?:^|[【\[(|])\s*cover(?=\s*[:：】\])「『])|\b(?:vocal|song)\s+cover\b|\b(?:cover(?:ed)?\s+by|cover\s+of)\b|\bcover\s*$/i;
const officialSongCredit = /(?:[/／]|\s-\s)\s*[^/]+?[\[(]\s*official\s*[\])]\s*$/i;
const shortVideo = /ショート(?:動画|版|ver\b)|\b(?:shorts|short\s+(?:ver(?:sion)?|edit))\b/iu;

const japaneseOtherProgram = /歌枠|カラオケ|配信切り抜き|切り抜き|切抜き|ダイジェスト|同時視聴|振り返[るり]|ふりかえ[るり]|雑談|告知枠|公開記念(?:配信|放送|特番)|投稿記念配信|予告|チラ見せ|ティザー|トレーラー|インスト(?:音源|版)?|音源のみ|弾いてみた|(?:3\s*d|生誕(?:祭)?|誕生日|周年|卒業|ソロ|ワンマン)\s*(?:記念\s*)?ライブ|ライブ(?:配信|映像|アーカイブ|版|ver\b)|コンサート/iu;
const englishOtherProgram = /\b(?:teaser|trailer|preview|highlights?|clips?|behind the scenes|reaction|watch[ -]?along|watch party|karaoke|instrumental|off[ -]?vocal|(?:official\s+)?audio(?:\s+only)?|concert|live\s+(?:performance|stream|version|ver|archive)|(?:anniversary|birthday|graduation|3d)[\s_-]*live)\b/i;

export function isShortVideoTitle(title) {
  return typeof title === 'string' && shortVideo.test(title.normalize('NFKC'));
}

export function isMusicVideoTitle(title, { officialMusic = false } = {}) {
  if (typeof title !== 'string') return false;
  const text = title.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (shortVideo.test(text) || japaneseOtherProgram.test(text) || englishOtherProgram.test(text)) return false;
  return japaneseMusicVideo.test(text) || englishMusicVideo.test(text) || englishCover.test(text)
    || (officialMusic && officialSongCredit.test(text));
}
