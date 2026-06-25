import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isNeedWindow, selectMissedOccurrences, summarizeNeedsForDay } from '../needs-tracking.js';
import { runNeedsTick } from '../needs-tracking-loop.js';

const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

// A daily need-window. when/end carry the time-of-day; the date part is the
// recurrence anchor (the expander applies the time-of-day to each day).
function need({ id = 'n1', label = 'dinner', startHour = 18, endHour = 20, resolutions = {} } = {}) {
  const anchor = new Date(2026, 0, 1, startHour, 0, 0);
  const end    = new Date(2026, 0, 1, endHour, 0, 0);
  return {
    id, type: 'task', label,
    when: anchor.toISOString(), end: end.toISOString(),
    payload: { need: true, stakes_tier: 'personal_wellbeing', recurrence: { freq: 'daily' }, resolutions },
  };
}

// "Now" today, at a chosen hour, so window math is deterministic.
function todayAt(hour) { const d = new Date(); d.setHours(hour, 0, 0, 0); return d.getTime(); }
function todayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('isNeedWindow: needs a marker, a window, and a recurrence', () => {
  assert.equal(isNeedWindow(need()), true);
  const noEnd = need(); delete noEnd.end;
  assert.equal(isNeedWindow(noEnd), false);
  const notNeed = need(); notNeed.payload = { ...notNeed.payload, need: false };
  assert.equal(isNeedWindow(notNeed), false);
  const noRec = need(); noRec.payload = { ...noRec.payload }; delete noRec.payload.recurrence;
  assert.equal(isNeedWindow(noRec), false);
});

test('selectMissedOccurrences: a window that closed unmet today is missed', () => {
  // (The 2-day lookback intentionally also catches a prior unmet day — so
  // we assert on TODAY specifically rather than the exact count.)
  const now = todayAt(21);                       // 21:00, after the 18–20 window
  const missed = selectMissedOccurrences([need()], now);
  assert.ok(missed.some(m => m.id === 'n1' && m.date === todayKey(now)), 'today is flagged missed');
});

test('selectMissedOccurrences: an open window (now inside it) is NOT missed', () => {
  const now = todayAt(19);                       // 19:00, inside 18–20
  assert.ok(!selectMissedOccurrences([need()], now).some(m => m.date === todayKey(now)),
    'today is not missed while its window is still open');
});

test('selectMissedOccurrences: an already-resolved day is NOT re-marked (natural dedup)', () => {
  const now = todayAt(21);
  const already = need({ resolutions: { [todayKey(now)]: 'missed' } });
  assert.ok(!selectMissedOccurrences([already], now).some(m => m.date === todayKey(now)));
  const done = need({ resolutions: { [todayKey(now)]: 'done' } });
  assert.ok(!selectMissedOccurrences([done], now).some(m => m.date === todayKey(now)));
});

test('summarizeNeedsForDay: status reflects met / missed / open / upcoming', () => {
  const at = (h) => summarizeNeedsForDay([need()], todayAt(h))[0]?.status;
  assert.equal(at(17), 'upcoming');   // before the window
  assert.equal(at(19), 'open');       // inside the window
  assert.equal(at(21), 'missed');     // after, unmet → live-derived missed
  const metNow = todayAt(21);
  assert.equal(summarizeNeedsForDay([need({ resolutions: { [todayKey(metNow)]: 'done' } })], metNow)[0].status, 'met');
});

test('runNeedsTick: disabled is a no-op', async () => {
  const r = await runNeedsTick({ enabled: false });
  assert.equal(r.reason, 'disabled');
});

test('runNeedsTick: stands down at moderate+ threat (never competes with triage)', async () => {
  let resolved = 0;
  const r = await runNeedsTick({
    enabled: true,
    threat: async () => ({ tier: 'moderate', weight: 3 }),
    list: async () => ({ nodes: [need()] }),
    resolveOccurrence: async () => { resolved++; return { ok: true }; },
    now: todayAt(21),
  });
  assert.equal(r.reason, 'stood-down');
  assert.equal(resolved, 0, 'nothing is marked while standing down');
});

test('runNeedsTick: when calm + enabled, marks a missed window via resolveOccurrence', async () => {
  const calls = [];
  const r = await runNeedsTick({
    enabled: true,
    threat: async () => ({ tier: 'calm', weight: 0 }),
    list: async () => ({ nodes: [need()] }),
    resolveOccurrence: async (args) => { calls.push(args); return { ok: true }; },
    now: todayAt(21),
  });
  assert.ok(r.marked >= 1);
  assert.ok(calls.some(c => c.resolution === 'missed' && c.id === 'n1' && c.occurrence_date === todayKey(todayAt(21))),
    'today\'s missed window was marked via resolveOccurrence');
});
