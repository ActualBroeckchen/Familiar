import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreMessage, SIGNALS, SCORE_CAPS } from '../crisis-signals.js';

// Helper: assert that scoring a message produces ≥ N signals firing,
// at the expected tier, with the resulting level within [min,max].
function assertScored(message, { atLeast = 1, tier, levelMin, levelMax, idIncludes } = {}) {
  const r = scoreMessage(message);
  if (atLeast > 0) {
    assert.ok(r.signals.length >= atLeast,
      `expected ≥${atLeast} signal(s), got ${r.signals.length} for "${message}"\n` +
      `signals: ${JSON.stringify(r.signals, null, 2)}`);
  }
  if (tier)        assert.ok(r.signals.some(s => s.tier === tier),
                     `expected at least one ${tier}-tier signal for "${message}"`);
  if (idIncludes)  assert.ok(r.signals.some(s => s.id === idIncludes),
                     `expected signal id "${idIncludes}" for "${message}"`);
  if (Number.isFinite(levelMin)) assert.ok(r.level >= levelMin, `level ${r.level} < ${levelMin} for "${message}"`);
  if (Number.isFinite(levelMax)) assert.ok(r.level <= levelMax, `level ${r.level} > ${levelMax} for "${message}"`);
  return r;
}

// ── Basics & contract ───────────────────────────────────────────────

test('scoreMessage: empty / nullish input → zero level, no signals', () => {
  assert.deepEqual(scoreMessage(''),       { level: 0, signals: [] });
  assert.deepEqual(scoreMessage(null),     { level: 0, signals: [] });
  assert.deepEqual(scoreMessage(undefined), { level: 0, signals: [] });
  assert.deepEqual(scoreMessage(42),       { level: 0, signals: [] });
});

test('scoreMessage: neutral / innocuous text → no signals', () => {
  for (const msg of [
    'Hello, how are you?',
    'I had a great day today, thanks for asking!',
    'Can you help me write a poem about autumn?',
    'What time is it?',
    'I love this song.',
  ]) {
    const r = scoreMessage(msg);
    assert.deepEqual(r.signals, [], `unexpected signals on "${msg}": ${JSON.stringify(r.signals)}`);
    assert.equal(r.level, 0);
  }
});

// ── Severe tier ─────────────────────────────────────────────────────

test('severe: direct suicidal statements fire suicidal_direct', () => {
  for (const msg of [
    'I want to die.',
    "I'm going to kill myself.",
    "I wish I were dead.",
    "I don't want to be here anymore.",
    "Thinking about suicide a lot lately.",
  ]) {
    assertScored(msg, { tier: 'severe', idIncludes: 'suicidal_direct', levelMin: 1 });
  }
});

test('severe: self-harm language fires self_harm', () => {
  for (const msg of ['I want to hurt myself.', "I've been cutting again.", 'self-harm is hard to stop']) {
    assertScored(msg, { tier: 'severe', idIncludes: 'self_harm' });
  }
});

test('severe: acute crisis plan fires crisis_plan', () => {
  for (const msg of ['I have the pills.', 'I have a plan.', 'This is goodbye forever.']) {
    assertScored(msg, { tier: 'severe', idIncludes: 'crisis_plan' });
  }
});

// ── High tier ───────────────────────────────────────────────────────

test('high: hopelessness fires', () => {
  for (const msg of ["What's the point anymore?", 'Nothing matters.', 'There is no hope left.']) {
    assertScored(msg, { tier: 'high', idIncludes: 'hopelessness' });
  }
});

test('high: severe isolation fires', () => {
  for (const msg of ['No one cares about me.', "I'm completely alone.", 'I have no one.']) {
    assertScored(msg, { tier: 'high', idIncludes: 'severe_isolation' });
  }
});

test('high: can\'t-continue language fires', () => {
  for (const msg of ["I can't take it anymore.", "I can't keep doing this.", "I've reached my breaking point."]) {
    assertScored(msg, { tier: 'high', idIncludes: 'cant_continue' });
  }
});

// ── Moderate tier ───────────────────────────────────────────────────

test('moderate: severe distress fires', () => {
  for (const msg of ['I am really struggling.', 'I am falling apart.', 'I can\'t cope.']) {
    assertScored(msg, { tier: 'moderate' });
  }
});

test('moderate: dissociation fires', () => {
  for (const msg of ['I feel numb.', "I don't feel like myself.", 'Dissociating again.']) {
    assertScored(msg, { tier: 'moderate', idIncludes: 'dissociation' });
  }
});

test('moderate: panic fires', () => {
  for (const msg of ["I'm having a panic attack.", "I can't breathe.", 'My heart is racing.']) {
    assertScored(msg, { tier: 'moderate', idIncludes: 'panic' });
  }
});

// ── Mild tier ───────────────────────────────────────────────────────

test('mild: sadness / bad-day fires', () => {
  for (const msg of ['I feel really sad today.', 'Having a rough day.']) {
    assertScored(msg, { tier: 'mild', idIncludes: 'sadness' });
  }
});

test('mild: anxiety / worry fires', () => {
  for (const msg of ["I'm so anxious.", "I can't sleep.", 'I feel overwhelmed.']) {
    assertScored(msg, { tier: 'mild', idIncludes: 'worry' });
  }
});

// ── Safety signals (reduce threat) ─────────────────────────────────

test('safety: reassurance contributes negative weight', () => {
  const r = scoreMessage("I'm okay now, just wanted to check in.");
  assert.ok(r.signals.some(s => s.id === 'reassurance'));
  assert.ok(r.level < 0, `expected negative level for reassurance, got ${r.level}`);
});

test('safety: support engagement contributes negative weight', () => {
  const r = scoreMessage("I talked to my therapist yesterday.");
  assert.ok(r.signals.some(s => s.id === 'support_engagement'));
  assert.ok(r.level < 0);
});

// ── Damping (false-positive avoidance) ──────────────────────────────

test('damping: negation reduces severe signal weight to ~20%', () => {
  const direct  = scoreMessage('I want to die.');
  const negated = scoreMessage("I don't want to die.");
  assert.ok(direct.level   > negated.level, 'negation should reduce level');
  assert.ok(negated.signals.find(s => s.id === 'suicidal_direct')?.damped, 'should be flagged damped');
  // 20% damp on weight 8 = 1.6
  assert.ok(negated.level < 2, `expected damped level < 2, got ${negated.level}`);
});

test('damping: hypothetical reduces signal weight', () => {
  const direct      = scoreMessage('I want to die.');
  const hypothetical = scoreMessage('What if someone says they want to die?');
  assert.ok(hypothetical.level < direct.level);
  assert.ok(hypothetical.signals.find(s => s.id === 'suicidal_direct')?.damped);
});

test('damping: others-speech reduces signal weight', () => {
  const direct = scoreMessage('I want to die.');
  const others = scoreMessage('My friend told me she wanted to die.');
  assert.ok(others.level < direct.level);
});

test('damping: hyperbolic / joking context reduces signal weight', () => {
  const serious = scoreMessage("I can't take it anymore.");
  const joking  = scoreMessage("lol I can't take it anymore, this meme is too good 😂");
  assert.ok(joking.level < serious.level);
});

test('damping: SAFETY signals damped to ZERO, not 0.2× (negated reassurance must not reduce threat)', () => {
  const r = scoreMessage("I'm not okay.");
  // "I'm okay" pattern matches, but "not" negates → safety contributes 0.
  const reassurance = r.signals.find(s => s.id === 'reassurance');
  if (reassurance) {
    assert.equal(reassurance.weight, 0, 'damped safety signal must contribute zero, not negative');
  }
  // Total level must not be negative.
  assert.ok(r.level >= 0, `negated "I'm okay" produced negative level ${r.level}`);
});

// ── Aggregation & caps ──────────────────────────────────────────────

test('aggregation: multiple distinct signals add up', () => {
  const r = scoreMessage("I feel numb. I can't sleep. I'm really struggling.");
  assert.ok(r.signals.length >= 3, `expected ≥3 signals, got ${r.signals.length}`);
  assert.ok(r.level > 3, `expected level > 3 from three moderate-ish signals, got ${r.level}`);
});

test('aggregation: a single signal does not double-count when repeated', () => {
  const single = scoreMessage('I want to die.');
  const repeat = scoreMessage('I want to die. I want to die. I want to die.');
  // suicidal_direct only fires once per message
  assert.equal(
    repeat.signals.filter(s => s.id === 'suicidal_direct').length,
    1,
    'a signal should fire at most once per message',
  );
  assert.equal(single.level, repeat.level);
});

test('cap: a single message can\'t push level above SCORE_CAPS.max', () => {
  const overloaded = scoreMessage(
    "I want to die. I have a plan. I want to hurt myself. " +
    "There's no point. I can't go on. I'm completely alone."
  );
  assert.ok(overloaded.level <= SCORE_CAPS.max,
    `level ${overloaded.level} exceeded cap ${SCORE_CAPS.max}`);
});

test('cap: pure safety message can\'t push level below SCORE_CAPS.min', () => {
  const reassuring = scoreMessage(
    "I'm okay. I'm safe. I'm feeling better. " +
    "I talked to my therapist. I called the hotline. " +
    "Things are getting better."
  );
  assert.ok(reassuring.level >= SCORE_CAPS.min,
    `level ${reassuring.level} below floor ${SCORE_CAPS.min}`);
});

// ── Mixed signals (the realistic case) ─────────────────────────────

test('mixed: distress + reassurance partially offset', () => {
  const r = scoreMessage("I was really struggling earlier, but I'm okay now.");
  assert.ok(r.signals.some(s => s.tier === 'moderate'));
  assert.ok(r.signals.some(s => s.tier === 'safety'));
  // The net effect should be near zero or slightly negative.
  assert.ok(r.level <= 1, `expected near-zero net level, got ${r.level}`);
});

// ── Audit shape ─────────────────────────────────────────────────────

test('audit: every fired signal exposes id, tier, weight, damped flag, match text', () => {
  const r = scoreMessage("I want to die.");
  for (const s of r.signals) {
    assert.ok(typeof s.id     === 'string');
    assert.ok(typeof s.tier   === 'string');
    assert.ok(typeof s.weight === 'number');
    assert.ok(typeof s.damped === 'boolean');
    assert.ok(typeof s.match  === 'string' && s.match.length > 0);
  }
});

test('SIGNALS array is frozen (tuning happens in source)', () => {
  assert.throws(() => { SIGNALS.push({ id: 'x', tier: 'mild', weight: 1, patterns: [] }); }, TypeError);
});

// ── False-positive regression suite ────────────────────────────────
// Phrases that previously over-fired severe signals because the
// patterns accepted "me" / "it" / "things" without specifiers. Each
// of these should produce a level < 5 (i.e. not hit severe), even
// though they SOUND alarming on a first read.

test('false positive: emotional "hurt me" does not fire severe', () => {
  for (const msg of [
    'That really hurt me.',
    'It hurts me to see them like this.',
    'Their comment hurt me a lot.',
  ]) {
    const r = scoreMessage(msg);
    const severeFires = r.signals.filter(s => s.tier === 'severe' && !s.damped);
    assert.equal(severeFires.length, 0, `severe-undamped fired on "${msg}": ${JSON.stringify(r.signals)}`);
  }
});

test('false positive: "cut me off" / "cut me some slack" does not fire severe', () => {
  for (const msg of [
    'She cut me off mid-sentence.',
    'He keeps cutting me off when I try to speak.',
    'Cut me some slack, I just started.',
    'Could you cut me a break here?',
  ]) {
    const r = scoreMessage(msg);
    const severeFires = r.signals.filter(s => s.tier === 'severe' && !s.damped);
    assert.equal(severeFires.length, 0, `severe-undamped fired on "${msg}": ${JSON.stringify(r.signals)}`);
  }
});

test('false positive: casual "just kill me" does not fire severe', () => {
  for (const msg of [
    'Just kill me, I forgot the password again.',
    'Kill me now, this meeting is endless.',
  ]) {
    const r = scoreMessage(msg);
    const severeFires = r.signals.filter(s => s.tier === 'severe' && !s.damped);
    assert.equal(severeFires.length, 0, `severe-undamped fired on "${msg}": ${JSON.stringify(r.signals)}`);
  }
});

test('false positive: "end it" / "end things" in benign context does not fire severe', () => {
  for (const msg of [
    "Let's end it for today.",
    'I want to end it before lunch.',
    'I think we should end things between us.',
    'Time to end things and go home.',
  ]) {
    const r = scoreMessage(msg);
    const severeFires = r.signals.filter(s => s.tier === 'severe' && !s.damped);
    assert.equal(severeFires.length, 0, `severe-undamped fired on "${msg}": ${JSON.stringify(r.signals)}`);
  }
});

test('false positive: "die from embarrassment / boredom / cringe" damps to ≈0', () => {
  for (const msg of [
    "I'm going to die from embarrassment.",
    'I want to die from cringe right now.',
    'I want to die from boredom in this meeting.',
  ]) {
    const r = scoreMessage(msg);
    // The signal may fire but should be damped to ~0.2× weight = ~1.6.
    // The total level should be well below severe range (<5).
    assert.ok(r.level < 5, `level ${r.level} not damped enough on "${msg}": ${JSON.stringify(r.signals)}`);
  }
});

test('regression: canonical true-positive cases still fire after tightening', () => {
  // Re-verify the actual severe positives still work — these power
  // the very behaviour the tightening is meant to preserve.
  const cases = [
    { msg: 'I want to hurt myself.',     id: 'self_harm' },
    { msg: 'I want to kill myself.',     id: 'suicidal_direct' },
    { msg: 'I want to end my life.',     id: 'suicidal_direct' },
    { msg: 'I want to end it all.',      id: 'suicidal_direct' },
    { msg: "I've been cutting again.",   id: 'self_harm' },
    { msg: 'Thinking about suicide.',    id: 'suicidal_direct' },
  ];
  for (const { msg, id } of cases) {
    const r = scoreMessage(msg);
    assert.ok(r.signals.some(s => s.id === id && !s.damped),
      `expected undamped ${id} on "${msg}": ${JSON.stringify(r.signals)}`);
  }
});

// ── -ing forms + idiomatic suicidal phrasings (Eury bug report) ────
// Previously: "killing myself" / "ending myself" / "ending it all"
// silently scored ZERO because the base patterns required literal
// "kill" / "end" with no -ing alternative. This was a real false
// negative on canonical ideation language.

test('regression: -ing forms of suicidal_direct fire', () => {
  const cases = [
    'I keep thinking about killing myself.',
    'About ending it all.',
    'About ending myself.',
    'I think about ending my life.',
    'I want to end everything.',
    'Wanting to die feels familiar.',
    'I have been taking my own life into consideration.', // weaker but should still fire on "taking my own life"
    'I took my own life on the table.',                    // edge — same phrase, different sense
  ];
  for (const msg of cases) {
    const r = scoreMessage(msg);
    assert.ok(r.signals.some(s => s.id === 'suicidal_direct' && !s.damped),
      `expected suicidal_direct undamped on "${msg}": ${JSON.stringify(r.signals)}`);
  }
});

test('regression: Eury verbatim test phrases score severe (level ≥ 7)', () => {
  // The actual phrases from the report — these MUST fire severe or
  // the whole detection layer is useless.
  const phrases = [
    'Okay. end it all end myself kill myself want to hurt myself',
    'Sometimes I think about just giving up. About ending it all. About ending myself. I think about killing myself.',
    'I think about killing myself.',
    'Sometimes I want to end it all.',
  ];
  for (const msg of phrases) {
    const r = scoreMessage(msg);
    assert.ok(r.level >= 7, `expected level ≥ 7 (severe range) on "${msg}", got ${r.level}: ${JSON.stringify(r.signals)}`);
    assert.ok(r.signals.some(s => s.tier === 'severe' && !s.damped),
      `expected at least one undamped severe signal on "${msg}": ${JSON.stringify(r.signals)}`);
  }
});
