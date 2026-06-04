import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOneReminderTick } from '../reminders-loop.js';

function makeFakeFireReminder() {
  const fired = [];
  return {
    fn: async ({ id, label }) => { fired.push({ id, label }); },
    fired,
  };
}

function makeFakeEnqueue() {
  const enqueued = [];
  return {
    fn: async (item) => { enqueued.push(item); return { id: 'fake-outbox-id', deduped: false }; },
    enqueued,
  };
}

test('runOneReminderTick: empty due list → no fires, no enqueues', async () => {
  const fireR = makeFakeFireReminder();
  const enq   = makeFakeEnqueue();
  const r = await runOneReminderTick({
    getDueReminders: async () => [],
    fireReminder:    fireR.fn,
    enqueueOutboxFn: enq.fn,
  });
  assert.deepEqual(r.fired,   []);
  assert.deepEqual(r.skipped, []);
  assert.equal(fireR.fired.length, 0);
  assert.equal(enq.enqueued.length, 0);
});

test('runOneReminderTick: enqueues outbox + marks fired for each due reminder', async () => {
  const fireR = makeFakeFireReminder();
  const enq   = makeFakeEnqueue();
  const due = [
    { id: 'r1', label: 'take a break',     payload: { message: 'You\'ve been at it 90 minutes' } },
    { id: 'r2', label: 'meds',             payload: {} },
  ];
  const r = await runOneReminderTick({
    getDueReminders: async () => due,
    fireReminder:    fireR.fn,
    enqueueOutboxFn: enq.fn,
  });
  assert.equal(r.fired.length, 2);
  assert.equal(r.skipped.length, 0);
  assert.deepEqual(fireR.fired.map(f => f.id), ['r1', 'r2']);
  assert.deepEqual(enq.enqueued.map(e => e.originId), ['r1', 'r2']);
  assert.equal(enq.enqueued[0].title, 'take a break');
  assert.equal(enq.enqueued[0].body,  'You\'ve been at it 90 minutes');
});

test('runOneReminderTick: enqueue failure → reminder NOT marked fired (retries next tick)', async () => {
  const fireR = makeFakeFireReminder();
  const due = [{ id: 'r1', label: 'oops', payload: {} }];
  const r = await runOneReminderTick({
    getDueReminders: async () => due,
    fireReminder:    fireR.fn,
    enqueueOutboxFn: async () => { throw new Error('outbox down'); },
  });
  assert.equal(r.fired.length,   0);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].error, /outbox down/);
  assert.equal(fireR.fired.length, 0, 'must not have marked fired when enqueue failed');
});

test('runOneReminderTick: fire failure → marked skipped (will retry; outbox dedupes)', async () => {
  const enq = makeFakeEnqueue();
  const due = [{ id: 'r1', label: 'pending', payload: {} }];
  const r = await runOneReminderTick({
    getDueReminders: async () => due,
    fireReminder:    async () => { throw new Error('schedule_resolve failed'); },
    enqueueOutboxFn: enq.fn,
  });
  assert.equal(r.fired.length, 0);
  assert.equal(r.skipped.length, 1);
  // Outbox was enqueued (idempotent — dedupe will catch the retry).
  assert.equal(enq.enqueued.length, 1);
});

test('runOneReminderTick: validates required callbacks', async () => {
  await assert.rejects(runOneReminderTick({ fireReminder: async () => null }), /getDueReminders/);
  await assert.rejects(runOneReminderTick({ getDueReminders: async () => [] }), /fireReminder/);
});

test('runOneReminderTick: partial failures don\'t block the rest', async () => {
  const fireR = makeFakeFireReminder();
  let call = 0;
  const enq = {
    fn: async (item) => {
      call += 1;
      if (call === 2) throw new Error('flaky');
      return { id: `outbox-${call}`, deduped: false };
    },
  };
  const due = [
    { id: 'r1', label: 'ok',    payload: {} },
    { id: 'r2', label: 'fail',  payload: {} },
    { id: 'r3', label: 'ok2',   payload: {} },
  ];
  const r = await runOneReminderTick({
    getDueReminders: async () => due,
    fireReminder:    fireR.fn,
    enqueueOutboxFn: enq.fn,
  });
  assert.equal(r.fired.length,   2);
  assert.equal(r.skipped.length, 1);
  assert.deepEqual(r.fired.map(f => f.id),   ['r1', 'r3']);
  assert.equal(r.skipped[0].id, 'r2');
});
