import { test } from 'node:test';
import assert from 'node:assert/strict';

import { braveSearch, tavilySearch, googleSearch, marginaliaSearch, API_PROVIDERS } from '../src/search/websearch-providers.js';

// ── Brave ────────────────────────────────────────────────────────
test('braveSearch needs a key', async () => {
  assert.match((await braveSearch('x', {}, {})).error, /Brave API key/);
});

test('braveSearch sends token auth and maps web.results → rows', async () => {
  let headers = null;
  const fetchFn = async (_url, opts) => { headers = opts.headers; return {
    ok: true,
    json: async () => ({ web: { results: [
      { title: 'A', url: 'https://a.test', description: 'da' },
      { title: 'B', url: 'https://b.test', description: 'db' },
    ] } }),
  }; };
  const r = await braveSearch('cats', { apiKey: 'k1' }, { fetchFn });
  assert.equal(headers['X-Subscription-Token'], 'k1');
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows[0], { title: 'A', url: 'https://a.test', content: 'da' });
});

test('braveSearch reports an HTTP error (caller falls back to the floor)', async () => {
  const r = await braveSearch('x', { apiKey: 'k' }, { fetchFn: async () => ({ ok: false, status: 429 }) });
  assert.match(r.error, /HTTP 429/);
});

// ── Tavily ───────────────────────────────────────────────────────
test('tavilySearch POSTs with bearer auth and maps results → rows', async () => {
  let sent = null;
  const fetchFn = async (url, opts) => { sent = { url, opts }; return {
    ok: true,
    json: async () => ({ results: [{ title: 'T', url: 'https://t.test', content: 'ct' }] }),
  }; };
  const r = await tavilySearch('dogs', { apiKey: 'tvly-x' }, { fetchFn });
  assert.match(sent.url, /api\.tavily\.com\/search/);
  assert.equal(sent.opts.method, 'POST');
  assert.equal(sent.opts.headers.Authorization, 'Bearer tvly-x');
  assert.match(sent.opts.body, /"query":"dogs"/);
  assert.deepEqual(r.rows[0], { title: 'T', url: 'https://t.test', content: 'ct' });
});

test('tavilySearch needs a key', async () => {
  assert.match((await tavilySearch('x', {}, {})).error, /Tavily API key/);
});

// ── Google ───────────────────────────────────────────────────────
test('googleSearch needs BOTH a key and a cseId', async () => {
  assert.match((await googleSearch('x', { apiKey: 'k' }, {})).error, /search-engine ID/);
  assert.match((await googleSearch('x', { cseId: 'c' }, {})).error, /Google API key/);
});

test('googleSearch passes key+cx and maps items → rows', async () => {
  let url = '';
  const fetchFn = async (u) => { url = u; return {
    ok: true,
    json: async () => ({ items: [{ title: 'G', link: 'https://g.test', snippet: 'sg' }] }),
  }; };
  const r = await googleSearch('cats', { apiKey: 'k', cseId: 'cx1' }, { fetchFn });
  assert.match(url, /cx=cx1/);
  assert.match(url, /key=k/);
  assert.deepEqual(r.rows[0], { title: 'G', url: 'https://g.test', content: 'sg' });
});

// ── Marginalia (independent index; key-optional) ─────────────────
test('marginaliaSearch defaults to the public key and maps results', async () => {
  let headers = null, url = '';
  const fetchFn = async (u, opts) => { url = u; headers = opts.headers; return {
    ok: true,
    json: async () => ({ query: 'x', license: 'CC', results: [{ title: 'M', url: 'https://m.test', description: 'dm' }] }),
  }; };
  const r = await marginaliaSearch('cats', {}, { fetchFn }); // no key → 'public'
  assert.equal(headers['API-Key'], 'public');
  assert.match(url, /api2\.marginalia-search\.com\/search\?query=cats/);
  assert.deepEqual(r.rows[0], { title: 'M', url: 'https://m.test', content: 'dm' });
});

test('marginaliaSearch uses a provided key over the public one', async () => {
  let headers = null;
  const fetchFn = async (_u, opts) => { headers = opts.headers; return { ok: true, json: async () => ({ results: [] }) }; };
  await marginaliaSearch('x', { apiKey: 'mykey' }, { fetchFn });
  assert.equal(headers['API-Key'], 'mykey');
});

test('marginaliaSearch explains a 503 as the shared-key rate limit', async () => {
  const r = await marginaliaSearch('x', {}, { fetchFn: async () => ({ ok: false, status: 503 }) });
  assert.match(r.error, /HTTP 503/);
  assert.match(r.error, /rate-limited/);
});

// ── registry ─────────────────────────────────────────────────────
test('API_PROVIDERS registers brave / google / marginalia / tavily', () => {
  assert.deepEqual(Object.keys(API_PROVIDERS).sort(), ['brave', 'google', 'marginalia', 'tavily']);
});
