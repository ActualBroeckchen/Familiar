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

- **Knowledge-graph entry editor.** Proto-Familiar surfaces the
  entity-core knowledge graph in every enriched prompt (the "Relevant
  Knowledge from Graph" section, populated via `graph_node_search` +
  1-hop `graph_subgraph` in `thalamus.js`), but there is no UI to
  view, edit, or delete those entries. When a node or edge goes stale
  ("Chen is on vacation" long after Chen returned), the only fix is to
  poke at entity-core's SQLite store directly or wait for whatever
  consolidation it does. Sketch: a "Graph" tab in the sidebar that
  lists nodes (label, type, description, confidence) with edges
  expanded inline, plus rename / delete / re-describe actions backed
  by entity-core MCP tools (the existing `graph_node_search`,
  `graph_subgraph`, and whatever update/delete tools the server
  exposes — check `packages/entity-core/src/tools/graph.ts` for the
  current surface before designing). Memory-file editing (the markdown
  files under `data/memories/`) could share the same panel.

