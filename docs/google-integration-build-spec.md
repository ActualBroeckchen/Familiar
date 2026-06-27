# Google Calendar integration — build spec

> **Milestone: 0.8 (the next minor).** This is its own milestone, so the whole
> feature shares ONE minor bump: it lands as `0.8.0-alpha`; sub-passes and
> follow-ups inside it bump PATCH (the consequence-graph two-pass precedent —
> see CLAUDE.md "One milestone = one minor"). The feature branch name owns the
> 0.8 slot; ancillary work elsewhere stays 0.7.x PATCH until this lands.
>
> **Status: SHIPPED in 0.8.0-alpha.** All five passes landed: inbound link tier
> (`ical.py`/`gcal.py` + `gcal-source.js` + `gcal-sync-loop.js`), outbound export
> (`icalwrite.py` + `schedule_export` + `/api/schedule/:id/export.ics`), the
> change-gated projection cue (`gcal-projection.js`), the advanced authenticated
> CLI read tier (`fetchViaCli`, gogcli/gcalcli), and confirmed write-back
> (`pushIcsViaCli` + `schedule_push_to_google`, ADD-only, opt-in). The CLI tiers
> are implemented as one generic, override-friendly adapter behind the single
> `gcal_ingest` seam rather than two hardcoded tool integrations — the ward picks
> a preset and may override the command. This doc stays as the design record.
>
> **Follow-up (0.8.1): native Google OAuth, no terminal.** Testing surfaced that
> the CLI tier assumes terminal authentication — a non-starter for a ward who
> doesn't live in a shell, and the `gogcli` binary couldn't be verified anyway.
> So 0.8.1 adds a **native Google account source** (`gcal-google.js`): the ward
> uploads their Cloud-Console `credentials.json` and clicks Allow once (a loopback
> OAuth flow entirely in the browser), or pastes a refresh token minted on
> Google's side — and Proto-Familiar then talks to the Calendar API directly
> (windowed read with `showDeleted`, `events.insert` for write-back), refreshing
> the token itself forever. This is now the recommended authenticated path; the
> CLI tiers remain for users who already run them. The iCal-URL link tier is
> unchanged as the zero-setup default.

## 0. What this builds on — inlined, so you don't open another doc to start

### 0.1 The Unruh schedule model (the thing this feeds)

Unruh is the in-tree temporal service (Python / uv FastMCP at `./unruh/`,
spawned as an MCP stdio child by thalamus). Its schedule layer stores nodes +
edges in sqlite (`unruh/src/unruh/schedule.py` — pure functions over a
connection; MCP glue in `server.py`):

- **Node types:** `event | task | phase | state | reminder`. Columns: `id`,
  `type`, `label`, `when_ts` (ISO-8601 **local-naive**, no offset — see §1.2), `end_ts` (optional), `resolution`,
  and an arbitrary `payload_json`. Validation: `event`/`phase`/`state`/`reminder`
  require `when`; `phase` additionally requires `end`; `task` may omit both
  (open-ended to-do).
- **Recurrence** lives in `payload.recurrence`. Shape (all optional but `freq`):
  `{ freq: 'daily'|'weekly'|'monthly'|'yearly', interval: number (default 1 —
  every N units), byweekday: int[] (MO=0…SU=6), bysetpos: int (monthly only;
  1=first … -1=last) }`. **One recurring series = ONE anchor node**; the JS
  expander (`recurrence.js`) materialises occurrences, and per-occurrence
  resolutions are stored in `payload.resolutions` (`{YYYY-MM-DD: resolution}`).
- **Edges:** kinds `causes | requires | depends_on | blocks | during |
  carries_forward | co_occurs_with`. Authored via `schedule_link`, validated in
  `schedule.py`.
- **Three-layer tool path** (follow it for every new capability here): tool
  defined in `unruh/src/unruh/server.py` (`@mcp.tool()`) → wrapped in
  `thalamus.js` (`unruhClient.callTool(...)`) → surfaced to the Familiar in
  `cerebellum.js` (first-person tool description).

### 0.2 The projection discipline we reuse (not reinvent)

New nodes route into the **existing** consequence-graph projection step:

- A **consequence is a `schedule_link` edge** (usually `causes` or
  `co_occurs_with`) with an optional payload: `{ valence: help|harm|neutral,
  condition: on_resolve|on_lapse|unconditional, horizon_hours, severity:
  low|med|high, certainty: low|med|high, observed: bool, note }`. `observed` is
  the past/future axis (a fact vs a projection).
- **Both futures:** a node worth projecting carries both branches — `on_resolve`
  (what finishing it buys — the half that *motivates*) AND `on_lapse` (what
  skipping costs). The Familiar authors both, **leading with `on_resolve`**. A
  consequence whose target isn't itself a scheduled item (a *crash*, a *flare*)
  is a `state` node, resolve-or-created by label in the same `schedule_link`
  call.
- Authoring **rides chat turns** (the Familiar holds the ids) and the reflection
  loop — **no new standalone LLM request**. The reflection loop (`pondering.js`)
  later confirms/refutes projections and calibrates `certainty`. (Full detail in
  `docs/consequence-graph-build-spec.md`; the above is all this feature needs.)

### 0.3 CLAUDE.md invariants this must honor

- **Graceful degradation:** every loop ships a hard off-switch
  (`PROTO_FAMILIAR_*_DISABLED=1`) **and** a Settings toggle in the same commit;
  one peer down never touches the chat path.
- **Ride existing requests; gate in code** — new judgments fold into calls that
  already happen; hard gates decide "should this fire?" for free.
- **No copy-paste of substantial logic** — one inbound upsert, one export path.
- **Every capability reachable BY the Familiar** — first-person tool description
  + every required input obtainable from a surface the Familiar already has.
- **LLM-generated values must not be the source of truth** — the spine of this
  whole feature (§3).

---

## 1. Inbound — Google → Unruh (mechanical, change-gated)

### 1.0 The two data flows (keep them separate in your head)

```
  INBOUND  (mechanical; the Familiar is prompted ONLY for what CHANGED)
  Google Calendar ──iCal link / gogcli / gcalcli──▶ Node fetch ──▶ Unruh upsert
                                                                       │
                                            code classifies each item: │
                                            new │ updated │ unchanged │ removed
                                                                       │
                                               ONLY `new` ids ─────────┘
                                                       │
                                                       ▼
                                          flagged needs_projection
                                                       │
                                                       ▼
                              Familiar prompted to PROJECT those items only —
                              the single Familiar-facing effect of ingestion.
                              An unchanged re-sync prompts NOTHING.

  OUTBOUND (Familiar-initiated, deterministic)
  Familiar pokes Unruh with a node id ──▶ Unruh emits .ics file + "add to Google"
  link ──▶ delivered to the human. (Advanced: gogcli/gcalcli write it to Google.)
```

> ⚠️ **The anti-clog rule (learn from the memory-queue pile-up).** The projection
> cue is fed **only the `new` ids from the code-level change classification** —
> never the whole calendar, never re-evaluated item-by-item by the LLM. A sync
> that changes nothing prompts nothing; a sync that adds one event prompts for
> that one event. This is the exact same discipline as the `dayDelta` fix that
> stopped the consent queue re-minting already-known facts: **change detection is
> code-gated, not LLM-gated.** Updated / unchanged / removed items never feed the
> cue (§4).

### 1.1 The shared contract: a normalized event

Both source adapters produce the same shape; Unruh maps that shape to a node.
This is the single seam — defined once, in Unruh, so calendars are never parsed
in two places.

```jsonc
{
  "uid":         "abc123@google.com",   // stable Google UID — the idempotency key
  "summary":     "Dentist",
  "start":       "2026-07-02T14:00:00Z", // ISO-8601 UTC
  "end":         "2026-07-02T14:45:00Z", // or null (open-ended)
  "all_day":     false,
  "recurrence":  { "freq": "weekly", "interval": 1, "byweekday": [2] }, // or null
  "location":    "12 High St",
  "description": "bring referral letter",
  "status":      "confirmed",            // or "cancelled"
  "last_modified": "2026-06-20T09:00:00Z"
}
```

### 1.2 Mapping to a node (in Unruh)

- `type = 'event'` (Google entries are appointments, not Proto-Familiar tasks).
- `when = start`, `end = end`, `label = summary`.

> **Timezone — the seam.** Unruh is **local-naive internal** (`when_ts`/`end_ts`
> are the ward's local wall-clock, no offset — see `docs/unruh-design.md`). iCal
> times arrive as real UTC/offset-bearing instants (the `…Z` above), so they MUST
> be converted to local at this seam: `add_node`/`to_local_naive` already does
> this on the inbound write, so passing the iСal value straight through is
> correct. **Outbound** (§2) is the mirror — when the Familiar exports a node, the
> local-naive `when_ts` is converted UP to a real UTC/offset value for the `.ics`
> (`DTSTART`) and the Google-render URL, because external calendars require a true
> instant. So the only timezone conversions in the whole feature live at this one
> external boundary, in code, both directions — never the model.
- `payload`: `source: 'gcal'` (marks it externally-managed — legibility +
  reconcile scope), `gcal_uid: uid` (idempotency key), `gcal_last_modified`
  (skip no-op updates), `recurrence` (mapped RRULE, §1.4), `location`,
  `description`, `all_day` (for the formatter), and `needs_projection: true`
  **set only on first insert** (§4).

### 1.3 Upsert = full-snapshot reconcile, keyed by `gcal_uid`, classifying each item

The iCal feed is a complete snapshot, so `gcal_ingest` reconciles the whole
gcal-sourced set in one shot and **returns the change classification** the loop
needs:

- **uid not seen before** → `add_node`, set `needs_projection` → **`new`**.
- **uid exists, `last_modified` advanced** → update `when/end/label/payload`
  in place (keep the node id, keep any consequence edges the Familiar authored,
  keep `needs_projection` as-is) → **`updated`**.
- **uid exists, unchanged** → no-op → **`unchanged`**.
- **`status: cancelled`, or a previously-seen uid absent from this snapshot** →
  deleted in Google → `resolve(node, 'cancelled')` (keeps the record + any
  consequence learning; do **not** hard-delete) → **`removed`**.

Returns `{ new: [...ids], updated: [...], removed: [...] }`. Only `new` reaches
the cue.

> ⚠️ **Deletion reconcile fires ONLY on a confirmed-good full fetch.** A failed
> or empty fetch is a no-op, never "the snapshot is empty, so cancel
> everything." This is the single most important robustness rule inbound.
> Windowed/partial reads (a gogcli/gcalcli read covering only the next N days)
> pass `reconcile_deletes: false` so they can't cancel events outside the window
> they fetched.

### 1.4 Recurrence (RRULE → `payload.recurrence`)

Map the subset `recurrence.js` understands: `FREQ` → `freq`, `INTERVAL` →
`interval`, `BYDAY` → `byweekday` (MO=0…SU=6), `BYSETPOS` → `bysetpos`. One
series = one anchor node.

For RRULEs outside that subset (multiple `BYxxx`, heavy `EXDATE`, odd
`BYMONTHDAY` sets): **don't silently drop them.** Expand the **next N
occurrences** as individual `event` nodes, each with a **stable synthetic uid**
`"<uid>#<YYYY-MM-DD>"` so the next sync reconciles them idempotently (they're
re-expanded every sync and matched by that uid — no duplication, no drift), and
`log()` that the rule was too complex to map as a series.

**N is occurrence-horizon based, not tied to the sync interval** (they're
different axes — sync cadence is *how often we re-read*, N is *how far ahead we
materialise an un-mappable series*). Propose **N = occurrences within the next 90
days**; each hourly sync refreshes the horizon forward. (Tunable.)

### 1.5 The source adapters (in Node — fetch only; **decided**)

Network and secrets stay in Node, consistent with every other adapter
(websearch, the Discord token); Unruh stays pure parse-and-store (unit-testable
with fixture `.ics` strings, no network in Python).

- **Link adapter (out-of-the-box):** `fetch(icalUrl)` → raw `.ics` text →
  `gcal_ingest(ics_text=…)`. Unruh parses VEVENTs → normalized events → upsert.
  **Parser: a small hand-rolled VEVENT reader** (an `.ics` is line-folded
  `KEY:VALUE` with `BEGIN/END:VEVENT` blocks) — zero new Python dependency for
  the common subset, with the §1.4 fallback for the rest. Revisit only if real
  feeds break it.
- **gogcli adapter (advanced):** gogcli is Google's fuller Workspace CLI — it
  authenticates once and can reach more than the calendar. **This milestone uses
  only its calendar surface**, normalised in Node → `gcal_ingest(events=[…])`,
  same upsert. (Opening the door to later Workspace surfaces — Gmail, Drive — is
  a future milestone, explicitly out of scope here.)
- **gcalcli adapter (advanced, lighter alternative):** for a ward who wants
  calendar-only without the full Workspace tool, `gcalcli` is the lighter option.
  Same normalised-event output → same `gcal_ingest`. gogcli and gcalcli are
  **interchangeable adapters behind the one seam** — the ward picks whichever
  suits them; neither forks the pipeline.

Authenticated reads that cover only a forward window pass
`reconcile_deletes:false` (§1.3).

### 1.6 The sync loop (`gcal-sync-loop.js`, Node)

A thin loop on the established singleton/supervisor pattern (mirror
`reachout-loop.js` / `memory-sweep-loop.js`):

- **Default cadence: hourly**, with a Settings control to widen or tighten it.
  Rationale: an hour is tight enough to catch a ward who re-plans through the day,
  while a ward whose same-day plans rarely move can widen it. (Heavy users tighten;
  light users widen; one hour is a sane floor for both.)
- Reads the iCal URL / gogcli|gcalcli config from settings; if none configured,
  idles.
- Calls the source adapter → `gcal_ingest` → gets `{new, updated, removed}`.
  Routes **only `new`** into the projection cue (§4).
- **Off-switch in the same commit:** env `PROTO_FAMILIAR_GCAL_DISABLED=1` **and**
  a Settings toggle ("Google Calendar sync"). A 30-s supervisor follows the
  toggle + config the way the Discord supervisor does, so changes apply without
  a restart.
- **Degrades silently:** a fetch error, bad URL, or parse failure is logged
  loudly, never surfaced in chat, never touches other loops, and **never
  reconciles deletions** (§1.3).

---

## 2. Outbound — Unruh → human (deterministic, Familiar-initiated)

### 2.1 The export tool (the "Familiar never types the link" requirement)

A new Unruh MCP tool, `schedule_export(id)`, returns artifacts built **in code
from the node's stored fields**:

```jsonc
{
  "ok": true,
  "ics":        "BEGIN:VCALENDAR…BEGIN:VEVENT…END:VEVENT…END:VCALENDAR",
  "google_url": "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Dentist&dates=20260702T140000Z/20260702T144500Z&details=…&location=…"
}
```

> **Local → UTC at export (mirror of §1.2 ingest).** The node's `when_ts`/`end_ts`
> are local-naive; external calendars need a real instant, so `schedule_export`
> converts UP to UTC in code when emitting the `.ics` `DTSTART`/`DTEND` and the
> `dates=…Z` of the Google-render URL (using the server's local offset — the same
> tz the times were stored in). Still no model arithmetic: the Familiar passes an
> `id`; Unruh does the local→UTC formatting.

- The Familiar calls it with a node `id` from the `[schedule ids]` legend it
  already reads, and gets back a correct link/file. It never assembles the URL or
  the date math. (Operability: the only input — the `id` — is already in a
  surface the Familiar has.)
- **Source-independent:** export works on *any* Unruh node, even one the human
  added by hand with no Google config at all. Always available, gated by nothing.

### 2.2 Delivery

- **Web chat:** `GET /api/schedule/:id/export.ics` (calls Unruh, streams the
  `.ics` as a download) so the Familiar's message carries a real download link;
  the `google_url` is a clickable link. The tool result returns both; the UI
  renders them.
- **Discord:** attach the `.ics` and/or post the `google_url`.
- Apply `stripLlmTimestamps` to anything the Familiar *says* around the link —
  the machine-built link/file is exempt.

---

## 3. The exact-values principle (the spine — why everything above is shaped this way)

> The Familiar is never the source of an exact string or number that has to be
> machine-correct. Dates, durations, UIDs, URLs, `.ics` bytes, RRULEs — all
> generated by Google or by Unruh's deterministic code. The Familiar references a
> node by `id` and *talks about* it; it never *constructs* the artifact.

Same principle as stripping hallucinated `[HH:MM]` timestamps, and the same
answer to the "LLMs are bad at exact math/certainty" worry: don't put the model
on the hook for values it can't reliably produce.

---

## 4. The projection prompt — change-gated, code-silenced, "and that's it"

When ingestion produces **new** nodes, the Familiar is prompted into the
**projection step only** — author both futures (`on_resolve` + `on_lapse`) via
`schedule_link`. No task-nagging, no care-check, no "do this now." An ingested
appointment is an `event`, not a Proto-Familiar `task`, so it never enters the
surface-candidates pipeline; the projection cue is the *single* Familiar-facing
consequence of ingestion.

### 4.1 What feeds the cue (code gate — this is the anti-churn guarantee)

- **Only `new` ids** from §1.3's change classification. Updated / unchanged /
  removed items **never** enter the cue. A moved event's existing projection just
  carries forward (the Familiar sees the new time in `[Temporal Context]`
  anyway); re-examining a moved event's projection is **not** a default behaviour
  — that would be exactly the "call the LLM to say 'nah, still fine'" churn we're
  avoiding. (If ever wanted, it's an explicit opt-in, not the default.)
- Bounded to an upcoming horizon (propose next 14 days) and capped per turn, so a
  100-event first import can't flood the cue. One series = one prompt (the anchor
  node).

### 4.2 No standalone call; silence is code-aged, not LLM-decided

- The cue is **prompt-injected into chat turns that already happen** (like the
  deferred-intents / recent-ponderings blocks). It **never triggers a dedicated
  LLM request** — so it cannot "call the LLM a bunch of times to say it's fine."
  The only cost is a few extra prompt tokens on the turns an un-addressed item
  rides along.
- That ride-along is **code-bounded**: an item shows for a small number of
  turns / a short window, then **goes quiet on its own** whether or not the
  Familiar acted. Projection is best-effort enrichment, not a mandatory task —
  an item aging out un-projected is fine and costs nothing further. No "nah it's
  fine" acknowledgement call is ever required to silence it.

### 4.3 Auto-clear (redundant with aging, kept as belt-and-suspenders)

- Once a node has ≥1 outgoing consequence edge (`causes` / `co_occurs_with`),
  it's been thought through → drop it from the cue immediately (pure derivation,
  no bookkeeping tool).
- An optional explicit "nothing worth projecting here" skip exists for a ward who
  wants to clear trivia by hand, but it is **not** the primary exit — §4.2's
  aging is. (Avoids the recorded "acknowledge ≠ acting" trap: the deliverable is
  the `schedule_link` calls; clearing is a *consequence* of having made them, or
  of time passing — never a substitute the Familiar can call instead of
  projecting.)

### 4.4 The cue wording (first-person, anchored to identity)

Illustrative — follow the proactivity rules (name the value of projecting, no
bias language, the Familiar's own voice):

> *New on {{user}}'s calendar, not yet thought through:*
> *— Dentist, Thu Jul 2 2:00pm  [id: …]*
> *I think two moves ahead: what does each lead to if it resolves, and if it
> lapses? I record both with `schedule_link`. Then I'm done with it **for
> now** — these are appointments, I don't need to keep chasing them.*

> Note the "**for now**": the Familiar should not internalise (or memorise) that
> a Google item is off-limits afterward. It's free to think about it, project
> from it, export it, attach more edges later — it just doesn't keep *re-raising*
> it. "Done for now" ≠ "never touch again."

---

## 5. Legibility — the Familiar can tell which items are Google's

A gcal-sourced node is externally managed: the **sync owns its `when`/`label`**,
and a delete in Google cancels it here. The Familiar needs to be able to tell —
not to treat the node as forbidden, but to know which fields aren't its to hand-edit.

- Render gcal-sourced items in `[Temporal Context]` with a marker (e.g. 📅 /
  "(from Google)") via `temporal-format.js`.
- Make the mechanical fact legible: **the next sync overwrites local edits to a
  Google item's time/title**, so hand-editing those fields just loses on
  reconcile — and a Google item isn't a `task` to `schedule_resolve`. But the
  Familiar **may and should** attach consequence edges (Proto-Familiar-side,
  never written back, never overwritten), **export** it, and reason about it.
  Framing is "the sync owns these fields," not "don't touch this node."

---

## 6. Settled choices (was "decisions to confirm" — now answered)

- **Advanced tier = gogcli (full Workspace) *and* gcalcli (calendar-only,
  lighter)** — both interchangeable behind the one upsert seam; ward picks. This
  milestone uses only their calendar surface.
- **Write-back is IN the plan, as the final step** (§7 pass 5) — the Familiar
  pushing an item to the real Google calendar via gogcli/gcalcli `add`. Kept
  explicit + confirmed because it's the only path that mutates the ward's real
  calendar.
- **Node fetches bytes, Unruh parses + upserts** (§1.5) — keeps secrets/network
  where every adapter lives, keeps Unruh network-free + testable.
- **Hand-rolled VEVENT parser** for the common subset + the §1.4 expansion
  fallback (§1.5).
- **Hourly sync by default, ward-configurable** (§1.6).
- **Recurrence fallback N = next-90-days of occurrences**, independent of the
  sync interval, refreshed each sync via stable per-occurrence uids (§1.4).
- **Projection horizon 14 days, per-turn cap** (§4.1).

---

## 7. Build order (passes, all under 0.8)

1. **Inbound link tier:** normalized-event contract + Unruh `gcal_ingest` (parse
   + UID upsert + change classification + confirmed-fetch-only reconcile) with
   fixture-`.ics` tests; the Node link adapter + `gcal-sync-loop.js` + off-switch
   + Settings toggle (incl. interval control); `source:'gcal'` legibility in the
   formatter.
2. **Outbound export:** Unruh `schedule_export` (+ tests on the generated
   `.ics`/URL), the download endpoint, thalamus wrapper, the Familiar-facing tool
   in cerebellum (first-person), Discord delivery.
3. **Projection cue:** the code-gated `new`-only selector + horizon/cap +
   change-driven flagging + aging-based silence + auto-clear; wire the loop's
   `new` ids in.
4. **Advanced read tier:** gogcli adapter (calendar surface) + gcalcli adapter,
   same upsert; Settings gate; CLI-installed/authed detection.
5. **Write-back (final):** push an Unruh node to Google via gogcli/gcalcli `add`,
   explicit + confirmed (the only path that mutates the real calendar).

Each pass: tests alongside, `docs/architecture.md` updated in the same commit,
off-switches shipped with their loops, no version bump until the milestone lands
as `0.8.0-alpha`.

---

## 8. Out of scope

- Two-way *sync* of arbitrary edits (we read Google; we push back only the
  explicit §7-pass-5 write-back gesture). Unruh is not a calendar server.
- Broader Google **Workspace** surfaces (Gmail, Drive) — gogcli makes them
  *possible later*, but this milestone is calendar-only.
- Non-Google providers — the normalized-event seam (§1.1) would let an
  Outlook/CalDAV adapter slot in behind `gcal_ingest`, but not this milestone.
- Familiar-driven *editing* of Google events — it references, projects, and
  exports; it doesn't reschedule the ward's dentist appointment in Google.
