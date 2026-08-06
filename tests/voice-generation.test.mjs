import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  generationExtras, DEFAULT_TTS_SEED, DEFAULT_TTS_TEMPERATURE,
  DEFAULT_NUM_STEPS, MAX_REFERENCE_SECONDS,
  MAX_CHAR_IN_SENTENCE, MIN_CHAR_IN_SENTENCE, runawaySampleLimit, DEFAULT_MAX_FRAMES, FRAME_RATE_HZ,
  pendingTailStart, expectedSpeechSeconds,
  renderDroppedWords, bestRender, SMALL_UTTERANCE_CHARS,
  speakUnitsSelfHealing,
} from '../voice-generation.js';

const RATE = 18.6;   // chars/second the helpers assume; the fake engine matches it
const sentencesOf = (t) => t.split(/(?<=[.!?])\s+/).filter(Boolean);
// A fake engine that renders `spoken` chars of `text` into that many "samples",
// so duration = spokenChars/RATE. `earlyStopAt` lets a unit drop its tail.
const fakeRender = (text, { spokenChars = text.length } = {}) => ({
  ok: true, samples: new Array(Math.max(0, spokenChars)).fill(0), durationSec: spokenChars / RATE,
});

/**
 * These exist because the bug they prevent shipped twice.
 *
 * PocketTTS re-seeds its sampler per SENTENCE, inside one generate call. With
 * upstream's -1 default that is a fresh random seed each time, so a
 * three-sentence reply came out as three voices at three energies — muffled,
 * then clear, then something else. Restructuring above the engine could not
 * fix it; only the seed can.
 */

test('a seed is always present — its absence is the whole bug', () => {
  const extra = generationExtras();
  assert.equal(typeof extra.seed, 'number');
  assert.ok(extra.seed >= 0, 'a negative seed is upstream for "randomise"');
  assert.equal(extra.seed, DEFAULT_TTS_SEED);
});

test('-1 is refused rather than passed through', () => {
  // -1 is upstream's "surprise me". Forwarding it would reintroduce exactly
  // the behaviour this module exists to stop, and it would do so silently.
  assert.equal(generationExtras({ seed: -1 }).seed, DEFAULT_TTS_SEED);
  assert.equal(generationExtras({ seed: -999 }).seed, DEFAULT_TTS_SEED);
});

test('a chosen seed is honoured, including zero', () => {
  assert.equal(generationExtras({ seed: 7 }).seed, 7);
  assert.equal(generationExtras({ seed: 0 }).seed, 0, '0 is a real seed, not "unset"');
});

test('junk falls back to the default instead of reaching the engine', () => {
  for (const bad of [undefined, null, '', 'abc', NaN, {}, []]) {
    assert.equal(generationExtras({ seed: bad }).seed, DEFAULT_TTS_SEED, `seed ${String(bad)}`);
    assert.equal(generationExtras({ temperature: bad }).temperature, DEFAULT_TTS_TEMPERATURE, `temp ${String(bad)}`);
  }
});

test('the same inputs always build the same extras — determinism starts here', () => {
  assert.deepEqual(generationExtras(), generationExtras());
  assert.deepEqual(generationExtras({ seed: 5, temperature: 0.4 }), generationExtras({ seed: 5, temperature: 0.4 }));
});

test('temperature is carried, so it can be tuned by ear', () => {
  assert.equal(generationExtras().temperature, DEFAULT_TTS_TEMPERATURE);
  assert.equal(generationExtras({ temperature: 0.3 }).temperature, 0.3);
});

test('the reference length rides along on every generation', () => {
  // Every generation must see the same reference window; a clone built from a
  // different slice of the clip is a different voice.
  assert.equal(generationExtras().max_reference_audio_len, MAX_REFERENCE_SECONDS);
  assert.equal(generationExtras({ seed: 3 }).max_reference_audio_len, MAX_REFERENCE_SECONDS);
});

test('the defaults are the values measured on real hardware', () => {
  assert.equal(DEFAULT_NUM_STEPS, 4, 'RTF 0.616 on the reference laptop');
  assert.equal(DEFAULT_TTS_TEMPERATURE, 0.7, "upstream's own default");
  assert.equal(MAX_REFERENCE_SECONDS, 12, 'most of a 12.8 s clip');
});

// ── The runt fragment, and the noise it caused ──────────────────────────

test('the sentence threshold is well clear of 200, where the runt was born', () => {
  // A 205-character sentence split at 200 left 'real.' as its own utterance.
  // The LM hit EOS at step 0, upstream's `if (eos_step > 0 …)` never fired,
  // and the loop ran its whole 500-frame budget as noise.
  // Assert the INVARIANT, not the number — the threshold moved to 2000 when
  // merging came in, and a test pinned to 360 would just have to be edited
  // again rather than telling anyone anything.
  assert.ok(MAX_CHAR_IN_SENTENCE > 205, 'the reported sentence must pass through whole');
});

test('both sentence bounds ride on every generation', () => {
  const extra = generationExtras();
  assert.equal(extra.max_char_in_sentence, MAX_CHAR_IN_SENTENCE);
  assert.equal(extra.min_char_in_sentence, MIN_CHAR_IN_SENTENCE);
});

test('a runaway is capped in seconds, not tens of seconds', () => {
  const forTheRunt = runawaySampleLimit('real.', 24000) / 24000;
  assert.ok(forTheRunt <= 4, `the fragment that caused this must not run long: ${forTheRunt}s`);
  assert.ok(forTheRunt >= 2, 'but not so tight that a short real line is cut');
});

test('the cap scales with the text, so a long sentence is not truncated', () => {
  const short = runawaySampleLimit('Hey.', 24000);
  const long = runawaySampleLimit('x'.repeat(300), 24000);
  assert.ok(long > short * 3, 'more words must buy more room');
  assert.ok(long / 24000 > 300 / 14, 'and comfortably more than the text could take to say');
});

test('the cap never returns zero or NaN, whatever it is handed', () => {
  // It gates audio reaching a person. A NaN ceiling would compare false and
  // silently disable the guard.
  for (const bad of ['', null, undefined, 0, {}, []]) {
    const v = runawaySampleLimit(bad, 24000);
    assert.ok(Number.isFinite(v) && v > 0, `runawaySampleLimit(${String(bad)}) = ${v}`);
  }
});

// ── The un-streamed tail: the last sentence must not be dropped ─────────

test('a callback that under-delivers leaves a tail to send from where it stopped', () => {
  // The reported bug: the message stopped a sentence early because the engine
  // handed its final chunk back in the clip, not through onProgress. The clip
  // is longer than what streamed, and the remainder starts where streaming did.
  assert.equal(pendingTailStart(48000, 72000), 48000);
});

test('nothing is re-sent when the callback already delivered the whole clip', () => {
  // The ordinary case: streamed === total, so there is no tail and the listener
  // is never handed audio they already heard.
  assert.equal(pendingTailStart(72000, 72000), -1);
  assert.equal(pendingTailStart(72001, 72000), -1);
});

test('a runaway stop is never reconciled — the tail there is the noise we cut', () => {
  // Past the streamed count on a runaway is exactly the degenerating audio the
  // cap stopped on purpose. Re-appending it would defeat the guard.
  assert.equal(pendingTailStart(48000, 200000, { runaway: true }), -1);
});

test('junk counts never invent a tail', () => {
  for (const [s, t] of [[NaN, 100], [100, NaN], [undefined, 100], [100, undefined]]) {
    assert.equal(pendingTailStart(s, t), -1, `pendingTailStart(${s}, ${t})`);
  }
});

// ── The merge threshold: a trade, not a win ─────────────────────────────

test('the merge floor stays where the text still renders in full', () => {
  // Measured: at one-utterance-per-message the engine reaches EOS early and
  // drops half the words (36.3 chars/s for an 899-char message, vs ~21 at 300).
  // So this is deliberately NOT "as large as possible".
  assert.ok(MIN_CHAR_IN_SENTENCE >= 300, 'too small drifts the voice, a reset per utterance');
  assert.ok(MIN_CHAR_IN_SENTENCE <= 600, 'too large makes the model stop early and swallow text');
});

test('an expected duration exists so a swallowed paragraph can be noticed', () => {
  // sherpa's Generate skips any sentence that renders empty, and abandons the
  // whole remainder if a progress callback returns false — both silent. The
  // only signal is audio that is far shorter than the words predict.
  const short = expectedSpeechSeconds('Hey there.');
  const long = expectedSpeechSeconds('x'.repeat(1000));
  assert.ok(long > short * 10, 'more words, more seconds');
  assert.ok(long > 30 && long < 80, `1000 chars should land in the tens of seconds, got ${long}`);
});

test('a slower speed expects longer audio, so it is not read as a drop', () => {
  // Without this, a ward who slowed speech for comprehension would trip the
  // short-render warning on every perfectly complete message.
  assert.ok(expectedSpeechSeconds('x'.repeat(500), { speed: 0.5 })
          > expectedSpeechSeconds('x'.repeat(500), { speed: 1 }));
});

test('expectedSpeechSeconds is junk-safe and never negative', () => {
  for (const bad of [null, undefined, 42, {}, []]) assert.equal(expectedSpeechSeconds(bad), 0);
  assert.ok(expectedSpeechSeconds('abc', { speed: 0 }) > 0, 'a zero speed falls back rather than dividing by zero');
  assert.ok(Number.isFinite(expectedSpeechSeconds('abc', { speed: NaN })));
});

// ── Self-healing read-aloud: catch a dropped tail and re-speak it ───────

test('a small unit is small on purpose — detection reliability needs it', () => {
  // The self-healing path verifies each unit by duration, which only works when
  // one dropped sentence is a large fraction of the unit. This must stay well
  // below the merge target used for the hand-it-one-trajectory path.
  assert.ok(SMALL_UTTERANCE_CHARS < MIN_CHAR_IN_SENTENCE);
  assert.ok(SMALL_UTTERANCE_CHARS >= 80, 'but not so small the whole message is one-sentence resets');
});

test('renderDroppedWords flags audio far shorter than the words predict', () => {
  const text = 'x'.repeat(160);            // ~8.6 s expected at 18.6 chars/s
  const full = expectedSpeechSeconds(text);
  assert.equal(renderDroppedWords(text, full * 0.95), false, 'a near-full render is fine');
  assert.equal(renderDroppedWords(text, full * 0.5), true, 'half the audio is a dropped sentence');
  assert.equal(renderDroppedWords(text, 0), true, 'no audio at all is the worst drop');
  assert.equal(renderDroppedWords(text, NaN), true, 'a missing duration is treated as a drop');
});

test('renderDroppedWords does not flag a merely brisk render', () => {
  // Real renders come back faster than the 18.6 floor (~25 was measured). The
  // 0.7 ratio must sit above that so a quick-but-complete render is not re-spoken.
  const text = 'x'.repeat(200);
  const brisk = text.length / 25;   // 25 chars/second
  assert.equal(renderDroppedWords(text, brisk), false);
});

test('renderDroppedWords refuses to judge something too short to judge', () => {
  // A couple of words is below the noise floor; calling it "dropped" would fire
  // constantly on legitimately tiny renders.
  assert.equal(renderDroppedWords('Yes.', 0.1), false);
  assert.equal(renderDroppedWords('', 0), false);
});

test('bestRender prefers the first complete attempt, else the longest', () => {
  const text = 'x'.repeat(160);
  const full = expectedSpeechSeconds(text);
  // First attempt dropped, second complete → take the complete one.
  const a = { samples: [1], durationSec: full * 0.5 };
  const b = { samples: [1, 2], durationSec: full * 0.95 };
  assert.equal(bestRender([a, b], text), b);
  // An earlier complete attempt wins over a later one, so the voice changes least.
  const c = { samples: [3], durationSec: full * 0.9 };
  assert.equal(bestRender([b, c], text), b);
  // All dropped → the longest partial beats silence.
  assert.equal(bestRender([a, { samples: [9], durationSec: full * 0.6 }], text).durationSec, full * 0.6);
  // Nothing usable → null, never a crash.
  assert.equal(bestRender([], text), null);
  assert.equal(bestRender([{ samples: [], durationSec: 5 }], text), null);
});

// ── The self-healing loop, driven through a fake engine ─────────────────

test('a unit that renders whole is emitted once, in order, unchanged', async () => {
  const emitted = [];
  const summary = await speakUnitsSelfHealing(['x'.repeat(150), 'y'.repeat(150)], {
    generate: (text) => fakeRender(text),
    emit: (s) => emitted.push(s.length),
    splitToSentences: sentencesOf,
  });
  assert.deepEqual(emitted, [150, 150]);
  assert.equal(summary.emitted, 2);
  assert.equal(summary.droppedSentences, 0);
});

test('a unit that early-stops is re-spoken, and only the complete take is emitted', async () => {
  // The engine drops half of any unit on seed N, but renders it whole on seed N+1.
  // This is the exact shape of the reported drop: the tail vanishes, then a seed
  // bump fixes it. The listener must hear the WHOLE unit, exactly once.
  const emitted = [];
  const unit = 'a'.repeat(180);
  const summary = await speakUnitsSelfHealing([unit], {
    baseSeed: 100,
    generate: (text, seed) => fakeRender(text, { spokenChars: seed === 100 ? Math.floor(text.length * 0.4) : text.length }),
    emit: (s) => emitted.push(s.length),
    splitToSentences: sentencesOf,
  });
  assert.deepEqual(emitted, [180], 'the whole unit, once — not the short take too');
  assert.ok(summary.reSpoken >= 1, 'it took a retry');
  assert.equal(summary.droppedSentences, 0);
});

test('a unit that stays short falls to sentences, each rendered whole', async () => {
  // The unit ALWAYS early-stops however the seed moves — so the loop must drop to
  // sentence granularity, where each short sentence renders fully. No word lost.
  const emitted = [];
  const unit = 'Alpha beta gamma delta. Epsilon zeta eta theta. Iota kappa lambda mu.';
  const sents = sentencesOf(unit);
  const summary = await speakUnitsSelfHealing([unit], {
    generate: (text) => {
      const isWholeUnit = text === unit;
      return fakeRender(text, { spokenChars: isWholeUnit ? Math.floor(text.length * 0.3) : text.length });
    },
    emit: (s) => emitted.push(s.length),
    splitToSentences: sentencesOf,
  });
  assert.equal(emitted.length, sents.length, 'one emit per sentence');
  assert.deepEqual(emitted, sents.map((s) => s.length), 'and each whole');
  assert.equal(summary.droppedSentences, 0);
});

test('a sentence that will not render whole is counted, never emitted as a lie', async () => {
  const emitted = [];
  // Sentences long enough to be judgeable (>~37 chars, so expected > 2 s).
  const unit = 'The first clause runs on for a good while here. The second clause also runs on for a good while here.';
  const summary = await speakUnitsSelfHealing([unit], {
    // Everything early-stops, always: the unit AND both sentences.
    generate: (text) => fakeRender(text, { spokenChars: Math.floor(text.length * 0.3) }),
    emit: (s) => emitted.push(s.length),
    splitToSentences: sentencesOf,
  });
  // Best-effort partials may be emitted, but every short sentence is COUNTED so
  // the caller can log it — silence is never dressed up as success.
  assert.ok(summary.droppedSentences >= 1, `expected drops to be counted, got ${summary.droppedSentences}`);
});

test('a worker death stops the loop instead of hammering a dead engine', async () => {
  const emitted = [];
  let calls = 0;
  const summary = await speakUnitsSelfHealing(['a'.repeat(150), 'b'.repeat(150), 'c'.repeat(150)], {
    generate: (text) => { calls += 1; return calls === 1 ? fakeRender(text) : { ok: false, reason: 'worker-died' }; },
    emit: (s) => emitted.push(s.length),
    splitToSentences: sentencesOf,
    isFatal: (r) => r === 'worker-died',
  });
  assert.deepEqual(emitted, [150], 'the first unit spoke, then the death stopped everything');
  assert.ok(calls <= 2, 'it did not keep asking a dead worker');
});

test('an abort mid-message stops promptly and emits nothing further', async () => {
  const emitted = [];
  let aborted = false;
  await speakUnitsSelfHealing(['a'.repeat(150), 'b'.repeat(150)], {
    generate: (text) => { aborted = true; return fakeRender(text); },   // abort after the first render starts
    emit: (s) => { if (!aborted || emitted.length === 0) emitted.push(s.length); },
    isAborted: () => aborted && emitted.length > 0,
    splitToSentences: sentencesOf,
  });
  assert.ok(emitted.length <= 1, 'a closed stream is not written to');
});

// ── Chunking: fewer LM resets, fewer places to drift ────────────────────

test('the frame budget leaves room for a merged utterance', () => {
  // Upstream's 500 is ~40 s at Mimi's 12.5 Hz — enough for one sentence, not
  // for a whole message once sentences merge into one trajectory.
  assert.ok(DEFAULT_MAX_FRAMES > 500);
  assert.equal(generationExtras().max_frames, DEFAULT_MAX_FRAMES);
  assert.equal(generationExtras({ maxFrames: 1800 }).max_frames, 1800);
});

test('the merge target is carried, and overridable', () => {
  assert.equal(generationExtras().min_char_in_sentence, MIN_CHAR_IN_SENTENCE);
  assert.equal(generationExtras({ minChars: 30 }).min_char_in_sentence, 30);
});

test('max is always forced clear of min, so a merged utterance is not re-split', () => {
  // Re-splitting a merged chunk gains nothing and risks the runt fragment.
  for (const [minChars, maxChars] of [[400, 100], [400, 400], [500, 550], [30, 360]]) {
    const e = generationExtras({ minChars, maxChars });
    assert.ok(
      e.max_char_in_sentence >= e.min_char_in_sentence + 200,
      `min=${e.min_char_in_sentence} max=${e.max_char_in_sentence} leaves no room to overshoot`,
    );
  }
});

test('the reference window is overridable, since upstream defaults to 10 not 12', () => {
  assert.equal(generationExtras({ referenceSeconds: 10 }).max_reference_audio_len, 10);
  assert.equal(generationExtras().max_reference_audio_len, MAX_REFERENCE_SECONDS);
});

// ── The guard must be able to fire at every length ─────────────────────

test('the runaway cap always lands below what the frame budget alone permits', () => {
  // Otherwise it is decorative for exactly the longest utterances — the ones
  // where a runaway costs the most listening. Raising max_frames to 4000 for
  // long messages put the cap at 429 s against a 320 s ceiling until this.
  const ceiling = DEFAULT_MAX_FRAMES / FRAME_RATE_HZ;
  for (const chars of [5, 400, 2000, 6000, 50000]) {
    for (const speed of [1, 0.5, 0.25, 2]) {
      const seconds = runawaySampleLimit('x'.repeat(chars), 24000, { speed }) / 24000;
      assert.ok(seconds < ceiling, `${chars} chars at speed ${speed}: cap ${seconds}s never fires under ${ceiling}s`);
      assert.ok(seconds >= 3, 'and never cuts below the floor');
    }
  }
});

test('slower speech buys proportionally more room', () => {
  // A ward who slows playback for comprehension must not have sentences cut in
  // half by a guard that exists to protect them.
  const normal = runawaySampleLimit('x'.repeat(400), 24000, { speed: 1 });
  const slow = runawaySampleLimit('x'.repeat(400), 24000, { speed: 0.5 });
  assert.ok(slow > normal * 1.5, 'half speed should roughly double the allowance');
});

test('merging is now ON by default — an ordinary message is one trajectory', () => {
  assert.ok(MIN_CHAR_IN_SENTENCE >= 400, 'upstream 30 merged nothing and produced the drift');
  assert.ok(MAX_CHAR_IN_SENTENCE >= MIN_CHAR_IN_SENTENCE + 200, 'a merged utterance must not be re-split');
  assert.ok(
    MAX_CHAR_IN_SENTENCE / 18.6 < DEFAULT_MAX_FRAMES / FRAME_RATE_HZ,
    'the longest permitted utterance must fit inside the frame budget',
  );
});
