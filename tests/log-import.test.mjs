import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImport, parseTimestampedText, toIso, dateFromFilename, applyFallbackDate } from '../log-import.js';

test('toIso handles epoch seconds, ms, and ISO; rejects junk', () => {
  assert.equal(toIso(1_750_000_000).slice(0, 4), '2025');       // seconds
  assert.equal(toIso(1_750_000_000_000).slice(0, 4), '2025');   // ms
  assert.equal(toIso('2026-06-20T14:35:00Z'), '2026-06-20T14:35:00.000Z');
  assert.equal(toIso('not a date'), null);
  assert.equal(toIso(null), null);
});

test('parses a Proto-Familiar session-log JSON object', () => {
  const raw = JSON.stringify({
    sessionId: 's1',
    messages: [
      { role: 'user', content: 'hi', timestamp: '2026-06-20T09:00:00Z' },
      { role: 'assistant', content: 'hello', timestamp: '2026-06-20T09:01:00Z' },
    ],
  });
  const r = parseImport(raw);
  assert.equal(r.ok, true);
  assert.equal(r.format, 'Proto-Familiar JSON');
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[1].role, 'assistant');
});

test('parses a bundle (array of session logs)', () => {
  const raw = JSON.stringify([
    { messages: [{ role: 'user', content: 'a', timestamp: '2026-06-20T09:00:00Z' }] },
    { messages: [{ role: 'assistant', content: 'b', timestamp: '2026-06-21T09:00:00Z' }] },
  ]);
  const r = parseImport(raw);
  assert.equal(r.ok, true);
  assert.equal(r.messages.length, 2);
});

test('timestamped text: role mapping via selfNames, continuation lines', () => {
  const raw = [
    '[2026-06-20 14:35] Ada: hey there',
    'this line continues Ada',
    '[2026-06-20 14:36] Sage: hello Ada',
  ].join('\n');
  const r = parseImport(raw, { selfNames: ['Sage'] });
  assert.equal(r.ok, true);
  assert.equal(r.format, 'timestamped text');
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[0].role, 'user');           // Ada → human
  assert.match(r.messages[0].content, /continues Ada/); // continuation folded in
  assert.equal(r.messages[1].role, 'assistant');      // Sage → self
});

test('timestamped text with no parseable timestamp anywhere is rejected', () => {
  const raw = '[whenever] Ada: hi\n[later] Sage: yo';
  // parseImport falls through both parsers → error
  const direct = parseTimestampedText(raw);
  assert.equal(direct, null);
});

test('parses a SillyTavern .jsonl (metadata line + is_user roles + send_date)', () => {
  const raw = [
    JSON.stringify({ chat_metadata: {}, user_name: 'unused', character_name: 'unused' }),
    JSON.stringify({ name: 'Kenric', is_user: false, is_system: false, send_date: '2026-06-14T21:19:41.313Z', mes: 'the room was hot' }),
    JSON.stringify({ name: 'Lydia', is_user: true, is_system: false, send_date: '2026-06-14T21:26:22.849Z', mes: 'she gasped' }),
    JSON.stringify({ name: 'System', is_user: false, is_system: true, send_date: '2026-06-14T21:27:00Z', mes: 'group note' }),
  ].join('\n');
  const r = parseImport(raw);
  assert.equal(r.ok, true);
  assert.equal(r.format, 'SillyTavern');
  assert.equal(r.messages.length, 2);            // system line skipped
  assert.equal(r.messages[0].role, 'assistant'); // is_user:false
  assert.equal(r.messages[1].role, 'user');      // is_user:true
  assert.equal(r.messages[0].timestamp, '2026-06-14T21:19:41.313Z');
});

test('dateFromFilename pulls an ISO-ish date out of a name', () => {
  assert.equal(dateFromFilename('b3acc751-Kenric__2026061423h19m41s277ms.jsonl'), '2026-06-14');
  assert.equal(dateFromFilename('chat 2025-05-23.txt'), '2025-05-23');
  assert.equal(dateFromFilename('no date here.txt'), null);
  assert.equal(dateFromFilename('2025-13-40 bad.txt'), null); // invalid month/day
});

test('applyFallbackDate stamps only undated messages, on the given local day', () => {
  const out = applyFallbackDate([
    { role: 'user', content: 'a', timestamp: null },
    { role: 'assistant', content: 'b', timestamp: '2026-01-01T00:00:00Z' },
  ], '2026-06-20');
  assert.equal(out[0].timestamp.slice(0, 4), '2026');
  assert.equal(new Date(out[0].timestamp).getFullYear(), 2026);
  assert.equal(out[1].timestamp, '2026-01-01T00:00:00Z'); // already-dated untouched
});

test('parses an OpenClaw event-log .jsonl (message events; non-text/non-message skipped)', () => {
  const raw = [
    JSON.stringify({ type: 'session', version: 3, id: 'x', timestamp: '2026-06-17T07:12:12.748Z' }),
    JSON.stringify({ type: 'model_change', timestamp: '2026-06-17T07:12:13Z', provider: 'zai' }),
    JSON.stringify({ type: 'message', timestamp: '2026-06-17T07:12:15.580Z', message: { role: 'user', content: [{ type: 'text', text: 'hello there' }] } }),
    JSON.stringify({ type: 'message', timestamp: '2026-06-17T07:13:43.598Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi back' }, { type: 'tool_use', name: 'x' }] } }),
    JSON.stringify({ type: 'message', timestamp: '2026-06-17T07:14:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'y' }] } }), // tool-only → skipped
    JSON.stringify({ type: 'custom_message', customType: 'openclaw.runtime-context', content: 'System: noise', timestamp: '2026-06-17T07:14:01Z' }), // skipped
  ].join('\n');
  const r = parseImport(raw);
  assert.equal(r.ok, true);
  assert.equal(r.format, 'OpenClaw');
  assert.equal(r.messages.length, 2);                  // tool-only + runtime-context dropped
  assert.equal(r.messages[0].role, 'user');
  assert.equal(r.messages[1].content, 'hi back');      // text part extracted, tool_use ignored
  assert.equal(r.messages[1].timestamp, '2026-06-17T07:13:43.598Z');
});

test('unknown format → loud structured error listing what is supported', () => {
  const r = parseImport('just some prose with no structure at all');
  assert.equal(r.ok, false);
  assert.match(r.error, /Supported:/);
});

test('empty input is rejected', () => {
  assert.equal(parseImport('').ok, false);
  assert.equal(parseImport('   ').ok, false);
});
