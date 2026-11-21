const japaneseMusicVideo = /ミュージック[・ ]?ビデオ|歌ってみた|カバー(?:曲|動画)/iu;
const englishMusicVideo = /(?<![a-z])(?:mv|m\s*[./]\s*v\.?|music\s+video)(?![a-z])/i;
const englishCover = /(?:^|[【\[(|])\s*cover(?=\s*[:：】\])「『])|\b(?:vocal|song)\s+cover\b|\b(?:cover(?:ed)?\s+by|cover\s+of)\b|\bcover\s*$/i;
const officialSongCredit = /(?:[/／]|\s-\s)\s*[^/]+?[\[(]\s*official\s*[\])]\s*$/i;
const shortVideo = /ショート(?:動画|版|ver\b)|\b(?:shorts|short\s+(?:ver(?:sion)?|edit))\b/iu;

const japaneseOtherProgram = /歌枠|カラオケ|配信切り抜き|切り抜き|切抜き|ダイジェスト|同時視聴|振り返[るり]|ふりかえ[るり]|雑談|告知枠|公開記念(?:配信|放送|特番)|投稿記念配信|予告|チラ見せ|ティザー|トレーラー|インスト(?:音源|版)?|音源のみ|弾いてみた|(?:3\s*d|生誕(?:祭)?|誕生日|周年|卒業|ソロ|ワンマン)\s*(?:記念\s*)?ライブ|ライブ(?:配信|映像|アーカイブ|版|ver\b)|コンサート/iu;
const englishOtherProgram = /\b(?:teaser|trailer|preview|highlights?|clips?|behind the scenes|reaction|watch[ -]?along|watch party|karaoke|instrumental|off[ -]?vocal|(?:official\s+)?audio(?:\s+only)?|concert|live\s+(?:performance|stream|version|ver|archive)|(?:anniversary|birthday|graduation|3d)[\s_-]*live)\b/i;

const coverTitle = /歌ってみた|カバー(?:曲|動画|バージョン|してみた)|(?:\bcover|カバー)(?=\s*[】」』\])])|カバー\s*$/iu;
const originalTitle = /オリジナル(?:楽曲|曲|ソング)|オリ曲|自作(?:楽曲|曲)|\boriginal\s+(?:song|track)\b|[【「『\[(]\s*original\s*[】」』\])]/iu;
const coverDescription = /^(?:(?:原曲|本家)(?:様|さま)?(?=\s*(?:[:】\])/|]|https?:|$))|(?:(?:これは|こちらは|本作は|この(?:曲|動画)は)\s*)?カバー(?:曲|動画)?です|original(?:ly)?\s+(?:artist|performer|performed\s+by)\b|(?:this is\s+)?(?:(?:a|my|our|vocal)\s+)?cover(?:ed)?\s+(?:by|of)\b)/iu;
const originalDescription = /^(?:(?:これは|こちらは|私(?:たち)?の|僕(?:たち)?の|自身の|新|初の|第\d+弾の)\s*オリジナル(?:楽曲|曲|ソング)|(?:this is\s+(?:an?|my|our)|my|our)(?:\s+(?:new|first|second|\d+(?:st|nd|rd|th)))?\s+original\s+(?:song|track)\b)/iu;

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

export function classifyMusicKind(title, description) {
  const text = typeof title === 'string' ? title.normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
  if (coverTitle.test(text) || englishCover.test(text)) return 'cover';
  if (originalTitle.test(text)) return 'original';
  if (typeof description !== 'string') return null;

  const lines = description.normalize('NFKC').split(/\r?\n/).map((line) => line.replace(/^[\s【\[▷►◇◆▼・●■▶]+/u, ''));
  const covers = lines.some((line) => coverDescription.test(line));
  const originals = lines.some((line) => originalDescription.test(line));
  if (covers === originals) return null;
  return covers ? 'cover' : 'original';
}
