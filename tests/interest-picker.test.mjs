import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickInterest } from '../interest-picker.js';

// Tiny linear-congruential rng so the weighted-distribution tests are
// deterministic. Not for production use; only here so the sampling
// assertions don't flake.
function seededRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('pickInterest returns null for empty / nullish input', () => {
  assert.equal(pickInterest([]),        null);
  assert.equal(pickInterest(undefined), null);
  assert.equal(pickInterest(null),      null);
});

test('pickInterest returns null when nothing is eligible', () => {
  assert.equal(pickInterest([
    { label: 'zero',     weight: 0 },
    { label: 'negative', weight: -3 },
    { label: 'nan',      weight: NaN },
    { label: 'infinite', weight: Infinity },
    { label: '',         weight: 5 },           // empty label
    { label: '   ',      weight: 5 },           // whitespace-only label
    { weight: 5 },                              // no label
    null,
    'not an object',
  ]), null);
});

test('pickInterest with a single eligible candidate always picks it', () => {
  const rng = seededRng(42);
  const interests = [
    { label: 'lonely',    weight: 5 },
    { label: 'ineligible', weight: 0 },
    { label: '',           weight: 10 },
  ];
  for (let i = 0; i < 50; i++) {
    assert.equal(pickInterest(interests, { rng }).label, 'lonely');
  }
});

test('pickInterest biases toward higher weight (1:9 weighted → ~10% / ~90% over many samples)', () => {
  const interests = [
    { label: 'rare',   weight: 1 },
    { label: 'common', weight: 9 },
  ];
  const rng = seededRng(7);
  const counts = { rare: 0, common: 0 };
  const N = 10_000;
  for (let i = 0; i < N; i++) {
    counts[pickInterest(interests, { rng }).label]++;
  }
  const rarePct = (counts.rare / N) * 100;
  // Expect ~10%. Wide tolerance (8-12%) so the test isn't flaky.
  assert.ok(rarePct > 8 && rarePct < 12,
    `expected rare ~10%, got ${rarePct.toFixed(2)}% (rare=${counts.rare}, common=${counts.common})`);
});

test('pickInterest never picks ineligible entries even when they look enticing', () => {
  const interests = [
    { label: 'good-low',  weight: 0.5 },
    { label: 'huge-zero', weight: 0 },          // would dominate if not filtered
    { label: 'good-mid',  weight: 1.5 },
    { label: '',          weight: 100 },        // would dominate if not filtered
  ];
  const rng = seededRng(123);
  const labels = new Set();
  for (let i = 0; i < 500; i++) {
    labels.add(pickInterest(interests, { rng }).label);
  }
  assert.deepEqual(labels, new Set(['good-low', 'good-mid']));
});

test('pickInterest preserves the full interest object on the pick', () => {
  const interest = { id: 'abc', label: 'preserve me', weight: 3, tier: 'live_interest', payload: { x: 1 } };
  const got = pickInterest([interest]);
  assert.equal(got, interest, 'picker should return the original object reference');
});
