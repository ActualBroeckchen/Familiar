// surface-events.test.mjs
//
// Targets the event store + outcome tagger directly. Each test gets
// its own temp tomesDir via mkdtempSync (mirrors the pondering.js test
// pattern). This guarantees the production .surface-events.json is
// never touched, even if someone runs tests against a working install.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

import {
  recordSurfaceOffers,
  getRecentOfferInfo,
  loadSurfaceEvents,
  tagOutcomes,
  tagRaisedOutcomes,
  getNewOutcomesSinceLastReflection,
  shouldReflectNow,
  markReflected,
  OUTCOMES,
} from '../surface-events.js';

// Per-test isolated dir. Set in beforeEach, cleaned in afterEach.
let DIR;
beforeEach(() => {
  DIR = mkdtempSync(path.join(os.tmpdir(), 'surface-events-test-'));
});
afterEach(() => {
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Use timestamps relative to "now" so pruneEvents (30d retention from
// Date.now()) doesn't discard the synthetic events under us.
const T0 = Date.now() - 60_000; // 1 min ago — well within retention

// ── Recording + dedup ───────────────────────────────────────────────

test('recordSurfaceOffers + getRecentOfferInfo round-trip', async () => {
  await recordSurfaceOffers(
    [
      { id: 't1', label: 'eat lunch',     type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' },
      { id: 't2', label: 'submit form',   type: 'task', stakesTier: 'external_obligation', confidence: 'high' },
    ],
    { threat_tier: 'calm', routine_phase: 'morning' },
    T0,
    DIR,
  );
  const info = await getRecentOfferInfo(DIR);
  assert.equal(info.t1.at, T0);
  assert.equal(info.t1.raised, null, 'fresh offer starts untagged');
  assert.equal(info.t2.at, T0);
});

test('getRecentOfferInfo returns most-recent offer per task', async () => {
  await recordSurfaceOffers(
    [{ id: 't1', label: 'eat lunch', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' }],
    {}, T0, DIR,
  );
  await recordSurfaceOffers(
    [{ id: 't1', label: 'eat lunch', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' }],
    {}, T0 + 4000, DIR,
  );
  const info = await getRecentOfferInfo(DIR);
  assert.equal(info.t1.at, T0 + 4000);
});

// ── Raised tagging ──────────────────────────────────────────────────

test('tagRaisedOutcomes: label in response → raised, absent → not raised', async () => {
  await recordSurfaceOffers(
    [
      { id: 't1', label: 'eat lunch',   type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' },
      { id: 't2', label: 'submit form', type: 'task', stakesTier: 'external_obligation', confidence: 'high' },
    ],
    {}, T0, DIR,
  );
  const result = await tagRaisedOutcomes({
    responseText: 'By the way — did you manage to EAT LUNCH yet? It matters today.',
    tasks: [{ id: 't1', label: 'eat lunch' }, { id: 't2', label: 'submit form' }],
    now: T0 + 1000,
    tomesDir: DIR,
  });
  assert.equal(result.raised, 1);
  assert.equal(result.notRaised, 1);
  const info = await getRecentOfferInfo(DIR);
  assert.equal(info.t1.raised, true, 'case-insensitive label match counts as raised');
  assert.equal(info.t2.raised, false);
});

test('tagRaisedOutcomes: only the most recent untagged offer is touched', async () => {
  await recordSurfaceOffers(
    [{ id: 't1', label: 'eat lunch', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' }],
    {}, T0, DIR,
  );
  await tagRaisedOutcomes({
    responseText: 'no mention here',
    tasks: [{ id: 't1', label: 'eat lunch' }],
    now: T0 + 1000, tomesDir: DIR,
  });
  // Re-offer later; new tag pass must hit the NEW event, not re-tag the old.
  await recordSurfaceOffers(
    [{ id: 't1', label: 'eat lunch', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' }],
    {}, T0 + 5000, DIR,
  );
  await tagRaisedOutcomes({
    responseText: 'so, about eat lunch…',
    tasks: [{ id: 't1', label: 'eat lunch' }],
    now: T0 + 6000, tomesDir: DIR,
  });
  const store = await loadSurfaceEvents(DIR);
  const sorted = store.events.filter(e => e.task_id === 't1').sort((a, b) => a.offered_at - b.offered_at);
  assert.equal(sorted[0].raised, false, 'first offer keeps its original tag');
  assert.equal(sorted[1].raised, true, 'second offer tagged by the second pass');
  const info = await getRecentOfferInfo(DIR);
  assert.equal(info.t1.raised, true, 'lookup reflects the most recent offer');
});

test('tagRaisedOutcomes: empty response / unknown task → no-op', async () => {
  await recordSurfaceOffers(
    [{ id: 't1', label: 'eat lunch', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' }],
    {}, T0, DIR,
  );
  assert.deepEqual(
    await tagRaisedOutcomes({ responseText: '', tasks: [{ id: 't1', label: 'eat lunch' }], tomesDir: DIR }),
    { raised: 0, notRaised: 0 },
  );
  assert.deepEqual(
    await tagRaisedOutcomes({ responseText: 'hello', tasks: [{ id: 'ghost', label: 'nope' }], tomesDir: DIR }),
    { raised: 0, notRaised: 0 },
  );
  const info = await getRecentOfferInfo(DIR);
  assert.equal(info.t1.raised, null, 'offer left untagged');
});

// ── Outcome tagging ─────────────────────────────────────────────────

test('tagOutcomes: done resolution → engaged_and_completed', async () => {
  await recordSurfaceOffers(
    [{ id: 't1', label: 'submit form', type: 'task', stakesTier: 'external_obligation', confidence: 'high' }],
    { threat_tier: 'calm' }, T0, DIR,
  );
  const result = await tagOutcomes({
    windowItems: [{ id: 't1', type: 'task', label: 'submit form', resolution: 'done' }],
    now: T0 + 1000,
    tomesDir: DIR,
  });
  assert.equal(result.tagged, 1);
  const store = await loadSurfaceEvents(DIR);
  assert.equal(store.events[0].outcome, OUTCOMES.ENGAGED_AND_COMPLETED);
  assert.equal(store.events[0].outcome_at, T0 + 1000);
});

test('tagOutcomes: maps cancelled / carried_forward / fired', async () => {
  await recordSurfaceOffers(
    [
      { id: 't1', label: 'a', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' },
      { id: 't2', label: 'b', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' },
      { id: 't3', label: 'c', type: 'reminder', stakesTier: 'personal_wellbeing', confidence: 'low' },
    ],
    {}, T0, DIR,
  );
  await tagOutcomes({
    windowItems: [
      { id: 't1', resolution: 'cancelled' },
      { id: 't2', resolution: 'carried_forward' },
      { id: 't3', resolution: 'fired' },
    ],
    now: T0 + 1000,
    tomesDir: DIR,
  });
  const store = await loadSurfaceEvents(DIR);
  const byId = Object.fromEntries(store.events.map(e => [e.task_id, e.outcome]));
  assert.equal(byId.t1, OUTCOMES.CANCELLED);
  assert.equal(byId.t2, OUTCOMES.DEFERRED);
  assert.equal(byId.t3, OUTCOMES.FIRED);
});

test('tagOutcomes: unresolved + >24h + I RAISED it → unresponded', async () => {
  await recordSurfaceOffers(
    [{ id: 't1', label: 'walk the dog', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' }],
    {}, T0, DIR,
  );
  // Post-turn scan confirms I actually brought it up.
  await tagRaisedOutcomes({
    responseText: 'hey, did you walk the dog yet?',
    tasks: [{ id: 't1', label: 'walk the dog' }],
    now: T0 + 1000, tomesDir: DIR,
  });
  const result = await tagOutcomes({
    windowItems: [{ id: 't1', resolution: null }],
    now: T0 + 25 * 3600 * 1000,
    tomesDir: DIR,
  });
  assert.equal(result.tagged, 1);
  const store = await loadSurfaceEvents(DIR);
  assert.equal(store.events[0].outcome, OUTCOMES.UNRESPONDED);
});

test('tagOutcomes: unresolved + >24h + I NEVER raised it (raised=false) → not_raised', async () => {
  await recordSurfaceOffers(
    [{ id: 't1', label: 'walk the dog', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' }],
    {}, T0, DIR,
  );
  // Post-turn scan: my reply never mentioned it → raised=false.
  await tagRaisedOutcomes({
    responseText: 'totally unrelated reply',
    tasks: [{ id: 't1', label: 'walk the dog' }],
    now: T0 + 1000, tomesDir: DIR,
  });
  const result = await tagOutcomes({
    windowItems: [{ id: 't1', resolution: null }],
    now: T0 + 25 * 3600 * 1000,
    tomesDir: DIR,
  });
  assert.equal(result.tagged, 1);
  const store = await loadSurfaceEvents(DIR);
  assert.equal(store.events[0].outcome, OUTCOMES.NOT_RAISED,
    'never-raised offers must not be read as the human ignoring me');
});

test('tagOutcomes: unresolved + >24h + untagged raise (null) → not_raised (conservative)', async () => {
  await recordSurfaceOffers(
    [{ id: 't1', label: 'a', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' }],
    {}, T0, DIR,
  );
  const result = await tagOutcomes({
    windowItems: [{ id: 't1', resolution: null }],
    now: T0 + 25 * 3600 * 1000,
    tomesDir: DIR,
  });
  assert.equal(result.tagged, 1);
  const store = await loadSurfaceEvents(DIR);
  assert.equal(store.events[0].outcome, OUTCOMES.NOT_RAISED,
    'unconfirmed raise is treated as not-raised, never as unresponded');
});

test('tagOutcomes: a real resolution still wins regardless of raised state', async () => {
  await recordSurfaceOffers(
    [{ id: 't1', label: 'a', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' }],
    {}, T0, DIR,
  );
  // Never raised, but the task actually got done — resolution is truth.
  const result = await tagOutcomes({
    windowItems: [{ id: 't1', resolution: 'done' }],
    now: T0 + 25 * 3600 * 1000,
    tomesDir: DIR,
  });
  assert.equal(result.tagged, 1);
  const store = await loadSurfaceEvents(DIR);
  assert.equal(store.events[0].outcome, OUTCOMES.ENGAGED_AND_COMPLETED);
});

test('tagOutcomes: unresolved + < 24h → skipped (left null)', async () => {
  await recordSurfaceOffers(
    [{ id: 't1', label: 'a', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' }],
    {}, T0, DIR,
  );
  const result = await tagOutcomes({
    windowItems: [{ id: 't1', resolution: null }],
    now: T0 + 3 * 3600 * 1000,
    tomesDir: DIR,
  });
  assert.equal(result.tagged, 0);
  assert.equal(result.skipped, 1);
});

test('tagOutcomes: already-tagged events are not re-tagged', async () => {
  await recordSurfaceOffers(
    [{ id: 't1', label: 'a', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' }],
    {}, T0, DIR,
  );
  await tagOutcomes({
    windowItems: [{ id: 't1', resolution: 'done' }],
    now: T0 + 1000,
    tomesDir: DIR,
  });
  // Second tag pass with different resolution — should be ignored
  const result = await tagOutcomes({
    windowItems: [{ id: 't1', resolution: 'cancelled' }],
    now: T0 + 2000,
    tomesDir: DIR,
  });
  assert.equal(result.tagged, 0);
  const store = await loadSurfaceEvents(DIR);
  assert.equal(store.events[0].outcome, OUTCOMES.ENGAGED_AND_COMPLETED);
  assert.equal(store.events[0].outcome_at, T0 + 1000);
});

// ── Reflection inputs ──────────────────────────────────────────────

test('getNewOutcomesSinceLastReflection: includes only outcome_at > last_reflection_at', async () => {
  await recordSurfaceOffers(
    [
      { id: 't1', label: 'a', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' },
      { id: 't2', label: 'b', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' },
    ],
    {}, T0, DIR,
  );
  await tagOutcomes({
    windowItems: [{ id: 't1', resolution: 'done' }],
    now: T0 + 1000,
    tomesDir: DIR,
  });
  await markReflected(T0 + 1500, DIR);
  await tagOutcomes({
    windowItems: [{ id: 't2', resolution: 'done' }],
    now: T0 + 2000,
    tomesDir: DIR,
  });
  const fresh = await getNewOutcomesSinceLastReflection(DIR);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].task_id, 't2');
});

test('shouldReflectNow: threshold gate', async () => {
  // Empty store → false
  assert.equal(await shouldReflectNow({ minOutcomes: 5, tomesDir: DIR }), false);

  // Add and tag 4 outcomes → still below threshold
  const four = Array.from({ length: 4 }, (_, i) => ({
    id: `t${i}`, label: `task${i}`, type: 'task',
    stakesTier: 'personal_wellbeing', confidence: 'low',
  }));
  await recordSurfaceOffers(four, {}, T0, DIR);
  await tagOutcomes({
    windowItems: four.map(t => ({ id: t.id, resolution: 'done' })),
    now: T0 + 1000,
    tomesDir: DIR,
  });
  assert.equal(await shouldReflectNow({ minOutcomes: 5, tomesDir: DIR }), false);

  // 5th outcome — threshold met
  await recordSurfaceOffers(
    [{ id: 't5', label: 'task5', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' }],
    {}, T0 + 2000, DIR,
  );
  await tagOutcomes({
    windowItems: [{ id: 't5', resolution: 'done' }],
    now: T0 + 3000,
    tomesDir: DIR,
  });
  assert.equal(await shouldReflectNow({ minOutcomes: 5, tomesDir: DIR }), true);
});

test('markReflected resets the fresh-outcome window', async () => {
  const five = Array.from({ length: 5 }, (_, i) => ({
    id: `t${i}`, label: `task${i}`, type: 'task',
    stakesTier: 'personal_wellbeing', confidence: 'low',
  }));
  await recordSurfaceOffers(five, {}, T0, DIR);
  await tagOutcomes({
    windowItems: five.map(t => ({ id: t.id, resolution: 'done' })),
    now: T0 + 1000,
    tomesDir: DIR,
  });
  assert.equal(await shouldReflectNow({ tomesDir: DIR }), true);
  await markReflected(T0 + 2000, DIR);
  assert.equal(await shouldReflectNow({ tomesDir: DIR }), false);
});

// ── Lock serialisation (regression guard for L2) ────────────────────

test('concurrent recordSurfaceOffers calls do not lose data', async () => {
  // Fire 10 record-offer calls in parallel; withDirLock should
  // serialise them so the events array ends up with all 10.
  const calls = Array.from({ length: 10 }, (_, i) =>
    recordSurfaceOffers(
      [{ id: `concurrent-${i}`, label: `task ${i}`, type: 'task',
         stakesTier: 'personal_wellbeing', confidence: 'low' }],
      {}, T0 + i, DIR,
    )
  );
  await Promise.all(calls);
  const store = await loadSurfaceEvents(DIR);
  assert.equal(store.events.length, 10, 'all 10 concurrent offers landed');
  const ids = new Set(store.events.map(e => e.task_id));
  assert.equal(ids.size, 10, 'no duplicates or overwrites');
});
