import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMemorySweepTick } from '../src/memory/memory-sweep-loop.js';

const conn = () => ({ provider: 'nanogpt', apiKey: 'sk', model: 'm' });
const seg = (date) => ({ startIdx: 0, endIdx: 1, count: 2, messages: [{}, {}] });

test('no connection → stands down without touching the queue', async () => {
  let called = false;
  const r = await runMemorySweepTick({
    getConnection: () => null,
    listIncomplete: async () => { called = true; return ['2026-06-20']; },
  });
  assert.deepEqual(r, { acted: false, reason: 'no-connection' });
  assert.equal(called, false);
});

test('skips the current day; only past incomplete days are swept', async () => {
  const enqueued = [];
  const r = await runMemorySweepTick({
    getConnection: conn,
    today: () => '2026-06-22',
    listIncomplete: async () => ['2026-06-20', '2026-06-22'], // 22nd is "today"
    dateSlices: async (date) => [{ sessionId: 's1', audienceTag: 'ward-private', seg: seg(date) }],
    enqueue: async (job) => { enqueued.push(job.topicId); return { deduped: false }; },
  });
  assert.equal(r.acted, true);
  assert.equal(r.enqueued, 1);
  assert.deepEqual(enqueued, ['2026-06-20']); // not the 22nd
});

test('nothing past-incomplete → covered, no enqueue', async () => {
  let enq = 0;
  const r = await runMemorySweepTick({
    getConnection: conn,
    today: () => '2026-06-22',
    listIncomplete: async () => ['2026-06-22'], // only today
    enqueue: async () => { enq++; return { deduped: false }; },
  });
  assert.deepEqual(r, { acted: false, reason: 'covered' });
  assert.equal(enq, 0);
});

test('deduped enqueues do not count as acted', async () => {
  const r = await runMemorySweepTick({
    getConnection: conn,
    today: () => '2026-06-22',
    listIncomplete: async () => ['2026-06-20'],
    dateSlices: async () => [{ sessionId: 's1', audienceTag: 'ward-private', seg: seg() }],
    enqueue: async () => ({ deduped: true }),
  });
  assert.equal(r.acted, false);
  assert.equal(r.reason, 'in-flight');
});
