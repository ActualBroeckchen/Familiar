// The [CARE CHECK] block, relocated byte-for-byte from thalamus.js into its own
// pure module. These pin BEHAVIOUR (what each tier renders), not wording — the
// wording is ward-signed and lives in src/safety/care-check.js alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCareCheckBlock } from '../src/safety/care-check.js';

test('calm, disabled, or missing threat renders nothing', () => {
  assert.equal(buildCareCheckBlock(null), '');
  assert.equal(buildCareCheckBlock({ tier: 'calm', weight: 0 }), '');
  assert.equal(buildCareCheckBlock({ tier: 'severe', weight: 9, disabled: true }), '');
});

test('every elevated tier renders its own header with the weight and stays in my voice', () => {
  for (const tier of ['mild', 'moderate', 'high', 'severe']) {
    const out = buildCareCheckBlock({ tier, weight: 1.5 });
    assert.match(out, new RegExp(`^\\[CARE CHECK — current threat: ${tier} \\(1\\.50\\)\\]`));
    assert.doesNotMatch(out, /\byou\b|\bthe user\b/i);
    assert.match(out, /identity|voice/i, `${tier} anchors to identity`);
  }
});

test('severe makes the crisis lines visible; lower tiers do not', () => {
  assert.match(buildCareCheckBlock({ tier: 'severe', weight: 8 }), /988|Samaritans|findahelpline/);
  assert.doesNotMatch(buildCareCheckBlock({ tier: 'high', weight: 4 }), /988/);
});
