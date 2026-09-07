---
title: "Tomes And Keyword Lore"
topics: [architecture, tomes]
sources:
  - id: tome-lore-js
    type: file
    path: src/tomes/tome-lore.js
  - id: tome-store-js
    type: file
    path: src/tomes/tome-store.js
  - id: tome-macros-js
    type: file
    path: src/tomes/tome-macros.js
  - id: manual-tome-js
    type: file
    path: src/tomes/manual-tome.js
  - id: discord-gateway-js
    type: file
    path: src/discord/discord-gateway.js
  - id: app-js
    type: file
    path: public/app.js
  - id: server-js
    type: file
    path: server.js
  - id: tomes-doc
    type: file
    path: docs/tomes.md
  - id: engineering-conventions
    type: file
    path: almanac/reference/engineering-conventions.md
---

# Tomes And Keyword Lore

A Tome is a SillyTavern-style keyword lorebook: a JSON file of entries, each with trigger
keys, that gets scanned against recent chat and injected into the prompt only when its keys
appear [@tomes-doc]. Tomes are one of two long-running memory surfaces in Proto-Familiar — the
other is [Phylactery](phylactery)'s autonomously-retrieved canonical memory — and the two are
kept deliberately separate: a Tome entry fires because a keyword matched, not because the
Familiar decided the fact was relevant [@tomes-doc]. [Session memorization](session-memorization)
is the automated writer that populates one particular Tome (`Session Memories`) with this
shape of entry; this page covers the activation engine and entry format that every Tome, hand-authored
or auto-written, is scanned and injected through, plus the two features built directly on top
of it: live tome macros and the self-documenting Familiar Manual tome (0.11.22-alpha).

## Storage and the activation engine

Tomes live as individual JSON files under `tomes/` (git-ignored), one file per Tome, each
independently enabled or disabled and manageable through the Tomes modal [@tomes-doc]. An entry
activates when one of its **primary keys** — a case-insensitive substring or a `/regex/flags`
pattern — matches somewhere in the scan corpus: the most recent N user/assistant messages plus
the new input, where N is the ward-configurable **keyword scan depth** (`tomeScanDepth`,
default 4) [@tomes-doc] [@app-js]. Matched entries are folded into five injection slots keyed by
SillyTavern's position codes — `sys_top`, `before_char`, `after_char`, `sys_bottom`, `at_depth`
— plus support for secondary/selective keys, constant entries, probability, groups, recursion,
and per-entry scan-depth/case/whole-word overrides [@tome-lore-js].

This engine originally existed only in the browser, as `public/app.js`'s
`activateTomeEntries` running over `state.tomeCache` — the client's in-memory copy of every
enabled Tome, populated by `GET`ing each Tome file and never persisted itself [@app-js]. That
made a server-side turn (Discord, voice) blind to the ward's own lore: a keyword typed in a
Discord DM never triggered anything, because nothing on the server side ever scanned for it
[@discord-gateway-js]. `tome-lore.js` closes that gap with a faithful, pure Node port —
`normalizeEntry`, `matchKeyword`, `parseKeywordRegex`, and the scan/group/recursion functions
mirror `app.js`'s algorithm one-for-one, and every input (entries, messages, scan settings,
timed-effects state, rng) is injected rather than read from ambient state, so a Discord turn, a
voice turn, or a test can all drive it the same way [@tome-lore-js]. `tome-store.js`'s
`readAllTomes(tomesDir)` gives the server side its own read of the same files the client
loads into `tomeCache`: it filters out dotfile bookkeeping (`.consent-pending.json`,
`.memorization-queue.json`) via `isTomeFile`, and skips a corrupt tome file rather than
throwing, because a bad lore file must never break a chat turn [@tome-store-js].

**Parity between the two engines is hand-maintained, not shared.** `public/app.js` is a
classic browser script with no ES modules, so it cannot import `tome-lore.js`; the comment at
the top of both files calls this out explicitly and says to change the matching logic in one
only if the same change is made in the other [@tome-lore-js] [@app-js]. Tests pin the shared
behavior, but there is no build step that would catch a silent drift the way a shared import
would. `discord-gateway.js`'s `activeDiscordLore()` is the server call site: it reads every
tome from disk, calls `activateLore()` with the settings' scan options and a `turnCount` derived
from the session's prior messages (since `delay` needs a turn count and Discord has no client
state to track it), and wraps the whole thing in a try/catch that logs and returns empty slots
on any failure — a bad tome degrades to no lore, never a broken turn [@discord-gateway-js]. The
feature has its own off-switch, `PROTO_FAMILIAR_DISCORD_TOMES_DISABLED=1`, independent of the
main Discord disable flag [@discord-gateway-js]. As of this port (0.11.21-alpha), timed effects
(`sticky`/`cooldown`) are not yet persisted across separate Discord turns — a documented v1
limitation — while `delay` works because it is driven by the turn count computed fresh each
call [@discord-gateway-js].

## Live tome macros: a fourth, deliberate macro boundary

[Engineering conventions](../reference/engineering-conventions) enumerates the three
server-side call sites where `macros.js`'s `substituteMacros` resolves `{{user}}`/`{{char}}` —
LLM prompts, tool results, and tool descriptions — specifically so a fourth is never added ad
hoc [@engineering-conventions]. Tome content is a deliberate exception to that closed list,
introduced in 0.11.22-alpha for a reason the other three boundaries do not share: a lorebook
entry can describe live, ward-facing state ("Vision is currently turned {{visionActive}}."),
and that description is only true if it is resolved at the moment the entry is injected, not
once at authoring time [@tome-macros-js].

`tome-macros.js`'s `resolveTomeMacros(text, settings)` is the server-side resolver. It first
calls `substituteMacros` for `{{user}}`/`{{char}}`, then walks its own `TOME_MACROS` table:
eight boolean **toggle macros** (`visionActive`, `voiceActive`, `discordActive`,
`ponderingActive`, `warmthActive`, `noticingActive`, `calendarActive`, `browserActive`), each
read from the ward-facing setting and rendered as the literal string `on`/`off`, plus four
**value macros** (`charName`, `userName`, `activeModel`, `scanDepth`) [@tome-macros-js]. Toggle
macros deliberately read the setting the ward can flip in the UI, not the deployment-level
`PROTO_FAMILIAR_*_DISABLED` environment off-switches — the browser cannot see an environment
variable, so reading the setting is what keeps the web and Discord copies of a tome entry
in agreement [@tome-macros-js]. An unresolved `{{token}}` outside this table is left untouched,
and a macro function that throws yields an empty string rather than propagating the error
[@tome-macros-js]. `tome-lore.js`'s `foldLoreForPrompt(activated, resolve)` takes this resolver
as an injected function rather than importing it directly, which keeps the activation engine
itself free of any settings-shaped dependency; `discord-gateway.js` passes
`(t) => resolveTomeMacros(t, settings)` as that resolver at its one call site
[@discord-gateway-js].

The browser side cannot import `tome-macros.js` for the same classic-script reason it cannot
import `tome-lore.js`, so `public/app.js`'s `applyNameVars` mirrors the same macro names by
hand — a comment at the mirror site calls out the parity requirement explicitly, and a test
pins the shared name set between the two [@app-js] [@tome-macros-js]. A future macro added to
`TOME_MACROS` needs the matching branch added to `applyNameVars` in the same change, or a tome
entry will render correctly on one surface and show a literal `{{token}}` on the other.

## The Familiar Manual: a self-documenting, protected tome

`manual-tome.js` ships a built-in Tome, the **Familiar Manual**, whose fourteen entries explain
a feature and where its setting lives, each keyed to how a ward would actually ask ("send you
pictures", "how do I use you") rather than to the feature's internal name [@manual-tome-js].
Every entry quotes at least one live toggle or value macro, so the manual's answer reflects
whatever is actually switched on right now instead of a frozen doc — the whole reason the macro
boundary above exists [@manual-tome-js].

The manual tome is seeded once, not managed like an ordinary Tome. `ensureManualTome(TOMES_DIR)`
runs at server boot (best-effort, wired into `server.js`) and checks a flag file,
`.manual-tome-seeded.json`, before writing anything: if the flag exists, it does nothing, so a
ward who has deleted or edited the manual is never overridden by a later boot
[@manual-tome-js] [@server-js]. The write itself is atomic — the tome is written to a `.tmp`
file and renamed into place — and the whole function never throws, because a seeding failure
must not block server startup [@manual-tome-js]. The shipped tome carries `enabled: true` and
`graduationExempt: true`: it is on by default, and the `graduationExempt` flag protects it from
`tome-graduation-loop.js` (see [Autonomous loops](autonomous-loops)), the opt-in background job
that promotes Tome facts into Phylactery — the manual is reference material the Familiar reads
and relays, not a fact about the ward that should ever be graduated into canonical memory
[@manual-tome-js].

## Where this fits

- [Session memorization](session-memorization) — the automated writer that populates the
  `Session Memories` tome using this same activation engine and entry format.
- [Phylactery](phylactery) — the canonical, autonomously-retrieved memory store that Tomes
  (keyword-triggered, not relevance-triggered) are deliberately kept separate from.
- [Autonomous loops](autonomous-loops) — `tome-graduation-loop.js`, the opt-in loop that
  promotes ordinary Tome facts into Phylactery, and which `graduationExempt` opts the manual
  tome out of.
- [Content-based memory gating](content-gating) — the per-topic sensitivity tag that
  memorization-written Tome entries carry, layered on top of the plain keyword match this page
  describes.
- [Ward Discord console](ward-console) — the `!queue`/`!connection` menus that sit alongside
  the Discord tome-lore path described above in the same gateway module.
- [Tome multi-writer merge policy](../decisions/tome-multi-writer-merge-policy) — a proposed,
  not-yet-built reconciliation design for a Tome written by more than one source; today's single
  automated writer (memorization) plus manual ward edits is the simpler model that shipped.
- [Engineering conventions](../reference/engineering-conventions) — the macro-substitution
  boundary list that tome content is a deliberate, named exception to.
