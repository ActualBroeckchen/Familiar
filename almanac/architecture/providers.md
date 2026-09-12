---
title: Providers and Connection Readiness
topics: [architecture, connections]
sources:
  - id: providers-js
    type: file
    path: providers.js
  - id: docs-architecture
    type: file
    path: docs/architecture.md
  - id: cerebellum-js
    type: file
    path: cerebellum.js
  - id: llm-call-js
    type: file
    path: llm-call.js
  - id: server-js
    type: file
    path: server.js
  - id: discord-gateway-js
    type: file
    path: src/discord/discord-gateway.js
  - id: thalamus-js
    type: file
    path: thalamus.js
  - id: app-js
    type: file
    path: public/app.js
  - id: vision-js
    type: file
    path: src/vision/vision.js
  - id: media-retention-js
    type: file
    path: src/vision/media-retention.js
  - id: pondering-js
    type: file
    path: src/pondering/pondering.js
  - id: providers-test
    type: file
    path: tests/providers.test.mjs
  - id: readiness-commit
    type: commit
    ref: "5291688"
    note: "feat: local + custom OpenAI-compatible providers, key optional (0.11.91-alpha) — the commit that introduced providers.js's resolveProviderUrl/connectionReady/authHeader and threaded them through every LLM call site."
---

# Providers and Connection Readiness

`providers.js` is the one module every LLM call site in Proto-Familiar goes through to turn a
saved **connection** (provider tag, model, optional API key, optional base URL) into an actual
request: which URL to POST to, whether the request needs an `Authorization` header, and whether
the connection is usable at all [@providers-js]. Before 0.11.91-alpha, "is this connection
usable?" was answered separately at each call site with some variant of `conn.apiKey &&
conn.model`, which silently rejected any connection that legitimately has no key — a local
server on the ward's own machine. Centralising the three questions (URL, key requirement,
readiness) in one module means the whole call graph agrees on the answer, and a keyless local
model became a first-class connection everywhere at once instead of one call site at a time
[@docs-architecture] [@readiness-commit].

## The provider catalog: cloud presets, and keyless local/custom

`PROVIDER_URLS` is a static map from a provider tag to its full `chat/completions` endpoint,
covering the cloud presets for the popular OpenAI-compatible chat sources SillyTavern lists —
OpenAI, OpenRouter, DeepSeek, Groq, Mistral, Together AI, NanoGPT, Google AI Studio (Gemini, via
its OpenAI-compatible surface), and z.ai's two GLM endpoints [@providers-js]. Chat sources that
are *not* OpenAI-compatible — Anthropic's native API, Vertex, Bedrock — are deliberately out of
scope: each would need its own request adapter, not another entry in this URL map
[@readiness-commit].

Three provider tags resolve their URL from the connection's own `baseUrl` instead of the static
map, tracked in `BASE_URL_PROVIDERS` — `custom` (paste any OpenAI-compatible endpoint: llama.cpp,
KoboldCpp, TabbyAPI, oobabooga, vLLM, a self-hosted gateway, or any cloud not otherwise listed),
and the two local presets `ollama` (default `localhost:11434`) and `lmstudio` (default
`localhost:1234`) [@providers-js]. The same three tags are also the members of
`PROVIDER_KEYLESS`: `providerRequiresKey(provider)` is `false` for exactly these three, because
local servers and arbitrary custom endpoints commonly need no API key at all
[@providers-js].

## Resolving the endpoint: `normalizeBaseUrl` and `resolveProviderUrl`

`normalizeBaseUrl(base)` turns whatever the ward typed into a full endpoint: a bare host
(`http://localhost:11434`) gets `/v1/chat/completions` appended, a versioned base (`…/v1`) gets
`/chat/completions` appended, and a string that already ends in `/chat/completions` passes
through unchanged [@providers-js]. This is the exact-values rule (see
[Exact values are code's job](../decisions/exact-values-in-code)) applied to a URL specifically:
the ward types a base URL once, and code — never the model — canonicalises it into the shape the
fetch call needs. `resolveProviderUrl(conn)` is the single entry point that decides which source
wins: a base-URL provider with a `baseUrl` set uses `normalizeBaseUrl` on it, everything else
looks up `PROVIDER_URLS[conn.provider]`, and an unresolvable connection (most commonly `custom`
with no `baseUrl` yet) returns `null` rather than a broken string [@providers-js].

## The single readiness gate: `connectionReady`

`connectionReady(conn)` answers one question — is this connection usable right now? — by
requiring a non-empty `model`, plus a non-empty `apiKey` only when `providerRequiresKey` says the
provider needs one [@providers-js]. It replaced the scattered `conn.apiKey && conn.model` checks
that every call site used to write for itself, each of which rejected a keyless local connection
identically and independently.

`connectionReady` deliberately does **not** check whether the URL actually resolves. The old
per-call-site gates never checked that either, and every call site already resolves the URL
itself and guards on `resolveProviderUrl` returning a falsy value, so a misconfigured `custom`
connection with no `baseUrl` degrades exactly where it always did — at the URL-resolution step,
not inside the readiness check [@providers-js]. `tests/providers.test.mjs` pins this directly:
`connectionReady({ provider: 'custom', model: 'm' })` (no `baseUrl` at all) is asserted `true`,
"keyless custom passes the key/model gate," specifically so the readiness check stays decoupled
from URL-resolvability [@providers-test]. Keeping the two checks separate — "is this connection
configured enough to try" versus "does this connection's URL actually resolve" — means a
provider-less or otherwise minimal connection object (as a test fixture, or an old settings entry
predating a field) still gets a readiness answer instead of being rejected for an unrelated
reason.

## `authHeader`: no header beats a broken one

`authHeader(apiKey)` returns `{ Authorization: 'Bearer ' + key }` when a key is present and `{}`
otherwise — never a header with an empty or malformed Bearer value [@providers-js]. This matters
specifically for local servers: several reject a request carrying a blank or garbage
`Authorization` header with a 400, where the same request with no `Authorization` header at all
succeeds. Sending no header for a keyless connection is therefore not a simplification, it is the
difference between the request working and failing on some local backends.

## Threaded through every LLM call site

`resolveProviderUrl`, `connectionReady`, `providerRequiresKey`, and `authHeader` are imported
directly by the chat proxy and its tool loop (`server.js`), `callProviderChat` (`llm-call.js`,
the shared call used by the autonomous background loops), `callChatRaw` and the Discord revisit
path (`discord-gateway.js`), the silence-triage deliberation and `connectionForFeature`
(`cerebellum.js`), the warm reach-out composer (`reachout.js`), tome graduation
(`tome-graduation-loop.js`), the content-regate loop (`content-regate-loop.js`), all three voice
call paths (`voice-chat-turn.js`, `voice-call-server.js`, `voice-discord-server.js`), the
memorization worker (`memorization.js`), the pondering loop (`pondering.js`, covering
`ponder-research.js` too) [@pondering-js], and the Phylactery environment builder in
`thalamus.js`, which resolves a connection into
`PHYLACTERY_LLM_BASE_URL`/`PHYLACTERY_LLM_API_KEY` for the Python child process
[@providers-js] [@server-js] [@llm-call-js] [@discord-gateway-js] [@cerebellum-js]
[@thalamus-js]. Vision's `describeAsset` and media-retention's judgment call
(`media-retention.js`) reach `providers.js` indirectly, through `callProviderChat`, rather than
importing it themselves [@vision-js] [@media-retention-js] — one more reason every LLM request
should ride `callProviderChat` in the first place (see
[Engineering conventions](../reference/engineering-conventions), RULE A).

On the settings side, `public/app.js` (a classic script, not an ES module, so it cannot import
`providers.js`) hand-maintains its own copies of `BASE_URL_PROVIDERS` and the keyless provider
set, plus `connUsable(c)`, a client mirror of `connectionReady` [@app-js]. The mirror is not
byte-identical: `connUsable` additionally requires a non-empty `baseUrl` for `custom` connections
specifically (`providerNeedsBaseUrl`), which `connectionReady` itself does not check
[@app-js]. That asymmetry is intentional, not drift — the UI wants to stop the ward from saving a
`custom` connection that cannot possibly resolve, while the server-side gate deliberately leaves
URL-resolvability to the call site (see above). A future change to either side's readiness logic
should preserve that difference rather than "fixing" it into parity.

## Safety implication: triage can run on a keyless local model

`cerebellum.decideTriageViaLLM` — the silence-triage deliberation that decides whether the
Familiar reaches out during an elevated-threat silence, see [Safety spine](safety-spine) — now
gates on `connectionReady` and resolves its endpoint through `resolveProviderUrl`, the same as
every other call site [@cerebellum-js]. The practical effect is that the caring spine can run
entirely on a keyless local model; nothing about tier gates, cool-downs, escalation deadlines, or
the `wait` default changed. Because triage sits inside the set of files CLAUDE.md requires
explicit human sign-off to change behaviorally (see
[Engineering conventions](../reference/engineering-conventions), "Safety-critical sign-off"),
this specific change — which connections triage is willing to run on — was called out explicitly
as a ward sign-off item in the commit that shipped it, rather than folded silently into the rest
of the provider work [@readiness-commit].

## Related

- [Per-feature model routing](../decisions/per-feature-model-routing) — how a saved connection
  gets bound to a specific background job in the first place; this page covers what happens once
  a call site has that connection in hand.
- [Ward Discord console](ward-console) — the `!connection` menu that edits `primaryConnectionId`,
  per-feature routing, and `reasoningEffort`, all read back through `providers.js` at call time.
- [Safety spine](safety-spine) — the triage deliberation this page's readiness gate now covers.
- [Exact values are code's job](../decisions/exact-values-in-code) — the general rule
  `normalizeBaseUrl` applies to a ward-typed base URL.
- [Engineering conventions](../reference/engineering-conventions) — RULE A (every LLM call site
  goes through `callProviderChat` or replicates its guarantees) and the safety-critical sign-off
  rule this page's triage change was flagged under.
