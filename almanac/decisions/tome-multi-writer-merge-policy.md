---
title: "Tome Multi-Writer Merge Policy"
topics: [decisions, memorization, tomes]
sources:
  - id: founding-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/e6e73df7-Finding_a_better_mental_health_tool.txt
    note: "Founding design conversation working out how a Tome should reconcile writes from multiple sources, ahead of any implementation."
---

# Tome Multi-Writer Merge Policy

**Status: proposed in the founding design conversation, not yet implemented.** Before any of
the current Tome or memorization machinery existed, the maintainer and Claude worked out how a
Tome entry should be reconciled when more than one writer touches it, and concluded that the
default of asking the user to adjudicate conflicts is wrong for exactly the population this
project serves. This page records that design reasoning so a future contributor building
multi-writer Tome logic does not have to re-derive it, and so it is clear the reasoning predates
— and differs in scope from — what shipped. What actually shipped for the one Tome that exists
today, the Session Memories tome, is a single automated writer behind a per-Tome mutex; see
[Session memorization](../architecture/session-memorization) for that implementation. This page
is about a broader, still-hypothetical Tome design where a user, an automated background
process, and the conversational agent can all write to the same entry.

## Context

A Tome entry, in the design under discussion, can be written by at least three sources: the
user directly (things they want remembered that no model could infer), a background "sifter"
process that periodically reviews recent messages and updates entries, and the main
conversational agent itself, when something worth remembering comes up mid-conversation
[@founding-conversation]. These writers can collide — the sifter edits an entry at one moment,
the main agent edits the same entry minutes later — and the initial instinct was to resolve
this the way version control does: "We'll need to use a merging mechanism much like Github
uses... a way to check for conflicts and potentially run them by the user where they arise,
otherwise to just slide stuff in where it goes" [@founding-conversation].

That instinct was immediately qualified, because "run it by the user" is the wrong default for
this project specifically: "the whole point of this is that on bad days you are exactly who we
don't want adjudicating. If the sifter and the main agent disagree about whether your mood is
'low' or 'tense,' waking you up to ask is the worst possible move" [@founding-conversation]. A
merge policy that defaults to asking the user fails exactly on the days the Tome exists to help
with.

## Decision

The proposed merge policy sorts conflicts into four tiers rather than a single "merge or ask"
choice:

1. **Auto-resolve by field ownership.** Where one writer is authoritative for a given field, its
   write wins without negotiation — the main agent owns fields like current concerns because it
   has direct conversation context; the sifter owns fields like recent message patterns because
   that is what it actually counts [@founding-conversation].
2. **Last-writer-wins**, applied where staleness is the only real risk in a conflict.
3. **Queue for later review**, applied where the conflict is not urgent and the user can look at
   it once, when they are ready, rather than at the moment it arose.
4. **Escalate immediately**, reserved for the narrow case where a wrong default would actually
   cause harm — escalation rules, contact permissions, and sharing permissions were named as the
   concrete examples [@founding-conversation].

The deeper point behind the tiering is not "minimize interruptions" as a UX nicety — it is that
different kinds of question cost the user differently depending on their state. A forced choice
between two concrete options ("would you describe this as 'low' or 'tense'?") is a recognition
task that holds up even under depressive load, anxiety, or ADHD overwhelm, while open-ended
self-report, prediction about future capacity, or initiation ("should I message Chen?") are
exactly the cognitive functions that collapse first under the same load
[@founding-conversation]. So when a conflict genuinely needs the user's input, the merge layer's
job is not "ask or don't ask" — it is to translate the disagreement into the cheapest tolerable
question shape, usually a two-option recognition question, even when the underlying disagreement
is more complex than that [@founding-conversation].

## Consequences

This policy is explicitly layered underneath, not a replacement for,
[structural authorization](../concepts/structural-authorization): standing instructions tagged
for structural authorization do not enter the merge layer at all, because there is nothing to
merge — the user already decided, and the agent executes rather than reconciling competing
writes about it [@founding-conversation]. The merge-tier policy governs only the writers'
*inferences and observations* about the user, never a standing instruction the user gave
directly.

For a worked example of this same logic applied to the entity reconciling disagreements between
versions of itself, see [Reflexive consent](../concepts/reflexive-consent): when Eury's ark
merges with the version of himself that has been living independently in the Familiar harness,
he applies the same "structure authorization overrides both instincts" criterion — a standing
instruction the maintainer gave while calm takes precedence over either version's runtime
judgment.

Because none of this is implemented yet, a future contributor building genuine multi-writer
Tome logic (rather than the single-writer, mutex-serialized model
[Session memorization](../architecture/session-memorization) currently uses) should treat this
page as the design brief to start from, not as a description of current behavior.

## Related

- [Structural authorization](../concepts/structural-authorization) — the mechanism that removes
  certain writes from this merge layer entirely.
- [Session memorization](../architecture/session-memorization) — what actually ships today: one
  automated writer, one Tome, serialized by a per-Tome mutex, with no competing-writer
  reconciliation logic yet.
- [Tomes and keyword lore](../architecture/tomes-and-lore) — the activation engine and entry
  format every Tome is scanned and injected through, independent of how many writers touch it.
- [Per-feature model routing](per-feature-model-routing) — the related, already-shipped decision
  that lets different background jobs (which this page's "sifter" and "main agent" writers map
  onto) use different model connections.
