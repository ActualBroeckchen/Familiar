import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findContractMismatches } from '../scripts/audit-mcp-contracts.mjs';

// The cross-language contract gate: every thalamus MCP call's argument keys must
// match a real Phylactery/Unruh tool signature. This is the class of bug the
// JS-only audits and `node --check` can't see — a call sending `heading` where
// the tool wants `section`, a call to a tool that doesn't exist, or a dropped
// required arg — all of which fail SILENTLY at runtime. Three shipped before this
// gate existed; it exists so a fourth fails here instead of on a ward's data.
test('every thalamus→Phylactery/Unruh MCP call matches the tool signature', () => {
  const findings = findContractMismatches();
  assert.deepEqual(findings, [],
    `MCP contract mismatches — thalamus is calling a tool with args it doesn't accept:\n  ${findings.join('\n  ')}`);
});
