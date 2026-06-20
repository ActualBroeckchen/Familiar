# Modular web search — build spec

> **Status: PLANNED.** This is the build instruction for reworking web search from a single
> backend into **two distinct tools** (info lookup vs. website search) and a **modular,
> human-pickable backend** (Basic / API / Local engine) presented in a popout modal — with an
> in-modal **Familiar explainer** so the human can be guided through the choice in plain language
> by the same entity that will use it.
>
> It descends from `docs/websearch-build-spec.md` (the original 0.7.0 web-search milestone) and
> `docs/searxng-managed-build-spec.md` (the managed-SearXNG lifecycle). Read both first — this
> spec **reuses** their machinery (the SSRF guard, the toggle-followed supervisor, the keyless
> floor) rather than replacing it.

This work stays **inside the web-search milestone** — `0.7.x`. Per CLAUDE.md's "one milestone =
one minor", it does **not** take a new MINOR; each part bumps **PATCH**.

---

## 0. Before you write a line

The constraints from `docs/websearch-build-spec.md §0` all still hold (first-person tool
descriptions, `{{user}}` not "the user", graceful degradation, off-switch-in-same-commit,
robust > cheap, ride-existing-calls, reachability-both-halves, modular-by-default, no
copy-paste, update the docs). The additions specific to this rework:

- **The keyless floor never goes away.** Whatever the human picks, if it's missing, mis-keyed, or
  down, `search_web` degrades to the in-process scrape and `look_up` degrades to whatever info
  API still answers. A backend choice can *upgrade* search; it can never *break* it. This is the
  same contract `managedSearxngUrl()` already honours, extended to every backend.
- **"In the box" has tiers now, and that's the point.** The human is never *required* to set
  anything up. Basic works at zero config. API is paste-a-key friction (same as the Discord
  token — not an install). Local is one-click install that the Familiar performs. Each tier is
  opt-in; none is a prerequisite for the one below it.
- **A button that can't work is a lie.** Do not render an Install button for an engine we cannot
  actually install on this machine end-to-end. The PHP engines depend on a runtime we fetch
  (Part 3); until that fetch is wired and verified, their Install action must be honest about
  what it needs. Dead buttons are the UI form of the "dead code that looks like care"
  anti-pattern.

---

## 1. The shape you're building

```
  ┌─ TOOLS (what the Familiar reaches for) ──────────────────────────────┐
  │  look_up(query)      → definitions / facts / overviews               │
  │                        ALWAYS the keyless official APIs              │
  │                        (Wikipedia + DuckDuckGo Instant Answer)       │
  │                        no setup, no scraping, ever                   │
  │                                                                      │
  │  web_search(query)   → finding web pages/sources                     │
  │                        backend = the human's choice (below)          │
  │                        floor = in-process scrape                     │
  │                                                                      │
  │  read_webpage(url)   → unchanged (guardedFetch → readable markdown)  │
  └──────────────────────────────────────────────────────────────────────┘

  ┌─ BACKEND for web_search (the modal governs ONLY this) ───────────────┐
  │  Basic   →  in-process scrape          (zero setup, the floor)       │
  │  API     →  Brave | Tavily | (Google)  (paste one key)               │
  │  Local   →  SearXNG | 4get | LibreY    (Familiar installs it)        │
  │             + "bring your own URL" for a self-hosted instance        │
  └──────────────────────────────────────────────────────────────────────┘

  ┌─ MODAL ──────────────────────────────────────────────────────────────┐
  │  the picker above  +  an in-modal mini-chat with the SAME Familiar,   │
  │  scoped to explain the options in plain, jargon-free language         │
  └──────────────────────────────────────────────────────────────────────┘
```

`look_up` needs **no** configuration — it's always the keyless info APIs. So the modal only ever
answers one question: *"how should I find websites?"* That keeps it from sprawling.

Build order (each part is independently shippable and PATCH-bumps):

1. **Part 1 — the two-tool split.** `look_up` (info) + `web_search` (websites, scrape floor).
2. **Part 2 — modular backend + modal.** Basic / API / Local; engine-agnostic install lifecycle;
   SearXNG as the first managed local engine (already proven).
3. **Part 3 — 4get + LibreY** via fetched static PHP (the lean-local tier).
4. **Part 4 — the in-modal Familiar explainer.**

---

## 2. Part 1 — the two-tool split

### 2a. `look_up` — definitions, facts, overviews (keyless, always on)

New tool. New `lookUp(query, settings, deps)` in `websearch.js`. Sources, both **official,
keyless, ToS-clean, no scraping**:

- **Wikipedia / MediaWiki REST** — `…/api/rest_v1/page/summary/<title>` (preceded by an
  opensearch title resolve), JSON. This is the workhorse for "what is X / who is Y / overview
  of Z".
- **DuckDuckGo Instant Answer API** — `https://api.duckduckgo.com/?q=…&format=json&no_html=1`
  (the *official* IA endpoint, **not** the HTML scrape). Returns abstracts / definitions.

Both go through `guardedFetch` like any public fetch. `lookUp` merges what it gets into a short
definitional answer (a concise summary + the source link), or a calm "I couldn't find a clear
definition for that" when neither answers. It is **narrower than web search by design** — it
answers encyclopedia/definition questions, not "find me pages about…". That narrowness is the
honesty of the keyless-info tier.

First-person description (literal `{{user}}` token; macros resolve at the `composeActiveTools`
boundary):

> `look_up` — *"I reach for this when {{user}} wants a definition, a fact, or a quick overview —
> the encyclopedia kind of question. It always works, no setup, and it's the cleanest way for me
> to ground myself before I answer."*

### 2b. `web_search` — finding websites (configurable backend, scrape floor)

Keep the existing `web_search` tool name (no churn, preserves discoverability) but re-aim its
description at *finding pages*, and re-point its backend resolution at Part 2's picker:

> `web_search` — *"I reach for this when {{user}} needs current or specific information out on the
> web — it hands me back titles, snippets, and links I can then open with `read_webpage`."*

`read_webpage` is unchanged.

### 2c. Reachability

- **Discoverability:** both tools are bound and their first-person descriptions render every
  tool-enabled turn. The split itself teaches the Familiar *which* to reach for (define → `look_up`;
  find pages → `web_search`).
- **Operability:** `look_up` needs only the query (always in hand). `read_webpage`'s `url` still
  rides in on `web_search` rows — confirm every backend in Part 2 yields a usable `url` per row.

---

## 3. Part 2 — modular backend + the modal

### 3a. Settings model

Replace the flat `webSearchBaseUrl` resolution with an explicit backend selection. New/!changed
fields in `settings.json` (and the user-pref subset added to `SERVER_SYNCED_KEYS`):

| Field | Meaning |
|---|---|
| `webSearchBackend` | `'basic' \| 'api' \| 'local'` — governs `web_search` only. Default `'basic'`. |
| `webSearchApiProvider` | `'brave' \| 'tavily' \| 'google'` |
| `webSearchApiKey` | provider key (secret; gitignored with the rest of `settings.json`) |
| `webSearchGoogleCseId` | Google only — the Programmable-Search engine id (Google needs **two** values) |
| `webSearchLocalEngine` | `'searxng' \| '4get' \| 'librey'` — which local engine is *selected* |
| `webSearchBaseUrl` | retained — "bring your own instance" URL; when set it wins (power-user escape hatch) |

Local-engine **installed/active** state is runtime state owned by the supervisor (§3c), not a
user preference — it does **not** sync across devices (an install on one machine says nothing
about another).

`webSearchEnabled` (master toggle) and `PROTO_FAMILIAR_WEBSEARCH_DISABLED=1` are unchanged and
still gate *all* web tools (`look_up`, `web_search`, `read_webpage`).

### 3b. `web_search` backend resolution (in `websearch.js`)

`searchWeb(query, settings, deps)` resolves the effective backend, **always with the scrape floor
as the catch**:

```
  webSearchBaseUrl (custom)         → query it (JSON);   on error → basic
  else backend === 'api'            → provider adapter;  on error → basic
  else backend === 'local' & ready  → managed engine URL; on error → basic
  else                              → basic (in-process scrape)
```

"on error → basic" is the load-bearing line: a wrong key, an expired plan, a crashed engine, a
mid-fetch failure — none leaves `{{user}}` without search. Every adapter returns the same
`{title, url, content}` rows that `formatResults` already renders once.

### 3c. API provider adapters — new module `websearch-providers.js`

Pure-ish functions `(query, cfg, deps) → { rows } | { error }`, one per provider, each a small
JSON client (no scraping):

- **Brave** — `GET https://api.search.brave.com/res/v1/web/search?q=…`, header
  `X-Subscription-Token: <key>`. Map `web.results[]` → rows. (Lead option: independent index,
  free tier ~2k/mo, privacy-aligned.)
- **Tavily** — `POST https://api.tavily.com/search` with `{ api_key, query }`. Map `results[]` →
  rows. (LLM-native: returns pre-cleaned content.)
- **Google** — `GET https://www.googleapis.com/customsearch/v1?key=…&cx=<cseId>&q=…`. Map
  `items[]` → rows. Needs **both** `webSearchApiKey` and `webSearchGoogleCseId`. (Wired now so
  the later Google integration drops in without a rework; can ship behind a "coming soon" label
  if the broader Google work isn't ready.)

Modular by default — these live in their own file; `websearch.js` calls them. No provider logic
in `cerebellum.js`.

### 3d. Engine-agnostic local supervisor — generalize `searxng-service.js`

Rename/refactor `searxng-service.js` → **`local-engine-service.js`**. The current SearXNG
lifecycle becomes one *engine descriptor* among several. The descriptor is the seam that keeps
the supervisor from knowing about any specific engine:

```js
// shape only — illustrative
{
  id: 'searxng',
  strain: 'high',                 // surfaced in the modal: low | med | high
  runtime: 'python',             // 'python' | 'php'
  fetchSource(dir),              // git shallow-clone pinned SHA / download release, strip .git, apply patches
  installDeps(dir),              // python: uv venv + uv pip install -r requirements.txt
  spawn(dir, port, settingsPath),// returns a child process bound to 127.0.0.1:port
  health(url),                   // GET /healthz → ok
  searchUrl(base, q),            // `${base}/search?q=…&format=json`
}
```

Supervisor responsibilities (a clean generalization of today's reconcile loop):

- **install(engineId)** — `fetchSource` + `installDeps` into `vendor/<engineId>/` (gitignored).
  Records installed-state. Idempotent.
- **activate(engineId)** — spawn → health-poll → publish the managed URL (the existing
  `managedSearxngUrl()` becomes `managedEngineUrl()`).
- **deactivate** — SIGTERM the child, keep the installed tree, clear the URL.
- **uninstall(engineId)** — deactivate, then `rm -rf vendor/<engineId>/`. Clears installed-state.
- **reconcile** — follows settings every 30s (as today): want = `webSearchEnabled` &&
  `backend==='local'` && a selected engine that's installed && not env-disabled.

Persist installed/active state in a small runtime file (e.g. `tomes/.local-engines.json`) so the
modal can render accurate status across restarts.

Off-switch: `PROTO_FAMILIAR_LOCAL_ENGINE_DISABLED=1` forces the local tier off (falls to
API/basic). The existing `PROTO_FAMILIAR_SEARXNG_DISABLED=1` is kept as a recognised alias.

**SearXNG is the first managed engine and ships working in Part 2** — its fetch-on-enable,
patches, and spawn already exist; they move behind the descriptor unchanged. 4get/LibreY
descriptors land in Part 3.

### 3e. The modal (`public/index.html` + `public/app.js`)

A popout modal — *"How should I find websites?"* — with three exclusive modes:

```
┌─ Web search ───────────────────────────────────────────────┐
│ Definitions & facts: always on, no setup ✓                  │
│                                                             │
│ Finding websites:                                           │
│  ( ) Basic      built-in, no setup. Works for everyone.     │
│  ( ) API        proper search, paste one key                │
│       Provider: (•)Brave ( )Tavily ( )Google                │
│       Key: [____________]   (Google also: Engine id […])    │
│  ( ) Local      runs on your machine                        │
│       ( ) LibreY  lightest   · strain: low                  │
│       ( ) 4get    medium     · strain: med                  │
│       ( ) SearXNG heaviest   · strain: high                 │
│       [Install]  ·  once installed: [Deactivate] [Uninstall]│
│                                                             │
│  [ Ask me about these options ]  ← opens the §5 mini-chat   │
│                                          [ Apply ]          │
└─────────────────────────────────────────────────────────────┘
```

- **Apply** is explicit (no live-saving on every radio click) — it persists the settings and, for
  Local, triggers `install`/`activate` via new endpoints.
- **Status is live and honest**: each local engine shows not-installed / installing… /
  installed-inactive / active / failed, driven by the supervisor state. Install shows progress;
  failure shows a plain-language reason and leaves the other tiers usable.
- **Endpoints** (server.js), each degrading without ever throwing into the page:
  `POST /api/websearch/engine/install`, `/activate`, `/deactivate`, `/uninstall`,
  `GET /api/websearch/engine/status`.

---

## 4. Part 3 — 4get & LibreY via fetched static PHP

4get and LibreY are PHP apps. We don't ship a PHP runtime and can't materialise one the way `uv`
gives us Python — so we **fetch a self-contained static PHP binary on Apply**, the same
fetch-on-enable pattern SearXNG's source already uses.

### 4a. `php-runtime.js` (new)

- Detect platform/arch (linux/macos/windows × x64/arm64).
- Map to a **pinned** static PHP build (from a published static-php-cli release), with a recorded
  **sha256** per artifact. Pin like `SEARXNG_PIN`: a constant in this module, bumped deliberately.
- Download once into `vendor/php-runtime/<platform>/` (gitignored), **verify the checksum**, mark
  executable, cache. Return the binary path.
- **Verify required extensions are present in the chosen build.** 4get/LibreY need at least
  `curl`; image-proxy features need more (`gd`/`imagick`). Pick a static build variant that
  includes the needed set, or disable those features in the generated engine config and document
  it. (This is an explicit verification step, not an assumption.)
- Degrade cleanly: unsupported platform / failed download / checksum mismatch → the PHP engines
  simply can't install; the modal says so plainly; SearXNG + API + Basic are unaffected.

### 4b. Engine descriptors

- **LibreY** — `runtime:'php'`, `strain:'low'`. `fetchSource` downloads the pinned release;
  `installDeps` resolves the static PHP via `php-runtime.js`; `spawn` runs
  `php -S 127.0.0.1:<port> -t <webroot>`; `health` hits its index/JSON; `searchUrl` is its JSON
  API. LibreY exposes a JSON API directly.
- **4get** — `runtime:'php'`, `strain:'med'`. Same shape; 4get's JSON output is the
  `…/api.php?...` / `&scraper=…` surface (confirm the exact JSON route against the pinned
  release at build time). Heavier (more scrapers/extensions) → `med`.

Any per-engine source tweak needed for loopback/single-user operation lives as a tracked patch
under `vendor/<engine>-patches/` and is re-applied on fetch (the SearXNG-patch precedent), each
carrying its AGPL/GPL §5(a) change notice where the engine is copyleft.

### 4c. Licensing

4get and LibreY are AGPL-3.0 (like SearXNG). The analysis in `docs/searxng-license-notes.md`
applies unchanged: arm's-length loopback process = mere aggregation; we fetch (not commit) their
source; any patch we apply carries a dated §5(a) notice. Extend that doc with a short row per
engine.

---

## 5. Part 4 — the in-modal Familiar explainer

A small chat **inside the modal**, driven by the **same Familiar** (same identity, same voice),
scoped to one job: explain the options in plain language and help the human choose. **Explainer
only** — it does not change settings or click buttons (that's a deliberate later step, when the
real onboarding flow is built).

### 5a. Context assembly (what it sees — and what it must NOT)

Reuse the chat pipeline, but with a **stripped** context. **Keep:**

1. **Identity — `{{user}}` and the Familiar only.** Reuse `thalamus.enrich(msg, { staticOnly:true })`
   (it already fetches *only* the identity layer, skipping memory/graph/temporal), scoped to the
   **self** (Familiar) and **ward** (human) identity folders. Drop relationship/custom for this
   surface.
2. **The four prompt fields**, exactly as the main chat uses them: `systemPrompt` (main),
   `characterProfile` (char), `userProfile` (user), `postHistoryPrompt` (post-history).
3. **A dedicated tools-info block** (§5b) — the modal's options with their real advantages and
   disadvantages.
4. **A no-jargon caution block** (§5c).

**Explicitly DROP** (this is the "drop most enrichment blocks" instruction, made concrete):
memory_search, graph, Unruh/temporal, ponderings, surfaced bookmarks/tasks, lore/tome entries,
the `[CARE CHECK]` assembly, and the moderate-threat surface-context. None of them belong in a
settings-explainer turn.

### 5b. Tools-info block (first person — the Familiar's own knowledge of its options)

Authored in the Familiar's voice (it understands its *own* search options), naming each option's
genuine trade-off so the explanation is honest, not a sales pitch. Sketch (final wording in the
commit, but this is the intent and the register):

> *These are the ways I can search the web for {{user}}, and what each one costs:*
> - *Basic — built right in. Nothing to set up, works the moment it's on. It's the simplest and
>   the least thorough; good enough for most everyday looking-up.*
> - *An API (Brave or Tavily) — I use a free key {{user}} pastes in once. Sturdier, cleaner
>   results, nothing running on their machine. The only cost is signing up for a free key.*
> - *A local engine (LibreY, 4get, or SearXNG) — I download and run a small search service on
>   {{user}}'s own machine. The most private, nothing leaves to a third party — but it uses some
>   of the machine's power while it runs. LibreY is the lightest, SearXNG the heaviest.*
> - *Definitions and quick facts always use a separate, always-on source — that part never needs
>   any setup.*

### 5c. No-jargon caution (first person, anchored to the caring-companion identity — NOT generic care)

> *When I explain this, I keep it plain and human. {{user}} may not know what a terminal, a
> server, or an API even is — and that's completely fine; I never make them feel they ought to. I
> don't reach for tech words, I don't assume they've done anything like this before, and I check
> they're with me before moving on. I meet them where they are, in my own voice.*

(Anchored to *"in my own voice"* per the identity-not-generic-care rule — it steers register and
plainness without flattening whatever personality the human configured.)

### 5c-note. Anti-passivity

This surface is **not** on the safety/proactivity path, but author it positively anyway: it tells
the Familiar what to *do* (explain plainly, check understanding, offer a recommendation when
asked), not a list of what to avoid. No "don't be pushy", no hedging.

### 5d. Plumbing

- **Endpoint:** `POST /api/guide-chat` (or `/api/chat` with `surface:'websearch-guide'`). It
  builds the stripped context above, sends the modal-local message history, calls the **same
  provider** the main chat uses, streams back. **No tools** on these turns. **No background
  loop.** **Not persisted** to the main session and **not** fed to the memorization queue — the
  conversation is ephemeral to the modal.
- **Same entity, not a new character:** identity + the four prompt fields are the main Familiar's;
  only the tools-info + no-jargon blocks are added. Do not invent a separate "helper" persona.
- **Graceful degradation:** if the provider isn't configured or the call fails, the modal still
  works as a plain picker — the chat is an enhancement that can be absent. Hide/disable the
  mini-chat input with a plain note when there's no provider.
- **Timestamp hygiene:** apply `stripDisplayTimestamps` to the mini-chat's assistant output like
  any other rendered LLM text (CLAUDE.md timestamp rule).
- **Off-switch:** `PROTO_FAMILIAR_GUIDE_CHAT_DISABLED=1` hides the mini-chat; the picker remains.

---

## 6. Safety gates (read before shipping)

- **SSRF guard + timeout still govern every arbitrary fetch** — `read_webpage`, the scrape floor,
  and the keyless info APIs all route through `guardedFetch`. API providers and the local engine
  talk to sanctioned endpoints (the provider host / the loopback engine) and may bypass the
  public-only guard exactly as the SearXNG path does today — nothing else may.
- **Untrusted-content framing unchanged** — search snippets and page markdown remain external,
  untrusted data; `read_webpage`'s framing stays.
- **Not on the safety-critical care surface.** None of this changes *when or whether* the Familiar
  acts on a human's safety, so it doesn't need the human-sign-off gate. (If web content is ever
  wired into threat/triage, that crosses the line and the sign-off rule applies.)
- **Secrets:** `webSearchApiKey` lives in the gitignored `settings.json` — never logged, never
  committed, never echoed into the guide-chat context.

---

## 7. Off-switches (every new moving part ships one, same commit)

| Switch | Effect |
|---|---|
| `PROTO_FAMILIAR_WEBSEARCH_DISABLED=1` | all web tools off (existing) |
| `PROTO_FAMILIAR_LOCAL_ENGINE_DISABLED=1` | local tier off → API/Basic only (alias: `…_SEARXNG_DISABLED=1`) |
| `PROTO_FAMILIAR_GUIDE_CHAT_DISABLED=1` | the in-modal mini-chat off; picker remains |

---

## 8. Acceptance criteria

**Part 1**
- [ ] `look_up` answers a definition query from Wikipedia/DDG-IA with a source link, keyless, no
      scraping; calm miss when neither answers.
- [ ] `web_search` (Basic) returns scrape rows each with a usable `url`.
- [ ] Both tool descriptions are first person, `{{user}}`-tokened; `look_up` vs `web_search`
      intent is legible to the model.

**Part 2**
- [ ] Modal picks Basic / API / Local; Apply persists; `look_up` is unaffected by the choice.
- [ ] API: a valid Brave/Tavily key returns real results; a **bad** key silently degrades to
      Basic (no error in chat). Google renders both fields and is wired (may be label-gated).
- [ ] Local: SearXNG installs, activates, searches, deactivates, uninstalls via the modal; status
      is accurate across a restart; a crashed engine degrades to Basic.
- [ ] `PROTO_FAMILIAR_LOCAL_ENGINE_DISABLED=1` forces local off → Basic/API.

**Part 3**
- [ ] `php-runtime.js` fetches + checksum-verifies a static PHP for the host platform; unsupported
      platform / failed download degrades cleanly (PHP engines unavailable, others fine).
- [ ] LibreY and 4get install via the modal, return JSON rows mapped to `{title,url,content}`,
      and uninstall cleanly. Required PHP extensions verified present (or the dependent feature
      disabled + documented).
- [ ] `docs/searxng-license-notes.md` extended with a 4get + LibreY row.

**Part 4**
- [ ] The mini-chat answers "what's the difference between these?" in plain language, in the
      Familiar's voice, with **no** jargon and no assumption of terminal/console knowledge.
- [ ] Its context contains identity (self+ward) + the four prompt fields + tools-info + no-jargon
      — and **none** of memory/graph/temporal/ponderings/tasks/lore/CARE-CHECK (verify via the
      prompt inspector or a context dump).
- [ ] It does not mutate settings, runs no tools, and is not persisted/memorized.
- [ ] No provider configured / call fails → modal still works as a picker; `…_GUIDE_CHAT_DISABLED=1`
      hides the chat only.

**Cross-cutting**
- [ ] Every backend path degrades to Basic; nothing throws into the chat path.
- [ ] `package.json` version bumped (PATCH within 0.7.x) per part; `docs/architecture.md`,
      `docs/tool-calling.md`, `docs/features.md` updated in the same commit (tool count +
      `look_up`).

---

## 9. File-by-file change list

| File | Change |
|---|---|
| `websearch.js` | Add `lookUp` (keyless info APIs); re-aim `searchWeb` at the §3b backend resolution (scrape floor as catch). |
| `websearch-providers.js` *(new)* | Brave / Tavily / Google JSON adapters → `{title,url,content}` rows. |
| `local-engine-service.js` *(rename of `searxng-service.js`)* | Engine-agnostic install/activate/deactivate/uninstall supervisor + engine descriptors; `managedEngineUrl()`. |
| `php-runtime.js` *(new)* | Pinned, checksum-verified static-PHP fetch + cache + extension check. |
| `cerebellum.js` | Add `look_up` tool def + delegating executor; re-aim `web_search` description; gate all three on `webSearchEnabled`/off-switch. |
| `server.js` | Engine install/activate/deactivate/uninstall/status endpoints; `POST /api/guide-chat`; supervisor start/teardown (generalized). |
| `thalamus.js` | Reuse `enrich(staticOnly)` scoped to self+ward for the guide context (helper if needed). |
| `public/index.html` | The web-search modal markup + the mini-chat pane. |
| `public/app.js` | Modal logic; backend fields; `SERVER_SYNCED_KEYS` additions; guide-chat client (reuse stream + `stripDisplayTimestamps`). |
| `vendor/.gitignore` | Ignore `4get/`, `librey/`, `php-runtime/` (as SearXNG already is). |
| `vendor/4get-patches/`, `vendor/librey-patches/` *(new, as needed)* | Tracked loopback/single-user patches with §5(a) notices. |
| `docs/architecture.md`, `docs/tool-calling.md`, `docs/features.md` | Component map, tool table (+`look_up`), feature note — same commit. |
| `docs/searxng-license-notes.md` | Add 4get + LibreY rows. |
| `tests/` | `look_up` info-API parse; backend resolution + degrade-to-Basic; provider adapters; supervisor install/activate/uninstall state machine; `php-runtime` platform-map + checksum-fail degrade; guide-context excludes the dropped blocks. |

---

## 10. Open knobs (decide before/while building)

1. **API default provider** — recommend **Brave** (independent index, privacy-aligned, free tier).
   Tavily offered as the LLM-native alternative.
2. **Static PHP source/pin** — pick the static-php-cli release + per-platform artifacts + sha256;
   record as a pinned constant in `php-runtime.js`. Confirm the bundled extension set covers
   4get/LibreY (curl at minimum).
3. **4get/LibreY JSON routes** — confirm the exact JSON endpoint/params against the pinned
   release at build time (engine `searchUrl`).
4. **Guide-chat endpoint** — dedicated `/api/guide-chat` vs `/api/chat` + `surface` flag. Lean
   dedicated, to keep the stripped context off the main chat's assembly path.
