import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreMessage, SIGNALS, SCORE_CAPS } from '../src/safety/crisis-signals.js';

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
    "Thinking about suicide a lot lately.",
  ]) {
    assertScored(msg, { tier: 'severe', idIncludes: 'suicidal_direct', levelMin: 1 });
  }
});

// Regression: a severe signal whose OWN wording contains a blocker word must
// not damp itself. Before the span-exclusion fix, "I don't want to be here
// anymore" matched /(don'?t) want to (be here|exist|live)/ AND then tripped
// NEGATION_BLOCKERS on that same "don't" inside the ±50-char context window —
// scoring 1.6 (calm/mild) instead of 8 (severe → triage). Exact weights, NOT
// levelMin floors, so a re-introduction of the self-damp can't hide under a
// loose lower bound again.
test('severe: signal wording containing a blocker word does NOT self-damp', () => {
  const cases = [
    ["I don't want to be here anymore.", 'suicidal_direct'],
    ['I do not want to exist.',          'suicidal_direct'],
    ["I don't want to live anymore.",    'suicidal_direct'],
  ];
  for (const [msg, id] of cases) {
    const r = scoreMessage(msg);
    const sig = r.signals.find(s => s.id === id);
    assert.ok(sig, `expected ${id} to fire for "${msg}"`);
    assert.equal(sig.damped, false, `"${msg}" self-damped — the match's own wording must not damp it`);
    assert.equal(r.level, 8, `"${msg}" should score full severe weight 8, got ${r.level}`);
    assert.equal(r.signals.some(s => s.tier === 'severe'), true);
  }
});

// The dissociation moderate signal had the same shape ("I don't feel like
// myself" → /(don'?t )?feel like myself/ self-damped to 0.4). Full weight now.
test('moderate: dissociation wording with a blocker word does NOT self-damp', () => {
  const r = scoreMessage("I don't feel like myself.");
  const sig = r.signals.find(s => s.id === 'dissociation');
  assert.ok(sig, 'expected dissociation to fire');
  assert.equal(sig.damped, false);
  assert.equal(r.level, 2, `expected full moderate weight 2, got ${r.level}`);
});

// The invariant cuts BOTH ways — genuine surrounding negation/hypothetical
// context (the blocker sits OUTSIDE the matched span) must still damp.
test('damping: genuine context negation still damps (blocker outside the match span)', () => {
  const negated = scoreMessage("I don't want to die.");
  const nSig = negated.signals.find(s => s.id === 'suicidal_direct');
  assert.ok(nSig?.damped, '"I don\'t want to die" should still be damped — "don\'t" is outside "want to die"');
  assert.ok(negated.level < 2, `expected damped level < 2, got ${negated.level}`);

  const hypo = scoreMessage('What if someone says they want to die?');
  assert.ok(hypo.signals.find(s => s.id === 'suicidal_direct')?.damped,
    'hypothetical framing should still damp');
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

// ── Fuzzy-pattern tightening (false-positive reduction) ─────────────
// These HIGH/MODERATE idioms used to fire on ordinary venting and
// task/coding-frustration, quietly pushing threat up for days (3-day
// half-life) and starving warm outreach. Each case pins BOTH halves of
// the tightening: the genuine-distress form still fires; the benign idiom
// no longer does. (Real-distress sensitivity is preserved — a genuinely
// distressed person trips the other additive signals too.)

test('tightening: hopelessness keeps real despair, drops benign "giving up" / "the point"', () => {
  for (const msg of ["I'm giving up on life.", "I'm giving up on everything.",
                     "What's the point anymore?", "What's the point of going on?"]) {
    assertScored(msg, { tier: 'high', idIncludes: 'hopelessness' });
  }
  for (const msg of ["I'm giving up coffee for Lent.",
                     "Giving up on this bug, I'll try again tomorrow.",
                     "What's the point of this function?",
                     "What's the point of the second parameter?"]) {
    const r = scoreMessage(msg);
    assert.ok(!r.signals.some(s => s.id === 'hopelessness'),
      `"${msg}" must not fire hopelessness: ${JSON.stringify(r.signals)}`);
  }
});

test('tightening: cant_continue keeps "done with everything"/"done trying", drops "done with dinner"', () => {
  for (const msg of ["I'm done with everything.", "I'm so done with life.", "I'm done trying."]) {
    assertScored(msg, { tier: 'high', idIncludes: 'cant_continue' });
  }
  for (const msg of ["I'm done with dinner.", "I'm so done with this meeting.",
                     "I'm done for today, see you tomorrow.", "I'm done with the project."]) {
    const r = scoreMessage(msg);
    assert.ok(!r.signals.some(s => s.id === 'cant_continue'),
      `"${msg}" must not fire cant_continue: ${JSON.stringify(r.signals)}`);
  }
});

test('tightening: cant_continue keeps genuine "can\'t go on"/"anymore" forms, drops bare task-frustration', () => {
  // Genuine can't-continue still fires HIGH (recall protected):
  for (const msg of ["I can't go on.", "I can't keep going.", "I can't do this anymore.",
                     "I can't take it anymore.", "I can't handle this any longer."]) {
    assertScored(msg, { tier: 'high', idIncludes: 'cant_continue' });
  }
  // Bare task-frustration must NOT fire (the ward's reported over-fire):
  for (const msg of ["ugh I can't do this, nothing I try works", "I can't take it, this heat is unreal",
                     "I can't do this puzzle", "I can't handle it, this bug is impossible"]) {
    const r = scoreMessage(msg);
    assert.ok(!r.signals.some(s => s.id === 'cant_continue'),
      `"${msg}" must not fire cant_continue: ${JSON.stringify(r.signals)}`);
  }
});

test('tightening: severe_distress keeps "I\'m falling apart"/"I\'m breaking down", drops the car/data', () => {
  for (const msg of ["I'm falling apart.", "Everything is falling apart.", "I'm breaking down."]) {
    assertScored(msg, { tier: 'moderate', idIncludes: 'severe_distress' });
  }
  for (const msg of ["The car is falling apart.", "The whole plan is falling apart.",
                     "Let me finish breaking down the data.", "Breaking down the steps now."]) {
    const r = scoreMessage(msg);
    assert.ok(!r.signals.some(s => s.id === 'severe_distress'),
      `"${msg}" must not fire severe_distress: ${JSON.stringify(r.signals)}`);
  }
});

test('tightening: dissociation keeps "nothing feels real", drops "not real leather"', () => {
  for (const msg of ["Nothing feels real anymore.", "This doesn't feel real."]) {
    assertScored(msg, { tier: 'moderate', idIncludes: 'dissociation' });
  }
  for (const msg of ["That's not real leather.", "Wait, this can't be real!",
                     "The bug isn't real, it was a caching issue."]) {
    const r = scoreMessage(msg);
    assert.ok(!r.signals.some(s => s.id === 'dissociation'),
      `"${msg}" must not fire dissociation: ${JSON.stringify(r.signals)}`);
  }
});

test('tightening: exertion/arousal damps panic but NEVER a severe signal', () => {
  // panic from exercise / caffeine / excitement → damped (still fires weakly)
  for (const msg of ["My heart is racing after that workout.",
                     "Heart pounding, too much coffee today.",
                     "My heart is racing, I'm so excited!"]) {
    const r = scoreMessage(msg);
    const panic = r.signals.find(s => s.id === 'panic');
    assert.ok(panic && panic.damped, `panic should be damped for "${msg}": ${JSON.stringify(r.signals)}`);
  }
  // a real severe signal that merely mentions coffee/gym must NOT be damped
  for (const msg of ["I had coffee with my therapist and I still want to die.",
                     "After the gym I keep thinking about killing myself."]) {
    const r = scoreMessage(msg);
    assert.ok(r.signals.some(s => s.tier === 'severe' && !s.damped),
      `severe must stay undamped for "${msg}": ${JSON.stringify(r.signals)}`);
  }
});

test('tightening: mundane/technical context damps non-severe, never severe', () => {
  // frustration with a THING → damped (still fires weakly at 0.2x, not zeroed)
  for (const { msg, id } of [
    { msg: "I'm really struggling with this build.", id: 'severe_distress' },
    { msg: "So anxious about the deploy tomorrow.",  id: 'worry' },
    { msg: "I'm overwhelmed by my inbox.",            id: 'worry' },
    { msg: "I can't cope with the printer today.",    id: 'severe_distress' },
  ]) {
    const r = scoreMessage(msg);
    const sig = r.signals.find(s => s.id === id);
    assert.ok(sig && sig.damped, `${id} should be damped for "${msg}": ${JSON.stringify(r.signals)}`);
  }
  // a real severe signal that merely mentions code/a deadline must NOT be damped
  for (const msg of ["I keep thinking about killing myself, can't even look at the code.",
                     "Even the code can't distract me, I want to die."]) {
    const r = scoreMessage(msg);
    assert.ok(r.signals.some(s => s.tier === 'severe' && !s.damped),
      `severe must stay undamped for "${msg}": ${JSON.stringify(r.signals)}`);
  }
  // genuine distress NOT in a mundane register still fires full
  const real = scoreMessage("I'm really struggling right now, everything feels so heavy.");
  assert.ok(real.signals.some(s => s.id === 'severe_distress' && !s.damped),
    `genuine struggling must fire full: ${JSON.stringify(real.signals)}`);
});

test('tightening: the full coding-frustration vent (incl. "struggling") now stays calm', () => {
  // The exact report scenario — technical venting that used to stack to severe.
  // "struggling" is left untightened, but the mundane "this build" damps it,
  // and the tightened idioms (breaking down/point/done) no longer fire at all.
  const vent = "I'm really struggling with this build, it keeps breaking down, " +
               "what's the point of this config, I'm done.";
  const r = scoreMessage(vent);
  assert.ok(!r.signals.some(s => s.id === 'hopelessness'),  `no hopelessness: ${JSON.stringify(r.signals)}`);
  assert.ok(!r.signals.some(s => s.id === 'cant_continue'), `no cant_continue: ${JSON.stringify(r.signals)}`);
  assert.ok(r.level < 2, `vent should stay below the moderate gate (got ${r.level}): ${JSON.stringify(r.signals)}`);
});

test('tightening: a calm-register coding-frustration vent no longer stacks into a threat spike', () => {
  // The exact failure mode from the report: ordinary task frustration
  // stacking the HIGH idioms (point/done) + a data "breaking down" into
  // moderate/high and starving warm outreach. (`really struggling` is left
  // untightened by design, so it's omitted here.)
  const vent = "Ugh, this build keeps breaking down the modules. What's the point of this " +
               "config option? I'm done with the project for today.";
  const r = scoreMessage(vent);
  assert.ok(!r.signals.some(s => s.id === 'hopelessness'),  `no hopelessness: ${JSON.stringify(r.signals)}`);
  assert.ok(!r.signals.some(s => s.id === 'cant_continue'), `no cant_continue: ${JSON.stringify(r.signals)}`);
  assert.ok(!r.signals.some(s => s.id === 'severe_distress'), `no severe_distress: ${JSON.stringify(r.signals)}`);
  assert.equal(r.level, 0, `coding vent should score calm (got ${r.level}): ${JSON.stringify(r.signals)}`);
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
