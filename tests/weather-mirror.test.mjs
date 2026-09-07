// weather-mirror.js — the sync read-mirror + the [Now]-line gate.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import {
  writeWeatherMirror, clearWeatherMirror, readWeatherMirrorSync, readWeatherNowLine,
  readWeatherVagueLine, weatherEnabled,
} from '../src/weather/weather-mirror.js';
import { buildTimeAnchorBlock } from '../relative-time.js';

let dir;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'weather-mirror-')); delete process.env.PROTO_FAMILIAR_WEATHER_DISABLED; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const NOW = Date.parse('2026-07-11T14:00:00');
const freshMirror = () => ({
  provider: 'open-meteo',
  fetched_at: '2026-07-11T13:30:00',
  current: { temp_c: 6, weather_code: 61, precip_mm: 0.4, wind_kmh: 12 },
  hourly: [{ time: '2026-07-11T17:00:00', precip_mm: 0, weather_code: 0 }],
});

test('write → read roundtrip, then clear removes it', async () => {
  await writeWeatherMirror(freshMirror(), { tomesDir: dir });
  assert.ok(existsSync(path.join(dir, '.weather-now.json')));
  assert.equal(readWeatherMirrorSync({ tomesDir: dir }).current.temp_c, 6);
  await clearWeatherMirror({ tomesDir: dir });
  assert.equal(readWeatherMirrorSync({ tomesDir: dir }), null);
});

test('readWeatherNowLine: builds the line from a fresh mirror', async () => {
  await writeWeatherMirror(freshMirror(), { tomesDir: dir });
  const line = readWeatherNowLine({ tomesDir: dir, now: NOW });
  assert.match(line, /Weather where my human is: 6°C \(cold\), light rain, easing off around 17:00\./);
});

test('readWeatherNowLine: env off-switch short-circuits to empty', async () => {
  await writeWeatherMirror(freshMirror(), { tomesDir: dir });
  process.env.PROTO_FAMILIAR_WEATHER_DISABLED = '1';
  assert.equal(readWeatherNowLine({ tomesDir: dir, now: NOW }), '');
  assert.equal(readWeatherMirrorSync({ tomesDir: dir }), null);
  delete process.env.PROTO_FAMILIAR_WEATHER_DISABLED;
});

test('readWeatherNowLine: absent mirror / stale forecast → empty', async () => {
  assert.equal(readWeatherNowLine({ tomesDir: dir, now: NOW }), '');   // absent
  await writeWeatherMirror(freshMirror(), { tomesDir: dir });
  // 2 days later: past staleness → empty even though the file exists.
  assert.equal(readWeatherNowLine({ tomesDir: dir, now: Date.parse('2026-07-13T14:00:00') }), '');
});

test('readWeatherVagueLine: qualitative only for gated surfaces; fails closed', async () => {
  await writeWeatherMirror(freshMirror(), { tomesDir: dir });
  const v = readWeatherVagueLine({ tomesDir: dir, now: NOW });
  assert.match(v, /cold and rainy/);
  assert.doesNotMatch(v, /\d|°C|:/);       // no numbers/units/times
  // env off-switch and staleness both fail closed to ''.
  process.env.PROTO_FAMILIAR_WEATHER_DISABLED = '1';
  assert.equal(readWeatherVagueLine({ tomesDir: dir, now: NOW }), '');
  delete process.env.PROTO_FAMILIAR_WEATHER_DISABLED;
  assert.equal(readWeatherVagueLine({ tomesDir: dir, now: Date.parse('2026-07-13T14:00:00') }), '');
});

test('weatherEnabled: env off-switch + default-ON settings toggle', () => {
  assert.equal(weatherEnabled({}), true);                       // default ON
  assert.equal(weatherEnabled({ weatherEnabled: false }), false);
  process.env.PROTO_FAMILIAR_WEATHER_DISABLED = '1';
  assert.equal(weatherEnabled({ weatherEnabled: true }), false); // env wins
  delete process.env.PROTO_FAMILIAR_WEATHER_DISABLED;
});

// ── buildTimeAnchorBlock weather-line integration ────────────────────

test('buildTimeAnchorBlock: appends the weather line when passed, omits when empty', () => {
  const withW = buildTimeAnchorBlock({ now: NOW, weatherLine: 'Weather where my human is: 6°C (cold).' });
  assert.match(withW, /\[Now\]/);
  assert.match(withW, /Weather where my human is: 6°C \(cold\)\./);
  const without = buildTimeAnchorBlock({ now: NOW });
  assert.doesNotMatch(without, /Weather/);
  // Whitespace-only weatherLine is treated as none (no dangling blank line).
  const blank = buildTimeAnchorBlock({ now: NOW, weatherLine: '   ' });
  assert.doesNotMatch(blank, /Weather/);
});
