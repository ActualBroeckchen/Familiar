import { test } from 'node:test';
import assert from 'node:assert/strict';

import { researchForPonder, sourcesBlock } from '../ponder-research.js';

// A fake shared budget so the loop's real file I/O never runs in tests.
function fakeBudget(start) {
  let n = start;
  return {
    remaining: () => Math.max(0, n),
    record: (k = 1) => { n -= Math.max(0, k); return Math.max(0, n); },
    get left() { return n; },
  };
}

const baseSettings = { ponderWebEnabled: true, webSearchEnabled: true, ponderWebRoundsPerTick: 4 };

test('no topic or no callLLM → empty, no budget spent', async () => {
  const r1 = await researchForPonder({ topic: '', callLLM: async () => '{}', settings: baseSettings });
  assert.deepEqual(r1, { sources: [], readsUsed: 0, budgetSpent: false });
  const r2 = await researchForPonder({ topic: 'x', callLLM: undefined, settings: baseSettings });
  assert.deepEqual(r2, { sources: [], readsUsed: 0, budgetSpent: false });
});

test('an already-spent budget reports budgetSpent and never calls the model', async () => {
  let called = 0;
  const b = fakeBudget(0);
  const r = await researchForPonder(
    { topic: 'tea', callLLM: async () => { called++; return '{}'; }, settings: baseSettings },
    { ...b },
  );
  assert.deepEqual(r, { sources: [], readsUsed: 0, budgetSpent: true });
  assert.equal(called, 0);
});

test('bounded loop: executes searches + reads, stops on done', async () => {
  const b = fakeBudget(12);
  let round = 0;
  const searched = [], readUrls = [];
  const r = await researchForPonder(
    {
      topic: 'the small web',
      callLLM: async () => {
        round++;
        if (round === 1) return '{"searches":["small web index"],"reads":["https://example.com/a"],"done":false}';
        return '{"searches":[],"reads":[],"done":true}';   // round 2: satisfied
      },
      settings: baseSettings,
    },
    {
      ...b,
      searchWeb: async (q) => { searched.push(q); return { rows: [{ title: 'Marginalia', url: 'https://marginalia.nu' }] }; },
      readWebpage: async (u) => { readUrls.push(u); return '---\nmeta\n---\nthe page body'; },
      shouldBrowserRead: () => false,
    },
  );
  assert.deepEqual(searched, ['small web index']);
  assert.deepEqual(readUrls, ['https://example.com/a']);
  assert.equal(r.readsUsed, 2);                     // one search + one read
  assert.equal(b.left, 10);                         // budget decremented by 2
  assert.equal(r.sources.length, 2);
  assert.equal(r.sources[0].kind, 'search');
  assert.equal(r.sources[1].kind, 'read');
  assert.match(r.sources[1].excerpt, /the page body/);   // front-matter stripped
});

test('round cap bounds a model that never says done', async () => {
  const b = fakeBudget(100);
  let calls = 0;
  const r = await researchForPonder(
    {
      topic: 'endless',
      callLLM: async () => { calls++; return '{"searches":["q"],"reads":[],"done":false}'; },
      settings: { ...baseSettings, ponderWebRoundsPerTick: 3 },
    },
    { ...b, searchWeb: async () => ({ rows: [] }) },
  );
  assert.equal(calls, 3);                           // exactly ponderWebRoundsPerTick planning calls
  assert.equal(r.readsUsed, 3);                     // one search per round
});

test('budget exhaustion mid-round stops further reads', async () => {
  const b = fakeBudget(1);                          // only ONE read allowed all day
  const r = await researchForPonder(
    {
      topic: 'tight',
      callLLM: async () => '{"searches":["a","b"],"reads":["https://x/1","https://x/2"],"done":false}',
      settings: baseSettings,
    },
    { ...b, searchWeb: async () => ({ rows: [] }), readWebpage: async () => 'body', shouldBrowserRead: () => false },
  );
  assert.equal(r.readsUsed, 1);                     // stopped the instant the budget hit 0
  assert.equal(b.left, 0);
});

test('a malformed plan ends the loop gracefully', async () => {
  const b = fakeBudget(12);
  const r = await researchForPonder(
    { topic: 'x', callLLM: async () => 'not json at all', settings: baseSettings },
    { ...b },
  );
  assert.deepEqual(r.sources, []);
  assert.equal(r.readsUsed, 0);
});

test('browser-backed read is preferred when available', async () => {
  const b = fakeBudget(12);
  let browseCalls = 0, staticCalls = 0, round = 0;
  await researchForPonder(
    {
      topic: 'live dom',
      callLLM: async () => (++round === 1
        ? '{"searches":[],"reads":["https://spa.example"],"done":false}'
        : '{"done":true}'),
      settings: baseSettings,
    },
    {
      ...b,
      shouldBrowserRead: () => true,
      browseRead: async () => { browseCalls++; return { ok: true, text: 'rendered by browser' }; },
      readWebpage: async () => { staticCalls++; return 'static'; },
    },
  );
  assert.equal(browseCalls, 1);
  assert.equal(staticCalls, 0);                     // never fell through to the static floor
});

test('sourcesBlock renders nothing for empty, cites entries otherwise', () => {
  assert.equal(sourcesBlock([]), '');
  assert.equal(sourcesBlock(null), '');
  const block = sourcesBlock([{ kind: 'read', ref: 'https://x', excerpt: 'a fact  with   spaces' }]);
  assert.match(block, /\[1\] \(read\) https:\/\/x/);
  assert.match(block, /a fact with spaces/);        // whitespace collapsed
});
