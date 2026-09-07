import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNeedsLedger,
  isRoutineReviewDue,
  buildRoutineReviewSection,
  routineReviewHardDisabled,
} from '../src/schedule/routine-review.js';

const DAY_MS = 24 * 3600 * 1000;

// ── buildNeedsLedger ───────────────────────────────────────────────

test('buildNeedsLedger: empty needs returns empty array', () => {
  const now = Date.now();
  const result = buildNeedsLedger([], now, 7);
  assert.deepEqual(result, []);
});

test('buildNeedsLedger: need with 2 missed and 3 done within 7 days', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const needNodes = [
    {
      label: 'Dishes',
      payload: {
        resolutions: {
          '2026-06-28': 'done',
          '2026-06-29': 'missed',
          '2026-06-30': 'done',
          '2026-07-01': 'done',
          '2026-07-02': 'missed',
        },
      },
    },
  ];
  const result = buildNeedsLedger(needNodes, now, 7);
  assert.equal(result.length, 1);
  assert.equal(result[0].label, 'Dishes');
  assert.equal(result[0].met, 3);
  assert.equal(result[0].missed, 2);
  assert.equal(result[0].total, 5);
});

test('buildNeedsLedger: excludes resolutions older than days window', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const needNodes = [
    {
      label: 'Exercise',
      payload: {
        resolutions: {
          '2026-06-25': 'done',  // older than 7 days
          '2026-06-28': 'done',  // within 7 days
          '2026-07-02': 'missed',
        },
      },
    },
  ];
  const result = buildNeedsLedger(needNodes, now, 7);
  assert.equal(result.length, 1);
  assert.equal(result[0].met, 1, 'should only count the one from 2026-06-28');
  assert.equal(result[0].missed, 1);
  assert.equal(result[0].total, 2);
});

test('buildNeedsLedger: omits needs with NO in-window resolutions', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const needNodes = [
    {
      label: 'Meditation',
      payload: {
        resolutions: {
          '2026-06-20': 'done',  // older than 7 days
          '2026-06-21': 'done',  // still too old
        },
      },
    },
  ];
  const result = buildNeedsLedger(needNodes, now, 7);
  assert.equal(result.length, 0, 'need with no in-window resolutions should be omitted');
});

test('buildNeedsLedger: sorts by missed DESC (worst first)', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const needNodes = [
    {
      label: 'A - 1 miss',
      payload: {
        resolutions: {
          '2026-07-02': 'missed',
          '2026-07-03': 'done',
        },
      },
    },
    {
      label: 'B - 4 misses',
      payload: {
        resolutions: {
          '2026-06-28': 'missed',
          '2026-06-29': 'missed',
          '2026-06-30': 'missed',
          '2026-07-01': 'missed',
          '2026-07-02': 'done',
        },
      },
    },
  ];
  const result = buildNeedsLedger(needNodes, now, 7);
  assert.equal(result.length, 2);
  assert.equal(result[0].label, 'B - 4 misses', 'worst-first: 4 misses comes first');
  assert.equal(result[1].label, 'A - 1 miss');
});

test('buildNeedsLedger: ignores resolution values other than done/missed', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const needNodes = [
    {
      label: 'Chores',
      payload: {
        resolutions: {
          '2026-07-01': 'done',
          '2026-07-02': 'cancelled',
          '2026-07-03': 'missed',
          '2026-07-04': 'deferred',
        },
      },
    },
  ];
  const result = buildNeedsLedger(needNodes, now, 7);
  assert.equal(result.length, 1);
  assert.equal(result[0].met, 1, 'only done');
  assert.equal(result[0].missed, 1, 'only missed');
  assert.equal(result[0].total, 2, 'only done + missed, not cancelled/deferred');
});

test('buildNeedsLedger: uses fallback label "(unnamed need)" when missing', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const needNodes = [
    {
      payload: {
        resolutions: {
          '2026-07-02': 'done',
        },
      },
    },
  ];
  const result = buildNeedsLedger(needNodes, now, 7);
  assert.equal(result.length, 1);
  assert.equal(result[0].label, '(unnamed need)');
});

test('buildNeedsLedger: handles invalid date strings gracefully', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const needNodes = [
    {
      label: 'Test',
      payload: {
        resolutions: {
          'invalid-date': 'done',
          '2026-07-02': 'missed',
        },
      },
    },
  ];
  const result = buildNeedsLedger(needNodes, now, 7);
  assert.equal(result.length, 1);
  assert.equal(result[0].met, 0);
  assert.equal(result[0].missed, 1, 'invalid date should be skipped');
});

// ── isRoutineReviewDue ─────────────────────────────────────────────

test('isRoutineReviewDue: returns false when cadence not elapsed', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const lastReviewAt = now - 2 * DAY_MS;  // 2 days ago
  const ledger = [{ label: 'Dishes', met: 1, missed: 1, total: 2 }];
  const result = isRoutineReviewDue({ lastReviewAt, nowMs: now, reviewDays: 7, ledger });
  assert.equal(result, false, 'should be false when cadence not elapsed (2 < 7 days)');
});

test('isRoutineReviewDue: returns true when cadence elapsed and ledger has miss', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const lastReviewAt = now - 8 * DAY_MS;  // 8 days ago
  const ledger = [{ label: 'Dishes', met: 1, missed: 1, total: 2 }];
  const result = isRoutineReviewDue({ lastReviewAt, nowMs: now, reviewDays: 7, ledger });
  assert.equal(result, true, 'should be true when cadence elapsed and miss exists');
});

test('isRoutineReviewDue: returns false when cadence elapsed but ledger all met', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const lastReviewAt = now - 8 * DAY_MS;
  const ledger = [{ label: 'Dishes', met: 5, missed: 0, total: 5 }];
  const result = isRoutineReviewDue({ lastReviewAt, nowMs: now, reviewDays: 7, ledger });
  assert.equal(result, false, 'should be false when all met (no misses)');
});

test('isRoutineReviewDue: returns true when lastReviewAt=0 (never) and miss exists', () => {
  const now = Date.now();
  const ledger = [{ label: 'Dishes', met: 1, missed: 1, total: 2 }];
  const result = isRoutineReviewDue({ lastReviewAt: 0, nowMs: now, reviewDays: 7, ledger });
  assert.equal(result, true, 'should be true when never reviewed and miss exists');
});

test('isRoutineReviewDue: returns false when ledger is empty', () => {
  const now = Date.now();
  const lastReviewAt = now - 8 * DAY_MS;
  const ledger = [];
  const result = isRoutineReviewDue({ lastReviewAt, nowMs: now, reviewDays: 7, ledger });
  assert.equal(result, false, 'should be false when ledger is empty (no misses)');
});

test('isRoutineReviewDue: returns true when exactly reviewDays have elapsed and miss exists', () => {
  const now = Date.now();
  const lastReviewAt = now - 7 * DAY_MS;  // exactly 7 days
  const ledger = [{ label: 'Dishes', met: 0, missed: 1, total: 1 }];
  const result = isRoutineReviewDue({ lastReviewAt, nowMs: now, reviewDays: 7, ledger });
  assert.equal(result, true, 'should be true at exact boundary');
});

// ── buildRoutineReviewSection ──────────────────────────────────────

test('buildRoutineReviewSection: contains "ROUTINE REVIEW" phrase', () => {
  const ledger = [{ label: 'Dishes', met: 2, missed: 3, total: 5 }];
  const result = buildRoutineReviewSection(ledger);
  assert.match(result, /ROUTINE REVIEW/i);
});

test('buildRoutineReviewSection: contains "routine_review" instruction keyword', () => {
  const ledger = [{ label: 'Dishes', met: 2, missed: 3, total: 5 }];
  const result = buildRoutineReviewSection(ledger);
  assert.match(result, /routine_review/);
});

test('buildRoutineReviewSection: contains ledger labels and counts', () => {
  const ledger = [
    { label: 'Dishes', met: 2, missed: 3, total: 5 },
    { label: 'Exercise', met: 4, missed: 1, total: 5 },
  ];
  const result = buildRoutineReviewSection(ledger);
  assert.match(result, /Dishes/);
  assert.match(result, /met 2, missed 3/);
  assert.match(result, /Exercise/);
  assert.match(result, /met 4, missed 1/);
});

test('buildRoutineReviewSection: contains pivot words (shrink, shelve, not ready)', () => {
  const ledger = [{ label: 'Dishes', met: 1, missed: 2, total: 3 }];
  const result = buildRoutineReviewSection(ledger);
  assert.match(result, /shrink/i);
  assert.match(result, /shelve/i);
  assert.match(result, /not ready/i);
});

test('buildRoutineReviewSection: empty ledger still renders the section', () => {
  const result = buildRoutineReviewSection([]);
  assert.match(result, /ROUTINE REVIEW/i);
  assert.match(result, /routine_review/);
  assert.match(result, /shrink/i);
});

// ── routineReviewHardDisabled ──────────────────────────────────────

test('routineReviewHardDisabled: returns false when env var not set', () => {
  const oldEnv = process.env.PROTO_FAMILIAR_ROUTINE_REVIEW_DISABLED;
  try {
    delete process.env.PROTO_FAMILIAR_ROUTINE_REVIEW_DISABLED;
    const result = routineReviewHardDisabled();
    assert.equal(result, false);
  } finally {
    if (oldEnv) process.env.PROTO_FAMILIAR_ROUTINE_REVIEW_DISABLED = oldEnv;
  }
});

test('routineReviewHardDisabled: returns true when env var is "1"', () => {
  const oldEnv = process.env.PROTO_FAMILIAR_ROUTINE_REVIEW_DISABLED;
  try {
    process.env.PROTO_FAMILIAR_ROUTINE_REVIEW_DISABLED = '1';
    const result = routineReviewHardDisabled();
    assert.equal(result, true);
  } finally {
    if (oldEnv) process.env.PROTO_FAMILIAR_ROUTINE_REVIEW_DISABLED = oldEnv;
    else delete process.env.PROTO_FAMILIAR_ROUTINE_REVIEW_DISABLED;
  }
});

test('routineReviewHardDisabled: returns false when env var is "0"', () => {
  const oldEnv = process.env.PROTO_FAMILIAR_ROUTINE_REVIEW_DISABLED;
  try {
    process.env.PROTO_FAMILIAR_ROUTINE_REVIEW_DISABLED = '0';
    const result = routineReviewHardDisabled();
    assert.equal(result, false);
  } finally {
    if (oldEnv) process.env.PROTO_FAMILIAR_ROUTINE_REVIEW_DISABLED = oldEnv;
    else delete process.env.PROTO_FAMILIAR_ROUTINE_REVIEW_DISABLED;
  }
});

test('routineReviewHardDisabled: returns false when env var is other value', () => {
  const oldEnv = process.env.PROTO_FAMILIAR_ROUTINE_REVIEW_DISABLED;
  try {
    process.env.PROTO_FAMILIAR_ROUTINE_REVIEW_DISABLED = 'true';
    const result = routineReviewHardDisabled();
    assert.equal(result, false, 'only "1" is true');
  } finally {
    if (oldEnv) process.env.PROTO_FAMILIAR_ROUTINE_REVIEW_DISABLED = oldEnv;
    else delete process.env.PROTO_FAMILIAR_ROUTINE_REVIEW_DISABLED;
  }
});
