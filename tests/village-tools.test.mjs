import { test } from 'node:test';
import assert from 'node:assert/strict';

import { initCerebellumTools, executeToolCall } from '../cerebellum.js';
import { normalizeRegistry, upsertVillager } from '../village.js';

// ── village.js: privateNotes field round-trips ──────────────────────

test('normalizeRegistry keeps privateNotes when present, drops when blank', () => {
  const reg = normalizeRegistry({
    categories: [{ id: 'family', name: 'Family' }],
    villagers: [
      { id: 'v1', name: 'Sam', categoryIds: ['family'], privateNotes: '  trans, not out at work  ' },
      { id: 'v2', name: 'Chen', categoryIds: ['family'], privateNotes: '   ' },
    ],
  });
  const sam = reg.villagers.find(v => v.id === 'v1');
  const chen = reg.villagers.find(v => v.id === 'v2');
  assert.equal(sam.privateNotes, 'trans, not out at work', 'trimmed + kept');
  assert.equal('privateNotes' in chen, false, 'blank privateNotes dropped');
});

test('upsertVillager writes and clears privateNotes (in-memory file)', async () => {
  const filePath = `/tmp/pf-village-tools-${process.pid}-${Date.now()}.json`;
  const created = await upsertVillager(
    { name: 'Sam', privateNotes: 'sensitive thing' }, { filePath });
  assert.equal(created.privateNotes, 'sensitive thing');
  // Editing with an empty string clears it (applyOptStr semantics).
  const edited = await upsertVillager(
    { id: created.id, privateNotes: '' }, { filePath });
  assert.equal('privateNotes' in edited, false, 'empty string clears privateNotes');
});

// ── Tool gating (the safety-critical behavior) ──────────────────────
//
// The whole point of privateNotes is that it surfaces to the Familiar
// ONLY when it's just the ward in the room. These tests pin that.

const REGISTRY = {
  categories: [
    { id: 'family', name: 'Family' },
    { id: 'strangers', name: 'Strangers' },
  ],
  villagers: [
    { id: 'v1', name: 'Sam', categoryIds: ['family'],
      aliases: [{ platform: 'discord', id: '777', handle: 'sam_d' }],
      relationToWard: 'sister', notes: 'likes cats',
      privateNotes: 'recently diagnosed — not public', graphNodeId: 'node-sam' },
  ],
  locations: [
    { key: 'guild:1/chan:2', label: '#general', assignedCategoryId: 'family' },
    { key: 'discord:guild:5:channel:6', label: 'Book Club', assignedCategoryId: 'family', mode: 'active' },
  ],
};

function withFakeVillage(run) {
  const calls = [];
  initCerebellumTools({
    getVillageRegistry: async () => normalizeRegistry(REGISTRY),
    upsertVillager: async (args) => { calls.push(args); return { id: args.id ?? 'new-id', name: args.name ?? 'Sam', graphNodeId: args.graphNodeId }; },
  });
  return run(calls);
}

test('village_lookup: ward-private turn discloses privateNotes', async () => {
  await withFakeVillage(async () => {
    const out = await executeToolCall('village_lookup', '{}', { wardPrivate: true });
    assert.match(out, /Sam/);
    assert.match(out, /recently diagnosed/, 'private notes shown to the ward');
    assert.match(out, /Linked graph node: node-sam/);
  });
});

test('village_lookup: others present → privateNotes withheld, rest still shows', async () => {
  await withFakeVillage(async () => {
    const out = await executeToolCall('village_lookup', '{}', { wardPrivate: false });
    assert.match(out, /Sam/, 'the person still surfaces');
    assert.match(out, /likes cats/, 'ordinary notes still surface');
    assert.doesNotMatch(out, /recently diagnosed/, 'private notes MUST be withheld');
    assert.match(out, /withheld/i, 'a marker that something was held back');
  });
});

test('village_lookup: undefined wardPrivate defaults to full disclosure (ward-own paths)', async () => {
  await withFakeVillage(async () => {
    const out = await executeToolCall('village_lookup', '{}', {});
    assert.match(out, /recently diagnosed/, 'undefined → treated as ward-private');
  });
});

test('village_lookup: filters by category name', async () => {
  await withFakeVillage(async () => {
    const hit = await executeToolCall('village_lookup', JSON.stringify({ category: 'Family' }), { wardPrivate: true });
    assert.match(hit, /Sam/);
    const miss = await executeToolCall('village_lookup', JSON.stringify({ category: 'Strangers' }), { wardPrivate: true });
    assert.match(miss, /No one in the Village matches/);
  });
});

test('village_lookup: filters by location (resolves to its category)', async () => {
  await withFakeVillage(async () => {
    const out = await executeToolCall('village_lookup', JSON.stringify({ location: '#general' }), { wardPrivate: true });
    assert.match(out, /Sam/, 'location → assigned category → matching villagers');
  });
});

// ── Discoverability for relay (V8 / request 2) ─────────────────────

test('village_lookup: roster view lists Places I can relay to', async () => {
  await withFakeVillage(async () => {
    const out = await executeToolCall('village_lookup', '{}', { wardPrivate: true });
    assert.match(out, /Places I'm present in/, 'the location roster is surfaced');
    assert.match(out, /Book Club/, 'each place is named (relay-by-label)');
    assert.match(out, /active mode/, 'the place carries its presence mode');
  });
});

test('village_lookup: marks which villagers are reachable on Discord', async () => {
  await withFakeVillage(async () => {
    const out = await executeToolCall('village_lookup', '{}', { wardPrivate: true });
    assert.match(out, /Sam.*reachable on Discord/, 'a Discord-aliased villager is flagged reachable');
  });
});

test('village_lookup: a non-Discord location is flagged not-postable', async () => {
  await withFakeVillage(async () => {
    const out = await executeToolCall('village_lookup', '{}', { wardPrivate: true });
    assert.match(out, /#general.*not a room I can post into/, 'non-Discord keys are marked unreachable');
  });
});

test('village_lookup: a targeted name search omits the Places footer (about the person)', async () => {
  await withFakeVillage(async () => {
    const out = await executeToolCall('village_lookup', JSON.stringify({ name: 'Sam' }), { wardPrivate: true });
    assert.match(out, /Sam/);
    assert.doesNotMatch(out, /Places I'm present in/, 'name lookups stay focused on the person');
  });
});

test('village_upsert: others present → creating a just-met person is allowed', async () => {
  await withFakeVillage(async (calls) => {
    const out = await executeToolCall('village_upsert',
      JSON.stringify({ name: 'New Person', notes: 'met at the café' }), { wardPrivate: false });
    assert.equal(calls.length, 1, 'creation is allowed mid-room');
    assert.equal(calls[0].name, 'New Person');
    assert.match(out, /added in the Village/i);
  });
});

test('village_upsert: others present → editing an existing record is deferred for consent', async () => {
  await withFakeVillage(async (calls) => {
    const out = await executeToolCall('village_upsert',
      JSON.stringify({ id: 'v1', notes: 'changed' }), { wardPrivate: false });
    assert.equal(calls.length, 0, 'no mutation to an existing record with others present');
    assert.match(out, /bring it up with them|just us|confirm/i, 'defers for the ward\'s consent');
  });
});

test('village_upsert: others present → privateNotes on a new person is held back', async () => {
  await withFakeVillage(async (calls) => {
    const out = await executeToolCall('village_upsert',
      JSON.stringify({ name: 'New Person', privateNotes: 'sensitive' }), { wardPrivate: false });
    assert.equal(calls.length, 1, 'the person is still created');
    assert.equal('privateNotes' in calls[0], false, 'but the sensitive bucket is NOT written mid-room');
    assert.match(out, /held the private detail|once it's just us/i);
  });
});

test('village_upsert: ward-private create resolves category name → id and links graph node', async () => {
  await withFakeVillage(async (calls) => {
    const out = await executeToolCall('village_upsert',
      JSON.stringify({ name: 'Mum', category: 'Family', graphNodeId: 'node-mum', privateNotes: 'x' }),
      { wardPrivate: true });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].categoryIds, ['family'], 'category name resolved to id');
    assert.equal(calls[0].graphNodeId, 'node-mum');
    assert.equal(calls[0].privateNotes, 'x');
    assert.match(out, /added in the Village/i);
  });
});

test('village_upsert: unknown category name is reported, no mutation', async () => {
  await withFakeVillage(async (calls) => {
    const out = await executeToolCall('village_upsert',
      JSON.stringify({ name: 'X', category: 'Nonexistent' }), { wardPrivate: true });
    assert.match(out, /don't have a category called/i);
    assert.equal(calls.length, 0);
  });
});
