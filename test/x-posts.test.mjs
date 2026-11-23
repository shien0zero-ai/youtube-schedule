import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getXPosts } from '../src/x-posts.mjs';

const now = () => Date.parse('2026-11-23T12:00:00Z');
const token = 'local-test-bearer';
const account = { handle: 'TalentA' };

function post(id, overrides = {}) {
  return { id, author_id: '100', created_at: '2026-11-23T10:00:00Z', text: '配信のお知らせ', ...overrides };
}

function group(size) {
  return Array.from({ length: size }, (_, index) => ({ handle: `member_${String(index).padStart(2, '0')}` }));
}

test('reads eligible public X posts with verified authors and canonical links', async () => {
  const actual = await getXPosts([account, { handle: '@talenta' }, { handle: 'PrivateB' }, { handle: 'talentA OR from:outside' }], {
    token, now,
    async fetchImpl(url, options) {
      assert.equal(url.origin, 'https://api.x.com');
      assert.equal(url.pathname, '/2/tweets/search/recent');
      assert.equal(url.searchParams.get('query'), '(from:TalentA OR from:PrivateB) -is:retweet');
      assert.equal(url.searchParams.get('expansions'), 'author_id');
      assert.equal(url.searchParams.get('max_results'), '20');
      assert.equal(url.searchParams.get('sort_order'), 'recency');
      assert.equal(url.href.includes(token), false);
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      assert.equal(options.redirect, 'error');
      return Response.json({
        data: [
          post('200', { note_tweet: { text: '配信の詳細を含む長いポスト' } }),
          post('201', { created_at: '2026-11-23T11:00:00Z' }),
          post('202', { author_id: '101' }),
          post('203', { author_id: '102' }),
          post('204', { referenced_tweets: [{ type: 'retweeted', id: '99' }] }),
          post('205', { created_at: '2026-11-15T12:00:00Z' }),
          post('206', { created_at: '2026-11-24T12:00:00Z' }),
        ],
        includes: { users: [{ id: '100', username: 'talenta' }, { id: '101', username: 'Outside' },
          { id: '102', username: 'PrivateB', protected: true }] },
      });
    },
  });
  assert.deepEqual(actual, [
    { id: '201', handle: 'TalentA', text: '配信のお知らせ', createdAt: '2026-11-23T11:00:00.000Z', url: 'https://x.com/TalentA/status/201' },
    { id: '200', handle: 'TalentA', text: '配信の詳細を含む長いポスト', createdAt: '2026-11-23T10:00:00.000Z', url: 'https://x.com/TalentA/status/200' },
  ]);
});

test('bounds author groups and never paginates the recent search', async () => {
  const requests = [];
  const accounts = group(68);
  const posts = await getXPosts(accounts, {
    token, now,
    async fetchImpl(url) {
      const query = url.searchParams.get('query');
      assert.ok(query.length <= 512);
      assert.equal(url.searchParams.has('next_token'), false);
      requests.push([...query.matchAll(/from:(\w+)/g)].map((match) => match[1]));
      return Response.json({ meta: { result_count: 0, next_token: 'not-requested' } });
    },
  });
  assert.deepEqual(posts, []);
  assert.deepEqual(requests.map(({ length }) => length), [18, 18, 18, 14]);
  assert.deepEqual(requests.flat(), accounts.map(({ handle }) => handle));
});

test('honors X rate limits and retains validated partial posts without exposing source errors', async () => {
  let calls = 0;
  const reset = now() + 180_000;
  await assert.rejects(getXPosts(group(40), {
    token, now,
    async fetchImpl() {
      calls++;
      if (calls === 1) return Response.json({
        data: [post('200')], includes: { users: [{ id: '100', username: 'member_00' }] },
      });
      return Response.json({ detail: token }, {
        status: 429,
        headers: { 'x-rate-limit-reset': String(reset / 1000), 'retry-after': '60' },
      });
    },
  }), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.retryAt, reset);
    assert.deepEqual(error.partialPosts.map(({ id }) => id), ['200']);
    assert.equal(error.message.includes(token), false);
    return true;
  });
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(getXPosts(group(40), {
    token, now,
    async fetchImpl() {
      calls++;
      return Response.json({ meta: { result_count: 0 } }, { headers: { 'x-rate-limit-remaining': '0' } });
    },
  }), (error) => error.status === 429 && error.retryAt === now() + 900_000);
  assert.equal(calls, 1);
});

test('distinguishes unconfigured and partial responses from an empty search', async () => {
  await assert.rejects(getXPosts([account], {
    token: null, now, fetchImpl: () => assert.fail('No request should be made without credentials'),
  }), /X_BEARER_TOKEN/);

  await assert.rejects(getXPosts([account], {
    token, now, fetchImpl: async () => Response.json({ data: [post('200')], errors: [{ detail: 'author unavailable' }] }),
  }), (error) => /投稿の一部/.test(error.message) && error.partialPosts.length === 0);
});
