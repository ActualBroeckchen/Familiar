# Topics

## Overview

Topics let you tag a named slice of a conversation and track it with a coloured bar in the message gutter. When a topic ends, an LLM-generated summary can be saved directly to a Tome as a new entry with auto-suggested keywords.

Topics are stored per-session in `localStorage` under the key `pf_topics_<sessionId>`.

---

## Starting a Topic

Click the **+ Topic** button in the input bar. A dialog prompts for an optional name (leave blank to auto-generate one). From that point forward, all new messages are grouped under the topic.

Multiple topics can run in parallel. Each active topic shows a pulsing dot at the bottom of its gutter bar to indicate it is still open.

### Retroactive Start

Click the **▷ Topic start** button on any past message to begin a topic from that point in history rather than the present. This is useful for labelling a conversation slice after the fact.

---

## Ending a Topic

Hover over any message and click the **□ Topic end** button. If more than one open topic includes that message, a picker appears so you can choose which topic to close.

---

## Topic Auto-Summary

When a topic ends, an LLM call is made to produce a tome entry for the messages within that topic's bounds. The prompt is shaped by [`docs/tome-writing-guide.md`](tome-writing-guide.md), so the model is asked for:

- **Conversational trigger keywords** — phrases the user would actually say when the situation recurs, not topic labels.
- **Familiar-perspective bullet content** — the Familiar's own first-person notes-to-self: a short framing line followed by action and prohibition bullets ("what I will do" / "what I will NOT do"), using the `{{user}}` macro for the user's name.
- **A sticky value** suggestion sized to how long the situation typically persists.

A review dialog opens with:

- **Title** — editable; defaults to the topic name or a generated title.
- **Body** — the generated bullet content; fully editable before saving.
- **Keywords** — 3–8 conversational trigger phrases; editable.
- **Sticky** — number of turns the entry stays active after first match; editable (blank for one-shot).

Clicking **Save to Tome** creates a new [Tomes](tomes.md) entry with:

- The title as the entry comment
- The bullet body as the entry content
- The chosen keywords as primary keys
- The chosen sticky value (or none if blank)
- Injection position `before_char` (default)

The summary dialog can be dismissed without saving if the entry is not useful.

---

## Parallel Topics

Multiple topics can be open simultaneously. Their coloured bars appear side-by-side in the message gutter. Each topic tracks its own start message and end message independently.

---

## Topic Data Structure

Each topic object stored in `localStorage`:

```json
{
  "id":          "uuid",
  "label":       "My Topic",
  "color":       "#a8d8a8",
  "startIndex":  3,
  "endIndex":    12,
  "tomeEntryId": null
}
```

| Field | Description |
|---|---|
| `id` | UUID |
| `label` | Display name |
| `color` | Hex colour for the gutter bar |
| `startIndex` | Index of the first message in `state.messages` |
| `endIndex` | Index of the last message, or `null` if the topic is still open |
| `tomeEntryId` | UID of the Tome entry saved from this topic's summary, or `null` if none was saved |
