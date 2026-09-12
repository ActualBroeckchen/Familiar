// organs.js — the organ-status readout (pure presentation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatOrganStatus, anyDown, ORGAN_ORDER } from '../organs.js';

test('ORGAN_ORDER lists the four organs', () => {
  assert.deepEqual(ORGAN_ORDER, ['Phylactery', 'Unruh', 'Village', 'Tomes']);
});

test('formatOrganStatus: 🟢 for up, ⚫ for down, in order', () => {
  const out = formatOrganStatus({ phylactery: true, unruh: true, village: false, tomes: true });
  assert.equal(out,
    '[Organ status]\nPhylactery: 🟢\nUnruh: 🟢\nVillage: ⚫\nTomes: 🟢');
});

test('formatOrganStatus: a missing key reads as down (⚫)', () => {
  const out = formatOrganStatus({ phylactery: true });   // others absent
  assert.match(out, /Phylactery: 🟢/);
  assert.match(out, /Unruh: ⚫/);
  assert.match(out, /Village: ⚫/);
  assert.match(out, /Tomes: ⚫/);
});

test('formatOrganStatus: custom title', () => {
  const out = formatOrganStatus({ phylactery: true, unruh: true, village: true, tomes: true }, { title: 'Organs:' });
  assert.ok(out.startsWith('Organs:\n'));
});

test('anyDown: true iff at least one organ is down', () => {
  assert.equal(anyDown({ phylactery: true, unruh: true, village: true, tomes: true }), false);
  assert.equal(anyDown({ phylactery: true, unruh: false, village: true, tomes: true }), true);
  assert.equal(anyDown({}), true);   // all absent → all down
});
