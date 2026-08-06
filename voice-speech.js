/**
 * Turning what I wrote into what I say (voice spec §11).
 *
 * What reaches the screen is markdown written to be READ: asterisks for
 * emphasis, backticks around identifiers, links with urls behind them,
 * headings made of hashes. Handing that to a speech model verbatim produces
 * "asterisk asterisk careful asterisk asterisk", which is not emphasis — it is
 * noise where the emphasis was.
 *
 * So there is a translation step, and it is lossy on purpose. The rule
 * throughout: keep what carries meaning aloud, drop what only carried
 * formatting on a screen.
 *
 * ── Code is summarised, not spelled out ─────────────────────────────────
 * A fenced block read character by character is unusable — minutes of
 * punctuation nobody can follow, with no way to skip. Saying that a code block
 * is there, and how long, lets someone decide to go look at it. Silently
 * skipping it would be worse than either: they would never know it existed.
 *
 * ── This is an accessibility surface ────────────────────────────────────
 * The people most likely to use read-aloud are the ones least able to fall
 * back on reading the screen when it goes wrong. That is why nothing here
 * throws, and why an empty result is reported as empty rather than sent to the
 * engine as a silent clip that looks like a failure.
 */

import { stripLlmTimestamps } from './message-sanitize.mjs';
import { MAX_CHAR_IN_SENTENCE, MIN_CHAR_IN_SENTENCE } from './voice-generation.js';

/**
 * Typographic characters the model's vocabulary does not contain.
 *
 * The tokenizer has 4000 tokens and holds ASCII `'`, `"` and `-`, but has NO
 * token containing a curly quote or an ellipsis. SentencePiece falls back to
 * raw byte tokens for those, so a perfectly ordinary apostrophe in "there's"
 * becomes three bytes the model has rarely seen in that position. That is a
 * quiet, cumulative destabiliser rather than an obvious failure, which is the
 * kind worth removing before it is ever noticed.
 *
 * The em-dash IS in the vocabulary, so it stays.
 */
const VOCAB_SAFE = [
  [/[‘’‚‛]/g, "'"],      // curly single quotes
  [/[“”„‟]/g, '"'],      // curly double quotes
  [/…/g, '...'],                         // ellipsis
  [/[‐‑‒–]/g, '-'],      // hyphens and en-dash (em-dash kept)
  [/[     ]/g, ' '], // non-breaking and thin spaces
  [/[​‌‍﻿]/g, ''],        // zero-width, invisible entirely
  [/[ʼ′]/g, "'"],                   // modifier apostrophe, prime
];

/**
 * Split a sentence that is too long for the engine to take whole.
 *
 * Upstream splits at `max_char_in_sentence` and drops whatever is left into
 * its own chunk with NO minimum size — which is how a 205-character sentence
 * produced the five-character fragment 'real.' and, through an EOS bug, forty
 * seconds of noise. See voice-generation.js for the full mechanism.
 *
 * This guarantees what upstream does not: every piece is at least
 * `minChars`. It prefers to break at a clause boundary (a comma, semicolon or
 * dash), because that is where a listener already expects a pause, and it
 * checks that BOTH sides clear the floor before accepting a break. A period
 * replaces the clause mark so the engine treats each piece as a whole
 * sentence and never re-splits it.
 *
 * The text is being altered, which is not free — a comma promoted to a full
 * stop is a slightly firmer pause than the writer intended. That is a small
 * and honest cost next to the alternative.
 */
export function capSentenceLength(text, { maxChars = MAX_CHAR_IN_SENTENCE - 20, minChars = MIN_CHAR_IN_SENTENCE + 10 } = {}) {
  if (typeof text !== 'string' || text.length <= maxChars) return text;

  const cut = (s) => {
    if (s.length <= maxChars) return [s];

    // Clause marks, then any space — searching back from the limit, and only
    // accepting a point that leaves enough on BOTH sides.
    for (const pattern of [/[,;:]\s|\s[—–-]\s/g, /\s/g]) {
      let best = -1;
      let match;
      pattern.lastIndex = 0;
      while ((match = pattern.exec(s)) !== null) {
        const at = match.index + match[0].length;
        if (at > maxChars) break;
        if (at >= minChars && s.length - at >= minChars) best = at;
      }
      if (best > 0) {
        const head = s.slice(0, best).trim().replace(/[,;:—–-]$/, '');
        return [`${head}.`, ...cut(s.slice(best).trim())];
      }
    }
    // Nothing safe to break on. Leaving it whole is better than manufacturing
    // a runt — the engine will split it, but at least not into a fragment
    // this code created.
    return [s];
  };

  return cut(text).join(' ');
}

/** Beyond this, one utterance is split even without punctuation to split on. */
const MAX_CHUNK_CHARS = 240;

/** Below this, a chunk is merged into its neighbour rather than spoken alone. */
const MIN_CHUNK_CHARS = 24;

/**
 * Abbreviations whose full stop does not end a sentence.
 *
 * Not exhaustive and cannot be — this is a heuristic, and its failure mode is
 * a pause in an odd place, which is survivable. Anything that tried harder
 * would be a sentence tokeniser, which is a large thing to own for a cosmetic
 * gain.
 */
const ABBREVIATIONS = [
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st',
  'e.g', 'i.e', 'etc', 'vs', 'approx', 'no',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
];

/**
 * Emoji and pictographs. Speech models either mangle these or say the CLDR
 * name aloud ("grinning face with smiling eyes"), and neither is what the
 * emoji meant.
 */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Markdown as spoken text.
 *
 * Returns `{ text, notes }` — `notes` names what was summarised rather than
 * read, so a caller can show it. Something removed silently is something my
 * human cannot know they missed.
 */
export function speakableText(input) {
  if (typeof input !== 'string' || !input.trim()) return { text: '', notes: [] };

  const notes = [];
  // Timestamps first: the repo rule is that an LLM-emitted [HH:MM] is a
  // hallucination artifact, and speaking one aloud would state a time nothing
  // measured.
  let s = stripLlmTimestamps(input);

  // Fenced code — summarised, never spelled out.
  s = s.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_m, lang, body) => {
    const lines = body.replace(/\n+$/, '').split('\n').length;
    const what = String(lang || '').trim();
    notes.push(`a code block (${plural(lines, 'line')}${what ? `, ${what}` : ''}) was not read out`);
    return ` (${what ? `${what} ` : ''}code block, ${plural(lines, 'line')}) `;
  });

  // Indented code blocks are ambiguous with wrapped prose, so they are left
  // alone deliberately — guessing wrong would mangle ordinary text.

  s = s
    // Images: the alt text is the only part that was ever meant for a person.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt) => (alt ? `image, ${alt}` : 'an image'))
    // Links: say the label, drop the url. Reading a url aloud is punctuation soup.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Inline code: keep the contents. These are usually a name worth hearing.
    .replace(/`([^`]+)`/g, '$1')
    // Emphasis markers, not the words inside them.
    .replace(/(\*\*\*|___)(.+?)\1/g, '$2')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    // Headings: the text is the point, the hashes were a size.
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    // Blockquote markers.
    .replace(/^\s{0,3}>\s?/gm, '')
    // Horizontal rules say nothing aloud.
    .replace(/^\s{0,3}([-*_])\s*(\1\s*){2,}$/gm, '')
    // Bullets: the marker is visual. A line break already reads as a pause.
    .replace(/^\s*[-*+]\s+/gm, '')
    // Numbered lists keep their numbers — "1." is information, not decoration.
    .replace(EMOJI, '')
    // Table pipes would otherwise be read as stray punctuation.
    .replace(/^\s*\|.*\|\s*$/gm, (row) => row.replace(/\|/g, ' ').trim())
    .replace(/[ \t]+/g, ' ')
    // Removing something mid-sentence — an emoji, an image, a marker — leaves
    // its spacing behind, and " ." is heard as a pause in the wrong place.
    // Close the gap rather than letting the removal be audible.
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Characters the vocabulary cannot represent as real tokens, before any
  // length work — the substitutions change lengths (… becomes ...).
  for (const [pattern, to] of VOCAB_SAFE) s = s.replace(pattern, to);

  // Then make sure no single sentence is long enough for the engine to split
  // it into a fragment. Done per sentence so a long message of ordinary
  // sentences is left completely alone.
  s = s
    .split(/(?<=[.!?])(\s+)/)
    .map((piece) => (/^\s+$/.test(piece) ? piece : capSentenceLength(piece)))
    .join('');

  return { text: s, notes };
}

/** Does this full stop end a sentence, or an abbreviation? */
function endsAbbreviation(text, dotIndex) {
  const before = text.slice(0, dotIndex).toLowerCase();
  const word = before.match(/([a-z.]+)$/)?.[1] ?? '';
  if (ABBREVIATIONS.includes(word)) return true;
  // A single letter before a dot is an initial: "J. R. R."
  return /(^|\s)[a-z]$/.test(before);
}

/**
 * Split into utterances the engine speaks one at a time.
 *
 * The engine is configured `maxNumSentences: 1`, and splitting here is what
 * makes streaming possible at all: measured RTF is below 1, so while one
 * utterance plays the next has time to render. Handing over the whole message
 * would mean waiting for all of it before hearing any of it.
 */
export function splitForSpeech(text, { maxChars = MAX_CHUNK_CHARS, minChars = MIN_CHUNK_CHARS } = {}) {
  if (typeof text !== 'string' || !text.trim()) return [];

  const out = [];
  let buf = '';

  const flush = () => {
    const t = buf.trim();
    if (t) out.push(t);
    buf = '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    buf += ch;

    const sentenceEnd = (ch === '.' || ch === '!' || ch === '?')
      && !(ch === '.' && endsAbbreviation(text, i))
      && (i + 1 >= text.length || /[\s"')\]]/.test(text[i + 1]));

    // A blank line is a paragraph break and a real pause.
    const paragraphEnd = ch === '\n' && text[i + 1] === '\n';

    if (sentenceEnd || paragraphEnd) {
      if (buf.trim().length >= minChars) flush();
      continue;
    }

    if (buf.length >= maxChars) {
      // No sentence boundary in reach. Break at the last clause boundary or
      // space rather than mid-word — a word cut in half is heard as an error,
      // while a slightly early pause is not.
      const cut = Math.max(buf.lastIndexOf(', '), buf.lastIndexOf('; '), buf.lastIndexOf(' — '), buf.lastIndexOf(' '));
      if (cut > minChars) {
        const rest = buf.slice(cut + 1);
        buf = buf.slice(0, cut + 1);
        flush();
        buf = rest;
      } else {
        flush();
      }
    }
  }
  flush();

  return out;
}

/**
 * How much text one generation may carry.
 *
 * Deliberately large. A whole message SHOULD be one generation — PocketTTS
 * clones zero-shot per call with no seed, so every extra generation is
 * another roll of the dice on what the voice sounds like. This cap exists
 * only so that a pathologically long message cannot ask the engine to hold
 * minutes of audio in memory at once, not to chop ordinary messages up.
 */
const MAX_GENERATION_CHARS = 5000;

/**
 * Split for GENERATION, which is a different question from splitting for
 * playback.
 *
 * Almost always returns one part. When it cannot, it breaks at paragraph
 * boundaries and then at sentences — a seam where the voice may shift is far
 * less jarring between paragraphs than mid-thought, and a seam is exactly
 * what a second generation costs.
 */
export function splitForGeneration(text, { maxChars = MAX_GENERATION_CHARS } = {}) {
  if (typeof text !== 'string' || !text.trim()) return [];
  if (text.length <= maxChars) return [text.trim()];

  const parts = [];
  let buf = '';
  for (const para of text.split(/\n{2,}/)) {
    const candidate = buf ? `${buf}\n\n${para}` : para;
    if (candidate.length <= maxChars) { buf = candidate; continue; }
    if (buf) { parts.push(buf.trim()); buf = ''; }

    if (para.length <= maxChars) { buf = para; continue; }
    // A single paragraph over the cap: fall back to sentences, packed as
    // full as they will go so there are as few seams as possible.
    let sub = '';
    for (const sentence of splitForSpeech(para, { maxChars: maxChars, minChars: 1 })) {
      const next = sub ? `${sub} ${sentence}` : sentence;
      if (next.length <= maxChars) sub = next;
      else { if (sub) parts.push(sub.trim()); sub = sentence; }
    }
    if (sub) buf = sub;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.filter(Boolean);
}

/**
 * Everything at once: markdown in, generation units out.
 *
 * `spoken` is the text actually sent to the engine, kept so a caller can show
 * what was said rather than what was written — they differ, and that
 * difference is the whole point of this module.
 *
 * `parts` is normally length 1. `seams` counts the places where a second
 * generation had to start, which is the number of points a listener might
 * hear the voice shift. Reported rather than hidden: an unavoidable seam is
 * survivable, an unexplained one sounds like a bug.
 */
export function prepareForSpeech(input, opts = {}) {
  const { text, notes } = speakableText(input);
  const parts = splitForGeneration(text, opts);
  return {
    parts,
    seams: Math.max(0, parts.length - 1),
    spoken: text,
    notes,
    empty: parts.length === 0,
  };
}

/**
 * Split a message into pieces that are each EXACTLY one engine utterance.
 *
 * ── Why do this ourselves ───────────────────────────────────────────────
 * Handed a whole message, sherpa splits it internally (SplitByPunctuation →
 * MergeShortSentences → SplitLongSentence) and returns one lump of audio. If
 * one of those internal utterances renders empty or stops early — which it
 * does; `Generate` skips a sentence that produced no samples without a word —
 * the words are simply gone and nothing says which ones.
 *
 * Doing the same split up here costs nothing acoustically, because the LM state
 * resets per utterance either way (measured: one call 27.68 s vs the same split
 * as separate calls 28.16 s, 1.7% apart). What it buys is that each utterance
 * comes back with its own duration, so a render that swallowed its text can be
 * SEEN and re-tried, instead of arriving as a hole my human notices before I do.
 *
 * ── And it fixes the runt ───────────────────────────────────────────────
 * `MergeShortSentences` pushes whatever is left in its buffer as a final chunk,
 * however short — so a trailing "Great." becomes an utterance of its own, which
 * is the documented EOS-at-step-0 trigger. Here a leftover too small to stand
 * alone is merged back into the previous piece instead.
 */
export function splitForUtterances(text, { targetChars = MIN_CHAR_IN_SENTENCE } = {}) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const target = Math.max(1, Number(targetChars) || MIN_CHAR_IN_SENTENCE);
  // The smallest piece worth generating alone. Below this the model is being
  // handed a fragment, which is where it misbehaves.
  const minStandalone = Math.max(40, Math.floor(target / 4));

  const sentences = splitForSpeech(text, { maxChars: MAX_CHAR_IN_SENTENCE - 20, minChars: 1 });
  const out = [];
  let buf = '';
  for (const s of sentences) {
    buf = buf ? `${buf} ${s}` : s;
    if (buf.length >= target) { out.push(buf); buf = ''; }
  }
  if (buf) {
    // A leftover that can stand on its own becomes a piece; one that cannot is
    // folded back rather than handed over as a runt.
    if (buf.length >= minStandalone || out.length === 0) out.push(buf);
    else out[out.length - 1] = `${out[out.length - 1]} ${buf}`;
  }
  return out;
}
