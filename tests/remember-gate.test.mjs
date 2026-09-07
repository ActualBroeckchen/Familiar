import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateForCategory, resolveRememberGate, wardStandingActive } from '../src/memory/memorization.js';

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

// ── Fictional characters: no real-world privacy → kept freely ────────────────

test('resolveRememberGate: a fictional-flagged fact is kept freely, bypassing every gate', () => {
  // A named third party normally asks; a ward "false" normally blocks.
  assert.equal(resolveRememberGate('health_info', [], null, null, { hasNamedSubjects: true }), 'ask');
  // fictional wins over both the third-party ask and an explicit ward false.
  assert.equal(resolveRememberGate('health_info', [], null, null, { hasNamedSubjects: true, fictional: true }), 'true');
  const wardBlocks = { relationships: false };
  assert.equal(resolveRememberGate('relationships', [], wardBlocks, null, { fictional: true }), 'true');
});

test('resolveRememberGate: fictional defaults false — real people are unaffected', () => {
  // No fictional flag → a named third party still asks (unchanged behaviour).
  assert.equal(resolveRememberGate('health_info', [], null, null, { hasNamedSubjects: true }), 'ask');
});

// ── Standing mutual consent: clears `ask`, never overrides `false` ───────────

test('resolveRememberGate: standing consent (both agreed) clears the ask gate', () => {
  const agreed = { remember: { health_info: 'ask' }, standingConsent: { wardAgreed: true, villagerAgreed: true } };
  assert.equal(resolveRememberGate('health_info', [agreed], null), 'true');
});

test('resolveRememberGate: standing consent requires BOTH sides', () => {
  const wardOnly     = { remember: { health_info: 'ask' }, standingConsent: { wardAgreed: true } };
  const villagerOnly = { remember: { health_info: 'ask' }, standingConsent: { villagerAgreed: true } };
  assert.equal(resolveRememberGate('health_info', [wardOnly], null), 'ask');
  assert.equal(resolveRememberGate('health_info', [villagerOnly], null), 'ask');
});

test('resolveRememberGate: standing consent never overrides an explicit false', () => {
  const blocked = { remember: { health_info: false }, standingConsent: { wardAgreed: true, villagerAgreed: true } };
  assert.equal(resolveRememberGate('health_info', [blocked], null), 'false');
});

test('resolveRememberGate: one un-agreed ask villager still forces ask', () => {
  const agreed   = { remember: { health_info: 'ask' }, standingConsent: { wardAgreed: true, villagerAgreed: true } };
  const unagreed = { remember: { health_info: 'ask' } };
  assert.equal(resolveRememberGate('health_info', [agreed, unagreed], null), 'ask');
});

// ── Ward standing consent: time-gated auto-confirm for ward-self facts ────────

test('wardStandingActive: standing window active (until > now) → true', () => {
  const now = 1000;
  const standing = { emotional_content: { until: 1500 } };
  assert.equal(wardStandingActive(standing, 'emotional_content', now), true);
});

test('wardStandingActive: standing window expired (until < now) → false', () => {
  const now = 1500;
  const standing = { emotional_content: { until: 1000 } };
  assert.equal(wardStandingActive(standing, 'emotional_content', now), false);
});

test('wardStandingActive: until === now (not >) → false', () => {
  const now = 1000;
  const standing = { emotional_content: { until: 1000 } };
  assert.equal(wardStandingActive(standing, 'emotional_content', now), false);
});

test('wardStandingActive: missing category → false', () => {
  const standing = { health_info: { until: 2000 } };
  assert.equal(wardStandingActive(standing, 'emotional_content', 1000), false);
});

test('wardStandingActive: non-number until → false', () => {
  const standing = { emotional_content: { until: 'not-a-number' } };
  assert.equal(wardStandingActive(standing, 'emotional_content', 1000), false);
});

test('wardStandingActive: null/undefined standing → false', () => {
  assert.equal(wardStandingActive(null, 'emotional_content', 1000), false);
  assert.equal(wardStandingActive(undefined, 'emotional_content', 1000), false);
});

test('wardStandingActive: uses Date.now() when nowMs omitted', () => {
  const future = Date.now() + 86400000; // 1 day from now
  const standing = { emotional_content: { until: future } };
  assert.equal(wardStandingActive(standing, 'emotional_content'), true);
});

// ── Ward standing consent applied to resolveRememberGate ────────────────────

test('resolveRememberGate: ward-self fact, ask gate, standing window active → auto-confirm true', () => {
  const ward = { emotional_content: 'ask' };
  const standing = { emotional_content: { until: Date.now() + 86400000 } }; // 1 day in future
  assert.equal(
    resolveRememberGate('emotional_content', [], ward, standing),
    'true'
  );
});

test('resolveRememberGate: ward-self fact, ask gate, standing window expired → stays ask', () => {
  const ward = { emotional_content: 'ask' };
  const standing = { emotional_content: { until: Date.now() - 1000 } }; // 1 second in past
  assert.equal(
    resolveRememberGate('emotional_content', [], ward, standing),
    'ask'
  );
});

test('resolveRememberGate: ward-self fact, false gate, standing active → stays false', () => {
  const ward = { emotional_content: false };
  const standing = { emotional_content: { until: Date.now() + 86400000 } };
  assert.equal(
    resolveRememberGate('emotional_content', [], ward, standing),
    'false'
  );
});

test('resolveRememberGate: ward-self fact, true gate, standing active → stays true', () => {
  const ward = { emotional_content: true };
  const standing = { emotional_content: { until: Date.now() + 86400000 } };
  assert.equal(
    resolveRememberGate('emotional_content', [], ward, standing),
    'true'
  );
});

test('resolveRememberGate: villager-subject fact with standing → standing ignored', () => {
  const villager = { remember: { health_info: 'ask' } };
  const standing = { health_info: { until: Date.now() + 86400000 } };
  // With villager subject, standing consent is ignored (villager path unchanged)
  assert.equal(
    resolveRememberGate('health_info', [villager], null, standing),
    'ask'
  );
});

test('resolveRememberGate: ward-self, null standing map → gate unchanged', () => {
  const ward = { emotional_content: 'ask' };
  assert.equal(
    resolveRememberGate('emotional_content', [], ward, null),
    'ask'
  );
});

// ── Source-aware consent: direct channel = implied consent ──────────────────

test('direct ward-self fact, UNSET category → implied consent (auto-true)', () => {
  // Told directly in a DM/web chat, about my human, category they never
  // configured → default 'ask' becomes 'true'. This is the flood-killer.
  assert.equal(resolveRememberGate('emotional_content', [], null, null, { direct: true }), 'true');
  assert.equal(resolveRememberGate('health_info',       [], null, null, { direct: true }), 'true');
});

test('direct does NOT override an EXPLICIT ward "ask"', () => {
  const ward = { health_info: 'ask' }; // deliberately turned on gating
  assert.equal(resolveRememberGate('health_info', [], ward, null, { direct: true }), 'ask');
});

test('direct does NOT override an explicit ward "false"', () => {
  const ward = { emotional_content: false };
  assert.equal(resolveRememberGate('emotional_content', [], ward, null, { direct: true }), 'false');
});

test('indirect (group room) ward-self fact still asks', () => {
  // Same fact heard in a shared room → direct:false → default ask stands.
  assert.equal(resolveRememberGate('emotional_content', [], null, null, { direct: false }), 'ask');
  assert.equal(resolveRememberGate('emotional_content', [], null, null), 'ask'); // default opts
});

test('third party told directly: a stranger\'s private life still asks', () => {
  // "My coworker Bob is struggling" in a DM — hasNamedSubjects, no villager
  // match → NOT swept in by implied consent.
  assert.equal(
    resolveRememberGate('health_info', [], null, null, { direct: true, hasNamedSubjects: true }),
    'ask'
  );
  assert.equal(
    resolveRememberGate('emotional_content', [], null, null, { direct: true, hasNamedSubjects: true }),
    'ask'
  );
});

test('third party basics told directly are still kept (not sensitive)', () => {
  // A named person's basic biographical fact isn't private-life gating.
  assert.equal(
    resolveRememberGate('basics', [], null, null, { direct: true, hasNamedSubjects: true }),
    'true'
  );
});

test('direct implied consent never overrides a registered villager gate', () => {
  // Third person's private life via a registered villager → their map wins,
  // regardless of the direct channel.
  const villager = { remember: { health_info: 'ask' } };
  assert.equal(
    resolveRememberGate('health_info', [villager], null, null, { direct: true, hasNamedSubjects: true }),
    'ask'
  );
});
