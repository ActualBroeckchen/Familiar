// Tests for the Pillar D outgoing message gate (outgoing-filter.js).
//
// This gate is what stops ward-private knowledge from leaking into a shared
// room: it embeds the draft, asks Phylactery whether anything matches above
// threshold, and on a hit retries up to FILTER_RETRY_BUDGET times before
// falling back to a safe refusal. It must ALSO fail open — a search error can
// never block the reply. These tests drive it with an injected checkRestricted
// so they need neither a provider nor MCP.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  filterOutgoingReply,
  FILTER_THRESHOLD,
  FILTER_RETRY_BUDGET,
  FILTER_SAFE_REFUSAL,
} from '../outgoing-filter.js';

test('constants match the signed-off build-spec values', () => {
  assert.equal(FILTER_THRESHOLD, 0.70);
  assert.equal(FILTER_RETRY_BUDGET, 3);
  assert.match(FILTER_SAFE_REFUSAL, /can't share that here/i);
});

test('ward-private rooms skip the filter entirely (fast-path, no check)', async () => {
  let checked = false;
  const out = await filterOutgoingReply({
    draftText: 'anything at all',
    audienceTag: 'ward-private',
    callUpstream: async () => { throw new Error('should not be called'); },
    baseMessages: [],
    checkRestricted: async () => { checked = true; return { hit: true }; },
  });
  assert.deepEqual(out, { text: 'anything at all', blocked: false });
  assert.equal(checked, false, 'ward-private must not even run the restricted check');
});

test('a clean draft in a shared room passes through unchanged', async () => {
  const out = await filterOutgoingReply({
    draftText: 'just a friendly hello',
    audienceTag: 'villagers',
    callUpstream: async () => { throw new Error('should not retry'); },
    baseMessages: [{ role: 'user', content: 'hi' }],
    checkRestricted: async () => ({ hit: false }),
  });
  assert.deepEqual(out, { text: 'just a friendly hello', blocked: false });
});

test('a hit triggers a retry; a clean rewrite is delivered', async () => {
  let calls = 0;
  const out = await filterOutgoingReply({
    draftText: 'leaky first draft',
    audienceTag: 'villagers',
    callUpstream: async () => { calls++; return 'clean rewrite'; },
    baseMessages: [{ role: 'user', content: 'hi' }],
    // First check (original draft) hits; the rewrite is clean.
    checkRestricted: async (draft) => draft === 'leaky first draft' ? { hit: true, topic: 'the secret' } : { hit: false },
  });
  assert.deepEqual(out, { text: 'clean rewrite', blocked: false });
  assert.equal(calls, 1, 'exactly one retry for a single hit');
});

test('the rejection prompt carries the matched topic into the retry context', async () => {
  let seenSystem = null;
  await filterOutgoingReply({
    draftText: 'leaky',
    audienceTag: 'strangers',
    callUpstream: async (msgs) => {
      seenSystem = msgs.find(m => m.role === 'system')?.content ?? null;
      return 'clean';
    },
    baseMessages: [{ role: 'user', content: 'hi' }],
    checkRestricted: async (draft) => draft === 'leaky' ? { hit: true, topic: 'their address' } : { hit: false },
  });
  assert.ok(seenSystem, 'a system rejection message should be appended for the retry');
  assert.match(seenSystem, /their address/, 'the matched topic should be named in the rejection prompt');
});

test('persistent hits exhaust the budget and fall back to the safe refusal', async () => {
  let calls = 0;
  const out = await filterOutgoingReply({
    draftText: 'always leaky',
    audienceTag: 'villagers',
    callUpstream: async () => { calls++; return 'still leaky'; },
    baseMessages: [{ role: 'user', content: 'hi' }],
    checkRestricted: async () => ({ hit: true, topic: 'x' }),  // never clears
  });
  assert.deepEqual(out, { text: FILTER_SAFE_REFUSAL, blocked: true });
  // Budget is 3: retries fire on i=0,1,2; i=3 short-circuits to refusal.
  assert.equal(calls, FILTER_RETRY_BUDGET, 'should retry exactly the budget before refusing');
});

test('an upstream error during retry fails closed to the safe refusal', async () => {
  const out = await filterOutgoingReply({
    draftText: 'leaky',
    audienceTag: 'villagers',
    callUpstream: async () => { throw new Error('provider down'); },
    baseMessages: [{ role: 'user', content: 'hi' }],
    checkRestricted: async () => ({ hit: true, topic: 'x' }),
  });
  assert.deepEqual(out, { text: FILTER_SAFE_REFUSAL, blocked: true });
});
