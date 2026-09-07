// Tool-name consistency in the acknowledge family (verb_noun, matching
// acknowledge_deferred_intent/snooze_deferred_intent/drop_deferred_intent).
// graduation_acknowledge / disclosure_acknowledge were the odd ones out
// (noun_verb) — renamed to acknowledge_graduation / acknowledge_disclosure.
// The old names stay as executor-only aliases for one release so a model
// mid-conversation that still recalls the old name lands correctly, but they
// must not be advertised (absent from BUILTIN_TOOLS).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_TOOLS, TOOL_EXECUTORS } from '../cerebellum.js';
import { TOOL_MODULES } from '../tool-surfacing.js';

test('the new acknowledge_* names are advertised, first-person tools', () => {
  for (const name of ['acknowledge_graduation', 'acknowledge_disclosure']) {
    const def = BUILTIN_TOOLS.find(t => t.function?.name === name)?.function;
    assert.ok(def, `${name} tool definition present`);
    assert.match(def.description, /^I /);
    assert.equal(TOOL_MODULES[name], 'acks');
  }
});

test('the old noun_verb names are NOT advertised', () => {
  for (const oldName of ['graduation_acknowledge', 'disclosure_acknowledge']) {
    assert.equal(
      BUILTIN_TOOLS.find(t => t.function?.name === oldName),
      undefined,
      `${oldName} must not be in BUILTIN_TOOLS`,
    );
  }
});

test('old names still execute, aliasing the new function, for a mid-conversation model that recalls them', async () => {
  assert.equal(typeof TOOL_EXECUTORS.acknowledge_graduation, 'function');
  assert.equal(typeof TOOL_EXECUTORS.graduation_acknowledge, 'function');
  assert.equal(typeof TOOL_EXECUTORS.acknowledge_disclosure, 'function');
  assert.equal(typeof TOOL_EXECUTORS.disclosure_acknowledge, 'function');

  // Same failure-mode behaviour (no ids) proves the alias really delegates,
  // not just happens to return a similar-looking string.
  const gradNew = await TOOL_EXECUTORS.acknowledge_graduation({});
  const gradOld = await TOOL_EXECUTORS.graduation_acknowledge({});
  assert.equal(gradNew, gradOld);

  const discNew = await TOOL_EXECUTORS.acknowledge_disclosure({});
  const discOld = await TOOL_EXECUTORS.disclosure_acknowledge({});
  assert.equal(discNew, discOld);
});
