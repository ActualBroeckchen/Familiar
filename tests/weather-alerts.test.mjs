// Severe-weather heads-up (W-B §5.4): selection, formatting, and the
// reminders-tick integration (its own dedup channel + outbox kind).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectDueWeatherAlerts, formatWeatherAlert } from '../src/schedule/event-alerts.js';
import { runOneReminderTick } from '../src/schedule/reminders-loop.js';

const NOW = Date.parse('2026-07-11T12:00:00');
const LEAD = 3 * 3600e3;   // 3h default lead

const outsideEvent = (over = {}) => ({
  id: 'market-run', type: 'event', label: 'Market run',
  when: '2026-07-11T14:00:00',
  payload: { obstacle_tags: ['outside'], ...over.payload },
  ...over,
});
const wetMirror = { hourly: [
  { time: '2026-07-11T14:00:00', temp_c: 6, weather_code: 65, precip_mm: 8, precip_prob: 80, wind_kmh: 20 },
] };
const drySky = { hourly: [
  { time: '2026-07-11T14:00:00', temp_c: 15, weather_code: 0, precip_mm: 0, precip_prob: 5, wind_kmh: 8 },
] };

test('selectDueWeatherAlerts: outside item + adverse hour → one alert', () => {
  const a = selectDueWeatherAlerts({ windowNodes: [outsideEvent()], recurringNodes: [], mirror: wetMirror, nowMs: NOW, defaultLeadMs: LEAD });
  assert.equal(a.length, 1);
  assert.equal(a[0].id, 'market-run');
  assert.equal(a[0].occurrenceDate, null);
  assert.equal(a[0].hour.weather_code, 65);
});

test('selectDueWeatherAlerts: benign sky → no alert; weather alone never pings', () => {
  assert.equal(selectDueWeatherAlerts({ windowNodes: [outsideEvent()], recurringNodes: [], mirror: drySky, nowMs: NOW, defaultLeadMs: LEAD }).length, 0);
});

test('selectDueWeatherAlerts: non-outside item ignored even in a storm', () => {
  const indoor = outsideEvent({ payload: { obstacle_tags: ['focus'] } });
  assert.equal(selectDueWeatherAlerts({ windowNodes: [indoor], recurringNodes: [], mirror: wetMirror, nowMs: NOW, defaultLeadMs: LEAD }).length, 0);
});

test('selectDueWeatherAlerts: already weather-alerted → skipped (separate dedup channel)', () => {
  const done = outsideEvent({ payload: { obstacle_tags: ['outside'], weather_alerted_at: '2026-07-11T11:00:00' } });
  assert.equal(selectDueWeatherAlerts({ windowNodes: [done], recurringNodes: [], mirror: wetMirror, nowMs: NOW, defaultLeadMs: LEAD }).length, 0);
  // ...but a coming-up `alerted_at` does NOT suppress the weather channel.
  const comingUpOnly = outsideEvent({ payload: { obstacle_tags: ['outside'], alerted_at: '2026-07-11T11:00:00' } });
  assert.equal(selectDueWeatherAlerts({ windowNodes: [comingUpOnly], recurringNodes: [], mirror: wetMirror, nowMs: NOW, defaultLeadMs: LEAD }).length, 1);
});

test('selectDueWeatherAlerts: no mirror / no hourly → []', () => {
  assert.equal(selectDueWeatherAlerts({ windowNodes: [outsideEvent()], recurringNodes: [], mirror: null, nowMs: NOW, defaultLeadMs: LEAD }).length, 0);
  assert.equal(selectDueWeatherAlerts({ windowNodes: [outsideEvent()], recurringNodes: [], mirror: { hourly: [] }, nowMs: NOW, defaultLeadMs: LEAD }).length, 0);
});

test('formatWeatherAlert: code-built title + body', () => {
  const [a] = selectDueWeatherAlerts({ windowNodes: [outsideEvent()], recurringNodes: [], mirror: wetMirror, nowMs: NOW, defaultLeadMs: LEAD });
  const f = formatWeatherAlert(a, { nowMs: NOW });
  assert.match(f.title, /Weather heads-up: Market run/);
  assert.match(f.body, /heavy rain likely then/);
  assert.match(f.body, /at 14:00/);
});

test('runOneReminderTick: weather stream uses its own kind + marks kind=weather', async () => {
  const enqueued = [];
  const marks = [];
  const res = await runOneReminderTick({
    getDueReminders: async () => [],
    fireReminder: async () => {},
    getDueEventAlerts: async () => [],
    markEventAlerted: async (m) => { marks.push(m); },
    getDueWeatherAlerts: async () => [{ id: 'market-run', occurrenceDate: null, title: 'Weather heads-up: Market run', body: 'Outside soon — heavy rain likely then.' }],
    enqueueOutboxFn: async (item) => { enqueued.push(item); },
    now: () => NOW,
  });
  assert.equal(res.weatherAlerted.length, 1);
  assert.equal(enqueued[0].kind, 'weather_alert');
  assert.equal(enqueued[0].originId, 'weather-alert:market-run:once');
  assert.equal(marks[0].kind, 'weather');
});
