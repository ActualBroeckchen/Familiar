# Phylactery — build spec

You are building **Phylactery**: an in-tree Python/`uv` MCP service that becomes
Proto-Familiar's single canonical store for its whole self — identity, ward-identity, the
relational graph, and every memory tier — replacing the external `entity-core` service.

This document is your build instruction. It is the **what and the in-what-order**. For the
**why** behind any decision, read [`docs/phylactery-design.md`](phylactery-design.md) — it is
the authoritative rationale and the source this spec compresses. Where this spec and the design
doc agree, build it. Where you think they disagree, the design doc wins and you flag it.

---

## 0. Before you write a line

Read these first. They are not optional context — they are constraints you build inside of.

1. **`CLAUDE.md`** in the repo root. Every rule there binds you. The ones you will violate by
   accident if you don't internalise them:
   - **First-person convention (non-negotiable).** Every prompt, tool description, system
     message, and behaviour-describing comment the Familiar reads is written *in first person,
     from the entity's own perspective* ("I use this to let go of something my human asked me to
     forget"), never second person ("You are the Familiar…"). The **only** sanctioned exception
     in this milestone is the outgoing-filter rejection message (§ Pillar D) — comment it as the
     intentional exception.
   - **"My human" / `{{user}}`, never "the user."**
   - **Graceful degradation is a rule.** No module may take down the chat path. Phylactery being
     absent degrades to *running without self-memory*, never to a failed turn.
   - **Every background loop ships its hard off-switch (`PROTO_FAMILIAR_*_DISABLED=1`) in the
     same commit.** No "add the switch later."
   - **Robust > cheap.** Do not lead with the cheapest fix. Solve the problem space.
   - **Ride existing LLM calls; gate in code.** Do not add an LLM request where a code gate or an
     existing call will do.
   - **Reachability.** Every capability you give the Familiar must be discoverable BY it (it
     knows it has the power) and operable BY it (it can obtain every argument the tool needs),
     both in the same commit as the tool.
   - **Versioning.** `package.json` `version` is the single source of truth; bump it in the same
     commit. This milestone owns ONE minor slot (proposed `0.6.0`, confirm — § Open knobs):
     the milestone landing is `0.6.0`; every sub-feature/pillar inside it bumps PATCH.
   - **Safety-critical code needs human sign-off** (see § Safety gates below).
   - **Update `docs/architecture.md` in the same commit** as any architectural change.

2. **`docs/phylactery-design.md`** — full rationale, every decision's reasoning, the costs named.

3. **entity-core's actual source (v0.4.0).** You are reimplementing its *behaviour*, not forking
   its code. Read its record/graph/tier/consolidation shapes so recall precision is preserved.

4. **`./unruh/`** — your template for the in-tree Python-MCP-specialist pattern: `uv sync`,
   `uv run --no-sync python -m`, thalamus stdio spawn + reconnect/backoff + EOF shutdown +
   off-switch. Clone this plumbing; don't reinvent it.

---

## 1. The shape you're building

```
        Phylactery (in-tree Python MCP — occupies entity-core's slot)
        ./phylactery/  ·  ./phylactery/data/
        CANONICAL SELF: identity + ward-identity + knowledge graph (GraphRAG)
        + all memory tiers (daily→significant) + situational + trackers
        RAG · audience-native · timestamped · gated at query time
```

Hard requirements for the service itself:

- **Storage:** SQLite + `sqlite-vec`. One file. Embeddings local: `sentence-transformers` /
  `all-MiniLM-L6-v2`, **384-dim** — the same model and vector space entity-core used, so
  migrated vectors copy over without re-embedding. No API key for retrieval.
- **Retrieval:** RAG + GraphRAG. Embed query → vector similarity **plus** 1-hop graph traversal
  → scored results. Match entity-core's precision profile.
- **Identity surface:** always-injected (returned wholesale, not vector-retrieved) — the
  canonical-self read every turn depends on.
- **`audience` + timestamps are native fields on EVERY record** (identity, graph nodes,
  memories). No un-taggable record anywhere — the outgoing filter (Pillar D) depends on this
  being total.
- **Query-time gating inside the store:** `enrich()` passes the room's `audienceTag`; the
  service returns only records the room is cleared for. Gate at source, not after.
- **Consolidation LLM:** only the maintenance side (consolidation/summarization) uses an LLM —
  the **designated connection**, passed at spawn exactly as entity-core's was.
- **Degradation + off-switch:** degrade to absent if the client is null; ship
  `PROTO_FAMILIAR_PHYLACTERY_DISABLED=1` in the same commit. Plus auto-restart-with-backoff on
  the spawn (it's the canonical store — absence should be brief, never silent).

---

## 2. Build order (dependency-sorted)

```
A → B → G → (C, F) → (D, E) → H → I
```

`A` is the only hard prerequisite for everything else and can start now. Each pillar ships its
off-switch in the same commit. The "decided" schemas in §3 below are locked — build to them.

### Pillar A — Stand up the service
The largest pillar (absorbs all of entity-core). Stage it:
- **A1:** SQLite + `sqlite-vec` store, local embedder, identity store (always-injected), RAG
  memory + tiered records, native `audience`/timestamp/caretaker fields (§3 schemas).
- **A2:** knowledge graph (nodes/edges/properties) + GraphRAG 1-hop traversal. **Include a
  full-graph dump** (every node + deduplicated edges) — Pillar I's Map view needs it.
- **A3:** consolidation (daily→…→significant via the designated connection) + snapshots.
- **Preserve the auto-snapshot-before-destructive invariant**: snapshot before every destructive
  op (memory/identity/graph update+delete). It is the code-level "memories-disappearing" rule and
  the recoverable floor under the deletion paths.
**Done when:** the service stands alone, stores/recalls/gates tagged records, holds a graph with
GraphRAG recall, consolidates tiers, and snapshots — verified against entity-core's behaviour.

### Pillar B — Thalamus integration (replace entity-core's slot)
Spawn Phylactery as the stdio child in entity-core's slot (clone Unruh/entity-core lifecycle:
connect, reconnect/backoff, EOF shutdown, off-switch). **Stop spawning entity-core.** Query in
`enrich()` via `Promise.allSettled`, passing the room `audienceTag`. The always-injected identity
read now comes from Phylactery. Update installer/launcher entity-core detection (§ Phase-5 seams).
**Done when:** thalamus drives Phylactery, entity-core is no longer spawned, the chat path
enriches from Phylactery, and a Phylactery-down turn still succeeds (degraded).

### Pillar G — Richer entity nodes + `remember` consent
Person-nodes link to a Village villager dossier via `properties.villagerId` only (the *only*
thing the node carries; policy lives on the Village record, not the graph). Villager gains:
`pronouns`, `relationToWard`, `relationToFamiliar` (§3), `commStyleNotes`, freeform `notes`,
`graphNodeId`, and the **`remember`** retention map (§3). Land G before C: C's memorization runs
the `remember` gate.
**Done when:** villager dossiers carry the new fields, the `remember` map exists and is editable,
and the graph node carries only the villager link.

### Pillar C — Autonomous memorization
Move the memorization worker fully server-side; enqueue at session end / idle rollover for
**web AND Discord** (worker exists; add triggers). All memory lands in Phylactery, tagged with
the session's `audienceTag`. The single existing extraction pass also stamps each candidate's
`audience`, `remember` category + subject villager, and caretaker metadata — **no new per-turn
request**. The `remember` retention gate (§3) runs here, as a code gate after the extraction.
Off-switch `PROTO_FAMILIAR_MEMORIZE_DISABLED=1`.
**Done when:** web and Discord turns both memorize server-side into Phylactery, the extraction
honours the per-fact granularity contract (§3), and the `remember` gate applies true/false/ask.

### Pillar F — Migration (convert current Familiars)
One-time, snapshot-first, idempotent, re-runnable whole-self conversion. Phases:
- **0 Snapshot** everything (entity-core data dir, tome, Village registry) before mutating a byte.
- **1 Convert** entity-core → Phylactery: read its SQLite directly (no Deno needed; spawn its MCP
  once only as drift fallback). Identity + ward-identity → identity records; **rename
  `user` → `ward` here** (the one-time point); graph → graph; all tiers → memory records;
  **copy 384-dim vectors as-is** (re-embed only the vector-less); map confidence/lastConfirmedAt
  onto caretaker metadata. Create empty `me`/`ward` graduation categories.
- **2 Graph reconciliation** inside Phylactery: match person-nodes ↔ villagers; **surface
  ambiguous/duplicate matches to the ward — never auto-merge people**; link confident matches;
  offer to register unmatched (default `relationToFamiliar: "unaware"`).
- **3 Tome import:** embed each Session-Memories entry → `narrative` record; **preserve** the
  source tome (it becomes the human-authored lorebook).
- **4 Audience backfill:** default floor **`ward-private`** (leak-safe). Bulk re-tag affordance;
  optional opt-in LLM tag suggestion (off by default).
- **5 Retire entity-core + repoint plumbing** — see § Phase-5 seams (this is wide; do not miss
  one).
- **6 Foreign import** (entity-loom / chat logs) — later/optional, off the critical path.
**Done when:** an existing Familiar converts cleanly, verifies, and runs on Phylactery with
entity-core no longer spawned and its snapshot retained as rollback.

### Pillar D — Outgoing message filter (third gate) ⚠️ safety sign-off
Post-response, pre-send step shared by Discord (`discord-gateway.js`, before
`sendChannelMessage`) and web chat (`/api/chat`). One gate, both paths.
1. Turn knows the room's `audienceTag`.
2. `mem_search_restricted(draftReply, roomTag)` → records whose `audience` requires MORE
   permission than the room has AND that semantically match the draft above a tuned threshold.
3. On a hit: do not send; re-inject a rejection, loop for a rewrite (bounded retries; on
   exhaustion, safe refusal, never disclosure).
**Threshold, retry budget, and refusal wording need explicit human sign-off before shipping.**
The rejection prompt is the **sanctioned second-person exception** — comment it as such:
> *Your message wasn't sent because it contained content you are not permitted to disclose here:
> [topic]. Someone in this room is not cleared for that. Please say something different.*

### Pillar E — `memories: 'shared'` unlock
With every record tagged and gated at query time, stop gating `'shared'` OFF in
`fetchEligibility`; let the shared ladder return same-or-lower-sensitivity records. Safe because
the whole self is tagged.

### Pillar H — Lifecycle & backup
- Server-side memorization triggers (web + Discord) — overlaps C.
- Phylactery's **own internal consolidation scheduler** (Python/asyncio, mirroring entity-core's
  5-min cron) — self-paced and volume-gated, not a fixed beat. Off-switch
  `PROTO_FAMILIAR_CONSOLIDATE_DISABLED=1`.
- Cheap-code hygiene: dedup by stable id, merge identical-name+villagerId nodes, **decay**
  (low-`careWeight`, old, never-recalled records fade) — with merge+contradiction detection
  *folded into the consolidation pass*, not a new loop. Ambiguous merges surface to the ward.
- **Identity & ward hygiene audit** (Familiar-led, ward-consulted; rides consolidation) —
  graduates no-longer-front-of-mind detail from the always-injected `identity`/`ward` blocks into
  the `me`/`ward` categories. ⚠️ **The graduation-eligibility rule needs human sign-off** (it
  changes whether the Familiar can act on a fact). Care-critical (`careWeight: high`) is pinned
  and never graduates.
- Single-file export/restore: `VACUUM INTO` a `.sqlite` file; user-accessible "back up / restore
  my Familiar" surface.
Each background piece ships its off-switch in the same commit.

### Pillar I — Knowledge-manager repoint + new-field surfacing
Repoint the existing Knowledge editor (`/api/entity/*` HTTP routes + thalamus helpers + the
front-end modal / graph List↔Map view) from entity-core to Phylactery. The HTTP surface and
front-end stay structurally; only the data layer underneath moves. **This pillar is where the
new fields become user-accessible** — audience re-tagging (Phase 4 bulk), the `remember` consent
map, `careWeight`, and the deletion/purge paths. Without it the doc's "user-accessible" promises
have no surface. Carries the prompt-inspector relabel and the doc-migration checklist (§ Phase-5
seams).

---

## 3. Locked schemas — build to these exactly

These are decided. The cited design-doc section is authoritative if you need detail.

### The record (`narrative` is the common case)
| Field | On | Meaning |
|---|---|---|
| `id` | all | stable id; **rides in on every recall/search result** (reachability) |
| `kind` | all | `narrative` \| `tracker_def` \| `tracker_entry` |
| `register` | narrative | episodic (default) \| `me` \| `ward` — graduation axis, **separate from granularity** |
| `granularity` | episodic narrative | `daily…significant` — rollup tier (`VALID_MEMORY_GRANULARITIES` unchanged) |
| `content` | narrative | embedded free text |
| `audience` | all | min level allowed to hear it (`ward-private` or category id) — disclosure gate |
| `subjects` | narrative | villagerId(s) the fact is about — drives `mem_purge_by_villager` + conditional surfacing |
| `createdAt`/`updatedAt` | all | timestamps |
| `careWeight` | all | `high` (floor + pin) \| `low` \| unset — salience; gates decay AND graduation |
| `confidence` | all | 0–1 |
| `provenance` | narrative | `told-directly` \| `inferred` \| `observed-pattern` |
| `lastConfirmedAt` | narrative | recency-of-confirmation |
| `source` | all | `{ author, via, at, originalId? }` — authorship/provenance; observability, not a gate |
| `knownTo` | narrative | `[{ who, since?, source? }]` — who already knows (epistemic, not policy) |
| *embedding* | narrative | 384-dim `all-MiniLM-L6-v2` (local) |
| composite key | significant narrative | `YYYY-MM-DD_slug` — **preserved as-is** |

`source`:
```
source: {
  author: "proto-familiar" | "migration:entity-core" | "import:entity-loom" | "<embodiment-id>",
  via:    "memorization" | "consolidation" | "manual" | "import" | "migration",
  at:     "<ISO timestamp>",
  originalId?: "<ec-id>",
}
```

### `careWeight` mechanism (§8.2) — two distinct protections
- **Decay shield:** `"high"` records never score below `CARE_WEIGHT_FLOOR` (tunable, default
  `0.5`) regardless of age/access. `"low"`/unset decay normally.
- **Graduation pin:** `"high"` records are pinned to the always-injected surface, **exempt from
  the hygiene graduation audit**. Decay-shield ≠ graduation-pin — both apply to `high`.
- Care-critical splits into **pinned body** (crisp one-liners — allergies, meds, crisis triggers,
  support-map contacts — injected wholesale) vs **pinned pointer** (open-ended care guidance —
  what-helps/what-doesn't — body lives in `ward`/`me` at `careWeight: high`, surface carries a
  compact directory entry). Split criterion: would acting wrongly in a single turn *without* it
  harm my human → body; guidance I'd deliberately consult → pointer.
- The care-critical definition is surfaced to the Familiar (first person) at memorization,
  consolidation, and graduation.

### Trackers (§8.1) — schema locked now, UX later
Only the schema is committed now (no tracker UI / setup flow / ingestion this milestone).
```
tracker_def: {
  kind: "tracker_def", id: "tracker-<uuid>",
  name, purpose, subject, audience,
  dataShape?: "boolean"|"ordinal"|"scalar"|"categorical"|"event-log"|"inventory",
  unit?,
  dimensions?: [{ id, label, shape, scale?: {min,max,lowLabel?,highLabel?}, options? }],
  prompt?, cadence?, careWeight?
}
tracker_entry: {
  kind: "tracker_entry", trackerId, at,
  value? | item?:{label,qty,unit,expiresAt?} | values?:{[dimensionId]: …},
  observedAs: "self-report"|"familiar-observed"|"inferred",
  note?, confidence?,
  // source (authorship) inherited from the all-records schema
}
```

### `remember` consent map on the villager (§7)
```
remember: { basics: true, emotional_content: "ask", health_info: false }
```
- `true` → store freely. `false` → never store, drop silently. `"ask"` → **active hybrid**: the
  Familiar reads the moment AND freely asks the ward; erring toward silence is the failure mode,
  not a safe default.
- Defaults: no map → `basics: true`, sensitive categories default to **`ask`** (not `false`).
- Starting taxonomy (extensible): `basics, emotional_content, health_info, relationships,
  whereabouts` (confirm — § Open knobs).
- **Extraction granularity contract** (rides the existing memorization LLM pass; the prompt
  returns a JSON array, each element `{content, category, subjects, confidence}`):
  one output per distinct claimable fact; multi-category utterances split into one record each;
  ambiguous/inseparable → assign the *more restrictive* category; `confidence < 0.4` → skip
  silently; `ask` items batched into one in-turn question per session.

### `relationToFamiliar` on the villager (§8.4)
`stance` ∈ `unaware` (**default for any new contact**) | `warm` | `neutral` |
`tolerates-for-ward` | `wary-of-ai` | `hostile`, plus freeform notes. Stance calibrates *tone/
approach*, anchored to the Familiar's own character — never flattened into a people-pleaser. It
is orthogonal to the audience gate (tone ≠ clearance).

### `audience` tag (reuses `audience.js`)
`audience` = minimum level allowed to hear it: a category id or `'ward-private'` (most
restrictive). Disclosure rule: record `M` may surface in room `R` iff
`permissionScore(R) >= requiredScore(M)`; `'ward-private'` scores above all categories. Define
`requiredScore()` for the sentinel.

### Deletion / right-to-be-forgotten (§3)
Three hard-delete paths (no soft-delete, no undo — this is consent revocation):
- `mem_delete(id)` — single record. Ids ride in on recall/search, so the flow is **search →
  confirm → delete** (ward confirms; RAG match is fuzzy + delete is irreversible).
- `mem_purge_by_villager(villagerId)` and `mem_purge_by_topic(villagerId?, category)` — bulk.
  **Both are two-call:** first call **previews** (returns the full manifest as thin projections
  + a `purgeToken` pinning that exact id set; deletes nothing). The Familiar relays the manifest
  to the ward; only the second call, carrying the token, commits. A stale token (set changed
  between preview and commit) is refused. Escape hatch is always the by-id path. Preview is
  unskippable by construction.
- Cascades: embeddings delete with their record; `knownTo` refs removed from other records;
  `tracker_entry` rows cascade-delete with their `tracker_def`. Return a count; log every purge
  to the event log.

---

## 4. The three gates (consent-as-architecture)

| Gate | When | Question | Where it lives | Pillar |
|---|---|---|---|---|
| **Retention** (`remember`) | write / memorization | may I *store* this? | villager `remember` map | C/G |
| **Disclosure** (`audience`) | recall / enrich | may this *surface* here? | category grants + record tag | A/B |
| **Outgoing filter** | send | may this *leave* in this message? | record-tag scan of the draft | D |

`knownTo` is an **awareness aid, not a fourth hard gate** — the Familiar reasons with it (avoid
spoiling surprises, avoid repeating, notice leaks) and it may *feed* the outgoing filter as a
signal, but it never becomes a blunt gate. Hardening it into a real gate later would be a
safety-critical sign-off decision.

---

## 5. Context economy — non-negotiable output discipline

> **Storage shape ≠ retrieval shape ≠ context shape. Store rich, return thin, project per need.**

This is an **output** optimization, never a storage one. Never drop fields from the store or the
code paths that consume them — only from the prompt projection.

- **List thin, read fat.** Recall/`mem_search` return `id` + one-line + why-relevant tag. Fat
  record (all metadata, full text) only via `mem_read(id)` when a path needs it.
- Metadata (`audience`, `careWeight`, `source`, raw `confidence`, `knownTo`, embeddings) stays
  server-side; staleness rides as a compact prose tag ("(as of last month)", "(unconfirmed)"),
  never a JSON blob.
- `knownTo` materializes only when composing *to* a person; `relationToFamiliar` only when that
  villager is in the room.
- **Pin the pointer, not the body** for care-relevant-but-large content.
- Trackers return aggregates (latest + tiny rollup), not logs; full series on explicit demand.
- Prefer the consolidated tier for background; detail scales inversely with age/relevance.
- Token-budgeted assembly in code (not an LLM call); the `careWeight` floor guarantees
  care-critical survives a tight budget.
- **Cache-aware placement: keep depth 4.** `thalamus.js` splits `static` (cached prefix:
  base + identity) from `dynamic` (RAG + graph + temporal, injected at `thalamusDynamicDepth`,
  default 4). Smaller depth caches more; the real lever is thin projections, not depth. The
  dynamic block must stay the *highest* volatile element — nothing volatile above it.

Net per-turn output ≈ `identity (bounded) + top-k thin projections + tracker rollups`.

---

## 6. Phase-5 seams — everything that moves with the repoint

A half-migrated install that spawns both engines is the failure mode. **These move together.**

- **MCP lifecycle + every `callTool` site** in `thalamus.js`: the `mcpClient` global, `connect`/
  `scheduleEntityCoreReconnect`/`reconnectEntityCore`/`shutdownEntityCore`, and ~24 `callTool`
  sites + helper wrappers (`listMemories`, `readMemory`, `getIdentityAll`, `listGraphNodes`,
  `searchGraphNodes`, `getGraphSubgraph`, `getFullGraph`, `createMemory`, `appendIdentity`,
  `updateIdentitySection`, `rewriteIdentitySection`, `createGraphNode/Edge`,
  `update/deleteGraphNode/Edge`, `create/listSnapshots`, `restoreSnapshot`). Plus the enrich-path
  calls (`identity_get_all`, `memory_search`, `graph_node_search`, `graph_subgraph`).
- **`user` → `ward` identity-category rename is code-wide, not just data.** Hardcoded at:
  `cerebellum.js` `VALID_IDENTITY_CATEGORIES` (~:670) and the `write_identity_file` /
  `rewrite_identity_section` tool-schema enums (~:809, ~:917); `thalamus.js` default file list
  (~:361), the `id.user ?? []` accessor (~:1340), the static-context label (~:1580);
  `public/app.js` the `['self','user','relationship','custom']` array (~:6246); the
  `/api/entity/identity/:category` path; `entity-ref.js` + tests. **All move together.**
- **Standing-value ref scheme** (`entity-ref.js`, guarded by `entity-ref.test.mjs`): preserve the
  ref *structure*; migrate only the source token `entity-core:` → `phylactery:`, keeping
  `entity-core:` as a **legacy alias** so stored refs still resolve.
- **Composite-key contract — preserved, does NOT move.** `cerebellum.parseMemoryKey` and its five
  seams carry over unchanged. Called out so no one "migrates" a format that's fine.
- **Consolidation LLM-key plumbing:** `entityCoreConnectionId` (settings, synced) →
  `loadEntityCoreEnv()` → `ENTITY_CORE_LLM_*` env vars at spawn (`thalamus.js` ~:307–336), plus
  the entity-core badge / "✓ entity-core" designation button (`public/app.js` ~:723, ~:754).
  Repoint + relabel.
- **Auto-snapshot-before-destructive invariant** (`thalamus.js` `autoSnapshot()`) — Phylactery
  must preserve it.
- **Deno removal:** retiring entity-core removes Deno entirely — installer clone/tag/`deno cache`
  (`install.{sh,bat}`) and `~/.deno/bin` PATH priming (`start.sh`, `start.bat`,
  `Proto-Familiar.command`) drop or become `uv`/Phylactery setup. `scripts/import-entity.js` +
  the `import-entity` npm script become the Phylactery conversion tooling (Phase 1).
- **Prompt Inspector** (`public/app.js` ~:2520, ~:2575; `index.html` ~:28): relabel
  entity-core → Phylactery; also the natural surface to expose the audience tag + thin-projection
  visibility.
- **Docs:** `docs/entity-core.md` (retire/fold), `docs/architecture.md` (thalamus, composite-key,
  tier sections), `README` + `docs/getting-started.md` (drop "Deno 2+ required"), passing refs in
  `api-reference`, `features`, `troubleshooting`, `wiki/`.

---

## 7. Safety gates — do not ship these without explicit human sign-off

Per CLAUDE.md. Anything touching *when/whether the Familiar may store, recall, disclose, or act
on a human's safety* is human-signed, not yours to decide:

- **Outgoing filter (Pillar D):** similarity threshold, rewrite-retry budget, safe-refusal
  wording.
- **`remember` retention gate (Pillar C/G):** the behaviour of true/false/ask, especially the
  `ask` prompt — it must not hedge the Familiar into silence (the recorded 1.5-hour-silence
  failure mode).
- **Graduation-eligibility rule (Pillar H hygiene):** what may leave the always-injected surface.
  Care-critical (`careWeight: high`) stays pinned regardless.
- **Behavioural changes** in `crisis-signals.js`, `threat-tracker.js`, `silence-triage-loop.js`,
  `cerebellum.js` (triage prompt, trusted-contact delivery, escalation deadlines), and the
  `[CARE CHECK]` assembly in `thalamus.js`. A pure relocation with byte-identical behaviour is
  fine; a stricter gate or longer clamp is not yours to add.

**Never add bias-toward-quiet language** to any prompt deciding when the Familiar acts. Name both
costs (intrusion AND silence) at equal weight. Proactivity is identity, not permission.

---

## 8. Open knobs — confirm with the human before the consuming pillar ships

None of these block Pillar A. Each is due just-in-time. Propose the recommended default; let the
human decide.

| # | Knob | Recommended default | Due before |
|---|---|---|---|
| 1 | Milestone slot | `0.6.x` | landing |
| 2 | Legacy audience default | `ward-private` floor | F (migration) |
| 3 | Cutover style | hard (convert→verify→retire in one run) | F |
| 4 | Reliability bar | degrade-to-absent + auto-restart-with-backoff | B |
| 5 | Filter threshold + retry budget + refusal wording ⚠️ | high-threshold semantic + audience compare | D |
| 6 | `remember` taxonomy starting set | `basics, emotional_content, health_info, relationships, whereabouts` | C/G |
| 7 | Ward care-profile field list | baselines/warning-signs, what-helps/doesn't, links out to Unruh/cerebellum for loops + support map | G |
| 8 | Consolidation cadence + per-tier thresholds | 5-min tick, volume-gated | H |
| 9 | Export format + encryption | `.sqlite` only; passphrase encryption-at-rest open | H |
| 10 | Foreign-source import | later/optional, off critical path | post-milestone |
| 11 | Context-economy knobs (`k`, per-turn token budget, metadata-in-projection) | tight `k`; staleness-only prose tag; no raw metadata | H |
| — | Optional `careWeight: "critical"` (floor 1.0) level | not now unless wanted | H |

---

## 9. Definition of done (the milestone)

Phylactery is one in-tree Python/`uv` MCP service that:
- owns identity + ward-identity + graph (GraphRAG) + all memory tiers + trackers, every record
  carrying `audience` + timestamps + caretaker metadata;
- recalls with entity-core-grade precision, gated at query time, returning thin projections with
  ids that ride in for the Familiar to act on;
- is spawned by thalamus in entity-core's retired slot, degrades to absent without failing a turn,
  auto-restarts, and ships its off-switch;
- memorizes web AND Discord server-side through the `remember` gate;
- enforces the outgoing filter as the third gate (human-signed thresholds);
- converts an existing entity-core Familiar one-time (snapshot-first, idempotent), retires
  entity-core, and removes Deno;
- surfaces audience / `remember` / `careWeight` / deletion controls in the repointed
  Knowledge-manager UI;
- keeps the always-injected surfaces lean via the Familiar-led hygiene audit (human-signed
  graduation boundary; care-critical pinned);
- and has `docs/architecture.md` updated to match, with `package.json` bumped per the one-minor
  rule.

Build A first. Confirm the knobs as you reach the pillars that need them. When a change touches a
safety gate, stop and ask.
