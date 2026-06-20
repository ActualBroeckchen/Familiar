import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isBlockedIp,
  assertPublicUrl,
  guardedFetch,
  searchWeb,
  lookUp,
  readWebpage,
  WebAccessError,
} from '../websearch.js';

// ── SSRF guard: pure IP classification ───────────────────────────
test('isBlockedIp blocks loopback, private, link-local, metadata, and reserved', () => {
  for (const ip of [
    '127.0.0.1', '127.9.9.9', '10.0.0.1', '172.16.5.4', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1',
    'not-an-ip',
  ]) {
    assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`);
  }
});

test('isBlockedIp allows public addresses', () => {
  for (const ip of ['93.184.216.34', '1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) {
    assert.equal(isBlockedIp(ip), false, `${ip} should be allowed`);
  }
});

// ── assertPublicUrl: scheme + resolved-address gating ────────────
test('assertPublicUrl rejects non-http(s) schemes', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com', 'data:text/html,hi']) {
    await assert.rejects(() => assertPublicUrl(url), WebAccessError);
  }
});

test('assertPublicUrl rejects localhost and literal private IPs without DNS', async () => {
  for (const url of ['http://localhost/x', 'http://app.localhost/x', 'http://127.0.0.1:8742/api', 'http://169.254.169.254/latest/meta-data']) {
    await assert.rejects(() => assertPublicUrl(url), WebAccessError);
  }
});

test('assertPublicUrl rejects a hostname that resolves to a private IP', async () => {
  const lookupFn = async () => [{ address: '10.0.0.5' }];
  await assert.rejects(() => assertPublicUrl('http://rebind.example/', { lookupFn }), WebAccessError);
});

test('assertPublicUrl accepts a hostname that resolves to a public IP', async () => {
  const lookupFn = async () => [{ address: '93.184.216.34' }];
  const u = await assertPublicUrl('http://example.com/page', { lookupFn });
  assert.equal(u.hostname, 'example.com');
});

// ── guardedFetch: manual redirects re-validate every hop ─────────
test('guardedFetch refuses a redirect that lands on a private address', async () => {
  const lookupFn = async () => [{ address: '93.184.216.34' }]; // first hop public
  const fetchFn = async () => ({
    status: 302,
    headers: { get: (h) => (h.toLowerCase() === 'location' ? 'http://127.0.0.1/secret' : null) },
  });
  await assert.rejects(() => guardedFetch('http://example.com/', { fetchFn, lookupFn }), WebAccessError);
});

test('guardedFetch returns the final response after a permitted redirect', async () => {
  const lookupFn = async () => [{ address: '93.184.216.34' }];
  let call = 0;
  const fetchFn = async (href) => {
    call += 1;
    if (call === 1) return { status: 301, url: href, headers: { get: (h) => (h.toLowerCase() === 'location' ? 'http://example.com/final' : null) } };
    return { status: 200, url: href, headers: { get: () => null } };
  };
  const res = await guardedFetch('http://example.com/start', { fetchFn, lookupFn });
  assert.equal(res.status, 200);
  assert.equal(res.url, 'http://example.com/final');
});

// ── searchWeb: built-in DuckDuckGo default ───────────────────────
const DDG_HTML = `
  <div class="result results_links_deep">
    <div class="links_main">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=z">Result A</a>
      <a class="result__snippet" href="#">snippet a</a>
    </div>
  </div>
  <div class="result results_links_deep">
    <div class="links_main">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fb">Result B</a>
      <a class="result__snippet">snippet b</a>
    </div>
  </div>
  <div class="result result--ad">
    <div class="links_main"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fad.test">An ad</a></div>
  </div>`;

test('searchWeb (default backend) scrapes DuckDuckGo, decodes uddg links, skips ads, caps results', async () => {
  const lookupFn = async () => [{ address: '93.184.216.34' }];
  const fetchFn  = async (href) => ({ ok: true, url: href, status: 200, headers: { get: () => null }, text: async () => DDG_HTML });
  const out = await searchWeb('cats', { webSearchMaxResults: 1 }, { fetchFn, lookupFn });
  assert.match(out, /Results for "cats"/);
  assert.match(out, /1\. Result A/);
  assert.match(out, /https:\/\/example\.com\/a/);   // uddg redirect decoded
  assert.doesNotMatch(out, /2\. Result B/);          // capped at 1
  assert.doesNotMatch(out, /An ad/);                 // result--ad skipped
  assert.match(out, /read_webpage/);
});

test('searchWeb (default backend) degrades calmly when the web is unreachable', async () => {
  const lookupFn = async () => [{ address: '93.184.216.34' }];
  const out = await searchWeb('x', {}, { lookupFn, fetchFn: async () => { throw new Error('ENOTFOUND'); } });
  assert.match(out, /couldn't reach the web/);
});

// ── searchWeb: opt-in SearXNG backend ────────────────────────────
test('searchWeb uses SearXNG JSON when a custom base URL is set', async () => {
  let hit = '';
  const fetchFn = async (url) => { hit = url; return {
    ok: true,
    json: async () => ({ results: [
      { title: 'A', url: 'http://a.test', content: 'snippet a' },
      { title: 'B', url: 'http://b.test', content: 'snippet b' },
    ] }),
  }; };
  const out = await searchWeb('cats', { webSearchBaseUrl: 'http://localhost:8080', webSearchMaxResults: 1 }, { fetchFn });
  assert.match(hit, /^http:\/\/localhost:8080\/search\?q=cats&format=json$/);
  assert.match(out, /1\. A/);
  assert.doesNotMatch(out, /2\. B/);
});

test('searchWeb falls back to keyless when the configured SearXNG backend is down', async () => {
  const lookupFn = async () => [{ address: '93.184.216.34' }];
  const fetchFn  = async (url) => {
    if (url.includes('format=json')) throw new Error('ECONNREFUSED'); // SearXNG unreachable
    return { ok: true, url, status: 200, headers: { get: () => null }, text: async () => DDG_HTML };
  };
  const out = await searchWeb('cats', { webSearchBaseUrl: 'http://localhost:8080' }, { fetchFn, lookupFn });
  assert.match(out, /Result A/);   // keyless results returned despite the stale/down SearXNG URL
});

test('searchWeb reports the SearXNG error only when keyless ALSO fails', async () => {
  const lookupFn = async () => [{ address: '93.184.216.34' }];
  const fetchFn  = async (url) => {
    if (url.includes('format=json')) return { ok: false, status: 403 }; // SearXNG errors
    throw new Error('offline');                                          // keyless also down
  };
  const out = await searchWeb('x', { webSearchBaseUrl: 'http://localhost:8080' }, { fetchFn, lookupFn });
  assert.match(out, /HTTP 403/);
});

test('searchWeb needs a query', async () => {
  assert.match(await searchWeb('   ', {}), /need something to search/);
});

// ── searchWeb: backend selection (api / local / floor) ───────────
test('searchWeb (api backend) uses the chosen provider', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({ results: [{ title: 'P', url: 'https://p.test', content: 'cp' }] }) });
  const out = await searchWeb('cats',
    { webSearchBackend: 'api', webSearchApiProvider: 'tavily', webSearchApiKey: 'tvly-x' },
    { fetchFn });
  assert.match(out, /1\. P/);
  assert.match(out, /https:\/\/p\.test/);
});

test('searchWeb (api backend) falls back to the keyless floor when the provider errors', async () => {
  const lookupFn = async () => [{ address: '93.184.216.34' }];
  const fetchFn  = async (url) => {
    if (url.includes('tavily')) return { ok: false, status: 401 };  // bad key
    return { ok: true, url, status: 200, headers: { get: () => null }, text: async () => DDG_HTML };
  };
  const out = await searchWeb('cats',
    { webSearchBackend: 'api', webSearchApiProvider: 'tavily', webSearchApiKey: 'bad' },
    { fetchFn, lookupFn });
  assert.match(out, /Result A/); // floor answered — never left without search
});

test('searchWeb (api backend, no key set) still answers via the floor', async () => {
  const lookupFn = async () => [{ address: '93.184.216.34' }];
  const fetchFn  = async (url) => ({ ok: true, url, status: 200, headers: { get: () => null }, text: async () => DDG_HTML });
  const out = await searchWeb('cats',
    { webSearchBackend: 'api', webSearchApiProvider: 'brave' }, // no webSearchApiKey
    { fetchFn, lookupFn });
  assert.match(out, /Result A/);
});

test('searchWeb (local backend) uses the injected managed search when present', async () => {
  const managedSearch = async () => ({ rows: [{ title: 'M', url: 'http://m.test', content: 'cm' }] });
  const out = await searchWeb('cats', { webSearchBackend: 'local' }, { managedSearch });
  assert.match(out, /1\. M/);
  assert.match(out, /http:\/\/m\.test/);
});

test('searchWeb (local backend) falls to the floor when the managed engine returns an error', async () => {
  const lookupFn = async () => [{ address: '93.184.216.34' }];
  const fetchFn  = async (url) => ({ ok: true, url, status: 200, headers: { get: () => null }, text: async () => DDG_HTML });
  const managedSearch = async () => ({ error: 'no managed search engine is running right now.' });
  const out = await searchWeb('cats', { webSearchBackend: 'local' }, { fetchFn, lookupFn, managedSearch });
  assert.match(out, /Result A/); // floor answered
});

test('searchWeb (local backend) falls to the floor when no managed search is injected', async () => {
  const lookupFn = async () => [{ address: '93.184.216.34' }];
  const fetchFn  = async (url) => ({ ok: true, url, status: 200, headers: { get: () => null }, text: async () => DDG_HTML });
  const out = await searchWeb('cats', { webSearchBackend: 'local' }, { fetchFn, lookupFn });
  assert.match(out, /Result A/);
});

// ── lookUp: keyless reference APIs (Wikipedia + DDG Instant Answer) ──
const lookupPublic = async () => [{ address: '93.184.216.34' }];

// Route the injected fetch by host so one fetchFn can serve both sources.
function lookUpFetch({ ddg = null, wiki = null } = {}) {
  return async (href) => {
    const base = { ok: true, url: href, status: 200, headers: { get: () => null } };
    if (href.includes('api.duckduckgo.com')) {
      if (ddg == null) return { ...base, ok: false, status: 404 };
      return { ...base, json: async () => ddg };
    }
    if (href.includes('wikipedia.org')) {
      if (wiki == null) return { ...base, ok: false, status: 404 };
      return { ...base, json: async () => wiki };
    }
    throw new Error(`unexpected host: ${href}`);
  };
}

test('lookUp merges a DDG instant answer and a Wikipedia overview, with sources, no scraping', async () => {
  const fetchFn = lookUpFetch({
    ddg:  { AbstractText: 'A cat is a small domesticated carnivore.', AbstractURL: 'https://duckduckgo.com/Cat' },
    wiki: { query: { pages: { '12': { title: 'Cat', extract: 'The cat is a domestic species of small mammal.' } } } },
  });
  const out = await lookUp('cat', {}, { fetchFn, lookupFn: lookupPublic });
  assert.match(out, /what I found on "cat"/);
  assert.match(out, /small domesticated carnivore/);          // DDG abstract
  assert.match(out, /domestic species of small mammal/);       // Wikipedia extract
  assert.match(out, /Sources:/);
  assert.match(out, /en\.wikipedia\.org\/wiki\/Cat/);          // wiki source link built from title
});

test('lookUp still answers when only one source has anything', async () => {
  const fetchFn = lookUpFetch({
    wiki: { query: { pages: { '9': { title: 'Quine', extract: 'A quine is a self-replicating program.' } } } },
  });
  const out = await lookUp('quine', {}, { fetchFn, lookupFn: lookupPublic });
  assert.match(out, /self-replicating program/);
  assert.match(out, /Source:/); // singular — only one source carried through
});

test('lookUp degrades calmly when neither source has an answer', async () => {
  const fetchFn = lookUpFetch({}); // both 404
  const out = await lookUp('asdkjfhqweoiu', {}, { fetchFn, lookupFn: lookupPublic });
  assert.match(out, /couldn't find a clear definition or overview/);
  assert.match(out, /web_search/); // points at the other tool
});

test('lookUp needs a query', async () => {
  assert.match(await lookUp('   ', {}), /need something to look up/);
});

// ── readWebpage: guard refusal + extraction + provenance ─────────
test('readWebpage refuses an internal URL with a calm string, never throwing', async () => {
  const out = await readWebpage('http://127.0.0.1:8742/api/health', {});
  assert.match(out, /private or internal address/);
});

test('readWebpage extracts markdown and stamps provenance', async () => {
  const lookupFn = async () => [{ address: '93.184.216.34' }];
  const html = '<html><head><title>Doc</title></head><body><article><h1>Hello</h1><p>' +
    'This is a sufficiently long paragraph of real article body text so that the readability ' +
    'extractor treats it as the main content and returns it for conversion to markdown.' +
    '</p></article></body></html>';
  const fetchFn = async (href) => ({ ok: true, url: href, status: 200, headers: { get: () => null }, text: async () => html });
  const out = await readWebpage('http://example.com/doc', {}, { fetchFn, lookupFn });
  assert.match(out, /begin external page content/);
  assert.match(out, /Source: http:\/\/example\.com\/doc · retrieved \d{4}-\d{2}-\d{2}/);
  assert.match(out, /Hello/);
});

test('readWebpage truncates at webSearchMaxChars', async () => {
  const lookupFn = async () => [{ address: '93.184.216.34' }];
  const big = 'word '.repeat(2000);
  const html = `<html><body><article><h1>T</h1><p>${big}</p></article></body></html>`;
  const fetchFn = async (href) => ({ ok: true, url: href, status: 200, headers: { get: () => null }, text: async () => html });
  const out = await readWebpage('http://example.com/big', { webSearchMaxChars: 500 }, { fetchFn, lookupFn });
  assert.match(out, /truncated/);
});

test('readWebpage needs a url', async () => {
  assert.match(await readWebpage('', {}), /need the link/);
});
