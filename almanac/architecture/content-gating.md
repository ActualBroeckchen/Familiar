---
title: Content-Based Memory Gating
topics: [architecture, content-gating, phylactery]
sources:
  - id: build-spec
    type: file
    path: docs/content-gating-build-spec.md
  - id: claude-md
    type: file
    path: CLAUDE.md
  - id: content-tags-js
    type: file
    path: content-tags.js
  - id: content-regate
    type: file
    path: content-regate.js
  - id: content-gate-py
    type: file
    path: phylactery/src/phylactery/content_gate.py
  - id: audience-js
    type: file
    path: audience.js
  - id: village-js
    type: file
    path: village.js
  - id: memorization-js
    type: file
    path: memorization.js
  - id: content-tag-migration
    type: file
    path: phylactery/src/phylactery/migrations/0005_content_tag.sql
  - id: cerebellum-js
    type: file
    path: cerebellum.js
  - id: discord-gateway-js
    type: file
    path: discord-gateway.js
---

# Content-Based Memory Gating

Content-based memory gating is a second, finer-grained axis layered on top of
Village's existing audience-circle system, shipped complete across 0.9.17–0.9.24
[@claude-md] [@build-spec]. Before this feature, every Phylactery record carried
one `audience` value — the minimum Village category tier allowed to hear it — so
a villager sitting in two overlapping tiers could not be gated per subject: a
fact either fit their one circle or it did not [@build-spec]. Content gating adds
a `content_tag` (a topic plus a sensitivity level, e.g. `medical:sensitive`) to
each memory and a per-topic grant map to each Village tier, so a memory now
surfaces to a villager only when it clears **both** the coarse audience floor
described in [Phylactery](phylactery)'s "Audience-native records" section **and**
this finer per-topic gate [@claude-md]. The two axes are additive by design —
overlapping tiers can each unlock different topics for the same villager, which
the single-circle model could not express [@build-spec].

## The model: topics, levels, tags, and grants

`content-tags.js` is the pure spine both languages' gates are built on, with no
I/O, so it can be unit-tested directly and mirrored into Python without drift
[@content-tags-js] [@build-spec]. It fixes a closed vocabulary in `CONTENT_TOPICS`
— `general`, `medical`, `mental-health`, `sexuality`, `gender`, `family`,
`relationships`, `finances`, `legal`, `substance`, `religion`, `politics`,
`work`, `location`, `contact-info` — so the extraction prompt, the tier-grant
editor, and the gate itself all speak the same fixed language rather than free
text [@content-tags-js] [@build-spec]. `CONTENT_LEVELS` is `open < sensitive`:
`open` means shareable with any tier that is granted the topic at all,
`sensitive` means visible only to a tier trusted with that topic deeply
[@content-tags-js] [@build-spec].

A memory's tag is one `{topic, level}` pair, stored as the string `topic:level`
[@content-tags-js]. A Village tier's grants gained a second axis alongside its
existing coarse booleans: a `topics` map like
`{ general: 'open', medical: 'open', sexuality: 'none' }`, where a topic absent
from the map is treated as `none` — fail-closed, so a tier only sees topics it
was explicitly granted [@build-spec] [@village-js]. `topicVisibleToGrants` in
`content-tags.js` is the gate primitive: a tag is visible against a grants map
when the map's level for that topic is at or above the tag's level
[@content-tags-js]. `memoryVisibleToVillager(tag, unionedGrants)` wraps that
check and also implements the fail-closed default for an untagged memory,
treating it as `general:sensitive` so it can never leak to a tier that only has
the baseline `general:open` [@content-tags-js] [@build-spec]. `unionTopicGrants`
takes the most-permissive level per topic across a list of tier grant maps — the
"most-permissive tier wins" ward decision — extending the union `audience.js`
already performed across a villager's categories to this new per-topic map
[@content-tags-js] [@build-spec].

`categoryToTag` is the legacy bridge used both as a one-time migration source and
as the code-side fallback whenever a tag cannot be trusted: `basics` →
`general:open`, `health_info` → `medical:sensitive`, `emotional_content` →
`mental-health:sensitive`, `relationships` → `relationships:open`,
`whereabouts` → `location:open` [@content-tags-js] [@build-spec].

## Where the vocabulary lives, and how a tier's grants gained the axis without breaking anything

Village category `grants` (`village.js`) gained a nested `topics` map as the one
exception to an otherwise-flat grants object: `sanitizeGrants` strips every other
key to a primitive, but validates and preserves `topics` through
`content-tags.js`'s `sanitizeTopicGrants` [@village-js] [@build-spec]. Landing
that nested field required closing several surfaces in the same commit that a
naive addition would have silently broken [@build-spec]:

- `permissionScore` already ignored a nested object and adds zero for it, so
  `topics` cannot inflate a tier's coarse permission score [@build-spec].
- `grantUnion`/`grantIntersection` special-case `topics` to deep-union or
  deep-intersect per topic rather than collapsing it to a boolean — a boolean
  collapse would both destroy the map and, as a bare `true`, inflate
  `permissionScore` enough to shift `audienceTagFor` [@build-spec] [@village-js].
- `upsertCategory` preserves an existing tier's `topics` across a save that omits
  the field, because the legacy category editor does not send it
  [@village-js] [@build-spec].
- The category-editor UI excludes `topics` from its free-form key/value rows so
  it cannot be re-serialized into a plain string and corrupted [@build-spec].

A first-time-only migration (`normalizeRegistry` /
`deriveTopicGrantsFromCoarse` in `village.js`) seeds `topics` from a tier's
existing coarse grants and never overwrites a ward edit once `topics` is set
[@village-js] [@build-spec]: `identitySensitive` seeds every topic at
`sensitive` (visibility-preserving — the old "everything except address" grant
— the ward narrows it later); `health` seeds `medical`/`mental-health` at
`sensitive`; `memories`/`identityBasic` seed `general:open`; `location` seeds
`location:open` [@build-spec]. The migration guard checks specifically for
`topics === undefined`, so an explicit empty object (`{}`, meaning "every topic
hidden," set by the ward clearing every row in the editor) persists instead of
being re-derived [@village-js] [@build-spec]. The Village pane in `public/app.js`
renders a collapsed-by-default "Content topics" section — one None/Open/Sensitive
select per topic — only for an existing category, so a brand-new category omits
`topics` and lets the migration seed it from whatever coarse grants the ward
picked first [@build-spec].

## Extraction: the model suggests, code validates

Both memorization extraction prompts (`memorization.js`'s `buildPrompt` and
`buildSharedRoomPrompt`) gained a shared `content_tag` field, built from one
constant pair (`CONTENT_TAG_JSON_LINE` and `CONTENT_TAG_FIELD_RULE`) so the two
prompts cannot drift apart [@memorization-js] [@build-spec]. The prompt frames
`content_tag` as answering a different question than `category`: category is how
the fact is filed, `content_tag` is who is ever allowed to see it, and the model
is asked to reason about it in first person — "who I'd be comfortable knowing
this" [@memorization-js]. The full `CONTENT_TOPICS` vocabulary is interpolated
into the prompt text directly, so the extractor and the gate can never diverge on
what topics exist [@memorization-js] [@build-spec].

The model's output is never trusted as a machine value on its own. `processJob`
in `memorization.js` runs `normalizeTag(fact.content_tag) || categoryToTag(category)`
in code, falling back to the category-derived tag whenever the model's tag is
missing or does not match the fixed vocabulary [@memorization-js] [@build-spec].
This is the same pattern [Exact values are code's job](../decisions/exact-values-in-code)
describes for other model-adjacent values: the model may suggest, but code
canonicalizes at the boundary, and a mis-tag is designed to gate a memory
*tighter* than intended, never looser [@build-spec].

On the storage side, Phylactery's `memory.create` accepts an optional
`content_tag` and otherwise derives one itself from `category`, using a Python
mirror of `categoryToTag` so the fallback holds even if a caller skips the field
entirely [@build-spec]. Migration `0005_content_tag.sql` adds a nullable
`content_tag` column with an index, and `backfill_content_tags` idempotently
tags pre-existing NULL rows from their `category`, running once automatically at
server boot [@content-tag-migration] [@build-spec].

## Recall: a layered gate, not a replacement

Recall composes two checks deliberately, rather than treating content gating as
a replacement for the existing audience floor [@build-spec]:

1. **Coarse floor** — the unchanged `visibleAudiences` check from
   [Phylactery](phylactery)'s audience-native records: the room's ward-private
   and provenance ceiling. A memory made in a higher-trust context never
   surfaces in a lower one, and `ward-private` is excluded from every villager
   room [@build-spec].
2. **Fine content gate** — among what clears the floor, a memory surfaces only if
   `memoryVisibleToVillager`/`memory_visible_to_grants` passes against the room's
   topic grants: each villager's tiers unioned internally, then intersected
   across every participant in the room [@build-spec] [@content-gate-py].

`audience.js`'s `topicGrantsForRoom(effectiveGrants, roomTag)` is the deliberate
companion to `visibleAudiences`, derived together at every call site so the two
halves cannot drift apart: a ward room returns `null` (no content filter at
all), and a villager room with no topics returns `{}` (fail-closed — nothing by
content) [@audience-js] [@build-spec]. Phylactery's `memory.search` and
`memory.by_timerange` accept a `topic_grants` parameter and post-filter each row
after overfetching, so a per-row content drop still fills the caller's limit
[@build-spec]. On the Node side, `enrich` threads `topicGrants` into
`memory_search`; `server.js`'s `/api/chat` and `discord-gateway.js`'s
`resolveLocationGate` derive `audienceTopics` alongside `audienceVisible`; and
the Discord tool context carries `topicGrants` through
`cerebellum.discordReadTopicGrants(ctx)`, the fail-closed (`{}`) companion to
`discordReadAudiences` [@discord-gateway-js] [@cerebellum-js] [@build-spec].

Two paths deliberately stay outside the content gate:

- **Ward-context recall** — the pondering/reflection loop, tome-graduation
  dedup, and the ward's own API endpoints — omits `topic_grants` entirely, so
  the Familiar's own memory of itself stays unscoped: the ward always sees
  everything [@build-spec].
- **Graph nodes and edges** keep the coarse audience gate only, because they
  carry no `content_tag` at all; `graph_node_search` and `graph_subgraph` are
  unchanged by this feature [@build-spec].

## Memory-manager UI

The memory manager (`public/app.js`, KE Memories tab) shows each memory's
content tag as a badge next to its audience badge, and the detail editor exposes
a topic `<select>` plus a level `<select>` so the ward can retag or clear a
memory by hand — clearing sends it back to the untagged
`general:sensitive` default at recall time [@build-spec]. `PUT
/api/entity/memories/by-id/:id` accepts a `contentTag` value and canonicalizes it
in code with the same `normalizeTag` used everywhere else, rejecting anything
outside the fixed vocabulary rather than trusting the client [@build-spec].

## Retroactive re-tagging: bringing existing history along (Phase B)

Everything above is the forward gate (Phase A): new ward-about-self facts are content-gated as
they are written. That leaves the ward-private history written before this feature existed
untouched. The `content-regate-loop.js` background worker (see
[Autonomous loops](autonomous-loops)) is Phase B: an opt-in, 30-minute-tick pass that has the
Familiar itself review its own old ward-private facts and decide, per fact and with judgment
rather than a mechanical bulk re-tag, which should be pulled under the content-gating rules and
which stay strictly private [@content-regate]. It is deliberately conservative: a fact the
Familiar is unsure about stays private (the parser fails closed to "keep"), every fact it does
open is written to a disclosure notice the ward reads, and any opened fact can be reverted to
private per-fact [@content-regate]. Candidates are code-selected — ward-private, ward-self facts
only, never a third-party fact — and one batched LLM judgment covers a whole tick, reusing the
existing `updateMemoryById` wrapper as the only mutation surface [@content-regate]. The loop stays
dormant until the ward enables "Review my private notes for content-sharing" in Settings.

## Invariants

These hold at every seam this feature touches, and any future extension of
content gating must preserve them [@build-spec]:

- **Fail-closed everywhere.** An unknown tag, an unknown topic, an absent grant,
  or a gate error all resolve to "not shown" for a villager. The ward always
  sees everything on a ward-private turn.
- **The most-permissive union is villager-scoped, never global.** Only the tiers
  a given villager actually belongs to are unioned when deciding what they can
  see — not every tier in the registry.
- **The tag is a machine value at the boundary, not model output trusted
  directly.** The model suggests a topic and level; code validates against the
  fixed vocabulary and falls back to `categoryToTag` on anything invalid, the
  same exact-values discipline [Exact values are code's job](../decisions/exact-values-in-code)
  applies to timestamps, ids, and other model-adjacent values elsewhere in this
  codebase.
- **Every phase shipped with a recall-path pipeline test**, not only pure-function
  unit tests, because a wiring gap in the gate is exactly the kind of failure a
  pure-function test cannot catch [@build-spec].

Because this feature governs what a session is allowed to be told, it is a
read-side control in the same sense [Trust tiers gate reads, not writes](../decisions/trust-tiers-gate-reads-not-writes)
describes for the underlying single-audience system: content gating narrows
*what a villager tier can see* further than the coarse floor already did, but it
still has no bearing on what a conversational partner can get written into
memory in the first place — that remains the model's own behavioral judgment,
not an architectural filter [@build-spec].

## Related

- [Phylactery](phylactery) — the canonical store whose audience-native records
  provide the coarse floor this feature layers on top of.
- [Trust tiers gate reads, not writes](../decisions/trust-tiers-gate-reads-not-writes) —
  why the underlying category/grant system is read-only gating, and why write
  protection is a separate, behavioral defense; this feature inherits that same
  read/write split.
- [Exact values are code's job](../decisions/exact-values-in-code) — the general
  rule that a model-suggested value must be validated and canonicalized in code,
  which `normalizeTag(...) || categoryToTag(...)` applies here.
- [Session memorization](session-memorization) — the extraction pipeline whose
  prompts gained the `content_tag` field this page describes.
- [Autonomous loops](autonomous-loops) — where the content-re-gate background worker sits
  alongside the rest of the loop set, and the shared off-switch/degradation contract it follows.
