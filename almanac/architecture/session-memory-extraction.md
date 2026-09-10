---
title: "Session Memory Extraction"
topics: [architecture, memory, extraction, sessions, memorization]
sources:
  - id: memorization-js
    type: file
    path: src/memory/memorization.js
---

# Session Memory Extraction

Memory extraction is the process of calling an LLM to transform a chat transcript into structured memory facts and relationships. The extraction pipeline is owned by functions in `src/memory/memorization.js` that shape how a transcript is presented to the model, how the model's voice is framed, and how speaker attribution works. [@memorization-js]

When a memorization job runs (see [Session Memorization](session-memorization) for queue mechanics), the extraction pipeline assembles the transcript, calls the provider, and parses the response. This page explains the architectural layers that make extraction reliable: role-faithful message assembly, voice framing, the three-layer attribution fix, and speaker name handling.

## Role-faithful transcript assembly

The conversation is assembled as a proper message array with real OpenAI roles, not as a flattened "Name: text" blob inside a prompt. [@memorization-js]

`conversationMessages(messages, {sharedRoom, wardLabel, withNames})` [@memorization-js] transforms the session's message list into role-tagged turns:

- The Familiar's own lines become `assistant` role messages.
- Everyone else becomes `user` role messages.
- In shared rooms (where 3+ humans are present), an inline `[Name]:` prefix or ward label stays on each user message, because only three chat roles exist — all humans collapse to `user`, so inline labels are the only disambiguator for multiple people.

`buildExtractionMessages({instructions, messages, sharedRoom, wardLabel, withNames})` [@memorization-js] assembles the full provider message array:

1. A leading `system` message with the extraction instructions (the prompt).
2. The conversation as role-tagged turns from `conversationMessages`.
3. A neutral `system` closing cue: `EXTRACTION_CLOSING_CUE` [@memorization-js].

The closing cue is deliberately not first-person. It re-anchors "now extract" as a task directive so a transcript ending on a human line cannot tempt the model to reply as if continuing the conversation instead of extracting. It is task plumbing, not something the Familiar says, so it never puts the Familiar's voice in a role that is not theirs. [@memorization-js]

Why this matters: giving the model real roles lets it natively read which lines are the Familiar's own — where early `about_me` extraction used to go wrong, because the model could not reliably tell which parts of the flattened blob were the Familiar speaking.

Dating is unaffected: a memory's day comes from the job's calendar day (via `segmentByDay` and `date_key`), never from parsing the transcript itself. [@memorization-js]

## Voice reframe

Both extraction prompts (`buildPrompt` and `buildSharedRoomPrompt`) [@memorization-js] are framed as the Familiar's own notes, with careful attention to timing:

- The prompt opening is now timing-agnostic: "Ah, some unprocessed session logs…" instead of "I just finished talking." The old wording was wrong for the memory-sweep loop and batch imports, which run the same extraction prompt over past days that are no longer "just finished."
- A plain correctness caution grounds the task: "This is a form of tool call: the memorization only works if the syntax is flawless." This is safe because no tools are attached to the extraction request, so the phrase cannot make the model emit a real tool-call structure.
- The prompt bookends are punchy and JSON-focused: "My notes read —" to open, "ONLY the JSON" to close. [@memorization-js]

The voice reframe distinguishes the ward-private extraction (`buildPrompt`) from the shared-room variant (`buildSharedRoomPrompt`). Ward-private extraction assumes the Familiar will keep facts about everyone; the prompt instructs the Familiar to use proper first-person voice and asks for careful attribution. Shared-room extraction runs when strangers are present and assumes a separate consent step will filter — the prompt explicitly tells the Familiar to record facts without pre-censoring and to let consent handling do the gating. [@memorization-js]

## The attribution stack — three reinforcing layers

A reported bug in early versions: the Familiar saved memories crediting the ward with actions other people did. Not a data bug (speakers are tagged in the transcript) — the model's strong prior that "the user = the person I serve" was overrunning weak attribution guidance. Three reinforcing layers now address this: [@memorization-js]

1. **Subjects + the "Whose fact is it?" rule:** The first rule in both extraction prompts is stated in the `{{user}}` macro (a concrete name tracks better than "my human"). "Only what {{user}} did is about {{user}}; someone else's action is about THEM even when {{user}} relays it." Facts are named in the `content` field (using proper voice) and the `subjects` list (naming the actual actor), never with {{user}} as the actor when someone else did the deed. Correct `subjects` also routes third-party facts to the consent "ask" path later, tightening privacy gating. [@memorization-js]

2. **Role-faithful transcript** (described above): Fixes the Familiar-vs-others axis, so the model can natively read which lines are the Familiar's own.

3. **Name-field speaker handles** (described below): Fixes the ward-vs-other-humans axis by stamping each turn with a first-class sender ID.

These three layers resolve attribution whenever the transcript makes the actor identifiable. They do not close every case: a `"you"` or a bare pronoun in someone's words can still point at either the ward or whoever they were addressing with no way to tell from the turn itself. [Attribution confidence: degrade the attribution, not the fact](../decisions/attribution-confidence-degrades-not-drops) covers what the extraction does with that residual case — mark the referent unresolved, emit an optional `attribution_confidence` on the fact, and let recall and a later noticing sweep carry the correction instead of guessing or dropping the fact outright.

## Speaker name field handling

The OpenAI `name` field lets the model get a first-class sender identifier per message turn, not only the inline `[Name]:` text in the message content. But the field has constraints that make it tricky to use with real names. [@memorization-js]

### The constraint

OpenAI validates the `name` field against `^[^\s]+$` — no whitespace or non-ASCII. A bad value returns a 400 error for the ENTIRE request. Real names (spaces, unicode) are exactly what breaks it. [@memorization-js]

### Code-minted name-safe handles

Every speaker gets a code-generated handle via `speakerNameField({role, speaker, wardName, material})` [@memorization-js]:

- **Villagers or strangers:** `slugifyLabel(name)` — the name slug-cased, guaranteed name-field-safe.
- **The ward (a user turn with no speaker field):** `ward-<slug>` — the `ward-` prefix marks the bond and makes the ward a specific person, never flattened to a bare role. The slug preserves their name.
- **Material with no live speaker (an archived log on a user turn):** `session-archive` — so it cannot be misread as someone addressing the Familiar.
- **The Familiar's own assistant turns:** None (the role carries them; no name needed).

### Capability detection and learning

Whether to use name fields is gated by `nameFieldEnabledFor(job, settings)` [@memorization-js], which follows a three-tier fallback:

1. **Explicit per-connection setting:** The ward can set `nameFieldCapable: 'yes'` or `'no'` on a connection. This wins.
2. **Learned per-provider-model:** An in-process Map records what earlier calls taught: if a previous call succeeded with names, try names again; if a previous call got a 400-with-names that succeeded without names, skip names. Learned state is cheap and can re-learn after restart; no dotfile is needed.
3. **Optimistic:** If nothing is known, assume the provider supports names and attempt it. Learn from the outcome.

### Graceful degradation: `extractWithNameFallback`

The function `extractWithNameFallback({withNames, buildMessages, callProviderFn, onLearn})` [@memorization-js] implements the retry strategy:

- Attempt extraction with names enabled (if `withNames` is true).
- On success, record `'yes'` in the learned cache.
- On a 400 error while names were on, retry ONCE without names. If that succeeds, record `'no'` in the cache — the provider does not support the field. If it also fails, propagate the second failure untouched (never mis-learn).
- On non-400 errors, never retry — propagate immediately.

This design mirrors the `visionCapable` learning pattern. The net result: names switch on for capable providers with zero configuration. A strict server costs one wasted attempt, then stays bare. Memorization never fails over the name field itself. [@memorization-js]

### Why not split roles differently

The `name` field cannot "split roles" in a way that would let multiple humans appear as distinct role types. Chat has only three roles: `system`, `user`, `assistant`. Multiple humans all become `user` no matter what. [@memorization-js]

The message `speaker` field already carries the same information that the inline `[Name]:` label is generated from (in `discord-gateway` by `attributeUserContent`). Stamping the OpenAI `name` field with a pseudonym handle is what makes the field useful: the model gets a separate identifier namespace that does not depend on the content string. [@memorization-js]

## Related

- [Session Memorization](session-memorization) — the queue, triggers, consent gating, and coverage tracking that dispatches extraction jobs.
- [Content-based memory gating](content-gating) — how extracted facts are filtered and gated by villager tier and consent status.
- [Tomes and keyword lore](tomes-and-lore) — the entry format and keyword activation engine that extracted memories feed into.
- [Session lifecycle](session-lifecycle) — when sessions begin and when memorization is triggered.
- [Attribution confidence: degrade the attribution, not the fact](../decisions/attribution-confidence-degrades-not-drops) — the follow-on decision for a referent the three-layer fix above still can't resolve: mark it unresolved rather than guess or drop it, and let [Phylactery](phylactery) recall and [Noticing](noticing) carry the correction.
- [Deliberations delivered as system messages](../decisions/deliberations-as-system-messages) — the role-faithful transcript assembly on this page is the reference implementation of that decision's "Familiar spoken output rides as `assistant`" axis.
