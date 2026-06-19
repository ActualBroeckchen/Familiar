# Tome → Phylactery graduation — build spec

> **Status: PLANNED.** Phase 4 of the Phylactery-ingestion work. Phases 1–3 (graph legibility,
> the `recall` tool, the memory-routing rubric in the save tools) are shipped; this is the
> autonomous pass that moves *already-stranded* knowledge out of tomes and into its right
> Phylactery home — the part that happens **without my human initiating it**. It inherits the
> Phase 3 routing rubric verbatim (do not re-derive it).

---

## 0. Before you write a line

Read these — they're constraints, not background:

1. **`CLAUDE.md`**, especially:
   - **Ride existing LLM calls; gate in code.** This must NOT spin up a per-tome LLM request on a
     fixed cadence. Pure-code gates pick candidates; one batched LLM call makes the routing
     judgment; a self-set cool-down paces it.
   - **Every new background loop ships its hard off-switch in the same commit**
     (`PROTO_FAMILIAR_TOME_GRADUATION_DISABLED=1`) + a Settings toggle.
   - **Graceful degradation.** Graduation failing (Phylactery down, an LLM hiccup) must never
     touch the chat path or corrupt a tome. A failed graduation leaves the tome entry exactly as
     it was, to retry later.
   - **Robust > cheap, fix the root cause.** The point is that knowledge stops being stranded —
     not a "mark it reviewed and move on" that quietly drops facts.
   - **Writes to identity/memory/graph go through thalamus's wrappers**, never a second MCP
     connection. Consent-gating reuses the existing greenlight flow (`memorization.js` /
     `phylactery` consent-pending), not a new one.
   - **First-person** for every prompt the Familiar reads (the graduation judgment prompt is the
     Familiar's own voice, like `graduation.py`'s Pillar-H prompt).
   - **Update `docs/architecture.md`** (new loop) in the same commit.

2. **Phase 3 rubric** — the shipped `save_to_tome` / `save_memory` / `update_identity` /
   `create_graph_node` descriptions in `cerebellum.js`. The graduation prompt reuses this exact
   routing logic. Where a durable fact about the human goes → identity; entities/relations →
   graph; dated moments → memory; keyword-context that fits none → stays a tome.

3. **Pillar H graduation** (`phylactery/src/phylactery/graduation.py`) — the *existing*,
   different graduation: it moves stale **identity-file** detail into RAG memory to keep the
   always-injected surface lean. This new pass is **tome → Phylactery**. Clone its posture
   (conservative, snapshots, first-person, consent-consulted for ward content), not its target.

4. **`memorization.js`** — the existing session→Phylactery router + the consent-pending
   greenlight. The graduation pass routes through the **same** consent gate, not a parallel one.

---

## 1. The problem & the shape

Knowledge lands in tomes — the Familiar reached for `save_to_tome` (pre-Phase-3 habit), the
human imported a lorebook, or it's a user-created tome. Some of it is **durable facts that belong
in Phylactery** (identity / graph / memory). Tomes are keyword-triggered, local, per-embodiment —
so a fact stranded there is never semantically recalled, never cross-embodiment, never in the
canonical self. Phase 3 stops *new* mis-filing; Phase 4 drains the *backlog*.

```
  slow background pass (Proto-Familiar side; self-cooled, off-switchable)
        │
   1. CODE GATE: pick candidate tome entries
        - eligible tomes only (user knowledge tomes; skip Ponderings,
          Session Memories, system/runtime tomes)
        - skip entries already marked graduation-reviewed
        - batch a handful per tick
        │
   2. ONE LLM call (the Familiar's voice, reusing the Phase 3 rubric):
        for each entry → { home: identity|graph|memory|stays-tome,
                           dedup: already-held? , what-to-file }
        (fed the entry + recall()/find_graph_node() hits for dedup)
        │
   3. ROUTE via thalamus wrappers (consent-gated for ward facts):
        identity → appendIdentity / rewriteIdentitySection
        graph    → create node/edge (dedup against find_graph_node)
        memory   → createMemory (greenlight if long-term about the human)
        │
   4. TIDY the tome entry: mark it graduated with a pointer to its new
      home (see Open knob 2) — never hard-lose content on a failed route.
```

## 2. Pillars

- **A — candidate selection (pure code).** A registry of which tomes are in scope (default: user
  knowledge tomes; hard-exclude `Ponderings`, `Session Memories`, and any `.`-prefixed runtime
  tome). A per-entry `graduationReviewedAt` marker so the pass advances instead of re-scanning the
  same entries forever. Batch size small (e.g. 5/tick) to bound cost.

- **B — the judgment (one batched LLM call, self-cooled).** Reuse the Phase 3 rubric in a
  first-person prompt: for each candidate, decide its home (or "stays a tome"), and — fed the
  entry's own `recall()` + `find_graph_node()` results — whether it's already held (→ tidy only,
  don't duplicate). Self-set `nextRunMs` like the silence-triage pattern so it idles when there's
  nothing to do.

- **C — routing + dedup.** Through thalamus wrappers only. Identity/graph/memory per the home.
  Dedup before writing (the LLM saw the recall/graph hits; the code still guards). Ward-fact
  long-term memories go through the **existing** greenlight; the Familiar's own `self` facts are
  its own call (no human consent needed for its own identity).

- **D — tome tidy.** After a *confirmed* route, tidy per `tomeGraduationTidy` — `delete` removes
  the entry; `pointer` leaves a breadcrumb. Never tidy on an unconfirmed write; a failed/partial
  route leaves the entry untouched for retry.

- **E — controls.** Settings toggle + `PROTO_FAMILIAR_TOME_GRADUATION_DISABLED=1`; decisions
  logged; ward-facing note (like Pillar H) so the human can see what was filed where.

## 3. Safety & consent

- Not on the crisis/threat/triage surface — no human sign-off gate. But it **writes to the
  canonical store**, so: snapshot before tome edits (mirror Pillar H), consent-gate ward
  long-term memory via the existing flow, and stay conservative — when the LLM is unsure where a
  fact goes, it **stays a tome** (false-negative is cheap: the fact waits; false-positive
  mis-files into the canonical self).
- Never delete the only copy of a fact on a write that hasn't confirmed success.

## 4. Decisions (settled)

1. **Where it rides — its own slow Proto-Familiar-side loop** with a self-set cool-down (mirrors
   the reminders / silence-triage loop pattern). Independent, off the chat path; tomes are
   PF-local so it stays PF-side.
2. **Tome tidy — configurable via `tomeGraduationTidy`:**
   - `delete` — remove the graduated entry outright. The fact now lives in Phylactery, so nothing
     is lost; this is the **declutter mode** for installs whose tomes have piled up.
   - `pointer` *(default)* — replace the entry with a slim "this now lives in &lt;home&gt;"
     breadcrumb, so a keyword trigger still resolves.
   Either way, the tome entry is touched **only after** the route to Phylactery is confirmed — a
   failed/partial route leaves it intact to retry.
3. **Scope — confident durable facts only.** When the LLM isn't sure a tome entry is a durable
   fact with a clear home, it **stays a tome**. Borderline lore is left alone (false-negative is
   cheap; mis-filing into the canonical self is not).

## 5. Acceptance criteria

- [ ] A stranded durable fact in a user tome (e.g. "{{user}} lives in Berlin") is autonomously
      routed to its right home (identity + graph) and the tome entry is tidied — no human action.
- [ ] A fact already held in Phylactery is **not** duplicated — the entry is tidied, nothing
      re-written.
- [ ] `tomeGraduationTidy='delete'` removes the graduated entry; `='pointer'` leaves a breadcrumb;
      both happen only after a confirmed route, never before.
- [ ] Ponderings / Session Memories / runtime tomes are never touched.
- [ ] A fact the LLM can't confidently place **stays a tome**.
- [ ] Ward long-term memory routes through the existing greenlight; the Familiar's own `self`
      facts do not require consent.
- [ ] Phylactery down / LLM error → the tome entry is left intact for retry; chat path untouched.
- [ ] Toggle + `PROTO_FAMILIAR_TOME_GRADUATION_DISABLED=1` both stop it; decisions are logged.
- [ ] No new LLM request on a fixed per-entry cadence — batched + self-cooled.

## 6. File-by-file (anticipated)

| File | Change |
|---|---|
| `tome-graduation-loop.js` *(new)* | The pass: candidate gate, batched LLM judgment, routing, tidy, self-cool-down, off-switch. |
| `tomes` entry shape | Add `graduationReviewedAt` / a graduated-pointer marker (via the existing `modifyTomeFile`). |
| `cerebellum.js` / `thalamus.js` | Reuse existing wrappers; possibly a small helper for the batched judgment prompt (reusing the Phase 3 rubric text). |
| `server.js` | Boot the loop after the others; tear down in the shutdown handler. |
| `public/app.js` + `index.html` | Settings: enable toggle + `tomeGraduationTidy` (`delete` / `pointer`), both added to `SERVER_SYNCED_KEYS`. |
| `docs/architecture.md` | Record the new loop (the autonomous-loops set). |
| `tests/` | Candidate gate (eligible/excluded tomes, reviewed-marker), dedup-skips-duplicate, stays-tome-on-low-confidence, failed-route-leaves-entry. |
