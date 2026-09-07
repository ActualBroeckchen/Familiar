// Contact baselines (initiative-build-spec Pass 2) — pure functions on
// fixture timestamp sets, the honesty rule, ward-session filtering, and the
// rhythm-line consumer.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import {
  weekdayClass,
  coalesceEpisodes,
  episodeGaps,
  percentile,
  computeBaseline,
  isWardSession,
  readWardContactTimestamps,
  getContactBaseline,
  buildRhythmLine,
  isBaselinesEnabled,
  WINDOW_MS,
  MIN_SPAN_DAYS,
} from '../src/safety/contact-baselines.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// A fixed reference "now" on a Wednesday (2026-07-08T12:00:00Z is a Wed).
const NOW = Date.parse('2026-07-15T12:00:00Z');

// ── weekdayClass ─────────────────────────────────────────────────────

test('weekdayClass: weekday vs weekend, server-local', () => {
  // 2026-07-11 is a Saturday, 2026-07-13 is a Monday (UTC dates; use noon
  // UTC so the server's zone can't flip the day for this assertion set on
  // the CI box, which runs UTC).
  assert.equal(weekdayClass(Date.parse('2026-07-11T12:00:00Z')), 'weekend');
  assert.equal(weekdayClass(Date.parse('2026-07-12T12:00:00Z')), 'weekend'); // Sun
  assert.equal(weekdayClass(Date.parse('2026-07-13T12:00:00Z')), 'weekday'); // Mon
});

test('weekdayClass: honours a ward time zone (zone can flip the day)', () => {
  // 2026-07-13T02:00:00Z is Monday UTC but still Sunday evening in US/Pacific.
  const t = Date.parse('2026-07-13T02:00:00Z');
  assert.equal(weekdayClass(t, 'UTC'), 'weekday');
  assert.equal(weekdayClass(t, 'America/Los_Angeles'), 'weekend');
  // A bogus zone degrades to server-local rather than throwing.
  assert.doesNotThrow(() => weekdayClass(t, 'Not/AZone'));
});

// ── coalesceEpisodes / episodeGaps ───────────────────────────────────

test('coalesceEpisodes: bursts within the window collapse to one episode', () => {
  const base = NOW - 10 * DAY;
  const ts = [base, base + 5 * 60_000, base + 20 * 60_000, base + 5 * HOUR];
  const eps = coalesceEpisodes(ts, 3 * HOUR);
  assert.equal(eps.length, 2, 'first three are one episode (within 3h), the 5h-later one is new');
  assert.equal(eps[0].start, base);
  assert.equal(eps[0].end, base + 20 * 60_000);
  assert.equal(eps[1].start, base + 5 * HOUR);
});

test('episodeGaps: gap is quiet-end → next-start, tagged with when quiet began', () => {
  const eps = [{ start: 0, end: 10 }, { start: 100, end: 120 }, { start: 500, end: 500 }];
  const gaps = episodeGaps(eps);
  assert.deepEqual(gaps, [
    { gapMs: 90, startMs: 10 },
    { gapMs: 380, startMs: 120 },
  ]);
});

// ── percentile ───────────────────────────────────────────────────────

test('percentile: interpolates; handles empty and singleton', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([42], 0.9), 42);
  assert.equal(percentile([0, 10], 0.5), 5);
  assert.equal(percentile([0, 10, 20, 30], 0.9), 27); // 0.9*3=2.7 → 20 + 10*0.7
});

// ── computeBaseline: the honesty rule ────────────────────────────────

test('computeBaseline: below MIN_SPAN_DAYS → hasBaseline false', () => {
  // Plenty of episodes, but all inside one week → not enough span.
  const start = NOW - 6 * DAY;
  const ts = [];
  for (let i = 0; i < 12; i++) ts.push(start + i * 12 * HOUR);
  const b = computeBaseline(ts, { now: NOW, timeZone: 'UTC' });
  assert.equal(b.hasBaseline, false);
  assert.ok(b.spanDays < MIN_SPAN_DAYS);
});

test('computeBaseline: enough span + samples → a real per-class baseline', () => {
  // 4 weeks of a daily-ish contact: one episode every ~24h, so ~24h gaps.
  const ts = [];
  for (let d = 0; d < 27; d++) ts.push(NOW - (27 - d) * DAY - 3 * HOUR);
  const b = computeBaseline(ts, { now: NOW, timeZone: 'UTC', minSamples: 3 });
  assert.equal(b.hasBaseline, true);
  assert.ok(b.spanDays >= MIN_SPAN_DAYS);
  // Both classes should see ~24h median gaps.
  for (const cls of ['weekday', 'weekend']) {
    if (b.classes[cls].hasBaseline) {
      assert.ok(Math.abs(b.classes[cls].medianGapMs - DAY) < 2 * HOUR, `${cls} median ~24h`);
      assert.ok(b.classes[cls].p90GapMs >= b.classes[cls].medianGapMs);
      assert.ok(b.classes[cls].longestGapMs >= b.classes[cls].p90GapMs);
    }
  }
});

test('computeBaseline: window excludes stale timestamps', () => {
  const ts = [NOW - (WINDOW_MS + DAY), NOW - (WINDOW_MS + 2 * DAY), NOW - HOUR];
  const b = computeBaseline(ts, { now: NOW, timeZone: 'UTC' });
  // Only one in-window sample → no episodes-worth of gaps → no baseline.
  assert.equal(b.hasBaseline, false);
});

test('computeBaseline: a thin class stays honest while a rich one reports', () => {
  const ts = [];
  // Weekdays: dense contact across the 4 weeks (every weekday ~24h apart).
  for (let d = 0; d < 27; d++) {
    const t = NOW - (27 - d) * DAY;
    if (weekdayClass(t, 'UTC') === 'weekday') ts.push(t);
  }
  // Weekend: only a single contact → no weekend gaps at all.
  ts.push(NOW - 2 * DAY);
  const b = computeBaseline(ts, { now: NOW, timeZone: 'UTC', minSamples: 3 });
  assert.equal(b.hasBaseline, true, 'the weekday class carries it');
  assert.equal(b.classes.weekend.hasBaseline, false, 'weekend stays honest with too few samples');
});

// ── isWardSession ────────────────────────────────────────────────────

test('isWardSession: web (no tag) and ward-private count; group rooms never do', () => {
  assert.equal(isWardSession({ messages: [] }), true);                       // web
  assert.equal(isWardSession({ audienceTag: 'ward-private' }), true);        // ward DM
  assert.equal(isWardSession({ audienceTag: 'village-public' }), false);     // group
  assert.equal(isWardSession({ audienceTag: 'circle-abc' }), false);         // group circle
});

// ── readWardContactTimestamps ────────────────────────────────────────

test('readWardContactTimestamps: only ward user-messages in window', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'baseline-logs-'));
  try {
    const t = (iso) => new Date(iso).toISOString();
    // Web session: two user messages (ward), one assistant (ignored).
    writeFileSync(path.join(dir, 's-web.json'), JSON.stringify({
      messages: [
        { role: 'user', content: 'hi', timestamp: t('2026-07-14T09:00:00Z') },
        { role: 'assistant', content: 'hey', timestamp: t('2026-07-14T09:01:00Z') },
        { role: 'user', content: 'more', timestamp: t('2026-07-14T18:00:00Z') },
      ],
    }));
    // Ward-DM: one user message (counts).
    writeFileSync(path.join(dir, 's-warddm.json'), JSON.stringify({
      audienceTag: 'ward-private',
      messages: [{ role: 'user', content: 'yo', timestamp: t('2026-07-13T20:00:00Z') }],
    }));
    // Group room: a villager user-message (must NOT count).
    writeFileSync(path.join(dir, 's-group.json'), JSON.stringify({
      audienceTag: 'village-public',
      messages: [{ role: 'user', content: 'sup', timestamp: t('2026-07-14T10:00:00Z') }],
    }));
    // Corrupt file: skipped, never throws.
    writeFileSync(path.join(dir, 's-bad.json'), '{ not json');

    const ts = await readWardContactTimestamps({ logsDir: dir, now: NOW });
    assert.equal(ts.length, 3, 'two web + one ward-dm; the group message excluded');
    // sorted ascending
    assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readWardContactTimestamps: missing dir → [] (never throws)', async () => {
  const ts = await readWardContactTimestamps({ logsDir: path.join(tmpdir(), 'nope-'+Date.now()), now: NOW });
  assert.deepEqual(ts, []);
});

// ── getContactBaseline: gate + cache ─────────────────────────────────

let tdir;
beforeEach(() => { tdir = mkdtempSync(path.join(tmpdir(), 'baseline-cache-')); delete process.env.PROTO_FAMILIAR_BASELINES_DISABLED; });
afterEach(() => { rmSync(tdir, { recursive: true, force: true }); });

test('getContactBaseline: disabled → {hasBaseline:false, disabled:true}, no compute', async () => {
  process.env.PROTO_FAMILIAR_BASELINES_DISABLED = '1';
  const b = await getContactBaseline({ now: NOW, tomesDir: tdir, logsDir: path.join(tmpdir(), 'x'), settings: { contactBaselinesEnabled: true } });
  assert.equal(b.hasBaseline, false);
  assert.equal(b.disabled, true);
  delete process.env.PROTO_FAMILIAR_BASELINES_DISABLED;
});

test('isBaselinesEnabled: settings false / env off; default ON', () => {
  assert.equal(isBaselinesEnabled({ contactBaselinesEnabled: false }), false);
  assert.equal(isBaselinesEnabled({}), true);
  process.env.PROTO_FAMILIAR_BASELINES_DISABLED = '1';
  assert.equal(isBaselinesEnabled({ contactBaselinesEnabled: true }), false);
  delete process.env.PROTO_FAMILIAR_BASELINES_DISABLED;
});

test('getContactBaseline: computes then serves the cache on the next read', async () => {
  const logs = mkdtempSync(path.join(tmpdir(), 'baseline-src-'));
  try {
    const msgs = [];
    for (let d = 0; d < 27; d++) msgs.push({ role: 'user', content: 'x', timestamp: new Date(NOW - (27 - d) * DAY).toISOString() });
    writeFileSync(path.join(logs, 's-web.json'), JSON.stringify({ messages: msgs }));

    const first = await getContactBaseline({ now: NOW, tomesDir: tdir, logsDir: logs, settings: { wardTimeZone: 'UTC' } });
    assert.equal(first.hasBaseline, true);

    // Second read with an EMPTY logs dir but still inside the refresh window
    // → must serve the cached rich result, not recompute to empty.
    const emptyLogs = mkdtempSync(path.join(tmpdir(), 'baseline-empty-'));
    try {
      const second = await getContactBaseline({ now: NOW + 60_000, tomesDir: tdir, logsDir: emptyLogs, settings: { wardTimeZone: 'UTC' } });
      assert.equal(second.hasBaseline, true, 'served from cache');
    } finally { rmSync(emptyLogs, { recursive: true, force: true }); }
  } finally { rmSync(logs, { recursive: true, force: true }); }
});

// ── buildRhythmLine ──────────────────────────────────────────────────

function richBaseline() {
  return {
    hasBaseline: true,
    classes: {
      weekday: { hasBaseline: true, medianGapMs: 20 * HOUR, p90GapMs: 30 * HOUR, longestGapMs: 40 * HOUR },
      weekend: { hasBaseline: false, medianGapMs: null, p90GapMs: null, longestGapMs: null },
    },
  };
}

test('buildRhythmLine: renders the median and p90 for the last-contact class', () => {
  // last contact on a Monday (weekday) → weekday class, which has a baseline.
  const monday = Date.parse('2026-07-13T12:00:00Z');
  const line = buildRhythmLine(richBaseline(), { lastContactMs: monday, timeZone: 'UTC' });
  assert.match(line, /^- Our usual rhythm: on a weekday/);
  assert.match(line, /about a day|about 20 hours/);   // ~20h median
  assert.match(line, /longest ordinary weekday gap lately has been/);
});

test('buildRhythmLine: no line when the relevant class has no baseline', () => {
  // last contact on a Saturday (weekend) → weekend class, which is thin.
  const saturday = Date.parse('2026-07-11T12:00:00Z');
  assert.equal(buildRhythmLine(richBaseline(), { lastContactMs: saturday, timeZone: 'UTC' }), '');
});

test('buildRhythmLine: no baseline / no last-contact / disabled → empty string', () => {
  assert.equal(buildRhythmLine({ hasBaseline: false }, { lastContactMs: NOW }), '');
  assert.equal(buildRhythmLine({ hasBaseline: false, disabled: true }, { lastContactMs: NOW }), '');
  assert.equal(buildRhythmLine(richBaseline(), { lastContactMs: NaN, timeZone: 'UTC' }), '');
  assert.equal(buildRhythmLine(null, { lastContactMs: NOW }), '');
});
