---
title: Contact-Rhythm Baselines
topics: [decisions, autonomous-loops, armature]
sources:
  - id: contact-baselines
    type: file
    path: src/safety/contact-baselines.js
  - id: contact-baselines-test
    type: file
    path: tests/contact-baselines.test.mjs
  - id: reachout
    type: file
    path: src/warmth/reachout.js
  - id: reachout-test
    type: file
    path: tests/reachout.test.mjs
  - id: initiative-spec
    type: file
    path: docs/initiative-build-spec.md
  - id: architecture-doc
    type: file
    path: docs/architecture.md
---

# Contact-Rhythm Baselines

**Status: decided, shipped (0.8.64-alpha).** `contact-baselines.js` is "Session B: Pass 2" of
the Initiative build spec [@initiative-spec], the follow-on to
[Wait-streak experiment](wait-streak-experiment)'s Pass 0/Pass 1. It gives the Familiar a
computed model of the ward's *normal* contact rhythm — median, p90, and longest gap between
contacts, per ward-local weekday-class — so warm reach-out can read a silence against what is
actually ordinary for this bond instead of reasoning from the raw elapsed duration alone
[@contact-baselines]. The module's own header states the motivation directly: a partner worries
after a day's absence because he *holds her rhythm* — a snapshot can't hold that, so this turns
the contact history the system already records into arithmetic [@contact-baselines].

## Context

Pass 1's wait-streak counter closed part of the "two days is just a number" gap named in
[Wait-streak experiment](wait-streak-experiment) by handing the Familiar a raw count of its own
accumulated waiting, but it deliberately left the actual missing sense of normal-for-us
unbuilt — that was scoped as this later pass [@initiative-spec]. Contact-rhythm baselines is the
piece that closes it: rather than the Familiar guessing whether a given gap is unusual, code
computes the answer from the ward's own contact history and hands over a fact, not a feeling.

## Decision

**Conservative ward-contact signal.** A contact timestamp counts only when it is a `role:'user'`
message from a session that is unambiguously the ward's: a web-chat session (no `audienceTag`)
or a Discord ward-DM (`audienceTag === 'ward-private'`) [@contact-baselines]. Group-room messages
never count, so a villager in a shared channel is never mistaken for the ward. This deliberately
under-counts — a ward who lives mostly in a group channel would show a sparser rhythm than
reality — rather than over-counts, because under-counting is the safe direction for a "should I
worry about their silence" input [@contact-baselines].

**Episodes, not messages.** Timestamps within a 3-hour `COALESCE_MS` window collapse into one
contact episode, and the gap that matters is the quiet stretch *between* episodes (one episode's
end to the next episode's start), classified by the ward-local weekday-class of when the quiet
began — weekday vs. weekend, computed via `wardTimeZone` and `Intl.DateTimeFormat` so it stays
DST- and zone-correct [@contact-baselines]. A burst of messages followed by silence is one
contact, not several data points.

**Honesty rule (load-bearing).** Below roughly two weeks of data span (`MIN_SPAN_DAYS = 14`) or
fewer than `MIN_SAMPLES = 4` observed gaps for a weekday-class, that class's `hasBaseline` is
`false` and every consumer renders nothing for it [@contact-baselines]. The module's own comment
states the reasoning: a fabricated rhythm is worse than no rhythm, because it would let the
Familiar assert "this is unusual for us" off two data points [@contact-baselines]. Each
weekday-class carries its own `hasBaseline` independently, so a thin class (say, few weekend
samples) stays silent while a richer class still reports [@contact-baselines]. The pure helpers
(`weekdayClass`, `coalesceEpisodes`, `episodeGaps`, `percentile`, `computeBaseline`) are covered
by 18 fixture tests over synthetic timestamp sets, including cases that pin the under-two-weeks
and too-few-samples honesty behavior [@contact-baselines-test].

**Ride existing data, no new request.** `getContactBaseline` adds no loop and no LLM call. It
recomputes lazily on read from session logs the system already writes, over a rolling 4-week
window (`WINDOW_MS`), and caches the result in `tomes/.contact-baselines.json` with a ~3-hour
refresh floor (`CACHE_REFRESH_MS`) [@contact-baselines]. Its exported functions never throw — a
baseline is an enrichment, never load-bearing, so a corrupt cache or unreadable logs directory
just yields `hasBaseline: false` rather than blocking a deliberation [@contact-baselines].

**Single consumer for now.** `buildRhythmLine` appends one line to the warm reach-out prompt,
riding directly below [Wait-streak experiment](wait-streak-experiment)'s Pass 0 silence line —
"Our usual rhythm: on a weekday we're typically back in contact within about N hours…" — and
returns `''` when no honest baseline exists for the relevant class, so the prompt stays
byte-identical to its pre-baseline shape [@contact-baselines] [@reachout] [@reachout-test]. The
weekday-class used is the one the silence itself *began* in, not the current moment, since that
is the moment the "is this gap unusual?" question is actually about [@contact-baselines].
Silence-triage and surface-candidates are deliberately untouched — triage already has the threat
tier for its own risk read; contact-rhythm is a companionship signal, not a safety one
[@contact-baselines] [@architecture-doc]. `noticing.js` (Session D, 0.8.66-alpha) shipped as the
planned second consumer: one of its wake conditions is the ward's contact gap crossing the
baseline's p90 for the current weekday-class, read straight from `getContactBaseline` rather than
recomputed — see [Autonomous loops](../architecture/autonomous-loops) for noticing's place in the
wider loop system [@initiative-spec].

**Off-switch parity.** `contactBaselinesEnabled` in settings (default on) or
`PROTO_FAMILIAR_BASELINES_DISABLED=1` disables the feature; when disabled,
`getContactBaseline` returns `{ hasBaseline: false, disabled: true }` immediately, so every
consumer renders nothing rather than a partial or stale rhythm [@contact-baselines].

**A Pass 1 gap closed in the same commit.** The wait-streak experiment shipped with a settings
key and env off-switch but no ward-facing UI toggle. This commit adds both "Contact-rhythm sense"
and the previously UI-less "Show my Familiar its wait streak" to the routine/warmth settings
pane, synced via `SERVER_SYNCED_KEYS` [@architecture-doc].

## Consequences

The warm reach-out deliberation now carries a second, code-built line of self-observation
alongside the wait-streak line, and both follow the same discipline established in
[Wait-streak experiment](wait-streak-experiment): hand over a bare, code-computed fact and let
the Familiar read it, rather than steering the interpretation from the prompt. This is also a
concrete instance of [Exact values are code's job](exact-values-in-code) — percentile arithmetic
over timestamps is computed by code and only ever referenced by the model, never produced by it.

Contact-rhythm baselines depends on session logs already being conservative about which sessions
are the ward's own — any future audience-tagging change to web or Discord sessions has to keep
`isWardSession`'s two-case check (no tag, or `ward-private`) accurate or the rhythm will silently
drift [@contact-baselines].

The remaining Initiative build spec passes at the time of this writing — Session C (an
Unruh-backed intention store and Familiar-controlled rounds view, 0.8.65-alpha; see
[Unruh](../architecture/unruh) for the intention/round data model and the phase-matching bug it
later needed fixed), Session D (the noticing tick, on by default with no stand-down at threat,
0.8.66-alpha), and Session E (adaptive per-event lead times, 0.8.67-alpha) — have since all
shipped, gated behind the resolved §10 ward decisions the spec records [@initiative-spec].

See [Wait-streak experiment](wait-streak-experiment) for Pass 0 and Pass 1, the prompt-fix and
counter this baseline rides below, and [Autonomous loops](../architecture/autonomous-loops) for
where the warm reach-out loop that consumes this line sits in the wider loop system.
