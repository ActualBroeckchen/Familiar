import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAttribution, isIgnored, wardCalendarId, normalizeAttributionEntry,
  ATTRIBUTION_KINDS,
} from '../src/gcal/gcal-attribution.js';

test('ATTRIBUTION_KINDS includes expected values', () => {
  assert.ok(ATTRIBUTION_KINDS.includes('ward'));
  assert.ok(ATTRIBUTION_KINDS.includes('villager'));
  assert.ok(ATTRIBUTION_KINDS.includes('phylactery'));
  assert.ok(ATTRIBUTION_KINDS.includes('unassigned'));
  assert.ok(ATTRIBUTION_KINDS.includes('ignore'));
});

test('resolveAttribution: unmapped primary calendar → kind ward', () => {
  const cal = { id: 'p@g', primary: true, summary: 'My calendar' };
  const attr = resolveAttribution(cal, {});
  assert.equal(attr.kind, 'ward');
  assert.equal(attr.ref, null);
  assert.equal(attr.label, 'My calendar');
});

test('resolveAttribution: unmapped non-primary → kind unassigned', () => {
  const cal = { id: 'x@g', primary: false, summary: 'Shared calendar' };
  const attr = resolveAttribution(cal, {});
  assert.equal(attr.kind, 'unassigned');
  assert.equal(attr.ref, null);
  assert.equal(attr.label, 'Shared calendar');
});

test('resolveAttribution: mapped entry wins over primary/unassigned default', () => {
  const cal = { id: 'mom@g', primary: false, summary: 'Mom' };
  const map = {
    'mom@g': { kind: 'villager', ref: 'v123', label: 'Mom calendar' },
  };
  const attr = resolveAttribution(cal, map);
  assert.equal(attr.kind, 'villager');
  assert.equal(attr.ref, 'v123');
  assert.equal(attr.label, 'Mom calendar');
});

test('resolveAttribution: mapped but invalid kind falls back to unassigned', () => {
  const cal = { id: 'x@g', summary: 'X' };
  const map = {
    'x@g': { kind: 'bogus', ref: 'v1' },
  };
  const attr = resolveAttribution(cal, map);
  assert.equal(attr.kind, 'unassigned');
});

test('resolveAttribution: null/undefined calendar handled gracefully', () => {
  const attr = resolveAttribution(null, {});
  assert.equal(attr.kind, 'unassigned');
});

test('isIgnored: calendar with kind=ignore returns true', () => {
  const cal = { id: 'archive@g', summary: 'Archive' };
  const map = { 'archive@g': { kind: 'ignore' } };
  assert.equal(isIgnored(cal, map), true);
});

test('isIgnored: unmapped/mapped-other returns false', () => {
  assert.equal(isIgnored({ id: 'x@g' }, {}), false);
  assert.equal(isIgnored({ id: 'x@g' }, { 'x@g': { kind: 'ward' } }), false);
});

test('wardCalendarId: returns primary if no mapped ward', () => {
  const cals = [
    { id: 'a@g', summary: 'A', primary: false },
    { id: 'p@g', summary: 'Primary', primary: true },
  ];
  const id = wardCalendarId(cals, {});
  assert.equal(id, 'p@g');
});

test('wardCalendarId: prefers mapped ward over primary', () => {
  const cals = [
    { id: 'a@g', primary: false },
    { id: 'p@g', primary: true },
  ];
  const map = { 'a@g': { kind: 'ward' } };
  const id = wardCalendarId(cals, map);
  assert.equal(id, 'a@g');
});

test('wardCalendarId: returns null if no primary and no mapped ward', () => {
  const cals = [
    { id: 'a@g', primary: false },
    { id: 'b@g', primary: false },
  ];
  const id = wardCalendarId(cals, {});
  assert.equal(id, null);
});

test('normalizeAttributionEntry: ward → { ok:true, entry }', () => {
  const result = normalizeAttributionEntry({ kind: 'ward', label: 'My calendar' });
  assert.equal(result.ok, true);
  assert.equal(result.entry.kind, 'ward');
  assert.ok(!('ref' in result.entry));
  assert.equal(result.entry.label, 'My calendar');
});

test('normalizeAttributionEntry: villager without ref → ok:false', () => {
  const result = normalizeAttributionEntry({ kind: 'villager', label: 'Mom' });
  assert.equal(result.ok, false);
  assert.match(result.error, /ref/);
});

test('normalizeAttributionEntry: villager with ref → ok:true', () => {
  const result = normalizeAttributionEntry({ kind: 'villager', ref: 'v123', label: 'Mom' });
  assert.equal(result.ok, true);
  assert.equal(result.entry.kind, 'villager');
  assert.equal(result.entry.ref, 'v123');
});

test('normalizeAttributionEntry: phylactery without ref → ok:false', () => {
  const result = normalizeAttributionEntry({ kind: 'phylactery' });
  assert.equal(result.ok, false);
  assert.match(result.error, /phylactery/);
});

test('normalizeAttributionEntry: phylactery with ref → ok:true', () => {
  const result = normalizeAttributionEntry({ kind: 'phylactery', ref: 'node:456' });
  assert.equal(result.ok, true);
  assert.equal(result.entry.kind, 'phylactery');
  assert.equal(result.entry.ref, 'node:456');
});

test('normalizeAttributionEntry: unassigned never needs ref', () => {
  const result = normalizeAttributionEntry({ kind: 'unassigned', label: 'Unknown' });
  assert.equal(result.ok, true);
  assert.ok(!('ref' in result.entry));
});

test('normalizeAttributionEntry: ignore kind ok', () => {
  const result = normalizeAttributionEntry({ kind: 'ignore' });
  assert.equal(result.ok, true);
  assert.equal(result.entry.kind, 'ignore');
});

test('normalizeAttributionEntry: invalid kind → ok:false', () => {
  const result = normalizeAttributionEntry({ kind: 'bogus' });
  assert.equal(result.ok, false);
});

test('normalizeAttributionEntry: label is trimmed and capped at 120 chars', () => {
  const longLabel = 'x'.repeat(200);
  const result = normalizeAttributionEntry({ kind: 'ward', label: '  ' + longLabel + '  ' });
  assert.equal(result.entry.label.length, 120);
  assert.equal(result.entry.label, 'x'.repeat(120));
});

test('normalizeAttributionEntry: whitespace-only label drops from entry', () => {
  const result = normalizeAttributionEntry({ kind: 'ward', label: '   ' });
  assert.equal(result.ok, true);
  assert.ok(!('label' in result.entry));
});
