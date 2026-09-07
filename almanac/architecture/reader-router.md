---
title: "Reader Router: Reading Gated and Blocked Sites"
topics: [architecture, browser]
sources:
  - id: reader-router-js
    type: file
    path: src/browser/reader-router.js
  - id: reader-doctor-js
    type: file
    path: src/browser/reader-doctor.js
  - id: reddit-reader-js
    type: file
    path: src/browser/reddit-reader.js
  - id: browser-driver-js
    type: file
    path: src/browser/browser-driver.js
  - id: cerebellum-js
    type: file
    path: cerebellum.js
  - id: server-js
    type: file
    path: server.js
  - id: tool-surfacing-js
    type: file
    path: tool-surfacing.js
  - id: reader-router-spec
    type: file
    path: docs/reader-router-build-spec.md
  - id: reader-router-test
    type: file
    path: tests/reader-router.test.mjs
  - id: reader-doctor-test
    type: file
    path: tests/reader-doctor.test.mjs
  - id: reddit-reader-test
    type: file
    path: tests/reddit-reader.test.mjs
---

# Reader Router: Reading Gated and Blocked Sites

The reader router is the registry-plus-diagnostic pattern (0.11.30) for sites a plain
server-side fetch cannot read at all: Reddit today, with LinkedIn, Quora, Medium, and
Twitter specced as follow-up passes [@reader-router-spec]. `reader-router.js` holds the
per-site registry of which backend to try in which order; `reader-doctor.js` reports which
sites are reachable right now and what would unlock the rest; and `browser-driver.js`
gained a new primitive, `contextRequest()`, that both depend on to reach past a block a
Node `fetch` cannot get through [@reader-router-js] [@reader-doctor-js]
[@browser-driver-js]. This generalizes the Reddit-specific fix on
[Browser](browser) ("Reddit reads bypass the browser entirely," 0.11.29) into a pattern
meant to cover more gated sites without re-solving the same problem per site.

## The problem: three walls, and why two of them share one fix

`docs/reader-router-build-spec.md` names three reasons a server-side read fails, drawn from
two external write-ups on why AI agents can't read Reddit or LinkedIn: a **network-layer
block** (Reddit rejects a datacenter/server fetch by TLS/IP fingerprint, not just
User-Agent — even its `.json` API), a **login gate** (LinkedIn, Quora, metered Medium,
paywalled Substack, private Notion/Confluence — the content only exists for an
authenticated session), and **client-side rendering** (an SPA hands a server fetch an empty
shell; already addressed elsewhere by [Browser](browser)'s shadow-DOM piercing and
`settlePage` work) [@reader-router-spec]. The network-layer block and the login gate share
one fix: **use the ward's own already-logged-in browser**, because Proto-Familiar already
keeps a persistent browser profile (`browser/profile`) across runs once the ward has signed
in through the browser hand-off. A request issued through that context carries the real
browser's TLS fingerprint and cookie jar — the door a plain `fetch` cannot open — while
client-side rendering was already solved by reading the live DOM [@reader-router-spec].

## Why the 0.11.29 Reddit fix needed a second pass

[Browser](browser) records that 0.11.29 routed Reddit reads to `reddit-reader.js`'s public
`.json` API specifically because Reddit's anti-bot wall fingerprints *browser* traffic and
403s it before render. That fix assumed a plain server-side fetch of `.json` was a different
enough door to get through. It was not: the ward reported the JSON reader also came back
empty, and the cause is that Reddit's block operates at the network layer — TLS/IP
fingerprinting that catches a datacenter Node `fetch` regardless of the URL it targets, not
a header check a descriptive User-Agent can satisfy [@reader-router-spec]. The fix this
time is not a different endpoint but a different *requester*: the same `.json` fetch,
issued through the ward's own authenticated browser context instead of Node's `fetch`.

## `contextRequest`: the primitive every gated-site backend builds on

`browser-driver.contextRequest(url, { headers, method, timeoutMs })` fetches through the
persistent browser context's own `context.request` API — the ward's real TLS/HTTP
fingerprint plus the profile's cookie jar and any logged-in session — while still
tunnelling the [SSRF-guarding proxy](browser) that every browser-launched request already
goes through, and it never throws, returning a normalized `{ ok, status, contentType,
text }` on failure instead [@browser-driver-js]. This is the one new capability the whole
pattern rests on: everything reader-router and reader-doctor do is deciding *when* to reach
for this primitive versus a plain Node fetch, not a new way of talking to the network
itself.

## The registry: `reader-router.js`

`reader-router.js` is data, not behavior — it owns `READER_SITES`, an array of gated-site
records (`id`, `label`, `hosts`, an ordered `backends` list, and a one-line `unlock`
description), plus `readerSiteFor(url)` to resolve a URL to its site record and a generic
`runReaderChain(backends, runners)` that tries each backend in order, returns the first
success, and records every attempt in a `tried` array so a total failure is legible rather
than a silent empty string [@reader-router-js]. The vocabulary of backends is shared across
every site the registry will ever hold: `oauth` (a sanctioned API with the ward's
credentials), `browser-session` (`contextRequest` — the fingerprint/login door),
`public-json` or `static-fetch` (a plain best-effort server fetch), and `browser-read` (the
live, authenticated, JS-rendered DOM read [Browser](browser) already provides)
[@reader-router-js] [@reader-router-spec]. Reddit is the only site registered so far, with
`backends: ['oauth', 'browser-session', 'public-json']`; the build spec lists LinkedIn,
Quora, Medium, Substack, and Twitter as follow-up passes, each expected to register in
`READER_SITES`, add a `browser-session`/`browser-read` backend, a doctor probe, an
off-switch, and tests in one commit, following the same shape as the Reddit wiring
[@reader-router-js] [@reader-router-spec].

## Reddit wired through the chain: three tiers in `reddit-reader.js`

`fetchRedditJson()` now tries three tiers in order instead of two [@reddit-reader-js]:

1. **`oauth`** — when the ward has set script-app credentials, the sanctioned
   `oauth.reddit.com` API with an in-memory bearer token. This never touches the anti-bot
   wall at all and was unchanged by this pass.
2. **`browser-session`** (new in 0.11.30) — when the caller supplies a `deps.contextFetch`
   function, `fetchRedditJson` calls it against the same public `.json` URL and trusts the
   result only if it comes back as real JSON; a challenge page or HTML shell falls through
   to the next tier instead of being treated as a read [@reddit-reader-js]. `cerebellum.js`'s
   `read_webpage` executor wires `contextFetch` to `browser-driver.contextRequest` only on
   the ward's own turn and only when browsing is enabled, so a gated villager turn never
   gets the browser-session backend — the persistent session belongs to the ward
   [@cerebellum-js].
3. **`public-json`** — the plain server-side `.json` fetch from 0.11.29, kept as the
   best-effort floor for a ward who has not logged in through the browser hand-off and has
   not set OAuth credentials.

Everything downstream of a successful fetch is unchanged: `parseRedditReadable` renders the
JSON into text and `readReddit` still runs it through `injection-guard.js`'s
`sanitizeExternal()` before it reaches a prompt, because comment and post bodies are
user-authored content like any other web page [@reddit-reader-js]. `tests/reddit-reader.test.mjs`
pins that the browser-session tier wins ahead of the public tier when both are available,
and that a context fetch returning a non-JSON challenge falls through to the next tier
rather than being trusted [@reddit-reader-test].

## The doctor: "which sites can I read right now, and what unlocks the rest?"

`reader-doctor.js` answers the question a failed read leaves open: is a site blocked for
everyone, or just for this ward's current setup? `readerConfigStatus(settings)` reports
what is configured (OAuth credentials present or not) with no network calls, and
`buildReaderReport({ settings, probes, browserUp })` combines that with an optional live
probe per site — a caller-supplied async function so the module itself makes no network
calls and stays unit-testable — producing a per-site `{ reachable, via, detail, unlock }`
record, adding an explicit "browser session not active" hint when a site's chain needs
`browser-session` but no browser is up [@reader-doctor-js]. `runReaderDoctor()` assembles
the live version: it checks whether a Chromium is actually available, builds a real Reddit
probe that reads `r/popular/top.json` through the same tier chain reads use, and returns
the report; `formatReaderReport()` renders it as a first-person 🟢-reachable / ⚫-blocked
readout with the unlock instructions inline, in the same spirit as
[Architecture](../architecture)'s organ-status readout for Phylactery/Unruh availability
[@reader-doctor-js]. The doctor is surfaced two ways: the `reader_doctor` tool (registered
`core` in `tool-surfacing.js`, so it is always advertised rather than gated behind a
feature toggle) lets the Familiar run it mid-conversation when a read comes back empty and
explain exactly why instead of just failing, and `GET /api/reader-doctor` gives the ward
the same report from Settings, always with `wardTurn:true` since the endpoint is the ward's
own surface [@cerebellum-js] [@server-js] [@tool-surfacing-js]. `tests/reader-router.test.mjs`
and `tests/reader-doctor.test.mjs` pin the registry shape, the chain's first-success and
all-fail behavior, and the doctor's reachable/unreachable/throwing-probe cases without any
live network dependency [@reader-router-test] [@reader-doctor-test].

## Invariants

The build spec names a short list of properties any future site backend must preserve
[@reader-router-spec]:

- **`contextRequest` is ward-only in practice.** The persistent browser session belongs to
  the ward, so any backend built on it must gate to a ward turn — never a gated villager
  turn. Both the Reddit wiring in `cerebellum.js` and the live doctor probe check this.
- **The SSRF floor stays intact.** `context.request` still tunnels the guarded proxy
  [Browser](browser)'s SSRF section describes; `guardedFetch`'s public-IP guard still covers
  the plain Node-fetch backends. Nothing in this pattern opens a new unguarded network path.
- **External content is still sanitized** through `injection-guard.js` at the read seam,
  exactly as it was before this pass — reading through a different door does not change
  what the content is.
- **Honest degradation.** A blocked site returns a legible reason plus its unlock
  instructions, via `runReaderChain`'s `tried` list and the doctor's per-site detail, never
  a silent empty string.
- **Off-switches ship with each site.** Reddit keeps `redditReaderEnabled` and
  `PROTO_FAMILIAR_REDDIT_DISABLED=1`; the spec requires each future site's backend to add
  its own toggle in the same commit that wires it.

The spec is also explicit about what this pattern will not do: bypass a paywall the ward's
own logged-in account does not already grant, bundle a third-party anti-detect or proxy
service, or run a background pre-fetch — every read stays on-demand, on the ward's own turn,
through the ward's own session [@reader-router-spec].

## Related

- [Browser](browser) — the click-and-fill subsystem this pattern borrows its browser
  profile, SSRF proxy, and live-DOM read path from, and where the original 0.11.29
  Reddit-JSON fix is recorded.
- [Injection guard: wiring history](injection-guard-gap) — the sanitizer every gated-site
  read still passes through before its text reaches a prompt.
- [Exact values are code's job](../decisions/exact-values-in-code) — the same
  code-decides-Node-only discipline this page's `contextRequest` primitive follows: the
  model never sees or supplies a session cookie or bearer token.
