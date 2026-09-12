// schedule_edit — the Familiar can rename / re-time an item in place. Before
// this the only edits it could make were assign_time (start only) and set_lead;
// a rename meant delete + re-add and losing the id and its consequence links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_TOOLS, TOOL_EXECUTORS } from '../cerebellum.js';
import { TOOL_MODULES } from '../tool-surfacing.js';

const def = BUILTIN_TOOLS.find(t => t.function?.name === 'schedule_edit')?.function;

test('schedule_edit is defined, first-person, and only id is required', () => {
  assert.ok(def, 'tool definition present');
  assert.deepEqual(def.parameters.required, ['id']);
  assert.ok(['label', 'when', 'end'].every(k => k in def.parameters.properties));
  assert.match(def.description, /^I /);
  assert.doesNotMatch(def.description, /\bthe user\b/i);
  assert.match(def.description, /\[Temporal Context\]/, 'names where the id comes from');
});

test('schedule_edit rides the schedule-write surfacing module', () => {
  assert.equal(TOOL_MODULES.schedule_edit, 'schedule-write');
});

test('schedule_edit executor refuses a missing id or an empty patch without reaching Unruh', async () => {
  const exec = TOOL_EXECUTORS.schedule_edit;
  assert.ok(exec);
  assert.match(await exec({}), /id \(string\) is required/);
  assert.match(await exec({ id: 'dentist-x7' }), /nothing to change/);
  assert.match(await exec({ id: 'dentist-x7', label: '   ' }), /nothing to change/);
});
