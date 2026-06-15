// audience.js — grant resolution for Village session audiences (V3)
//
// Resolves session audience (location + participants) against the
// village registry to produce an effective grants object for a session.
// Thalamus passes this to enrich() to gate all knowledge classes
// before any fetches happen — the content never enters the process at all.
//
// Design: docs/village-support-design.md "Audience resolution"
// Sign-off: 2026-06-11 (human-approved V3 gate semantics)

import { CATEGORY_STRANGERS } from './village.js';

// ── Sentinel ──────────────────────────────────────────────────────
// WARD_PRIVATE is returned when no audience is set — today's behavior,
// zero gating applied. Distinct from "everyone is a stranger" (which
// returns {} grants → everything denied).
export const WARD_PRIVATE = null;

// ── Grant ladders ─────────────────────────────────────────────────
// Scalar grants where position on the ladder is less-permissive (index 0)
// → more-permissive (last index). Union takes max; intersection takes min.
export const GRANT_LADDERS = {
  memories: [false, 'shared', true],
  schedule: [false, 'coarse', 'full'],
  contacts: [false, 'care-visible', true],
};

// ── Section-marker → grant key mapping ───────────────────────────
// Maps <!-- gate: CLASS --> labels inside identity files to the grant
// key that admits them. Unknown labels → fail-closed (always strip).
export const MARKER_GRANT_MAP = {
  sensitive: 'identitySensitive',
  health: 'health',
  location: 'location',
};

// ── Ladder helpers ────────────────────────────────────────────────

function ladderIdx(ladder, value) {
  const v = (value === undefined || value === null) ? false : value;
  const i = ladder.indexOf(v);
  return i === -1 ? 0 : i; // unknown values snap to the floor
}

function ladderMin(ladder, a, b) {
  return ladder[Math.min(ladderIdx(ladder, a), ladderIdx(ladder, b))];
}

function ladderMax(ladder, a, b) {
  return ladder[Math.max(ladderIdx(ladder, a), ladderIdx(ladder, b))];
}

// ── Grant combination ─────────────────────────────────────────────

/**
 * Union two grant sets (for a villager belonging to multiple categories).
 * Boolean: OR. Scalar ladder: max (most permissive wins).
 * False / floor values are omitted from the output (absent ≡ denied).
 */
export function grantUnion(g1, g2) {
  const out = {};
  const allKeys = new Set([...Object.keys(g1 ?? {}), ...Object.keys(g2 ?? {})]);
  for (const k of allKeys) {
    const v1 = (g1 ?? {})[k];
    const v2 = (g2 ?? {})[k];
    const ladder = GRANT_LADDERS[k];
    const val = ladder
      ? ladderMax(ladder, v1 ?? false, v2 ?? false)
      : !!(v1 || v2);
    if (val !== false) out[k] = val;
  }
  return out;
}

/**
 * Intersect two grant sets (for a room with multiple participants).
 * Boolean: AND. Scalar ladder: min (most restrictive wins).
 * A key absent from either side is treated as false → denied.
 * False / floor values are omitted from the output (absent ≡ denied),
 * so intersecting with {} ({} = strangers = nothing) yields {}.
 */
export function grantIntersection(g1, g2) {
  const out = {};
  const allKeys = new Set([...Object.keys(g1 ?? {}), ...Object.keys(g2 ?? {})]);
  for (const k of allKeys) {
    const v1 = (g1 ?? {})[k];
    const v2 = (g2 ?? {})[k];
    const ladder = GRANT_LADDERS[k];
    const val = ladder
      ? ladderMin(ladder, v1 ?? false, v2 ?? false)
      : !!(v1 && v2);
    if (val !== false) out[k] = val;
  }
  return out;
}

// Union a villager's category grants across all their categories.
function villagersEffectiveGrants(villager, categoryMap) {
  const ids = (villager.categoryIds?.length) ? villager.categoryIds : [CATEGORY_STRANGERS];
  let grants = { ...(categoryMap.get(ids[0])?.grants ?? {}) };
  for (let i = 1; i < ids.length; i++) {
    const cat = categoryMap.get(ids[i]);
    if (cat) grants = grantUnion(grants, cat.grants ?? {});
  }
  return grants;
}

// Match a participant entry ({ id, name }) to a registry villager.
function resolveParticipant(participant, registry) {
  const { id, name } = participant ?? {};
  if (id) {
    const byId = (registry?.villagers ?? []).find(v => v.id === id);
    if (byId) return byId;
  }
  if (name && typeof name === 'string') {
    const lower = name.trim().toLowerCase();
    const byName = (registry?.villagers ?? []).find(v =>
      v.name.toLowerCase() === lower ||
      v.aliases.some(a => (a.handle ?? '').toLowerCase() === lower),
    );
    if (byName) return byName;
  }
  return null; // unknown → strangers
}

// ── Main export ───────────────────────────────────────────────────

/**
 * Resolve the effective grants for a session audience.
 *
 * Rules (fail-closed):
 * - null / empty audience → WARD_PRIVATE (no gating, today's behavior).
 * - Unknown participant → strangers floor ({} → everything denied).
 * - Per-villager grants: union across all their categories.
 * - Room grants: intersection of all participants' effective grants.
 * - Location ceiling: the location's assignedCategoryId is intersected in.
 *   Unassigned location → strangers ceiling applied.
 * - careState is never grantable; it never appears in category grants.
 *
 * @param {object|null} sessionAudience { location: string|null, participants: Array }
 * @param {object} registry normalized village registry
 * @returns {object|null} effective grants, or WARD_PRIVATE
 */
export function resolveAudience(sessionAudience, registry) {
  if (!sessionAudience) return WARD_PRIVATE;
  const { location = null, participants = [] } = sessionAudience;
  if (!participants.length && !location) return WARD_PRIVATE;

  const categoryMap = new Map(
    (registry?.categories ?? []).map(c => [c.id, c]),
  );
  const strangerGrants = categoryMap.get(CATEGORY_STRANGERS)?.grants ?? {};

  const grantsList = (participants ?? []).map(p => {
    const villager = resolveParticipant(p, registry);
    return villager ? villagersEffectiveGrants(villager, categoryMap) : strangerGrants;
  });

  if (location) {
    const loc = (registry?.locations ?? []).find(l => l.key === location);
    const catId = loc?.assignedCategoryId;
    const locCat = catId ? categoryMap.get(catId) : null;
    grantsList.push(locCat?.grants ?? strangerGrants);
  }

  if (!grantsList.length) return WARD_PRIVATE;

  let effective = { ...grantsList[0] };
  for (let i = 1; i < grantsList.length; i++) {
    effective = grantIntersection(effective, grantsList[i]);
  }
  return effective;
}

// ── Audience tag (durable room-audience label) ────────────────────
//
// A stable identifier for "who this room is readable by", stamped onto
// a session so memories derived from it never mix ward-private content
// with content from a shared room.
//
// How it works (the design): scan the present users, compare each to
// the registry, and tag the room with the LOWEST permission level in
// it — a room is only as private as its least-trusted occupant. One
// stranger present drops the whole room to strangers.
//
//   - No audience set (ward-private session) → 'ward-private'. This is
//     the only tag the memorization sweep treats as safe to route into
//     Phylactery; everything else stays in the local tome.
//   - Otherwise: each participant resolves to the category that
//     represents their access (their most-permissive category, since
//     multi-category membership unions). Unknown users fall to the
//     strangers floor. The tag is the least-permissive of those.
//   - The location's assigned category joins the comparison as one more
//     candidate, so it can only ever LOWER the tag — a public channel's
//     full readership isn't enumerable from who has spoken, so its
//     ceiling still caps the room (unassigned → strangers floor).
//
// This tag feeds the fetchEligibility 'shared' ladder (Pillar E): when a
// room has memories='shared', memory_search is gated to records whose
// audience matches the room tag. The outgoing filter (Pillar D) then
// guards what leaves, completing the loop.
export const AUDIENCE_TAG_WARD_PRIVATE = 'ward-private';

// Permission score for a grant set: higher = more access. Used only to
// rank categories against each other so the room can be tagged with its
// least-permissive occupant. Scalar grants score by ladder position;
// boolean grants score 1 when granted. The strangers floor ({}) → 0.
function permissionScore(grants) {
  let score = 0;
  for (const [k, v] of Object.entries(grants ?? {})) {
    const ladder = GRANT_LADDERS[k];
    if (ladder) {
      const i = ladder.indexOf(v);
      score += i === -1 ? 0 : i;
    } else if (v === true) {
      score += 1;
    }
  }
  return score;
}

// The category that represents a villager's access level — their
// most-permissive category (membership unions, so the max is their
// effective level). Unknown villager / unknown category → strangers.
function representativeCategory(villager, categoryMap) {
  const ids = (villager?.categoryIds?.length) ? villager.categoryIds : [CATEGORY_STRANGERS];
  let best = CATEGORY_STRANGERS;
  let bestScore = -1;
  for (const id of ids) {
    const cat = categoryMap.get(id);
    const s = cat ? permissionScore(cat.grants) : 0;
    if (s > bestScore) { bestScore = s; best = cat ? id : CATEGORY_STRANGERS; }
  }
  return best;
}

export function audienceTagFor(sessionAudience, registry) {
  if (!sessionAudience) return AUDIENCE_TAG_WARD_PRIVATE;
  const { location = null, participants = [] } = sessionAudience;
  if (!participants.length && !location) return AUDIENCE_TAG_WARD_PRIVATE;

  const categoryMap = new Map((registry?.categories ?? []).map(c => [c.id, c]));

  // Scan present users → the category that represents each one's access.
  const candidates = (participants ?? []).map(p =>
    representativeCategory(resolveParticipant(p, registry), categoryMap),
  );

  // The location ceiling joins as one more candidate (only ever lowers).
  if (location) {
    const loc = (registry?.locations ?? []).find(l => l.key === location);
    const catId = loc?.assignedCategoryId;
    candidates.push(catId && categoryMap.has(catId) ? catId : CATEGORY_STRANGERS);
  }

  if (!candidates.length) return AUDIENCE_TAG_WARD_PRIVATE;

  // Lowest permission level in the room wins (most restrictive).
  let tag = candidates[0];
  let min = permissionScore(categoryMap.get(tag)?.grants);
  for (const id of candidates.slice(1)) {
    const s = permissionScore(categoryMap.get(id)?.grants);
    if (s < min) { min = s; tag = id; }
  }
  return tag;
}

// ── Grant check ───────────────────────────────────────────────────

/**
 * Check whether a grant key is active in a grants object.
 * Boolean: must be true. Scalar ladder: any truthy non-'none' value.
 * Absent = denied.
 */
export function isGranted(grantKey, grants) {
  const v = (grants ?? {})[grantKey];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const lower = v.toLowerCase();
    return lower !== 'false' && lower !== 'none' && lower !== '';
  }
  return false;
}

// ── Fetch eligibility (gate-before-fetch) ─────────────────────────

/**
 * Decide which enrich() fetches may run for this audience.
 *
 * Fail-closed rules for intermediate ladder values:
 *   - memories: 'shared' — audience-tagged memories landed in Pillar C; the
 *     outgoing filter (Pillar D) guards what leaves. Pillar E unlocks this
 *     so 'shared' grants now permit memory_search, filtered to same-audience
 *     records at query time.
 *   - schedule: 'coarse' requires a coarse renderer ("busy until evening").
 *     None exists yet → only 'full' (or boolean true) permits the
 *     temporal_context fetch today.
 * When coarse rendering lands, this is the single place to widen.
 *
 * @param {object|null} audience effective grants or WARD_PRIVATE
 * @returns {{ wardPrivate: boolean, memory: boolean, graph: boolean, temporal: boolean }}
 */
export function fetchEligibility(audience) {
  if (audience === WARD_PRIVATE) {
    return { wardPrivate: true, memory: true, graph: true, temporal: true };
  }
  const g = audience ?? {};
  return {
    wardPrivate: false,
    memory:   g.memories === true || g.memories === 'shared',
    graph:    g.graph === true,
    temporal: g.schedule === 'full' || g.schedule === true,
  };
}

// ── Section-marker filtering ──────────────────────────────────────

/**
 * Strip gated sections from identity file content.
 *
 * Section format inside identity files:
 *   <!-- gate: CLASS -->
 *   ... content ...
 *   <!-- /gate -->
 *
 * In ward-private mode (effectiveGrants === WARD_PRIVATE), content is
 * returned unchanged — markers appear as inert HTML comments.
 *
 * In gated mode:
 *   - Known CLASS, grant active → markers stripped, content kept.
 *   - Known CLASS, grant not active → entire section stripped.
 *   - Unknown CLASS → entire section stripped (fail-closed).
 *
 * @param {string} content
 * @param {object|null} effectiveGrants
 * @returns {string}
 */
export function stripGatedSections(content, effectiveGrants) {
  if (effectiveGrants === WARD_PRIVATE) return content;
  if (typeof content !== 'string') return content ?? '';
  return content.replace(
    /<!--\s*gate:\s*([^\s>]+)\s*-->([\s\S]*?)<!--\s*\/gate\s*-->/g,
    (_match, cls, inner) => {
      const grantKey = MARKER_GRANT_MAP[cls.trim().toLowerCase()];
      if (!grantKey) return ''; // unknown class → fail-closed
      return isGranted(grantKey, effectiveGrants) ? inner : '';
    },
  );
}
