/**
 * weather-format.js — code speaks the weather (Weather sense, Session W-A).
 *
 * Pure formatters. Every value the model reads about weather is turned into
 * words HERE — temperatures, precipitation, wind all carry a code-derived
 * qualitative band ("6°C (cold)", "light rain"), and the times ("easing off
 * around 17:00") are read off the forecast's own hourly array, never computed
 * by the model. This is the exact-machine-values rule applied to weather; the
 * plainInterval precedent is the shape.
 *
 * Internal forecast shape (what the fetch half normalises everything to):
 *   current: { temp_c, weather_code, precip_mm, wind_kmh }
 *   hourly:  [ { time: local-naive ISO, temp_c, weather_code, precip_mm,
 *               precip_prob, wind_kmh } ]  (next ~48h, ascending)
 * WMO weather codes throughout (Open-Meteo native; the MET-Norway adapter
 * maps its symbol_codes onto these).
 */

// How stale a cached forecast may be before it stops speaking as "now"
// (honesty rule — the baselines precedent: no data beats wrong data).
export const WEATHER_STALE_MS = 12 * 60 * 60_000;   // 12h
// How far ahead a precipitation-transition phrase may reach.
const TRANSITION_LOOKAHEAD_MS = 12 * 60 * 60_000;

// ── WMO weather codes → words ────────────────────────────────────────
const WMO = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'heavy showers',
  85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail',
};
export function wmoToWords(code) {
  return WMO[code] ?? (Number.isFinite(code) ? 'unsettled' : '');
}
// Precipitation-bearing codes (drizzle and up; fog excluded — it isn't precip).
export function isPrecipCode(code) {
  return (code >= 51 && code <= 67) || (code >= 71 && code <= 86) || (code >= 95 && code <= 99);
}
// Codes we call genuinely adverse (for the W-B severe-weather join; defined
// here with the rest of the code vocabulary): heavy rain, freezing rain, any
// snow, heavy showers, thunderstorms.
const ADVERSE_CODES = new Set([65, 66, 67, 71, 73, 75, 77, 82, 85, 86, 95, 96, 99]);
export function isAdverseCode(code) {
  return ADVERSE_CODES.has(code);
}

// ── Qualitative bands (fixed, code-owned) ────────────────────────────
export function tempBand(c) {
  if (!Number.isFinite(c)) return '';
  if (c < 0)  return 'freezing';
  if (c < 10) return 'cold';
  if (c < 18) return 'mild';
  if (c < 26) return 'warm';
  if (c <= 32) return 'hot';
  return 'very hot';
}
export function precipBand(mmPerH) {
  if (!Number.isFinite(mmPerH) || mmPerH <= 0) return 'none';
  if (mmPerH < 2.5) return 'light';
  if (mmPerH < 7.6) return 'moderate';
  return 'heavy';
}
export function windBand(kmh) {
  if (!Number.isFinite(kmh)) return '';
  if (kmh < 12) return 'calm';
  if (kmh < 29) return 'breezy';
  if (kmh < 50) return 'windy';
  if (kmh < 75) return 'strong wind';
  return 'gale';
}

// ── Value renderers (value + band, machine-formatted) ────────────────
// `unit` is 'celsius' (default) or 'fahrenheit' — the ward's display choice
// (settings.weatherUnit). The model never converts; code does it here, once,
// at the render boundary. The BAND stays computed from Celsius internally
// (tempBand takes `c` unconverted) so a display-unit switch can never shift
// a "cold"/"mild" read — only the printed number and its unit symbol change.
export function formatTemp(c, unit = 'celsius') {
  if (!Number.isFinite(c)) return '';
  const band = tempBand(c);
  const value = unit === 'fahrenheit' ? Math.round(c * 9 / 5 + 32) : Math.round(c);
  const symbol = unit === 'fahrenheit' ? '°F' : '°C';
  return `${value}${symbol}${band ? ` (${band})` : ''}`;
}

function hhmm(iso) {
  const m = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/.exec(String(iso) || '');
  return m ? `${m[1]}:${m[2]}` : '';
}

// ── Precipitation transition (read off the hourly array) ─────────────
/**
 * Given the hourly forecast and "now", find the next change in whether it's
 * raining/snowing. Returns { kind: 'easing'|'starting'|'none', at: 'HH:MM' }.
 * Pure — `now` is passed in. A wet-now forecast reports when it eases; a
 * dry-now forecast reports when precip is likely to start; capped to the
 * look-ahead so we never say "easing off" 30h out.
 */
export function precipTransition(current, hourly, now = Date.now()) {
  const arr = Array.isArray(hourly) ? hourly : [];
  const wetNow = (Number(current?.precip_mm) > 0) || isPrecipCode(current?.weather_code);
  const limit = now + TRANSITION_LOOKAHEAD_MS;
  const future = arr
    .map(h => ({ ...h, ms: Date.parse(h?.time) }))
    .filter(h => Number.isFinite(h.ms) && h.ms > now && h.ms <= limit)
    .sort((a, b) => a.ms - b.ms);
  const isWet = (h) => (Number(h.precip_mm) > 0) || isPrecipCode(h.weather_code);
  for (const h of future) {
    if (wetNow && !isWet(h)) return { kind: 'easing', at: hhmm(h.time) };
    if (!wetNow && isWet(h)) return { kind: 'starting', at: hhmm(h.time) };
  }
  return { kind: 'none', at: '' };
}

// ── The [Now] weather line ───────────────────────────────────────────
/**
 * The single line the [Now] block carries: "Weather where my human is: 6°C
 * (cold), light rain, easing off around 17:00." Returns '' when there's no
 * usable/fresh forecast (absence renders as absence). `mirror` is the
 * read-mirror shape { fetched_at, current, hourly }.
 */
export function buildNowWeatherLine(mirror, { now = Date.now(), unit = 'celsius' } = {}) {
  if (!mirror || typeof mirror !== 'object') return '';
  const fetchedMs = Date.parse(mirror.fetched_at);
  if (!Number.isFinite(fetchedMs) || (now - fetchedMs) > WEATHER_STALE_MS) return '';
  const cur = mirror.current;
  if (!cur || !Number.isFinite(Number(cur.temp_c))) return '';

  const parts = [];
  parts.push(formatTemp(Number(cur.temp_c), unit));
  const words = wmoToWords(cur.weather_code);
  if (words) parts.push(words);
  const wb = windBand(Number(cur.wind_kmh));
  if (wb === 'strong wind' || wb === 'gale') parts.push(wb);

  const tr = precipTransition(cur, mirror.hourly, now);
  let tail = '';
  if (tr.kind === 'easing' && tr.at)   tail = `, easing off around ${tr.at}`;
  else if (tr.kind === 'starting' && tr.at) tail = `, rain likely from around ${tr.at}`;

  return `Weather where my human is: ${parts.join(', ')}${tail}.`;
}

// ── The vague tier — gated audiences (W-B, §5.6) ─────────────────────
/**
 * On a non-ward-private surface, precise values + units are a soft
 * geolocation ("x°C, so metric, so…"). This renders the SAME cached forecast
 * qualitatively only — bands and verbs, no numbers, no units, no times, no
 * location phrasing. "It's cold and rainy out." Returns '' on missing/stale
 * data (the honesty rule still applies) so the gate fails closed to nothing.
 */
export function formatWeatherVague(mirror, { now = Date.now() } = {}) {
  if (!mirror || typeof mirror !== 'object') return '';
  const fetchedMs = Date.parse(mirror.fetched_at);
  if (!Number.isFinite(fetchedMs) || (now - fetchedMs) > WEATHER_STALE_MS) return '';
  const cur = mirror.current;
  if (!cur || !Number.isFinite(Number(cur.temp_c))) return '';

  const t = tempBand(Number(cur.temp_c));           // freezing|cold|mild|warm|hot|very hot
  const wetNow = (Number(cur.precip_mm) > 0) || isPrecipCode(cur.weather_code);
  const snow = cur.weather_code >= 71 && cur.weather_code <= 86 && cur.weather_code !== 80
    && cur.weather_code !== 81 && cur.weather_code !== 82;
  const windy = ['strong wind', 'gale'].includes(windBand(Number(cur.wind_kmh)));

  const feel = t === 'very hot' ? 'sweltering'
    : t === 'hot' ? 'hot'
    : t === 'warm' ? 'warm'
    : t === 'mild' ? 'mild'
    : t === 'cold' ? 'cold'
    : t === 'freezing' ? 'freezing'
    : '';

  const bits = [];
  if (feel) bits.push(feel);
  if (wetNow) bits.push(snow ? 'snowy' : 'rainy');
  else if (windy) bits.push('windy');

  if (!bits.length) return '';
  const phrase = bits.length === 1 ? bits[0] : `${bits.slice(0, -1).join(', ')} and ${bits[bits.length - 1]}`;
  return `It's ${phrase} out where my human is.`;
}

// ── Per-hour lookup + the outside-join (W-B, §5.2b / §5.4) ────────────
/**
 * The forecast hour nearest a target instant, within tolerance. Returns the
 * hourly entry ({ time, temp_c, weather_code, precip_mm, precip_prob,
 * wind_kmh }) or null when nothing in the array lands close enough. Pure —
 * both `hourly` times and `targetMs` are compared in the same (local-naive)
 * frame the caller supplies.
 */
export function forecastAtHour(hourly, targetMs, { toleranceMs = 90 * 60_000 } = {}) {
  const arr = Array.isArray(hourly) ? hourly : [];
  if (!Number.isFinite(targetMs)) return null;
  let best = null, bestGap = Infinity;
  for (const h of arr) {
    const ms = Date.parse(h?.time);
    if (!Number.isFinite(ms)) continue;
    const gap = Math.abs(ms - targetMs);
    if (gap < bestGap) { best = h; bestGap = gap; }
  }
  return best && bestGap <= toleranceMs ? best : null;
}

// Thresholds for "genuinely worth flagging" at a specific hour (pure code —
// §5.4). Adverse code, a likely-and-wet hour, a temperature extreme, or
// strong+ wind. Used to gate the readiness weather note and the severe-alert.
const HEAT_EXTREME_C = 33;
const COLD_EXTREME_C = -5;
const LIKELY_PRECIP_PROB = 60;
export function isAdverseHour(hour) {
  if (!hour || typeof hour !== 'object') return false;
  const code = Number(hour.weather_code);
  if (isAdverseCode(code)) return true;
  const prob = Number(hour.precip_prob);
  const wet = (Number(hour.precip_mm) > 0) || isPrecipCode(code);
  if (wet && Number.isFinite(prob) && prob >= LIKELY_PRECIP_PROB) return true;
  const t = Number(hour.temp_c);
  if (Number.isFinite(t) && (t >= HEAT_EXTREME_C || t <= COLD_EXTREME_C)) return true;
  const wb = windBand(Number(hour.wind_kmh));
  return wb === 'strong wind' || wb === 'gale';
}

/**
 * A compact code-built weather clause for a single schedule item's hour —
 * the outside-join. Always returns a usable clause (the model reads it, never
 * computes it): the adverse factor when there is one ("heavy rain likely then,
 * ~6°C"), otherwise a benign brief ("clear then, ~14°C (mild)"). Returns ''
 * only when the hour has no usable temperature.
 */
export function formatItemWeather(hour, unit = 'celsius') {
  if (!hour || typeof hour !== 'object') return '';
  const t = Number(hour.temp_c);
  if (!Number.isFinite(t)) return '';
  const tempStr = formatTemp(t, unit);
  const code = Number(hour.weather_code);
  const wet = (Number(hour.precip_mm) > 0) || isPrecipCode(code);
  const wb = windBand(Number(hour.wind_kmh));

  let lead;
  if (isAdverseCode(code)) lead = `${wmoToWords(code)} likely then`;
  else if (wet) lead = `${wmoToWords(code) || 'rain'} likely then`;
  else if (t >= HEAT_EXTREME_C) lead = 'very hot then';
  else if (t <= COLD_EXTREME_C) lead = 'bitterly cold then';
  else if (wb === 'strong wind' || wb === 'gale') lead = `${wb} then`;
  else lead = `${wmoToWords(code) || 'settled'} then`;

  return `${lead}, ${tempStr}`;
}

// ── The day arc — weather_today (W-B, §5.2) ──────────────────────────
// Part-of-day windows (local hour, from the local-naive time strings — no tz
// math; the strings already carry the location's wall clock).
const PARTS = [
  { key: 'morning',   from: 6,  to: 11 },
  { key: 'afternoon', from: 12, to: 17 },
  { key: 'evening',   from: 18, to: 22 },
];
function hourOf(iso)  { const m = /T(\d{2}):/.exec(String(iso) || ''); return m ? Number(m[1]) : NaN; }
function dateOf(iso)  { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso) || ''); return m ? m[1] : ''; }
function modeCode(hours) {
  const counts = new Map();
  for (const h of hours) {
    const c = Number(h.weather_code);
    if (Number.isFinite(c)) counts.set(c, (counts.get(c) || 0) + 1);
  }
  let best = null, n = -1;
  for (const [c, k] of counts) if (k > n) { best = c; n = k; }
  return best;
}
// One part's phrase: "light rain, 7–9°C (mild)" / "overcast, 4–6°C (cold)".
// The band is read off the (unconverted) Celsius high; only the printed
// number(s) and unit symbol follow `unit`.
function describePart(hours, unit = 'celsius') {
  const hs = hours.filter(h => h && typeof h === 'object');
  if (!hs.length) return '';
  const temps = hs.map(h => Number(h.temp_c)).filter(Number.isFinite);
  let tempStr = '';
  if (temps.length) {
    const loC = Math.min(...temps), hiC = Math.max(...temps);
    const band = tempBand(hiC);
    const conv = c => unit === 'fahrenheit' ? Math.round(c * 9 / 5 + 32) : Math.round(c);
    const symbol = unit === 'fahrenheit' ? '°F' : '°C';
    const lo = conv(loC), hi = conv(hiC);
    tempStr = lo === hi ? `${hi}${symbol} (${band})` : `${lo}–${hi}${symbol} (${band})`;
  }
  const precipHours = hs.filter(h => (Number(h.precip_mm) > 0) || isPrecipCode(h.weather_code));
  let condition;
  if (precipHours.length) {
    const worst = precipHours.reduce((a, b) => (Number(b.precip_mm) || 0) > (Number(a.precip_mm) || 0) ? b : a);
    condition = wmoToWords(worst.weather_code) || 'rain';
  } else {
    condition = wmoToWords(modeCode(hs)) || '';
  }
  return [condition, tempStr].filter(Boolean).join(', ');
}
// Up to a couple of notable turns for the day (rain start/stop, strong wind).
function notableForDay(dayHours) {
  const hs = dayHours.slice().sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const notes = [];
  let wasWet = null;
  for (const h of hs) {
    const wet = (Number(h.precip_mm) > 0) || isPrecipCode(h.weather_code);
    if (wasWet === false && wet) notes.push(`rain from ~${hhmm(h.time)}`);
    if (wasWet === true && !wet) notes.push(`easing ~${hhmm(h.time)}`);
    wasWet = wet;
  }
  const firstStrong = hs.find(h => ['strong wind', 'gale'].includes(windBand(Number(h.wind_kmh))));
  if (firstStrong) notes.push(`strong wind around ~${hhmm(firstStrong.time)}`);
  return notes.slice(0, 3);
}
function describeDay(label, dayHours, unit = 'celsius') {
  if (!dayHours.length) return '';
  const partStrs = [];
  for (const p of PARTS) {
    const hrs = dayHours.filter(h => { const hr = hourOf(h.time); return hr >= p.from && hr <= p.to; });
    const d = describePart(hrs, unit);
    if (d) partStrs.push(`${p.key}: ${d}`);
  }
  if (!partStrs.length) return '';
  const notes = notableForDay(dayHours);
  const tail = notes.length ? ` Notable: ${notes.join('; ')}.` : '';
  return `${label} — ${partStrs.join('; ')}.${tail}`;
}
/**
 * The day arc for the model: today + tomorrow, morning/afternoon/evening each,
 * with notable turns — all code-built from the forecast's own hourly array
 * (§5.2). `todayDate`/`tomorrowDate` are local (YYYY-MM-DD) the caller derives
 * from ward-local now; the hourly times are already local-naive, so grouping
 * needs no timezone math. Returns '' when the forecast can't cover the days
 * (absence renders as absence). `locationLabel` is the ward's own label (never
 * a place name/coords) and is included only on ward-private surfaces.
 */
export function weatherArc(forecast, { todayDate, tomorrowDate, locationLabel = '', unit = 'celsius' } = {}) {
  if (!forecast || typeof forecast !== 'object') return '';
  const hourly = Array.isArray(forecast.hourly) ? forecast.hourly : [];
  if (!hourly.length) return '';
  const today = hourly.filter(h => dateOf(h.time) === todayDate);
  const tomorrow = hourly.filter(h => dateOf(h.time) === tomorrowDate);
  const lines = [];
  const t1 = describeDay('Today', today, unit);
  const t2 = describeDay('Tomorrow', tomorrow, unit);
  if (t1) lines.push(t1);
  if (t2) lines.push(t2);
  if (!lines.length) return '';
  const where = locationLabel ? ` (${locationLabel})` : ' (where my human is)';
  return `The sky over my human's day${where}:\n${lines.join('\n')}`;
}
