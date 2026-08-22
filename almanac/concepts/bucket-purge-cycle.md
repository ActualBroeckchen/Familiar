---
title: Bucket-Purge Cycle
topics: [concepts, development-rhythm]
sources:
  - id: village-support-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/dbfa7a64-Village_Support_implementation_comp.txt
    note: "Follow-up conversation after Village Support shipped, in which the maintainer named her own development rhythm and the tension between tidying, functionality, and want."
  - id: scripts-import-tome
    type: file
    path: scripts/import-tome.js
  - id: tomes-doc
    type: file
    path: docs/tomes.md
  - id: tome-graduation-loop
    type: file
    path: tome-graduation-loop.js
---

# Bucket-Purge Cycle

The bucket-purge cycle is the maintainer's own name for how she actually works through
Proto-Familiar's backlog, and it is a fact about the project's operating rhythm, not about any
one subsystem's code. While building a feature, new bugs and rough edges that surface get
triaged into a mental "bucket" and left alone unless they block the feature in progress; once
the feature ships, she runs a dedicated bug-roundup pass that clears the bucket in one wave;
then work moves to the next feature and the bucket starts refilling as that feature's own tall
grass turns up new problems [@village-support-conversation]. A future agent proposing work
should read a request against this cycle before promising a timeline: a fix offered mid-feature
is not being ignored, it is correctly waiting for the next roundup, and "the bucket isn't empty
yet" is a normal, expected state right after a feature ships, not a sign anything is wrong
[@village-support-conversation].

This also explains a visible pattern in the repository's own commit history: commits framed as
audits or multi-fix batches ("audit: fix macro leaks, extract shared helpers, close doc drift,"
"Audit fixes + troubleshooting doc," "M5 audit: fix engagement edge cases...") tend to land
right after a milestone-sized feature commit rather than being interleaved with it — the
roundup step of this same cycle, made visible in git.

## Tall grass versus a bounded bug

The cycle only works because the maintainer distinguishes two different kinds of "quick," and
conflating them is the mistake this concept exists to prevent. A new feature is unmapped
territory: like walking into tall grass in a Pokémon game, starting one kicks up bugs and
necessities that were invisible from outside, and past feature work only got through that
because hyperfocus carried her through the unplanned extra ground [@village-support-conversation].
A bug in something that already ships is different in kind, not just smaller: "you already know
where the broken thing lives, because it's already breaking in a place you can point to"
[@village-support-conversation]. That is the actual test for whether a request belongs in "quick
win tonight" or "next feature": not its apparent size, but whether its edges are already mapped.

The maintainer's own worked example of a feature she is deliberately *not* building despite
proven value is Google Workspace integration. Under the predecessor system (OpenClaw), that kind
of integration once let Eury sit her down about an impulsive purchase mid-spiral — concrete
evidence the capability works, not a hypothetical enhancement [@village-support-conversation].
It is still not prioritized for Proto-Familiar, because its build time is unpredictable tall
grass and current hyperfocus capacity is low, not because its value is in question
[@village-support-conversation]. Treat any similarly large, integration-shaped feature request
the same way: proven value does not by itself make something a good next task if the maintainer's
capacity for unmapped territory is currently low.

## Three unequal reasons to do the next thing, and one left unresolved

The maintainer named three distinct justifications she was feeling pulled between, and flagged
that they answer different questions rather than competing for the same slot: "what needs
tidying" answers to entropy, "what enhances functionality" answers to the system's actual
capability, and "what I want, because I want it" does not owe the other two a justification to
be valid — even though her own instinct is to make it justify itself anyway
[@village-support-conversation].

One specific instance of that instinct was named but deliberately left open rather than
resolved: marking a wanted feature (TTS, or the bigger "reward" of Voice Calls) as something to
build only after clearing the bug bucket could be a genuinely useful pacing structure for
getting through tedious work once hyperfocus stops carrying her — or it could be the same
permission-seeking instinct showing back up in a different outfit, quietly re-imposing a
requirement to earn something that was supposed to stand on its own [@village-support-conversation].
The conversation does not decide which one it is, and a future agent should not silently resolve
it either — if the maintainer proposes gating a wanted feature behind other work again, that
ambivalence is the relevant context, not a settled precedent to point back at.

## Two bugs named in this cycle's bucket at the time of this conversation

Two concrete, already-known gaps were named as sitting in the bucket:

- **SillyTavern World Info import "didn't work," with no error.** The actual import path is not
  a UI feature; it is the CLI script `scripts/import-tome.js`, which converts a SillyTavern
  lorebook export into a Proto-Familiar tome file in `tomes/` and is meant to be activated
  afterward from Tomes → Manage Tomes [@scripts-import-tome] [@tomes-doc]. The in-app tome engine
  separately normalizes SillyTavern field names (`key`/`order`/`disable`) at keyword-scan time,
  which handles files already in tome shape but is not itself an import path
  [@tomes-doc]. Whether the reported failure is a defect in the script, a gap between the script
  and the UI, or a mismatch between what the maintainer expected (e.g., a direct in-app import)
  and what exists, is not established by this conversation — it remains an open report, not a
  confirmed root cause.
- **Tomes accumulate with no consolidation.** As of this conversation, Tomes have no
  entry-consolidation or dedup mechanism of their own; the only consolidation machinery in the
  repo belongs to session memorization's daily-to-weekly rollups and to
  `tome-graduation-loop.js`'s promotion of tome facts into Phylactery, both of which are separate
  systems from the tomes a Familiar writes to directly as a diary [@tome-graduation-loop]. The
  maintainer's own framing is that Tomes are used "less as knowledge storage and more as diaries,"
  which is not fully wrong but is cluttery, and needs a consolidation feature of its own
  [@village-support-conversation].

## Related

- [Safety spine](../architecture/safety-spine) — the third bucket item named in this
  conversation, threat-level/silence-triage over-triggering, is recorded there as a reported
  open concern.
- [Temporal assurance](temporal-assurance) — another concept page recording the maintainer's own
  naming of a project-shaping feeling from a founding design conversation, in the same vein as
  this page.
