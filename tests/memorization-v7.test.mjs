// V7 stranger data minimization — prompt variant selection tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSharedRoomPrompt, buildPrompt } from '../src/memory/memorization.js';

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

test('buildSharedRoomPrompt: names the shared-room setting and defers to the consent step', () => {
  const p = buildSharedRoomPrompt(MESSAGES);
  assert.match(p, /my human/i);
  // No longer pre-censors strangers — it extracts freely and lets the separate
  // consent step decide what's kept about other people.
  assert.match(p, /consent step/i);
  assert.match(p, /shared room/i);
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

test('buildSharedRoomPrompt differs from buildPrompt (shared-room framing)', async () => {
  const sharedPrompt = buildSharedRoomPrompt(MESSAGES);
  const wardPrompt = buildPrompt(MESSAGES);
  // The shared-room variant is the one that names the room + the consent step.
  assert.match(sharedPrompt, /shared room/i);
  assert.doesNotMatch(wardPrompt, /shared room/i);
});

test('both prompts author names as macros and forbid third-person self-reference', () => {
  for (const p of [buildPrompt(MESSAGES), buildSharedRoomPrompt(MESSAGES)]) {
    assert.match(p, /\{\{user\}\}/);        // {{user}}, resolved at the call site
    assert.doesNotMatch(p, /\bEury\b/);     // never a hard-coded instance name
    assert.match(p, /third person/i);       // the first-person self rule
  }
  // The ward prompt's bad-example uses the {{char}} macro, not a literal name.
  assert.match(buildPrompt(MESSAGES), /\{\{char\}\} agreed to help/);
});

test('both prompts carry the fictional-character allowance', () => {
  for (const p of [buildPrompt(MESSAGES), buildSharedRoomPrompt(MESSAGES)]) {
    assert.match(p, /fictional/);
    assert.match(p, /Sailor Moon|show, game, book/i);
  }
});

// ── Content tag (Phase 3b — the recall-gating axis) ────────────────

test('both prompts ask for a content_tag with the topic vocabulary and levels', () => {
  for (const p of [buildPrompt(MESSAGES), buildSharedRoomPrompt(MESSAGES)]) {
    assert.match(p, /content_tag/);
    // A representative spread of the fixed topic list must appear.
    assert.match(p, /medical/);
    assert.match(p, /sexuality/);
    assert.match(p, /contact-info/);
    // Both sensitivity levels are named.
    assert.match(p, /\bopen\b/);
    assert.match(p, /\bsensitive\b/);
    // It's framed as separate from category (who-sees-it vs how-filed).
    assert.match(p, /separate from category/i);
  }
});

// ── Transcript labelling — never "User" (first-person convention) ──

test('buildPrompt: never labels my human as "User" in the transcript', () => {
  const p = buildPrompt(MESSAGES, null, 'Bluebell');
  // The forbidden generic label must not appear as a turn marker.
  assert.doesNotMatch(p, /^User:/m);
  assert.doesNotMatch(p, /\nUser: /);
});

test('buildPrompt: labels my human by their configured name', () => {
  const p = buildPrompt(MESSAGES, null, 'Bluebell');
  assert.match(p, /Bluebell: Hi, feeling really stressed today\./);
});

test('buildPrompt: falls back to "My human" when no name is given', () => {
  const p = buildPrompt(MESSAGES);
  assert.match(p, /My human: Hi, feeling really stressed today\./);
  assert.doesNotMatch(p, /^User:/m);
});

test('buildPrompt: labels my own turns "Me", not "Assistant"', () => {
  const p = buildPrompt(MESSAGES, null, 'Bluebell');
  assert.match(p, /Me: I hear you\./);
  assert.doesNotMatch(p, /^Assistant:/m);
});

test('buildSharedRoomPrompt: ward by name, never "User"', () => {
  const p = buildSharedRoomPrompt(MESSAGES, null, 'Bluebell');
  assert.match(p, /Bluebell: Hi, feeling really stressed today\./);
  assert.doesNotMatch(p, /^User:/m);
  assert.doesNotMatch(p, /^Assistant:/m);
});

test('buildSharedRoomPrompt: preserves name-prefixed villager turns', () => {
  const sharedMsgs = [
    { role: 'user',      content: 'Hi, feeling stressed.' },          // the ward (unprefixed)
    { role: 'assistant', content: 'I hear you.' },
    { role: 'user',      content: '[Chen]: I brought snacks.' },      // a villager (prefixed)
    { role: 'assistant', content: 'Thanks, Chen.' },
  ];
  const p = buildSharedRoomPrompt(sharedMsgs, null, 'Bluebell');
  // The ward's unprefixed turn gets their name; Chen's prefix is kept verbatim,
  // NOT overwritten with the ward's name.
  assert.match(p, /Bluebell: Hi, feeling stressed\./);
  assert.match(p, /\[Chen\]: I brought snacks\./);
  assert.doesNotMatch(p, /Bluebell: \[Chen\]/);
});
