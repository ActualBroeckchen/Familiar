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
  findVillagerByAlias, villagerByAlias, migrateTrustedContacts,
  seedDefaultCategories,
  initVillageSync, bootSync,
  migrateCategoryIds,
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

test('grant values are restricted to primitives (except the topics map)', () => {
  const reg = normalizeRegistry({
    categories: [{ id: 'c1', name: 'Friends', grants: { location: true, schedule: 'coarse', evil: { nested: true }, fn: null } }],
  });
  const c = reg.categories.find(x => x.id === 'c1');
  // Coarse primitives kept; arbitrary nested objects + null stripped.
  assert.equal(c.grants.location, true);
  assert.equal(c.grants.schedule, 'coarse');
  assert.equal(c.grants.evil, undefined);
  assert.equal(c.grants.fn, undefined);
  // `topics` is the ONE nested object kept — here seeded from the location grant.
  assert.deepEqual(c.grants.topics, { location: 'open' });
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

  // The pure form matches against an already-loaded registry (one read, many ids —
  // what the voice-call roster builder uses to name several speakers at once).
  const reg = await getRegistry({ filePath });
  assert.equal(villagerByAlias(reg, { platform: 'discord', id: '123456789' })?.name, 'Chen');
  assert.equal(villagerByAlias(reg, { platform: 'Discord', id: '123456789' })?.name, 'Chen');  // platform case-insensitive
  assert.equal(villagerByAlias(reg, { platform: 'discord', id: 'nope' }), null);
  assert.equal(villagerByAlias(null, { platform: 'discord', id: '123456789' }), null);          // no registry → null, never throws
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

test('standingConsent: only true flags persist; both-true round-trips', async () => {
  const v = await upsertVillager(
    { name: 'Melian', standingConsent: { wardAgreed: true, villagerAgreed: true, junk: 'x' } },
    { filePath },
  );
  assert.deepEqual(v.standingConsent, { wardAgreed: true, villagerAgreed: true });
  // Regression: it must survive the read-path normalizer too, not just the
  // write's return value — else the editor re-renders with the boxes unchecked.
  const reg = await getRegistry({ filePath });
  assert.deepEqual(reg.villagers.find(x => x.id === v.id).standingConsent,
    { wardAgreed: true, villagerAgreed: true });
});

test('standingConsent: a partial (one side) is kept; an empty object clears it', async () => {
  const v = await upsertVillager({ name: 'Melian', standingConsent: { wardAgreed: true, villagerAgreed: false } }, { filePath });
  assert.deepEqual(v.standingConsent, { wardAgreed: true });
  const cleared = await upsertVillager({ id: v.id, standingConsent: { wardAgreed: false, villagerAgreed: false } }, { filePath });
  assert.equal(cleared.standingConsent, undefined);
});

test('disclosure: per-category audience tags persist; empty clears', async () => {
  const v = await upsertVillager(
    { name: 'Mum', disclosure: { health_info: 'family', basics: 'friends', junk: 'x', whereabouts: '  ' } },
    { filePath },
  );
  // only known remember-categories with a non-empty string value survive
  assert.deepEqual(v.disclosure, { health_info: 'family', basics: 'friends' });
  // Regression: it must survive the read-path normalizer too — and survive an
  // unrelated mutate to ANOTHER villager (which re-reads + rewrites the whole
  // registry). This is the round-trip the upsert-return-value assert above
  // can't catch (the standingConsent/disclosure disappearing-value class).
  await upsertVillager({ name: 'Someone Else' }, { filePath });
  const reg = await getRegistry({ filePath });
  assert.deepEqual(reg.villagers.find(x => x.id === v.id).disclosure,
    { health_info: 'family', basics: 'friends' });
  const cleared = await upsertVillager({ id: v.id, disclosure: {} }, { filePath });
  assert.equal(cleared.disclosure, undefined);
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

// ── Presence modes (V8) ────────────────────────────────────────────

test('location defaults to strict mode', async () => {
  const loc = await upsertLocation({ key: 'discord:guild:1:channel:2' }, { filePath });
  assert.equal(loc.mode, 'strict');
});

test('unknown mode falls back to strict (never chattier than asked)', async () => {
  const reg = normalizeRegistry({
    categories: [], villagers: [],
    locations: [{ key: 'k', mode: 'screaming' }],
  });
  assert.equal(reg.locations[0].mode, 'strict');
});

test('lurk mode is stored, no active sub-fields kept', async () => {
  const loc = await upsertLocation({ key: 'k', mode: 'lurk', activeStrategy: 'tiers', activeCooldownSec: 30 }, { filePath });
  assert.equal(loc.mode, 'lurk');
  assert.equal(loc.activeStrategy, undefined);
  assert.equal(loc.activeCooldownSec, undefined);
});

test('active mode keeps strategy + cooldown; defaults applied on read', async () => {
  await upsertLocation({ key: 'k', mode: 'active' }, { filePath });
  const reg = await getRegistry({ filePath });
  const loc = reg.locations.find(l => l.key === 'k');
  assert.equal(loc.mode, 'active');
  assert.equal(loc.activeStrategy, 'llm');         // DEFAULT_ACTIVE_STRATEGY
  assert.equal(loc.activeCooldownSec, 60);         // DEFAULT_ACTIVE_COOLDOWN_SEC
});

test('active mode accepts a valid strategy + cooldown', async () => {
  const loc = await upsertLocation({ key: 'k', mode: 'active', activeStrategy: 'tiers', activeCooldownSec: 45 }, { filePath });
  assert.equal(loc.activeStrategy, 'tiers');
  assert.equal(loc.activeCooldownSec, 45);
});

test('switching active → strict clears strategy + cooldown', async () => {
  await upsertLocation({ key: 'k', mode: 'active', activeStrategy: 'tiers', activeCooldownSec: 45 }, { filePath });
  const loc = await upsertLocation({ key: 'k', mode: 'strict' }, { filePath });
  assert.equal(loc.mode, 'strict');
  assert.equal(loc.activeStrategy, undefined);
  assert.equal(loc.activeCooldownSec, undefined);
});

test('invalid active strategy is ignored (keeps default on read)', async () => {
  await upsertLocation({ key: 'k', mode: 'active', activeStrategy: 'telepathy' }, { filePath });
  const reg = await getRegistry({ filePath });
  assert.equal(reg.locations.find(l => l.key === 'k').activeStrategy, 'llm');
});

test('readBots defaults off and is independent of presence mode', async () => {
  const loc = await upsertLocation({ key: 'k', mode: 'lurk' }, { filePath });
  assert.equal(loc.readBots, undefined, 'off by default');
  const on = await upsertLocation({ key: 'k', readBots: true }, { filePath });
  assert.equal(on.readBots, true, 'enables without touching mode');
  assert.equal(on.mode, 'lurk', 'mode preserved');
});

test('readBots survives a normalize round-trip and can be cleared', async () => {
  await upsertLocation({ key: 'k', readBots: true }, { filePath });
  const reg = await getRegistry({ filePath });
  assert.equal(reg.locations.find(l => l.key === 'k').readBots, true);
  const off = await upsertLocation({ key: 'k', readBots: false }, { filePath });
  assert.equal(off.readBots, undefined, 'false clears the flag');
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

// ── Default category seeding ───────────────────────────────────────

test('fresh registry includes the three default categories', async () => {
  const reg = await getRegistry({ filePath });
  const names = reg.categories.map(c => c.name);
  assert.ok(names.includes('Close Friends'));
  assert.ok(names.includes('Acquaintances'));
  assert.ok(names.includes('Care Network'));
});

test('seedDefaultCategories is idempotent — no duplicate on re-run', async () => {
  const first  = await seedDefaultCategories({ filePath });
  assert.equal(first.added, 0); // already seeded by emptyRegistry via getRegistry above
  const second = await seedDefaultCategories({ filePath });
  assert.equal(second.added, 0);
  const reg = await getRegistry({ filePath });
  const closeFriends = reg.categories.filter(c => c.name === 'Close Friends');
  assert.equal(closeFriends.length, 1);
});

test('seedDefaultCategories back-fills categories missing from an existing registry', async () => {
  // Write a registry that only has the builtins.
  const { promises: fsp2 } = await import('node:fs');
  await fsp2.writeFile(filePath, JSON.stringify({
    updatedAt: new Date().toISOString(),
    syncPending: false,
    categories: [
      { id: CATEGORY_EMERGENCY, name: 'Emergency Contacts', grants: {} },
      { id: CATEGORY_STRANGERS, name: 'Strangers', grants: {} },
    ],
    villagers: [],
    locations: [],
  }), 'utf8');
  const result = await seedDefaultCategories({ filePath });
  assert.equal(result.added, 3);
  const reg = await getRegistry({ filePath });
  assert.ok(reg.categories.some(c => c.name === 'Close Friends'));
  assert.ok(reg.categories.some(c => c.name === 'Care Network'));
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

  initVillageSync({ push: async () => ({ ok: false, error: 'Phylactery down' }) });
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
  initVillageSync({ pull: async () => { throw new Error('Phylactery down'); } });
  const reg = await bootSync({ filePath });
  assert.equal(reg.villagers[0].name, 'Chen');
});

// ── Category-id slug migration (readable ids, not UUIDs) ─────────────

test('migrateCategoryIds: legacy seed UUIDs → their slugs; ward UUIDs → name slugs; slugs untouched', () => {
  const map = migrateCategoryIds([
    { id: '00000000-0000-4000-8001-000000000001', name: 'Close Friends' },
    { id: '00000000-0000-4000-8001-000000000003', name: 'Care Network' },
    { id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', name: 'Book Club' },
    { id: 'strangers', name: 'Strangers' },                 // already a slug → kept
  ]);
  assert.equal(map.get('00000000-0000-4000-8001-000000000001'), 'close-friends');
  assert.equal(map.get('00000000-0000-4000-8001-000000000003'), 'care-network');
  assert.equal(map.get('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'), 'book-club');
  assert.equal(map.has('strangers'), false);                // slug ids are not remapped
});

test('migrateCategoryIds: name-slug collisions get a numeric suffix', () => {
  const map = migrateCategoryIds([
    { id: '11111111-1111-4111-8111-111111111111', name: 'Family' },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Family' },
  ]);
  const slugs = [...map.values()];
  assert.deepEqual(slugs, ['family', 'family-2']);
});

test('normalizeRegistry migrates UUID category ids across every reference', () => {
  const reg = normalizeRegistry({
    categories: [
      { id: '00000000-0000-4000-8001-000000000001', name: 'Close Friends', grants: { health: true } },
    ],
    villagers: [
      { id: 'v1', name: 'Chen', categoryIds: ['00000000-0000-4000-8001-000000000001'] },
    ],
    locations: [
      { key: 'guild:1/chan:2', label: 'Lounge', assignedCategoryId: '00000000-0000-4000-8001-000000000001' },
    ],
  });
  assert.ok(reg.categories.some(c => c.id === 'close-friends'));
  assert.ok(!reg.categories.some(c => /^0{8}-/.test(c.id)));
  assert.deepEqual(reg.villagers[0].categoryIds, ['close-friends']);
  assert.equal(reg.locations[0].assignedCategoryId, 'close-friends');
});

test('upsertCategory mints a readable slug id, not a UUID', async () => {
  const cat = await upsertCategory({ name: 'Work Friends', grants: {} }, { filePath });
  assert.equal(cat.id, 'work-friends');
  const cat2 = await upsertCategory({ name: 'Work Friends', grants: {} }, { filePath });
  assert.equal(cat2.id, 'work-friends-2');   // collision → suffix
});

test('pendingCategoryAudienceRemap: always includes the fixed legacy-seed map', async () => {
  const { pendingCategoryAudienceRemap } = await import('../village.js');
  // No file at this path → seed map only (the three legacy seed UUIDs → slugs).
  const map = await pendingCategoryAudienceRemap({ filePath: path.join(dir, 'nonexistent.json') });
  assert.equal(map['00000000-0000-4000-8001-000000000001'], 'close-friends');
  assert.equal(map['00000000-0000-4000-8001-000000000002'], 'acquaintances');
  assert.equal(map['00000000-0000-4000-8001-000000000003'], 'care-network');
});

test('pendingCategoryAudienceRemap: unions ward-created UUID → name-slug from the raw file', async () => {
  const { pendingCategoryAudienceRemap } = await import('../village.js');
  const raw = { categories: [{ id: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e', name: 'Book Club' }] };
  await fsp.writeFile(filePath, JSON.stringify(raw), 'utf8');
  const map = await pendingCategoryAudienceRemap({ filePath });
  assert.equal(map['b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e'], 'book-club');
  assert.equal(map['00000000-0000-4000-8001-000000000001'], 'close-friends'); // seeds still present
});

// ── Content-gating Phase 2: per-topic grant seeding + preservation ──

test('normalizeRegistry: seeds per-topic grants from coarse grants (first time only)', () => {
  const reg = normalizeRegistry({
    categories: [
      { id: 'close', name: 'Close', grants: { identitySensitive: true, memories: true } },
      { id: 'care',  name: 'Care',  grants: { health: true, memories: 'shared' } },
      { id: 'acq',   name: 'Acq',   grants: { identityBasic: true } },
    ],
  });
  const g = id => reg.categories.find(c => c.id === id).grants.topics;
  // identitySensitive → every topic at sensitive.
  assert.equal(g('close').medical, 'sensitive');
  assert.equal(g('close').sexuality, 'sensitive');
  // health → medical topics; memories:'shared' → general open; NOT sexuality (conservative).
  assert.equal(g('care').medical, 'sensitive');
  assert.equal(g('care').general, 'open');
  assert.ok(!g('care').sexuality);
  // identityBasic → general open only.
  assert.deepEqual(g('acq'), { general: 'open' });
});

test('normalizeRegistry: never overwrites an existing (ward-set) topics map', () => {
  const reg = normalizeRegistry({
    categories: [{ id: 'c', name: 'C', grants: { identitySensitive: true, topics: { medical: 'open' } } }],
  });
  assert.deepEqual(reg.categories.find(c => c.id === 'c').grants.topics, { medical: 'open' });
});

test('upsertCategory: a topic-less update preserves the tier topic grants', async () => {
  const cat = await upsertCategory({ name: 'Friends', grants: { identitySensitive: true } }, { filePath });
  // Migration seeds topics on read.
  let after = (await getRegistry({ filePath })).categories.find(c => c.id === cat.id);
  assert.equal(after.grants.topics.medical, 'sensitive');
  // A legacy-editor save (no `topics` key) must keep them while replacing coarse grants.
  await upsertCategory({ id: cat.id, grants: { identityBasic: true } }, { filePath });
  after = (await getRegistry({ filePath })).categories.find(c => c.id === cat.id);
  assert.equal(after.grants.topics.medical, 'sensitive');
  assert.equal(after.grants.identitySensitive, undefined);
});

test('upsertCategory: an explicit topics map replaces', async () => {
  const cat = await upsertCategory({ name: 'Friends', grants: { identitySensitive: true } }, { filePath });
  await upsertCategory({ id: cat.id, grants: { identityBasic: true, topics: { medical: 'open' } } }, { filePath });
  const after = (await getRegistry({ filePath })).categories.find(c => c.id === cat.id);
  assert.deepEqual(after.grants.topics, { medical: 'open' });
});

test('upsertCategory: an explicit empty topics map persists (clear-all is not re-derived)', async () => {
  const cat = await upsertCategory({ name: 'Friends', grants: { identitySensitive: true } }, { filePath });
  // The ward sets every topic to Hidden → topics: {}. It must STICK, not
  // re-seed from identitySensitive on the next read.
  await upsertCategory({ id: cat.id, grants: { identitySensitive: true, topics: {} } }, { filePath });
  const after = (await getRegistry({ filePath })).categories.find(c => c.id === cat.id);
  assert.deepEqual(after.grants.topics, {});
});
