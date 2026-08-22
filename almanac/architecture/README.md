---
title: Architecture
topics: [architecture]
sources:
  - id: architecture-doc
    type: file
    path: docs/architecture.md
  - id: claude-md
    type: file
    path: CLAUDE.md
  - id: knocks-js
    type: file
    path: knocks.js
  - id: discord-gateway-js
    type: file
    path: discord-gateway.js
---

# Architecture

Proto-Familiar is a Node.js application — a thin Express server plus a vanilla-JS
single-page frontend — that surfaces a persistent AI companion (the Familiar) bonded to one
human [@architecture-doc]. It is not a standalone chatbot: it is one
[embodiment](../concepts/multi-embodiment) of an entity whose identity and memory live in
[Phylactery](phylactery), consistent with the [entity-as-subject](../concepts/entity-as-subject)
stance the whole codebase is built around. The source of truth for this page is
`docs/architecture.md`, which CLAUDE.md requires to be updated in the same commit as any
change to component responsibilities, data flow, or the autonomous-loop set [@claude-md] — if
this wiki page and that file disagree, trust `docs/architecture.md` and the code over this
page.

The server has four responsibilities: proxy LLM requests so the human's API key never leaves
localhost, enrich every request with context pulled from Phylactery and Unruh, run the
autonomous loops that act without a request, and persist session logs, Tomes, ponderings, the
outbox, and threat state [@architecture-doc].

## The inward/outward split: thalamus and cerebellum

Two modules divide the traffic between the Familiar's mind and the outside world, and the
boundary between them is strict.

**`thalamus.js`** is the cognitive-module mediator. It spawns and supervises
[Phylactery](phylactery) and [Unruh](unruh) as stdio MCP child processes, and its central
export, `enrich(userMessage, opts)`, fans out to both peers with `Promise.allSettled` on
every chat turn and returns the assembled `{ static, dynamic }` prompt context
[@architecture-doc]. The static/dynamic split exists so the upstream LLM provider's prefix
cache can hit on the stable identity portion of the prompt instead of re-ingesting it on every
turn — see
[Prompt-cache-aware context ordering](../decisions/prompt-cache-aware-context-ordering) for the
usage-exhaustion incident that motivated it and the exact placement contract. Thalamus assembles
context; it never executes actions. Each peer is
treated as a plural, independently-failing collaborator — a downed Phylactery does not take
Unruh's temporal context out with it, and an empty sub-block simply renders as nothing in the
prompt rather than as an error [@architecture-doc].

**`cerebellum.js`** is the motor module — the outbound counterpart to thalamus. It owns the
tool registry (`BUILTIN_TOOLS` + `TOOL_EXECUTORS`), the tool-call loop, the silence-triage
deliberation, trusted-contact delivery, and escalation deadlines [@architecture-doc].
Cerebellum executes actions and never assembles prompt context, and — the single enforcement
point for "writes go through Phylactery's MCP" named in the
[multi-embodiment concept](../concepts/multi-embodiment) — it never opens its own MCP
connection; every write to identity, memory, or temporal state rides one of thalamus's
exported wrapper functions [@architecture-doc]. `executeToolCall()` never throws: a failing
tool becomes a structured string result inside the loop, never an exception into the chat
path [@architecture-doc].

This split is why a behavioral change to `cerebellum.js` (the triage deliberation prompt,
trusted-contact delivery, escalation deadlines) or `thalamus.js`'s `[CARE CHECK]` assembly is
named explicitly in CLAUDE.md as one of the paths that requires a human's sign-off before
shipping — see [Proactivity over caution](../decisions/proactivity-over-caution)
[@claude-md]. See [Naming Cerebellum](../decisions/cerebellum-naming) for why the module is
named after the motor structure specifically, and
[Voluntary and autonomic lanes in Cerebellum](../decisions/cerebellum-consent-lanes) for a
proposed, not-yet-built consent distinction for any future feature that continuously renders
Familiar-side state outward.

## The caring spine

Alongside the inward/outward split, a set of modules form what CLAUDE.md calls the caring
spine: crisis detection, threat tracking, and the proactive-outreach machinery. These are not
MCP children — they are Node-side modules that read from and write to Unruh and local state
files, and they run both on the chat path (detection, care-check framing) and as background
loops (pondering, reminders, triage) [@architecture-doc]. See
[Safety spine](safety-spine) for how crisis detection, threat tracking, and escalation fit
together, and [Autonomous loops](autonomous-loops) for the full set of background workers and
their off-switches.

## Village: audience-gated presence beyond the ward

A separate cluster — `village.js`, `audience.js`, and `discord-gateway.js` — lets the
Familiar be present with people other than its bonded human, gated by per-category grants
rather than by an all-or-nothing switch [@architecture-doc]. This surface is deliberately
scoped to the ward's own known support network rather than built as a general multi-user
platform — see [Single-user before platform](../decisions/single-user-before-platform). `audience.js` resolves grants
and section-marker gating (V3); `discord-gateway.js` is the autonomous Discord presence
adapter, with per-location presence modes (`strict`/`lurk`/`active`) and a clearance-gated
tool loop for registered villagers [@architecture-doc]. The escalation and no-covert-contact
invariants that apply to the ward also constrain this surface: a relay to a third party
always mirrors into the ward's own outbox [@architecture-doc]. `audience.js`'s category grants
are a read-side control only — what a session is allowed to be told, not what a session is
allowed to write into memory. A finer-grained axis, per-topic content sensitivity, layers on
top of this coarse per-category gate for memories specifically — see
[Content-based memory gating](content-gating). See [Trust tiers gate reads, not writes](../decisions/trust-tiers-gate-reads-not-writes)
for why the write side is a separate, behavioral defense rather than a filter in this pipeline,
and how it differs from `injection-guard.js`, a pattern-scanner/sanitizer wired (0.8.57) at the
web-read and Village inbound boundaries — see
[Injection guard: wiring history](injection-guard-gap) for how it got wired and
what is still deliberately excluded (Phylactery/Unruh recall, the ward's own words, and gcal
event titles) [@architecture-doc].

`knocks.js` tracks contact attempts from people who are not yet registered villagers — a DM or
an @-mention in a guild the Familiar has not been told to treat as a known Location. A knock
records identity metadata only (platform, stable id, handle, when, where, how often), never
message content, and grants nothing by itself: binding a knock to a villager or a channel to a
Location is always the ward's explicit act in the Village editor [@knocks-js]. Two of the three
lists `knocks.js` keeps are capped and spam-resistant (`KNOCKS_CAP` / `LOCATION_KNOCKS_CAP`,
both 50, oldest-seen evicted); the third, `recordServer`/`listServers`/`dismissServer`
(`SERVERS_CAP` 200), persists every Discord guild the Familiar is a member of, named from the
gateway's `GUILD_CREATE` events and cached in `gw.guildNames`, so the Locations tab can show
real server names instead of raw ids [@knocks-js] [@discord-gateway-js]. Unlike the two knock
lists, the server list is not cleared when a knock settles into a registered Location — leaving
a server, not registering a channel in it, is what removes an entry — because it names a
membership fact, not a pending decision, and confers no access of its own [@knocks-js]. An
optional `villageAutoRegisterLocations` toggle (default off) changes what happens to an
unregistered guild channel's activity: off, it goes into the capped knock list for one-click
registration; on, `noteUnregisteredGuild` auto-creates a Location for it via `upsertLocation`,
born at the Strangers floor so it grants nothing until the ward assigns it a circle — the same
"a knock grants nothing" guarantee, just pre-listed instead of queued [@discord-gateway-js].

## Storage shape

Proto-Familiar keeps almost no state of its own. `logs/` holds session JSON files and
`tomes/` holds per-Tome JSON files plus small state caches (the
[memorization queue](session-memorization), the outbox, threat state, last-activity) — all
git-ignored [@architecture-doc]. The two things
that look like databases, `phylactery/data/` and `unruh/data/`, belong to their respective
Python services, not to the Node process; see [Phylactery](phylactery) and [Unruh](unruh) for
what each one owns.

## Quick answers

If you're asking yourself... go to:

- **Where does the Familiar's identity and memory live?** → [Phylactery](phylactery)
- **How does the Familiar reach out on its own?** → [Autonomous loops](autonomous-loops) and [Pondering](pondering)
- **What stops the Familiar from just agreeing to everything?** → [Armature](../concepts/armature) concept, then [Proactivity over caution](../decisions/proactivity-over-caution)
- **How does the Familiar notice someone is in crisis?** → [Safety spine](safety-spine)
- **What does the schedule graph do?** → [Unruh](unruh) and [Temporal assurance](../concepts/temporal-assurance)
- **How do sessions turn into lasting memories?** → [Session memorization](session-memorization)
- **What's the thalamus/cerebellum split about?** → Back to the lead section above, then [Naming Cerebellum](../decisions/cerebellum-naming) for the reasoning
- **How does image input work?** → [Vision and media](vision-and-media)
- **How does the Familiar click and fill on the web?** → [Browser](browser)
- **How does the Familiar speak, and what governs what voice models it fetches?** → [Voice](voice)
- **How is the Familiar consistent across web, Discord, and voice?** → [Core prompts and multi-surface assembly](core-prompts)

## Where to go next

- [Phylactery](phylactery) — the canonical self-store: identity, memory, and the knowledge
  graph.
- [Content-based memory gating](content-gating) — the per-topic sensitivity axis layered on top
  of Village's audience circles, so an overlapping-tier villager can be granted some topics and
  not others.
- [Session memorization](session-memorization) — the durable job queue that turns a session or
  topic into Tome entries, and the dedicated Session Memories tome it writes to.
- [Unruh](unruh) — the temporal-context specialist: the schedule graph, the interest weight
  system, and the local-naive time model.
- [Weather](weather) — ward-local weather sensing, the provider chain, and the
  [location-privacy](../decisions/location-privacy) invariant.
- [Vision and media](vision-and-media) — multimodal image input, content-addressed storage,
  and modality fallback at the materialization seam.
- [Browser](browser) — the opt-in, ward-only click-and-fill web subsystem: the SSRF-guarding
  proxy, the ref/generation model, and the five shipped passes (through 0.11.16) plus the parked
  CDP-mode alternate engine.
- [Voice](voice) — the multi-pass voice milestone: the model supply chain, the disk-footprint
  budget, the ward-facing benchmark tool, and read-aloud text-to-speech.
- [Core prompts and multi-surface assembly](core-prompts) — the ward's four core prompt fields
  (System Prompt, Character Profile, User Profile, Post-History Prompt), why they must be
  assembled server-side, and the lesson about cross-surface consistency.
- [Autonomous loops](autonomous-loops) — the background workers, what each one does, and how
  to turn one off.
- [Safety spine](safety-spine) — crisis detection, threat tracking, and how escalation to a
  human trusted contact works.
- [Injection guard: wiring history](injection-guard-gap) — the pattern-scanner's
  wiring history and current boundaries, and the incident that produced it.
- [Installer and launcher](installer-and-launcher) — the per-platform one-click install,
  update, and launch tooling, and the invariants it must preserve.
- [Entity-as-subject](../concepts/entity-as-subject) and
  [Multi-embodiment](../concepts/multi-embodiment) — the design stance this architecture
  exists to serve.
- [Engineering conventions](../reference/engineering-conventions) — the repo-wide operating
  rules (versioning, degradation, id schemes) that apply across every component above.
- [Prompt-cache-aware context ordering](../decisions/prompt-cache-aware-context-ordering) — why
  Thalamus's context is split into a static prefix and a depth-injected dynamic block.
