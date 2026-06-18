import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  desiredManaged,
  reconcile,
  managedSearxngUrl,
  stopManagedSearxng,
} from '../searxng-service.js';

// ── desiredManaged — pure decision ───────────────────────────────
const present  = () => true;
const absent   = () => false;
const off      = () => false;  // not hard-disabled
const on       = () => true;   // hard-disabled

test('desiredManaged wants a managed instance only when fully eligible', () => {
  const base = { webSearchEnabled: true };
  assert.equal(desiredManaged(base, { present, disabled: off }), true);
});

test('desiredManaged declines when web search is off', () => {
  assert.equal(desiredManaged({ webSearchEnabled: false }, { present, disabled: off }), false);
  assert.equal(desiredManaged({},                          { present, disabled: off }), false);
});

test('desiredManaged declines when the human set their own SearXNG URL', () => {
  const s = { webSearchEnabled: true, webSearchBaseUrl: 'http://localhost:8080' };
  assert.equal(desiredManaged(s, { present, disabled: off }), false);
});

test('desiredManaged declines when the source is absent or env-disabled', () => {
  assert.equal(desiredManaged({ webSearchEnabled: true }, { present: absent, disabled: off }), false);
  assert.equal(desiredManaged({ webSearchEnabled: true }, { present,         disabled: on  }), false);
});

// ── reconcile — lifecycle with injected side effects ─────────────
function fakeChild() {
  const handlers = {};
  return {
    kill() { this._killed = true; },
    on(ev, fn) { handlers[ev] = fn; },
    emit(ev)   { handlers[ev]?.(); },
    _killed: false,
  };
}

test('reconcile spawns when desired, then tears down when no longer desired', async () => {
  let spawned = 0;
  const child = fakeChild();
  const deps = {
    present:  present,
    disabled: off,
    ensureDeps: async () => {},
    spawnFn:  async () => { spawned += 1; return { child, url: 'http://127.0.0.1:9999' }; },
  };

  // Enabled → comes up and publishes its URL.
  await reconcile({ ...deps, readSettings: () => ({ webSearchEnabled: true }) });
  assert.equal(spawned, 1);
  assert.equal(managedSearxngUrl(), 'http://127.0.0.1:9999');

  // Idempotent: a second reconcile while ready does not respawn.
  await reconcile({ ...deps, readSettings: () => ({ webSearchEnabled: true }) });
  assert.equal(spawned, 1);

  // Disabled → torn down, URL gone, child killed.
  await reconcile({ ...deps, readSettings: () => ({ webSearchEnabled: false }) });
  assert.equal(managedSearxngUrl(), null);
  assert.equal(child._killed, true);
});

test('reconcile degrades to keyless (null URL) when the spawn fails', async () => {
  await stopManagedSearxng(); // clean slate
  const deps = {
    present:  present,
    disabled: off,
    ensureDeps: async () => {},
    spawnFn:  async () => { throw new Error('uv not found'); },
    readSettings: () => ({ webSearchEnabled: true }),
  };
  await reconcile(deps);           // must not throw
  assert.equal(managedSearxngUrl(), null);
});

test('a child that exits on its own drops the managed URL back to null', async () => {
  await stopManagedSearxng();
  const child = fakeChild();
  await reconcile({
    present, disabled: off, ensureDeps: async () => {},
    spawnFn: async () => ({ child, url: 'http://127.0.0.1:8123' }),
    readSettings: () => ({ webSearchEnabled: true }),
  });
  assert.equal(managedSearxngUrl(), 'http://127.0.0.1:8123');
  child.emit('exit');              // SearXNG crashed/exited
  assert.equal(managedSearxngUrl(), null);
  await stopManagedSearxng();
});
