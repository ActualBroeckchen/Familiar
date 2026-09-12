// providers.js — resolveReasoningEffort for always-on-thinking models (GLM-5.3+).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveReasoningEffort } from '../providers.js';

test('explicit low/high/max is honored for ANY provider (the ward\'s call)', () => {
  for (const provider of ['zai', 'zai-coding', 'nanogpt', 'google']) {
    assert.equal(resolveReasoningEffort({ provider, reasoningEffort: 'low' }), 'low');
    assert.equal(resolveReasoningEffort({ provider, reasoningEffort: 'high' }), 'high');
    assert.equal(resolveReasoningEffort({ provider, reasoningEffort: 'max' }), 'max');
  }
});

test('off/none → null (explicit opt-out) even on a z.ai connection', () => {
  assert.equal(resolveReasoningEffort({ provider: 'zai', reasoningEffort: 'off' }), null);
  assert.equal(resolveReasoningEffort({ provider: 'zai', reasoningEffort: 'none' }), null);
});

test('unset → auto-low ONLY for the always-on-thinking z.ai family', () => {
  // The fix's whole point: a GLM-5.3 (z.ai) connection with no setting stops
  // running at its own max default and gets low automatically.
  assert.equal(resolveReasoningEffort({ provider: 'zai' }), 'low');
  assert.equal(resolveReasoningEffort({ provider: 'zai-coding' }), 'low');
  // Other providers get nothing unless set — no unknown-param 400 risk on a
  // Gemini or a non-reasoning NanoGPT model.
  assert.equal(resolveReasoningEffort({ provider: 'nanogpt' }), null);
  assert.equal(resolveReasoningEffort({ provider: 'google' }), null);
  assert.equal(resolveReasoningEffort({ provider: 'zai', reasoningEffort: '' }), 'low');
});

test('case-insensitive + whitespace tolerant; garbage treated as unset', () => {
  assert.equal(resolveReasoningEffort({ provider: 'zai', reasoningEffort: ' LOW ' }), 'low');
  assert.equal(resolveReasoningEffort({ provider: 'google', reasoningEffort: 'HIGH' }), 'high');
  assert.equal(resolveReasoningEffort({ provider: 'zai', reasoningEffort: 'banana' }), 'low');   // unset-like → auto-low (zai)
  assert.equal(resolveReasoningEffort({ provider: 'google', reasoningEffort: 'banana' }), null); // unset-like → nothing
});

test('missing/blank connection never throws', () => {
  assert.equal(resolveReasoningEffort(), null);
  assert.equal(resolveReasoningEffort({}), null);
  assert.equal(resolveReasoningEffort({ provider: null }), null);
});
