import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAvailability,
  formatAvailabilityLines,
  buildAvailabilityBlock,
  DAY_PARTS,
} from '../src/schedule/schedule-availability.js';

// Fixed local "now" anchoring all test fixtures. Tests build nodes on the
// same local day so date comparisons are deterministic.
const NOW_MS = new Date(2026, 6, 6, 8, 0, 0).getTime(); // Mon Jul 6 2026, 08:00 local

// ── computeAvailability ─────────────────────────────────────────────

test('computeAvailability: empty nodes → all free', () => {
  const avail = computeAvailability([], { nowMs: NOW_MS, days: 3 });
  assert.strictEqual(avail.length, 3, 'Should return 3 days');
  avail.forEach((day, i) => {
    assert.strictEqual(day.parts.morning, 'free', `Day ${i} morning should be free`);
    assert.strictEqual(day.parts.afternoon, 'free', `Day ${i} afternoon should be free`);
    assert.strictEqual(day.parts.evening, 'free', `Day ${i} evening should be free`);
  });
});

test('computeAvailability: event at 15:00 today → afternoon busy', () => {
  const nodes = [{
    type: 'event',
    label: 'appointment',
    when: '2026-07-06T15:00:00',
    end: '2026-07-06T16:00:00',
  }];
  const avail = computeAvailability(nodes, { nowMs: NOW_MS, days: 1 });
  assert.strictEqual(avail[0].parts.morning, 'free');
  assert.strictEqual(avail[0].parts.afternoon, 'busy');
  assert.strictEqual(avail[0].parts.evening, 'free');
});

test('computeAvailability: hold at 09:00–10:00 today → morning busy', () => {
  const nodes = [{
    type: 'hold',
    label: 'rest day',
    when: '2026-07-06T09:00:00',
    end: '2026-07-06T10:00:00',
  }];
  const avail = computeAvailability(nodes, { nowMs: NOW_MS, days: 1 });
  assert.strictEqual(avail[0].parts.morning, 'busy');
  assert.strictEqual(avail[0].parts.afternoon, 'free');
  assert.strictEqual(avail[0].parts.evening, 'free');
});

test('computeAvailability: all-day event (payload.all_day) → all parts busy', () => {
  const nodes = [{
    type: 'event',
    label: 'full day',
    payload: { all_day: true },
    when: '2026-07-06T00:00:00',  // Must have full timestamp for parsing
    end: '2026-07-06T23:59:59',
  }];
  const avail = computeAvailability(nodes, { nowMs: NOW_MS, days: 1 });
  assert.strictEqual(avail[0].parts.morning, 'busy');
  assert.strictEqual(avail[0].parts.afternoon, 'busy');
  assert.strictEqual(avail[0].parts.evening, 'busy');
});

test('computeAvailability: date-only when (≤10 chars) → all-day busy', () => {
  // An all-day item can arrive with a bare date and no time at all (Google
  // all-day events, hand-entered dates). It has no minutes to parse — only a
  // day to occupy — so the whole day is busy.
  const nodes = [{
    type: 'event',
    label: 'all day',
    when: '2026-07-06',
  }];
  const avail = computeAvailability(nodes, { nowMs: NOW_MS, days: 1 });
  assert.strictEqual(avail[0].parts.morning, 'busy');
  assert.strictEqual(avail[0].parts.afternoon, 'busy');
  assert.strictEqual(avail[0].parts.evening, 'busy');
});

test('computeAvailability: payload.all_day with full timestamp → all-day busy', () => {
  const nodes = [{
    type: 'event',
    label: 'all day',
    payload: { all_day: true },
    when: '2026-07-06T00:00:00',
  }];
  const avail = computeAvailability(nodes, { nowMs: NOW_MS, days: 1 });
  assert.strictEqual(avail[0].parts.morning, 'busy');
  assert.strictEqual(avail[0].parts.afternoon, 'busy');
  assert.strictEqual(avail[0].parts.evening, 'busy');
});

test('computeAvailability: date-only when outside the window → not counted', () => {
  const nodes = [{
    type: 'event',
    label: 'far away all-day',
    when: '2026-08-20',
  }];
  const avail = computeAvailability(nodes, { nowMs: NOW_MS, days: 3 });
  avail.forEach(day => {
    assert.strictEqual(day.parts.morning, 'free');
  });
});

test('computeAvailability: task (type task) → not busy', () => {
  const nodes = [{
    type: 'task',
    label: 'to do',
    when: '2026-07-06T15:00:00',
  }];
  const avail = computeAvailability(nodes, { nowMs: NOW_MS, days: 1 });
  assert.strictEqual(avail[0].parts.afternoon, 'free');
});

test('computeAvailability: resolved event → not busy', () => {
  const nodes = [{
    type: 'event',
    label: 'done',
    resolution: 'done',
    when: '2026-07-06T15:00:00',
    end: '2026-07-06T16:00:00',
  }];
  const avail = computeAvailability(nodes, { nowMs: NOW_MS, days: 1 });
  assert.strictEqual(avail[0].parts.afternoon, 'free');
});

test('computeAvailability: event outside window → not counted', () => {
  const nodes = [{
    type: 'event',
    label: 'far future',
    when: '2026-07-10T15:00:00',  // Day 5, but days:3 only covers days 0-2
    end: '2026-07-10T16:00:00',
  }];
  const avail = computeAvailability(nodes, { nowMs: NOW_MS, days: 3 });
  avail.forEach(day => {
    assert.strictEqual(day.parts.afternoon, 'free', 'Should not count event outside window');
  });
});

test('computeAvailability: event with no end → ~60 min default block', () => {
  const nodes = [{
    type: 'event',
    label: 'no end',
    when: '2026-07-06T15:00:00',
    // no end → should default to 60 min
  }];
  const avail = computeAvailability(nodes, { nowMs: NOW_MS, days: 1 });
  // 15:00–16:00 is in the afternoon (12:00–17:00)
  assert.strictEqual(avail[0].parts.afternoon, 'busy');
  assert.strictEqual(avail[0].parts.evening, 'free');
});

test('computeAvailability: multiple days', () => {
  const nodes = [{
    type: 'event',
    label: 'today',
    when: '2026-07-06T15:00:00',
    end: '2026-07-06T16:00:00',
  }, {
    type: 'event',
    label: 'tomorrow',
    when: '2026-07-07T09:00:00',
    end: '2026-07-07T10:00:00',
  }];
  const avail = computeAvailability(nodes, { nowMs: NOW_MS, days: 3 });
  assert.strictEqual(avail[0].parts.afternoon, 'busy', 'Day 0 afternoon busy');
  assert.strictEqual(avail[1].parts.morning, 'busy', 'Day 1 morning busy');
  assert.strictEqual(avail[2].parts.morning, 'free', 'Day 2 morning free');
});

// ── formatAvailabilityLines ────────────────────────────────────────────

test('formatAvailabilityLines: all free → "open"', () => {
  const avail = [{ date: '2026-07-06', parts: { morning: 'free', afternoon: 'free', evening: 'free' } }];
  const lines = formatAvailabilityLines(avail);
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /open/);
});

test('formatAvailabilityLines: all busy → "full"', () => {
  const avail = [{ date: '2026-07-06', parts: { morning: 'busy', afternoon: 'busy', evening: 'busy' } }];
  const lines = formatAvailabilityLines(avail);
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /full/);
});

test('formatAvailabilityLines: mixed → names free parts', () => {
  const avail = [{ date: '2026-07-06', parts: { morning: 'free', afternoon: 'busy', evening: 'free' } }];
  const lines = formatAvailabilityLines(avail);
  assert.match(lines[0], /morning.*&.*evening/);
  assert.match(lines[0], /free/);
});

test('formatAvailabilityLines: includes formatted day name', () => {
  const avail = [{ date: '2026-07-06', parts: { morning: 'free', afternoon: 'free', evening: 'free' } }];
  const lines = formatAvailabilityLines(avail);
  // Jul 6 2026 is a Monday
  assert.match(lines[0], /Monday/);
});

// ── buildAvailabilityBlock ────────────────────────────────────────────

test('buildAvailabilityBlock: grant undefined → empty string', () => {
  const block = buildAvailabilityBlock([], { grant: undefined, nowMs: NOW_MS, days: 7 });
  assert.strictEqual(block, '');
});

test('buildAvailabilityBlock: grant "none" → empty string', () => {
  const block = buildAvailabilityBlock([], { grant: 'none', nowMs: NOW_MS, days: 7 });
  assert.strictEqual(block, '');
});

test('buildAvailabilityBlock: grant "coarse" → includes availability, no labels', () => {
  const nodes = [{
    type: 'event',
    label: 'SECRET THERAPY',
    when: '2026-07-06T15:00:00',
    end: '2026-07-06T16:00:00',
  }];
  const block = buildAvailabilityBlock(nodes, { grant: 'coarse', nowMs: NOW_MS, days: 7 });
  assert.strictEqual(block !== '', true, 'Block should be non-empty');
  assert.match(block, /free|busy/i, 'Should mention free or busy');
  assert.strictEqual(block.includes('SECRET THERAPY'), false, 'coarse should not reveal label');
});

test('buildAvailabilityBlock: grant "full" → includes labels', () => {
  const nodes = [{
    type: 'event',
    label: 'SECRET THERAPY',
    when: '2026-07-06T15:00:00',
    end: '2026-07-06T16:00:00',
  }];
  const block = buildAvailabilityBlock(nodes, { grant: 'full', nowMs: NOW_MS, days: 7 });
  assert.strictEqual(block.includes('SECRET THERAPY'), true, 'full should reveal label');
});

test('buildAvailabilityBlock: multiple items with full grant → all labels shown', () => {
  const nodes = [{
    type: 'event',
    label: 'Meeting 1',
    when: '2026-07-06T10:00:00',
    end: '2026-07-06T11:00:00',
  }, {
    type: 'event',
    label: 'Meeting 2',
    when: '2026-07-06T14:00:00',
    end: '2026-07-06T15:00:00',
  }];
  const block = buildAvailabilityBlock(nodes, { grant: 'full', nowMs: NOW_MS, days: 7 });
  assert.strictEqual(block.includes('Meeting 1'), true);
  assert.strictEqual(block.includes('Meeting 2'), true);
});

test('buildAvailabilityBlock: grant "coarse" → multiple items without labels', () => {
  const nodes = [{
    type: 'event',
    label: 'Item 1',
    when: '2026-07-06T10:00:00',
    end: '2026-07-06T11:00:00',
  }, {
    type: 'event',
    label: 'Item 2',
    when: '2026-07-06T14:00:00',
    end: '2026-07-06T15:00:00',
  }];
  const block = buildAvailabilityBlock(nodes, { grant: 'coarse', nowMs: NOW_MS, days: 7 });
  assert.strictEqual(block.includes('Item 1'), false, 'Item 1 should not appear in coarse');
  assert.strictEqual(block.includes('Item 2'), false, 'Item 2 should not appear in coarse');
});

test('buildAvailabilityBlock: mentions "my human"', () => {
  const block = buildAvailabilityBlock([], { grant: 'coarse', nowMs: NOW_MS, days: 7 });
  assert.match(block, /my human/);
});

test('buildAvailabilityBlock: holds count as busy (both grants)', () => {
  const nodes = [{
    type: 'hold',
    label: 'rest',
    when: '2026-07-06T09:00:00',
    end: '2026-07-06T10:00:00',
  }];
  const blockCoarse = buildAvailabilityBlock(nodes, { grant: 'coarse', nowMs: NOW_MS, days: 1 });
  const blockFull = buildAvailabilityBlock(nodes, { grant: 'full', nowMs: NOW_MS, days: 1 });
  // Both should mark the time as busy (coarse doesn't show the label though)
  assert.strictEqual(blockCoarse.includes('rest'), false);
  assert.strictEqual(blockFull.includes('rest'), true);
  // Both should show a busy morning
  assert.match(blockCoarse, /busy/i);
  assert.match(blockFull, /busy/i);
});

console.log('[schedule-availability] All tests passed');
