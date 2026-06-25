import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relativeTime, relativeDay, clockTime, dayAndDate, plainInterval, buildTimeAnchorBlock } from '../relative-time.js';

// All test fixtures use a fixed "now" so they're deterministic across
// timezones and clock drift. The relativeTime/relativeDay helpers
// compare by local calendar day, so the test process's TZ does matter
// — pin to a stable anchor inside the working day to keep buckets
// ("morning"/"afternoon") predictable.

const NOW = new Date(2026, 5, 4, 14, 30, 0).getTime(); // Thu Jun 4 2026, 14:30 local

// ── clockTime ──────────────────────────────────────────────────────

test('clockTime: 12-hour with am/pm; whole hours drop :00', () => {
  assert.equal(clockTime(new Date(2026, 5, 4,  9,  0)), '9am');
  assert.equal(clockTime(new Date(2026, 5, 4,  9, 30)), '9:30am');
  assert.equal(clockTime(new Date(2026, 5, 4, 14,  0)), '2pm');
  assert.equal(clockTime(new Date(2026, 5, 4, 23, 15)), '11:15pm');
  assert.equal(clockTime(new Date(2026, 5, 4, 12,  0)), 'noon');
  assert.equal(clockTime(new Date(2026, 5, 4,  0,  0)), 'midnight');
});

// ── relativeTime: sub-hour windows ─────────────────────────────────

test('relativeTime: under a minute → "just now" / "in a moment"', () => {
  assert.equal(relativeTime(NOW - 30 * 1000, NOW), 'just now');
  assert.equal(relativeTime(NOW + 30 * 1000, NOW), 'in a moment');
});

test('relativeTime: minutes', () => {
  assert.equal(relativeTime(NOW -  1 * 60_000, NOW), 'a minute ago');
  assert.equal(relativeTime(NOW - 20 * 60_000, NOW), '20 minutes ago');
  assert.equal(relativeTime(NOW + 30 * 60_000, NOW), 'in 30 minutes');
});

test('relativeTime: hours within the same day', () => {
  assert.equal(relativeTime(NOW -  1 * 3600_000, NOW), 'about an hour ago');
  assert.equal(relativeTime(NOW + 2 * 3600_000, NOW), 'in 2 hours');
  assert.equal(relativeTime(NOW - 3 * 3600_000, NOW), '3 hours ago');
});

// ── relativeTime: same-day time-of-day buckets ────────────────────

test('relativeTime: same day, > 6h offset → time-of-day phrasing', () => {
  // "now" is 14:30; events from earlier-than-6h or later-than-6h on
  // the same day use morning/afternoon/evening/tonight buckets.
  const morningEvent = new Date(2026, 5, 4, 7, 0).getTime();
  assert.equal(relativeTime(morningEvent, NOW), 'this morning at 7am');

  const eveningEvent = new Date(2026, 5, 4, 21, 0).getTime();
  assert.equal(relativeTime(eveningEvent, NOW), 'tonight at 9pm');
});

// ── relativeTime: yesterday / tomorrow ─────────────────────────────

test('relativeTime: yesterday / tomorrow at <clock>', () => {
  const yesterday4pm = new Date(2026, 5, 3, 16, 0).getTime();
  const tomorrow10am = new Date(2026, 5, 5, 10, 0).getTime();
  assert.equal(relativeTime(yesterday4pm, NOW), 'yesterday at 4pm');
  assert.equal(relativeTime(tomorrow10am, NOW), 'tomorrow at 10am');
});

// ── relativeTime: week-scope phrasings ─────────────────────────────

test('relativeTime: past ±2..6 days → "last X" with weekday (unchanged)', () => {
  // Thu Jun 4 2026 is "now". Sat May 30 is 5 days ago (last Saturday).
  const lastSaturday = new Date(2026, 4, 30, 14, 0).getTime();
  assert.equal(relativeTime(lastSaturday, NOW), 'last Saturday at 2pm');
});

test('relativeTime: future 2..6 days → "this X at <clock> (in N days)"', () => {
  // Mon Jun 8 is 4 days ahead (this Monday). The exact day count rides
  // alongside so the model never has to compute the distance itself.
  const thisMonday = new Date(2026, 5, 8, 10, 0).getTime();
  assert.equal(relativeTime(thisMonday, NOW), 'this Monday at 10am (in 4 days)');
});

test('relativeTime: future 7..13 days → "next X at <clock> (in N days)"', () => {
  const nextThursday = new Date(2026, 5, 11, 9, 0).getTime();
  assert.equal(relativeTime(nextThursday, NOW), 'next Thursday at 9am (in 7 days)');
});

test('relativeTime: future 14..21 days → absolute date + clock + exact day count', () => {
  // Jun 25 is 21 days out — too far for a bare weekday name, so the
  // absolute date leads, and ≤3 weeks the day count stays exact.
  const inThreeWeeks = NOW + 21 * 24 * 3600_000;
  assert.equal(relativeTime(inThreeWeeks, NOW), 'Thursday, June 25 at 2:30pm (in 21 days)');
});

test('relativeTime: future coarsens — weeks past 3 weeks, months past ~2 months', () => {
  // 35 days out (exactly 5 weeks) → weeks, not "in 35 days".
  const inFiveWeeks = NOW + 35 * 24 * 3600_000;
  assert.equal(relativeTime(inFiveWeeks, NOW), 'Thursday, July 9 at 2:30pm (in 5 weeks)');
  // Far future → months, not an unwieldy day count.
  const farFuture = new Date(2026, 11, 25, 9, 0).getTime();
  assert.equal(relativeTime(farFuture, NOW), 'Friday, December 25 at 9am (in 7 months)');
});

// ── relativeTime: past month-scope and beyond (phrasing unchanged) ─

test('relativeTime: past 2-4 weeks → "N weeks ago"', () => {
  const twoWeeksAgo = NOW - 14 * 24 * 3600_000;
  assert.equal(relativeTime(twoWeeksAgo, NOW), '2 weeks ago');
});

test('relativeTime: past beyond a month → absolute date ALWAYS carries a relative interval', () => {
  const farPast = new Date(2025, 0, 22, 15, 0).getTime();
  assert.equal(relativeTime(farPast, NOW), 'Wednesday, January 22, 2025 (a year ago)');
});

// ── relativeTime: bad inputs ───────────────────────────────────────

test('relativeTime: bad input → empty string, no throw', () => {
  assert.equal(relativeTime(null, NOW), '');
  assert.equal(relativeTime('not-a-date', NOW), '');
  assert.equal(relativeTime(NOW, 'also-bad'), '');
});

// ── relativeDay (memory-style date strings, no time component) ────

test('relativeDay: today / yesterday / tomorrow', () => {
  assert.equal(relativeDay('2026-06-04', NOW), 'today');
  assert.equal(relativeDay('2026-06-03', NOW), 'yesterday');
  assert.equal(relativeDay('2026-06-05', NOW), 'tomorrow');
});

test('relativeDay: past weekday phrasing unchanged; future carries a day count', () => {
  assert.equal(relativeDay('2026-05-30', NOW), 'last Saturday');
  assert.equal(relativeDay('2026-06-08', NOW), 'this Monday (in 4 days)');
});

test('relativeDay: past weeks unchanged; future ≤3 weeks → absolute date + exact day count', () => {
  assert.equal(relativeDay('2026-05-21', NOW), '2 weeks ago');
  assert.equal(relativeDay('2026-06-25', NOW), 'Thursday, June 25 (in 21 days)');
});

test('relativeDay: future coarsens past 3 weeks → weeks, then months', () => {
  assert.equal(relativeDay('2026-07-09', NOW), 'Thursday, July 9 (in 5 weeks)');
  assert.equal(relativeDay('2026-12-25', NOW), 'Friday, December 25 (in 7 months)');
});

test('relativeDay: beyond a month → past keeps a relative interval', () => {
  assert.equal(relativeDay('2025-01-22', NOW), 'Wednesday, January 22, 2025 (a year ago)');
});

test('relativeDay: bad input → empty string', () => {
  assert.equal(relativeDay('not-a-date', NOW), '');
  assert.equal(relativeDay(null, NOW), '');
});

// ── dayAndDate ─────────────────────────────────────────────────────

test('dayAndDate: weekday + month + day, no year by default', () => {
  assert.equal(dayAndDate(new Date(2026, 5, 4)), 'Thursday, June 4');
  assert.equal(dayAndDate(new Date(2026, 0, 1), { withYear: true }), 'Thursday, January 1, 2026');
});

// ── buildTimeAnchorBlock ───────────────────────────────────────────

test('buildTimeAnchorBlock: always includes the [Now] header + clock + UTC offset + weekday/date', () => {
  const block = buildTimeAnchorBlock({ now: NOW });
  assert.match(block, /^\[Now\]/);
  assert.match(block, /Now: 2:30pm \(UTC[+-]\d{2}:\d{2}\) on Thursday, June 4\./);
});

test('buildTimeAnchorBlock: adds last-message line with absolute clock + interval', () => {
  // NOW = 14:30; subtracting 12 min puts the prior message at 14:18 → "2:18pm".
  const block = buildTimeAnchorBlock({
    now: NOW,
    lastUserMessageAt: new Date(NOW - 12 * 60_000).toISOString(),
  });
  assert.match(block, /Before this, my human last sent a message at 2:18pm, which was 12 minutes ago\./);
});

test('buildTimeAnchorBlock: omits last-message line when lastUserMessageAt is null/missing', () => {
  const block = buildTimeAnchorBlock({ now: NOW });
  assert.doesNotMatch(block, /last sent a message/);
});

test('buildTimeAnchorBlock: bad lastUserMessageAt → omitted, no throw', () => {
  const block = buildTimeAnchorBlock({ now: NOW, lastUserMessageAt: 'not-a-date' });
  assert.doesNotMatch(block, /last sent a message/);
  assert.match(block, /\[Now\]/);
});

// ── plainInterval ──────────────────────────────────────────────────

test('plainInterval: minutes', () => {
  assert.equal(plainInterval(NOW - 30 * 1000, NOW), 'less than a minute');
  assert.equal(plainInterval(NOW - 1 * 60_000, NOW), 'a minute');
  assert.equal(plainInterval(NOW - 20 * 60_000, NOW), '20 minutes');
});

test('plainInterval: hours (no "at HH:MM" suffix, no "ago" suffix)', () => {
  assert.equal(plainInterval(NOW - 1 * 3600_000, NOW), 'about an hour');
  assert.equal(plainInterval(NOW - 4 * 3600_000, NOW), '4 hours');
});

test('plainInterval: days', () => {
  assert.equal(plainInterval(NOW - 1 * 86_400_000, NOW), 'a day');
  assert.equal(plainInterval(NOW - 3 * 86_400_000, NOW), '3 days');
});

test('plainInterval: weeks', () => {
  assert.equal(plainInterval(NOW - 7 * 86_400_000, NOW), 'a week');
  assert.equal(plainInterval(NOW - 21 * 86_400_000, NOW), '3 weeks');
});

test('plainInterval: months and years (deep history)', () => {
  assert.equal(plainInterval(NOW - 60 * 86_400_000, NOW), '2 months');
  assert.equal(plainInterval(NOW - 365 * 86_400_000, NOW), 'a year');
});

test('plainInterval: bad input → empty string', () => {
  assert.equal(plainInterval(null, NOW), '');
  assert.equal(plainInterval('not-a-date', NOW), '');
});
