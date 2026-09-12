// weather-source.js + weather-providers.js — geocode, normalisation, fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { geocode, fetchForecast } from '../src/weather/weather-source.js';
import { fetchOpenMeteo, fetchMetNorway, utcToLocalNaive } from '../src/weather/weather-providers.js';

// A fake fetch that returns a canned JSON body.
function jsonFetch(body, { ok = true, status = 200 } = {}) {
  return async () => ({ ok, status, json: async () => body });
}
function throwingFetch(msg = 'network down') {
  return async () => { throw new Error(msg); };
}

// ── geocode ───────────────────────────────────────────────────────────

test('geocode: resolves to coords + place name + timezone (coords never modelled)', async () => {
  const fetchFn = jsonFetch({ results: [{
    latitude: 52.52, longitude: 13.41, name: 'Berlin', admin1: 'Berlin', country: 'Germany',
    timezone: 'Europe/Berlin',
  }] });
  const r = await geocode('Berlin', { fetchFn });
  assert.equal(r.ok, true);
  assert.equal(r.lat, 52.52);
  assert.equal(r.place_name, 'Berlin, Berlin, Germany');
  assert.equal(r.timezone, 'Europe/Berlin');
});

test('geocode: empty query and no-match degrade cleanly', async () => {
  assert.equal((await geocode('  ', { fetchFn: jsonFetch({}) })).ok, false);
  assert.equal((await geocode('Xyzzy', { fetchFn: jsonFetch({ results: [] }) })).ok, false);
  assert.equal((await geocode('Berlin', { fetchFn: throwingFetch() })).ok, false);
});

// ── Open-Meteo normalisation ─────────────────────────────────────────

test('fetchOpenMeteo: maps wire → internal shape (local times, km/h)', async () => {
  const body = {
    current: { temperature_2m: 6.1, weather_code: 61, precipitation: 0.4, wind_speed_10m: 12 },
    hourly: {
      time: ['2026-07-11T15:00:00', '2026-07-11T16:00:00'],
      temperature_2m: [6, 5], weather_code: [61, 3],
      precipitation: [0.4, 0], precipitation_probability: [70, 20], wind_speed_10m: [12, 10],
    },
  };
  const r = await fetchOpenMeteo(52.5, 13.4, { fetchFn: jsonFetch(body) });
  assert.equal(r.provider, 'open-meteo');
  assert.equal(r.current.temp_c, 6.1);
  assert.equal(r.hourly.length, 2);
  assert.equal(r.hourly[0].precip_prob, 70);
  assert.equal(r.hourly[0].time, '2026-07-11T15:00:00');
});

test('fetchOpenMeteo: days param widens forecast_days + hourly horizon (outside-join)', async () => {
  let seenUrl = '';
  const captureFetch = (url) => { seenUrl = url; return Promise.resolve({ ok: true, status: 200, json: async () => ({
    current: { temperature_2m: 6, weather_code: 0, precipitation: 0, wind_speed_10m: 5 },
    hourly: { time: Array.from({ length: 200 }, (_, i) => `2026-07-${String(11 + Math.floor(i / 24)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00`),
      temperature_2m: Array(200).fill(6), weather_code: Array(200).fill(0),
      precipitation: Array(200).fill(0), precipitation_probability: Array(200).fill(10), wind_speed_10m: Array(200).fill(5) },
  }) }); };
  const r = await fetchOpenMeteo(52.5, 13.4, { fetchFn: captureFetch, days: 7 });
  assert.match(seenUrl, /forecast_days=7/);
  assert.equal(r.hourly.length, 7 * 24);   // keep = days*24
});

// ── MET Norway normalisation + tz conversion ─────────────────────────

test('utcToLocalNaive: converts with a zone, strips Z without one', () => {
  // 13:00Z in Berlin summer (UTC+2) → 15:00 local.
  assert.match(utcToLocalNaive('2026-07-11T13:00:00Z', 'Europe/Berlin'), /T15:00:00$/);
  assert.equal(utcToLocalNaive('2026-07-11T13:00:00Z', null), '2026-07-11T13:00:00');
});

test('fetchMetNorway: maps symbol_code → WMO, m/s → km/h, UTC → local', async () => {
  const body = { properties: { timeseries: [{
    time: '2026-07-11T13:00:00Z',
    data: {
      instant: { details: { air_temperature: 6, wind_speed: 5 } },   // 5 m/s → 18 km/h
      next_1_hours: { summary: { symbol_code: 'lightrain' }, details: { precipitation_amount: 0.4 } },
    },
  }] } };
  const r = await fetchMetNorway(52.5, 13.4, { fetchFn: jsonFetch(body), timezone: 'Europe/Berlin' });
  assert.equal(r.provider, 'met-norway');
  assert.equal(r.current.weather_code, 61);   // lightrain → 61
  assert.equal(r.current.wind_kmh, 18);
  assert.match(r.hourly[0].time, /T15:00:00$/);
});

// ── fetchForecast fallback chain ─────────────────────────────────────

test('fetchForecast: falls through to MET Norway when Open-Meteo fails', async () => {
  const metBody = { properties: { timeseries: [{
    time: '2026-07-11T13:00:00Z',
    data: { instant: { details: { air_temperature: 6, wind_speed: 3 } },
            next_1_hours: { summary: { symbol_code: 'cloudy' }, details: {} } },
  }] } };
  // Open-Meteo path throws, MET path returns.
  const chain = [
    { name: 'open-meteo', fetch: async () => { throw new Error('om down'); } },
    { name: 'met-norway', fetch: (lat, lon, opts) => fetchMetNorway(lat, lon, { ...opts, fetchFn: jsonFetch(metBody) }) },
  ];
  // now is an absolute instant (13:00Z); the stamp is local-naive in the
  // location's zone — Berlin summer is UTC+2, so it reads 15:00.
  const r = await fetchForecast(52.5, 13.4, { timezone: 'Europe/Berlin', chain, now: () => Date.parse('2026-07-11T13:00:00Z') });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'met-norway');
  assert.equal(r.fetched_at, '2026-07-11T15:00:00');   // local-naive stamp in the location's zone
});

test('fetchForecast: all providers fail → {ok:false}, no throw', async () => {
  const chain = [
    { name: 'open-meteo', fetch: async () => { throw new Error('a'); } },
    { name: 'met-norway', fetch: async () => { throw new Error('b'); } },
  ];
  const r = await fetchForecast(52.5, 13.4, { chain });
  assert.equal(r.ok, false);
  // Each failure is provider-labelled so a degraded chain is legible in logs.
  assert.match(r.error, /open-meteo: a; met-norway: b/);
});

test('fetchForecast: bad coordinates → {ok:false}', async () => {
  assert.equal((await fetchForecast(NaN, 13.4, {})).ok, false);
});
