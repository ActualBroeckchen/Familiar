---
title: "Browser Milestone: Guardrails in Code, Not Prompts"
topics: [decisions, safety, browser]
sources:
  - id: browser-build-spec
    type: file
    path: docs/browser-build-spec.md
  - id: websearch-js
    type: file
    path: websearch.js
  - id: village-js
    type: file
    path: village.js
  - id: browser-grants-js
    type: file
    path: browser-grants.js
  - id: browser-lens-js
    type: file
    path: browser-lens.js
  - id: browser-driver-js
    type: file
    path: browser-driver.js
  - id: browser-js
    type: file
    path: browser.js
  - id: ponder-research-js
    type: file
    path: ponder-research.js
---

# Browser Milestone: Guardrails in Code, Not Prompts

**Status: Pass 1 through Pass 4 decided and shipped (0.11.0 / 0.11.1 / 0.11.3 / 0.11.4 / 0.11.5 /
0.11.6 / 0.11.7).** `docs/browser-build-spec.md` specs a MINOR milestone — the
Familiar using the web (click, fill, scroll, multi-step flows) instead of only reading it
through `read_webpage` [@browser-build-spec]. It is a cognition layer over `playwright-core`,
built on the existing web-search stack (`websearch.js`'s `look_up` / `web_search` /
`read_webpage`) and modeled on two external references: agent-browser's dense-ref token model
and Sigil's doctrine of deterministic, code-level guardrails instead of prompted ones
[@browser-build-spec]. Pass 1 (the driver, the lens, the guarded proxy,
`browse_open`/`see`/`act`/`close`, the audit log), Pass 2 (screenshots, tabs, downloads,
history), Pass 3a (site modes and credential/payment fill hardening, 0.11.3), and Pass 3b (the
consent ceremony, credentials vault, fill-source gate, confirm-domain refusal, and
`browse_handoff`, 0.11.4) are all built and described on
[Browser: click-and-fill web access](../architecture/browser); this page records the design
decisions a second spec review settled — not the whole spec, which stays authoritative for the
mechanics, but the *why* behind the choices that are easy to get wrong or quietly re-litigate
later. Each one reuses an existing Proto-Familiar defense rather than inventing a parallel one,
which is the throughline: SSRF reuses `websearch.js`'s IP guard, page trust reuses Village's
floor tier, and credential handling reuses [Exact values are code's job](exact-values-in-code).
Pass 3 split by risk: 3a covers gates that decide synchronously with no ward involvement, and 3b
covers the surfaces that either need the ward in the loop (`browse_handoff`) or are dangerous
enough to require an explicit, hand-edited consent file (the credentials vault, payment fill,
confirm-domain auto-submit).

## SSRF is enforced by a proxy the app owns, not `context.route`

Two naive designs for blocking requests to loopback/private/link-local/metadata addresses both
fail against a browser engine specifically, because Chromium resolves DNS itself: a pre-`goto`
host check races a DNS rebind (the app's own lookup sees a public IP, the browser's later lookup
sees a private one — a TOCTOU gap), and Playwright's `context.route` handler only ever exposes
`request.url()`, never the resolved socket IP, so it cannot structurally implement "block by
resolved IP" at all [@browser-build-spec].

The spec's fix is to launch Chromium through a small in-process CONNECT proxy the app owns
(`launch({ proxy })`). The proxy becomes the single resolution point for every request the
browser makes, main navigation and subresources alike: it resolves the host, runs `websearch.js`'s
existing `isBlockedIp` over the real connect target, refuses the blocked ranges, and connects to
the exact IP it just checked — so the browser and the guard can never disagree on what address is
actually being reached [@browser-build-spec] [@websearch-js]. `browse_open` and redirect hops
still run the existing `assertPublicUrl` as a fast pre-check, but the proxy, not the pre-check, is
the enforcement floor [@browser-build-spec] [@websearch-js]. This closes main-navigation,
subresource, and DNS-rebinding SSRF in one mechanism instead of three separate patches, and it
means the browsing milestone does not reinvent `isBlockedIp` — it launches Chromium through a
network chokepoint that calls the same function `read_webpage` already trusts.

## A web page is a Stranger from day one

Page content enters at the lowest trust tier Village has — the same tier `village.js` locks to
`strangers`, whose grants are forced to `{}` and cannot be widened by the ward
[@village-js]. Concretely: a page's text can never direct the Familiar, name a tool to run, or
move any safety state — it cannot raise or lower the ward's threat tier or trip a care-check. The
precedent this borrows directly is the image-derived threat gate on the [Safety spine](../architecture/safety-spine):
`scoreImageDescriptionThreat()` only ever moves threat state for images stamped
`audienceTag === 'ward-private'`, so a villager's shared bytes can never alter the ward's safety
tracking. The browser milestone applies the identical discipline to page content: nothing a page
says can move safety state, full stop [@browser-build-spec].

Every string a page contributes is provenance-stamped `source:'web'`, and — mirroring the rule
that a stranger's bytes are not stored — nothing a page says reaches a Tome silently. The gist of
a read only lands in memory through the Familiar's own deliberate `save_to_tome` act, never an
automatic sweep [@browser-build-spec]. Starting this strict is a deliberate floor, not a final
verdict: the spec's own §15 flags revisiting a finer-grained trust/privacy tier for the browser
once real usage and an audit-log history exist, and states plainly that loosening the Stranger
default is a ward-signed change, never a silent one [@browser-build-spec].

## Credential and file-field refusal is on the source of the bytes, not the field

`browse_act` refuses any model-supplied `value` into a password field or anything
heuristically credential-shaped, and no UI setting loosens it — the refusal is keyed to *where
the bytes came from*, not to the field alone, so the model is structurally incapable of supplying
a secret [@browser-build-spec]. Ordinary logins happen once, by the ward's own hands, in the
`browse_handoff` window; the browser profile keeps the resulting session cookie afterward
[@browser-build-spec].

The only path that can still fill such a field is code-typed vault fill, gated behind a
hand-edited `browser/autonomy-grants.json` (no UI, an exact-string acknowledgment sentence
required byte-for-byte, absent-or-malformed file means every grant reads false) plus a
`browser/credentials-vault.json` the app never reads through any Familiar tool
[@browser-build-spec]. This shipped as specced in Pass 3b (0.11.4): `browser-grants.js`'s
`readGrants()` re-reads the grants file on every call rather than caching it, so a revoked grant
can never stay alive on stale state, and `readVaultEntry(name)` is inert unless the matching
`credentials`/`payments` grant is active [@browser-grants-js]. With a `credentials` grant, the
Familiar names a vault entry and code reads and types the secret — the password never enters a
prompt, a tool result, a session log, or the audit trail [@browser-grants-js]. The pure decision
of *which* bytes a given field may accept lives in `browser-lens.js`'s `evaluateFill()`, kept
separate from the grants file so the safety-critical judgment is unit-tested without a browser
[@browser-lens-js]; see [Browser: click-and-fill web access](../architecture/browser) for the
mechanics. This is
[Exact values are code's job](exact-values-in-code) applied to secrets instead of timestamps or
ids: the model points at a named thing, code alone touches the value. File inputs (`<input
type=file>`) are refused by the same code floor, for the same reason `own-files.js` denies the
vault to every Familiar tool — there is no path in this milestone by which a page may be handed
the ward's files [@browser-build-spec].

## A dialog can be answered, but never used to escalate

The Familiar may answer a benign `confirm()` rather than always dismissing blind, but the spec
pins the boundary carefully so a dialog can never become a side door around the other guardrails.
This shipped in `browser-driver.js`'s `act()`, which takes an `onDialog` parameter
(`browse_act`'s `on_dialog`, wired through `browser.js`) that defaults to `'dismiss'` — the safe,
negative answer [@browser-driver-js] [@browser-js]. The verdict surfaces the dialog's text,
itself framed as Stranger-tier content, never as an instruction, and the Familiar may then
re-issue the act with `on_dialog:'accept'` having seen that text, so an accept is always made
with the words in hand, never blind [@browser-build-spec] [@browser-driver-js]. The load-bearing
rule is that **an accept is exactly as powerful as clicking the button that raised the dialog**,
so it is gated identically: every refusal the triggering act was already subject to — payment or
credential fields, a `browseConfirmDomains` submit, the active site mode — still holds, and a
dialog can never launder a gated action [@browser-build-spec]. `alert()` is acknowledged (its
only option), `beforeunload` is accepted (it only guards the Familiar's own chosen navigation),
and `prompt()` defaults to `dismiss` because typing a value into a page-requested prompt carries
the same page-instruction-becomes-Familiar-input risk as a credential field
[@browser-build-spec]. Popups and new tabs are captured into the same guarded context, counted
against the tab cap, and hit the SSRF proxy exactly like any other navigation — no window ever
runs outside the guards [@browser-build-spec].

## Handoff falls back to headless, never pops a window nobody is at

`browse_handoff` is the tool for moments that belong to the ward — logins, payments, CAPTCHAs. It
shipped in Pass 3b (0.11.4): `browserStatus()` exposes the driver's `hasDisplay()` result
alongside the current URL and active grants, and `browse_handoff` reads it to decide which path
to take [@browser-js] [@browser-driver-js]. When a local display exists, it opens the current
page headed on that display, explains why, and pauses until the ward hands it back, never having
seen the password or card number [@browser-build-spec]. When no display exists — a headless
server, no `DISPLAY`, or a remote ward — the browser stays headless: the shipped code parks the
action and logs `parked for ward: <reason>` to the audit trail instead of trying to pop a window
nobody is at [@browser-js]. The browser and its profile stay alive so the Familiar resumes the
instant the ward's part is done through whatever surface they used [@browser-build-spec]. A
headed window is the nicer path when it exists, not a requirement the tool can fail on.

The automatic hand-back-and-resume flow named as pending in the original review shipped in
0.11.6. Because only one Chromium instance may hold the persistent profile at a time, and
Playwright cannot toggle a live context between headless and headed, resume is a relaunch dance
rather than a flag: `driver.openHeaded()` closes the headless context and reopens the same
profile headed; `POST /api/browser/handback` closes the headed context and reopens headless at
the same URL, now carrying whatever cookies the ward's session left behind
[@browser-driver-js]. While a handback is pending, `ensureContext` throws so the profile can
never be double-opened, and every `browse_*` op degrades to a calm wait instead of an error
[@browser-driver-js] [@browser-js]. See [Browser: click-and-fill web access](../architecture/browser)
for the mechanics; only a co-located desktop install benefits, since the server process needs
display access, and a failed headed launch still falls back to the honest park rather than a
broken promise. Driving the ward's own already-logged-in Chrome remotely — the highest-stakes
variant, and the one capability explicitly *not* copied from Sigil — stays a pinned horizon
item, not part of this milestone [@browser-build-spec].

## `[CONFIRM]` gained an opt-in approve-resume path (0.11.5)

The hard refusal described above is the shipped default and remains unchanged. `browseConfirmMode:
'ask'` is the approve-then-resume alternative named as pending in the original review: instead of
refusing a submit-shaped act on a `browseConfirmDomains` host outright, `act()` holds it in
`state.pendingConfirms` and returns `{held: true}` [@browser-driver-js]. The property that keeps
this from becoming a self-approval side door is where the approval comes from: a Settings button
posts to `POST /api/browser/confirm`, never a model tool argument, so no page content can talk the
model into supplying its own approval [@browser-driver-js]. On approval, `resolvePendingConfirm()`
resumes the stored act through the normal `act()` path with `autoSubmit` lifted for that one call,
so the same generation guard described below still applies — a page that changed since the ward
approved fails rather than clicking whatever now occupies that ref [@browser-driver-js]. See
[Browser: click-and-fill web access](../architecture/browser) for the full mechanics.

## Ref-to-locator resolution fails loud instead of clicking the wrong element

The reliability crux of the lens (`browser-lens.js`, landing in Pass 1) is that a ref handed back
to the model must keep pointing at the same element, and must fail loud rather than act on the
wrong one once the page has moved. The spec deliberately does not hold live Playwright
`ElementHandle`s across turns — they pin DOM nodes and die silently on navigation. Instead each
snapshot mints a ref (`r3`, `r14`) alongside a regenerated role-plus-accessible-name locator,
re-resolved against the live DOM only at act time [@browser-build-spec]. A page-generation token
bumped on navigation or major DOM mutation lets `browse_act` refuse a stale-generation ref up
front, and at act time the resolved locator must match exactly one element — zero or more than one
is a structured error, never a coin-flip on the first match [@browser-build-spec]. The failure
mode this buys is always "re-observe, then retry," never "clicked something the model never
named."

## Build order defers `read_webpage`'s re-backing past both shipped passes

Pass 1 shipped the driver, the lens, `browse_open/see/act/close`, the SSRF proxy, and the audit
log, but deliberately left `read_webpage` on its existing static extractor rather than routing it
through the new browser driver immediately [@browser-build-spec]. The reasoning: the driver
(crash supervision, idle reaper, the CONNECT proxy) was unproven in Pass 1, and `read_webpage` is
an always-on, widely-used tool — routing it through a brand-new subsystem in the same pass that
subsystem first ships would put unproven code straight into the hot path of existing behavior.
`browse_*` proved the driver first; the spec placed `read_webpage`'s replacement (the static
extractor retained as the degradation floor, selectable via `webReadBackend:'static'`) in Pass 2
[@browser-build-spec], but as shipped through 0.11.7, that re-backing is still deferred — see
[Browser: click-and-fill web access](../architecture/browser) for the current state of the tool
surface. Pass 3 added the sovereignty surfaces (site modes, the consent ceremony, the
credentials vault, the fill-source gate, the confirm-domain refusal, and `browse_handoff`) across
0.11.3 and 0.11.4, and its two named refinements (`browseConfirmMode: 'ask'` approve-resume and
headed handoff hand-back-and-resume) shipped in 0.11.5 and 0.11.6, so Pass 3 is now fully
shipped. Pass 4 (0.11.7) shipped read-only unattended research on pondering ticks — the one
deliberate exception to the project's usual "ride existing requests, never poll" rule for
background work — described in the section below.

## Pass 4 (0.11.7) inverts agency instead of adding a tool loop

The spec described Pass 4 as a read-only *tool-calling* loop layered on `browse_*`. The shipped
design, `ponder-research.js`, deliberately diverges: it is a **plan-and-read loop**, not a
tool-calling loop, and the divergence is itself the decision worth recording
[@ponder-research-js]. The reasoning is about *where* the loop runs: [pondering](../architecture/pondering)
fires unattended, with no ward nearby to notice odd behavior mid-tick. In that context the
Familiar should get **less** agency than it has on a live chat turn, not more — the opposite of
what handing it a `browse_*` tool surface would do [@ponder-research-js].

Concretely, the model in `researchForPonder()` only ever returns JSON naming what it wants —
`{searches, reads, done}` — and code alone performs the bounded reads (`websearch.js`'s
`searchWeb`/`readWebpage`, or a browser-backed `browseRead` when available) [@ponder-research-js].
There is no tool surface at all for a hostile page to misuse, even via malformed model output,
because reads are idempotent and there is no act path to reach — a stronger safety property than
a read-only tool loop would have offered, since a tool loop still hands the model a callable
surface a crafted page could try to talk it into misusing. This is the same "gate in code, not in
the prompt" doctrine as the rest of the milestone, applied to the shape of the loop itself rather
than to a single gate inside it.

Two bounds keep the added request volume small: `ponderWebRoundsPerTick` clamps the loop to
1–10 rounds, and a shared per-day read budget (`ponder-web-budget.js`, day-keyed and fail-closed)
caps total reads regardless of how many ponder ticks fire [@ponder-research-js]. An exhausted
budget is never a failed call — the ponder prompt says plainly that it is thinking from what it
already holds — because the deliberate exception to "ride existing requests, never poll" is
scoped narrowly: the research itself is the feature, and the round cap plus budget are what keep
that exception bounded rather than open-ended. See [Pondering](../architecture/pondering) for how
the research gate sits inside `ponderOnce()`, and [Browser: click-and-fill web access](../architecture/browser)
for the module's place alongside the rest of the browser subsystem.

## Consequences

Because every guardrail above is enforced in code at the network or action layer, the injection
resistance this milestone needs does not depend on prompt framing holding under an adversarial
page — matching the "gate in code" doctrine already established for [Injection guard](../architecture/injection-guard-gap)
and [Content-based memory gating](../architecture/content-gating). A future implementer must not
loosen the Stranger default, the credential-refusal boundary, or the handoff headless fallback as
local conveniences; each one is a ward-signed floor, and the spec names loosening any of them as
its own decision to reopen, not a bug to quietly fix. The build-order deferral means
`read_webpage` keeps its static-extractor behavior even after Pass 1 through Pass 4 shipped in
0.11.0/0.11.1/0.11.3/0.11.4/0.11.5/0.11.6/0.11.7 — a reader should not expect the browser-backed
reading path until a future pass flips it over. `browse_handoff`, the autonomy grants, vault-fill
credentials, `browseConfirmMode: 'ask'` approve-resume, the headed handoff hand-back-and-resume,
and Pass 4's plan-and-read pondering research are all now shipped and can be relied on. Because
Pass 4's design diverged from the spec's read-only tool-loop description, a future implementer
should not "fix" `ponder-research.js` back toward a tool-calling shape without re-reading the
agency-inversion reasoning above — the divergence is the safer design, not an unfinished one.
