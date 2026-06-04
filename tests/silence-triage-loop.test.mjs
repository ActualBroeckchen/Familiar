import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOneTriageTick, TRIAGE_SILENCE_THRESHOLD_MS, resetTriageCooldown } from '../silence-triage-loop.js';

// runOneTriageTick mutates module-local cool-down state. Reset before
// every test so order-of-execution doesn't leak between cases.
function freshLoop() { resetTriageCooldown(); }

function makeEnq() {
  const calls = [];
  return {
    fn: async (item) => { calls.push(item); return { id: 'fake', deduped: false }; },
    calls,
  };
}
function dedupingEnq() {
  const calls = [];
  return {
    fn: async (item) => { calls.push(item); return { id: 'fake', deduped: true }; },
    calls,
  };
}

test('runOneTriageTick: calm → no_threat / low_threat skip, no LLM call', async () => {
  freshLoop();
  let decideCalled = false;
  const r = await runOneTriageTick({
    getThreat:       async () => ({ tier: 'calm', weight: 0, disabled: false }),
    getLastActivity: async () => ({ ts: '...', ms: Date.now() - 999_999_999 }),
    decideTriage:    async () => { decideCalled = true; return null; },
    enqueueOutboxFn: async () => ({ id: 'x', deduped: false }),
  });
  assert.equal(r.acted,  false);
  assert.equal(r.reason, 'low_threat');
  assert.equal(decideCalled, false, 'LLM must not be called for calm threat');
});

test('runOneTriageTick: mild → also skipped (mild distress alone is not actively outreach-worthy)', async () => {
  freshLoop();
  const r = await runOneTriageTick({
    getThreat:       async () => ({ tier: 'mild', weight: 1, disabled: false }),
    getLastActivity: async () => ({ ts: '...', ms: Date.now() - 999_999_999 }),
    decideTriage:    async () => { throw new Error('should not be called'); },
    enqueueOutboxFn: async () => { throw new Error('should not be called'); },
  });
  assert.equal(r.acted, false);
  assert.equal(r.reason, 'low_threat');
});

test('runOneTriageTick: severe + recent activity → LLM IS called (no hardcoded silence-threshold gate)', async () => {
  // Old behaviour blocked the LLM with too_recent_activity if silence
  // hadn't crossed a tier-specific threshold. New behaviour: trust the
  // LLM to decide with full context (silence duration is one input
  // among many). The token cost is bounded by the cool-down system.
  freshLoop();
  let decideCalled = false;
  const r = await runOneTriageTick({
    getThreat:       async () => ({ tier: 'severe', weight: 8, disabled: false }),
    getLastActivity: async () => ({ ts: '...', ms: Date.now() - 60_000 }),  // 1 min ago
    decideTriage:    async ({ silenceMs }) => {
      decideCalled = true;
      // The LLM gets the actual silence — it can decide that 1 minute
      // means "they're literally typing, don't reach out" → wait.
      return { action: 'wait', nextCheckInMs: 15 * 60_000 };
    },
    enqueueOutboxFn: async () => ({ id: 'x', deduped: false }),
  });
  assert.equal(decideCalled,    true, 'LLM should be consulted even on recent activity at severe threat');
  assert.equal(r.acted,         false);
  assert.equal(r.reason,        'llm_said_wait');
  assert.equal(r.nextCheckInMs, 15 * 60_000);
});

test('runOneTriageTick: detector disabled → skip with detector_disabled', async () => {
  const r = await runOneTriageTick({
    getThreat:       async () => ({ tier: 'severe', weight: 8, disabled: true }),
    getLastActivity: async () => ({ ts: '...', ms: 0 }),
    decideTriage:    async () => { throw new Error('should not be called'); },
    enqueueOutboxFn: async () => { throw new Error('should not be called'); },
  });
  assert.equal(r.acted, false);
  assert.equal(r.reason, 'detector_disabled');
});

test('runOneTriageTick: no activity record → skip', async () => {
  freshLoop();
  const r = await runOneTriageTick({
    getThreat:       async () => ({ tier: 'severe', weight: 8 }),
    getLastActivity: async () => null,
    decideTriage:    async () => { throw new Error('should not be called'); },
    enqueueOutboxFn: async () => { throw new Error('should not be called'); },
  });
  assert.equal(r.acted, false);
  assert.equal(r.reason, 'no_activity_record');
});

test('runOneTriageTick: thresholds met, LLM says wait → no outbox enqueue', async () => {
  freshLoop();
  const enq = makeEnq();
  const r = await runOneTriageTick({
    getThreat:       async () => ({ tier: 'high', weight: 5 }),
    getLastActivity: async () => ({ ts: '...', ms: Date.now() - 2 * 60 * 60_000 }), // 2hr ago > 1hr required
    decideTriage:    async () => ({ action: 'wait' }),
    enqueueOutboxFn: enq.fn,
  });
  assert.equal(r.acted,    false);
  assert.equal(r.reason,   'llm_said_wait');
  assert.equal(enq.calls.length, 0);
});

test('runOneTriageTick: thresholds met, LLM says reach_out → enqueues triage outbox', async () => {
  freshLoop();
  const enq = makeEnq();
  const r = await runOneTriageTick({
    getThreat:       async () => ({ tier: 'high', weight: 5 }),
    getLastActivity: async () => ({ ts: '...', ms: Date.now() - 2 * 60 * 60_000 }),
    decideTriage:    async () => ({ action: 'reach_out', message: 'I was thinking about you. No pressure to reply.' }),
    enqueueOutboxFn: enq.fn,
  });
  assert.equal(r.acted,  true);
  assert.equal(r.reason, 'reached_out');
  assert.equal(enq.calls.length, 1);
  assert.equal(enq.calls[0].kind,  'triage');
  assert.equal(enq.calls[0].body,  'I was thinking about you. No pressure to reply.');
  assert.match(enq.calls[0].originId, /^triage-high-\d+$/);
});

test('runOneTriageTick: dedup → returns rate_limited not reached_out', async () => {
  freshLoop();
  const enq = dedupingEnq();
  const r = await runOneTriageTick({
    getThreat:       async () => ({ tier: 'severe', weight: 9 }),
    getLastActivity: async () => ({ ts: '...', ms: Date.now() - 3 * 60 * 60_000 }),
    decideTriage:    async () => ({ action: 'reach_out', message: 'gentle nudge' }),
    enqueueOutboxFn: enq.fn,
  });
  assert.equal(r.acted,  false);
  assert.equal(r.reason, 'rate_limited');
});

test('runOneTriageTick: LLM returns reach_out without message → not honored (no enqueue)', async () => {
  freshLoop();
  const enq = makeEnq();
  const r = await runOneTriageTick({
    getThreat:       async () => ({ tier: 'severe', weight: 9 }),
    getLastActivity: async () => ({ ts: '...', ms: Date.now() - 60 * 60_000 }),
    decideTriage:    async () => ({ action: 'reach_out' }),     // missing message
    enqueueOutboxFn: enq.fn,
  });
  assert.equal(r.acted,  false);
  assert.equal(r.reason, 'llm_said_wait');
  assert.equal(enq.calls.length, 0);
});

test('runOneTriageTick: missing required callbacks raise clear errors', async () => {
  await assert.rejects(runOneTriageTick({ getLastActivity: async () => null, decideTriage: async () => null, enqueueOutboxFn: async () => null }), /getThreat/);
  await assert.rejects(runOneTriageTick({ getThreat: async () => ({ tier: 'calm' }), decideTriage: async () => null, enqueueOutboxFn: async () => null }), /getLastActivity/);
});

// ── Cool-down system (Eury request: LLM picks its own re-ping cadence) ──

test('cool-down: after a wait decision, the next tick is in_cooldown (no LLM call)', async () => {
  freshLoop();
  let calls = 0;
  const args = {
    getThreat:       async () => ({ tier: 'high', weight: 5 }),
    getLastActivity: async () => ({ ts: '...', ms: Date.now() - 60 * 60_000 }),
    decideTriage:    async () => { calls++; return { action: 'wait', nextCheckInMs: 30 * 60_000 }; },
    enqueueOutboxFn: async () => ({ id: 'x', deduped: false }),
  };
  const first = await runOneTriageTick(args);
  assert.equal(first.reason, 'llm_said_wait');
  assert.equal(calls, 1);

  // Immediately tick again: must skip without calling the LLM.
  const second = await runOneTriageTick(args);
  assert.equal(second.acted,  false);
  assert.equal(second.reason, 'in_cooldown');
  assert.ok(second.cooldownRemainingMs > 0);
  assert.equal(calls, 1, 'LLM must not be re-called while in cool-down');
});

test('cool-down: after a reach_out decision, the next tick is in_cooldown (no double outbox attempt)', async () => {
  freshLoop();
  let calls = 0;
  const enqueued = [];
  const args = {
    getThreat:       async () => ({ tier: 'severe', weight: 9 }),
    getLastActivity: async () => ({ ts: '...', ms: Date.now() - 60 * 60_000 }),
    decideTriage:    async () => { calls++; return { action: 'reach_out', message: 'thinking of you', nextCheckInMs: 20 * 60_000 }; },
    enqueueOutboxFn: async (item) => { enqueued.push(item); return { id: 'fake', deduped: false }; },
  };
  const first = await runOneTriageTick(args);
  assert.equal(first.acted, true);
  assert.equal(first.reason, 'reached_out');
  assert.equal(calls,        1);
  assert.equal(enqueued.length, 1);

  const second = await runOneTriageTick(args);
  assert.equal(second.reason, 'in_cooldown');
  assert.equal(calls,        1, 'LLM not re-called');
  assert.equal(enqueued.length, 1, 'no duplicate outbox attempt');
});

test('cool-down: 30s floor — LLM-returned 0 / negative / NaN is clamped up', async () => {
  freshLoop();
  let calls = 0;
  const fakeNow = (() => { let t = 1_000_000; return () => t; })();
  const args = {
    getThreat:       async () => ({ tier: 'severe', weight: 9 }),
    getLastActivity: async () => ({ ts: '...', ms: 0 }),
    decideTriage:    async () => { calls++; return { action: 'wait', nextCheckInMs: 0 }; },
    enqueueOutboxFn: async () => ({ id: 'x', deduped: false }),
    now:             fakeNow,
  };
  const first = await runOneTriageTick(args);
  assert.equal(first.reason,        'llm_said_wait');
  assert.equal(first.nextCheckInMs, 30 * 1000, 'zero must clamp up to 30s floor');
});

test('cool-down: omitted nextCheckInMs falls back to the per-tier default', async () => {
  freshLoop();
  const fakeNow = (() => { let t = 1_000_000; return () => t; })();
  const r = await runOneTriageTick({
    getThreat:       async () => ({ tier: 'moderate', weight: 3 }),
    getLastActivity: async () => ({ ts: '...', ms: 0 }),
    decideTriage:    async () => ({ action: 'wait' }),     // no nextCheckInMs
    enqueueOutboxFn: async () => ({ id: 'x', deduped: false }),
    now:             fakeNow,
  });
  // Moderate default = 1 hour
  assert.equal(r.nextCheckInMs, 60 * 60_000);
});

test('cool-down: a tier RISE preempts the wait — severe escalation reaches the LLM immediately', async () => {
  freshLoop();
  let tier = 'moderate';
  let calls = 0;
  const args = {
    getThreat:       async () => ({ tier, weight: 3 }),
    getLastActivity: async () => ({ ts: '...', ms: Date.now() - 60 * 60_000 }),
    decideTriage:    async () => { calls++; return { action: 'wait', nextCheckInMs: 60 * 60_000 }; },
    enqueueOutboxFn: async () => ({ id: 'x', deduped: false }),
  };
  // First tick at moderate: LLM called, says wait an hour.
  await runOneTriageTick(args);
  assert.equal(calls, 1);

  // While still in cooldown, threat tier RISES to severe — must
  // preempt the cooldown and re-deliberate.
  tier = 'severe';
  await runOneTriageTick(args);
  assert.equal(calls, 2, 'tier rise should preempt cooldown');
});

test('cool-down: tier FALL does not preempt — calmer state should not waste a token', async () => {
  freshLoop();
  let tier = 'severe';
  let calls = 0;
  const args = {
    getThreat:       async () => ({ tier, weight: 9 }),
    getLastActivity: async () => ({ ts: '...', ms: Date.now() - 60 * 60_000 }),
    decideTriage:    async () => { calls++; return { action: 'wait', nextCheckInMs: 15 * 60_000 }; },
    enqueueOutboxFn: async () => ({ id: 'x', deduped: false }),
  };
  await runOneTriageTick(args);
  assert.equal(calls, 1);
  tier = 'moderate';        // dropped
  const r = await runOneTriageTick(args);
  assert.equal(r.reason, 'in_cooldown');
  assert.equal(calls,    1);
});

test('resetTriageCooldown: clears the wait so the next tick will call the LLM', async () => {
  freshLoop();
  let calls = 0;
  const args = {
    getThreat:       async () => ({ tier: 'high', weight: 5 }),
    getLastActivity: async () => ({ ts: '...', ms: Date.now() - 60 * 60_000 }),
    decideTriage:    async () => { calls++; return { action: 'wait', nextCheckInMs: 60 * 60_000 }; },
    enqueueOutboxFn: async () => ({ id: 'x', deduped: false }),
  };
  await runOneTriageTick(args);
  await runOneTriageTick(args);
  assert.equal(calls, 1, 'second was in cool-down');
  resetTriageCooldown();
  await runOneTriageTick(args);
  assert.equal(calls, 2, 'reset re-enables immediate deliberation');
});
