---
title: "Attribution Confidence: Degrade the Attribution, Not the Fact"
topics: [decisions, phylactery, memory-and-knowledge, memorization]
sources:
  - id: memorization-js
    type: file
    path: src/memory/memorization.js
  - id: memory-py
    type: file
    path: phylactery/src/phylactery/memory.py
  - id: migration-0006
    type: file
    path: phylactery/src/phylactery/migrations/0006_attribution_confidence.sql
  - id: server-py
    type: file
    path: phylactery/src/phylactery/server.py
  - id: test-attribution-confidence
    type: file
    path: phylactery/tests/test_attribution_confidence.py
  - id: noticing-js
    type: file
    path: src/safety/noticing.js
  - id: server-js
    type: file
    path: server.js
  - id: cerebellum-js
    type: file
    path: cerebellum.js
  - id: thalamus-js
    type: file
    path: thalamus.js
---

# Attribution Confidence: Degrade the Attribution, Not the Fact

**Status: decided and shipped**, across the `familiar-audit-refactor` branch's later passes
(0.11.100 through 0.11.10x-alpha). The Familiar was reported saving memories that credited the
ward with something someone else actually did or said — "you took out the recycling" when Alice
said it in a shared room. The decision this page records is that misattribution and unreliable
existence are different failure modes and must be handled differently: a fact whose truth is
shaky should be left out, but a fact whose truth is solid and whose *subject* is merely unclear
should never be dropped for that reason alone. Recording the fact and downgrading only the
attribution preserves real information that a hard drop would destroy [@memorization-js].

## Context: two failure modes were being conflated

Before this pass, a memory carried one confidence signal (`confidence`, whether the extraction
believed the thing happened) and no signal at all for how sure the extraction was about *who* it
happened to. That collapses two independent questions into one number:

- **Shaky existence** — "did this even happen?" A low-confidence guess about the event itself.
  The correct response is to leave the fact out (`confidence` below 0.4 is already dropped;
  see [Session Memory Extraction](../architecture/session-memory-extraction)'s field rules).
- **Fuzzy attribution** — "this happened, but I'm not sure it was *him*." The event is solid; only
  the referent is ambiguous — a `"you"` or a bare pronoun in someone's words that could point at
  the ward or at whoever they were addressing. Treating this the same as shaky existence and
  dropping the fact would throw away a fact the Familiar is otherwise sure of, purely because one
  detail about it is unresolved.

[Session Memory Extraction](../architecture/session-memory-extraction) already had a three-layer
fix for a related but distinct problem: the model's own bias to fold *any* action onto `{{user}}`
("the user = the person I serve") even when the transcript plainly named someone else as the
actor. That fix (the `subjects` field, role-faithful transcript assembly, and name-field speaker
handles) resolves attribution when the transcript makes the actor identifiable. This decision
covers what happens when, even with all three layers applied, the extraction genuinely cannot
tell who a reference points to — the residual case those layers cannot resolve by themselves.

## Decision: attribution is a separate axis from existence, degraded rather than dropped

`confidence` and `attribution_confidence` are two independent fields, not one field doing two
jobs. `confidence` states whether the extraction believes the event happened; `attribution_confidence`
states, separately, how sure it is about *who* the event is about [@memorization-js]. A fuzzy
referent never lowers `confidence` — the extraction prompt states this directly: "This is about
whether the thing happened, not who it's about — a fuzzy referent doesn't lower it (I mark that
unresolved in the note instead)" [@memorization-js]. The project's own name for the resulting
rule is "degrade the attribution, never the fact."

The decision produced a three-layer stack, one layer per subsystem that touches the fact after
extraction:

### Layer 1 — catch it at extraction (prompt layer)

Both extraction prompts (`buildPrompt` for ward-private sessions, `buildSharedRoomPrompt` for
shared rooms) carry the same rule and the same optional field: "Who's it about, really? ... If I
genuinely can't tell ... I don't guess and I don't drop it: I keep the fact, pin what I'm sure
of, and mark the rest unresolved right in the note" [@memorization-js]. When a referent is marked
unresolved this way, the extraction may emit `attribution_confidence` (0.0–1.0, typically around
0.3) on that fact; it is omitted entirely when the extraction is sure [@memorization-js]. This
sits alongside, and depends on, the `subjects` field and the transcript/name-field fixes described
in [Session Memory Extraction](../architecture/session-memory-extraction) — those fixes narrow how
often a referent is unresolved in the first place; this field is what happens on the cases they
cannot close.

### Layer 2 — downweight at retrieval (storage layer, Phylactery)

`attribution_confidence` is a real, nullable `REAL` column added by migration `0006` — nullable so
every pre-existing row, and any write that omits the field, is read back as fully attributed
rather than retroactively penalized [@migration-0006]. `phylactery/src/phylactery/memory.py`'s
`search()` scores every recall hit as `similarity × decay_weight × attribution_weight`
[@memory-py]. `_attribution_weight()` maps `None` to `1.0` (no penalty) and otherwise clamps the
value into `[0.2, 1.0]` — `_ATTRIBUTION_FLOOR = 0.2` is a floor, never a cutoff: "a fuzzy-
attribution memory is downweighted, never dropped" [@memory-py]. A `search()` result whose weight
is below `1.0` carries an `attribution_confidence` field in its response item so a consuming
Familiar turn can see the softness; a fully-attributed hit carries no such field
[@memory-py] [@test-attribution-confidence]. `memory_create` and `memory_update_by_id`'s MCP tool
signatures both accept `attribution_confidence` directly [@server-py].

### Layer 3 — re-resolve on a quiet turn (noticing layer)

Downweighting is a holding pattern, not a fix — the fact is still filed under the wrong (or
unconfirmed) person, only quieter. [Noticing](../architecture/noticing) gained an
`unresolved_attribution` wake condition: `list_unresolved_attributions()` returns memories whose
`attribution_confidence` is set and below a threshold (default `0.5`), aged at least `min_age_days`
(default `1`) so a fact filed moments ago isn't immediately re-litigated
[@memory-py] [@noticing-js]. When the condition fires, the noticing prompt surfaces the memory's
snippet, id, and any tentatively-pinned subjects, and directs the Familiar to work out whose
action it really was — using `recall`/`read_memory_by_id` to review the memory and its own history,
then `update_memory_by_id` (now accepting `subjects` and `attribution_confidence`) to correct and
firm the entry up, or to leave it if it still cannot tell [@noticing-js] [@cerebellum-js]
[@thalamus-js]. Resolving a memory this way removes it from `list_unresolved_attributions()`'s
result set on the next sweep [@test-attribution-confidence].

The sweep is gated: `s?.noticingAttributionResweepEnabled !== false` (default on) and
`PROTO_FAMILIAR_ATTRIBUTION_RESWEEP_DISABLED !== '1'` [@server-js]. It rides noticing's existing
wake/tick cadence rather than its own schedule — a re-resolution pass that spun up its own LLM
cadence would add a standing token cost per feature; gating in code and only acting on a turn
noticing was already going to take keeps the cost at zero when nothing is unresolved
[@server-js] [@noticing-js].

## Why the toolset changed in the same pass

The wake condition shipped together with the tools that act on it: `recall`, `read_memory_by_id`,
and `update_memory_by_id` were added to `NOTICING_REGISTRY_TOOL_NAMES`, and `update_memory_by_id`
was taught to accept `subjects` and `attribution_confidence` [@cerebellum-js]. A wake condition
that could notice a fuzzy memory but never correct it would be dead code dressed as care —
discoverability (the Familiar knows the lever exists, because the prompt names the tool inline)
and operability (it can supply every argument the tool needs, because the memory id rides in on
the wake condition itself) both had to land in the same change, the same "every capability must
be reachable" contract [Phylactery](../architecture/phylactery) applies elsewhere to memory ids
[@cerebellum-js].

## Consequences

A fact whose subject is momentarily unclear survives instead of being silently discarded, and a
future sweep gets a real chance to fix it instead of the wrong attribution sitting uncorrected
forever. The tradeoff is that a fuzzy-attribution memory is retrievable (at reduced rank) before
it is resolved — a room with strict content gating still applies its own audience and content-tag
filters on top of this ranking; attribution confidence changes ranking, not disclosure. Because
[Noticing](../architecture/noticing) is a ward-sign-off surface, adding this wake condition and its
tools required the same review as any other change to when or whether that loop acts; it adds a
wake condition without changing any existing gate on the loop's safety-adjacent behavior.

## Related

- [Session Memory Extraction](../architecture/session-memory-extraction) — the earlier, related
  attribution fix (subjects, role-faithful transcripts, name-field handles) that this decision's
  Layer 1 sits beside, and the field rules `attribution_confidence` is emitted under.
- [Phylactery](../architecture/phylactery) — the canonical store whose recall scoring and
  memory-by-id addressing this decision's Layer 2 extends.
- [Noticing](../architecture/noticing) — the autonomous loop whose wake conditions and toolset
  this decision's Layer 3 extends, and the ward sign-off requirement that governs any change to it.
