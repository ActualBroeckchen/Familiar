import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  desiredEngine,
  reconcile,
  managedEngineUrl,
  managedEngineSearch,
  stopLocalEngines,
} from '../local-engine-service.js';

const off = () => false; // not hard-disabled
const on  = () => true;  // hard-disabled

// A fake engine descriptor with an injectable child + a spawn counter.
function fakeChild() {
  const handlers = {};
  return {
    kill() { this._killed = true; },
    on(ev, fn) { handlers[ev] = fn; },
    emit(ev)   { handlers[ev]?.(); },
    _killed: false,
  };
}
function fakeEngine(id) {
  const child = fakeChild();
  const eng = {
    id, label: id, strain: 'low', runtime: 'python',
    installed: () => true,
    ensureInstalled: async () => {},
    spawn: async () => { eng._spawns += 1; return { child, url: `http://127.0.0.1/${id}` }; },
    search: async (base, q) => ({ rows: [{ title: id, url: base, content: q }] }),
    uninstall: async () => {},
    _child: child,
    _spawns: 0,
  };
  return eng;
}

const localOn = (engine = 'searxng') => ({
  webSearchEnabled: true, webSearchBackend: 'local', webSearchLocalEngine: engine,
});

// ── desiredEngine — pure decision ────────────────────────────────
test('desiredEngine returns the selected engine only when fully eligible', () => {
  assert.equal(desiredEngine(localOn('searxng'), { disabled: off }), 'searxng');
});

test('desiredEngine declines when web search is off', () => {
  assert.equal(desiredEngine({ webSearchBackend: 'local' }, { disabled: off }), null);
});

test('desiredEngine declines when the backend is not "local"', () => {
  assert.equal(desiredEngine({ webSearchEnabled: true, webSearchBackend: 'basic' }, { disabled: off }), null);
  assert.equal(desiredEngine({ webSearchEnabled: true, webSearchBackend: 'api' }, { disabled: off }), null);
});

test('desiredEngine declines when the human set their own SearXNG URL', () => {
  const s = { webSearchEnabled: true, webSearchBackend: 'local', webSearchBaseUrl: 'http://localhost:8080' };
  assert.equal(desiredEngine(s, { disabled: off }), null);
});

test('desiredEngine declines an unknown engine', () => {
  assert.equal(desiredEngine(localOn('nope'), { disabled: off }), null);
});

test('desiredEngine declines when env-disabled', () => {
  assert.equal(desiredEngine(localOn('searxng'), { disabled: on }), null);
});

// ── reconcile — lifecycle with injected engines ──────────────────
test('reconcile starts the selected engine, is idempotent, and tears down when deselected', async () => {
  await stopLocalEngines();
  const eng = fakeEngine('searxng');
  const engines = { searxng: eng };
  const deps = { engines, disabled: off };

  await reconcile({ ...deps, readSettings: () => localOn('searxng') });
  assert.equal(managedEngineUrl(), 'http://127.0.0.1/searxng');
  assert.equal(eng._spawns, 1);

  // Idempotent: a second reconcile while ready does not respawn.
  await reconcile({ ...deps, readSettings: () => localOn('searxng') });
  assert.equal(eng._spawns, 1);

  // Deselected → torn down, URL gone, child killed.
  await reconcile({ ...deps, readSettings: () => ({ webSearchEnabled: false }) });
  assert.equal(managedEngineUrl(), null);
  assert.equal(eng._child._killed, true);
});

test('reconcile switches engines: stops the old, starts the new', async () => {
  await stopLocalEngines();
  const a = fakeEngine('searxng');
  const b = fakeEngine('librey');
  const engines = { searxng: a, librey: b };
  const deps = { engines, disabled: off };

  await reconcile({ ...deps, readSettings: () => localOn('searxng') });
  assert.equal(managedEngineUrl(), 'http://127.0.0.1/searxng');

  await reconcile({ ...deps, readSettings: () => localOn('librey') });
  assert.equal(managedEngineUrl(), 'http://127.0.0.1/librey');
  assert.equal(a._child._killed, true);   // old one stopped
  assert.equal(b._spawns, 1);
  await stopLocalEngines();
});

test('reconcile degrades to keyless (null URL) when the spawn fails', async () => {
  await stopLocalEngines();
  const engines = { searxng: { ...fakeEngine('searxng'), spawn: async () => { throw new Error('uv not found'); } } };
  await reconcile({ engines, disabled: off, readSettings: () => localOn('searxng') });
  assert.equal(managedEngineUrl(), null); // must not throw
});

test('managedEngineSearch delegates to the active engine, and errors when none runs', async () => {
  await stopLocalEngines();
  assert.match((await managedEngineSearch('x')).error, /no managed search engine/);
  const eng = fakeEngine('searxng');
  await reconcile({ engines: { searxng: eng }, disabled: off, readSettings: () => localOn('searxng') });
  const r = await managedEngineSearch('hi');
  assert.deepEqual(r.rows[0], { title: 'searxng', url: 'http://127.0.0.1/searxng', content: 'hi' });
  await stopLocalEngines();
  assert.match((await managedEngineSearch('x')).error, /no managed search engine/);
});

test('a child that exits on its own drops the managed URL back to null', async () => {
  await stopLocalEngines();
  const eng = fakeEngine('searxng');
  await reconcile({ engines: { searxng: eng }, disabled: off, readSettings: () => localOn('searxng') });
  assert.equal(managedEngineUrl(), 'http://127.0.0.1/searxng');
  eng._child.emit('exit');               // engine crashed/exited
  assert.equal(managedEngineUrl(), null);
  await stopLocalEngines();
});
