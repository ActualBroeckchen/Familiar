---
title: "Session Memorization: Durable Server-Side Queue"
topics: [decisions, memorization]
sources:
  - id: memorization-js
    type: file
    path: src/memory/memorization.js
  - id: sessions-doc
    type: file
    path: docs/sessions.md
  - id: claude-md
    type: file
    path: CLAUDE.md
  - id: debug-session
    type: conversation
    path: scratchpad/session-memorization-debug.md
    note: "Development session that diagnosed the pre-fix memorizeSessionToTome() bug and recorded the user's rationale at each design decision. NOTE (0.8.55 audit): this scratchpad file is not in the repository — citation preserved for provenance, but the source itself is no longer retrievable."
---

# Session Memorization: Durable Server-Side Queue

**Status: decided, implemented.** Session memorization — turning a chat session into durable
Tome entries — was rebuilt from a fire-and-forget client function into a durable server-side
job queue with retry, after a report that "the tome with memories keeps disappearing" traced
to four compounding bugs in the old `memorizeSessionToTome()` [@debug-session]
[@memorization-js]. This page records why the fix took the shape it did, including the
choices the user made explicitly over cheaper alternatives, because that reasoning is not
recoverable from the code or from [the resulting architecture](../architecture/session-memorization)
alone.

## Context

The pre-fix `memorizeSessionToTome()` in `public/app.js` had four independent failure points,
all present at once [@debug-session]:

1. Every error path was swallowed — the function ended in a catch block that discarded any
   error, plus several bare early returns on a bad LLM response — so a failed save produced no
   user-visible signal at all.
2. The call fired without `await` *after* `startNewSession()` had already started the next
   session, racing a 10-30 second LLM round trip against the user closing the tab or the
   3-hour idle rollover finishing first.
3. The entries write read the target Tome file, then wrote the whole `entries` object back —
   a read-modify-write race that could clobber a concurrent edit from another tab.
4. The save target was `state.tomeRegistry.filter(t => t.enabled)[0]` — whichever Tome
   happened to sort first — so reordering, renaming, or disabling Tomes silently moved where
   memories went.

Asked whether the "N entries memorized" toast appears when memories go missing, the user's
answer was: "It usually happens when the software is closed or the session rolls over due to
the 3 hour timeframe being hit." [@debug-session] That answer pointed at failure points 1 and
2 — silent errors racing tab-close/session-rollover — as the actual loss mechanism, not at
wrong-tome targeting (failure point 4), which is a discoverability problem rather than a data
loss.

## Decision

**Target: a dedicated, name-addressed Tome.** Rather than "whichever Tome the user marks
default" or keeping the existing "first enabled Tome" behavior, every memorization job writes
to a Tome named `Session Memories`, auto-created on first use and found by name thereafter,
now the fixed save target for every automatic and manual memorization path in the shipped
system [@memorization-js] [@sessions-doc]. This was chosen because a fixed, named target is predictable and survives
Tome reordering or disabling — the user should not have to keep some other Tome "first" or
"enabled" for memorization to keep working [@debug-session].

**Triggers: the offered set, plus one the user added.** The triggers considered were the
existing 3-hour idle timeout and manual Clear, plus two new ones: an on-demand "Memorize now"
button and a `beforeunload` capture for tab-close. The user selected all of these, and also
wrote in a trigger that was not on the list: memorization should fire when a Topic is marked
finished, not only at whole-session boundaries [@debug-session]. The stated reasoning was that
Topics already represent semantically complete slices of conversation, and treating topic-end
as its own memorization boundary avoids waiting for the whole session — which can run for
hours — to capture a topic that has already resolved [@debug-session]. This is now the
topic-end trigger described in [Session memorization](../architecture/session-memorization).

**Scope: the largest option offered.** Given four options ranging from "surface errors only"
to "server-side queue with retry," the user picked the queue, explicitly over the cheaper
"just fix the read-modify-write race" or "move the save server-side without a queue" options
[@debug-session]. The reasoning: the actual failure mode is tab-close or session-rollover
racing a slow LLM call, and only a durable, server-owned queue actually closes that gap —
anything still keyed to the browser's lifetime, even a synchronous server call triggered from
the client, is vulnerable to the same race if the request itself does not survive the tab
closing [@debug-session]. This is why `beforeunload` pairs with `navigator.sendBeacon`
specifically: the *enqueue* call has to survive unload, and the LLM work itself has to survive
the browser being gone entirely — a plain synchronous request would not [@debug-session]. This
choice is a specific instance of the repo's general priority order of robust fixes over cheap
ones, which explicitly names "smallest change that closes the symptom" and "quick patch for
now, revisit later" as anti-patterns to avoid when framing a fix [@claude-md], and of the
graceful-degradation rule that a failure that matters must be observable rather than silently
swallowed [@claude-md] — see [Engineering conventions](../reference/engineering-conventions).
The swallowed errors in the old implementation were exactly the failure mode that rule exists
to prevent.

**Two implementation choices approved without change.** Before building, the assistant
flagged two risks and the user approved both as proposed [@debug-session]:

1. The queue's on-disk JSON file stores the job's API key in plain form, because the worker
   needs it to resume in-flight jobs across a server restart. This was accepted as an
   extension of the project's existing local-only trust model — `/api/*` has no auth, and
   `logs/` and `tomes/` are already unauthenticated local files — not a new class of risk, with
   the explicit caveat that it should be revisited if the server is ever exposed beyond
   localhost [@debug-session] [@memorization-js].
2. Topic-scoped memorization reuses the same whole-session LLM prompt, fed only the topic's
   message slice, rather than a second, more focused prompt written just for topics. This was
   accepted as sufficient on the reasoning that a shorter input alone yields fewer, more
   focused entries without needing prompt-level tuning [@debug-session].

## Consequences

The queue, its backoff schedule, the dedicated Tome, the trigger set, and the endpoints that
implement this decision are described in
[Session memorization](../architecture/session-memorization). Two capabilities have since been
layered on top of this queue rather than folded into this decision: day-anchored segmentation
(memorizing a session in per-calendar-date slices) and a consent gate on sensitive categories
before a fact is written [@memorization-js]. Both reuse the same queue and retry mechanics this
decision established; neither changes the dedicated-tome target, the trigger set, or the
API-key-on-disk posture recorded here.

The API-key-on-disk posture is a standing item to revisit if Proto-Familiar's server is ever
exposed beyond localhost — the decision explicitly does not hold if the trust boundary that
justified it changes [@debug-session].
