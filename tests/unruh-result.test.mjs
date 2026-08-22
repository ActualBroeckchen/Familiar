import { test } from 'node:test';
import assert from 'node:assert/strict';

import { unruhResult } from '../thalamus.js';

// The bug this guards: the MCP SDK's callTool does NOT throw when an Unruh tool
// raises (a pydantic error from a bad/missing arg, or any exception) — it
// resolves with isError:true — so a write wrapper that returned
// parseToolText(r, { ok: true }) reported SUCCESS on failure, because the error
// text isn't the tool's normal JSON and fell through to the {ok:true} fallback.
// unruhResult() surfaces the failure honestly instead.

test('an isError result becomes an honest { ok: false, error }', () => {
  const r = { isError: true, content: [{ type: 'text', text: 'ValidationError: topic required' }] };
  const out = unruhResult(r);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'ValidationError: topic required');
});

test('an isError result with no text still fails (no silent success)', () => {
  const out = unruhResult({ isError: true });
  assert.equal(out.ok, false);
  assert.ok(out.error); // some error text, not {ok:true}
});

test('a normal JSON success payload passes through, carrying its own ok', () => {
  const r = { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: 'tea-ritual-x7' }) }] };
  const out = unruhResult(r);
  assert.equal(out.ok, true);
  assert.equal(out.id, 'tea-ritual-x7');
});

test('a tool that deliberately returns ok:false is preserved, not overwritten', () => {
  const r = { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'no such node' }) }] };
  const out = unruhResult(r);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'no such node');
});

test('a contentless success falls back to the assume-ok default (already known non-error)', () => {
  // No isError, no text — the call resolved cleanly with an empty body.
  const out = unruhResult({});
  assert.equal(out.ok, true);
});

test('a leading "Failed:" string is treated as a failure even without isError', () => {
  const r = { content: [{ type: 'text', text: 'Failed: could not write' }] };
  const out = unruhResult(r);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'Failed: could not write');
});
