---
title: Message attachments ride beside content, not inside it
topics: [decisions, vision, architecture]
sources:
  - id: vision-js
    type: file
    path: src/vision/vision.js
---

# Message attachments ride beside content, not inside it

**Status**: Shipped in 0.9.0-alpha (PR #219)

**Decision**: `message.content` remains a plain string forever. When images arrive, they are stored separately and referenced via an optional `attachments: [{id, kind, mime}]` field on the same message object. The single seam where attachments become LLM-visible is `materializeAttachments()` in `vision.js` [@vision-js].

## Context

The 0.9.0 vision milestone adds multimodal input to the Familiar, starting with images. This required answering: how do attachments change the message shape? The options were:

1. **Keep content as string, add attachments field** (chosen) — `message` is `{content: string, attachments?: [...]}`. Existing code stays untouched.
2. **Make content an array** — `message.content: (string | ImagePart)[]`. Every consumer changes.
3. **Embed images in the string** — base64 inline, markdown syntax, or custom delimiters. Loses structure.

## Decision

Option 1. `message.content` is always a string. Attachments are optional metadata on the same message object, separate from content.

This is called a "load-bearing decision" because every future vision-related change depends on keeping this boundary stable [@vision-js].

## Consequences

**Preserved backward compatibility**: Every existing consumer of message data keeps working unchanged [@vision-js]. This includes:

- Timestamp stamp/strip in `message-sanitize.js` — operates on strings
- `INPUT_CHAR_CAP` enforcement — counts string length
- Memorization filters that check `typeof m.content === 'string'` — still true
- Session JSON logs — string content remains scannable without parser knowledge of attachments

**Single seam for provider materialization**: The attachment layer is invisible to the rest of the system except at one place: when the message is about to be sent to an LLM provider, `materializeAttachments()` converts stored attachment metadata into provider-consumable image_url data-URL parts (or text stand-ins when vision is unavailable) [@vision-js].

**Easy future modality expansion**: Adding support for audio, video, or documents is a materializer change only, not a message-format migration [@vision-js]. The storage format, message shape, and every consumer stay the same; only `vision.js` needs to know what modalities exist. Video (0.11.33-alpha) confirmed this in practice: [Vision and media](../architecture/vision-and-media) documents the `video` kind riding the same `attachments` field, materialized by the same `materializeAttachments()` seam, with no change to `message.content` or any of its existing string-assuming consumers.

**Audience gating is clean**: Private attachments can be silently dropped from specific audiences without altering the message's string content, because attachments are a separate field [@vision-js]. An attachment shared with the ward but not with a villager contributes nothing to that villager's chat turn — not even a text stand-in.

**Requires discipline**: Code must never assume `message.content` is complete for display or analysis. Attachments are metadata that only the materialization seam consumes. Every tool that works with "what the LLM sees" must call `materializeAttachments()` and work with the result, not the raw message.

## Related

- [Vision and media](../architecture/vision-and-media) — the dual of this decision: how attachments become LLM-visible at the materialization seam, and how modality fallback works when vision is unavailable.
- [Session memorization](../architecture/session-memorization) — where attachment metadata is preserved when sessions turn into lasting memories.
