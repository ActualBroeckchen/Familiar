---
title: Data Ingestion
topics: [architecture, data-ingestion]
sources:
  - id: log-import-js
    type: file
    path: log-import.js
  - id: server-js
    type: file
    path: server.js
  - id: app-js
    type: file
    path: public/app.js
---

# Data Ingestion

Familiar can import conversation logs from other platforms and formats into its session storage. The ingestion system (`log-import.js`) detects the format automatically, normalizes messages to a canonical shape, anchors them by date, and feeds them through the memorization pipeline as if they were native sessions [@log-import-js]. This lets wards bring chat history from ChatGPT, Claude, SillyTavern, OpenClaw, or plain timestamped text into the Familiar's memory.

## Supported formats

`log-import.js` recognizes five formats, tried in order until one matches [@log-import-js]:

| Format | Source | Detection | Timestamps |
|---|---|---|---|
| Familiar JSON | Native exports | Array of sessions or messages with `messages` array | Per-message ISO |
| SillyTavern JSONL | .jsonl chat exports | One JSON object per line with `is_user`, `mes`, `send_date` | Per-message ISO (`send_date`) |
| OpenClaw JSONL | Event stream exports | Line-by-line events, `type:'message'` contains `role`, `content`, `timestamp` | Per-message ISO |
| ChatGPT copy/share | Web UI clipboard export | STANDALONE headers `**ChatGPT:**` or `ChatGPT said:` (current format), separated by `* * *` | None (date-supplied) |
| Timestamped text | Plain text or Markdown | Lines shaped `[<timestamp>] <Speaker>: <text>` | Per-message (`[timestamp]`) |

Each parser returns `{ messages, format }` on match or `null` to try the next parser. If all parsers fail, the system returns a loud, structured error (no silent best-effort parsing) [@log-import-js].

## Normalized message shape

Every format normalizes to `{ role: 'user'|'assistant'|'system', content, timestamp: ISO|null, speaker?: string }`. The `role` field determines how the message is treated downstream:

- **user** — something the ward said (or a generic non-self speaker in a multi-party format)
- **assistant** — the AI responded (or a configured self-name in timestamped text)
- **system** — metadata, notes, or a named non-you/non-assistant speaker in ChatGPT

The optional `speaker` field preserves the original name if the source provides one [@log-import-js].

## Date anchoring

Messages from undated formats need a calendar date before they can be segmented into daily buckets. The caller supplies a date via:

- **Filename extraction** — `dateFromFilename("2025-05-23_chat.txt")` pulls an ISO-ish run anywhere in the name (validating month/day) [@log-import-js]
- **Explicit date** — passed by the UI when the user selects a date in the importer modal
- **Fallback to today** — if both are absent (though the UI should enforce this)

Once dated, all messages in the import get stamped with that date (at local noon, so timezone drift cannot skew the calendar day assignment) if they have no per-message timestamp [@log-import-js].

## ChatGPT format

ChatGPT copy/share exports have two header shapes in the wild, both now recognized [@log-import-js]:

- **Bold markdown** — `**You:**` / `**ChatGPT:**` (older copy/share export)
- **"Said" plain text** — `You said:` / `ChatGPT said:` (current web-UI copy format, no bold, the word "said" before the colon)

Recognition of the new "said" format was added to fix a regression where modern ChatGPT copy/paste was rejected as "unrecognised" [@log-import-js]. Turns are separated by a `* * *` line, and inline bold markdown (headings, emphasis) inside a message is never mistaken for a speaker header because speaker headers must be STANDALONE (the whole line) [@log-import-js].

## UTF-8 BOM stripping

Text editors on macOS and Windows often prepend a UTF-8 BOM (byte-order mark, U+FEFF) when saving files. If present, it is stripped before parsing so the text is treated as plain content, not a format marker [@log-import-js].

## Error handling

Unknown formats return a loud, structured error (no silent best-effort). A parse with no timestamps anywhere is also rejected — `segmentByDay` needs an anchor, and `day-segments.js` forward-fills gaps only within a same-day session [@log-import-js].

The UI (`POST /api/import-log`) accepts raw text in the request body, calls a suitable parser in order, and returns `{ ok, messages?, format?, error? }` to the client [@log-import-js] [@server-js]. A successful import enqueues the messages for memorization as if they were a native session, day-bucketed and ready for the consent gate and consolidation pipeline [@app-js].

## Related

- [Session memorization](session-memorization) — the queue that turns imported messages into Tome entries
- [Engineering conventions](../reference/engineering-conventions) — the repo-wide graceful-degradation and loud-error rules this subsystem follows
