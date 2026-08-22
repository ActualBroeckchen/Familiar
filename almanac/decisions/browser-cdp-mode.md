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
  - id: browser-build-spec
    type: file
    path: docs/browser-build-spec.md
---

# CDP Mode: Driving the Ward's Own Chrome

The browser milestone's §9 Horizon #2 is an alternate engine backing for the existing
`browse_*` tools: instead of the Familiar's own isolated headless profile, attach to the
ward's *already-running, logged-in* Chrome over the Chrome DevTools Protocol
(`connectOverCDP`) and drive that. The full design lives in
`docs/browser-cdp-mode-build-spec.md` [@browser-cdp-spec]; the main browser spec pinned it as
"own spec, own sign-off" precisely because the blast radius is the ward's authenticated life —
every site their real browser is logged into [@browser-build-spec].

**Status: designed in full, deliberately parked — no code.** The ward reviewed the
design and chose to hold it until the cheaper owned-profile modes (Passes 1–4 plus page
watches) have been proven in real use, the same "prove it first" posture the spec applies to
the Horizon #3 task-flows. This page records *why the design is shaped the way it is* so that
whoever unparks it builds the version that was actually agreed, not a fresh guess.

## The load-bearing problem: the SSRF floor cannot apply

The milestone's strongest guardrail is a CONNECT proxy the app owns, injected via
`launch({ proxy })`, which is the single DNS-resolution point for every request and refuses
private / loopback / metadata IPs. It is airtight *because the app launches the browser*. CDP
**attaches** to a browser it did not launch, so `launch({ proxy })` is unavailable and the
airtight floor is gone. What remains is a best-effort **URL** gate (CDP request interception
sees `request.url`, not the resolved socket IP — the exact DNS-rebind TOCTOU the proxy was
written to close) [@browser-cdp-spec]. Any future `ensureContext` CDP branch plugs in at the
same driver seam the owned-profile launch uses today [@browser-driver-js].

## Settled decisions (ward-answered)

- **Forced single-domain allowlist.** Because the IP floor degrades, CDP mode may never run
  `open` or `blocklist` site-mode. The allowlist *is* the one domain the ward armed for the
  task, plus URL-level refusal of loopback / private / metadata literals. The tightness comes
  from the arm being narrow and short-lived, not from a typed URL list.
- **Two independent human acts nothing can fake** are the safety spine: (1) the ward launches
  Chrome with `--remote-debugging-port` themselves — the app never does, and only ever attaches
  over loopback — and (2) the ward arms a scoped, time-boxed grant in the UI (single domain,
  15-minute default / 60-minute ceiling, instantly disarmable). Arming is a ward action, never
  a tool the model can call, so a hostile page can never talk the Familiar into self-arming.
- **On arm expiry mid-task: drop to the owned profile**, not hard-refuse — but the swap is
  audit-stamped and announced to the Familiar so it is never silent (RULE B: the Familiar
  always knows what it is actually driving). Work that needed the ward's login then fails
  honestly on the logged-out profile.
- **Every other §5 guardrail still holds app-side** (no-credential rule, payment-field refusal,
  `[CONFIRM]` gates, injection / Stranger-tier framing, the audit trail stamped `mode:'cdp'`,
  ward-only, and the autonomy-grants file still separately required for credential / payment /
  auto-submit powers). A hard invariant for the eventual build: **disconnect** the CDP session,
  never `browser.close()` the ward's real Chrome.

The general lesson worth carrying: a capability whose safety depends on a guarantee the
architecture can't provide (here, the owned proxy) should either not ship, or ship only behind
human gates strong enough to stand in for the missing guarantee — and that trade is the ward's
to make, not the implementer's.
