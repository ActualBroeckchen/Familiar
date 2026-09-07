// flag_distress wiring (ward-signed safety tool). Behaviour of the threat
// raise itself is in threat-tracker.test.mjs; this locks WHERE the tool is
// reachable — the ward's caller decisions — so a future change can't silently
// drop it from a surface it's meant to be on.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_TOOLS, TOOL_EXECUTORS, composeNoticingTools, villagerToolNames,
} from '../cerebellum.js';
import { TOOL_MODULES } from '../tool-surfacing.js';
import { buildNoticingPrompt } from '../src/safety/noticing.js';

test('flag_distress: has a schema, an executor, and is CORE (always advertised)', () => {
  assert.ok(BUILTIN_TOOLS.some(t => t.function?.name === 'flag_distress'), 'schema present');
  assert.equal(typeof TOOL_EXECUTORS.flag_distress, 'function', 'executor present');
  assert.equal(TOOL_MODULES.flag_distress, 'core', 'CORE — reachable every turn without request_tools');
});

test('flag_distress: reachable by EVERY registered villager, regardless of grants', () => {
  // No grants at all → still present (anyone in the Village can raise the alarm).
  assert.ok(villagerToolNames({}).has('flag_distress'));
  assert.ok(villagerToolNames({ schedule: false, memories: false, contacts: false }).has('flag_distress'));
});

test('flag_distress: in the noticing toolset, and the prompt names it at moderate+', () => {
  assert.ok(composeNoticingTools({}).map(t => t.function.name).includes('flag_distress'));
  // With the tool in hand, the moderate+ prompt hands a crisis to triage via it.
  const p = buildNoticingPrompt({ situationReport: ['- x'], threatTier: 'severe', hasFlagDistress: true });
  assert.match(p, /flag_distress/);
});

test('flag_distress: the description frames it as sensing, never a message-sending path', () => {
  const t = BUILTIN_TOOLS.find(t => t.function?.name === 'flag_distress');
  const d = t.function.description;
  // It moves the Familiar's own concern; it does not itself contact anyone.
  assert.match(d, /does not itself message anyone|moves my own/i);
  // The villager-visible no-covert guarantee is stated.
  assert.match(d, /always told immediately|nothing here is hidden/i);
});
