# Future features

Scratch pad for ideas that are pending design or implementation. Add an
entry as a top-level bullet, with enough context for a future session to
pick it up without re-deriving the problem.

## Memory entries

- **Time-code on memory entries.** Memory entries (Tome entries written
  by the session/topic summarizer) should carry a visible time code in
  the UI — at minimum the source session's start, ideally also the
  message-range timestamps. Today only `created_at` and `learnedAt` are
  stored; neither is surfaced in the Tome Manager rows. Decide whether
  to render the existing `learnedAt`, add a new "session time" field on
  the entry, or both.

- **Category button for memory entries.** A per-entry category field
  (e.g. mood / event / preference / situation) selected from a small
  fixed set, shown as a colored chip in the manager and filterable.
  Need to decide: is this a free-form tag or a closed enum, does the
  summarizer pick it or only the user, and does it affect activation
  (e.g. weight or scope) or only display.

## Entity-Core

Entity-core already exposes the full read/write surface for identity,
memory, and graph over MCP — see `packages/entity-core/src/server.ts`
for the registered tools (memory_create / read / update / delete /
consolidate; identity_write / append / prepend / update_section /
rewrite_section / delete_custom / set_meta; graph_node_*, graph_edge_*,
graph_write_transaction, etc.). Proto-Familiar surfaces only three of
these to the Familiar today: `save_to_tome`, `save_memory` (wraps
memory_create), and `update_identity` (wraps identity_append). Two
mostly-orthogonal directions:

- **Expand the Familiar's tool set.** Add LLM-callable wrappers for the
  destructive / mutating tools the Familiar would need to self-correct
  stale state — at minimum `memory_update`, `memory_delete`,
  `identity_rewrite_section`, and a small graph-editing subset
  (`graph_node_update`, `graph_node_delete`, `graph_edge_delete`). Each
  needs a careful description: when to use it, when not. Tradeoff: more
  power means more chances for an over-confident model to delete
  something the user wanted to keep — consider a per-tool confirmation
  toggle, an undo via snapshot_create before destructive ops, or
  gating destructive tools behind an explicit user-set flag.

- **User-facing editor UI.** A "Graph / Memories" tab in the sidebar
  that lists nodes (label, type, description, confidence) with edges
  expanded inline, lists memory entries by granularity/date, and exposes
  rename / re-describe / delete actions backed by the existing
  entity-core MCP tools. Same panel could surface a "supersede" action
  that writes a new memory dated today that contradicts the stale one
  (the recency-decay scoring will then bury the stale entry without
  losing the audit trail). Adding this on top of the tool-set expansion
  gives the user direct manual control as a safety net for whatever
  the Familiar does on its own.

