const japaneseSideProgram = /同時視聴|ウォッチパーティー|カラオケ|歌枠|雑談|振り返[るり]|ふりかえ[るり]|感想|アフタートーク|裏話|切り抜き|ダイジェスト|予告|チラ見せ|リハーサル|【(?:告知|お知らせ)】|開催(?:決定|告知)|告知(?:配信|枠|動画)|直前(?:配信|枠|番組)|(?:ライブ|コンサート)のお知らせ/u;
const englishSideProgram = /\b(?:karaoke|watch[ -]?along|watch party|co[ -]?watch|reaction|just chatting|after[ -]?(?:talk|show|party)|pre[ -]?show|recap|review|highlights?|preview|teaser|trailer|announcements? (?:stream|for|about)|(?:live|concert|showcase|debut) announcements?|rehearsal|shorts)\b/i;
const twoDimensional = /(?<!\d)2\s*d(?=$|[^a-z]|(?:live|model|concert|showcase)(?![a-z]))/i;

const japaneseThreeDimensional = /(?<!\d)3\s*d\s*(?:(?:の|ソロ|初|記念|誕生日|生誕祭|周年|新衣装|モデル)\s*)*(?:ライブ(?!配信)|コンサート|お披露目|おひろめ|デビュー)/i;
const englishThreeDimensional = /(?<!\d)3\s*d[\s_-]*(?:(?:birthday|anniversary|first|solo|model)[\s_-]+)*(?:live(?![a-z]|\s+stream\b)|concert\b|showcase\b|debut\b|reveal\b)/i;
const japaneseConcert = /(?:誕生日|生誕(?:祭)?|周年|卒業)[\s・_-]*(?:20\d{2}[\s・_-]*)?(?:記念[\s・_-]*)?(?:ライブ(?!配信)|live(?![a-z]|\s+stream\b))|(?:ワンマン|ソロ|全体|カウントダウン|\d+(?:st|nd|rd|th))[\s・_-]*ライブ(?!配信)|コンサート/iu;
const englishConcert = /\bconcert\b|\b(?:birthday|anniversary)[\s_-]+(?:live(?![a-z]|\s+stream\b)|showcase\b)|\bhololive\s+\d+(?:st|nd|rd|th)?\s+fes\b/i;

export function isSpecialLive(stream) {
  const titles = [stream?.title, stream?.holoduleTitle]
    .filter((title) => typeof title === 'string')
    .map((title) => title.normalize('NFKC').replace(/\s+/g, ' '));
  if (titles.some((title) => japaneseSideProgram.test(title) || englishSideProgram.test(title) || twoDimensional.test(title))) return false;
  return titles.some((title) => japaneseThreeDimensional.test(title) || englishThreeDimensional.test(title)
    || japaneseConcert.test(title) || englishConcert.test(title));
}
