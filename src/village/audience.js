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
import { unionTopicGrants, intersectTopicGrants, sanitizeTopicGrants } from '../memory/content-tags.js';

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
    // `topics` is the nested content-gating map — union it per-topic (most
    // permissive), NEVER collapse it to a boolean (that both destroys the map
    // and, as a bare `true`, would inflate permissionScore).
    if (k === 'topics') {
      const t = unionTopicGrants([(g1 ?? {}).topics, (g2 ?? {}).topics]);
      if (Object.keys(t).length) out.topics = t;
      continue;
    }
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
    // `topics` intersects per-topic (min level, only topics both sides grant) —
    // never collapsed to a boolean (see grantUnion).
    if (k === 'topics') {
      const t = intersectTopicGrants((g1 ?? {}).topics, (g2 ?? {}).topics);
      if (Object.keys(t).length) out.topics = t;
      continue;
    }
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

// Coarse-audience sentinel for a fact ABOUT THE WARD whose visibility is
// governed by the fine content gate (content_tag × each circle's per-topic
// grants), not by a circle membership. It PASSES the coarse membership floor in
// every gated room (added to visibleAudiences below, like strangers is) and
// defers entirely to the content gate: a villager sees the fact only if their
// circle grants its content topic, and if NO circle grants it the fact reaches
// no one (fail-closed → effectively ward-private). Distinct from 'ward-private'
// (hard private, the ward's per-fact override) and from a circle id.
export const AUDIENCE_TAG_WARD_OPEN = 'ward-content-gated';

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
  const set = roomCircleSet(sessionAudience, registry);
  if (set == null) return AUDIENCE_TAG_WARD_PRIVATE;

  // The room's tag is the most-trusted circle EVERYONE present shares — the
  // narrowest visibility that still round-trips (a memory written here is
  // readable back here, because its tag is in this room's shared-circle set by
  // construction; a room with a stranger falls to 'strangers', the broadest
  // tag). permissionScore's ONLY surviving role in the read/tag gate: ranking
  // the SHARED circles against each other, deterministic tie-break by id.
  const categoryMap = new Map((registry?.categories ?? []).map(c => [c.id, c]));
  let tag = CATEGORY_STRANGERS;
  let best = -1;
  for (const id of [...set].sort()) {
    const s = permissionScore(categoryMap.get(id)?.grants);
    if (s > best) { best = s; tag = id; }
  }
  return tag;
}

/**
 * The set of circle (category) ids that EVERY participant in the room belongs
 * to — the Villager/Group-Chat membership mechanism extended to record
 * visibility. This is the single source of truth both `visibleAudiences` (the
 * read gate) and `audienceTagFor` (the write-time tag) derive from, so the two
 * halves can never disagree about who a room is.
 *
 * A villager's membership set is `categoryIds ∪ {strangers}` (everyone is at
 * least a stranger; a villager with no categories → strangers only). An
 * unresolved/unknown participant → `{strangers}`. Dangling ids that name no
 * live category are dropped (fail-closed). The location joins as one more
 * membership set: `{assignedCategory, strangers}` for an assigned location,
 * `{strangers}` for an unassigned one — a public channel's full readership
 * isn't enumerable from who has spoken, so it's only ever provably strangers
 * plus the circle the ward assigned it.
 *
 * The room's set is the INTERSECTION of all those membership sets: a circle is
 * in it only if every participant (and the location) belongs to that circle.
 * `strangers` is in every membership set, so the intersection is never empty
 * for a gated room — strangers-tagged records stay visible everywhere gated.
 *
 * @returns {Set<string>|null} the shared-circle set, or null for a ward-private
 *   session (no participants + no location → no gating).
 */
function roomCircleSet(sessionAudience, registry) {
  if (!sessionAudience) return null;
  const { location = null, participants = [] } = sessionAudience;
  if (!participants.length && !location) return null;

  const categoryMap = new Map((registry?.categories ?? []).map(c => [c.id, c]));
  const live = (id) => (id && categoryMap.has(id)) ? id : null;

  const memberSets = (participants ?? []).map(p => {
    const v = resolveParticipant(p, registry);
    const ids = (v?.categoryIds?.length ? v.categoryIds : []).map(live).filter(Boolean);
    return new Set([...ids, CATEGORY_STRANGERS]);
  });

  if (location) {
    const loc = (registry?.locations ?? []).find(l => l.key === location);
    const catId = live(loc?.assignedCategoryId);
    memberSets.push(new Set(catId ? [catId, CATEGORY_STRANGERS] : [CATEGORY_STRANGERS]));
  }

  if (!memberSets.length) return null;

  let inter = memberSets[0];
  for (let i = 1; i < memberSets.length; i++) {
    inter = new Set([...inter].filter(x => memberSets[i].has(x)));
  }
  return inter;
}

/**
 * The set of audience tags a room may SEE on stored records (Pillar E recall
 * gate). MEMBERSHIP, not a scalar trust score: a record tagged with circle X
 * surfaces in a room iff every person present is a member of X (X is in the
 * room's shared-circle set). Two circles with identical grants no longer see
 * each other's records — trust is not a total order, so a Family DM never
 * surfaces a Work-tagged record even at equal permission scores.
 *
 * Takes the session audience (participants + location), not a bare tag, because
 * membership can only be computed from who is actually present.
 *
 * @param {object|null} sessionAudience { location, participants } or null
 * @param {object} registry normalized village registry
 * @returns {string[]|null} the allowed audience-tag set (always includes
 *   'strangers' for a gated room; never includes 'ward-private'), or null for a
 *   ward-private session (no filtering, the ward sees everything). A record
 *   tagged with a deleted/unknown category id is in no membership set → excluded
 *   (fail-closed).
 */
export function visibleAudiences(sessionAudience, registry) {
  const set = roomCircleSet(sessionAudience, registry);
  // The ward-content-gated sentinel is admitted to EVERY gated room's coarse
  // set (like strangers) so a ward-about-self content-gated fact clears the
  // membership floor and its real visibility is decided by the content gate.
  // A ward session (null) still returns null = unscoped (sees all).
  return set ? [...set, AUDIENCE_TAG_WARD_OPEN] : null;
}

/**
 * The room's per-topic content-tag grant map (content-gating Phase 4 recall
 * gate). The COMPANION to `visibleAudiences`: they are always derived and
 * passed together so the two halves of the gate can't drift (the exact failure
 * class the ward flagged — one half built as if the other didn't exist).
 *
 * `visibleAudiences` is the coarse provenance/ward-private floor (which category
 * tiers a room may see); this is the fine per-topic sensitivity gate (what
 * CONTENT within those a room may see). A memory surfaces only if it clears
 * both.
 *
 * @param {object} effectiveGrants  the room's effective grants from
 *   `resolveAudience()` (already unioned within each villager's tiers and
 *   intersected across the room's participants — its `.topics` is the room's
 *   effective per-topic map).
 * @param {string} roomTag          the room's audience tag (from `audienceTagFor`).
 * @returns {object|null} the sanitized per-topic grant map, or null for a
 *   ward-private room (= no content filter, the ward sees everything). A villager
 *   room with no topic grants → `{}` (fail-closed: nothing surfaces by content).
 */
export function topicGrantsForRoom(effectiveGrants, roomTag) {
  if (!roomTag || roomTag === AUDIENCE_TAG_WARD_PRIVATE) return null; // ward sees all
  const topics = (effectiveGrants && typeof effectiveGrants === 'object') ? effectiveGrants.topics : null;
  return sanitizeTopicGrants(topics); // fail-closed: unknown/absent topics dropped → not visible
}

// ── Write-time audience derivation (Phase 2) ──────────────────────
//
// A memory's audience is DERIVED IN CODE from what the extractor already
// produces (category + subjects) and the session tag — the LLM is never asked
// for it (a tag it could forget is a tag that could leak). Widen + tighten (ward
// decision): a subject villager's EXPLICIT `disclosure[category]` may raise OR
// lower the audience; without an explicit preference the default is
// session-bounded (never auto-widened from the villager's category).
//
// NOTE (audit follow-up): the tighten/widen ordering below still uses
// permissionScore-as-restrictiveness (audienceScore/mostRestrictive). The READ
// gate moved to circle membership (visibleAudiences/audienceTagFor); this write
// side picks "narrower of the session tag and a disclosure preference," where
// narrower is a per-circle comparison that a scalar approximates adequately for
// choosing between two *specific* tags (not for a room-visibility total order,
// which was the bug). Left as-is deliberately; a full membership-based
// tighten/widen is a candidate for the same treatment in a later pass.

const SENSITIVE_CATEGORIES = new Set(['health_info', 'emotional_content']);

// Restrictiveness score of an audience tag: higher = narrower circle. ward-private
// and unknown/deleted categories score Infinity (fail-private).
function audienceScore(tag, categoryMap) {
  if (!tag || tag === AUDIENCE_TAG_WARD_PRIVATE) return Infinity;
  const cat = categoryMap.get(tag);
  return cat ? permissionScore(cat.grants) : Infinity;
}

// The most restrictive (narrowest) of a set of audience tags.
function mostRestrictive(tags, categoryMap) {
  let best = AUDIENCE_TAG_WARD_PRIVATE, bestScore = -Infinity;
  for (const t of tags) {
    const s = audienceScore(t, categoryMap);
    if (s > bestScore) { bestScore = s; best = t; }
  }
  return best;
}

/**
 * Derive the audience tag a memory should be stored with.
 * @param {string} category      remember-category (health_info, basics, …)
 * @param {Array}  subjects       subject villager objects (may carry `.disclosure`)
 * @param {string} sessionTag     the room the memory was made in (the ward's ceiling)
 * @param {object} registry       village registry (for category scores)
 * @returns {string} an audience tag (a category id, or 'ward-private')
 */
export function deriveMemoryAudience({ category, subjects = [], sessionTag = AUDIENCE_TAG_WARD_PRIVATE, registry } = {}) {
  const categoryMap = new Map((registry?.categories ?? []).map(c => [c.id, c]));

  // ── Fact about the WARD themselves (no third-party subject) ──
  if (!subjects.length) {
    // In a ward-private session it's CONTENT-GATED: the content_tag + each
    // circle's per-topic grants decide who may ever see it (a villager sees it
    // only if their circle grants its topic; no circle granted → nobody, so
    // still effectively private). The ward can override any specific memory to
    // hard 'ward-private' via the memory manager. The old SENSITIVE_CATEGORIES
    // → ward-private floor is intentionally GONE here: sensitivity now rides the
    // content_tag, not the coarse tag (health_info → medical:sensitive, etc.).
    // In a SHARED room the fact stays session-bounded — that room already saw it.
    if (!sessionTag || sessionTag === AUDIENCE_TAG_WARD_PRIVATE) return AUDIENCE_TAG_WARD_OPEN;
    return sessionTag;
  }

  // ── Fact about a THIRD PARTY (subjects present) — UNCHANGED ──
  // Third-party privacy + provenance stay on the coarse circle gate, with the
  // sensitivity floor. Session-bounded default, tightened by the fact's
  // sensitivity floor; an explicit per-subject disclosure preference may widen
  // or tighten; the narrowest across all named subjects wins.
  const floor = SENSITIVE_CATEGORIES.has(category) ? AUDIENCE_TAG_WARD_PRIVATE : null;
  const sessionDefault = floor ? mostRestrictive([sessionTag, floor], categoryMap) : (sessionTag || AUDIENCE_TAG_WARD_PRIVATE);
  const levels = subjects.map(v => {
    const explicit = v?.disclosure?.[category];
    if (explicit && (explicit === AUDIENCE_TAG_WARD_PRIVATE || categoryMap.has(explicit))) return explicit;
    return sessionDefault;
  });
  return mostRestrictive(levels, categoryMap);
}

/**
 * Derive the audience tag a knowledge-graph node should carry, IN CODE (Phase 3).
 * A node whose label matches a known villager (by name or handle) takes that
 * villager's representative Village category — so a person-node surfaces only in
 * rooms cleared for them. A label matching no villager (a place, an org, the ward,
 * an abstraction) fails closed to ward-private; the ward/Familiar can widen a
 * specific node deliberately later (graph_node_update). The model is never asked.
 *
 * @param {string} label    the node label (an entity name)
 * @param {object} registry village registry
 * @returns {string} an audience tag (a category id, or 'ward-private')
 */
export function deriveNodeAudience({ label, registry } = {}) {
  if (!label || typeof label !== 'string') return AUDIENCE_TAG_WARD_PRIVATE;
  const villager = resolveParticipant({ name: label }, registry);
  if (!villager) return AUDIENCE_TAG_WARD_PRIVATE; // not a known person → fail-closed
  const categoryMap = new Map((registry?.categories ?? []).map(c => [c.id, c]));
  return representativeCategory(villager, categoryMap);
}

/**
 * The most restrictive (narrowest) of a set of audience tags — the public wrapper
 * over the internal helper, for callers that hold a registry but not a categoryMap
 * (e.g. deriving an edge's audience as the narrower of its two endpoints).
 */
export function mostRestrictiveAudience(tags, registry) {
  const categoryMap = new Map((registry?.categories ?? []).map(c => [c.id, c]));
  return mostRestrictive(tags, categoryMap);
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
 *   - graph FOLLOWS the memory grant. The graph is relational memory; once a room
 *     may see shared memories it may see the graph, and the per-node `audiences`
 *     filter (visibleAudiences → audience_in_sql) scopes it node-by-node so a
 *     ward-private node never surfaces even when the fetch runs. (Previously graph
 *     gated on a `graph` grant that NO category ever granted, so it was silently
 *     off in every non-ward session — the per-node tags now do the real gating.)
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
  const memory = g.memories === true || g.memories === 'shared';
  return {
    wardPrivate: false,
    memory,
    graph: memory, // graph follows memory; per-node audiences filter does the gating
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
