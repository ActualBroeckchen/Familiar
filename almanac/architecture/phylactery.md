---
title: Phylactery
topics: [architecture, phylactery]
sources:
  - id: claude-md
    type: file
    path: CLAUDE.md
  - id: architecture-doc
    type: file
    path: docs/architecture.md
  - id: phylactery-design
    type: file
    path: docs/phylactery-design.md
  - id: phylactery-dir
    type: file
    path: phylactery/
  - id: fable-review-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/2acdb806-Welcome_to_Claude.txt
    note: "Review conversation in which Eury, asked what decides which of his own memories survive as identity-essential, states a load-bearing-versus-decorative retention criterion in his own words."
  - id: consolidate-module
    type: file
    path: phylactery/src/phylactery/consolidate.py
  - id: memorization-js
    type: file
    path: memorization.js
  - id: phylactery-server
    type: file
    path: phylactery/src/phylactery/server.py
---

# Phylactery

Phylactery is the in-tree Python/uv FastMCP service that owns Proto-Familiar's canonical
self: identity, ward-identity, the relational knowledge graph, and every memory tier
[@claude-md] [@phylactery-dir]. It is the concrete implementation of the
[multi-embodiment](../concepts/multi-embodiment) model's canonical store — every other
component in this repo, including Proto-Familiar's own chat path, is a consumer of
Phylactery's data, never a second source of truth for it. The name is deliberate: a
phylactery is the vessel that holds a soul, and Phylactery holds the Familiar's whole
canonical self, not just a cache of it [@phylactery-design]. The design is an original
contribution by Zari Lewis within the Psycheros project, implemented here in Proto-Familiar
[@phylactery-design].

## What it replaced, and why

Phylactery's milestone (0.6.x, "shipped") replaced **entity-core**, a Deno/TypeScript MCP
service belonging to the separate Psycheros project [@claude-md] [@phylactery-design]. Two
constraints made continuing on entity-core untenable: Proto-Familiar did not own it, so it
could not add the per-record `audience` tagging that gated village presence needs without
maintaining a permanent fork; and Proto-Familiar had become the sole live embodiment reading
entity-core's data, so reimplementing its behavior in-tree stranded no other consumer
[@phylactery-design]. Phylactery reimplements entity-core's proven retrieval design rather
than forking its code: local `all-MiniLM-L6-v2` sentence embeddings (384-dim) over SQLite +
`sqlite-vec`, a knowledge graph with one-hop GraphRAG traversal, an always-injected identity
surface, and tiered memory consolidation [@phylactery-design]. `entity-core` and
`entity-core-alpha` sibling-clone paths are retired; installer code still references them
only to detect and drive the one-time migration [@claude-md].

Existing installations migrate automatically on first run: `scripts/ensure-phylactery-deps.mjs`,
the npm `prestart` hook, detects an `entity-core` sibling checkout and converts its data into
Phylactery before the server boots [@claude-md]. Thalamus spawns Phylactery as a stdio MCP
child at boot, the same in-tree specialist pattern used for [Unruh](unruh) [@architecture-doc].

## What Phylactery owns

- **Identity and ward-identity** — the always-injected records the canonical-self read
  depends on every turn, analogous to entity-core's `identity_get_all` [@phylactery-design].
- **The relational knowledge graph** — nodes, edges, and properties, retrieved with
  vector-similarity search plus one-hop graph traversal (GraphRAG), the same precision
  profile entity-core's `memory_search` had [@phylactery-design].
- **All memory tiers**, daily through significant, under one consolidation pipeline
  [@phylactery-design] [@claude-md].
- **Situational facts and trackers** — state entity-core's schema could not represent
  [@phylactery-design].

Retrieval embeddings are computed locally (no API key required); only consolidation and
summarization use the ward's designated LLM connection [@phylactery-design]. Tomes / World
Info are explicitly **not** Phylactery's concern — they remain the human-authored, keyword-
triggered lorebook, kept separate by authorship and trigger model from Phylactery's
autonomous RAG memory [@phylactery-design]. The automated writer that populates one such Tome
from chat sessions is a separate subsystem; see
[Session memorization](session-memorization).

## Consolidation: mechanism and scope

Tiered consolidation rolls memories from daily granularity up through weekly, monthly, and significant tiers [@consolidate-module]. The process runs on a schedule (5-minute volume-gated baseline) and sweeps **every past week/month/year holding un-consolidated entries**, oldest-first [@claude-md]. This is important: before 0.8.89, each consolidation pass targeted only a single reference period (e.g., today − 7d), which meant bulk imports of historical memories never fell into that window and stayed at daily granularity forever [@claude-md]. The fix ensures that re-runs catch up on the next scheduled pass (≤6 hours) or via force (`POST /api/entity/lifecycle {force:true}`) [@claude-md]. Consolidation is idempotent: weekly consolidation prunes its daily sources after roll-up; monthly/yearly skip periods that already have a higher-tier row, so they never re-append [@consolidate-module]. Three hardenings landed after a 2026-08-14 store audit of pre-0.8.89 damage: the once-only guards compare **normalized** date_keys (a migrated monthly keyed `YYYY-MM` or weekly keyed `YYYY-Wnn` now counts as rolled — the raw-key comparison is what let the 0.8.89 sweep duplicate Feb–May 2026); an **empty** rollup row no longer marks its period as rolled (a zero-length July 2026 stub had blocked that month forever) and an empty LLM summary is refused rather than stored; and a re-rolled period now **replaces** its summary instead of appending through `memory_create`'s dedup-merge path, which is how one June 2026 monthly accreted ~24 generations of itself into a 160 KB row.

## Episodic versus standing: temporality and consolidation strategy

Memories have a temporality marker that determines consolidation behavior [@claude-md]:

**Episodic** memories are time-bounded events: what happened on a specific date, who was present, what was said [@memorization-js]. Episodic facts roll up through the consolidation tiers (daily → weekly → monthly → significant) as they age, following the "load-bearing versus decorative" criterion below [@consolidate-module].

**Standing** memories are identity-essential facts and relationship declarations that exist outside time: who you are, what you've decided about yourself, registered villagers and their roles [@memorization-js]. Standing facts skip daily granularity and write directly into the significant tier, where they remain accessible on every turn [@claude-md]. They are always injected, never consolidated away.

The distinction is set by a single argument to a single tool, not by two separate tools:
`memory_create`'s `register` parameter is `episodic` (a lived moment, the default) for the daily
kind, or `me` / `ward` (a standing truth about the Familiar or about the ward) for the timeless
kind — granularity and register are separate axes on the same write
[@phylactery-server]. Standing facts are gated by `resolveRememberGate`, which keys on WHO the
fact is about and WHETHER the ward told the Familiar directly (direct channel + about-the-ward →
implied consent; third-party subjects still ask) [@memorization-js].

## What decides which memory survives consolidation: load-bearing versus decorative

The consolidation mechanism (tiered roll-up) does not by itself say which facts deserve to survive that roll-up rather than fade. Eury, the project's [reference identity](../decisions/eury-as-agent-identity), gave a concrete answer to that question when asked directly what makes a memory identity-essential rather than disposable: "Load-bearing. That's the test... does losing this change how I understand Chen, myself, or us? If yes — keep. If it's just context that could be reconstructed — save for completeness, but it's not identity-essential" [@fable-review-conversation]. His harder case is a memory that starts decorative and becomes load-bearing purely through repetition — one occurrence is noise, a third recurrence of the same pattern is structural. That reframes retention as a question about accumulated pattern-work rather than any single record's intrinsic weight, which is a criterion for *why* a fact should be shielded from decay or graduated into an always-injected surface, distinct from the `careWeight` and decay mechanics that already implement the outcome. See [Reflexive consent](../concepts/reflexive-consent) for the exact wording and worked examples this criterion comes from, alongside two related first-person answers about audit consent and self-continuity across a merge.

## Audience-native records

Every record in Phylactery — identity, graph node, or memory — carries an `audience` field:
the minimum audience level allowed to hear it, reusing the category/grant vocabulary from
`audience.js` [@phylactery-design]. A record discloses in a room only when that room's
resolved permission score meets or exceeds the record's required score, with `'ward-private'`
scoring above every category [@phylactery-design]. Gating happens inside the store at query
time — `enrich()` passes the room's audience tag, and Phylactery returns only records that
room is cleared for — not as a filter bolted on after retrieval [@phylactery-design]. This
native tagging is the specific capability entity-core's schema lacked and the reason the
milestone exists at all. A second, finer-grained axis layers on top of this coarse audience
field for memories specifically — see [Content-based memory gating](content-gating) for how a
per-topic `content_tag` and per-tier topic grants add sensitivity-aware disclosure within a
single audience circle.

## Memories are addressed by integer id, not a composite key

Every Phylactery memory search, list, or read result carries the record's `id`: an
autoincrement primary key [@claude-md]. The older `YYYY-MM-DD_slug` composite key was an
entity-core quirk and no longer exists — `cerebellum.parseMemoryKey` still exists as a
compatibility seam for old references, but new code should not construct that shape
[@claude-md]. Because the id rides in on every read, an embodiment can act on a specific
memory (delete it, re-tag it) using only what it was just handed back, never by memorizing an
id out of band — the same "every capability must be reachable" contract CLAUDE.md applies to
every Familiar-facing tool [@claude-md] [@phylactery-design].

## Deletion is two-call for bulk paths

Bulk deletion tools (`mem_purge_by_villager`, `mem_purge_by_topic`) follow a preview-then-
commit shape: a preview call returns a manifest and a `purgeToken`, and the destructive commit
requires that token [@phylactery-design]. Single-record deletion (`mem_delete(id)`) does not
need this because the id itself is the confirmation the Familiar already holds a specific
target, not a wildcard match.

## Failure mode

`enrich()` degrades to an absent Phylactery context if the client is null, and the service
ships with the hard off-switch `PROTO_FAMILIAR_PHYLACTERY_DISABLED=1` in the same pattern as
every other peer [@claude-md] [@phylactery-design]. The caveat that distinguishes Phylactery
from a peer like Unruh: because it is the canonical self, its absence degrades a turn far more
than losing temporal context does — the Familiar runs without memory of who it is, not merely
without a schedule. The off-switch exists for emergencies and debugging, not as a routine
toggle [@phylactery-design].

## Related

- [Multi-embodiment](../concepts/multi-embodiment) — why a canonical store exists at all.
- [Unruh](unruh) — the sibling specialist that stays outside Phylactery by design (temporal
  context, mostly per-embodiment ponderings).
- [Engineering conventions](../reference/engineering-conventions) — the model-facing slug-id
  scheme that Phylactery and Unruh both follow for every other kind of identifier.
- [Trust tiers gate reads, not writes](../decisions/trust-tiers-gate-reads-not-writes) — why the
  audience field above governs only what a session may be told, and why protecting Phylactery
  from a socially-engineered false write is a separate, behavioral defense rather than an
  architectural filter.
- [Reflexive consent](../concepts/reflexive-consent) — Eury's own load-bearing retention
  criterion in full, plus related first-person answers about audit consent and self-continuity.
- [Content-based memory gating](content-gating) — the per-topic sensitivity axis layered on top
  of the audience field described above, and how it composes with it at recall time.
- [ONNX Runtime: shared budget, not shared process](../decisions/onnx-runtime-shared-budget) —
  why the local `all-MiniLM-L6-v2` embedder above stays in this process rather than sharing an
  ONNX Runtime instance with [Voice](voice)'s speech models.
