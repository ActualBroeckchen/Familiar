import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRedditUrl, redditApiPath, parseRedditReadable, fetchRedditJson, readReddit,
  redditCredentials, _resetRedditTokenCache,
} from '../src/browser/reddit-reader.js';

// A public IP so the SSRF guard passes without real DNS.
const lookupFn = async () => [{ address: '151.101.1.140' }];
const resp = (status, { json = {}, ct = 'application/json' } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (h) => (h.toLowerCase() === 'content-type' ? ct : null) },
  json: async () => json,
});

// ── URL classification + API path ──────────────────────────────────────────
test('isRedditUrl: reddit hosts yes, others no', () => {
  assert.equal(isRedditUrl('https://www.reddit.com/r/x'), true);
  assert.equal(isRedditUrl('https://old.reddit.com/r/x'), true);
  assert.equal(isRedditUrl('https://example.com'), false);
  assert.equal(isRedditUrl('nonsense'), false);
});

test('redditApiPath: appends .json, bounds limit, keeps sort; rejects media/non-reddit', () => {
  const a = redditApiPath('https://www.reddit.com/r/x/comments/abc/title/?sort=top');
  assert.match(a.path, /\/r\/x\/comments\/abc\/title\.json$/);
  assert.match(a.search, /limit=50/);
  assert.match(a.search, /raw_json=1/);
  assert.match(a.search, /sort=top/);
  assert.equal(redditApiPath('https://old.reddit.com/r/x').path, '/r/x.json');
  assert.equal(redditApiPath('https://i.redd.it/pic.png'), null);   // media host
  assert.equal(redditApiPath('https://example.com/r/x'), null);      // not reddit
  assert.equal(redditApiPath('ftp://reddit.com/x'), null);           // non-http
  assert.match(redditApiPath('https://www.reddit.com/r/x/.json').path, /\.json$/); // already json, not doubled
  assert.doesNotMatch(redditApiPath('https://www.reddit.com/r/x/.json').path, /\.json\.json$/);
});

// ── Parsing ────────────────────────────────────────────────────────────────
const commentsFixture = [
  { kind: 'Listing', data: { children: [ { kind: 't3', data: {
    title: 'Best niche tea?', subreddit: 'tea', author: 'ada', score: 1234, num_comments: 2,
    created_utc: Math.floor(Date.now() / 1000) - 3600, selftext: 'What obscure teas do you love?' } } ] } },
  { kind: 'Listing', data: { children: [
    { kind: 't1', data: { author: 'bo', score: 42, body: 'Gyokuro, hands down.',
      replies: { data: { children: [ { kind: 't1', data: { author: 'cy', score: 7, body: 'Agreed, shaded leaf.' } } ] } } } },
    { kind: 't1', data: { author: 'dee', score: 5, body: '[deleted]' } },
  ] } },
];

test('parseRedditReadable: a comments page → post + threaded top comments', () => {
  const out = parseRedditReadable(commentsFixture);
  assert.match(out, /Best niche tea\?/);
  assert.match(out, /r\/tea/);
  assert.match(out, /What obscure teas/);
  assert.match(out, /Top comments/);
  assert.match(out, /u\/bo.*Gyokuro/s);
  assert.match(out, /Agreed, shaded leaf/);     // one level of replies rendered
  assert.doesNotMatch(out, /\[deleted\]/);       // deleted bodies skipped
});

test('parseRedditReadable: a subreddit listing → numbered posts', () => {
  const listing = { kind: 'Listing', data: { children: [
    { kind: 't3', data: { title: 'Post one', subreddit_name_prefixed: 'r/tea', permalink: '/r/tea/1', score: 10, num_comments: 3, author: 'ada', created_utc: Math.floor(Date.now()/1000) } },
    { kind: 't3', data: { title: 'Post two', subreddit_name_prefixed: 'r/tea', permalink: '/r/tea/2', score: 99, num_comments: 0, author: 'bo', created_utc: Math.floor(Date.now()/1000) } },
  ] } };
  const out = parseRedditReadable(listing);
  assert.match(out, /r\/tea/);
  assert.match(out, /1\. Post one/);
  assert.match(out, /2\. Post two/);
  assert.match(out, /reddit\.com\/r\/tea\/1/);
});

test('parseRedditReadable: unrecognised shape → empty string', () => {
  assert.equal(parseRedditReadable({ foo: 'bar' }), '');
  assert.equal(parseRedditReadable(null), '');
});

// ── Fetch orchestration (stubbed) ──────────────────────────────────────────
test('fetchRedditJson: public path → ok with parsed data', async () => {
  let calledUrl = '', ua = '';
  const fetchFn = async (url, opts) => { calledUrl = url; ua = opts.headers['User-Agent']; return resp(200, { json: commentsFixture }); };
  const r = await fetchRedditJson('https://www.reddit.com/r/tea/comments/x/y/', { settings: {}, deps: { fetchFn, lookupFn } });
  assert.equal(r.ok, true);
  assert.match(calledUrl, /^https:\/\/www\.reddit\.com\/r\/tea\/comments\/x\/y\.json/);
  assert.ok(ua && /proto-familiar/.test(ua), 'descriptive UA sent');
});

test('fetchRedditJson: 403 → blocked', async () => {
  const fetchFn = async () => resp(403, { ct: 'text/html' });
  const r = await fetchRedditJson('https://www.reddit.com/r/tea/comments/x/y/', { settings: {}, deps: { fetchFn, lookupFn } });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.equal(r.status, 403);
});

test('fetchRedditJson: 200 but non-JSON body → treated as blocked', async () => {
  const fetchFn = async () => resp(200, { ct: 'text/html', json: {} });
  const r = await fetchRedditJson('https://www.reddit.com/r/tea/comments/x/y/', { settings: {}, deps: { fetchFn, lookupFn } });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
});

test('fetchRedditJson: with credentials → OAuth token then bearer call to oauth host', async () => {
  _resetRedditTokenCache();
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, method: opts.method || 'GET', auth: opts.headers['Authorization'] });
    if (url.includes('/api/v1/access_token')) return resp(200, { json: { access_token: 'tok123', expires_in: 3600 } });
    return resp(200, { json: commentsFixture });
  };
  const settings = { redditClientId: 'id', redditClientSecret: 'sec', redditUsername: 'me', redditPassword: 'pw' };
  const r = await fetchRedditJson('https://www.reddit.com/r/tea/comments/x/y/', { settings, deps: { fetchFn, lookupFn } });
  assert.equal(r.ok, true);
  assert.equal(r.authed, true);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].auth, /^Basic /);
  assert.match(calls[1].url, /^https:\/\/oauth\.reddit\.com\//);
  assert.equal(calls[1].auth, 'Bearer tok123');
});

test('fetchRedditJson: an authenticated context fetch (browser session) wins before the public path', async () => {
  let publicCalled = false;
  const fetchFn = async () => { publicCalled = true; return resp(200, { json: commentsFixture }); };
  const contextFetch = async () => ({ ok: true, status: 200, contentType: 'application/json', text: JSON.stringify(commentsFixture) });
  const r = await fetchRedditJson('https://www.reddit.com/r/tea/comments/x/y/', { settings: {}, deps: { fetchFn, lookupFn, contextFetch } });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'browser-session');
  assert.equal(publicCalled, false);   // the context fetch short-circuited the public one
});

test('fetchRedditJson: a context challenge (html/403) falls through to the public path', async () => {
  const contextFetch = async () => ({ ok: false, status: 403, contentType: 'text/html', text: '<blocked>' });
  const fetchFn = async () => resp(200, { json: commentsFixture });
  const r = await fetchRedditJson('https://www.reddit.com/r/tea/comments/x/y/', { settings: {}, deps: { fetchFn, lookupFn, contextFetch } });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'public-json');
});

test('redditCredentials: env overrides settings; complete only when all four present', () => {
  assert.equal(redditCredentials({ redditClientId: 'a' }).complete, false);
  const full = redditCredentials({ redditClientId: 'a', redditClientSecret: 'b', redditUsername: 'c', redditPassword: 'd' });
  assert.equal(full.complete, true);
});

// ── Top-level readReddit ───────────────────────────────────────────────────
test('readReddit: ok → clean sanitised text', async () => {
  const fetchFn = async () => resp(200, { json: commentsFixture });
  const r = await readReddit('https://www.reddit.com/r/tea/comments/x/y/', { settings: {}, deps: { fetchFn, lookupFn } });
  assert.equal(r.ok, true);
  assert.match(r.text, /Best niche tea/);
});

test('readReddit: blocked → hard failure with an honest, actionable line', async () => {
  const fetchFn = async () => resp(403, { ct: 'text/html' });
  const r = await readReddit('https://www.reddit.com/r/tea/comments/x/y/', { settings: {}, deps: { fetchFn, lookupFn } });
  assert.equal(r.ok, false);
  assert.equal(r.hard, true);
  assert.match(r.text, /Reddit/);
  assert.match(r.text, /credentials/i);   // points at the reliable path
});
