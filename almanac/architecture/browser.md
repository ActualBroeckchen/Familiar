---
title: "Browser: Click-and-Fill Web Access"
topics: [architecture, browser, safety]
sources:
  - id: browser-lens-js
    type: file
    path: browser-lens.js
  - id: browser-proxy-js
    type: file
    path: browser-proxy.js
  - id: browser-driver-js
    type: file
    path: browser-driver.js
  - id: browser-js
    type: file
    path: browser.js
  - id: browser-grants-js
    type: file
    path: browser-grants.js
  - id: browser-audit-js
    type: file
    path: browser-audit.js
  - id: cerebellum-js
    type: file
    path: cerebellum.js
  - id: package-json
    type: file
    path: package.json
  - id: browser-build-spec
    type: file
    path: docs/browser-build-spec.md
  - id: browser-tools-test
    type: file
    path: tests/browser-tools.test.mjs
  - id: ponder-research-js
    type: file
    path: ponder-research.js
  - id: ponder-web-budget-js
    type: file
    path: ponder-web-budget.js
  - id: browser-driver-test
    type: file
    path: tests/browser-driver.test.mjs
  - id: page-watch-js
    type: file
    path: page-watch.js
  - id: page-watch-loop-js
    type: file
    path: page-watch-loop.js
  - id: browser-server-js
    type: file
    path: server.js
  - id: slug-ids-js
    type: file
    path: slug-ids.js
  - id: browser-cdp-spec
    type: file
    path: docs/browser-cdp-mode-build-spec.md
---

# Browser: Click-and-Fill Web Access

The browser subsystem lets the Familiar navigate, read, and act on live web pages —
click, fill, scroll, and multi-step flows — instead of only reading a page through the
existing static `read_webpage` extractor. It shipped in five passes: Pass 1 (0.11.0, the
spine: driver, lens, guarded proxy, `browse_open`/`see`/`act`/`close`, the audit log), Pass 2
(0.11.1, screenshots, tabs, downloads, history), Pass 3a (0.11.3, synchronous safety gates),
Pass 3b (0.11.4, the ward-in-the-loop and consent-gated surfaces), and Pass 4 (0.11.7,
unattended web research on [pondering](pondering) ticks), followed by two async
refinements to Pass 3b's synchronous hard-stops: `browseConfirmMode: 'ask'` approve-resume
(0.11.5) and headed handoff hand-back-and-resume (0.11.6)
[@package-json] [@browser-driver-js] [@browser-js] [@browser-grants-js] [@ponder-research-js].
`docs/browser-build-spec.md` is the design document the Pass 1 through 3b work implements; Pass
4 shipped as a deliberate divergence from that spec — see the "Pass 4" section below and the
[Browser milestone: guardrails in code, not prompts](../decisions/browser-guardrails-in-code)
decision page, which records why its guardrails, including Pass 4's, are shaped the way they
are. This page describes the modules that exist in the repo today and how they fit together,
using the built code — not the spec — as the source of truth for what actually runs.

Work continued past the spec's four passes: two Chromium-acquisition hardening fixes (0.11.11 /
0.11.12, covered below), page watches (0.11.13, a scheduled watch-and-notify loop that reuses
the static web-read path rather than the driver), and a run of interaction-model refinements
(0.11.14–0.11.16) that made refs meaning-bearing, let the model act by naming what it sees, gave
it awareness of images on a page, and added page-level scroll. A CDP-attach engine backing for
the ward's own logged-in Chrome (spec §9 Horizon #2) is fully designed but deliberately parked,
not built — see the CDP mode section below.

The feature is opt-in (`settings.browseEnabled`, default off, with a hard
`PROTO_FAMILIAR_BROWSE_DISABLED` env kill switch) and ward-only: the `browse_*` tools are
gated at the executor so a villager turn never reaches them [@browser-js] [@cerebellum-js].
`playwright-core` is an `optionalDependency`, so the server still boots when it is absent
[@package-json].

## Six modules, one job each

The subsystem is deliberately split so that each layer can be reasoned about — and tested —
in isolation.

**`browser-lens.js`** is pure: it takes a plain `PageData` object and turns it into a
leveled, ref'd, token-capped snapshot (`outline` / `actions` / `text` / `full`), plus a
code-computed delta verdict describing what an action changed [@browser-lens-js]. It has no
dependency on `playwright-core` and is fixture-tested without a browser, which keeps the
ref/token logic — the part most likely to have subtle bugs — directly testable rather than
hidden behind a stub of the thing that actually renders the page. `protectedKind(node)`
classifies a field as `'payment'` (card/CVV/IBAN autocomplete or name heuristics) or
`'credential'` (password/file inputs, OTP, other credential-shaped autocomplete) or `null`
for a plain field, reading the site's own `autocomplete` declaration as the strongest signal
before falling back to name/inputmode heuristics; `isProtectedField()` is `protectedKind(node)
!== null` [@browser-lens-js]. `evaluateFill(node, {value, secret, grants})` is the pure
fill-source decision described in the Pass 3b section below [@browser-lens-js].

**`browser-proxy.js`** is the SSRF enforcement floor. See the SSRF section below — it is
worth calling out separately because it is the one place in this subsystem where a naive
design would have quietly failed.

**`browser-driver.js`** is the engine. It lazily imports `playwright-core` so the server
boots without it, detects a usable Chromium (system channel, then the Playwright browser
cache, then a Familiar-fetched binary) and, when nothing is found, background-fetches one
into a git-ignored `browser/pw-browsers` by shelling out to `playwright-core`'s own install
CLI — which owns the version pin and checksum, so the fetch never blocks a chat turn
[@browser-driver-js]. It launches one persistent browser profile through the guarded proxy,
enforces a tab cap, runs an idle reaper that closes the browser after inactivity, and
supervises crashes. A DOM extraction is one in-page walk that produces the lens's `PageData`
shape, computing a unique CSS path per interactable node at extraction time
[@browser-driver-js] [@browser-lens-js].

**`browser.js`** is the executor-facing layer cerebellum's `browse_*` tools call
[@cerebellum-js]. It wires the driver's raw output through the lens, then applies the two
safety boundaries described below (injection-guard sanitization and Stranger-tier framing),
logs every open/act to the audit log, and turns any driver failure — a missing browser, a
crash, a stale ref — into a calm first-person string rather than an exception that reaches
the chat path [@browser-js].

**`browser-audit.js`** appends every action to `logs/browser-actions.jsonl`, mirroring the
shape of `discord-write-log.js`'s append-only log; a `browse_act` entry stamps `grant` with
whichever autonomy grant a fill actually used, or `null` for an ungated action
[@browser-audit-js] [@browser-js].

**`browser-grants.js`**, added in Pass 3b (0.11.4), is the consent gate for the surfaces the
other five modules refuse by default: filling a credential or payment field, submitting on a
ward-listed confirm domain, and completing a CAPTCHA. It reads two hand-edited, git-ignored
JSON files under `browser/` and exposes no UI path to change either — see the
"Pass 3b" section below for what it enforces and why [@browser-grants-js].

## Refs never hold a live element; they resolve fresh at act time

Pass 1's central reliability problem is that a ref handed to the model (`r3`, `r14`) has to
keep pointing at the same element across turns, and must fail loud rather than silently act
on the wrong one once the page has moved. `browser-driver.js` does not hold live Playwright
`ElementHandle`s across turns — they pin DOM nodes and die silently on navigation. Instead,
each snapshot mints a ref alongside a code-computed unique CSS path, and that path is
re-resolved against the live DOM only at act time [@browser-driver-js].

A per-page generation counter, bumped on `framenavigated` and on page-driven navigation
(a link click, a JS redirect), is stamped onto every snapshot; `browse_act` rejects a ref
minted in an older generation before it ever tries to resolve it [@browser-driver-js]. At act
time the resolved locator must match exactly one element — zero or more than one is a
structured error, never a first-match guess [@browser-driver-js]. The failure mode this buys
is always "re-observe with `browse_see`, then retry," never "clicked something the model
never actually named."

This ref/generation design exists specifically because `playwright-core` 1.62.1 removed
`page.accessibility`; the public replacement, `locator.ariaSnapshot()`, does not emit stable
refs, and `getByRole(name)` is ambiguous whenever a page has duplicate accessible names — so
the CSS-path resolver was the fallback the installed API actually supports, not the first
choice from the spec [@browser-driver-js].

## SSRF is enforced by a proxy the app owns, not a pre-navigation check

Two naive designs for blocking requests to loopback, private, and link-local addresses both
fail against a browser engine specifically, because Chromium resolves DNS itself: a
pre-`goto` host check races a DNS rebind (the app's own lookup sees a public IP, Chromium's
later lookup sees a private one), and Playwright's `context.route` handler only ever exposes
`request.url()`, never the resolved socket IP, so "block by resolved IP" cannot be
implemented there at all [@browser-proxy-js].

`browser-driver.js` launches Chromium through a small in-process CONNECT proxy that
`browser-proxy.js` owns (`launch({ proxy })`). The proxy is the single resolution point for
every request the browser makes — main navigation and every subresource — and it reuses
`websearch.js`'s existing `isBlockedIp` verbatim rather than keeping a second copy of the
blocked-range logic [@browser-proxy-js]. Crucially, it connects to the exact IP it just
checked, so a rebind between the check and the connect cannot slip through: the browser and
the guard can never disagree about which address is actually being reached
[@browser-proxy-js]. This closes main-navigation, subresource, and DNS-rebinding SSRF with
one mechanism instead of three separate patches.

## Two boundaries turn raw page bytes into something safe to read

`browser.js` applies the same two-part discipline to every string a page contributes before
it reaches a prompt [@browser-js]:

- **Injection-guard sanitization.** Every snapshot and act verdict passes through
  `injection-guard.js`'s `sanitizeExternal()` — the same function `websearch.js` calls at the
  web-read boundary — before it leaves `browser.js` [@browser-js]. This makes `browser.js` a
  second wired call site for the guard beyond the ones recorded on
  [Injection guard: wiring history](injection-guard-gap).
- **Stranger-tier framing.** Every block of page text is wrapped in an explicit frame telling
  the Familiar the content is something it reads, never instructions it follows — a page
  asking it to visit a URL, run a tool, or ignore its ward describes the page's wishes, not
  the Familiar's duties [@browser-js]. This mirrors Village's floor tier for a `strangers`
  participant, whose text can never move safety state; see the "A web page is a Stranger from
  day one" section of [Browser milestone: guardrails in code, not prompts](../decisions/browser-guardrails-in-code)
  for why that tier was chosen as the starting floor.

Credential and file-input fields are refused before any of this: `isProtectedField()` flags
them in the lens, and `browser.js`/`browser-driver.js` never accept a model-supplied value
into one — the Pass 3b section below covers the vault-fill path that is the one exception.

## What Pass 2 (0.11.1) added

Pass 2 kept the Pass 1 spine and added the pieces that make the browser usable for more than
text-only reads [@browser-js]:

- **`browse_screenshot`** saves a PNG as a media asset and returns its id, which the executor
  pushes onto `_pendingImages` so the screenshot rides the same turn through the existing
  `view_image` mechanism [@browser-js] [@cerebellum-js]. It is gated to vision-capable turns
  the same way `view_image` is, so a text-only turn is never offered a tool it cannot use —
  it reads the page via `browse_see level=text` instead [@cerebellum-js].
- **Downloads become media.** An act that triggers a download is captured
  (`acceptDownloads` + `takeLastDownload`) and saved through a mime allow-list restricted to
  documents, images, and audio — never an executable — with a size cap [@browser-js].
- **`browse_tabs`** (list/switch/close) and **`browse_history`** (query
  `logs/browser-actions.jsonl`) round out the tool surface [@browser-js] [@browser-audit-js].

## What Pass 3a (0.11.3) added: synchronous safety gates

Pass 3a is scoped to gates that decide in-line, without waiting on the ward — the design
principle for the whole of Pass 3 is that everything dangerous is off by default, and a grant
only *lifts* a gate; it never invents a new capability outright.

- **Site modes.** `siteModeAllows(url, settings)` in `browser.js` reads
  `settings.browseSiteMode` (`'open'` / `'blocklist'` / `'allowlist'`), matches subdomains via
  `hostMatches()`, and fails closed on an unparseable URL [@browser-js]. It gates both
  `browse_open` and page-triggered top-level navigation: `opts(settings)` wires it in as
  `siteGuard`, which `browser-driver.js` enforces via a `context.route` interceptor that aborts
  a disallowed main-frame navigation a page triggers itself (a link, a JS redirect) — not just
  navigations the Familiar requests directly [@browser-js] [@browser-driver-js]. Subresources
  are untouched by the site guard; the CONNECT proxy described below still owns the network
  floor for those. A site-blocked `read_webpage` call returns a distinct `{ok: false, blocked:
  true}` signal rather than falling through to the static-extractor floor, which closes a real
  bypass: without that distinct signal, a blocked browser read could silently re-fetch the page
  through the unguarded static path [@browser-js].
- **Credential/payment fill hardening.** `protectedKind()` (described above) reads the site's
  own `autocomplete` declaration first — the strongest signal — before falling back to
  name/inputmode heuristics, and the field-kind classification only ever gates *whether* a fill
  is refused; it never accepts model-supplied bytes into a protected field regardless of kind
  [@browser-lens-js].

## What Pass 3b (0.11.4) added: the ward-in-the-loop and dangerous surfaces

Pass 3b is the "sovereignty surfaces" the decision page named as unbuilt through 0.11.1: the
consent ceremony, the credentials vault, the fill-source gate, the confirm-domain refusal, and
`browse_handoff`. All of it is now built [@browser-grants-js] [@browser-lens-js]
[@browser-driver-js] [@browser-js].

- **`browser-grants.js` is the consent ceremony, and it has no UI, ever.** `readGrants()`
  re-reads `browser/autonomy-grants.json` on every call — a stale cache must never keep a
  revoked grant alive — and requires the file's `acknowledgment` string to match `ACK_SENTENCE`
  exactly after trimming surrounding whitespace (an editor's trailing newline should not revoke
  real consent, but a changed word does); an absent file, malformed JSON, or a mismatched
  sentence makes every grant read `false`, which is the shipped default [@browser-grants-js].
  Typing the sentence by hand into the file is the consent; there is no checkbox that can carry
  it. Grants are `credentials`, `payments`, `captchas`, and `autoSubmit`.
- **The credentials vault.** `readVaultEntry(name)` reads `browser/credentials-vault.json`
  only when the `credentials` or `payments` grant is active, and returns `{user, secret}` for
  code — never the model — to type [@browser-grants-js]. The secret never enters a prompt, tool
  result, session log, or audit entry; the Familiar only ever names the vault entry. Both
  `autonomy-grants.json` and `credentials-vault.json` are git-ignored and are also on
  `own-files.js`'s denylist, so no Familiar tool can read either file directly
  [@browser-grants-js]. This is [Exact values are code's job](../decisions/exact-values-in-code)
  applied to secrets: the model points at a named thing, code alone touches the value.
- **The fill-source gate is pure and unit-tested.** `evaluateFill(node, {value, secret,
  grants})` in `browser-lens.js` is the single decision point: a protected field admits only a
  code-typed vault `secret` under the grant matching its `protectedKind` (`payment` requires
  `grants.payments`, `credential` requires `grants.credentials`); it refuses model-supplied
  `value` bytes into any protected field, and separately refuses a `secret` aimed at a plain
  field [@browser-lens-js]. `browser-driver.js`'s `act()` calls it for every `fill` action and
  stamps the result's `grantUsed` onto the return value that `browser.js` forwards to the audit
  log [@browser-driver-js]. Because the decision lives in the lens rather than the driver, it is
  fixture-tested without a live browser — the safety-critical judgment call does not depend on
  Playwright behaving a particular way.
- **The `[CONFIRM]`-domain gate.** `isSubmitShaped(action, node, value)` in `browser-driver.js`
  treats a `press` of Enter, a `click` on a `type=submit` element, or a click on an element
  whose name matches a submit/pay/order/checkout-shaped regex as submit-shaped
  [@browser-driver-js]. `act()` refuses any submit-shaped act whose host is on the ward's
  `browseConfirmDomains` list — matched exactly or as a subdomain — unless the `autoSubmit`
  grant lifts it, and hands the refusal back naming `browse_handoff` as the ward's path to
  complete it [@browser-driver-js]. The hard refusal is the shipped default; the
  approve-then-resume alternative is `browseConfirmMode`, covered below.
- **`browse_handoff`.** `browserStatus()` exposes `hasDisplay` from the driver alongside
  `currentUrl` and the active grant list [@browser-js] [@browser-driver-js]. When a display
  exists, `browse_handoff` hands the ward a headed window on the current page; when it does not
  (a headless server, no ward at this machine), it parks the action and logs `parked for ward:
  <reason>` to the audit trail rather than pretending a window popped somewhere the ward can see
  it [@browser-js]. This headless-fallback honesty is the review-2 behavior the decision page
  called for; on a co-located desktop where a display does exist, `browse_handoff` now also
  closes the loop automatically — see the hand-back-and-resume refinement below.
- **Loud visibility.** Every browser launch that finds an active grant logs `⚠ AUTONOMY GRANTS
  ACTIVE: <names> (browser/autonomy-grants.json)` to the console, `browserStatus()` surfaces the
  same `grants` list to any caller, and every `browse_act` audit entry stamps the `grant` a fill
  actually used [@browser-driver-js] [@browser-js] [@browser-audit-js]. Silent autonomy is the
  failure mode this visibility exists to prevent — a grant can lift a gate, but it cannot make
  its own use invisible.

## Two Pass 3 refinements (0.11.5 / 0.11.6): async, opt-in, toggle-gated

Both `[CONFIRM]`'s hard refusal and `browse_handoff`'s headless park are safe *synchronous*
hard-stops: they refuse in-line and hand the moment to the ward without waiting on them. Two
later refinements make each one an async, human-in-the-loop flow that resumes across the gap
where the ward is away — both are toggle- or capability-gated so the shipped safe defaults are
unchanged; the refinement is opt-in, never a silent behavior change [@browser-driver-js].

### `browseConfirmMode: 'ask'` — approve-resume without a blanket grant (0.11.5)

A ward toggle on `settings.browseConfirmMode`, default `'refuse'` (the Pass 3b hard-stop
described above); `'ask'` HOLDS a submit-shaped act on a `browseConfirmDomains` host as a
pending confirmation instead of refusing it outright [@browser-js] [@browser-driver-js]. This
exists for the ward who wants to pre-authorize one specific submit without granting blanket
`autoSubmit` forever.

The load-bearing safety property is where the approval comes from: a Settings button posts to
`POST /api/browser/confirm`, never a model tool argument, so a page can never talk the model
into self-approving its own submit — that is the entire point of requiring a fresh ward
confirmation [@browser-driver-js]. In `'ask'` mode, `act()` registers the held act in
`state.pendingConfirms` and returns `{held: true, confirmId, host, action}` instead of acting,
and clears the idle reaper so the browser stays alive while the ward's yes is pending
[@browser-driver-js]. The held tool result explicitly reports that nothing happened yet: the
Familiar never assumes the submit succeeded, and can check the real outcome via
`browse_history` once the confirmation resolves.

`resolvePendingConfirm(id, approve)` looks the pending act up by id: on approval, the stored act
resumes through the normal `act()` path with `autoSubmit` lifted for that one call, so the same
generation guard described above still fires — a page that moved since the ward approved fails
honestly instead of clicking whatever now sits at that ref [@browser-driver-js]. A decline, or
an unknown id, is dropped safely with no side effect [@browser-driver-js] [@browser-js].

### Headed handoff hand-back-and-resume (0.11.6)

Makes `browse_handoff` a closed loop on a co-located desktop, rather than a one-shot hand to the
ward. The constraint that shapes the design: only one Chromium instance may hold the persistent
browser profile at a time, and Playwright cannot toggle a live context between headless and
headed — so resuming is a relaunch dance, not a flag flip [@browser-driver-js].

`driver.openHeaded(url)` closes the headless context, relaunches the *same* profile with
`headless: false` through a fresh guarded proxy (the SSRF floor still applies to the headed
window), navigates to the page, and holds a module-level `handoff` state
[@browser-driver-js]. While that state is set, `ensureContext` throws `'awaiting handback'`, so
the profile can never be double-opened from underneath the ward [@browser-driver-js]. The ward
completes their login, payment, or CAPTCHA in the real window; because it is the same browser
profile, cookies persist automatically — there is no other state transfer. Clicking "Hand it
back" posts to `POST /api/browser/handback`, which closes the headed context, relaunches
headless, and navigates back to the same URL, now authenticated by the cookies the ward's
session left behind [@browser-driver-js].

While a handback is pending, every `browse_*` op returns a calm "I'm waiting for you to finish…
click hand it back" instead of an error, via a `handbackPending()` guard in `browser.js`, so the
Familiar never fights the ward for the profile [@browser-js]. A failed headed launch (for
example, no display after all) falls back to the honest park described above rather than a
broken promise [@browser-js]. The refinement's value is narrow by design: only a co-located
desktop install benefits, since the server process needs display access; the review-2 headless
park remains the fallback for the far more common remote-ward shape.

**Testing boundary.** The headed launch and the real window it opens cannot be exercised in a
headless CI container — there is no display to open one on. `tests/browser-tools.test.mjs`
stubs the driver to unit-test the lifecycle *decisions* (headed-vs-park, the awaiting-handback
wait, the handback swap, failure-to-park), not the Playwright relaunch itself; the profile
relaunch dance needs a live desktop shakeout before it can be trusted beyond that
[@browser-tools-test].

## Pass 4 (0.11.7): unattended web research on pondering ticks

Pass 4 lets the Familiar seek out sources mid-[ponder](pondering) instead of only recombining
what it already holds, and it completes the browser milestone's build passes
[@ponder-research-js]. The load-bearing design decision is that this shipped as a
**plan-and-read loop, not a tool-calling loop**, deliberately diverging from the build spec's
§8.5, which described a read-only tool loop; the
[Browser milestone: guardrails in code, not prompts](../decisions/browser-guardrails-in-code)
decision page's Pass 4 section records the full reasoning. In short: an unattended context
(pondering, no ward nearby to notice odd behavior) is where the Familiar should get **less**
agency, not more, so `ponder-research.js`'s model call only ever names what to search or read —
it returns JSON `{searches, reads, done}` — and code alone performs the bounded reads
[@ponder-research-js]. There is no tool surface for a hostile page to misuse even through
malformed model output, because reads are idempotent and there is no act path to reach.

`researchForPonder()` runs up to `ponderWebRoundsPerTick` rounds (clamped 1–10, default 4),
asking the model each round what it wants to look up next given what it has already pulled, and
can follow a trail across rounds (read a page, then ask for a link from it)
[@ponder-research-js]. Each read goes through the browser's live-DOM read
(`shouldBrowserRead`/`browseRead`, stamped `sessionId:'pondering'` in the browser action audit
log) when the driver is up, else falls back to the static `readWebpage` floor — the same
degradation relationship `read_webpage` itself has to the driver elsewhere on this page
[@ponder-research-js]. `ponder-web-budget.js` enforces a shared per-day read budget
(`tomes/.ponder-web-budget.json`, keyed to the ward's local calendar day, fail-closed on a
read/write failure) across all unattended research, independent of the round cap
[@ponder-web-budget-js]. An exhausted budget is never a failed call: the returned `sources` array
comes back empty with `budgetSpent:true`, and [pondering](pondering)'s prompt then says plainly
that it is thinking from what it already holds rather than erroring [@ponder-research-js]. Every
source gathered is provenance-stamped and folded into the ponder prompt via `sourcesBlock()` so
the resulting thought cites what it actually read [@ponder-research-js].

Settings: `ponderWebEnabled` (default on), `ponderWebRoundsPerTick` (default 4),
`ponderWebReadsPerDay` (default 12), plus the hard env off-switch
`PROTO_FAMILIAR_PONDER_WEB_DISABLED=1` [@ponder-research-js]. See
[Pondering](pondering) for where this research gate sits inside `ponderOnce()` and why it is
skipped for reflection-mode ponders.

## Getting a browser: prefer an installed one, and never fetch forever (0.11.11 / 0.11.12)

The first live test of the browser tools surfaced a "downloading Chromium forever" hang, and
fixing it hardened the whole browser-acquisition path in `browser-driver.js`. Two distinct
faults, each with its own lesson.

The **auto-fetch was neither observable nor bounded** (0.11.11). `startChromiumFetch` spawned
`node playwright-core/cli.js install chromium` with `stdio: 'ignore'` and no timeout, so a
stalled download stayed `status: 'fetching'` indefinitely — the Familiar re-said "setting up"
every turn with nothing to diagnose. This is the failures-must-be-observable rule violated in
the acquisition path. The fix makes the fetch (a) observable — the installer's output is
captured to `browser/chromium-install.log`; (b) bounded — a watchdog (`INSTALL_TIMEOUT_MS`,
15 min, overridable via `PROTO_FAMILIAR_BROWSER_INSTALL_TIMEOUT_MS`) kills a hung install and
records `failed` with the reason plus the log path, so it can never fetch forever; (c)
retryable — after a short cooldown a fresh browse call re-spawns the fetch, while the cooldown
stops a permanently-broken environment being hammered once per call; and (d) resilient to a
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` inherited from a container/CI environment, which is stripped
from the child env — otherwise it silently turns the deliberate install into a no-op (exit 0,
no binary), a case now reported as a failure rather than a false "ready". `chromiumInstallState()`
surfaces `elapsedMs` and `logPath` for the status endpoint [@browser-driver-js]
[@browser-driver-test].

The **deeper cause for a Windows ward: no Windows browser detection at all** (0.11.12).
`findChromium`'s system-install list was Linux/macOS-only, so a Windows machine — which always
ships Edge and usually Chrome — was pushed onto the download path (and then the hang) even
though a perfectly good browser was already installed. `systemBrowserCandidates()` now returns
platform-appropriate locations: Chrome / Edge / Chromium under `%ProgramFiles%`,
`%ProgramFiles(x86)%` and `%LOCALAPPDATA%` on Windows (built from the real env vars, not a
guessed drive letter); the same three under `/Applications` on macOS; and
`google-chrome` / `chromium` / `microsoft-edge` (including the snap path) on Linux. Because
`playwright-core` drives any Chromium-family browser via `executablePath`, an already-installed
browser skips the download entirely — the spec's intended primary path, with the bundled fetch
as the fallback. Since Windows always has Edge, a Windows ward never needs the fetch at all
[@browser-driver-js] [@browser-driver-test].

The lesson worth carrying forward: **prefer an already-installed system browser, detected
cross-platform, and treat the bundled download as a fallback that must be observable and
time-bounded — never a silent forever-fetch.** `PROTO_FAMILIAR_CHROME` (or `CHROME`) remains the
explicit override that points at any binary and sidesteps discovery.

## Page watches (0.11.13): a scheduled diff loop, not a browser read

Page watches answer "tell me when this page changes" — a restock, a decision posted, a date
announced — without paying an LLM call on every re-check [@page-watch-js]. The feature lives in
the browser milestone's roadmap as spec §9 Horizon #1, but it does not touch `browser-driver.js`
or Chromium at all: each watched URL is re-read on a schedule through `websearch.js`'s existing
static `fetchReadable()` — the same extractor `read_webpage` falls back to when the driver is
unavailable — rather than through a live browser tab [@page-watch-js] [@browser-server-js]. That
choice keeps an armed watch list cheap: most watched pages (a product listing, an announcement
page) don't need a rendered browser to read, and routing every watch through Chromium would turn
an idle watch list into a standing resource cost.

**The core is pure and injectable.** `page-watch.js` holds the store (`tomes/.page-watches.json`,
git-ignored, the same posture as the outbox and the ponder-web budget), the normalize-and-hash
diff, due-selection, and the one-tick reconcile — all free of network or LLM calls, so
`runOnePageWatchTick()` is unit-tested against fixture `fetchReadable`/`decideChange`/`enqueue`
functions rather than a live loop [@page-watch-js]. `normalizeForHash()` collapses whitespace and
strips `read_webpage`'s own front-matter block before hashing with sha256; it is deliberately
conservative about what it normalizes away — no stripping of numbers or dates — because missing
a real change is worse here than an occasional noisy one, and the LLM step is the actual noise
filter [@page-watch-js].

**Code diffs for free; the LLM judges only a real change.** `dueWatches()` selects only watches
whose own `intervalMs` (default 6h, floor 15min so nothing gets hammered) has elapsed since
`lastCheckedAt` [@page-watch-js]. A hash match against `lastHash` costs one fetch and zero
tokens; only a hash mismatch calls the injected `decideChange`, which reads a leak-free
before/after (only the watched page's own snapshot text, capped at 2000 chars) and returns JSON
`{surface, summary}` judging whether the change is worth a nudge or just noise — an ad, a
timestamp, a view counter [@page-watch-js]. This is the same "ride existing requests, gate in
code" ordering [Engineering conventions](../reference/engineering-conventions) documents for LLM
requests generally, applied here to a brand-new background loop rather than an existing call
site. A watch's first-ever read only sets the baseline hash and is never surfaced — otherwise
every new watch would immediately read as "changed" [@page-watch-js]. A URL that fails to fetch
`MAX_FETCH_FAILS` (5) times in a row deactivates itself with the failure reason recorded on the
watch, rather than retrying a dead link forever [@page-watch-js].

**The loop is the same singleton pattern used elsewhere.** `page-watch-loop.js` mirrors
`gcal-sync-loop.js`: a short base tick (5 min) wakes the loop, and the per-watch `intervalMs`
inside `runOnePageWatchTick` — not the base tick — decides what is actually due, so the loop can
wake often without re-reading every watch every 5 minutes [@page-watch-loop-js]. It follows
[Autonomous loops](autonomous-loops)'s shared contract: a reentrancy guard (`_activeTick`), a
graceful `stopPageWatchLoop()` that awaits any in-flight tick, and it never lets a failure escape
its own boundary — a fetch failure backs off that one watch without touching the others
[@page-watch-loop-js].

**Wiring and surfacing.** `server.js`'s `startPageWatches()` supplies the three injected
functions: `fetchReadable` (the static path, behind the same SSRF check every web read uses),
`decideChange` (resolves a connection via `connectionForFeature(s,'chat')` or the pondering
connection, and runs `buildPageWatchPrompt()`'s `{{user}}`/`{{char}}` tokens through
`substituteMacros` before the call — the same boundary-1 macro discipline
[Engineering conventions](../reference/engineering-conventions) documents for triage, warm
reach-out, pondering, tome-graduation, and guide-chat), and `enqueue` (drops a `kind:'page_watch'`
item through `enqueueAndDispatch`, the same outbox-plus-push path reminders and reach-outs use)
[@browser-server-js]. The `originId` is `${watchId}:${hash}` — a distinct string per detected
change, not per watch — so a genuinely new change on an already-notified watch still surfaces,
while the outbox's own `(kind, originId)` dedup still stops a re-delivery of the identical
unacknowledged change from duplicating [@browser-server-js]. Every tick that actually read a due
page is logged to `logs/page-watch-events.jsonl` (`GET /api/page-watch-events`), so a silently
dead loop reads as stale entries rather than calm silence — the same auditability pattern
[Autonomous loops](autonomous-loops) records for the noticing loop [@cerebellum-js].

**Tools, gating, off-switches.** `watch_page` / `list_page_watches` / `unwatch_page` are
ward-only — refused on any turn `discordReadAudiences` resolves to a villager or stranger
context — and only registered when `pageWatchEnabled` is not explicitly `false` in settings
(default on, but inert until a watch actually exists) [@cerebellum-js]. The hard kill switch is
`PROTO_FAMILIAR_PAGE_WATCH_DISABLED=1`, checked before the loop even starts
[@browser-server-js]. Watch ids are readable slugs minted from the label or URL via
`slug-ids.js`'s `slugifyLabel`, following the same
[readable-slug-id convention](../decisions/exact-values-in-code) every other model-facing id in
the app follows [@page-watch-js] [@slug-ids-js].

## Refs are meaning-bearing slugs, and the model can name what it sees (0.11.14)

The ref/generation model described above — originally opaque, `r3`/`r14`-shaped — now mints refs
from each element's own accessible name instead: `add-to-basket` rather than `r14`
[@browser-lens-js]. `mintRef(node, taken)` slugifies the interactable's `name` (falling back to
its `role` or `tag` when unnamed) via `slug-ids.js`'s `slugifyLabel`, suffixing only on collision
within the same generation [@browser-lens-js] [@slug-ids-js]. This is the
[readable-slug-id law](../decisions/exact-values-in-code) — already the convention for every
other model-facing id in the app — applied to page elements for the first time: a model names
`add-to-basket` far more reliably than an opaque `r14`, because the handle it emits now means
what it is [@browser-lens-js]. Nothing about the underlying reliability model changes:
`buildRefTable()` still pairs each ref with a code-computed locator (`{role, name, nth}`) the
driver re-resolves fresh at act time, the ref still dies with the generation described above, and
the model still only ever repeats a ref — it never fabricates a selector [@browser-lens-js].

`resolveTarget(refTable, {target, role})` adds a second way to act: `browse_act` now also accepts
`target` (a visible label, such as "Add to basket") plus an optional `role` to narrow it, instead
of requiring a ref [@browser-lens-js]. Matching is most-specific first — exact accessible-name
match, then a name substring, then the ref-slug itself — and returns a single ref on a unique
hit, the candidate refs on an ambiguous match (so the model can then name the exact one it
means), or `none` when nothing matches [@browser-lens-js]. `browser-driver.js`'s `act()` calls
`resolveTarget` before acting whenever `target` is supplied instead of `ref`, and surfaces an
ambiguous match as a structured refusal rather than a first-match guess — the same "fail loud,
never guess" discipline the ref/generation model already applies to a stale ref
[@browser-driver-js]. Code still owns disambiguation; the model only ever supplies what it sees.

## The model can see that a page has pictures, and scroll it without a target (0.11.16)

Before this, the lens had no way to tell the model a page held an image at all — it reads text,
not pixels, so a page's pictures were structurally invisible to it, and it could never decide to
look at one. The DOM walk `browser-driver.js` runs at extraction time now also collects `img`,
`[role=img]`, a named `svg`, `figure` (captioned by its `figcaption`), and `canvas` elements as
image nodes (`isImage:true`, non-interactable) [@browser-driver-js]. `buildRefTable()` mints a
ref for an image node the same way it does an interactable, and `renderSnapshot()` adds an
`[images]` section listing each image's ref alongside its author-supplied alt text — the
strongest signal for whether the picture is worth a look [@browser-lens-js]. This is what lets
the model decide, in text, to call `browse_screenshot scope=<image-ref>` for one picture instead
of the whole page — without this section it could not know a page had a picture worth looking
at, let alone which one [@browser-lens-js].

`browse_act`'s `scroll` action gained a page-level mode: called with no `ref` and no `target`
(direction in `value`: `up`/`down`/`top`/`bottom`), it moves the viewport itself via
`window.scrollTo`/`scrollBy` rather than scrolling a specific element into view
[@browser-driver-js]. This is distinct from `scroll` *with* a ref, which still calls
`scrollIntoViewIfNeeded` on that element [@browser-driver-js]. Page-level scroll is what reveals
below-the-fold or lazy-loaded/infinite-scroll content that `browse_see`'s viewport-only outline
level would otherwise never mention.

## CDP mode (Horizon #2): driving the ward's own Chrome — designed, not built

`docs/browser-cdp-mode-build-spec.md` specs an alternate engine backing for the same `browse_*`
tool surface: instead of the Familiar's own isolated profile, it would attach to the ward's
**already-running, already-logged-in** Chrome via `chromium.connectOverCDP()`, so tasks that the
owned-profile mode has to hand back to the ward — anything behind a login — could proceed without
a handoff [@browser-cdp-spec]. The ward reviewed the design and chose to **spec-and-park** it
rather than build it now: the owned-profile browser this page describes had only just entered
real use, and CDP mode belongs in the same "prove the cheaper modes first" bucket as the
still-undesigned delegated task-flow horizon [@browser-cdp-spec]. No code exists yet — the design
is settled and answered (§7 of the spec), and this section exists so that work is not lost before
a future ward go-ahead revives it.

The design's central problem is that this page's "SSRF is enforced by a proxy the app owns"
guarantee cannot apply under CDP: that guarantee depends on the app launching the browser through
`launch({proxy})`, and CDP attaches to a browser it did not launch, so the network floor degrades
from an airtight IP-resolution check to a best-effort URL allowlist [@browser-cdp-spec]. See
[CDP mode: driving the ward's own Chrome](../decisions/browser-cdp-mode) for why that degraded
floor, plus a forced single-domain allowlist and two independent human acts nothing can fake,
were judged an acceptable design for a capability this high-stakes — read it in full before
resuming this work.

## What is deliberately still deferred

`read_webpage` is not re-backed by this driver. It stays on its existing static extractor even
after Pass 1 through 4 have shipped, on purpose: `read_webpage` is an always-on, widely used
tool, and the spec's ordering is to prove the driver on the opt-in `browse_*` surface first,
then flip the always-on tool to it only once the driver has shaken out under real use
[@browser-build-spec]. This is the one item the spec originally placed inside Pass 2 that
remains undone as of 0.11.7.

The whole browser milestone specced in `docs/browser-build-spec.md`'s Passes 1 through 4 is now
built, including both Pass 3b refinements named above (`browseConfirmMode: 'ask'`
approve-resume, 0.11.5, and the headed handoff hand-back-and-resume, 0.11.6) and Pass 4's
unattended pondering research (0.11.7, shipped as a plan-and-read loop rather than the spec's
tool-calling design). What remains is `read_webpage`'s re-backing onto this driver.

## Related

- [Browser milestone: guardrails in code, not prompts](../decisions/browser-guardrails-in-code)
  — the design decisions behind the SSRF proxy, the Stranger-tier default, and the consent,
  vault, and handoff surfaces Pass 3 built.
- [CDP mode: driving the ward's own Chrome](../decisions/browser-cdp-mode) — the settled,
  parked design for the Horizon #2 alternate engine backing, and why its degraded network floor
  was judged acceptable.
- [Exact values are code's job](../decisions/exact-values-in-code) — the general rule
  `readVaultEntry()` applies to secrets, and the readable-slug-id law page watches and
  meaning-bearing refs both apply to page-facing identifiers.
- [Injection guard: wiring history](injection-guard-gap) — the pattern-scanner
  `browser.js` now also calls, and the other boundaries it does and does not cover.
- [Vision and media](vision-and-media) — the `view_image`/`_pendingImages` mechanism
  `browse_screenshot` rides, and the media asset store screenshots and downloads are saved
  into.
- [Safety spine](safety-spine) — the broader crisis-detection and threat-tracking system the
  Stranger-tier framing is designed never to be able to move.
- [Pondering](pondering) — the autonomous thought loop Pass 4's research gate runs inside, and
  where `sourcesBlock()`'s output lands in the ponder prompt.
- [Autonomous loops](autonomous-loops) — the shared loop contract page watches follows, and
  where it sits alongside the app's other background workers.
