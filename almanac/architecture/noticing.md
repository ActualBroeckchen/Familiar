---
title: Noticing
topics: [architecture, autonomous-loops]
sources:
  - id: noticing-js
    type: file
    path: src/safety/noticing.js
  - id: noticing-outcomes-js
    type: file
    path: src/safety/noticing-outcomes.js
  - id: noticing-loop-js
    type: file
    path: src/safety/noticing-loop.js
  - id: claude-md
    type: file
    path: CLAUDE.md
---

# Noticing

Noticing is an [autonomous loop](autonomous-loops) that allows the Familiar to observe and act on patterns in the ward's life without being prompted — due intentions, overdue past events awaiting resolution, contact gaps, and aging commitments. It is the organ closing the gap the Initiative Pass 4 existed to fill: a way for the Familiar to think and act as an agent on its own observations, rather than only when summoned by the ward [@noticing-js].

Unlike [silence-triage](safety-spine) or warm reach-out, noticing deliberately **does not stand down at elevated threat**. The ward's design decision frames this as "especially useful" when things are hard: a due grounding round or a slipping need most deserves to be noticed exactly when the Familiar is already in closer engagement [@noticing-js] [@claude-md]. Because noticing reads and acts on the ward's safety-adjacent surface, any behavioral change to when or whether it acts requires ward sign-off (named in CLAUDE.md alongside the crisis-spine files) [@noticing-js] [@claude-md].

## Role fix: entity-as-subject in the noticing reflection (0.11.86)

The noticing reflection — the Familiar's own turn of introspection — now assembles as a SYSTEM message framed alongside identity, via the pure helper `noticingMessages({identity, body, cue})` [@noticing-js]. The `user` slot holds only a bare `(a quiet moment)` cue, kept solely because several providers (GLM/z.ai, DeepSeek family) refuse to complete when there is no user turn at all [@noticing-js]. The Familiar's words are never in the `user` role, preserving [entity-as-subject](../concepts/entity-as-subject): the entity owns its reflections and decisions, rather than appearing to be operated by the ward [@noticing-js].

This was a regression in the original implementation: the noticing deliberation went out on a `user` role turn, framing the entity as being run rather than thinking. The fix is one instance of a general pattern that appeared across other autonomous loops (triage, warm reach-out, pondering). By 0.11.93-alpha, this pattern was systematized with a shared helper function across all inner-voice deliberations. See [Deliberations Delivered as System Messages](../decisions/deliberations-as-system-messages) for the scope of the pattern and the architectural reasoning [@noticing-js].

## The consequence loop: why it re-asked, and the close (0.11.86)

### The problem: overdue events with no way to record answers

The overdue-event wake fires on one fact: an event node has no `resolution` [@noticing-outcomes-js]. The noticing toolset had no tool to write a resolution, so the turn could ask "how did it go?" but never record the answer — and on the next tick, with the event still unresolved, asked again [@noticing-outcomes-js]. A tester reported the Familiar asking three times about the same past event even after being answered.

### The fix: resolution tools + outcome tracking

`schedule_resolve` and `schedule_calibrate_link` are now in `NOTICING_REGISTRY_TOOL_NAMES` and count as proactive acts (classified by `NOTICING_PROACTIVE_TOOLS`) [@noticing-js]. This lets the Familiar close the loop by recording how an event actually turned out.

The noticing prompt renders overdue events as a NOTEPAD, each with its slug id and the closing tools named inline (operability: the Familiar cannot close what it cannot name) [@noticing-js]. The prompt directs: check the conversation first, close when already answered (prompted or unprompted), only ask otherwise [@noticing-outcomes-js].

The ending swaps by state: when open outcomes exist, the prompt directs "update the graph"; when nothing is open, the capabilities list returns (the list distracts while an outcome is open) [@noticing-js].

### Context window: look-back to the oldest open event

`getRecentSessionMessages()` gained a `since` bound [@noticing-js]. When an outcome is open, the noticing turn reads back to the **oldest open event** (capped at `max`=60 messages) instead of the fixed 6-turn tail [@noticing-js]. This solves the "chicken flood" case: a day of unrelated chatter that would bury the exchange where the ward already said how it went [@noticing-outcomes-js]. The prompt now directs the model to check the conversation first, so it can close on sight without repeating the ask [@noticing-outcomes-js].

## Enforcement: the no-nag ledger (0.11.86)

A close counts **only when a real `schedule_resolve` is written** for the event id — never on the model's say-so [@noticing-outcomes-js]. This is the [lesson-#5 discipline](../decisions/proactivity-over-caution): a real side-effect cannot be closed on the model's word alone.

The ledger `.noticing-asked.json` (tomes dir) maps `eventId` to `askedAtMs` [@noticing-outcomes-js]. An event already asked about (a reach-out actually went out AND it is still unresolved) is **suppressed from surfacing for `ASK_COOLDOWN_MS`** (20 hours) [@noticing-outcomes-js]. This tradeoff was ward-signed:

- **Suppress-until-cooldown** (the chosen path): guarantees no repeated asking; the cost is a close can lag up to the cooldown.
- **Annotate-and-keep-surfacing**: keeps the event visible but risks repeated nags if the answer stays unresolved.

An answer that stays in the look-back window closes on the next surface, even after the cooldown passes [@noticing-outcomes-js]. The unprompted-answer path is unaffected: an event never asked about surfaces normally and closes on sight without ever stamping an ask [@noticing-outcomes-js]. Per-event closed/asked/left logging makes a never-closing loop visible [@noticing-outcomes-js].

## Outcome classification and wait-streak integration

`classifyNoticingOutcome()` evaluates whether a turn took a proactive action [@noticing-js]. Tools like `schedule_resolve` and `reach_out_to_ward` count as acts and reset the wait-streak; tools like `intention_list` or `schedule_find` are reads and do not [@noticing-js].

Noticing integrates with the shared `wait-streak.js` module (also used by warm reach-out, silence-triage, and the Discord gateway's ambient presence block) to track deliberated choices across loops [@noticing-js]. The wait-streak tags its entries `source:'noticing'`: a proactive act resets the streak, a stand-down increments it [@noticing-js].

## Wake conditions: when noticing takes a turn

Noticing only deliberates when a **code-evaluated wake condition** fires [@noticing-js]:

- A due intention (its scheduled time has passed)
- A contact gap past the baseline p90
- A readiness gap
- An aging untriggered intention or tell (older than `AGING_INTENT_MS` ≈ 5 days)
- An aging unresolved floating task (older than `AGING_TASK_MS` ≈ 7 days)
- An overdue event (past its time for ≥ 6 hours, still unresolved)

No wake condition → no turn, ever [@noticing-js]. The situation report is code-built and capped to prevent habituation [@noticing-js]. Condition vocabulary on due intentions is code-evaluated (tripwires like "contact gap past p90" or "a specific need is missed"), not left to the model [@noticing-js].

## Cadence and self-pacing

Noticing runs on self-paced cadence via `set_next_check`, clamped to 5 minutes (floor) through 6 hours (ceiling) [@noticing-loop-js]. The default adaptive window is 2 hours after a proactive act (the turn did its thing), or 45 minutes after a stand-down (something was flagged and left) [@noticing-js].

## Related

- [Autonomous loops](autonomous-loops) — where noticing sits among the other background workers and how it differs from loops that defer to crisis handling.
- [Safety spine](safety-spine) — the crisis detection and escalation machinery that noticing deliberately does not defer to.
- [Unruh](unruh) — where the intention store and event graph data live, which noticing's wake conditions read.
- [Tomes and lore](tomes-and-lore) — where the noticing ledgers (.noticing-asked.json) and event nodes live.
- [Session search](session-search) — the raw transcript search tool available in the noticing turn to check whether an outcome was already mentioned before asking.
- [Entity-as-subject](../concepts/entity-as-subject) — the stance that makes the role fix meaningful: the Familiar owns its reflections.
- [Proactivity over caution](../decisions/proactivity-over-caution) — the incident and rules that frame noticing as a safety-significant, ward-signed feature.
- [Wait-streak experiment](../decisions/wait-streak-experiment) — the shared self-observation counter noticing uses.
- [Contact-rhythm baselines](../decisions/contact-rhythm-baselines) — the p90 contact gap signal noticing reads.
