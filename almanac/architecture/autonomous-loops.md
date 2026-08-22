---
title: Autonomous Loops
topics: [architecture, autonomous-loops]
sources:
  - id: claude-md
    type: file
    path: CLAUDE.md
  - id: architecture-doc
    type: file
    path: docs/architecture.md
  - id: content-regate-loop
    type: file
    path: content-regate-loop.js
  - id: media-retention-loop
    type: file
    path: media-retention-loop.js
---

# Autonomous Loops

Autonomous loops are background workers that run alongside Proto-Familiar's HTTP server and
act without a human request — checking in during silence, firing a reminder, drifting off to
ponder an interest, syncing a calendar, curating an old voice clip. CLAUDE.md counts thirteen of
them, each booted in `server.js`'s `app.listen()` callback and each stopped from the
SIGTERM/SIGINT/SIGHUP handler so a clean shutdown can await any in-flight tick [@claude-md]
[@architecture-doc]. Loops exist
because the Familiar is designed to be a companion who can reach out, not a request-response
tool — see [Proactivity over caution](../decisions/proactivity-over-caution) for why that
design choice is treated as safety-critical rather than a nice-to-have. The reminders and
event-alert loops specifically are the delivery mechanism for
[temporal assurance](../concepts/temporal-assurance): reaching out unprompted is the whole
point, not an optional enhancement over a passive calendar view.

## The shared contract

Every loop follows the same shape, stated in CLAUDE.md as a rule rather than a habit
[@claude-md]:

- **A settings toggle plus a hard `PROTO_FAMILIAR_*_DISABLED=1` environment off-switch**,
  shipped in the same commit as the loop itself — "we can add the switch later" is not an
  acceptable state to ship in [@claude-md].
- **Independent failure.** A loop crashing, or a peer it depends on being down, must never
  surface as an error in the human's live conversation. `enrich()`'s `Promise.allSettled`
  fan-out and `executeToolCall()`'s never-throw contract are the mechanisms underneath this
  guarantee — see [Architecture](../architecture) for how thalamus and cerebellum enforce it
  [@claude-md].
- **Reentrancy guards and a graceful stop.** A loop tracks whether a tick is in flight and a
  `stop*()` call awaits it rather than killing it mid-write.

## The loops

| Loop | File | Cadence | Default | Off-switch |
|---|---|---|---|---|
| Pondering | `pondering-loop.js` | tiered by interest weight + threat (30min–6h) | on | `PROTO_FAMILIAR_PONDERING_DISABLED=1` |
| Reminders + event alerts | `reminders-loop.js` + `event-alerts.js` | 30s poll | on | `PROTO_FAMILIAR_REMINDERS_DISABLED=1` / `PROTO_FAMILIAR_EVENT_ALERTS_DISABLED=1` |
| Silence triage | `silence-triage-loop.js` | 5min, LLM-set cool-down | on | `PROTO_FAMILIAR_TRIAGE_DISABLED=1` |
| Warm reach-out | `reachout-loop.js` + `reachout.js` | 10min, ~2h cool-down | on | `PROTO_FAMILIAR_WARMTH_DISABLED=1` |
| Noticing | `noticing-loop.js` + `noticing.js` | self-paced via `set_next_check`, clamped 5min–6h | on | `PROTO_FAMILIAR_NOTICING_DISABLED=1` |
| Discord gateway | `discord-gateway.js` | 30s supervisor | on (idles without a bot token) | `PROTO_FAMILIAR_DISCORD_DISABLED=1` |
| Memorization | `memorization.js` | 5s queue drain | on | `PROTO_FAMILIAR_MEMORIZE_DISABLED=1` |
| Memory sweep | `memory-sweep-loop.js` | 10min | on | `PROTO_FAMILIAR_MEMORY_SWEEP_DISABLED=1` |
| Tome → Phylactery graduation | `tome-graduation-loop.js` | 30min | **off** | `PROTO_FAMILIAR_TOME_GRADUATION_DISABLED=1` |
| Needs tracking | `needs-tracking-loop.js` | 30min | **off** | `PROTO_FAMILIAR_NEEDS_TRACKING_DISABLED=1` |
| Google Calendar sync | `gcal-sync-loop.js` | 60s base tick, ward-configurable interval | **off** | `PROTO_FAMILIAR_GCAL_DISABLED=1` |
| Content re-gate | `content-regate-loop.js` | 30min | **off** | `PROTO_FAMILIAR_CONTENT_REGATE_DISABLED=1` |
| Media retention | `media-retention-loop.js` | ~6h | on | `PROTO_FAMILIAR_MEDIA_RETENTION_DISABLED=1` |

Content re-gate and media retention are the two most recently added loops, both from later
milestone work (content-gating Phase B and the voice milestone's Pass 4 respectively) and are
easy to miss when skimming `server.js`'s boot list because they are opt-in or slow-ticking rather
than chat-path-adjacent [@content-regate-loop] [@media-retention-loop]. Content re-gate re-tags
the ward's own existing private facts against the content-sensitivity scheme in
[Content-based memory gating](content-gating) once the ward opts in via "Review my private notes
for content-sharing," batching an LLM judgment over facts written before that gate existed and
writing every change to a disclosure notice the ward reads [@content-regate-loop]. Media
retention curates aged voice clips on a ~daily cadence, deciding only whether the *sound* of an
old exchange is kept — the transcript always survives — so a wrong "let go" costs disk, not
memory [@media-retention-loop]. Like every loop that reads threat state, it defers during a live
call and at moderate-or-higher threat, because the crisis machinery owns that moment; see
[Safety spine](safety-spine).

(Sourced from CLAUDE.md's "Autonomous loops" section and `docs/architecture.md`'s
autonomous-loop boot list [@claude-md] [@architecture-doc]. Stewardship and the weekly
routine review are related but are *not* standalone loops: stewardship rides `enrich()` on
every chat turn, and the routine review rides an existing pondering reflection tick, rather
than owning a `setInterval` of its own [@architecture-doc].)

## Loops that write to the canonical self default off

Tome graduation and needs tracking are opt-in because they write to
[Phylactery](phylactery), the canonical self — the milestone note in CLAUDE.md treats writes
to canonical state as requiring an explicit ward decision, not a shipped default
[@architecture-doc]. Google Calendar sync is opt-in for a related but distinct reason: it is
the one loop that can eventually reach an external service the ward's real calendar depends
on, and its write-back path (`schedule_push_to_google`) is gated behind its own separate
opt-in on top of the loop being enabled at all [@architecture-doc].

## Loops that defer to crisis handling

Warm reach-out and needs tracking both stand down entirely once the ward's threat tier
reaches moderate or higher, so they never compete with silence-triage for the moment that
matters [@architecture-doc]. This is deliberately the opposite failure direction from the
incident recorded in
[Proactivity over caution](../decisions/proactivity-over-caution) — deferring a
companionship signal in favor of the crisis loop is adding caution in a place that costs
nothing, not the "bias toward staying quiet" pattern that caused real harm when it leaked
into the *safety* decision itself.

Noticing is the deliberate exception: it is ward-signed to **not** stand down at elevated
threat, on the reasoning that an aging intention or a widening contact gap is "especially
useful" to surface exactly when things are hard, not something to suppress [@claude-md]. Threat
still shifts its *register* — moderate-or-higher renders a tier line in the deliberation prompt,
and a genuinely alarming read is handed to triage rather than answered with a casual reach-out —
but the turn itself is never skipped. Because it acts on the ward's safety-adjacent surface, any
change to when or whether noticing acts requires the same sign-off as the triage files
[@claude-md].

## Shared self-observation: the wait-streak line

Warm reach-out, silence triage, the Discord gateway's ambient presence block, and — since
Initiative Pass 4 — noticing all consume the same small module, `wait-streak.js`, rather than
each tracking their own sense of "how long has it been since I acted." It is not itself a loop —
it has no `setInterval` of its own — but a persistent counter that each of those loops'
deliberation ticks reads from and writes to, recording only waits and resets that were an
explicit, offered choice [Wait-streak experiment](../decisions/wait-streak-experiment). Noticing
tags its entries `source:'noticing'`: a proactive act resets the streak, a stand-down increments
it, the same contract the wait-streak decision page defines for the original three consumers. It
exists because an earlier
version of the warm reach-out prompt asserted "nothing is wrong" as an axiom on every tick, which
let a real two-day silence read as fine by definition; the decision page covers both that prompt
fix and the counter it motivated.

A second, similarly loop-less module rides below the same silence line in the warm reach-out
prompt: `contact-baselines.js` derives median/p90/longest contact gaps per ward-local
weekday-class from session logs and reports nothing until roughly two weeks of history exist —
see [Contact-rhythm baselines](../decisions/contact-rhythm-baselines) for the conservative
ward-contact signal and the honesty rule that gates it.

## Related

- [Pondering](pondering) — the autonomous thought loop, its cadence, and the `read_pondering` tool.
- [Safety spine](safety-spine) — the crisis-detection and escalation machinery
  silence-triage sits on top of.
- [Content-based memory gating](content-gating) — the sensitivity scheme content re-gate
  re-applies to facts written before it existed.
- [Voice](voice) — the milestone media retention shipped as part of, and the disk-footprint
  budget it protects.
- [Proactivity over caution](../decisions/proactivity-over-caution) — why these loops default
  to acting rather than waiting.
- [Wait-streak experiment](../decisions/wait-streak-experiment) — the warm reach-out prompt fix
  and the shared self-observation counter described above.
- [Contact-rhythm baselines](../decisions/contact-rhythm-baselines) — the computed sense of
  normal contact rhythm that rides below the wait-streak line in the same prompt.
- [Engineering conventions](../reference/engineering-conventions) — the graceful-degradation
  and versioning rules that every loop above is written to follow.
- [Per-feature model routing](../decisions/per-feature-model-routing) — how several of these
  loops (pondering, triage, warm reach-out, tome graduation) each resolve their own LLM
  connection independent of the ward's chat connection.
- [Local process over VM/Docker sandboxing](../decisions/local-process-over-vm-sandboxing) — why
  these loops all run inside one continuously-running Node process rather than a separate
  always-on listener waking heavier components lazily.
