// The prompt-catalog extractor — the one piece of non-trivial logic in the
// generator. It lifts a prompt from source by a unique anchor at a literal's
// start, handling escapes, ${…} interpolation (incl. a nested template inside
// an interpolation), and adjacent "a" + `b` concatenation — and refuses, loudly,
// anything ambiguous (a stale anchor must never yield a silent empty block).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanLiteral, extractPrompt } from '../scripts/build-prompt-catalog.mjs';

test('scanLiteral: plain template literal', () => {
  const src = 'x = `hello world`;';
  const open = src.indexOf('`');
  const r = scanLiteral(src, open, '`');
  assert.equal(r.content, 'hello world');
});

test('scanLiteral: interpolation with a nested template inside it', () => {
  // The reflection prompt shape: ${cond ? `\n${x}` : ''} must not close early
  // on the INNER backtick — only the outer one at depth 0 closes.
  const src = 'const p = `start ${a ? `\\n${b}` : \'\'} end`;';
  const open = src.indexOf('`');
  const r = scanLiteral(src, open, '`');
  assert.match(r.content, /^start /);
  assert.match(r.content, / end$/, 'captured through to the OUTER close, not the nested backtick');
});

test('scanLiteral: escapes do not terminate early', () => {
  const src = 'x = "a\\"b";';
  const open = src.indexOf('"');
  const r = scanLiteral(src, open, '"');
  assert.equal(r.content, 'a\\"b');
});

test('extractPrompt: folds adjacent string concatenation', () => {
  const src = 'const D =\n  "one " +\n  "two " +\n  `three`;';
  const r = extractPrompt(src, 'one ', 'concat');
  assert.equal(r.text, 'one two three');
  assert.equal(r.line, 2, 'line of the opening literal');
});

test('extractPrompt: throws on a missing anchor', () => {
  assert.throws(() => extractPrompt('x = `hi`;', 'nope', 'missing'), /anchor not found/);
});

test('extractPrompt: throws when the anchor is not unique', () => {
  assert.throws(() => extractPrompt('a=`dup`; b=`dup`;', 'dup', 'dup'), /not unique/);
});

test('extractPrompt: throws when the anchor is not at a literal start', () => {
  // "world" sits mid-literal, so the char before it is a letter, not a delimiter.
  assert.throws(() => extractPrompt('x = `hello world`;', 'world', 'midlit'), /not at a literal start/);
});
