/**
 * Cross-store refs (temporal-bridges Piece 2) — the memorization prompt side.
 *
 * When a schedule legend is provided, buildPrompt exposes an optional
 * schedule_refs field + the legend; when it's absent, the prompt is byte-for-
 * byte the pre-Piece-2 prompt (backward compatibility). The code-side
 * validation (only legend ids survive) is exercised by construction here via
 * the legend the prompt advertises.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../src/memory/memorization.js';

const MSGS = [
  { role: 'user', content: 'I had my therapy session with Kleinschmidt today and it went badly.' },
  { role: 'assistant', content: 'That sounds really hard. Do you want to talk about it?' },
];

test('no legend → prompt omits schedule_refs entirely (backward compatible)', () => {
  const p = buildPrompt(MSGS, null, 'Chen');
  assert.ok(p, 'prompt built');
  assert.doesNotMatch(p, /schedule_refs/);
  assert.doesNotMatch(p, /Schedule legend/);
});

test('legend present → prompt advertises schedule_refs and lists only legend ids', () => {
  const legend = [
    { id: 'kleinschmidt-session-x7', label: 'Kleinschmidt session', type: 'event' },
    { id: 'dinner-q2', label: 'dinner', type: 'event' },
  ];
  const p = buildPrompt(MSGS, null, 'Chen', legend);
  assert.match(p, /schedule_refs/);
  assert.match(p, /Schedule legend/);
  assert.match(p, /Kleinschmidt session \[event\] = kleinschmidt-session-x7/);
  assert.match(p, /dinner \[event\] = dinner-q2/);
  // The instruction that pins the model to legend ids only.
  assert.match(p, /ONLY ids that appear in the legend/);
});

test('legend entries without id or label are skipped', () => {
  const legend = [
    { id: 'ok-1', label: 'Good one', type: 'task' },
    { label: 'no id' },
    { id: 'no-label' },
  ];
  const p = buildPrompt(MSGS, null, 'Chen', legend);
  assert.match(p, /Good one \[task\] = ok-1/);
  assert.doesNotMatch(p, /no id/);
  assert.doesNotMatch(p, /no-label/);
});

test('legend is capped at 30 entries', () => {
  const legend = Array.from({ length: 50 }, (_, i) => ({ id: `n-${i}`, label: `Item ${i}`, type: 'task' }));
  const p = buildPrompt(MSGS, null, 'Chen', legend);
  assert.match(p, /Item 0 \[task\] = n-0/);
  assert.match(p, /Item 29 \[task\] = n-29/);
  assert.doesNotMatch(p, /= n-30\b/);
});
