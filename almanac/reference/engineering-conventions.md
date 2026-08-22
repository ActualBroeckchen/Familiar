---
title: Engineering Conventions
topics: [reference]
sources:
  - id: claude-md
    type: file
    path: CLAUDE.md
  - id: app-js
    type: file
    path: public/app.js
  - id: audit-mcp-script
    type: file
    path: scripts/audit-mcp-contracts.mjs
  - id: cerebellum-js
    type: file
    path: cerebellum.js
  - id: mcp-contracts-test
    type: file
    path: tests/mcp-contracts.test.mjs
  - id: thalamus
    type: file
    path: thalamus.js
  - id: phylactery-result
    type: file
    path: phylactery-result.js
  - id: mcp-smoke-test
    type: file
    path: tests/mcp-smoke.test.mjs
  - id: llm-call-js
    type: file
    path: llm-call.js
  - id: voice-transcribe-js
    type: file
    path: voice-transcribe.js
---

# Engineering Conventions

This page is a lookup reference for the repo-wide operating rules recorded in `CLAUDE.md`
that apply across every component, not just one subsystem. Use it to check a specific
convention before making a change; use [Architecture](../architecture) for how the
components these rules govern actually fit together.

## Versioning

`package.json`'s `version` field is the single source of truth. The server reads it once at
boot and exposes it via `/api/health`, `/api/version`, the startup banner, and the sidebar
UI badge — the version must not be hard-coded anywhere else [@claude-md].

| Change | Bump |
|---|---|
| Bug fix, copy edit, dependency pin, doc tweak | patch |
| New user-visible feature, behavioral change, UX rework, new endpoint | minor |
| Breaking API/storage change, removed feature, format migration | major |
| Graduate from pre-release | drop the `-alpha` suffix |

Format while in alpha: `MAJOR.MINOR.PATCH-alpha` [@claude-md]. The version bump happens in
the same commit as the change it describes. If a change's bump is ambiguous between patch and
minor, prefer minor — it is cheaper than a wrong "patch" label shipping [@claude-md].

**One milestone = one minor.** The minor number names a milestone (0.2 = pre-Unruh, 0.3 =
Unruh, 0.4 = Cerebellum), not a count of shipped features — multiple sub-features of the same
milestone share one minor bump and land as patches within it [@claude-md]. During a
long-running feature branch that is the sole reason the minor slot is being held, ancillary
work on that branch bumps patch only; the branch name signals which feature owns the next
minor [@claude-md].

## Robust over cheap

The priority order for any proposal or implementation, in order, is robust (handles the
problem space, not just the symptom that triggered the report), sustainable (no
tribal-knowledge workarounds; state that should persist, persists), and user-accessible (the
bonded human and the Familiar can both see, reason about, and adjust the result through
surfaces they can reach) [@claude-md].

Named anti-patterns to avoid in framing a proposal: "the cheapest meaningful fix is…",
"surgical minimum…", "smallest change that closes the symptom…", "quick patch for now,
revisit later" (later rarely comes), "we can defer the harder version" (sometimes correct,
often a cover for the lazy option), and leading with token/line-count as the primary virtue
rather than a side-effect of clarity [@claude-md]. The default frame offered to the human
must be the robust one, named explicitly — not buried under "but the cheap version is also
possible" as if the two were equivalent [@claude-md].

## Fix the root cause, not the symptom

When a bug traces back to a function's architecture, rewrite the function rather than
stacking an extra condition on top of already-tangled logic. A clean rewrite is usually
shorter and less likely to introduce a new bug than a patch welded onto a broken shape
[@claude-md].

## No copy-paste of substantial logic

Never copy-paste a non-trivial code block across files; extract a shared helper instead. The
threshold is judgment, not a line count — a few genuinely parallel-but-distinct lines are
fine, a copy-pasted helper function is not [@claude-md]. Extracting a shared abstraction once
real duplication exists is the correction of a structural mistake, not premature abstraction;
inventing the abstraction *before* the duplication exists is the anti-pattern to avoid
[@claude-md]. See [Installer and launcher](../architecture/installer-and-launcher) for a
worked example: stale-instance port recycling lives once in
`scripts/ensure-port-free.mjs` rather than being copy-pasted across the shell launchers.

## Modular by default; orchestration files are the exception

New logic defaults to a focused module. `cerebellum.js` and `thalamus.js` are deliberately
wide because they are the system's connective tissue — that width is appropriate
architecture, not a single-responsibility violation, and should not be reflexively split. But
unrelated logic that could live in its own file should not be piled into them either
[@claude-md]. See [Architecture](../architecture) for what each of those two files actually
owns.

## Ride existing requests; gate in code

Every LLM request costs tokens and latency, and a system that adds a new standalone request
per feature inflates linearly with capability. The order of operations for any feature that
needs LLM judgment [@claude-md]:

1. Can a hard gate in cheap code handle it? Threat tier, quiet hours, dedup windows,
   time-of-day filters, and pattern-match classification answer most "should this happen?"
   questions for free — the LLM should only see candidates that survived the gates.
2. Can the judgment ride an existing LLM call (a chat turn, a pondering tick, a
   silence-triage check, a reminder composition) instead of spinning out a new one?
3. Only if neither works, add a new request — and give it a self-set cool-down (the
   silence-triage `nextCheckInMs` pattern) so it does not fire on a fixed cadence regardless
   of need.

Pure-code tagging beats LLM classification when the labels are crisp (engaged / ignored /
deferred / completed); the LLM is reserved for interpreting patterns across many tagged
events, not for labeling each one individually [@claude-md]. See
[Safety spine](../architecture/safety-spine) for this rule applied to crisis detection.

## Every capability must be reachable by the Familiar

A tool the Familiar cannot discover, or whose required inputs it cannot obtain, is not a
capability — CLAUDE.md calls it "dead code that looks like care" [@claude-md]. Shipping a new
tool, background action, or power requires both halves, in the same commit:

1. **Discoverability** — a bound tool's first-person description is the baseline; anything
   gated, conditional, multi-step, or behind another surface needs an explicit home in
   something the Familiar reads (identity, injected context, a tome, the relevant prompt)
   [@claude-md].
2. **Operability** — every required argument must be obtainable from a surface the Familiar
   actually has. The worked example: `mem_delete(id)` is real because the id rides in on a
   prior `recall`/search result, never something the Familiar has to invent or memorize
   [@claude-md].

## Graceful degradation

No module may be able to take down the chat path — a peer being down, a loop crashing, or a
tool throwing must never surface as an error in the human's conversation; absence renders as
absence [@claude-md]. Every new background loop ships with a hard off-switch env var in the
same commit. Every new peer or channel adapter must fail independently, so one bad adapter or
MCP peer never takes another one's context or delivery down with it. Failures that matter
must be observable — delivery state recorded on the item, triage decisions logged, degraded
peers logging loudly at boot — because silent failure is exactly the failure mode this rule
exists to prevent [@claude-md]. See [Architecture](../architecture) and
[Autonomous loops](../architecture/autonomous-loops) for where this is implemented.

## Token-conscious operation

The human running a coding session has a fixed weekly token budget; anything that returns
output into the agent's context (`Bash`, `WebSearch`, `WebFetch`, `Read`) costs them.
CLAUDE.md's guidance: spend tokens verifying something that could plausibly be wrong, not
something that obviously has not changed [@claude-md]. Run the test suite when runtime code,
an import/API shape, or test code itself changed, or when verifying a bug the human just
reported; skip it for doc-only changes, a comment or unassessed string, or a version-only
bump [@claude-md].

## Macro substitution boundaries

`{{user}}` and `{{char}}` are authored as literal tokens in prompts and tool descriptions and
resolved to configured names by `macros.js`'s `substituteMacros` at exactly three
server-side boundaries, enumerated so a fourth is never added ad hoc [@claude-md]:

1. LLM prompts, at each call site of a standalone prompt (triage, warm reach-out, pondering,
   tome-graduation, guide-chat).
2. Tool results, applied blanket at `executeToolCall`'s result boundary.
3. Tool descriptions, applied by `composeActiveTools` before the tool list reaches the
   provider.

Server-injected static/dynamic context blocks (identity, temporal context, the
`[CARE CHECK]` block, presence) bypass all three boundaries deliberately and author the
literal string "my human" instead of a macro token, because those blocks are assembled and
injected directly by `server.js`/`thalamus.js`/`temporal-format.js` rather than passed
through a macro-substitution call site [@claude-md]. Reintroducing a macro token into one of
those blocks is a regression CLAUDE.md records having already fixed once (the 0.7.83 audit).

The browser's own prompt assembly is a separate implementation of the same boundary-1
principle: `public/app.js`'s `applyNameVars` resolves `{{user}}` and `{{char}}`, plus two
time macros, `{{elapsedTime}}` and `{{timeSinceLastSession}}`, at every segment
`buildApiMessages` feeds into the main chat request (system prompt, character profile, user
profile, post-history prompt, and injected history entries) [@app-js]. It is a distinct
function from `macros.js`'s `substituteMacros`, not a client mirror of it, and it is the only
place either time macro is resolved. See
[Elapsed-time macros read stored history, not Date.now()](../decisions/time-macros) for why
`{{elapsedTime}}` and `{{timeSinceLastSession}}` each anchor their gap differently.

## A throw partway through `init()` silently disables every later listener

`public/app.js`'s `init()` wires up every UI control in one long top-to-bottom function: settings
fields, chat buttons, the prompt inspector, the logs modal, the topic system, the tomes modal, and
more, each via `$('some-btn').addEventListener('click', someHandler)` [@app-js]. `addEventListener`
resolves its handler argument at the moment that line executes, not when the enclosing function was
defined. If a handler name referenced on an earlier line does not exist yet, the browser throws an
uncaught `ReferenceError` right there, and `init()` — like any uncaught top-level throw in
JavaScript — stops executing immediately. Every `addEventListener` call still lower in the function
body never runs, so every button wired below the throw looks identical to a working button (it
renders, it takes hover/click states) but does nothing, with no error tied to the button the user
actually clicked.

This exact shape broke the Tomes modal in one incident: `init()` referenced `openPromptInspector`
and `closePromptInspector` on the prompt-inspector wiring lines, before either function was defined
anywhere in the file, well above the `tomes-btn` listener later in the same function [@app-js]. The
console showed `Uncaught ReferenceError: openPromptInspector is not defined` at the prompt-inspector
line; every listener registered after it, including Tomes, Logs, the topic system, import buttons,
the theme toggle, and the reveal buttons, was never attached. Both functions are now defined
earlier in the file, so this specific occurrence is fixed [@app-js], but the failure shape recurs
any time a new wiring block is added to `init()` referencing a handler that does not exist yet.

The diagnostic move that finds this class of bug fastest: when any button in the app does nothing,
open the browser console before touching the reported button, even when the console error looks
unrelated to what the user described. A single early throw in `init()` is a more common cause of
"several unrelated buttons stopped working" than a defect in each button individually.

## Three named rules from a five-incident postmortem

CLAUDE.md promotes three point-fixes to standing rules, named A/B/C, after the same shape of
bug shipped on a new surface five times because each earlier fix was recorded as a fact about
one call site instead of a law about every call site [@claude-md].

**RULE A — every LLM call site goes through `callProviderChat`, or replicates both of its
guarantees**: a generous `max_tokens` (≥4000, since a thinking model bills its reasoning against
the same cap) and `extractContent` at the reply boundary, which falls back to
`reasoning_content`/`reasoning` when `content` comes back empty [@claude-md] [@llm-call-js]. A
new raw provider fetch is a review flag; grep for `max_tokens` when touching one. This was paid
for twice: triage (0.8.82), then the Discord turn path (0.9.7, empty turns and tool calls cut
mid-JSON), because the first fix lived in `llm-call.js` alone and Discord's own raw fetch never
got the memo [@claude-md].

**RULE B — budget exhaustion is never silence.** Every cap, limit, timeout, or retry ceiling
must define, before it is built: what the ward sees, what the Familiar is told (its own tool
result must record that an action did not run — a dropped cutoff manufactures confident
confabulation, not an honest gap), and the log line [@claude-md]. The round-cap closing text
round (0.9.7, tuned per-surface in 0.9.8) is the reference implementation: on tool-round budget
exhaustion, force one closing text round with tools stripped, plus a first-person note that the
pending calls did not run [@claude-md].

**RULE C — a capability lands in the shared turn path, or the spec carries a surface matrix.**
Turn-machinery features must live in code every surface shares; where per-surface wiring is
unavoidable, the build spec must contain an explicit matrix (web live turn / web tool rounds /
Discord ward / Discord villager+ambient / background loops), each cell marked wired-or-N/A, in
the same commit as the feature [@claude-md]. The incident: Discord shipped without the
synchronous-describe wiring [Vision and media](../architecture/vision-and-media) gave the web
path (0.9.6) — web got `ensureDescribed`, Discord silently didn't, and the Familiar described
images on Discord it had never actually looked at [@claude-md]. `ensureDescribed`'s sibling for
voice notes, `ensureTranscribed` in `voice-transcribe.js`, was built with the lesson already
applied: both surfaces gained it in the same change, and its own doc comment names
`ensureDescribed` as the reason it exists [@voice-transcribe-js].

## Safety-critical sign-off

Behavioral changes (not relocations, comments, or renames) to `crisis-signals.js`,
`threat-tracker.js`, `silence-triage-loop.js`, the triage/delivery/escalation logic in
`cerebellum.js`, or the `[CARE CHECK]` assembly in `thalamus.js` require asking the human
before shipping [@claude-md]. See [Proactivity over caution](../decisions/proactivity-over-caution)
and [Safety spine](../architecture/safety-spine) for why.

## Test discipline: assert, not narrate

A test file must contain assertions. A passing test that is mostly prose narration
("this function works because…"), even when correct in intent, is a smell: it is brittle,
gives false confidence, and rots into dead code. The 0.9.0 full-codebase audit (shipped as
0.9.0-alpha, PR #211) caught a date-handling bug in the availability calculator because the
covering test was an AI debugging monologue asserting nothing—just describing what *should*
happen instead of verifying what *does*. Test the actual wire shape, not a convenient
stand-in: if the code must handle bare date strings like `2026-07-06`, the test must exercise
exactly that shape, not a convenience substitute.

## Guards on shared primitives demand full-suite audit

A guard (a fail-closed check that blocks some input or behavior) applied to a function used
by many callers is easy to introduce and easy to break downstream. The 0.8.99 recurring-series
guard was tested in isolation and passed; when only the schedule/server subset of the full
Unruh test suite was run at merge time, gcal's internal cancel logic broke silently. Lesson:
when a guard ships on a shared primitive, the same commit must audit every internal caller of
that primitive in the full test suite. A subset run (schedule-specific, server-specific) is
not sufficient. Run the full suite before claiming the guard is safe. This pattern was exposed
by the 0.9.0 full-codebase audit (PR #211).

## Accessibility is a contract, not a "nice to have"

Proto-Familiar ships with [WCAG 2.0 AA](https://www.w3.org/WAI/WCAG21/quickref/) as an
explicit requirement. The 0.9.0 full-codebase audit found and fixed: pinch-zoom disabled
(no interaction mode for touch users), keyboard focus invisible on buttons (no focus indicators
for keyboard users), and text-muted foreground at ~2:1 contrast (text readability). Contrast
ratios are documented inline in `style.css` with precise values so future changes can be
verified without manual testing. The conventions are recorded in `CLAUDE.md` with "hold the
WCAG line" as the operating principle.

## Cross-language MCP contracts: a silent-failure bug class and its gate

Thalamus (JS) calls [Phylactery](../architecture/phylactery) and [Unruh](../architecture/unruh)
(Python) MCP tools with `callTool({ name, arguments })`, and `arguments` is an opaque object —
nothing in the JS toolchain checks its keys against the Python tool's `@mcp.tool` parameter
names [@audit-mcp-script]. That gap produces three distinct failure shapes, and all three fail
**silently**: invisible to `node --check` and to every JS-only wiring audit (imports, exports,
endpoints, loops), because the mismatch only exists at the JS↔Python argument boundary
[@audit-mcp-script].

- **Wrong/misnamed arg.** Pydantic drops the unknown key and the tool's actually-required
  parameter is now missing, so FastMCP returns an `isError` result the JS wrapper often never
  inspects — the HTTP layer answers `{ok:true}` while nothing was written.
- **Extra arg the tool doesn't accept.** Pydantic silently drops it, so a filter or flag the
  caller believes it is passing does nothing.
- **A tool name that doesn't exist.** The call throws; if the caller wraps it in a
  swallow-and-log `try`/`catch`, the feature goes inert with only a log line as evidence.

Four instances shipped before the gate below existed [@audit-mcp-script]: `identity_update_section`
sent `heading` where the tool wanted `section` (silent no-op write, HTTP still reported
`{ok:true}`); `graph_node_search` sent `type`, which the tool did not accept, so a
type-filtered graph search silently returned every type (`graph_node_list` did support the
filter — only `search` was missing it, fixed by adding the filter to Phylactery);
`interest_report_surfacing_outcome` — the Unruh tool did not exist at all, see below; and
`graph_node_delete` sent a dead `permanent` flag that Phylactery's delete tool does not
accept — it only hard-deletes a node and its edges — removed end-to-end from thalamus's call
site [@thalamus].

**The gate.** `scripts/audit-mcp-contracts.mjs` (`npm run audit:mcp`) parses every thalamus MCP
call site and every Phylactery/Unruh `@mcp.tool` signature, then flags UNKNOWN tool names,
BAD-ARG keys that are not a parameter of the tool, and MISSING-REQ parameters a call never
sends [@audit-mcp-script]. `tests/mcp-contracts.test.mjs` asserts the check returns no findings,
so a future mismatch fails CI instead of reaching a ward's data [@mcp-contracts-test]. It
catches all four instances above.

**Its limit, stated so nobody over-trusts it:** the gate checks argument names, tool existence,
and required-parameter presence only — **not** types and **not** semantics
[@audit-mcp-script]. A call that sends a correctly-named argument with the wrong type (a string
where the tool wants a list), or the right name and type with the wrong meaning (a
local-naive timestamp where the tool expects UTC — the class behind the 0.7.84 reminder bug,
see [Unruh](../architecture/unruh)), still passes. Static name-checking cannot decide either
case: the call sites are untyped JS, and meaning is not decidable from syntax alone. Catching
those classes needs a cross-process integration test that actually spawns the peer and asserts
behavior, not a static contract check — see the smoke test below for the coverage that fills
this gap.

**Checker precision fix (0.10.109-alpha).** The gate originally resolved `arguments: someVar`
by a global first match of `const/let/var someVar = {...}`, but variable names like `args` are
reused across many call sites, so a global first match could resolve the wrong assignment
entirely. It now resolves to the NEAREST-PRECEDING assignment above the call site and folds in
any incremental `someVar.key = …` assignments between that point and the call
[@audit-mcp-script]. This mattered concretely: `temporal_context`'s `mode` argument (see
[Unruh](../architecture/unruh)) was assembled into a separate `const unruhArgs` object, so the
old resolver validated only that the tool existed, never that `mode` was one of its keys.
Removing `mode` from the Python tool now correctly flags `BAD-ARG unruh.temporal_context`.

## The isError-swallow class: a runtime gap the static gate can't catch

The contract gate above checks argument *names* against the Python signature; it says nothing
about whether a caller correctly reads the *result* of a call. `callTool` from
`@modelcontextprotocol/sdk` does not throw when a Python tool raises — a pydantic validation
error from a bad or missing argument, or any other exception, comes back as a **resolved**
result with `isError: true` [@phylactery-result]. A wrapper that only reads
`content[].text` and falls through to a `{ ok: true }` fallback when that text does not parse
as the tool's normal JSON reports success on a failed write — the error text isn't the tool's
JSON payload, so the fallback wins silently. This is the exact class behind the
`identity_update_section` bug, which had previously been fixed at only that one call site.

A 0.10.108-alpha audit found the fix had not generalized: **28 mutating Unruh wrappers** in
`thalamus.js` returned `parseToolText(r, { ok: true })`, plus 2 more returned `true`
unconditionally, so all 30 reported success on any Unruh raise. The root-cause fix is two
pieces:

- `phylacteryToolError` was generalized into server-agnostic `mcpToolError(result)` in
  `phylactery-result.js`: `isError` is set by both Phylactery and Unruh on a raise, and the
  "Failed:" prefix check is Phylactery's own deliberate-failure convention layered on top — a
  harmless no-op check against Unruh, whose success payloads are JSON starting with `{`
  [@phylactery-result].
- `unruhResult(result, fallback)` in `thalamus.js` calls `mcpToolError` first: an error result
  becomes honest `{ ok: false, error }`; a success result returns the tool's own JSON payload
  (which already carries `ok`) [@thalamus]. All 28 write wrappers plus the original
  `identity_update_section` site now route through it.

Reads are deliberately **not** routed through `unruhResult` — they still degrade to an empty
payload on failure (absence renders as absence), which is this page's own Graceful degradation
rule's intended behavior for a peer being down. Only the write class, where a silent success is
the dangerous outcome, is made honest. The general lesson: the static contract checker matches
argument *names*, and structurally cannot see whether a caller reads a raised error as success
— that is runtime error-handling behavior, not a naming mismatch, and it needs a different kind
of check.

## Cross-process MCP smoke test

`tests/mcp-smoke.test.mjs` closes the gap the previous two sections both point at: it spawns the
**real** Phylactery and Unruh MCP children through thalamus (not stubs) and round-trips
representative tools, asserting actual behavior and actual return shapes — catching type or
semantic mismatches that neither the static gate nor a pure-function unit test can
[@mcp-smoke-test]. Its cases include `saveBookmark` → `listBookmarks` (the M8 write side,
exercised cross-process, see [Unruh](../architecture/unruh)); a call with a missing required
argument, asserting the resulting pydantic `isError` surfaces as an honest `{ ok: false }`
through `unruhResult` against a real raise rather than a stub; `bumpInterest` →
`listInterests`; and Phylactery's `getMemoryHealth`. The suite self-skips when `uv` or the
Python venvs are absent (CI without Python), so a missing toolchain never reddens the suite
[@mcp-smoke-test].

Isolating the test from dev data required a store override: `UNRUH_DB_PATH` and
`PHYLACTERY_DB_PATH` relocate each server's sqlite file, read in `default_db_path()` on both the
Unruh and Phylactery sides, and forwarded into the spawned child's environment by
`thalamus.js` only when set [@mcp-smoke-test] [@thalamus]. The forwarding is explicit because
these variables are not in the MCP SDK's inherited-environment allowlist — the SDK's stdio
transport merges only its own default environment plus `serverParams.env`, so an unlisted
variable never reaches the child unless the caller adds it itself. Production spawns are
unaffected when the variables are unset, and the same override lets an install relocate its
data directory generally, not just under test.

**The meta-lesson.** A JS-internal wiring audit has a structural blind spot at every
language/process boundary. "Thorough audit" must explicitly include cross-boundary contract
checks, boundary-crossing tests for the type/semantic classes a static check can't decide, and a
check on runtime error-handling at the boundary — not just intra-language imports, exports,
endpoints, and argument names. See [Unruh](../architecture/unruh) for the concrete feature
(bookmark resurfacing) this blind spot hid pieces of across two consecutive audit passes.

## Sibling tool names must be prefix-distinct

An LLM selecting a tool by name is misled when two sibling tools share a prefix: reaching for
the shorter name gets railroaded into the longer one. This shipped as a live bug — the Familiar
trying to call `intention_set` was routed into `intention_set_rounds_visibility`, so it couldn't
set intentions at all. The fix (0.11.16) was to rename the longer tool to `intention_visibility`
so the names no longer collide on the `intention_set` prefix; only the model-facing name changed
(the tool definition, its executor key, and the surfacing-module map), while the internal Unruh
MCP call kept its own name [@cerebellum-js]. The convention: when two Familiar-facing tools are
siblings, make sure neither name is a prefix of the other — the model picks by name, and a
shared prefix is a selection hazard, not just a cosmetic overlap.
