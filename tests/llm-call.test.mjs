// llm-call.js — the shared background-loop chat call + thinking-model handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callProviderChat, extractContent, foldReasoningIntoContent } from '../llm-call.js';

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
