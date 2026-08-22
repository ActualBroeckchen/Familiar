import { test } from 'node:test';
import assert from 'node:assert/strict';

import { coreSystemSegment, postHistoryMessage, withCorePrompts } from '../core-prompts.js';

// The bug these guard: the ward's four authored prompts are assembled by the
// browser on the web, so a server-initiated turn (Discord, voice) shipped
// WITHOUT them — the Familiar answered with none of its identity. This module
// is the server-side mirror; these tests pin that mirror to the web client's
// order, headers, and macro handling (public/app.js _buildApiMessagesInner).

test('coreSystemSegment orders system → Character Profile → Human Profile with the client headers', () => {
  const seg = coreSystemSegment({
    systemPrompt: 'I am {{char}}.',
    characterProfile: 'Sharp, warm, blunt.',
    userProfile: 'Night owl.',
  });
  // Same headers and the same '\n\n---\n\n' join the web client uses.
  assert.equal(seg,
    'I am the Familiar.\n\n---\n\n[Character Profile]\nSharp, warm, blunt.\n\n---\n\n[Human Profile]\nNight owl.');
});

test('coreSystemSegment resolves {{user}}/{{char}} to the configured names', () => {
  const seg = coreSystemSegment({
    systemPrompt: 'I am {{char}}, bonded to {{user}}.',
    charName: 'Eury', userName: 'Wren',
  });
  assert.equal(seg, 'I am Eury, bonded to Wren.');
  assert.ok(!/\{\{/.test(seg), 'no literal macro token may reach the model');
});

test('coreSystemSegment falls back to "my human"/"the Familiar" when names are unset', () => {
  const seg = coreSystemSegment({ systemPrompt: '{{char}} looks after {{user}}.' });
  assert.equal(seg, 'the Familiar looks after my human.');
});

test('coreSystemSegment is empty when none of the three are configured', () => {
  assert.equal(coreSystemSegment({}), '');
  assert.equal(coreSystemSegment({ systemPrompt: '   ', characterProfile: '' }), '');
  assert.equal(coreSystemSegment(), '', 'no settings at all still returns a clean empty string');
});

test('coreSystemSegment includes only the fields that are set', () => {
  assert.equal(coreSystemSegment({ characterProfile: 'Just the character.' }),
    '[Character Profile]\nJust the character.');
  assert.equal(coreSystemSegment({ systemPrompt: 'Just the system.' }), 'Just the system.');
});

test('postHistoryMessage returns null when unconfigured, the message when set', () => {
  assert.equal(postHistoryMessage({}), null);
  assert.equal(postHistoryMessage({ postHistoryPrompt: '  ' }), null);

  const m = postHistoryMessage({ postHistoryPrompt: 'Stay in {{char}}.', charName: 'Eury' });
  assert.deepEqual(m, { role: 'system', content: 'Stay in Eury.' });
});

test('postHistoryMessage honours the configured role, and rejects a bad one to system', () => {
  assert.equal(postHistoryMessage({ postHistoryPrompt: 'x', postHistoryRole: 'user' }).role, 'user');
  assert.equal(postHistoryMessage({ postHistoryPrompt: 'x', postHistoryRole: 'assistant' }).role, 'assistant');
  assert.equal(postHistoryMessage({ postHistoryPrompt: 'x', postHistoryRole: 'nonsense' }).role, 'system',
    'an unknown role falls back to system, exactly as the web client does');
});

// withCorePrompts is the server-side assembly the /api/chat injectCorePrompts
// path calls. The contract that MUST hold: core segment first (so the static
// identity block prepends in front of it → static → persona, the web order),
// post-history last (after the user turn), history untouched between.
test('withCorePrompts leads with the core segment and trails with post-history', () => {
  const settings = {
    systemPrompt: 'I am {{char}}.', characterProfile: 'Blunt.', userProfile: 'Wren.',
    postHistoryPrompt: 'Stay in character.', charName: 'Eury',
  };
  const out = withCorePrompts([{ role: 'user', content: 'hi' }], settings);
  assert.equal(out[0].role, 'system');
  assert.match(out[0].content, /^I am Eury\.\n\n---\n\n\[Character Profile\]/, 'core segment leads');
  assert.deepEqual(out[1], { role: 'user', content: 'hi' }, 'the caller history rides untouched in the middle');
  assert.equal(out[out.length - 1].content, 'Stay in character.', 'post-history trails last');
  assert.equal(out[out.length - 1].role, 'system');
});

test('withCorePrompts with nothing configured returns the messages unchanged', () => {
  const msgs = [{ role: 'user', content: 'hi' }];
  assert.deepEqual(withCorePrompts(msgs, {}), msgs, 'no core prompts → no added messages');
});

test('withCorePrompts tolerates a non-array (defensive) — returns just the configured prompts', () => {
  const out = withCorePrompts(null, { systemPrompt: 'S' });
  assert.deepEqual(out, [{ role: 'system', content: 'S' }]);
});
