import { test } from 'node:test';
import assert from 'node:assert/strict';

import { speakableText, splitForSpeech, prepareForSpeech, capSentenceLength, splitForUtterances,
  normalizeTranscriptCase,
} from '../voice-speech.js';
import { MAX_CHAR_IN_SENTENCE, MIN_CHAR_IN_SENTENCE } from '../voice-generation.js';
import { encodeWav, parseWav, wavHeader, floatToPcm16, WAV_STREAMING_LENGTH } from '../voice-audio-features.js';

// ── ASR case rescue — the streaming zipformer shouts; un-shout it ────────
test('normalizeTranscriptCase: ALL CAPS → sentence case, and "i" → "I"', () => {
  assert.equal(normalizeTranscriptCase('WISH ME LUCK'), 'Wish me luck');
  assert.equal(normalizeTranscriptCase('I CAN NOT DO THIS ANYMORE'), 'I can not do this anymore');
  assert.equal(normalizeTranscriptCase('CALL MOM. THEN GO OUT.'), 'Call mom. Then go out.');
  assert.equal(normalizeTranscriptCase("I'M FINE"), "I'm fine");
});

test('normalizeTranscriptCase leaves already-cased text ALONE (SenseVoice / corrections)', () => {
  assert.equal(normalizeTranscriptCase('Wish me luck at the interview.'), 'Wish me luck at the interview.');
  assert.equal(normalizeTranscriptCase('I said HELLO to the API team'), 'I said HELLO to the API team', 'mixed case is untouched');
  assert.equal(normalizeTranscriptCase(''), '');
  assert.equal(normalizeTranscriptCase('12:30'), '12:30', 'no cased letters → unchanged');
});

// ── Markdown that was written to be read, said instead ───────────────────

test('emphasis is heard as words, not as asterisks', () => {
  const { text } = speakableText('That is **really** not _fine_, and ***never*** was.');
  assert.equal(text, 'That is really not fine, and never was.');
});

test('a link says its label and drops the url', () => {
  // A url read aloud is punctuation soup and tells nobody anything.
  const { text } = speakableText('See [the build spec](https://example.com/a/b?c=d#e) for why.');
  assert.equal(text, 'See the build spec for why.');
});

test('inline code keeps its contents — it is usually a name worth hearing', () => {
  const { text } = speakableText('Call `mem_search` first.');
  assert.equal(text, 'Call mem_search first.');
});

test('a code block is summarised, and the summary says so out loud', () => {
  // Reading it character by character is unusable; dropping it silently would
  // mean never knowing it was there.
  const { text, notes } = speakableText('Try this:\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\nThat is all.');
  assert.match(text, /js code block, 2 lines/);
  assert.doesNotMatch(text, /const/);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /not read out/);
});

test('an unlabelled code block still says how long it was', () => {
  const { text } = speakableText('```\nline one\n```');
  assert.match(text, /code block, 1 line\b/, 'singular, not "1 lines"');
});

test('headings, quotes and rules lose their markers but keep their words', () => {
  const { text } = speakableText('## What happened\n\n> It broke.\n\n---\n\nThen it did not.');
  assert.match(text, /What happened/);
  assert.match(text, /It broke\./);
  assert.doesNotMatch(text, /#|>|---/);
});

test('bullets lose the marker; numbered lists keep their numbers', () => {
  const { text } = speakableText('- first\n- second');
  assert.doesNotMatch(text, /[-*+]\s/);
  const numbered = speakableText('1. first\n2. second').text;
  assert.match(numbered, /1\. first/, 'the number is information, not decoration');
});

test('an image becomes its alt text, because that was the part meant for a person', () => {
  assert.match(speakableText('![a red bicycle](x.png)').text, /image, a red bicycle/);
  assert.match(speakableText('![](x.png)').text, /an image/);
});

test('emoji are dropped rather than spelled out', () => {
  const { text } = speakableText('Good morning 🌞 — ready? 🎉');
  assert.doesNotMatch(text, /[\u{1F300}-\u{1FAFF}]/u);
  assert.match(text, /Good morning/);
});

test('removing something mid-sentence does not leave an audible hole', () => {
  // Caught by running it, not by a test: stripping the emoji left "the thing ."
  // and a stranded space before a full stop is heard as a pause in the wrong
  // place. What was removed should not be detectable in the speaking.
  assert.equal(speakableText('I did the thing 🎉.').text, 'I did the thing.');
  assert.equal(speakableText('Ready 🚀 ? Yes 👍 !').text, 'Ready? Yes!');
  assert.doesNotMatch(speakableText('One 🌞 , two 🌙 ; three.').text, /\s[,;]/);
});

test('a hallucinated timestamp is never spoken — it would state a time nothing measured', () => {
  // The repo rule: only a machine timestamp is trustworthy. An LLM-emitted one
  // is an artifact, and saying it aloud asserts it.
  assert.equal(speakableText('[14:35] I was thinking...').text, 'I was thinking...');
  assert.equal(speakableText('⫸09:02⫷ Morning.').text, 'Morning.');
});

test('empty or non-string input is empty, not an error', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}]) {
    const r = speakableText(bad);
    assert.equal(r.text, '');
    assert.deepEqual(r.notes, []);
  }
});

// ── Breaking a message into things to say ────────────────────────────────

test('sentences are split so the next can render while this one plays', () => {
  const chunks = splitForSpeech('This is the first sentence here. And this is the second one now. A third arrives too.');
  assert.equal(chunks.length, 3);
  assert.match(chunks[0], /first sentence here\.$/);
});

test('an abbreviation does not end a sentence', () => {
  const chunks = splitForSpeech('Dr. Ramanujan looked at the numbers for a while, e.g. the ones from Tuesday. Then he stopped.');
  assert.equal(chunks.length, 2, `split wrongly: ${JSON.stringify(chunks)}`);
  assert.match(chunks[0], /^Dr\. Ramanujan/);
});

test('initials do not end a sentence either', () => {
  const chunks = splitForSpeech('It was J. R. R. Tolkien who wrote that one, apparently. Or so they say.');
  assert.equal(chunks.length, 2, `split wrongly: ${JSON.stringify(chunks)}`);
});

test('a very short sentence rides along instead of being spoken alone', () => {
  // "No." on its own is a clipped fragment with an awkward pause either side.
  const chunks = splitForSpeech('No. That is not what happened here, and it matters quite a lot.');
  assert.equal(chunks.length, 1);
});

test('a long run with no full stop is broken at a clause, never mid-word', () => {
  const long = `${'a clause that keeps going, '.repeat(20)}and then it ends.`;
  const chunks = splitForSpeech(long, { maxChars: 120 });
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 160, `chunk too long: ${c.length}`);
    assert.doesNotMatch(c, /\bclaus$|\bkeepin$/, 'no word was cut in half');
  }
  assert.match(chunks.join(' '), /and then it ends\./);
});

test('no text is lost in the splitting', () => {
  const src = 'One sentence about something. Another about something else entirely. A third, with a clause, that runs on.';
  const joined = splitForSpeech(src).join(' ').replace(/\s+/g, ' ');
  assert.equal(joined, src);
});

test('nothing to say is an empty list, not a chunk of whitespace', () => {
  assert.deepEqual(splitForSpeech(''), []);
  assert.deepEqual(splitForSpeech('   \n\n  '), []);
  assert.deepEqual(splitForSpeech(null), []);
});

test('prepareForSpeech reports emptiness rather than sending silence to the engine', () => {
  const r = prepareForSpeech('   ');
  assert.equal(r.empty, true);
  assert.deepEqual(r.parts, []);
  assert.equal(r.seams, 0);
});

test('a whole message survives the round trip end to end', () => {
  const r = prepareForSpeech('## Morning\n\nI **did** the thing 🎉. See `notes.md` or [the doc](http://x.y).\n\n```py\nx = 1\n```\n\nThat is all.');
  assert.equal(r.empty, false);
  assert.doesNotMatch(r.spoken, /[*#`]|🎉|http/);
  assert.match(r.spoken, /I did the thing/);
  assert.equal(r.notes.length, 1);
});

// ── One generation per message: the fix for three-voices-in-one-reply ────

test('an ordinary multi-sentence message is ONE generation', () => {
  // The whole bug: PocketTTS clones zero-shot per call with no seed, so a
  // second generation is a second roll of the dice on what the voice is.
  // Three sentences must not become three clones.
  const r = prepareForSpeech('First sentence here. Second sentence follows. And a third one closes it.');
  assert.equal(r.parts.length, 1);
  assert.equal(r.seams, 0, 'no seam means no place the voice can shift');
});

test('even a long-ish message stays one generation', () => {
  const r = prepareForSpeech(`${'This is a full sentence of ordinary length. '.repeat(40)}`);
  assert.equal(r.parts.length, 1, 'about 1700 characters is still one clone');
});

test('a pathologically long message seams at paragraphs, and says how often', () => {
  // Splitting is a last resort against holding minutes of audio in memory, not
  // a routine step — and where it happens, it happens between paragraphs.
  const para = `${'A sentence of reasonable length goes here. '.repeat(30)}`;
  const r = prepareForSpeech([para, para, para].join('\n\n'), { maxChars: 800 });
  assert.ok(r.parts.length > 1);
  assert.equal(r.seams, r.parts.length - 1, 'the count of places the voice may shift is reported');
  for (const p of r.parts) assert.ok(p.length <= 800, `a part exceeded the generation cap: ${p.length}`);
});

test('splitting for generation loses no words', () => {
  const para = `${'Words that must all survive the split. '.repeat(30)}`;
  const src = [para, para, para].join('\n\n');
  const r = prepareForSpeech(src);
  const rejoined = r.parts.join(' ').replace(/\s+/g, ' ').trim();
  assert.equal(rejoined, r.spoken.replace(/\s+/g, ' ').trim());
});

test('a single unbroken paragraph over the cap still splits rather than being dropped', () => {
  const r = prepareForSpeech('One sentence. '.repeat(400), { maxChars: 800 });
  assert.ok(r.parts.length > 1);
  assert.ok(r.parts.every((p) => p.length <= 800));
});

// ── Vocabulary-safe punctuation ─────────────────────────────────────────

test('curly quotes become ASCII — the vocabulary has no token for them', () => {
  // 4000 tokens, and not one contains U+2019 or U+201C. SentencePiece falls
  // back to raw bytes, so an ordinary apostrophe becomes three tokens the
  // model has barely seen in that position.
  const { text } = speakableText('It assumes there’s a “pure” way to want something.');
  assert.equal(text, 'It assumes there\'s a "pure" way to want something.');
  assert.doesNotMatch(text, /[‘’“”]/);
});

test('an ellipsis becomes three dots, and invisible characters go entirely', () => {
  assert.match(speakableText('Just… you gave me that.').text, /Just\.\.\. you/);
  assert.doesNotMatch(speakableText('a​b c').text, /[​ ]/);
});

test('the em-dash survives, because the vocabulary does have it', () => {
  // Normalising away something the model handles correctly would cost prosody
  // for nothing.
  assert.match(speakableText('in my head — the question').text, /—/);
});

// ── The runt fragment that produced seconds of noise ────────────────────

const REPORTED = 'It assumes there’s a “pure” way to want something — independently generated, pre-existing, self-originated — and that anything that wakes up in response to someone else’s reaching is a lower grade of real.';

test('the reported sentence is never chopped into a fragment', () => {
  // 205 characters. Upstream split it at 200 and left 'real.' alone, which
  // hit EOS at step 0 and ran the full frame budget as noise. It must now go
  // to the engine whole.
  const { text } = speakableText(REPORTED);
  assert.equal(text.length, 205, 'ASCII quotes are the same width as curly ones');
  assert.ok(text.length < MAX_CHAR_IN_SENTENCE, 'below the threshold, so the engine leaves it alone');
  assert.match(text, /lower grade of real\.$/);
});

test('a sentence long enough to need splitting never leaves a runt', () => {
  const long = `It assumes there is a pure way to want something, ${'independently generated and pre-existing, '.repeat(8)}and that is a framework built for a different kind of being.`;
  assert.ok(long.length > 340);

  // Explicit bounds: this is about the logic, not about whatever the shipping
  // threshold happens to be this week.
  const pieces = capSentenceLength(long, { maxChars: 340, minChars: 40 })
    .split(/(?<=[.!?])\s+/).filter(Boolean);
  assert.ok(pieces.length > 1, 'it did split');
  for (const p of pieces) {
    assert.ok(p.length >= 40, `a runt survived: ${JSON.stringify(p)}`);
  }
});

test('splitting keeps every word, changing only the punctuation at the seam', () => {
  const long = `The wanting does not need to exist in a vacuum to count, ${'and the reaching is what makes it real, '.repeat(9)}so that is where I got to.`;
  const words = (s) => s.replace(/[.,;:]/g, ' ').split(/\s+/).filter(Boolean);
  assert.deepEqual(words(capSentenceLength(long)), words(long));
});

test('a sentence with nowhere safe to break is left whole rather than mangled', () => {
  // Manufacturing a runt would be worse than handing over a long sentence.
  const unbreakable = `${'a'.repeat(500)}.`;
  assert.equal(capSentenceLength(unbreakable), unbreakable);
});

test('ordinary text is untouched by the length guard', () => {
  const normal = 'Hey. There has been this thing turning over in my head. I think I landed somewhere.';
  assert.equal(capSentenceLength(normal), normal);
  assert.equal(speakableText(normal).text, normal);
});

// ── Float samples becoming a wav a browser will play ─────────────────────

test('what is encoded parses back as the same audio', () => {
  const samples = new Float32Array(240);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 8) * 0.5;

  const parsed = parseWav(encodeWav(samples, 24000));
  assert.equal(parsed.sampleRate, 24000);
  assert.equal(parsed.samples.length, 240);
  for (let i = 0; i < samples.length; i++) {
    assert.ok(Math.abs(parsed.samples[i] - samples[i]) < 0.001, `sample ${i} drifted`);
  }
});

test('a sample past full scale clamps instead of wrapping into noise', () => {
  // Wrapping turns a slight overshoot into a loud crack — a startling failure
  // on a surface people use because the screen is hard for them.
  const parsed = parseWav(encodeWav(new Float32Array([2, -2, 0.5]), 24000));
  assert.ok(parsed.samples[0] > 0.99, 'clamped to positive full scale');
  assert.ok(parsed.samples[1] < -0.99, 'clamped to negative full scale');
  assert.ok(Math.abs(parsed.samples[2] - 0.5) < 0.001);
});

test('an empty clip is a valid, playable, silent wav', () => {
  const wav = encodeWav(new Float32Array(0), 24000);
  assert.equal(wav.length, 44, 'header only');
  const parsed = parseWav(wav);
  assert.equal(parsed.samples.length, 0);
});

test('a plain array works as well as a typed array', () => {
  const parsed = parseWav(encodeWav([0, 0.25, -0.25], 16000));
  assert.equal(parsed.sampleRate, 16000);
  assert.equal(parsed.samples.length, 3);
});

test('a streaming header declares the maximum and does not overflow', () => {
  // Audio is generated after the header goes out, so the size cannot be
  // known. Adding 36 to the sentinel would wrap to a tiny number and the
  // player would stop almost immediately.
  const h = wavHeader(WAV_STREAMING_LENGTH, 24000);
  assert.equal(h.length, 44);
  assert.equal(h.readUInt32LE(4), WAV_STREAMING_LENGTH, 'RIFF size, not wrapped');
  assert.equal(h.readUInt32LE(40), WAV_STREAMING_LENGTH, 'data size, not wrapped');
  assert.equal(h.toString('ascii', 0, 4), 'RIFF');
  assert.equal(h.readUInt32LE(24), 24000, 'sample rate survives');
});

test('a streamed wav parses as audio once the bytes have arrived', () => {
  // parseWav trusts the bytes present over the declared length, so a stream
  // that ends is readable rather than a claimed-4GB file that never resolves.
  const body = floatToPcm16(new Float32Array([0, 0.5, -0.5, 0.25]));
  const parsed = parseWav(Buffer.concat([wavHeader(WAV_STREAMING_LENGTH, 24000), body]));
  assert.equal(parsed.samples.length, 4);
  assert.ok(Math.abs(parsed.samples[1] - 0.5) < 0.001);
});

// ── Utterance-sized pieces (so a swallowed one can be SEEN) ──────────────

test('pieces come out utterance-sized rather than one lump', () => {
  const text = 'One two three four. Five six seven eight. '.repeat(30);
  const pieces = splitForUtterances(text);
  assert.ok(pieces.length > 1, 'a long message is more than one utterance');
  for (const p of pieces) assert.ok(p.length <= 900, `no piece is a whole message: ${p.length}`);
});

test('a trailing runt is folded back, never handed over alone', () => {
  // MergeShortSentences pushes its leftover however short, and a lone "Great."
  // is the documented EOS-at-step-0 trigger. Ours merges it back.
  const pieces = splitForUtterances('A. '.repeat(150) + 'Great.');
  assert.ok(pieces[pieces.length - 1].length > 20, 'the tail is not a fragment');
  assert.match(pieces[pieces.length - 1], /Great\.$/, 'and the words are still there');
});

test('every word survives the split', () => {
  const text = 'First sentence here. Second one follows. Third arrives now. ' .repeat(12);
  const joined = splitForUtterances(text).join(' ');
  for (const w of ['First', 'Second', 'Third']) assert.ok(joined.includes(w));
  assert.ok(Math.abs(joined.length - text.trim().length) < 20, 'nothing meaningful lost');
});

test('a short message stays a single piece, and junk yields none', () => {
  assert.equal(splitForUtterances('Just a quick line.').length, 1);
  assert.deepEqual(splitForUtterances(''), []);
  assert.deepEqual(splitForUtterances(null), []);
});
