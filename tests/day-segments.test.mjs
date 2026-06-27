import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentByDay, localDateOf, isReadableMessage, dayDelta } from '../day-segments.js';

// Build a timestamp at a given LOCAL wall-clock time so the test is tz-safe:
// localDateOf reads it back in the same local zone it was constructed in.
const at = (y, mo, d, h = 12) => new Date(y, mo - 1, d, h).toISOString();
const msg = (content, ts, role = 'user') => ({ role, content, timestamp: ts });

test('localDateOf returns local YYYY-MM-DD, null on junk', () => {
  assert.equal(localDateOf(at(2026, 6, 20, 14)), '2026-06-20');
  assert.equal(localDateOf(null), null);
  assert.equal(localDateOf('not a date'), null);
});

test('one day → one segment spanning all its messages', () => {
  const segs = segmentByDay([
    msg('hi', at(2026, 6, 20, 9)),
    msg('there', at(2026, 6, 20, 10), 'assistant'),
    msg('how are you', at(2026, 6, 20, 18)),
  ]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].date, '2026-06-20');
  assert.equal(segs[0].startIdx, 0);
  assert.equal(segs[0].endIdx, 2);
  assert.equal(segs[0].count, 3);
  assert.equal(segs[0].readableCount, 3);
});

test('a conversation crossing midnight splits into two date segments', () => {
  const segs = segmentByDay([
    msg('late night', at(2026, 6, 20, 23)),
    msg('still up', at(2026, 6, 20, 23), 'assistant'),
    msg('past midnight', at(2026, 6, 21, 0)),
    msg('yep', at(2026, 6, 21, 1), 'assistant'),
  ]);
  assert.deepEqual(segs.map(s => s.date), ['2026-06-20', '2026-06-21']);
  assert.equal(segs[0].count, 2);
  assert.equal(segs[1].count, 2);
  assert.equal(segs[1].startIdx, 2);
});

test('a message with no timestamp inherits the previous resolved date', () => {
  const segs = segmentByDay([
    msg('dated', at(2026, 6, 20, 12)),
    msg('undated follows', undefined, 'assistant'),
    msg('also undated', undefined),
  ]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].date, '2026-06-20');
  assert.equal(segs[0].count, 3);
});

test('readableCount excludes tool turns and tool-call-only assistant turns', () => {
  const segs = segmentByDay([
    msg('real', at(2026, 6, 20, 9)),
    { role: 'assistant', tool_calls: [{ id: 't1' }], content: '', timestamp: at(2026, 6, 20, 9) },
    { role: 'tool', content: 'result', timestamp: at(2026, 6, 20, 9) },
    msg('real again', at(2026, 6, 20, 10), 'assistant'),
  ]);
  assert.equal(segs[0].count, 4);
  assert.equal(segs[0].readableCount, 2);
});

test('isReadableMessage matches the memorizer filter', () => {
  assert.equal(isReadableMessage({ role: 'user', content: 'hi' }), true);
  assert.equal(isReadableMessage({ role: 'tool', content: 'x' }), false);
  assert.equal(isReadableMessage({ role: 'assistant', tool_calls: [{}], content: '' }), false);
  assert.equal(isReadableMessage({ role: 'user', content: '   ' }), false);
});

test('empty input → no segments', () => {
  assert.deepEqual(segmentByDay([]), []);
  assert.deepEqual(segmentByDay(null), []);
});

// ── dayDelta (the consent-queue dedup fix) ───────────────────────────────────

test('dayDelta: first run (priorThrough 0) ingests the whole segment', () => {
  const all = [msg('a', at(2026, 6, 20, 9)), msg('b', at(2026, 6, 20, 10), 'assistant')];
  const d = dayDelta(all, 0);
  assert.equal(d.skip, false);
  assert.equal(d.priorThrough, 0);
  assert.equal(d.messages.length, 2);
});

test('dayDelta: a grown day ingests only the un-memorized tail', () => {
  const all = [
    msg('a', at(2026, 6, 20, 9)), msg('b', at(2026, 6, 20, 10), 'assistant'),
    msg('c', at(2026, 6, 20, 11)), msg('d', at(2026, 6, 20, 12), 'assistant'),
  ];
  const d = dayDelta(all, 2); // first 2 already memorized
  assert.equal(d.skip, false);
  assert.equal(d.priorThrough, 2);
  assert.deepEqual(d.messages.map(m => m.content), ['c', 'd']);
});

test('dayDelta: a fully-memorized day skips (nothing new)', () => {
  const all = [msg('a', at(2026, 6, 20, 9)), msg('b', at(2026, 6, 20, 10), 'assistant')];
  assert.deepEqual(dayDelta(all, 2), { messages: [], priorThrough: 2, skip: true });
  assert.equal(dayDelta(all, 5).skip, true); // recorded past the end → still skip
});

test('dayDelta: a tail too thin to extract from (<2 readable) skips and waits', () => {
  const all = [
    msg('a', at(2026, 6, 20, 9)), msg('b', at(2026, 6, 20, 10), 'assistant'),
    msg('c', at(2026, 6, 20, 11)), // only one new readable message
  ];
  const d = dayDelta(all, 2);
  assert.equal(d.skip, true);
  assert.equal(d.messages.length, 1); // the tail is carried, just not worth a job yet
});
