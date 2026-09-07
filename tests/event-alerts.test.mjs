import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectDueEventAlerts, formatEventAlert, alertWindowBounds,
  clampLeadMinutes, ALERT_GRACE_MS, DEFAULT_LEAD_MINUTES,
  clampElapsedStampHours, DEFAULT_ELAPSED_STAMP_HOURS,
  effectiveLeadMs,
} from '../src/schedule/event-alerts.js';
import { runOneReminderTick } from '../src/schedule/reminders-loop.js';

// A fixed "now" in the shared ward-local-as-server-local frame.
const NOW = new Date('2026-07-04T14:00:00').getTime();
const LEAD = 60 * 60_000;

const ev = (over = {}) => ({
  id: 'e1', type: 'event', label: 'Dentist', resolution: null,
  when: '2026-07-04T14:45:00', payload: {}, ...over,
});

test('clampLeadMinutes: floors, ceils, defaults', () => {
  assert.equal(clampLeadMinutes(60), 60);
  assert.equal(clampLeadMinutes(1), 5);
  assert.equal(clampLeadMinutes(100000), 1440);
  assert.equal(clampLeadMinutes('nope'), DEFAULT_LEAD_MINUTES);
});

test('a one-time event inside the lead window alerts once', () => {
  const out = selectDueEventAlerts({ windowNodes: [ev()], recurringNodes: [], nowMs: NOW, leadMs: LEAD });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'e1');
  assert.equal(out[0].occurrenceDate, null);
});

// ── Per-event lead (Initiative Pass 5) ───────────────────────────────

test('effectiveLeadMs: per-event lead_minutes overrides the default, clamped', () => {
  const dflt = 60 * 60_000;
  assert.equal(effectiveLeadMs({ payload: {} }, dflt), dflt, 'no override → default');
  assert.equal(effectiveLeadMs({ payload: { lead_minutes: 90 } }, dflt), 90 * 60_000);
  assert.equal(effectiveLeadMs({ payload: { lead_minutes: 2 } }, dflt), 5 * 60_000, 'clamped up to floor');
  assert.equal(effectiveLeadMs({ payload: { lead_minutes: 99999 } }, dflt), 1440 * 60_000, 'clamped to ceiling');
});

test('per-event lead: a longer custom lead fires earlier than the global default would', () => {
  // Event 3h out; global default is 60min (would NOT alert yet), but this
  // event carries a 4h lead → it should alert now.
  const far = ev({ id: 'therapy', when: '2026-07-04T17:00:00', payload: { lead_minutes: 240 } });
  const withDefault = selectDueEventAlerts({ windowNodes: [far], recurringNodes: [], nowMs: NOW, defaultLeadMs: LEAD });
  assert.equal(withDefault.length, 1, 'the 4h custom lead fires 3h out');
  assert.equal(withDefault[0].id, 'therapy');
});

test('per-event lead: a shorter custom lead suppresses an alert the default would send', () => {
  // Event 45min out; global default 60min WOULD alert, but a 10min custom
  // lead means it's not time yet.
  const soon = ev({ payload: { lead_minutes: 10 } });  // 45min out
  const out = selectDueEventAlerts({ windowNodes: [soon], recurringNodes: [], nowMs: NOW, defaultLeadMs: LEAD });
  assert.equal(out.length, 0, 'the 10min lead holds the alert until 10min before');
});

test('per-event lead: recurring occurrence honours the anchor lead_minutes', () => {
  const anchor = ev({
    id: 'standup', when: '2026-07-04T17:00:00',
    payload: { recurrence: { freq: 'daily' }, lead_minutes: 240 },
  });
  const out = selectDueEventAlerts({ windowNodes: [], recurringNodes: [anchor], nowMs: NOW, defaultLeadMs: LEAD });
  assert.equal(out.length, 1, 'a 3h-out occurrence fires under the 4h custom lead');
  assert.equal(out[0].id, 'standup');
  assert.ok(out[0].occurrenceDate);
});

test('outside the lead window (too far ahead) stays silent', () => {
  const far = ev({ when: '2026-07-04T16:30:00' });
  const out = selectDueEventAlerts({ windowNodes: [far], recurringNodes: [], nowMs: NOW, leadMs: LEAD });
  assert.equal(out.length, 0);
});

test('already-started events alert only within the grace window', () => {
  const justStarted = ev({ when: '2026-07-04T13:50:00' });   // 10 min ago
  const longGone    = ev({ id: 'e2', when: '2026-07-04T13:00:00' }); // 1h ago
  const out = selectDueEventAlerts({ windowNodes: [justStarted, longGone], recurringNodes: [], nowMs: NOW, leadMs: LEAD });
  assert.deepEqual(out.map(a => a.id), ['e1']);
});

test('alerted_at, resolution, all_day, and non-event types are all excluded', () => {
  const nodes = [
    ev({ id: 'done',    resolution: 'done' }),
    ev({ id: 'pinged',  payload: { alerted_at: '2026-07-04T13:40:00' } }),
    ev({ id: 'allday',  payload: { all_day: true } }),
    ev({ id: 'task',    type: 'task' }),
    ev({ id: 'rem',     type: 'reminder' }),
  ];
  const out = selectDueEventAlerts({ windowNodes: nodes, recurringNodes: [], nowMs: NOW, leadMs: LEAD });
  assert.equal(out.length, 0);
});

test('recurring events alert per occurrence, keyed by date, skipping alerted ones', () => {
  const anchor = {
    id: 'r1', type: 'event', label: 'Standup', resolution: null,
    when: '2026-06-01T14:30:00',
    payload: { recurrence: { freq: 'daily' } },
  };
  const out = selectDueEventAlerts({ windowNodes: [], recurringNodes: [anchor], nowMs: NOW, leadMs: LEAD });
  assert.equal(out.length, 1);
  assert.equal(out[0].occurrenceDate, '2026-07-04');
  assert.ok(out[0].whenIso.startsWith('2026-07-04T14:30'));

  // Same day already alerted → silent.
  anchor.payload.alerts = { '2026-07-04': '2026-07-04T13:30:00' };
  const again = selectDueEventAlerts({ windowNodes: [], recurringNodes: [anchor], nowMs: NOW, leadMs: LEAD });
  assert.equal(again.length, 0);
});

test('formatEventAlert builds code-derived title/body', () => {
  const [a] = selectDueEventAlerts({ windowNodes: [ev()], recurringNodes: [], nowMs: NOW, leadMs: LEAD });
  const f = formatEventAlert(a, { nowMs: NOW });
  assert.equal(f.title, 'Coming up: Dentist');
  assert.match(f.body, /14:45/);
});

test('alertWindowBounds spans grace behind and lead ahead in local-naive ISO', () => {
  const { fromIso, toIso } = alertWindowBounds({ nowMs: NOW, leadMs: LEAD });
  assert.equal(fromIso, '2026-07-04T13:45:00');
  assert.equal(toIso, '2026-07-04T15:00:00');
  assert.equal(ALERT_GRACE_MS, 15 * 60_000);
});

test('reminder tick: alerts enqueue then mark, and a failed mark retries next tick', async () => {
  const enq = [];
  const marked = [];
  let failMark = true;
  const tick = () => runOneReminderTick({
    getDueReminders: async () => [],
    fireReminder: async () => {},
    getDueEventAlerts: async () => [{ id: 'e1', label: 'Dentist', occurrenceDate: null, title: 'Coming up: Dentist', body: 'Starts soon.' }],
    markEventAlerted: async (a) => { if (failMark) throw new Error('unruh down'); marked.push(a); },
    enqueueOutboxFn: async (item) => { enq.push(item); return { id: 'x' }; },
  });
  const r1 = await tick();
  assert.equal(r1.alerted.length, 0);
  assert.equal(r1.skipped.length, 1);
  assert.equal(enq.length, 1);
  assert.equal(enq[0].kind, 'event_alert');
  assert.equal(enq[0].originId, 'event-alert:e1:once');

  failMark = false;
  const r2 = await tick();
  assert.equal(r2.alerted.length, 1);
  assert.equal(marked.length, 1);
  // The re-enqueue reuses the same originId — the outbox dedups it.
  assert.equal(enq[1].originId, enq[0].originId);
});

// ── Elapsed-stamp threshold clamp (causal-chain fix piece 4) ──────

test('clampElapsedStampHours: default 24, clamped to [1, 720], rounded', () => {
  assert.equal(clampElapsedStampHours(undefined), DEFAULT_ELAPSED_STAMP_HOURS);
  assert.equal(clampElapsedStampHours('nonsense'), DEFAULT_ELAPSED_STAMP_HOURS);
  assert.equal(clampElapsedStampHours(0), 1);
  assert.equal(clampElapsedStampHours(100000), 720);
  assert.equal(clampElapsedStampHours(48.4), 48);
  assert.equal(clampElapsedStampHours(24), 24);
});
