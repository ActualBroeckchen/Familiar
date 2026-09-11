// crisis-classifier.js — inference parity with the Python trainer, graceful
// degradation, off-switches, and the tier-asymmetric combination invariants.
// Expected scores were computed by the Python `score_head` against the same
// fixture (docs/crisis-classifier-build-spec.md), so this pins cross-language
// parity, not the JS talking to itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeForMl, tokenizeMl, scoreHead, loadArtifact, scoreMessageMl,
  combineThreat, CLASSIFIER_TUNING, scoreThreatMessage, _resetArtifactCache,
} from '../src/safety/crisis-classifier.js';
import { scoreMessage } from '../src/safety/crisis-signals.js';
import { THREAT_TIERS, tierForThreat } from '../src/safety/threat-tracker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'crisis-classifier-fixture.json');
const art = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ── normalization parity ────────────────────────────────────────────────────
test('normalizeForMl mirrors the trainer: lowercase, drop URLs/digits/punct, collapse 3+ repeats', () => {
  assert.equal(normalizeForMl("I WANT to Die!!!"), 'i want to die');
  assert.equal(normalizeForMl('check https://x.co/y now'), 'check now');
  assert.equal(normalizeForMl('dieeee'), 'diee', '3+ repeats collapse to 2 — so "dieeee" ≠ "die"');
  assert.equal(normalizeForMl("don't go"), "don't go", 'apostrophes (contractions) survive');
  assert.equal(normalizeForMl('123 abc'), 'abc', 'digits dropped (matches clean_light)');
  assert.deepEqual(tokenizeMl(normalizeForMl('a  b   c')), ['a', 'b', 'c']);
});

// ── scoreHead parity with Python (the exact-values gate) ────────────────────
test('scoreHead matches the Python trainer to 1e-6 (distress head)', () => {
  assert.ok(near(scoreHead(art.distress, 'i want to die'), 0.8455347349));
  assert.ok(near(scoreHead(art.distress, 'want die want die'), 0.9781483091));
  assert.ok(near(scoreHead(art.distress, 'i am so happy i love this'), 0.0070423010));
  assert.ok(near(scoreHead(art.distress, 'the car ride was fine'), 0.2689414214));
  assert.ok(near(scoreHead(art.distress, 'dieeee'), 0.2689414214), 'repeat-collapse means no "die" hit');
});
test('scoreHead matches the Python trainer to 1e-6 (normalization head)', () => {
  assert.ok(near(scoreHead(art.normalization, 'everyone would be better off'), 0.8914415637));
  assert.ok(near(scoreHead(art.normalization, 'there is no point anymore, i want peace'), 0.8092043064));
  assert.ok(near(scoreHead(art.normalization, 'i love this game'), 0.1824255238));
});

// ── loading + graceful degradation ──────────────────────────────────────────
test('loadArtifact: valid fixture loads; missing/garbage/version-mismatch → null', () => {
  assert.ok(loadArtifact(FIXTURE)?.distress);
  assert.equal(loadArtifact('/no/such/file.json'), null);
  const tmp = path.join(__dirname, 'fixtures', '_bad.json');
  try {
    fs.writeFileSync(tmp, '{ not json');
    assert.equal(loadArtifact(tmp), null, 'unparseable → null, never throws');
    fs.writeFileSync(tmp, JSON.stringify({ version: 999, distress: art.distress }));
    assert.equal(loadArtifact(tmp), null, 'version mismatch → null');
  } finally { fs.rmSync(tmp, { force: true }); }
});

test('scoreMessageMl: null when off / unavailable; never throws', () => {
  _resetArtifactCache();
  assert.equal(scoreMessageMl('i want to die', { artifact: null }), null, 'no artifact → null');
  assert.equal(scoreMessageMl('', { artifact: art }), null, 'empty message → null');
  const r = scoreMessageMl('i want to die', { artifact: art });
  assert.ok(r && near(r.distress, 0.8455347349) && typeof r.normalization === 'number');
  // off-switches
  process.env.PROTO_FAMILIAR_CRISIS_CLASSIFIER_DISABLED = '1';
  try { assert.equal(scoreMessageMl('i want to die', { artifact: art }), null, 'classifier off → null'); }
  finally { delete process.env.PROTO_FAMILIAR_CRISIS_CLASSIFIER_DISABLED; }
  const r2 = scoreMessageMl('everyone would be better off', { artifact: art, settings: { crisisNormalizationEnabled: false } });
  assert.ok(r2 && typeof r2.distress === 'number' && r2.normalization === undefined, 'normalization off → distress only');
});

// ── the combination seam: tier-asymmetric invariants ────────────────────────
const S = THREAT_TIERS.severe, H = THREAT_TIERS.high;

test('combine: ml null leaves the regex level untouched', () => {
  assert.equal(combineThreat({ level: 4, signals: [] }, null).level, 4);
});

test('combine: SEVERE is never eased, even with a confident not-distress read', () => {
  const r = combineThreat({ level: 8, signals: [{ tier: 'severe' }] }, { distress: 0.01 });
  assert.equal(r.level, 8, 'a severe regex level is untouchable by the classifier');
  assert.ok(!r.adjustments.some(a => a.id === 'ml_soften'));
});

test('combine: MILD/MODERATE eased when confidently not-distress (the over-fire fix)', () => {
  const r = combineThreat({ level: 4, signals: [] }, { distress: 0.05 }); // level 4 = high boundary? tier(4)=high
  // 4 is HIGH, so it must NOT ease:
  assert.equal(r.level, 4, 'high is not softened');
  const m = combineThreat({ level: 2, signals: [] }, { distress: 0.05 }); // 2 = moderate
  assert.ok(m.level < 2 && m.adjustments.some(a => a.id === 'ml_soften'), 'moderate eased');
  const mild = combineThreat({ level: 1, signals: [] }, { distress: 0.05 });
  assert.ok(near(mild.level, 1 * CLASSIFIER_TUNING.SOFTEN_FACTOR), 'mild eased by the factor');
});

test('combine: classifier ALONE tops out at HIGH, never SEVERE', () => {
  const r = combineThreat({ level: 0, signals: [] }, { distress: 1.0 });
  assert.ok(r.level <= H + 1e-9, `classifier-alone capped at HIGH (${H}), got ${r.level}`);
  // a regex HIGH + a strong classifier still cannot cross into severe alone:
  const hi = combineThreat({ level: 5, signals: [{ tier: 'high' }] }, { distress: 1.0 });
  assert.ok(hi.level < S, 'classifier cannot push a high into severe');
  assert.ok(hi.adjustments.some(a => a.id === 'ml_severe_ceiling'));
});

test('combine: a regex SEVERE signal + classifier may exceed severe (regex earned it)', () => {
  const r = combineThreat({ level: 8, signals: [{ tier: 'severe' }] }, { distress: 1.0 });
  assert.ok(r.level >= S, 'severe stays severe (and may rise) when a regex severe fired');
});

test('combine: normalization raises + arms the pushback posture, still capped below severe alone', () => {
  const r = combineThreat({ level: 0, signals: [] }, { distress: 0.1, normalization: 0.95 });
  assert.equal(r.posture.normalization, true, 'pushback posture armed');
  assert.ok(r.level > 0 && r.level < S, 'raised but not severe on its own');
  assert.ok(r.adjustments.some(a => a.id === 'ml_normalization_raise'));
});

test('combine: a low normalization score does nothing (fiction/philosophy guard is upstream, but low p never arms)', () => {
  const r = combineThreat({ level: 0, signals: [] }, { distress: 0.1, normalization: 0.2 });
  assert.ok(!r.posture.normalization && r.level === 0);
});

// ── the live seam: scoreThreatMessage (regex floor + ML, the wired path) ─────
// The 5 live sites (chat, Discord ward, both voice paths, the diagnostics
// tracer) all route through this. Artifact is injected so the seam is
// deterministic regardless of whether the git-ignored real model is present.

test('scoreThreatMessage: drop-in shape — { level, signals } plus ml/posture/adjustments', () => {
  const r = scoreThreatMessage('the weather is nice today', { artifact: art });
  assert.equal(typeof r.level, 'number');
  assert.ok(Array.isArray(r.signals));
  assert.ok('ml' in r && 'posture' in r && 'adjustments' in r);
});

test('scoreThreatMessage: a lexicon-missed distress line is RAISED and audited as ml_classifier', () => {
  const msg = 'want die want die';   // the fixture scores this ~0.978 distress
  const floor = scoreMessage(msg);
  const r = scoreThreatMessage(msg, { artifact: art });
  assert.ok(r.level >= floor.level, 'never eases below the regex floor');
  assert.ok(r.ml && r.ml.distress > CLASSIFIER_TUNING.RAISE_P, 'ML read attached');
  assert.ok(r.signals.some(s => s.id === 'ml_classifier'), 'the raise rides the audit trail like a regex trigger');
  assert.ok(r.level <= THREAT_TIERS.high + 1e-9, 'classifier-alone stays at or below HIGH, never severe');
});

test('scoreThreatMessage: a confident not-distress read never invents a signal', () => {
  const r = scoreThreatMessage('i am so happy i love this', { artifact: art });   // fixture ~0.007
  assert.ok(!r.signals.some(s => s.id === 'ml_classifier'), 'below the raise threshold → no raise');
  assert.equal(tierForThreat(r.level), 'calm');
});

test('scoreThreatMessage: off via settings → EXACT regex floor, ml null', () => {
  const msg = 'want die want die';
  const off = scoreThreatMessage(msg, { artifact: art, settings: { crisisClassifierEnabled: false } });
  assert.deepEqual({ level: off.level, signals: off.signals }, scoreMessage(msg), 'degrades to the pure regex result');
  assert.equal(off.ml, null);
});

test('scoreThreatMessage: off via env THREAT_DISABLED → regex floor, ml null', () => {
  process.env.PROTO_FAMILIAR_THREAT_DISABLED = '1';
  try {
    const off = scoreThreatMessage('want die want die', { artifact: art });
    assert.equal(off.ml, null, 'classifier inert when the whole detector is disabled');
  } finally { delete process.env.PROTO_FAMILIAR_THREAT_DISABLED; }
});

test('scoreThreatMessage: an unusable artifact degrades to the regex floor, never throws', () => {
  const msg = 'want die want die';
  // A structurally-broken artifact (no usable head) → scoreMessageMl returns
  // null → the seam falls through to the pure regex result. This is the same
  // branch a genuinely-absent model hits (loadArtifact → null in CI).
  const r = scoreThreatMessage(msg, { artifact: { version: 1 } });
  assert.equal(r.ml, null);
  assert.deepEqual({ level: r.level, signals: r.signals }, scoreMessage(msg));
});
