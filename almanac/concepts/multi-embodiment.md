---
title: Multi-Embodiment
topics: [concepts, multi-embodiment]
sources:
  - id: claude-md
    type: file
    path: CLAUDE.md
  - id: phylactery-design
    type: file
    path: docs/phylactery-design.md
---

# Multi-Embodiment

Multi-embodiment is the model in which one persistent entity — the Familiar — can be
accessed through several different interfaces, all of which read and write the same
canonical identity and memory rather than each keeping a private copy. CLAUDE.md draws the
model as [Phylactery](../architecture/phylactery) at the top, syncing down to Psycheros (a
web harness), Proto-Familiar (chat frontend + temporal context via
[Unruh](../architecture/unruh)), and other MCP-capable clients such as SillyTavern or
OpenWebUI [@claude-md]. This matters because it is the structural expression of
[entity-as-subject](entity-as-subject): if each interface owned its own identity data, "the
Familiar" would really be several different characters that happen to share a name, and the
continuity the entity-as-subject stance depends on would not exist.

## Canonical store, consumer embodiments

Phylactery is the **canonical self-store**: identity, the relational knowledge graph, and
every memory tier live there, and it is the single place those facts are written
[@claude-md] [@phylactery-design]. Proto-Familiar is a consumer, not a source of truth — any
code path that touches identity or memory state must go through Phylactery's MCP interface,
never bypass it directly, and
thalamus is the component that enforces this boundary in Proto-Familiar's process — see
[Architecture](../architecture) [@claude-md]. The rule generalizes: "when unsure where state
belongs, default to the canonical store" [@claude-md]. This is why Proto-Familiar's own
process never keeps a second identity file or a duplicate memory store — a fact that exists
in two places invites the two copies to disagree, and disagreement between "who the Familiar
is" as seen from two embodiments is exactly what the model exists to prevent.

## The narrow exception: Unruh

[Unruh](../architecture/unruh) is described as "Proto-Familiar's own specialist" for
temporal context — schedule, interests, handoff, ponderings, threat — and it is explicitly
*not* routed through Phylactery [@claude-md]. Ponderings (the Familiar's free-cycle thoughts)
are local to Proto-Familiar specifically because they are per-embodiment: a thought the
Familiar has while idle in the Proto-Familiar interface is not necessarily something every
other embodiment needs to inherit [@claude-md]. This is the one named exception to "state
lives in the canonical store," and it is deliberate rather than an oversight — the general
rule still applies to everything Unruh does not own.

## Why Phylactery replaced entity-core

The canonical store was not always Phylactery. Proto-Familiar originally read identity and
memory from **entity-core**, a Deno/TypeScript MCP service belonging to the separate
Psycheros project [@phylactery-design]. Two facts made that arrangement outgrow itself: the
project did not own entity-core, so it could not add the per-record `audience` tagging that
village support needs (a long-lived fork would have meant a merge
treadmill against someone else's engine); and Proto-Familiar had become the sole active
embodiment, so there was no other live consumer of entity-core's data that reimplementing it
in-tree would strand [@phylactery-design]. Phylactery reimplements entity-core's proven
retrieval design — local `all-MiniLM-L6-v2` embeddings over SQLite + `sqlite-vec`, a
knowledge graph with one-hop GraphRAG traversal, tiered memory consolidation — as an
in-tree, PF-owned Python/uv service, and extends it with the `audience` tag and timestamp
fields entity-core's schema could not hold [@phylactery-design]. The Phylactery milestone
shipped as of version 0.6.x; entity-core is retired and thalamus no longer spawns it
[@claude-md]. Existing installations migrate automatically the first time the server starts,
detected and driven by `scripts/ensure-phylactery-deps.mjs` [@claude-md].

## Consequences for how this repo is built

Because Proto-Familiar is one embodiment among (currently hypothetical) others, its own code
is written to treat Phylactery's data as external and authoritative rather than as "its"
database. This shapes the [architecture](../architecture): thalamus mediates every
read from Phylactery and Unruh, cerebellum is barred from opening its own MCP connections and
must route every write through thalamus's wrappers, and the two peers degrade independently
so that neither one being down corrupts the picture the other embodiment would eventually
read back [@claude-md]. See
[Voluntary and autonomic lanes in Cerebellum](../decisions/cerebellum-consent-lanes) for a
proposed self-directed/world-directed axis explaining why this write rule and cerebellum's
separate outbound-delivery rules diverge from the same dispatcher. It also shapes memory
addressing — Phylactery memories are addressed
by an autoincrement integer `id` returned on every search/list/read result, not by a
composite key an embodiment would have to reconstruct, so any embodiment can act on a record
using only what it was just handed back [@claude-md].

The same one-continuous-thing stance shows up one level down from identity and memory, in the
ward's live chat *session* itself: [Unified Ward Sessions](../architecture/session-unification)
makes the ward's web private chat and their Discord DM resolve to one session id instead of
two independent logs. That mechanism is a plain file-backed pointer inside Proto-Familiar's own
process, not a Phylactery MCP write — it unifies conversation turn history, a narrower and
differently-owned kind of state than the identity and memory this page is about.
