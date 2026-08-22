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
import { CONTENT_TOPICS, sanitizeTopicGrants } from './content-tags.js';

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

// ── Location presence modes (Village V8) ──────────────────────────
//
// How I behave in a shared room, per location. Inherited shape from
// Psycheros's Discord channel modes (strict | lurk | active):
//   - strict: I reply only when @-mentioned or directly replied-to.
//             Messages I'm not addressed in pass me by. (The default —
//             every pre-V8 location reads as strict.)
//   - lurk:   I still only speak when addressed, but I READ the room —
//             messages accumulate into the session so when someone
//             finally turns to me I have the conversation in hand.
//   - active: I can chime in without being addressed, paced so I don't
//             flood the room. Two cadence strategies (activeStrategy):
//               'llm'   — each eligible message, I decide whether it's
//                         worth speaking (I can stay quiet).
//               'tiers' — code paces me to how busy the room is
//                         (slow/medium/fast), scaled off activeCooldownSec.
// A hard per-location cooldown (activeCooldownSec) floors how often I
// take an unprompted turn at all, so active presence never runs away
// with the token budget. The V5 rate limit is the second backstop.
const LOCATION_MODES = ['strict', 'lurk', 'active'];
const ACTIVE_STRATEGIES = ['llm', 'tiers'];
export const DEFAULT_LOCATION_MODE = 'strict';
export const DEFAULT_ACTIVE_STRATEGY = 'llm';
export const DEFAULT_ACTIVE_COOLDOWN_SEC = 60;

// ── Voice call mode per location (Pass 3c) ────────────────────────
// Whether/how I join a voice channel in this location:
//   - off:    I never join here — even an explicit `!call` is refused.
//             The ward's way to fully disable voice in a channel.
//   - summon: I join only when explicitly asked (`!call`, the
//             join_voice_call tool) — never on my own. The DEFAULT, so
//             the deliberate act of typing `!call` always works and no
//             config is needed to summon me.
//   - auto:   I also join automatically when the ward ENTERS this voice
//             channel — hands-free presence, opt-in.
// Default SUMMON, not off: the proactivity-sensitive part is AUTO (joining
// unprompted), which stays opt-in; refusing an explicit `!call` because an
// unconfigured dropdown said "off" would just break the ward's own command.
// So an unset/unknown/pre-3c location reads as summon (explicit works, no
// auto); the ward opts up to auto or down to off deliberately.
const CALL_MODES = ['off', 'summon', 'auto'];
export const DEFAULT_CALL_MODE = 'summon';

/** A location's normalized call mode. Unknown/absent → summon (explicit works, no auto). */
export function locationCallMode(l) {
  return CALL_MODES.includes(l?.callMode) ? l.callMode : DEFAULT_CALL_MODE;
}

// Normalize a location's presence-mode fields. Unknown mode → strict
// (fail-quiet: an unrecognized mode must never make me chattier than
// the ward asked). Strategy/cooldown only ride along in 'active' mode.
function normalizeLocationMode(l) {
  const mode = LOCATION_MODES.includes(l?.mode) ? l.mode : DEFAULT_LOCATION_MODE;
  if (mode !== 'active') return { mode };
  const strategy = ACTIVE_STRATEGIES.includes(l?.activeStrategy) ? l.activeStrategy : DEFAULT_ACTIVE_STRATEGY;
  const sec = Number(l?.activeCooldownSec);
  const cooldown = Number.isFinite(sec) && sec >= 0 ? Math.floor(sec) : DEFAULT_ACTIVE_COOLDOWN_SEC;
  return { mode, activeStrategy: strategy, activeCooldownSec: cooldown };
}

// ── Default category seeds ────────────────────────────────────────
//
// Three pre-seeded categories provided on fresh installs (and back-filled
// on first boot for existing registries). Not builtins — the ward can
// rename, adjust grants, or delete them freely. Stable IDs make seeding
// idempotent across upgrades.

// Category ids are readable slugs (the mandatory slug-id rule — a category id
// rides in memory audiences, villager assignments, and surfaces the model can
// read, so it must be greppable, not a UUID). The old deterministic-UUID seeds
// are migrated to these on load; see migrateCategoryIds.
const CAT_CLOSE_FRIENDS = 'close-friends';
const CAT_ACQUAINTANCES  = 'acquaintances';
const CAT_CARE_NETWORK   = 'care-network';

// Old seed ids (pre-slug) → their slug, for the one-time load-time migration.
const LEGACY_SEED_CATEGORY_IDS = {
  '00000000-0000-4000-8001-000000000001': CAT_CLOSE_FRIENDS,
  '00000000-0000-4000-8001-000000000002': CAT_ACQUAINTANCES,
  '00000000-0000-4000-8001-000000000003': CAT_CARE_NETWORK,
};

const _UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A short readable slug from a category name ("Close Friends" → "close-friends").
function slugifyCategoryName(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'circle';
}

/**
 * Build the old-id → new-slug map for a registry's categories (idempotent).
 * A UUID-shaped category id is remapped: a known legacy seed → its slug; any
 * other UUID (a ward-created randomUUID category) → a unique slug from its name.
 * Ids that are already slugs are left untouched. Pure. Returns a Map (empty when
 * nothing needs migrating).
 */
/**
 * The full old-id → new-slug map to hand Phylactery so it can remap the
 * `audience` stored on memories / graph nodes / edges (the category id lives in
 * two stores; the registry migration only fixes the Node mirror). ALWAYS
 * includes the fixed legacy-seed map so the seed remap runs idempotently every
 * boot regardless of registry state; unions in any ward-created UUID → slug from
 * the raw file (present until the first write persists slugs). Reads the RAW
 * file (pre-normalize) on purpose — the UUIDs must still be visible to map them.
 */
export async function pendingCategoryAudienceRemap({ filePath = DEFAULT_VILLAGE_PATH } = {}) {
  let derived = {};
  try {
    const raw = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    derived = Object.fromEntries(migrateCategoryIds(Array.isArray(raw?.categories) ? raw.categories : []));
  } catch { /* no file / bad json → seed map only */ }
  return { ...LEGACY_SEED_CATEGORY_IDS, ...derived };
}

export function migrateCategoryIds(rawCategories = []) {
  const map = new Map();
  // Reserve the builtin + seed slugs and any id already slug-shaped, so a
  // name-derived slug can't collide with them.
  const taken = new Set([CATEGORY_EMERGENCY, CATEGORY_STRANGERS, CAT_CLOSE_FRIENDS, CAT_ACQUAINTANCES, CAT_CARE_NETWORK]);
  for (const c of rawCategories) {
    if (c && typeof c.id === 'string' && !_UUID_RE.test(c.id)) taken.add(c.id);
  }
  for (const c of rawCategories) {
    if (!c || typeof c.id !== 'string' || !_UUID_RE.test(c.id)) continue; // already a slug (or junk)
    let slug = LEGACY_SEED_CATEGORY_IDS[c.id];
    if (!slug) {
      const base = slugifyCategoryName(c.name);
      slug = base;
      for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    }
    map.set(c.id, slug);
    taken.add(slug);
  }
  return map;
}

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
      // `topics` is the content-gating per-topic level map (Phase 2) — the one
      // nested object we keep, validated to {topic: open|sensitive}. An explicit
      // topics OBJECT is kept even when empty: {} means "the ward set every
      // topic to hidden", which must persist (not re-derive from coarse grants).
      // A non-object topics value is ignored. Every OTHER nested value is still
      // stripped to keep grants primitive.
      if (k === 'topics') {
        if (v && typeof v === 'object' && !Array.isArray(v)) out.topics = sanitizeTopicGrants(v);
      } else if (typeof v === 'boolean' || typeof v === 'string') {
        out[k] = v;
      }
    }
  }
  return out;
}

// Migration seed for the content-gating per-topic grants (Phase 2): derive an
// initial {topic: level} map from a tier's COARSE grants so nothing silently
// loses access when topic-gating (Phase 4) turns on. Conservative but
// visibility-preserving: a tier that saw "everything sensitive" keeps every
// topic at sensitive (the ward narrows it deliberately later in the editor).
// Runs only when a tier has no `topics` yet, so it never overwrites a ward edit.
function deriveTopicGrantsFromCoarse(coarse = {}) {
  const has = (k) => coarse[k] === true || (typeof coarse[k] === 'string' && coarse[k].length > 0);
  const t = {};
  // Can this tier see memory content at all? → the everyday baseline.
  if (has('memories') || has('identityBasic')) t.general = 'open';
  // "Everything except address" (the old broad sensitive grant) → every topic.
  if (has('identitySensitive')) for (const topic of CONTENT_TOPICS) t[topic] = 'sensitive';
  // A dedicated health grant → the medical topics specifically.
  if (has('health')) { t.medical = 'sensitive'; t['mental-health'] = 'sensitive'; }
  // A location grant → the location topic.
  if (has('location')) t.location = t.location || 'open';
  return t;
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

  // Slug-id migration (idempotent): rewrite any UUID category id to a readable
  // slug, and carry the remap into every reference below (villager categoryIds,
  // location assignedCategoryId). A registry already on slugs yields an empty
  // map and this is a no-op.
  const idMap = migrateCategoryIds(categories);
  const remap = (id) => idMap.get(id) ?? id;

  const byId = new Map();
  for (const c of categories) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id.trim()) continue;
    if (typeof c.name !== 'string' || !c.name.trim()) continue;
    const cid = remap(c.id);
    const grants = sanitizeGrants(c.grants);
    // Content-gating migration (Phase 2): seed per-topic grants from the coarse
    // grants the FIRST time only (topics absent). Never overwrites a ward edit
    // (once topics is set + persisted, sanitizeGrants preserves it → present →
    // skipped). Strangers stay {} (forced below) → sees nothing.
    if (grants.topics === undefined) {
      const derived = deriveTopicGrantsFromCoarse(grants);
      if (Object.keys(derived).length) grants.topics = derived;
    }
    byId.set(cid, {
      id: cid,
      name: c.name.trim(),
      builtin: cid === CATEGORY_EMERGENCY || cid === CATEGORY_STRANGERS,
      grants,
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
      const stdConsent = sanitizeStandingConsent(v.standingConsent);
      const disc = sanitizeDisclosure(v.disclosure);
      return {
        id: v.id,
        name: v.name.trim(),
        // Accepts both categoryIds[] (new) and legacy categoryId scalar.
        // Dangling / empty → [strangers]. Narrow, never widen.
        categoryIds: normalizeCategoryIds(
          (v.categoryIds ?? (v.categoryId ? [v.categoryId] : [])).map(remap),
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
        ...(stdConsent ? { standingConsent: stdConsent } : {}),
        ...(disc ? { disclosure: disc } : {}),
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
      // Unassigned or dangling → strangers ceiling (the floor). Remap first so
      // a pre-slug UUID assignment carries over to the migrated category id.
      assignedCategoryId: byId.has(remap(l.assignedCategoryId)) ? remap(l.assignedCategoryId) : CATEGORY_STRANGERS,
      ...normalizeLocationMode(l),
      // Voice call mode (Pass 3c). Only stored when non-default, so old
      // locations stay unchanged and 'off' never bloats the registry.
      ...(locationCallMode(l) !== DEFAULT_CALL_MODE ? { callMode: locationCallMode(l) } : {}),
      // readBots: opt-in to seeing other bots/Familiars in this room.
      // Off by default — the loop guard. Independent of presence mode.
      ...(l.readBots === true ? { readBots: true } : {}),
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
 * Pure alias→villager match against an already-loaded registry. Match is
 * by platform + exact id (the stable platform identifier, e.g. the Discord
 * snowflake — NOT the display handle, which can be spoofed). Split out so a
 * caller resolving MANY ids (a voice-call roster) reads the registry once and
 * maps in memory, rather than one async read per id.
 */
export function villagerByAlias(reg, { platform, id } = {}) {
  if (typeof platform !== 'string' || typeof id !== 'string') return null;
  const p = platform.trim().toLowerCase();
  const villagers = Array.isArray(reg?.villagers) ? reg.villagers : [];
  return villagers.find(v => (v.aliases ?? []).some(a => a.platform === p && a.id === id)) ?? null;
}

/**
 * Resolve a platform alias to a villager, or null. Alias matching is
 * by platform + exact id (the stable platform identifier, e.g. the
 * Discord snowflake — NOT the display handle, which can be spoofed).
 */
export async function findVillagerByAlias({ platform, id }, { filePath = DEFAULT_VILLAGE_PATH } = {}) {
  if (typeof platform !== 'string' || typeof id !== 'string') return null;
  const reg = await readRegistryFile(filePath);
  return villagerByAlias(reg, { platform, id });
}

// ── Category CRUD ─────────────────────────────────────────────────

export async function upsertCategory({ id, name, grants }, { filePath = DEFAULT_VILLAGE_PATH } = {}) {
  return mutate(filePath, (reg) => {
    if (id === CATEGORY_STRANGERS) throw new Error('the Strangers category is locked — it is the floor');
    // Preserve the tier's content-topic grants across a save that OMITS `topics`
    // — the legacy grant editor (vlReadGrants) doesn't send them yet, and a
    // topic-less PATCH must not wipe them. An explicit `topics` key (the future
    // topic editor) still replaces. Applied to both builtin + custom updates.
    const withTopics = (incoming, existing) => {
      const next = sanitizeGrants(incoming);
      if (incoming && !('topics' in incoming) && existing?.topics) next.topics = existing.topics;
      return next;
    };
    if (id) {
      const existing = reg.categories.find(c => c.id === id);
      if (!existing) throw new Error(`unknown category: ${id}`);
      if (existing.builtin) {
        // Builtin: grants may widen/narrow, identity may not.
        existing.grants = withTopics(grants ?? existing.grants, existing.grants);
        return existing;
      }
      if (typeof name === 'string' && name.trim()) existing.name = name.trim();
      if (grants !== undefined) existing.grants = withTopics(grants, existing.grants);
      return existing;
    }
    if (typeof name !== 'string' || !name.trim()) throw new Error('name (string) is required');
    // Readable slug id (the mandatory slug rule), unique within the registry.
    const taken = new Set(reg.categories.map(c => c.id));
    const base = slugifyCategoryName(name);
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    const cat = { id: slug, name: name.trim(), builtin: false, grants: sanitizeGrants(grants) };
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

const RELATION_TO_FAMILIAR_VALUES = [
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

// Standing mutual consent: when BOTH my human and this person have agreed I may
// keep memories about them, the per-fact consent prompts stop for that person
// (an explicit `false` in their remember map still hard-blocks that category —
// a convenience toggle never overrides my human's veto). Only `true` is stored;
// an un-agreed side is simply absent. Returns null when neither side has agreed.
function sanitizeStandingConsent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  if (raw.wardAgreed === true) out.wardAgreed = true;
  if (raw.villagerAgreed === true) out.villagerAgreed = true;
  return Object.keys(out).length ? out : null;
}

// Both sides agreed → standing consent is active and the `ask` gate is cleared
// for that person (their explicit `false` categories still hard-block).
export function standingConsentActive(villager) {
  const sc = villager?.standingConsent;
  return !!(sc && sc.wardAgreed === true && sc.villagerAgreed === true);
}

// `disclosure` — per remember-category, the AUDIENCE this person is OK being
// discussed at (a Village category id, or 'ward-private'). Governs WHERE a memory
// about them may surface (distinct from `remember`, which governs WHETHER to
// store). Each value is a non-empty string; the audience-derivation validates it
// against the live registry. Absent categories → no explicit preference (the
// memory's audience stays session-bounded).
function sanitizeDisclosure(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const cat of REMEMBER_CATEGORIES) {
    const v = raw[cat];
    if (typeof v === 'string' && v.trim()) out[cat] = v.trim();
  }
  return Object.keys(out).length ? out : null;
}

// Merge per-category remember gates into ONE villager's map — the narrow
// setter behind the Discord consent menu (a villager updating their OWN
// settings). Values per REMEMBER_CATEGORIES: true (keep) | 'ask' | false
// (never). Unknown categories are ignored; other villager fields are
// untouched.
export async function setVillagerRemember(villagerId, patch, { filePath = DEFAULT_VILLAGE_PATH } = {}) {
  return mutate(filePath, (reg) => {
    const v = reg.villagers.find(x => x.id === villagerId);
    if (!v) throw new Error(`unknown villager: ${villagerId}`);
    const rem = { ...(v.remember ?? {}) };
    for (const [cat, val] of Object.entries(patch ?? {})) {
      if (!REMEMBER_CATEGORIES.includes(cat)) continue;
      if (val === true || val === false || val === 'ask') rem[cat] = val;
    }
    if (Object.keys(rem).length) v.remember = rem;
    return { villager: v };
  });
}

// ── Villager CRUD ─────────────────────────────────────────────────

export async function upsertVillager({
  id, name, categoryIds, categoryId, aliases, connection, triage,
  pronouns, relationToWard, relationToFamiliar, commStyleNotes, notes, privateNotes, graphNodeId, remember, standingConsent, disclosure,
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
      if (standingConsent !== undefined) {
        const sc = sanitizeStandingConsent(standingConsent);
        if (sc) v.standingConsent = sc;
        else delete v.standingConsent;
      }
      if (disclosure !== undefined) {
        const dc = sanitizeDisclosure(disclosure);
        if (dc) v.disclosure = dc;
        else delete v.disclosure;
      }
      return v;
    }
    if (typeof name !== 'string' || !name.trim()) throw new Error('name (string) is required');
    const cids = resolveCategories(rawIds) ?? [CATEGORY_STRANGERS];
    const relFam = RELATION_TO_FAMILIAR_VALUES.includes(relationToFamiliar) ? relationToFamiliar : 'unaware';
    const rem = sanitizeRemember(remember);
    const sc = sanitizeStandingConsent(standingConsent);
    const dc = sanitizeDisclosure(disclosure);
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
      ...(sc ? { standingConsent: sc } : {}),
      ...(dc ? { disclosure: dc } : {}),
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

export async function upsertLocation({ key, label, assignedCategoryId, connectionId, rateLimit, mode, activeStrategy, activeCooldownSec, readBots, callMode }, { filePath = DEFAULT_VILLAGE_PATH } = {}) {
  return mutate(filePath, (reg) => {
    if (typeof key !== 'string' || !key.trim()) throw new Error('key (string) is required');
    if (assignedCategoryId !== undefined && !reg.categories.some(c => c.id === assignedCategoryId)) {
      throw new Error(`unknown category: ${assignedCategoryId}`);
    }
    const k = key.trim();
    let loc = reg.locations.find(l => l.key === k);
    if (!loc) {
      loc = { key: k, label: k, assignedCategoryId: CATEGORY_STRANGERS, mode: DEFAULT_LOCATION_MODE };
      reg.locations.push(loc);
    }
    if (typeof label === 'string' && label.trim()) loc.label = label.trim();
    if (assignedCategoryId !== undefined) loc.assignedCategoryId = assignedCategoryId;
    // Presence mode (V8). Unknown mode → strict. Strategy/cooldown are
    // only kept in 'active' mode; switching away clears them so the
    // registry never carries stale cadence settings.
    if (mode !== undefined) loc.mode = LOCATION_MODES.includes(mode) ? mode : DEFAULT_LOCATION_MODE;
    if (activeStrategy !== undefined && ACTIVE_STRATEGIES.includes(activeStrategy)) loc.activeStrategy = activeStrategy;
    if (activeCooldownSec !== undefined) {
      const s = Number(activeCooldownSec);
      if (Number.isFinite(s) && s >= 0) loc.activeCooldownSec = Math.floor(s);
    }
    if ((loc.mode ?? DEFAULT_LOCATION_MODE) !== 'active') {
      delete loc.activeStrategy;
      delete loc.activeCooldownSec;
    }
    // Voice call mode (Pass 3c). Unknown → off. Store only when non-default so
    // the registry stays lean and old locations keep reading as off.
    if (callMode !== undefined) {
      const m = CALL_MODES.includes(callMode) ? callMode : DEFAULT_CALL_MODE;
      if (m === DEFAULT_CALL_MODE) delete loc.callMode; else loc.callMode = m;
    }
    // readBots: independent of mode. On = this room may see/answer other
    // bots and Familiars (loops paced by the cooldown + rate limit; self
    // is always ignored). Off = the default loop guard.
    if (readBots !== undefined) {
      if (readBots === true) loc.readBots = true;
      else delete loc.readBots;
    }
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
