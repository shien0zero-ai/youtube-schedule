import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSpecialLive } from '../src/special-lives-classification.mjs';

test('recognizes explicitly staged 3D lives and major concert titles', () => {
  const titles = [
    '【＃ホロライブ】FLOW GLOW ３ＤＬＩＶＥ「MAKE IT, BREAK IT」',
    '【３Dソロお披露目】VRChatで3D！沢山ファンサするよ✨【火威 】',
    '【#ときのそら生誕祭】素敵な歌を！ 生誕祭ライブ2026',
    '【5周年記念ライブ】Hololive Anniversary Stage',
    '【ワンマンライブ】Milky Way',
    '【3D Debut Showcase】Welcome to the stage!',
    '【3D Birthday Live】Music from the Heart',
    '≪3D LIVE≫ Birthday 2025 + ANNOUNCEMENTS!',
    '【生誕祭2026 LIVE】最後に重大告知あり！',
    '【Anniversary Concert】A New Stage',
    'hololive 6th fes. Color Rise Harmony',
  ];
  for (const title of titles) assert.equal(isSpecialLive({ title }), true, title);
});

test('does not confuse ordinary streams or concert-related side programs with the event', () => {
  const titles = [
    '【誕生日記念】みんなでお祝い！',
    '【周年記念ライブ配信】お知らせと雑談',
    '【新衣装】3Dでゲームしてみる',
    '【歌枠】3Dライブみたいに歌いたい',
    '【同時視聴枠】#FG3Dライブ 祝3D！本配信は概要欄から',
    '【3D LIVE】ライブの振り返りと裏話',
    'コンサートを振り返る',
    '【3D Live】Concert Teaser',
    '【3D Live】The concert preview',
    '【告知】3Dライブの開催日が決まりました！',
    '【3D Debut Announcement】Come learn more',
    '【Anniversary Concert】Official Watch-Along',
    '【3D Birthday Live】Karaoke Party',
    '【２Ｄライブ】5周年記念ライブ',
    '【２ＤＬＩＶＥ2026】Birthday Live',
    '【Live2D Model Debut】Birthday Concert',
    '【Anniversary Live Stream】New Games With Friends',
  ];
  for (const title of titles) assert.equal(isSpecialLive({ title }), false, title);
});

test('uses the preserved listing title and vetoes side programs named by either source', () => {
  assert.equal(isSpecialLive({ title: 'Shine on!', holoduleTitle: '【3D LIVE】Shine on!' }), true);
  assert.equal(isSpecialLive({ title: '【同時視聴】Shine on!', holoduleTitle: '【3D LIVE】Shine on!' }), false);
  assert.equal(isSpecialLive({ title: '【3D LIVE】Shine on!', holoduleTitle: '公演のアフタートーク' }), false);
  assert.equal(isSpecialLive({ title: 'ときのそら の配信', holoduleTitle: null }), false);
});
