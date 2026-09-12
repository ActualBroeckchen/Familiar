// delete_location — set_current_location could move {{user}} between saved
// places but nothing could ever remove a stale one. Mirrors
// set_current_location's own tool (same module, same place-by-label shape).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_TOOLS, TOOL_EXECUTORS, villagerToolNames } from '../cerebellum.js';
import { TOOL_MODULES } from '../tool-surfacing.js';

const def = BUILTIN_TOOLS.find(t => t.function?.name === 'delete_location')?.function;

test('delete_location is defined, first-person, and names where the label comes from', () => {
  assert.ok(def, 'tool definition present');
  assert.deepEqual(def.parameters.required, ['place']);
  assert.ok('place' in def.parameters.properties);
  assert.match(def.description, /^I /);
  assert.doesNotMatch(def.description, /\bthe user\b/i);
  // Operability: the Familiar must be able to name the label from a surface
  // it reads — set_current_location's own result/error surfaces the saved
  // labels, or {{user}} names one directly.
  assert.match(def.description, /set_current_location/);
});

test('delete_location rides the same surfacing module as set_current_location', () => {
  assert.equal(TOOL_MODULES.delete_location, TOOL_MODULES.set_current_location);
});

test('delete_location stays ward-only — absent even from a villager granted every ladder at its top rung', () => {
  const maxGrants = { schedule: 'full', memories: true, contacts: true };
  assert.ok(!villagerToolNames(maxGrants).has('delete_location'));
  assert.ok(!villagerToolNames(maxGrants).has('set_current_location'));
});

test('delete_location executor refuses a missing place without reaching Unruh', async () => {
  const exec = TOOL_EXECUTORS.delete_location;
  assert.ok(exec);
  assert.match(await exec({}), /need the label/);
  assert.match(await exec({ place: '   ' }), /need the label/);
});
