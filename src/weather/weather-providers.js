/**
 * weather-providers.js — the fetch adapters behind one seam (Weather sense,
 * Session W-A). Mirrors websearch-providers.js: interchangeable backends that
 * each normalise their wire format to ONE internal shape, so the rest of the
 * system (cache, formatters, [Now] line) is provider-agnostic.
 *
 * Normalised shape (also documented in weather-format.js):
 *   { provider, current: {temp_c, weather_code, precip_mm, wind_kmh},
 *     hourly: [{time (local-naive ISO), temp_c, weather_code, precip_mm,
 *              precip_prob, wind_kmh}] }
 *
 * All network I/O lives here + weather-source.js — Unruh never fetches.
 * fetchFn is injected so tests drive the adapters without a network.
 *
 * Privacy: only coordinates are ever sent. No account, no key (Open-Meteo and
 * MET Norway are both keyless), so requests aren't tied to an identity.
 */

const FETCH_TIMEOUT_MS = 8000;
const DEFAULT_DAYS = 3;   // next ~72h covers [Now] + today/tomorrow
const MAX_DAYS = 16;      // Open-Meteo's ceiling; the outside-join reaches here on demand
// How many hourly rows to keep for a given horizon (24/day).
function keepFor(days) { return clampDays(days) * 24; }
function clampDays(days) {
  const n = Math.round(Number(days));
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_DAYS) : DEFAULT_DAYS;
}

async function getJson(url, { fetchFn = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS, headers = {} } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetchFn(url, { headers, signal: ac.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Open-Meteo (primary; keyless) ────────────────────────────────────
// timezone=auto → the API returns LOCAL-naive times for the coordinates, so
// no conversion is needed on this path.
export async function fetchOpenMeteo(lat, lon, { fetchFn, days = DEFAULT_DAYS } = {}) {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}`
    + '&current=temperature_2m,weather_code,precipitation,wind_speed_10m'
    + '&hourly=temperature_2m,weather_code,precipitation,precipitation_probability,wind_speed_10m'
    + `&forecast_days=${clampDays(days)}&timezone=auto&wind_speed_unit=kmh`;
  const d = await getJson(url, { fetchFn });
  const c = d?.current ?? {};
  const h = d?.hourly ?? {};
  const times = Array.isArray(h.time) ? h.time : [];
  const hourly = times.slice(0, keepFor(days)).map((t, i) => ({
    time: t,
    temp_c:      num(h.temperature_2m?.[i]),
    weather_code: num(h.weather_code?.[i]),
    precip_mm:   num(h.precipitation?.[i]),
    precip_prob: num(h.precipitation_probability?.[i]),
    wind_kmh:    num(h.wind_speed_10m?.[i]),
  }));
  return {
    provider: 'open-meteo',
    current: {
      temp_c:      num(c.temperature_2m),
      weather_code: num(c.weather_code),
      precip_mm:   num(c.precipitation),
      wind_kmh:    num(c.wind_speed_10m),
    },
    hourly,
  };
}

// ── MET Norway / Yr (fallback; keyless, needs an honest User-Agent) ──
// MET returns UTC times and symbol_codes; we map symbols → WMO codes and
// convert times to the location's local-naive using its IANA `timezone`.
const MET_UA = 'Proto-Familiar/1.0 weather-sense (open-source companion app)';
const SYMBOL_TO_WMO = [
  [/thunder/, 95], [/sleet/, 67], [/snow/, 73], [/heavyrain/, 65],
  [/lightrain|drizzle/, 61], [/rain/, 63], [/fog/, 45],
  [/cloudy/, 3], [/partlycloudy/, 2], [/fair/, 1], [/clearsky/, 0],
];
function symbolToWmo(symbol) {
  const s = String(symbol || '').toLowerCase();
  for (const [re, code] of SYMBOL_TO_WMO) if (re.test(s)) return code;
  return NaN;
}

export async function fetchMetNorway(lat, lon, { fetchFn, timezone = null, days = DEFAULT_DAYS } = {}) {
  const url = 'https://api.met.no/weatherapi/locationforecast/2.0/compact'
    + `?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
  const d = await getJson(url, { fetchFn, headers: { 'User-Agent': MET_UA } });
  const series = d?.properties?.timeseries;
  if (!Array.isArray(series) || !series.length) throw new Error('met: empty timeseries');

  const point = (entry) => {
    const inst = entry?.data?.instant?.details ?? {};
    const next1 = entry?.data?.next_1_hours ?? {};
    return {
      time: utcToLocalNaive(entry.time, timezone),
      temp_c:      num(inst.air_temperature),
      weather_code: symbolToWmo(next1?.summary?.symbol_code),
      precip_mm:   num(next1?.details?.precipitation_amount),
      precip_prob: num(next1?.details?.probability_of_precipitation),
      wind_kmh:    Number.isFinite(num(inst.wind_speed)) ? Math.round(num(inst.wind_speed) * 3.6) : NaN, // m/s → km/h
    };
  };
  const hourly = series.slice(0, keepFor(days)).map(point);
  const first = hourly[0] ?? {};
  return {
    provider: 'met-norway',
    current: {
      temp_c: first.temp_c, weather_code: first.weather_code,
      precip_mm: first.precip_mm, wind_kmh: first.wind_kmh,
    },
    hourly,
  };
}

// ── helpers ──────────────────────────────────────────────────────────
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : NaN; }

// Convert a UTC ISO instant to the location's LOCAL-naive wall-clock using its
// IANA zone (Intl, DST-correct — the wardLocalNowISO pattern). Falls back to
// the raw string (minus any 'Z') when no zone is known.
export function utcToLocalNaive(iso, timezone) {
  if (!iso) return iso;
  if (!timezone) return String(iso).replace(/Z$/, '');
  try {
    const d = new Date(iso);
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
    return `${f.year}-${f.month}-${f.day}T${f.hour}:${f.minute}:${f.second}`;
  } catch {
    return String(iso).replace(/Z$/, '');
  }
}

// Provider order (WARD-DECIDED: MET Norway ships as the automatic fallback).
export const PROVIDER_CHAIN = [
  { name: 'open-meteo', fetch: (lat, lon, opts) => fetchOpenMeteo(lat, lon, opts) },
  { name: 'met-norway', fetch: (lat, lon, opts) => fetchMetNorway(lat, lon, opts) },
];
