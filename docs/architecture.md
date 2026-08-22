# Architecture

> **Keep this current.** When component responsibilities, data flow,
> or the prompt-assembly order changes in code, update this doc in
> the same commit. CLAUDE.md mandates it because architecture
> drift is a top driver of "future-me has no idea why X" bugs.

## Overview

Proto-Familiar is a Node.js application — a thin Express server +
vanilla-JS single-page frontend — that surfaces a persistent AI
companion (the Familiar) bonded to one human. It is an **embodiment**
of the same entity held in **Phylactery** — the in-tree
canonical store (Phylactery milestone complete as of 0.6.x); see
[CLAUDE.md](../CLAUDE.md#entity-as-subject--the-design-value-under-everything)
and the [Psycheros PHILOSOPHY.md](https://github.com/PsycherosAI/Psycheros/blob/main/PHILOSOPHY.md)
for the design value that everything below descends from.

The server's responsibilities:

1. **Proxy LLM requests** so the user's API key never leaves localhost.
2. **Enrich every request** with cognitive-module context: identity +
   memory + graph from Phylactery, temporal context + ponderings +
   care-check framing from Unruh + the caring-spine modules.
3. **Run autonomous loops** for the proactive surfaces — pondering,
   reminders, silence-triage — that fire without a human request.
4. **Persist** session logs, Tomes, ponderings, outbox items,
   threat state, last-activity.

```
Browser (public/)
    │
    │  HTTP + SSE  + /api/outbox polling for proactive deliveries
    ▼
server.js  (Express, Node 22+, ESM)
    │
    │  ── cognitive bridge (per-request enrichment, INWARD) ────────
    ├── thalamus.js       ──►  Phylactery  (Python via uv, stdio MCP) — identity / memory / graph / snapshots
    │                     ──►  Unruh       (Python via uv, stdio MCP) — schedule / interests / handoff / intentions / routine
    │
    │  ── motor module (action + delivery, OUTWARD) ───────────────
    ├── cerebellum.js       ── tool registry + executors + tool-call loop,
    │                          triage deliberation, trusted-contact delivery,
    │                          escalation deadlines (uses thalamus's wrappers
    │                          for every MCP write — never its own connection)
    │
    │  ── caring spine (per-request + autonomous) ─────────────────
    ├── crisis-signals.js   ── pattern detector run on each user msg
    ├── threat-tracker.js   ── decaying scalar, persistent, audit history
    ├── recent-ponderings.js── read recent free-cycle thoughts into chat
    ├── pondering.js        ── one-shot ponder primitive (LLM call → tome entry)
    ├── pondering-loop.js   ── autonomous: wakes on cadence, ponders
    ├── reminders-loop.js   ── autonomous: fires due reminders into outbox
    ├── silence-triage-loop.js ── autonomous: LLM-deliberated check-ins
    ├── reachout-loop.js    ── autonomous: warm non-crisis outreach
    ├── reachout.js         ── warm-outreach decision (ward + warm villagers)
    ├── outbox.js           ── persistent delivery queue (reminders, triage, alerts)
    ├── last-activity.js    ── timestamps user activity for the silence loop
    ├── wait-streak.js      ── wait-streak experiment: counts deliberated waits since last proactive act
    ├── contact-baselines.js ─ derives normal contact rhythm (median/p90 gaps) from session logs
    ├── noticing.js         ── the Familiar's own turn: wake conditions + situation report + prompt + tick
    ├── noticing-loop.js    ── autonomous: drives the noticing tick, self-paced (Initiative Pass 4)
    │
    │  ── village (audience gating + external presence) ───────────
    ├── village.js          ── registry: categories/grants, villagers, locations
    ├── audience.js         ── grant resolution + section-marker gate (V3)
    ├── discord-gateway.js  ── autonomous: bidirectional Discord presence (V4); per-location presence modes strict/lurk/active + mention legibility + readBots (V8); deferred presence [later:…] revisit queue (V9)
    │
    │  ── classical infrastructure ──────────────────────────────
    ├── memorization.js     ── autonomous per-fact memorization queue + worker (Pillar C)
    ├── outgoing-filter.js  ── Pillar D: post-response semantic gate before delivery
    ├── temporal-format.js  ── pure renderer for Unruh's payload
    ├── providers.js        ── shared chat-completions URL map
    │
    ├── logs/               session JSON files (git-ignored)
    └── tomes/              per-Tome JSON files + state caches
        ├── .memorization-queue.json   (git-ignored)
        ├── .consent-pending.json      (git-ignored) — pending consent IDs for Phylactery
        ├── .threat-state.json{,.tmp}  (git-ignored)
        ├── .outbox.json{,.tmp}        (git-ignored)
        └── .last-activity.json{,.tmp} (git-ignored)
```

Thalamus is a **plural-peer mediator**: each cognitive module is a
separate stdio MCP child spawned at boot. Failures degrade
independently — Phylactery down doesn't take Unruh out, and vice
versa — and `enrich()` fans out across whichever peers are live
via `Promise.allSettled`. Empty sub-blocks render as nothing in the
prompt; the LLM only sees scaffolding when there's content.

The **caring spine** modules are not MCP children — they are
Node-side modules that read from / write to Unruh and the local
state files. They run alongside the chat path (detection,
ponderings injection, care-check framing) and as background loops
(pondering, reminders, triage).

## File Structure

```
/
├── server.js                Express server — chat proxy, all HTTP endpoints, autonomous-loop boot
├── thalamus.js              MCP bridge — Phylactery + Unruh, plus all the helper wrappers. MUTATING wrappers read results honestly via `unruhResult` / `mcpToolError` (phylactery-result.js): the SDK's callTool does NOT throw when a tool raises (it resolves isError:true), so a wrapper that just returned `{ok:true}` reported success on failure — the silent-write class behind the identity_update_section bug. Reads deliberately still degrade to empty (absence renders as absence). `saveBookmark` is the M8 write side (→ interest_bookmark), feeding the resurfacing loop
├── cerebellum.js            Motor module — tool registry + executors + tool loop, triage deliberation, trusted-contact delivery, escalation deadlines
├── crisis-signals.js        Pattern-based detector — 5 tiers, ~13 signal categories, damping
├── threat-tracker.js        Decaying scalar with audit history, off-switches, file persistence
├── spine-states.js          Temporal-bridges Pass A — the caring spine mints graph citizens. On a live ward turn `enrich()` fire-and-forgets `syncSpineState`: threat crossing into moderate+ mints a ward-private `state` node (`payload.spine`) for the hard stretch so it becomes relatable to schedule events (the missing causal middle); falling back below closes it at the code-derived decay-crossing instant (`decayCrossingMs`, same half-life as the tracker) and derives `co_occurs_with` edges to overlapping schedule items (arithmetic, capped/deduped, recurring anchors linked once). All machine values code-derived; never moves the tier / gates nothing / delays no triage. Villager privacy is structural + fail-closed: `isSensitiveNode` + `stripSensitiveScheduleNodes` (gated-turn context) + the `schedule_find` filter hide `spine`/`sensitive` nodes from every non-ward surface. Open-episode pointer in `tomes/.spine-episode.json`. Off: `spineStatesEnabled` (default ON) + `PROTO_FAMILIAR_SPINE_STATES_DISABLED=1`. Pure helpers unit-tested; MCP wrappers injected by the call site (no thalamus cycle)
├── pondering.js             Pure `ponderOnce()` primitive — LLM call + tome write
├── pondering-cadence.js     Tiered interval formula + threat multiplier + user-stretch scale
├── pondering-loop.js        Autonomous singleton loop; integrates with cadence + isEnabled gate
├── reminders-loop.js        Autonomous singleton loop; polls Unruh for due reminders
├── silence-triage-loop.js   Autonomous singleton loop; LLM-deliberated proactive check-ins
├── reachout-loop.js         Autonomous singleton loop; warm non-crisis outreach (companionship). Stands down at moderate+ threat (triage owns distress); quiet-hours + cooldown gated
├── tome-graduation-loop.js  Autonomous singleton loop (Phase 4, opt-in/default-OFF); drains durable facts stranded in tomes into Phylactery (identity + memory + graph; relational facts resolve-or-create nodes + dedup edges). Pure logic in tome-graduation.js. Code-gated candidates → one batched LLM judgment (Phase-3 rubric; leans toward graduating — consolidation back-end prunes over-gathering) → route via thalamus wrappers (ward memory consent-gated) → tidy only after confirmed route (delete/pointer). Off-switch PROTO_FAMILIAR_TOME_GRADUATION_DISABLED=1; distinct from Pillar H (identity→RAG); per-tome opt-out `graduationExempt` (0.8.106): ward-toggleable in the Tomes modal, stamped on runtime tomes at creation, exposed via GET/PATCH /api/tomes — the name-exclusion list stays as belt-and-suspenders
├── content-regate-loop.js   Autonomous singleton loop (ward-disclosure Phase B, opt-in/default-OFF); the Familiar reviews EXISTING ward-private ward-self memories and, with a batched judgment, opens the ones that may be content-gated (`audience → ward-content-gated`, optionally correcting the coarse backfill `content_tag`) while keeping the rest private. Pure logic in content-regate.js. Conservative (parser fails closed to keep); code-selects candidates (memory_list_content_gate_candidates — ward-private + no third-party subject only, never touches a third-party fact); reviewed-tracker judges each once; every opening writes a `[DISCLOSURE NOTICE]` (enrich(), ward-visible) settled by `disclosure_acknowledge` / reverted by `keep_memory_private`. Off-switch PROTO_FAMILIAR_CONTENT_REGATE_DISABLED=1 + "Review my private notes for content-sharing" toggle
├── content-regate.js        Pure Phase-B logic: selectBatch / parseRetagDecision (fail-closed) / summarizeCircles / buildRetagPrompt + injectable runOneRetagTick; reviewed-tracker (tomes/.content-regate-reviewed.json) + disclosure notices (tomes/.disclosure-notices.json)
├── needs-tracking-loop.js   Autonomous singleton loop (Pass 2, opt-in/default-OFF); marks a recurring need-window's occurrence `missed` once its [when,end] elapses unresolved (builds the needs-fulfilment ledger). Pure selection in needs-tracking.js. Stands down at moderate+ threat (never competes with triage); only the LAPSE is made factual — projected consequence edges are untouched. Off-switch PROTO_FAMILIAR_NEEDS_TRACKING_DISABLED=1
├── needs-tracking.js        Pure Pass-2 logic: isNeedWindow / selectMissedOccurrences / summarizeNeedsForDay (the live "Needs today" view)
├── gcal-sync-loop.js        Autonomous singleton loop (0.8, opt-in/default-OFF); ward-configurable cadence (hourly default). Each due tick: fetch the iCal feed (gcal-source.js) → Unruh gcal_ingest (parse + reconcile + change-classify) → route ONLY `new` ids to the projection cue. Fetch/parse failure degrades silently and NEVER reconciles deletions. Off-switch PROTO_FAMILIAR_GCAL_DISABLED=1 + "Google Calendar sync" toggle
├── gcal-source.js           Inbound FETCH half (Node owns network + the iCal URL): normalizeIcalUrl (webcal→https) + fetchIcal (timeout, ok:false on any failure, rejects non-iCal bodies so an auth wall can't read as "empty calendar"). Advanced tier (§1.5): fetchViaCli runs a ward-configured authenticated command (gogcli/gcalcli presets, overridable) that emits `.ics` (reuses Unruh's parser) or JSON (normalizeCliEvents) — a windowed read, always reconcileDeletes:false; detectCli probes installed/authed. Write-back (§7-5, the ONLY path that mutates the real calendar): pushIcsViaCli imports a generated `.ics` (reuses icalwrite — code builds it, never the model) through the ward's import command (ADD only) — gated behind the `schedule_push_to_google` tool's opt-in. Unruh stays parse-only/network-free
├── gcal-attribution.js      Calendar attribution (multi-calendar, 0.8.22) — every synced calendar (a Google calendar, an iCal feed, a CLI calendar) is an attributable SOURCE. resolveAttribution(cal, map) → {kind: ward|villager|phylactery|unassigned|ignore, ref, label}: an unmapped primary defaults to the ward, others to unassigned (still synced, labeled by name), `ignore` skips. wardCalendarId picks the calendar that adopts legacy rows. The map is ward state (settings.gcalCalendarAttribution keyed by calendar id); the discovered-calendars cache (tomes/.gcal-calendars.json) is what the sync last saw. normalizeAttributionEntry validates a set. Pure helpers + never-throwing state I/O
├── gcal-sync-loop.js        Autonomous singleton loop (0.8, opt-in/default-OFF); ward-configurable cadence (hourly default). Each due tick fetches PER-CALENDAR snapshots and ingests each independently — one bad calendar never blanks the others; the tick succeeds if ≥1 calendar ingested. Each snapshot carries {calendarId, events|icsText, reconcileDeletes, includeLegacy, attribution} → Unruh gcal_ingest (parse + reconcile + change-classify, SCOPED to that calendar) → route ONLY `new` ids to the projection cue. Back-compatible with a single top-level snapshot. Fetch/parse failure degrades silently and NEVER reconciles deletions. Off-switch PROTO_FAMILIAR_GCAL_DISABLED=1 + "Google Calendar sync" toggle
├── gcal-source.js           Inbound FETCH half (Node owns network + the iCal URL): normalizeIcalUrl (webcal→https) + fetchIcal (timeout, ok:false on any failure, rejects non-iCal bodies so an auth wall can't read as "empty calendar"). Advanced tier (§1.5): fetchViaCli runs a ward-configured authenticated command (gogcli/gcalcli presets, overridable) that emits `.ics` (reuses Unruh's parser) or JSON (normalizeCliEvents) — a windowed read, always reconcileDeletes:false; detectCli probes installed/authed. Write-back (§7-5, the ONLY path that mutates the real calendar): pushIcsViaCli imports a generated `.ics` (reuses icalwrite — code builds it, never the model) through the ward's import command (ADD only) — gated behind the `schedule_push_to_google` tool's opt-in. Unruh stays parse-only/network-free
├── gcal-google.js           Native Google Calendar (0.8.1; multi-calendar 0.8.22): OAuth (parseCredentials, buildAuthUrl, exchangeCode, refreshAccessToken, getFreshAccessToken) + Calendar API (listCalendars enumerates the account's own AND shared-in calendars; listEvents(calendarId) windowed/showDeleted/paginated, insertEvent ADD-only write-back) + gitignored token store. SCOPE widened to calendar.events + calendar.readonly so shared calendars can be enumerated/read (existing users reconnect once; hasCalendarListScope tells the UI). normalizeGoogleEvents(items, calendarId) stamps each event's source calendar. buildEventResource sends local time + IANA zone. publicStatus redacted; status reports sharedScope Every network call takes an injectable fetchFn. normalizeGoogleEvents reuses the shared normalizer; buildEventResource sends local time + IANA zone and lets Google do local→instant. publicStatus is redacted (never leaks tokens). Replaces the CLI for the authenticated path — no terminal
├── gcal-projection.js       The projection cue (gcal §4, generalized by the causal-chain fix 0.8.107): gatherProjectionCandidates unions Unruh's `gcal_projection` feed with ANY bare upcoming event in the briefing window (unresolved, no consequence edges, ≥6h runway — hand-added or chat-created, not just synced); pure selectCueItems (per-turn cap + turn/time aging + a one-shot last-chance re-surface within 48h of the event) + buildCueBlock (first-person, literal "my human"); persisted aging state in tomes/.gcal-projection-cue.json. Rides chat turns (no standalone request); auto-clears when a node gains a consequence edge. Injected as a dynamic block in thalamus enrich()
├── weather-source.js        Weather FETCH half (W-A; Node owns the network, the gcal precedent): geocode(query) resolves a city/ZIP ONCE at location-entry → {lat, lon, place_name, timezone} (Open-Meteo keyless geocoding); fetchForecast(lat, lon) is the 6-hourly refresh, walking the provider chain until one returns, stamping a location-local-naive `fetched_at`. fetchFn/now injectable for tests; total failure → {ok:false} (caller keeps the stale cache, the [Now] line simply drops). Coordinates go to the API only — the model never sees them
├── weather-providers.js     Provider adapters (W-A, mirrors websearch-providers.js): fetchOpenMeteo (primary, keyless, timezone=auto→local times) + fetchMetNorway (fallback, keyless, symbol_code→WMO, m/s→km/h, UTC→local via utcToLocalNaive using the location's stored zone). Both normalise to one internal shape {provider, current, hourly[]}; PROVIDER_CHAIN orders them
├── weather-format.js        Weather PURE formatters (W-A + W-B; the exact-machine-values rule — code speaks the words, never the model): WMO code→words, qualitative bands (tempBand/precipBand/windBand), precipTransition (12h lookahead), buildNowWeatherLine → "Weather where my human is: 6°C (cold), light rain, easing off around 17:00." **W-B additions:** weatherArc (today+tomorrow morning/afternoon/evening + notable turns, from the hourly array's own local-naive date/hour prefixes — no tz math), forecastAtHour + isAdverseHour (adverse code / likely-and-wet / temp extreme / strong wind — the outside-join + severe-alert gate), formatItemWeather (a compact per-item clause), formatWeatherVague (§5.6: qualitative-only, no numbers/units/times/labels). The HONESTY rule lives here: a forecast older than WEATHER_STALE_MS (12h) yields '' (the line drops rather than lie), as does any missing/garbage field. **°C/°F toggle (`weatherUnit` setting, 'celsius'|'fahrenheit', default celsius):** `formatTemp(c, unit)` is the ONE place the conversion happens — the model never converts (exact-values rule again, applied to units). `tempBand(c)` stays Celsius-internal always, so switching display units never shifts a "cold"/"mild" read. Every number-bearing renderer (`buildNowWeatherLine`, `formatItemWeather`, `weatherArc`'s day-part descriptions) threads `unit` down to `formatTemp`; `formatWeatherVague` (no numbers/units at all) is untouched — nothing to convert. Callers (weather-mirror.js, cerebellum.js's `weather_today` tool, event-alerts.js's weather-alert text, stewardship.js's readiness weather note, server.js's `[Now]` block + noticing deliberation) read `settings.weatherUnit` and pass it down; the vague/gated tier needs no unit
├── weather-service.js       Weather GET-OR-FETCH seam (W-B; coordinates stay Node-side): resolveLocation (by ward label or current, from the Node-only private shape), getForecast (cache-first; fetches on demand when absent/stale/a needed date is beyond the ~48h cache — Open-Meteo reaches 16 days — then ingests to warm the cache; degrades to the stale cache on a fetch failure), dayDatesFor (location-local today/tomorrow via wardLocalNowISO). Backs weather_today + the outside-join
├── weather-mirror.js        Weather READ-mirror (W-A; the last-activity.js precedent): writeWeatherMirror/clearWeatherMirror keep tomes/.weather-now.json in sync so the hot [Now]-block path reads synchronously. readWeatherNowLine (the ONE call buildTimeAnchorBlock makes on a ward-private turn — takes `unit` and threads it to buildNowWeatherLine) + readWeatherVagueLine (W-B; the gated-turn line, qualitative only, no unit needed) — both sync, never throw, honour the env off-switch + staleness. weatherEnabled(settings) is the one shared gate (env off-switch + default-ON toggle), imported by cerebellum/thalamus/server so every surface reads it identically
├── reachout.js              Warm-outreach decision: getWarmVillagers (relationToFamiliar==='warm' + reachable), buildReachoutPrompt (warm-framed, not crisis), decideReachoutViaLLM
├── outbox.js                Delivery queue (reminders / triage / reachout / relay / outbound_alert), dedup on originId
├── updater.js               Git-based self-update (0.8.86): checkForUpdate/applyUpdate against origin/<branch> read live from git (repo/branch-agnostic — fork now, upstream later). Pure git, no GitHub API. Refuses on a dirty tree; restart-to-run. Off-switch PROTO_FAMILIAR_UPDATE_DISABLED=1
├── last-activity.js         Tiny persistent "user last typed at" timestamp
├── wait-streak.js           Wait-streak experiment (Pass 1): deliberated-wait counter + the neutral prompt fact line
├── contact-baselines.js     Contact-rhythm baselines (Pass 2): median/p90 gaps per weekday-class; the warmth rhythm line
├── recent-ponderings.js     Read recent pondering tome entries for in-chat reference
├── interest-picker.js       Weight-proportional sampler for the pondering loop
├── relative-time.js         Natural-English relative phrasing for every timestamped surface (memories, ponderings, schedule, handoff, "Now")
├── recurrence.js            Recurrence-rule expansion — turns one "weekly cleaning" anchor into occurrences within the temporal window
├── temporal-format.js       Pure renderer for the Unruh temporal_context payload
├── media.js                 Media store (vision build spec §2, Pass 1–2) — content-addressed image persistence in media/ (sha256 bytes + `.json` meta + `.slugs.json` index). saveAsset (dedup free — same bytes = one asset), getAsset/getAssetMeta, setAssetDescription (also upgrades a generic `img-xxxx` slug to a meaning-bearing alias once described), listAssets/deleteAsset, resolveAssetId (slug/sha → sha, index + meta-scan heal). **Pass 2 picture→node linking (§6.5):** addAssetLink/removeAssetLink (links[] on meta, deduped by nodeId — bytes stay local, the link is an embodiment-local annotation), assetsForNode ("show me what Milkyway looks like"), and buildStandin names linked nodes ("— of Milkyway —"). drainPendingImages (§10 — view_image's stash → a user image message for the next tool round; lives here so both tool loops call it without a cerebellum↔vision cycle). Caps at save (MEDIA_MAX_BYTES 6MB, image mime allow-list). Pure-code readImageSize (JPEG/PNG/GIF/WebP headers, no native lib). buildStandin + contentWithStandins (§6/§7). Never throws into a caller. Off via PROTO_FAMILIAR_VISION_DISABLED=1 — inert until an image arrives
├── zai-vision.js            z.ai coding-plan vision (0.9.5) — on the GLM Coding Plan, vision is NOT on the chat endpoint; it's a separate "Vision Understanding" MCP server (@z_ai/mcp-server, GLM-4.6V) with its own quota pool. This module lazily spawns that server as a stdio MCP child (keyed by API key, env Z_AI_API_KEY + Z_AI_MODE=ZAI), discovers its analyze_image tool + schema (pickAnalyzeTool/buildAnalyzeArgs adapt to whatever it names its image param — path/url/base64 — writing a temp file only when a path is wanted), and describeViaZaiVision() returns the description text. describeAsset (vision.js) routes here when the resolved vision connection is provider 'zai-coding' — so a coding connection assigned to the vision feature spends the coding vision allotment (describe-only; the coding chat models can't take live image parts). Graceful: any spawn/call failure → {ok:false}, description stays null. Off: PROTO_FAMILIAR_ZAI_VISION_DISABLED=1
├── vision.js                The provider boundary (vision build spec §3, Pass 1–2) — the ONE seam turning media references into provider content-parts. materializeAttachments(apiMessages,{connection,settings,visibleAudiences}) → live `image_url` data-URL parts (capable + within the live budget, newest-first) OR a text stand-in appended to the content STRING (otherwise); returns `stoodInUndescribed` ids so the chat path can background-describe them; a request with no attachments is returned identical, and the internal `attachments` field is stripped from every outgoing message. Audience gate first, fail-closed (a ward-private asset contributes nothing on a gated turn). Capability (§3.1): per-connection `visionCapable` tri-state ('yes'/'no' the ward's word; 'auto' → cache tomes/.vision-capability.json, then a TIGHT name allowlist `looksVisionCapable` — recognised vision families ride live and self-confirm, everything else defaults BLIND → described, never sent an image it may not see. This replaced a blanket "optimistic = capable" that let a text-only primary hallucinate a photo it never saw). isModalityError classifies a modality rejection for the mid-turn hard fallback. **Blind-image confabulation guard:** when any image stands in with NO description (a describe failed), the seam injects a hard system line — the Familiar never describes/guesses/names what's in an unseen image (`blindImageStandins`). **Pass 2:** describeAsset (look-once-keep-forever — resolveVisionConnection picks a capable connection via connectionForFeature('vision')→primary→first-capable; one callProviderChat with the image as a data-URL part; the result is injection-guarded THEN cached via setAssetDescription, never regenerated). **Image→threat scoring (0.9.2, ward-signed §15.1):** scoreImageDescriptionThreat scores the ward's OWN image's DESCRIPTION with the ward's scoreMessage and feeds recordThreat(source:'vision') — FULL weight, RAISE-ONLY, ward-private only; crisis-signals.js/threat-tracker.js unchanged. Fired fire-and-forget from the chat path on the ward's live turn (server.js visionThreatScoringOn gate); off-switch PROTO_FAMILIAR_VISION_THREAT_DISABLED=1
├── unruh/ templates.py      Requirement templates (stewardship Pass 2b, 0.8.20) — a `templates` table (migration 0004, keyed by obstacle tag UNIQUE, one bundle per barrier) + upsert/list/delete accessors, exposed as MCP tools template_upsert/list/delete. Storage ONLY — deliberately NOT schedule nodes, so templates never leak into the schedule window. APPLYING a template is JS orchestration in cerebellum's template_apply: reads an event's payload.obstacle_tags, matches templates, resolve-or-creates each prerequisite task (findScheduleNodes exact-label reuse of an open task, else addScheduleNode — never duplicates) and links a `requires` edge (addScheduleEdge) — SUGGESTED + prunable per instance. schedule_add_event hints (loud) when a tagged event has a matching template. Templates are the Familiar's own editable objects (no ward UI, per spec §3.2)
├── surface-context.js       Consumer pipeline — hard gates + candidate selection + block format. Consequence-aware scoring reads schedule edges (summarizeConsequences: requires/depends_on/blocks/causes → priority pressure + plain "why"). Stewardship Pass 2a (0.8.19) adds an obstacle-radar nudge: a task whose `payload.obstacle_tags` names a real barrier (e.g. "outside") gets +1 pressure and a "worth keeping on the radar" reason, so an outside-the-house errand doesn't slide under the easier tasks
├── surface-events.js        Event store (offers + outcomes) + pure-code tagger + reflection inputs
├── village.js               Village registry (V1) — categories/grant sets, villagers (name/pronouns/aliases/relation/stance/comm-style/notes/privateNotes/remember consent map/graphNodeId), locations; local mirror + Phylactery write-through sync (see docs/village-support-design.md). The Familiar reaches it via the village_lookup / village_upsert tools (privateNotes field-gated to ward-private turns)
├── own-files.js             Sandboxed read-only access to the Familiar's own checkout — resolves repo-relative paths inside the root, denies secrets (settings.json, .env) + build noise (node_modules/.git/.venv), size-caps + text-only. Backs the list_files / read_file tools (ward-private only)
├── websearch.js             Web access (opt-in, 0.7.0) — backs the look_up / web_search / read_webpage tools. look_up (0.7.19) answers definitions/facts/overviews from keyless official reference APIs (Wikipedia action API + DuckDuckGo Instant Answer API), no scraping/no setup. web_search finds pages; searchWeb resolves the human-chosen backend: webSearchBackend ∈ {basic → in-box keyless DuckDuckGo HTML scrape (no setup); api → a provider adapter (Marginalia/Tavily/Brave/Google) via webSearchApiProvider+key}. ANY backend failing falls through to the keyless floor — a wrong key / down provider never leaves the human without search. Each search logs which backend actually served (`[websearch] "q" — served via …` / `… failed […]; fell back to built-in keyless search`) so a silent fallback is visible (0.7.28). Owns the SSRF guard (scheme allow-list + resolved-IP block of loopback/private/link-local/metadata + redirect re-validation), the fetch timeout, and the linkedom→@mozilla/readability→turndown extraction with provenance stamping — the html→framed-markdown half is `extractReadable(html,{url,maxChars})`, SHARED with the browser read path (browser.js) so live-DOM and static reads produce byte-identical output. cerebellum registers the defs + delegates; gated by webSearchEnabled / PROTO_FAMILIAR_WEBSEARCH_DISABLED=1. (The managed local engines — SearXNG/4get/LibreY — were removed in 0.7.38; Marginalia + APIs + the floor cover the same ground without the install/spawn machinery.)
├── browser.js               Internet navigation — Pass 1 spine + Pass 2 eyes/hands + Pass 3a safety gates (docs/browser-build-spec.md; 0.11.x, opt-in/default-OFF). Pass 3a (0.11.3): site modes (`siteModeAllows` — open/blocklist/allowlist, subdomain match, fail-closed; enforced at browse_open + browseRead AND on page-TRIGGERED top-level navs via a driver route interceptor that aborts a disallowed main-frame navigation), hardened credential/payment fill refusal (autocomplete cc-*/current-password + name/inputmode heuristics in browser-lens.isProtectedField, over autocomplete/inputmode now captured by the DOM walk), and a Settings "browser activity" viewer (GET /api/browser-actions + /api/browser/status). A site-blocked read returns a DISTINCT `blocked` signal so read_webpage honours the block instead of falling through to the static floor. Pass 2 (0.11.1) adds: browse_screenshot (saves a PNG media asset, returns an id the executor pushes to _pendingImages so it rides the SAME turn on a vision-capable connection — capable-turn-gated like view_image), browse_tabs (list/switch/close), browse_history (query the audit log), and downloads→media on an act (size-cap + mime allow-list, never an executable). **read_webpage re-backing (0.11.2):** browseRead reads the LIVE JS-rendered DOM (driver.readPage → an ephemeral, cap-exempt tab → page.content()) through websearch.js's SHARED extractReadable, so browser + static output can't drift; the read_webpage executor routes here when shouldBrowserRead (browseEnabled + a browser exists + webReadBackend != 'static') and falls back to the static floor on any failure. The executor-facing browse_open/see/act/close ops: tie the engine (browser-driver.js) to the pure lens (browser-lens.js), sanitise every string leaving the lens through injection-guard, FRAME page content as Stranger-tier external speech (read, never obeyed), audit-log every action, and degrade any engine failure to a calm first-person line (never a throw into the turn). browseEnabled gate + PROTO_FAMILIAR_BROWSE_DISABLED=1. cerebellum's browse_* executors dynamic-import this (heavy engine out of the static graph); WARD-ONLY (a gated villager turn is refused). read_webpage is NOT re-backed this pass (Pass 2, spec §11).
├── browser-driver.js        The engine: lazy playwright-core (optionalDependency — server boots without it), Chromium channel-detect (findChromium: PROTO_FAMILIAR_CHROME/CHROME env → PLAYWRIGHT_BROWSERS_PATH cache → browser/pw-browsers → system installs) with a BACKGROUND auto-fetch when none is found (startChromiumFetch shells out to playwright-core's own install CLI into browser/pw-browsers — it owns the version pin + checksum; the first browse call kicks it off and returns "setting up", status() surfaces install state, a later call finds it ready — never blocks a turn), one persistent context (browser/profile, git-ignored) launched THROUGH the guarded proxy, tab registry + hard cap (browseMaxTabs), idle reaper (browseIdleMin), crash supervision, GET /api/browser/status. extractPageData runs ONE in-page DOM walk → the lens shape with a code-computed unique CSS path per node (the act-time resolver; no held ElementHandles — verified against playwright-core 1.62.1 where page.accessibility is gone). extractPageData also emits IMAGE nodes (0.11.15: img/[role=img]/named-svg/figure/canvas, named or ≥100×100, capped 40, each with a css) so the model can perceive pictures and scope a screenshot to one. act() enforces the §4.1 dialog policy (confirm defaults dismiss; on_dialog:'accept' only for a benign one) + protected-field refusal + act-time unique-match-or-error + a generation guard (a nav / DOM rebuild bumps the page generation via framenavigated; a ref from an older generation errors to a re-observe). **Page-level scroll (0.11.15):** `scroll` with NO ref moves the viewport (value up/down/top/bottom via window.scrollBy/To) to reveal below-the-fold / lazy-loaded / infinite-scroll content, then re-snapshots — distinct from `scroll` with a ref (scrollIntoViewIfNeeded). Pass 2 adds screenshot({scope}), tab ops (list/switch/close), and download capture (page 'download' → takeLastDownload).
├── browser-lens.js          The cognition layer (spec §3) — PURE, no playwright: PageData → leveled, ref'd, token-capped snapshots (outline/actions/text/full) + code-computed delta verdicts. **Refs are MEANING-BEARING slugs (0.11.14):** buildRefTable/mintRef assign each interactable a slug of its accessible name (role when unnamed), collision-suffixed (add-to-basket, quantity, button-2) via the shared slugifyLabel — the readable-slug-id law applied to page elements, so an LLM picks the right handle far more reliably than an opaque r14 (still code-minted, ephemeral, resolved by the code-held locator). **resolveTarget** powers select-by-text: browse_act may name a `target` (visible label, optional `role`) instead of a ref — exact-name→substring→slug match, unique→ref / several→candidate refs / none→re-observe; code owns disambiguation. **Images are perceivable (0.11.15):** the DOM walk emits image nodes (img/[role=img]/named-svg/figure/canvas, meaningful ones only), buildRefTable refs them, and renderSnapshot adds an `[images]` section — so the model KNOWS pictures are on the page and can `browse_screenshot scope=<image-ref>` to look at one (it reads text, not pixels, so without this it couldn't decide to screenshot). isProtectedField flags password/file/credential fields. Fixture-tested without a browser.
├── browser-proxy.js         The SSRF enforcement floor (spec §5.1) — a small in-process CONNECT proxy Chromium launches through: the SINGLE DNS-resolution point, runs websearch.js's isBlockedIp over the real connect target and pins the checked IP, so main-nav + subresources + DNS-rebinding are closed together (context.route can't see the resolved IP; a pre-goto check races a rebind).
├── browser-audit.js         Append-only audit of every browse action → logs/browser-actions.jsonl (GET /api/browser-actions). The mirror of discord-write-log.js; never throws.
├── browser-grants.js        Sovereignty surfaces (Pass 3b, spec §5.9): the autonomy-grants reader + credentials vault. readGrants() re-reads browser/autonomy-grants.json per call, requires the `acknowledgment` sentence to match ACK_SENTENCE exactly (surrounding whitespace tolerated) or every grant is false (the shipped state); returns {credentials, payments, captchas, autoSubmit, active}. readVaultEntry(name) reads browser/credentials-vault.json (site→user/secret) ONLY under a credentials/payments grant, returns {user, secret} for CODE to type — the secret never enters a prompt/log/audit; the model only ever names the entry. Both files are git-ignored AND on the own-files.js denylist so no Familiar tool can read them. Grants are logged loudly at every browser launch and surfaced in browserStatus(); browse_act stamps the grant it used on the audit entry. The fill-source decision itself is pure in browser-lens.evaluateFill (protected field → vault secret under the matching grant only; a payment field needs `payments`, a credential field `credentials`; a plain field takes model bytes and refuses a stray secret). browse_handoff hands a moment back to the ward: with a display it opens the page HEADED on the SAME profile (openHeaded closes the headless context first — one Chromium per profile — and holds a module-level `handoff` state), the ward acts + clicks "hand it back" (POST /api/browser/handback → completeHandback: close headed, relaunch headless at the same URL, now signed-in via the persisted cookies); while awaiting handback the browse ops wait (isAwaitingHandback) and a failed headed launch parks honestly. Without a display it parks + is honest (0.11.6); the [CONFIRM]-domain submit gate (browseConfirmDomains) refuses a submit-shaped act on a listed domain unless the autoSubmit grant lifts it. browseConfirmMode (0.11.5): 'refuse' (default) hands back; 'ask' HOLDS the act as a pending confirmation (driver state.pendingConfirms) the ward resolves OUT-OF-BAND via POST /api/browser/confirm (a Settings button, never a model tool arg — so a page can't talk the model into self-approving); approval resumes the stored act generation-guarded, decline drops it, and the held tool-result never claims it acted.
├── websearch-providers.js   Proper search-API adapters (0.7.20; marginalia 0.7.37) — braveSearch / tavilySearch / googleSearch / marginaliaSearch, one small JSON client each (no scraping), all returning the same {rows}|{error} shape searchWeb dispatches through (API_PROVIDERS registry). Marginalia is an INDEPENDENT small-web index whose "public" key needs no signup (API-Key header; 503 when the shared key is rate-limited). Provider hosts are sanctioned public endpoints (not the SSRF-guarded read path); missing/bad key → {error} → searchWeb degrades to the floor
├── guide-chat.js            In-modal web-search explainer (0.7.29) — the SAME Familiar, scoped to explaining the search-backend options in plain language. buildGuideSystem() assembles a STRIPPED context (framing + identity layer via enrich staticOnly + the four prompt fields + a tools-info block with honest per-option trade-offs and Brave/Tavily signup steps + a no-jargon block), macro-resolved. Explainer only: no tools, no memory/graph/temporal/care-check, not persisted/memorised. Backs POST /api/guide-chat. Off-switch PROTO_FAMILIAR_GUIDE_CHAT_DISABLED=1
├── web-fetch-util.js        timedFetch — a shared fetch-with-AbortController-timeout used by the search-API provider adapters (one place, not copy-pasted). Not the SSRF guard; just the timeout + JSON defaults for sanctioned backends
├── audience.js              Audience grant resolution (V3) — union/intersection/ladders, fetch eligibility, identity section markers; consumed by thalamus.enrich() and the Discord router
├── discord-gateway.js       Discord gateway adapter (V4+V5+V6) — bot-token WebSocket presence; DM policy + mention-only guild replies, per-location sessions, V3 gate applied before every reply; V5: per-location connection routing (location.connectionId → settings.connections → primary fallback) + hourly token-bucket rate limiting (tomes/.rate-limits.json, ward outbox notice on exhaustion); V6: relayToDiscord() REST send (DM-open or channel post) backing the relay_message tool; **vision Pass 3 (0.9.4): arrival-time image ingest** — ingestDiscordImages fetches image attachments AT ARRIVAL (CDN URLs are ephemeral) via the media proxy's own resize params (discordResizeUrl, long edge 1568, no image lib), saves through saveAsset with origin.surface='discord' + origin.speaker + the room's audienceTag; ward always, registered villager yes, stranger never; caps MAX_IMAGES_PER_MESSAGE + discordMediaPerHour (default 20, per-location hourly, in-memory); observeMessage ingests too; materializeAttachments wired into handleTurn's apiMessages (once, rides every tool round, fail-closed on the room's visible audiences); failed fetch → [image failed to load] note; both history .map() blocks preserve attachments; off-switch PROTO_FAMILIAR_DISCORD_DISABLED=1
├── knocks.js                Village knock list (V4.x) — contact attempts from unregistered people, captured for one-click registration in the Village editor; tomes/.village-knocks.json, capped, metadata only
├── injection-guard.js       Prompt injection immunization — pattern scanner + sanitizer (span-surgical, conservative false-positive budget; escape-tolerant bracket markers). WIRED (0.8.57) at the two genuinely-external inbound boundaries: web text (websearch.js — search titles/snippets, look_up reference text, read_webpage extraction; URLs deliberately untouched) and Village communications (discord-gateway.js inboundContent() — villager/stranger text only). The ward's OWN words are never sanitized on any path (threat scoring must read them raw; a redacted distress line could read as a jailbreak to triage), and no OUTBOUND path (replies, relay_message, relay_to_ward, trusted-contact delivery) passes through it — the guard is inbound-third-party-only, which is what keeps relay and triage structurally unblockable by it. NOT applied to Phylactery/Unruh recall (first-party stores; villager-written memories carry provenance labels instead) or gcal event titles (the ward's own calendar)
├── memorization.js          Persistent per-session memorization queue + worker; V7: buildSharedRoomPrompt variant selected when audienceTag !== 'ward-private' — focuses on ward-only facts, skips unregistered-third-party detail. Source-aware consent (0.8.88): direct ward-self facts kept on implied consent, only third-party/group-room facts ask; extractor tags temporality (episodic→daily dated / standing→ward register). Deferred follow-ups: the ward-private `buildPrompt` also asks for `follow_ups` (things I said I'd do this session but never backed with a tool) on the SAME call — `parseFollowups` + `createSessionFollowup` (recent-ponderings.js) store each; gated by `followupsEnabled` (default ON) / `PROTO_FAMILIAR_FOLLOWUPS_DISABLED=1`
├── session-log.js           Shared `writeSessionLog(data,{logsDir})` (atomic tmp+rename), `stampMessages` (id/timestamp safety net), and `turnMessages(user,assistant,{speaker})` (the one place a call's turn pair is built — id + real accumulation-time timestamp + a `speaker` on the user turn when known). The one place a conversation lands in `logs/` as a reviewable session. Used by the Discord gateway AND both voice-call servers: a voice call (web + Discord) lands as a reviewable session log the ward can open in the Sessions tab, not only as extracted facts — web at `ward-private`, each Discord segment stamped with ITS audience tag (a villager's segment never ward-private), written on hang-up before memorization, each half independent. GROUP calls: the room session attributes each turn to the villager who spoke (`speaker`, matching Discord text) so memorization and the reviewer both read who-said-what; `createMessageEl` renders the speaker's initial + name. Off-switch `PROTO_FAMILIAR_VOICE_SESSION_LOG_DISABLED=1`
├── outgoing-filter.js       Pillar D outgoing gate — semantic check before delivery; retries up to budget then safe-refusal
├── providers.js             Shared chat-completions URL map (used by server.js + thalamus.js)
├── llm-call.js              One chat-completion call for the autonomous background loops (pondering / reach-out / memorization / tome-graduation) — replaces four byte-identical `defaultCallLLM` copies. THINKING-MODEL handling lives here: a reasoning model bills its chain-of-thought against `max_tokens`, so a small cap returned an empty `message.content` (the "Provider returned empty content" the loops logged). `callProviderChat` uses a generous default cap (free for non-thinking models — they stop when done), falls back to `reasoning_content`/`reasoning` when `content` is empty (`extractContent`, shared with memorization which keeps its own finish_reason handling), and throws a diagnostic naming `finish_reason` (=length → raise the cap) instead of a bare mystery. The safety-critical triage call in `cerebellum.js` (silence-triage) now routes through this too (ward-signed, 0.8.82): its cap was 600 with no reasoning handling, and its empty-content path returns `action:'wait'` — so a thinking model there degraded to a SILENT no-op on a distressed ward (the 1.5-hour-silence class). The call now uses `callProviderChat` (cap 4000 + reasoning recovery); the decision logic is unchanged — a genuine transient failure still degrades to the safe `wait`, never a fabricated decision
├── (quiet success)          Write-tool success results collapse at the `executeToolCall` boundary (0.8.13): a WRITE executor's success branch returns `quietOk(fullText, {id})` and the model sees `ok` (+ the new id when chaining needs it) instead of confirmation prose — success confirmations recur every turn the transcript survives, and carry nothing the model didn't imply by making the call. The safety contract: ONLY genuine success branches opt in (the boundary never classifies text, so a failure can never read as success); READ tools never opt in (the result IS the payload); load-bearing successes stay loud (contact_trusted_person, show_crisis_resources, schedule_push_to_google, schedule_export, memorize_now, village_upsert, convert_ids_to_slugs). Debug escape hatch: PROTO_FAMILIAR_QUIET_TOOLS_DISABLED=1 restores full prose
├── schedule-availability.js Coarse availability (stewardship Pass 4, 0.8.24) — LABEL-FREE-by-construction free/busy per day-part (morning/afternoon/evening) for coordinating with a villager the ward permitted. computeAvailability(nodes,{nowMs,days}) marks a part busy when an event or `hold` overlaps it (tasks/reminders don't block time); formatAvailabilityLines renders coarse rows; buildAvailabilityBlock is the villager-DM block, gated on the `schedule` grant ('coarse'|'full'). The derivation NEVER emits a label — structural privacy, not model discretion; 'full' additionally names items (ward's choice). Pure. Permission tier = the EXISTING audience.js `schedule` grant (category-level, V3 model); injected on villager-DM turns in discord-gateway (availabilityBlockFor) as context, and — since the clearance-gated Discord tools (V10, below) — also reachable as the `schedule_availability` tool when the speaker's grant authorises it. Familiar-facing: schedule_availability (own free/busy check) + schedule_add_hold (a 'hold' node — new SCHEDULE_NODE_TYPES member, keep-a-time-free, counted busy)
├── routine-review.js        Routine review (stewardship Pass 3, 0.8.21) — pure ledger + due-check + the pivot-menu prompt section. buildNeedsLedger counts met/missed per tracked need over the week (from each need anchor's payload.resolutions); isRoutineReviewDue is true only when the cadence (routineReviewDays) has elapsed AND ≥1 routine actually slipped (a good week manufactures nothing); buildRoutineReviewSection is the first-person pivot-menu text (keep/shrink/move/make-enjoyable/swap/shelve — "not ready yet" a finding, both costs named). RIDES one reflection tick, no new LLM call: server.js's shouldReflect lets a due review claim the tick, getReflectionInput attaches the section, the reflection prompt (pondering.js buildReflectionPrompt) emits a first-person `routine_review` finding, and runPonder's follow-through stamps the cadence + stashes the finding via stewardship.recordRoutineReview. Off-switch routineReviewEnabled + PROTO_FAMILIAR_ROUTINE_REVIEW_DISABLED=1; borrows the reflection slot without colonizing the pondering loop
├── stewardship.js           The executive layer over the temporal world model (0.8.18, Pass 1 of docs/stewardship-build-spec.md; default-ON, injection-only). The temporal window / consequence graph / needs ledger are truthful but, injected every turn, habituate into scenery — this picks a TINY conditional agenda instead (hard cap 3 items, block ABSENT when nothing qualifies; the salience lives in the absence). buildStewardshipBlock() is orchestration over pure selectors (selectDocket, buildOpeningBrief, medianHHMM, tierAtLeastModerate): (1) opening brief on the first REAL contact of the ward-local day — two conditions, past the dayStartAnchor AND after a dayStartGapHours inactivity gap (lastUserMessageAt); (2) docket — aging floating tasks (type='task', no when, unresolved) past docketMinAgeDays, oldest-first with a 3-day re-offer cooldown, at most once/ward-day; (3) anchor learning — after ≥14 first-contact samples it surfaces a >90-min drift so the Familiar adopts the observed rhythm via set_day_start_anchor. Code selects WHAT; the Familiar owns HOW it raises each item. Stands down at moderate+ threat (tierAtLeastModerate — deferral to triage, same posture as warm reach-out/needs-tracking). All facts code-computed (days-floating, the gap, the median) so the Familiar can't soften a record it didn't author. State (brief-fired flag, rotation cursors, first-contact samples) in tomes/.stewardship-state.json, mutated ONLY on liveTurn (a debug preview never fires a false opening); every path degrades to "" and never throws into the chat path. Assembled in thalamus.enrich() between careBlock and temporalLines. Off-switch: stewardshipEnabled + PROTO_FAMILIAR_STEWARDSHIP_DISABLED=1. **Pass 2a (0.8.19):** adds selectReadiness — for an event/task inside its readinessLeadHours window, walks the schedule EDGES (temporalPayload.schedule.edges, threaded in as scheduleEdges) for `requires`/`depends_on` prerequisites (direction: edge reads "src requires dst", so prereqs are the dst of edges whose src is the item) and surfaces any still-unresolved one it can see in the window (~6h per-event cooldown, never invents a blocker). Reads `payload.obstacle_tags` (a barrier vocabulary like "outside") to annotate readiness items
├── (regex/trigger tracer)   Ward-facing diagnostic (0.8.25) for tuning the keyword/regex surfaces. tool-surfacing.js exports explainSelection({turnText,dynamicBlock,villagerNames}) → per-module which regex matched which substrings / which block markers / villager names. POST /api/diagnostics/session-trace runs the REAL server modules per turn — explainSelection (surfacing) + scoreMessage (crisis-signals threat, with the matched text). The tome-keyword analyzer runs client-side in public/app.js (runSessionTrace) via the real matchKeyword over state.tomeCache entries, since tome/world-info lives client-side. Two Debug-section buttons (surfacing-only quick + a configurable modal: signal checkboxes + last-N-turns), plaintext output, copy/download. Localhost-gated like all endpoints; nothing stored
├── tool-surfacing.js        Context-sensitive tool surfacing (0.8.15, opt-in/default-OFF) — decides WHICH tool modules travel on a chat turn, all in cheap code (no LLM picks the tool set): TOOL_MODULES maps every builtin to exactly one module (a strict two-way parity test guards the map); CORE (time, recall/save/file, schedule_find, interests, both crisis tools, request_tools) is ALWAYS advertised; other modules surface via TRIGGERS (regex over user message + previous reply, marker-block presence in the injected dynamic context, villager names) + a per-session sticky TTL (toolStickyTurns, default 2). Recovery contract: the always-visible request_tools tool carries the full MODULE_INDEX in its description and pulls a module into the SAME turn (next loop round grows the tool list via runToolCallLoop's getTools hook / the streaming round's payload.tools) — a miss costs one round and logs `[tools] surfacing miss` for trigger tuning. Gated by toolSurfacingEnabled + PROTO_FAMILIAR_TOOL_SURFACING_DISABLED=1. See docs/tool-surfacing-build-spec.md
├── macros.js                Shared macro substitution — `substituteMacros(text, settings)` resolves `{{user}}`/`{{char}}` to configured names. Applied at three boundaries: (1) LLM prompts at each call site (triage, reachout, pondering, tome-graduation, guide-chat), (2) tool results (`executeToolCall` result boundary — all executors covered automatically), (3) tool descriptions (`composeActiveTools`). Server-injected static/dynamic context blocks (temporal-format, surface-context, CARE CHECK, presence) bypass all three, so they author the literal 'my human' — never a macro. Lowercase fallbacks ('my human', 'the Familiar') are intentional for mid-sentence inline prose.
├── entity-ref.js            Validate phylactery:self/file.md#section refs; accepts legacy entity-core: prefix as alias
├── package.json
├── .gitignore
│
├── logs/                    Session JSON files (auto-created, git-ignored)
├── tomes/                   Per-Tome JSON files (auto-created, git-ignored on UUID names)
│
├── phylactery/              In-tree Python module (Phylactery — canonical self-store)
│   ├── pyproject.toml       uv-managed Python project, deps locked in uv.lock
│   ├── src/phylactery/server.py  FastMCP server (identity / memory / graph / snapshots / lifecycle / backup)
│   ├── src/phylactery/identity.py + memory.py + graph.py + consolidate.py
│   ├── src/phylactery/graduation.py  Pillar H — signed-off graduation-eligibility rule + Familiar-led audit
│   ├── src/phylactery/scheduler.py   Pillar H — volume-gated lifecycle worker (off-switch PROTO_FAMILIAR_CONSOLIDATE_DISABLED). Pass 4 = distill-only memory lifecycle (temporal-bridges Piece 4): rides the pass, ADDS standing pattern-memories out of aged episodic facts, never demotes/deletes an original (distilled_at breadcrumb). Opt-in via memoryLifecycleEnabled → PROTO_FAMILIAR_MEMORY_LIFECYCLE_ENABLED env; hard off PROTO_FAMILIAR_MEMORY_LIFECYCLE_DISABLED=1
│   ├── src/phylactery/backup.py      Pillar H — passphrase-encrypted single-file export/restore
│   ├── src/phylactery/remember.py    Pillar I — ward remember-consent map (true/false/ask) + time-boxed standing consent
│   ├── src/phylactery/snapshot.py + audience.py + embed.py + db.py
│   ├── data/                SQLite database + snapshots + backups + remember_map.json + remember_standing.json (auto-created, git-ignored)
│   └── tests/               pytest contract tests (test_graduation.py + test_retrieval_decay.py)
│
├── unruh/                   In-tree Python module (Unruh — temporal context)
│   ├── pyproject.toml       uv-managed Python project, deps locked in uv.lock
│   ├── src/unruh/server.py  MCP server exposing every temporal tool
│   ├── src/unruh/schedule.py + interest.py + handoff.py
│   ├── src/unruh/ical.py      iCal (.ics) parse → normalized-event contract (0.8 inbound; RRULE subset-map + 90-day fallback expansion)
│   ├── src/unruh/gcal.py      normalized events → schedule nodes; change-classifying upsert/reconcile keyed by gcal_uid
│   ├── src/unruh/icalwrite.py schedule node → .ics + Google-render URL (0.8 outbound; local→UTC at this one boundary)
│   ├── src/unruh/location.py  Weather-location store (W-A) — pure fns over a `locations` table (migration 0006) + a `weather_cache` table. PRIVACY SPINE: coords never leave the store toward the model. location_public returns {id, label, is_current} ONLY; location_private / weather_locations_private carry lat/lon and are called by NODE CODE ONLY (never bound as a model tool). First location auto-current; delete reassigns current; ingest validates + replaces the per-location cache (JSON times are local-naive, same frame as the forecast). Unruh never fetches — Node owns the network (the gcal precedent)
│   ├── data/                SQLite + state (auto-created, git-ignored)
│   └── tests/               pytest contract tests
│
├── scripts/
│   ├── import-entity.js     Import an entity-core data directory
│   ├── import-tome.js       Convert SillyTavern lorebook export → Proto-Familiar tome
│   ├── ensure-unruh-deps.mjs npm prestart hook: materialise unruh/.venv if missing
│   ├── ensure-port-free.mjs  npm prestart hook: auto-recycle stale Proto-Familiar
│   ├── ponder-once.mjs       CLI: one-shot ponder via TEMP_KEY
│   ├── ponder-from-interests.mjs CLI: live demo of the pondering loop
│   ├── pondering-loop-demo.mjs   CLI: autonomous loop demo (fast-forward cadence)
│   ├── chat-with-ponderings.mjs  CLI: demo of pondering reference in chat
│   ├── threat-demo.mjs            CLI: end-to-end detection + care-check rendering
│   ├── seed-test-interests.mjs    CLI: seed Unruh interests for the pondering demo
│   └── _unruh-mcp.mjs             Shared MCP-client helper for the CLI scripts
│
├── tests/                   Node test suite (`npm test`)
│
├── public/
│   ├── index.html           App shell — sidebar, chat pane, Temporal editor modal, all modals
│   ├── style.css            All styling — dark/light themes, modal/tab styles
│   ├── graph-map.js         Shared force-directed graph-map engine (createGraphMap) — behind
│   │                        BOTH the Phylactery knowledge graph and the Unruh schedule map
│   └── app.js               All frontend logic — state, API calls, rendering, topics, Tomes,
│                            temporal editor, outbox delivery polling (tool registry + execution
│                            moved server-side to cerebellum.js in 0.4.0-alpha)
│
└── docs/                    This documentation (incl. research/ for design-input notes)
    ├── architecture.md      You are here
    ├── consequence-priors.md Generic curves for what lapsing costs (read by surface-context.js)
    └── research/            Design-input notes (task-handling, personalization-and-tracking)
```

## Component responsibilities

### `server.js` — the HTTP surface + autonomous-loop boot

The Express server handles every external request and manages the
lifecycle of the autonomous loops:

**Chat / enrichment:**
- `POST /api/chat` — validates request, fires `recordUserActivity()`
  (fire-and-forget timestamp) + `scoreMessage()` → `recordThreat()`
  on the user text, then `thalamus.enrich()` to assemble static +
  dynamic context. **After the context is assembled and before the
  provider fetch, `materializeAttachments` (vision.js) runs ONCE** on
  the full message array — a message carrying `attachments` gains live
  `image_url` parts or a text stand-in, and every tool round carries
  that forward (the loop reuses the materialized `baseMessages`). A
  modality rejection triggers the mid-turn hard fallback (retry with
  stand-ins, cache the connection `no`); a successful live-image turn
  caches `yes`. Returns the `_thalamus` envelope so the prompt
  inspector can show what was actually injected. With
  `runToolLoop: true` (sent by the app when tools are enabled) the
  server also runs the multi-round tool-call loop here, executing via
  cerebellum and emitting `_toolRound` SSE events / a `_toolRounds`
  response array — see "Data flow" below.
- OpenAI/SillyTavern compatibility: `POST /v1/chat/completions`,
  `POST /v1/completions`, `GET/POST /v1/models`, and `GET /v1/model`
  are accepted as aliases. They resolve provider/key/model from
  request body + Bearer token + saved primary connection, then route
  through `/api/chat` with `enrich:false` so external clients get
  plain OpenAI-shape traffic without Proto-Familiar `_thalamus` extras.
- `POST /api/debug-prompt` — offline preview (no upstream call).
- `GET /api/last-prompt` — the verbatim message array last sent to the model,
  per surface (web / voice / discord), captured at the send boundary
  (`prompt-capture.js`). Ground truth for the prompt inspector; localhost-only,
  same as `/api/debug-prompt`.
- **Media (vision build spec §2):** `POST /api/media` (its OWN
  `express.raw({type:'image/*'})` body parser, so image bytes never
  touch the global JSON limit), `GET /api/media/:id` (streams bytes for
  a thumbnail, slug or sha), `GET /api/media?limit=N` (inventory),
  `DELETE /api/media/:id`. `POST /api/media/:id/link` /
  `DELETE /api/media/:id/link/:nodeId` (§6.5 — the ward tags an image to
  a graph node; the link POST also fires description→node graduation).
  All refuse politely when vision is off.
- `POST /api/interest/engage` — fire-and-forget engagement bump.
- `POST /api/session/handoff` — store session-end intent for the
  next session.

**Logs / Tomes:** familiar endpoints for session JSON and Tome CRUD.

**Memorization:** `POST /api/memorize` (session scope is day-anchored) +
`GET /api/memorize` + ack/cancel — see `memorization.js`.
**Coverage (day-anchoring Phase 3):** `GET /api/memory-coverage` (per-date
status for the calendar) + `POST /api/memorize-day {date,force}` ((re)feed a
day's slices) — see `memory-coverage.js`.
**Dedup health:** `GET /api/memory-health` — is semantic dedup live or degraded
to the lexical fallback (`{healthy, dedup_mode, embed_ok, vec_ok, vec_rows,
memory_rows}`, from Phylactery's `memory_health`). A dead vector stack
(fastembed/sqlite-vec) silently disabled dedup and flooded the consent queue;
the fallback keeps dedup working and this surface + a loud boot log make the
degradation visible instead of silent. `POST /api/memory-backfill` embeds
memories that never got a vector — the entity-core migration imported rows
without embeddings, leaving them invisible to semantic dedup (a "healthy" stack
can still show `vec_rows < memory_rows`); the backfill also auto-runs in the
background at boot when that gap is detected. Idempotent.
**Import (day-anchoring Phase 4):** `POST /api/import-logs` — without `commit`
PREVIEWS (parse + segment, no writes); with `commit` places foreign logs by date
(one imported session per date) and enqueues them for immediate ingestion.
`POST /api/import-logs-batch` does the same for MANY files in one request (each
resolves its own date from a per-file `fallbackDate` or its filename; preview
returns a per-file breakdown; commit ingests every file that resolved and SKIPS —
never fails the whole batch on — any that need a date or didn't parse). Both share
`resolveImportSegs` (parse→date→segment) + `commitImportSegs` (write+enqueue) so
the rules can't drift. Parsers in `log-import.js` (Proto-Familiar JSON,
SillyTavern & OpenClaw `.jsonl`, **ChatGPT copy/share export** — `**You:**` /
`**ChatGPT:**` markdown with `* * *` separators, standalone-header-only so an
inline `**Reminder:**` stays content — and timestamped text; rejects unknown loudly).

**Diagnostics (ward-facing, localhost-gated):** `POST /api/diagnostics/session-trace`
— the regex/trigger tracer (0.8.25); per turn, runs the real tool-surfacing +
crisis-signal modules and reports which regex matched which text. Nothing stored.
**Google Calendar (0.8):** the OAuth endpoints (`/api/gcal/google/*`) plus
`GET /api/gcal/calendars` — discovered calendars + their attribution, for the
multi-calendar panel.

**Provider models:**
- `POST /api/models` — proxy the provider's own `GET /models` (URL derived from `providers.js`, normalised in `provider-models.js`) so the Connections modal can show a live, clickable model list. Falls back client-side to the curated per-provider suggestions.

**Temporal editor (M9):**
- `GET /api/temporal/interests` — live + standing with decay metadata
- `POST /api/temporal/interests/bump` — manual engagement bump
- `POST /api/temporal/interests/:id/demote` — demote standing value
- `POST /api/temporal/interests/set-standing` — promote topic to standing
- `GET /api/temporal/schedule[?from&to&limit]` — windowed events/tasks
- `POST /api/temporal/schedule` — add event/task/state/phase/reminder
- `PATCH /api/temporal/schedule/:id` — partial update
- `POST /api/temporal/schedule/:id/resolve` — mark done/cancelled/etc.
- `POST /api/temporal/schedule/:id/resolve_occurrence` — resolve ONE occurrence of a recurring node (leaves the series alive)
- `DELETE /api/temporal/schedule/:id` — hard delete (edges cascade)
- `POST /api/temporal/schedule/edge` — connect two nodes into the consequence graph (`{src, dst, kind}`, optional consequence `payload`)
- `PATCH /api/temporal/schedule/edge/:id` — merge consequence metadata onto an edge (`{payload}`)
- `DELETE /api/temporal/schedule/edge/:id` — remove one consequence link (both endpoint nodes survive)
- `GET /api/schedule/:id/export.ics` — stream a schedule node as a downloadable `.ics` (calendar export, 0.8 §2). Built in Unruh's code from the node's stored fields (local→UTC at this boundary); the model never types a calendar artifact. Source-independent — works on any node, gated by nothing
- Native Google OAuth (0.8.1, all UI-driven — no terminal): `GET /api/gcal/google/status` (redacted), `POST /api/gcal/google/credentials` (upload the Cloud-Console client), `GET /api/gcal/google/auth-url` (consent URL + CSRF state; loopback redirect derived from the request host), `GET /api/gcal/oauth/callback` (exchange code → store token → close-tab page), `POST /api/gcal/google/token` (paste a refresh token minted on Google's side), `POST /api/gcal/google/disconnect`
- `GET /api/temporal/phases` — **date-independent** routine surface
- `GET /api/temporal/handoff` + `POST .../handoff/:id/consume`
- `GET /api/temporal/reminders/health` — observability on the loop
- `GET /api/temporal/ponderings[?limit&sinceDays]` + DELETE
- `POST /api/ponderings/intents/acted-on` — mark a deferred intent as filed (body: `{ uid, index }`); called by the `acknowledge_deferred_intent` LLM tool

**Weather locations (W-A — ward-facing, coords never modelled):**
- `GET /api/locations` — the ward's saved weather locations, PUBLIC shape only (`{id, label, is_current}` — never coordinates)
- `POST /api/locations/geocode` — resolve a city/ZIP to `{place_name}` for the ward to confirm before saving (the geocode runs server-side; coords stay in the response envelope the UI posts back, never surfaced to the model)
- `POST /api/locations` — save a location (label + resolved coords + timezone); first one becomes current; forces a weather refresh
- `POST /api/locations/current` — switch the current location; forces a refresh
- `DELETE /api/locations/:id` — remove a location (current is reassigned); forces a refresh

**Village surface (V1 — registry only; gating lands in V3):**
- `GET /api/village` — full registry (categories + villagers + locations, normalized)
- `POST /api/village/categories` + `PATCH /api/village/categories/:id` + `DELETE /api/village/categories/:id?reassignTo=` — built-ins not deletable; Strangers locked
- `POST /api/village/villagers` + `PATCH /api/village/villagers/:id` + `DELETE /api/village/villagers/:id` — saving a villager auto-dismisses knocks matching their aliases
- `POST|PATCH|DELETE /api/village/locations` — keyed by body `key` (location keys contain `:`)
- `GET /api/village/knocks` + `DELETE /api/village/knocks/:platform/:id` — pending contact attempts from unregistered people (captured by the Discord gateway; identity metadata only, never message content)
- `GET /api/discord/status` — gateway connection state, bot identity, turn/failure counters, a `fatal` flag (token/intents rejected — the UI shows red instead of a perpetual "reconnecting"), plus `webSocketSupported`/`nodeVersion` so the Settings UI can warn proactively when the runtime is too old (Node < 22) to open the gateway
- `POST /api/discord/apply` — apply the saved Discord settings and (re)connect immediately (the Settings "Apply & connect" button), clearing any fatal state; returns the resulting status. Saves the ward waiting for the 30s supervisor tick or reloading the page
- `GET /api/discord-writes` — the villager-write audit trail (`discord-write-log.js` → `logs/discord-writes.jsonl`): every state-mutating tool a villager triggered through the Familiar on Discord, with who caused it. Newest first.

**Web search (the Settings "Configure search backend" modal):**
- `POST /api/guide-chat` — the in-modal Familiar explainer (0.7.29): same entity, stripped context (identity + the four prompt fields + tools-info/no-jargon), non-streaming, no tools, not persisted. Degrades calmly. Off-switch `PROTO_FAMILIAR_GUIDE_CHAT_DISABLED=1`

**Threat surface:**
- `GET /api/threat` — current tier + weight + last_touched + disabled
- `GET /api/threat/history?limit=N` — audit trail
- `POST /api/threat/reset` — manual reset to calm (always works)

**Outbox surface:**
- `GET /api/outbox[?pending=1&limit=N]` — UI polls this; pending items are injected as assistant chat messages in the active session (since 0.3.9-alpha; before, they rendered as banners)
- `POST /api/outbox/:id/acknowledge` — fired automatically by the client after each item is rendered into chat
- `POST /api/outbox/clear-acknowledged`
- Since 0.4.0-alpha every user-facing enqueue goes through
  `cerebellum.enqueueAndDispatch`, which ALSO pushes the item to each
  configured push channel and records the per-channel outcome on the
  item as `delivery: { '<adapter>': { status, at, error? } }`. Channels:
  the human's own Discord webhook (`discord-dm`, Settings → Trusted
  contacts → "My Discord webhook") and — since 0.8.x — the gateway
  bot's DM to the ward (`discord-bot-dm`, active whenever
  discordEnabled + bot token + ward user id are set; registered by
  server.js via `registerPushAdapterFactory` so cerebellum never
  imports the gateway). The browser stays pull-based; its confirmation
  signal is the acknowledge.

**Settings + Tailscale gate:** as before.

**Self-update (`updater.js`, 0.8.86; download mode 0.8.91):** two install shapes behind one seam (`getRepoInfo` returns `mode`), so the HTTP/UI surface is identical for both.
- **`mode:'git'`** — a cloned checkout. Repo/branch-agnostic: everything keys off `origin` + the checked-out branch read live from git, so a fork tracks the fork and an upstream clone tracks upstream. `git fetch` + compare + `merge --ff-only` (**refuses on a dirty tree**). Pure git → private repos + non-GitHub hosts.
- **`mode:'download'`** — a release archive with no `.git` (the default macOS/Windows install). No git history to read, so it keys off the `repository` field baked into **package.json** (a fork sets its own — same repo-agnostic property). Check = GET the remote branch's `package.json` version over HTTPS (`raw.githubusercontent.com`) and `cmpVersions` against the local one. Apply = **download-and-replace**: pull the branch tarball (`codeload.github.com`), extract with the system `tar` (in the base OS on macOS/Linux + Win10+; unlike git, needs no Xcode tools), and `fs.cp` it over the install with `force`. **User data is safe by construction** — the tarball holds only tracked files, so gitignored data (`settings.json`, `tomes/`, `logs/`, venvs, `node_modules`) is never in the source and is never overwritten or deleted. Refuses if the archive has no root `package.json` (junk-guard). Branch override: `PROTO_FAMILIAR_UPDATE_BRANCH`.
- `GET /api/update-status` — the cached last check `{ ok, repo, branch, mode, current:{version,commit}, remote:{version,commit,subject}, behind, updateAvailable, dirty, checkedAt }`. The UI polls this (60s) so the topbar indicator lights up in near-real-time on a left-open tab; the server refreshes the cache on its own 30-min timer (and once at boot).
- `POST /api/update-check` — force a fresh check now (the popover's "Check again").
- `POST /api/update-apply` — fast-forward (git) or download-and-replace (download); never restarts the process (launcher-agnostic; the restart re-runs dependency install); returns `{ ok, version, restartRequired:true }` and the UI/Discord tell the ward to restart.
- **Surfaces:** the topbar update button + popover (next to the prompt inspector; `initUpdateChecker` in `public/app.js`), and a ward-only `/update` / `/update now` Discord command (`discord-gateway.js`, intercepted before any LLM turn — villagers never reach it). Hard off-switch `PROTO_FAMILIAR_UPDATE_DISABLED=1`.

**Autonomous-loop boot** (`app.listen()` callback). Every loop has a
Settings toggle + `PROTO_FAMILIAR_*_DISABLED=1` env off-switch (the ones that
write to the canonical self default OFF):
- `startMemorizationWorker()` — drains the session-memorization queue
- `startAutonomousPondering()`
- `startRemindersScheduler()` — due reminders + event lead-time alerts
- `startGcalSync()` — Google Calendar sync (0.8; opt-in). Multi-calendar +
  attribution since 0.8.22; DST-correct since 0.8.23
- `startSilenceTriage()`
- `startReachout()` — warm non-crisis reach-out
- `startMemorySweep()` — passive coverage sweep, enqueues idled/uningested
  day-slices into the memorization pipeline (default ON)
- `startVillageSync()` — village registry boot reconciliation + default-category seeding
- `startDiscordGateway()` — supervisor idles until Settings carry a bot
  token + the toggle; follows Settings changes within 30s; hard
  off-switch `PROTO_FAMILIAR_DISCORD_DISABLED=1`
- `startTomeGraduationLoop()` — tome→Phylactery graduation (opt-in, default OFF)
- `startNeedsTrackingLoop()` — needs-fulfilment ledger worker (opt-in, default OFF)

(Stewardship and the routine review are NOT standalone loops — the block
rides `enrich()` on chat turns, and the weekly review rides a pondering
reflection tick; see stewardship.js / routine-review.js.)

Each loop has a `stop*()` function called from the SIGTERM /
SIGINT / SIGHUP handler so clean shutdown awaits any in-flight tick.

### `thalamus.js` — the cognitive-module mediator

Spawns and reconnects **Phylactery** (Python via uv, `./phylactery/`) + **Unruh**
(Python via uv) as stdio MCP children. Phylactery is the canonical self-store
(identity + memory + graph + trackers); entity-core (Deno) is retired as of Pillar I.
Exposes:

- **`enrich(userMessage, { liveTurn, staticOnly, lastUserMessageAt, audience })`**
  — the central per-request call. Fans out to identity + memory + graph
  (Phylactery) + temporal_context (Unruh) + local-disk reads (recent
  ponderings, threat state). Returns `{ static, dynamic }`. The
  `audience` option (Village V3) is the resolved grant object from
  `audience.js`; when present, ungranted knowledge classes are never
  fetched (gate-before-fetch) and ward-private blocks (ponderings,
  deferred intents, care check, surface candidates) are skipped
  entirely. Absent/null audience = ward-private = full context. See
  [Prompt assembly](#prompt-assembly) below for what goes where.
- **Interest helpers:** `recordInterest`, `bumpInterest`, `demoteStanding`,
  `setStandingInterest`, `listLiveInterests`, `listInterests`.
- **Schedule helpers:** `getScheduleWindow`, `addScheduleNode`,
  `updateScheduleNode`, `resolveScheduleNode`, `deleteScheduleNode`,
  `getDueReminders`, `getRemindersHealth`, `listPhases`.
- **Handoff helpers:** `recordHandoff`, `getHandoff`,
  `markHandoffConsumed`.
- **Phylactery spawn / reconnect:** auto re-spawns when settings
  change the Phylactery connection.
- **Standing-value bridge (M7):** on every liveTurn, reconciles
  standing values whose `value_ref` points at a now-gone Phylactery
  identity fact (demotes them to live interests).

### `cerebellum.js` — the motor module (outbound counterpart to Thalamus)

Thalamus owns everything flowing inward; cerebellum owns everything
flowing outward — the Familiar's actions and deliveries. The boundary
is strict: Thalamus assembles context and never executes actions;
cerebellum executes actions and never assembles prompt context.
Cerebellum never opens its own MCP connections — every write to
identity / memory / temporal state goes through thalamus.js's exported
wrappers (the single enforcement point for "writes go through
Phylactery's MCP").

Currently owns:

- **Tool dispatch** — `BUILTIN_TOOLS` (the full registry of tool
  definitions, first-person descriptions authored with `{{user}}`/`{{char}}`
  macros — raw source form; substitution happens at send time) +
  `TOOL_EXECUTORS` (server-side implementations; writes ride
  thalamus's wrappers) + `executeToolCall()` (never throws — failures
  become structured strings into the loop; applies `substituteMacros` from
  `macros.js` to every tool return value at the result boundary, so all
  executors are covered even if they forget substitution individually) +
  `composeActiveTools(customTools, settings, opts)` (built-ins + the user's
  advertise-only custom tools; deep-clone walks every `description` string
  through `substituteToolMacros` → `macros.js` before the tool list is sent
  to the provider; optional `settings` param defaults to `readSettingsSync()`;
  `opts.modules` — a Set from `tool-surfacing.js` — narrows the built-ins to
  core + the selected modules, applied BEFORE the web/gcal gates so surfacing
  can only ever narrow, never widen)
  + `runToolCallLoop()` (the non-streaming multi-round loop; the
  streaming variant lives in /api/chat because it is SSE transport; its
  `getTools` hook lets /api/chat re-compose the tool list between rounds so
  a `request_tools` call grows the set within the same turn).
  `request_tools` itself lives here as a core builtin: it validates the
  requested module names against `tool-surfacing.js` and stashes them on
  `toolCtx._requestedModules` for the recompose step.
  `initCerebellumTools()` receives the tome-storage capability, **the
  Village read/upsert functions, and `relayToDiscord`** from server.js at
  boot so `save_to_tome`, `village_lookup` / `village_upsert`, and
  `relay_message` work without cerebellum ever importing server.js (the
  last would be a cycle — discord-gateway imports settings helpers from
  cerebellum).
- **Village tools (0.6.x)** — `village_lookup` / `village_upsert` let the
  Familiar see and edit the Village and link villagers to graph nodes
  (`graphNodeId`). Gated via `ctx.wardPrivate` (threaded into `toolCtx`
  from the session audience tag in /api/chat): `privateNotes` disclosed
  and mutations allowed only on ward-private turns; lookups still surface
  the person and ordinary notes when others are present, with the
  sensitive bucket stripped. Mutations: editing an existing record or
  writing `privateNotes` is ward-private only and deferred for consent
  otherwise; *creating* a just-met person is allowed even with others
  present. See docs/village-support-design.md ("Field-level gating —
  privateNotes").
- **Own-file tools (0.6.x)** — `list_files` / `read_file` give the
  Familiar sandboxed read-only access to its own checkout (tomes, logs,
  docs) so it can look things up on purpose. Sandbox + secret denylist
  in `own-files.js`; ward-private only (file contents are shared
  history, not for gated rooms).
- **`relay_message` (Village V6, 0.6.15-alpha)** — carries a message from
  the ward to a villager (DM) or a Discord location. Resolves the target
  against the registry, runs the composed text through the
  restricted-memory gate at the *target's* audience tag (`searchRestricted`
  dep, defaults to `searchMemoryRestricted`; fails open), delivers via
  `relayToDiscord` (injected dep), and mirrors every relay to the ward's
  outbox (`mirrorToWard` dep, defaults to `enqueueAndDispatch`) — no covert
  contact. The gate/mirror/delivery deps are injectable so tests run
  without spawning MCP children or touching the real outbox. Both target
  kinds are made enumerable to the Familiar by `village_lookup`, which
  (V8) reports a **Places** roster + per-villager Discord-reachability so
  the Familiar can always name a valid relay target.
- **Web tools (opt-in, 0.7.0-alpha; `look_up`/`web_search` split 0.7.19-alpha)** —
  `look_up` / `web_search` / `read_webpage`, thin executors that delegate
  to `websearch.js` (SSRF guard, timeout,
  `linkedom`→`@mozilla/readability`→`turndown` extraction with provenance
  stamping). `look_up` answers definitions/facts/overviews from keyless
  official reference APIs (Wikipedia + DDG Instant Answer), no scraping;
  `web_search` finds pages. Unlike every other built-in they are
  **conditionally advertised**: `composeActiveTools` filters them out via
  `webSearchEnabled(settings)` unless the human has enabled web access
  (and `PROTO_FAMILIAR_WEBSEARCH_DISABLED=1` forces them off). A page the
  Familiar reads persists in session history for the rest of the session;
  to carry it across sessions the Familiar keeps the gist via the existing
  `save_to_tome` (the read return is provenance-stamped so the source
  rides along). See docs/websearch-setup.md and docs/websearch-build-spec.md.
- **`decideTriageViaLLM({threat, silenceMs, signals})`** — the triage
  deliberation: assembles the [Now]-anchored prompt (identity context,
  recent conversation with relative times, threat signals, trusted
  contacts, candidate tasks), calls the primary connection, parses the
  `wait` / `reach_out` / `contactHuman` decision.
- **Channel adapters (push delivery)** — `activePushAdapters()` returns
  the configured push channels: the built-in `discord-dm` (the human's
  own webhook) plus whatever registered factories produce
  (`registerPushAdapterFactory` — server.js registers `discord-bot-dm`,
  the gateway bot DMing the ward via relayToDiscord's REST path).
  `dispatchOutboxPush()` runs every adapter (a failing
  one never blocks the rest) and records per-channel
  `delivery: { status, at, error? }` on the item. Delivery detection is
  channel-agnostic: `contactDeadlineFor` starts the escalation veto
  clock at the EARLIEST confirmed delivery on any channel, and
  `formatDeliveryNote` reads "delivered" if any channel landed;
  `enqueueAndDispatch()` is the default enqueuer for everything
  user-facing. `formatDeliveryNote()` renders one line of delivery
  state into the prompts the Familiar reads — a failed push is visible
  to it, so "they never saw me" and "they're ignoring me" are
  distinguishable signals. `sendDiscordWebhook()` is the shared
  primitive under both the user push channel and trusted-contact
  delivery.
- **`deliverToTrustedContact({name, message, channel})`** — Discord
  webhook delivery with the "no covert contact" invariant enforced
  structurally: every outbound to a third party mirrors an
  `outbound_alert` into the user's outbox (and out the push channel),
  even on delivery failure.
- **`checkAndFirePendingContacts()` + `contactDeadlineFor()`** —
  escalation deadlines. The acknowledgement clock starts at FIRST
  CONFIRMED push delivery of the check-in (the human can only veto
  what they could have seen), falling back to the enqueue time when no
  push channel is configured, the push failed, or no delivery record
  lands within `DISPATCH_GRACE_MS` — a dead adapter can never block
  escalation forever. Pre-0.4.0 items with a precomputed
  `contactDeadlineTs` are honored as-is. Marks `delivered` *before*
  the async fire (double-delivery guard). All I/O injectable; covered
  by deterministic clock tests in `tests/cerebellum.test.mjs`.
- **`CONTACT_ESCALATION_DELAY_MS`** — the per-tier acknowledgement
  window (severe 30min / high 2h / moderate 6h).
- **Triage event log** — `appendTriageEventLog` / `readTriageEvents`
  on `logs/triage-events.jsonl`.
- **`readSettingsSync` / `primaryConnectionFrom`** — the single
  settings-reader implementation, imported by server.js.

These are the highest-stakes code paths in the system. Behavioral
changes here (not relocations) require explicitly asking the human
before shipping — see CLAUDE.md.

### Caring-spine modules

**`crisis-signals.js`** — auditable, pattern-based detector. Returns
`{ level, signals[] }` per message. 5 tiers (severe / high / moderate /
mild / safety). Damping for negation / hypothetical / others-speech /
hyperbolic context. The patterns are tuned for high precision on
SEVERE (the "cut me off" / "I want to die from embarrassment" false
positives are the regression cases the test suite watches).

**`threat-tracker.js`** — persistent decaying scalar at
`tomes/.threat-state.json` with 3-day half-life. Cap MAX=10, floor 0,
FIFO audit history (50). Off-switches: `PROTO_FAMILIAR_THREAT_DISABLED=1`
silences recording; `resetThreat()` always works regardless.
**`flagDistress`** (ward-signed, safety-critical) is the channel by which the
model's OWN read of distress moves the tier: it floors the weight to
`FLAG_FLOOR_WEIGHT` (8.0 — solidly severe with a real window, then decays like
any threat), dedups repeat flags within `FLAG_DEDUP_MS` (per-turn), and never
lowers an already-higher state. The `flag_distress` executor (cerebellum, CORE
tool + noticing toolset + every villager) raises it, forces an immediate triage
re-check (`resetTriageCooldown`), and — on a villager-triggered flag — always
mirrors to the ward (`enqueueAndDispatch`, no covert safety action). It sends
nothing itself; triage owns what care actually lands.

**`pondering.js`** — pure `ponderOnce({topic, provider, apiKey, model,
grounding})` that calls the LLM as the Familiar and writes a real
first-person tome entry to "Familiar's Ponderings" (entries are
`enabled: false` so they don't auto-fire as RAG lore — they're
inspectable artifacts). **Grounded pondering (0.8.85):** for an interest
ponder, `runPonder` (server.js) first recalls what the Familiar actually
knows — a `searchMemory` on the topic + recent ponderings on the SAME
topic (from `getRecentPonderings`, matched on the stored `topic_pondered`)
— and passes it as `grounding`. `buildGroundingBlock` turns that into a
prompt section: the recalled memories are "the grounded truth I draw on"
(so it doesn't muse from the outside about something its human has a real
relationship to — the confident-wrong-AURORA case), and recent same-topic
ponders become "I already turned this over, so I do NOT reach out asking
the same question a third morning in a row" (the repeated-reach-out case).
No memories recalled → an honest "I don't hold anything concrete about
this yet, so the ponder is the pull and what I'd want to ASK" note, which
steers to not-knowing over confabulation. Best-effort: one cheap recall
that degrades to an ungrounded ponder; reflection mode is already grounded
(windowMemories) and is skipped.

**`recent-ponderings.js`** — reads the N most recent pondering entries
within sinceDays and formats them as a prompt-injection block. Also
owns the deferred-intent consumer (Pillar B): `getUnactedIntents()`
returns unacted `wants_to_save` entries oldest-first; `markIntentActedOn()`
flips one `acted_on` flag under the per-file lock after the chat-turn
Familiar files it; `formatDeferredIntentsBlock()` renders the [Deferred
intents] block for enrich(). **A "tell" auto-consumes in code:**
`getUnactedIntents({ markSurfaced:true })` — passed only on enrich's live,
ward-private surface — stamps a shown `tell` with `surfaced_at`, and on the
next live turn marks it `acted_on` (disposition `'surfaced'`) so it is shown
exactly once. This removes the reliance on the LLM calling
`acknowledge_deferred_intent` after voicing a tell — forgetting that made the
same warm question re-surface every turn. Filing intents (tome/memory/identity)
are never auto-consumed: they carry a real side-effect that must land first, so
they still require the tool call + acknowledge (acting-≠-marking-done). All
read-only callers (`list_deferred_intents`, the reach-out candidate scan, the
noticing wake check) pass `markSurfaced:false` and never mutate.

**Deferred follow-ups** (the "I'll do that later" catch, docs/deferred-
followups-build-spec.md) reuse this same surface with the least possible new
code. `createSessionFollowup({ summary })` (recent-ponderings.js) mints its
own tome entry — `scope:'session-followup'`, one `wants_to_save` entry
`{ kind:'followup', summary, source:'session', acted_on:false }` — so
`getUnactedIntents()` surfaces it with zero new read code, and
`getRecentPonderings()` excludes `scope:'session-followup'` entries so a
caught commitment never reads as "something I've been thinking about."
Unlike a tell, a follow-up is **not** auto-consumed by `markSurfaced` — it
has a real action to perform, so it persists (like a filing intent) until
`markIntentActedOn`/`dropIntent` fires after the Familiar actually uses the
right tool. **Aging:** `getUnactedIntents` drops (in code, on read) any
follow-up older than `followupMaxAgeDays` (default 7) — stamped
`disposition:'aged-out'`, an honest record, never a claim it was done. The
extraction rides `memorization.js`'s existing per-session LLM call (no new
request): `buildPrompt`'s ward-private-only `follow_ups` section (gated by
`followupsFeatureEnabled` — `followupsEnabled` setting, default ON, or
`PROTO_FAMILIAR_FOLLOWUPS_DISABLED=1`) asks the Familiar to name anything it
told my human it would do but never backed with a tool call; `parseFollowups`
parses the same raw response that already produced facts/relations (fail-
safe to `[]`); `processJob` stores each via `createSessionFollowup`, which
dedups lexically against currently-open follow-ups so the same commitment
caught across overlapping memorization slices isn't filed twice. The system
never fabricates the follow-through (no invented reminder time/tool) — it
only catches, persists, and re-surfaces; the Familiar completes it or drops
it.

**`pondering-cadence.js`** — pure tiered formula:
`computeRequiredInterval(topWeight, threatLevel, { scale })`. Tiers:
high=30min / mid=60min / low=2h / idle=6h. Threat multiplies (severe
0.15× → calm 1.0×). User scale stretches (≥1×).

**`pondering-loop.js`** — autonomous singleton.
`runOneTick({getInterests, runPonder, getThreat, isEnabled,
getIntervalScale})` is the pure-ish surface; `startPonderingLoop`
wraps it with setInterval + lifecycle. Reentrancy-guarded; stop awaits
in-flight ticks.

**`reminders-loop.js`** — autonomous singleton. Every 30s, calls
Unruh's `reminders_due` MCP tool, enqueues each into the outbox
(idempotent on origin id so retries don't double-fire), then marks
the schedule node `resolution='fired'`. The frontend's outbox poller
turns each item into an assistant chat message in the active session.
Health-watch warns when `overdue` climbs across consecutive ticks.
The same tick also carries the **event lead-time alert pass**
(`event-alerts.js`, the timeblindness surface): unresolved
`type='event'` nodes — synced from Google or hand-added — get a
code-built "coming up" outbox ping (`kind='event_alert'`) a
ward-configurable lead before `when_ts` (default 60 min, clamped
5–1440; `eventAlertsEnabled` default-ON; hard off-switch
`PROTO_FAMILIAR_EVENT_ALERTS_DISABLED=1`). Recurring events alert per
occurrence via the JS expander; durable per-occurrence dedup lives on
the node payload (`alerted_at` / `alerts[YYYY-MM-DD]`, written by
Unruh's `schedule_mark_alerted` — atomic merge, enqueue-first
mark-second like reminders). All-day events never ping (their
when_ts is midnight). All comparisons run in the ward-local frame
(nowMs derived from `wardLocalNowISO`).

The same pass also carries the **severe-weather heads-up** (W-B §5.4,
`selectDueWeatherAlerts`): an `obstacle_tags:["outside"]` item whose
occurrence-hour forecast turns adverse in the CACHED forecast (the
read-mirror — "within lead range" means inside the ~48h it covers, so
no fetch) gets a code-built `weather_alert` outbox ping. It rides the
SAME window scan (a per-tick memo, `fetchAlertScanData`, shares one
schedule fetch between the two passes) through the SAME enqueue-then-mark
helper (`runAlertStream`), but into a SEPARATE dedup channel
(`weather_alerted_at` / `weather_alerts[YYYY-MM-DD]`, `kind:'weather'`)
so a coming-up ping and a weather ping for one occurrence never suppress
each other. Weather alone (no outside item affected) never pings — this
is a preparation surface, not a weather report. Gated by BOTH weather
and event-alerts being on.

The same tick also carries **elapsed stamping** (causal-chain fix
piece 4, 0.8.108, ward-signed): a pure-code pass, self-gated in
`server.js` to an hourly cadence, that calls Unruh's
`schedule_stamp_elapsed` — one-off `type='event'` nodes whose time
(`end_ts` when present, else `when_ts`) has been past for more than the
ward-configurable `elapsedStampHours` (Settings, default 24h, clamped
1–720h) with no resolution get `payload.elapsed_at` stamped. An
**observation, not a resolution**: the node stays unresolved, nothing
is hidden, and the safety-audit surface (overdue-event noticing) still
reads raw timestamps. Recurring anchors and need-windows are excluded
(their pasts are per-occurrence). Display consumers in
`temporal-format.js`: a stamped event renders under "Past events with
no word on how they went" instead of "Coming days", and the hindsight
question line tags it `[never marked done]`. Idempotent Unruh-side;
hard off-switch `PROTO_FAMILIAR_ELAPSED_STAMP_DISABLED=1`.

The same 30s tick also carries the **weather refresh seam** (W-A,
"ride existing requests, gate in code"): `refreshWeatherIfDue()` is a
self-gated fire-and-forget — it no-ops unless weather is enabled
(`weatherEnabled` default-ON + `PROTO_FAMILIAR_WEATHER_DISABLED=1`
off-switch) and the current location's cache is older than
`WEATHER_REFRESH_MS` (6h); a `_weatherRefreshing` guard prevents
overlap. When due it geocodes-nothing (coords already stored),
`fetchForecast`s the current location, writes the Unruh
`weather_cache` (via `ingestWeather`) and syncs the read-mirror
(`syncWeatherMirror` → tomes/.weather-now.json). It also runs once at
boot and is forced on a location add / set-current / delete. No new
LLM call and no new loop — weather is pure code end to end; the
model only ever reads the code-built [Now] line.

**W-B surfaces (the day at will + preparation).** Two ward-only tools
(gated by `weatherEnabled`, surfaced by the `weather` tool-surfacing
module on leaving-the-house language + the readiness/projection blocks):
`weather_today` (the code-built arc for today+tomorrow, current place or
another saved label — on-demand fetch via `weather-service.js` for a
non-current place; falls closed to the vague tier on a gated turn) and
`set_current_location` (moves the current place; warms the new sky).
`weather_today` also joins the **noticing** toolset (read-only — NOT a
wake condition; weather only flavours a turn already happening) and the
**projection cue** prose (a reminder it can check the sky while thinking
a new appointment's lead time through). The **readiness** note
(`stewardship.js`) reads the mirror synchronously and, for an outside-
tagged item whose hour looks adverse, appends a code-built weather clause
so the prep nudge is weather-aware. The ward manages places in the
Temporal editor's **Weather** tab (add-via-geocode-confirm / set-current
/ delete over `/api/locations`), which only ever shows the public
`{label, is_current}` shape — coordinates never reach the browser list
nor the model.

**`silence-triage-loop.js`** — autonomous singleton. Every 5min, gates
on tier (calm/mild = no-op) and cool-down (LLM-controlled
`nextCheckInMs`, clamped to [30s, 24h], with per-tier defaults if
omitted). Tier-rise preempts the cool-down. The LLM call IS the
decision — `wait` is honored. On `reach_out`, posts to outbox (and out
the push channel via `enqueueAndDispatch`); if `contactHuman` is
included AND the name matches a configured trusted contact, schedules
a deferred Discord-webhook delivery (held until the user acknowledges
or `CONTACT_ESCALATION_DELAY_MS` elapses — counted from confirmed push
delivery; see cerebellum's `contactDeadlineFor`). The deliberation
prompt includes the Familiar's still-unacknowledged check-ins with
their delivery state, so a failed push reads as "they may never have
seen me," not as silence.

**`reachout-loop.js`** + **`reachout.js`** — autonomous singleton, the
companionship counterpart to silence-triage. Every 10min, `runOneReachoutTick`
applies cheap code gates *before* any LLM call: crisis-defer (threat at
moderate+ → stand down, triage owns the moment), quiet hours
(`warmthQuietHoursStart/End`, default 23–08 local), and a cool-down
(`nextCheckInMs`, clamped to [15min, 24h], default ~2h). The decision
(`decideReachoutViaLLM`) reuses `enrich(staticOnly)` + recent session
messages for continuity, is given **recent memories (today + yesterday) via
`getRecentMemoryLines`** so it cross-checks whether the thing it would raise was
already answered (the prompt suppresses a redundant re-ask without dampening a
genuinely fresh reach-out — the reported "brings it up even though we discussed
it" fix), and is given the pending `tell` intents
(`getUnactedIntents`, filtered to kind `tell`) and the warm-villager list
(`getWarmVillagers`: `relationToFamiliar==='warm'` AND Discord-reachable —
the dormant tag's first real use). On `reach_out` it routes to either a
ward banner (outbox `kind:'reachout'`, dedup-bucketed; marks the `tell`
acted-on if one was cited) or a warm-villager DM (`relayToDiscord`, always
mirrored to the ward — no covert contact). The prompt is warm-framed, not
crisis-framed, and follows the proactivity rules (both costs named at equal
weight; no bias-toward-quiet). This loop never gates a *safety* action —
it's purely additive warmth. Off: Settings "Warm reach-outs" or
`PROTO_FAMILIAR_WARMTH_DISABLED=1`.

**`outbox.js`** — `tomes/.outbox.json` persistent queue. `enqueueOutbox`
dedups on `(kind, originId)` while unacknowledged. `listOutbox`
newest-first. `acknowledgeOutbox` / `clearAcknowledged`. `updateOutboxMeta`
for the triage loop's pending-contact deferral.

**`last-activity.js`** — single timestamp in `tomes/.last-activity.json`
stamped from the chat path; consumed by the silence-triage loop.
Discord ward messages stamp it too — the Familiar's sense of "my human
was just here" follows the human, not a particular window.

**Intentions (Initiative Pass 3)** — a first-class "my intention" object the
Familiar writes for its future self: the substrate for planning, follow-through,
and *rounds* (phase-bound standing intentions — self-maintenance as identity).
Stored in Unruh's own `intentions` table (`unruh/intention.py`, migration
`0005`), NOT the schedule layer — intentions are per-embodiment cognition and
the ward's schedule surfaces must never grow Familiar-internal rows. Each has a
`what`, a `why` (read back as the payoff-turn reasoning), `refs` (slug ids kept,
never snapshotted — dereferenced fresh when it surfaces), a `trigger`
(`at`|`phase`|`on_next_contact`|`none`; `recurring` for rounds), an optional
`condition` (a tiny tripwire vocab — `minContactGapMs`/`needsStatus`/
`unresolvedRefs` — the Node side applies the live-signal gate), and a
`visibility` the Familiar itself controls. Unruh owns storage + trigger TIMING
(`intentions_due`); the Node side owns the condition gate and budgets.
**Phase-round matching is forgiving (0.11.17, bugfix):** a `phase` round's
`trigger_phase` is matched to the ward's live routine-phase label via
`phase_matches` — case-insensitive and substring either way — so a round the
Familiar typed as `'evening'` still fires against a phase labelled
`'Evening wind-down'` (the exact match `'evening' == 'Evening'` silently never
fired, so evening check-ins never surfaced). `set_intention` also canonicalises
the typed word to a real phase label at set time (`resolve_phase`, fed the
ward's `list_phases` labels by the MCP wrapper) and, when nothing matches,
returns a `warning` the Familiar surfaces — so a round that can never fire is
visible, not silent dead care.
Chat-path tools (`cerebellum.js`, first-person, ward-only, `intentions`
surfacing module): `intention_set/list/drop/done/mark_fired` +
`intention_visibility` (rounds shared/private — renamed from
`intention_set_rounds_visibility` in 0.11.16 so its name no longer collides on
the `intention_set` prefix and mis-routes tool selection). Budget caps enforced at set time, ward-configurable:
`intentionStandingPerPhase` (default 3), `intentionOpenOneShots` (default 30) —
a cap hit tells the Familiar to prune, never a silent drop. Due intentions
surface in `[Temporal Context]` via `temporal_context` (a payoff turn riding the
existing per-turn call; stripped on gated villager turns — private cognition).
Reflection can also END in commitments: the pondering output schema gains
`intentions[]` (≤3/tick, `source:'reflection'`, routed via `setIntention`).
**The Familiar's rounds** is a ward-facing read-only view (`GET /api/rounds`, routine
tab) honouring the Familiar's own visibility choice — a private round is counted
(`hidden_count`) but its contents withheld: existence is never hidden, only what
a private round *is*. The autonomous noticing turn that consumes due intentions
with the full condition code-gate is Initiative Pass 4 (not yet built).

**`noticing.js`** + **`noticing-loop.js`** — the Familiar's own turn (Initiative
Pass 4): the organ that lets it *notice* and act without my human spelling it
out. `noticing.js` holds the pure logic — wake conditions (a due intention whose
condition passes, a contact gap past the baseline p90, a readiness gap, an aging
untriggered intention, an aging floating task (`AGING_TASK_MS`), an overdue
unresolved event (`OVERDUE_EVENT_GRACE_MS`, reached via the window's `linked`
endpoints — ward-signed 0.8.98, the Familiar ASKS the outcome and records it, it
never assumes done/missed); **no wake condition → no turn**), the condition
code-gate (`conditionPasses` — evaluated here, not left to the model, since no
human reads this turn), the code-built ≤5-item situation report, the ward-signed
prompt (`buildNoticingPrompt` — threat-tier line only at moderate+, flag_distress
clause only when that tool is in hand), and the injectable `runOneNoticingTick`.
`noticing-loop.js` is the singleton that drives it, self-paced (`set_next_check`,
clamped [5min,6h], adaptive default). The bounded, tool-using deliberation runs
in `server.js`'s `noticingDeliberate` (`composeNoticingTools`: intention CRUD + a
few schedule reads + the noticing-scoped `reach_out_to_ward` warm-knock and
`set_next_check`; a reach-out refused during quiet hours is not counted as
acting). It assembles the same recent context a live chat turn / warm reach-out
gets — identity (static block), the time anchor, **recent conversation
(`getRecentSessionMessages` → `formatRecentMessagesForContext`) and recent
memories (`getRecentMemoryLines`, today+yesterday)** — so it doesn't decide blind
to what was just said. That context is **information only** (ward decision, no
suppression instruction): it never nudges a stand-down, and the recent context is
worded to yield to the no-look-away posture at elevated threat. **Does NOT stand down at elevated threat** (ward-signed,
safety-significant — the tier shifts the register, never skips the turn; joins
the safety-critical sign-off set). A proactive act resets the wait streak; a
stand-down increments it (`source:'noticing'`). Every decision-reaching tick —
including quiet-window evaluations — lands in `logs/noticing-events.jsonl` (GET
`/api/noticing-events`). Model via `connectionForFeature(s,'noticing')`. Off:
`noticingEnabled` / `PROTO_FAMILIAR_NOTICING_DISABLED=1`.

**`contact-baselines.js`** — a model of "normal contact rhythm," in code
(initiative-build-spec Pass 2). Turns the contact history the system already
records (ward user-message timestamps in session logs) into per-weekday-class
arithmetic: median gap, p90 gap, longest-observed gap, over a rolling 4-week
window. Ward-contact signal is conservative — only web-chat sessions (no
`audienceTag`) and Discord ward-DMs (`audienceTag === 'ward-private'`) count,
so a villager in a group room is never mistaken for the ward (it under-counts
rather than over-counts, the safe direction for a "should I worry about their
silence" input). Timestamps within 3h coalesce into one contact *episode*; the
gaps that matter are the quiet stretches between episodes, classified by the
ward-local weekday-class of when the quiet began. **Honesty rule:** below ~2
weeks of span or too few samples for a class, `hasBaseline` is false and
consumers render nothing — a fabricated rhythm is worse than none. No loop, no
LLM call: recomputed lazily on read (cached in `tomes/.contact-baselines.json`,
refreshed at most every ~3h). Consumed by exactly two surfaces: the warm
reach-out prompt's rhythm line (`buildRhythmLine`, riding below Pass 0's
silence line) and — once built — the Pass 4 noticing situation report. Triage
and surface-candidates stay untouched (triage has the threat tier; baselines
are companionship territory). Off: `contactBaselinesEnabled:false` or
`PROTO_FAMILIAR_BASELINES_DISABLED=1`.

**`wait-streak.js`** — the ward's wait-streak experiment
(initiative-build-spec Pass 1): a persistent counter in
`tomes/.wait-streak.json` of how many times the Familiar has chosen to
wait/defer since its last proactive act. Increments ONLY on deliberated
wait choices (triage `wait`, warmth `wait`, a Discord `[later:…]` defer,
snoozing a deferred tell); resets ONLY on proactive decisions (triage /
warmth `reach_out` at decision time, a revisit that actually speaks,
acknowledging a deferred intent after acting). Gate-skipped ticks never
count (the Familiar was never asked), and the ward speaking never resets.
Read side: `buildWaitStreakLine` renders ONE neutral verbatim fact line
into the three deliberations that offer the choice — `buildReachoutPrompt`,
`decideTriageViaLLM`, and the ambient Discord presence block — no advice,
no thresholds, no gate changes (the experiment contract: only the
information varies). `streakAtDecision` is stamped into
`triage-events.jsonl` / `reachout-events.jsonl` so the ward can correlate
streak values with decisions. Off: `waitStreakEnabled:false` or
`PROTO_FAMILIAR_WAIT_STREAK_DISABLED=1` — disabled means no recording AND
no line, and the affected prompts are byte-identical to their pre-feature
output.

**`discord-gateway.js`** — autonomous singleton (Village V4). A
supervisor tick (30s) compares Settings (`discordEnabled`,
`discordBotToken`) against the live connection and starts / stops /
restarts to match — no server restart needed. The gateway itself is a
native-WebSocket client (Node ≥ 22) implementing identify / heartbeat /
resume / backoff. Fatal states park it until Settings change (cleared on
token change or via `applyDiscordSettings()`): WS-level fatal close codes
(missing privileged intents) **and** a `401`/`403` on the REST `/gateway/bot`
handshake (rejected/reset token) — the latter sets `fatal` instead of
looping silently, so the UI surfaces "token rejected" rather than a green
light over an endless retry. Inbound `MESSAGE_CREATE` flows
through `classifyMessage()` (pure, tested): ward DM → ward-private
turn; registered-villager DM → gated turn; guild → governed by the
location's **presence mode** (Village V8): `strict` (default — reply
only when @-mentioned or replied-to), `lurk` (read the room, reply only
when addressed), or `active` (may chime in unprompted). The location
ceiling is ALWAYS in the audience (unassigned room = Strangers). Each
location is a session in `logs/` (rotated after 6h idle; map in
`tomes/.discord-map.json`), participants accumulate, and the audience is
re-resolved per turn from the accumulated list. Ward messages also run
crisis-signal scoring + threat recording (`source: 'discord'`) on the
reply path. Discord turns never consume handoffs (`liveTurn: false`).
Memorization of Discord sessions is deferred until
memories carry audience tags (see village-support-design.md).

*Villager consent self-service (0.8.106, `villager-consent.js`).*
`!consent` in a REGISTERED villager's own DM is a pure-code surface (no
LLM): a menu of what the Familiar holds about them (`memory_list_by_subject`
— kept facts where they are a recorded subject, thin briefs), what is
pending review about them, and their per-category remember settings, which
they change themselves (`!consent keep|ask|never <category|all>` →
`setVillagerRemember`). A keep/never answer also settles their PENDING
items in those categories (confirm/drop + queue prune) — the original
meaning of "ask": the person the fact is about answers, not only the ward.
Changes are audit-logged (discord-writes) and visible in the ward's
Village UI; strangers never reach the code (ignored upstream); in a guild
room the command is ignored (personal data never renders in a room); the
ward's DM points at the Village UI. The villager-DM presence block tells
the Familiar the command exists so it can offer it.

*Visual consent menu (0.8.107).* Bare `!consent` now sends a Discord
component message (embed + category select + buttons) instead of the text
wall; the text menu remains the automatic fallback when the component
send fails, and `!consent keep|ask|never …` still works as before
(accessibility + scriptability). One message morphs between views via
interaction callback type 7 (UPDATE_MESSAGE): home (settings summary +
select + "What I remember (N)" / "Waiting for review (N)" / Done) →
category view (keep/ask/never buttons) → paginated memories view →
pending view (Keep all / Ask me later / Never buttons that settle the
backlog). View builders are pure (`villager-consent.js`, `pfconsent:*`
custom_ids); the gateway routes `INTERACTION_CREATE` (component type 3,
`pfconsent:` prefix) through `handleConsentInteraction`, which
**re-resolves identity from the interacting user's Discord id on every
click** — custom_ids carry only actions, never trusted identity; a
non-villager click strips the controls. Set/settle actions run through
the same `applyConsentAndSettle` helper as the text path (shared, not
copy-pasted) and the same audit log. DMs are inherently private, so no
ephemeral flag is needed.

*Ward console — `!queue` + `!connection` (0.11.19, `ward-consent-queue.js`,
`ward-connections.js`).* The ward-facing twins of the villager consent menu,
same discipline (pure builders, gateway does the I/O, no LLM). Shared
component primitives (`btn`/`row`/`EMBED_COLOR`/`expiredView`) now live in
`discord-menu-kit.js`, used by all three menu modules instead of copied.
Both commands are **ward-DM only** (personal data + settings never render in
a room) and intercepted before any turn, beside `!update`/`!call`.
  - **`!queue`** — the pending memory-consent queue as a component menu:
    paginated list, a picker to open one item (Keep it / Drop it), and
    Keep all / Drop all. Keep → `confirmConsentMemories`, drop →
    `dropPendingMemories`, both then `pruneConsentPending` (shared
    `settleQueueItems`). Reads the same `.consent-pending.json` the web
    `[PENDING MEMORY CONSENT]` block shows. `pfqueue:*` custom_ids.
  - **`!connection`** (also `!conn`/`!model`, plurals accepted) — set the
    active connection (`primaryConnectionId`) and route each background
    feature (`featureConnections`, the six `connectionForFeature` keys,
    mirroring `FEATURE_CONNECTIONS` in `public/app.js` — a test guards the
    two against drift). Writes go through `patchWardSettings`: the same
    locked, atomic, wholesale-top-level `mergeSettings` write the HTTP
    `PUT /api/settings` uses, so a Discord change and a web change can't
    tear the file. `pfconn:*` custom_ids; a `__default__` sentinel clears a
    feature override back to the primary.
  - Both interaction handlers **re-check that the clicking user is the ward**
    on every event (`interactionIsWard` → `discordWardUserId`) — a villager
    clicking a forwarded control is refused. The gateway's
    `INTERACTION_CREATE` dispatch routes by custom_id prefix
    (`pfconsent:`/`pfqueue:`/`pfconn:`). Ward `!consent` now points at both
    new commands (discoverability) rather than only the web app.

*Clearance-gated tools (V10, `docs/discord-tools-build-spec.md`).*
`handleTurn` runs a tool loop (reusing `cerebellum.runToolCallLoop`;
`callChatRaw` supplies the full provider response with `tool_calls`)
whose toolset follows the SPEAKER: ward alone → full web parity
(`composeActiveTools`); a registered villager → the universal
`relay_to_ward` + a fail-closed allowlist from their `audience.js` grants
(`composeDiscordTools`/`villagerToolNames`; `schedule`/`memories`/`contacts`
ladders → their read/write tools, deletes + Google-push held ward-only); a
stranger → none. The result gate is `discordReadAudiences(ctx)` — a gated
non-ward read scopes to the room's `audienceVisible` set, **fail-closed to
`[]`** (Phylactery `0=1`) so a tool result can never leak ward-private data;
`recall` routes through it, `searchMemory` forwards the Pillar E `audiences`
filter. Villager writes carry provenance (`discordWriteProvenance` →
`source_meta` in `source_json`, surfaced on recall by `_source_label`) and
are audit-logged (`discord-write-log.js` → `GET /api/discord-writes`). A
whole-loop failure falls back to a plain reply; a tool chain with no closing
text stays quiet. Default ON (`discordToolsEnabled`); off-switch
`PROTO_FAMILIAR_DISCORD_TOOLS_DISABLED=1`.
Off-switch: `PROTO_FAMILIAR_DISCORD_DISABLED=1`. Observability:
`GET /api/discord/status`.

*Presence modes (V8).* Messages the Familiar isn't addressed in resolve
to `action: 'observe'` (lurk, and active turns it sits out): the message
is appended to the session for context, nothing is sent, no LLM call —
and deliberately **threat-neutral** (observing never moves the ward's
activity clock or threat tier; that stays on the reply path, out of the
safety-critical surface). Active-mode pacing is `decideAmbientReply()`
(pure, tested) over a volatile in-memory `ambientState` (per-location
`lastTurnAt` + recent message timestamps): a hard `activeCooldownSec`
floor on unprompted turns plus one of two ward-toggleable strategies —
`llm` (model decides each time; abstains via a bare `[pass]`, detected
by `isAmbientAbstain`) or `tiers` (pure-code slow/medium/fast cadence
scaled off the cooldown). The V3 knowledge gate runs identically in
every mode — mode is *when* the Familiar speaks, never *what it knows*.

*Active-mode reply batching (V8.x).* An unprompted turn no longer replies
once per message — a burst coalesces into ONE reply to the whole block,
the way a person catches up on a few lines at once. The first reply-worthy
ambient message arms a per-location settle timer (`scheduleAmbientBatch`)
instead of replying; later messages in the burst fold into the session log
via the existing `observeMessage` path (so they land in history) and reset
the timer; when the room goes quiet the single held trigger runs through
`handleTurn`, which already reads the whole log. The settle window adapts to
room pace — `adaptiveSettleMs()` (pure, tested) waits ~1.5× the typical
recent inter-message gap, clamped to [2s, 12s], with a 25s hard age ceiling
so a never-quiet room still gets answered; `markAmbientTurn` (the cooldown)
fires when the batch does. **Only ambient turns batch** — a direct @-mention
replies immediately and `cancelAmbientBatch` folds any pending burst into
history so it isn't answered twice. Off-switch:
`PROTO_FAMILIAR_DISCORD_BATCH_DISABLED=1` reverts to per-message replies.

*Room legibility (V8).* `resolveMentions()` (pure, tested) rewrites
inbound `<@id>` / `<@!id>` tokens to `@Name` (my own char name → a
registered villager's name → the payload display name → `@someone`)
before the text reaches the model, in both the reply and observe paths —
raw snowflakes leave the Familiar unable to tell who a message names. On
an ambient turn `directedAtOthers()` (pure, tested) collects the names a
message was explicitly aimed at (other-user @-mentions + a reply target,
excluding me) and feeds them to the presence block, so an active-mode
Familiar can distinguish "this exchange is between them" from open-room
chatter and weigh both costs (barging in vs. a missed moment of
presence) instead of treating every unaddressed line as its cue.

But the *triggering* line of an exchange is often the only one that's
tagged — "@Nichtschwert, you and I?" is, but Nichtschwert's untagged
"sure, what's up?" that follows is not, even though it plainly continues
their two-person thread. `directedAtOthers()` alone would read that
follow-up as open-room and the Familiar would barge in. So every stored
message (spoken and observed) records structured per-message signals —
`speaker`, `targets` (others it named), `namedMe` (whether it pulled me
in) — and on an ambient turn whose own line names no one,
`carriedExchange()` (pure, tested) walks the recent history for the most
recent message that named only others (and didn't pull me in): its
speaker + named parties are a live exchange, and if the person speaking
now is one of them, this line continues *their* thread, not an opening
for me. It reads only the structured fields — no parsing of display text
— so it stays reliable code, not a guess about tone. A line that names
me cancels the carry-forward (the room turned toward me). The open-room
presence branch is correspondingly worded to make the model *read* for an
untagged exchange between others rather than treating any unaddressed
line as its cue — absence of a tag on one line is not proof the room is
open.

*Other bots & Familiars (V8).* My own messages are ALWAYS ignored (the
inner loop guard, above the opt-in). *Other* bots — including other
Familiars — are ignored by default (`reason: 'bot-author'`); a location
with `readBots: true` lets them through `classifyMessage` as normal, so
they're answered when addressed and paced by the room's mode +
`activeCooldownSec` + rate limit otherwise. For shared Familiar
channels; the loop is the ward's to pace, not a hard block.

*Silence tags are leading-commands (0.8.106).* `[pass]` / `[silence]` /
`[later:…]` count when they LEAD a message, not only when they are the
whole message — the tag is the command; trailing text is the model's
private reasoning (logged, never posted). `deliverReply` additionally
strips any leading control tag on every delivery path and skips the send
when a reply was only tags, so a control token can never reach a room.

*Deferred presence (V9).* Ambient turns now have a third option beyond
speak / `[pass]`: `[later:…]` schedules a revisit. Three syntax forms —
relative (`[later:15m]`), wall-clock (`[later:22:30]`), and named
buckets (`[later:soon]` ~15min / `[later:later]` ~45min /
`[later:much-later]` ~1h). Clamped to [5min, 1h]; may re-defer up to
2× total. Persisted in `tomes/.discord-revisits.json`. A self-arming
timer (`armRevisitTimer`) fires the soonest-due entry and re-arms; it
is armed on every `READY` (so the bot token is present before a timer
could fire, and a disable→enable cycle re-arms) and cleared in
`teardown`. Any real incoming message at a location supersedes its
pending revisit (`cancelRevisitsForLocation`). Revisit turns are
threat-neutral and never move the ward's activity clock.

A revisit speaks into a *shared* room, so `fireRevisit` runs the exact
same safety spine as a live turn: it resolves the knowledge gate from
the room + accumulated participants (`resolveLocationGate` →
`resolveAudience`/`audienceTagFor`, never ward-private context in a
guild), and delivers through `deliverReply` — the shared Pillar D
outgoing-filter → send → persist → rate-slot → status path that
`handleTurn` also uses. The two paths share one delivery function so
neither can drift from the other or skip a gate the other applies.

Session history now renders `[HH:MM]` timestamps (server local time)
before each speaker prefix, so the model can read exchange rhythm and
gaps directly. `carriedExchange` gains a `maxAgeMs` staleness gate
(default 1h) so exchanges older than that are not carried forward as
live threads.

### `memorization.js` — autonomous per-fact memorization (Pillar C)

Persistent queue at `tomes/.memorization-queue.json`, 5-second tick,
exponential backoff, idempotent enqueue on
`sessionId+scope+topicId+messageRange`.

**Extraction** uses a per-fact format: LLM returns
`{facts: [{content, category, subjects, temporality, confidence}], relations: [{from, fromType, type, to, toType}]}`
where `category` ∈ `basics | emotional_content | health_info | relationships | whereabouts`
and `temporality` ∈ `episodic | standing` (default `episodic` when unsure).
Facts with `confidence < 0.4` are silently skipped.

**Source-aware consent (0.8.88).** The remember gate keys on WHO a fact is about
and WHETHER my human told me directly — not category alone. `resolveRememberGate`
takes `{direct, hasNamedSubjects}`:
- **Direct + about my human themselves** (a DM / web chat, `audienceTag ===
  'ward-private'`, no named third party) → **implied consent**: kept without
  asking. They told me on purpose. This only fills the UNSET default — an
  explicit ward `ask`/`false` in the remember map still wins.
- **A third person's private life** (a registered villager subject, or any
  named-but-unregistered person via `hasNamedSubjects`) → still asks for
  sensitive categories, whatever the channel. A stranger's sensitive fact is
  never swept in by implied consent.
- **Indirect** (a group room, `direct=false`) → asks, as before.

This is what stops the confusing flood of date-less asks for things my human
said to me directly. The `[PENDING MEMORY CONSENT]` block now carries each
item's `date` and a `reason` (`shared-room` / `third-party`) so the ask is
explained and time-anchored, and the block states up front that directly-told
self-facts are already kept.

**Temporality → storage tier.** `episodic` facts land at `daily` (standalone,
dated — the memory of a day, consolidates + decays). `standing` facts are
"generally true now", not a memory of a day: a standing fact about my human goes
on the **`ward` register** (`register` passthrough in `createMemoryFull` →
`significant`, recalled-when-relevant, never day-bucketed); a standing fact about
a specific person is a durable `significant` person-attached row. The extractor
tags temporality, so a fact already knows whether it's dated or standing before
it's stored.

**Shared graph rubric (`graph-vocab.js`, 0.7.63).** What earns a node/edge is defined
**once** and read by every surface that creates one: the entity-type vocabulary
(`person, place, organisation, pet, condition, project, thing`), the **no-abstractions**
rule (the single biggest driver of graph quality — keeps "stress"/"work-life balance"
from becoming nodes), and the edge rule (both endpoints concrete, never invented,
snake_case type). Both memorization prompts (`buildPrompt` / `buildSharedRoomPrompt`)
and the chat-path tools (`create_graph_node` / `create_graph_edge`) interpolate the same
constants, so a node made mid-chat is held to the same standard as one made during
memorization — closing a drift where the vocabulary differed across three surfaces and
the chat tools lacked the no-abstractions rule. The Python `graph_relate` /
`graph_node_create` docstrings carry the same list by hand (sync comment in both).

**Tiering — standalone `daily` facts (0.8.2):** extracted facts land at the
`daily` tier (the doc's baseline for conversation-derived memory), written with
`standalone: true` so each keeps **its own row** carrying its `category` /
`subjects` / `consent_pending` / `confidence` — instead of being mis-filed as
`significant`. In `memory.create` there are now three storage shapes:
`significant` (own row keyed `date_slug`, a rare deliberate milestone),
`standalone` (own row keyed by the **plain date** so consolidation's range
filter still rolls it up; a `slug` marks it so the journal bucket never absorbs
it), and the date-bucketed journal (`daily`/`weekly`/… with `slug` NULL, content
appended as bullets). Reserving `significant` for true milestones means these
facts now **consolidate** (`daily→weekly→…`), **decay**, and are caught by
exact-dup hygiene (which groups by `granularity,date_key,content` — significant's
unique `date_slug` had escaped it). After a weekly rollup, the consolidated daily
sources are **pruned** (snapshot first, recoverable) so the tier doesn't pile up;
`consent_pending` dailies are excluded from both the summary and the prune, so an
unreviewed fact is never baked into a permanent weekly note before the ward
approves it.

**Day-anchored fact dates + by-id addressing (0.7.61).** Because many standalone
facts share one plain `date_key`, that key **cannot** address a single fact —
`read_memory(granularity, date)` returns whichever row comes first. Two fixes:
- **The date now rides through.** `processJob` passes the day-scoped job's
  `topicId` (the segment's calendar date) as `createMemoryFull({ date })`, so a
  slice from an older conversation files under **its** day, not today. Without this
  every imported fact landed in today's bucket (the "159-into-today" bug).
- **By-id is the unique handle.** `memory.py` gained `read_memory_by_id`,
  `update_memory_by_id`, `delete_memory_by_id`, and `move_memory_date` (re-files a
  mis-dated fact — only the day moves; significant rows rebuild their `date_slug`).
  Exposed as MCP tools (`memory_read_by_id`, `memory_move_date`,
  `memory_update_by_id`, `memory_delete_by_id`), thalamus wrappers, the Familiar's
  `read_memory_by_id` / `move_memory_date` / `update_memory_by_id` /
  `delete_memory_by_id` tools (ids ride in on `recall` / `list_memories`), and the
  HTTP `/api/entity/memories/by-id/:id` surface (GET/PUT/DELETE + `…/move`). The
  Knowledge-editor memory panel now opens, edits, moves, and deletes by id — fixing
  the bug where every row opened the same entry.
- **The mass-overwrite guard (0.7.64, audit finding).** `granularity+date_key` is
  unique ONLY for the journal bucket (`slug NULL`) and significant rows (slug baked
  into the composite key) — **not** for standalone per-fact rows that share a plain
  date. So the by-date `update_memory` / `delete_memory` now scope to `slug IS NULL`
  when no slug is given: a no-slug update was previously an **un-scoped** `UPDATE …
  WHERE granularity=? AND date_key=?` that would rewrite **every** standalone fact
  on that date with the same content. By-date now only ever touches the journal
  bucket; per-fact rows are by-id only, and the Familiar's `update_memory` /
  `delete_memory` descriptions steer it to the `_by_id` variants for a single fact.

> **Tiering is one of two axes; don't conflate them.** `granularity`
> (`daily…significant`) is the rollup tier this section touches. A memory record
> *also* has a **`register`** field — `episodic | me | ward` — which is a
> **separate axis** (`phylactery-design.md:272`). The memorization pipeline only
> produces **`episodic`** facts; the `me`/`ward` registers hold *standing truths*
> about the Familiar (`me`) or the human (`ward`). They are reached two ways:
> autonomously by *graduation* (Pillar H moves identity-file detail off the
> always-injected surface, created at `significant`), and **deliberately by the
> Familiar** via `save_memory`'s `register` choice (0.8.6 — a me/ward write is
> filed as a standalone `significant` fact on that register; the lighter sibling
> of `update_identity`). `me`/`ward` are **not** `granularity` values.
>
> **Legibility (0.8.6 / 0.7.48):** `memory.search`, `memory.list_memories`, and
> `memory.read_memory` all carry each record's `register`. Thalamus tags
> `me`/`ward` recalls (`a standing fact about my human · …`) so the *Familiar* can
> weight an identity-grade fact differently from a passing episodic moment, and
> the *Knowledge editor* badges them (`standing · self`/`ward`) in the memory
> browse list + detail so the **human** can see them too. Without this the
> register was invisible on both surfaces.

**Semantic dedup-merge (0.8.0):** `memory.create` (Phylactery) runs a KNN
similarity check before inserting a significant / standalone / consent-pending
memory. A near-identical paraphrase (sim ≥ 0.85) folds into the existing entry
(bumps `updated_at`, no new row); an additive near-dup (sim ≥ 0.78) appends the
new detail. A per-fact row only dedups against other per-fact rows
(`slug IS NOT NULL`), never into a journal bucket. Consent-safe: an unconsented
detail is never folded into an already-confirmed memory (it gets its own row).
The merge marker rides back through `memory_create` → `thalamus.createMemoryFull`
→ `memorization.js`, which skips re-queuing a merged dup for consent. This is
what stopped the "82 queued, only 5 new" duplicate pile-up.

**Pending-queue dedup (0.8.27):** the confirmed store's conservative bar leaves
the *review* queue noisier than it should be — a reworded restatement of a
not-yet-reviewed fact lands just under 0.78 and both survive as separate
pendings. So a `consent_pending` incoming fact now takes a distinct path
(`_dedup_merge_pending`, separate from the untouched confirmed-store logic):
a looser threshold (`_DEDUP_PENDING_MERGE_MIN = 0.70`) and **audience-agnostic**
matching (the same pending fact is a dup regardless of the room-tag it was
derived under; audience still gates where a memory *surfaces*). Two directions:
a pending near-dup of another *pending* fact folds together (one queue candidate,
not five paraphrases); a pending near-dup of an already-*confirmed* memory is
**dropped** as `already_known` — the ward already greenlit it, so re-asking is
suppressed — and the confirmed row is left byte-unchanged (unreviewed wording
never folds into a consented memory). The confirmed-store threshold that protects
long-term memory from conflating two real facts is never loosened.

**Ward standing consent (0.8.27):** the middle tier between "ask about every
fact" and flipping a whole category to permanent "Store freely". Per category,
the ward can open a time-boxed window ("trust his judgment for 6h/24h/7d/30d");
while it's open, an `'ask'` category's ward-self facts auto-confirm (stored, not
queued). Stored as an absolute epoch-ms expiry in `remember_standing.json`
(no timezone math — a machine value the server derives from the chosen preset,
never typed). Phylactery tools `remember_standing_get` / `remember_standing_set`
(`remember.py`, returns active-only grants) → thalamus `getStandingConsent` /
`setStandingConsent` → the gate in `memorization.resolveRememberGate`
(`wardStandingActive` promotes `'ask'`→`'true'`; never overrides `'false'`, never
touches villager-subject facts). Surfaced in the Ward · Remember settings panel;
when the pending queue reaches ≥4 items the Familiar's consent block reminds it
it can *offer* the ward standing consent (the grant is the ward's to make).

**Auto-graph (0.8.1):** the same extraction call also returns `relations` —
concrete edges between named entities (person/place/organisation/pet/condition/
thing; never abstractions). `parseRelations` normalises and within-job-dedups
them (never throws — enrichment, not load-bearing), then `processJob` routes each
via `thalamus.graphRelate` → Phylactery `graph_relate` (`graph.relate`), which
resolve-or-creates both endpoints by case-insensitive label and dedups the edge
by `from/to/lower(type)`. Fire-and-forget per edge (Promise.allSettled), gated on
`created > 0` so a fully gate-dropped session doesn't quietly rebuild the graph.
This rides the existing memorization LLM call (no new request) and fixes the
"Familiar almost never saves to the graph unless prompted" gap.

**Graph-node audience derivation (Pillar E, 0.7.x).** Each endpoint's audience is
derived **in code** before routing: `audience.deriveNodeAudience({ label,
registry })` matches the label to a known villager (by name/handle) and takes that
villager's representative Village category, else **`ward-private`** (fail-closed —
places, orgs, the ward, abstractions stay private until deliberately widened). The
edge takes the **narrower** of its two endpoints (`mostRestrictiveAudience`) so it
can't reveal a ward-private node in a wider room. These ride into `graph_relate`'s
`fromAudience`/`toAudience`/`edgeAudience` (and the Familiar's `create_graph_node`
derives the same way). Audience tags only **new** nodes — `resolve_or_create_node`
never re-tags an existing node, so a deliberate override isn't clobbered by ongoing
memorization. The deliberate-override surface is `graph_node_update`'s `audience`
(Familiar tool `update_graph_node`, or the Knowledge-editor node popover's audience
dropdown) — how the ward/Familiar widens a node to a circle or keeps it to just the
two of them. Graph gating is the structural `audience` column + the Phase-1 recall
filter; the `<!-- gate: -->` comments are an **identity-file** mechanism only and
were never used in graph descriptions.

**`remember` gate** (per villager, per category):
- `true` → store freely in Phylactery
- `false` → drop silently
- `ask` (or no `remember` map on the villager) → store immediately with
  `consent_pending=1` and record the ID in `tomes/.consent-pending.json`

When multiple villagers are subjects of a fact, the most restrictive
gate wins (`false > ask > true`). Default when no villager map exists:
`basics=true`, all others=`ask`.

**Standing mutual consent (0.8.3):** a villager record can carry
`standingConsent: { wardAgreed, villagerAgreed }`. When **both** are true
(`village.standingConsentActive`), `resolveRememberGate` clears that villager's
`ask` to `true` — no more per-fact consent prompts about them — but an explicit
`false` category still hard-blocks (a convenience toggle never overrides the
ward's veto). Set two ways: the Village-UI consent checkboxes, or the Familiar's
`village_upsert` tool (`mutualConsentToRemember`, ward-private only).

**Write-time audience derivation (Pillar C → Pillar E, 0.7.x).** Each per-fact row
is now stamped with the audience tag that gates its later recall — derived **in
code** by `audience.deriveMemoryAudience({ category, subjects, sessionTag,
registry })`, never asked of the extractor (a tag the LLM could forget is a tag
that could leak). The rule is **session-bounded by default, widen/tighten by
explicit consent**: with no per-subject preference a fact is capped at the room it
was made in (`audienceTag`), and a sensitive category (`health_info`,
`emotional_content`) is floored to `ward-private`. A subject villager may carry a
`disclosure` map (per remember-category → a Village category id, or
`ward-private`); an explicit entry **overrides** the default in either direction —
widening a ward-private fact out to a named circle, or tightening past the session
ceiling — and even overrides the sensitivity floor, because that is the data
subject's own stated consent. With multiple subjects the **narrowest** circle wins
(everyone named must be comfortable with the room). The ward sets `disclosure` in
the Village UI (a per-category dropdown beside the consent toggles); the Familiar
sets it in first person via `village_upsert`'s `disclosure` argument (circle names
resolved to ids, ward-private only for edits). The derived tag rides into
`createMemoryFull({ audience })`, where it becomes the `audience` column the Pillar
E recall gate filters on.

**Consent flow:** `thalamus.enrich()` reads `.consent-pending.json` cheaply
(no MCP round-trip) and injects a `[PENDING MEMORY CONSENT]` block when
non-empty. The Familiar calls `memory_confirm_consent(ids)` or
`memory_drop_pending(ids)` (both in `BUILTIN_TOOLS`); `pruneConsentPending(ids)`
then removes the handled IDs from the local file.

**Day-anchored coverage (Phase 1 of the day-anchoring keystone, 0.7.x).** Session
memorization is now tracked per **local calendar date**, not per session.
`day-segments.js` `segmentByDay(messages)` derives per-date slices from a session
log (Hybrid model — the live log stays one intact file; segmentation is logical,
at memorize time; a midnight-crossing session becomes two slices). `memorization
.enqueueSessionByDay()` enqueues one job per date-slice (`scope:'day'`,
`topicId:<date>`, `messageRange`), skipping slices the **coverage ledger** already
marks memorized. **Tail-only ingestion:** for a day that's only *partly*
memorized (a session that kept growing on the same date), `enqueueMemorization`
slices to the un-memorized tail via `day-segments.dayDelta(messages,
segmentMemorizedThrough(...))` and stamps `priorThrough` on the job — so the
earlier messages are never re-read, which is what stopped the consent queue
filling with duplicate / already-known facts re-minted from the same
conversation each run. A tail with < 2 readable messages waits rather than
spawning an empty job; the manual `force` re-memorize passes `fullSegment` to
deliberately re-read the whole day. On completion `processJob` calls
`memory-coverage.recordSegmentRun()` with the **cumulative** through-count
(`priorThrough + delta length`), so a tail-only run still advances coverage to
the full day (a day slice with zero kept facts is still *done* — it's recorded,
not retried; shared-room slices get a `'shared-room'` flag). The ledger
(`tomes/.memory-coverage.json`) stores only what's been memorized per
(date, session); `computeCoverage()` reads the logs live and derives per-date
status (`complete | partial | uncertain | empty`) by comparing the two — so the
active day reads `partial` the moment new messages land. Dates use server-local
time, stamped in the ledger. **Phase 3 (calendar UI):** the Knowledge editor's
**Coverage** tab renders a month calendar coloured by status (`computeCoverage()`
via `GET /api/memory-coverage`); clicking a day lists its sessions and offers
"Memorize this day" (`POST /api/memorize-day`, `collectDateSlices` → per-slice
enqueue, `force` to re-run done days). **Phase 2 (always-on sweep):**
`memory-sweep-loop.js` — a 10-min pass that enqueues the missing slices of every
*past* incomplete day (skips today, handled live; skips completed days). Only
enqueues into the memorization worker (no LLM call of its own); default-ON,
Settings "Memory coverage sweep" / `PROTO_FAMILIAR_MEMORY_SWEEP_DISABLED=1`.
**Phase 4 (foreign-log import):** `POST /api/import-logs` (preview → commit) +
`log-import.js` parsers place foreign logs by date (one imported session per
date) and enqueue them for immediate ingestion (confirm-gated in the Coverage-tab
import form). Parsers: Proto-Familiar JSON, SillyTavern `.jsonl` (`is_user`→role, ISO
`send_date`), OpenClaw `.jsonl` (event stream — `type:'message'` events, content
blocks), timestamped text. Undated logs are dated by an explicit `fallbackDate`
or one read from the filename (`dateFromFilename`); if neither exists the preview
asks for a date. *(see `docs/day-anchoring-build-spec.md`.)*

**Triggers** (all session-scope triggers route through `enqueueSessionByDay`;
topic-scope stays whole-range):
- Web: client calls `POST /api/memorize` on session end (fetch or sendBeacon),
  and the sidebar "Memorize now" button (`memorize-now-btn`) for on-demand.
  Always `audienceTag: 'ward-private'`.
- Discord: `discord-gateway.sessionForLocation()` enqueues the old session
  when idle rotation fires (session has been quiet ≥ `SESSION_IDLE_ROTATE_MS`).
  `audienceTag` comes from the stored session log.
- **Familiar self-trigger (0.8.4):** the `memorize_now` tool. When the Familiar
  judges the conversation holds things it must carry across instances — and a
  clean rollover may never happen (the human switches sessions / clears history)
  — it commits the session itself. The executor reads the session id from the
  tool context (`sessionInfo.sessionId`) and delegates to `memorizeSessionNow`
  (server.js, injected via `initCerebellumTools` to avoid the cerebellum↔
  memorization import cycle), which reads the clean on-disk log and enqueues the
  same pipeline. No new request beyond the chat turn it rides; degrades to a calm
  first-person line, never throws into the tool loop. (Single deliberate facts
  still go through `save_memory`; this commits the whole exchange.)

**Off-switch:** `PROTO_FAMILIAR_MEMORIZE_DISABLED=1` (the worker; `memorize_now`
just enqueues, so it honours the same switch — a disabled worker won't drain).

### Migration: entity-core → Phylactery (Pillar F)

One-time, snapshot-first, idempotent conversion run via:

```
npm run import-entity -- --from /path/to/entity-core [--yes]
```

`scripts/import-entity.js` resolves the source data directory (accepts
both an entity-core root with `src/` + `data/`, or a bare data dir with
`self/` / `memories/` / `graph.db`), confirms with the operator, then
invokes the Python migration module:

```
cd phylactery/ && uv run python -m phylactery.migrate_from_entity_core \
    --source <sourceDataDir>
```

`phylactery/src/phylactery/migrate_from_entity_core.py` phases:

- **Phase 0** — Snapshots Phylactery before any writes (recovery baseline via
  `snapshot.auto_snapshot`). Safe to run multiple times: already-migrated records
  (matched by `source_json.originalId`) are skipped.
- **Phase 1a** — Identity `.md` files from `self/`, `user/` (→ `'ward'` category),
  `relationship/`, `custom/` are inserted into `identity_files` with
  `audience='ward-private'`.
- **Phase 1b** — Memory `.md` files from all five tiers (`daily/weekly/monthly/
  yearly/significant/`) are inserted into `memories`, date-key preserved, with
  `audience='ward-private'`.
- **Phase 1c** — `graph.db` nodes and edges are inserted into `graph_nodes` /
  `graph_edges` with `audience='ward-private'`. Schema columns are probed
  gracefully; missing `graph.db` or unrecognised schema is skipped with a warning.
- **Phase 2** — Prints `type='person'` nodes for manual villager-match review.
  No auto-merge of person nodes ↔ villagers.

The `identity_files.category` rename (`'user'` → `'ward'`) is enforced at
migration time (Phase 1a) and by SQL migration `0003_pillar_f_ward_rename.sql`
for any pre-existing rows. After migration, entity-core is not started;
Phylactery is the sole canonical store.

### `outgoing-filter.js` — Pillar D outgoing gate

Post-response, pre-send semantic gate for non-ward-private rooms. Runs in the
non-streaming tool-call loop path in `server.js` and in the Discord reply path.
Streaming replies bypass the filter (content is already in-flight as deltas).

**Flow:**
1. If `audienceTag === 'ward-private'`, return immediately — no check needed.
2. Call `memory_search_restricted(query, roomAudience)` via Phylactery, which
   searches for ward-private memories semantically close to the draft text.
3. If similarity score ≥ `FILTER_THRESHOLD` (0.70), send a rejection nudge
   (second-person prompt per build-spec §3 — the one sanctioned exception to
   the first-person convention) and retry `callUpstream`.
4. After `FILTER_RETRY_BUDGET` (3) retries without a clean draft, emit
   `FILTER_SAFE_REFUSAL`: "I can't share that here — something in what I was
   about to say isn't cleared for this room. If you need that information,
   ask me somewhere private."

**Failure mode:** any error in `searchMemoryRestricted` returns `{hit: false}`,
so the filter always fails open — a Phylactery outage never blocks a reply.

**Parameters signed off by the human (build-spec §7):**
threshold=0.70, retry budget=3, safe-refusal text as above.

### Pillar E — audience-gated recall (`audience.js` + Phylactery)

`fetchEligibility` decides *whether* the memory/graph fetch runs for a room;
**the recall gate decides *what comes back*.** **Graph follows the memory grant**
(0.7.66): the graph is relational memory, so `doGraph = doMemory` (a room with
`memories: true | 'shared'` also fetches the graph), and the per-node `audiences`
filter below scopes it node-by-node. This replaced a gate on a `graph` grant that
**no Village category ever granted** — graph enrichment was therefore silently OFF
in *every* non-ward session (memory still worked, so the symptom was "graph stopped
enriching but memory didn't"). The per-node tags now do the real privacy gating, so
the coarse grant was both unsatisfiable and redundant. `audience.js` `visibleAudiences
(sessionAudience, registry)` computes the SET of audience tags a room may see by
circle **MEMBERSHIP**, not a scalar trust score (audit 2026-07: the score model
let two circles with equal `permissionScore`, e.g. "Family" and "Work", see each
other's records — trust is not a total order). The set is the INTERSECTION of
every participant's membership set (`categoryIds ∪ {strangers}`, unknown → just
`strangers`), intersected with the location's set (`{assignedCategory, strangers}`
assigned, `{strangers}` unassigned) — a record tagged circle X surfaces iff
**everyone present is a member of X**. `strangers` is always in the intersection
(everyone is a stranger), so strangers-tagged records stay visible everywhere
gated; `ward-private` is never a category → never in the set; a deleted/unknown
category id is in no membership set → excluded (fail-closed). `audienceTagFor`
tags a room with the most-trusted circle everyone SHARES (permissionScore's only
surviving role: ranking the shared circles), so a memory written in a room
round-trips (its tag is in that room's set by construction).
`server.js`/`discord-gateway.js` compute
this set and pass it into `enrich({ audiences })`, which forwards it to
`memory_search` / `graph_node_search` / `graph_subgraph`. Phylactery's
`audience_in_sql(audiences)` turns it into `audience IN (…)` (None → `1=1` for a
ward room; `[]` → `0=1`); `memory.search`, `graph.search_nodes`, and
`graph.get_subgraph` (all three fetches, incl. the subgraph endpoint backfill)
filter through it. Fail-closed: a record tagged with a deleted/unknown category
is absent from the set → excluded; a registry-read failure leaves
`audiences=null` only on the ward path.

**The leak this closed (0.7.x):** the room tag was never passed, so recall
defaulted to `ward-private` → `1=1` → ward-private memories/graph surfaced in the
Familiar's *context* in trusted shared rooms. (The old `audience_filter_sql` also
kept `ward-private` in the non-ward `IN`-list — a second leak — left for the dedup
path; recall now routes through `audience_in_sql`, which doesn't.) The outgoing
filter (Pillar D) remains the send-side backstop; together they are the two gates
the design intended. See `docs/audience-gating-build-spec.md`.

**Content-tag layer (content-gating Phase 4, 0.9.23).** The `audiences` set above
is the *coarse* floor (ward-private + provenance ceiling); a *fine* per-topic
gate now composes on top of it for MEMORIES. Each memory carries a `content_tag`
(`topic:level`, e.g. `medical:sensitive` — Phase 3); each Village tier grants a
per-topic level map (`grants.topics`, Phase 2). `audience.js`
`topicGrantsForRoom(effectiveGrants, roomTag)` — the companion to
`visibleAudiences`, derived together at every seam so the two halves can't drift —
returns the room's most-permissive-per-topic map (`null` for a ward room, `{}`
fail-closed for a villager room with no topics). It rides `enrich({ topicGrants })`
→ `memory_search`, and the standalone `searchMemory`/`memByTimerange` wrappers
(threaded from the Discord tool ctx via `cerebellum.discordReadTopicGrants`, the
fail-closed companion to `discordReadAudiences`). Phylactery's `memory.search` /
`memory.by_timerange` take `topic_grants` and post-filter each row through
`content_gate.memory_visible_to_grants` (the Python mirror of `content-tags.js`),
overfetching so the drop still fills the limit. **Visible ⟺ clears the coarse
floor AND the content gate.** Fail-closed: no tag → `general:sensitive`; unknown
topic / absent grant → hidden. Graph nodes/edges keep the coarse `audiences` gate
only (no `content_tag`). Ward-context recall (pondering, tome-graduation dedup,
the ward's own endpoints) omits `topic_grants` → ward sees all, unchanged. See
`docs/content-gating-build-spec.md` §Phase 4.

### Pillar H — lifecycle: consolidation scheduler, hygiene, graduation, backup

**Consolidation scheduler** (`scheduler.py`) — Phylactery's own internal
background worker (daemon thread, 5-min wake cadence, **volume-gated** so an
idle Familiar burns no LLM calls). Each pass runs, independently guarded:
hygiene → tier consolidation → graduation audit. Off-switch
`PROTO_FAMILIAR_CONSOLIDATE_DISABLED=1`; started from `server.py:main()`,
forced on demand via the `lifecycle_pass` tool / `POST /api/entity/lifecycle`.

**Cheap-code hygiene** (`consolidate.run_hygiene`) — pure SQL, folded into the
pass (not a separate loop): dedup exact-duplicate narrative records (keep
oldest), merge graph nodes sharing a non-empty `(label, villagerId)` (re-point
edges, drop losers). Same label with **different** identities is never
auto-merged — it's reported as ambiguous for the ward to resolve. Snapshots
before any change.

**Tier consolidation** (`consolidate.consolidate_to_weekly/monthly/yearly`) — LLM
rolls a period's lower-tier entries into one higher-tier summary (`daily→weekly→
monthly→yearly`). After a successful **weekly** rollup the consolidated daily
sources are pruned (`_prune_consolidated`, snapshot first) so the daily tier
doesn't accumulate. `consent_pending` dailies are held out of both the summary and
the prune — an unreviewed fact is never folded into a permanent rollup before the
ward approves it.

**Backlog sweep (0.8.89).** `run_consolidation` sweeps **every** past period that
still holds un-consolidated entries (oldest-first), not just the single most-recent
one. Enumerators `_distinct_past_weeks/months/years` find each past week/month/year
with ≥2 source rows; the current (still-accumulating) period is always excluded.
This closed a silent gap: consolidation previously targeted only *last* week/month/
year (`reference_date` default `today − 7d` etc.), so a **bulk import of months-old
daily notes never fell inside that window and sat at `daily` forever**, surfacing
stale months-old entries in recall (the reported symptom). Weekly stays idempotent
via its daily-prune; monthly/yearly don't prune their sources, so their enumerators
skip a period that already has a higher-tier row (`_existing_date_keys`) to avoid
re-appending every pass. The weekly range query is date-range based
(`_get_entries_in_range`), so a week straddling a month boundary (Mon Mar 30 … Sun
Apr 5) still collects all seven days. Each period is guarded independently — one bad
period never aborts the sweep. Existing installs catch up automatically on the next
scheduled pass (≤6 h); `POST /api/entity/lifecycle {force:true}` triggers it now.

**Recall tracking** (`memory.search` → `_touch_recall`) — pure observability:
bumps `recall_count` + `last_recalled_at` for everything surfaced.

**Retrieval-decay** (`_decay_weight`) — `score = similarity × 0.5^(days_since_recall/180)`.
careWeight:high records floor at 0.5; never-recalled records get weight=1.0. Down-rank only
(never a filter cutoff). Applied before the `max_results` slice so decay can reorder across
similarity bands. Re-sort on every search ensures stale records don't crowd out fresh ones.

**Graduation audit** (`graduation.py`) — keeps the always-injected
`identity`/`ward` surface lean by filing no-longer-front-of-mind detail into
RAG-recalled `me`/`ward` register records. Nothing is deleted; graduated
records can be pulled back. The **eligibility rule is human-signed** and lives
in one pure function, `is_graduation_eligible(record, now)`:

```
candidate  = NOT careWeight:high
             AND on-surface > DWELL_DAYS (30)
             AND last recalled > RECALL_RECENCY_DAYS (30, or never)
             AND last confirmed > CONFIRM_RECENCY_DAYS (30)
NEVER eligible (pinned): careWeight:high
             OR category ∈ {health_info, crisis, support-map}
             OR content matches care-critical patterns (allergies, meds,
                doses, crisis triggers, support contacts, care guidance)
             OR confirmed within the window
```

The bias is toward KEEPING — false positives are cheap, filing away a
safety-relevant fact is not. The actual per-block decision rides the
consolidation LLM call (the Familiar, in its own voice); code only narrows the
candidates and re-screens every graduated item against the care matcher
(defence in depth). `auto_snapshot` runs before any identity trim. Ward-block
graduations land in `graduation_log`; thalamus surfaces unacknowledged ones as
a `[GRADUATION NOTICE]` block (TTL-cached, ward-private turns only,
non-blocking), and the Familiar calls `graduation_acknowledge` once mentioned.
Tested in `phylactery/tests/test_graduation.py`.

The sibling `[DISCLOSURE NOTICE]` block (ward-disclosure Phase B) works the same
way for the content-gating re-tag pass: when `content-regate.js` opens one of the
ward's own formerly-private facts to be governed by content rules, thalamus
surfaces it (ward-private turns only) so nothing opens behind the ward's back;
the Familiar calls `disclosure_acknowledge` once mentioned, or `keep_memory_private`
to revert a fact to strictly-private on the ward's word.

**Encrypted backup/restore** (`backup.py`) — "back up / restore my Familiar":
`VACUUM INTO` a consistent copy, encrypt with a key derived from the ward's
passphrase (PBKDF2-HMAC-SHA256 → Fernet/AES), write a single `.phylactery`
file. Restore decrypts, sanity-checks it's a real Phylactery DB, swaps it over
the live DB, and `thalamus.restoreBackup` reconnects the MCP child. The
passphrase is never stored — a lost passphrase means an unrecoverable backup,
which the UI states plainly. Surfaced in the Knowledge editor → Snapshots tab
and via `POST /api/entity/backup/{export,restore}`.

### `public/graph-map.js` — shared graph-map engine

`createGraphMap(config)` is one reusable canvas engine behind **both**
map views — the Phylactery knowledge graph and the Unruh schedule's
consequence graph — because both stores hold genuinely graph-shaped
data. It owns everything generic: the Fruchterman-Reingold force layout,
the dots-and-quadratic-curve rendering, hit-testing (point-to-Bézier),
the deterministic 24-hue palette + legend, the tooltip, and the viewport
(`world = (screen − tx) / zoom`). Interaction is unified through Pointer
events: **wheel** zooms, **one finger / drag** pans, **two-finger pinch**
zooms, and the **＋ / − / Fit** buttons zoom around centre — the
touchpad-friendly path for users who can't scroll-to-zoom.

What stays with each host is the *domain* layer: data fetch, node/edge
shapes, and the editor popover. Hosts normalise their edges to
`{ id, fromId, toId, type, weight? }` before `setData`; the knowledge
graph passes `weight` (edges fade by strength), the schedule passes none
(edges hue by `kind`). This extraction replaced ~520 lines of inline
`keGraph*` code that the schedule map would otherwise have had to
copy-paste (CLAUDE.md — no copy-paste of substantial logic). The engine
emits `onNodeClick` / `onBackgroundClick`; each host wires its own
popover to those.

### `public/app.js` — frontend (one file)

- **State + persistence** as before.
- **Tool rendering only** (since 0.4.0-alpha) — the registry and the
  executors live server-side in cerebellum.js. The app sends
  `runToolLoop: true` + custom tools + session metadata, renders the
  `_toolRound` / `_toolRounds` records as collapsible blocks, and
  persists the same assistant-tool_calls / tool message shapes in
  history as before, so old sessions render identically.
- **buildApiMessages** — assembles the request. Sends an explicit
  `userMessage` field (avoids the "post-history prompt shadows the
  actual user input" bug); post-history prompt is `role: 'system'`
  not `'user'`. One /api/chat request per user message — the server
  runs all tool rounds inside it.
- **Icons are vendored Material Symbols (0.8.102)** — `public/icons.js` holds inline SVG path data (Apache-2.0, fully offline; no Google Fonts request). Static markup declares `data-ms-icon="name"`; generated templates call `msIcon(name)`. Trusted contacts moved from their own sidebar section into the **Village modal** (a "Trusted contacts" tab — they're people), and the ward's own push webhook into the **Discord** section (it's a notification channel); the sidebar nav's `keywords` keep settings search finding both at their new homes.
- **Settings sidebar (master-detail, 0.8.101)** — the sidebar shows a
  searchable grouped MENU of sections (config: `SIDEBAR_NAV` in app.js);
  opening one shows that section alone with a back header. Section
  markup/ids are untouched — visibility-only orchestration — so field
  bindings are stable. Search deep-matches each section's rendered text
  ("webhook" finds Trusted contacts). The Advanced group (Tools,
  Diagnostics) stays hidden until "Show advanced settings" — the
  first-run essentials mode, persisted as the synced `uiShowAdvanced`
  setting. Last-open section is restored per device via localStorage
  (never stealing focus from the chat input at load).
- **Temporal editor modal** — six tabs (Interests / Threat /
  Ponderings / Schedule / Routine / Handoff), each with CRUD where
  applicable. **Time handling is local-naive end to end (0.8.100):** the
  browser IS the ward's clock, so the editor sends plain local wall-clock
  strings (`YYYY-MM-DDTHH:MM:SS`, no offset) for creates, edits, AND the
  windowed-read `from`/`to` bounds — matching Unruh's local-naive storage
  with no conversion anywhere. (It previously converted to UTC `Z` strings
  and relied on the server-side `to_local_naive` seam to convert straight
  back, which silently shifted times whenever `wardTimeZone` wasn't set —
  the Berlin-bug class. Do not reintroduce `toISOString()` on any schedule
  write or query-bound path; `teNaiveFromDate`/`teLocalTimeToday`/
  `teDatetimeLocalToNaive` in `app.js` are the helpers.) The Routine tab
  hits `/api/temporal/phases` so phases on past dates surface (they
  recur). The Schedule tab has a **view toggle** (List / Calendar / Map):
  - **List** — the existing linear schedule view with windowed
    look-ahead (default 48h, configurable).
  - **Calendar** — month-grid view, Monday-start, 6×7 cells.
    Clicking a day opens the create form pre-filled to that date.
    Recurring nodes expand server-side so occurrences render on
    their actual dates; phases stay in the Routine tab to avoid
    cluttering daily-recurring rows. Iconography: recurring
    occurrences prefix with ↻, resolved ones strike through.
  - **Map** — the schedule's **consequence graph** on the shared
    force-directed canvas (see *Graph-map engine* below): nodes are
    events/tasks/phases/states (resolved ones faded), edges are the
    `causes`/`requires`/`depends_on`/`blocks`/`during`/`carries_forward`
    links between them, hued by kind. Clicking a node opens a popover
    that lists its links (✕ to remove) and a "+ connect" form
    (target node + kind) — the user-facing half of edge authoring,
    posting to `/api/temporal/schedule/edge`. This is the home of the
    graph Unruh was always shaped to hold; the Familiar authors the
    same edges from its side via the `schedule_link` tool. **The planned
    consequence-over-time model on top of these edges (valence / two
    futures / certainty / window-position learning) is specced in
    [`consequence-graph-build-spec.md`](consequence-graph-build-spec.md).**
- **Local-time helpers** for the time pickers: convert between
  `<input type="time">` + `<input type="datetime-local">` and the ISO
  timestamps Unruh stores (**local-naive**, no offset — see
  `docs/unruh-design.md` "Time model") via real local-time semantics, not
  string-slicing. (A picker value that still serialises with an offset is
  normalised to local server-side by `db.to_local_naive`, so the round-trip
  is correct either way.)
- **Outbox delivery polling** — `startOutboxPolling()` polls
  `/api/outbox` every 30s; reminder / triage / outbound_alert items
  are injected as ordinary assistant chat messages in the active
  session (with `proactive: true` + `outboxKind` flags persisted on
  the message). Auto-acked after injection. Per-poll cap of 5 items
  so an upgrade-day backlog doesn't dump a wall of historical
  messages all at once.
  - **Design note (future):** The `#outbox-banners` div is still in
    `index.html` as an inert host. If pondering activity or the
    Familiar's in-progress thinking is ever made visible, the banner
    surface is the right place for it — ephemeral, non-intrusive,
    doesn't pollute the chat log. Reminders and triage stay as chat
    messages; pondering/thinking visibility would use banners.
- **Trusted contacts** UI for M12c (Discord webhook list).
- **Topic system** — gutter bars, "▷ Topic start" / "■ Topic end"
  buttons per-message, summarizer modal.
- **Tome engine** unchanged from the original SillyTavern-compatible
  implementation.

### Pillar I — Knowledge-manager repoint + new-field surfacing

All `/api/entity/*` HTTP routes now delegate entirely to Phylactery via thalamus.js wrappers
(entity-core is retired). New fields surfaced in the KE:

- **`audience` + `careWeight` on memory records** — shown in the detail view with editable
  dropdowns; `PUT /api/entity/memories/by-id/:id` accepts `audience` and `careWeight`
  and forwards them to `memory_update_by_id` → `memory.py` `update_memory_by_id()`. The
  audience dropdown lists the real Village circles (ward-private + each category, via the
  shared `keAudienceOptionsHTML` helper used by the graph-node editor too) — the same model
  the recall gate filters on, not the old stale `ward-private`/`all` pair.
- **Audience badges** in the memory list rows for non-ward-private records; careWeight badges
  for `high`/`low` entries.
- **Ward · Remember settings** — persistent consent-policy map
  (`basics / emotional_content / health_info / relationships / whereabouts → true/false/ask`).
  Stored in `phylactery/data/remember_map.json`. Surfaced via:
  - Phylactery MCP tools `remember_map_get` / `remember_map_set` (`remember.py`)
  - thalamus.js helpers `getRememberMap()` / `setRememberMap()`
  - HTTP routes `GET /api/entity/ward/remember`, `PUT /api/entity/ward/remember`
  - KE Identity pane: "Remember settings" row always visible under the `ward` category header
  - **Standing consent (0.8.27):** the time-boxed middle tier — per `'ask'` category,
    a window ("trust his judgment for 6h/24h/7d/30d") that auto-confirms ward-self facts
    while open. Absolute epoch-ms expiry in `remember_standing.json`; tools
    `remember_standing_get` / `remember_standing_set`, thalamus `getStandingConsent()` /
    `setStandingConsent()`, `PUT /api/entity/ward/remember/standing` (server derives the
    expiry from the preset — no typed timestamp), gated in `resolveRememberGate`
    (`wardStandingActive`; only promotes `'ask'`→`'true'`, never overrides `'false'`).
  - **Wired into the memorization gate** (`memorization.js`): the Village registry's
    per-villager `remember` map covers facts about *other* people; the ward is not a
    villager, so facts about my human themselves (no matched villager subject) are gated
    by this ward map. Without it, the human's own `health_info`/`emotional_content` facts
    bypassed the gate entirely. The gate decision lives in two pure, tested exports —
    `gateForCategory(category, map)` and `resolveRememberGate(category, subjectVillagers, wardMap)`
    (`remember-gate.test.mjs`). Defaults (human-signed): `basics=true`, all sensitive
    categories `ask` — surfaced for confirmation, never silently dropped. Degrades to those
    defaults if Phylactery is unreachable.
- **Settings field rename**: `entityCoreConnectionId` → `phylacteryConnectionId` (legacy name
  still accepted as fallback in `loadPhylacteryEnv()` and `phylacteryCredsSnapshot()`).
- **Prompt Inspector labels**: "Entity-Core (static/dynamic)" → "Phylactery (static/dynamic)".
- **Deno/entity-core retirement**: `start.sh`, `start.bat`, `Proto-Familiar.command` no longer
  prime `~/.deno/bin` on PATH; comments updated to reflect Phylactery+Unruh as the only MCP children.

## Data flow — single chat request

```
User types message
       │
       ▼
buildApiMessages(userInput, userTimestamp)
   ├── activateTomeEntries()    ← keyword scan across all enabled Tomes
   ├── applyNameVars()           ← {{user}} / {{char}} / {{elapsedTime}}
   ├── pushes role:'user' content: userInput
   └── pushes role:'system' content: postHistoryPrompt   (was 'user' — fixed)
       │
       ▼
POST /api/chat  { messages, userMessage: userInput, … }
       │                                  ↑ explicit field — server uses this for
       │                                    detection + RAG query, not "last role:'user'"
       ▼  server.js
recordUserActivity()                     (fire-and-forget)
scoreMessage(userMessage)                ← crisis-signals.js
   if level ≠ 0 → recordThreat(level, signals)   ← threat-tracker.js (logged: "[threat] scored ±N")
       │
       ▼
thalamus.enrich(userMessage, { liveTurn: true })
   ├── identity_get_all     ──►  Phylactery (MCP)         → static block
   ├── memory_search        ──►  Phylactery (MCP)         ┐
   ├── graph_node_search    ──►  Phylactery (MCP)         │
   ├── temporal_context     ──►  Unruh (MCP)              │ dynamic block:
   │     ├── current phase                                │  - RAG memory matches
   │     ├── full routine (live phases, date-independent) │  - graph excerpt
   │     ├── schedule window (events/tasks/reminders)     │  - "Today's rhythm"
   │     ├── interests (standing + live with weights)     │  - schedule sections
   │     └── handoff (session-end note)                   │  - interests
   ├── getRecentPonderings() ──► local tome read          │  - [CARE CHECK]
   └── getThreat()           ──► local file read          ┘  - [Temporal Context]
       │
       │  injection-guard.js is NOT applied to Phylactery / Unruh content —
       │  those are trusted first-party systems. The guard runs at the
       │  genuinely external ingestion points (wired 0.8.57, after the audit
       │  found this paragraph's "when those are built" step had been skipped
       │  when they WERE built): web text in websearch.js and non-ward
       │  Discord text in discord-gateway.js inboundContent(). It sits on the
       │  inbound boundary of each adapter, never on the recall path of own
       │  memory, never on the ward's own words, never on outbound delivery.
       │
       ▼
Prompt assembly (see "Prompt assembly" below)
       │
       ▼
fetch(providerURL, enrichedPayload)
       │
       ▼  SSE stream or JSON
Tool calls?  (server-side loop since 0.4.0-alpha)
   ├── YES → cerebellum.executeToolCall() per call → append results →
   │         re-call provider (up to 5 rounds, all inside the one
   │         /api/chat request; the [Now] time anchor is re-appended
   │         as the LAST message every round). Each round is streamed
   │         to the client as a `_toolRound` SSE event (or returned as
   │         the `_toolRounds` array when non-streaming) so the chat
   │         renders the collapsible tool blocks without executing
   │         anything.
   └── NO  → render assistant message → save to localStorage + server
```

The browser opts in by sending `runToolLoop: true` plus its custom
tools and session metadata; the built-in registry is composed
server-side (`cerebellum.composeActiveTools`). Direct `/api/chat`
callers that pass their own `tools` array keep the legacy passthrough
(single round, results handled by the caller). Enrichment runs ONCE
per user message — tool rounds reuse it — and the internal provider
re-calls never count against the 20 req/min chat rate limit.

### Custom tools — advertise-only (needs addressing post-MVP)

The Settings → Custom tools JSON array is appended to the advertised
tool list, but **no executor exists**: calls return a structured
"not implemented" notice into the loop. This is a deliberate pre-MVP
posture — useful for prototyping what the Familiar *would* do with a
tool — and it is flagged in the Settings UI. A real extension point
needs a decision about where user-supplied executors run (server-side
JS modules? declarative HTTP templates?) and what their security
boundary is. Until then: keep them advertised, keep the disclaimer,
don't silently drop the feature.

## Prompt assembly (cache-aware)

LLM providers cache the longest common prefix across consecutive
requests. The static identity block barely changes within a session,
so caching it is a big save — but only if per-turn-dynamic content
doesn't sit in front of it.

`thalamus.enrich()` returns `{ static, dynamic }`:

| Block | Contents | Lifetime | Placement |
|---|---|---|---|
| `static` | `base_instructions.md` + identity files (self / user / relationship / custom) | Stable across turns in a session | Prepended to the system message at index 0 |
| `dynamic` | RAG memory matches → knowledge-graph excerpt → recent ponderings → deferred intents → recent-memory cross-check (today+yesterday, `getRecentMemoryLines`, ward-private live turns — so proactive questions don't re-ask something already answered) → Google-Calendar projection cue (0.8) → `[CARE CHECK]` (if threat ≠ calm) → `[My stewardship]` (0.8.18, if anything qualifies) → `[Temporal Context]` | Re-derived every turn | Inserted as a separate `role: 'system'` message at `max(1, messages.length - depth)` |

The depth defaults to 4 (`thalamusDynamicDepth`, 1–50, server-synced).

### The four core prompts — every surface, not just the web (`core-prompts.js`)

Separate from Phylactery identity (the `static` block above), the ward authors
**four prompt fields** in Settings that make the Familiar *itself*: System
Prompt, Character Profile, User (Human) Profile, and Post-History Prompt. On the
**web** these are assembled by the browser (`_buildApiMessagesInner` in
`public/app.js`) and POSTed inside the messages array. A **server-initiated
turn** — Discord text, a voice call — has no browser, and until this fix it shipped
**without any of them**: the Familiar answered Discord and voice with none of its
configured identity (the reported "my Familiar doesn't see the user prompt at
all on Discord").

`core-prompts.js` is the server-side mirror of that client assembly — the ONE
place, kept in step with `public/app.js` (order system → `[Character Profile]` →
`[Human Profile]`, the same headers, `{{user}}`/`{{char}}` resolved via
`substituteMacros`). It is NOT the lorebook/tome interleaving (that stays
browser-only); it is exactly the four identity fields.

- `coreSystemSegment(settings)` → the system-message segment (empty when unset).
- `postHistoryMessage(settings)` → the trailing message, ward-configurable role.
- `withCorePrompts(messages, settings)` → folds both into a bare array: core
  segment LEADS (so the `static` block prepends in front of it, preserving the
  web order static → persona), post-history TRAILS the conversation.

Wiring: **`/api/chat`** injects them when the caller passes `injectCorePrompts`
(the voice path, `voice-chat-turn.js`); the web client builds them itself and
never sets the flag. **`discord-gateway.js`** folds `coreSystemSegment` into
`systemContent` and appends `postHistoryMessage` in both the live (`handleTurn`)
and revisit paths. Voice (web + Discord) routes through `voice-chat-turn.js`, so
one flag covers both.

### Prompt capture — the inspector shows what was actually sent (`prompt-capture.js`)

The web prompt inspector used to be a client-side *reconstruction* — it could
only ever describe the web assembly, and it showed what *should* be built, not
what left the building. So it cheerfully showed core prompts present while
Discord received none. `prompt-capture.js` records the real outgoing message
array at each send boundary (`recordOutgoingPrompt(surface, …)` — web / voice /
discord / discord-revisit; last-one-per-surface, best-effort, never throws into
a turn). `GET /api/last-prompt` reads it, and the inspector gained a surface-tab
view that renders each surface's **verbatim** captured payload beside the
annotated web reconstruction — ground truth for the surfaces with no browser of
their own.

Within `dynamic`, the order is deliberate:
1. **`[Now]`** — wall-clock + weekday + date + relative phrasing of "my human last sent a message" (see "Time perception" below). Always first so every other block reads against a consistent present.
2. **RAG memories** — direct retrieval relevance, weight-bearing facts. Each result's date is rendered through `relativeDay()` so "from yesterday" appears alongside the granularity tag.
3. **Graph excerpt** — entity-relationship context
4. **Recent ponderings** — the Familiar's own quiet thoughts (honesty loop). Each entry's `created_at` is rendered via `relativeTime()`.
5. **Deferred intents** — only on live turns. Up to 5 `wants_to_save` entries the Familiar flagged during free cycles but hasn't acted on yet, PLUS any `followup` entries memorization caught (things the Familiar said it would do but didn't). Shows the kind (tome/memory/identity/followup), the summary, the routing tool (or, for a followup, "the right tool" — no single one is named), and the (uid, index) pair for `acknowledge_deferred_intent`. See "Deferred-action pattern" below.
5b. **What I said when I knocked** (`reach-out-log.js`) — only on live
   ward-private turns. A between-sessions reach-out ("a thought from me") is
   delivered through the outbox and, until this existed, nothing put it back in
   front of the Familiar: my human answered hours later in chat and the reply
   arrived as a non-sequitur — *"I don't remember asking about anything?"* about
   a question the Familiar itself had asked. Worse, the message alone never said
   WHICH occurrence was meant, so even once reminded it could not answer
   *"last week's or the week before?"*.

   So a knock is recorded with three things: what was **said**, what it was
   **about** (the specific occurrence, named), and **why**. Both delivery paths
   record — the warm reach-out loop (`about`/`why` ride the decision JSON it
   already returns, no extra LLM call) and noticing's `reach_out_to_ward` (same
   two fields on the tool, so the Familiar can say what it meant). The
   `[I reached out first — this is what I said]` block renders the last few for
   48 h, and `markSurfaced` ages each out in code after `MAX_SHOWN` turns —
   the surfaced-tell discipline, so nothing depends on an acknowledge call the
   model would forget. Deliberately NOT the outbox: that is a delivery queue
   whose items are acknowledged and gone, while this is the Familiar's own
   memory of having spoken and must outlive delivery.

6. **Projection cue** (0.8 §4, generalized 0.8.107) — only on live turns. Appointments not yet thought-through, capped per turn and aged out after a few turns / a short window (code-driven, no acknowledgement call), with a one-shot last-chance re-surface within 48h of the event. Candidates are gathered in code (`gatherProjectionCandidates`): Unruh's `temporal_context.gcal_projection` flags (fresh sync arrivals) unioned with any bare upcoming event in the briefing window — unresolved, untouched by consequence edges, ≥6h runway — so hand-added and chat-created events get the cue too, not just synced ones. Auto-clears the moment the Familiar links one. Invites authoring both futures via `schedule_link`; never nags. See `gcal-projection.js`.
7. **`[CARE CHECK]`** — only present when threat tier ≠ calm; carries identity-anchored guidance per tier
8. **`[My stewardship]`** (0.8.18, `stewardship.js`) — the executive layer: a tiny conditional agenda (opening brief / aging floaters / anchor-drift), cap 3 items, ABSENT most turns. Stands down at moderate+ threat (so it never overlaps the CARE CHECK above). Code selects what qualifies; the Familiar owns how it raises each. See "File Structure" and docs/stewardship-build-spec.md.
6. **`[Temporal Context]`** — handoff + today's rhythm + schedule window + interests. Every timed item (upcoming / reminders / resolved) is rendered through `relativeTime()` so the Familiar reads "tomorrow at 10am" / "in 30 minutes" rather than ISO timestamps.
7. **`[Surface candidates]`** — open schedule items that survived the hard gates (active snooze, threat tier, routine phase, dedup window), packaged with consequence priors + person-model excerpt so the Familiar can decide in voice whether to mention any. The header is ADHD/executive-dysfunction-aware: explicit GREEN LIGHT states to surface in (free time, momentum, boredom/restlessness, "forgetting something"), explicit RED LIGHT states to hold in (severe/high threat, quiet phase, mid-task), and named access ramps (timebox, single next action, planning-only slot, body-double). See "Surface pipeline" below.

## Time perception (the `relative-time` layer)

Unruh tells the Familiar *when* events happened — but the Familiar perceives time the way humans do: in relative phrases (yesterday, this morning, in 2 hours, last Tuesday) rather than ISO arithmetic. `relative-time.js` is the single helper every consumer of timestamped data uses to render that phrasing, recomputed every turn against `Date.now()` — the same moment used for the `[Now]` block. A memory written yesterday reads as "yesterday" today and "two days ago" tomorrow, without anyone re-writing the memory.

**A relative phrase ALWAYS travels with a date (0.7.x).** Near-term phrasings ("yesterday", "in 3 weeks") were always present, but beyond ~a month `relativeTime`/`relativeDay` used to fall back to a bare absolute date the model had to date-arithmetic itself. They now append a directional interval (`intervalPhrase` → "in N months" / "a year ago"), so a distant memory or appointment reads "Friday, December 25 **(in 7 months)**" / "January 22, 2025 **(a year ago)**" — the absolute date keeps the precision, the parenthetical keeps the perception. One helper change covers every consumer below.

**Future events carry a day count, coarsening with distance (0.7.x).** A relative-only future phrase ("this Sunday", "in 3 weeks") still forces the model to compute *how far away* that is — and LLMs are unreliable at date arithmetic, which is exactly what the **timeblindness alerts** depend on being right. So every future phrasing ≥2 calendar days out now carries a count alongside its human anchor, exact in the near window and coarsening further out so it stays readable:

| Future distance | Renders as |
|---|---|
| 2–6 days | `this Friday at 3pm (in 3 days)` |
| 7–13 days | `next Wednesday at 9am (in 9 days)` |
| 14–21 days | `Thursday, June 25 at 2pm (in 21 days)` |
| 22 days – ~2 months | `Thursday, July 9 at 2pm (in 5 weeks)` |
| beyond ~2 months | `Friday, December 25 at 9am (in 7 months)` |

The **exact-day window runs to 3 weeks** — that's where the timeblindness alerts actually fire and the model must not mis-estimate distance; past it, weeks then months read better than "in 204 days". The day count is `calendarDayDelta` (the same calendar-day measure the rest of the layer uses, so 23:59→00:01 reads as 1 day); the coarser weeks/months tiers reuse `intervalPhrase`/`plainInterval`. The 21-day threshold lives in one place (`futureInterval`). **Past** phrasings are deliberately left natural ("last Monday", "2 weeks ago"): day-count precision is a forward-scheduling need, and a memory recalled as "2 weeks ago" reads better than "14 days ago". `tomorrow`/`yesterday` stay bare — the count is already in the word.

Surfaces using `relativeTime()` / `relativeDay()`:

| Surface | Where | What it gets |
|---|---|---|
| `[Now]` block | thalamus.js enrich() | "Now: 2pm on Thursday, June 4. My human last sent a message 12 minutes ago." |
| RAG memories | thalamus.js enrich() | "(from daily/2026-06-03, **yesterday**, 87% relevant)" |
| Ponderings block | recent-ponderings.js | "— **this morning at 9am** · 'On honesty'" |
| Schedule items | temporal-format.js | "**tomorrow at 10am** — [event] dentist appointment" |
| Handoff | temporal-format.js | "Last session (**ended last Tuesday at 9pm**):" |
| Chat-turn messages | public/app.js buildApiMessages | "[14:30] hi" (every user + assistant message in history) |

The chat-turn message stamps use a compact `⫸HH:MM⫷` tag (U+2AF8 / U+2AF7) rather than full relative phrasing — the relative anchor is in the `[Now]` block, so each message just needs a marker the Familiar can correlate. The uncommon bracket chars matter: the earlier `[HH:MM]` format was common enough in natural text that the LLM started mimicking it back into its own responses, which then *accumulated* turn-over-turn when `toApiMessage` re-stamped the content (pile grew by one stamp per turn). Two defenses make accumulation impossible:

1. `stampContent` strips ALL existing `⫸HH:MM⫷` patterns from the content before prepending the fresh canonical tag. The authoritative source is the message's `timestamp` field — the content's tag is treated as disposable LLM-echo, never preserved.
2. UI render sites globally strip the same pattern so the user never sees them in chat. A small backward-compat sweep iteratively strips leading legacy `[HH:MM]` tags from pre-fix-era history (leading-only there, so mid-content references the user may have written stay intact).

Result: the LLM always sees exactly one canonical stamp per message every turn; the user sees none.

## Recurrence (events / tasks / reminders / phases that repeat)

Schedule nodes carry an optional `payload.recurrence` rule that turns one anchored entry into a series of occurrences without storing every occurrence separately:

```js
payload.recurrence = {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly',
  interval?: 2,                              // every N units (default 1)
  until?:    '2026-12-31',                   // cut-off date
  bysetpos?: -1 | 1 | 2 | 3 | 4,             // monthly only — "last" or "Nth"
  byweekday?: 0..6,                          // 0=Sun, 5=Fri — pairs with bysetpos
}
```

Common patterns:

| Need | Rule |
|---|---|
| Weekly cleaning every Sunday | `{ freq: 'weekly' }` anchored on a Sunday |
| Biweekly therapy | `{ freq: 'weekly', interval: 2 }` |
| Rent on the 1st of every month | `{ freq: 'monthly' }` anchored on the 1st |
| Birthday | `{ freq: 'yearly' }` |
| Last Friday of every month | `{ freq: 'monthly', bysetpos: -1, byweekday: 5 }` |
| First Monday of every month | `{ freq: 'monthly', bysetpos: 1, byweekday: 1 }` |

**Expansion flow** (read-time, no stored occurrences):

```
enrich()  ─► temporal_context  (Unruh)  → schedule.window (anchor-in-window items only)
       │
       ├─► listRecurring()    (Unruh)  → recurring anchors (any when_ts, including past)
       │
       └─► expandWindow(recurringAnchors, now-24h, now+7d)  (recurrence.js)
                                      ↓
                       merge into schedule.window
                                      ↓
                       formatTemporalContext()  (temporal-format.js)
```

Recurring anchors are dropped from the merged window if they'd otherwise appear (avoids both "the anchor stamped months ago" AND "today's occurrence" rendering).

**Per-occurrence resolution.** `payload.resolutions` is a map `{ "YYYY-MM-DD": "done"|"cancelled"|"carried_forward" }` keyed by local-TZ date. The expander filters out any occurrence whose date is in the map. Writers:
- `schedule_resolve_occurrence` MCP tool / `schedule_resolve` BUILTIN_TOOL with `occurrence_date` arg
- HTTP `POST /api/temporal/schedule/:id/resolve_occurrence`
- Temporal-editor "✓ done" / "✕ cancel" buttons auto-route to the per-occurrence endpoint when the item is an expanded occurrence (carries `__occurrence_of`).

The anchor's own `resolution` column still cancels the WHOLE series rather than one occurrence — but ending a whole recurring series is **fail-closed** (0.8.99). `schedule.resolve()` raises `RecurringSeriesError` on a recurring node unless the caller passes `series=True`; the `schedule_resolve` MCP tool surfaces this as `{ok:false, code:'recurring_needs_scope', id, label}`. This exists because the destructive whole-series cancel was the silent default of an ambiguous call — "cancel this week's wash day" almost always means one occurrence, and the Familiar (or a UI click on the anchor) could wipe out every future Sunday by omitting `occurrence_date`. Now the caller must opt in: pass `occurrence_date` for one instance (the usual path), or `scope:'series'` (BUILTIN_TOOL) / `series:true` (MCP/HTTP) to deliberately end the series. The reminders-fire path (`fireReminder`) passes `series:true` so its historical whole-node semantics are preserved. The temporal-editor's whole-node resolve confirms via a dialog before ending a series.

UI: the temporal-editor schedule-create form has a **Repeats** dropdown with the common presets. The Familiar's `schedule_add_*` BUILTIN_TOOLS accept a `recurrence` object so the model can set arbitrary rules — including the "last Friday" pattern — directly from chat.

Bounded: the expander caps at 50 occurrences per anchor (overflow guard against malformed rules) and handles month-clamp edge cases (Jan 31 → Feb 28 instead of overflowing to March 3; Feb 29 → Feb 28 in non-leap years).

## Surface pipeline (the consumer side of personalization)

Open schedule items don't speak for themselves — the Familiar needs to
decide whether *this* moment is the moment to raise one, and how. The
surface pipeline rides existing LLM calls rather than spinning up a
new request per task (see CLAUDE.md "Ride existing requests; gate in
code"). All three triggers — opportunistic, triggered, care-driven —
plus the reflection loop net zero new LLM requests.

```
temporalPayload.schedule.window   ←  open tasks/events/reminders
                │
                ▼
   ── HARD GATES (pure code, no LLM) ──
   threat tier (severe → none; high → external_obligation only)
   routine phase (quiet_routine pattern → external_obligation only)
   dedup window (6h if the last offer was actually RAISED in the
   response; 90min if not — staying quiet never buys long
   suppression. Bypassed by external_obligation.)
                │
                ▼
   ── CONTEXT ASSEMBLY (per candidate) ──
   stakes_tier  ← payload.stakes_tier OR inferStakesTier(label)
   floating     ← !task.when  (no time assigned)
   ageDays      ← from task.when, OR task.created_at when FLOATING
   priorsBlock  ← matched section from docs/consequence-priors.md
   personModel  ← Phylactery custom/what_lapses_cost.md (raw)
   taskSpecific ← payload.consequence_model
   confidence   ← high/medium/low based on what info is present
                │
                ▼
   ── PROMPT BLOCK ──
   [Surface candidates] block appended to enriched dynamic
   surfacedTasks list returned alongside surfacedBookmarks
                │
                ▼
   ── EVENT RECORD (fire-and-forget) ──
   Append to tomes/.surface-events.json with full event record
   (state_snapshot, stakes_tier, confidence, raised=null,
   outcome=null). Two taggers fill the record in later:
                │
                ▼
   ── RAISED TAG (post-turn, pure code) ──
   tagRaisedOutcomes scans the final response text for each offered
   task's label (same accepted-imprecision pattern as the M8 bookmark
   outcome scan; four call sites in server.js — both tool-loop paths
   and both plain paths) and tags the offer raised=true/false. The
   dedup gate reads it via getRecentOfferInfo: only a raised offer
   earns the 6h window. The outcome tagger separately fills in
   `outcome` when the schedule resolves.
```

**Triggers** (all rides, zero new LLM calls):

| Trigger | When | Riding | Carrier |
|---|---|---|---|
| Opportunistic | User just sent a chat message | Chat-turn enrich call | `[Surface candidates]` block in `dynamic` |
| Triggered | Reminder hits its `when_ts` | Pure-code firing (set at creation by the Familiar) | Chat message via outbox (since 0.3.9-alpha) |
| Care-driven | Silence-triage decided to reach out | The triage LLM call that's already happening | "Candidate tasks I could touch on" block in triage prompt |

**`stakes_tier`** controls surfacing pressure:
- `external_obligation` — real-world clock + external consequences (paperwork, deadlines, appointments). Bypasses quiet-hours and dedup. Surfaces under high threat.
- `personal_wellbeing` — internal, reversible, person-specific decay (meals, hygiene, exercise). Respects all soft gates.
- `purely_optional` — only matters if {{user}} cares. Lowest surfacing pressure.

Inferred from label by `inferStakesTier()` in `surface-context.js`. Overridable by the Familiar at creation (BUILTIN_TOOLS `stakes_tier` arg) and by {{user}} in the temporal editor (Stakes dropdown).

**`consequence_model`** is per-task free-text attached to the schedule node payload, informing framing when the task surfaces. (Superseded for richer use by the consequence-graph model below; still read as a confidence input.)

### Consequence graph — consequences over time (Pass 1)

The schedule edges (shipped `0.7.74`) carry a **consequence payload** so the Familiar can reason about what an item leads to over time, not just how items connect. Specced in [`consequence-graph-build-spec.md`](consequence-graph-build-spec.md). A consequence is an edge (usually `causes`, or the new **`co_occurs_with`** — "noticed together, no causal claim") whose `payload_json` carries: `valence` (help/harm/neutral), `condition` (`on_resolve` / `on_lapse` / `unconditional` — the **two futures**, so the Familiar projects what finishing buys *and* what skipping costs), `horizon_hours`, `severity`, `certainty`, `observed` (the past↔future flag), `note`. Consequences that aren't scheduled items are `state` nodes (resolve-or-create by label via `schedule_upsert_state`). Validated in Unruh `schedule.py`; authored by the Familiar through the extended `schedule_link` and by the human in the Schedule **Map** (consequence detail in the connect form; harm edges red, projected edges dashed).

**Visibility & planning.** `temporal-format.js` renders a *Consequence links* section into `[Temporal Context]` (the edges were stored but invisible before). `selectSurfaceCandidates` reads the edges: a task an imminent node **requires** or that **blocks** one gets a pure-code pressure bump (survives the per-turn cap) + a rendered "why"; the `[Surface candidates]` block gained a **CONSEQUENCE & PLANNING** directive (both futures, predict-then-check, honesty about certainty — proactivity-rule-compliant, regression-guarded).

**The `linked` set (0.8.47 — the visibility-rot fix).** The original wiring fetched edges *touching window nodes* and let renderers drop any edge with an unresolvable endpoint. But consequence endpoints are routinely OUTSIDE every time window — `state` nodes were stamped `when=now` and scrolled out ~12h after authoring; recurring anchors are stamped months back — so in practice **every consequence edge went invisible within hours** (stored fine, never rendered, never graded: the "causal system doesn't work" defect). Fixed at the source: Unruh's `get_window` now returns the **whole schedule-layer edge set** (bounded by `limit` — the graph is deliberately small) plus **`linked`** — every edge endpoint that isn't a window node — so consumers always resolve both ends. Updated in the same commit: `temporal-format.js` (label map + id legend include `linked`), thalamus's surface-candidate assembly (`scheduleNodes` includes `linked`), the reflection input in server.js (`labelById` includes `linked`), and the Schedule Map in `app.js` (linked nodes render, so state endpoints are visible/editable). `schedule_upsert_state` now creates states **undated** (`state` no longer requires `when` in `add_node`; a dated state is still allowed, just not forced). Regression tests pin the rot cases — an undated state endpoint, and an edge between a months-old recurring anchor and a state (`unruh/tests/test_schedule.py::TestGetWindow`, `tests/temporal-format.test.mjs`).

**Learning (predict→observe→learn).** `resolve()` records `acted_at` + **`window_fraction`** (where in a `[when,end]` window the ward acted). The reflection loop (`pondering.js`) does three things, all riding the existing reflection call (no new loop): (1) learns window-timing into `what_lapses_cost.md` (needs ≥3–4 of a kind); (2) **calibrates its own forecasts** — fed its projected (unobserved) edges with ids, returns `edge_calibrations` (raise/lower `certainty`, mark `observed` only once truly seen), applied via `updateScheduleEdge`. The causal-chain fix (0.8.107) widened this input's schedule fetch to ward-local −7d..+2d (the default window reached only hours back, so a projection's moment had always scrolled past before reflection could grade it) and stamps each edge with its source node's `when` (`from_when`) so reflection can tell whether the projected moment has arrived. The same fix added the chat-side half: the temporal briefing renders a **"Recently past, not yet examined"** section (`temporal-format.js` — events ≤72h past whose consequence edges are still ungraded, question form, 3-line cap, edge ids inline) and a `schedule_calibrate_link` chat tool (cerebellum → `updateScheduleEdge`) so the Familiar can grade a forecast the moment my human tells it how things actually went — before that tool, edge ids were not actionable from chat at all; (3) **promotes** a repeated `co_occurs_with` to a *tentative* cause — fed co-occurrence pairs with a noticed-count (pairs that already have a cause are filtered out server-side), it returns `promotions` and the server adds a `causes` edge between the existing endpoints with `observed:false` + low default certainty (the noticing stays as the trail; the new cause is graded next reflection). The ladder is **noticed → suspected → confirmed**, and the loop can only ever add a *tentative* rung — it never asserts `observed` from a promotion.

**Needs-tracking (Pass 2).** A "need" is a recurring window-task (`payload.need`, a `[when,end]` window) — a meal, meds, sleep — created via `schedule_add_need`. That makes "skipped" *defined by the window*. `temporal-format` renders a live **Needs today** view (met / open / missed / upcoming), derived every turn so a missed window shows even though the expander drops resolved occurrences. The opt-in `needs-tracking-loop` (default OFF, `PROTO_FAMILIAR_NEEDS_TRACKING_DISABLED=1`, stands down at moderate+ threat) marks an elapsed-unresolved occurrence `missed`, building the fulfilment ledger. **It makes only the *lapse* factual** — it never touches the projected `on_lapse` consequence edges. Whether the predicted cost actually followed stays the Familiar's observation, confirmed *or corrected* through the reflection calibration above (which marks `observed` only once genuinely seen). Nothing auto-confirms a consequence. To close that loop, reflection is *fed the recently-missed needs* (last 7 days, from the ledger) as a **cue** to check each one's projected `on_lapse` consequence — confirm it only if the cost was actually seen, correct it (lower certainty) if it didn't land — never assume.

**`snooze_until`** is an ISO timestamp on the task payload, set when {{user}} explicitly says "not now" and the Familiar calls the `schedule_snooze_task` tool (id + minutes, clamped 1min–1week). `passesHardGates` honours an active snooze across every tier — the human asked — so it blocks before the threat/quiet/dedup checks. The reminder loop remains the firm safety net for anything with a real deadline; the snooze only quiets the opportunistic surface path. Because Unruh's `schedule_update_node` REPLACES the whole payload, the tool reads the current payload from the schedule window and merges the stamp in (preserving `stakes_tier` / `consequence_model`).

## Reflection loop (slice 2)

The pondering loop has a *mode*: when 5+ tagged surface outcomes have accumulated since the last reflection, the next pondering tick reflects on them instead of pondering an interest. **Same LLM call, different topic shape — zero new requests.**

```
pondering-loop.runOneTick()
   │
   ▼
shouldReflectNow()  ← reads tomes/.surface-events.json,
                      counts events with outcome ≠ null whose
                      outcome_at > last_reflection_at. ≥ 5 → true.
   │
   ▼ (true)
getReflectionInput()  ← projects fresh outcomes + current
                        what_lapses_cost.md content + identity
                        anchor into the reflection prompt input
   │
   ▼
runPonder(input, { mode: 'reflection' })
   │ ponderOnce() dispatches via buildPonderPrompt(input.mode === 'reflection')
   ▼
LLM returns:
  { title, content, what_lapses_cost_update: null | { heading, content } }
   │
   ├── Pondering tome write (scope: 'reflection')
   ├── markReflected(now) — resets fresh-outcome window
   └── If what_lapses_cost_update present:
       updateIdentitySection({ category: 'custom',
                               filename: 'what_lapses_cost.md',
                               heading, content })   ← via Phylactery MCP
```

**Outcome tagging** is pure-code, runs at chat-turn entry as a fire-and-forget pass over `tomes/.surface-events.json`:

| Schedule signal | Outcome |
|---|---|
| `resolution === 'done'` | `engaged_and_completed` |
| `resolution === 'cancelled'` | `cancelled` |
| `resolution === 'carried_forward'` | `deferred` |
| `resolution === 'fired'` (reminder) | `fired` |
| unresolved + offered > 24h ago + `raised === true` | `unresponded` |
| unresolved + offered > 24h ago + `raised !== true` | `not_raised` |
| unresolved + < 24h | left null, re-checked next turn |

The `unresponded` / `not_raised` split is load-bearing: `unresponded` means the Familiar *actually raised* the task with the ward and nothing came of it (evidence about the ward), while `not_raised` means it was offered to the Familiar as a candidate but never reached the ward at all (evidence about the Familiar's own surfacing — the ward can't respond to what they never saw). Conflating them — the pre-0.6.25 behaviour — let a quiet stretch where the Familiar simply didn't speak get misread as the ward withdrawing. A confirmed resolution always wins over both regardless of `raised`.

Once tagged, an event's `outcome` is immutable — the LLM later reasons about a stable record, not a moving target.

**`raised` tagging** is a separate, earlier tag on the same event: did the Familiar actually *say* something about the task in the turn it was offered? Tagged post-turn by `tagRaisedOutcomes` (pure-code response-text scan, zero LLM calls). It drives the differentiated dedup window (raised → 6h rest; un-raised → back in 90min), decides the aged-out outcome split above, and flows into reflection (the projection carries `raised`, and the reflection prompt is taught that `not_raised` outcomes are about the Familiar's surfacing, never the ward's engagement).

**Prompt stance:** the `[Surface candidates]` header is written for a ward with executive dysfunction — there is no "right moment" that arrives on its own, so the header tunes toward action. It names explicit GREEN LIGHT states the Familiar surfaces in and explicit RED LIGHT states it holds in (vagueness is *not* a reason to stay quiet — the servile-default model needs the inclusion/exclusion conditions spelled out or it collapses to silence), names the cost of silence (the task waits forever; a missed task outweighs a refusable check-in), and offers concrete access ramps (timebox, single next action, planning-only slot, body-double). It deliberately contains no bias-toward-quiet language — see CLAUDE.md's proactivity section; a regression test in `tests/surface-context.test.mjs` guards against its return.

**Floating-task aging (0.7.x).** A floating task (no `when`) used to compute `ageDays` from `task.when` only — so it was always `null` and every floating task read as brand-new forever, with no staleness to prioritise. Now age falls back to `created_at` (which Unruh already serialised), the candidate carries a `floating` flag, and both surfaces show it — the candidate block (`[floating — no time set]` + `Floating for: Nd — still no time assigned`) and the `[Temporal Context]` open-tasks list (`(floating Nd — no time set)`). The prompt gains a dedicated FLOATING TASKS directive: the aged ones earn a gentle "when shall we put this?" in a calm moment, and the Familiar pins the agreed time with the new **`schedule_assign_time(id, when)`** tool (thin wrapper over `updateScheduleNode` → Unruh `schedule_update_node`, which always supported setting `when_ts` — the capability existed end-to-end but had no Familiar-facing surface). Turning a someday into a real `when` is itself counted as progress.

**Addressing schedule nodes by id (0.7.x).** Every schedule editing tool — `schedule_assign_time`, `schedule_snooze_task`, `schedule_resolve`, and `schedule_delete` — is keyed by a node **id**, but the human-readable schedule renders **labels**. Both surfaces that show schedule state now also surface the ids the tools need, so the Familiar can *act on* what it can *see* (the CLAUDE.md operability rule: a tool whose key argument the Familiar can never name is a tool it can never use):
- **`[Temporal Context]`** (`temporal-format.js`) appends a compact `[schedule ids]` legend at the end of the block — mirroring the knowledge-graph id legend — listing `label [type] = id` for both routine phases and the window, deduped, skipping nodes with no id. This is the only path by which a **phase** id reaches the model (phases are otherwise label-only in "Today's rhythm").
- **`[Surface candidates]`** (`surface-context.js`) prints an `id:` line under each candidate, so a floating task surfaced for time-assignment carries its id in the same place the Familiar reads about it.

**`schedule_delete(id)` (0.7.x).** Permanently removes a schedule node — event, task, reminder, or routine **phase** — via `deleteScheduleNode` → Unruh `schedule_delete_node` (which returns `{ok, deleted}`; `deleted:false` means no such id). Distinct from `schedule_resolve`, which marks a node `done`/`cancelled` while *keeping the record*: delete *erases* it, and is the only way to remove a phase or clean up a duplicate/mistaken entry. The plumbing (`deleteScheduleNode` thalamus helper + the Unruh MCP tool) already existed end-to-end; it simply had no Familiar-facing tool until now — the classic "capability not reachable BY the Familiar" gap.

**Storage decision:** event records and reflection metadata live in `tomes/.surface-events.json` (per-embodiment, like ponderings). Identity-layer *insights* derived from them ("Eury crashes within 4h of skipping meals" — Eury here is the *reference* Familiar instance used in examples, **not** a universal name; each user's Familiar is named via the `{{char}}` config, and code/prompts never hard-code "Eury") get lifted to Phylactery's `custom/what_lapses_cost.md` only after the reflection LLM judges the pattern strong enough. The raw event stream belongs to Proto-Familiar; the durable knowledge belongs to the entity.

**`what_lapses_cost.md`** lives in Phylactery's `custom` category as `what_lapses_cost.md`. The Familiar writes via the reflection loop when patterns emerge. May not exist initially; surface-context assembly is null-tolerant.

Files: `surface-context.js`, `surface-events.js`, `docs/consequence-priors.md`.

## Deferred-action pattern (wants_to_save)

The autonomous pondering loop has no tool access — it's a background process that calls the LLM and writes to a tome, but can't call `save_memory` or `update_identity` during that call. The deferred-action pattern bridges this gap in two pillars:

**Pillar A (pondering-loop side, `pondering.js`):** When the Familiar notices, while pondering, that something fact-shaped wants to be filed, she records a `wants_to_save` intent in the tome entry instead of trying to write it there. Each intent has `kind` (tome/memory/identity), `summary` (what to save), and `acted_on: false`.

**Pillar B (chat-turn side, `recent-ponderings.js` + `thalamus.js`):** At the start of every live chat turn, `getUnactedIntents()` reads up to 5 unacted intents (oldest-first) from the ponderings tome. `enrich()` formats them as a `[Deferred intents from my free time]` block in the dynamic context — one entry per intent with the routing tool (`save_to_tome` / `save_memory` / `update_identity`) and the `(uid, index)` pair. The Familiar files each one at her own discretion during the turn. After each filing, she calls `acknowledge_deferred_intent(uid, index)`, which hits `POST /api/ponderings/intents/acted-on` and flips `acted_on` to `true` under the per-file lock.

The pattern is forward-compatible: any module that produces `wants_to_save` intents (pondering, reflection, future scan candidates) shares the same consumer infrastructure. No new LLM requests; the intents ride the existing chat turn.

**A fourth kind, `followup`, is minted straight into the tome (not via a pondering call) — `memorization.js`'s session extraction, via `createSessionFollowup()`.** It's the "I'll do that later" catch: a commitment the Familiar voiced in chat but never backed with a tool call. Unlike `tell` (auto-consumed after one live turn — the whole action IS the saying) it behaves like the filing kinds: it needs the real tool call before `acknowledge_deferred_intent`, because saying it again isn't doing it. It additionally ages out (dropped, `disposition:'aged-out'`) after `followupMaxAgeDays` so it doesn't nag forever. See the "Deferred follow-ups" note under `recent-ponderings.js` above and `docs/deferred-followups-build-spec.md`.

`injectDynamicAtDepth(messages, dynamicContent, depth)` in `server.js`
is a pure helper; `tests/depth-inject.test.mjs` guards the
load-bearing invariant *"messages[0..injectedAt-1] is the same
reference as the input"* — without it, the prefix-cache claim is
hollow.

## Id scheme (0.8.x overhaul) — readable slugs, opaque everywhere

Model-facing ids are **label-derived word slugs with a short random
suffix** — `dentist-k3`, `weekly-cleaning-8f`, `sister-mira-k3`; label-less
rows (edges, handoffs) lean on their kind (`causes-x7k2`). Generated at the
three id seams (`unruh/db.slug_id`, `phylactery/db.slug_id`,
`pondering.shortPonderUid`), collision-checked at insert (`insert_with_slug_retry`
regrows the suffix, uuid4 as the final fallback). Why: a 32-hex uuid costs
~16 tokens per legend line and can't be read or reliably retyped by the
model; a slug costs ~3 and self-documents in tool calls.

**The invariants:**
- **Ids are opaque TEXT everywhere.** Nothing parses id shape — old uuid4-hex
  ids coexist with slugs forever; there is no migration and none is needed.
  Never write code that infers meaning from an id's format (the label in a
  slug is a *mnemonic snapshot at creation*, not a live pointer — renames
  don't re-key).
- **Path-facing validators accept both shapes.** `isValidEntryUid` /
  `VALID_GRAPH_ID_RE` / the export-endpoint check are `alnum+dash, bounded
  length` — traversal-proof without assuming UUID. Session ids, tome ids, and
  job ids remain strict UUIDs (`isValidUUID`).
- **Memories get slug ids too** (`content`-derived, `memory.create` →
  `db.insert_with_slug_retry`, `kind="mem"`). They're surfaced by
  recall/list/read, the consent block, graduation, and intention `refs`, so
  they follow the same readable-id rule as graph nodes. (An earlier note here
  claimed memories "stay integer ids — already cheap"; that was wrong — the id
  was `uuid.uuid4().hex`, not an integer, so it was exactly the expensive-hex
  case the scheme exists to fix. Legacy hex ids remain valid — ids are opaque
  TEXT.)
- **Discovery is a capability, not a legend.** The `[schedule ids]` /
  `[graph ids]` legends cover what's in view; `schedule_find` (label search,
  any horizon) is how the Familiar reaches everything else — see below.
- **Sessions and the outbox are model-facing too** (the Familiar browses
  `logs/` and greps `tomes/.outbox.json` via list_files/read_file), so they
  slug as well: session ids are `s-YYYYMMDD-xxxx` (the log FILENAME says
  which day it was; `get_session_info` returns the current one), outbox item
  ids are `<kind>-xxxxxx`. Session gates accept both shapes
  (`isValidSessionId`). Old session LOGS keep their historical uuid names —
  renaming archives would break cross-store references.
- **`convert_ids_to_slugs`** (Familiar tool) is the one-shot mechanical
  re-key for everything else: Unruh nodes/edges (`unruh_ids_to_slugs`, one
  transaction, FK-safe), Phylactery graph (`graph_ids_to_slugs`, incl.
  embedding rows), pondering uids, outbox item ids — and it follows the
  node-id mapping through the JSON stores that reference them (outbox
  originIds, projection-cue aging state, surface-event task_ids). Idempotent;
  no LLM judgment anywhere.

## Significant memories — the composite-key contract (regression guard)

This contract broke once already, silently, as a side effect of a fix.
Read this before touching ANYTHING that addresses a memory by date.

**The entity-core contract** (source of truth: `packages/entity-core/src/tools/memory.ts` in Psycheros):

- Significant memories are stored **one named file per milestone**:
  `data/memories/significant/{date}_{slug}.md`
  (e.g. `2026-06-11_why-melian-trusts-me.md`). The slug is mandatory in
  practice — two slugless saves on the same date collide on `{date}.md`
  and entity-core's merge-and-dedup destroys content (the original
  "significant memories disappearing" bug).
- `memory_list` returns significant entries with a **composite** `date`
  field: `` slug ? `${date}_${slug}` : date ``.
- `memory_read` / `memory_update` / `memory_delete` do **NOT** accept
  the composite form — they validate `date` against
  `/^\d{4}(-W\d{2}|(-\d{2})?(-\d{2})?)$/` and take `slug` as a
  **separate optional parameter**. An update that reaches entity-core
  without a slug relies on its fall-back-to-existing-slug behaviour to
  avoid writing a bare `{date}.md` that *shadows* the real
  `{date}_{slug}.md`.

So the identifier a consumer **sees** (from listings) is not the
identifier the write tools **accept**. Every seam between the two must
split the composite key.

**The single splitting point:** `cerebellum.parseMemoryKey(key)` →
`{ date, slug | null }` or `null`. Splits at the FIRST underscore
(dates never contain one; slugs may), and rejects slugs containing
dots or slashes so a key can never smuggle path segments. Do not
re-implement this split anywhere else.

**The seams that must honor the contract** (all wired as of 0.4.1-alpha):

| Seam | What it does |
|---|---|
| `GET/PUT/DELETE /api/entity/memories/:granularity/:date` (server.js) | Accepts the composite `:date`, splits via `parseMemoryKey`, passes `date` + `slug` separately to thalamus. **Never reintroduce a plain-date regex here.** |
| `GET/PUT/DELETE /api/entity/memories/by-id/:id` + `POST …/move` (server.js) | The unique-handle surface (registered BEFORE `:granularity/:date` so `by-id` isn't swallowed as a granularity). The only way to address one of many standalone facts that share a date; `…/move` re-files a mis-dated fact. |
| `thalamus.readMemory` / `updateMemory` / `deleteMemory` | Pass `slug` through to entity-core's tools. `updateMemory` without the slug is the shadow-file hazard. |
| `thalamus.readMemoryById` / `updateMemoryById` / `deleteMemoryById` / `moveMemoryDate` | By-id wrappers over the `memory_*_by_id` / `memory_move_date` MCP tools. |
| `update_memory` / `delete_memory` executors (cerebellum.js) | Split the model-supplied key; their tool descriptions teach the `YYYY-MM-DD_slug` addressing. |
| `read_memory_by_id` / `move_memory_date` / `update_memory_by_id` / `delete_memory_by_id` executors (cerebellum.js) | The Familiar's by-id surface; ids ride in on `recall` / `list_memories`. `move_memory_date` cleans up facts filed under the wrong day; `update_/delete_by_id` safely correct or remove ONE per-fact row. The by-date `update_memory`/`delete_memory` are journal-bucket/significant only (scoped `slug IS NULL`). |
| `save_memory` executor | Auto-derives the slug (`deriveMemorySlug`) and returns the composite key in its confirmation so the Familiar knows the address of what it just wrote. |
| Knowledge editor — memory panel (app.js) | Addresses every read/edit/move/delete by the row's `id` (0.7.61). It used to send the `granularity/date` key, which collided for standalone facts sharing a date — clicking any row opened the top one. By-id is the fix; don't regress it back to key-addressing. |

**How it broke the first time** (so it isn't repeated): originally,
significant saves had no slugs — listings returned plain dates and the
editor worked, but same-date saves destroyed each other. The slug fix
(0.3.x) made *writes* safe, which changed what `memory_list` returns —
and the read/edit/delete seams, still validating plain dates, started
rejecting every new entry with `invalid date format` (found
2026-06-11, fixed in 0.4.1-alpha). The lesson: the date+slug contract
spans multiple seams across two repos; a change to how memories are
*written* is also a change to how they are *addressed*, and every seam
in the table above must move together.

**The guard:** the `parseMemoryKey` suite + executor-hint tests in
`tests/cerebellum.test.mjs`. If a refactor makes those tests awkward,
that is the contract talking — update all seams together or stop.

## Autonomous loops — when and what

| Loop | Cadence | Off-switch | What it does |
|---|---|---|---|
| Memorization | 5s tick | `PROTO_FAMILIAR_MEMORIZE_DISABLED=1` | Drains queue of session-memorization jobs |
| Pondering | 1min tick + tier-based interval | Settings toggle + `PROTO_FAMILIAR_PONDERING_DISABLED=1` | Picks an interest, ponders it, writes a real tome entry. When web search is on, a tick may first do bounded unattended research (`ponder-research.js` + `ponder-web-budget.js`, §8.5): the model names searches/URLs, code executes the reads under a shared daily budget, sources are cited in the ponder and audited under surface `pondering`. Settings toggle + `PROTO_FAMILIAR_PONDER_WEB_DISABLED=1` |
| Reminders | 30s tick | `PROTO_FAMILIAR_REMINDERS_DISABLED=1` | Polls `reminders_due`, enqueues into outbox, marks fired; same tick runs event lead-time alerts (`PROTO_FAMILIAR_EVENT_ALERTS_DISABLED=1` to silence those alone), the weather refresh (self-gated to a 6h cadence; `PROTO_FAMILIAR_WEATHER_DISABLED=1`), and elapsed-stamping of long-past unresolved events (self-gated hourly; `PROTO_FAMILIAR_ELAPSED_STAMP_DISABLED=1`) — both ride this tick rather than spinning their own loops |
| Page watches | 5min base tick + per-watch interval (~6h default, 15min floor) | Settings toggle + `PROTO_FAMILIAR_PAGE_WATCH_DISABLED=1` | Re-reads each watched URL over the static read path, diffs in code, and only on a real change asks the LLM whether to surface an outbox banner (§9 Horizon #1; `page-watch.js` + `page-watch-loop.js`). Inert until a watch is registered. `logs/page-watch-events.jsonl` |
| Silence triage | 5min tick + LLM-set cool-down | `PROTO_FAMILIAR_TRIAGE_DISABLED=1` | LLM decides "should I reach out?" given threat + silence |
| Warm reach-out | 10min tick + LLM-set cool-down | Settings toggle + `PROTO_FAMILIAR_WARMTH_DISABLED=1` | Warm non-crisis outreach (ward banner or warm-villager DM); stands down at moderate+ threat |
| Tome graduation | 30min tick (opt-in, default OFF) | Settings "Graduate tome knowledge" + `PROTO_FAMILIAR_TOME_GRADUATION_DISABLED=1` | Drains durable facts stranded in tomes → identity/memory/graph (relational facts resolve-or-create + dedup); confirmed route before tidy; consent-gated ward memory |
| Content-gating re-tag | 30min tick (opt-in, default OFF) | Settings "Review my private notes for content-sharing" + `PROTO_FAMILIAR_CONTENT_REGATE_DISABLED=1` | The Familiar reviews EXISTING ward-private ward-self facts and, with a batched judgment, opens the ones that may be content-gated (`audience → ward-content-gated`, optionally correcting the `content_tag`) while keeping the rest private. Conservative (unsure → keep); code-selects candidates (ward-private + no third-party subject only); a reviewed-tracker judges each once; every opening writes a `[DISCLOSURE NOTICE]` the ward reads + is revertible (`keep_memory_private`). Never on the chat path |
| Needs tracking | 30min tick (opt-in, default OFF) | Settings "Track unmet needs" + `PROTO_FAMILIAR_NEEDS_TRACKING_DISABLED=1` | Marks a recurring need-window's occurrence `missed` once its window elapses unresolved (the needs-fulfilment ledger). Stands down at moderate+ threat; only the lapse is made factual — never auto-confirms a projected consequence |
| Memory coverage sweep | 10min tick (default ON) | Settings "Memory coverage sweep" + `PROTO_FAMILIAR_MEMORY_SWEEP_DISABLED=1` | Memorizes PAST days that never ingested (day-anchoring Phase 2); skips today + completed days; only enqueues into the memorization worker — no LLM call of its own |
| Noticing | 20min base pulse + self-set cadence (default ON) | Settings "Let my Familiar notice on its own" + `PROTO_FAMILIAR_NOTICING_DISABLED=1` | The Familiar's own turn: code-gated wake conditions (due intentions, rhythm deviation, readiness gaps, aging intents/tasks, overdue events) → bounded tool-using deliberation. Runs at ALL threat tiers (ward-signed no-stand-down); every decision-reaching tick logs to `logs/noticing-events.jsonl` |
| Media retention | 6h tick (default ON) | Settings toggle + `PROTO_FAMILIAR_MEDIA_RETENTION_DISABLED=1` | Voice Pass 4 §9, the 13th worker. Curates aged voice-clip SOUNDS: code gates pick candidates (audio past `voiceNoteRetentionDays`, not stripped, not `keep`, has a transcript) → ONE batched LLM judgment names which sounds to keep → the rest `media.stripAudio` (bytes gone, transcript+meta+slugs survive). The transcript ALWAYS survives. Fail-soft: an LLM error or unparseable response keeps everything that pass (never strips on doubt). Defers during a live call + at moderate+ threat |
| Google Calendar sync | 60s wake + ward interval (hourly default; opt-in, default OFF) | Settings "Google Calendar sync" + `PROTO_FAMILIAR_GCAL_DISABLED=1` | Fetch the ward's iCal feed → Unruh `gcal_ingest` (parse + reconcile + change-classify) → route ONLY `new` ids to the projection cue. Failure degrades silently and never reconciles deletions |
| Discord gateway | 30s supervisor | Settings toggle + `PROTO_FAMILIAR_DISCORD_DISABLED=1` | Bidirectional Discord presence; follows Settings (token/enable) without restart |
| Threat detection | per chat msg (in-band) | `PROTO_FAMILIAR_THREAT_DISABLED=1` | Patterns score my human's text; tracker accumulates with decay |

The autonomous loops do not run during shutdown — server.js's SIGTERM
handler awaits each loop's `stop*()` before closing the MCP children.

## Voice — Pass 0 (the bench tool and its supply chain)

Voice owns its own milestone (`docs/voice-build-spec.md`). Pass 0 is the
measuring pass: it ships no speech, only the machinery that decides what a
ward's machine can actually run and what it costs them. Five modules, all
pure or file-local, none on the chat path.

| module | owns |
|---|---|
| `voice-models.js` | The manifest + tier composition. Two INDEPENDENT axes — capability (`read-aloud` / `listening` / `listening-plus`) × voice engine (`pocket` / `piper`) — and the §0.7 footprint ceilings, checked by `evaluatePlan()`. ASR languages are a table; `availableAsrLangs()` returns only curated **and** pinned ones so a menu cannot offer what cannot be fetched. |
| `voice-footprint.js` | On-disk measurement per category and the free-space pre-flight. Fails **closed**: unreadable free space refuses a download rather than guessing. Splits re-fetchable MACHINE artifacts from the Familiar's own SELF (memories, tomes, graph, kept media) — only machine artifacts are ever reclaimable. |
| `voice-fetch.js` | Pre-flight → refuse-unpinned → stream-and-hash → verify → content-addressed install. Blobs stored once and hardlinked; reclaiming one model can never take a blob another still needs. |
| `voice-extract.js` | Archive unpacking. Verify-THEN-unpack, two independent path-traversal defences, temp-then-rename so a failure leaves no half-installed directory. `.installed.json` records which archive produced a model directory. |
| `voice-catalogue.js` | Which reference voice clips may ship, and on what terms. |
| `voice-bench.js` | The measurements: WER (real word-level edit distance with the operation mix), RTF at 1 and 2 streams, TTS time-to-first-chunk, and the §4 interference phase. Report renders to markdown + JSON. |

**The supply chain is three-way (spec §0.8):** the `sherpa-onnx-node` binding
and its per-platform binary come from npm (optionalDependency, one platform
per ward); the models are fetched on first enable from pinned URLs with
sha256; bench fixtures are vendored so WER is comparable across wards.

**Pins are machine-written, never typed.** `voice-model-pins.json` is produced
by `scripts/pin-audio-models.mjs`, which downloads a candidate, hashes it in
flight, and — for archives — unpacks it to record the size it occupies on
disk. `applyPins()` accepts only whole records (https url, 64-hex sha256,
positive byte count), so a half-pin can never become a fetchable model. This
is the exact-values rule made structural: there is no line in source for
anyone to type a hash into.

**Download size and disk size are different numbers, and both matter.** bz2
archives expand (the German decoder: 55 MB fetched, 68 MB unpacked). The §0.7
ceilings are checked against DISK; the pre-flight is checked against PEAK —
during install the archive and its unpacked copy both exist, and sizing only
the download would start a fetch that cannot finish, on precisely the
nearly-full machines the budget exists to protect.

**Licensing is enforced in code, not remembered.** `shippableSources()` gates
on the licence field; non-commercial sources (Expresso, EARS) cannot reach the
shipped set of a GPL distribution, and stay listed *with their reasons* so
nobody rediscovers and re-litigates them. The NOTICE text is generated from
the catalogue so a credit cannot be dropped by editing prose.

**Ward-supplied voice clips are allowed and are handled as personal use.**
PocketTTS clones zero-shot from a ~10 s clip, so a ward may use a voice that
means something to them. `mayLeaveTheMachine()` fails closed — such a clip
never rides out in a diagnostic, bench report or shared surface — but
`belongsInIdentityBackup()` is true for every voice, because a restored
Familiar that comes back sounding like a stranger is a continuity break. The
two questions are orthogonal by design.

⚠️ **Aspirational, not wired (found in the Pass 1 audit).**
`belongsInIdentityBackup()` has no caller: Phylactery's backup is Python and
never asks this JavaScript function anything, so **voices do not currently
survive a backup/restore**. The predicate encodes the right intent and is
tested; what is missing is a decision about where backup responsibility for
non-Phylactery files lives. Do not read this paragraph as describing working
behaviour.

## Voice — Pass 1 (speaking, and why it took four attempts)

Read-aloud runs as a **two-step HTTP flow** so planning and speaking can be
paid for separately:

| endpoint | cost | what it does |
|---|---|---|
| `POST /api/voice/speech-plan` | none | markdown → speakable text, returns a short-lived `say-xxxxxx` id |
| `GET /api/voice/tts/:id` | a model + generation | streams a wav — engine-branched (see below) |

The browser gets the whole shape of a message immediately, then points an
`<audio>` at the streaming URL. `GET /api/voice/tts/:id` takes **one of two
paths, by engine** (`resolved.backend`):

- **`pocket` (sidecar, default):** streams out of ONE generation per
  `splitForGeneration` part (ordinary messages are a single part). The KV cache
  carries the whole message, so there is nothing to drift and no tail to drop —
  responsiveness from streaming, completeness for free. Never pre-split into
  small utterances; that would force a clone per piece and reintroduce seams.
- **`sherpa` (built-in fallback):** **buffered self-healing**
  (`speakUnitsSelfHealing`, `voice-generation.js`). The message is split into
  small units (`SMALL_UTTERANCE_CHARS`), each generated to a full clip and
  checked against `renderDroppedWords` *before* any of its audio is written. A
  short one is re-spoken with a bumped seed (which breaks sherpa's deterministic
  early-EOS); if it stays short it drops to sentence granularity, each verified
  and emitted once. Costs a small delay before the first words; buys the
  guarantee that no sentence silently vanishes. Any still-short sentence is
  counted and logged — never dressed up as success.

### The four bugs, in the order they were found

Each looked like the previous one's fix had failed. They were different.

1. **No seed.** PocketTTS re-seeds its sampler *per sentence* inside one
   `generate` call (`NormalDataGenerator normal_gen(0, stddev, seed)`), and
   upstream's default is `-1` — random every time. Three sentences came out as
   three speakers. The seed lives in the untyped `extra` map, which is why
   neither the JS typedefs nor the compiled strings list it; **the C++ header
   does**. `voice-generation.js` now fixes it, and refuses `-1` rather than
   forwarding "surprise me".

2. **The runt fragment.** `SplitLongSentence` splits at `max_char_in_sentence`
   and drops the remainder into its own chunk — after `MergeShortSentences` has
   already run, so it is never merged back. A 205-char sentence became
   `[…199 chars, 'real.']`. `'real.'` hit EOS at step 0, and upstream's
   `if (eos_step > 0 …)` never fires for zero, so the loop ran its whole frame
   budget: up to 40 s of degenerating noise. Fixed by prevention (thresholds
   raised, `capSentenceLength` guarantees a minimum piece) **and** containment
   (`runawaySampleLimit`, clamped below the frame ceiling so it can always
   fire).

3. **The reference recording.** Upstream: *"the audio quality of the sample is
   also reproduced."* Kyutai use `_enhanced` for every VCTK voice; our picker
   defaulted to `original`. Measured: same pitch, same duration, ~23% more
   high-frequency energy. The bundled clip is now the enhanced one.

4. **LM state resets per utterance.** `GenerateSingleSentence` opens with
   `GetLmMainInitState()`. Merging (`min_char_in_sentence` 30 → 400) made resets
   rarer — drift moved from per-sentence to per-paragraph — but the port offers
   no way to continue a trajectory across a call. That is what the sidecar
   exists for.

   **A fixed 400 was not enough, and my human heard it** ("it swaps through
   different voices at different points of the message" — within one message,
   built-in engine only, never the sidecar). 400 makes an *ordinary* message one
   trajectory but leaves a long one as several, and every extra utterance is
   another voice.

   **The one-utterance "fix" was reverted — it dropped words.** Sizing the whole
   message as one utterance (`wholeUtteranceMin`, briefly shipped) does give one
   voice, but PocketTTS was trained on sentence-length audio and reaches EOS
   early on a very long "sentence", swallowing the tail: measured, an 899-char
   message rendered in half the duration (36 chars/s — impossible for real
   speech). So there is **no single built-in setting that wins both** — small
   drifts the voice, large drops content. That is the whole reason `pocket` is
   the default now (its KV cache needs no resets), and the reason the built-in
   read-aloud path *verifies and re-speaks* instead of trusting one big
   generation (see "read-aloud", above). `MIN_CHAR_IN_SENTENCE` stays 400 for
   the hand-it-one-trajectory paths; the self-healing path deliberately uses the
   much smaller `SMALL_UTTERANCE_CHARS` so a dropped sentence is detectable.

### Two backends, one protocol

`voice-backend.js` decides which process speaks. Both talk the framed stdio
protocol in `audio-frame.js`, so `audio-worker-host.js` supervises them
identically — parking, backoff and idle unload were written once.

| | `pocket` (default) | `sherpa` (built-in fallback) |
|---|---|---|
| worker | `voicebox/` (Python) | `audio-worker.mjs` |
| cost | ~600 MB installed | ships; ~216 MB |
| model | `english_2026-04` | `2026-01` (only ONNX export) |
| continuity | `copy_state=False` carries the KV cache | resets per utterance |

`pocket` is the **default** because it does not drop the tail of a long message
the way sherpa's per-utterance reset does. But nothing downloads at boot: a
machine with no venv still speaks immediately, because `resolveBackend` **falls
back to sherpa and says so** (`fellBackFrom: 'pocket'`, in the log and on
`/api/voice/status`). The ~600 MB is fetched **on first use** —
`autoInstallSidecarIfDefault` fires from the read-aloud path (never from status
polling, so opening Settings pulls nothing), with visible, cancellable progress;
selecting `pocket` in Settings starts the same download (the selection is the
consent). The worker is built on first use; the old one is stopped before the
new starts so two engines never hold models in RAM at once.

**Runtime fall-back, not just install-time.** `resolveBackend` only knows whether
pocket's *files* are present — it can't see that torch's native library won't
load (Windows "[WinError 126] … c10.dll" from a missing Visual C++ runtime, a
corrupt install). So `currentAudioWorker` **verifies a freshly-built pocket
worker actually loads** (one `ping`, which runs the torch import + model load, so
it doubles as a warm-up) and, if it can't, tears it down and rebuilds on sherpa —
same `fellBackFrom: 'pocket'` shape. The result is cached (`pocketBroken`) so a
known-bad pocket isn't respawned every turn, and cleared by `stopAudioWorker` so
a repair (Fix Kyutai) + fresh worker is re-verified rather than demoted forever.
This is why a missing VC++ runtime now means a *lesser voice*, not silence.

**Why a clean Windows box hits this at all:** torch's Windows wheels are built
against the MSVC runtime, and `uv`'s standalone Python doesn't ship it the way
conda does (astral-sh/uv#18413) — a dev machine usually already has the redist
from something else, a fresh one doesn't, so "same hardware, mine works, theirs
doesn't." `ensureWindowsMsvcRuntime` (voice-backend.js) closes that gap: on
Windows it installs cgohlke's `msvc-runtime` wheel into the venv to ACQUIRE the
runtime DLLs, then **copies them into `torch/lib`** — because the wheel drops
them beside python.exe (sys.prefix / Scripts), which is *not* where torch looks.
torch loads c10.dll from `torch/lib` and Python 3.8+ resolves that DLL's own
dependencies from `torch/lib` + `add_dll_directory` dirs + system dirs only —
never sys.prefix or PATH — so the runtime is discoverable only if it sits in
`torch/lib` itself (the first version of this fix installed the wheel and stopped
there, and Kyutai still failed with WinError 126). The copy is a pure, testable
helper (`placeMsvcRuntimeBesideTorch`), idempotent, re-run after every venv sync.
No admin, no system-wide redist. It runs from **every** install/repair path (the
`ensure-voicebox.mjs` CLI, the Settings/first-use auto-install it shells, and
`rebuildVoicebox`), best-effort (older Python has no wheel → the built-in engine
still covers it). `POST /api/voice/fix-kyutai` rebuilds the venv, adds the
runtime, and proves torch imports before declaring success (returning the
official-redist hint only when even that isn't enough); it stops the audio
worker first so Windows can delete the venv python.

**Provisioned at install, not just first use.** The three installers (`install.sh`,
`install.bat`, `scripts/win/install.ps1`) run the voice setup on a **fresh install**
(Kyutai via `ensure-voicebox.mjs --install` + the listening models via
`ensure-audio-models.mjs`), so a new user isn't left to discover a download or
troubleshoot a half-set-up engine. Heavy, so it's fresh-install-only and skippable
with `PF_SKIP_VOICE_INSTALL=1`; every step is non-fatal (a machine that can't fetch
voice still gets a Familiar on the built-in engine). First-use auto-download still
exists as the fallback for installs that skipped it.

**Speed & expressiveness (`voiceTts.speed`, `voiceTts.temperature`).** User-tunable
in Settings → Chat → Voice. The two engines honour them differently: **sherpa** takes
both **per request** (threaded from settings into each TTS call); **pocket** takes no
speed (`generate_audio_stream` has none — reported `unsupported`) and bakes
temperature in at **model-load** time via `PF_TTS_TEMPERATURE`, so `resolveBackend`
puts the chosen temperature in the pocket worker's spawn env and `currentAudioWorker`
respawns the worker when that env changes (an env-signature compare) — which is why a
temperature change takes effect on the next spoken message, not mid-utterance. The UI
says as much. All voice settings now live under **Chat** (the engine picker, Fix
Kyutai, voice call, tuning, read-aloud); only the **Voice benchmark** stays in
Diagnostics.

**Listening is not governed by this default.** `listeningWorker()` resolves
sherpa **by name** (not via the default, which is now `pocket`) — the recogniser
is always a sherpa model, and routing a voice note to the Python speaker would
make it fail. Flipping the speaking default must never move the listener.

Install can still be run by hand with `node scripts/ensure-voicebox.mjs
--install`. Deliberately **not** in the prestart hook: downloading 600 MB
because someone typed `npm start` would be hostile on a full laptop — hence
first-*use*, not first-*boot*.

### Text preparation (`voice-speech.js`)

Markdown is written to be *read*; spoken verbatim it becomes "asterisk asterisk
careful asterisk asterisk". The translation is lossy on purpose. Code blocks
are **summarised** (`(py code block, 4 lines)`) — unreadable spelled out,
invisible if dropped. LLM-emitted `[HH:MM]` is stripped, because speaking a
fabricated time asserts it. Curly quotes and ellipses are normalised to ASCII:
the tokenizer has 4000 tokens and **no token contains them**, so SentencePiece
byte-falls-back and an ordinary apostrophe becomes three rarely-seen tokens.

### Media store

`media.js` holds images *and* audio in one content-addressed store —
`MEDIA_KINDS` derives kind and extension from a single lookup, so a voice note
can no longer be stored as an image carrying an audio extension. The audience
tag, dedup and slug ids were written once and cover both. Size ceilings are
per-kind (`maxBytesForKind`): 6 MB for an image, 24 MB for audio, because one
number cannot serve both — the image cap would have cut a voice note off at
three minutes.

### Voice notes (Pass 1) — shipped 0.10.x

New HTTP surface: `POST /api/media` (now `image/*` **and** `audio/*`),
`POST /api/media/:id/transcribe`, `POST /api/media/:id/transcript` (the ward's
correction), `POST /api/voice/ward-voice`, `GET /api/voice/local`, and
`POST /api/voice/install-models` taking `{what:'speak'|'listen'|'call'}`.

- **A transcript my human can correct** (`correctTranscript` in
  `voice-transcribe.js`). A recogniser mishears names and anyone whose speech it
  wasn't trained on — "wish me luck" came back as "Wish May Look" — and the
  transcript is not decoration: it is what the Familiar reads in the turn, what
  memorisation folds, and what the asset's slug was minted from, so a
  mis-hearing is wrong everywhere at once. The correction keeps what the
  recogniser actually heard as `description.auto` (never overwritten by a second
  correction) and marks `corrected:true`, so nothing downstream mistakes it for
  the Familiar's own hearing. It also **re-graduates the slug** from the
  corrected words (`setAssetDescription(..., {regraduate:true})`) — a note
  findable only as `wish-may-look-x7` becomes findable by what was said — while
  every old slug keeps resolving forever (ids are opaque; nothing may break).
  The composer chip carries the edit affordance, so the fix happens before the
  note is ever sent.

The listen-once-keep-forever path, deliberately shaped as vision's twin.

```
browser                     server                        worker
───────                     ──────                        ──────
MediaRecorder (webm/opus)
  → decodeAudioData
  → OfflineAudioContext ──── 16 kHz mono wav
  → encodeWav                     │
        POST /api/media ──────────┴─→ saveAsset  kind:'audio'
                                        durationSec read from the header
        POST /api/media/:id/transcribe
                                    → transcribeAsset ──→ load  asr-offline
                                                     ──→ transcribe wavPath
                                    ← text cached in `description`
                                      slug graduates: snd-4kf2p1 → bins-tonight-x7
chat turn:  hearVoiceNotes() ──→ ensureTranscribed (BEFORE prompt assembly)
            materializeAttachments ──→ [voice note bins-tonight-x7, 0:41: …]
```

- **The browser converts, not the server.** `MediaRecorder` gives webm/opus or
  mp4/aac; nothing server-side can decode either without a media library, and
  the recogniser wants 16 kHz mono PCM. The browser already contains a decoder
  and resampler, so conversion happens where it is free and the store keeps the
  one format it can always read — with no codec dependency years later.
- **The transcript lives in `description`**, the same slot an image's caption
  uses. Every consumer (stand-in builder, slug graduation, memorization's fold)
  already treats that field as "the words I have for this thing" and needed no
  change. That is also why a transcript outlives its bytes.
- **Audio never rides as provider content-parts.** Gated in
  `materializeAttachments`' live-eligibility check, not at the use site, so a
  future audio modality is one condition to relax.
- **`audio-worker-current.js`** owns TWO workers, deliberately.
  `currentAudioWorker()` follows my human's speaking choice (sherpa or the
  voicebox sidecar); `listeningWorker()` is pinned to sherpa always, because the
  recogniser is a sherpa model and which voice SPEAKS has nothing to do with it.
  Conflating them meant that choosing the voicebox voice sent every voice note
  to a Python process that cannot listen. Both live here rather than in
  `server.js` so Discord reaches the same ones — the shape of the RULE C
  incident. `voice-transcribe.js`'s `hearVoiceNotes()` is the one call both
  surfaces make; see the voice spec's §14.5 surface matrix.
- **⚠️ Never leave a placeholder for an op that has an implementation.** The
  OPS table in `audio-worker.mjs` carried `transcribe` twice — real handler,
  plus a leftover stub — and the duplicate key silently won, killing voice notes
  for four rounds of testing. `npm run audit:wiring` check 8 now fails on a
  duplicate member in a top-level dispatch table, and a pipeline test spawns the
  real worker rather than a stub. Full account in the voice spec §14.7 and
  CLAUDE.md's verification-errors section.
- **Failure reasons are enumerated, not improvised.** Everything the worker or
  its supervisor can return has words for my human in `transcriptProblem()`
  (public/app.js), and a test derives the list from the emitting source — a
  hand-written version missed `no-engine`, and an unmapped reason shows as
  "I couldn't make this one out", which blames my human's diction for a routing
  bug.
- **Two consents, not one.** `voiceEnabled` (default OFF) governs everything
  that hears. Read-aloud does not depend on it — it is an accessibility
  surface. `PROTO_FAMILIAR_VOICE_DISABLED=1` kills both.
- **The recogniser is SenseVoice** (`asr-offline`, zh/en/ja/ko/yue in one
  model, punctuation + inverse text normalisation built in). Decoded offline,
  once, with nobody waiting — so accuracy is the only axis and the streaming
  models stay unfetched until live calls in Pass 2.
- **Streaming ASR is the Pass 2 worker spine (2a, landed).** Alongside the
  offline recogniser the worker now loads an `asr-streaming` role (an online
  zipformer transducer) and a `vad` role (Silero). `asrStream` opens a
  per-`streamId` session; inbound `KIND_PCM` frames route straight to
  `feedDecoder`, which runs sherpa's online contract (accept → decode-while-
  ready → `getResult`) and emits unsolicited `asr-partial` / `asr-final` frames
  as text forms and endpoints fire; `asrStreamStop` flushes the tail and drops
  the session. Endpoint rules live in one named constant (`ASR_ENDPOINT`),
  tunable against the §6.1 latency budget on the ward's hardware. Verified on
  the real engine — chunked decoding is byte-identical to a whole-file decode,
  and a spawned-child pipeline test (guarded by `PF_ASR_STREAMING_MODEL_DIR`,
  skipped in CI) streams a wav through the actual worker and asserts partials +
  a final. The `call-engine.js` that drives these (and fetches the model) is 2b.
- **`call-engine.js` is the platform-neutral call spine (2b).** It owns
  everything that is not transport — the `CallAdapter` registry, the one-call
  lifecycle, `tomes/.call-state.json` (`{active, callId, since}`; the compute
  governor's gate, read fail-safe via `isCallActiveFromFile`, cleared at boot by
  `clearStaleCallState`), speaker→stream routing to the streaming worker,
  endpoint→turn assembly, and `endUtterance` (push-to-talk's explicit boundary,
  finalising via the 2a stop→reopen). An adapter provides transport only
  (`joinCall`/`leaveCall`/`playAudio`/`stopPlayback`, pushing inbound audio
  through engine hooks) so the next platform is a transport-only job; the turn
  runner is an injected `onTurn` seam server.js wires to the chat path. Hard
  off-switch `PROTO_FAMILIAR_VOICE_CALL_DISABLED=1`. The web adapter + the real
  `onTurn` wiring are the next 2b slice.
  - **Hybrid ASR (ward-configurable, default ON).** The streaming 20 M zipformer
    is lossy (uppercase, no punctuation, weak on hard words). Since a call
    utterance has an explicit boundary (Discord speaking-end / web release), the
    engine uses streaming only for endpointing and re-transcribes the finished
    clip with the accurate offline model (SenseVoice — the same one voice notes
    use). `audio-worker.mjs` buffers the utterance and `emitFinal` runs the
    offline pass on finalize, falling back to the streaming text if the offline
    model isn't loaded or errors (graceful). The engine loads `asr-offline`
    alongside `asr-streaming` at call start when enabled and opens each stream
    with `offlineFinal`. Setting `voiceCallOfflineTranscribe`; off-switch
    `PROTO_FAMILIAR_VOICE_OFFLINE_ASR_DISABLED=1`. Benefits web and Discord calls
    equally (both share the engine + worker).
- **`voice-discord-adapter.js` is the Discord transport (Pass 3).** A second
  `CallAdapter` behind the same contract, so `call-engine.js` is untouched. Its
  only real work is the two format seams: inbound Opus (48 kHz stereo, decoded
  by `opusscript`) → 16 kHz mono for the ASR, and the engine's 24 kHz mono reply
  → 48 kHz stereo for `createAudioResource(Raw)`. Discord's own SPEAKING
  start/end events are the utterance boundary (no push-to-talk, no VAD), but the
  per-speaker subscription+decoder is opened once and kept OPEN for the whole
  call — subscribing reactively on each speaking-start clipped the first ~30–60 ms
  of every utterance ("Okay"→"KY"), so the events now only gate whether decoded
  audio feeds the engine or a small pre-roll buffer (flushed at onset); the
  subscription is torn down on channel-leave, not utterance-end. The `@discordjs/voice` functions + the
  Opus decoder are injected, so the whole adapter is unit-tested against a fake
  connection (`tests/voice-discord-adapter.test.mjs`); the resample helpers are
  pure and exported. The gateway voice bridge lives in `discord-gateway.js`
  (`GUILD_VOICE_STATES` intent bit 7; `discordVoiceAdapterCreator(guildId)` whose
  `sendPayload` is `wsSend`, so the library sends op 4 itself; `VOICE_STATE_UPDATE`
  + `VOICE_SERVER_UPDATE` dispatch forwarding; a `setVoiceRosterListener` seam for
  who-is-in-the-channel). `voice-discord-server.js` (`attachDiscordVoice`) wires
  it to a `call-engine`, shares the web path's ASR/TTS workers (the streamed
  synthesizer is now `voice-synthesize.js`, used by both transports — extracted,
  not copy-pasted), guards one-call-at-a-time across both transports via
  `isCallActiveFromFile`, and exposes `joinVoiceCall`/`leaveVoiceCall`.
  `server.js` attaches it at boot and registers it as the gateway's voice
  controller (`setDiscordVoiceController`), so a ward-only `!call`/`!join` (join
  the ward's current VC, found from tracked voice states) and `!leave` drive it.
  Off-switch `PROTO_FAMILIAR_DISCORD_VOICE_DISABLED=1`. **Pass 3b:** the ward's
  voice runs a real ward-private chat turn via `voice-chat-turn.js` — the shared
  `/api/chat` spoken turn (RULE-A guarantees) the web call also uses — wrapped by
  the same `createVoiceTurnRunner` (ward-only threat scoring, speakable,
  synthesize). A **registered villager**'s voice runs a turn gated to the ROOM's
  audience (ward-signed §5): the speaker slug resolves → user id (`refToUser`) →
  villager, the audience input `{location, participants}` is built from the
  complete VC roster (`discordVoiceChannelMembers`, seeded from `GUILD_CREATE`
  voice_states), and that object is the `sessionAudience` — so `/api/chat` scopes
  recall (`audiences`/`topicGrants`), withholds ward-private, tags storage. The
  villager turn carries **no ward-private history**, so it can't leak; storage is
  split per audience tag; a **stranger** is transcribed but never answered/stored
  (fail-closed); threat stays ward-only. The gated turn carries no tools. **Pass 3c (partial):** the ward-only
  `join_voice_call`/`leave_voice_call` Familiar tools (`cerebellum.js`
  `VOICE_CALL_TOOLS`, appended for the ward in `composeDiscordTools`, off under the
  hard switch) let her join/leave on natural language — the gateway injects
  `voiceJoin`/`voiceLeave` into the ward turn's tool ctx (no import cycle; it owns
  the controller + who's-in-which-VC), resolving the channel from the ward's
  current VC or a `<#id>` they mentioned so the Familiar names no argument. The
  per-location **call-mode dropdown** (`village.js` `callMode` off/summon/auto;
  default summon so `!call` always works, auto-join opt-in) governs joining: `off`
  refuses even `!call` (`locationCallModeFor`), `auto` joins hands-free when the
  ward enters a VC (`maybeAutoJoinVoice` off `VOICE_STATE_UPDATE`). **Pass 3d —
  group-call presence & attribution** (`voice-presence.js`, pure): in a group call
  (2+ humans) each turn is prefixed with the speaker's real name — my human's
  included, marked `(WARD)` (0.11.18) so I never read their words as my own or a
  villager's — in the live transcript and stored call history (solo calls unchanged;
  the memory write still carries the speaker as its own field). The same
  disambiguation covers multi-party **text** rooms: `attributeUserContent`
  (`discord-gateway.js`) prefixes every guild-channel turn — a villager as
  `[Name]:`, my human as `[Name (WARD)]:` — while a one-on-one ward DM stays raw
  (there's only us). Baked into the stored content so it replays identically. Names come from a
  gateway user-object cache (`gw.userInfo`, seeded from `GUILD_CREATE` members +
  `VOICE_STATE_UPDATE.member`) via `nameForVoiceUser`/`discordVoiceDisplayName`,
  with the villager name winning through a one-read `villagerByAlias`. A
  first-person "who's here / who joined or left" note is surfaced once per roster
  change (annotation only — like the room-sound note, never stored, never moves
  threat, gate untouched), and a leak-free spoken **greeting** (`voiceProactiveGreetings`,
  default ON) welcomes a non-ward arrival via the engine's `speakProactive` so it
  rides the next silence gap, deduped per stay and stood down at moderate+ threat.
  Off-switches `PROTO_FAMILIAR_VOICE_PRESENCE_DISABLED=1` (whole layer) /
  `PROTO_FAMILIAR_VOICE_GREETINGS_DISABLED=1` (spoken hello only). **opusscript
  shared-heap decode fix** (0.11.10): opusscript keeps one emscripten heap across
  all `OpusScript` instances and caches heap views at construction, so allocating a
  new per-speaker decoder (a second speaker joining) can grow the heap and detach
  the existing decoders' views → "memory access out of bounds" on their next packet
  (an existing speaker went silent when another joined). `decodeOpus` in
  `voice-discord-adapter.js` rebuilds the decoder on the current heap and retries
  the packet once (no audio lost, stream stays open; converges once the roster
  stabilises); a truly bad packet is skipped with a rate-limited warning, and an
  oversized packet (> `MAX_OPUS_PACKET`) is dropped before it can overflow the
  input buffer. All speakers including other bots are decoded (two Familiars by
  voice is supported). **Noise/silence
  polish** lives in `call-engine.js` as two options both call servers pass:
  `transcriptFilter` (drops ambient noise the recogniser guessed as CJK, via
  `isLikelyNoiseTranscript`) and `turnSettleMs` (coalesces sentences within a pause
  into one turn so the Familiar doesn't interrupt; ward-tunable `voiceCallSettleMs`,
  Discord always / web open-mic only). Ward-verified live (no gateway/UDP/Opus in CI). Deps: `@discordjs/voice` **≥0.19.2** (0.18 uses an
  older voice gateway with no DAVE and can no longer complete Discord's current
  voice handshake — it stalls `connecting → signalling`; 0.19 is gateway v8 +
  DAVE + the multi-transition fix), `opusscript` (pure-JS Opus, only needed once
  audio flows), `@noble/ciphers` (pure-JS transport encryption, primary) with
  `libsodium-wrappers` as a WASM fallback, and `@snazzah/davey` (DAVE E2EE — a
  napi-rs native module that ships PREBUILT binaries, so no compiler; pulled in by
  `@discordjs/voice`). `loadDiscordVoiceDeps` probes the transport ciphers up
  front, logs the active one, and fails the join FAST with a clear message if none
  load (a broken libsodium ESM build — seen on Windows AND Linux — otherwise
  stalls for 30s instead of naming the cause).

## Voice — Pass 4 (who is speaking, proactive voice, curation) — IN PROGRESS

The "who is speaking" spine is built as pure, testable modules ahead of the live
wiring (so the safety-critical logic is verifiable without audio):

- **`voice-embedding.js`** — pure vector math (cosine similarity, L2 normalise,
  averaged enrolment). Fail-soft: garbage → 0, never NaN/throw (it runs on the
  live-call path).
- **`voiceprints.js`** — the LOCAL biometric store, `tomes/.voiceprints.json`
  (git-ignored, never synced, never leaves the embodiment). Ward print + opt-in
  per-villager prints. `enrolledPrints()` feeds the diarizer. Never throws on a
  missing/corrupt file.
- **`voice-guest-watchdog.js`** (SAFETY-CRITICAL, ward-signed §8.2) — the privacy
  state machine. ENTER on N=3 consecutive non-ward segments; RELEASE only on BOTH
  M=6 ward segments AND ≥90 s quiet; instant spoken-release ONLY in a
  ward-matched segment (un-fakeable), plus manual/UI release. Emits transitions
  for logging; the `voiceGuestPolicy` (ignore/note/gate) is the caller's, never
  decided here. Any behavioural change needs the ward, like the audience gate.
- **`voice-diarize.js`** (§8.3) — mixed-stream matcher: enrolled prints first,
  then short-lived online clusters (guest-1/guest-2); unmatched → stranger-tier
  (fail-closed). **Wired into the call engine (open-mic path):** the engine's
  `diarize` + `diarizeSegments` seams run the stage only in open-mic mode with the
  model present — on each finalized utterance the buffered PCM is embedded and
  `diarize()` resolves `{ref,name}`; the turn is attributed to that speaker.
  `voice-call-server.js` builds a per-call diarizer **only when a ward print
  exists** (no baseline → no diarization, call stays ward-private), and `runTurn`
  gates the audience **fail-closed**: any non-ward voice sets a
  stranger/villager-present audience BEFORE anything that could throw, so a guest's
  turn can never read ward-private context. A matched villager carries their
  id+name (their real circle resolves via `/api/chat`); a guest is `someone`. The
  stored transcript labels the diarized speaker. Push-to-talk is untouched (§8.2
  watchdog owns it). Off-switch `PROTO_FAMILIAR_VOICE_DIARIZE_DISABLED=1`.
- **`voice-audio-tags.js` + `voice-tagging.js`** (§8.4) — room-sound tagging,
  **annotation-only** this milestone. `voice-audio-tags.js` is the pure classifier:
  it DROPS human-vocalisation labels (speech, shouting, crying, laughter — the
  care-detection territory §8.4 defers to its own ward-signed spec) and bare
  acoustic-environment labels, keeps salient non-human sounds above a confidence
  floor, and phrases them into one "[I can hear … in the room]" line.
  `voice-tagging.js` is the plumbing: `createTagSegment` (the engine seam — loads
  the tagging model on the worker, runs the `tag` op, returns RAW AudioSet events)
  and `createRoomListener` (per-call dedup → one-off note). The engine's
  `tagSegment` seam runs on each finalized utterance (independent of speaker ID —
  different model); both call servers inject the classified line as a **one-off
  system note, never stored, never touching the threat tier**. Inert until the
  ward's `voiceAudioTaggingEnabled` (default OFF) AND the model is installed.
  Off-switch `PROTO_FAMILIAR_AUDIO_TAGGING_DISABLED=1`.
- **Worker op** (`audio-worker.mjs`): `role:'speaker'` loads the
  `SpeakerEmbeddingExtractor` (sherpa `BASE_MODELS` id `speaker-embed`, unpinned
  until `pin-audio-models.mjs speaker-embed <url>` records its sha); the `embed`
  op turns a wav OR raw VAD samples into a number[] voiceprint. `role:'tagging'`
  loads the zipformer AudioSet `AudioTagging` model (id `tagging-audioset`, pinned
  via `pin-audio-models.mjs tagging-audioset --upstream`); the `tag` op turns a wav
  OR raw samples into AudioSet events. Both: too-short/absent → honest
  `not-ready`/`not-loaded`, never a fabricated result.

Shipped alongside:

- **Voice-escalation factor** (§10, ward-signed §16.4) — `contactDeadlineFor`
  shortens the trusted-contact clock (×`voiceEscalationFactor`, default 0.5,
  clamped [0.25, 1]) ONLY when a triage check-in was confirmed spoken into a live
  call with the ward present (`delivery['voice-call'].{status:'delivered',
  wardPresent:true}`). Tightens toward action only.
- **Media-retention loop** — see the Autonomous-loops table (13th worker).
- **Proactive voice → Discord (§7, `voice-discord-server.js`)** — the Discord half
  of the web `voice-call` push adapter, registered under the SAME `voice-call`
  name so a check-in spoken here earns the §10 escalation factor identically.
  Two paths: (1) a live Discord call → speak the item into it; (2) no call +
  `voiceProactiveJoin` (default OFF, ward toggle) + my human sitting in a VC →
  transient join → speak → leave. BOTH gated on `wardVoiceState().wardAlone` —
  a private check-in is never spoken where a villager/stranger (or any
  unidentified member — fail-closed) can hear; when it can't be spoken privately
  the adapter declines and the item still lands via the private channels
  (webhook / bot-DM). The two `voice-call` factories never both deliver: at most
  one voice connection is live (the shared call-state lock), and the proactive-join
  branch stands down whenever any call is active (`isCallActiveFromFileSync` +
  a delivery-time re-check), so the single delivery record is never overwritten.
  `findWardVoiceChannel` (discord-gateway) locates my human's VC across guilds.
  Off-switch: the whole feature rides `PROTO_FAMILIAR_DISCORD_VOICE_DISABLED=1`.

**Pass 4 complete.** Shipped: enrolment endpoints + UI; the guest watchdog +
diarizer integration into the call engine (§8.2/§8.3); the web AND Discord
`voice-call` push adapters (proactive voice + §7 Discord proactive-join);
ward-voice threat scoring (§10, ward-signed §16.1); the speaker-model pin/download
(`voice-pin.js` + the in-UI downloader); and room-sound tagging (§8.4,
annotation-only). The audio-tagging model still needs its live pin
(`pin-audio-models.mjs tagging-audioset --upstream`), the same last step as the
speaker models. The long-term care-detection ambition on top of §8.4 is a
separate, ward-signed spec and deliberately NOT built here.

## Security design

- **API key handling:** key travels browser → `localhost` only. Server
  uses it once per request and discards. Browser persists in
  `localStorage`; don't use on shared / untrusted devices.
- **Path traversal:** all file-backed endpoints validate IDs against
  strict UUID regex before constructing paths. Covers session logs,
  Tome IDs, Tome entry UIDs.
- **Rate limiting:** `POST /api/chat` is per-IP, 20/min, in-memory.
- **Prompt inspector + temporal editor + threat surface:** unauthenticated.
  Intended for localhost. Disable / firewall before any non-loopback
  deployment.
- **MCP child processes:** Phylactery + Unruh run as local stdio children
  (Python via uv), reading/writing only their own `data/` dirs. No network
  listener of their own; reachable only through thalamus over stdio.
- **Input size:** `express.json` capped at 4MB; per-field memory + identity
  writes capped at 8KB.
- **Tailscale gate:** server binds `0.0.0.0` but rejects non-loopback
  with `403` until the in-UI Tailscale toggle is on. Toggle endpoint
  is itself unauthenticated — leave off unless you trust the network.
- **Trusted-contact outreach (M12c):** Discord webhook only. Every
  outbound is duplicated into the user's chat outbox (`kind:
  'outbound_alert'`) so there is no covert contact. Hallucinated
  contact names are server-side rejected. Empty contacts list = no
  outreach possible. See
  [docs/threat-detection.md](threat-detection.md).
- **No telemetry:** no data leaves localhost except the proxied LLM
  request to the user-configured provider.

## Related docs

- [`CLAUDE.md`](../CLAUDE.md) — agent guide, philosophy, robust-over-cheap,
  proactivity-is-desired, entity-as-subject conventions.
- [`docs/threat-detection.md`](threat-detection.md) — the caring spine
  in detail, off-switches, every signal pattern.
- [`docs/caring-spine-build-plan.md`](caring-spine-build-plan.md) — the
  per-step build path that landed the spine.
- [`docs/cerebellum-design.md`](cerebellum-design.md) — the motor
  module's design rationale: the efferent symmetry, the thalamus
  boundary, tool dispatch, channel adapters, the escalation veto
  window.
- [`docs/unruh-design.md`](unruh-design.md) — temporal-context module.
- [`docs/phylactery-design.md`](phylactery-design.md) — canonical self-store
  design rationale (original design by Zari Lewis / Psycheros).
- [`docs/phylactery-build-spec.md`](phylactery-build-spec.md) — imperative
  build instruction for the Phylactery milestone (A→B→G→…).
- [`docs/research/`](research/) — research notes that feed future
  design decisions (task-handling obstacles, etc.).
