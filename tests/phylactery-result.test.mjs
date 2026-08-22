import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mcpToolError } from '../phylactery-result.js';

// The bug this guards: an MCP tool reports failure as an isError result OR a
// plain "Failed: …" string — neither throws (the SDK's callTool resolves an
// isError result) — so a wrapper that doesn't inspect the result reads a failed
// write as success (identity_update_section silently answered {ok:true} while
// nothing was written; the same swallow lived in the Unruh write wrappers).

test('an isError result is a failure, carrying its text', () => {
  const r = { isError: true, content: [{ type: 'text', text: 'Input validation error: section required' }] };
  assert.equal(mcpToolError(r), 'Input validation error: section required');
});

test('an isError result with no text still reports a failure', () => {
  assert.equal(mcpToolError({ isError: true, content: [] }), 'MCP tool reported an error');
  assert.equal(mcpToolError({ isError: true }), 'MCP tool reported an error');
});

test('a plain "Failed: …" string is a failure even without isError', () => {
  const r = { content: [{ type: 'text', text: 'Failed: no such section' }] };
  assert.equal(mcpToolError(r), 'Failed: no such section');
  // the "Failed -" variant too
  assert.equal(mcpToolError({ content: [{ type: 'text', text: 'Failed - bad path' }] }), 'Failed - bad path');
});

test('a success string is NOT a failure', () => {
  assert.equal(mcpToolError({ content: [{ type: 'text', text: "Section 'Caring' of self/values.md rewritten." }] }), null);
});

test('the word "failed" mid-sentence is not a false positive', () => {
  // Only a LEADING "Failed:" is the tools' failure convention.
  assert.equal(mcpToolError({ content: [{ type: 'text', text: 'The last attempt failed, but this one worked.' }] }), null);
});

test('an empty / shapeless result is not a failure (nothing to report)', () => {
  assert.equal(mcpToolError({}), null);
  assert.equal(mcpToolError(null), null);
  assert.equal(mcpToolError({ content: [] }), null);
});
