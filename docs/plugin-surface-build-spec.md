# Familiar plugin surface ("Grimoire") — build spec

> **Status: NOT STARTED — design approved, implementation pending.** This is the action list; the
> rationale is [`docs/plugin-surface-design.md`](plugin-surface-design.md). Read that first. The
> milestone is large and MUST land in the passes below (§8), each with its own off-switch, tests,
> and — for the safety-touching passes — ward sign-off.

---

## 0. Before you write a line

Read these — they're constraints, not background:

1. **`CLAUDE.md`**, especially:
   - **Every capability must be reachable BY the Familiar.** A plugin tool needs a first-person
     description and a home in `tool-surfacing.js`; a plugin's presence must be legible to the
     Familiar (manual tome live macro), not just technically callable.
   - **Ride existing LLM calls; gate in code.** Plugin prompt hooks ride the chat turn's existing
     assembly (`enrich()`), not a new per-plugin request. A plugin does NOT get to add a standalone
     LLM call to the safety path.
   - **Graceful degradation is a rule.** A failing plugin degrades to absence; it can NEVER surface
     an error into the chat path. Every plugin ships an off-switch in the same commit.
   - **First-person + macro boundaries.** Plugin prompt-hook output rides the tool-result macro
     boundary (`substituteMacros` in `executeToolCall`), NOT a new boundary. Pin it with a test.
   - **Model-facing ids are readable slugs.** Plugin ids are slugs already (manifest enforces
     `id === dir`); any new id-bearing surface (event-log entries, provenance tags) is a slug too.
   - **Safety-critical code requires human sign-off.** §5 of the design (the safety wall) is
     ward-sign-off-class. Passes that touch it (P3, P6) do not ship without the maintainer.
2. **Psycheros's contract** (read-only reference clone at `../psycherosai/psycheros` when present):
   - `packages/plugin-api/src/mod.ts` — the manifest schema + validation we PORT (don't re-derive).
   - `packages/psycheros/docs/plugins.md` — the authoring + vetting guide we adapt.
   - `packages/psycheros/src/plugins/plugin-manager.ts` — the host-service + hook/ctx interfaces
     (`PluginPromptContext`, `PsycherosPluginServices`, `PluginPromptHook`, `PluginRoute`,
     `PluginAttachmentHook`, `PsycherosDiscordMediaService`) we mirror in Node.
3. **`docs/architecture.md`** — update it in the SAME commit as any component/wiring change (the
   plugin host is a new component; the diagram and the autonomous-loops/HTTP-surface lists change).

**Contract fidelity rule:** where a field, path shape, or hook signature exists in the Psycheros
contract, match it exactly unless the design doc names a deliberate divergence. Convergence is the
whole point; a gratuitous rename forks the ecosystem.

---

## 1. Modules (new, focused — modular-by-default)

- **`plugin-manifest.js`** — a Node port of `plugin-api/src/mod.ts`. Pure except for two host
  couplings, swapped: `Deno.env`→`process.env`, `Deno.readTextFile`→`fs`, `@std/path`→`node:path`,
  `@std/dotenv`→a tiny dotenv parse. Exports `validatePluginManifest`, `isSafePluginId`,
  `validatePluginRelativePath`, `isDeniedPluginEnvVar` (with Familiar's reserved prefixes:
  `PROTO_FAMILIAR_*` except `PROTO_FAMILIAR_PLUGIN_*`, `PHYLACTERY_*`, `UNRUH_*`),
  `contentTypeMatchesGlob`, the capability-count helpers, and the `SUPPORTED_PLUGIN_API_VERSIONS`
  constant. **Behaviour-identical to the Psycheros validator** — port its test cases too.
- **`plugin-host.js`** — the loader/registry. Discover (`bundled-plugins/` + data-root `plugins/`) →
  validate → topo-sort by `dependencies` (semver ranges) → choose loader tier → load → hold the
  registry. Owns `PluginStatus` (mirror the Psycheros shape: enabled/active/degraded/
  restartRequired/warnings/capabilities/origin/lastError), degraded-isolation, and the per-plugin
  event log (`plugin-logs/<id>.log`, `GET /api/plugins/:id/log`). NEVER throws into a caller.
- **`plugin-loader-native.js`** — tier 0/1: import a plain-ESM or transpiled entrypoint into-process,
  with the enumerated `Deno.*` shim (tier 1). The shim surface is a CLOSED, documented list; an
  unshimmed `Deno.*` access throws a clear "needs sidecar" error that marks the plugin degraded and
  names the missing API. Do NOT grow the shim silently — widening it is a reviewed change.
- **`plugin-loader-sidecar.js`** — tier 2 (opt-in): spawn a Deno child, discover its exports, bridge
  tools/promptHooks/routes/attachmentHook over stdio JSON-RPC. Reuse the existing MCP-stdio child
  plumbing shape where it fits (§8 P5 decides verbatim-reuse vs. thin sibling). Gated behind an
  operator toggle AND a manifest hint; never spawns Deno unasked.
- **`plugin-secrets.js`** — `plugin-secrets/<id>.env` read/apply/restore + `writeSecret`/`readSecrets`
  services, denylist-enforced. Direct port of `applyPluginEnv`/`readPluginEnv` semantics.
- **`plugin-env.js`** — the `PluginEnv` accessor (`get`/`has`/`require`) handed to hooks/routes.

## 2. Host wiring (into existing files — the connective seams)

- **`thalamus.js` `enrich()`** — after the native `dynamicSections` are built, call
  `plugin-host.runPromptHooks(ctx)` (bounded: per-hook `timeoutMs` default 15s, `maxChars` default
  12k, aggregate cap; `Promise.allSettled`) and fold the results in as their own labelled section.
  **The plugin section is EXCLUDED from the inputs handed to `crisis-signals`/`threat-tracker`
  scoring and to the triage/noticing deliberations** (design §5.1). This exclusion is the safety
  wall — pin it with a pipeline test (P6).
- **`cerebellum.js` + `composeActiveTools` + `tool-surfacing.js`** — plugin tools join the composed
  toolset through the existing allowlist path; results pass through `executeToolCall` (macro +
  provenance boundary). Plugin tools may NOT be the safety executors (`flag_distress`, threat reset,
  triage re-check) — the allowlist refuses them.
- **`server.js`** — mount plugin routes under `/api/plugins/<id>/*`; serve `browser` assets under
  `/plugins/<id>/*`; inject enabled plugins' `browser.scripts/styles` into the web shell; add the
  Plugins settings endpoints (`GET /api/plugins`, enable/disable, `POST /api/plugins/:id/settings`,
  log download, update-check). Load the host at boot alongside the MCP children.
- **`discord-gateway.js`** — consult `attachmentHook`s for inbound attachments the native walk
  declined (glob-matched, priority-ordered, budgeted); inject `services.discord.sendAttachments`
  (host bot token, never exposed) into `start()` when `discordMedia.send` is declared. Follow the
  existing ingest/audience gating.
- **Phylactery seam (canonical, P4)** — a JS `resultDecorators` proxy applied host-side to named
  Phylactery MCP results (additive-only, collision-refusing); later, the canonical plugin-tool
  registry under a `plugin.<id>.<tool>` namespace routing through `executeToolCall`, persisting only
  via Phylactery MCP (never bypassing the store).
- **Manual tome** — add a live macro exposing loaded-plugin names/capabilities so the Familiar knows
  what it has (discoverability rule). Mirror the macro name in `TOME_MACROS` + `applyNameVars`.

## 3. Settings, off-switches, secrets

- Master off-switch **`PROTO_FAMILIAR_PLUGINS_DISABLED=1`** + `pluginsEnabled` setting (default ON,
  inert until a plugin is installed). Per-plugin enable in the manifest + a Settings toggle.
- Tier-2 sidecar gated by **`PROTO_FAMILIAR_PLUGIN_SIDECAR_DISABLED=1`** + an operator opt-in.
- Discord-media plugin surface stands down under the existing `PROTO_FAMILIAR_DISCORD_DISABLED=1`.
- Secrets namespace `PROTO_FAMILIAR_PLUGIN_<ID>_*`; denylist + reserved host prefixes enforced in
  `plugin-manifest.isDeniedPluginEnvVar`.
- Add every new switch to the audited env-var registry so `audit:wiring`'s "undocumented switch"
  check stays green.

## 4. Surface matrix (fill each cell wired-or-N/A in the landing commit — RULE C)

| Capability | web turn | web tool rounds | Discord ward | Discord villager/ambient | background loops | canonical (Phylactery) |
|---|---|---|---|---|---|---|
| promptHooks | | | | | N/A (safety-excluded) | N/A |
| tools | | | | (allowlist-gated) | N/A | via P4 registry |
| routes | | N/A | N/A | N/A | N/A | N/A |
| browser assets | | N/A | N/A | N/A | N/A | N/A |
| settingsFragment | | N/A | N/A | N/A | N/A | N/A |
| discordMedia in/out | N/A | N/A | | | N/A | N/A |
| resultDecorators | | | | | | (P4) |

## 5. Tests (every pass ships at least one PIPELINE test — RULE from the 0.9 post-mortem)

- **`plugin-manifest.test.mjs`** — port the Psycheros manifest test suite; assert byte-identical
  accept/reject on the shared fixtures (apiVersion gating, path escape, denylist, glob validation).
- **`plugin-host.test.mjs`** — discover/validate/topo-sort/degraded-isolation; a plugin that throws
  at load is isolated, others still load; a dependency cycle/missing dep degrades with `lastError`.
- **Loader tiers** — tier-0 native load; tier-1 shim runs a common-subset plugin unmodified; an
  unshimmed `Deno.*` fails loudly and reports "needs sidecar"; tier-2 sidecar round-trips one tool +
  one prompt hook over RPC (cross-process, real child — a stub-only test would miss the boundary,
  per the voice post-mortem RULE 3).
- **PIPELINE: a full chat turn** through real `enrich()` with a stub plugin promptHook — asserts the
  plugin section lands in the prompt AND (P6) that the same plugin text is ABSENT from the threat
  scoring input and the triage deliberation input. This is the safety wall's regression test; watch
  it fail before it passes (post-mortem RULE 4).
- **Route namespacing / asset containment / secret restoration after shutdown / macro resolution on
  plugin output / audience fail-closed on a gated Discord turn.**

## 6. Ward-sign-off gate (do NOT ship without the maintainer)

Passes **P3** (safety wall) and **P6** (its regression pins) change when/whether plugin context can
influence the ward's safety surface. Per CLAUDE.md they are the same class as the triage files:
- the exclusion of plugin context from crisis/threat/triage/noticing inputs,
- the allowlist refusal of safety executors to plugin tools,
must be reviewed and signed off by the human before merge. The build spec author does not decide
these alone.

## 7. Docs & versioning

- Update `docs/architecture.md` (new component + HTTP surface + boot sequence) in the same commit as
  the host lands.
- Adapt the Psycheros vetting guide into `docs/plugin-authoring.md` (authoring) with Familiar's
  safety-wall notes made explicit for operators; link it from the design doc.
- Milestone owns the next MINOR (0.12 = "Grimoire" per the one-milestone-one-minor rule); everything
  inside it bumps PATCH until the milestone lands as `0.12.0`.

## 8. Passes (each: off-switch + tests + docs + version, in the same commit)

- **P0 — manifest port.** `plugin-manifest.js` + ported tests. Pure, no wiring. (patch)
- **P1 — host + native loader (tier 0).** Discover/validate/registry/degraded-isolation; load a
  plain-ESM plugin exporting one tool + one promptHook; wire into `enrich()` + `composeActiveTools`;
  master off-switch; Plugins settings list + enable/disable. Pipeline test. (patch)
- **P2 — routes, browser assets, settingsFragment, secrets.** `/api/plugins/<id>/*`,
  `/plugins/<id>/*`, secret write/read services, settings pane. (patch)
- **P3 — the safety wall.** Exclude plugin context from safety inputs; allowlist-refuse safety
  executors; audience fail-closed for plugin reads. **Ward sign-off.** (patch)
- **P4 — canonical: resultDecorators proxy, then the plugin-tool registry.** Additive-only decorator
  merge at the thalamus/Phylactery seam; then `plugin.<id>.<tool>` canonical tools routing through
  `executeToolCall`, persisting only via Phylactery MCP + provenance labelling. (patch, then patch)
- **P5 — Deno shim hardening + sidecar (tier 1/2).** Enumerate + test the shim surface; the opt-in
  Deno sidecar with stdio-RPC bridge and its own off-switch. (patch)
- **P6 — Discord media + safety-wall regression pins + authoring guide.** attachmentHook + outbound
  send; the pipeline regression that plugin context can't move the tier; `docs/plugin-authoring.md`.
  **Ward sign-off (regression pins).** Milestone lands → `0.12.0`.

## 9. Explicitly deferred / out of scope for the milestone

- Sandboxing beyond process isolation (tier-2 is isolation-by-process, not a capability sandbox) —
  the trust model stays "vetted local code," matching Psycheros.
- A plugin *marketplace*/registry UI beyond install-from-zip/git + the GitHub-tag update check.
- Auto-migrating existing in-tree features into first-party plugins (design §8 open question) — a
  separate, later effort if pursued at all.
