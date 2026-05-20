# Future features

Scratch pad for ideas that are pending design or implementation. Add an
entry as a top-level bullet, with enough context for a future session to
pick it up without re-deriving the problem.

## In flight

- **Unruh — temporal-context cognitive module.** Sibling specialist to
  entity-core, gives the Familiar a meaningful relationship with time
  (schedule + interests as two graph layers, intent handoff at session
  boundaries, decay-based weight tracking, proactive messaging). Live
  work happens on the `Unruh` branch; design in
  [`unruh-design.md`](unruh-design.md), milestone-by-milestone plan in
  [`unruh-implementation-plan.md`](unruh-implementation-plan.md). M1+M2
  (process skeleton + Thalamus second-peer wiring) shipped; M3 onward
  is the next pickup point.

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

Implemented (see [Knowledge editor](features.md#knowledge-editor-entity-core)
and [Tool Calling](tool-calling.md#built-in-tools)): a Knowledge editor
modal with Memories / Graph / Identity / Snapshots tabs, plus the seven
LLM-callable editing tools (`update_memory`, `delete_memory`,
`rewrite_identity_section`, `update_graph_node`, `delete_graph_node`,
`update_graph_edge`, `delete_graph_edge`). Auto-snapshot before every
destructive op, plus a manual "create snapshot now" button and one-click
restore from the Snapshots tab.

Open follow-ups for this area, if/when they earn their slot:

- **Memory diff view on supersede.** When the user clicks "Supersede
  with today's date" in the Memories tab, show the old vs. new content
  side by side before committing — easier to confirm the contradiction
  reads cleanly.

- **Identity top-of-file editing.** The Identity tab currently shows
  pre-heading content as read-only ("(top)") because the underlying
  `identity_rewrite_section` tool needs a heading to target. Either add
  an `identity_write` round-trip that preserves headings, or change the
  on-disk convention so every identity file starts with a heading.

- **Surface snapshots' bytes/age and what they captured.** The Snapshots
  list currently shows just id + createdAt. Pulling in the snapshot's
  size and the (date, op) of the most recent destructive call that
  preceded it would make "which snapshot do I restore?" much easier.

