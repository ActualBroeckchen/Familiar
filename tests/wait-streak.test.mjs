// Wait-streak (initiative-build-spec Pass 1) — the ward's experiment.
// Invariants W1–W6 from the spec, each pinned here or noted where pinned.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import {
  getWaitStreak,
  recordWait,
  recordProactive,
  formatWaitStreakLine,
  buildWaitStreakLine,
  isWaitStreakEnabled,
  PROACTIVE_KIND_PHRASES,
} from '../src/safety/wait-streak.js';
import { runOneTriageTick, resetTriageCooldown } from '../src/safety/silence-triage-loop.js';
import { runOneReachoutTick, resetReachoutCooldown } from '../src/warmth/reachout-loop.js';
import { buildReachoutPrompt } from '../src/warmth/reachout.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wait-streak-'));
  delete process.env.PROTO_FAMILIAR_WAIT_STREAK_DISABLED;
  resetTriageCooldown();
  resetReachoutCooldown();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  // Leave the suite the way the other loop tests expect it: recording off.
  process.env.PROTO_FAMILIAR_WAIT_STREAK_DISABLED = '1';
});

// Enabled without touching the real settings.json.
const ON = { waitStreakEnabled: true };

// ── Counter semantics ────────────────────────────────────────────────

test('recordWait increments count and the per-source tally', async () => {
  await recordWait('warmth', { tomesDir: dir, settings: ON });
  await recordWait('warmth', { tomesDir: dir, settings: ON });
  await recordWait('triage', { tomesDir: dir, settings: ON });
  const s = getWaitStreak({ tomesDir: dir });
  assert.equal(s.count, 3);
  assert.deepEqual(s.tallies, { warmth: 2, triage: 1 });
  assert.ok(s.lastWaitAt);
});

test('recordProactive resets count, stamps kind and time; tallies stay cumulative', async () => {
  await recordWait('warmth', { tomesDir: dir, settings: ON });
  await recordWait('discord-defer', { tomesDir: dir, settings: ON });
  const t0 = Date.parse('2026-07-10T12:00:00Z');
  await recordProactive('warmth', { tomesDir: dir, now: t0, settings: ON });
  const s = getWaitStreak({ tomesDir: dir, now: t0 + 3600_000 });
  assert.equal(s.count, 0);
  assert.equal(s.lastProactiveKind, 'warmth');
  assert.equal(s.sinceMs, 3600_000, 'sinceMs is code-computed');
  assert.deepEqual(s.tallies, { warmth: 1, 'discord-defer': 1 }, 'analysis tallies survive the reset');
});

// W4 — only proactive acts reset. Waiting after a reset re-accumulates;
// nothing else (in particular not the ward speaking — the chat path calls
// last-activity.js, which has no import of this module; asserted below by
// the absence of any other writer).
test('W4: waits never reset; only recordProactive does', async () => {
  for (let i = 0; i < 5; i++) await recordWait('warmth', { tomesDir: dir, settings: ON });
  assert.equal(getWaitStreak({ tomesDir: dir }).count, 5);
  await recordProactive('triage', { tomesDir: dir, settings: ON });
  assert.equal(getWaitStreak({ tomesDir: dir }).count, 0);
  await recordWait('tell-snooze', { tomesDir: dir, settings: ON });
  assert.equal(getWaitStreak({ tomesDir: dir }).count, 1);
});

// ── W2 — the verbatim lines, and nothing editorial ───────────────────

test('W2: verbatim line — prior proactive act on record, count > 0', async () => {
  const now = Date.parse('2026-07-10T12:00:00Z');
  const state = {
    count: 41,
    lastProactiveAt: new Date(now - 2 * 3600_000).toISOString(),
    lastProactiveKind: 'warmth',
  };
  assert.equal(
    formatWaitStreakLine(state, now),
    '- Since my last proactive reach-out (2 hours ago, a warm reach-out), I have chosen to wait 41 time(s) when given this choice.',
  );
});

test('W2: verbatim line — no proactive act on record', () => {
  const line = formatWaitStreakLine({ count: 7, lastProactiveAt: null, lastProactiveKind: null }, Date.now());
  assert.equal(line, '- I have no proactive reach-out on record; since tracking began I have chosen to wait 7 time(s) when given this choice.');
});

test('W2: verbatim line — immediately after a reset (count 0)', () => {
  const now = Date.parse('2026-07-10T12:00:00Z');
  const state = { count: 0, lastProactiveAt: new Date(now - 30 * 60_000).toISOString(), lastProactiveKind: 'triage' };
  assert.equal(
    formatWaitStreakLine(state, now),
    '- My last proactive reach-out was 30 minutes ago (a check-in); I have not waited since.',
  );
});

test('W2: every kind renders plainly; no editorializing tokens in any shape', () => {
  const now = Date.now();
  const shapes = [
    { count: 0,  lastProactiveAt: null, lastProactiveKind: null },
    { count: 12, lastProactiveAt: null, lastProactiveKind: null },
  ];
  for (const kind of Object.keys(PROACTIVE_KIND_PHRASES)) {
    shapes.push({ count: 0, lastProactiveAt: new Date(now - 60_000).toISOString(), lastProactiveKind: kind });
    shapes.push({ count: 3, lastProactiveAt: new Date(now - 86_400_000).toISOString(), lastProactiveKind: kind });
  }
  for (const s of shapes) {
    const line = formatWaitStreakLine(s, now);
    assert.ok(line.startsWith('- '), line);
    // The experiment contract: a bare fact, no advice, no evaluation.
    assert.doesNotMatch(line, /consider|should|maybe it's time|overdue|too (long|many)|only|already/i, line);
  }
});

// ── W3 — off means OFF: no line, no recording, byte-identical prompts ─

test('W3: env kill switch — no line, and recording is a no-op', async () => {
  process.env.PROTO_FAMILIAR_WAIT_STREAK_DISABLED = '1';
  assert.equal(isWaitStreakEnabled(ON), false, 'env wins over settings');
  assert.equal(buildWaitStreakLine({ tomesDir: dir, settings: ON }), '');
  const r = await recordWait('warmth', { tomesDir: dir, settings: ON });
  assert.equal(r.disabled, true);
  assert.equal(existsSync(path.join(dir, '.wait-streak.json')), false, 'no state file written');
  delete process.env.PROTO_FAMILIAR_WAIT_STREAK_DISABLED;
});

test('W3: settings waitStreakEnabled:false — fully off; default is ON', async () => {
  assert.equal(isWaitStreakEnabled({ waitStreakEnabled: false }), false);
  assert.equal(buildWaitStreakLine({ tomesDir: dir, settings: { waitStreakEnabled: false } }), '');
  assert.equal(isWaitStreakEnabled({}), true, 'unset defaults ON');
});

test('W3: buildReachoutPrompt is byte-identical with the feature off', () => {
  const args = {
    nowBlock: '[Now] test', identityContext: 'I am someone.', sessionBlock: '',
    pendingTells: [], warmVillagers: [], wardSilencePhrase: '2 hours',
  };
  const off      = buildReachoutPrompt({ ...args, waitStreakLine: '' });
  const baseline = buildReachoutPrompt(args); // param omitted = pre-feature shape
  assert.equal(off, baseline);
  const on = buildReachoutPrompt({ ...args, waitStreakLine: formatWaitStreakLine({ count: 3, lastProactiveAt: null }, Date.now()) });
  assert.notEqual(on, baseline);
  assert.match(on, /chosen to wait 3 time\(s\)/);
});

// ── W5 — a poisoned state file changes no outcome ────────────────────

test('W5: corrupt state reads as zero and never throws; recording heals it', async () => {
  writeFileSync(path.join(dir, '.wait-streak.json'), '{{{ not json', 'utf8');
  const s = getWaitStreak({ tomesDir: dir });
  assert.equal(s.count, 0);
  assert.equal(s.lastProactiveAt, null);
  assert.equal(formatWaitStreakLine(s, Date.now()).includes('0 time(s)'), true);
  const r = await recordWait('warmth', { tomesDir: dir, settings: ON });
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(readFileSync(path.join(dir, '.wait-streak.json'), 'utf8')).count, 1);
});

test('W5: a throwing streak reader cannot change a triage outcome', async () => {
  const enqueued = [];
  const r = await runOneTriageTick({
    getThreat:       async () => ({ tier: 'high', weight: 5 }),
    getLastActivity: async () => ({ ts: '...', ms: Date.now() - 3600_000 }),
    decideTriage:    async () => ({ action: 'reach_out', message: 'hey' }),
    enqueueOutboxFn: async (i) => { enqueued.push(i); return { id: 'x', deduped: false }; },
    getWaitStreakFn:   () => { throw new Error('poisoned'); },
    recordWaitFn:      async () => { throw new Error('poisoned'); },
    recordProactiveFn: async () => { throw new Error('poisoned'); },
  });
  assert.equal(r.acted, true, 'triage still reaches out');
  assert.equal(enqueued.length, 1);
  assert.equal(r.streakAtDecision, null);
});

// ── W1 — gate-skipped ticks never record (never offered the choice) ──

test('W1: triage gates (low tier, cooldown, no activity) never record', async () => {
  const waits = [];
  const base = {
    getLastActivity: async () => ({ ts: '...', ms: Date.now() - 3600_000 }),
    decideTriage:    async () => ({ action: 'wait', nextCheckInMs: 3600_000 }),
    enqueueOutboxFn: async () => ({ id: 'x', deduped: false }),
    recordWaitFn:      async (src) => { waits.push(src); },
    recordProactiveFn: async () => { waits.push('proactive'); },
  };
  // calm tier gate
  let r = await runOneTriageTick({ ...base, getThreat: async () => ({ tier: 'calm', weight: 0 }) });
  assert.equal(r.reason, 'low_threat');
  // no-activity gate
  r = await runOneTriageTick({ ...base, getThreat: async () => ({ tier: 'high', weight: 5 }), getLastActivity: async () => null });
  assert.equal(r.reason, 'no_activity_record');
  assert.deepEqual(waits, [], 'no recording before a deliberation happened');
  // One real deliberation (records once), then the cooldown gate (records nothing).
  r = await runOneTriageTick({ ...base, getThreat: async () => ({ tier: 'high', weight: 5 }) });
  assert.equal(r.reason, 'llm_said_wait');
  r = await runOneTriageTick({ ...base, getThreat: async () => ({ tier: 'high', weight: 5 }) });
  assert.equal(r.reason, 'in_cooldown');
  assert.deepEqual(waits, ['triage'], 'exactly one wait recorded, none from the gated tick');
});

test('W1: warmth gates (crisis-defer, quiet hours, cooldown) never record', async () => {
  const calls = [];
  const base = {
    getThreat:        async () => ({ tier: 'calm', weight: 0, disabled: false }),
    getLastActivity:  async () => ({ ts: '...', ms: Date.now() - 3 * 3600_000 }),
    getPendingTells:  async () => [],
    getWarmVillagers: async () => [],
    isQuietHours:     async () => false,
    decideReachout:   async () => ({ action: 'wait', nextCheckInMs: 7200_000 }),
    deliverWardKnock: async () => ({ ok: true }),
    deliverVillagerReach: async () => ({ ok: true }),
    recordWaitFn:      async (src) => { calls.push(src); },
    recordProactiveFn: async (kind) => { calls.push(`proactive:${kind}`); },
  };
  let r = await runOneReachoutTick({ ...base, getThreat: async () => ({ tier: 'severe', weight: 9, disabled: false }) });
  assert.equal(r.reason, 'crisis_defer');
  r = await runOneReachoutTick({ ...base, isQuietHours: async () => true });
  assert.equal(r.reason, 'quiet_hours');
  assert.deepEqual(calls, [], 'gated ticks are not waits — I was never asked');
  r = await runOneReachoutTick(base);
  assert.equal(r.reason, 'llm_said_wait');
  r = await runOneReachoutTick(base);
  assert.equal(r.reason, 'in_cooldown');
  assert.deepEqual(calls, ['warmth'], 'one deliberated wait, nothing from gates');
});

// ── Decision recording: increments on wait, resets on reach_out ─────

test('triage: wait increments, reach_out resets — at decision time', async () => {
  const calls = [];
  const base = {
    getThreat:       async () => ({ tier: 'high', weight: 5 }),
    getLastActivity: async () => ({ ts: '...', ms: Date.now() - 3600_000 }),
    enqueueOutboxFn: async () => ({ id: 'x', deduped: true }),   // deduped delivery…
    recordWaitFn:      async (src) => { calls.push(`wait:${src}`); },
    recordProactiveFn: async (kind) => { calls.push(`proactive:${kind}`); },
  };
  await runOneTriageTick({ ...base, decideTriage: async () => ({ action: 'wait' }) });
  resetTriageCooldown();
  await runOneTriageTick({ ...base, decideTriage: async () => ({ action: 'reach_out', message: 'hey' }) });
  // …still resets: decisions count at decision time, delivery is the outbox's concern.
  assert.deepEqual(calls, ['wait:triage', 'proactive:triage']);
});

test('warmth: reach_out to either target resets at decision time', async () => {
  const calls = [];
  const base = {
    getThreat:        async () => ({ tier: 'calm', weight: 0 }),
    getLastActivity:  async () => ({ ts: '...', ms: Date.now() - 3600_000 }),
    getPendingTells:  async () => [],
    getWarmVillagers: async () => [{ id: 'v1', name: 'Chen', discordId: '111' }],
    isQuietHours:     async () => false,
    deliverWardKnock: async () => ({ ok: true }),
    deliverVillagerReach: async () => ({ ok: false, error: 'discord down' }),   // delivery fails…
    recordWaitFn:      async (src) => { calls.push(`wait:${src}`); },
    recordProactiveFn: async (kind) => { calls.push(`proactive:${kind}`); },
  };
  await runOneReachoutTick({ ...base, decideReachout: async () => ({ action: 'reach_out', target: 'villager', villagerId: 'v1', message: 'hi' }) });
  resetReachoutCooldown();
  await runOneReachoutTick({ ...base, decideReachout: async () => ({ action: 'reach_out', target: 'ward', message: 'hey' }) });
  // …still resets both times: the decision to act happened.
  assert.deepEqual(calls, ['proactive:warmth', 'proactive:warmth']);
});

// ── W6 — the value the prompt showed rides the tick result ──────────

test('W6: streakAtDecision lands on triage and warmth deliberation results', async () => {
  const fakeStreak = () => ({ count: 17 });
  const triage = await runOneTriageTick({
    getThreat:       async () => ({ tier: 'moderate', weight: 3 }),
    getLastActivity: async () => ({ ts: '...', ms: Date.now() - 3600_000 }),
    decideTriage:    async () => ({ action: 'wait' }),
    enqueueOutboxFn: async () => ({ id: 'x', deduped: false }),
    getWaitStreakFn: fakeStreak,
    recordWaitFn:      async () => {},
    recordProactiveFn: async () => {},
  });
  assert.equal(triage.streakAtDecision, 17);

  const warmth = await runOneReachoutTick({
    getThreat:        async () => ({ tier: 'calm', weight: 0 }),
    getLastActivity:  async () => ({ ts: '...', ms: Date.now() - 3600_000 }),
    getPendingTells:  async () => [],
    getWarmVillagers: async () => [],
    isQuietHours:     async () => false,
    decideReachout:   async () => ({ action: 'wait' }),
    deliverWardKnock: async () => ({ ok: true }),
    deliverVillagerReach: async () => ({ ok: true }),
    getWaitStreakFn: fakeStreak,
    recordWaitFn:      async () => {},
    recordProactiveFn: async () => {},
  });
  assert.equal(warmth.streakAtDecision, 17);
});
