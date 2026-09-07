// content-tags.js — content-based memory gating (the spine).
//
// The audience model was single-tier: a memory carried ONE `audience` circle,
// so a villager who sat in two overlapping tiers couldn't be gated sensibly.
// This module replaces that with CONTENT tags: a memory is tagged by TOPIC and
// SENSITIVITY LEVEL, and each Village tier grants, per topic, the highest level
// it may see. A villager sees a memory when ANY tier they belong to grants the
// memory's topic at or above its level (ward decision: most-permissive wins —
// overlapping tiers are additive, which is what makes overlap useful).
//
// Design + migration plan: docs/content-gating-build-spec.md. This file is
// Phase 1 — the vocabulary + the pure gating function + the legacy-category
// bridge — with no I/O, so it's trivially testable and carries no migration
// risk. The wiring (extraction tagging, recall gating, tier-grant UI, the
// memory migration) builds on top of these primitives.

// ── Vocabulary ────────────────────────────────────────────────────────────

// The fixed set of content topics the extractor may tag. Fixed (not
// ward-extensible) so the model, the tier-grant editor, and the gate all speak
// the same language. `general` is the catch-all for anything that isn't one of
// the sensitive topics — it rides the tier's baseline `general` grant.
export const CONTENT_TOPICS = [
  'general',        // ordinary day-to-day facts, no special sensitivity
  'medical',        // physical health, conditions, medications, symptoms
  'mental-health',  // mental/emotional health, diagnoses, therapy
  'sexuality',      // orientation, sexual life
  'gender',         // gender identity, transition
  'family',         // family structure, relatives, domestic life
  'relationships',  // partners, dating, interpersonal dynamics
  'finances',       // money, debt, income, financial situation
  'legal',          // legal status, cases, immigration, records
  'substance',      // alcohol/drug use, recovery
  'religion',       // faith, practice, beliefs
  'politics',       // political views, affiliation
  'work',           // job, employer, professional life
  'location',       // whereabouts, address, movement
  'contact-info',   // phone, email, handles, ways to reach
];

const _TOPIC_SET = new Set(CONTENT_TOPICS);

// Two sensitivity levels, ordered. `open` = shareable within a tier that knows
// this topic at all; `sensitive` = only a tier trusted with this topic deeply.
export const CONTENT_LEVELS = ['open', 'sensitive'];
const _LEVEL_RANK = { none: 0, open: 1, sensitive: 2 };

/** Numeric rank of a level string (unknown/absent → 0 = "not permitted"). */
export function levelRank(level) {
  return _LEVEL_RANK[level] ?? 0;
}

export function isTopic(t)  { return _TOPIC_SET.has(t); }
export function isLevel(l)  { return l === 'open' || l === 'sensitive'; }

/**
 * Normalize an extractor-supplied tag to `{ topic, level }`, or null if it
 * isn't a recognised topic. Accepts `"medical:sensitive"`, `"medical-sensitive"`,
 * or `{ topic, level }`. An unknown/absent level defaults to `sensitive` — the
 * safe default (a mis-tagged fact gates TIGHTER, never looser).
 */
export function normalizeTag(tag) {
  let topic, level;
  if (tag && typeof tag === 'object') {
    topic = tag.topic; level = tag.level;
  } else if (typeof tag === 'string') {
    // Match against the known topics (which themselves contain hyphens, e.g.
    // mental-health), longest first, then read an optional trailing level. A
    // trailing token that isn't open|sensitive is ignored → default applies.
    const s = tag.trim().toLowerCase();
    topic = [...CONTENT_TOPICS].sort((a, b) => b.length - a.length)
      .find(t => s === t || s.startsWith(`${t}:`) || s.startsWith(`${t}-`));
    if (topic) {
      const rest = s.slice(topic.length).replace(/^[:-]/, '');
      if (rest === 'open' || rest === 'sensitive') level = rest;
    }
  }
  if (!_TOPIC_SET.has(topic)) return null;
  return { topic, level: isLevel(level) ? level : 'sensitive' };
}

// ── The gate ──────────────────────────────────────────────────────────────

/**
 * Does a grant set permit a memory tagged `{topic, level}`?
 *
 * `topicGrants` is the tier's per-topic level map, e.g.
 *   { general: 'open', medical: 'open', sexuality: 'none' }
 * A topic absent from the map is treated as 'none' (fail-closed: a tier only
 * sees topics it was explicitly granted). `general` at `open` is the ordinary
 * baseline a tier gets for everyday facts.
 *
 * Visible ⟺ the tier's granted level for this topic ≥ the memory's level.
 * Pure. Never throws.
 */
export function topicVisibleToGrants(topicGrants, topic, level) {
  const want = levelRank(level || 'sensitive');
  const have = levelRank((topicGrants && topicGrants[topic]) || 'none');
  return have >= want && want > 0;
}

/**
 * Union per-topic grants across all the tiers a villager belongs to — the
 * most-permissive level per topic wins (ward decision). `tierGrantsList` is an
 * array of per-topic maps. Returns one merged map.
 */
export function unionTopicGrants(tierGrantsList = []) {
  const out = {};
  for (const grants of tierGrantsList) {
    if (!grants || typeof grants !== 'object') continue;
    for (const [topic, level] of Object.entries(grants)) {
      if (!_TOPIC_SET.has(topic)) continue;
      if (levelRank(level) > levelRank(out[topic])) out[topic] = level;
    }
  }
  return out;
}

/**
 * Intersect two per-topic grant maps — the MIN level per topic, and only topics
 * present in BOTH (a room with multiple participants: everyone must be granted).
 * Absent/`none` on either side drops the topic. Pure.
 */
export function intersectTopicGrants(a, b) {
  const out = {};
  const am = a || {}, bm = b || {};
  for (const topic of Object.keys(am)) {
    if (!_TOPIC_SET.has(topic) || !(topic in bm)) continue;
    const lvl = levelRank(am[topic]) <= levelRank(bm[topic]) ? am[topic] : bm[topic];
    if (levelRank(lvl) > 0) out[topic] = lvl;
  }
  return out;
}

/**
 * The whole gate for one memory + one villager (their tiers' unioned grants):
 * visible when the villager's most-permissive tier grants the memory's topic at
 * or above its level. A memory with no recognised tag is treated as
 * `general:sensitive` — it needs an explicit `general:sensitive` grant, so an
 * untagged memory never leaks to a tier that only has baseline `general:open`.
 */
export function memoryVisibleToVillager(memoryTag, unionedGrants) {
  const t = normalizeTag(memoryTag) || { topic: 'general', level: 'sensitive' };
  return topicVisibleToGrants(unionedGrants, t.topic, t.level);
}

// ── Tier topic-grant sanitation (Phase 2) ────────────────────────────────────

/**
 * Validate a tier's per-topic grant map: keep only recognised topics with a
 * real level (`open`/`sensitive`); drop everything else (unknown topic, `none`,
 * junk). Returns a fresh clean map. Pure. The Village grants object carries this
 * under `grants.topics`; `none`/absent means the tier sees that topic not at all.
 */
export function sanitizeTopicGrants(raw) {
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [topic, level] of Object.entries(raw)) {
      if (_TOPIC_SET.has(topic) && (level === 'open' || level === 'sensitive')) out[topic] = level;
    }
  }
  return out;
}

// ── Legacy bridge ───────────────────────────────────────────────────────────

// Map the OLD content `category` (basics/emotional_content/health_info/
// relationships/whereabouts) to a content tag, so existing memories and the
// current extractor output gate sensibly before the full tagging lands. The
// level leans on the pre-existing sensitive-category set: a sensitive category
// migrates to `sensitive`, an ordinary one to `open`.
const _CATEGORY_TO_TOPIC = {
  basics:            'general',
  emotional_content: 'mental-health',
  health_info:       'medical',
  relationships:     'relationships',
  whereabouts:       'location',
};
const _SENSITIVE_CATEGORIES = new Set(['emotional_content', 'health_info']);

/** { topic, level } for a legacy category (+ optional explicit sensitivity). */
export function categoryToTag(category, { sensitive } = {}) {
  const topic = _CATEGORY_TO_TOPIC[category] || 'general';
  const level = (typeof sensitive === 'boolean')
    ? (sensitive ? 'sensitive' : 'open')
    : (_SENSITIVE_CATEGORIES.has(category) ? 'sensitive' : 'open');
  return { topic, level };
}
