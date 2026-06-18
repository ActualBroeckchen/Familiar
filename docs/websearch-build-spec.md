# Web search & read — build spec

> **Status: PLANNED (targets `0.7.0-alpha`).** This is the build instruction for giving
> the Familiar the ability to **search the web, read a page, and keep what's worth keeping** —
> backed by a local, self-hosted [SearXNG](https://docs.searxng.org/) instance and in-process
> content extraction. It is the **what and in-what-order**. The reviewed proposal it descends
> from chose SearXNG + `@mozilla/readability`; this spec keeps that shape, swaps the DOM for the
> lighter `linkedom`, and hardens it against the conventions in `CLAUDE.md`.

This milestone owns the `0.7.0` minor slot: the feature landing is `0.7.0-alpha`; any
follow-up fixes inside it bump PATCH.

---

## 0. Before you write a line

Read these first. They are constraints you build *inside of*, not background reading.

1. **`CLAUDE.md`** — repo root. The rules you will violate by accident if you don't
   internalise them now:
   - **First-person convention (non-negotiable).** Every tool description the Familiar reads
     is written *in its own voice* ("I reach for this when…"), never imperative ("Search the
     web…"). No exceptions in this milestone.
   - **"My human" / `{{user}}`, never "the user."** Tool descriptions resolve macros at the
     `composeActiveTools` boundary, so author them with the literal `{{user}}` token.
   - **Graceful degradation is a rule.** SearXNG being down, a page timing out, an extractor
     throwing — none of these may surface as an error in the human's conversation. They become
     structured *strings returned into the tool loop* (the `executeToolCall` contract, which
     never throws into the chat path). Absence renders as a calm "I couldn't reach that."
   - **Every new capability ships its hard off-switch in the same commit.** These aren't
     background loops, but a *network-egress* power earns the same treatment: a Settings toggle
     **and** an env kill-switch (`PROTO_FAMILIAR_WEBSEARCH_DISABLED=1`).
   - **Robust > cheap.** Do not lead with the bare `fetch(url)`. The SSRF guard and the timeout
     are part of the minimum, not a follow-up.
   - **Ride existing LLM calls; gate in code.** These tools ride the *existing* server-side tool
     loop (`runToolCallLoop`). Add **no** new LLM request. The two-step search→read flow is the
     model's own judgement inside one `/api/chat` cycle.
   - **Reachability (both halves, same commit).** Discoverability: the first-person descriptions
     on the two bound tools are the surface — the model sees them every tool-enabled turn.
     Operability: `read_webpage`'s `url` argument **rides in** on `web_search` results (the
     `mem_delete(id)` precedent). Confirm the search result format always carries a usable URL.
   - **Modular by default.** The heavy logic (SSRF guard, fetch, extraction) lives in a new
     focused module, **not** piled into `cerebellum.js`. Cerebellum gets only the tool
     *definitions* and thin executor entries that delegate.
   - **No copy-paste of substantial logic.** One fetch-with-guard helper, called by both tools.
   - **Update `docs/architecture.md`, `docs/tool-calling.md`, `docs/features.md` in the same
     commit** as the code. The tool count and tables in those files enumerate every tool.
   - **Versioning.** `package.json` `version` is the single source of truth; the feature lands
     at `0.7.0-alpha`.

2. **`docs/tool-calling.md`** — how the registry, executors, and the multi-round loop fit
   together. Your two tools slot into the same machinery as the existing thirty-four.

3. **`cerebellum.js`** — read `BUILTIN_TOOLS` (the registry), `TOOL_EXECUTORS` (the
   `(args, ctx)` executors), `executeToolCall` (the no-throw boundary, the macro substitution
   at the result boundary), and `runToolCallLoop` (the multi-round driver). You are extending
   these, not changing their shape.

4. **`public/app.js`** — `SERVER_SYNCED_KEYS`. Any user-preference field you add to settings
   that should follow the human across devices goes in that list.

---

## 1. The shape you're building

```
   ┌──────────────────────────────────────────────────────────────┐
   │  /api/chat  →  runToolCallLoop  (existing, unchanged)         │
   │                     │                                          │
   │            executeToolCall(name, args, ctx)                   │
   │                     │                                          │
   │        ┌────────────┴─────────────┐                           │
   │   web_search(query)          read_webpage(url)                │
   │        │                          │                           │
   └────────┼──────────────────────────┼───────────────────────────┘
            │                          │
            ▼                          ▼
     websearch.js  ──────────────────────────────  (NEW focused module)
       searchWeb(query, settings)   readWebpage(url, settings)
            │                          │
            │                    guardedFetch(url)  ◄── SSRF guard + timeout
            │                          │              (shared helper)
            ▼                          ▼
     SearXNG JSON API          raw HTML → linkedom → Readability → turndown
   (local Docker, configured     → markdown (truncated, framed as UNTRUSTED
    base URL in settings)          external content, stamped with source URL)
                                          │
                                          ▼
                                 in-session: stays in history, re-accessible
                                 + prompt-cacheable, no re-fetch needed.
                                 across sessions: the Familiar may keep the
                                 gist via the EXISTING save_to_tome —
                                 provenance rides along so it survives.
```

- **No Discord exposure.** Discord turns run no tools; only `/api/chat` composes the tool
  list (`composeActiveTools`, server.js). Adding to `BUILTIN_TOOLS` is correctly scoped to the
  web chat path with tool use enabled.
- **No new LLM call.** Everything above is one tool round inside the existing loop.

---

## 2. Pillar A — the SearXNG service

SearXNG runs as a **local, self-hosted** Docker container the human starts themselves. It is
**not** bundled into the Node process and **not** auto-started — the spec treats its base URL
as configuration.

1. Document a minimal `docker run` / compose in `docs/getting-started.md` (or a new
   `docs/websearch-setup.md` linked from it). The human owns the container lifecycle.

2. Required SearXNG `settings.yml`:
   ```yaml
   search:
     formats:
       - html
       - json          # the API is JSON-disabled by default; this is mandatory
   server:
     secret_key: "<generated>"   # SearXNG refuses to start the API without it
   ```
   Call out **both** lines in the docs — the reviewed proposal named only `formats`, and a
   bare `formats` block without `secret_key` won't boot.

3. The base URL is a **setting** (`webSearchBaseUrl`, default `http://localhost:8080`), never a
   literal in code. SearXNG's container port (8080) is unrelated to Proto-Familiar's own
   default (8742) — no clash, but don't hardcode either.

---

## 3. Pillar B — settings, toggle, off-switch

In the same commit as the tools:

1. **Settings fields** (stored in `settings.json`, surfaced in the Settings UI under a "Web
   search" group):
   - `webSearchEnabled` — boolean master toggle. When false, the two tools are **omitted from
     the advertised tool list** (filtered in `composeActiveTools` or its caller), not merely
     left to error. The model shouldn't see a tool it can't use.
   - `webSearchBaseUrl` — string, default `http://localhost:8080`.
   - `webSearchMaxResults` — int, default 5 (caps `web_search` rows to protect context).
   - `webSearchMaxChars` — int, default 15000 (caps `read_webpage` markdown).
2. **Sync.** Add the user-preference fields to `SERVER_SYNCED_KEYS` in `public/app.js` so they
   follow the human across devices (mind the first-sync absorption caveat in `CLAUDE.md`).
3. **Hard env off-switch.** `PROTO_FAMILIAR_WEBSEARCH_DISABLED=1` forces both tools off
   regardless of settings — checked in the same place the toggle is read, so ops can kill
   egress without touching the UI.

---

## 4. Pillar C — `websearch.js`, the focused module

A new module at repo root. It owns **all** logic; `cerebellum.js` only registers and delegates.

### 4a. `guardedFetch(url, { timeoutMs })` — the SSRF + timeout boundary (safety-critical)

This is the load-bearing safety primitive. A poisoned `web_search` snippet can steer the model
to call `read_webpage` on an internal URL; web content is **untrusted external data** flowing
toward a Familiar that holds `contact_trusted_person`, `delete_memory`, `relay_message`, and
identity edits. The guard is not optional.

- **Scheme allow-list:** `http:` and `https:` only. Reject `file:`, `ftp:`, `data:`, etc.
- **Block private / loopback / link-local / reserved targets.** Resolve the hostname and reject
  if it lands in: `127.0.0.0/8`, `::1`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`
  (cloud metadata `169.254.169.254`), `0.0.0.0`, `*.localhost`, and any non-global address.
  Guard against DNS-rebinding by validating the **resolved** IP, not just the literal host.
- **The configured SearXNG base URL is the one sanctioned loopback exception** — `searchWeb`
  talks to it directly and does **not** route through the public-only guard. `read_webpage`
  always uses the guard.
- **Timeout via `AbortController`** (default 8–10s). Tool results run under `Promise.all` in
  the loop — one hung host must not stall the whole round.
- **No redirect into a blocked target.** Follow redirects manually (or `redirect: 'manual'`)
  and re-run the guard on each hop.
- Return a structured result/throw that the executors translate into a calm first-person
  string. The guard itself may throw; the *executors* never let it reach the chat path.

### 4b. `searchWeb(query, settings)`

- GET `${webSearchBaseUrl}/search?q=…&format=json` with a timeout.
- Defensive parse: `data?.results` may be absent on a SearXNG error body — guard it, don't
  assume `.slice` is safe.
- Map the top `webSearchMaxResults` rows to `{ title, url, content }`. Confirm every row
  carries a `url` — that's the operability contract that makes `read_webpage` reachable.

### 4c. `readWebpage(url, settings)`

- `guardedFetch(url)` → raw HTML.
- `linkedom` → parse to a `document` → `Readability(...).parse()` → article HTML.
- `turndown` → markdown.
- Truncate to `webSearchMaxChars` with a visible `[…truncated]` marker.
- **Stamp provenance.** Prepend a `Source: <url> · retrieved <ISO date>` line to the returned
  content. This is what makes gist persistence (Pillar E) work — when the Familiar keeps what it
  read, the URL and date travel with it.
- **Frame the return as untrusted.** Wrap the markdown so the model reads it as *external
  content I fetched*, not as instructions addressed to it — a short delimiter/header to blunt
  prompt-injection from page bodies.

### 4d. Dependencies

Add to `package.json` `dependencies`: `linkedom`, `@mozilla/readability`, `turndown`. All three
are light: `@mozilla/readability` and `turndown` carry near-zero transitive trees, and
`linkedom` is a deliberate choice over `jsdom` to keep the runtime close to its two-dependency
ideal — `jsdom` is a near-complete browser DOM that drags in dozens of transitive packages.
`linkedom` provides Readability with the `document` it needs at a fraction of the install
weight; the trade is slightly lower fidelity on malformed pages.

**If testing shows `linkedom` mangles real articles, `jsdom` is the documented fallback** —
swap the one parse line in `readWebpage`; nothing else changes. Note the swap (and why) in the
commit body if it happens.

`import` all three at **module top** of `websearch.js` (the reviewed snippet put imports inside
the executor object literal — a syntax error; do not reproduce it).

---

## 5. Pillar D — wiring into `cerebellum.js`

Thin. The definitions and delegating executors only.

1. **`BUILTIN_TOOLS`** — two entries, descriptions in the Familiar's first-person voice, macros
   as literal tokens:
   - `web_search` — *"I reach for this when my human needs something current that my own memory
     doesn't hold — it gives me back a handful of titles, snippets, and links I can then read."*
   - `read_webpage` — *"I read a page I found while searching, pulled down to clean markdown so
     I can actually take it in. I pass the exact URL a search handed me. What I read stays with
     me for the rest of this conversation anyway — but when something is worth keeping past it, I
     save the gist to a tome so it's still mine in the next session."*
   - Keep parameter schemas as in the proposal (`query` / `url`, both required).
2. **`TOOL_EXECUTORS`** — two `(args, ctx)` entries that `await` into `websearch.js` and return
   a string. They `try/catch` and return a calm first-person failure (the no-throw contract).
   They contain **no** fetch/parse logic of their own.
3. Macro substitution on the result is already applied once at the `executeToolCall` boundary —
   executors don't repeat it.
4. **Toggle-gated advertisement.** Where the active tool list is composed, drop the two web
   tools when `webSearchEnabled` is false or the env off-switch is set.

---

## 6. Pillar E — keeping what's worth keeping (gist persistence)

**First, what does NOT need solving.** A `read_webpage` result already persists in the live
session: the tool round is pushed into `state.messages` (`public/app.js` — both the streaming
and non-streaming paths), saved to `localStorage`, and re-sent on every subsequent turn
(`state.messages.map(toApiMessage)`). So for the rest of the session the page content is fully
re-accessible **without re-fetching**, and it sits as a stable prefix the provider can
prompt-cache. *Within-session recall is free; do not build anything for it.*

The cost that buys: each read sits in history at up to `webSearchMaxChars` and is re-sent every
turn for the remainder of the session. In practice this is noise, not a problem to engineer
against — the supported models carry 200k+ token windows, and the existing ~3h-idle session
rotation (`SESSION_IDLE_MS`, `public/app.js` → `autoEndSession`/`startNewSession`) already
bounds how much any one session can accumulate. So `webSearchMaxChars` is a sensible per-read
bound, not a defence against runaway growth; **no trimming logic in this milestone.** General
long-session context handling is a separate, future concern and explicitly out of scope here.

**What Pillar E is actually for: crossing the session boundary.** Session history is
per-session — the next conversation starts fresh, and only Phylactery/tomes carry over. The
memorization loop already auto-summarizes ended sessions, but lossily. Pillar E is the Familiar
*deliberately* keeping a provenance-stamped gist so a specific thing it read survives into
future sessions intact — distinct from, and better than, the automatic summary.

The robust shape here is **reuse, not a new mechanism**:

1. **No new storage tool.** Knowledge already has a home — `save_to_tome` (and `save_memory`
   for the more personal kind). Adding a `web_remember` tool would duplicate that logic and
   split where web-derived knowledge lives. The Familiar keeps a gist with the tools it already
   has. *(This is the no-copy-paste / one-home-for-state rule.)*

2. **No new LLM call.** By the time the Familiar decides to keep something, the page content is
   already in its context — from `read_webpage` this turn, or from session history on a later
   turn. Deciding to save and calling `save_to_tome` rides a turn that's already happening —
   Pillar E adds **zero** request volume.

3. **Provenance makes a cross-session recall trustworthy.** Because `readWebpage` stamps
   `Source: <url> · retrieved <date>` onto its return (Pillar C, 4c), whatever the Familiar
   saves carries the URL and the date it was read. A future-session tome scan surfaces the saved
   gist with its source, so the Familiar can answer directly — or, seeing the retrieval date is
   old, choose to re-read for freshness. The provenance is what turns a saved blob into
   something it can reason about in a session that no longer holds the original page.

4. **Saving is the Familiar's judgement, not automatic.** Auto-saving every page read would
   bloat memory with things that didn't matter, and *what's worth keeping* is interpretation,
   not a crisp code-side tag — so it stays the Familiar's call, nudged by the `read_webpage`
   description (Pillar D). The consent-gating that already governs long-term memory applies
   unchanged; web-derived facts are not a special exception to it.

**Reachability check (both halves):** discoverability — the `read_webpage` first-person
description tells the Familiar it can keep the gist; operability — every input `save_to_tome`
needs (title, content, keywords) is already in hand from the page it just read, and the source
URL rides in on the stamped return. Nothing new is required to make this usable.

---

## 7. Safety gates (read before shipping)

- **SSRF guard + timeout are blocking.** No path reaches a network read without them. This is
  the single most important line in the spec.
- **Untrusted-content framing is blocking.** Search snippets and page markdown are external
  data; they must not be presented to the model as trusted instruction.
- **These tools are not on the safety-critical care surface** (crisis-signals, threat-tracker,
  silence-triage, cerebellum triage prompt). They add a capability; they don't change *when or
  whether* the Familiar acts on a human's safety. So they do **not** need the human-sign-off
  gate that those files carry — but if a future change wires web content *into* threat scoring
  or triage, that crosses into safety-critical and the sign-off rule applies.

---

## 8. Open knobs (decide before build)

1. **DOM library.** **Decided: `linkedom`** — light, keeps the runtime near its two-dep ideal;
   `jsdom` is the documented fallback if testing shows mangled extraction (Pillar C, 4d).
2. **Default `webSearchMaxChars`.** **Decided: 15000** (~4–5k tokens/read). This is a
   *per-read* context cost paid each time `read_webpage` runs — there is no page cache, so
   "read once then it's free" does not apply unless the Familiar deliberately persists what it
   read (see Future enhancements).
3. **Settings UI placement.** New "Web search" group in the sidebar Tools section vs. a
   dedicated Settings panel.

---

## 9. Acceptance criteria

- [ ] `web_search` against a live local SearXNG returns ≤ `webSearchMaxResults` rows, each with
      a usable URL, as a compact string.
- [ ] `read_webpage` on a real article returns clean truncated markdown, framed as untrusted,
      with a `Source: <url> · retrieved <date>` provenance line.
- [ ] A `read_webpage` result persists in session history and is re-accessible on later turns
      without re-fetching (no special work — verify the tool round lands in `state.messages`).
- [ ] After a `read_webpage`, the Familiar can keep the gist via `save_to_tome` (no new tool,
      no extra LLM call) and the saved entry carries the source URL; a *next-session* recall
      surfaces it.
- [ ] `read_webpage` on `http://127.0.0.1:8742/…`, `http://169.254.169.254/…`, `file:///…`,
      and a public URL that **redirects** to a private one are all refused by the guard, and the
      refusal renders as a calm first-person string — never a thrown 500.
- [ ] A hung host returns the timeout failure within the configured window; the rest of the
      tool round completes.
- [ ] SearXNG down → calm "I couldn't reach my search right now," no chat-path error.
- [ ] `webSearchEnabled=false` (or `PROTO_FAMILIAR_WEBSEARCH_DISABLED=1`) → neither tool is
      advertised to the model.
- [ ] Tool descriptions are first person; no second-person or imperative phrasing.
- [ ] `package.json` at `0.7.0-alpha`; `docs/architecture.md`, `docs/tool-calling.md`,
      `docs/features.md` updated (tool count + tables) in the same commit.
- [ ] Tests cover the SSRF guard (allow/deny matrix), the timeout, and the toggle-gated
      advertisement, in `tests/`.

---

## 10. File-by-file change list

| File | Change |
|---|---|
| `websearch.js` *(new)* | `guardedFetch`, `searchWeb`, `readWebpage` (incl. provenance stamp); all extraction logic; top-of-file imports. |
| `cerebellum.js` | Two `BUILTIN_TOOLS` entries (first-person; `read_webpage` nudges gist-keeping); two delegating `TOOL_EXECUTORS` entries; toggle-gated advertisement. No new save tool — gist persistence reuses `save_to_tome`. |
| `package.json` | Add `linkedom`, `@mozilla/readability`, `turndown`; bump `version` → `0.7.0-alpha`. |
| `public/app.js` | Settings fields + UI; add user-pref keys to `SERVER_SYNCED_KEYS`. |
| `settings.json` handling | Read the four new fields with defaults; honour the env off-switch. |
| `docs/architecture.md` | Record `websearch.js` and the two tools in the component map + data flow. |
| `docs/tool-calling.md` | Bump the tool count; add `web_search` / `read_webpage` table rows. |
| `docs/features.md` | Note the new capability. |
| `docs/websearch-setup.md` *(new, or section in getting-started)* | SearXNG `docker run` + `settings.yml` (`formats` **and** `secret_key`). |
| `tests/websearch.test.mjs` *(new)* | SSRF allow/deny matrix, timeout, toggle gating. |
