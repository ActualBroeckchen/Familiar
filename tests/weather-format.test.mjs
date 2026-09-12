// weather-format.js — pure formatters, bands, the [Now] line, the honesty rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  wmoToWords, isPrecipCode, isAdverseCode,
  tempBand, precipBand, windBand, formatTemp,
  precipTransition, buildNowWeatherLine, WEATHER_STALE_MS,
  formatWeatherVague, forecastAtHour, isAdverseHour, formatItemWeather, weatherArc,
} from '../src/weather/weather-format.js';

const T = (iso) => Date.parse(iso);

// ── code vocabulary ──────────────────────────────────────────────────

test('wmoToWords: known codes and fallback', () => {
  assert.equal(wmoToWords(0), 'clear');
  assert.equal(wmoToWords(61), 'light rain');
  assert.equal(wmoToWords(95), 'thunderstorm');
  assert.equal(wmoToWords(999), 'unsettled');
  assert.equal(wmoToWords(NaN), '');
});

test('isPrecipCode / isAdverseCode', () => {
  assert.equal(isPrecipCode(0), false);   // clear
  assert.equal(isPrecipCode(45), false);  // fog is not precip
  assert.equal(isPrecipCode(61), true);   // rain
  assert.equal(isPrecipCode(71), true);   // snow
  assert.equal(isAdverseCode(61), false); // light rain not adverse
  assert.equal(isAdverseCode(65), true);  // heavy rain
  assert.equal(isAdverseCode(73), true);  // snow
  assert.equal(isAdverseCode(95), true);  // storm
});

// ── bands ─────────────────────────────────────────────────────────────

test('tempBand thresholds', () => {
  assert.equal(tempBand(-3), 'freezing');
  assert.equal(tempBand(6), 'cold');
  assert.equal(tempBand(14), 'mild');
  assert.equal(tempBand(22), 'warm');
  assert.equal(tempBand(30), 'hot');
  assert.equal(tempBand(36), 'very hot');
});

test('precipBand / windBand', () => {
  assert.equal(precipBand(0), 'none');
  assert.equal(precipBand(1), 'light');
  assert.equal(precipBand(5), 'moderate');
  assert.equal(precipBand(10), 'heavy');
  assert.equal(windBand(5), 'calm');
  assert.equal(windBand(20), 'breezy');
  assert.equal(windBand(40), 'windy');
  assert.equal(windBand(60), 'strong wind');
  assert.equal(windBand(90), 'gale');
});

test('formatTemp: value + band, rounded', () => {
  assert.equal(formatTemp(6.4), '6°C (cold)');
  assert.equal(formatTemp(34), '34°C (very hot)');
  assert.equal(formatTemp(NaN), '');
});

// ── °C / °F toggle (weatherUnit) ──────────────────────────────────────
// The model never converts (exact-values rule) — formatTemp does the math.
// The band is computed from the unconverted Celsius value and must not
// shift when the display unit changes.

test('formatTemp: unit-aware conversion, sanity points', () => {
  assert.equal(formatTemp(0, 'fahrenheit'), '32°F (cold)');
  assert.equal(formatTemp(100, 'fahrenheit'), '212°F (very hot)');
  assert.equal(formatTemp(-40, 'celsius'), '-40°C (freezing)');
  assert.equal(formatTemp(-40, 'fahrenheit'), '-40°F (freezing)');
  assert.equal(formatTemp(6.4, 'fahrenheit'), '44°F (cold)');
  assert.equal(formatTemp(NaN, 'fahrenheit'), '');
});

test('formatTemp: defaults to celsius when unit omitted/unknown', () => {
  assert.equal(formatTemp(6.4), formatTemp(6.4, 'celsius'));
  assert.equal(formatTemp(6.4, 'bogus'), formatTemp(6.4, 'celsius'));
});

test('formatTemp: band is unchanged by unit — only the number/symbol move', () => {
  for (const c of [-10, -3, 6, 14, 22, 30, 36]) {
    const cBand = formatTemp(c, 'celsius').match(/\(([^)]+)\)/)?.[1];
    const fBand = formatTemp(c, 'fahrenheit').match(/\(([^)]+)\)/)?.[1];
    assert.equal(cBand, fBand, `band mismatch at ${c}°C`);
    assert.equal(cBand, tempBand(c));
  }
});

// ── precip transition (read off the hourly array) ────────────────────

const hourly = (specs) => specs.map(([time, precip_mm, code]) => ({
  time, precip_mm, weather_code: code ?? (precip_mm > 0 ? 61 : 0),
}));

test('precipTransition: wet now → reports when it eases', () => {
  const now = T('2026-07-11T14:00:00');
  const h = hourly([
    ['2026-07-11T15:00:00', 0.4], ['2026-07-11T16:00:00', 0.2],
    ['2026-07-11T17:00:00', 0], ['2026-07-11T18:00:00', 0],
  ]);
  const tr = precipTransition({ precip_mm: 0.5, weather_code: 61 }, h, now);
  assert.deepEqual(tr, { kind: 'easing', at: '17:00' });
});

test('precipTransition: dry now → reports when rain starts', () => {
  const now = T('2026-07-11T14:00:00');
  const h = hourly([
    ['2026-07-11T15:00:00', 0], ['2026-07-11T16:00:00', 0],
    ['2026-07-11T17:00:00', 1.0], ['2026-07-11T18:00:00', 1.0],
  ]);
  const tr = precipTransition({ precip_mm: 0, weather_code: 3 }, h, now);
  assert.deepEqual(tr, { kind: 'starting', at: '17:00' });
});

test('precipTransition: no change within lookahead → none', () => {
  const now = T('2026-07-11T14:00:00');
  const h = hourly([['2026-07-11T15:00:00', 0], ['2026-07-11T16:00:00', 0]]);
  assert.equal(precipTransition({ precip_mm: 0, weather_code: 0 }, h, now).kind, 'none');
});

// ── the [Now] line + honesty rule ────────────────────────────────────

test('buildNowWeatherLine: full line with easing', () => {
  const now = T('2026-07-11T14:00:00');
  const mirror = {
    fetched_at: '2026-07-11T13:30:00',
    current: { temp_c: 6, weather_code: 61, precip_mm: 0.4, wind_kmh: 12 },
    hourly: hourly([['2026-07-11T15:00:00', 0.2], ['2026-07-11T17:00:00', 0]]),
  };
  const line = buildNowWeatherLine(mirror, { now });
  assert.match(line, /^Weather where my human is: 6°C \(cold\), light rain, easing off around 17:00\.$/);
});

test('buildNowWeatherLine: fahrenheit unit threads through', () => {
  const now = T('2026-07-11T14:00:00');
  const mirror = {
    fetched_at: '2026-07-11T13:30:00',
    current: { temp_c: 6, weather_code: 61, precip_mm: 0.4, wind_kmh: 12 },
    hourly: hourly([['2026-07-11T15:00:00', 0.2], ['2026-07-11T17:00:00', 0]]),
  };
  const line = buildNowWeatherLine(mirror, { now, unit: 'fahrenheit' });
  assert.match(line, /43°F \(cold\)/);
});

test('buildNowWeatherLine: strong wind is surfaced, calm is not', () => {
  const now = T('2026-07-11T14:00:00');
  const base = { fetched_at: '2026-07-11T13:30:00', hourly: [] };
  const windy = buildNowWeatherLine({ ...base, current: { temp_c: 10, weather_code: 3, precip_mm: 0, wind_kmh: 60 } }, { now });
  assert.match(windy, /strong wind/);
  const calm = buildNowWeatherLine({ ...base, current: { temp_c: 10, weather_code: 3, precip_mm: 0, wind_kmh: 8 } }, { now });
  assert.doesNotMatch(calm, /wind/);
});

test('buildNowWeatherLine: STALE forecast → empty (honesty rule)', () => {
  const now = T('2026-07-12T14:00:00');
  const mirror = {
    fetched_at: '2026-07-11T13:30:00',   // ~24h old, past the 12h staleness
    current: { temp_c: 6, weather_code: 61 },
    hourly: [],
  };
  assert.equal(buildNowWeatherLine(mirror, { now }), '');
  // Just inside the window renders.
  const fresh = buildNowWeatherLine({ ...mirror, fetched_at: new Date(now - WEATHER_STALE_MS + 60_000).toISOString() }, { now });
  assert.notEqual(fresh, '');
});

test('buildNowWeatherLine: missing/garbage → empty', () => {
  assert.equal(buildNowWeatherLine(null, {}), '');
  assert.equal(buildNowWeatherLine({}, {}), '');
  assert.equal(buildNowWeatherLine({ fetched_at: 'x', current: {} }, {}), '');
  assert.equal(buildNowWeatherLine({ fetched_at: new Date().toISOString(), current: { temp_c: 'nope' } }, {}), '');
});

// ── the vague tier (gated audiences) ─────────────────────────────────

test('formatWeatherVague: qualitative only — no numbers/units/times/labels', () => {
  const now = T('2026-07-11T14:00:00');
  const m = { fetched_at: '2026-07-11T13:30:00', current: { temp_c: 6, weather_code: 61, precip_mm: 0.4, wind_kmh: 12 }, hourly: [] };
  const v = formatWeatherVague(m, { now });
  assert.match(v, /cold and rainy/);
  assert.doesNotMatch(v, /\d/);       // no numbers
  assert.doesNotMatch(v, /°C|km\/h|mm/); // no units
  assert.doesNotMatch(v, /\d{2}:\d{2}/); // no times
});

test('formatWeatherVague: hot+snow variants, and stale → empty (fail closed)', () => {
  const now = T('2026-07-11T14:00:00');
  const hot = formatWeatherVague({ fetched_at: '2026-07-11T13:30:00', current: { temp_c: 35, weather_code: 0, precip_mm: 0, wind_kmh: 5 }, hourly: [] }, { now });
  assert.match(hot, /sweltering out/);
  const snow = formatWeatherVague({ fetched_at: '2026-07-11T13:30:00', current: { temp_c: -2, weather_code: 73, precip_mm: 1, wind_kmh: 5 }, hourly: [] }, { now });
  assert.match(snow, /freezing and snowy/);
  // stale forecast → nothing (fail closed)
  assert.equal(formatWeatherVague({ fetched_at: '2026-07-09T13:30:00', current: { temp_c: 6, weather_code: 61 }, hourly: [] }, { now }), '');
  assert.equal(formatWeatherVague(null, { now }), '');
});

// ── per-hour lookup + outside-join ───────────────────────────────────

test('forecastAtHour: nearest within tolerance, else null', () => {
  const h = [
    { time: '2026-07-11T14:00:00', temp_c: 6 },
    { time: '2026-07-11T15:00:00', temp_c: 7 },
  ];
  assert.equal(forecastAtHour(h, T('2026-07-11T14:50:00')).temp_c, 7);
  assert.equal(forecastAtHour(h, T('2026-07-11T20:00:00')), null);  // >90min from any
  assert.equal(forecastAtHour([], T('2026-07-11T14:00:00')), null);
});

test('isAdverseHour: code / likely-precip / temp extreme / strong wind', () => {
  assert.equal(isAdverseHour({ weather_code: 65 }), true);            // heavy rain code
  assert.equal(isAdverseHour({ weather_code: 61, precip_mm: 0.4, precip_prob: 70 }), true); // likely+wet
  assert.equal(isAdverseHour({ weather_code: 61, precip_mm: 0.4, precip_prob: 20 }), false); // unlikely
  assert.equal(isAdverseHour({ weather_code: 0, temp_c: 35 }), true); // heat extreme
  assert.equal(isAdverseHour({ weather_code: 0, temp_c: -8 }), true); // cold extreme
  assert.equal(isAdverseHour({ weather_code: 3, wind_kmh: 60 }), true); // strong wind
  assert.equal(isAdverseHour({ weather_code: 3, temp_c: 15, wind_kmh: 10 }), false);
  assert.equal(isAdverseHour(null), false);
});

test('formatItemWeather: adverse clause vs benign brief', () => {
  assert.match(formatItemWeather({ weather_code: 65, temp_c: 6, precip_mm: 8 }), /heavy rain likely then, 6°C \(cold\)/);
  assert.match(formatItemWeather({ weather_code: 0, temp_c: 14, precip_mm: 0 }), /clear then, 14°C \(mild\)/);
  assert.match(formatItemWeather({ weather_code: 0, temp_c: 35 }), /very hot then/);
  assert.equal(formatItemWeather({ weather_code: 0, temp_c: 'x' }), '');
});

test('formatItemWeather: unit threads through', () => {
  assert.match(formatItemWeather({ weather_code: 0, temp_c: 14 }, 'fahrenheit'), /57°F \(mild\)/);
});

// ── the day arc ──────────────────────────────────────────────────────

const arcHours = (date, specs) => specs.map(([hh, temp, precip, code]) => ({
  time: `${date}T${hh}:00:00`, temp_c: temp, precip_mm: precip,
  weather_code: code ?? (precip > 0 ? 61 : 0), wind_kmh: 10, precip_prob: precip > 0 ? 70 : 10,
}));

test('weatherArc: today + tomorrow, parts + notable, ward label', () => {
  const forecast = { hourly: [
    ...arcHours('2026-07-11', [['08', 6, 0], ['10', 7, 0], ['14', 9, 0.4], ['16', 8, 0.2], ['19', 7, 0]]),
    ...arcHours('2026-07-12', [['09', 12, 0], ['15', 18, 0], ['20', 14, 0]]),
  ] };
  const arc = weatherArc(forecast, { todayDate: '2026-07-11', tomorrowDate: '2026-07-12', locationLabel: 'home' });
  assert.match(arc, /\(home\)/);
  assert.match(arc, /Today — morning: clear, 6–7°C \(cold\)/);
  assert.match(arc, /afternoon: light rain, 8–9°C \(cold\)/);
  assert.match(arc, /Notable: rain from ~14:00; easing ~19:00/);
  assert.match(arc, /Tomorrow — .*afternoon: clear, 18°C \(warm\)/);
});

test('weatherArc: fahrenheit unit threads through, band unchanged', () => {
  const forecast = { hourly: arcHours('2026-07-11', [['08', 6, 0], ['10', 7, 0]]) };
  const arc = weatherArc(forecast, { todayDate: '2026-07-11', tomorrowDate: '2026-07-12', unit: 'fahrenheit' });
  assert.match(arc, /morning: clear, 43–45°F \(cold\)/);
});

test('weatherArc: no matching days → empty; default label phrasing', () => {
  const forecast = { hourly: arcHours('2026-07-11', [['08', 6, 0]]) };
  assert.equal(weatherArc(forecast, { todayDate: '2030-01-01', tomorrowDate: '2030-01-02' }), '');
  const arc = weatherArc(forecast, { todayDate: '2026-07-11', tomorrowDate: '2026-07-12' });
  assert.match(arc, /where my human is/);
  assert.equal(weatherArc({ hourly: [] }, {}), '');
});
