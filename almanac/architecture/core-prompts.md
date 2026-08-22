---
title: Core Prompts and Multi-Surface Assembly
topics: [architecture]
sources:
  - id: core-prompts-js
    type: file
    path: core-prompts.js
  - id: prompt-capture-js
    type: file
    path: prompt-capture.js
  - id: architecture-doc
    type: file
    path: docs/architecture.md
  - id: app-js
    type: file
    path: public/app.js
  - id: discord-gateway-js
    type: file
    path: discord-gateway.js
---

# Core Prompts and Multi-Surface Assembly

**Status: implemented v0.11.0-alpha (PR #274).** The ward's four core prompts — System Prompt, Character Profile, User (Human) Profile, and Post-History Prompt — define who the Familiar is and who their human is. They are the standing instructions that must be present on every surface. Prior to v0.11.0-alpha, they were assembled only by the browser and invisible to server-initiated surfaces (Discord, voice, background loops), causing the Familiar to answer those surfaces with no configured identity. This page documents the bug, the fix, and the lesson for any future cross-surface capability.

## The Four Core Prompts

The four core prompts are ward-authored configuration fields, not the identity block stored in [Phylactery](phylactery) [@core-prompts-js]:

1. **System Prompt** — the standing instruction for how the Familiar should behave
2. **Character Profile** — who the Familiar is (their personality, voice, values)
3. **User (Human) Profile** — who their bonded human is
4. **Post-History Prompt** — the standing instruction that rides *after* the conversation (often used to gate certain behaviors or set priorities that only matter once the context is clear)

These are separate from the `enriched.static` block (the Phylactery identity layer: base instructions, self, ward, relationship, and custom files). That layer covers *what the system knows*; the core prompts are *how the Familiar should behave* — they are personality and stance, authored by the ward in settings [@core-prompts-js].

## The Bug: Client-Side Assembly Only

Before v0.11.0-alpha, these four prompts were assembled solely in the browser. The web client's `_buildApiMessagesInner` function in `public/app.js` constructed them and POSTed them inside the messages array [@app-js]. This worked fine for web chat, but every server-initiated turn — Discord text via `handleTurn + revisit`, voice calls via `voice-chat-turn.js → /api/chat` — used a bare messages array with no browser to assemble them [@core-prompts-js]. The Familiar answered Discord and voice with none of its configured identity. The reported symptom was: "my Familiar doesn't see the user prompt at all on Discord."

The bug was architectural, not a typo. There was one path that assembled the prompts, and it lived in the browser. Server surfaces had no mirror.

## The Fix: Server-Side Assembly Path

Three changes restored the four prompts to all surfaces [@core-prompts-js]:

**`core-prompts.js`** is the ONE server-side assembly mirror. It exports three functions [@core-prompts-js]:

- `coreSystemSegment(settings)` — builds the three system-level prompts (System Prompt, Character Profile, User Profile) in the same order, with the same headers (`[Character Profile]` and `[Human Profile]`), and the same separator (`---`) the web client uses. It resolves `{{user}}/{{char}}` macros the same way `applyNameVars` does on the client, so a configured name appears in place of a literal token. It returns a string, or an empty string when no prompts are configured (so `.filter(Boolean)` drops it cleanly).
- `postHistoryMessage(settings)` — builds the post-history prompt as its own message (role is ward-configurable, defaults to 'system'). Returns a complete message object `{role, content}`, or null when unconfigured.
- `withCorePrompts(messages, settings)` — folds the core prompts into a bare messages array: the core system segment LEADS (prepended before the conversation), and the post-history message TRAILS (appended after). This is the function called by the `/api/chat` endpoint when `injectCorePrompts` is set [@core-prompts-js].

**`/api/chat` gained the `injectCorePrompts` flag** [@architecture-doc]. When set (voice sets it; the web client still builds prompts itself so they don't double), the endpoint calls `withCorePrompts` to inject them before sending to the model. The order matters: core segment leads, so a static prepend via [Prompt-cache-aware context ordering](../decisions/prompt-cache-aware-context-ordering) lands in front of it (static → persona, matching the web order), and post-history trails the conversation [@core-prompts-js] [@architecture-doc].

**`discord-gateway.js` folds core prompts into both live and revisit paths** [@discord-gateway-js]. The Discord adapter now resolves settings and calls `withCorePrompts`, so Discord text (whether a live `handleTurn` or a cached `revisit`) assembles them the same way voice and the web do [@discord-gateway-js].

## Ground Truth, Not Reconstruction: Prompt Capture

The prompt inspector revealed a deeper problem: it was a client-side reconstruction, showing what *should* have been assembled based on the web client's state. It could never show server surfaces' payloads, and it showed intent, not reality [@prompt-capture-js].

**`prompt-capture.js` records the actual message array sent to the model, per surface, at the send boundary** [@prompt-capture-js]. Instead of the inspector reconstructing "what should be in the prompt," it now captures "what actually left the building":

- `recordOutgoingPrompt(surface, {messages, model, provider})` — records the exact payload for a surface (web, voice, discord, discord-revisit, etc.), overwriting the previous capture. It is best-effort: capture must never throw into a turn, even if the inspector is broken.
- `lastOutgoingPrompt(surface)` — retrieves one surface's latest capture (or null), so the inspector can show ground truth for every surface, not just the web path [@prompt-capture-js].

The inspector's UI now tabs by surface. Each tab shows the actual message array that reached the model on that surface, not a reconstruction. When the Familiar reported not seeing its core prompts on Discord, the inspector would have shown exactly that — an absent system segment — instead of cheerfully displaying prompts that never left the browser [@prompt-capture-js].

## The Lesson: Cross-Surface Capabilities Need Server Cells

This bug generalizes to a rule: **any prompt component assembled client-side is invisible to every server-initiated surface (Discord, voice, background loops, future surfaces).** When a capability crosses the browser/server boundary, the server needs its own assembly path, or the feature silently vanishes off-web [@core-prompts-js].

This mirrors what CLAUDE.md calls vision RULE C: a capability must either land in the shared turn path, or the spec must name which surfaces carry it. The four core prompts were a web-only assembly with no server cell, so they vanished on every other surface [@core-prompts-js] [@architecture-doc].

The corollary for observability: an inspector fed by "what should be assembled" cannot catch a payload it never sees. Ground truth must be captured at the send boundary, not reconstructed from intent.

## Related

- [Prompt-Cache-Aware Context Ordering](../decisions/prompt-cache-aware-context-ordering) — the decision that splits context into static and dynamic parts, and why core prompts must lead before the static identity prepend.
- [Phylactery](phylactery) — the identity layer distinct from the four core prompts, holding the base instructions and identity files.
- [Architecture](../architecture) — the overview of system surfaces: web, Discord, voice, and background loops.
- [Multi-embodiment](../concepts/multi-embodiment) — the design stance that one entity is accessed through multiple interfaces. Core prompts are part of ensuring that entity is consistent across all of them.
