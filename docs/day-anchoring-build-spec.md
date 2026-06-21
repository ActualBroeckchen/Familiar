# Day-anchoring & memory-coverage — build spec

> **Status:** draft for review. This completes the memory-coverage system that
> the per-session memorization shipped *incomplete* — so it lands as `0.7.x`
> patches, **not** a new minor. (Same framing as the dedup / re-tier / consent /
> register fixes: repairing the memory system, not adding a milestone.)
>
> Self-contained: everything needed to build this lives here. Read
> [`architecture.md`](architecture.md) §`memorization.js` for the current shape
> it extends.

---

## 1. Why

Memorization today is **session-anchored and rollover-dependent**, and that
leaves real gaps:

- **No notion of a "day."** Logs are `logs/{sessionId}.json`, one file per
  session; messages carry an ISO `timestamp` but nothing groups by date. A
  session that crosses midnight is one undifferentiated blob.
- **No coverage tracking.** Nothing records which conversations have been run
  through the pipeline. The dedup key only collapses *in-flight* jobs; once a job
  finishes, the same content can be re-memorized, and there's no "this is done"
  signal anywhere.
- **Rollover isn't reliable.** Memorization fires on web session-end, Discord
  6-h idle rotation, or the `memorize_now` tool. But the Familiar is meant to be
  *always running*, and people switch sessions / clear history — so a thread of
  real importance can pass through and never get memorized.
- **No way to bring in the past.** Logs exported from other harnesses/platforms
  can't be placed by date and ingested.

The ward's own words frame the target: *"I'd like to see a calendar… days that are
fully memorized [one colour]; days where anything is still missing or the Familiar
isn't sure [a distinct colour] I can click to feed all logs from that date to the
pipeline. Once a day is fully done, its logs are no longer searched for
information when memorizing — only for recall if pertinent."*

## 2. Goals / non-goals

**Goals**
- A first-class **calendar date** as the unit of memory coverage.
- A **coverage ledger**: per date, is every log from it fully memorized, partly
  missing, or uncertain?
- An **always-on, coverage-driven sweep** that memorizes what's missing without
  depending on a clean rollover; **completed days drop out of the sweep**.
- A **calendar UI**: coloured days, click to (re)feed a day.
- **Import** of foreign timestamped logs: place by date, segment, ingest.
- **Markdown** as the ingestion format (token-economical), JSON stays the
  storage format.

**Non-goals (for this spec)**
- Physically splitting the live session file at midnight. Per the **Hybrid**
  decision (below) the live session stays intact; segmentation is *logical*, at
  memorization/archive time.
- Re-architecting Phylactery. Extracted facts still flow to Phylactery exactly as
  today (daily-standalone, consent-gated, graph-routed). The ledger is a
  **Proto-Familiar-local** concern (sessions are per-embodiment, like ponderings).
- A general "import any format" parser. We support a small, documented set of
  shapes and degrade loudly on the rest (see §7).

## 3. The Hybrid model (decided)

> The live session file (`logs/{sessionId}.json`) **stays intact** for UX
> continuity — you can keep chatting across midnight. **Day-segmentation happens
> at memorization/archive time**, producing per-day units for the ledger without
> breaking the active session.

Consequence: a "day-segment" is **derived**, not a primary store. The primary
store is unchanged. Everything below computes day-segments on demand from session
logs.

*Trade-off noted:* the context-management benefit of a hard midnight session
cut is deferred. If wanted later, it's a separate, softer change (bias session
rollover toward midnight boundaries) and does not block this work.

## 4. Core concepts & data shapes

### 4.1 Day-segment (derived, pure)

New module `day-segments.js`:

```js
// Group a session log's messages by LOCAL calendar date (see §8 timezone).
// Pure + synchronous → trivially testable. Returns segments in date order.
export function segmentByDay(messages, { tz }): Array<{
  date: string,          // 'YYYY-MM-DD' (local)
  startIdx: number,      // inclusive index into messages
  endIdx: number,        // inclusive
  count: number,         // endIdx - startIdx + 1
  messages: Message[],   // the slice (so callers don't re-index)
}>
```

Rules: messages without a usable `timestamp` inherit the previous message's date
(or, for a leading run, the first dated message's date). A segment with `< 2`
readable messages is still reported (the ledger needs to know it exists) but the
memorizer will skip it (too short to extract).

### 4.2 Coverage ledger (`tomes/.memory-coverage.json`, gitignored)

```jsonc
{
  "version": 1,
  "tz": "Europe/London",          // the tz the dates were computed in (§8)
  "days": {
    "2026-06-20": {
      "status": "complete",        // complete | partial | uncertain | empty
      "segments": {
        "<sessionId>": {
          "memorizedThrough": 42,  // highest message index of this date's slice
                                   // that has been run through the pipeline
          "total": 42,             // total messages for this date in this session
          "lastRun": "2026-06-21T03:11:00Z",
          "facts": 7,              // facts produced (observability)
          "flag": null             // null | 'shared-room' | 'extract-failed'
        }
      },
      "updatedAt": "2026-06-21T03:11:00Z"
    }
  }
}
```

**Status derivation** (pure function over a day entry):
- `empty` — no session has ≥2 readable messages on that date.
- `complete` — every session with messages on that date has
  `memorizedThrough === total` **and** no segment carries a `flag`.
- `uncertain` — every slice is memorized but at least one carries a `flag`
  (shared-room session, or an extraction that failed/low-confidence). Surfaced in
  its own colour so the ward can review.
- `partial` — otherwise (some slice not fully memorized).

New module `memory-coverage.js` owns read/write (atomic tmp+rename like the
memorization queue), plus:
```js
recordSegmentRun({ date, sessionId, throughIdx, total, facts, flag })
computeStatus(dayEntry) -> 'complete'|'partial'|'uncertain'|'empty'
incompleteDates() -> string[]          // for the sweep
getCoverage() -> { days: {...} }       // for the calendar API
```
Degrades like every other tome file: unreadable/missing → treated as empty, never
throws into a request or loop.

## 5. Phase 1 — day-anchoring foundation

Make memorization **day-segment-aware** and start writing the ledger. No new
loop yet; rides the existing triggers.

1. `day-segments.js` (§4.1) + tests.
2. `memory-coverage.js` (§4.2) + tests.
3. **Enqueue per day-segment, not per whole session.** The existing
   `enqueueMemorization({ sessionId, scope, topicId, messageRange, ... })` already
   keys idempotency on `sessionId|scope|topicId|rangeKey`. Day jobs use:
   - `scope: 'day'`
   - `topicId: <date>` (so the dupKey is unique per date)
   - `messageRange: { start: startIdx, end: endIdx }`
   - `messages`: the segment slice
   A helper `enqueueSessionByDay(sessionLog, …)` segments the log and enqueues one
   job per segment with ≥2 readable messages, **skipping segments the ledger
   already marks memorized** (`memorizedThrough === total`).
4. **Record coverage on completion.** `processJob` already returns
   `{ factsCreated, … }`. On success it calls `recordSegmentRun(...)` with the
   job's `topicId` (date), `sessionId`, `messageRange.end` as `throughIdx`, and a
   `flag` of `'shared-room'` when `audienceTag !== 'ward-private'`, or
   `'extract-failed'` on a caught extraction error.
5. **Point the existing triggers at the day helper:** web `POST /api/memorize`
   (session scope), Discord idle rotation, and `memorize_now` all route through
   `enqueueSessionByDay` instead of one whole-session job. (Topic-scoped jobs are
   unaffected — they keep `scope:'topic'`.)

Ships behind nothing new; it only *adds* the ledger and changes the segment
granularity. Existing behaviour (facts → Phylactery) is identical per-slice.

## 6. Phase 2 — coverage-driven sweep (rollover-independent)

New background loop `memory-sweep-loop.js` (the "always-on" answer to unreliable
rollover):

- Tick cadence: slow (default **10 min**); self-paced — no work when nothing's
  incomplete.
- Each tick: enumerate `logs/*.json`, segment each by day, and for every
  **incomplete** date enqueue the missing slices via `enqueueSessionByDay`.
- **Completed days drop out:** a date whose ledger status is `complete` is
  skipped without re-reading its sessions (cheap-gate in code, no LLM). Its logs
  are kept for browsing/recall, never re-scanned for memorization — exactly the
  ward's "once a day is done, only recalled if pertinent."
- Hard off-switch `PROTO_FAMILIAR_MEMORY_SWEEP_DISABLED=1`, in the same commit
  (loop rule). Settings toggle "Memory coverage sweep".
- Graceful: a bad log file is skipped with a warning; the loop never throws.

This **does not** add an LLM call per tick — it only *enqueues* into the existing
memorization worker, which already paces itself. (Ride existing requests; gate in
code.)

## 7. Phase 3 — calendar UI

- `GET /api/memory-coverage` → `{ tz, days: { 'YYYY-MM-DD': { status, facts,
  flags } } }` (sanitized; no message content).
- `POST /api/memorize-day { date }` → segments every session touching that date
  and enqueues the missing slices (manual (re)feed; a `force:true` re-runs even
  `complete` days — the write-time dedup makes that safe).
- A **calendar view** (new Knowledge-editor tab or a panel): one cell per day,
  coloured by status —
  - `complete` → calm/green
  - `partial` → "needs attention" colour
  - `uncertain` → a distinct third colour (shared-room / unsure)
  - `empty` → muted
  Click a day → detail (which sessions, fact counts, flags) + a **"Memorize this
  day"** button (`POST /api/memorize-day`). Legend included.
- Live-ish: re-fetch coverage after a memorize action and on tab focus.

## 8. Phase 4 — foreign-log import

- `POST /api/import-logs` (+ an upload/paste UI in the calendar tab).
- **Parsers** (`log-import.js`), tried in order, each returning a normalized
  `Message[]` (`{ role, content, timestamp, speaker? }`) or `null`:
  1. Proto-Familiar's own session-log JSON (and an export bundle of many).
  2. A generic **timestamped-markdown / text** shape: lines like
     `[2026-06-20 14:35] Name: text` (configurable-ish, documented).
  3. OpenAI-style `{ messages:[{role,content}] }` arrays **with** a sidecar or
     per-message timestamp.
  Anything else → a loud, structured error back to the UI ("couldn't recognise
  this format; here's what I support"). No silent best-effort.
- **Place by date:** run the normalized messages through `segmentByDay`, write
  each segment into an **archived day-segment** store
  (`logs/imported/YYYY-MM-DD/<importId>.json`, native format) so it's browsable
  and re-memorizable, and seed the ledger for those dates as `partial`.
- **Ingest:** the sweep (Phase 2) picks the new dates up, or the import response
  offers an immediate "memorize now" that calls `POST /api/memorize-day` per
  imported date.
- **Markdown ingestion:** extraction is fed lean markdown, not JSON. The internal
  `formatTranscript` already emits speaker-prefixed plain text; this phase
  formalizes a single `toIngestMarkdown(messages)` used by *both* the live
  pipeline and import, so foreign JSON never reaches the model as JSON. (Storage
  stays JSON; only the LLM feed is markdown — JSON is great for storage, wasteful
  for ingestion.)

## 9. Cross-cutting

- **Versioning:** `0.7.x` patch per shippable phase (Phase 1 → `0.7.x`, etc.). No
  minor — completing an incomplete system.
- **Degradation:** ledger/ sweep failures never touch the chat path; a missing
  ledger reads as "all empty" and the sweep rebuilds it.
- **Off-switches:** Phase 2's loop ships its `PROTO_FAMILIAR_MEMORY_SWEEP_DISABLED=1`
  in the same commit.
- **No copy-paste:** `segmentByDay`, `toIngestMarkdown`, and the status-derivation
  live in one module each and are reused by the triggers, the sweep, the API, and
  import.
- **docs/architecture.md** updated in the same commit as each phase (the ledger,
  the new loop in the autonomous-loops table, the new endpoints).
- **Tests:** pure functions (`segmentByDay`, status derivation, parsers) get unit
  tests; the ledger gets round-trip + status tests.

## 10. Open decisions (please confirm before Phase 1)

1. **Timezone for date boundaries.** A "day" needs a tz to place a message's
   UTC/ISO `timestamp` on a calendar date. Options: (a) the server's local tz
   (simplest, matches a single-machine ward); (b) a configurable
   `settings.memoryTimezone`. **Recommend (a)** now, with the ledger stamping the
   tz it used so (b) can come later without ambiguity.
2. **What flags a day "uncertain"?** Proposed: shared-room sessions
   (`audienceTag !== 'ward-private'`) and failed/low-confidence extractions. Any
   others you want surfaced (e.g. a Discord day with unregistered people)?
3. **Recall over raw day-segments?** The ward said completed days are "recalled if
   pertinent." Today recall = semantic search over *Phylactery facts*, not raw
   logs. **Recommend:** keep it that way — extracted facts are the recall corpus;
   raw day-segments stay for browsing/re-memorization only (embedding raw logs
   would duplicate the store). Confirm that's the intent, or we add a raw-log
   recall corpus.
4. **Retention.** Completed days' raw logs are **kept** (never deleted), just
   excluded from the memorization sweep. Confirm — vs. an archive/compaction step
   later.
5. **Phase order.** 1 → 2 → 3 → 4 as written, or pull the calendar (Phase 3)
   earlier so you can *see* coverage before the sweep automates it?
