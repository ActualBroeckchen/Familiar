import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  tierAtLeastModerate,
  parseHHMM,
  minutesToHHMM,
  medianHHMM,
  selectDocket,
  buildOpeningBrief,
  selectReadiness,
  buildStewardshipBlock,
  recordRoutineReview,
  readStewardshipState,
} from '../src/schedule/stewardship.js';

// ── tierAtLeastModerate ────────────────────────────────────────────
test('tierAtLeastModerate: true for moderate, high, severe', () => {
  assert.equal(tierAtLeastModerate('moderate'), true);
  assert.equal(tierAtLeastModerate('high'), true);
  assert.equal(tierAtLeastModerate('severe'), true);
});

test('tierAtLeastModerate: false for calm, mild', () => {
  assert.equal(tierAtLeastModerate('calm'), false);
  assert.equal(tierAtLeastModerate('mild'), false);
});

test('tierAtLeastModerate: false for unknown/undefined', () => {
  assert.equal(tierAtLeastModerate('unknown'), false);
  assert.equal(tierAtLeastModerate(undefined), false);
  assert.equal(tierAtLeastModerate(null), false);
  assert.equal(tierAtLeastModerate(''), false);
});

// ── parseHHMM ──────────────────────────────────────────────────────
test('parseHHMM: parses 09:30 to 570', () => {
  assert.equal(parseHHMM('09:30'), 570);
});

test('parseHHMM: parses 00:00 to 0', () => {
  assert.equal(parseHHMM('00:00'), 0);
});

test('parseHHMM: parses 23:59 to 1439', () => {
  assert.equal(parseHHMM('23:59'), 1439);
});

test('parseHHMM: parses single-digit hours', () => {
  assert.equal(parseHHMM('9:30'), 570);
  assert.equal(parseHHMM('1:00'), 60);
});

test('parseHHMM: requires two-digit minutes', () => {
  assert.equal(parseHHMM('9:5'), null, '9:5 should be null');
  assert.equal(parseHHMM('9:05'), 545);
});

test('parseHHMM: rejects invalid hours', () => {
  assert.equal(parseHHMM('24:00'), null);
  assert.equal(parseHHMM('25:00'), null);
});

test('parseHHMM: rejects invalid minutes', () => {
  assert.equal(parseHHMM('12:60'), null);
  assert.equal(parseHHMM('12:61'), null);
});

test('parseHHMM: rejects invalid strings', () => {
  assert.equal(parseHHMM('x'), null);
  assert.equal(parseHHMM(''), null);
  assert.equal(parseHHMM('12:3x'), null);
});

test('parseHHMM: handles undefined/null', () => {
  assert.equal(parseHHMM(undefined), null);
  assert.equal(parseHHMM(null), null);
});

// ── minutesToHHMM ──────────────────────────────────────────────────
test('minutesToHHMM: converts 570 to "09:30"', () => {
  assert.equal(minutesToHHMM(570), '09:30');
});

test('minutesToHHMM: converts 0 to "00:00"', () => {
  assert.equal(minutesToHHMM(0), '00:00');
});

test('minutesToHHMM: converts 1439 to "23:59"', () => {
  assert.equal(minutesToHHMM(1439), '23:59');
});

test('minutesToHHMM: zero-pads both hours and minutes', () => {
  assert.equal(minutesToHHMM(65), '01:05');
  assert.equal(minutesToHHMM(605), '10:05');
});

test('minutesToHHMM: wraps at 1440 (24 hours)', () => {
  assert.equal(minutesToHHMM(1440), '00:00');
  assert.equal(minutesToHHMM(1441), '00:01');
});

test('minutesToHHMM: handles negative wrapping', () => {
  assert.equal(minutesToHHMM(-1), '23:59');
  assert.equal(minutesToHHMM(-60), '23:00');
});

test('minutesToHHMM: rounds to nearest minute', () => {
  assert.equal(minutesToHHMM(570.4), '09:30');
  assert.equal(minutesToHHMM(570.5), '09:31');
});

// ── medianHHMM ────────────────────────────────────────────────────
test('medianHHMM: empty array returns null', () => {
  assert.equal(medianHHMM([]), null);
});

test('medianHHMM: single sample returns that sample', () => {
  assert.equal(medianHHMM(['09:30']), '09:30');
});

test('medianHHMM: odd count returns middle sample', () => {
  assert.equal(medianHHMM(['09:00', '10:00', '11:00']), '10:00');
});

test('medianHHMM: even count averages the two middles', () => {
  // ['09:00', '10:00', '11:00', '12:00'] → average of 10:00 (600) and 11:00 (660) = 630 = 10:30
  const result = medianHHMM(['09:00', '10:00', '11:00', '12:00']);
  assert.equal(result, '10:30');
});

test('medianHHMM: sorts before finding median', () => {
  // Out-of-order: [11:00, 09:00, 10:00] → sorted: [09:00, 10:00, 11:00] → median: 10:00
  assert.equal(medianHHMM(['11:00', '09:00', '10:00']), '10:00');
});

test('medianHHMM: ignores null/invalid samples', () => {
  // ['09:00', 'invalid', '10:00', '11:00'] → filters to [09:00, 10:00, 11:00] → median: 10:00
  assert.equal(medianHHMM(['09:00', 'invalid', '10:00', '11:00']), '10:00');
});

// ── selectDocket ───────────────────────────────────────────────────
test('selectDocket: empty items returns empty array', () => {
  const result = selectDocket({ items: [], nowMs: Date.now() });
  assert.deepEqual(result, []);
});

test('selectDocket: filters out scheduled tasks (has when)', () => {
  const items = [
    { id: '1', type: 'task', when: '2026-07-10T10:00:00', created_at: '2026-07-01T10:00:00' },
  ];
  const result = selectDocket({ items, nowMs: Date.now() });
  assert.deepEqual(result, []);
});

test('selectDocket: filters out resolved tasks', () => {
  const items = [
    { id: '1', type: 'task', when: null, resolution: 'completed', created_at: '2026-07-01T10:00:00' },
  ];
  const result = selectDocket({ items, nowMs: Date.now() });
  assert.deepEqual(result, []);
});

test('selectDocket: filters out events', () => {
  const items = [
    { id: '1', type: 'event', when: null, created_at: '2026-07-01T10:00:00' },
  ];
  const result = selectDocket({ items, nowMs: Date.now() });
  assert.deepEqual(result, []);
});

test('selectDocket: includes floating tasks (no when, no resolution)', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime(); // Jul 4 2026
  const fiveDaysAgo = new Date(2026, 5, 29, 10, 0, 0).getTime(); // Jun 29
  const items = [
    { id: 'task1', label: 'Learn rust', type: 'task', when: null, created_at: new Date(fiveDaysAgo).toISOString() },
  ];
  const result = selectDocket({ items, nowMs: now, minAgeDays: 3 });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'task1');
  assert.equal(result[0].label, 'Learn rust');
  assert.equal(result[0].ageDays, 5);
});

test('selectDocket: filters by minAgeDays', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const twoDaysAgo = new Date(2026, 6, 2, 10, 0, 0).getTime();
  const items = [
    { id: '1', label: 'Old task', type: 'task', when: null, created_at: new Date(twoDaysAgo).toISOString() },
  ];
  const result = selectDocket({ items, nowMs: now, minAgeDays: 3 });
  assert.deepEqual(result, []);
});

test('selectDocket: respects cooldown exclusion', () => {
  const now = Date.now();
  const oneHourAgo = now - 3600 * 1000;
  const items = [
    { id: 'task1', label: 'Old', type: 'task', when: null, created_at: new Date(now - 10 * 24 * 3600 * 1000).toISOString() },
  ];
  const cooldownMs = 24 * 3600 * 1000; // 1 day
  const offeredAt = { task1: oneHourAgo }; // offered 1 hour ago
  const result = selectDocket({ items, nowMs: now, minAgeDays: 0, offeredAt, cooldownMs });
  assert.deepEqual(result, [], 'task should be excluded (within cooldown)');
});

test('selectDocket: includes item outside cooldown', () => {
  const now = Date.now();
  const twoHoursAgo = now - 2 * 3600 * 1000;
  const items = [
    { id: 'task1', label: 'Old', type: 'task', when: null, created_at: new Date(now - 10 * 24 * 3600 * 1000).toISOString() },
  ];
  const cooldownMs = 3600 * 1000; // 1 hour
  const offeredAt = { task1: twoHoursAgo }; // offered 2 hours ago
  const result = selectDocket({ items, nowMs: now, minAgeDays: 0, offeredAt, cooldownMs });
  assert.equal(result.length, 1, 'task should be included (outside cooldown)');
});

test('selectDocket: sorts oldest-first (highest ageDays first)', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const items = [
    { id: '1', label: 'Newer', type: 'task', when: null, created_at: new Date(2026, 6, 1, 10, 0, 0).toISOString() },
    { id: '2', label: 'Oldest', type: 'task', when: null, created_at: new Date(2026, 5, 25, 10, 0, 0).toISOString() },
    { id: '3', label: 'Middle', type: 'task', when: null, created_at: new Date(2026, 5, 28, 10, 0, 0).toISOString() },
  ];
  const result = selectDocket({ items, nowMs: now, minAgeDays: 0, max: 3 });
  assert.deepEqual(result.map(r => r.id), ['2', '3', '1']);
});

test('selectDocket: respects max parameter', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const items = [
    { id: '1', label: 'A', type: 'task', when: null, created_at: new Date(2026, 5, 20, 10, 0, 0).toISOString() },
    { id: '2', label: 'B', type: 'task', when: null, created_at: new Date(2026, 5, 21, 10, 0, 0).toISOString() },
    { id: '3', label: 'C', type: 'task', when: null, created_at: new Date(2026, 5, 22, 10, 0, 0).toISOString() },
  ];
  const result = selectDocket({ items, nowMs: now, minAgeDays: 0, max: 2 });
  assert.equal(result.length, 2);
});

test('selectDocket: uses label fallback when missing', () => {
  const now = Date.now();
  const items = [
    { id: 'id-1', type: 'task', when: null, created_at: new Date(now - 10 * 24 * 3600 * 1000).toISOString() },
  ];
  const result = selectDocket({ items, nowMs: now, minAgeDays: 0 });
  assert.equal(result[0].label, 'id-1');
});

// ── buildOpeningBrief ──────────────────────────────────────────────
test('buildOpeningBrief: empty items returns "clear stretch" message', () => {
  const now = Date.now();
  const result = buildOpeningBrief({ items: [], nowMs: now });
  assert.match(result, /clear stretch/);
});

test('buildOpeningBrief: lists dated items in window', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime(); // Jul 4, 10:00 local
  const tomorrow = new Date(2026, 6, 5, 14, 0, 0).toISOString().slice(0, 19); // Jul 5, 14:00
  const items = [
    { label: 'Meeting', type: 'event', when: tomorrow, resolution: null },
  ];
  const result = buildOpeningBrief({ items, nowMs: now, lookaheadDays: 3, wardTimeZone: null });
  assert.match(result, /Meeting/);
  assert.match(result, /\[event\]/);
});

test('buildOpeningBrief: excludes items outside lookahead window', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const farFuture = new Date(2026, 6, 12, 14, 0, 0).toISOString().slice(0, 19); // 8 days ahead
  const items = [
    { label: 'Distant event', type: 'event', when: farFuture, resolution: null },
  ];
  const result = buildOpeningBrief({ items, nowMs: now, lookaheadDays: 3, wardTimeZone: null });
  assert.doesNotMatch(result, /Distant event/);
  assert.match(result, /clear stretch/);
});

test('buildOpeningBrief: excludes items before current time', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const past = new Date(2026, 7, 4, 9, 0, 0).toISOString().slice(0, 19); // before now
  const items = [
    { label: 'Past event', type: 'event', when: past, resolution: null },
  ];
  const result = buildOpeningBrief({ items, nowMs: now, lookaheadDays: 3, wardTimeZone: null });
  assert.doesNotMatch(result, /Past event/);
});

test('buildOpeningBrief: includes items in the past hour (lower bound is -1h)', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const recentPast = new Date(2026, 6, 4, 9, 30, 0).toISOString().slice(0, 19); // 30 min ago
  const items = [
    { label: 'Recent event', type: 'event', when: recentPast, resolution: null },
  ];
  const result = buildOpeningBrief({ items, nowMs: now, lookaheadDays: 3, wardTimeZone: null });
  assert.match(result, /Recent event/);
});

test('buildOpeningBrief: excludes resolved items', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const tomorrow = new Date(2026, 6, 5, 14, 0, 0).toISOString().slice(0, 19);
  const items = [
    { label: 'Done event', type: 'event', when: tomorrow, resolution: 'completed' },
  ];
  const result = buildOpeningBrief({ items, nowMs: now, lookaheadDays: 3, wardTimeZone: null });
  assert.doesNotMatch(result, /Done event/);
});

test('buildOpeningBrief: includes tasks, reminders, holds (not just events)', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const tomorrow = new Date(2026, 6, 5, 14, 0, 0).toISOString().slice(0, 19);
  const items = [
    { label: 'Task due', type: 'task', when: tomorrow, resolution: null },
    { label: 'Reminder', type: 'reminder', when: tomorrow, resolution: null },
    { label: 'Hold', type: 'hold', when: tomorrow, resolution: null },
  ];
  const result = buildOpeningBrief({ items, nowMs: now, lookaheadDays: 3, wardTimeZone: null });
  assert.match(result, /Task due/);
  assert.match(result, /Reminder/);
  assert.match(result, /Hold/);
});

test('buildOpeningBrief: sorts items chronologically', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const t1 = new Date(2026, 6, 5, 14, 0, 0).toISOString().slice(0, 19);
  const t2 = new Date(2026, 6, 5, 10, 0, 0).toISOString().slice(0, 19);
  const items = [
    { label: 'Later', type: 'event', when: t1, resolution: null },
    { label: 'Earlier', type: 'event', when: t2, resolution: null },
  ];
  const result = buildOpeningBrief({ items, nowMs: now, lookaheadDays: 3, wardTimeZone: null });
  const earlierPos = result.indexOf('Earlier');
  const laterPos = result.indexOf('Later');
  assert(earlierPos < laterPos, 'Earlier should appear before Later');
});

// ── buildStewardshipBlock ──────────────────────────────────────────
test('buildStewardshipBlock: returns empty when staticOnly=true', async () => {
  const result = await buildStewardshipBlock({ staticOnly: true });
  assert.equal(result, '');
});

test('buildStewardshipBlock: returns empty when stewardshipEnabled=false', async () => {
  const result = await buildStewardshipBlock({
    staticOnly: false,
    settings: { stewardshipEnabled: false },
  });
  assert.equal(result, '');
});

test('buildStewardshipBlock: returns empty when threat.tier is moderate+', async () => {
  for (const tier of ['moderate', 'high', 'severe']) {
    const result = await buildStewardshipBlock({
      staticOnly: false,
      settings: { stewardshipEnabled: true },
      threat: { tier },
    });
    assert.equal(result, '', `Should be empty for threat tier "${tier}"`);
  }
});

test('buildStewardshipBlock: returns empty when PROTO_FAMILIAR_STEWARDSHIP_DISABLED=1', async () => {
  const oldEnv = process.env.PROTO_FAMILIAR_STEWARDSHIP_DISABLED;
  try {
    process.env.PROTO_FAMILIAR_STEWARDSHIP_DISABLED = '1';
    const result = await buildStewardshipBlock({
      staticOnly: false,
      settings: { stewardshipEnabled: true },
      threat: { tier: 'calm' },
    });
    assert.equal(result, '');
  } finally {
    process.env.PROTO_FAMILIAR_STEWARDSHIP_DISABLED = oldEnv;
  }
});

test('buildStewardshipBlock: opening brief fires when past anchor and after gap', async () => {
  const tomesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stew-'));
  try {
    const now = new Date(2026, 6, 4, 10, 0, 0).getTime(); // Local 10:00
    const fiveHoursAgo = new Date(2026, 6, 4, 5, 0, 0).toISOString(); // 5 hours before
    const result = await buildStewardshipBlock({
      liveTurn: true,
      staticOnly: false,
      threat: { tier: 'calm' },
      settings: {
        stewardshipEnabled: true,
        dayStartAnchor: '09:00',
      },
      nowMs: now,
      lastUserMessageAt: fiveHoursAgo,
      scheduleItems: [],
      wardTimeZone: null,
      tomesDir,
    });
    assert.match(result, /\[My stewardship/);
    assert.match(result, /just arrived/);
  } finally {
    fs.rmSync(tomesDir, { recursive: true });
  }
});

test('buildStewardshipBlock: opening brief does NOT fire twice on same day', async () => {
  const tomesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stew-'));
  try {
    const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
    const fiveHoursAgo = new Date(2026, 6, 4, 5, 0, 0).toISOString();

    // First call
    const result1 = await buildStewardshipBlock({
      liveTurn: true,
      staticOnly: false,
      threat: { tier: 'calm' },
      settings: { stewardshipEnabled: true, dayStartAnchor: '09:00' },
      nowMs: now,
      lastUserMessageAt: fiveHoursAgo,
      scheduleItems: [],
      wardTimeZone: null,
      tomesDir,
    });
    assert.match(result1, /just arrived/);

    // Second call same day/same now
    const result2 = await buildStewardshipBlock({
      liveTurn: true,
      staticOnly: false,
      threat: { tier: 'calm' },
      settings: { stewardshipEnabled: true, dayStartAnchor: '09:00' },
      nowMs: now,
      lastUserMessageAt: fiveHoursAgo,
      scheduleItems: [],
      wardTimeZone: null,
      tomesDir,
    });
    assert.doesNotMatch(result2, /just arrived/, 'Brief should not fire twice');
  } finally {
    fs.rmSync(tomesDir, { recursive: true });
  }
});

test('buildStewardshipBlock: opening brief does NOT fire when gap < minGapHours', async () => {
  const tomesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stew-'));
  try {
    const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
    const oneMinuteAgo = new Date(2026, 6, 4, 9, 59, 0).toISOString(); // Only 1 minute ago
    const result = await buildStewardshipBlock({
      liveTurn: true,
      staticOnly: false,
      threat: { tier: 'calm' },
      settings: { stewardshipEnabled: true, dayStartAnchor: '09:00', dayStartGapHours: 3 },
      nowMs: now,
      lastUserMessageAt: oneMinuteAgo,
      scheduleItems: [],
      wardTimeZone: null,
      tomesDir,
    });
    assert.doesNotMatch(result, /just arrived/, 'Brief should not fire within gap');
  } finally {
    fs.rmSync(tomesDir, { recursive: true });
  }
});

test('buildStewardshipBlock: opening brief does NOT fire before anchor', async () => {
  const tomesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stew-'));
  try {
    const now = new Date(2026, 6, 4, 6, 0, 0).getTime(); // Local 06:00 (before 09:00 anchor)
    const fiveHoursAgo = new Date(2026, 6, 4, 1, 0, 0).toISOString();
    const result = await buildStewardshipBlock({
      liveTurn: true,
      staticOnly: false,
      threat: { tier: 'calm' },
      settings: { stewardshipEnabled: true, dayStartAnchor: '09:00' },
      nowMs: now,
      lastUserMessageAt: fiveHoursAgo,
      scheduleItems: [],
      wardTimeZone: null,
      tomesDir,
    });
    assert.doesNotMatch(result, /just arrived/, 'Brief should not fire before anchor');
  } finally {
    fs.rmSync(tomesDir, { recursive: true });
  }
});

test('buildStewardshipBlock: docket surfaces floating tasks', async () => {
  const tomesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stew-'));
  try {
    const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
    const oneMinuteAgo = new Date(2026, 6, 4, 9, 59, 0).toISOString(); // Recent, no brief
    const fiveDaysAgo = new Date(2026, 6, 4, 10, 0, 0).getTime() - 5 * 24 * 3600 * 1000;
    const items = [
      {
        id: 'float-1',
        label: 'Floating task',
        type: 'task',
        when: null,
        resolution: null,
        created_at: new Date(fiveDaysAgo).toISOString(),
      },
    ];
    const result = await buildStewardshipBlock({
      liveTurn: true,
      staticOnly: false,
      threat: { tier: 'calm' },
      settings: { stewardshipEnabled: true, dayStartAnchor: '09:00', docketMinAgeDays: 3 },
      nowMs: now,
      lastUserMessageAt: oneMinuteAgo,
      scheduleItems: items,
      wardTimeZone: null,
      tomesDir,
    });
    assert.match(result, /Floating task/);
    assert.match(result, /floating/);
  } finally {
    fs.rmSync(tomesDir, { recursive: true });
  }
});

test('buildStewardshipBlock: does NOT write state when liveTurn=false', async () => {
  const tomesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stew-'));
  try {
    const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
    const fiveHoursAgo = new Date(2026, 6, 4, 5, 0, 0).toISOString();
    await buildStewardshipBlock({
      liveTurn: false,  // Not a live turn
      staticOnly: false,
      threat: { tier: 'calm' },
      settings: { stewardshipEnabled: true, dayStartAnchor: '09:00' },
      nowMs: now,
      lastUserMessageAt: fiveHoursAgo,
      scheduleItems: [],
      wardTimeZone: null,
      tomesDir,
    });
    const stateFile = path.join(tomesDir, '.stewardship-state.json');
    const fileExists = fs.existsSync(stateFile);
    assert.equal(fileExists, false, 'State file should not exist when liveTurn=false');
  } finally {
    fs.rmSync(tomesDir, { recursive: true });
  }
});

test('buildStewardshipBlock: writes state when liveTurn=true and conditions met', async () => {
  const tomesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stew-'));
  try {
    const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
    const fiveHoursAgo = new Date(2026, 6, 4, 5, 0, 0).toISOString();
    await buildStewardshipBlock({
      liveTurn: true,
      staticOnly: false,
      threat: { tier: 'calm' },
      settings: { stewardshipEnabled: true, dayStartAnchor: '09:00' },
      nowMs: now,
      lastUserMessageAt: fiveHoursAgo,
      scheduleItems: [],
      wardTimeZone: null,
      tomesDir,
    });
    const stateFile = path.join(tomesDir, '.stewardship-state.json');
    const fileExists = fs.existsSync(stateFile);
    assert.equal(fileExists, true, 'State file should exist when liveTurn=true and brief fires');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(state.briefFiredOn, 'briefFiredOn should be set');
  } finally {
    fs.rmSync(tomesDir, { recursive: true });
  }
});

test('buildStewardshipBlock: handles malformed/missing state gracefully', async () => {
  const tomesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stew-'));
  try {
    // Write invalid JSON
    const stateFile = path.join(tomesDir, '.stewardship-state.json');
    fs.writeFileSync(stateFile, 'invalid json {{{', 'utf8');

    // Should not throw
    const result = await buildStewardshipBlock({
      liveTurn: false,
      staticOnly: false,
      threat: { tier: 'calm' },
      settings: { stewardshipEnabled: true, dayStartAnchor: '09:00' },
      nowMs: Date.now(),
      lastUserMessageAt: null,
      scheduleItems: [],
      wardTimeZone: null,
      tomesDir,
    });
    assert.ok(typeof result === 'string', 'Should return a string despite malformed state');
  } finally {
    fs.rmSync(tomesDir, { recursive: true });
  }
});

test('buildStewardshipBlock: includes header when content renders', async () => {
  const tomesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stew-'));
  try {
    const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
    const fiveHoursAgo = new Date(2026, 6, 4, 5, 0, 0).toISOString();
    const result = await buildStewardshipBlock({
      liveTurn: true,
      staticOnly: false,
      threat: { tier: 'calm' },
      settings: { stewardshipEnabled: true, dayStartAnchor: '09:00' },
      nowMs: now,
      lastUserMessageAt: fiveHoursAgo,
      scheduleItems: [],
      wardTimeZone: null,
      tomesDir,
    });
    assert.match(result, /\[My stewardship/);
    assert.match(result, /I raise these in my own voice/);
  } finally {
    fs.rmSync(tomesDir, { recursive: true });
  }
});

// ── selectReadiness ────────────────────────────────────────────────
test('selectReadiness: event with unmet requires prerequisite in-window → returned', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const eventWhen = new Date(2026, 6, 5, 14, 0, 0).toISOString().slice(0, 19); // next day, within 48h
  const items = [
    { id: 'event1', label: 'Team meeting', type: 'event', when: eventWhen, resolution: null },
    { id: 'task1', label: 'Prepare slides', type: 'task', when: null, resolution: null },
  ];
  const edges = [
    { src: 'event1', dst: 'task1', kind: 'requires' },
  ];
  const result = selectReadiness({
    items, edges, nowMs: now, wardTimeZone: null, leadHours: 48,
  });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].id, 'event1');
  assert.deepEqual(result[0].label, 'Team meeting');
  assert.ok(result[0].unmet.includes('Prepare slides'));
});

test('selectReadiness: prerequisite with resolution=done → NOT returned', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const eventWhen = new Date(2026, 6, 5, 14, 0, 0).toISOString().slice(0, 19);
  const items = [
    { id: 'event1', label: 'Team meeting', type: 'event', when: eventWhen, resolution: null },
    { id: 'task1', label: 'Prepare slides', type: 'task', when: null, resolution: 'done' },
  ];
  const edges = [
    { src: 'event1', dst: 'task1', kind: 'requires' },
  ];
  const result = selectReadiness({
    items, edges, nowMs: now, wardTimeZone: null, leadHours: 48,
  });
  assert.equal(result.length, 0, 'event should not be returned (prereq is met)');
});

test('selectReadiness: edge kind causes (not requires) → NOT returned', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const eventWhen = new Date(2026, 6, 5, 14, 0, 0).toISOString().slice(0, 19);
  const items = [
    { id: 'event1', label: 'Team meeting', type: 'event', when: eventWhen, resolution: null },
    { id: 'task1', label: 'Prepare slides', type: 'task', when: null, resolution: null },
  ];
  const edges = [
    { src: 'event1', dst: 'task1', kind: 'causes' },
  ];
  const result = selectReadiness({
    items, edges, nowMs: now, wardTimeZone: null, leadHours: 48,
  });
  assert.equal(result.length, 0, 'event should not be returned (causes, not requires)');
});

test('selectReadiness: direction check — reversed edge → NOT returned', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const eventWhen = new Date(2026, 6, 5, 14, 0, 0).toISOString().slice(0, 19);
  const items = [
    { id: 'event1', label: 'Team meeting', type: 'event', when: eventWhen, resolution: null },
    { id: 'task1', label: 'Prepare slides', type: 'task', when: null, resolution: null },
  ];
  const edges = [
    { src: 'task1', dst: 'event1', kind: 'requires' },
  ];
  const result = selectReadiness({
    items, edges, nowMs: now, wardTimeZone: null, leadHours: 48,
  });
  assert.equal(result.length, 0, 'event should not be returned (wrong edge direction)');
});

test('selectReadiness: event outside lead window (10 days ahead) → NOT returned', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const eventWhen = new Date(2026, 7, 14, 14, 0, 0).toISOString().slice(0, 19); // 10 days away
  const items = [
    { id: 'event1', label: 'Future meeting', type: 'event', when: eventWhen, resolution: null },
    { id: 'task1', label: 'Prepare', type: 'task', when: null, resolution: null },
  ];
  const edges = [
    { src: 'event1', dst: 'task1', kind: 'requires' },
  ];
  const result = selectReadiness({
    items, edges, nowMs: now, wardTimeZone: null, leadHours: 48,
  });
  assert.equal(result.length, 0, 'event should not be returned (outside lead window)');
});

test('selectReadiness: cooldown — flaggedAt item within 6h → NOT returned', () => {
  const now = Date.now();
  const oneHourAgo = now - 3600 * 1000;
  const eventWhen = new Date(now + 2 * 3600 * 1000).toISOString().slice(0, 19);
  const items = [
    { id: 'event1', label: 'Call', type: 'event', when: eventWhen, resolution: null },
    { id: 'task1', label: 'Notes', type: 'task', when: null, resolution: null },
  ];
  const edges = [
    { src: 'event1', dst: 'task1', kind: 'requires' },
  ];
  const result = selectReadiness({
    items, edges, nowMs: now, wardTimeZone: null, leadHours: 48,
    flaggedAt: { event1: oneHourAgo }, cooldownMs: 6 * 3600 * 1000,
  });
  assert.equal(result.length, 0, 'event should be excluded (within cooldown)');
});

test('selectReadiness: cooldown — flaggedAt older than 6h → returned', () => {
  const now = Date.now();
  const sevenHoursAgo = now - 7 * 3600 * 1000;
  const eventWhen = new Date(now + 2 * 3600 * 1000).toISOString().slice(0, 19);
  const items = [
    { id: 'event1', label: 'Call', type: 'event', when: eventWhen, resolution: null },
    { id: 'task1', label: 'Notes', type: 'task', when: null, resolution: null },
  ];
  const edges = [
    { src: 'event1', dst: 'task1', kind: 'requires' },
  ];
  const result = selectReadiness({
    items, edges, nowMs: now, wardTimeZone: null, leadHours: 48,
    flaggedAt: { event1: sevenHoursAgo }, cooldownMs: 6 * 3600 * 1000,
  });
  assert.equal(result.length, 1, 'event should be returned (outside cooldown)');
});

test('selectReadiness: depends_on kind works same as requires', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const eventWhen = new Date(2026, 6, 5, 14, 0, 0).toISOString().slice(0, 19);
  const items = [
    { id: 'event1', label: 'Meeting', type: 'event', when: eventWhen, resolution: null },
    { id: 'task1', label: 'Prep', type: 'task', when: null, resolution: null },
  ];
  const edges = [
    { src: 'event1', dst: 'task1', kind: 'depends_on' },
  ];
  const result = selectReadiness({
    items, edges, nowMs: now, wardTimeZone: null, leadHours: 48,
  });
  assert.equal(result.length, 1);
  assert.ok(result[0].unmet.includes('Prep'));
});

test('selectReadiness: obstacleTags — event with obstacle_tags payload', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const eventWhen = new Date(2026, 6, 5, 14, 0, 0).toISOString().slice(0, 19);
  const items = [
    {
      id: 'event1', label: 'Outside task', type: 'event', when: eventWhen, resolution: null,
      payload: { obstacle_tags: ['outside'] },
    },
    { id: 'task1', label: 'Prep', type: 'task', when: null, resolution: null },
  ];
  const edges = [
    { src: 'event1', dst: 'task1', kind: 'requires' },
  ];
  const result = selectReadiness({
    items, edges, nowMs: now, wardTimeZone: null, leadHours: 48,
  });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].obstacleTags, ['outside']);
});

test('selectReadiness: max caps the number returned', () => {
  const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
  const eventWhen1 = new Date(2026, 6, 5, 10, 0, 0).toISOString().slice(0, 19);
  const eventWhen2 = new Date(2026, 6, 5, 14, 0, 0).toISOString().slice(0, 19);
  const eventWhen3 = new Date(2026, 6, 5, 18, 0, 0).toISOString().slice(0, 19);
  const items = [
    { id: 'event1', label: 'First', type: 'event', when: eventWhen1, resolution: null },
    { id: 'event2', label: 'Second', type: 'event', when: eventWhen2, resolution: null },
    { id: 'event3', label: 'Third', type: 'event', when: eventWhen3, resolution: null },
    { id: 'task1', label: 'Prep', type: 'task', when: null, resolution: null },
  ];
  const edges = [
    { src: 'event1', dst: 'task1', kind: 'requires' },
    { src: 'event2', dst: 'task1', kind: 'requires' },
    { src: 'event3', dst: 'task1', kind: 'requires' },
  ];
  const result = selectReadiness({
    items, edges, nowMs: now, wardTimeZone: null, leadHours: 48, max: 2,
  });
  assert.equal(result.length, 2, 'result should be capped to max=2');
  assert.equal(result[0].id, 'event1', 'first item should be soonest-first');
});

test('buildStewardshipBlock: readiness surfaces when event + unmet prerequisite in-window', async () => {
  const tomesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stew-readiness-'));
  try {
    const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
    const eventWhen = new Date(2026, 6, 4, 12, 0, 0).toISOString().slice(0, 19); // 2 hours ahead
    const scheduleItems = [
      { id: 'event1', label: 'Standup', type: 'event', when: eventWhen, resolution: null },
      { id: 'task1', label: 'Prep notes', type: 'task', when: null, resolution: null },
    ];
    const scheduleEdges = [
      { src: 'event1', dst: 'task1', kind: 'requires' },
    ];
    const result = await buildStewardshipBlock({
      liveTurn: true,
      staticOnly: false,
      threat: { tier: 'calm' },
      settings: { stewardshipEnabled: true, dayStartAnchor: '09:00' },
      nowMs: now,
      lastUserMessageAt: new Date(2026, 6, 4, 5, 0, 0).toISOString(),
      scheduleItems,
      scheduleEdges,
      wardTimeZone: null,
      tomesDir,
    });
    assert.match(result, /Standup/);
    assert.match(result, /needs/);
    assert.match(result, /still open/);
  } finally {
    fs.rmSync(tomesDir, { recursive: true });
  }
});

// ── recordRoutineReview + buildStewardshipBlock integration ────────
test('recordRoutineReview: stamps routineReviewAt and stores finding', async () => {
  const tomesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-review-'));
  try {
    const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
    const finding = 'dishes are slipping — shrink it?';
    await recordRoutineReview(finding, now, tomesDir);
    const state = await readStewardshipState(tomesDir);
    assert.equal(state.routineReviewAt, now);
    assert.ok(state.routineReviewFinding, 'finding should exist');
    assert.equal(state.routineReviewFinding.text, finding);
    assert.equal(state.routineReviewFinding.turnsLeft, 3);
  } finally {
    fs.rmSync(tomesDir, { recursive: true });
  }
});

test('recordRoutineReview: null finding stamps time but clears finding', async () => {
  const tomesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-review-'));
  try {
    const now1 = new Date(2026, 6, 4, 10, 0, 0).getTime();
    const now2 = new Date(2026, 6, 5, 10, 0, 0).getTime();
    // First record a finding
    await recordRoutineReview('something to say', now1, tomesDir);
    // Then record null to clear it
    await recordRoutineReview(null, now2, tomesDir);
    const state = await readStewardshipState(tomesDir);
    assert.equal(state.routineReviewAt, now2);
    assert.equal(state.routineReviewFinding, undefined, 'finding should be cleared when null');
  } finally {
    fs.rmSync(tomesDir, { recursive: true });
  }
});

test('recordRoutineReview: caps finding text at 500 chars', async () => {
  const tomesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-review-'));
  try {
    const now = Date.now();
    const longText = 'x'.repeat(600);
    await recordRoutineReview(longText, now, tomesDir);
    const state = await readStewardshipState(tomesDir);
    assert.equal(state.routineReviewFinding.text.length, 500);
  } finally {
    fs.rmSync(tomesDir, { recursive: true });
  }
});

test('buildStewardshipBlock: surfaces routine review finding when present', async () => {
  const tomesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stew-routine-'));
  try {
    const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
    const finding = 'dishes are slipping — shrink it?';
    // Pre-set a routine review finding in state
    await recordRoutineReview(finding, now - 10000, tomesDir);
    // Now build the block with liveTurn=true, recent last message (no brief)
    const oneMinuteAgo = new Date(2026, 6, 4, 9, 59, 0).toISOString();
    const result = await buildStewardshipBlock({
      liveTurn: true,
      staticOnly: false,
      threat: { tier: 'calm' },
      settings: { stewardshipEnabled: true, dayStartAnchor: '09:00' },
      nowMs: now,
      lastUserMessageAt: oneMinuteAgo,
      scheduleItems: [],
      wardTimeZone: null,
      tomesDir,
    });
    assert.match(result, /dishes are slipping/);
  } finally {
    fs.rmSync(tomesDir, { recursive: true });
  }
});

test('buildStewardshipBlock: decrements turnsLeft on live turn', async () => {
  const tomesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stew-routine-'));
  try {
    const now = new Date(2026, 6, 4, 10, 0, 0).getTime();
    const finding = 'dishes are slipping — shrink it?';
    const oneMinuteAgo = new Date(2026, 6, 4, 9, 59, 0).toISOString();
    // Record initial finding (turnsLeft=3)
    await recordRoutineReview(finding, now, tomesDir);
    // First live turn call
    await buildStewardshipBlock({
      liveTurn: true,
      staticOnly: false,
      threat: { tier: 'calm' },
      settings: { stewardshipEnabled: true, dayStartAnchor: '09:00' },
      nowMs: now,
      lastUserMessageAt: oneMinuteAgo,
      scheduleItems: [],
      wardTimeZone: null,
      tomesDir,
    });
    let state = await readStewardshipState(tomesDir);
    assert.equal(state.routineReviewFinding.turnsLeft, 2);
    // Second live turn call
    await buildStewardshipBlock({
      liveTurn: true,
      staticOnly: false,
      threat: { tier: 'calm' },
      settings: { stewardshipEnabled: true, dayStartAnchor: '09:00' },
      nowMs: now,
      lastUserMessageAt: oneMinuteAgo,
      scheduleItems: [],
      wardTimeZone: null,
      tomesDir,
    });
    state = await readStewardshipState(tomesDir);
    assert.equal(state.routineReviewFinding.turnsLeft, 1);
    // Third live turn call
    await buildStewardshipBlock({
      liveTurn: true,
      staticOnly: false,
      threat: { tier: 'calm' },
      settings: { stewardshipEnabled: true, dayStartAnchor: '09:00' },
      nowMs: now,
      lastUserMessageAt: oneMinuteAgo,
      scheduleItems: [],
      wardTimeZone: null,
      tomesDir,
    });
    state = await readStewardshipState(tomesDir);
    assert.equal(state.routineReviewFinding, undefined, 'finding should be cleared after turnsLeft reaches 0');
  } finally {
    fs.rmSync(tomesDir, { recursive: true });
  }
});
