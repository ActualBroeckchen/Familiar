---
title: "CDP Mode: Driving the Ward's Own Chrome"
topics: [decisions, safety, browser]
sources:
  - id: browser-cdp-spec
    type: file
    path: docs/browser-cdp-mode-build-spec.md
  - id: browser-driver-js
    type: file
    path: browser-driver.js
  - id: browser-cdp-arm-js
    type: file
    path: browser-cdp-arm.js
  - id: browser-cdp-arm-test
    type: file
    path: tests/browser-cdp-arm.test.mjs
  - id: browser-build-spec
    type: file
    path: docs/browser-build-spec.md
  - id: cdp-launcher-js
    type: file
    path: cdp-launcher.js
---

# CDP Mode: Driving the Ward's Own Chrome

The browser milestone's §9 Horizon #2 is an alternate engine backing for the existing
`browse_*` tools: instead of the Familiar's own isolated headless profile, attach to the
ward's *already-running, logged-in* Chrome over the Chrome DevTools Protocol
(`connectOverCDP`) and drive that. The full design lives in
`docs/browser-cdp-mode-build-spec.md` [@browser-cdp-spec]; the main browser spec pinned it as
"own spec, own sign-off" precisely because the blast radius is the ward's authenticated life —
every site their real browser is logged into [@browser-build-spec].

**Status: decided and shipped (0.11.31-alpha), pending a desktop shakeout.** The design below
was specced in full and then deliberately parked — the ward held it until the cheaper
owned-profile modes (Passes 1–4 plus page watches) had been proven in real use. The ward then
gave the go-ahead and the spec was built to the letter: `browser-cdp-arm.js` is the arm gate,
`browser-driver.js`'s `ensureContext` grew a CDP branch that attaches and drives a dedicated
tab, and every settled decision below is enforced in code, not just on this page
[@browser-cdp-arm-js] [@browser-driver-js]. The arm-gate logic — domain normalization,
private/loopback refusal, the single-domain allowlist, expiry plus the one-shot note, disarm,
and the env hard-disable — is fully unit-tested (`tests/browser-cdp-arm.test.mjs`)
[@browser-cdp-arm-test]. What is *not* yet verified is the live attach-and-drive itself: it
cannot run in headless CI (there is no real Chrome with a debug port to attach to), so it
needs the same kind of ward desktop shakeout the headed-handoff hand-back required before it
could be trusted — launch Chrome with `--remote-debugging-port=9222`, arm a domain, and
confirm the drive works and that disarm, expiry, and `browse_close` never touch the ward's own
Chrome or its other tabs [@browser-cdp-spec]. This page still records *why the design is
shaped the way it is*, because that reasoning is exactly what a shakeout has to verify against.

## The load-bearing problem: the SSRF floor cannot apply

The milestone's strongest guardrail is a CONNECT proxy the app owns, injected via
`launch({ proxy })`, which is the single DNS-resolution point for every request and refuses
private / loopback / metadata IPs. It is airtight *because the app launches the browser*. CDP
**attaches** to a browser it did not launch, so `launch({ proxy })` is unavailable and the
airtight floor is gone. What remains is a best-effort **URL** gate (CDP request interception
sees `request.url`, not the resolved socket IP — the exact DNS-rebind TOCTOU the proxy was
written to close) [@browser-cdp-spec]. The `ensureContext` CDP branch plugs in at the same
driver seam the owned-profile launch uses, via a dedicated `ensureCdpContext()` path
[@browser-driver-js].

## Settled decisions (ward-answered, now enforced in code)

- **Forced single-domain allowlist.** Because the IP floor degrades, CDP mode never runs
  `open` or `blocklist` site-mode. The allowlist *is* the one domain the ward armed for the
  task — `armAllowsHost()` matches the armed domain or a subdomain and refuses everything else,
  including every private/loopback/metadata literal, which can never match a public armed
  domain [@browser-cdp-arm-js]. The tightness comes from the arm being narrow and short-lived,
  not from a typed URL list.
- **Two independent human acts nothing can fake** are the safety spine: (1) the ward launches
  Chrome with `--remote-debugging-port` themselves — the app never does, and only ever attaches
  over loopback (`CDP_ENDPOINT` is hardcoded to `127.0.0.1:9222`) — and (2) the ward arms a
  scoped, time-boxed grant via `POST /api/browser/cdp-arm` (single domain, 15-minute default /
  60-minute ceiling, instantly disarmable via `/api/browser/cdp-disarm`) [@browser-cdp-arm-js].
  Arming is a ward-only HTTP action; the model has no tool that can call it, so a hostile page
  can never talk the Familiar into self-arming — `cerebellum.js`'s `browse_open` description
  only lets the Familiar *ask* the ward to arm one.
- **On arm expiry mid-task: drop to the owned profile**, not hard-refuse — `ensureContext`
  detects the arm has gone stale, closes the CDP session, and re-opens the owned profile; the
  swap is audit-stamped and announced to the Familiar via a one-shot first-person note
  (`consumeCdpDropNote`, RULE B: the Familiar always knows what it is actually driving)
  [@browser-driver-js]. Work that needed the ward's login then fails honestly on the
  logged-out profile.
- **Every other §5 guardrail still holds app-side** (no-credential rule, payment-field refusal,
  `[CONFIRM]` gates, injection / Stranger-tier framing, the audit trail stamped `mode:'cdp'`,
  ward-only, and the autonomy-grants file still separately required for credential / payment /
  auto-submit powers). The hard invariant is enforced in `closeBrowser`'s `cdp` branch:
  it closes only the dedicated tab it opened, then **disconnects** — it never calls
  `browser.close()` on the ward's real Chrome [@browser-driver-js].

## Amendment: the shipped one-click setup uses a dedicated profile, not the ward's everyday Chrome

The design above assumes CDP attaches to the ward's *already-running, already-logged-in*
Chrome — their real, everyday profile, with its own bank and email sessions. The one-click
"Set up my Chrome" launcher shipped afterward (`cdp-launcher.js`) deliberately does not do
that: it points the launched Chrome's `--user-data-dir` at a separate, dedicated profile
(`~/.proto-familiar/cdp-chrome`) that starts logged out, so the debug port this whole mode
depends on is never a path to the ward's real profile [@cdp-launcher-js]. This is a ward-approved deviation from
the build spec's premise, made because it is strictly safer, not a reversal of any of the
settled decisions above — the arm gate, the forced single-domain allowlist, and the
disconnect-not-close invariant all still apply unchanged to whatever profile is attached. A
ward who wants the original, everyday-Chrome behavior can still bypass the launcher and start
their own Chrome with the debug flag by hand. See [Browser: click-and-fill web
access](../architecture/browser) for the one-click launcher's mechanics.

See [Browser: click-and-fill web access](../architecture/browser) for how this engine backing
fits alongside the owned-profile driver it can swap with, and for the desktop-shakeout testing
gap this page shares with the headed-handoff hand-back refinement. [Vision and media](../architecture/vision-and-media)'s
Gemini File-API path (0.11.35-alpha) is in the same position: unit-tested against a stub, isolated
in its own module and endpoint, and waiting on a live ward shakeout before the untested piece can
be trusted.

The general lesson worth carrying: a capability whose safety depends on a guarantee the
architecture can't provide (here, the owned proxy) should either not ship, or ship only behind
human gates strong enough to stand in for the missing guarantee — and that trade is the ward's
to make, not the implementer's.
