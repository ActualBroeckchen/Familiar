/**
 * Tests for the temporal_context payload renderer.
 *
 * Run with: node --test tests/temporal-format.test.mjs
 *
 * The contract under test is the boundary between Unruh and Thalamus:
 * Unruh produces a JSON shape; Thalamus turns it into text the model
 * reads. If either side drifts, conversations silently lose temporal
 * context — these tests catch the drift early.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTemporalContext } from '../temporal-format.js';

test('returns empty string for null payload', () => {
  assert.equal(formatTemporalContext(null), '');
});

test('returns empty string for undefined payload', () => {
  assert.equal(formatTemporalContext(undefined), '');
});

test('returns empty string for non-object payload', () => {
  assert.equal(formatTemporalContext('garbage'), '');
  assert.equal(formatTemporalContext(42), '');
});

test('omits section entirely when all sub-blocks empty', () => {
  // Critical contract: an Unruh that has no data yet (Milestone 1-2 state)
  // must NOT produce a hollow "[Temporal Context]" header. The assembler
  // in thalamus.js relies on '' here to skip the section push.
  const empty = {
    ts: '2026-05-18T10:00:00Z',
    schedule: { window: [], phase: null },
    interests: { standing: [], live: [] },
    handoff: { intent: null, open_threads: [] },
  };
  assert.equal(formatTemporalContext(empty), '');
});

test('renders handoff intent when present', () => {
  const out = formatTemporalContext({
    handoff: { intent: 'finishing the owl-wings thought', open_threads: [] },
  });
  assert.match(out, /Last session:/);
  assert.match(out, /finishing the owl-wings thought/);
});

test('renders open threads as strings or objects', () => {
  const out = formatTemporalContext({
    handoff: {
      intent: null,
      open_threads: ['raw string thread', { label: 'object thread' }, { id: 'fallback-id' }],
    },
  });
  assert.match(out, /raw string thread/);
  assert.match(out, /object thread/);
  assert.match(out, /fallback-id/);
});

test('renders current phase and schedule window', () => {
  const out = formatTemporalContext({
    schedule: {
      phase: { id: 'morning-correspondence', label: 'morning correspondence' },
      window: [
        { when: '14:00', label: "Chen's appointment" },
        { when: '22:00', label: 'cat play' },
      ],
    },
  });
  assert.match(out, /Current phase: morning correspondence/);
  assert.match(out, /14:00 — Chen's appointment/);
  assert.match(out, /22:00 — cat play/);
});

test('renders standing values without weights', () => {
  const out = formatTemporalContext({
    interests: { standing: [{ label: 'caring for the user' }], live: [] },
  });
  assert.match(out, /Standing values:/);
  assert.match(out, /caring for the user/);
  // Standing values must NOT carry a weight in the prompt — they never decay,
  // so a number would be meaningless and misleading.
  assert.doesNotMatch(out, /\[\d/);
});

test('renders live interests with weight to 2dp', () => {
  const out = formatTemporalContext({
    interests: {
      standing: [],
      live: [
        { label: 'owl feather aerodynamics', weight: 0.7432 },
        { label: 'biomimetic engineering', weight: 0.31 },
      ],
    },
  });
  assert.match(out, /Live interests \(by weight\):/);
  assert.match(out, /owl feather aerodynamics \[0\.74\]/);
  assert.match(out, /biomimetic engineering \[0\.31\]/);
});

test('falls back to id when label missing', () => {
  const out = formatTemporalContext({
    interests: { standing: [], live: [{ id: 'node-42', weight: 0.5 }] },
  });
  assert.match(out, /node-42/);
});

test('renders timed items with relative-time phrasing the Familiar can perceive', () => {
  // An item later today renders with a time-of-day bucket ("tonight at
  // 10pm") rather than a bare ISO; the renderer recomputes against
  // Date.now() per call so the relative phrasing stays current.
  const today = new Date();
  today.setHours(22, 0, 0, 0);
  const out = formatTemporalContext({
    schedule: { phase: null, window: [{ when: today.toISOString(), label: 'cat play' }] },
  });
  // The label is preserved alongside SOME relative phrasing — the
  // exact words depend on what "now" is during the test, but it
  // should be human-readable (contain "at", "in", "ago", "today",
  // "tonight", "tomorrow" — not just an ISO).
  assert.match(out, /cat play/);
  assert.match(out, /(at \d|in \d|\d minutes? ago|just now|moment|tonight|this evening|this afternoon|this morning)/i);
});

test('renders tomorrow items in tomorrow-relative phrasing', () => {
  const tomorrow = new Date(Date.now() + 86_400_000);
  tomorrow.setHours(14, 0, 0, 0);
  const out = formatTemporalContext({
    schedule: { phase: null, window: [{ when: tomorrow.toISOString(), label: 'Chen' }] },
  });
  assert.match(out, /Chen/);
  assert.match(out, /tomorrow at 2pm/);
});

test('renders phase span using start–end times', () => {
  const t = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const out = formatTemporalContext({
    schedule: {
      phase: { id: 'p1', label: 'morning correspondence', when: t(10, 0), end: t(13, 0) },
      window: [],
    },
  });
  assert.match(out, /Current phase: morning correspondence \(10:00–13:00\)/);
});

test('does not repeat the current phase in the window list', () => {
  const t = (h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  // Phase label chosen to NOT collide with relativeTime's time-of-day
  // buckets ("this morning at HH:MM" etc.) — using a domain-y label
  // so the regex below only counts the phase row.
  const phase = { id: 'p1', label: 'correspondence-block', when: t(10), end: t(13) };
  const out = formatTemporalContext({
    schedule: { phase, window: [
      { ...phase, type: 'phase' },         // current phase — should be filtered
      { id: 'e1', label: 'event 1', when: t(11) },
    ]},
  });
  assert.equal(out.match(/correspondence-block/g)?.length, 1, 'current phase should appear exactly once');
  assert.match(out, /event 1/);
});

test('open tasks (no when_ts, no resolution) get a {{user}}-bonded header', () => {
  const out = formatTemporalContext({
    schedule: { phase: null, window: [
      { type: 'task', label: 'file taxes' },
      { type: 'task', label: 'review the report' },
    ]},
  });
  // Header that primes the Familiar to feel them as commitments their
  // bonded human is counting on them to ACT on — to remember AND to
  // raise — not background noise.
  assert.match(out, /Open tasks I'm holding for \{\{user\}\} — mine to remember and to raise/);
  assert.match(out, /- file taxes/);
  assert.match(out, /- review the report/);
});

test('upcoming items grouped under their own header with type tag', () => {
  const t = new Date(); t.setHours(15, 0, 0, 0);
  const out = formatTemporalContext({
    schedule: { phase: null, window: [
      { type: 'event', when: t.toISOString(), label: 'dentist' },
      { type: 'task',  when: t.toISOString(), label: 'reply to Sam' },
    ]},
  });
  assert.match(out, /Upcoming in this window:/);
  assert.match(out, /\[event\] dentist/);
  assert.match(out, /\[task\] reply to Sam/);
});

test('reminders get their own "set to fire" header', () => {
  const t = new Date(); t.setHours(20, 0, 0, 0);
  const out = formatTemporalContext({
    schedule: { phase: null, window: [
      { type: 'reminder', when: t.toISOString(), label: 'take meds' },
    ]},
  });
  assert.match(out, /Reminders set to fire:/);
  assert.match(out, /take meds/);
});

test('resolved items grouped under "Recently resolved" header (not mixed with upcoming)', () => {
  const t = new Date(); t.setHours(15, 0, 0, 0);
  const t2 = new Date(); t2.setHours(11, 0, 0, 0);
  const out = formatTemporalContext({
    schedule: { phase: null, window: [
      { type: 'task', when: t.toISOString(),  label: 'upcoming-thing' },
      { type: 'task', when: t2.toISOString(), label: 'past-thing', resolution: 'done' },
    ]},
  });
  assert.match(out, /Upcoming in this window:[\s\S]*upcoming-thing/);
  assert.match(out, /Recently resolved in this window:[\s\S]*past-thing \[done\]/);
});

test('past-date phase rows in schedule.window do NOT pollute the schedule sections', () => {
  // The "Routine" section (payload.routine) is the right surface for
  // phases — they recur daily by design. If a phase happens to leak
  // through schedule.window (stored date in the past), the schedule
  // block must skip it so we don't double-render.
  const out = formatTemporalContext({
    schedule: { phase: null, window: [
      { type: 'phase', label: 'leaked-from-window', when: '2026-05-01T06:00:00Z', end: '2026-05-01T10:00:00Z' },
    ]},
    // No routine block — this asserts the schedule-side skip, not the rhythm rendering.
  });
  assert.equal(out.includes('leaked-from-window'), false);
});

test("today's rhythm: phases surface regardless of stored date (recur daily)", () => {
  const out = formatTemporalContext({
    schedule: { phase: null, window: [] },
    routine: [
      // Stored on different past dates — should all surface anyway.
      { id: 'p1', label: 'early morning',          when: '2026-05-01T06:00:00Z', end: '2026-05-01T10:00:00Z',
        payload: { texture: 'before {{user}} wakes' } },
      { id: 'p2', label: 'morning correspondence', when: '2026-03-14T10:00:00Z', end: '2026-03-14T13:00:00Z' },
      { id: 'p3', label: 'late night',             when: '2026-02-02T23:00:00Z', end: '2026-02-03T06:00:00Z' },
    ],
  });
  assert.match(out, /Today's rhythm:/);
  assert.match(out, /early morning/);
  assert.match(out, /morning correspondence/);
  assert.match(out, /late night/);
  assert.match(out, /before \{\{user\}\} wakes/);
});

test("today's rhythm: current phase is marked '← I am here'", () => {
  const out = formatTemporalContext({
    schedule: {
      phase: { id: 'p2', label: 'morning correspondence', when: '2026-03-14T10:00:00Z', end: '2026-03-14T13:00:00Z' },
      window: [],
    },
    routine: [
      { id: 'p1', label: 'early morning',          when: '2026-05-01T06:00:00Z', end: '2026-05-01T10:00:00Z' },
      { id: 'p2', label: 'morning correspondence', when: '2026-03-14T10:00:00Z', end: '2026-03-14T13:00:00Z' },
      { id: 'p3', label: 'afternoon work',         when: '2026-03-14T13:00:00Z', end: '2026-03-14T18:00:00Z' },
    ],
  });
  // The current phase carries the marker; others do not.
  assert.match(out, /morning correspondence.*← I am here/);
  assert.equal(/early morning.*← I am here/.test(out), false);
  assert.equal(/afternoon work.*← I am here/.test(out), false);
});

test("today's rhythm: phases sorted by local time-of-day, not by stored date", () => {
  const out = formatTemporalContext({
    schedule: { phase: null, window: [] },
    routine: [
      // Insertion order deliberately scrambled vs. time-of-day.
      { id: 'late',  label: 'late night',      when: '2026-05-01T23:00:00Z', end: '2026-05-02T06:00:00Z' },
      { id: 'early', label: 'early morning',   when: '2026-05-01T06:00:00Z', end: '2026-05-01T10:00:00Z' },
      { id: 'noon',  label: 'morning correspondence', when: '2026-05-01T10:00:00Z', end: '2026-05-01T13:00:00Z' },
    ],
  });
  const iEarly = out.indexOf('early morning');
  const iNoon  = out.indexOf('morning correspondence');
  const iLate  = out.indexOf('late night');
  assert.ok(iEarly < iNoon && iNoon < iLate, `order should be early→noon→late, got ${iEarly}/${iNoon}/${iLate}`);
});

test('renders resolution badge on resolved items', () => {
  const t = new Date(); t.setHours(15, 0, 0, 0);
  const out = formatTemporalContext({
    schedule: { phase: null, window: [
      { when: t.toISOString(), label: 'laundry', resolution: 'done' },
    ]},
  });
  assert.match(out, /laundry \[done\]/);
});

test('passes through non-ISO time strings unchanged (backward-compat)', () => {
  const out = formatTemporalContext({
    schedule: { phase: null, window: [{ when: '14:00', label: 'literal' }] },
  });
  assert.match(out, /14:00 — literal/);
});

test('block order is handoff → schedule → interests', () => {
  const out = formatTemporalContext({
    handoff: { intent: 'HANDOFF-MARKER', open_threads: [] },
    schedule: { phase: { label: 'SCHEDULE-MARKER' }, window: [] },
    interests: { standing: [{ label: 'INTERESTS-MARKER' }], live: [] },
  });
  const h = out.indexOf('HANDOFF-MARKER');
  const s = out.indexOf('SCHEDULE-MARKER');
  const i = out.indexOf('INTERESTS-MARKER');
  assert.ok(h !== -1 && s !== -1 && i !== -1, 'all markers should render');
  assert.ok(h < s, 'handoff should come before schedule');
  assert.ok(s < i, 'schedule should come before interests');
});
