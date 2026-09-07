---
title: Per-Feature Model Routing
topics: [decisions, memorization, architecture]
sources:
  - id: app-js
    type: file
    path: public/app.js
  - id: server-js
    type: file
    path: server.js
  - id: ward-connections-js
    type: file
    path: src/ward/ward-connections.js
  - id: providers-js
    type: file
    path: providers.js
  - id: founding-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/e6e73df7-Finding_a_better_mental_health_tool.txt
    note: "Founding design conversation where the maintainer proposed routing distinct jobs to distinct providers/models, ahead of any implementation."
---

# Per-Feature Model Routing

**Status: decided, implemented.** Proto-Familiar lets the ward bind each background LLM job to
its own saved connection instead of forcing every job through whichever provider the ward
chats on. `public/app.js` defines `FEATURE_CONNECTIONS`, the fixed list of jobs that call a
model outside the live chat turn — autonomous pondering, memorization and the coverage sweep,
crisis triage, warm reach-outs, and tome graduation — each with a dropdown that resolves to a
saved connection id or falls back to "Primary (default)" [@app-js]. Chat itself is deliberately
excluded from this list: it always uses the primary connection plus its configured fallbacks,
because a mid-conversation provider swap is a different kind of decision than which model
quietly does background bookkeeping [@app-js]. The selection persists to
`state.featureConnections` and syncs to the server, where `connectionForFeature(settings, key)`
resolves it back to an actual provider/model/key at each call site — the pondering loop, the
warm reach-out composer, and the memorization worker's `getConnection` callback all read
through this one resolver rather than each re-implementing the fallback-to-primary logic
[@server-js].

## Context

The founding design conversation identified this as a structural need before any of it was
built, while discussing a wholly different, unimplemented system (a local sifter model
updating tome entries): "You're describing something the architecture is going to need anyway:
task-to-model routing. Different jobs in Familiar have different requirements, and forcing them
through one model is wasteful at best and limiting at worst" [@founding-conversation]. Three
distinct workloads were named at the time — a background *sifter* needing structured output and
tolerating latency, a *main agent* needing conversational presence and low latency, and a
*retrieval/ranker* needing neither — with the architectural principle stated as "define jobs,
not models, in the configuration... The job names are stable; the bindings can change"
[@founding-conversation]. The reasoning for why this matters was twofold: **graceful
degradation** (if one job's provider goes down, only that job degrades — crisis signals and the
rest of the system keep working) and **cost-shaping** (a job that runs constantly in the
background should not need to spend frontier-model tokens to do it) [@founding-conversation].

## Decision

Proto-Familiar's shipped implementation realizes this principle directly, though the concrete
job list differs from the sifter/main-agent/retrieval split first sketched — the jobs that
actually exist in the shipped system are the ones with their own autonomous loops (see
[Autonomous loops](../architecture/autonomous-loops)) plus memorization's queue (see
[Session memorization](../architecture/session-memorization)), not a standalone sifter or
retrieval-ranker job. Each of those jobs resolves its own connection through
`connectionForFeature`, defaulting to the primary connection when the ward has not assigned a
specific one, which keeps the common case (one connection for everything) working with zero
configuration while making per-job override available without code changes [@server-js]
[@app-js].

## Consequences

A ward can now point the memorization worker at a cheap, fast model while keeping a stronger
model for live conversation, or vice versa, without either choice affecting the other job's
behavior. A provider outage for one feature's bound connection degrades only that feature — the
same independent-failure guarantee [Autonomous loops](../architecture/autonomous-loops)
requires of every background loop applies here at the connection layer, not just the process
layer. The caution the founding conversation raised about this pattern still applies as a
standing consideration for future work: more providers means more failure modes, more billing
relationships, and more places where personal context leaves the ward's control — worth being
deliberate about which providers see which data before binding a job to a new one
[@founding-conversation].

The web Connections modal is no longer the only control surface for this mechanism. The
[Ward Discord console](../architecture/ward-console)'s `!connection` command exposes the same
`primaryConnectionId` and `FEATURE_CONNECTIONS` routing from the ward's own Discord DM, reading
and writing the same settings the web app does through one locked, atomic write path — a
Discord change and a web change cannot tear the settings file [@ward-connections-js]. Each saved
connection also carries an optional `reasoningEffort` field (`low`/`high`/`max`/`off`), resolved
per call by `resolveReasoningEffort(conn)`: an explicit value is honored for any provider, and an
unset connection defaults to `low` only for the always-thinking z.ai GLM family, never for a
provider that might reject an unrecognized parameter [@providers-js]. `reasoningEffort` is set
from the Discord console only, not from the web UI.

## Related

- [Autonomous loops](../architecture/autonomous-loops) — the background workers that
  `FEATURE_CONNECTIONS` covers.
- [Session memorization](../architecture/session-memorization) — the memorization queue whose
  worker resolves its connection through this same mechanism.
- [Ward Discord console](../architecture/ward-console) — the `!connection` command that exposes
  active-connection selection, per-feature routing, and reasoning effort from Discord.
