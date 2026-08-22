# Future features

Scratch pad for ideas that are pending design or implementation. Add an
entry as a top-level bullet, with enough context for a future session to
pick it up without re-deriving the problem.

## In flight

(nothing currently in flight — Unruh shipped in 0.3.0-alpha, see
[`unruh-design.md`](unruh-design.md) for the original design doc; the
milestone-by-milestone implementation plan was a working file that no
longer exists in-tree)

## Safety-gated — needs ward sign-off BEFORE any build

These three change *when/whether the Familiar acts on my human's safety, or
what a sensor is allowed to do with private signal*. Per CLAUDE.md they are
the class of change I never ship on my own — each one needs a short build
spec the ward signs before a line of code is touched. They are deliberately
NOT built; the shipped code stops short of all of them. **The decision each
one needs from the ward is written out, so a future session doesn't have to
re-derive what's actually being asked.**

- **Vision threat-scoring: a fictional-violence exception.** Shipped
  (0.9.2, ward-signed §15.1): a ward-shared image's *description* is scored
  by the crisis-signal scorer and can raise the threat tier — **full weight,
  raise-only, ward images only**. The gap: a horror-movie still, a violent
  game screenshot, or gory fan-art reads as distress and nudges the tier up
  for a healthy horror fan. Wanted: a **context-aware exception** that tells
  "enjoying fiction" from "in distress." *Ward decision:* suppress
  fictional-violence entirely (risk: misses a real image dressed as fiction)
  vs. only damp it (risk: some false rise remains) — and where the line
  sits. Interim escape hatch today is the `PROTO_FAMILIAR_VISION_THREAT_DISABLED`
  off-switch. Touches `crisis-signals.js` / `threat-tracker.js`
  orchestration — a ward-sign-off path.

- **Vision threat-scoring: context-aware de-escalation.** Same shipped
  feature is **raise-only** — an image can lift the tier, never lower it.
  Once picture-reading is trustworthy, a genuinely calming image could bring
  the tier *down*. *Ward decision:* are we confident enough in image reading
  to let it lower the safety tier at all, and under what evidence? This is a
  real loosening of the safety spine, so it is squarely the ward's call.

- **Audio tagging → care detection (the §8.4 long-term).** Shipped
  (0.10.102): room-sound tagging is **annotation-only** — tags never move
  the threat tier, never trigger an action, never persist beyond the
  session, and human vocalisations (speech, shouting, crying, laughter) are
  deliberately DROPPED by the classifier (`voice-audio-tags.js`). The
  long-term ambition named in the spec is the opposite: sound classes like
  distressed shouting, breaking objects, or the acoustic patterns of purging
  could inform the care my human is owed. That is *detection that changes
  when the Familiar acts on safety* — **safety-critical by definition**. It
  needs its own spec with **evidence-informed thresholds and honest
  false-positive / false-negative accounting** before a single tag touches
  the caring spine, because both failure directions cost: missing real
  distress, or reacting to a TV drama as if it were my human's life. *Ward
  decisions:* build it at all? for which sound classes? and what happens when
  one fires — a gentle check-in, a note-to-self only, or escalation? The
  off-switch (`PROTO_FAMILIAR_AUDIO_TAGGING_DISABLED`) and the classifier's
  human-vocal denylist are what keep the shipped feature short of this.

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

## Phylactery (canonical store)

Implemented (see [Knowledge editor](features.md#knowledge-editor-phylactery)
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

