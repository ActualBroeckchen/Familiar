# Tool Calling

## Overview

Tool calling lets the LLM invoke the Familiar's tools and receive their results before producing a final response. Proto-Familiar implements the OpenAI function-calling protocol. Since **0.4.0-alpha** the registry, the executors, and the multi-round execution loop all live **server-side** (in `cerebellum.js`, the motor module — see [`architecture.md`](architecture.md)): the loop runs inside a single `POST /api/chat` request, and the browser only *renders* what happened. This is what lets future non-browser channels (e.g. Discord) get tool execution for free.

---

## Enabling / Disabling

The **Enable tool use** checkbox in the sidebar **Tools** section controls whether the app opts the request into the server-side tool loop (`runToolLoop: true`). When unchecked, no tools are advertised to the model and it behaves as a plain chat completion.

---

## Built-in Tools

Forty-six tools are always available when tool use is enabled: two session-info tools (`get_datetime`, `get_session_info`); seven read/write & deferred-intent tools (`save_to_tome`, `save_memory`, `memorize_now`, `update_identity`, the snooze/acknowledge deferred-intent pair, and `recall` — semantic search over the Familiar's own memory, for checking what it already holds before saving); eight memory-browse-and-edit tools (`list_memories`, `read_memory`, `read_memory_by_id`, the by-date `update_memory`/`delete_memory` pair, and the by-id `move_memory_date`/`update_memory_by_id`/`delete_memory_by_id` trio for addressing a single per-fact memory that shares its date with the rest of a day's extracted facts); `rewrite_identity_section` for clean section rewrites; eight graph tools (lookup, create, update, delete for nodes and edges); nine temporal tools (schedule + `schedule_assign_time` to pin a floating task + interests, backed by Unruh); three crisis outreach tools for when the Familiar needs to help a user who is in danger during a live conversation; three consent/graduation tools (`memory_confirm_consent`, `memory_drop_pending`, `graduation_acknowledge`); two own-file tools (sandboxed read access to the Familiar's own folder — tomes, logs, docs); and three Village/relay tools (look up who's in the ward's Village, add/edit people with sensitive notes gated to private turns, and relay a message). Every destructive tool (delete / rewrite / replace) auto-snapshots Phylactery before the call — recovery is one click in the **Snapshots** tab of the Knowledge editor.

Three further tools — `look_up`, `web_search`, and `read_webpage` — are **opt-in** (web access since **0.7.0-alpha**; the `look_up`/`web_search` split since **0.7.19-alpha**): they appear in the tool list only when the human enables web access in Settings, and the `PROTO_FAMILIAR_WEBSEARCH_DISABLED=1` env var forces them off regardless. They are the only built-ins gated this way; everything else above is always present. The two search tools are deliberately distinct: **`look_up`** answers the definition/fact/overview kind of question from keyless official reference APIs (Wikipedia + the DuckDuckGo Instant Answer API), no scraping and no setup; **`web_search`** finds pages out on the web and works **out of the box** via a built-in keyless DuckDuckGo scrape (no install), upgradable to a proper search API (Marginalia — no signup; Tavily; Brave; Google) in Settings (see [`websearch-setup.md`](websearch-setup.md)). All web logic lives in `websearch.js` (the SSRF guard, the timeout, the floor) + `websearch-providers.js` (the API adapters) + `lookUp` (the reference-API client) + the `linkedom`+`@mozilla/readability`+`turndown` extraction; cerebellum only registers the defs and delegates.

| Tool | Description | Returns |
|---|---|---|
| `get_datetime` | Current local date, time, and timezone | Human-readable locale string (e.g. `"Tuesday, May 13, 2026 at 02:30:00 PM CEST"`) |
| `get_session_info` | Metadata about the current session | JSON with `startedAt`, `messageCount`, `provider`, `model`, `elapsedMsSinceLastMessage` |
| `save_to_tome` | Save **keyword-triggered context/lore** that should resurface on a topic — the narrow lane (durable facts about the human → `update_identity`; entities/relations → graph; dated moments → `save_memory`). Recall-deduped | Confirmation string with the assigned entry UID |
| `save_memory` | Write a memory at a chosen `granularity` (`daily` \| `weekly` \| `monthly` \| `yearly` \| `significant`) — by default a time-stamped *moment*. A separate `register` axis (`episodic` default \| `me` \| `ward`) marks a **standing truth** about the Familiar (`me`) or the human (`ward`): filed as a standalone `significant` fact recalled when relevant — the lighter sibling of `update_identity`. Recall-first: correct in place if mis-recorded, or supersede with a fresh dated entry if it evolved | `"Memory saved."` / `"Saved as a standing truth …"` / an error string |
| `memorize_now` | Commit the **whole current conversation** to long-term memory now, instead of waiting for a session rollover that may not cleanly happen. Runs the full memorization pass (extract → tier → consent-gate → graph). For a single deliberate fact, use `save_memory` instead. No arguments | A first-person confirmation, or a calm defer line |
| `update_identity` | Append a durable standing fact to an identity file — **the Familiar's own `self`** (`my_identity.md`, …), the ward, the relationship, or a custom file. These ride the always-injected surface, so it holds load-bearing truths and routes richer detail to `save_memory`. Cross-surface deduped (identity + recall + graph) | `"Identity file updated."` or an error string |
| `snooze_deferred_intent` | When {{user}} asks to come back to a deferred intent later: park it so it stops appearing, then auto-resurface after N minutes (default 60, max one week). Only on an explicit defer — never the Familiar's own initiative | Confirmation string |
| `acknowledge_deferred_intent` | Mark a `wants_to_save` intent from the [Deferred intents] block as filed, so it stops resurfacing (see the deferred-action pattern in [`architecture.md`](architecture.md)). Called once per intent, right after the filing tool call | Confirmation string |
| `find_graph_node` | Look up the graph id(s) for an entity by name. Use before `update_graph_node` / `delete_graph_node` when the entity isn't in the graph block's ids legend | One line per match: `<label> (id=…, type=…) — <description>` |
| `find_graph_edges` | List a node's 1-hop edges with their ids. Use before `update_graph_edge` / `delete_graph_edge` when the edge isn't in the graph block's ids legend | One line per edge: `<from> -<rel>-> <to> (id=…)` |
| `list_memories` | Browse stored memories at a given tier, most recent first — for surveying recent entries or finding the key of an entry to update/delete. No arguments required; `granularity` and `limit` are optional | One line per entry: `<tier>/<key> — <title or first 80 chars>` |
| `read_memory` | Read the full contents of one memory entry by its exact address. Use when a summary isn't enough and you need the verbatim body before quoting or updating it. Significant memories use the composite key `YYYY-MM-DD_slug` | Full entry body, or a "not found" string |
| `read_memory_by_id` | Read one memory by its `id` — the reliable handle when a date alone can't tell two entries apart (a whole conversation's facts land on one day). Ids ride in on `recall` / `list_memories` results | Full entry body, or a "not found" string |
| `move_memory_date` | Re-file a mis-dated memory (`id`) to the day it actually belongs to — the case for facts brought in from older conversations that all landed in today's bucket. Only the day changes; content is untouched | Status string |
| `update_memory_by_id` | Correct one specific per-fact memory by `id` — the safe way when a day's facts share one date and by-date `update_memory` can't single one out. New `content` REPLACES the entry | Status string |
| `delete_memory_by_id` | Delete one specific per-fact memory by `id` (a duplicate, or one extracted wrongly) when by-date `delete_memory` can't single it out. Auto-snapshots first | Status string + snapshot note |
| `recall` | Semantic search over the Familiar's own long-term memory (`query`, optional `limit`). The dedup-before-save path: checks whether a fact is already recorded so the Familiar can update/supersede instead of duplicating. Returns matches with relevance, address (tier/date), `register`, and id — so a `me`/`ward` standing truth reads back tagged, distinct from a passing episodic moment | Ranked match list with addresses, or a "nothing close — looks new" string |
| `create_graph_node` | Add a new entity (person, place, project, pet, organisation, …) to the knowledge graph. Returns the new node's id for immediate edge-wiring | `"Graph node created: \"<label>\" (id=…)."` or an error string |
| `create_graph_edge` | Record a relationship between two existing graph nodes. Both endpoints must exist first (resolve or create with `find_graph_node` / `create_graph_node`) | `"Graph edge created: <fromId> -<type>-> <toId> (id=…)."` or an error string |
| `update_memory` | Overwrite a **journal-bucket** entry (a daily/weekly/… summary) or a **significant** milestone (by its `YYYY-MM-DD_slug` key) to correct an inaccuracy. Replaces the entry whole. Because a whole day's per-fact memories share one date, a single fact is corrected by id with `update_memory_by_id` instead | Status string |
| `delete_memory` | Permanently delete a **journal-bucket** entry or a **significant** milestone (by `YYYY-MM-DD_slug`). A single per-fact memory (which shares its day with others) is removed by id with `delete_memory_by_id` instead. Prefer `save_memory` (today's date, contradicting the stale entry) when the change has historical value | Status string + snapshot note |
| `rewrite_identity_section` | Replace one section of an identity file. Use when an existing section is misleading and a clean rewrite serves future-you better than appending a correction | Status string |
| `update_graph_node` | Rename or re-describe a knowledge-graph entity (person / place / project), or set how widely it may surface via `audience` (a circle name like `"Family"`, or `"ward-private"` to keep it to just {{user}} and the Familiar). Use when the label/description is wrong or the visibility should change, not for new relationships | Status string |
| `delete_graph_node` | Delete an entity AND all its edges. Only when the node is an error (duplicate, wrong entity); for "no longer related" use `delete_graph_edge` instead | Status string + snapshot note |
| `update_graph_edge` | Change a relationship's type or weight when it still holds but is mis-typed (e.g. "acquaintance" → "close friend") | Status string |
| `delete_graph_edge` | Remove one relationship between two entities while keeping the entities themselves. The right tool for "X is no longer at Y" / "X no longer works with Y" | Status string + snapshot note |
| `schedule_add_event` | Record a one-time (or recurring) appointment on the schedule; surfaces in `[Temporal Context]` as its time approaches | Confirmation string with the node id |
| `schedule_add_task` | Record a task, optionally deadline-bound, with optional `stakes_tier` / `consequence_model`; surfaces until resolved | Confirmation string with the node id |
| `schedule_assign_time` | Pin an existing **floating** task (`id`, one with no time set) to a concrete `when` (ISO 8601 UTC) so it stops drifting and actually comes due — the tool to reach for the moment {{user}} names a time for a someday task | Confirmation string |
| `schedule_add_reminder` | Set a time-triggered reminder, delivered as a chat message (and Discord push when configured) when it fires | Confirmation string with the node id |
| `schedule_add_phase` | Add a named block to the daily routine, with an optional texture for how the Familiar shows up during it | Confirmation string with the node id |
| `schedule_resolve` | Mark a schedule node `done` / `cancelled` / `carried_forward`; optional `occurrence_date` resolves one occurrence of a recurring series | Confirmation string |
| `schedule_snooze_task` | Park a task for N minutes (clamped 1min–1week) when {{user}} says "not now" — it stops surfacing, then returns on its own | Confirmation string |
| `schedule_delete` | Permanently remove a schedule node — event, task, reminder, or routine **phase** — when it should no longer exist at all (a duplicate or mistaken entry, or a phase {{user}} wants gone). For "done / cancelled" use `schedule_resolve`, which keeps the record; this erases the node. No undo | Confirmation string |
| `interest_bump` | Nudge an interest topic's weight (creates the topic on first bump); feeds the pondering loop | Confirmation string |
| `interest_set_standing` | Promote a topic to a never-decaying standing value | Confirmation string |
| `get_trusted_contacts` | Return the names and channels of any trusted contacts configured in Settings. Call this before `contact_trusted_person` to confirm who is available and get the exact name to pass. | Plain-text list, or a note that none are configured |
| `contact_trusted_person` | Immediately send a message to one of the user's trusted contacts (Discord webhook). Intended for live conversations where the user is actively present but in genuine danger. Every outbound is also mirrored into the user's chat (and pushed to their own webhook when configured) — nothing is covert. | Confirmation string, or an error string on failure |
| `show_crisis_resources` | Surface international crisis-line and safety-resource links as a chat message (and push). Low friction — call early rather than late. No contacts required. | Confirmation string |
| `memory_confirm_consent` | After {{user}} says yes to keeping records flagged in the [PENDING MEMORY CONSENT] block: clear `consent_pending` on the given `ids` so they become permanent and enter the normal recall pool | Confirmation string |
| `memory_drop_pending` | Discard pending-consent records {{user}} declined (or that should be dropped), by `ids` from the [PENDING MEMORY CONSENT] block. Auto-snapshots first | Status string + snapshot note |
| `graduation_acknowledge` | Mark the [GRADUATION NOTICE] items (`ids`) as surfaced once the Familiar has mentioned (or judged no mention needed) the ward-block detail filed off its always-injected surface, so they stop re-raising. Nothing is deleted | Confirmation string |
| `village_lookup` | See who's in the ward's Village; filter by `category`, `location`, or `name`. Returns each villager's id, relation, notes, and linked graph node. `privateNotes` are disclosed only on ward-private turns and withheld whenever others are present | Plain-text list, or a "no one matches" note |
| `village_upsert` | Add or edit a villager (name, category, relation, pronouns, notes, `privateNotes`, the `graphNodeId` link to a Phylactery node, and `disclosure` — a per-fact-kind map setting which Village circle that kind of fact about them may surface in, a category name or `"ward-private"`). Resolves a category name to its id. With others present, creating a just-met person is allowed, but edits to existing records, the `privateNotes` bucket, and `disclosure` are deferred for the ward's consent | Confirmation string |
| `list_files` | List entries under a repo-relative folder of the Familiar's own checkout (tomes, logs, docs). Sandboxed (no escaping the root), secrets (settings/keys/.env) and build noise denied. **Ward-private turns only** | Plain-text listing |
| `read_file` | Read one of the Familiar's own text files by repo-relative path (size-capped, text-only, same sandbox + denylist as `list_files`). Lets the Familiar look up its own tomes / session logs on purpose. **Ward-private turns only** | File contents, or an error string |
| `relay_message` | Carry a message from the ward to a villager (DM) or a Discord location, named by `to` (villager name/alias or location label/key) + `message`. Delivery via the Discord bot token (REST); a restricted-memory gate holds back anything not cleared for the target room (fails open on error); every relay is mirrored to the ward's outbox — never covert | Confirmation string, a "held that back" note if gated, or an error string |
| `look_up` *(opt-in)* | Look up a definition, fact, or overview (`query`) from keyless official reference APIs (Wikipedia + the DuckDuckGo Instant Answer API). No scraping, no setup; narrower than `web_search` by design — a short grounded answer with its source, not a page list. Only advertised when web access is enabled in Settings | A short definitional answer + source link(s), or a calm "couldn't find" string |
| `web_search` *(opt-in)* | Search the web for pages (`query`). Returns the top N results (default 5) as titles + links + snippets. Built-in keyless DuckDuckGo by default (no setup); upgradable to a search API (Marginalia/Tavily/Brave/Google). Only advertised when web access is enabled in Settings | Compact result list, or a calm failure string if the web is unreachable |
| `read_webpage` *(opt-in)* | Open a public URL (`url`, usually one a `web_search` returned), extract the main article to markdown (capped at `webSearchMaxChars`), stamped with `Source: <url> · retrieved <date>` and framed as untrusted. SSRF-guarded: refuses loopback/private/link-local/metadata targets and redirects into them | Clean markdown, or a calm refusal/failure string |

### Graph ids in the prompt

The relationship lines themselves are **concept-only** — they render labels, never raw ids (`Chen has_cat Mochi`, not `Chen has_cat <uuid>`). An endpoint whose label can't be resolved is dropped rather than leaked as a hex string, because LLMs relate concepts, not ids. (This relies on Phylactery's `graph_subgraph` returning a label for every edge endpoint, including 1-hop neighbours — see `get_subgraph` in `phylactery/graph.py`.) Every id lives in **one** place: a compact legend at the *end* of the block, so the Familiar can still resolve names like "Eury protects Chen" into the underlying graph ids without an extra tool call. The legend has two sections:

```
[graph ids — pass these strings to update_graph_node / delete_graph_node / update_graph_edge / delete_graph_edge]
nodes:
  Eury = 1747389234876-a3f2e8b1
  Chen = 1747389234876-c4d8f7a2
edges:
  Eury -protects-> Chen = 1747389234877-e1f9b3c4
```

For entities or edges not in the active block, `find_graph_node` and `find_graph_edges` resolve names → ids on demand. For entities not yet in the graph, `create_graph_node` adds them and returns an id ready for `create_graph_edge`.

### Schedule ids in the prompt

The schedule renders the same way, and for the same reason: the human-readable lines in `[Temporal Context]` (today's rhythm, upcoming, open tasks, reminders) carry **labels**, not ids — but every schedule editing tool (`schedule_assign_time`, `schedule_snooze_task`, `schedule_resolve`, `schedule_delete`) is addressed by a node **id**. Without surfacing the ids the Familiar could *see* its schedule yet never act on it. So `temporal-format.js` appends a compact `[schedule ids]` legend at the end of the block — mirroring the graph-id legend — covering both routine phases and the window, deduped:

```
[schedule ids — to give a floating task a time (schedule_assign_time), park one (schedule_snooze_task), mark one done/cancelled (schedule_resolve), or remove one entirely incl. a phase (schedule_delete), pass its id]
  morning correspondence [phase] = ph-1
  Calbright Workshop [event] = ev-9
  file taxes [task] = tk-3
```

Floating tasks reach the model by a second path too — the `[Surface candidates]` block (`surface-context.js`) now prints an `id:` line under each candidate, so a task surfaced for time-assignment carries the id the tool needs in the same place the Familiar reads about it. Either surface is sufficient; both exist because a task can appear in one without the other.

### Editing principles surfaced to the model

Every editing tool's description carries first-person guidance on **when** to use it. The shared principles, repeated in different forms across the descriptions:

- **APPEND** when the new information adds to an existing record without contradicting it. Append is non-destructive and reversible by deletion.
- **UPDATE / REWRITE** when the existing record is now inaccurate or incomplete in a way that a partial addition wouldn't fix.
- **DELETE** when the record is fully obsolete or was wrong from the start. If the change has historical value ("they were on vacation, now back"), prefer writing a newer contradicting memory instead — the recency-decay scoring demotes the stale entry while preserving the audit trail.
- **If unsure, err toward preservation.** Writing an extra note is cheaper than restoring from a snapshot.

`get_datetime` and `get_session_info` require no arguments. See parameter details for the write tools below.

---

### Write Tool Parameters

#### `save_to_tome`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `title` | string | Yes | Short label for the entry |
| `content` | string | Yes | Text to inject when the entry activates |
| `keywords` | string[] | Yes | 2–8 trigger words/phrases |

Entries are saved to the first enabled Tome (auto-creates "General" if none exist), with `learnedAt` set to the current timestamp.

#### `save_memory`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `content` | string | Yes | Memory text in first-person, as bullet points starting with `- `. No `[chat:id]` tags on live saves. |
| `granularity` | enum | Yes | `daily` \| `weekly` \| `monthly` \| `yearly` \| `significant`. The rollup tier: `daily` is the consolidating baseline (rolls up `daily→weekly→monthly→yearly`); `significant` is a rare standalone milestone that bypasses consolidation. Ignored when `register` is `me`/`ward` (those are filed `significant`). |
| `register` | enum | No | `episodic` (default) \| `me` \| `ward` — a **separate axis** from granularity. `episodic` is a lived moment; `me`/`ward` mark a *standing truth* about the Familiar / the human, filed as a standalone `significant` fact and recalled when relevant (lighter than `update_identity`, which stays always-injected). |
| `title` | string | Required for `significant` and for `me`/`ward`, ignored otherwise | Short human-readable label (e.g. `"first meeting"`). Used to slug-name the file so each gets its own `YYYY-MM-DD_slug.md` and does not overwrite previous ones. |

Requires Phylactery to be running. Degrades gracefully (returns an error string) if Phylactery is unavailable. For `significant` (and `me`/`ward`), the server auto-derives a slug from the title (or from `content`'s first line if the title is missing) before forwarding to Phylactery, and the confirmation string includes the composite key (`Memory saved (significant/2026-06-11_why-melian-trusts-me).`) — that key is how the entry is addressed later in `update_memory` / `delete_memory`. A `me`/`ward` write instead confirms `Saved as a standing truth about myself/my human …`.

#### `update_identity`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `category` | enum | Yes | `user` \| `relationship` |
| `filename` | string | Yes | Target file, e.g. `user_notes.md` or `relationship_notes.md` |
| `content` | string | Yes | Text to append to the file |

Requires Phylactery. Appends to the end of the specified file.

#### `find_graph_node`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Entity name or fragment (e.g. `"Chen"`, `"vacation"`) |
| `type`  | string | No  | Restrict matches to a single node type |
| `limit` | number | No  | Max matches (default 10, max 100) |

Calls `graph_node_search` server-side. Returns one match per line in the form `<label> (id=…, type=…) — <description>`, ready to paste into `update_graph_node` / `delete_graph_node`.

#### `find_graph_edges`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `nodeId` | string | Yes | Graph id of the node whose edges to list |
| `depth`  | number | No  | Traversal depth 1–3 (default 1) |

Calls `graph_subgraph` server-side. Returns one edge per line as `<from> -<rel>-> <to> (id=…)`, ready to paste into `update_graph_edge` / `delete_graph_edge`.

#### `list_memories`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `granularity` | enum | No | `daily` \| `weekly` \| `monthly` \| `yearly` \| `significant` — omit to list across all tiers |
| `limit` | number | No | Max entries to return (default 50, max 200) |

Calls `memory_list` server-side. Useful for browsing recent entries or locating an entry's date/key before calling `update_memory` or `delete_memory`. Does not require a search query.

#### `read_memory`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `granularity` | enum | Yes | `daily` \| `weekly` \| `monthly` \| `yearly` \| `significant` |
| `date` | string | Yes | Date of the entry (`YYYY-MM-DD` for daily/weekly/monthly/yearly). **Significant memories use the composite key `YYYY-MM-DD_slug`** — the same format `save_memory` returns and `list_memories` shows. |

Calls `memory_read` server-side. Returns the full verbatim body of the entry. Use this before quoting, updating, or carefully reasoning over a specific entry's contents; for topic-based recall the `[Memory]` block in context already surfaces relevant excerpts.

#### The by-id memory tools (`read_memory_by_id`, `move_memory_date`, `update_memory_by_id`, `delete_memory_by_id`)

| Tool | Parameter | Type | Required | Description |
|---|---|---|---|---|
| `read_memory_by_id` | `id` | string | Yes | The memory id, from a `recall` or `list_memories` result |
| `move_memory_date` | `id` | string | Yes | The memory id to move |
| | `date` | string | Yes | The correct calendar day, `YYYY-MM-DD` |
| `update_memory_by_id` | `id` | string | Yes | The memory id to correct |
| | `content` | string | Yes | Full new contents — REPLACES the entry |
| `delete_memory_by_id` | `id` | string | Yes | The memory id to delete |

These exist because a whole conversation's extracted facts land on a single date, so the by-date `update_memory` / `delete_memory` can't single one out — they target journal-bucket / significant entries. The `id` always lands on the exact entry and **rides in on `recall` and `list_memories` results**, so the Familiar already holds it. `move_memory_date` is for facts brought in from older conversations that all defaulted into today's bucket: it re-files an entry to the day it really belongs to, changing only the day, not the content. `update_memory_by_id` and `delete_memory_by_id` auto-snapshot Phylactery first.

#### `create_graph_node`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `label` | string | Yes | Display name of the entity, e.g. `"Dr. Okafor"`, `"the allotment"`, `"Aria (cat)"` |
| `type` | string | No | Entity type, e.g. `"person"`, `"place"`, `"project"`, `"pet"`, `"organisation"` |
| `description` | string | No | Short note on who/what this is, in first-person voice |

Check `find_graph_node` first to avoid creating a duplicate with a slightly different label. Returns the new node's id; use it immediately with `create_graph_edge` to wire relationships.

#### `create_graph_edge`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `fromId` | string | Yes | Graph id of the source node (the relationship's subject) |
| `toId` | string | Yes | Graph id of the target node (the relationship's object) |
| `type` | string | Yes | Relationship type as a short verb phrase, e.g. `"is_therapist_of"`, `"lives_in"`, `"works_with"` |
| `weight` | number | No | Confidence/strength in [0, 1] |

Both endpoints must already exist — resolve or create them with `find_graph_node` / `create_graph_node` first. For a relationship that has ended, delete or re-type the edge rather than leaving a false one standing.

#### `update_memory`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `granularity` | enum | Yes | `daily` \| `weekly` \| `monthly` \| `yearly` \| `significant` |
| `date`        | string | Yes | Date of the entry, in the format it was stored (e.g. `YYYY-MM-DD` for daily). **Significant memories use the composite key `YYYY-MM-DD_slug`** (as returned by `save_memory` and shown in memory listings) so the right milestone file is targeted. |
| `content`     | string | Yes | Full new contents — REPLACES the entry |

Auto-snapshots Phylactery, then calls `memory_update` (the composite key is split into separate `date` + `slug` parameters). Use to correct an inaccuracy in a journal-bucket or significant entry. To correct a single per-fact memory (which shares its date with the rest of a day's facts), use `update_memory_by_id`. To record a change that has historical value, use `save_memory` instead so the old version is preserved.

#### `delete_memory`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `granularity` | enum | Yes | Memory tier |
| `date`        | string | Yes | Date of the entry to delete. Significant memories use the composite key `YYYY-MM-DD_slug`. |

Auto-snapshots, then calls `memory_delete`. Reserve for fully wrong / obsolete journal-bucket or significant entries; for a single per-fact memory, use `delete_memory_by_id`.

#### `rewrite_identity_section`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `category` | enum | Yes | `self` \| `user` \| `relationship` \| `custom` |
| `filename` | string | Yes | Target file, e.g. `user_notes.md` |
| `section`  | string | Yes | The markdown heading of the section (without leading `#`s), e.g. `"Sleep patterns"` |
| `content`  | string | Yes | Full new body for that section, in first-person voice |

Auto-snapshots, then calls `identity_rewrite_section`. For adding facts, use `update_identity` (append) instead.

#### `update_graph_node`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id`          | string | Yes | Node id (from earlier graph context) |
| `label`       | string | No | New display label |
| `description` | string | No | New description |
| `audience`    | string | No | How widely the node may surface: a circle name (e.g. `"Family"`, `"Close friends"`) to open it to that circle, or `"ward-private"` to keep it to just {{user}} and the Familiar |

Auto-snapshots, then calls `graph_node_update`. Omit fields you want to leave unchanged.

#### `delete_graph_node`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | Yes | Node id |

Auto-snapshots, then calls `graph_node_delete`. Deletes all edges attached to the node. For "they're no longer at Y" use `delete_graph_edge` instead — the node still exists.

#### `update_graph_edge`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id`     | string | Yes | Edge id |
| `type`   | string | No | New relationship type |
| `weight` | number | No | New strength in [0, 1] |

Auto-snapshots, then calls `graph_edge_update`. For a relationship that USED to be true and is now false, delete instead.

#### `delete_graph_edge`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | Yes | Edge id |

Auto-snapshots, then calls `graph_edge_delete`. Both endpoint nodes remain.

---

### Crisis Outreach Tools

These three tools let the Familiar act during a live conversation when the user is actively present but clearly in danger. They are distinct from the **silence-triage loop**, which fires only when the user is quiet. The Familiar is expected to use judgment — these tools come with weighted guidance in their descriptions to make false alarms costly to reach for.

The suggested sequence is: **`show_crisis_resources`** first (no prerequisites, always appropriate), then **`get_trusted_contacts`** to see who is available, then **`contact_trusted_person`** only when the Familiar genuinely believes human presence is needed.

#### `get_trusted_contacts`

No parameters. Reads `trustedContacts` from `settings.json` server-side. Returns names and channels only; webhook URLs are never exposed to the model.

#### `contact_trusted_person`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Exact name of the contact, as returned by `get_trusted_contacts` |
| `message` | string | Yes | 1–3 sentences to that person. Identify yourself as the user's Familiar; describe what you've observed. Specific, honest, not sensationalised. |

Delivers via `cerebellum.deliverToTrustedContact`. Delivery is **immediate** (unlike the silence-triage's deferred escalation path). On success or failure, an `outbound_alert` is enqueued to the user's outbox — injected into their chat and pushed to their own Discord webhook when configured. The user always sees exactly what was sent.

#### `show_crisis_resources`

No parameters. Enqueues a `crisis_resources` outbox item containing links to international hotlines (988/Crisis Text Line/Samaritans/Lifeline AU/findahelpline.com); it appears as a chat message (and push). Deduplicated to one item per hour so repeated calls during a single conversation don't flood the queue.

---

## Custom Tools

Paste a JSON array of [OpenAI function-calling](https://platform.openai.com/docs/guides/function-calling) tool definitions into the **Custom tools** field in the sidebar:

```json
[
  {
    "type": "function",
    "function": {
      "name": "my_tool",
      "description": "Does something useful.",
      "parameters": {
        "type": "object",
        "properties": {
          "input": { "type": "string", "description": "The input value." }
        },
        "required": ["input"]
      }
    }
  }
]
```

Custom tools are **advertise-only**: the model sees them and may call them, but no executor exists — calls return a structured *"advertised but has no implementation yet"* result into the loop. Use them to let the model *describe* what it would do. (A real extension point is flagged as post-MVP work — see the "Custom tools — advertise-only" design note in [`architecture.md`](architecture.md).)

To wire real logic for a tool today, add a definition to `BUILTIN_TOOLS` and a matching entry to `TOOL_EXECUTORS` in `cerebellum.js`:

```js
export const TOOL_EXECUTORS = {
  // ... existing built-ins ...
  my_tool: ({ input }) => `Result for: ${input}`,
};
```

The executor function receives `(args, ctx)` — the parsed arguments object plus per-request context — and must return a string (or a value that will be stringified). Executors never throw into the chat path: any error becomes a structured failure string the model reads.

---

## The Execution Loop

The loop runs **inside the server's `/api/chat` handling** — one HTTP request per user message, no matter how many rounds the model takes. Internal provider re-calls don't count against the chat rate limit.

```
POST /api/chat  { runToolLoop: true, customTools, sessionInfo, ... }
        │
        ▼  server composes tools = BUILTIN_TOOLS + customTools
Provider responds with finish_reason: "tool_calls"?
   │
   ├── YES
   │     │
   │     ▼
   │   For each tool call in the response:
   │     └── cerebellum.executeToolCall()   (TOOL_EXECUTORS, or the
   │         "no implementation" notice for custom/unknown tools)
   │     │
   │     ▼
   │   Emit a `_toolRound` SSE event (streaming) / collect into the
   │   `_toolRounds` array (non-streaming) — the browser renders the
   │   collapsible call/result block from this
   │     │
   │     ▼
   │   Append assistant message (with tool_calls) + tool result
   │   messages; re-append the [Now] time anchor as the LAST message
   │     │
   │     └── Re-call the provider (round += 1), up to MAX_TOOL_ROUNDS (5)
   │
   └── NO (normal text response, or 5 rounds exhausted)
         │
         ▼
       Stream/return the final response → browser renders + saves history
```

After 5 rounds without a `stop` finish reason, the last assistant reply is used as-is. A mid-loop upstream failure surfaces to the streaming client as a `_loopError` event, which the app treats like any failed request (retry / fallback ladder).

---

## Chat Rendering

Tool-call rounds are displayed as compact, collapsible blocks in the chat showing:
- Tool name
- Arguments (formatted JSON)
- Result

These blocks are included in session logs but **stripped from Markdown exports**.

---

## Request Shape

When tool use is enabled, the app's request to `/api/chat` includes:

```json
{
  "runToolLoop": true,
  "customTools": [ ...userDefinedTools ],
  "sessionInfo": { "startedAt": "...", "messageCount": 12, "provider": "zai", "model": "...", "elapsedMsSinceLastMessage": 4200 }
}
```

The server composes the upstream `tools` array (built-ins + custom) and sets `tool_choice: "auto"`. `sessionInfo` backs the `get_session_info` tool.

Direct API callers that pass their own `tools` / `tool_choice` fields (without `runToolLoop`) get the legacy passthrough: both fields are forwarded verbatim to the provider, a single round runs, and tool results are the caller's responsibility.
