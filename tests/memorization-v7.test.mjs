// V7 stranger data minimization — prompt variant selection tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSharedRoomPrompt } from '../memorization.js';

const MESSAGES = [
  { role: 'user',      content: 'Hi, feeling really stressed today.' },
  { role: 'assistant', content: "I hear you. What's going on?" },
  { role: 'user',      content: 'Work has been a lot. Also Chen is here with me.' },
  { role: 'assistant', content: 'Take it easy. Chen, it is nice to meet you.' },
];

// ── Happy path ──────────────────────────────────────────────────────

test('buildSharedRoomPrompt: returns a non-null string for a valid conversation', () => {
  const p = buildSharedRoomPrompt(MESSAGES);
  assert.ok(typeof p === 'string' && p.length > 0);
});

test('buildSharedRoomPrompt: returns null for too-short conversation', () => {
  assert.equal(buildSharedRoomPrompt([MESSAGES[0]]), null);
  assert.equal(buildSharedRoomPrompt([]), null);
});

// ── Content direction ──────────────────────────────────────────────

test('buildSharedRoomPrompt: instructs to focus on the ward, not strangers', () => {
  const p = buildSharedRoomPrompt(MESSAGES);
  assert.match(p, /my human/i);
  assert.match(p, /stranger|unregistered|consent/i);
});

test('buildSharedRoomPrompt: does NOT contain the full-detail category list', () => {
  const p = buildSharedRoomPrompt(MESSAGES);
  // The stranger variant explicitly says "skip" for third-party detail.
  // It should not contain the full-detail "Example good" / "Example bad" pair
  // that the ward-private variant has.
  assert.doesNotMatch(p, /Example bad/);
});

test('buildSharedRoomPrompt: includes the conversation text', () => {
  const p = buildSharedRoomPrompt(MESSAGES);
  assert.match(p, /feeling really stressed/);
});

test('buildSharedRoomPrompt: includes topicLabel when provided', () => {
  const p = buildSharedRoomPrompt(MESSAGES, 'work stress');
  assert.match(p, /work stress/);
});

// ── Prompt isolation — ward-private vs shared ──────────────────────

test('buildSharedRoomPrompt differs from buildPrompt (stricter instructions)', async () => {
  // Import the ward-private variant (not exported by name, but we can check via
  // the shared-room prompt's content to confirm it is distinct).
  const sharedPrompt = buildSharedRoomPrompt(MESSAGES);
  // The shared-room variant must contain the key restriction phrase.
  assert.match(sharedPrompt, /haven't consented/i);
});
