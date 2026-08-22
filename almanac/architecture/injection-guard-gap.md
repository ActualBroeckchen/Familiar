---
title: "Injection Guard: From Documented-but-Unwired to Two Wired Boundaries"
topics: [architecture, safety]
sources:
  - id: injection-guard
    type: file
    path: injection-guard.js
  - id: injection-guard-tests
    type: file
    path: tests/injection-guard.test.mjs
  - id: claude-md
    type: file
    path: CLAUDE.md
  - id: architecture-doc
    type: file
    path: docs/architecture.md
---

# Injection Guard: From Documented-but-Unwired to Two Wired Boundaries

**Status: RESOLVED (0.8.57).** `injection-guard.js` was built, tested, and documented as a
running defense for two audits before anyone checked whether any runtime code actually called
it — none did. After reviewing this finding, the maintainer directed wiring at
two boundaries — web reading (the guard's original intent) and Village communications — with
two hard constraints: it must never block the relay system, and it must never block threat
triage in a group setting. What shipped:

- **Web:** `websearch.js` sanitizes search titles/snippets, `look_up` reference text, and
  `read_webpage` extractions at the module's return boundaries (URLs deliberately untouched so
  the read_webpage follow-up keeps working). The guard also became escape-tolerant for bracket
  markers, because turndown renders `[SYSTEM]` as `\[SYSTEM\]` at exactly this boundary. The
  [browser milestone](browser)'s `browser.js`, shipped later (0.11.0), is a second wired call
  site: every page snapshot and act verdict passes through `sanitizeExternal()` before it can
  reach a prompt, on top of the Stranger-tier framing that page content also gets there.
- **Village:** `discord-gateway.js`'s new `inboundContent()` helper (both ingestion sites —
  spoken turns and observed messages) sanitizes villager/stranger text only. The constraints
  are structural, not behavioral: the ward's own words never pass through the guard on any
  path (threat scoring reads them raw; a redacted distress line could read as a jailbreak to
  triage), no outbound path (replies, `relay_message`, `relay_to_ward`, trusted-contact
  delivery) passes through it, and the guard's span-surgical redaction means a villager
  genuinely relaying distress passes byte-identical. Each constraint is pinned by a test.

Still deliberately unwired: Phylactery/Unruh recall (first-party stores; villager-written
memories carry provenance labels instead) and gcal event titles (the ward's own calendar).
The history below is preserved as the record of how the gap happened.

## The original finding (0.8.55 audit)

`injection-guard.js` exports a real, tested pattern scanner and sanitizer
(`scanForInjection`, `sanitizeExternal`) with a full unit-test file covering instruction-
override phrases, fake system markers, and per-source contexts [@injection-guard]
[@injection-guard-tests]. `CLAUDE.md`'s file table describes it as "pattern scanner +
sanitizer applied at every external-data boundary" [@claude-md], and `docs/architecture.md`
repeats the same claim [@architecture-doc]. The
[trust-tiers decision](../decisions/trust-tiers-gate-reads-not-writes) discusses it as one of
the repo's real defenses.

**None of that is true at runtime.** A history-wide search
(`git log --all -S 'sanitizeExternal' -- <runtime files>`) returns nothing: no runtime module
has ever imported or called either export, in any commit. The only consumer is the test file.
The module was built, tested, and documented — and the wiring step never happened. Its only
trace in runtime code is a comment in the triage prompt assembly explaining why the guard is
deliberately *not* applied to the ward's own words ("the injection guard is for third-party
external data, not words my human has said") — a correct scoping decision for a defense that,
as of this writing, runs nowhere.

## Why this mattered more than ordinary dead code

This was the exact failure `CLAUDE.md`'s capability-reachability rule names as "dead code that
looks like care," but on the *defensive* side: three layers of documentation asserted a
protection that did not exist, so every design conversation up to that point (including the
vision and browser build specs, which both leaned on "passes through injection-guard.js" as a
mitigation) inherited a false premise. Before the fix, external data reaching prompts
unsanitized included at minimum: web page extractions (`read_webpage`/`web_search` results),
Discord villager and stranger message content, and gcal-synced event titles. Villager-authored
memory content surfaced on recall was, and remains, out of scope — see below.

## Where the guard was wired, and why the boundaries needed judgment

Deciding where to apply the guard was not mechanical — the candidate boundaries differed in risk
and in cost-of-mangling, which is why the shipped scope (web reads plus Village communications,
in the section above) is narrower than "every external boundary":

1. **Web reads** were the broadest surface and the clearest win (third-party text, no dignity
   cost to sanitizing) — this is why they shipped first.
2. **Villager/stranger Discord content** is external but is also *conversation* — sanitizing it
   risks distorting what a villager actually said, so the audience-gating and provenance systems
   were already carrying part of this load structurally before the guard was wired here too.
3. **The ward's own words are exempt by design** (the triage comment referenced above records
   why: replacing a ward's distress phrasing with `[removed: …]` could cause the triage LLM to
   dismiss genuine crisis as a jailbreak attempt).

**Deliberately still unwired, by ongoing design choice rather than oversight:** Phylactery/Unruh
recall (first-party stores; villager-written memories carry provenance labels instead of
sanitization) and gcal event titles remain outside the guard's scope. Prompt-injection defense
for those two surfaces rests on the structural systems (audience gating, fail-closed read
scoping, provenance labels, code-gated actions) rather than on text sanitization.

## Related

- [Trust tiers gate reads, not writes](../decisions/trust-tiers-gate-reads-not-writes) — the
  page that treats pattern filtering as explicitly *insufficient* on the write side; this gap
  means even the read-side pattern layer it contrasts against was not actually running.
- [Engineering conventions](../reference/engineering-conventions) — the capability-
  reachability rule this defect is the defensive-side mirror of.
- [Browser milestone: guardrails in code, not prompts](../decisions/browser-guardrails-in-code)
  — the design decisions behind the browsing milestone's deterministic code guardrails (an SSRF
  proxy, a Stranger-tier default for page content), layered on top of this now-wired injection
  guard rather than relying on prompt framing alone; see [Browser](browser) for the shipped
  subsystem itself.
