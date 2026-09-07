---
title: Ward Discord Console
topics: [architecture, memorization]
sources:
  - id: ward-connections-js
    type: file
    path: src/ward/ward-connections.js
  - id: ward-consent-queue-js
    type: file
    path: src/ward/ward-consent-queue.js
  - id: discord-menu-kit-js
    type: file
    path: src/discord/discord-menu-kit.js
  - id: discord-gateway-js
    type: file
    path: src/discord/discord-gateway.js
  - id: providers-js
    type: file
    path: providers.js
---

# Ward Discord Console

The ward Discord console is a pair of ward-only slash-style commands —
`!queue` and `!connection` (aliases `!conn`/`!model`) — that expose settings
the ward would otherwise have to open the web app to change: which pending
memories to keep or drop, which saved connection is active, how each
background feature is routed, and how hard each connection's model reasons
before it answers. They are the ward-facing twins of the villager `!consent` menu that
`discord-gateway.js` already exposes to registered villagers (see
[Architecture](../architecture) for the Village cluster `!consent` belongs
to): same
component-menu idiom, same discipline of pure builder functions plus
gateway-owned I/O, and no LLM call in the loop, because a consent decision or
a routing choice has to be exact rather than judged [@ward-connections-js]
[@ward-consent-queue-js].

## A shared menu kit, not three copies

`discord-menu-kit.js` factors out the primitives every Discord menu in this
codebase needs — `EMBED_COLOR`, a `btn()` button builder, a `row()` action-row
wrapper, and an `expiredView()` for a stale control — so the villager consent
menu and both ward console menus speak one component idiom instead of each
module carrying its own copy [@discord-menu-kit-js]. `villager-consent.js` was
refactored to import from this shared kit when the ward console shipped
(behavior unchanged); `ward-connections.js` and `ward-consent-queue.js` are
new modules built on it from the start.

## `!queue`: the pending memory-consent queue

[Session memorization](session-memorization) surfaces a `[PENDING MEMORY
CONSENT]` block for facts the Familiar heard but has not kept — things said in
a shared room, or about a third party's private life — held in
`.consent-pending.json` until the ward says keep or drop. `!queue` is that
same queue as a paginated Discord menu: a page of items (six per page) with a
picker to review one in full, per-item Keep it/Drop it buttons, and Keep
all/Drop all for the whole page [@ward-consent-queue-js]. Settling an item
calls the same `confirmConsentMemories`/`dropPendingMemories` entry points the
web UI uses, then prunes the settled ids out of the queue file via
`pruneConsentPending` — the Discord and web surfaces read and write one file,
so an item settled from either side disappears from both
[@ward-consent-queue-js].

## `!connection`/`!conn`/`!model`: active connection and per-feature routing

The web Connections modal lets the ward pick the primary connection chat runs
on and, separately, route individual background jobs to a different saved
connection — see [Per-feature model routing](../decisions/per-feature-model-routing)
for why that split exists. `!connection` opens the same two controls from
Discord: a dropdown to set the active `primaryConnectionId`, and a
"Per-feature routing →" submenu built from `FEATURE_CONNECTIONS`, a fixed list
of six background jobs (pondering, memorization, triage, reachout, tome
graduation, vision) that deliberately mirrors `FEATURE_CONNECTIONS` in
`public/app.js` key-for-key [@ward-connections-js]. A test guards the two
lists against drifting apart, since nothing else enforces that a key added to
one is added to the other.

### Reasoning effort

A second submenu, "Reasoning effort →", sets a per-connection `reasoningEffort`
field (`low`/`high`/`max`/`off`, or cleared back to a `__default__` sentinel).
The field exists because GLM-5.3 made chain-of-thought reasoning mandatory
with no way to disable it: left unset, the model spent its entire token
budget reasoning, returned empty content, and the reasoning-content fallback
surfaced the raw chain-of-thought as the reply. `providers.js`'s
`resolveReasoningEffort(conn)` sends an explicit `low`/`high`/`max` verbatim
for any provider (the ward's call), never sends anything for `off`/`none`, and
otherwise defaults unset connections to `low` only for the z.ai GLM family —
never for other providers, so an unset default can never trigger an
unknown-parameter 400 on a provider that does not recognize the field
[@providers-js]. The Discord submenu is the only place this field is exposed;
setting it rewrites the target connection's entry in the whole `connections`
array, because `mergeSettings`'s wholesale top-level replace means a partial
write cannot patch one array element in place [@ward-connections-js].

## Invariants

Two enforcement points keep this console ward-only and safe against a torn
settings file:

- **Ward-DM-only interception, re-checked per click.** `discord-gateway.js`
  intercepts `!queue` and `!connection` before any chat turn, and only when
  the message is both from the ward and in the ward's own DM — never in a
  shared room, since these commands render personal data and settings
  [@discord-gateway-js]. A villager typing either string falls through to
  normal chat handling; it means nothing to them. Because a component
  `custom_id` carries only the action (`pfqueue:set:<id>:keep`,
  `pfconn:effset:<connId>`) and never identity, `interactionIsWard()`
  re-reads `discordWardUserId` from settings and re-checks the clicking
  user on *every* interaction, not just the opening command — a forwarded or
  aged menu message can never be clicked into acting as the ward
  [@discord-gateway-js].
- **One locked, atomic write path.** Every console mutation goes through
  `patchWardSettings()`, which takes the same file lock, reads-merges-writes
  through `mergeSettings`, and does an atomic rename-into-place that
  `PUT /api/settings` uses for the web app's own settings writes — so a
  Discord change and a web change racing each other cannot tear
  `settings.json` [@discord-gateway-js].

## Related

- [Session memorization](session-memorization) — the consent-pending queue
  `!queue` settles, and the file both surfaces share.
- [Per-feature model routing](../decisions/per-feature-model-routing) — the
  connection and per-feature routing model `!connection` exposes from
  Discord.
