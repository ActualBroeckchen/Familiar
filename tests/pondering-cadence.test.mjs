import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRequiredInterval,
  tierForWeight,
  PONDER_INTERVAL_MS,
  PONDER_TIER_LABEL,
} from '../pondering-cadence.js';

test('computeRequiredInterval: zero / negative / non-finite → Infinity (don\'t ponder)', () => {
  assert.equal(computeRequiredInterval(0),         Infinity);
  assert.equal(computeRequiredInterval(-1),        Infinity);
  assert.equal(computeRequiredInterval(NaN),       Infinity);
  assert.equal(computeRequiredInterval(Infinity),  Infinity);
  assert.equal(computeRequiredInterval(undefined), Infinity);
  assert.equal(computeRequiredInterval(null),      Infinity);
});

test('computeRequiredInterval: tier boundaries', () => {
  // idle: 0 < w < 2
  assert.equal(computeRequiredInterval(0.5), PONDER_INTERVAL_MS.idle);
  assert.equal(computeRequiredInterval(1.99), PONDER_INTERVAL_MS.idle);
  // low: 2 <= w < 4
  assert.equal(computeRequiredInterval(2),   PONDER_INTERVAL_MS.low);
  assert.equal(computeRequiredInterval(3.99), PONDER_INTERVAL_MS.low);
  // mid: 4 <= w < 8
  assert.equal(computeRequiredInterval(4),   PONDER_INTERVAL_MS.mid);
  assert.equal(computeRequiredInterval(7.99), PONDER_INTERVAL_MS.mid);
  // high: w >= 8
  assert.equal(computeRequiredInterval(8),   PONDER_INTERVAL_MS.high);
  assert.equal(computeRequiredInterval(100), PONDER_INTERVAL_MS.high);
});

test('computeRequiredInterval: monotonic non-increasing as weight rises', () => {
  // Higher weight should NEVER give a longer interval.
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

test('PONDER_INTERVAL_MS is frozen (tuning happens in source, not at runtime)', () => {
  assert.throws(() => { PONDER_INTERVAL_MS.high = 1; }, TypeError);
});
