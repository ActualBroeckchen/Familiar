/**
 * weather-source.js — the fetch half (Weather sense, Session W-A).
 *
 * The only place that talks to the network for weather. Two jobs:
 *   - geocode(query): one-time city/ZIP → {lat, lon, place_name, timezone}
 *     at location-entry time (Open-Meteo's keyless geocoding API).
 *   - fetchForecast(lat, lon): the 6-hourly refresh, trying the provider chain
 *     (Open-Meteo → MET Norway) until one returns, normalised to the internal
 *     shape with a local-naive fetched_at stamp.
 *
 * Unruh never fetches (the gcal precedent). fetchFn/now are injected so tests
 * exercise the fallback and normalisation without a network. A total failure
 * returns { ok: false } — the caller keeps the stale cache and the [Now] line
 * simply drops (absence renders as absence).
 */

import { PROVIDER_CHAIN } from './weather-providers.js';

const GEOCODE_TIMEOUT_MS = 8000;

// Local-naive ISO for a location's own zone (the stamp weather_cache stores;
// keeps the honesty clock in the same frame as the forecast's hourly times).
function localNaiveNow(timezone, now = Date.now()) {
  const d = new Date(now);
  if (!timezone) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
    return `${f.year}-${f.month}-${f.day}T${f.hour}:${f.minute}:${f.second}`;
  } catch {
    return localNaiveNow(null, now);
  }
}

/**
 * Geocode a city/ZIP to coordinates (Open-Meteo geocoding, keyless). Returns
 * { ok, lat, lon, place_name, timezone } or { ok: false, error }. The place_name
 * is the geocoder's resolved label — shown to the ward for confirmation, never
 * to the model.
 */
export async function geocode(query, { fetchFn = globalThis.fetch, now = Date.now } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return { ok: false, error: 'empty query' };
  const url = 'https://geocoding-api.open-meteo.com/v1/search'
    + `?name=${encodeURIComponent(q)}&count=1&language=en&format=json`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const resp = await fetchFn(url, { signal: ac.signal });
    if (!resp.ok) return { ok: false, error: `geocode HTTP ${resp.status}` };
    const d = await resp.json();
    const r = Array.isArray(d?.results) ? d.results[0] : null;
    if (!r || !Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) {
      return { ok: false, error: 'no match' };
    }
    const place = [r.name, r.admin1, r.country].filter(Boolean).join(', ');
    return {
      ok: true,
      lat: r.latitude, lon: r.longitude,
      place_name: place || r.name || q,
      timezone: r.timezone || null,
    };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'geocode timeout' : (err?.message ?? String(err)) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a forecast for coordinates, trying the provider chain in order until
 * one returns a usable result. Returns { ok, provider, fetched_at, current,
 * hourly } or { ok: false, error }. `chain` is injectable for tests.
 */
export async function fetchForecast(lat, lon, {
  fetchFn = globalThis.fetch,
  timezone = null,
  now = Date.now,
  days = undefined,
  chain = PROVIDER_CHAIN,
} = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false, error: 'bad coordinates' };
  const errors = [];
  for (const provider of chain) {
    try {
      const res = await provider.fetch(lat, lon, { fetchFn, timezone, days });
      if (res && res.current && Array.isArray(res.hourly) && res.hourly.length) {
        return {
          ok: true,
          provider: res.provider ?? provider.name,
          fetched_at: localNaiveNow(timezone, now()),
          current: res.current,
          hourly: res.hourly,
        };
      }
      errors.push(`${provider.name}: empty`);
    } catch (err) {
      errors.push(`${provider.name}: ${err?.message ?? err}`);
    }
  }
  return { ok: false, error: errors.join('; ') || 'all providers failed' };
}
