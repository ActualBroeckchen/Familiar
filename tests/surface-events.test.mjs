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
  getRecentOfferTimes,
  loadSurfaceEvents,
  tagOutcomes,
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

test('recordSurfaceOffers + getRecentOfferTimes round-trip', async () => {
  await recordSurfaceOffers(
    [
      { id: 't1', label: 'eat lunch',     type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' },
      { id: 't2', label: 'submit form',   type: 'task', stakesTier: 'external_obligation', confidence: 'high' },
    ],
    { threat_tier: 'calm', routine_phase: 'morning' },
    T0,
    DIR,
  );
  const times = await getRecentOfferTimes(DIR);
  assert.equal(times.t1, T0);
  assert.equal(times.t2, T0);
});

test('getRecentOfferTimes returns most-recent offer per task', async () => {
  await recordSurfaceOffers(
    [{ id: 't1', label: 'eat lunch', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' }],
    {}, T0, DIR,
  );
  await recordSurfaceOffers(
    [{ id: 't1', label: 'eat lunch', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' }],
    {}, T0 + 4000, DIR,
  );
  const times = await getRecentOfferTimes(DIR);
  assert.equal(times.t1, T0 + 4000);
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

test('tagOutcomes: unresolved + > 24h old → unresponded', async () => {
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
  assert.equal(store.events[0].outcome, OUTCOMES.UNRESPONDED);
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
