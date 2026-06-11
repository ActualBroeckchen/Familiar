import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getRegistry, normalizeRegistry,
  upsertCategory, deleteCategory,
  upsertVillager, deleteVillager,
  upsertLocation, deleteLocation,
  findVillagerByAlias, migrateTrustedContacts,
  initVillageSync, bootSync,
  CATEGORY_EMERGENCY, CATEGORY_STRANGERS,
} from '../village.js';

let dir;
let filePath;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'village-test-'));
  filePath = path.join(dir, 'village.json');
  initVillageSync({}); // no transport — writes go pending
});

afterEach(async () => {
  initVillageSync({});
  await fsp.rm(dir, { recursive: true, force: true });
});

// ── Builtins & normalization (fail-closed) ─────────────────────────

test('fresh registry has both builtin categories', async () => {
  const reg = await getRegistry({ filePath });
  const ids = reg.categories.map(c => c.id);
  assert.ok(ids.includes(CATEGORY_EMERGENCY));
  assert.ok(ids.includes(CATEGORY_STRANGERS));
});

test('strangers grants are empty and locked', async () => {
  const reg = await getRegistry({ filePath });
  const strangers = reg.categories.find(c => c.id === CATEGORY_STRANGERS);
  assert.deepEqual(strangers.grants, {});
  await assert.rejects(
    () => upsertCategory({ id: CATEGORY_STRANGERS, grants: { location: true } }, { filePath }),
    /locked/,
  );
});

test('normalizeRegistry forces strangers grants to {} even if tampered', () => {
  const reg = normalizeRegistry({
    categories: [{ id: CATEGORY_STRANGERS, name: 'Strangers', grants: { location: true, identitySensitive: true } }],
  });
  const strangers = reg.categories.find(c => c.id === CATEGORY_STRANGERS);
  assert.deepEqual(strangers.grants, {});
});

test('normalizeRegistry restores missing builtins', () => {
  const reg = normalizeRegistry({ categories: [], villagers: [], locations: [] });
  assert.ok(reg.categories.some(c => c.id === CATEGORY_EMERGENCY));
  assert.ok(reg.categories.some(c => c.id === CATEGORY_STRANGERS));
});

test('villager with dangling categoryIds is reassigned to strangers (narrow, never widen)', () => {
  const reg = normalizeRegistry({
    villagers: [{ id: 'v1', name: 'Chen', categoryIds: ['deleted-category'] }],
  });
  assert.deepEqual(reg.villagers[0].categoryIds, [CATEGORY_STRANGERS]);
});

test('villager with legacy scalar categoryId is migrated to array', () => {
  const reg = normalizeRegistry({
    categories: [{ id: CATEGORY_EMERGENCY, name: 'Emergency Contacts', grants: {} }],
    villagers: [{ id: 'v1', name: 'Chen', categoryId: CATEGORY_EMERGENCY }],
  });
  assert.deepEqual(reg.villagers[0].categoryIds, [CATEGORY_EMERGENCY]);
  assert.equal('categoryId' in reg.villagers[0], false);
});

test('location with dangling/absent assignedCategoryId falls to strangers', () => {
  const reg = normalizeRegistry({
    locations: [
      { key: 'discord:guild:1:channel:2', assignedCategoryId: 'gone' },
      { key: 'discord:guild:1:channel:3' },
    ],
  });
  for (const l of reg.locations) assert.equal(l.assignedCategoryId, CATEGORY_STRANGERS);
});

test('grant values are restricted to primitives', () => {
  const reg = normalizeRegistry({
    categories: [{ id: 'c1', name: 'Friends', grants: { location: true, schedule: 'coarse', evil: { nested: true }, fn: null } }],
  });
  const c = reg.categories.find(x => x.id === 'c1');
  assert.deepEqual(c.grants, { location: true, schedule: 'coarse' });
});

test('corrupt file on disk yields a clean empty registry', async () => {
  await fsp.writeFile(filePath, '{not json', 'utf8');
  const reg = await getRegistry({ filePath });
  assert.ok(reg.categories.length >= 2);
  assert.deepEqual(reg.villagers, []);
});

// ── Category CRUD ──────────────────────────────────────────────────

test('create / update / delete a custom category', async () => {
  const cat = await upsertCategory({ name: 'Local Friends', grants: { location: true } }, { filePath });
  assert.ok(cat.id);
  assert.equal(cat.builtin, false);

  const updated = await upsertCategory({ id: cat.id, name: 'Locals', grants: { location: true, schedule: 'coarse' } }, { filePath });
  assert.equal(updated.name, 'Locals');
  assert.equal(updated.grants.schedule, 'coarse');

  const res = await deleteCategory({ id: cat.id }, { filePath });
  assert.equal(res.ok, true);
  const reg = await getRegistry({ filePath });
  assert.ok(!reg.categories.some(c => c.id === cat.id));
});

test('builtin emergency-contacts: grants editable, name fixed, not deletable', async () => {
  const updated = await upsertCategory({ id: CATEGORY_EMERGENCY, name: 'Renamed!', grants: { wardPresence: true } }, { filePath });
  assert.equal(updated.name, 'Emergency Contacts');
  assert.deepEqual(updated.grants, { wardPresence: true });
  await assert.rejects(() => deleteCategory({ id: CATEGORY_EMERGENCY }, { filePath }), /built-in/);
});

test('deleting a category with sole-category members requires reassignTo', async () => {
  const cat = await upsertCategory({ name: 'Family', grants: {} }, { filePath });
  await upsertVillager({ name: 'Mum', categoryIds: [cat.id] }, { filePath });
  await assert.rejects(() => deleteCategory({ id: cat.id }, { filePath }), /reassignTo/);
  const res = await deleteCategory({ id: cat.id, reassignTo: CATEGORY_STRANGERS }, { filePath });
  assert.equal(res.reassigned, 1);
  const reg = await getRegistry({ filePath });
  assert.deepEqual(reg.villagers[0].categoryIds, [CATEGORY_STRANGERS]);
});

test('deleting a category from a multi-category villager does not require reassignTo', async () => {
  const cat = await upsertCategory({ name: 'Family', grants: {} }, { filePath });
  await upsertVillager({ name: 'Mum', categoryIds: [cat.id, CATEGORY_EMERGENCY] }, { filePath });
  const res = await deleteCategory({ id: cat.id }, { filePath });
  assert.equal(res.reassigned, 0);
  const reg = await getRegistry({ filePath });
  assert.deepEqual(reg.villagers[0].categoryIds, [CATEGORY_EMERGENCY]);
});

test('deleting a category drops dependent location ceilings to strangers', async () => {
  const cat = await upsertCategory({ name: 'Online Friends', grants: {} }, { filePath });
  await upsertLocation({ key: 'discord:guild:9:channel:9', assignedCategoryId: cat.id }, { filePath });
  await deleteCategory({ id: cat.id }, { filePath });
  const reg = await getRegistry({ filePath });
  assert.equal(reg.locations[0].assignedCategoryId, CATEGORY_STRANGERS);
});

// ── Villager CRUD & alias resolution ───────────────────────────────

test('create villager defaults to strangers when no category given', async () => {
  const v = await upsertVillager({ name: 'Rando' }, { filePath });
  assert.deepEqual(v.categoryIds, [CATEGORY_STRANGERS]);
});

test('villager with unknown category is rejected', async () => {
  await assert.rejects(() => upsertVillager({ name: 'X', categoryIds: ['nope'] }, { filePath }), /unknown category/);
});

test('villager can belong to multiple categories (overlapping)', async () => {
  const cat = await upsertCategory({ name: 'Close Friends', grants: { location: true } }, { filePath });
  const v = await upsertVillager({ name: 'Chen', categoryIds: [CATEGORY_EMERGENCY, cat.id] }, { filePath });
  assert.ok(v.categoryIds.includes(CATEGORY_EMERGENCY));
  assert.ok(v.categoryIds.includes(cat.id));
  assert.equal(v.categoryIds.length, 2);
});

test('legacy scalar categoryId accepted and stored as array', async () => {
  const v = await upsertVillager({ name: 'Chen', categoryId: CATEGORY_EMERGENCY }, { filePath });
  assert.deepEqual(v.categoryIds, [CATEGORY_EMERGENCY]);
});

test('alias resolution matches platform + stable id, not handle', async () => {
  await upsertVillager({
    name: 'Chen',
    categoryIds: [CATEGORY_EMERGENCY],
    aliases: [{ platform: 'Discord', id: '123456789', handle: 'chen_draws' }],
  }, { filePath });

  const hit = await findVillagerByAlias({ platform: 'discord', id: '123456789' }, { filePath });
  assert.equal(hit?.name, 'Chen');

  // Handle alone never matches — display names are spoofable.
  const miss = await findVillagerByAlias({ platform: 'discord', id: 'chen_draws' }, { filePath });
  assert.equal(miss, null);
});

test('aliases without a stable id are dropped at sanitization', async () => {
  const v = await upsertVillager({
    name: 'Sam',
    aliases: [{ platform: 'discord', handle: 'only-a-handle' }, { platform: 'discord', id: '42' }],
  }, { filePath });
  assert.equal(v.aliases.length, 1);
  assert.equal(v.aliases[0].id, '42');
});

test('update villager: move categories, clear triage', async () => {
  const cat = await upsertCategory({ name: 'Family', grants: {} }, { filePath });
  const v = await upsertVillager({ name: 'Mum', categoryIds: [CATEGORY_EMERGENCY], triage: { webhook: 'https://example.test/hook' } }, { filePath });
  assert.ok(v.triage);
  const updated = await upsertVillager({ id: v.id, categoryIds: [cat.id], triage: null }, { filePath });
  assert.deepEqual(updated.categoryIds, [cat.id]);
  assert.equal(updated.triage, undefined);
});

test('delete villager', async () => {
  const v = await upsertVillager({ name: 'Temp' }, { filePath });
  await deleteVillager({ id: v.id }, { filePath });
  const reg = await getRegistry({ filePath });
  assert.equal(reg.villagers.length, 0);
  await assert.rejects(() => deleteVillager({ id: v.id }, { filePath }), /unknown villager/);
});

// ── Locations ──────────────────────────────────────────────────────

test('upsert location: new location defaults to strangers ceiling', async () => {
  const loc = await upsertLocation({ key: 'discord:guild:1:channel:2', label: 'Cozy #general' }, { filePath });
  assert.equal(loc.assignedCategoryId, CATEGORY_STRANGERS);
});

test('location rate limit is floored to non-negative integers', async () => {
  const loc = await upsertLocation({ key: 'k1', rateLimit: { perHour: 12.7 } }, { filePath });
  assert.deepEqual(loc.rateLimit, { perHour: 12 });
  const cleared = await upsertLocation({ key: 'k1', rateLimit: null }, { filePath });
  assert.equal(cleared.rateLimit, undefined);
});

// ── Migration ──────────────────────────────────────────────────────

test('trustedContacts migrate into Emergency Contacts, idempotently', async () => {
  const contacts = [
    { name: 'Chen', webhook: 'https://example.test/hook', channel: 'discord' },
    { name: 'Mum', webhook: 'https://example.test/hook2' },
  ];
  const first = await migrateTrustedContacts(contacts, { filePath });
  assert.equal(first.imported, 2);
  const second = await migrateTrustedContacts(contacts, { filePath });
  assert.equal(second.imported, 0);

  const reg = await getRegistry({ filePath });
  assert.equal(reg.villagers.length, 2);
  for (const v of reg.villagers) {
    assert.deepEqual(v.categoryIds, [CATEGORY_EMERGENCY]);
    assert.ok(v.triage?.webhook);
  }
});

// ── Sync semantics ─────────────────────────────────────────────────

test('write with no transport marks syncPending', async () => {
  await upsertVillager({ name: 'Chen' }, { filePath });
  const reg = await getRegistry({ filePath });
  assert.equal(reg.syncPending, true);
});

test('write-through: successful push clears syncPending; failure sets it', async () => {
  let pushes = 0;
  initVillageSync({ push: async () => { pushes++; return { ok: true }; } });
  await upsertVillager({ name: 'Chen' }, { filePath });
  let reg = await getRegistry({ filePath });
  assert.equal(reg.syncPending, false);
  assert.equal(pushes, 1);

  initVillageSync({ push: async () => ({ ok: false, error: 'entity-core down' }) });
  await upsertVillager({ name: 'Sam' }, { filePath });
  reg = await getRegistry({ filePath });
  assert.equal(reg.syncPending, true);
});

test('push that throws never surfaces as a registry error', async () => {
  initVillageSync({ push: async () => { throw new Error('boom'); } });
  const v = await upsertVillager({ name: 'Chen' }, { filePath });
  assert.ok(v.id); // mutation succeeded
  const reg = await getRegistry({ filePath });
  assert.equal(reg.syncPending, true);
});

test('canonical copy excludes syncPending', async () => {
  let captured = null;
  initVillageSync({ push: async (json) => { captured = JSON.parse(json); return { ok: true }; } });
  await upsertVillager({ name: 'Chen' }, { filePath });
  assert.ok(captured);
  assert.equal('syncPending' in captured, false);
  assert.ok(Array.isArray(captured.villagers));
});

test('bootSync: canonical newer overwrites mirror', async () => {
  await upsertVillager({ name: 'OldLocal' }, { filePath });
  const future = new Date(Date.now() + 60_000).toISOString();
  initVillageSync({
    pull: async () => ({
      updatedAt: future,
      categories: [],
      villagers: [{ id: 'v-canon', name: 'CanonChen', categoryIds: [CATEGORY_EMERGENCY] }],
      locations: [],
    }),
  });
  const reg = await bootSync({ filePath });
  assert.equal(reg.villagers.length, 1);
  assert.equal(reg.villagers[0].name, 'CanonChen');
  // Builtins restored on the pulled copy too (normalization on ingest).
  assert.ok(reg.categories.some(c => c.id === CATEGORY_STRANGERS));
});

test('bootSync: older canonical does not clobber mirror; pending mirror replays', async () => {
  await upsertVillager({ name: 'LocalChen' }, { filePath }); // pending (no transport)
  let pushed = false;
  initVillageSync({
    pull: async () => ({ updatedAt: new Date(0).toISOString(), categories: [], villagers: [], locations: [] }),
    push: async () => { pushed = true; return { ok: true }; },
  });
  const reg = await bootSync({ filePath });
  assert.equal(reg.villagers[0].name, 'LocalChen');
  assert.equal(pushed, true);
  assert.equal(reg.syncPending, false);
});

test('bootSync: pull failure leaves mirror authoritative (never throws)', async () => {
  await upsertVillager({ name: 'Chen' }, { filePath });
  initVillageSync({ pull: async () => { throw new Error('entity-core down'); } });
  const reg = await bootSync({ filePath });
  assert.equal(reg.villagers[0].name, 'Chen');
});
