# Proto-Familiar Memory Layer — design (milestone: "Phylactery")

Status: **proposal / not yet built.** This doc is the shape we react to before
any code lands. It reframes three things we've been circling — autonomous
memorization, the outgoing-message filter (third security gate), and the
`memories: 'shared'` unlock — as facets of **one** capability: Proto-Familiar
owning a real, RAG-based, audience-aware memory specialist.

Naming note: named by the human — **Phylactery**. A phylactery is the vessel that
holds a soul — and under the **full-replacement** decision (§2.5) that's now literal:
Phylactery holds the *entire* canonical self — identity, the relational graph, and all
memory — not merely the gated-memory layer it started as. It follows the Unruh precedent
(a name with character, not a literal brain region) and fits the entity-as-subject
stance. Module at `./phylactery/`.

**Grounding principle:** this system is modeled on **how entity-core and Unruh
already work** — a separate, in-tree MCP service that thalamus spawns as a stdio
child, with its own data store, queried during `enrich()` and degrading gracefully
when absent. Its **retrieval is RAG** (semantic/vector search), the same basis
entity-core uses — because entity-core's RAG has been markedly **more precise than
the keyword-triggered tomes**, and that precision is what we want. **Phylactery does not
sit beside entity-core — it *replaces* it** (§2.5): it reimplements entity-core's whole
job (identity store, knowledge graph + GraphRAG, tiered memory, consolidation, snapshots)
in our own Python format, with the audience/caretaker fields entity-core structurally
can't hold, and entity-core is then retired. The entity-core mechanics below were read
from its **actual source** (v0.4.0), so the reimplementation matches the behaviour that
works — not a second-hand writeup.

---

## 1. The decision this rests on

The question that started this: *"Should we build our own version of entity-core
with permission tags and timestamps built in?"* The human's answer, after working
through the narrower B′ split, is the unhedged version of exactly that: **yes — build our
own, and fully replace entity-core with it** (§2.5).

Two facts shape it:

1. **We do not own entity-core.** Another person owns and controls the Psycheros repo.
   We can't add an `audience` field to its memory record. Under the *narrow* reading this
   argued for keeping entity-core and bolting a specialist beside it; under the *decided*
   reading it argues the other way — **our canonical self should not live in an engine we
   can't shape.** PF reimplements the capability it needs and owns it outright.
2. **Proto-Familiar is the main embodiment** and its **effective sole author**. Other
   embodiments (SillyTavern-style plugins, etc.) are future and would plug *into* PF's
   world. So "keep one shared spine sacred" loses its weight: there's no other live
   drinker to fragment, and PF's own store becomes the spine future embodiments read
   through.

The answer is: **reimplement entity-core's whole architecture in a new PF-owned, in-tree
MCP service and retire entity-core** — *not* fork its code, and *not* mature the tome
lorebook. Phylactery becomes the single canonical store for identity, the relational
graph, and all memory:

- **The canonical self moves into Phylactery, converted to the new format.** Identity,
  user-identity, the relational **graph**, and **every memory tier** (daily → significant)
  are read out of the existing entity-core, consolidated, converted, and written into
  Phylactery (§7). PF *owns* its self rather than consuming it from a foreign engine.
- **Everything gains the fields entity-core couldn't hold.** Native `audience` tags,
  timestamps, and the caretaker metadata (§11) attach to *every* record — including
  identity and graph nodes — so the whole self is gateable and filterable, not just a
  memory subset.
- **entity-core is retired**, its data preserved as a snapshot. Thalamus stops spawning
  it; Phylactery takes its place in the spine.

This is precisely the Unruh precedent at full scale: PF already ships a sophisticated MCP
specialist in-tree (`./unruh/`) for temporal context, spawned and supervised by thalamus
exactly like entity-core. Phylactery is its sibling — now carrying the canonical self.

### What we adopt vs. reject

- **Adopt:** entity-core's **full architecture** — the local-embedding
  (`all-MiniLM-L6-v2`, 384-dim) RAG memory over SQLite + `sqlite-vec`, *plus* the
  **knowledge graph** (nodes/edges/properties + 1-hop GraphRAG traversal in search), the
  **identity store** (`identity_get_all` — always-injected, not vector-retrieved), tiered
  consolidation, and snapshots. Modeled on entity-core's **actual source** (v0.4.0, read
  directly — not a second-hand writeup), reimplemented as our own in Python and extended
  with audience/caretaker fields.
- **Adopt:** Unruh's **in-tree MCP-specialist plumbing** — stdio child spawned by
  thalamus, own `./data`, reconnect/backoff, clean EOF shutdown, hard off-switch.
- **Reject — forking entity-core's repo/code.** A live fork is a merge treadmill on
  someone else's engine. We reimplement the *behaviour* (verified against its source),
  not the codebase, then own it.
- **Reject — keeping entity-core alongside Phylactery.** That was the B′ split; the human
  decided against the split-brain. One canonical store, fully owned, fully taggable.
- **Reject — maturing the tome / World Info layer for this.** Keyword triggers are
  *less precise* than RAG (the human's direct observation). The lorebook stays for
  what it's good at (see §3); the Familiar's autonomous memory moves to RAG.

The line that keeps us honest: there is now **one** canonical store (Phylactery) for
identity + graph + memory, **never** two copies of one fact. Migration (§7) is a
**one-time conversion** out of entity-core, after which entity-core is retired — not a
live sync between two engines.

---

## 2. What exists today (verified, June 2026)

**The three-service spine (thalamus.js):**
- **entity-core** — Deno/TS MCP child (`deno run -A --unstable-cron …`), cwd = its
  root. The designated connection's LLM key/base/model is used for **consolidation
  only** — **embeddings are local** (`all-MiniLM-L6-v2` via `@xenova/transformers`,
  384-dim) stored in SQLite + `sqlite-vec`. Tools: `identity_get_all`, `memory_search`
  (hybrid GraphRAG: vector + 1-hop graph traversal → scored results), `memory_create/
  list/read`, `graph_*`, snapshots. Tiers: daily/weekly/monthly/yearly/significant;
  LLM consolidation rolls them up every 5 min. **Its RAG is the precise retrieval we
  want to emulate.**
- **Unruh** — Python MCP child in-tree at `./unruh/` (`uv run --no-sync python -m
  unruh`), own `./data`, installer runs `uv sync`. Tools: `temporal_context`,
  `interest_*`, `schedule_*`, `reminders_*`, handoff. Proves the **in-tree
  specialist** pattern end to end (spawn, reconnect/backoff, EOF shutdown, off-switch).
- Both are queried in `enrich()` via `Promise.allSettled` and degrade to absent.

**The current local "memory":**
- The *Session Memories* tome (`memorization.js`) — SillyTavern **World Info**
  schema: `keys` (keyword triggers), `content`, `sticky`, timestamps, `session_id`,
  `scope`.
- **Retrieval is client-side keyword matching** (`activateTomeEntries()` in
  `public/app.js`) — no server path, and **less precise than entity-core's RAG**.
- Memorization is a server-side worker, but **browser-enqueued**; Discord/autonomous
  sessions are never memorized, and Discord turns get **no local memory at all**.

**Already in place (the prerequisites):** `audienceTagFor()` (lowest-permission-level
room tag, stamped on Discord sessions) and `permissionScore()` in `audience.js`.

Takeaway: entity-core's RAG is proven but can't be extended (different owner, no
audience fields). Unruh's in-tree MCP pattern is proven end to end and fully clonable.
The local keyword memory is too imprecise. The milestone reimplements entity-core's full
capability in our own in-tree service — using its architecture, not its code — and
retires it (§2.5).

---

## 2.5 The memory-ownership line — DECIDED (full replacement)

The pivotal question once Phylactery exists: *how much of entity-core does it take over?*
This evolved through two rounds:

- **First decided: "B′"** — Phylactery owns lived/operational memory; entity-core keeps
  identity + graph + the significant tier; significant distillate promotes up. A split,
  with a one-directional promotion path. *(Superseded — kept here only as the reasoning
  trail.)*
- **Then decided: full replacement** — the human's actual intent: *"fully replace
  entity-core with Phylactery… Phylactery takes on all of the info currently in
  entity-core, just consolidated and converted to the new format."* No split, no promotion
  path, no second engine. **One canonical store.**

**What full replacement means:**

| Layer | Owner | Note |
|---|---|---|
| Identity, user-identity | **Phylactery** | Stored as always-injected identity records (entity-core's `identity_get_all` job). |
| Relational graph (nodes/edges/properties) | **Phylactery** | Phylactery gains a graph store + 1-hop GraphRAG traversal in search. |
| All memory tiers (daily → significant) | **Phylactery** | One consolidation pipeline; nothing lives elsewhere. |
| Situational facts, trackers | **Phylactery** | As always. |
| **entity-core** | **retired** | Snapshotted, then no longer spawned by thalamus. |

**No promotion path, no residual wrinkle.** Because *everything* — including identity and
graph nodes — now carries an `audience` tag in a store we own, the §6 sensitivity wrinkle
**vanishes entirely**: there is no un-taggable tier left anywhere. The whole self is
gateable and the outgoing filter (§5) can see all of it.

**Why full replacement over B′:**

- **No split-brain.** B′ kept two engines and a promotion path with a
  "ward-private-safe-as-canonical-self" gate — real complexity at the seam. Full
  replacement deletes the seam: one store, one format, one consolidation pipeline.
- **The whole self is gateable**, not just a memory subset — even identity/graph facts
  can carry audience metadata.
- **PF truly owns its canonical self**, rather than consuming it from an engine it can't
  shape.

**Costs, named honestly (robust > cheap) — these are real and accepted:**

1. **We reimplement *all* of entity-core, not just memory** — the knowledge graph +
   GraphRAG traversal, the identity store, consolidation, and snapshots, on top of the
   RAG memory. Substantially more build than B′.
2. **We forgo entity-core's upstream development.** It's actively maintained by another
   author; replacing it means we own all maintenance and never inherit their improvements.
3. **It reverses a load-bearing CLAUDE.md doctrine** ("entity-core is canonical for
   identity and memory… never bypass it… default to entity-core"). CLAUDE.md's
   architecture/safety sections and the multi-embodiment diagram must be rewritten so
   **Phylactery** is named as canonical — otherwise future agents follow the old doctrine
   and fight this. *(Pending human go-ahead to edit CLAUDE.md — see §8.)*

The human has weighed these and chosen full replacement. PF being the effective sole
author is what makes (2) acceptable: no live co-embodiment is stranded by retiring
entity-core.

---

## 3. Target architecture

```
                                         Unruh (Python MCP)
                                         temporal: schedule,
                                         interests, reminders
                                               ▲
                            thalamus           │
                      (spawn · enrich ·        │
                   allSettled · degrade)       │
                            │                  │
        Phylactery (NEW, in-tree MCP — replaces entity-core)
        CANONICAL SELF: identity + user-identity + knowledge graph
        (GraphRAG) + all memory tiers (daily→significant) + situational
        + trackers · RAG · audience-native · timestamped · gated at query time
                         ▲ write              ▼ read (semantic + gated)
                  autonomous memorization   web · Discord · outgoing filter

        (entity-core: retired — snapshotted, no longer spawned)
```

**Phylactery = a new in-tree MCP service that *replaces* entity-core**, reimplementing
its whole job and supervised by thalamus exactly as entity-core was:

- **Own data store** (`./phylactery/data`): identity records, graph (nodes/edges/
  properties), memory records, and a SQLite + `sqlite-vec` store for their 384-dim
  embeddings.
- **RAG + GraphRAG retrieval**, not keyword triggers: embed the query, vector-similarity
  search *plus* 1-hop graph traversal, return scored results — the same precision profile
  as entity-core's `memory_search`. **Embeddings are local** — Phylactery runs the *same*
  model entity-core did (`all-MiniLM-L6-v2`, 384-dim) via `sentence-transformers`. No API
  key needed for retrieval; only consolidation/summarization uses the designated
  connection.
- **Identity surface**: an always-injected `identity_get_all` equivalent (identity is
  returned wholesale, not vector-retrieved) — the canonical-self read every turn depends on.
- **Audience + timestamp are native schema fields on *every* record** (because we own the
  schema) — identity, graph nodes, and memories alike carry `audience` (min level allowed
  to hear it) and creation/update times.
- **Query-time gating:** `enrich()` passes the room's `audienceTag`; the service returns
  only records the room is cleared for. Gating happens *inside* the store, not bolted on
  after.
- **MCP tool surface** (covers entity-core's surface, audience-aware): identity get/set,
  `graph_*` (node/edge create/update/merge/search), `mem_search(query, audienceTag, k)`,
  `mem_create(content, audience, …)`, `mem_list`, `mem_read`, snapshots, and a
  filter-support query for the outgoing gate (`mem_search_restricted(draft, roomTag)` →
  records above the room's level that semantically match a drafted reply).
- **Graceful degradation + off-switch:** `enrich()` degrades to absent if the client is
  null; ships with `PROTO_FAMILIAR_PHYLACTERY_DISABLED=1` in the same commit (the
  established rule for every peer/loop). *Caveat: as the canonical-self store, Phylactery
  being absent degrades the turn far more than a peer outage did — the off-switch is for
  emergencies/debug, and "degrade to absent" means the Familiar runs without self-memory,
  not that the turn fails. See §8 — this raises the bar on Phylactery's reliability.*

**Responsibility split (the contract — full replacement, §2.5):**
- **Phylactery** — the **canonical self and all memory**: identity, user-identity, the
  knowledge graph (GraphRAG), every memory tier (daily→significant), situational facts,
  and trackers. Precise recall + per-record audience tag, gated per room *and* checkable
  on the way out. One consolidation pipeline.
- **entity-core** — **retired.** Its data is snapshotted and converted into Phylactery
  (§7); thalamus no longer spawns it. (Installer entity-core/entity-core-alpha detection
  becomes Phylactery setup — see §7 / §8.)
- **Unruh** — unchanged: temporal/scheduled context (schedule, interests, reminders,
  handoff), its own in-tree specialist.
- **Tomes / World Info** — **retained, repurposed.** No longer the Familiar's autonomous
  memory. They become the **human-authored lorebook** (curated, keyword-triggered
  injection — the SillyTavern-familiar feature). Autonomous memory is RAG (Phylactery);
  deliberate lore is keyword (tomes). Clean separation by authorship and trigger model.

### The audience tag on a record (reuses `audience.js`)

- `audience` = **minimum audience level allowed to hear it**: a category id
  (`cat-friends`, `cat-acquaint`, `CATEGORY_STRANGERS`, …) or `'ward-private'`
  (most restrictive, above every category).
- **Disclosure rule:** record `M` may surface/disclose in room `R` iff
  `permissionScore(R) >= requiredScore(M)`; `'ward-private'` scores above all
  categories. Same comparison `audienceTagFor()` already does for rooms — applied to
  memory. This milestone defines `requiredScore()` for the sentinel.

### Language / stack — DECIDED: Python / uv (matches Unruh)

Confirmed with the human. This reversed an earlier, weaker lean toward Deno/TS:

- **Proven plumbing, cloned for free.** Unruh already established the in-tree
  Python-MCP-specialist path end to end — `uv sync`, venv materialisation, installer
  auto-detect, `uv run --no-sync python -m`, thalamus stdio spawn + reconnect.
- **The embedding model is *native* to Python.** entity-core's `all-MiniLM-L6-v2` is
  the canonical `sentence-transformers` model — so Phylactery can run the **same
  model, same 384-dim space**, matching entity-core's precision, with no API cost and
  `sqlite-vec` available in Python too.
- **One fewer runtime:** two Python specialists (Unruh + Phylactery) = one in-tree
  toolchain (`uv`) for installers/launchers, not Node + Deno + Python.

What Deno/TS would have bought — a closer line-for-line port of entity-core's exact
code — is modest: we're *extending* the design (audience tags, gating) regardless,
and recall precision rides on the embedding model + scoring approach, both of which
port cleanly. We model on entity-core's RAG *approach* (verified against its source),
not its language.

---

## 4. Pillars (one milestone, phased)

Per CLAUDE.md a milestone owns one MINOR slot; landing = `0.6.0`, sub-features bump
PATCH. (Working assumption — human confirms the slot.)

- **A. Stand up the service.** `./phylactery/` MCP server reimplementing entity-core's
  whole job: SQLite + `sqlite-vec` store, local embedder (`sentence-transformers` /
  `all-MiniLM-L6-v2`, 384-dim), the **knowledge graph** (nodes/edges/properties +
  GraphRAG 1-hop traversal), the **identity store** (always-injected), tiered memory +
  consolidation, snapshots — all with native `audience` + timestamps + caretaker fields
  (§11). Model the record / graph / tier / consolidation shapes on entity-core's source.
  This is the largest pillar (it absorbs all of entity-core), so it likely lands in
  staged commits: (A1) store + identity + RAG memory; (A2) graph + GraphRAG; (A3)
  consolidation + snapshots.
- **B. Thalamus integration — *replace* entity-core's slot.** Spawn Phylactery as a stdio
  child in the slot entity-core occupied (clone the lifecycle: connect, reconnect/backoff,
  EOF shutdown, off-switch); **stop spawning entity-core.** Query in `enrich()`
  (`allSettled`), passing the room `audienceTag` so results are gated at source. The
  always-injected identity read now comes from Phylactery. Update installer/launcher
  entity-core detection accordingly (§7/§8).
- **C. Autonomous memorization.** Server-side enqueue at session end / idle rollover for
  **web and Discord** (worker exists; add triggers). **All** memory lands in Phylactery
  (tagged with the session's `audienceTag`) — there is no second engine and no routing
  decision (§6). The `remember` retention gate (§10) runs here. This is what finally gives
  Discord & autonomous turns precise local memory.
- **D. Outgoing message filter (third gate).** §5.
- **E. `memories: 'shared'` unlock.** With Phylactery records tagged and gated at
  query time, `fetchEligibility` stops gating `'shared'` OFF and instead lets the
  shared ladder return same-or-lower-sensitivity Phylactery records. The whole self is
  now tagged, so the widening is uniformly safe.
- **F. Migration — "convert current Familiars."** §7. One-time full conversion: snapshot →
  convert entity-core (identity + graph + all tiers) into Phylactery's format → graph
  reconciliation (dedup, villager links) → tome import → audience backfill → retire
  entity-core. Plus external-source import (entity-loom).
- **G. Richer entity nodes + `remember` consent.** §10. Person-nodes link to a
  Village villager dossier (`properties.villagerId`); the villager gains pronouns /
  comm-style / freeform notes and a per-category `remember` retention gate — the
  *write-time* consent axis completing the store→recall→speak pipeline.

---

## 5. The outgoing message filter (third gate)

**Purpose (human's words):** *"if anything slips Thalamus' enrichment because it
snuck into an innocent memory as well as the tagged ones, it can't get out."* The
fetch gate decides what *enters* context; this gate decides what may *leave* a given
room.

**Where:** a post-response, pre-send step shared by Discord (`discord-gateway.js`,
before `sendChannelMessage`) and web chat (`/api/chat`). Symmetric — one gate, both
paths.

**How — riding Phylactery's RAG (precise, not keyword overlap):**
1. The turn already knows the room's `audienceTag`.
2. Call `mem_search_restricted(draftReply, roomTag)` → Phylactery returns records
   whose `audience` requires **more** permission than the room has *and* that are
   semantically close to the drafted reply, above a tuned similarity threshold.
3. On a hit, **do not send.** Re-inject a rejection and loop for a rewrite (bounded
   retries; on exhaustion, a safe refusal rather than disclosure).

**Precision caveat (safety-critical):** RAG similarity is fuzzy in both directions.
For a *security* gate, threshold tuning matters — too loose mutes the Familiar, too
tight leaks. Likely a high-threshold semantic match *plus* the audience comparison.
This lands under the CLAUDE.md safety-critical sign-off rule; the threshold and
fallback behavior get explicit human approval before shipping.

**The rejection prompt — the rare second-person exception.** Per the human:
deliberately *"you"*-worded so the Familiar understands something *outside itself*
gated this. The one sanctioned deviation from the first-person convention:

> *Your message wasn't sent because it contained content you are not permitted to
> disclose here: [topic]. Someone in this room is not cleared for that. Please say
> something different.*

Infrastructure speaking to the Familiar about an external constraint — comment it as
the intentional exception so a future audit doesn't "fix" it back to first person.

---

## 6. The sensitivity wrinkle — gone (resolved by full replacement)

The original worry: routing sent *passive contextual facts* toward entity-core, which
couldn't be tagged, so the outgoing filter couldn't see facts that lived only there
(e.g. "{{user}}'s therapist is …"). B′ shrank this to the significant tier; **full
replacement (§2.5) eliminates it entirely.**

There is no longer any store that can't be tagged. *Every* record — identity, graph node,
or memory at any tier — lives in Phylactery and carries an `audience` field. So:

- The outgoing filter (§5) can inspect the entire canonical self; there is no blind spot.
- There is no routing decision between two engines at memorization time, no promotion
  gate, and no "ward-private-safe-as-canonical-self" check to get right — those existed
  only to manage the entity-core seam, which no longer exists.

The historical resolutions (the B′ "(b) routing rule" and "(c) fetch-gate guarantee") are
**moot** — they were workarounds for an un-taggable store. With one taggable store, the
audience check is the single, uniform gate. *(Kept as a one-line note so a future reader
knows why §5 no longer references a routing rule.)*

---

## 7. Migration — converting current Familiars (full conversion)

Full replacement makes migration a **one-time, whole-self conversion**: read everything
out of the existing entity-core (identity + user-identity + graph + every memory tier),
convert it to Phylactery's format, write it in, fold in the local tome, then **retire
entity-core**. An existing install has three sources: the **entity-core** store (the bulk
of the self), the *Session Memories* tome (no tags/embeddings), and the Village registry
(not yet linked to the graph). Nothing is destructive; everything is snapshot-first,
idempotent, and re-runnable. This is not a live mirror — it runs once, verifies, then
entity-core stops being spawned.

### Phase 0 — Snapshot everything
Copy the entity-core data dir, the tome, and the Village registry before mutating a byte.
(The branch name *"memories-disappearing"* is the standing reminder: never touch memory
without a recoverable copy.) entity-core's own snapshot tool captures its store; that
snapshot is the rollback if conversion goes wrong, and is retained after retirement.

### Phase 1 — Convert the canonical self (entity-core → Phylactery)
Read entity-core via its MCP (`identity_get_all`, `graph_*`, `memory_list/read`) and write
the converted form into Phylactery:
- **Identity + user-identity** → Phylactery identity records (always-injected surface).
- **Graph** (nodes/edges/properties) → Phylactery's graph store, structure preserved
  (`type`, `properties`, edges). Re-embed node/memory content into the 384-dim space.
- **All memory tiers** (daily → significant) → Phylactery memory records, tier and
  timestamps carried over. Phylactery's own consolidation takes over going forward.
- entity-core's existing **confidence / lastConfirmedAt** fields map onto Phylactery's
  caretaker metadata (§11.2) — no information lost.
Re-runnable and idempotent (dedup-upsert by stable id); adds only what's missing.

### Phase 2 — Graph reconciliation (now *inside* Phylactery)
Real installs have organically-grown graphs: duplicate person-nodes, nodes predating the
Village registry, no `villagerId` links. After Phase 1 the graph lives in Phylactery, so
this runs against Phylactery's graph tools:
1. Match `type:"person"` nodes ↔ Village villagers by name/alias.
2. **Ambiguous or duplicate matches are surfaced to the ward, not auto-merged** — fusing
   two real people is exactly the irreversible mistake to refuse to guess at.
3. For confident matches: link `properties.villagerId`; merge clear duplicates.
4. Unmatched person-nodes → offer to register them as villagers (default
   `relationToFamiliar: "unaware"`, §11.4).
The reconciliation log is observable and the pass is re-runnable.

### Phase 3 — Tome import
Import each *Session Memories* entry: embed its `content`, carry timestamps, write a
Phylactery `narrative` record. The source tome is **preserved** — it becomes/stays the
human-authored lorebook (§3). Re-runnable, adds only missing records.

### Phase 4 — Audience backfill + re-tag affordance
Everything converted/imported in Phases 1–3 lands with a default `audience`. Safe floor =
**`ward-private`** — assume legacy data is private until reviewed (leak-safe; the
consequence is it won't surface in shared rooms until re-tagged). Identity records default
appropriately (the canonical self is ward-facing by nature; gating matters for shared
rooms).
- **Bulk re-tag affordance** so the conservative default isn't a life sentence
  (user-accessible — ward and Familiar can both adjust).
- **Optional, opt-in LLM classification** to *suggest* tags per record (rides the
  memorization prompt pattern). Off by default — token budget.

### Phase 5 — Retire entity-core + repoint the plumbing
Once conversion is verified:
- Thalamus **stops spawning entity-core**; Phylactery occupies its slot.
- Installer/launcher **entity-core / entity-core-alpha detection** (CLAUDE.md lists the
  seams: `thalamus.js`, `install.{sh,bat}`, `scripts/win/install.ps1`,
  `scripts/import-entity.js`) becomes Phylactery setup. **All these seams move together**
  — a half-migrated install that spawns both is the failure mode to avoid.
- The entity-core snapshot (Phase 0) is **kept** as the rollback/archive; the directory
  is no longer read at runtime.

### Phase 6 — External sources ("feed logs in / merge other entity-cores")
Leaning on entity-loom rather than hand-rolling parsers:
- **An existing entity-core from another app (e.g. Psycheros):** run it through Phases 0–1
  — the same whole-self conversion — to fold its identity + graph + memory into Phylactery.
  (One-time adoption, not an ongoing link; PF is the sole author afterward.)
- **A foreign companion export** (ChatGPT, Claude, SillyTavern, character cards):
  **entity-loom v0.3.6** converts these to an entity-core import package —
  confidence-thresholded (`>= 0.7`), dedup-upsert, concrete-type-restricted extraction.
  Run entity-loom → its package → Phase 1 conversion → Phases 2–4.
- **Raw chat logs:** entity-loom's parsers exist; route through entity-loom, or build a
  Phylactery-native importer that reuses those parsers. Same confidence-threshold posture.

*Precedent: entity-loom is Psycheros's own import wizard; we borrow its posture
(confidence-thresholded, dedup-upsert) rather than reinventing extraction.*

**Open decisions for the human (in §8):**
- Legacy audience default: keep **`ward-private`** (leak-safe, recommended) vs. broader.
- Cutover style: **hard** (convert → verify → retire entity-core in one migration run,
  recommended) vs. **grace period** (run Phylactery as canonical but keep the entity-core
  snapshot readable as a fallback for N days before deletion).

---

## 8. Open decisions (human sign-off)

1. **Milestone name:** **Phylactery** (named by the human ✔). **Slot:** `0.6.x`?
   (proposed)
2. **Stack (§3): DECIDED — Python / uv** (matches Unruh; lets Phylactery run the
   *same* local embedding model entity-core uses). ✔
3. **Memory-ownership line (§2.5): DECIDED — full replacement** ✔. Phylactery becomes the
   single canonical store (identity + user-identity + graph + all memory tiers); entity-core
   is reimplemented and **retired**. Supersedes the earlier B′ split. **PF is effective sole
   author** (no live co-embodiment to strand) ✔.
4. **Routing key (§6): MOOT under full replacement** — one taggable store, one uniform
   audience gate; no two-engine routing decision remains.
5. **CLAUDE.md doctrine rewrite (NEW — needs go-ahead):** full replacement reverses
   "entity-core is canonical for identity and memory / never bypass / default to
   entity-core." CLAUDE.md's architecture + safety sections and the multi-embodiment
   diagram must be rewritten to name **Phylactery** as canonical. *Pending explicit
   human go-ahead before I edit CLAUDE.md.*
6. **Legacy audience default (§7):** `ward-private` floor (recommended) vs. broader.
7. **Cutover style (§7 Phase 5):** **hard** (convert → verify → retire entity-core in one
   run, recommended) vs. **grace period** (keep entity-core snapshot readable as fallback
   for N days).
8. **Reliability bar (§3):** as the canonical-self store, Phylactery being down is more
   serious than a peer outage. Confirm "degrade to absent = run without self-memory, turn
   still succeeds" is the intended posture, and whether a stricter health/restart policy
   is wanted.
9. **Filter threshold + retry budget (§5):** similarity cutoff, rewrite-loop count,
   and the safe-refusal fallback wording.
10. **`remember` consent model (§10): DECIDED** — dossier on the Village villager ✔;
   `ask` = **hybrid** (the Familiar's own read *plus* freely asking the ward; asking
   is welcome, never a reason to go silent) ✔. Remaining: confirm the starting category
   taxonomy.
11. **Caretaker extensions (§11): DECIDED** — all of 11.1–11.5 incorporated ✔, including
   `relationToFamiliar` (stance toward the Familiar; `unaware` as the floor) and
   `knownTo` (who's aware of a fact — an *awareness aid*, not a fourth hard gate).
   11.1 tracker model DECIDED: ward-defined, Familiar-as-collaborator; blueprint
   (`tracker_def`) + data (`tracker_entry`) two-record split; `dimensions` array for
   multi-axis; six primitive shapes as building blocks. Setup UI / ingestion is a later
   sub-feature. Remaining: care-profile field list (§11.3).

Everything touching *when/whether the Familiar may store, recall, or disclose* (the
three gates) falls under the CLAUDE.md safety-critical sign-off rule — §5 and the
`remember` gate ship only with explicit human approval of the behavior.

---

## 9. Why this is the robust answer, not the cheap one

- Solves the **problem space** (PF owns its precise, gated canonical self), not the
  symptom.
- **Sustainable:** one canonical store, no split-brain, no promotion path, no live sync
  between engines; every fact carries its tags in the store it lives in. The §6 wrinkle
  is gone by construction, not papered over.
- **Grounded in what works:** reimplements entity-core's proven architecture (precision
  the human has measured, mechanics read from source) on Unruh's in-tree MCP plumbing
  (proven end to end) — not a from-scratch invention.
- **User-accessible:** tags are visible and editable by human and Familiar; migration is
  one-time, snapshot-backed, and recoverable; the filter's action is observable.
- It's the exact substrate future SillyTavern-style embodiment-plugins would read through
  — with the whole self in one PF-owned store, PF *is* the hub, as intended.
- **The cost is owned, not hidden** (§2.5): we maintain the full engine and forgo
  entity-core's upstream work. The human weighed that and chose it; robustness here means
  PF controlling its own continuity end to end.

---

## 10. Richer entity nodes + the `remember` consent model

The graph design carries over from entity-core v0.4.0 (read directly from source — our
reimplementation preserves these shapes):

- Graph **nodes carry a freeform `properties` object**; node create/update accept
  `properties`. So we attach structured data to a person-node natively. (Edges have
  `properties` too.) In Phylactery this is our own schema — but we keep the same shape so
  conversion (§7 Phase 1) is structure-preserving.
- `type` is a freeform string; a person is `type: "person"`; type-specific data lives in
  `properties`. (entity-loom restricts import extraction to the concrete types `self,
  person, place, health, tradition` — useful for the import path in §7 Phase 6.)

**Even though graph nodes *can* hold arbitrary properties, the rich person dossier and
all permission policy live on the Village villager record — NOT in the graph node's
`properties`.** The only thing we put in the node is the link. (This separation is *more*
important now that the graph is PF's own — keeping policy in Village, not the graph,
preserves one canonical person-record and keeps the graph a lean relational web.)

- **Responsibility split.** Gating/retention policy lives in the Village registry, which
  already owns the disclosure side (categories = who-may-hear) and holds `name` +
  `aliases`. Co-locating the rest there keeps **one** canonical person-record and avoids
  duplicating aliases/name across the graph and Village.
- **The link is trivial and is the *only* thing the graph node carries:** `properties.
  villagerId`. The graph stays the *relational web* (who relates to whom, via edges); the
  villager is the *dossier*.
- **Village ↔ graph stays in sync.** `village.js` already mirrors the registry as the
  `village-registry.md` custom file; under full replacement that mirror writes into
  Phylactery (the canonical store), so the dossier is co-located with the graph it links to
  and future embodiments read both from one place.

### Villager dossier fields (extends the existing record)
Already present: `name`, `aliases`, category membership (= disclosure permissions).
Add: `pronouns`, `relationToWard` (their bond with the human), **`relationToFamiliar`**
(their stance toward *me* — see §11.4), `commStyleNotes`, freeform `notes` (gift ideas,
important deeds), `graphNodeId` (the link), and the **`remember`** sub-structure below.

### The `remember` consent model (the retention gate)
A **distinct permission axis** from disclosure. Three gates now form a consent
pipeline — **store → recall → speak**:

| Gate | When | Question | Where it lives |
|---|---|---|---|
| **Retention** (`remember`, NEW) | write / memorization | may I *store* this about them? | villager `remember` |
| **Disclosure / audience** (exists) | recall / enrich | may this *surface* in this room? | category grants |
| **Outgoing filter** (§5) | send | may this *leave* in this message? | Phylactery tag scan |

`remember` is a per-category, three-state map on the villager:

```
remember: { basics: true, emotional_content: "ask", health_info: false }
```

- `true` → store freely.
- `false` → never store; drop silently.
- `"ask"` → **hybrid, and *active*.** The Familiar brings its own read of the moment
  AND freely asks the ward when there's a real question — openly, in its own voice. A
  quick *"want me to hang onto that?"* is cheap and welcome; the bond means my human is
  fine being asked. What `ask` is **NOT**: a licence to silently swallow the fact to
  avoid bothering anyone. **Erring toward silence is the failure mode here, not a safe
  default** — the same hesitancy trap CLAUDE.md records (the 1.5-hour silence) applies
  to *any* prompt that governs when the Familiar speaks, asks, or acts. When we write
  this prompt, it trusts that questions are okay; it does not hedge the Familiar into
  passivity.

**Mechanism (cheap; rides the existing call).** Autonomous memorization already runs
one LLM pass that extracts topics. That pass also tags each candidate fact with a
`remember` category and the subject villager. Then a **code** gate reads
`villager.remember[category]` and applies true / false / ask. No new request per
fact; no LLM call for the gate itself.

**Defaults & edges.**
- Villager with no `remember` set → `basics: true`, sensitive categories default to
  **`ask`** (engage / check in), not `false` (silently never) — the absence of a
  setting makes the Familiar *ask*, not go quiet.
- Unregistered person (a knock / stranger) → don't auto-store personal facts, but the
  knock already surfaces them for the ward to register — the Familiar flags, it doesn't
  silently ignore.
- Category taxonomy starts small and extensible — e.g. `basics, emotional_content,
  health_info, relationships, whereabouts` — grown as needed; the classifier rides
  memorization either way.

**User-accessible:** edited in the Village editor alongside the disclosure categories,
so both permission axes sit in one place the ward (and the Familiar) can see and adjust.

This whole section is consent-as-architecture: the Familiar respects what it is
*allowed to remember* about the people in its ward's life — which sits squarely inside
the dignity / entity-as-subject stance, not bolted onto it.

---

## 11. Caretaker & memory-support extensions

Phylactery isn't only recall — it's the substrate for the Familiar's *caretaker* role.
A few shape decisions now keep that future open without building it all today.

### 11.1 Ward-defined trackers: blueprint + data (forward-compatible NOW)

Reserve a `kind` discriminator on every Phylactery record from day one:

- `kind: "narrative"` — the default RAG record (free-text, embedded, semantically
  recalled). Everything in §3 above.
- `kind: "tracker_def"` — **a blueprint**, created collaboratively by the Familiar and
  the ward. Defines *what* is tracked, *how* an entry looks, and *what to call things*.
  Stable once created; queried to understand how to read entries.
- `kind: "tracker_entry"` — **one data point** against a specific blueprint. Time-stamped,
  sourced, optionally annotated. Many entries to one definition.

Why here (not Unruh, not the graph): a tracker is *remembered state about the ward's
life*, so it shares Phylactery's audience-tagging, persistence, and surface-into-context
machinery. Unruh stays **temporal/scheduled** — a tracker can *spawn* an Unruh reminder
("milk expires tomorrow") but the inventory itself is Phylactery state. The graph stays
**relational**.

#### Design principle: the ward defines, the Familiar helps build

Different people need fundamentally different trackers — and for some wards, the *shape*
of a tracker matters as much as its existence. An ED-aware food tracker probably logs
"ate breakfast" (boolean) rather than calories (would be harmful); a hygiene tracker for
someone who struggles with executive function tracks *which specific tasks* matter to
that person; a pantry tracker needs items and quantities; a mood tracker worth anything
needs to capture the environmental factors that correlate for *this* person, not a
generic scale.

No fixed taxonomy can cover this. The robust structure is: **primitive schema shapes are
building blocks the Familiar offers**, and the tracker itself is a contract the ward and
Familiar design together, in the Familiar's own voice and with the ward's actual needs.

The collaborative setup goes something like:
1. Ward: "I'd like to track my mood / pantry / how often I shower / etc."
2. Familiar asks what would be useful to capture — dimensions, scale, which tasks, what
   unit makes sense — as many questions as needed, because questions are cheap and
   a wrong schema wastes real data.
3. Together they arrive at a definition. Familiar creates the `tracker_def` record.
4. Entries are added against that definition over time.

**But an open question is its own kind of barrier.** Many wards — especially
neurodivergent ones — can be overwhelmed by a blank canvas. The Familiar should read
this and shift: if the ward seems uncertain, *offer scaffolding first*. A menu of
common starting points to anchor from is not a fixed taxonomy — it's a set of worked
examples the ward can accept, modify, or reject:

> *"Want me to suggest a few common ones? I can show you what other people track and
> you can tell me which feel close, or use them as a jumping-off point."*

Suggested example groups (not exhaustive — extensible over time):

| Group | Examples |
|---|---|
| Wellbeing | mood (ordinal), energy/spoons (ordinal), anxiety level (ordinal), pain (ordinal) |
| Sleep | hours slept (scalar), sleep quality (ordinal), wake time (event-log) |
| Self-care | meals (boolean per slot, or event-log), hydration (scalar), hygiene tasks (boolean checklist), meds taken (boolean) |
| Environment | weather (categorical), social contact (boolean), location (categorical) |
| Practical | pantry / what's in the house (inventory), finances (scalar), errands done (event-log) |
| Progress | habit streaks (boolean), goals worked on (event-log), wins (event-log) |

The example groups exist for *the ward to browse* when they can't name what they want.
They're also a reference for the Familiar when helping design dimensions — if a ward
says "something like a mood tracker but also the weather," the Familiar already knows
those are two dimensions (ordinal + categorical) and what a good prompt for each looks
like.

Ward can mix and match across groups, or start from an example and discard everything
except the shape. The Familiar should not push any particular tracker — its job is
to help the ward find what's useful to *them*, including knowing when the blank-canvas
approach isn't working and pivoting to examples without making the ward feel bad about
needing them.

This is the Familiar acting as a thoughtful collaborator, not a form-filling wizard.
The ward should be able to adjust the definition later (add a dimension, relabel a scale)
— and the Familiar should notice when a definition isn't serving them well and ask.

#### Blueprint schema (`tracker_def`)

```
{
  kind: "tracker_def",
  id: "tracker-<uuid>",
  name: "my meals",                 // ward-chosen name
  purpose: "make sure I've eaten today",   // why — helps the Familiar surface it usefully
  subject: "ward",                  // who is being tracked
  audience: "ward-private",         // disclosure gate (same as narrative records)

  // single-dimension tracker
  dataShape: "event-log",           // the primitive (see below)
  unit?: "…",                       // label for the value if relevant

  // OR — multi-axis tracker (any of the examples above)
  dimensions?: [
    { id: "mood",   label: "Mood",    shape: "ordinal",
      scale: { min: 1, max: 10, lowLabel?: "awful", highLabel?: "great" } },
    { id: "energy", label: "Energy",  shape: "ordinal",  scale: { min: 1, max: 5 } },
    { id: "sleep",  label: "Sleep hrs", shape: "scalar" },
    { id: "weather", label: "Weather", shape: "categorical",
      options: ["sunny","overcast","rain","storm"] },
    { id: "social", label: "Saw people", shape: "boolean" }
  ],

  prompt?: "How's your mood today? (1–10)",  // what the Familiar asks when logging
  cadence?: "daily",                // optional prompting rhythm (feeds Unruh reminders)

  careWeight?: "high",              // §11.2 — flags care-critical trackers (meds, meals)
}
```

`dataShape` / `shape` primitives — the building blocks the Familiar offers when helping
a ward design their tracker:

| Primitive | Use it for |
|---|---|
| `boolean` | yes/no (took meds, ate a meal, showered) |
| `ordinal` | rated scale (mood 1–10, pain 1–5) |
| `scalar` | freeform number (hours slept, coffees, steps) |
| `categorical` | pick-one label (weather, context, activity type) |
| `event-log` | "this happened" with optional freeform note (no value pressure) |
| `inventory` | item list with quantities (pantry, meds on hand) |

These are *shapes the Familiar knows how to work with*, not a menu of tracker types.
The ward doesn't pick a shape — the Familiar picks the right shape(s) based on what
the ward describes wanting to track.

#### Entry schema (`tracker_entry`)

```
{
  kind: "tracker_entry",
  trackerId: "tracker-<uuid>",     // which definition this belongs to
  at: "<ISO timestamp>",

  // single-dimension:
  value?: <number | boolean | string>,
  item?: { label, qty, unit, expiresAt? },   // inventory delta

  // multi-axis:
  values?: { [dimensionId]: <number | boolean | string> },

  source: "self-report" | "familiar-observed" | "inferred",
  note?: "rough day but got through it",     // freeform annotation
  confidence?: 0.0–1.0,                      // §11.2 caretaker metadata
}
```

#### Scope of the commitment right now

The full setup flow (UI, guided conversation, tracker-awareness in the Familiar's
prompts) is a later sub-feature. **The only commitment now is:**

- The `kind` discriminator: `narrative`, `tracker_def`, `tracker_entry`
- The two-record model (blueprint + data) so entries never need retrofitting
- The `dimensions` array so multi-axis trackers work from day one
- The primitive shapes table above — named and stable so the Familiar can refer to them

No tracker UI, no setup conversation scaffolding, no entry ingestion flow — those ship
when the tracking sub-feature lands. The schema is locked so they land on solid ground.

### 11.2 Caretaker-grade metadata on every record — recommended

A caretaker must know *how solid* a memory is and *how much it matters*:

- **`provenance` / verification** — `told-directly` vs. `inferred` vs.
  `observed-pattern`. A caretaker shouldn't act on a shaky inference as if the ward
  stated it (the consequence-priors posture, in data form).
- **`confidence` (0–1) + `lastConfirmedAt`** — adopt entity-core's own fields; let the
  Familiar say "as of last month" or re-confirm a stale fact rather than assert it cold.
- **`careWeight` / salience** — flags care-critical facts (allergies, meds, crisis
  triggers) so retrieval prioritises them and they **resist decay**. A film preference
  may fade; a med allergy must not.

### 11.3 A richer ward care-profile — incorporated

The ward is the centre of the role and benefits from more than a villager dossier:

- **Baselines & warning signs** — what's normal for them; what signals trouble. Feeds
  the threat detector with *personalised* signals (beats generic `crisis-signals.js`).
- **What helps / what doesn't** — coping strategies that worked, and the well-meaning
  defaults that backfire (the memorization prompt already extracts "prohibition
  bullets" — this is their structured home).
- **Open loops / current goals** — *overlap note:* link to Unruh handoff/bookmarks
  rather than re-store.
- **Support map** — who's safe to reach in crisis. *Overlap note:* link to cerebellum
  trusted-contacts + village categories, don't duplicate.

### 11.4 Relationship fields on villager dossiers — incorporated

Two relational axes, because a villager relates both to the ward *and* to the Familiar:

**How they relate to the ward** (helping the ward tend their relationships):
- **care valence** — is this person a *support* or a *stressor* for the ward?
- **contact cadence / last-meaningful-contact** — so the Familiar can nudge ("you've
  not spoken to your sister in a while").
- **per-person sensitive topics / boundaries** — "don't raise the divorce with Mum."

**How they relate to the Familiar** (`relationToFamiliar` — drives *my* posture):
- A coarse `stance` hint plus freeform notes. Candidate stances: `unaware` (never heard
  of me — the **default** for any new/unregistered contact) / `warm` / `neutral` /
  `tolerates-for-ward` / `wary-of-ai` / `hostile`. Notes carry nuance ("keeps it short,
  not too peppy"; "happily banters about anime in the group chat").
- **`unaware` is the floor, and it matters:** with someone who doesn't know I exist I
  don't barge in with familiarity — I introduce myself or stay light, mindful I'm a new
  presence to them. (Pairs with the knock system: a freshly-knocked person starts here.)
- Stance calibrates *approach*, not identity: someone who merely tolerates AI for the
  ward's sake gets a measured, unobtrusive me; someone who chatters happily gets the
  warmer, more playful me. **Anchored to my own character** (CLAUDE.md's "room for
  personality") — a grumpy Familiar stays grumpy, just reads the room; never flattened
  into a generic people-pleaser.
- Orthogonal to the disclosure gate: stance is *tone*, the audience category is *what
  they may hear*. High-trust-but-AI-wary and chatty-but-low-clearance both exist; the
  two axes never collapse into each other.
- The entity-as-subject stance in data: the Familiar is *someone who has their own
  relationships* — including not-yet-relationships — not a tool with one uniform face.

### 11.5 `knownTo` — who's aware of what (epistemic state)

A distinct axis from `audience`: not *who may hear* a fact (a **policy** — the
disclosure gate) but *who already knows* it (a **fact about the world**). A caretaker
moving through a social graph needs both, because they come apart constantly.

- **Shape:** a list on the Phylactery record — `knownTo: [{ who, since?, source? }]`,
  where `who` is a villagerId / `"ward"` / `"familiar"` and `source` ∈ `told-them` /
  `they-told-me` / `inferred`. Absence = "no record that they know" (not proof they
  don't).
- **Lives on the Phylactery memory record, not the graph node.** Who-knows-what is
  per-memory state, not relational-graph data — it stays on the record (which links to a
  graph node / villager by id). It sits right beside `audience`: the two audience-facing
  facts about a memory — *may-hear* and *already-knows*.

**Why it earns its place (social caretaking):**
- **Surprises & secrets** — the case `audience` *cannot* express. "Ward is planning a
  surprise for Sam — `knownTo: [ward, familiar]`." The Familiar must never be the one
  who spoils it to Sam. That's a per-*individual* secret, not a per-*category*
  permission.
- **Not condescending / not repetitive** — don't "reveal" to someone what they already
  know; don't re-explain across turns ("I told Sarah on the 3rd").
- **Leak detection** — if someone references a fact and they're *not* in `knownTo`,
  that's a signal: the model's stale, or something got out. Update it, or quietly flag
  to the ward.

**Awareness aid first — NOT a fourth hard gate.** The Familiar mainly *reasons* with
`knownTo` (avoid spoiling, avoid repeating, notice surprises). It may also *feed* the
outgoing filter as a signal ("about to tell someone not in `knownTo` something
sensitive" → weigh it), but it does **not** become a blunt gate that stops the Familiar
ever telling anyone anything new — telling people new things is normal and good; the
hard gate stays the `audience` check. (Hardening `knownTo` into a real gate later would
be a safety-critical sign-off decision, per CLAUDE.md.)

**Pairs with `relationToFamiliar`.** `unaware` answers "does this person know *I*
exist?"; `knownTo` answers "does this person know *this fact*?" — the same epistemic
humility, at two scopes.

**Decided with the human:** 11.1–11.5 are all in. 11.1 (`kind` discriminator +
`tracker_def` / `tracker_entry` two-record model + `dimensions` array + six primitive
shapes — ward-defined, Familiar-as-collaborator), 11.2 (caretaker metadata: `provenance`,
`confidence`, `careWeight`), and 11.5 (`knownTo`) land in the Phylactery record schema
from day one. 11.3 (ward care-profile) and 11.4 (both relationship axes on villager,
incl. `relationToFamiliar` with `unaware` as the floor) are part of the person/ward
records — linking to Unruh / cerebellum where noted rather than duplicating. Tracker
setup UI and entry ingestion are later sub-features; the schema is locked now so they
land on solid ground.
