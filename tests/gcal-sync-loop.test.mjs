import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOneGcalSyncTick, clampSyncIntervalMs, DEFAULT_SYNC_INTERVAL_MS } from '../gcal-sync-loop.js';

test('clampSyncIntervalMs: floors, ceils, and defaults', () => {
  assert.equal(clampSyncIntervalMs(60 * 60_000), 60 * 60_000);
  assert.equal(clampSyncIntervalMs(60_000), 5 * 60_000);         // below floor → 5min
  assert.equal(clampSyncIntervalMs(99 * 24 * 60 * 60_000), 24 * 60 * 60_000); // above ceil
  assert.equal(clampSyncIntervalMs(NaN), DEFAULT_SYNC_INTERVAL_MS);
});

test('tick routes ONLY new ids into the cue', async () => {
  const routed = [];
  const r = await runOneGcalSyncTick({
    fetchSource: async () => ({ ok: true, icsText: 'BEGIN:VCALENDAR…' }),
    ingest: async () => ({ ok: true, new: ['n1', 'n2'], updated: ['u1'], removed: ['r1'] }),
    routeNew: async (ids) => routed.push(...ids),
  });
  assert.equal(r.synced, true);
  assert.deepEqual(r.new, ['n1', 'n2']);
  assert.deepEqual(routed, ['n1', 'n2']);   // updated/removed never routed
});

test('an unchanged re-sync routes nothing', async () => {
  const routed = [];
  const r = await runOneGcalSyncTick({
    fetchSource: async () => ({ ok: true, icsText: 'x' }),
    ingest: async () => ({ ok: true, new: [], updated: [], removed: [] }),
    routeNew: async (ids) => routed.push(...ids),
  });
  assert.equal(r.synced, true);
  assert.deepEqual(routed, []);
});

test('fetch failure skips the tick and never calls ingest (no deletion reconcile on a blip)', async () => {
  let ingestCalled = false;
  const r = await runOneGcalSyncTick({
    fetchSource: async () => ({ ok: false, error: 'timeout' }),
    ingest: async () => { ingestCalled = true; return { ok: true }; },
  });
  assert.equal(r.synced, false);
  assert.equal(r.reason, 'fetch_failed');
  assert.equal(ingestCalled, false);
});

test('windowed reads forward reconcileDeletes:false to ingest', async () => {
  let seen = null;
  await runOneGcalSyncTick({
    fetchSource: async () => ({ ok: true, events: [], reconcileDeletes: false }),
    ingest: async (args) => { seen = args; return { ok: true, new: [] }; },
  });
  assert.equal(seen.reconcileDeletes, false);
});

test('ingest failure is reported, not thrown', async () => {
  const r = await runOneGcalSyncTick({
    fetchSource: async () => ({ ok: true, icsText: 'x' }),
    ingest: async () => ({ ok: false, error: 'unruh down' }),
  });
  assert.equal(r.synced, false);
  assert.equal(r.reason, 'ingest_failed');
});
