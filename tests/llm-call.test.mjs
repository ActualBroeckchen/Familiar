// llm-call.js — the shared background-loop chat call + thinking-model handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callProviderChat, extractContent, foldReasoningIntoContent, extractTurnReply, familiarDeliberationMessages } from '../llm-call.js';
import { noticingMessages } from '../src/safety/noticing.js';

const okFetch = (body) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

test('extractContent: content wins, else reasoning_content, else reasoning, else ""', () => {
  assert.equal(extractContent({ content: 'hi' }), 'hi');
  assert.equal(extractContent({ content: '', reasoning_content: 'think' }), 'think');
  assert.equal(extractContent({ reasoning: 'r' }), 'r');
  assert.equal(extractContent({}), '');
  assert.equal(extractContent(), '');
});

test('foldReasoningIntoContent: recovers a thinking model reply into content', () => {
  // The non-stream passthrough bug: content empty, answer in reasoning_content.
  const m = { content: '', reasoning_content: 'Hey?' };
  foldReasoningIntoContent(m);
  assert.equal(m.content, 'Hey?');
});

test('foldReasoningIntoContent: leaves a real content untouched', () => {
  const m = { content: 'already here', reasoning_content: 'scratch work' };
  foldReasoningIntoContent(m);
  assert.equal(m.content, 'already here');
});

test('foldReasoningIntoContent: never clobbers a tool_calls response', () => {
  // Empty content beside tool_calls is legitimate — reasoning is NOT the answer.
  const m = { content: '', reasoning_content: 'deciding…', tool_calls: [{ id: 't1' }] };
  foldReasoningIntoContent(m);
  assert.equal(m.content, '');
});

test('foldReasoningIntoContent: nothing to recover leaves content empty', () => {
  const m = { content: '' };
  foldReasoningIntoContent(m);
  assert.equal(m.content, '');
});

test('callProviderChat: returns assistant content', async () => {
  const fetchFn = okFetch({ choices: [{ message: { content: '{"title":"x"}' }, finish_reason: 'stop' }] });
  const out = await callProviderChat({ provider: 'nanogpt', apiKey: 'k', model: 'm', prompt: 'p', fetchFn });
  assert.equal(out, '{"title":"x"}');
});

test('callProviderChat: thinking model — empty content falls back to reasoning_content', async () => {
  const fetchFn = okFetch({ choices: [{ message: { content: '', reasoning_content: '{"title":"y"}' }, finish_reason: 'stop' }] });
  const out = await callProviderChat({ provider: 'nanogpt', apiKey: 'k', model: 'm', prompt: 'p', fetchFn });
  assert.equal(out, '{"title":"y"}');
});

test('callProviderChat: truncated empty → diagnostic error naming finish_reason=length', async () => {
  const fetchFn = okFetch({ choices: [{ message: { content: '' }, finish_reason: 'length' }] });
  await assert.rejects(
    () => callProviderChat({ provider: 'nanogpt', apiKey: 'k', model: 'm', prompt: 'p', fetchFn }),
    /finish_reason=length.*raise max_tokens/,
  );
});

test('callProviderChat: sends the configured max_tokens + temperature', async () => {
  let sentBody;
  const fetchFn = async (_url, opts) => { sentBody = JSON.parse(opts.body); return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }; };
  await callProviderChat({ provider: 'nanogpt', apiKey: 'k', model: 'm', prompt: 'p', maxTokens: 4000, temperature: 0.7, fetchFn });
  assert.equal(sentBody.max_tokens, 4000);
  assert.equal(sentBody.temperature, 0.7);
  assert.equal(sentBody.stream, false);
});

test('callProviderChat: HTTP error and provider error surface clearly', async () => {
  const errFetch = async () => ({ ok: false, status: 502, text: async () => 'bad gateway' });
  await assert.rejects(() => callProviderChat({ provider: 'nanogpt', apiKey: 'k', model: 'm', prompt: 'p', fetchFn: errFetch }), /502/);
  const apiErr = okFetch({ error: { message: 'rate limited' } });
  await assert.rejects(() => callProviderChat({ provider: 'nanogpt', apiKey: 'k', model: 'm', prompt: 'p', fetchFn: apiErr }), /rate limited/);
});

test('callProviderChat: unknown provider throws before any fetch', async () => {
  await assert.rejects(() => callProviderChat({ provider: 'nope', apiKey: 'k', model: 'm', prompt: 'p' }), /Unknown provider/);
});

test('callProviderChat: sends reasoning_effort only when passed (opt-in)', async () => {
  let sentBody;
  const cap = async (_url, opts) => { sentBody = JSON.parse(opts.body); return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }; };
  // Not passed → absent, so the ward-signed triage call stays byte-identical.
  await callProviderChat({ provider: 'zai', apiKey: 'k', model: 'm', prompt: 'p', fetchFn: cap });
  assert.equal('reasoning_effort' in sentBody, false);
  // Passed → present.
  await callProviderChat({ provider: 'zai', apiKey: 'k', model: 'm', prompt: 'p', reasoningEffort: 'low', fetchFn: cap });
  assert.equal(sentBody.reasoning_effort, 'low');
});

test('extractTurnReply: content wins; length-exhaustion never dumps raw reasoning', () => {
  // Real content always wins.
  assert.equal(extractTurnReply({ message: { content: 'hello' }, finish_reason: 'stop' }), 'hello');
  // THE bug: empty content + only reasoning + cut at the token cap → NOT an
  // answer. Must return '' so the caller shows an honest note, not the CoT.
  assert.equal(extractTurnReply({ message: { content: '', reasoning_content: 'long chain of thought…' }, finish_reason: 'length' }), '');
  // Empty + stop + a parked answer in reasoning_content → recover it (the
  // legitimate proxy-parking case foldReasoningIntoContent also serves).
  assert.equal(extractTurnReply({ message: { content: '', reasoning_content: 'the answer' }, finish_reason: 'stop' }), 'the answer');
  assert.equal(extractTurnReply({ message: { reasoning: 'r' }, finish_reason: 'stop' }), 'r');
  // Nothing at all → ''.
  assert.equal(extractTurnReply({ message: {}, finish_reason: 'stop' }), '');
  assert.equal(extractTurnReply({}), '');
});

test('familiarDeliberationMessages: the Familiar\'s prompt is SYSTEM, the user slot is a bare cue', () => {
  // The whole point of the entity-as-subject role fix: a first-person prompt is
  // the Familiar thinking, so it must never land in the `user` role.
  const msgs = familiarDeliberationMessages({ identity: 'WHO-I-AM', body: "I'm {{char}}. Nobody's talking to me…", cue: '(a quiet moment)' });
  const users = msgs.filter(m => m.role === 'user');
  assert.equal(users.length, 1, 'exactly one user turn (some providers refuse none)');
  assert.equal(users[0].content, '(a quiet moment)', 'the user turn is only the bare cue');
  assert.ok(msgs.some(m => m.role === 'system' && /Nobody's talking/.test(m.content)), 'the prompt is a system message');
  assert.ok(msgs.some(m => m.role === 'system' && m.content === 'WHO-I-AM'), 'identity leads');
});

test('familiarDeliberationMessages: no identity → just system body + user cue', () => {
  assert.deepEqual(familiarDeliberationMessages({ body: 'BODY' }), [
    { role: 'system', content: 'BODY' },
    { role: 'user', content: '(a quiet moment)' },
  ]);
});

test('familiarDeliberationMessages is byte-identical to noticing\'s own builder', () => {
  // The shape is duplicated on purpose (noticing.js is deliberately import-free);
  // this pins the two together so they can never quietly drift.
  const cases = [
    { identity: 'ID', body: 'B', cue: '(c)' },
    { body: 'only body' },
    {},
  ];
  for (const c of cases) {
    assert.deepEqual(familiarDeliberationMessages(c), noticingMessages(c), JSON.stringify(c));
  }
});
