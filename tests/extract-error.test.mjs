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

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFunction } from './_vm-extract.mjs';

// Extract extractErrorText from app.js (a classic browser script, not
// importable) and eval it in a fresh vm context.
const APP_JS = new URL('../public/app.js', import.meta.url);
const extractErrorText = loadFunction(APP_JS, 'extractErrorText');

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
