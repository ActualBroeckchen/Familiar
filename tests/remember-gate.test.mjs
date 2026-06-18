import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateForCategory, resolveRememberGate } from '../memorization.js';

// ── gateForCategory: single-category resolution against one map ───────────────

test('gateForCategory: null map → basics stored freely, sensitive asks', () => {
  assert.equal(gateForCategory('basics', null), 'true');
  assert.equal(gateForCategory('health_info', null), 'ask');
  assert.equal(gateForCategory('emotional_content', null), 'ask');
  assert.equal(gateForCategory('relationships', null), 'ask');
  assert.equal(gateForCategory('whereabouts', null), 'ask');
});

test('gateForCategory: explicit map values are honored', () => {
  const m = { basics: true, health_info: false, emotional_content: 'ask', whereabouts: true };
  assert.equal(gateForCategory('basics', m), 'true');
  assert.equal(gateForCategory('health_info', m), 'false');
  assert.equal(gateForCategory('emotional_content', m), 'ask');
  assert.equal(gateForCategory('whereabouts', m), 'true');
});

test('gateForCategory: category absent from a present map falls back to defaults', () => {
  const m = { basics: true }; // health_info unset
  assert.equal(gateForCategory('health_info', m), 'ask');
  assert.equal(gateForCategory('basics', m), 'true');
});

// ── resolveRememberGate: ward-vs-villager selection ──────────────────────────

test('resolveRememberGate: no villager subject → ward map gates (self-fact)', () => {
  // This is the gap that was being missed: a fact about the human with no
  // matched villager must be gated by the ward map, not stored freely.
  const ward = { basics: true, health_info: 'ask', emotional_content: false };
  assert.equal(resolveRememberGate('basics', [], ward), 'true');
  assert.equal(resolveRememberGate('health_info', [], ward), 'ask');
  assert.equal(resolveRememberGate('emotional_content', [], ward), 'false');
});

test('resolveRememberGate: no villager + null ward map → shared defaults', () => {
  assert.equal(resolveRememberGate('basics', [], null), 'true');
  assert.equal(resolveRememberGate('health_info', [], null), 'ask');
});

test('resolveRememberGate: single villager subject uses that villager map, not ward', () => {
  const ward = { health_info: false };
  const villager = { remember: { health_info: true } };
  // Villager subject present → ward map must NOT apply.
  assert.equal(resolveRememberGate('health_info', [villager], ward), 'true');
});

test('resolveRememberGate: most restrictive villager wins (false beats ask beats true)', () => {
  const a = { remember: { health_info: true } };
  const b = { remember: { health_info: 'ask' } };
  const c = { remember: { health_info: false } };
  assert.equal(resolveRememberGate('health_info', [a, b], null), 'ask');
  assert.equal(resolveRememberGate('health_info', [a, b, c], null), 'false');
  assert.equal(resolveRememberGate('health_info', [a], null), 'true');
});

test('resolveRememberGate: villager with no remember map uses category defaults', () => {
  const v = {}; // no remember field
  assert.equal(resolveRememberGate('basics', [v], null), 'true');
  assert.equal(resolveRememberGate('health_info', [v], null), 'ask');
});
