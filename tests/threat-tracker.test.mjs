import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { mkdtempSync, rmSync, promises as fsp } from 'fs';

import {
  getThreat,
  recordThreat,
  resetThreat,
  getThreatHistory,
  effectiveWeight,
  tierForThreat,
  MAX_RAW_WEIGHT,
  HISTORY_CAP,
} from '../threat-tracker.js';

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'threat-test-'));
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

// ── tierForThreat ────────────────────────────────────────────────

test('tierForThreat: tier boundaries', () => {
  assert.equal(tierForThreat(0),    'calm');
  assert.equal(tierForThreat(-1),   'calm');
  assert.equal(tierForThreat(NaN),  'calm');
  assert.equal(tierForThreat(0.5),  'mild');
  assert.equal(tierForThreat(1.9),  'mild');
  assert.equal(tierForThreat(2),    'moderate');
  assert.equal(tierForThreat(3.9),  'moderate');
  assert.equal(tierForThreat(4),    'high');
  assert.equal(tierForThreat(6.9),  'high');
  assert.equal(tierForThreat(7),    'severe');
  assert.equal(tierForThreat(100),  'severe');
});

// ── effectiveWeight ──────────────────────────────────────────────

test('effectiveWeight: zero / no-touch → 0', () => {
  assert.equal(effectiveWeight(0,   null,                 { now: 0 }),                    0);
  assert.equal(effectiveWeight(-1,  '2026-05-30T00:00:00Z', { now: 0 }),                    0);
  assert.equal(effectiveWeight(5,   null,                 { now: 0 }),                    5);
});

test('effectiveWeight: no decay when now == last_touched', () => {
  const ts  = '2026-05-30T12:00:00Z';
  const now = Date.parse(ts);
  assert.equal(effectiveWeight(8, ts, { now }), 8);
});

test('effectiveWeight: half-life behaviour (tau=3 days → half after 3 days, quarter after 6)', () => {
  const last = '2026-05-30T00:00:00Z';
  const lastMs = Date.parse(last);
  const day = 24 * 60 * 60 * 1000;
  // 3 days later → half (within tolerance)
  const w3 = effectiveWeight(8, last, { now: lastMs + 3 * day });
  assert.ok(Math.abs(w3 - 4) < 0.01, `expected ~4 after 3 days, got ${w3}`);
  // 6 days later → quarter
  const w6 = effectiveWeight(8, last, { now: lastMs + 6 * day });
  assert.ok(Math.abs(w6 - 2) < 0.01, `expected ~2 after 6 days, got ${w6}`);
});

// ── recordThreat / getThreat round-trip ──────────────────────────

test('recordThreat then getThreat → state persists, decays on read', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const t0 = Date.parse('2026-05-30T12:00:00Z');
    const r  = await recordThreat({ delta: 4, source: 'test', tomesDir: dir, now: t0 });
    assert.equal(r.ok, true);
    assert.equal(r.weight, 4);
    assert.equal(r.tier,   'high');

    // Read at t0 → still 4
    const same = await getThreat({ tomesDir: dir, now: t0 });
    assert.equal(same.weight,     4);
    assert.equal(same.raw_weight, 4);
    assert.equal(same.tier,       'high');

    // Read 3 days later → half (~2 → moderate)
    const day = 24 * 60 * 60 * 1000;
    const later = await getThreat({ tomesDir: dir, now: t0 + 3 * day });
    assert.ok(Math.abs(later.weight - 2) < 0.05, `expected ~2 after 3 days, got ${later.weight}`);
    assert.equal(later.tier, 'moderate');
    // raw is unchanged on read
    assert.equal(later.raw_weight, 4);
  } finally { cleanup(); }
});

test('recordThreat: caps at MAX_RAW_WEIGHT', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const r = await recordThreat({ delta: 999, source: 'test', tomesDir: dir });
    assert.equal(r.weight, MAX_RAW_WEIGHT);
  } finally { cleanup(); }
});

test('recordThreat: floors at zero (a big negative delta won\'t go negative)', async () => {
  const { dir, cleanup } = tempDir();
  try {
    await recordThreat({ delta: 3, tomesDir: dir });
    const r = await recordThreat({ delta: -999, tomesDir: dir });
    assert.equal(r.weight, 0);
    assert.equal(r.tier,   'calm');
  } finally { cleanup(); }
});

test('recordThreat: decays current value before adding delta', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const t0  = Date.parse('2026-05-30T12:00:00Z');
    const day = 24 * 60 * 60 * 1000;
    // 1) Set to 8 at t0
    await recordThreat({ delta: 8, source: 'test', tomesDir: dir, now: t0 });
    // 2) 3 days later, add 0 — should produce ~4 (after decay) not 8
    const r = await recordThreat({ delta: 0.001, source: 'test', tomesDir: dir, now: t0 + 3 * day });
    // (decay 8 → 4, then +0.001)
    assert.ok(Math.abs(r.weight - 4) < 0.05, `expected ~4 after decay+0, got ${r.weight}`);
  } finally { cleanup(); }
});

test('recordThreat: rejects non-finite delta', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const r = await recordThreat({ delta: NaN, tomesDir: dir });
    assert.equal(r.ok, false);
  } finally { cleanup(); }
});

// ── resetThreat ──────────────────────────────────────────────────

test('resetThreat: zeroes the weight and logs an audit entry', async () => {
  const { dir, cleanup } = tempDir();
  try {
    await recordThreat({ delta: 5, tomesDir: dir });
    const r = await resetThreat({ tomesDir: dir });
    assert.equal(r.ok, true);
    assert.equal(r.weight, 0);
    const after = await getThreat({ tomesDir: dir });
    assert.equal(after.weight, 0);
    const hist = await getThreatHistory({ tomesDir: dir });
    assert.ok(hist.some(h => h.source === 'manual_reset'));
  } finally { cleanup(); }
});

// ── History ──────────────────────────────────────────────────────

test('history: capped to HISTORY_CAP (FIFO)', async () => {
  const { dir, cleanup } = tempDir();
  try {
    // Record HISTORY_CAP + 10 small bumps
    for (let i = 0; i < HISTORY_CAP + 10; i++) {
      await recordThreat({ delta: 0.01, source: `t${i}`, tomesDir: dir });
    }
    const hist = await getThreatHistory({ tomesDir: dir, limit: HISTORY_CAP + 20 });
    assert.equal(hist.length, HISTORY_CAP);
    // Newest first: t<HISTORY_CAP+9> should be at top
    assert.equal(hist[0].source, `t${HISTORY_CAP + 9}`);
    // Oldest of what's left should be t10 (first 10 fell off the FIFO)
    assert.equal(hist[hist.length - 1].source, 't10');
  } finally { cleanup(); }
});

test('history: empty on fresh state', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const hist = await getThreatHistory({ tomesDir: dir });
    assert.deepEqual(hist, []);
  } finally { cleanup(); }
});

// ── Disabled mode ────────────────────────────────────────────────

test('disabled: PROTO_FAMILIAR_THREAT_DISABLED=1 → record no-ops, get returns calm', async () => {
  const { dir, cleanup } = tempDir();
  const original = process.env.PROTO_FAMILIAR_THREAT_DISABLED;
  try {
    process.env.PROTO_FAMILIAR_THREAT_DISABLED = '1';
    const r = await recordThreat({ delta: 5, tomesDir: dir });
    assert.equal(r.disabled, true);
    assert.equal(r.weight,   0);
    const g = await getThreat({ tomesDir: dir });
    assert.equal(g.disabled, true);
    assert.equal(g.weight,   0);
    assert.equal(g.tier,     'calm');
    // No state file should have been written.
    await assert.rejects(fsp.stat(path.join(dir, '.threat-state.json')));
  } finally {
    if (original === undefined) delete process.env.PROTO_FAMILIAR_THREAT_DISABLED;
    else                         process.env.PROTO_FAMILIAR_THREAT_DISABLED = original;
    cleanup();
  }
});

test('disabled: resetThreat still works (always-on user control)', async () => {
  const { dir, cleanup } = tempDir();
  const original = process.env.PROTO_FAMILIAR_THREAT_DISABLED;
  try {
    // First, with detector enabled, accumulate some threat
    delete process.env.PROTO_FAMILIAR_THREAT_DISABLED;
    await recordThreat({ delta: 5, tomesDir: dir });
    // Now disable, then reset — reset must succeed regardless
    process.env.PROTO_FAMILIAR_THREAT_DISABLED = '1';
    const r = await resetThreat({ tomesDir: dir });
    assert.equal(r.ok,     true);
    assert.equal(r.weight, 0);
  } finally {
    if (original === undefined) delete process.env.PROTO_FAMILIAR_THREAT_DISABLED;
    else                         process.env.PROTO_FAMILIAR_THREAT_DISABLED = original;
    cleanup();
  }
});

// ── Concurrency safety ───────────────────────────────────────────

test('concurrent recordThreat calls don\'t clobber each other (serialized via lock)', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const N = 10;
    await Promise.all(Array.from({ length: N }, () =>
      recordThreat({ delta: 0.5, tomesDir: dir }),
    ));
    const r = await getThreat({ tomesDir: dir });
    // 10 bumps of 0.5 = 5.0 exactly (capped at MAX_RAW_WEIGHT)
    assert.ok(Math.abs(r.weight - 5.0) < 0.001, `expected exactly 5.0 after 10x0.5, got ${r.weight}`);
    const hist = await getThreatHistory({ tomesDir: dir });
    assert.equal(hist.length, N);
  } finally { cleanup(); }
});
