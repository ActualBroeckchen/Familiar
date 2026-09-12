---
title: Weather
topics: [architecture, weather]
sources:
  - id: weather-build-spec
    type: file
    path: docs/weather-build-spec.md
  - id: weather-source
    type: file
    path: src/weather/weather-source.js
  - id: weather-providers
    type: file
    path: src/weather/weather-providers.js
  - id: weather-format
    type: file
    path: src/weather/weather-format.js
  - id: weather-mirror
    type: file
    path: src/weather/weather-mirror.js
  - id: unruh-location
    type: file
    path: unruh/src/unruh/location.py
  - id: unruh-migration
    type: file
    path: unruh/src/unruh/migrations/0006_locations.sql
  - id: weather-service
    type: file
    path: src/weather/weather-service.js
  - id: event-alerts
    type: file
    path: src/schedule/event-alerts.js
---

# Weather

Weather sense shipped in Session W-A (0.8.76-alpha) as the first ward-private tier of the Familiar's **weather sense** [@weather-build-spec]. The Familiar now learns the weather where its human is and feels it in the `[Now]` block — entirely in code, with no new LLM call and no new background loop. The subsystem enforces a load-bearing invariant: **locations never reach the LLM** [@weather-build-spec].

## The invariant: locations stay local

A city or ZIP is geocoded exactly once at entry (via `weather-source.js geocode`), and only coordinates go to the weather API thereafter [@weather-build-spec]. The model reads a code-built qualitative line ("6°C (cold), light rain, easing off around 17:00") and the ward's own label ("home", "work") — never *where* a place is [@weather-build-spec].

Structural enforcement lives in [Unruh](unruh): `location_public` returns `{id, label, is_current}` only [@weather-build-spec]. The coordinate-bearing shapes — `location_private` and `weather_locations_private` — are called by Node code only and are never bound as model tools [@weather-build-spec]. Coordinates are data for the fetch, not knowledge for the entity. This boundary is structural, not procedural, so no future change can accidentally leak coordinates to the model.

## Why it rides existing requests instead of adding a loop

Per "ride existing requests, gate in code" (a pattern established elsewhere in the system): weather refresh is a self-gated fire-and-forget (`refreshWeatherIfDue`) hung on the 30-second reminders tick — no-op unless enabled and the current location's cache is older than 6 hours, guarded against overlap [@weather-build-spec]. It also runs at boot and is forced on a location add/switch/delete. There is no weather loop and no weather LLM call; the whole subsystem is pure code, and the model only ever *reads* the output [@weather-build-spec].

## Two inherited operating rules

Weather applies two invariants borrowed from [Exact Values Are Code's Job](../decisions/exact-values-in-code):

- **Exact-machine-values rule:** the model never types a weather value [@weather-build-spec]. `weather-format.js` turns machine numbers into words and bands; the model repeats the code-built line.
- **Honesty rule:** a forecast older than `WEATHER_STALE_MS` (12 hours) yields an empty line — the `[Now]` weather line *drops* rather than assert a stale reading [@weather-build-spec]. Missing or garbage fields do the same. Failure renders as absence, never as a wrong claim and never as a throw into the chat path (the graceful-degradation rule).

## Where weather appears

Weather appears only on four **ward-facing** `[Now]` call sites: triage, warmth, noticing, and ward-private web chat [@weather-build-spec]. Villager/Discord surfaces never receive it — the Discord gateway doesn't use `buildTimeAnchorBlock` at all, so the coordinate-free line structurally cannot reach a villager [@weather-build-spec]. The vague/gated tier for shared surfaces is deferred to Session W-B.

## Module map (W-A)

- `weather-source.js` — geocode (once) + fetchForecast (provider chain, local-naive stamp); Node owns the network (the gcal precedent); failure → `{ok:false}`, stale cache kept [@weather-source].
- `weather-providers.js` — Open-Meteo primary + MET Norway fallback, normalized to one internal shape [@weather-providers].
- `weather-format.js` — WMO words, qualitative bands, precip transition, the `[Now]` line, the honesty rule [@weather-format].
- `weather-mirror.js` — sync read-mirror (`last-activity.js` precedent) so the hot `[Now]` path reads without an async MCP round-trip; the single `readWeatherNowLine` call `buildTimeAnchorBlock` makes; honours `PROTO_FAMILIAR_WEATHER_DISABLED=1` [@weather-mirror].
- Unruh `location.py` + migration `0006_locations.sql` — the `locations` + `weather_cache` store; times inside cached JSON are local-naive (same frame as the forecast's hourly times) [@unruh-location] [@unruh-migration].

## W-B — the day at will, preparation, and the vague tier

Session W-B (0.8.77-alpha) built the second tier on W-A's foundation: the
Familiar can look at the day ahead, weave the sky into how it prepares its
human for going out, and speak weather safely on shared surfaces. Still pure
code end to end — the model reads code-built words, never computes a value or
sees a coordinate [@weather-build-spec].

**Two ward-only tools.** `weather_today` returns the today+tomorrow arc
(morning/afternoon/evening + notable turns) for the current place or another
saved label; `set_current_location` moves the current place. Both are gated by
`weatherEnabled` and surfaced by a new `weather` tool-surfacing module on
leaving-the-house language and the readiness/projection blocks. On a gated
(non-ward) turn `weather_today` falls closed to the vague tier.

**The get-or-fetch seam** [@weather-service]. `weather-service.js` resolves a
location by ward label or current (from the Node-only private shape) and
returns a forecast cache-first, fetching on demand only when the cache is
absent, stale, or doesn't reach a needed date (Open-Meteo serves 16 days; the
outside-join uses this for far dates). Coordinates live here and never leave
toward the model.

**Preparation hookups.** The readiness note reads the `[Now]` mirror
synchronously and, for an outside-tagged item whose hour looks adverse,
appends a code-built weather clause — no fetch. `weather_today` also joins the
noticing toolset (read-only; deliberately NOT a wake condition — weather only
flavours a turn already happening) and the projection cue's prose (a reminder
to weigh the sky against an appointment's lead time).

**The severe-weather heads-up** [@event-alerts]. `selectDueWeatherAlerts`
gives an outside-tagged item whose occurrence-hour turns adverse in the CACHED
forecast a `weather_alert` outbox ping. It rides the SAME 30s window scan as
the coming-up alert (a per-tick memo shares one schedule fetch between the two
passes) through a SHARED enqueue-then-mark helper, but into a SEPARATE dedup
channel (`weather_alerts` / `kind="weather"`) so a coming-up ping and a weather
ping for one occurrence never suppress each other. Weather alone — with no
outside item affected — never pings: this is a preparation surface, not a
weather report.

## The vague tier — weather on gated audiences

Precise values and units are a soft geolocation ("x°C, so metric, so…"), so on
any non-ward-private surface the weather renders qualitatively only — bands and
verbs, no numbers, no units, no times, no labels ("It's cold and rainy out")
[@weather-build-spec]. `formatWeatherVague` is the one gate, applied
fail-closed: an unclear audience gets vague-or-nothing, and vague itself yields
'' when the forecast is stale. The gated `[Now]` turn renders
`readWeatherVagueLine`; ward-private keeps the full code-formatted detail.

## Off-switch and testing

Off-switch: `weatherEnabled` (default ON) + `PROTO_FAMILIAR_WEATHER_DISABLED=1` [@weather-build-spec]. The shared gate `weatherEnabled(settings)` lives in `weather-mirror.js` so cerebellum, thalamus, and server all read it identically. Full suites green after W-B: 1385 Node, 294 Python [@weather-build-spec]. Shipped via PR #190 (W-A + W-B on one branch).
