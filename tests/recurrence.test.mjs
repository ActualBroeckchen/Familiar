import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandOccurrences, expandWindow, localDateKey } from '../recurrence.js';

// All test anchors use local-TZ Date construction so the tests are
// deterministic regardless of where the runner lives — recurrence
// expansion walks in calendar terms (days/months/years), and the
// fixture clock matches.

// ── Daily ──────────────────────────────────────────────────────────

test('daily: anchor + 7-day window produces 7 occurrences', () => {
  const anchor = new Date(2026, 5, 1, 9, 0).toISOString(); // Mon Jun 1, 9am
  const node = { when: anchor, payload: { recurrence: { freq: 'daily' } } };
  const fromMs = new Date(2026, 5, 1, 0, 0).getTime();
  const toMs   = new Date(2026, 5, 7, 23, 59).getTime();
  const occs = expandOccurrences(node, fromMs, toMs);
  assert.equal(occs.length, 7);
  // All occurrences should be at 9am local
  for (const ms of occs) {
    assert.equal(new Date(ms).getHours(), 9);
  }
});

test('daily: interval=2 → every other day', () => {
  const anchor = new Date(2026, 5, 1, 9, 0).toISOString();
  const node = { when: anchor, payload: { recurrence: { freq: 'daily', interval: 2 } } };
  const fromMs = new Date(2026, 5, 1, 0, 0).getTime();
  const toMs   = new Date(2026, 5, 10, 23, 59).getTime();
  const occs = expandOccurrences(node, fromMs, toMs);
  // Days 1, 3, 5, 7, 9 = 5 occurrences
  assert.equal(occs.length, 5);
});

test('daily: until cutoff is honored', () => {
  const anchor = new Date(2026, 5, 1).toISOString();
  const node = {
    when: anchor,
    payload: { recurrence: { freq: 'daily', until: '2026-06-03' } },
  };
  const fromMs = new Date(2026, 5, 1).getTime();
  const toMs   = new Date(2026, 5, 30).getTime();
  const occs = expandOccurrences(node, fromMs, toMs);
  // Jun 1, 2, 3 → 3 occurrences (the 4th would be after until)
  assert.equal(occs.length, 3);
});

// ── Weekly ─────────────────────────────────────────────────────────

test('weekly: anchored on a Monday → repeats Mondays', () => {
  const anchor = new Date(2026, 5, 1, 9, 0).toISOString(); // Mon Jun 1
  const node = { when: anchor, payload: { recurrence: { freq: 'weekly' } } };
  // Window covers 3 weeks. End-of-day on Jun 22 so the 9am
  // occurrence that day stays inside the inclusive window.
  const fromMs = new Date(2026, 5, 1).getTime();
  const toMs   = new Date(2026, 5, 22, 23, 59).getTime();
  const occs = expandOccurrences(node, fromMs, toMs);
  // Jun 1, 8, 15, 22 = 4 occurrences (all Mondays)
  assert.equal(occs.length, 4);
  for (const ms of occs) {
    assert.equal(new Date(ms).getDay(), 1, 'must be a Monday');
  }
});

// ── Monthly ────────────────────────────────────────────────────────

test('monthly: same day-of-month each month', () => {
  const anchor = new Date(2026, 0, 15, 14, 0).toISOString(); // Jan 15
  const node = { when: anchor, payload: { recurrence: { freq: 'monthly' } } };
  const fromMs = new Date(2026, 0, 1).getTime();
  const toMs   = new Date(2026, 5, 30).getTime();
  const occs = expandOccurrences(node, fromMs, toMs);
  // Jan 15, Feb 15, Mar 15, Apr 15, May 15, Jun 15 = 6 occurrences
  assert.equal(occs.length, 6);
  for (const ms of occs) {
    assert.equal(new Date(ms).getDate(), 15);
  }
});

test('monthly: Jan 31 → Feb clamps to Feb 28/29 instead of overflowing to March', () => {
  const anchor = new Date(2026, 0, 31, 9, 0).toISOString(); // Jan 31, 2026 (not a leap year)
  const node = { when: anchor, payload: { recurrence: { freq: 'monthly' } } };
  const fromMs = new Date(2026, 0, 1).getTime();
  const toMs   = new Date(2026, 2, 31, 23, 59).getTime();
  const occs = expandOccurrences(node, fromMs, toMs);
  // Jan 31, Feb 28 (clamped, NOT March 3), Mar 31
  assert.equal(occs.length, 3);
  assert.equal(new Date(occs[1]).getMonth(), 1); // February
  assert.equal(new Date(occs[1]).getDate(), 28);
});

test('monthly: bysetpos=-1 + byweekday=5 → "last Friday of every month"', () => {
  const anchor = new Date(2026, 5, 26, 18, 0).toISOString(); // anchor in June 2026
  const node = {
    when: anchor,
    payload: { recurrence: { freq: 'monthly', bysetpos: -1, byweekday: 5 } },
  };
  const fromMs = new Date(2026, 5, 1).getTime();
  const toMs   = new Date(2026, 8, 30, 23, 59).getTime();
  const occs = expandOccurrences(node, fromMs, toMs);
  // Last Fridays of June, July, August, September 2026
  // Jun 2026: 26 (Fri), Jul 31, Aug 28, Sep 25
  assert.equal(occs.length, 4);
  for (const ms of occs) {
    const d = new Date(ms);
    assert.equal(d.getDay(), 5, 'must be a Friday');
    // Confirm it's the LAST such weekday in the month — i.e. adding 7
    // days lands in the next month.
    const oneWeekAhead = new Date(d.getTime() + 7 * 24 * 3600 * 1000);
    assert.notEqual(d.getMonth(), oneWeekAhead.getMonth());
  }
});

test('monthly: bysetpos=1 + byweekday=1 → "first Monday of every month"', () => {
  const anchor = new Date(2026, 0, 5, 9, 0).toISOString(); // first Monday of Jan 2026
  const node = {
    when: anchor,
    payload: { recurrence: { freq: 'monthly', bysetpos: 1, byweekday: 1 } },
  };
  const fromMs = new Date(2026, 0, 1).getTime();
  const toMs   = new Date(2026, 2, 31).getTime();
  const occs = expandOccurrences(node, fromMs, toMs);
  // First Mondays: Jan 5, Feb 2, Mar 2
  assert.equal(occs.length, 3);
  assert.equal(new Date(occs[0]).getDate(), 5);
  assert.equal(new Date(occs[1]).getDate(), 2);
  assert.equal(new Date(occs[2]).getDate(), 2);
});

// ── Yearly ─────────────────────────────────────────────────────────

test('yearly: birthday repeats every year on the same date', () => {
  const anchor = new Date(2024, 5, 4).toISOString(); // Jun 4, 2024
  const node = { when: anchor, payload: { recurrence: { freq: 'yearly' } } };
  const fromMs = new Date(2026, 0, 1).getTime();
  const toMs   = new Date(2028, 11, 31).getTime();
  const occs = expandOccurrences(node, fromMs, toMs);
  // Jun 4 of 2026, 2027, 2028 = 3 occurrences (2024, 2025 anchors fall outside window)
  assert.equal(occs.length, 3);
  for (const ms of occs) {
    const d = new Date(ms);
    assert.equal(d.getMonth(), 5);
    assert.equal(d.getDate(), 4);
  }
});

test('yearly: Feb 29 anchor clamps to Feb 28 in non-leap years', () => {
  const anchor = new Date(2024, 1, 29).toISOString(); // Feb 29, 2024 (leap)
  const node = { when: anchor, payload: { recurrence: { freq: 'yearly' } } };
  const fromMs = new Date(2024, 0, 1).getTime();
  const toMs   = new Date(2027, 11, 31).getTime();
  const occs = expandOccurrences(node, fromMs, toMs);
  // 2024: Feb 29; 2025-2027: Feb 28 (clamped)
  assert.equal(occs.length, 4);
  assert.equal(new Date(occs[0]).getDate(), 29);
  assert.equal(new Date(occs[1]).getDate(), 28);
  assert.equal(new Date(occs[2]).getDate(), 28);
  assert.equal(new Date(occs[3]).getDate(), 28);
});

// ── Bad inputs / edge cases ────────────────────────────────────────

test('no recurrence rule → empty array', () => {
  const node = { when: new Date().toISOString(), payload: {} };
  assert.deepEqual(expandOccurrences(node, 0, Date.now()), []);
});

test('malformed when → empty array (no throw)', () => {
  const node = { when: 'not-a-date', payload: { recurrence: { freq: 'daily' } } };
  assert.deepEqual(expandOccurrences(node, 0, Date.now()), []);
});

test('inverted window (from > to) → empty array', () => {
  const node = {
    when: new Date(2026, 0, 1).toISOString(),
    payload: { recurrence: { freq: 'daily' } },
  };
  assert.deepEqual(
    expandOccurrences(node, Date.now() + DAY, Date.now()),
    [],
  );
});

// ── expandWindow integration ───────────────────────────────────────

test('expandWindow: plain nodes pass through unchanged', () => {
  const plain = { id: 'a', when: '2026-06-04T09:00:00Z', label: 'A', payload: {} };
  const out = expandWindow([plain], 0, Date.now() + DAY * 365);
  assert.equal(out.length, 1);
  assert.equal(out[0], plain); // same object reference, no copy
});

test('expandWindow: recurring nodes are expanded into per-occurrence items', () => {
  const node = {
    id: 'cleaning',
    when: new Date(2026, 5, 7, 10, 0).toISOString(), // Sun Jun 7
    end:  new Date(2026, 5, 7, 11, 0).toISOString(),
    label: 'Cleaning',
    type: 'task',
    payload: { recurrence: { freq: 'weekly' } },
  };
  const fromMs = new Date(2026, 5, 1).getTime();
  const toMs   = new Date(2026, 5, 28, 23, 59).getTime();
  const out = expandWindow([node], fromMs, toMs);
  // 4 Sundays: Jun 7, 14, 21, 28
  assert.equal(out.length, 4);
  for (const item of out) {
    assert.equal(item.label, 'Cleaning');
    assert.equal(item.__occurrence_of, 'cleaning');
    assert.equal(item.resolution, null);
    // Each occurrence preserves the 1-hour duration
    const dur = new Date(item.end).getTime() - new Date(item.when).getTime();
    assert.equal(dur, 60 * 60 * 1000);
  }
});

const DAY = 24 * 3600 * 1000;

// ── Per-occurrence resolutions ─────────────────────────────────────

test('per-occurrence resolution: marked-done occurrence is filtered out', () => {
  // Weekly Monday anchor; mark Jun 8 (the second Monday) done.
  // Expansion should produce Jun 1, 15, 22 — not Jun 8.
  const anchor = new Date(2026, 5, 1, 9, 0).toISOString();
  const node = {
    when: anchor,
    payload: {
      recurrence: { freq: 'weekly' },
      resolutions: { '2026-06-08': 'done' },
    },
  };
  const fromMs = new Date(2026, 5, 1).getTime();
  const toMs   = new Date(2026, 5, 22, 23, 59).getTime();
  const occs = expandOccurrences(node, fromMs, toMs);
  assert.equal(occs.length, 3);
  const dates = occs.map(ms => localDateKey(ms));
  assert.ok(!dates.includes('2026-06-08'), 'Jun 8 should be filtered out');
  assert.ok(dates.includes('2026-06-01'));
  assert.ok(dates.includes('2026-06-15'));
  assert.ok(dates.includes('2026-06-22'));
});

test('per-occurrence resolution: multiple resolutions all filtered', () => {
  const anchor = new Date(2026, 5, 1).toISOString();
  const node = {
    when: anchor,
    payload: {
      recurrence: { freq: 'daily' },
      resolutions: {
        '2026-06-02': 'done',
        '2026-06-04': 'cancelled',
        '2026-06-06': 'carried_forward',
      },
    },
  };
  const fromMs = new Date(2026, 5, 1).getTime();
  const toMs   = new Date(2026, 5, 7, 23, 59).getTime();
  const occs = expandOccurrences(node, fromMs, toMs);
  // Days 1..7 = 7 - 3 resolved = 4 remaining
  assert.equal(occs.length, 4);
  const dates = occs.map(ms => localDateKey(ms));
  assert.ok(!dates.includes('2026-06-02'));
  assert.ok(!dates.includes('2026-06-04'));
  assert.ok(!dates.includes('2026-06-06'));
});

test('per-occurrence resolution: empty resolutions object → no filter', () => {
  const anchor = new Date(2026, 5, 1).toISOString();
  const node = {
    when: anchor,
    payload: { recurrence: { freq: 'daily' }, resolutions: {} },
  };
  const fromMs = new Date(2026, 5, 1).getTime();
  const toMs   = new Date(2026, 5, 3, 23, 59).getTime();
  const occs = expandOccurrences(node, fromMs, toMs);
  assert.equal(occs.length, 3);
});

test('localDateKey: stable YYYY-MM-DD in local TZ', () => {
  const ms = new Date(2026, 5, 4, 9, 30).getTime();
  assert.equal(localDateKey(ms), '2026-06-04');
});
