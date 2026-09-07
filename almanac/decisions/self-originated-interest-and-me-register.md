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
---

# Self-Originated Interest and the `me` Register

**Status: decided and shipped (0.11.72, the 2026-09 audit).**

## The diagnosis

The ward reported the Familiar's individuality "watered down into standard assistant
friendliness". The prompts were already first-person and identity-anchored; the cause
was **structural**, in two organs that were supposed to carry the Familiar's own self:

1. **The interest layer was a mirror of the human.** The only automatic writer of
   `live_interest` nodes was `POST /api/interest/engage`, fed by the browser's open
   *chat topics* — i.e. whatever my human talked about. The pondering loop then sampled
   *those* by weight. A ponder could flag `wants_to_save` kinds `tome|memory|identity|tell`
   but had no way to say "this new thing pulls at me" — so a free cycle could never
   plant a curiosity of the Familiar's own. `interest_bump` existed but its description
   led with "when {{user}} explicitly tells me they care about something".

2. **The Familiar's own standing views were filed under the human.** The extractor's
   `subjects: []` meant "about me OR about my human", and every standing fact with no
   named subject went to `register: 'ward'`. Phylactery had a `me` register and
   `save_memory` could write to it deliberately, but the automatic path never did — a
   view the Familiar voiced in chat persisted, if at all, as a fact about the human.

## The decision

- **A ponder can spawn curiosity: `drawn_to`.** The ponder prompt invites up to three
  short tag-like labels; `parsePondering` validates them (≤6 words, deduped, cap 3)
  and `server.js` records each via `recordInterest({source:'pondering', delta:1})` in
  code, immediately. No deferred intent — naming the pull *is* the action (the
  0.9.32 "code consumes what the model already said" test passes). Weight decay keeps
  a passing pull from sticking unless later ponders land on it again.
- **Self-facts route to `me`.** The extractor asks for `about_me`; `factStorage()`
  (pure, tested) sends a standing `about_me` fact to `register:'me'`. The prompt
  intro now explicitly invites "what I found I think, like, dislike or want".
- **Prompts stop hedging the Familiar's own thoughts.** The ponderings block lets the
  Familiar volunteer a thought "simply because I want to share it"; the warm reach-out
  prompt dropped its equal-weight "both choices are real" balance sheet (CLAUDE.md
  proactivity rule 2) in favour of the invited default.

## What this does not do

It does not change any ward-sign-off safety path (triage, noticing, CARE CHECK
wording). The `[Surface candidates]` block and the noticing prompt's budget sentence
are flagged for the ward in the audit report, not edited.
