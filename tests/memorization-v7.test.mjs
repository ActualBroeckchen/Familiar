// V7 stranger data minimization — prompt variant selection tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSharedRoomPrompt, buildPrompt, conversationMessages, buildExtractionMessages, speakerNameField, nameFieldEnabledFor, recordNameFieldResult, extractWithNameFallback, _resetNameFieldCache } from '../src/memory/memorization.js';

const NAME_SAFE = /^[a-zA-Z0-9_-]+$/;   // the OpenAI `name` charset — no spaces/unicode

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

test('both extraction prompts carry the "whose fact is it?" attribution rule', () => {
  const ward = buildPrompt(MESSAGES);
  const shared = buildSharedRoomPrompt(MESSAGES);
  for (const p of [ward, shared]) {
    assert.match(p, /Whose fact is it\?/);
    assert.match(p, /\{\{user\}\}/);   // uses the name macro, not "my human", here
  }
  // The ward rule forbids folding another's action onto the human.
  assert.match(ward, /never write \{\{user\}\} as having done another person's action/);
  // The shared rule leans on the speaker tags and forbids collapsing the room.
  assert.match(shared, /don't fold the room into \{\{user\}\}/);
  assert.match(shared, /\[Name\]: before a line is who said it/);
});

// ── name-field speaker handles (opt-in structural attribution) ──────

test('speakerNameField: code-minted handles are always name-safe', () => {
  // The whole point: a real name's spaces/unicode never reach the field raw.
  assert.equal(speakerNameField({ role: 'user', speaker: 'Chen Wei' }), 'chen-wei');
  assert.match(speakerNameField({ role: 'user', speaker: 'José García' }), NAME_SAFE);
  assert.match(speakerNameField({ role: 'user', speaker: "O'Brien" }), NAME_SAFE);
});

test('speakerNameField: ward is ward-<slug> (bond marker + a specific person, never bare)', () => {
  assert.equal(speakerNameField({ role: 'user', speaker: null, wardName: 'Mary Anne' }), 'ward-mary-anne');
  assert.match(speakerNameField({ role: 'user', speaker: null, wardName: 'Mary Anne' }), NAME_SAFE);
  // Unconfigured name still yields a safe fallback, never empty.
  assert.equal(speakerNameField({ role: 'user', speaker: null, wardName: '' }), 'ward');
});

test('speakerNameField: material gets session-archive; the Familiar (assistant) gets none', () => {
  assert.equal(speakerNameField({ role: 'user', material: true, speaker: 'anything' }), 'session-archive');
  assert.equal(speakerNameField({ role: 'assistant', speaker: 'Chen' }), undefined);  // role carries it
});

test('conversationMessages withNames: stamps a name per user turn, none on the Familiar', () => {
  const shared = [
    { role: 'user',      content: 'hey', speaker: null },          // the ward
    { role: 'assistant', content: 'hi there' },                    // the Familiar
    { role: 'user',      content: '[Chen]: brought snacks', speaker: 'Chen' },
  ];
  const msgs = conversationMessages(shared, { sharedRoom: true, wardLabel: 'Bluebell', withNames: true });
  assert.equal(msgs[0].name, 'ward-bluebell');
  assert.equal('name' in msgs[1], false, 'the assistant turn carries no name');
  assert.equal(msgs[2].name, 'chen');
  for (const m of msgs) if (m.name) assert.match(m.name, NAME_SAFE);
});

test('conversationMessages: withNames off (default) adds no name field — zero behaviour change', () => {
  const msgs = conversationMessages(MESSAGES);   // default withNames:false
  assert.ok(!msgs.some(m => 'name' in m), 'no name field unless explicitly opted in');
});

test('buildExtractionMessages threads withNames to the transcript turns', () => {
  const instructions = buildPrompt(MESSAGES);
  const on  = buildExtractionMessages({ instructions, messages: MESSAGES, withNames: true });
  const off = buildExtractionMessages({ instructions, messages: MESSAGES, withNames: false });
  assert.ok(on.some(m => m.role === 'user' && m.name), 'names present when on');
  assert.ok(!off.some(m => 'name' in m), 'no names when off');
});

test('nameFieldEnabledFor: optimistic by default, ward tri-state and learned cache override', () => {
  _resetNameFieldCache();
  const job = { provider: 'prov-a', model: 'm1', baseUrl: null };
  // Default: optimistic ON (attempt + learn) — no tri-state, nothing learned.
  assert.equal(nameFieldEnabledFor(job, {}), true, 'optimistic default');
  assert.equal(nameFieldEnabledFor(job, { connections: [] }), true);
  // Ward tri-state wins.
  assert.equal(nameFieldEnabledFor(job, { connections: [{ provider: 'prov-a', model: 'm1', baseUrl: null, nameFieldCapable: 'no' }] }), false);
  assert.equal(nameFieldEnabledFor(job, { connections: [{ provider: 'prov-a', model: 'm1', baseUrl: null, nameFieldCapable: 'yes' }] }), true);
  // A learned 'no' turns it off for that provider:model.
  recordNameFieldResult(job, 'no');
  assert.equal(nameFieldEnabledFor(job, {}), false, 'learned no');
  // Ward tri-state still overrides a learned result.
  assert.equal(nameFieldEnabledFor(job, { connections: [{ provider: 'prov-a', model: 'm1', baseUrl: null, nameFieldCapable: 'yes' }] }), true);
  _resetNameFieldCache();
});

test('extractWithNameFallback: success caches capable; a name-field 400 retries bare and caches incapable', async () => {
  _resetNameFieldCache();
  // Happy path: names on, provider accepts → returns result, learns 'yes', one call.
  let calls = 0; let learned = null;
  const ok = await extractWithNameFallback({
    withNames: true,
    buildMessages: (names) => ({ names }),
    callProviderFn: (m) => { calls++; return { content: 'ok', usedNames: m.names }; },
    onLearn: (v) => { learned = v; },
  });
  assert.equal(ok.usedNames, true);
  assert.equal(calls, 1);
  assert.equal(learned, 'yes');

  // Name-field rejection: first call (names) 400s, retry WITHOUT names succeeds → learns 'no'.
  calls = 0; learned = null;
  const recovered = await extractWithNameFallback({
    withNames: true,
    buildMessages: (names) => ({ names }),
    callProviderFn: (m) => { calls++; if (m.names) throw new Error('Provider openai returned 400: unknown field name'); return { content: 'ok', usedNames: m.names }; },
    onLearn: (v) => { learned = v; },
  });
  assert.equal(recovered.usedNames, false, 'retried without names');
  assert.equal(calls, 2);
  assert.equal(learned, 'no');
});

test('extractWithNameFallback: a real error is not masked by the name-field retry', async () => {
  // 400 on BOTH (names and bare) → a genuine bad request, propagates, not learned 'no'.
  let learned = null;
  await assert.rejects(() => extractWithNameFallback({
    withNames: true,
    buildMessages: (names) => ({ names }),
    callProviderFn: () => { throw new Error('Provider x returned 400: bad model'); },
    onLearn: (v) => { learned = v; },
  }), /returned 400/);
  assert.equal(learned, null, 'never learned no when the bare retry also failed');

  // A non-400 (e.g. 500) never triggers the retry — surfaces immediately.
  let calls = 0;
  await assert.rejects(() => extractWithNameFallback({
    withNames: true,
    buildMessages: (names) => ({ names }),
    callProviderFn: () => { calls++; throw new Error('Provider x returned 500: upstream'); },
    onLearn: () => {},
  }), /returned 500/);
  assert.equal(calls, 1, 'no retry on a 5xx');
});

test('extractWithNameFallback: names off → one plain call, nothing learned', async () => {
  let calls = 0; let learned = null;
  const res = await extractWithNameFallback({
    withNames: false,
    buildMessages: (names) => ({ names }),
    callProviderFn: (m) => { calls++; return { usedNames: m.names }; },
    onLearn: (v) => { learned = v; },
  });
  assert.equal(res.usedNames, false);
  assert.equal(calls, 1);
  assert.equal(learned, null);
});

test('both prompts carry the referent / degrade-dont-drop rule', () => {
  for (const p of [buildPrompt(MESSAGES), buildSharedRoomPrompt(MESSAGES)]) {
    assert.match(p, /Who's it about, really\?/);
    assert.match(p, /unresolved/);                              // the greppable marker
    assert.match(p, /a hedged memory i can fix later/i);        // degrade, don't drop
    // confidence is decoupled from attribution, so a hedged fact isn't culled.
    assert.match(p, /whether the thing happened, not who it's about/);
  }
});

test('both prompts describe the optional attribution_confidence field, tied to the unresolved marker', () => {
  for (const p of [buildPrompt(MESSAGES), buildSharedRoomPrompt(MESSAGES)]) {
    assert.match(p, /attribution_confidence — OPTIONAL/);
    assert.match(p, /how sure I am WHO the fact is about/);
    assert.match(p, /never drops the fact/);          // it's a downweight signal, not a cull
    assert.match(p, /unresolved/i);                    // tied to the referent rule
  }
});
