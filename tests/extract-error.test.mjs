/**
 * Tests for extractErrorText() — the helper that turns OpenAI-
 * compatible structured error objects into readable strings instead
 * of "[object Object]".
 *
 * app.js is a classic browser script, not an ES module — so we can't
 * import the function. Instead we extract its source by brace-matching
 * from the file and eval it inside a fresh vm context. Brittle to
 * renames, robust to body changes (any number of nested braces). If
 * the function is ever renamed, this test fails loudly at load time.
 *
 * Run via: npm test
 */

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

// ── Extract the function from app.js by balanced-brace matching ──────

const APP_JS = new URL('../public/app.js', import.meta.url);
const src = readFileSync(APP_JS, 'utf8');

function extractFunctionSource(text, name) {
  const start = text.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`${name} not found in ${APP_JS.pathname}`);
  let depth = 0;
  let inBraces = false;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') { depth++; inBraces = true; }
    else if (text[i] === '}') {
      depth--;
      if (inBraces && depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const fnSrc = extractFunctionSource(src, 'extractErrorText');
const ctx = {};
runInNewContext(`${fnSrc};\nresult = extractErrorText;`, ctx);
const extractErrorText = ctx.result;
assert.equal(typeof extractErrorText, 'function');

// ── Tests ────────────────────────────────────────────────────────────

test('null payload returns fallback', () => {
  assert.equal(extractErrorText(null, 'default'), 'default');
});

test('undefined payload returns fallback', () => {
  assert.equal(extractErrorText(undefined, 'default'), 'default');
});

test('payload without .error returns fallback', () => {
  assert.equal(extractErrorText({}, 'default'), 'default');
  assert.equal(extractErrorText({ message: 'x' }, 'default'), 'default');
});

test('string .error is returned verbatim', () => {
  assert.equal(extractErrorText({ error: 'Plain string error' }, 'default'),
               'Plain string error');
});

test('object .error with .message prefers .message', () => {
  // The standard OpenAI-compatible shape.
  assert.equal(
    extractErrorText(
      { error: { message: 'Rate limit exceeded', type: 'rate_limit', code: 'rate_limit_exceeded' } },
      'default',
    ),
    'Rate limit exceeded',
  );
});

test('object .error without .message falls back to .code', () => {
  assert.equal(
    extractErrorText({ error: { code: 'invalid_request_error' } }, 'default'),
    'invalid_request_error',
  );
});

test('object .error with neither .message nor .code uses JSON', () => {
  const result = extractErrorText({ error: { detail: 'something else', http: 502 } }, 'default');
  assert.match(result, /detail/);
  assert.match(result, /something else/);
});

test('empty-string .message falls through to .code', () => {
  assert.equal(
    extractErrorText({ error: { message: '', code: 'fallthrough' } }, 'default'),
    'fallthrough',
  );
});

test('integration: the literal payload that caused [object Object] now renders cleanly', () => {
  // Reconstructing the actual provider error that produced the bug
  // report — nanogpt-style structured error inside a 4xx body.
  const result = extractErrorText(
    { error: { message: 'Invalid API key', type: 'authentication_error' } },
    'API error 401',
  );
  // The key assertion: it's a useful string, NOT "[object Object]".
  assert.equal(result, 'Invalid API key');
  assert.notEqual(result, '[object Object]');
});

test('regression guard: bare String(obj) coercion would produce [object Object]', () => {
  // This documents the bug we fixed. If extractErrorText is ever
  // simplified back to `data.error || fallback`, this test still
  // passes (extractErrorText returns the .message), but the assertion
  // captures the failure mode we were guarding against.
  const buggy = String({ error: { message: 'real message' } }.error);
  assert.equal(buggy, '[object Object]', 'sanity check on the bug we fixed');
});
