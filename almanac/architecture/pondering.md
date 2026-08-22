---
title: Pondering
topics: [architecture, autonomous-loops, pondering]
sources:
  - id: pondering-loop-js
    type: file
    path: pondering-loop.js
  - id: recent-ponderings-js
    type: file
    path: recent-ponderings.js
  - id: cerebellum-js
    type: file
    path: cerebellum.js
  - id: tool-surfacing-js
    type: file
    path: tool-surfacing.js
  - id: autonomous-loops-doc
    type: file
    path: docs/architecture.md
  - id: pondering-js
    type: file
    path: pondering.js
  - id: ponder-research-js
    type: file
    path: ponder-research.js
---

# Pondering

The pondering loop is an autonomous worker that thinks aloud (in the Familiar's voice, not the ward's chat) about topics it is currently oriented toward, at a cadence weighted by interest and threat level [@pondering-loop-js]. Unlike triage or reminders, pondering is not prompted by external events or chat turns — it fires on its own, at the Familiar's initiative, carrying the [proactivity](../decisions/proactivity-over-caution) principle into background thought [@autonomous-loops-doc]. Ponderings are per-embodiment (not routed through [Phylactery](phylactery) canonical storage) and are surfaced on demand via the `read_pondering(uid)` tool [@cerebellum-js].

## One thought per tick

Each pondering tick generates one thought — a single, focused reflection on a topic, captured as one line in the `[Ponderings]` briefing block that appears in every turn's prompt [@pondering-loop-js]. This was a deliberate design choice to keep ponderings high-signal rather than verbose [@autonomous-loops-doc]. The one-line format is strict: the full thought is available on demand via the `read_pondering(uid)` tool for ward curiosity, but the default briefing appearance is summary-level.

The structured shape of a thought record is:

```json
{
  "uid": "unique-id",
  "topic": "topic-slug",
  "thought": "One-line summary of the reflection",
  "full_text": "The complete pondering (may be multiple sentences or paragraphs)",
  "created_at": "ISO timestamp",
  "cadence": "30m|1h|2h|6h"  // Last computed cadence based on interest weight
}
```

The one-line summary is what appears in the briefing; the full text is available via `read_pondering(uid)` for the Familiar to re-read on the ward's request or for the ward to inspect what the Familiar has been pondering about [@recent-ponderings-js].

## Cadence: interest-weighted and threat-gated

The pondering loop runs on a tiered cadence, NOT a fixed interval [@autonomous-loops-doc]. The cadence is computed from two inputs:

1. **Interest weight** — how much attention is currently oriented toward this topic [@pondering-loop-js]. Topics accrue weight from token volume, persistence across consecutive messages, and surviving session boundaries; weight decays over time.
2. **Threat level** — the scalar from [Unruh](../architecture/unruh) that drives urgency [@autonomous-loops-doc]. When threat reaches moderate or higher, pondering stands down entirely (along with warmth and needs-tracking) to defer to [silence triage](../architecture/safety-spine).

The cadence tiers are: 30 minutes (high interest), 1 hour, 2 hours, and 6 hours (low interest, background noise). A topic with very low interest still ponders, but only every 6 hours [@autonomous-loops-doc].

## The `read_pondering` tool

`read_pondering(uid)` is a cerebellum tool (surfaced as a 'core' tool in every embodiment) that returns the full text of a saved pondering [@cerebellum-js] [@tool-surfacing-js]. This lets the ward ask "what have you been thinking about?" or the Familiar to re-read a past reflection if it wants to build on it. The tool takes a `uid` (the saved pondering's unique id, available in the briefing line), looks up the full record, and returns `{ uid, topic, thought, full_text, created_at }` [@cerebellum-js].

Because ponderings are per-embodiment and stored locally (in `recent-ponderings.js` memory or in a local sqlite table), `read_pondering` is synchronous and never calls out to Phylactery [@cerebellum-js].

## Looking things up before writing (Pass 4, 0.11.7)

`ponderOnce()` (`pondering.js`) can research a topic before it writes the thought, instead of
only recombining what the Familiar already holds [@pondering-js]. The gate runs only for an
interest ponder — never a reflection-mode tick — and requires `settings.ponderWebEnabled` (default
true), `settings.webSearchEnabled` true, and the env off-switch
`PROTO_FAMILIAR_PONDER_WEB_DISABLED` unset [@pondering-js]. When it fires, `ponderOnce()` calls
`researchForPonder()` from [Browser](browser)'s `ponder-research.js`, then folds the result into
`buildPonderPrompt()`'s `sourcesText` argument: either a cited-sources block naming what was
found, or — when the shared daily read budget is spent — an honest line saying the Familiar is
thinking from what it already holds rather than looking anything up [@pondering-js]
[@ponder-research-js]. A research failure is swallowed and treated as "no sources this ponder,"
since the lookup is best-effort and must never turn a background thought into a failed tick
[@pondering-js].

This research call is the one place a pondering tick reaches outside the Familiar's own stored
context, and it runs read-only and code-bounded for that reason — see
[Browser milestone: guardrails in code, not prompts](../decisions/browser-guardrails-in-code)'s
Pass 4 section for why the loop hands the model no tool surface at all, only the ability to name
what it wants looked up.

## Why ponderings stay per-embodiment

Ponderings are not written to Phylactery, the canonical store, because they are thoughts in progress rather than conclusions about the ward or the world [@pondering-loop-js]. A pondering is context-sensitive to the current embodiment's conversation history, interruptions, current mood, and recent focus. The thought "I wonder if Chen is overcommitting again" makes sense in a particular chat session or embodiment flow, not as a fact to inject into every future conversation [@autonomous-loops-doc]. Ponderings are meant to be read in the moment or on-demand via `read_pondering`, not accumulated into standing identity.

## Related

- [Autonomous loops](autonomous-loops) — the full list of loops, their cadences, and off-switches.
- [Safety spine](../architecture/safety-spine) — how pondering, warmth, and needs-tracking stand down during crisis.
- [Unruh](../architecture/unruh) — the interest and threat scoring systems that shape pondering cadence.
- [Proactivity over caution](../decisions/proactivity-over-caution) — the design principle that ponderings embody.
- [Browser: click-and-fill web access](browser) — the `ponder-research.js`/`ponder-web-budget.js`
  modules the research gate above calls, and the rest of the browser subsystem they share code
  with.
- [Browser milestone: guardrails in code, not prompts](../decisions/browser-guardrails-in-code) —
  why Pass 4's research loop hands the model no tool surface, only the ability to name a lookup.
