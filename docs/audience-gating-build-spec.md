# Audience-gated recall — build spec

> **Status:** built (all three phases). Privacy-critical. Closed the recall-side
> audience leak and completed the audience model the design intended. Patches on
> `0.7.x` (completing an incomplete safety feature, not a new milestone). The
> phase headings below are marked ✅ as they landed.

## 1. The real gap (verified against code, not docs)

The audience **foundation already exists** — the review/docs were behind the code:

| Thing | Reality |
|-------|---------|
| `audience` column on memories | ✅ exists (`migrations/0001_initial.sql`), indexed, default `ward-private` |
| `audience` column on graph nodes **and edges** | ✅ exists (structural, not a comment hack) |
| Outgoing filter (`search_restricted`, Pillar D) | ✅ exists **and is wired** (`outgoing-filter.js` → server.js + discord-gateway.js) |
| `fetchEligibility` gates whether memory/graph fetch runs | ✅ exists (`audience.js:303`) — a strangers room gets **no** memory fetch |
| The `<!-- gate: -->` markers | parsed for **identity files only** (`stripGatedSections`), **never** for graph nodes — so any gate-comments hand-written into graph-node *descriptions* are **inert** |

**The actual hole:** when a room IS trusted enough to run `memory_search`/`graph_subgraph` (it has the `memories:'shared'` / `graph` grant), those calls run **unfiltered** — `thalamus` never passes the room's `audienceTag`, so memory recall defaults to `ward-private` → `audience_filter_sql` → `"1=1"` → **everything, ward-private included**, and `graph.get_subgraph` ignores `audience` entirely. So ward-private memories/graph **enter the Familiar's context in trusted shared rooms.** The send-side outgoing filter is a partial backstop; the context itself is ungated.

**Plus a latent bug:** `audience_filter_sql` returns `audience IN (room_tag, 'ward-private')` for a non-ward room — including `ward-private`, which contradicts the gate's own intended semantics and would keep leaking even once wired. (Fixed by routing recall through `audience_in_sql` instead, which does not re-add ward-private.)

## 2. Design principle

**The trust model stays in JS** (`audience.js` owns categories + grant ladders + scores). The room `audienceTag` is a **Village category id** (or `ward-private`). JS computes the **set of audience tags a room is cleared to see** and passes it to Phylactery; Phylactery just filters `audience IN (set)`. No scoring duplicated in Python; no category-trust drift between the two.

```
audienceTag (category id)  ──audience.js: visibleAudiences()──▶  ["cat-friends", "cat-acquaint", …]
                                                                 (every category whose score ≤ room's,
                                                                  EXCLUDING ward-private; ward room → ALL)
        │
        └─ thalamus passes the set ─▶ memory_search(audiences=[…]) / graph_subgraph(audiences=[…])
                                       Python: WHERE audience IN (…)   (ward room → no filter)
```

## 3. Phases (leak closes first)

### Phase 1 — close the recall leak, with the category ladder ✅ done
- **`audience.js` `visibleAudiences(roomTag, registry)`** → the set of audience tags a room may see: every category whose `permissionScore` ≤ the room category's score, **excluding `ward-private`**. Ward-private room → a sentinel meaning "all" (`null`). Strangers room → `[]` (sees nothing — though `fetchEligibility` already blocks the fetch there). This IS the category ladder.
- **`memory.py` `audience_filter_sql` + `search`** accept an **allowed-set** (list) instead of a single tag. `None`/ward sentinel → `1=1`; `[]` → `0=1` (nothing); else `audience IN (?,…)`. **Fixes the ward-private-in-the-IN-list bug.**
- **`graph.py` `get_subgraph`** gains the same audience filter (today it has none).
- **`thalamus`** computes `visibleAudiences` from the session's `audienceTag` (+ registry) and passes the set to both `memory_search` and `graph_subgraph`. The MCP tools (`server.py`) thread it through.
- Result: a shared room sees only memories/graph it's cleared for; ward-private never surfaces outside a ward-private session. Closes the leak.

### Phase 2 — write-time audience derivation (widen + tighten — ward decision) ✅ done
Today a memory's `audience` = the session's `audienceTag`. **Decision (ward): both widen and tighten** — a subject villager's disclosure preference may raise *or* lower a memory's audience.

**Rule as built (`audience.deriveMemoryAudience`) — session-bounded by default, explicit disclosure widens/tightens; most-restrictive across multiple subjects:**
```
sessionDefault            = mostRestrictive( sessionTag, categoryFloor(fact.category) )
memory about the ward only = sessionDefault                          (never auto-widened)
memory about villager(s) V = mostRestrictive(
                               disclosure(V_i, fact.category) if set, else sessionDefault
                               for each subject )
```
- **`disclosure(V, C)`** — how widely V is OK being discussed re: category C. Source: a **per-villager `disclosure` map** (sibling of `remember`/`standingConsent`), per remember-category, holding an audience level (a Village category id, or `ward-private`). This is what lets Melian's *"my health is fine with close friends"* widen a health memory to `cat-friends` instead of `ward-private`.
  - **Default when unset = session-bounded (the safer choice we shipped).** With no explicit preference, a fact is capped at the room it was made in — it is **never auto-widened** from the villager's own category. (The earlier draft auto-widened to V's representative category; we tightened that to session-bounded so silence never widens.) Sensitive categories (`health_info`, `emotional_content`) floor the default to `ward-private`.
- **Explicit disclosure overrides in either direction**, including past the sensitivity floor — that entry *is* the data subject's stated consent. A memory about a `cat-friends` villager can become friends-visible even though it was made in a ward-private session.
- **Multi-subject** → most restrictive wins (every named person must be OK with the room).

> **Field `villager.disclosure`** (delivered): schema/sanitize in `village.js` (mirrors `remember`), server endpoints (POST/PATCH), a Village-UI editor (per-category → audience dropdown), and the Familiar's `village_upsert` tool gaining a `disclosure` argument (circle names resolved to ids) so it can record *"they're fine sharing X with my circle"* in first person. Audience is still **derived in code** from this field + the fact's category + subjects — the extraction LLM is never asked for an audience (§6).

> **Phase 1 is independent of all this** — it gates recall by whatever `audience` a record already carries, so it closes the leak regardless of how audience is written. Phase 2 only changes what audience gets *written* going forward.

### Phase 3 — graph-node audience is settable; retire the inert comments ✅ done
- **Derived in code (the default):** `audience.deriveNodeAudience({ label, registry })` tags each new node from the villager it matches (else `ward-private`, fail-closed); the edge takes the narrower endpoint (`mostRestrictiveAudience`). The auto-graph path (`memorization.js`) and the Familiar's `create_graph_node` both derive this way; `graph_relate` gained `fromAudience`/`toAudience`/`edgeAudience` and `resolve_or_create_node` never re-tags an existing node (a deliberate override survives).
- **Settable deliberately:** `graph_node_update` (Python + MCP) gained an `audience` setter; the Familiar reaches it via `update_graph_node`'s `audience` arg (circle name → id, ward-private sentinel), the human via the Knowledge-editor node popover's audience dropdown. `get_subgraph`/`search_nodes` now return each node's `audience` so the editor can show it.
- **The inert comments:** an audit found **no** `<!-- gate: -->` comments in any graph-node description — they only ever existed as the identity-file gating mechanism (`stripGatedSections`). Nothing to remove; documented that graph gating is the structural `audience` field + the Phase-1 recall filter.

## 4. Cross-cutting
- **Versioning:** `0.7.x` patch per phase.
- **Fail-closed everywhere:** unknown tag → not in the visible set → not shown. Empty set → nothing. A registry read failing during enrich → fall back to **ward-private-only** recall (most restrictive), never "show all".
- **Both gates remain:** Phase 1 is the recall/context gate; the existing outgoing filter stays as the send gate. Defense in depth.
- **Tests:** `visibleAudiences` ladder (pure), `audience_filter_sql` set semantics + the ward-private fix, write-time derivation rule, graph filter.
- **docs/architecture.md** updated per phase; this leak + fix recorded.

## 5. Order
Phase 1 (close the leak — independent, the safety win) → Phase 2 (write-time derivation, widen+tighten, the new `disclosure` field) → Phase 3 (graph audience + cleanup). The widen/tighten decision is settled (both).

## 6. The LLMs must not have to learn the schema (discoverability & operability)

CLAUDE.md: *every capability must be reachable by the Familiar.* For privacy the
safest reading is stronger — **the extraction LLM and the Familiar must not be
relied on to know about the `audience` field at all.** A field they must remember
to set is a field they will sometimes forget, and a forgotten privacy tag leaks.
So:

- **Memory audience is DERIVED IN CODE, never asked of the LLM.** The
  memorization extractor already produces `category` (health_info, …) and
  `subjects` (villager names) and the job already carries the session
  `audienceTag`. Phase 2 derives `audience` from exactly those three in
  `memorization.js`/`createMemoryFull` — the model is never asked for an audience.
  *Consequence:* `category` and `subjects` accuracy is now **privacy-load-bearing**;
  the extraction prompt stays as is, but this dependency gets a comment so nobody
  weakens those fields later thinking they're cosmetic.
- **Graph-node audience is DERIVED IN CODE too.** When `graph_relate` (the
  memorization auto-graph path) or the chat graph tools create a node that
  resolves to a villager, the node's `audience` is set from that villager's
  category — in the resolve-or-create step, not by the model. A node with no
  villager link defaults `ward-private` (fail-closed). The Familiar is never
  asked to tag a node.
- **What the Familiar IS told (because it acts on it):**
  - The **few** tools where it can deliberately tighten privacy (e.g. a future
    `set_audience`/mark-private, or graph-node audience override) ship a
    first-person description that teaches the *intent* ("I keep this to just
    {{user}} and me / to our close circle"), per the discoverability rule — not
    the field name, the meaning.
  - **Awareness in context ✅ (`0.7.60`):** a short line the Familiar reads when
    it's in a non-ward-private room (`discord-gateway.js` `presenceBlock`, every
    `kind !== 'ward-dm'`), so it understands it is seeing a **filtered** view of
    its own memory/graph (it won't recall ward-private things here — that absence
    is the gate working, not a hole in its memory) and that what it stores here is
    tagged for *this* room. Without this it could get confused ("why can't I
    remember X?") or wrongly assume it has the full picture. Rides the existing
    presence block — no new call.
- **Net:** the model keeps doing what it already does (extract `category` +
  `subjects`, speak in-room); the privacy tagging is the code's job. The only
  thing the Familiar *learns* is the human-meaning of acting more privately and
  the fact that recall is room-filtered — both in its own voice, both on surfaces
  it already reads.

