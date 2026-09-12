# Gated-site reader router — build spec

> **Status: FOUNDATION SHIPPED (0.11.30-alpha).** The authenticated-browser-context
> fetch primitive, the site registry, the doctor, and Reddit wired through them
> landed. The remaining per-site backends (LinkedIn / Quora / Medium / Twitter)
> are follow-up passes (§4). This is the action list; the *why* is captured inline
> and in `almanac/`.

---

## 0. The problem, stated once

An AI can't read most of the interesting web by fetching it server-side. Three
walls, from two independent write-ups (web2md's "Why Claude can't read Reddit",
Panniantong/Agent-Reach):

1. **Network-layer block.** Reddit (post-2023) rejects server-side/datacenter
   fetches outright — even its `.json` API — regardless of DOM-extraction
   quality. TLS/IP fingerprinting, not just a User-Agent check.
2. **Login gate.** LinkedIn, Quora, Medium(metered), Substack(paywall), private
   Notion/Confluence — content only exists for an authenticated session.
3. **Client-side render.** SPA docs sites hand a server fetch an empty shell;
   the content only appears after JS runs in a real browser (already addressed
   by the shadow-DOM piercing + `settlePage` work).

**The generalisable key to walls 1 and 2 is the same: use the ward's own
authenticated browser.** Proto-Familiar already runs a persistent browser
context (`browser/profile`) that keeps the ward's logins across runs (set up via
the browser hand-off). A request issued *through that context*
(`browser-driver.contextRequest` → Playwright `context.request`) carries the
real browser fingerprint AND the logged-in cookies — the door a Node `fetch`
can't open. This is the same insight as Agent-Reach's "reuse the existing Chrome
session" and web2md's "convert in the browser you're already logged into."

## 1. Shape (shipped foundation)

- **`browser-driver.contextRequest(url, {headers, method, timeoutMs})`** — fetch
  through the persistent context. Returns `{ ok, status, contentType, text }`,
  never throws. Uses the context's cookie jar + the guarded proxy (SSRF floor
  intact). The one primitive every gated-site backend builds on.
- **`reader-router.js`** — the site REGISTRY (data, not behaviour): each gated
  site's hosts, its ordered backend chain, and the one-line "what unlocks it."
  `readerSiteFor(url)` and a generic `runReaderChain(backends, runners)` (first
  success wins, every attempt recorded).
- **`reader-doctor.js`** — "which sites can I read now, what unlocks the rest."
  `runReaderDoctor` probes each site (bounded, live), `buildReaderReport`
  assembles config + reachability, `formatReaderReport` renders it first-person.
  Surfaced as the **`reader_doctor`** tool AND `GET /api/reader-doctor`.
- **Reddit** wired through the chain in `reddit-reader.fetchRedditJson`: **oauth**
  (sanctioned API, if credentials) → **browser-session** (authenticated
  `context.request` on the `.json` URL — trusted only if it returns real JSON) →
  **public-json** (best-effort). `read_webpage` routes Reddit URLs here before
  the browser/static path; the browser-session backend is offered only on the
  ward's own turn (the session is theirs).

## 2. Backends (the vocabulary)

| backend | mechanism | unlocks |
|---|---|---|
| `oauth` | sanctioned API + ward credentials | Reddit (script app) |
| `browser-session` | `context.request` — real fingerprint + login cookies | network-blocked + login-gated sites |
| `browser-read` | read the live authenticated DOM (`browseRead` + shadow-DOM piercing) | login-gated pages that render fine once in |
| `public-json` / `static-fetch` | plain server-side fetch | open sites, best-effort floor |

## 3. Invariants (do not regress)

- **`contextRequest` is ward-only in practice.** The persistent session is the
  ward's; a backend that uses it must be gated to ward turns (never a gated
  villager turn — the read scoping fail-closed rule). The Reddit wiring and the
  doctor both check `wardTurn`.
- **SSRF floor stays.** `context.request` tunnels the context's guarded proxy;
  don't bypass it. `guardedFetch`'s public-IP guard covers the Node backends.
- **External content is sanitised** at the read seam (injection-guard) — comment
  bodies and page text are user-authored. Already done for Reddit.
- **Honest degradation.** A blocked site returns a legible reason + the unlock,
  never a silent empty string. `runReaderChain.tried` and the doctor make the
  failure visible.
- **Off-switches.** Reddit: `redditReaderEnabled` + `PROTO_FAMILIAR_REDDIT_DISABLED=1`.
  Each future site backend ships its own toggle in the same commit.

## 4. Follow-up passes (per site)

Each: register in `READER_SITES`, add a `browser-session`/`browser-read` backend,
a doctor probe, an off-switch, tests, docs — in one commit.

- **LinkedIn** — `browser-read` off the logged-in profile (public API is closed).
- **Quora / Medium / Substack** — `browser-read`; respect the ward's own logged-in
  entitlement (no paywall circumvention beyond what their session already grants).
- **Twitter/X** — `browser-session` for single tweets/threads off the login.
- **YouTube transcripts, RSS** — open backends (no auth), lower priority.

Login is via the existing **browser hand-off** (the ward logs in once in the
headed window; the profile keeps it). No credential scraping; no new secret store
beyond Reddit's optional OAuth fields.

## 5. Explicitly out of scope

- Bypassing a paywall the ward's own account doesn't grant. `browser-read` reads
  what the ward could read logged in — nothing more.
- Bundling third-party proxy/anti-detect services. The mechanism is the ward's
  own session, on their own machine.
- A background pre-fetch/crawl. Reads stay on-demand, on the ward's turn.
