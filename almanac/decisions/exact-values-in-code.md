---
title: Exact Values Are Code's Job
topics: [decisions, reference]
sources:
  - id: claude-md
    type: file
    path: CLAUDE.md
  - id: message-sanitize
    type: file
    path: message-sanitize.mjs
  - id: slug-ids
    type: file
    path: slug-ids.js
---

# Exact Values Are Code's Job

**Status: decided, actively enforced.** Any value that has to be machine-correct — a
timestamp, a timezone offset, a UID, a URL, an `.ics` blob, an RRULE, a precise threshold or
count — must be produced or canonicalized by code and never trusted from the model's free
output. The model may *reference* such a value (say "the local time my `[Now]` block shows")
but must not compute or format it itself [@claude-md]. Reasoning and language are the model's
job; arithmetic and exact strings are code's.

## Context

CLAUDE.md calls this "a repeatedly-paid-for lesson," and names three concrete instances that
each looked fine until they failed silently [@claude-md]:

1. **Hallucinated `[HH:MM]` timestamps.** The model, having seen `[HH:MM]` / `⫸HH:MM⫷`
   prefixes in injected chat history, imitates the pattern and emits fabricated times in its
   own replies.
2. **The reminder timezone bug (0.7.84).** Asking the model to convert local time to a
   UTC-offset string on write produced a naive local time the old UTC-based comparison never
   matched — a reminder scheduled fine, showed as fired, and never actually delivered, with
   no error and no chime. See [Unruh](../architecture/unruh) for the full story, including
   the follow-up bug where "local" turned out to mean the server's zone rather than the
   ward's.
3. **The Google-calendar integration is built entirely on this rule.** The Familiar pokes
   Unruh with a node id; Unruh and Google generate the dates, the URL, and the `.ics` bytes.
   The model never types a calendar artifact by hand [@claude-md].

## Decision

Before a feature relies on an exact value, the question is whether code can derive it from
something the model already references — usually yes, via a node id, the live `[Now]` clock,
a stored field, or a machine timestamp [@claude-md]. When a value must be accepted *from* the
model at all, it is normalized and validated at one boundary in code, and a malformed value
is treated as an expected failure mode to handle, not an edge case to hope never happens
[@claude-md]. A value the model formats by hand will be wrong some fraction of the time, and
the failure is usually silent — the rule is to design so that fraction can never reach a
human-facing or safety-relevant surface [@claude-md].

### LLM-generated timestamps are stripped at every outgoing boundary

`message-sanitize.mjs` exports `stripLlmTimestamps(text)`, applied wherever a reply can reach
a human or a platform: in `discord-gateway.js`'s `deliverReply()` before the message is sent
and before it is written to the session log, in both Discord history-assembly `.map()` blocks
(so an old contaminated session cannot compound), and in `reachout.js` on the LLM-generated
message before it reaches the outbox [@claude-md] [@message-sanitize]. The browser side has a
mirror function, `stripDisplayTimestamps(content)` in `app.js`, applied whenever a new
assistant message is committed to state (both streaming and non-streaming paths) and again at
render time [@claude-md]. CLAUDE.md's standing instruction is that any new path delivering
LLM output to a human or platform must apply the matching stripper before the message leaves
the system, and must strip the *stored* content, not only what is rendered — otherwise a
future re-injection compounds the contamination across turns [@claude-md].

### Model-facing ids are readable slugs, never UUIDs

Any identifier the Familiar can ever read — in a tool result, a prompt block, an outbox item,
a session log — is a short, readable slug, never a UUID or raw hash [@claude-md]. This is the
same principle applied to naming rather than arithmetic: a UUID costs roughly 16 tokens and
carries no meaning, while a slug is cheap and greppable, so the Familiar can find a thing
again by remembering what it *is* [@claude-md]. `slug-ids.js` (Node) and `db.slug_id`
(Phylactery/Unruh, Python) are the shared helpers [@claude-md] [@slug-ids]. The preferred form
is meaning-bearing — `slugify(label)-xx`, minted from the best label available at creation
time, growing its random suffix only on collision (the `insert_with_slug_retry` pattern) — and
falls back to a `<kind>-xxxxxx` or date-prefixed form only when no label exists yet, such as an
outbox item where the kind *is* the meaning [@claude-md]. Internal machine keys, like a
content-addressed sha256 filename used for dedup, may remain hashes, but the model-facing alias
for that same record is still a slug [@claude-md]. Ids are treated as opaque strings by every
consumer — nothing parses their shape, and validators accept legacy UUID/hex forms
indefinitely rather than gatekeeping on format [@claude-md].

## Consequences

New id-bearing surfaces must mint a slug id in the same commit that introduces them — "UUID
now, slug later" is explicitly disallowed [@claude-md]. New paths that deliver LLM output to a
human must wire in timestamp stripping in the same commit, at the storage boundary, not only
at render time. And any new feature that would need the model to produce a count, threshold,
or confidence score should route that arithmetic through code and let the model interpret the
resulting pattern instead — CLAUDE.md names this as the forward-looking case still being
watched for (consequence-graph work, certainty scores) [@claude-md].

This decision is the general form that [Unruh's local-naive time model](../architecture/unruh)
and [Phylactery's integer memory ids](../architecture/phylactery) are both specific
applications of. [Voice](../architecture/voice)'s Pass 0 supply chain applies the same rule to
model integrity: `scripts/pin-audio-models.mjs` downloads and hashes each voice model itself
and writes the resulting sha256 and byte counts to `voice-model-pins.json`, so there is no line
of source code where a hash could be typed by hand and drift from the real file. Pass 1's
`voice-speech.js` applies the timestamp-stripping half of the rule to spoken output: an
LLM-emitted `[HH:MM]` is stripped before text-to-speech, because speaking a fabricated time
asserts it as real the same way displaying one would.

The unbuilt browser milestone specs a further application to secrets: the model may name a
credentials-vault entry, but only code reads and types the value, so a password never enters a
prompt, tool result, session log, or audit trail — see
[Browser milestone: guardrails in code, not prompts](browser-guardrails-in-code).
