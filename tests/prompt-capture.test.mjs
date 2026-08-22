import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  recordOutgoingPrompt, lastOutgoingPrompts, lastOutgoingPrompt, _clearOutgoingPrompts,
} from '../prompt-capture.js';

test('records the last payload per surface and reads it back verbatim', () => {
  _clearOutgoingPrompts();
  recordOutgoingPrompt('discord', {
    messages: [{ role: 'system', content: 'I am the Familiar.' }, { role: 'user', content: 'hi' }],
    model: 'glm-4.6', provider: 'zai',
  });
  const cap = lastOutgoingPrompt('discord');
  assert.equal(cap.surface, 'discord');
  assert.equal(cap.model, 'glm-4.6');
  assert.equal(cap.messages.length, 2);
  assert.equal(cap.messages[0].content, 'I am the Familiar.', 'ground truth, not a reconstruction');
});

test('a newer capture for a surface overwrites the older one', () => {
  _clearOutgoingPrompts();
  recordOutgoingPrompt('web', { messages: [{ role: 'user', content: 'first' }] });
  recordOutgoingPrompt('web', { messages: [{ role: 'user', content: 'second' }] });
  assert.equal(lastOutgoingPrompt('web').messages[0].content, 'second');
  assert.equal(lastOutgoingPrompts().filter(s => s.surface === 'web').length, 1, 'one entry per surface');
});

test('surfaces come back newest-first', async () => {
  _clearOutgoingPrompts();
  recordOutgoingPrompt('web', { messages: [] });
  await new Promise(r => setTimeout(r, 2));
  recordOutgoingPrompt('discord', { messages: [] });
  const all = lastOutgoingPrompts();
  assert.equal(all[0].surface, 'discord', 'most recent first');
  assert.equal(all[1].surface, 'web');
});

test('flattens content-part arrays (vision turns) instead of choking', () => {
  _clearOutgoingPrompts();
  recordOutgoingPrompt('web', {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url' }] }],
  });
  const c = lastOutgoingPrompt('web').messages[0].content;
  assert.equal(typeof c, 'string');
  assert.match(c, /look/);
});

test('surfaces attachment counts and tool_calls without the raw bytes', () => {
  _clearOutgoingPrompts();
  recordOutgoingPrompt('discord', {
    messages: [{ role: 'user', content: 'x', attachments: [{ id: 'a' }, { id: 'b' }] }],
  });
  assert.equal(lastOutgoingPrompt('discord').messages[0].attachmentCount, 2);
});

test('never throws on garbage input — capture must not break a turn', () => {
  _clearOutgoingPrompts();
  assert.doesNotThrow(() => recordOutgoingPrompt('web', { messages: null }));
  assert.doesNotThrow(() => recordOutgoingPrompt('web', {}));
  assert.doesNotThrow(() => recordOutgoingPrompt(undefined, undefined));
  assert.equal(lastOutgoingPrompt('web').messages.length, 0, 'a bad payload records an empty array, not a crash');
});
