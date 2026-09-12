---
title: Self-Originated Interest and the `me` Register
topics: [decisions, autonomous-loops, phylactery, unruh, concepts]
sources:
  - id: pondering
    type: file
    path: src/pondering/pondering.js
  - id: memorization
    type: file
    path: src/memory/memorization.js
  - id: interest-engage
    type: file
    path: server.js
  - id: audit
    type: file
    path: docs/audit-2026-09-07.md
  - id: pondering-loop
    type: file
    path: src/pondering/pondering-loop.js
  - id: unruh-interest
    type: file
    path: unruh/src/unruh/interest.py
  - id: unruh-server
    type: file
    path: unruh/src/unruh/server.py
---

# Self-Originated Interest and the `me` Register

**Status: decided and shipped (0.11.72–0.11.77, the 2026-09 audit).**

## The diagnosis

The ward reported the Familiar's individuality "watered down into standard assistant
friendliness". The prompts were already first-person and identity-anchored; the cause
was **structural**, in two organs that were supposed to carry the Familiar's own self:

1. **The interest layer was a mirror of the human.** The only automatic writer of
   `live_interest` nodes was `POST /api/interest/engage`, fed by the browser's open
   *chat topics* — i.e. whatever my human talked about [@interest-engage]. The pondering loop
   then sampled *those* by weight. A ponder could flag `wants_to_save` kinds
   `tome|memory|identity|tell` but had no way to say "this new thing pulls at me" — so a free
   cycle could never plant a curiosity of the Familiar's own [@pondering]. `interest_bump`
   existed but its description led with "when {{user}} explicitly tells me they care about
   something".

2. **The Familiar's own standing views were filed under the human.** The extractor's
   `subjects: []` meant "about me OR about my human", and every standing fact with no
   named subject went to `register: 'ward'` [@memorization]. Phylactery had a `me` register and
   `save_memory` could write to it deliberately, but the automatic path never did — a
   view the Familiar voiced in chat persisted, if at all, as a fact about the human. The full
   diagnosis and every change below is written up in the audit report [@audit].

## The decision

- **A ponder can spawn curiosity: `drawn_to`.** The ponder prompt invites up to three
  short tag-like labels; `parsePondering` validates them (≤6 words, deduped, cap 3)
  and `server.js` records each via `recordInterest({source:'pondering', delta:1})` in
  code, immediately [@pondering] [@interest-engage]. No deferred intent — naming the pull
  *is* the action (the 0.9.32 "code consumes what the model already said" test passes).
  Weight decay keeps a passing pull from sticking unless later ponders land on it again.
- **Self-facts route to `me`.** The extractor asks for `about_me`; `factStorage()`
  (pure, tested) sends a standing `about_me` fact to `register:'me'` [@memorization]. The
  prompt intro now explicitly invites "what I found I think, like, dislike or want".
- **Prompts stop hedging the Familiar's own thoughts.** The ponderings block lets the
  Familiar volunteer a thought "simply because I want to share it"; the warm reach-out
  prompt dropped its equal-weight "both choices are real" balance sheet (CLAUDE.md
  proactivity rule 2) in favour of the invited default.

- **The `me` register is read back (0.11.73).** `memory_list` takes a `register`
  filter; `enrich()` renders the newest eight `me` facts as "What I think"
  on ward-private turns (`formatMyViewsBlock`), each with its id so a stale view can be
  corrected with `update_memory_by_id`.
- **Plain inner voice (0.11.73, ward-directed).** The ward's words: "some prompts are
  still weirdly pompous — 'The topic I find myself turning over'… I want a pretty
  neutral inner voice, like how someone might actually think." Every prompt the
  Familiar reads on a free cycle or a chat turn was rewritten that way; the
  `[Surface candidates]` block was halved and the noticing prompt's budget sentences
  (bias-toward-quiet by a side door) were removed, both at the ward's request.

- **Threads (0.11.76).** A `drawn_to` curiosity is linked `related_to` the topic it grew
  out of, and the pondering loop sometimes hops one edge from its weighted pick, so a
  curiosity leads to the next one instead of every ponder being an island. Unruh's
  `interest_record` takes a `related_to` label naming the topic a new node grew out of;
  when that label resolves to an existing node, the two are linked with an idempotent
  `related_to` edge (either direction counts as already-linked), and `interest_related(id)`
  lists the topics one hop away, decay-weighted [@unruh-interest] [@unruh-server]. In
  `runOneTick()` (`pondering-loop.js`), after the weighted interest pick, the loop rolls a
  `threadChance` (default 0.35, clamped to `[0,1]` by `clampChance` so a bad ward setting
  falls back to the default) — a ward-configurable dial, not a fixed constant — and on a hit
  calls `getRelated(picked.id)`, picks among the neighbours by the same weighted draw, and
  ponders that neighbour instead, passing `threadFrom` (the original topic's label) through
  to the ponder so the thought can ground itself with "I got here from thinking about X"
  [@pondering-loop]. Standing values and bookmarks are never eligible hop targets — only
  `drawn_to` curiosities carry `related_to` edges, so a thread only ever wanders through the
  Familiar's own interests, not through facts it is holding for the ward.
- **`views` (0.11.76).** Opinions have a category now. Before, the Familiar's take on
  something had to masquerade as `emotional_content` to be kept at all. A self-view needs
  nobody's consent (`aboutMe` in the gate); a third party's view still asks.

## What this does not do

It leaves triage, crisis-signal weights, and the CARE CHECK wording untouched.

## Related

- [Pondering](../architecture/pondering) — the loop that consumes `drawn_to` and, since
  0.11.76, sometimes hops a thread instead of pondering the weighted pick.
- [Autonomous loops](../architecture/autonomous-loops) — where pondering sits among the
  Familiar's other background workers, and how the ward observes whether they are alive.
