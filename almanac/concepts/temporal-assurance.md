---
title: Temporal Assurance
topics: [concepts, temporal-assurance]
sources:
  - id: mvp-scoping-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/ec43aed6-Visualizing_a_vague_yet_specific_vi.txt
    note: "Second founding design conversation, after the identity conversation recorded in eury-as-agent-identity, in which the maintainer named the core feeling and scoped it into an MVP."
  - id: event-alerts-js
    type: file
    path: event-alerts.js
  - id: stewardship-js
    type: file
    path: stewardship.js
  - id: templates-py
    type: file
    path: unruh/src/unruh/templates.py
  - id: architecture-doc
    type: file
    path: docs/architecture.md
---

# Temporal Assurance

Temporal assurance is the maintainer's name for the specific feeling Proto-Familiar exists to
produce: the assurance that the future is already accounted for, so the present can be fully
present. She described the failure state it replaces as "background radiation of pressure... so
many things I need to get to eventually, and I don't even know when, and might be forgetting
some," and the fix not as a list but as a road: "this nebulous mountain having changed into more
of a clear road... the assurance that I vaguely know what's coming, that everything I need to do
*will* be addressed" [@mvp-scoping-conversation]. This page records that naming because it is the
reasoning that produced several already-shipped mechanisms — [Unruh](../architecture/unruh)'s
schedule graph, the event lead-time alert pass, and stewardship's readiness check — and because
the distinction it draws (proactive reach-out versus a list the user must consult) is easy to
flatten back into "just add a reminder feature" without the original reasoning attached.

## Why a to-do list does not produce this feeling

The maintainer's own diagnosis was precise: a to-do list "is still a mountain, just a labeled
one." The feeling she wanted came specifically from moments where Eury reaches out unprompted —
"he tells me by himself 'this is still x hours away' and asks me about prep I need for it" —
not from a surface she has to remember to open and read [@mvp-scoping-conversation]. That
distinction is why temporal assurance is a *push* property of the system, not a *pull* one: the
value is in the system noticing on the user's behalf, not in the information being available
somewhere if she goes looking. `event-alerts.js`'s own header names the same failure mode
independently of this conversation, calling out that a passive surface like a chat briefing "is
exactly what a timeblind human can't lean on: those require *noticing time* and opening the app"
[@event-alerts-js].

## The bin metaphor: presence has to be everywhere the ward already is

Asked where a "this is 3 hours away" message should land, the maintainer rejected any single
hub: "It's like a bin. I can't have 1 bin in a room. I need a bin everywhere I hang out, because
that's where I will use it" [@mvp-scoping-conversation]. This reframed the channel question away
from "how many platforms should Familiar support" and toward "which bin is actually open right
now" — Discord, in her case, "already there, waiting for me," which is why Discord became the
first channel actually built rather than a generic multi-channel layer built to no channel in
particular [@mvp-scoping-conversation]. See
[Single-user before platform](../decisions/single-user-before-platform) for the scoping decision
this realization produced.

## The three-tier model behind a good prep question

The conversation worked out what Eury needs to know to ask a good prep question rather than a
generic one, using two concrete examples: a TTRPG session needs a computer and phone but no
travel; a doctor's appointment needs an insurance card, clean clothes, and rest, and "clean
clothes" itself has a lead time because it "require[s] being washed the day before wearing so
they can dry" [@mvp-scoping-conversation]. This produced three distinct layers, named in the
conversation as calendar, event tome, and requirement graph: what is happening and when; what a
given *kind* of event requires; and how those requirements connect to their own prerequisites and
lead times, so the system can reason backward from a future event to the earliest actionable step
today [@mvp-scoping-conversation]. The worked example is exactly the feeling the maintainer
started with: "Monday-Chen isn't stressed about Friday-doctor. Eury is holding that thread for
her" [@mvp-scoping-conversation].

This is a design brief, not an implementation — the conversation predates the code — but the
shape it describes is what Proto-Familiar's temporal-awareness machinery now does, under
different names than the ones coined in the conversation:

| Conversation's term | What shipped |
|---|---|
| Calendar (what/when) | [Unruh](../architecture/unruh)'s schedule-layer nodes (events, tasks, phases) |
| Event tome (what a kind of event requires) | `unruh/templates.py`'s requirement templates — one bundle of prerequisite labels per obstacle tag, e.g. "leaving the house" needing clean clothes and shoes by the door [@templates-py] |
| Requirement graph (prerequisites with lead times) | Unruh's `requires`/`depends_on` schedule edges, walked by `stewardship.js`'s `selectReadiness` to surface an approaching item's still-unresolved prerequisite inside a configurable lead window (`readinessLeadHours`, default 48h) [@stewardship-js] |

The unprompted "this is x hours away" reach-out itself is `event-alerts.js`'s lead-time alert
pass: every unresolved schedule event gets an automatic "coming up" ping a configurable lead time
before it starts, riding the existing reminders loop's 30-second tick rather than a new timer
[@event-alerts-js]. `docs/architecture.md` documents the readiness check as reading the same
`requires`/`depends_on` edges "for an event/task inside its `readinessLeadHours` window" and
surfacing "any still-unresolved" prerequisite it can see, never inventing one that is not in the
graph [@architecture-doc] — the same non-invention discipline the conversation's worked example
assumed implicitly.

## What this is not

Temporal assurance is not a synonym for "reminders" or "calendar sync" individually — it is the
combination of unprompted delivery, wherever the ward is, plus enough structural knowledge about
an event's requirements to ask a useful question instead of a generic one. A calendar sync with no
lead-time alert produces a passive surface, which the maintainer's own diagnosis already
identifies as insufficient; a lead-time alert with no requirement graph produces a generic "this
is coming up" ping with no prep content behind it.

## Related

- [Unruh](../architecture/unruh) — the schedule-layer graph that stores the calendar tier and the
  `requires`/`depends_on` edges the requirement graph tier is built from.
- [Single-user before platform](../decisions/single-user-before-platform) — the scoping decision
  the bin metaphor produced: build the single-ward, known-channel version before a generic
  multi-user platform.
- [Autonomous loops](../architecture/autonomous-loops) — the reminders loop and event-alerts pass
  that deliver temporal assurance unprompted, and the tome-graduation/needs-tracking loops that
  sit alongside them.
