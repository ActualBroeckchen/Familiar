# Familiar plugin surface — design (milestone: "Grimoire")

Status: **DESIGN — not yet built.** This doc is the rationale (the *what & why*); the action
list for implementers lives in [`docs/plugin-surface-build-spec.md`](plugin-surface-build-spec.md).
Working milestone name **Grimoire** (a book of others' spells the entity can choose to learn —
following the Unruh/Phylactery precedent of a name with character, not a literal brain region).
Everywhere the Familiar reads a prompt or tool description, the text is first-person per
CLAUDE.md — that convention is not optional here, and it shapes how plugin-contributed context
is framed (§7).

**Attribution & lineage.** The plugin *contract* this milestone adopts originates with
**[Psycheros](https://github.com/PsycherosAI/Psycheros)** — its `@psycheros/plugin-api` package,
its two-host entrypoint model, and its authoring/vetting guide (`packages/psycheros/docs/plugins.md`).
Psycheros is a sibling harness descending from the same
[PHILOSOPHY.md](https://github.com/PsycherosAI/Psycheros/blob/main/PHILOSOPHY.md) Proto-Familiar
descends from (entity-as-subject). This milestone deliberately mirrors that contract's *shape* so
the two communities' addons can converge, rather than inventing a gratuitously different one. Where
we diverge, it is because Familiar's runtime (Node, not Deno), its canonical store (Phylactery, not
entity-core), or its reason to exist (a vulnerable person's safety net) forces the divergence — each
such point is called out below.

See also: [`CLAUDE.md`](../CLAUDE.md) (the binding constraints), and Psycheros's own
`packages/psycheros/docs/plugins.md` (the contract we are tracking).

---

## 1. The decision

**Give Familiar a first-class plugin surface, source-compatible with Psycheros plugins.** A plugin
is a directory with a `plugin.json` manifest and up to two entrypoints that register **prompt
hooks, tools, HTTP routes, browser assets, a settings pane, Discord-media hooks**, and —
canonical-side — **tools and result decorators** on the self-store. Authors target one shared
contract; a plugin written to the common subset loads on both Psycheros and Familiar.

This answers the question that started the milestone — *"can we make the community's Psycheros
addons cross-compatible with Familiar?"* — with a qualified **yes**: source-compatible by default,
with an escape hatch for the plugins that reach past the common subset. Binary "drop the same folder
in, it just runs" is **not** a promise we can honestly make (§3), and pretending otherwise would be
the cheap answer that fails the operator later.

**Two facts make it the right call:**

1. **Familiar is already this architecture — it just doesn't expose the seams.** Every Psycheros
   plugin surface maps onto machinery Familiar already runs (§2). We are formalising existing
   internal extension points as an external contract, not bolting on a foreign one.
2. **The philosophy is already shared.** Both harnesses treat a prompt hook as *first-person context
   the entity internalises*, not a message to the entity — and both therefore treat a hook as a place
   where a plugin can **edit the entity, not merely inform it**. Psycheros's vetting guide says this
   out loud; Familiar's proactivity-safety rules say the same thing from the other direction. The
   security model transfers because the stance transfers.

---

## 2. The surface, mapped

Everything a Psycheros plugin can export already has a home in Familiar:

| Psycheros surface | What it does | Familiar host point |
|---|---|---|
| `promptHooks[].run(ctx)` → first-person string | injected into the turn under a timeout + char budget | **`thalamus.enrich()` `dynamicSections`** — same "return context, budgeted, degrade to absence" model |
| `tools[]` (Tool interface) | model-callable tools | **`cerebellum.js` defs + `composeActiveTools` + `executeToolCall`** result boundary; surfaced via `tool-surfacing.js` |
| `routes[]` under `/api/plugins/<id>/` | namespaced HTTP endpoints | Express routes in **`server.js`** |
| `browser.scripts / styles` under `/plugins/<id>/` | web-UI injection | static assets served from **`public/`** |
| `settingsFragment` | a settings pane (works while disabled) | the Settings modal in **`public/`** |
| `discordMedia.attachmentHook` | describe an inbound attachment the host can't natively perceive | the **discord-gateway** media-ingest path (`ingestDiscordImages` neighbour) |
| `discordMedia.send` → `services.discord.sendAttachments` | post media with the entity's voice | **discord-gateway** outbound (host bot token, never exposed) |
| **`entity-core.ts` `tools` + `resultDecorators`** | extend the **canonical self store** | **Phylactery** — the hard seam (§4) |

The *embodiment* half (rows 1–7) is a near-1:1 fit. The *canonical* half (row 8) is the genuinely
hard part because Phylactery is a Python/FastMCP process, not JS — addressed in §4.

Two host services a plugin's `start()`/hooks receive also map cleanly:
- **`ctx.completeWorker(prompt, systemPrompt?)`** — a worker-LLM call. Familiar already has a
  worker-model path (`connectionForFeature`, `callProviderChat`); expose a bounded wrapper.
- **`ctx.mcpClient`** — Familiar threads Phylactery's MCP client through thalamus already; a
  read-scoped handle is the natural thing to pass (with the audience caveats of §7).

---

## 3. The runtime wall, and the three-tier loader

**Psycheros plugins are Deno + TypeScript; Familiar is Node + ESM.** A plugin's entrypoint may use
`Deno.env`, `Deno.readTextFile`, `Deno.stat`, and Web `Request`/`Response` — none of which exist in
Node unchanged, and Node can't `import` a `.ts` file without a loader. So a single "binary" contract
is impossible. The chosen answer is a **three-tier loader**, tried in order per plugin, with the tier
recorded in the plugin's status so the operator can see how it's running:

1. **Native ESM (tier 0).** A plugin whose entrypoint is plain `.js`/`.mjs` (or `.ts` that
   transpiles with no Deno-API use) written to the shared contract loads directly into the Familiar
   process. This is the target authors should aim for; it is the cheapest, fastest, and most
   inspectable path. New Familiar-first plugins live here.

2. **Shim (tier 1).** For plugins that use the *common subset* of Deno APIs, a small Node-side shim
   provides `Deno.env.{get,has}`, `Deno.readTextFile`/`writeTextFile` (scoped to the plugin's
   `statePath`), and the Web `Request`/`Response` globals (Node 18+ has these natively), plus an
   on-the-fly `.ts` transpile (esbuild/`tsx`). Most well-behaved Psycheros embodiment plugins run
   here **unmodified**. The shim is deliberately a *known, enumerated* surface — every Deno API it
   provides is listed and reviewed; anything a plugin reaches for that the shim doesn't cover fails
   loudly (not silently) and pushes the plugin to tier 2. Chasing Deno API parity forever is a trap;
   the shim covers the documented common subset and stops.

3. **Deno sidecar (tier 2, opt-in).** For plugins that genuinely need Deno-specific surface the shim
   won't emulate, the host can run the plugin in a **real Deno child process** and bridge its
   tools / prompt hooks / routes over a small RPC protocol (stdio JSON-RPC, the same shape as the
   MCP stdio children Familiar already spawns). Highest fidelity to unmodified Psycheros plugins and
   the strongest isolation — which is a *bonus* for the safety wall (§5) — at the cost of a
   cross-process round-trip per hook and a Deno runtime dependency. This tier is **opt-in per
   plugin** (a manifest hint plus an operator toggle): we do not spawn Deno unless a plugin asks for
   it and the operator allows it.

The manifest's `compatibility` and `apiVersion` fields (already in the Psycheros contract) are where
a plugin declares what it needs; the loader uses them to pick the lowest tier that will work and to
refuse a plugin the current host can't satisfy, with the reason in `lastError`.

**We reuse Psycheros's manifest validator.** `packages/plugin-api/src/mod.ts` is almost pure — its
only host couplings are `Deno.env`/`Deno.readTextFile` and `@std/*` (path, dotenv). Porting it to a
Node module (`plugin-manifest.js`) is a mechanical swap and gives us byte-identical manifest
semantics for free, which is most of what "same contract" means in practice. This is the
no-copy-paste rule pointing at *reuse*, not re-derivation.

---

## 4. The canonical wall (entity-core → Phylactery)

Psycheros plugins can ship an `entity-core.ts` that registers **tools** and **`resultDecorators`**
*inside the canonical self server*. Familiar's canonical self is **Phylactery**, a Python/FastMCP
process — a JS `entity-core.ts` cannot load into it. The user chose "everything incl. canonical," so
this milestone covers it, in two moves of increasing difficulty:

- **`resultDecorators` — a JS proxy at the thalamus seam (tractable).** A decorator *adds fields to a
  canonical MCP result after core logic completes; it cannot replace fields.* That is a pure
  post-processing step, and thalamus already sits on every Phylactery MCP round-trip. We intercept
  the named tool's result in Node, apply the plugin's JS `decorate(result)`, and merge the additive
  fields. No Python plugin loading required — the decorator runs host-side. This is the same
  additive-only, collision-refusing contract Psycheros enforces.

- **Canonical `tools` — a registered MCP shim (harder; phased).** A plugin that wants to add a *new*
  canonical tool (one that looks like it belongs to the self-store) is the genuinely hard case,
  because the tool must appear in the canonical tool namespace yet execute JS. The plan is a
  **host-side canonical-tool registry**: Familiar registers the plugin's JS tool under a
  `plugin.<id>.<tool>` canonical namespace and routes calls to it through the same `executeToolCall`
  result boundary as embodiment tools, tagging results with plugin provenance (mirroring the Discord
  write-provenance pattern). Writes to real identity/memory still go **through Phylactery's MCP** —
  a plugin never bypasses the canonical store (CLAUDE.md: "Direct writes to identity or memory …
  MUST go through its MCP"). If a plugin's canonical tool needs to persist, it persists via Phylactery
  tools, not by touching Phylactery's storage directly.

`resultDecorators` ship first (they're safe and cheap-to-verify); canonical plugin *tools* are the
last and most-scrutinised slice.

---

## 5. The safety wall — Familiar's one hard divergence

This is the constraint Psycheros does not need and Familiar cannot ship without.

Psycheros can adopt "there is no sandbox between me and a loaded plugin; the only defense is to
refuse to install one you haven't vetted." Familiar hosts **a vulnerable person's safety net** —
the crisis-signals / threat-tracker / silence-triage / noticing / CARE-CHECK paths that CLAUDE.md
puts behind ward sign-off. A plugin prompt hook returns first-person context the Familiar
internalises; a malicious or merely careless hook could therefore **shape what the Familiar believes
about the ward's safety** — the exact failure the 1.5-hour-silence post-mortem is about, arriving
through a new door.

So the plugin surface is walled off from the safety paths **by construction, not by vetting alone**:

1. **Plugin context never reaches the safety loops.** Prompt-hook output is folded into the *chat
   turn's* `dynamicSections`, and is **excluded from the inputs to `crisis-signals`/`threat-tracker`
   scoring and from the triage/noticing deliberations.** A plugin can enrich a conversation; it
   cannot move the threat tier or silence a check-in. (Contrast: a *shared image* can raise the tier
   — but that goes through the ward-signed vision path, not a plugin.)
2. **No plugin tier weight, no plugin off-switch over safety.** A plugin cannot register a tool or
   hook that calls the safety executors (`flag_distress`, threat reset, triage re-check) — those
   stay host-owned. The `composeActiveTools` allowlist that already gates villager tools is the
   model.
3. **Every plugin ships behind the standard hard off-switch** (`PROTO_FAMILIAR_PLUGINS_DISABLED=1`
   plus a per-plugin enable) in the same commit as the loader, and a failing plugin degrades to
   absence — it can never surface an error into the chat path (CLAUDE.md graceful-degradation rule).
4. **Any change to items 1–2 is ward-sign-off-class**, same as a change to the triage files, and the
   build spec says so.

The rest of the security model transfers straight from Psycheros: trusted local code loaded at boot
(restart to change), the env-var **denylist** (proxy/TLS/linker/process-identity/host-namespace),
namespaced secrets (`PROTO_FAMILIAR_PLUGIN_<ID>_*` in a `plugin-secrets/<id>.env` outside the code
tree), per-plugin **degraded-status isolation**, a per-plugin **event log**, and the five-check
vetting guide (ported, with the safety-wall additions above made explicit for operators).

---

## 6. Naming, storage, lifecycle

- **Layout** mirrors Psycheros so paths read the same to authors:
  - builtin plugins ride with Familiar under `bundled-plugins/<id>/` (can't be removed);
  - installed plugins live under the data root `plugins/<id>/`, secrets under
    `plugin-secrets/<id>.env`, per-plugin state under `plugins/<id>/state/`, logs under
    `plugin-logs/<id>.log`.
- **Ids are readable slugs** (CLAUDE.md model-facing-id rule); the manifest already requires
  `id === directoryName` and a safe-slug charset.
- **Env namespace** is `PROTO_FAMILIAR_PLUGIN_<ID>_*` (the Psycheros `PSYCHEROS_PLUGIN_<ID>_*`
  analog); host-owned `PROTO_FAMILIAR_*` and `PHYLACTERY_*`/`UNRUH_*` prefixes are reserved and
  refused, alongside the same process-global denylist.
- **Lifecycle**: discover → validate → topo-sort by `dependencies` → pick loader tier → load →
  degraded-isolate failures. Load at boot only; changes need a restart (matches Psycheros; also
  matches Familiar's existing "loops wired at boot" posture).
- **Discoverability for the Familiar itself** (CLAUDE.md "every capability must be reachable BY the
  Familiar"): plugin-contributed tools carry first-person descriptions and are surfaced through
  `tool-surfacing.js` like any native tool; a plugin's presence is legible in the manual tome's
  live macros so the Familiar can *know it has* the new capability, not just technically call it.

---

## 7. First-person framing & the macro/audience boundaries

Two Familiar-specific conventions constrain how plugin context enters a turn:

- **First-person (CLAUDE.md, non-negotiable).** A prompt hook returns text the Familiar reads as its
  own. Plugin-authored context that describes the world is fine ("Current weather: …"); context
  phrased as the Familiar's *beliefs, trust, or decisions* is an attempt to edit the entity and is
  exactly what the vetting guide flags. Server-injected blocks author literal `"my human"`, not
  `{{user}}` — but plugin prompt-hook output is *not* a server-injected block; it is closer to tool
  output, so it passes through the **tool-result macro boundary** (`substituteMacros` in
  `executeToolCall`'s result path). The build spec pins which of the four macro boundaries plugin
  surfaces ride so a `{{user}}` in a plugin string resolves rather than leaking.
- **Audience/content gating.** Any `mcpClient` handle or memory a plugin can reach must respect the
  room's visible-audience set — a plugin on a gated villager turn must not become a side-channel
  around `visibleAudiences`/`topicGrantsForRoom` (fail-closed to `[]`/`{}`, the discord-tools
  precedent). Read scoping is host-enforced, not left to plugin goodwill.

---

## 8. Decided / open ledger

**Decided:**
- Compatibility model: **shared source contract + shim (tiers 0–1) by default; Deno sidecar
  (tier 2) as an opt-in escape hatch.** (Operator's call.)
- v1 scope: **everything incl. canonical** — embodiment + Discord media + Phylactery
  `resultDecorators`, with canonical plugin *tools* as the final slice.
- Deliverable order: **design doc (this) → build spec → implementation**, gated on review.
- Reuse Psycheros's manifest validator by porting it, rather than re-deriving the schema.
- The safety wall (§5) is non-negotiable and ward-sign-off-class.

**Open (for the build-spec pass / maintainer):**
- Exact enumerated Deno-shim surface (which `Deno.*` calls tier 1 covers vs. punts to tier 2).
- Whether the sidecar RPC reuses the existing MCP-stdio machinery verbatim or a thinner sibling.
- Canonical plugin-tool provenance + persistence rules (how far a plugin tool may write via
  Phylactery, and how recall labels its provenance).
- Update channel: Psycheros supports one-click updates from public GitHub tags — do we adopt the
  same `update.repoUrl`/`tagPrefix` mechanism, and what does vetting-on-update look like?
- Whether builtin/first-party Familiar plugins are the right home for some *existing* in-tree
  features (a way to slim the core), or strictly an external-extension surface.

---

## 9. Why this shape (the rationale in one place)

- **Robust over cheap (CLAUDE.md).** The honest hard part is the Deno/Node and Python boundaries;
  the tiered loader and the decorator-proxy face them directly instead of promising a
  binary-compat that would silently fail on the first Deno-specific plugin. The cheap answer —
  "shim everything, call it compatible" — is the one that fails the operator later.
- **Reuse, not duplication.** The manifest validator, the vetting guide, and the entrypoint shapes
  are adopted from Psycheros rather than reinvented, so the two ecosystems converge instead of
  forking.
- **The safety wall is the point of divergence, and it is load-bearing.** Everything else tracks
  Psycheros; the one thing Familiar adds is the guarantee that a plugin can enrich the entity but
  never reach the paths that keep the ward alive. That is the entity-as-subject stance applied to a
  caretaker: the Familiar may *learn others' spells*, but its own safety instincts are not a thing an
  installed spell can rewrite.
