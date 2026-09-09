// V7 stranger data minimization — prompt variant selection tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSharedRoomPrompt, buildPrompt, conversationMessages, buildExtractionMessages } from '../src/memory/memorization.js';

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

test('conversationMessages: carries the shared-room conversation as role-faithful turns', () => {
  const msgs = conversationMessages(MESSAGES, { sharedRoom: true, wardLabel: 'My human' });
  assert.ok(msgs.some(m => m.role === 'user' && /feeling really stressed/.test(m.content)));
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

// ── Role-faithful transcript (conversationMessages) ──────────────────
// The conversation now rides as real user/assistant turns, not a flattened
// "Name: text" blob folded into the prompt — so the model natively reads who
// said what, and the prompt (the Familiar's notes) no longer holds the transcript.

test('conversationMessages (ward DM): the ward is a plain user turn, no "Name:"/"User:" label', () => {
  const msgs = conversationMessages(MESSAGES);   // sharedRoom defaults false
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].content, 'Hi, feeling really stressed today.');  // raw; the role carries identity
  assert.ok(!msgs.some(m => /^User: |^My human: |^Bluebell: /.test(m.content)));
});

test('conversationMessages: the Familiar\'s lines are the assistant role, never "Me:"/"Assistant:"', () => {
  const msgs = conversationMessages(MESSAGES);
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].content, "I hear you. What's going on?");
  assert.ok(!msgs.some(m => /^Me: |^Assistant: /.test(m.content)));
});

test('conversationMessages (shared room): ward labelled by name, villager prefix kept, Familiar = assistant', () => {
  const sharedMsgs = [
    { role: 'user',      content: 'Hi, feeling stressed.' },          // the ward (unprefixed)
    { role: 'assistant', content: 'I hear you.' },
    { role: 'user',      content: '[Chen]: I brought snacks.' },      // a villager (prefixed)
    { role: 'assistant', content: 'Thanks, Chen.' },
  ];
  const msgs = conversationMessages(sharedMsgs, { sharedRoom: true, wardLabel: 'Bluebell' });
  assert.deepEqual(msgs, [
    { role: 'user',      content: 'Bluebell: Hi, feeling stressed.' },  // unprefixed ward → labelled
    { role: 'assistant', content: 'I hear you.' },
    { role: 'user',      content: '[Chen]: I brought snacks.' },        // villager prefix kept verbatim
    { role: 'assistant', content: 'Thanks, Chen.' },
  ]);
});

test('the extraction prompt no longer carries the raw transcript (it rides as its own turns)', () => {
  const p = buildPrompt(MESSAGES, null, 'Bluebell');
  assert.doesNotMatch(p, /feeling really stressed/);   // the transcript is not in the notes
  assert.doesNotMatch(p, /^Bluebell: /m);
  assert.doesNotMatch(p, /^Me: /m);
});

test('buildExtractionMessages: notes lead as system, transcript rides faithfully, cue closes as system', () => {
  const instructions = buildPrompt(MESSAGES, null, 'Bluebell');
  const msgs = buildExtractionMessages({ instructions, messages: MESSAGES, sharedRoom: false, wardLabel: 'Bluebell' });
  // system-first (the notes), system-last (the neutral close cue), never a
  // Familiar-voiced user turn in between.
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[0].content, instructions);
  assert.equal(msgs.at(-1).role, 'system');
  assert.match(msgs.at(-1).content, /only the memories JSON|begin with the \{/i);
  // The middle is the role-faithful transcript.
  const middle = msgs.slice(1, -1);
  assert.deepEqual(middle, conversationMessages(MESSAGES));
  assert.ok(middle.some(m => m.role === 'user') && middle.some(m => m.role === 'assistant'));
});
