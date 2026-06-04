import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRequiredInterval,
  tierForWeight,
  PONDER_INTERVAL_MS,
  PONDER_TIER_LABEL,
  THREAT_CADENCE_MULTIPLIER,
} from '../pondering-cadence.js';

test('computeRequiredInterval: zero / negative / non-finite → Infinity (don\'t ponder)', () => {
  assert.equal(computeRequiredInterval(0),         Infinity);
  assert.equal(computeRequiredInterval(-1),        Infinity);
  assert.equal(computeRequiredInterval(NaN),       Infinity);
  assert.equal(computeRequiredInterval(Infinity),  Infinity);
  assert.equal(computeRequiredInterval(undefined), Infinity);
  assert.equal(computeRequiredInterval(null),      Infinity);
});

test('computeRequiredInterval: tier boundaries with no threat', () => {
  assert.equal(computeRequiredInterval(0.5), PONDER_INTERVAL_MS.idle);
  assert.equal(computeRequiredInterval(1.99), PONDER_INTERVAL_MS.idle);
  assert.equal(computeRequiredInterval(2),   PONDER_INTERVAL_MS.low);
  assert.equal(computeRequiredInterval(3.99), PONDER_INTERVAL_MS.low);
  assert.equal(computeRequiredInterval(4),   PONDER_INTERVAL_MS.mid);
  assert.equal(computeRequiredInterval(7.99), PONDER_INTERVAL_MS.mid);
  assert.equal(computeRequiredInterval(8),   PONDER_INTERVAL_MS.high);
  assert.equal(computeRequiredInterval(100), PONDER_INTERVAL_MS.high);
});

test('computeRequiredInterval: monotonic non-increasing as weight rises', () => {
  const samples = [0.1, 1, 2, 3, 4, 5, 6, 7, 8, 12, 50];
  for (let i = 1; i < samples.length; i++) {
    assert.ok(
      computeRequiredInterval(samples[i]) <= computeRequiredInterval(samples[i - 1]),
      `interval rose between weight ${samples[i - 1]} and ${samples[i]}`,
    );
  }
});

test('tierForWeight: labels match each interval band', () => {
  assert.equal(tierForWeight(0),    PONDER_TIER_LABEL.none);
  assert.equal(tierForWeight(0.5),  PONDER_TIER_LABEL.idle);
  assert.equal(tierForWeight(2),    PONDER_TIER_LABEL.low);
  assert.equal(tierForWeight(5),    PONDER_TIER_LABEL.mid);
  assert.equal(tierForWeight(8),    PONDER_TIER_LABEL.high);
  assert.equal(tierForWeight(100),  PONDER_TIER_LABEL.high);
});

// ── Threat-aware cadence (step 4b) ──────────────────────────────

test('computeRequiredInterval: threat shortens the interval (calm=1.0×, severe=0.15×)', () => {
  const baseHigh = PONDER_INTERVAL_MS.high;
  assert.equal(computeRequiredInterval(10, 0),    baseHigh);
  // mild: 0.8×
  assert.equal(computeRequiredInterval(10, 0.5),  Math.round(baseHigh * 0.80));
  assert.equal(computeRequiredInterval(10, 1),    Math.round(baseHigh * 0.80));
  // moderate: 0.5×
  assert.equal(computeRequiredInterval(10, 2),    Math.round(baseHigh * 0.50));
  assert.equal(computeRequiredInterval(10, 3.99), Math.round(baseHigh * 0.50));
  // high: 0.3×
  assert.equal(computeRequiredInterval(10, 4),    Math.round(baseHigh * 0.30));
  assert.equal(computeRequiredInterval(10, 6.99), Math.round(baseHigh * 0.30));
  // severe: 0.15×
  assert.equal(computeRequiredInterval(10, 7),    Math.round(baseHigh * 0.15));
  assert.equal(computeRequiredInterval(10, 999),  Math.round(baseHigh * 0.15));
});

test('computeRequiredInterval: no interests → Infinity regardless of threat', () => {
  assert.equal(computeRequiredInterval(0, 9), Infinity);
  assert.equal(computeRequiredInterval(0, 4), Infinity);
});

test('computeRequiredInterval: same threat tier applies same multiplier across interest tiers', () => {
  // Severe threat (0.15×) should produce the same RATIO across all interest tiers.
  const tiers = [PONDER_INTERVAL_MS.high, PONDER_INTERVAL_MS.mid, PONDER_INTERVAL_MS.low, PONDER_INTERVAL_MS.idle];
  const weights = [10, 5, 2.5, 1];
  for (let i = 0; i < weights.length; i++) {
    assert.equal(computeRequiredInterval(weights[i], 8), Math.round(tiers[i] * 0.15));
  }
});

test('THREAT_CADENCE_MULTIPLIER is frozen', () => {
  assert.throws(() => { THREAT_CADENCE_MULTIPLIER.calm = 0; }, TypeError);
});

test('PONDER_INTERVAL_MS is frozen', () => {
  assert.throws(() => { PONDER_INTERVAL_MS.high = 1; }, TypeError);
});

// ── User-set interval scale (≥1× only — stretches, never speeds up) ──

test('computeRequiredInterval: scale=1 → unchanged from default', () => {
  assert.equal(computeRequiredInterval(10, 0, { scale: 1 }), PONDER_INTERVAL_MS.high);
  assert.equal(computeRequiredInterval(5,  0, { scale: 1 }), PONDER_INTERVAL_MS.mid);
});

test('computeRequiredInterval: scale=2 → doubles the interval', () => {
  assert.equal(computeRequiredInterval(10, 0, { scale: 2 }), PONDER_INTERVAL_MS.high * 2);
  assert.equal(computeRequiredInterval(5,  0, { scale: 2 }), PONDER_INTERVAL_MS.mid * 2);
});

test('computeRequiredInterval: scale composes with threat multiplier', () => {
  // severe (0.15×) AND 2× user scale → net 0.30× — same as plain high threat.
  assert.equal(
    computeRequiredInterval(10, 8, { scale: 2 }),
    Math.round(PONDER_INTERVAL_MS.high * 0.15 * 2),
  );
});

test('computeRequiredInterval: scale<1 is clamped to 1 (UI only allows ≥1×)', () => {
  // Even if a stale settings file somehow passes 0.5, we don\'t let
  // the system ponder MORE often than the tier defaults.
  assert.equal(computeRequiredInterval(10, 0, { scale: 0.5 }),  PONDER_INTERVAL_MS.high);
  assert.equal(computeRequiredInterval(10, 0, { scale: -1 }),   PONDER_INTERVAL_MS.high);
  assert.equal(computeRequiredInterval(10, 0, { scale: NaN }),  PONDER_INTERVAL_MS.high);
});

test('computeRequiredInterval: no scale option → backward compat (=1×)', () => {
  assert.equal(computeRequiredInterval(10),       PONDER_INTERVAL_MS.high);
  assert.equal(computeRequiredInterval(10, 0),    PONDER_INTERVAL_MS.high);
});
