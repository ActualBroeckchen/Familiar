import { test } from 'node:test';
import assert from 'node:assert/strict';

import { searxngSearch, libreySearch, fourgetSearch } from '../local-engine-adapters.js';

const okJson = (payload) => async () => ({ ok: true, json: async () => payload });

test('searxngSearch passes through results[] and builds the format=json url', async () => {
  let hit = '';
  const fetchFn = async (url) => { hit = url; return { ok: true, json: async () => ({ results: [{ title: 'A', url: 'http://a', content: 'ca' }] }) }; };
  const r = await searxngSearch('http://127.0.0.1:9/', 'cats', { fetchFn });
  assert.match(hit, /^http:\/\/127\.0\.0\.1:9\/search\?q=cats&format=json$/); // trailing slash trimmed
  assert.deepEqual(r.rows[0], { title: 'A', url: 'http://a', content: 'ca' });
});

test('libreySearch maps the JSON array and drops entries without a url+title', async () => {
  const payload = [
    { wikipedia: { title: 'infobox', text: '…' } },           // leading special element, no url → dropped
    { title: 'L1', url: 'https://l1.test', description: 'd1' },
    { title: '', url: 'https://nope.test' },                   // no title → dropped
  ];
  const r = await libreySearch('http://127.0.0.1:8', 'dogs', { fetchFn: okJson(payload) });
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.rows[0], { title: 'L1', url: 'https://l1.test', content: 'd1' });
});

test('fourgetSearch maps the web[] group', async () => {
  const payload = { status: 'ok', web: [{ title: 'F1', url: 'https://f1.test', description: 'df1' }] };
  const r = await fourgetSearch('http://127.0.0.1:7', 'foxes', { fetchFn: okJson(payload) });
  assert.deepEqual(r.rows[0], { title: 'F1', url: 'https://f1.test', content: 'df1' });
});

test('a local adapter reports an HTTP error (caller degrades to the floor)', async () => {
  const fetchFn = async () => ({ ok: false, status: 502 });
  assert.match((await libreySearch('http://x', 'q', { fetchFn })).error, /HTTP 502/);
  assert.match((await fourgetSearch('http://x', 'q', { fetchFn })).error, /HTTP 502/);
  assert.match((await searxngSearch('http://x', 'q', { fetchFn })).error, /HTTP 502/);
});
