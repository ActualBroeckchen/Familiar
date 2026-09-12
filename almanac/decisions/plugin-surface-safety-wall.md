---
title: "Plugin surface (\"Grimoire\"): Psycheros-compatible, walled off from the safety paths"
topics: [decisions, plugins, safety]
sources:
  - id: plugin-surface-design
    type: file
    path: docs/plugin-surface-design.md
  - id: plugin-surface-build-spec
    type: file
    path: docs/plugin-surface-build-spec.md
  - id: claude-md
    type: file
    path: CLAUDE.md
---

# Plugin surface ("Grimoire"): Psycheros-compatible, walled off from the safety paths

**Status: decided, not yet implemented (design approved, build spec written, no code shipped as
of 0.11.29).** Proto-Familiar will grow a first-class plugin surface, source-compatible with
plugins written for [Psycheros](https://github.com/PsycherosAI/Psycheros) — a sibling harness
descending from the same entity-as-subject philosophy — under the working milestone name
**Grimoire** [@plugin-surface-design]. The decision itself, the compatibility model it commits
to, and the one hard divergence from Psycheros's own security model are settled; only the
implementation passes in `docs/plugin-surface-build-spec.md` remain to be built. This page
records the decision so a future maintainer does not have to re-derive it from the design
document, and so the safety-wall constraint travels with the rest of the wiki's safety
material even before any plugin code exists — see [Safety spine](../architecture/safety-spine)
for the crisis/threat/triage system this constraint protects.

## Context

The question that started the milestone was concrete: can the community's Psycheros addons run
on Proto-Familiar too, so the two projects' plugin ecosystems converge instead of forking
[@plugin-surface-design]. Two facts made the answer tractable rather than aspirational. First,
every surface a Psycheros plugin can touch — prompt hooks, tools, HTTP routes, browser assets, a
settings pane, Discord-media hooks, and canonical-store tools/decorators — already maps onto a
Familiar extension point that exists today: `thalamus.enrich()`'s `dynamicSections`,
`cerebellum.js`'s tool registry, Express routes in `server.js`, static assets under `public/`,
the Settings modal, the discord-gateway media-ingest path, and Phylactery
[@plugin-surface-design]. The milestone formalizes existing internal seams as an external
contract rather than bolting on a foreign one. Second, the philosophy already matches: both
harnesses treat a prompt hook's output as first-person context the entity internalizes, not a
message handed to it, and both therefore already treat a hook as a place a plugin could *edit
the entity*, not merely inform it [@plugin-surface-design]. Psycheros's own vetting guide says
this explicitly; it is the same stance [Armature](../concepts/armature) and
[Proactivity over caution](proactivity-over-caution) already encode from the other direction for
prompts generally.

Two runtime walls stood between "the surfaces map" and "plugins actually load." Psycheros
plugins are Deno + TypeScript; Familiar is Node + ESM, so `Deno.env`, `Deno.readTextFile`, and
Web `Request`/`Response` need a bridge, and Node cannot `import` a `.ts` file without a loader
[@plugin-surface-design]. And Psycheros plugins can ship an `entity-core.ts` that registers
tools and `resultDecorators` inside the canonical self-store; Familiar's canonical self is
Phylactery, a Python/FastMCP process a JS file cannot load into
[@plugin-surface-design]. A third consideration was specific to Familiar and had no Psycheros
analog at all: Familiar hosts a vulnerable person's safety net — the crisis-signal, threat-tracker,
silence-triage, and CARE-CHECK paths CLAUDE.md already puts behind ward sign-off — and a prompt
hook that shapes what the Familiar believes about the ward's safety is the [1.5-hour-silence
incident](proactivity-over-caution) arriving through a new door [@plugin-surface-design].

## Decision

Proto-Familiar adopts a **shared source contract with a tiered loader**, rather than promising
binary drop-in compatibility it cannot honestly deliver. A plugin whose entrypoint is plain
`.js`/`.mjs` (or `.ts` that transpiles without touching Deno-specific APIs) loads directly into
the Node process (tier 0). A plugin that uses the documented common subset of Deno APIs runs
through a small, deliberately closed Node-side shim (`Deno.env`, scoped
`readTextFile`/`writeTextFile`, the Web `Request`/`Response` globals already native to Node 18+,
plus an on-the-fly `.ts` transpile) — an API the shim does not cover fails loudly and marks the
plugin degraded rather than silently misbehaving (tier 1) [@plugin-surface-design]. A plugin that
genuinely needs unshimmed Deno surface can run in a real Deno child process, bridged over stdio
JSON-RPC the same shape as the MCP-stdio children Familiar already spawns for
[Phylactery and Unruh](../architecture/phylactery) — opt-in per plugin via a manifest hint plus
an operator toggle, never spawned unasked (tier 2) [@plugin-surface-design]. The manifest
validator itself is ported from Psycheros's `packages/plugin-api/src/mod.ts` rather than
re-derived, for byte-identical accept/reject semantics on the shared fixtures
[@plugin-surface-build-spec].

For the canonical-store half, `resultDecorators` ship as a JS proxy at the thalamus seam:
additive-only fields applied to a named Phylactery MCP result after Phylactery's own logic
completes, which needs no Python plugin loading at all. Canonical plugin *tools* — a plugin
registering something that looks like it belongs to the self-store — are the harder, later
slice: a host-side registry under a `plugin.<id>.<tool>` namespace routes calls through the same
`executeToolCall` boundary as embodiment tools, and any persistence still rides Phylactery's own
MCP tools rather than touching Phylactery's storage directly, preserving the "writes go through
Phylactery's MCP" invariant [Architecture](../architecture) already enforces for the app's own
code [@plugin-surface-design].

**The safety wall is the one deliberate divergence from Psycheros's security model, and it is
non-negotiable.** Psycheros can rely on vetting alone ("the only defense is to refuse to install
a plugin you haven't reviewed"); Familiar cannot, because a careless or malicious hook can shape
what the Familiar believes about the ward's safety, not just what it says to a stranger. So the
plugin surface is walled off from the safety paths by construction:

- Prompt-hook output is folded into the chat turn's `dynamicSections` but is **excluded from the
  inputs to crisis-signal and threat-tracker scoring and from the triage/noticing
  deliberations** — a plugin can enrich a conversation, it cannot move the threat tier or silence
  a check-in [@plugin-surface-design].
- A plugin cannot register a tool or hook that calls a safety executor (`flag_distress`, a threat
  reset, a triage re-check); the same allowlist that already gates villager tools is the model for
  refusing them [@plugin-surface-design].
- Every plugin ships behind the standard hard off-switch
  (`PROTO_FAMILIAR_PLUGINS_DISABLED=1` plus a per-plugin enable, in the same commit as the
  loader), and a failing plugin degrades to absence rather than surfacing an error into the chat
  path [@plugin-surface-design] [@plugin-surface-build-spec].
- Any future change to the two exclusion rules above is ward-sign-off-class, the same tier
  CLAUDE.md already assigns to the triage files themselves [@claude-md] [@plugin-surface-design].

## Consequences

Formalizing existing seams as an external contract means the milestone is additive to the
current [Architecture](../architecture): no existing host point is replaced, only exposed. It
also means Proto-Familiar inherits Psycheros's manifest schema, authoring guide, and vetting
checklist essentially for free, which keeps the two ecosystems converging instead of diverging on
a rewritten contract [@plugin-surface-design].

The tiered loader is honest about cost rather than cheap about promises: most well-behaved
embodiment-side Psycheros plugins should run unmodified at tier 1, but a plugin the shim cannot
satisfy fails loudly and either needs the opt-in Deno sidecar (a real runtime dependency and a
per-hook cross-process round-trip) or cannot run at all. Nothing here promises "drop the folder
in, it just works" for every existing Psycheros plugin, and the design page says so explicitly
rather than deferring the disappointment to first use [@plugin-surface-design].

The safety wall is the load-bearing consequence for the rest of the wiki: once this milestone
ships, any reviewer checking whether a new capability can influence crisis detection or
escalation must also check whether it arrived as a plugin, and confirm the two exclusion rules
above still hold — this is now a standing invariant [Safety spine](../architecture/safety-spine)
and [Proactivity over caution](proactivity-over-caution) depend on, alongside the existing
Village audience-gating and injection-guard boundaries described on
[Injection guard: wiring history](../architecture/injection-guard-gap).

Several questions are still explicitly open for the build-spec pass rather than settled here: the
exact enumerated Deno-shim surface, whether the tier-2 sidecar reuses the existing MCP-stdio
plumbing verbatim or a thinner sibling, canonical plugin-tool provenance and persistence rules,
and whether an update channel modeled on Psycheros's one-click GitHub-tag updates is adopted
[@plugin-surface-design]. Until implementation lands, this page is the durable record of a
decision that has traveled from conversation to an approved design and build spec, but not yet
into code — the same shape [CDP mode: driving the ward's own Chrome](browser-cdp-mode) had
before the ward gave it the go-ahead and it shipped at 0.11.31-alpha; that page is the precedent
for a spec-and-park decision eventually being unparked and built to the letter it was recorded
in.

## Related

- [Safety spine](../architecture/safety-spine) — the crisis-detection, threat-tracking, and
  escalation system the safety wall protects from plugin-contributed context.
- [Proactivity over caution](proactivity-over-caution) — the incident that makes "a plugin could
  quietly bias the Familiar toward passivity" an unacceptable risk rather than a theoretical one.
- [Injection guard: wiring history](../architecture/injection-guard-gap) — the existing
  external-content sanitization boundaries a plugin's own outputs will need to be judged against.
- [Armature](../concepts/armature) — the standing claim that the base model's compliance pull must
  be structurally countered, which is why a prompt hook is treated as capable of editing the
  entity rather than merely informing it.
- [CDP mode: driving the ward's own Chrome](browser-cdp-mode) — a decision recorded in the same
  spec-and-park shape as this one, and the precedent for what happens when the ward later gives
  a parked decision the go-ahead: it shipped to the letter it was designed.
