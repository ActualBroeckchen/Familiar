// village.js — the Village registry (V1 of Village Support)
//
// Stores who is in my human's Village: ward-defined categories with
// grant sets, villagers with platform aliases, and locations (virtual
// places) with trust ceilings. This module is the LOCAL MIRROR — the
// copy Thalamus and Cerebellum read at runtime so the knowledge gate
// never depends on a live MCP peer (fail-closed requires the gate to
// work even when Phylactery is down).
//
// The canonical copy lives in Phylactery (hybrid model, see
// docs/village-support-design.md "Registry storage"). Sync contract:
//   - writes are write-through: mutate mirror → push canonical;
//     push failure marks syncPending and never throws into the caller
//   - bootSync() pulls canonical at startup; canonical-wins when newer
//   - reads NEVER touch MCP — gating is a local file read, full stop
//
// The sync transport is injected via initVillageSync() so this module
// stays import-safe for tests (same pattern as initCerebellumTools):
// server.js wires the real Phylactery push/pull at boot.
//
// Concurrency: every read-modify-write goes through thalamus's
// withLock (import-safe; MCP children spawn on startThalamus(), not
// import) keyed on the registry path. Atomic writes via .tmp + rename.

import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsp } from 'fs';
import { randomUUID } from 'crypto';
import { withLock } from './thalamus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_VILLAGE_PATH = path.join(__dirname, 'village.json');

// ── Built-in categories ───────────────────────────────────────────
//
// Two categories always exist and cannot be deleted:
//   - emergency-contacts: reachable by triage escalation, told only
//     ward-presence-level information. Grants editable (the ward may
//     widen them), name fixed.
//   - strangers: the floor. Grants are LOCKED to {} — the most
//     prohibitive tier is not configurable, by design. Anyone
//     unrecognized resolves here, and the audience intersection rule
//     means one stranger in the room floors everything.

export const CATEGORY_EMERGENCY = 'emergency-contacts';
export const CATEGORY_STRANGERS = 'strangers';

// ── Default category seeds ────────────────────────────────────────
//
// Three pre-seeded categories provided on fresh installs (and back-filled
// on first boot for existing registries). Not builtins — the ward can
// rename, adjust grants, or delete them freely. Stable IDs make seeding
// idempotent across upgrades.

const CAT_CLOSE_FRIENDS = '00000000-0000-4000-8001-000000000001';
const CAT_ACQUAINTANCES  = '00000000-0000-4000-8001-000000000002';
const CAT_CARE_NETWORK   = '00000000-0000-4000-8001-000000000003';

const DEFAULT_CATEGORY_SEEDS = [
  {
    id: CAT_CLOSE_FRIENDS,
    name: 'Close Friends',
    builtin: false,
    grants: {
      identityBasic: true,
      identitySensitive: true,   // V3 gate: everything except address
      wardPresence: true,
      memories: true,
      health: true,
      schedule: 'full',
      contacts: true,
    },
  },
  {
    id: CAT_ACQUAINTANCES,
    name: 'Acquaintances',
    builtin: false,
    grants: {
      identityBasic: true,       // online name, surface persona
      wardPresence: true,
      memories: 'shared',        // only memories they're actually part of
    },
  },
  {
    id: CAT_CARE_NETWORK,
    name: 'Care Network',
    builtin: false,
    grants: {
      identityBasic: true,
      wardPresence: true,
      health: true,              // medical context
      schedule: 'coarse',        // rough rhythms only
      contacts: 'care-visible',  // emergency + close friends when relevant
    },
  },
];

function builtinCategories() {
  return [
    {
      id: CATEGORY_EMERGENCY,
      name: 'Emergency Contacts',
      builtin: true,
      grants: { wardPresence: true, triageContact: true },
    },
    {
      id: CATEGORY_STRANGERS,
      name: 'Strangers',
      builtin: true,
      grants: {},
    },
  ];
}

function emptyRegistry() {
  return {
    updatedAt: new Date(0).toISOString(),
    syncPending: false,
    categories: [...builtinCategories(), ...DEFAULT_CATEGORY_SEEDS.map(d => ({ ...d }))],
    villagers: [],
    locations: [],
  };
}

// ── Normalization (fail-closed) ───────────────────────────────────
//
// Every read passes through here. Guarantees:
//   - builtins present, strangers' grants forced to {}
//   - grant values restricted to primitives (boolean | string)
//   - villagers with an unknown categoryId are reassigned to
//     strangers (the floor) — a dangling reference must never widen
//     access, so it narrows it
//   - shapes coerced so downstream code never sees undefined arrays

function sanitizeGrants(grants) {
  const out = {};
  if (grants && typeof grants === 'object' && !Array.isArray(grants)) {
    for (const [k, v] of Object.entries(grants)) {
      if (typeof v === 'boolean' || typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

function normalizeCategoryIds(raw, byId) {
  const valid = (Array.isArray(raw) ? raw : [])
    .filter(id => typeof id === 'string' && byId.has(id));
  return valid.length > 0 ? [...new Set(valid)] : [CATEGORY_STRANGERS];
}

function sanitizeAliases(aliases) {
  if (!Array.isArray(aliases)) return [];
  return aliases
    .filter(a => a && typeof a === 'object' && typeof a.platform === 'string' && a.platform.trim()
      && (typeof a.id === 'string' && a.id.trim()))
    .map(a => ({
      platform: a.platform.trim().toLowerCase(),
      id: a.id.trim(),
      ...(typeof a.handle === 'string' && a.handle.trim() ? { handle: a.handle.trim() } : {}),
    }));
}

export function normalizeRegistry(raw) {
  const reg = (raw && typeof raw === 'object') ? raw : {};
  const categories = Array.isArray(reg.categories) ? reg.categories : [];

  const byId = new Map();
  for (const c of categories) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id.trim()) continue;
    if (typeof c.name !== 'string' || !c.name.trim()) continue;
    byId.set(c.id, {
      id: c.id,
      name: c.name.trim(),
      builtin: c.id === CATEGORY_EMERGENCY || c.id === CATEGORY_STRANGERS,
      grants: sanitizeGrants(c.grants),
    });
  }
  // Builtins always exist; strangers' grants are locked to the floor.
  for (const b of builtinCategories()) {
    const existing = byId.get(b.id);
    if (!existing) byId.set(b.id, b);
    else {
      existing.name = b.name;       // builtin names are fixed
      existing.builtin = true;
      if (b.id === CATEGORY_STRANGERS) existing.grants = {};
    }
  }

  const villagers = (Array.isArray(reg.villagers) ? reg.villagers : [])
    .filter(v => v && typeof v === 'object' && typeof v.id === 'string' && v.id.trim()
      && typeof v.name === 'string' && v.name.trim())
    .map(v => {
      const relFam = RELATION_TO_FAMILIAR_VALUES.includes(v.relationToFamiliar)
        ? v.relationToFamiliar : 'unaware';
      const rem = sanitizeRemember(v.remember);
      return {
        id: v.id,
        name: v.name.trim(),
        // Accepts both categoryIds[] (new) and legacy categoryId scalar.
        // Dangling / empty → [strangers]. Narrow, never widen.
        categoryIds: normalizeCategoryIds(
          v.categoryIds ?? (v.categoryId ? [v.categoryId] : []),
          byId,
        ),
        aliases: sanitizeAliases(v.aliases),
        connection: typeof v.connection === 'string' ? v.connection : '',
        relationToFamiliar: relFam,
        ...(typeof v.pronouns === 'string' && v.pronouns.trim() ? { pronouns: v.pronouns.trim() } : {}),
        ...(typeof v.relationToWard === 'string' && v.relationToWard.trim() ? { relationToWard: v.relationToWard.trim() } : {}),
        ...(typeof v.commStyleNotes === 'string' && v.commStyleNotes.trim() ? { commStyleNotes: v.commStyleNotes.trim() } : {}),
        ...(typeof v.notes === 'string' && v.notes.trim() ? { notes: v.notes.trim() } : {}),
        // privateNotes: the ward-only bucket. Disclosed in full to the
        // Familiar in ward-private turns; STRIPPED when anyone else is
        // present. For genuinely sensitive things (orientation, health,
        // legal name) — not trivia. Gating happens at read time in
        // cerebellum; storing it here keeps the registry the single home.
        ...(typeof v.privateNotes === 'string' && v.privateNotes.trim() ? { privateNotes: v.privateNotes.trim() } : {}),
        ...(typeof v.graphNodeId === 'string' && v.graphNodeId.trim() ? { graphNodeId: v.graphNodeId.trim() } : {}),
        ...(rem ? { remember: rem } : {}),
        ...(v.triage && typeof v.triage === 'object' && typeof v.triage.webhook === 'string'
          ? { triage: { webhook: v.triage.webhook, ...(typeof v.triage.channel === 'string' ? { channel: v.triage.channel } : {}) } }
          : {}),
      };
    });

  const locations = (Array.isArray(reg.locations) ? reg.locations : [])
    .filter(l => l && typeof l === 'object' && typeof l.key === 'string' && l.key.trim())
    .map(l => ({
      key: l.key.trim(),
      label: typeof l.label === 'string' ? l.label : l.key.trim(),
      // Unassigned or dangling → strangers ceiling (the floor).
      assignedCategoryId: byId.has(l.assignedCategoryId) ? l.assignedCategoryId : CATEGORY_STRANGERS,
      ...(typeof l.connectionId === 'string' && l.connectionId ? { connectionId: l.connectionId } : {}),
      ...(l.rateLimit && typeof l.rateLimit === 'object' && Number.isFinite(l.rateLimit.perHour)
        ? { rateLimit: { perHour: Math.max(0, Math.floor(l.rateLimit.perHour)) } }
        : {}),
    }));

  return {
    updatedAt: typeof reg.updatedAt === 'string' ? reg.updatedAt : new Date(0).toISOString(),
    syncPending: reg.syncPending === true,
    categories: [...byId.values()],
    villagers,
    locations,
  };
}

// ── File I/O ──────────────────────────────────────────────────────

async function readRegistryFile(filePath) {
  try {
    const raw = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    return normalizeRegistry(raw);
  } catch {
    return emptyRegistry();
  }
}

async function writeRegistryFile(filePath, reg) {
  const tmp = `${filePath}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(reg, null, 2), 'utf8');
  await fsp.rename(tmp, filePath);
}

// ── Sync (Phylactery canonical) ───────────────────────────────────
//
// Injected by server.js at boot:
//   push(canonicalJsonString) → { ok, error? }   write-through target
//   pull()                    → canonical object | null
// Both must never throw (wrap Phylactery failures into { ok:false }
// / null) — but we defend anyway: a sync failure must never surface
// as a registry API error.

let syncHooks = { push: null, pull: null };

export function initVillageSync({ push, pull } = {}) {
  syncHooks = { push: typeof push === 'function' ? push : null, pull: typeof pull === 'function' ? pull : null };
}

function canonicalCopy(reg) {
  const { syncPending, ...rest } = reg;
  return rest;
}

async function pushCanonical(reg) {
  if (!syncHooks.push) return false; // no transport wired (tests, degraded boot) → pending
  try {
    const res = await syncHooks.push(JSON.stringify(canonicalCopy(reg), null, 2));
    return res?.ok === true;
  } catch (err) {
    console.warn('[village] canonical push failed:', err?.message ?? err);
    return false;
  }
}

/**
 * Boot-time reconciliation. Canonical-wins when newer; otherwise a
 * pending mirror is replayed upward. Never throws — a failed sync
 * leaves the mirror authoritative for gating, which is the safe state.
 */
export async function bootSync({ filePath = DEFAULT_VILLAGE_PATH } = {}) {
  return withLock(`village:${filePath}`, async () => {
    const mirror = await readRegistryFile(filePath);
    let canonical = null;
    if (syncHooks.pull) {
      try { canonical = await syncHooks.pull(); } catch (err) {
        console.warn('[village] canonical pull failed:', err?.message ?? err);
      }
    }
    if (canonical && typeof canonical === 'object') {
      const canonNorm = normalizeRegistry(canonical);
      if (new Date(canonNorm.updatedAt).getTime() > new Date(mirror.updatedAt).getTime()) {
        canonNorm.syncPending = false;
        await writeRegistryFile(filePath, canonNorm);
        console.log('[village] bootSync: canonical newer → mirror updated');
        return canonNorm;
      }
    }
    if (mirror.syncPending) {
      const ok = await pushCanonical(mirror);
      if (ok) {
        mirror.syncPending = false;
        await writeRegistryFile(filePath, mirror);
        console.log('[village] bootSync: pending mirror replayed to canonical');
      }
    }
    return mirror;
  });
}

// ── Mutation core ─────────────────────────────────────────────────
//
// Single path for every write: lock → read → mutate → stamp → attempt
// push → persist with syncPending reflecting the push outcome. The
// push runs inside the lock so a rapid second edit can't interleave
// between mirror-write and canonical-write.

async function mutate(filePath, fn) {
  return withLock(`village:${filePath}`, async () => {
    const reg = await readRegistryFile(filePath);
    const result = fn(reg); // may throw a validation Error → caller surfaces it
    reg.updatedAt = new Date().toISOString();
    reg.syncPending = !(await pushCanonical(reg));
    await writeRegistryFile(filePath, reg);
    return result ?? reg;
  });
}

// ── Reads ─────────────────────────────────────────────────────────

export async function getRegistry({ filePath = DEFAULT_VILLAGE_PATH } = {}) {
  return readRegistryFile(filePath);
}

/**
 * Resolve a platform alias to a villager, or null. Alias matching is
 * by platform + exact id (the stable platform identifier, e.g. the
 * Discord snowflake — NOT the display handle, which can be spoofed).
 */
export async function findVillagerByAlias({ platform, id }, { filePath = DEFAULT_VILLAGE_PATH } = {}) {
  if (typeof platform !== 'string' || typeof id !== 'string') return null;
  const p = platform.trim().toLowerCase();
  const reg = await readRegistryFile(filePath);
  return reg.villagers.find(v => v.aliases.some(a => a.platform === p && a.id === id)) ?? null;
}

// ── Category CRUD ─────────────────────────────────────────────────

export async function upsertCategory({ id, name, grants }, { filePath = DEFAULT_VILLAGE_PATH } = {}) {
  return mutate(filePath, (reg) => {
    if (id === CATEGORY_STRANGERS) throw new Error('the Strangers category is locked — it is the floor');
    if (id) {
      const existing = reg.categories.find(c => c.id === id);
      if (!existing) throw new Error(`unknown category: ${id}`);
      if (existing.builtin) {
        // Builtin: grants may widen/narrow, identity may not.
        existing.grants = sanitizeGrants(grants ?? existing.grants);
        return existing;
      }
      if (typeof name === 'string' && name.trim()) existing.name = name.trim();
      if (grants !== undefined) existing.grants = sanitizeGrants(grants);
      return existing;
    }
    if (typeof name !== 'string' || !name.trim()) throw new Error('name (string) is required');
    const cat = { id: randomUUID(), name: name.trim(), builtin: false, grants: sanitizeGrants(grants) };
    reg.categories.push(cat);
    return cat;
  });
}

export async function deleteCategory({ id, reassignTo }, { filePath = DEFAULT_VILLAGE_PATH } = {}) {
  return mutate(filePath, (reg) => {
    const cat = reg.categories.find(c => c.id === id);
    if (!cat) throw new Error(`unknown category: ${id}`);
    if (cat.builtin) throw new Error('built-in categories cannot be deleted');

    // Villagers whose categoryIds list would become empty after removing this id.
    const wouldBeEmpty = reg.villagers.filter(v =>
      v.categoryIds.includes(id) && v.categoryIds.filter(x => x !== id).length === 0,
    );
    let reassignTarget = null;
    if (wouldBeEmpty.length > 0) {
      reassignTarget = reg.categories.find(c => c.id === reassignTo);
      if (!reassignTarget) throw new Error(
        `${wouldBeEmpty.length} villager(s) would have no category — pass reassignTo with a valid category id`,
      );
    }

    let reassigned = 0;
    for (const v of reg.villagers) {
      if (!v.categoryIds.includes(id)) continue;
      v.categoryIds = v.categoryIds.filter(x => x !== id);
      if (v.categoryIds.length === 0) {
        v.categoryIds = reassignTarget ? [reassignTarget.id] : [CATEGORY_STRANGERS];
        reassigned++;
      }
    }

    reg.categories = reg.categories.filter(c => c.id !== id);
    // Locations whose ceiling pointed here fall to the floor.
    for (const l of reg.locations) {
      if (l.assignedCategoryId === id) l.assignedCategoryId = CATEGORY_STRANGERS;
    }
    return { ok: true, reassigned };
  });
}

// ── Villager field helpers ─────────────────────────────────────────

export const RELATION_TO_FAMILIAR_VALUES = [
  'unaware', 'warm', 'neutral', 'tolerates-for-ward', 'wary-of-ai', 'hostile',
];

export const REMEMBER_CATEGORIES = [
  'basics', 'emotional_content', 'health_info', 'relationships', 'whereabouts',
];

function sanitizeRemember(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const cat of REMEMBER_CATEGORIES) {
    const v = raw[cat];
    if (v === true || v === false || v === 'ask') out[cat] = v;
  }
  return Object.keys(out).length ? out : null;
}

// ── Villager CRUD ─────────────────────────────────────────────────

export async function upsertVillager({
  id, name, categoryIds, categoryId, aliases, connection, triage,
  pronouns, relationToWard, relationToFamiliar, commStyleNotes, notes, privateNotes, graphNodeId, remember,
}, { filePath = DEFAULT_VILLAGE_PATH } = {}) {
  return mutate(filePath, (reg) => {
    // Accept categoryIds (array, new) or categoryId (scalar, legacy).
    const rawIds = categoryIds !== undefined ? categoryIds
      : (categoryId !== undefined ? [categoryId] : undefined);

    const resolveCategories = (raw) => {
      if (raw === undefined) return undefined;
      const ids = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      for (const cid of ids) {
        if (!reg.categories.some(c => c.id === cid)) throw new Error(`unknown category: ${cid}`);
      }
      return ids.length > 0 ? [...new Set(ids)] : [CATEGORY_STRANGERS];
    };

    const applyOptStr = (obj, key, val) => {
      if (val !== undefined) {
        if (typeof val === 'string' && val.trim()) obj[key] = val.trim();
        else delete obj[key];
      }
    };

    if (id) {
      const v = reg.villagers.find(x => x.id === id);
      if (!v) throw new Error(`unknown villager: ${id}`);
      if (typeof name === 'string' && name.trim()) v.name = name.trim();
      const cids = resolveCategories(rawIds);
      if (cids !== undefined) v.categoryIds = cids;
      if (aliases !== undefined) v.aliases = sanitizeAliases(aliases);
      if (connection !== undefined) v.connection = typeof connection === 'string' ? connection : '';
      if (triage !== undefined) {
        if (triage && typeof triage.webhook === 'string' && triage.webhook.trim()) {
          v.triage = { webhook: triage.webhook.trim(), ...(typeof triage.channel === 'string' ? { channel: triage.channel } : {}) };
        } else {
          delete v.triage;
        }
      }
      applyOptStr(v, 'pronouns', pronouns);
      applyOptStr(v, 'relationToWard', relationToWard);
      if (relationToFamiliar !== undefined) {
        v.relationToFamiliar = RELATION_TO_FAMILIAR_VALUES.includes(relationToFamiliar)
          ? relationToFamiliar : 'unaware';
      }
      applyOptStr(v, 'commStyleNotes', commStyleNotes);
      applyOptStr(v, 'notes', notes);
      applyOptStr(v, 'privateNotes', privateNotes);
      applyOptStr(v, 'graphNodeId', graphNodeId);
      if (remember !== undefined) {
        const rem = sanitizeRemember(remember);
        if (rem) v.remember = rem;
        else delete v.remember;
      }
      return v;
    }
    if (typeof name !== 'string' || !name.trim()) throw new Error('name (string) is required');
    const cids = resolveCategories(rawIds) ?? [CATEGORY_STRANGERS];
    const relFam = RELATION_TO_FAMILIAR_VALUES.includes(relationToFamiliar) ? relationToFamiliar : 'unaware';
    const rem = sanitizeRemember(remember);
    const v = {
      id: randomUUID(),
      name: name.trim(),
      categoryIds: cids,
      aliases: sanitizeAliases(aliases),
      connection: typeof connection === 'string' ? connection : '',
      relationToFamiliar: relFam,
      ...(typeof pronouns === 'string' && pronouns.trim() ? { pronouns: pronouns.trim() } : {}),
      ...(typeof relationToWard === 'string' && relationToWard.trim() ? { relationToWard: relationToWard.trim() } : {}),
      ...(typeof commStyleNotes === 'string' && commStyleNotes.trim() ? { commStyleNotes: commStyleNotes.trim() } : {}),
      ...(typeof notes === 'string' && notes.trim() ? { notes: notes.trim() } : {}),
      ...(typeof privateNotes === 'string' && privateNotes.trim() ? { privateNotes: privateNotes.trim() } : {}),
      ...(typeof graphNodeId === 'string' && graphNodeId.trim() ? { graphNodeId: graphNodeId.trim() } : {}),
      ...(rem ? { remember: rem } : {}),
      ...(triage && typeof triage.webhook === 'string' && triage.webhook.trim()
        ? { triage: { webhook: triage.webhook.trim(), ...(typeof triage.channel === 'string' ? { channel: triage.channel } : {}) } }
        : {}),
    };
    reg.villagers.push(v);
    return v;
  });
}

export async function deleteVillager({ id }, { filePath = DEFAULT_VILLAGE_PATH } = {}) {
  return mutate(filePath, (reg) => {
    const before = reg.villagers.length;
    reg.villagers = reg.villagers.filter(v => v.id !== id);
    if (reg.villagers.length === before) throw new Error(`unknown villager: ${id}`);
    return { ok: true };
  });
}

// ── Location CRUD ─────────────────────────────────────────────────

export async function upsertLocation({ key, label, assignedCategoryId, connectionId, rateLimit }, { filePath = DEFAULT_VILLAGE_PATH } = {}) {
  return mutate(filePath, (reg) => {
    if (typeof key !== 'string' || !key.trim()) throw new Error('key (string) is required');
    if (assignedCategoryId !== undefined && !reg.categories.some(c => c.id === assignedCategoryId)) {
      throw new Error(`unknown category: ${assignedCategoryId}`);
    }
    const k = key.trim();
    let loc = reg.locations.find(l => l.key === k);
    if (!loc) {
      loc = { key: k, label: k, assignedCategoryId: CATEGORY_STRANGERS };
      reg.locations.push(loc);
    }
    if (typeof label === 'string' && label.trim()) loc.label = label.trim();
    if (assignedCategoryId !== undefined) loc.assignedCategoryId = assignedCategoryId;
    if (connectionId !== undefined) {
      if (typeof connectionId === 'string' && connectionId) loc.connectionId = connectionId;
      else delete loc.connectionId;
    }
    if (rateLimit !== undefined) {
      if (rateLimit && Number.isFinite(rateLimit.perHour)) loc.rateLimit = { perHour: Math.max(0, Math.floor(rateLimit.perHour)) };
      else delete loc.rateLimit;
    }
    return loc;
  });
}

export async function deleteLocation({ key }, { filePath = DEFAULT_VILLAGE_PATH } = {}) {
  return mutate(filePath, (reg) => {
    const before = reg.locations.length;
    reg.locations = reg.locations.filter(l => l.key !== key);
    if (reg.locations.length === before) throw new Error(`unknown location: ${key}`);
    return { ok: true };
  });
}

// ── Default-category seeding ──────────────────────────────────────
//
// Called once at boot (after bootSync) to back-fill the three pre-seeded
// categories into existing registries that were created before 0.4.20.
// Idempotent: checks for the stable IDs before writing anything.

export async function seedDefaultCategories({ filePath = DEFAULT_VILLAGE_PATH } = {}) {
  const existing = await readRegistryFile(filePath);
  const missing = DEFAULT_CATEGORY_SEEDS.filter(d => !existing.categories.some(c => c.id === d.id));
  if (!missing.length) return { added: 0 };
  return mutate(filePath, (reg) => {
    let added = 0;
    for (const cat of missing) {
      if (!reg.categories.some(c => c.id === cat.id)) {
        reg.categories.push({ ...cat });
        added++;
      }
    }
    return { added };
  });
}

// ── Migration: settings.trustedContacts → Emergency Contacts ─────
//
// Idempotent by name match: a contact whose name already exists as a
// villager is skipped, so repeated boots don't duplicate. The settings
// key keeps working during alpha (one-way import; registry becomes
// the superset).

export async function migrateTrustedContacts(contacts, { filePath = DEFAULT_VILLAGE_PATH } = {}) {
  if (!Array.isArray(contacts) || contacts.length === 0) return { imported: 0 };
  return mutate(filePath, (reg) => {
    let imported = 0;
    for (const c of contacts) {
      if (!c || typeof c.name !== 'string' || !c.name.trim()) continue;
      const name = c.name.trim();
      if (reg.villagers.some(v => v.name === name)) continue;
      reg.villagers.push({
        id: randomUUID(),
        name,
        categoryIds: [CATEGORY_EMERGENCY],
        aliases: [],
        connection: 'imported from trusted contacts',
        ...(typeof c.webhook === 'string' && c.webhook.trim()
          ? { triage: { webhook: c.webhook.trim(), ...(typeof c.channel === 'string' ? { channel: c.channel } : {}) } }
          : {}),
      });
      imported++;
    }
    return { imported };
  });
}
