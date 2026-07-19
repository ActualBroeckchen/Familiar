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

Familiar ships with [WCAG 2.0 AA](https://www.w3.org/WAI/WCAG21/quickref/) as an
explicit requirement. The 0.9.0 full-codebase audit found and fixed: pinch-zoom disabled
(no interaction mode for touch users), keyboard focus invisible on buttons (no focus indicators
for keyboard users), and text-muted foreground at ~2:1 contrast (text readability). Contrast
ratios are documented inline in `style.css` with precise values so future changes can be
verified without manual testing. The conventions are recorded in `CLAUDE.md` with "hold the
WCAG line" as the operating principle.
