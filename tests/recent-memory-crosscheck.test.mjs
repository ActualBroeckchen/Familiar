import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getRecentMemoryLines } from '../thalamus.js';
import { buildReachoutPrompt } from '../src/warmth/reachout.js';
import { formatRecentMessagesForContext } from '../cerebellum.js';

// The shared recent-message formatter (used by warm reach-out AND noticing —
// extracted so the two proactive surfaces don't each carry the same map).
test('formatRecentMessagesForContext handles string + array content, skips empties', () => {
  const now = Date.parse('2026-07-25T12:00:00Z');
  const out = formatRecentMessagesForContext([
    { role: 'user', content: 'plain string message', timestamp: '2026-07-25T11:00:00Z' },
    { role: 'assistant', content: [{ type: 'text', text: 'array content message' }], timestamp: '2026-07-25T11:30:00Z' },
    { role: 'user', content: '' },   // empty → dropped
  ], now);
  assert.match(out, /Them.*plain string message/);
  assert.match(out, /Me.*array content message/);
  assert.equal(out.split('\n').length, 2, 'the empty message is dropped');
  assert.equal(formatRecentMessagesForContext([], now), '');
  assert.equal(formatRecentMessagesForContext(undefined, now), '');
});

// The fix: proactive questions (warm reach-out + the causal-chain "did that
// follow?" hindsight lines) must cross-check recent (today+yesterday) memory
// so they don't re-ask something my human already answered across sessions.

test('getRecentMemoryLines formats results from the injected fetch', async () => {
  const fetchFn = async ({ fromDate, toDate, limit }) => {
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(fromDate), 'fromDate is a YYYY-MM-DD ward-local date');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(toDate), 'toDate is a YYYY-MM-DD ward-local date');
    assert.equal(limit, 8);
    return { results: [
      { granularity: 'daily', date: '2026-07-24', excerpt: 'therapy went okay, felt lighter after' },
      { granularity: 'daily', date: '2026-07-25', content: 'ordered the oat milk finally' },
    ] };
  };
  const lines = await getRecentMemoryLines({ days: 2, limit: 8, fetchFn });
  assert.match(lines, /therapy went okay/);
  assert.match(lines, /ordered the oat milk/);
  assert.match(lines, /daily\/2026-07-24/);
});

test('getRecentMemoryLines returns "" on empty results, empty-text rows, and failure', async () => {
  assert.equal(await getRecentMemoryLines({ fetchFn: async () => ({ results: [] }) }), '');
  assert.equal(await getRecentMemoryLines({ fetchFn: async () => ({ results: [{ date: '2026-07-25', content: '   ' }] }) }), '');
  assert.equal(await getRecentMemoryLines({ fetchFn: async () => { throw new Error('phylactery down'); } }), '',
    'a failed fetch degrades to "" — the block is simply omitted, never throws into a turn');
  assert.equal(await getRecentMemoryLines({ fetchFn: async () => ({}) }), '', 'no results array → ""');
});

test('getRecentMemoryLines normalizes bad days (never inverts the range)', async () => {
  const seen = [];
  const fetchFn = async ({ fromDate, toDate }) => { seen.push({ fromDate, toDate }); return { results: [] }; };
  // days=0, negative, and non-numeric must all resolve to a valid range where
  // fromDate <= toDate (falls back to "today only"), not an inverted query.
  for (const bad of [0, -3, NaN, undefined]) {
    await getRecentMemoryLines({ days: bad, fetchFn });
  }
  for (const { fromDate, toDate } of seen) {
    assert.ok(fromDate <= toDate, `fromDate (${fromDate}) must not be after toDate (${toDate})`);
  }
});

test('buildReachoutPrompt injects the recent-memory cross-check when memories exist', () => {
  const withMem = buildReachoutPrompt({
    nowBlock: '[Now] …', identityContext: '', sessionBlock: '', pendingTells: [], warmVillagers: [],
    wardSilencePhrase: 'an hour', recentMemoryBlock: '  · (daily/2026-07-24) therapy went okay',
  });
  // the memories are present…
  assert.match(withMem, /therapy went okay/);
  // …and the cross-check instruction that stops a redundant re-ask is present…
  assert.match(withMem, /already answered/i);
  // …without dampening genuine outreach (still names "genuinely fresh")
  assert.match(withMem, /genuinely fresh/i);
});

test('buildReachoutPrompt omits the recent-memory section when there are no recent memories', () => {
  const noMem = buildReachoutPrompt({
    nowBlock: '[Now] …', identityContext: '', sessionBlock: '', pendingTells: [], warmVillagers: [],
    wardSilencePhrase: 'an hour', recentMemoryBlock: '',
  });
  assert.doesNotMatch(noMem, /Recent memories \(today and yesterday\)/);
});
