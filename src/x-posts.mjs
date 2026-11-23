const searchUrl = 'https://api.x.com/2/tweets/search/recent';
const handlePattern = /^[A-Za-z0-9_]{1,15}$/;
const postIdPattern = /^\d{1,20}$/;
const windowMs = 7 * 24 * 60 * 60 * 1000;
const rateLimitWindowMs = 15 * 60 * 1000;
const handlesPerQuery = 18;
const maxQueries = 6;
const postsPerQuery = 20;

class XPostsError extends Error {
  constructor(message, { status, retryAt } = {}) {
    super(message);
    this.status = status;
    this.retryAt = retryAt;
  }
}

function resetTime(headers, time, fallback = 0) {
  const reset = Number(headers.get('x-rate-limit-reset')) * 1000;
  const retryAfter = headers.get('retry-after');
  const retry = /^\d+$/.test(retryAfter ?? '') ? time + Number(retryAfter) * 1000 : Date.parse(retryAfter);
  const hints = [reset, retry].filter((value) => Number.isSafeInteger(value) && value > time);
  return hints.length ? Math.max(...hints) : fallback ? time + fallback : undefined;
}

function sortedPosts(posts) {
  return [...posts.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function searchPosts(handles, { token, fetchImpl, signal, now }) {
  const query = new URL(searchUrl);
  query.search = new URLSearchParams({
    query: `(${handles.map((handle) => `from:${handle}`).join(' OR ')}) -is:retweet`,
    'tweet.fields': 'author_id,created_at,note_tweet,referenced_tweets',
    expansions: 'author_id',
    'user.fields': 'username,protected',
    sort_order: 'recency',
    max_results: String(postsPerQuery),
  }).toString();

  let response;
  try {
    response = await fetchImpl(query, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error',
      signal,
    });
  } catch {
    throw new XPostsError('X API に接続できませんでした。');
  }
  const limited = response.status === 429;
  if (!response.ok) {
    throw new XPostsError(`X API から投稿を取得できませんでした（HTTP ${response.status}）。`, {
      status: response.status,
      retryAt: resetTime(response.headers, now(), limited ? rateLimitWindowMs : 0),
    });
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new XPostsError('X API の応答を読み取れませんでした。');
  }
  const data = body?.data ?? (body?.meta?.result_count === 0 ? [] : null);
  if (!Array.isArray(data)) throw new XPostsError('X API の投稿一覧を読み取れませんでした。');
  const authors = Array.isArray(body.includes?.users) ? body.includes.users : [];
  const partial = Boolean(body.errors?.length || (data.length && !authors.length));
  const allowedHandles = new Map(handles.map((handle) => [handle.toLowerCase(), handle]));
  const handlesById = new Map();
  for (const author of authors) {
    const handle = typeof author?.username === 'string' ? allowedHandles.get(author.username.toLowerCase()) : undefined;
    if (handle && author.id && author.protected !== true) handlesById.set(author.id, handle);
  }

  const time = now();
  const posts = [];
  for (const item of data.slice(0, postsPerQuery)) {
    const handle = handlesById.get(item?.author_id);
    const timeCreated = typeof item?.created_at === 'string' ? Date.parse(item.created_at) : NaN;
    const text = item?.note_tweet?.text || item?.text;
    if (!handle || typeof item.id !== 'string' || !postIdPattern.test(item.id) || typeof text !== 'string' || !text.trim()
      || !Number.isFinite(timeCreated) || timeCreated < time - windowMs || timeCreated > time
      || (Array.isArray(item.referenced_tweets) && item.referenced_tweets.some((reference) => reference?.type === 'retweeted'))) continue;

    const { id } = item;
    posts.push({ id, handle, text, createdAt: new Date(timeCreated).toISOString(), url: `https://x.com/${handle}/status/${id}` });
  }
  const retryAt = response.headers.get('x-rate-limit-remaining') === '0'
    ? resetTime(response.headers, time, rateLimitWindowMs) : undefined;
  return { posts, partial, retryAt };
}

export async function getXPosts(accounts, { token = process.env.X_BEARER_TOKEN, fetchImpl = fetch, now = Date.now } = {}) {
  const handles = new Map();
  for (const account of accounts) {
    const handle = typeof account?.handle === 'string' ? account.handle.trim().replace(/^@/, '') : '';
    if (handlePattern.test(handle) && !handles.has(handle.toLowerCase())) handles.set(handle.toLowerCase(), handle);
  }
  if (!handles.size) return [];
  if (handles.size > handlesPerQuery * maxQueries) throw new RangeError('X のアカウントが一度に取得できる件数を超えています。');
  const credentials = typeof token === 'string' ? token.trim() : '';
  if (!credentials) throw new XPostsError('X_BEARER_TOKEN が設定されていません。');

  const names = [...handles.values()];
  const options = { token: credentials, fetchImpl, signal: AbortSignal.timeout(12_000), now };
  const collected = new Map();
  let partial = false;
  try {
    for (let offset = 0; offset < names.length; offset += handlesPerQuery) {
      const result = await searchPosts(names.slice(offset, offset + handlesPerQuery), options);
      result.posts.forEach((post) => collected.set(post.id, post));
      partial ||= result.partial;
      if (result.retryAt && offset + handlesPerQuery < names.length) {
        throw new XPostsError('X API の一時的な取得上限に達しました。', { status: 429, retryAt: result.retryAt });
      }
    }
    if (partial) throw new XPostsError('X API から投稿の一部を読み取れませんでした。');
  } catch (error) {
    error.partialPosts = sortedPosts(collected);
    throw error;
  }
  return sortedPosts(collected);
}
