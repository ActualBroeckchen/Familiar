import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wardClosingReplayMessages } from '../src/discord/discord-gateway.js';

// The ward dead-air guard (audit Task 4): when my human's own tool turn ends
// with no closing text, handleTurn replays the tool rounds + a nudge and makes
// a plain no-tools call so the model answers in words instead of dead air. The
// replay reconstruction is the part worth pinning — a mis-threaded
// tool_call_id would make the provider reject the closing call and the ward
// would still get silence.

test('wardClosingReplayMessages: base + assistant tool_calls + tool results + nudge, in order', () => {
  const base = [
    { role: 'system', content: 'identity' },
    { role: 'user', content: 'check my schedule and my memory of Tuesday' },
  ];
  const rounds = [
    {
      content: null,
      toolCalls: [
        { id: 'tc1', function: { name: 'schedule_find' } },
        { id: 'tc2', function: { name: 'recall' } },
      ],
      results: [
        { tool_call_id: 'tc1', content: 'nothing scheduled' },
        { tool_call_id: 'tc2', content: 'you rested Tuesday' },
      ],
    },
  ];
  const replay = wardClosingReplayMessages(base, rounds);

  assert.deepEqual(replay.slice(0, 2), base, 'base messages preserved at the head');
  const assistant = replay[2];
  assert.equal(assistant.role, 'assistant');
  assert.deepEqual(assistant.tool_calls.map(t => t.id), ['tc1', 'tc2']);
  // Each tool result must carry the matching tool_call_id (the thread the
  // provider validates) and immediately follow the assistant message.
  assert.equal(replay[3].role, 'tool');
  assert.equal(replay[3].tool_call_id, 'tc1');
  assert.equal(replay[4].role, 'tool');
  assert.equal(replay[4].tool_call_id, 'tc2');
  const nudge = replay[replay.length - 1];
  assert.equal(nudge.role, 'system');
  assert.match(nudge.content, /finished using my tools/);
});

test('wardClosingReplayMessages: multiple rounds are replayed in order', () => {
  const base = [{ role: 'user', content: 'do a lot' }];
  const rounds = [
    { content: 'thinking', toolCalls: [{ id: 'a', function: { name: 'x' } }], results: [{ tool_call_id: 'a', content: 'ra' }] },
    { content: null, toolCalls: [{ id: 'b', function: { name: 'y' } }], results: [{ tool_call_id: 'b', content: 'rb' }] },
  ];
  const replay = wardClosingReplayMessages(base, rounds);
  const roles = replay.map(m => m.role).join(',');
  assert.equal(roles, 'user,assistant,tool,assistant,tool,system');
  assert.equal(replay[1].content, 'thinking');   // first round's assistant content preserved
  assert.equal(replay[2].tool_call_id, 'a');
  assert.equal(replay[4].tool_call_id, 'b');
});

test('wardClosingReplayMessages: empty/missing rounds → base + nudge only, never throws', () => {
  const base = [{ role: 'user', content: 'hi' }];
  for (const rounds of [[], undefined, null]) {
    const replay = wardClosingReplayMessages(base, rounds);
    assert.equal(replay.length, 2);
    assert.equal(replay[0].content, 'hi');
    assert.equal(replay[1].role, 'system');
  }
});
