import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runOneGcalSyncTick, clampSyncIntervalMs, DEFAULT_SYNC_INTERVAL_MS,
  startGcalSyncLoop, stopGcalSyncLoop, FAILURE_RETRY_MS,
} from '../src/gcal/gcal-sync-loop.js';

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

test('a failed sync retries on the short leash; success consumes the full interval', async () => {
  let t = 0;
  let ok = false;
  const attempts = [];
  startGcalSyncLoop({
    baseTickMs: 5,
    now: () => t,
    isEnabled: async () => true,
    getIntervalMs: async () => 60 * 60_000,
    fetchSource: async () => { attempts.push(t); return ok ? { ok: true, icsText: 'x' } : { ok: false, error: 'boom' }; },
    ingest: async () => ({ ok: true, new: [] }),
  });
  const settle = () => new Promise(r => setTimeout(r, 40));
  try {
    await settle();
    assert.equal(attempts.length, 1, 'boot fire attempted once');
    await settle();
    assert.equal(attempts.length, 1, 'a failure does not re-attempt inside the leash');
    t = FAILURE_RETRY_MS + 1;
    await settle();
    assert.equal(attempts.length, 2, 'retried once the failure leash elapsed — not the full hour');
    ok = true;
    t += FAILURE_RETRY_MS + 1;
    await settle();
    assert.equal(attempts.length, 3, 'second retry succeeded');
    t += 30 * 60_000;
    await settle();
    assert.equal(attempts.length, 3, 'success consumed the full interval');
    t += 31 * 60_000;
    await settle();
    assert.equal(attempts.length, 4, 'due again after the interval');
  } finally {
    await stopGcalSyncLoop();
  }
});

test('multi-snapshot: fetchSource returning snapshots[] ingests each with calendarId', async () => {
  const ingests = [];
  const r = await runOneGcalSyncTick({
    fetchSource: async () => ({
      ok: true,
      snapshots: [
        { events: [{ uid: 'e1' }], calendarId: 'calA' },
        { events: [{ uid: 'e2' }], calendarId: 'calB' },
      ],
    }),
    ingest: async (args) => {
      ingests.push(args);
      return { ok: true, new: ['n' + args.calendarId], updated: [], removed: [] };
    },
  });
  assert.equal(ingests.length, 2, 'ingest called once per snapshot');
  assert.equal(ingests[0].calendarId, 'calA');
  assert.equal(ingests[1].calendarId, 'calB');
  assert.deepEqual(r.new, ['ncalA', 'ncalB'], 'new ids from all snapshots collected');
  assert.equal(r.synced, true);
});

test('multi-snapshot: one calendar fails, others succeed → synced:true', async () => {
  const ingests = [];
  const r = await runOneGcalSyncTick({
    fetchSource: async () => ({
      ok: true,
      snapshots: [
        { events: [{ uid: 'e1' }], calendarId: 'calA' },
        { events: [{ uid: 'e2' }], calendarId: 'calB' },
      ],
    }),
    ingest: async (args) => {
      ingests.push(args);
      // calA fails, calB succeeds
      if (args.calendarId === 'calA') return { ok: false, error: 'auth failed' };
      return { ok: true, new: ['ncalB'], updated: [], removed: [] };
    },
  });
  assert.equal(ingests.length, 2);
  assert.equal(r.synced, true, 'synced should be true if any calendar succeeds');
  assert.deepEqual(r.new, ['ncalB']);
});

test('multi-snapshot: all calendars fail → synced:false, reason ingest_failed', async () => {
  const r = await runOneGcalSyncTick({
    fetchSource: async () => ({
      ok: true,
      snapshots: [
        { events: [{ uid: 'e1' }], calendarId: 'calA' },
        { events: [{ uid: 'e2' }], calendarId: 'calB' },
      ],
    }),
    ingest: async () => ({ ok: false, error: 'unruh down' }),
  });
  assert.equal(r.synced, false);
  assert.equal(r.reason, 'ingest_failed');
});

test('multi-snapshot: attribution passed to ingest per snapshot', async () => {
  const ingests = [];
  const r = await runOneGcalSyncTick({
    fetchSource: async () => ({
      ok: true,
      snapshots: [
        { events: [{ uid: 'e1' }], calendarId: 'calA', attribution: { kind: 'ward' } },
        { events: [{ uid: 'e2' }], calendarId: 'calB', attribution: { kind: 'villager', ref: 'v1' } },
      ],
    }),
    ingest: async (args) => {
      ingests.push(args);
      return { ok: true, new: [], updated: [], removed: [] };
    },
  });
  assert.equal(ingests[0].attribution.kind, 'ward');
  assert.equal(ingests[1].attribution.kind, 'villager');
  assert.equal(ingests[1].attribution.ref, 'v1');
});

test('legacy single-snapshot (no snapshots array) still works', async () => {
  const ingests = [];
  const r = await runOneGcalSyncTick({
    fetchSource: async () => ({
      ok: true,
      icsText: 'BEGIN:VCALENDAR...',
      reconcileDeletes: true,
    }),
    ingest: async (args) => {
      ingests.push(args);
      return { ok: true, new: ['legacy'], updated: [], removed: [] };
    },
  });
  assert.equal(ingests.length, 1);
  assert.equal(ingests[0].icsText, 'BEGIN:VCALENDAR...');
  assert.equal(ingests[0].reconcileDeletes, true);
});
