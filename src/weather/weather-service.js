/**
 * weather-service.js — get-or-fetch orchestration (Weather sense, Session W-B).
 *
 * The single Node-side seam that turns "I want the weather for this place /
 * this day" into a normalised forecast, fetching on demand only when the cache
 * can't answer. Backs the `weather_today` tool and the outside-join (an
 * outside-tagged schedule item carrying its occurrence-time forecast).
 *
 * PRIVACY (the load-bearing constraint, spec §1): coordinates live here and in
 * the fetch half — they are read from the Node-only `weather_locations_private`
 * shape and passed to the provider, and they NEVER appear in anything returned
 * toward the model. Callers get code-formatted words + the ward's own label.
 */

import { weatherLocationsPrivate, readWeather, ingestWeather } from '../../thalamus.js';
import { fetchForecast } from './weather-source.js';
import { wardLocalNowISO } from '../../relative-time.js';
import { WEATHER_STALE_MS } from './weather-format.js';

const DAY_MS = 24 * 60 * 60_000;

/** Local (location-frame) today/tomorrow YYYY-MM-DD for grouping the arc. */
export function dayDatesFor(timezone, now = Date.now()) {
  const today = wardLocalNowISO(timezone, now).slice(0, 10);
  const tomorrow = wardLocalNowISO(timezone, now + DAY_MS).slice(0, 10);
  return { todayDate: today, tomorrowDate: tomorrow };
}

/**
 * Resolve a location WITH coordinates (Node-only). `label` matches the ward's
 * chosen label case-insensitively; omitted → the current location. Returns the
 * private row ({ id, label, lat, lon, timezone, is_current, fetched_at }) or
 * null. The coordinates on this row must never be handed to the model.
 */
export async function resolveLocation({ label = null } = {}) {
  const res = await weatherLocationsPrivate();
  const locs = Array.isArray(res?.locations) ? res.locations : [];
  if (!locs.length) return null;
  if (label != null && String(label).trim()) {
    const q = String(label).trim().toLowerCase();
    return locs.find(l => String(l.label ?? '').toLowerCase() === q) || null;
  }
  return locs.find(l => l.is_current) || null;
}

/** How many forecast-days to request to reach a needed date (with a buffer). */
function daysToReach(needDate, todayDate) {
  const gap = (Date.parse(needDate) - Date.parse(todayDate)) / DAY_MS;
  return Number.isFinite(gap) ? Math.max(3, Math.ceil(gap) + 2) : 3;
}

/**
 * Get a forecast for a resolved location, fetching on demand when the cache is
 * absent, stale, or doesn't cover a needed date. On a fetch it ingests the
 * result so the cache warms for next time. A total fetch failure degrades to
 * the stale cache when one exists (a read prefers old data to nothing), else
 * { ok:false }. Returns { ok, forecast, stale?, location } — forecast is the
 * normalised { provider, fetched_at, current, hourly }.
 */
export async function getForecast(loc, {
  now = Date.now(), maxAgeMs = WEATHER_STALE_MS, needDate = null,
  refetch = false, fetchFn,
} = {}) {
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return { ok: false };

  let cached = null;
  try { cached = (await readWeather({ location_id: loc.id }))?.weather || null; } catch { /* best-effort */ }
  const fresh = cached?.fetched_at && (now - Date.parse(cached.fetched_at)) <= maxAgeMs;
  const coversDate = !needDate
    || (Array.isArray(cached?.hourly) && cached.hourly.some(h => String(h.time).startsWith(needDate)));
  if (!refetch && fresh && coversDate) return { ok: true, forecast: cached, location: loc };

  const { todayDate } = dayDatesFor(loc.timezone, now);
  const days = needDate ? daysToReach(needDate, todayDate) : undefined;
  const fc = await fetchForecast(loc.lat, loc.lon, { timezone: loc.timezone, days, fetchFn });
  if (!fc.ok) {
    if (cached?.current) return { ok: true, forecast: cached, stale: true, location: loc };
    return { ok: false };
  }
  try {
    await ingestWeather({
      location_id: loc.id, provider: fc.provider,
      fetched_at: fc.fetched_at, current: fc.current, hourly: fc.hourly,
    });
  } catch { /* cache warm is best-effort; the read still succeeds */ }
  return { ok: true, forecast: fc, location: loc };
}
