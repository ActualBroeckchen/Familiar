/**
 * local-engine-service.js — Familiar-managed local search engines.
 *
 * Web search works out of the box with a keyless in-process backend
 * (websearch.js → DuckDuckGo) and can be upgraded to a proper API
 * (websearch-providers.js). For maximum privacy — nothing leaving the
 * machine — the Familiar can instead run a self-hosted search engine ITSELF,
 * brought up when my human selects the "local" backend and torn down when
 * they switch away (or on server shutdown). Same toggle-followed lifecycle
 * the Discord gateway uses.
 *
 * One supervisor, MANY possible engines — but only ONE runs at a time: the
 * one my human selected (webSearchLocalEngine) while the local backend is
 * active. Each engine is a DESCRIPTOR (how to detect / install / spawn /
 * health-check / uninstall it); the supervisor itself knows nothing
 * engine-specific. SearXNG is the first descriptor; 4get and LibreY (PHP,
 * via a fetched static runtime) land in Part 3.
 *
 * Graceful degradation is absolute: a cold / failed / absent / switching
 * engine ALWAYS leaves managedEngineUrl() returning null, and searchWeb
 * falls through to the keyless floor. A managed engine can never break
 * search — that's the contract every descriptor inherits.
 *
 * Hard off-switch: PROTO_FAMILIAR_LOCAL_ENGINE_DISABLED=1 (the older
 * PROTO_FAMILIAR_SEARXNG_DISABLED=1 is kept as a recognised alias). Keyless
 * + API search still work when disabled.
 */

import path from 'path';
import net from 'net';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readdirSync } from 'fs';

import { searxngSearch, libreySearch, fourgetSearch } from './local-engine-adapters.js';
import { ensurePhp, phpSupported } from './php-runtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPERVISOR_INTERVAL_MS = 30_000;
const HEALTH_TIMEOUT_MS      = 45_000;
const HEALTH_POLL_MS         = 1_000;
const SOURCE_RETRY_COOLDOWN_MS = 60 * 60_000;   // back off 1h after a failed fetch

// ── Supervisor state (single managed child across all engines) ─────
let _state        = 'down';   // 'down' | 'starting' | 'ready' | 'stopping'
let _activeId     = null;     // which engine is running (or null)
let _activeEngine = null;     // the actual running descriptor (authoritative for search)
let _child        = null;
let _url          = null;
let _timer        = null;
let _readSettings = () => ({});
const _depsEnsured = new Set();   // engine ids whose install was confirmed this run
const _installing  = new Set();   // engine ids whose install is in flight (modal polls this)
const _installErr  = new Map();   // engine id → last install error message

/** The healthy managed URL, or null when nothing is running. Safe to call
 *  anytime — searchWeb uses it to resolve the 'local' backend. */
export function managedEngineUrl() {
  return _state === 'ready' ? _url : null;
}

export function localEngineHardDisabled() {
  return process.env.PROTO_FAMILIAR_LOCAL_ENGINE_DISABLED === '1'
      || process.env.PROTO_FAMILIAR_SEARXNG_DISABLED === '1';   // recognised alias
}

/** Is engine `id` installed (its source present on disk)? */
export function engineInstalled(id) {
  return !!ENGINES[id]?.installed();
}

/**
 * Pure desired-state: which local engine (if any) should be running now?
 * Yes only when web access is on, the human chose the 'local' backend,
 * hasn't pointed us at their own instance (a custom base URL means "use
 * mine"), the env switch is off, and the selected engine is one we know.
 * Returns the engine id or null. Probes/engines injectable for tests.
 */
export function desiredEngine(settings, { disabled = localEngineHardDisabled, engines = ENGINES } = {}) {
  if (disabled()) return null;
  if (settings?.webSearchEnabled !== true) return null;
  if (String(settings?.webSearchBaseUrl || '').trim()) return null;          // their own instance
  if (String(settings?.webSearchBackend || 'basic') !== 'local') return null; // not the local backend
  const id = String(settings?.webSearchLocalEngine || 'searxng');
  const eng = engines[id];
  return (eng && eng.available !== false) ? id : null; // unavailable (not-yet-wired) → never desired
}

// ── Lifecycle ─────────────────────────────────────────────────────

/**
 * Reconcile actual vs desired once. Switching engines tears the current one
 * down before bringing the next up. Injectable (readSettings, engines map,
 * disabled probe). Never throws.
 */
export async function reconcile(deps = {}) {
  const readSettings = deps.readSettings || _readSettings;
  const engines = deps.engines || ENGINES;
  const want = desiredEngine(readSettings(), deps);

  // Wrong engine running (or none wanted): stop it first.
  if (_activeId && want !== _activeId && (_state === 'ready' || _state === 'starting')) {
    await stopEngine();
  }
  // Nothing running and one is wanted: start it (same tick after a switch).
  if (want && _state === 'down') {
    await startEngine(want, engines);
  }
}

async function startEngine(id, engines) {
  const eng = engines[id];
  if (!eng) { console.warn(`[local-engine] unknown engine "${id}"`); return; }
  _state        = 'starting';
  _activeId     = id;
  _activeEngine = eng;
  try {
    if (!_depsEnsured.has(id)) {
      await eng.ensureInstalled();
      _depsEnsured.add(id);
    }
    const { child, url } = await eng.spawn();
    _child = child;
    _url   = url;
    _state = 'ready';
    // If the child dies on its own, drop back to down so the next reconcile
    // (or the next search via managedEngineUrl) falls through to keyless.
    _child?.on?.('exit', () => {
      if (_child === child) { _child = null; _url = null; _state = 'down'; _activeId = null; _activeEngine = null; }
    });
    console.log(`[local-engine] ${id} ready at ${url}`);
  } catch (err) {
    console.warn(`[local-engine] could not start ${id} (${err.message}); web search falls back to the built-in keyless backend`);
    await stopEngine();
  }
}

async function stopEngine() {
  _state = 'stopping';
  if (_child) {
    try { _child.kill('SIGTERM'); } catch { /* already gone */ }
    _child = null;
  }
  _url          = null;
  _activeId     = null;
  _activeEngine = null;
  _state        = 'down';
}

/**
 * Start the supervisor: reconcile immediately, then every 30s so changing
 * the backend brings an engine up/down without a restart (mirrors the
 * Discord gateway). No-op (keyless/API only) when hard-disabled.
 */
export function startLocalEngineSupervisor({ readSettings = () => ({}), intervalMs = SUPERVISOR_INTERVAL_MS } = {}) {
  _readSettings = readSettings;
  if (localEngineHardDisabled()) {
    console.log('[local-engine] managed local engines hard-disabled via PROTO_FAMILIAR_LOCAL_ENGINE_DISABLED=1 (keyless + API search still work)');
    return;
  }
  reconcile({ readSettings }).catch(() => { /* never throws into boot */ });
  _timer = setInterval(() => reconcile({ readSettings }).catch(() => {}), intervalMs);
  _timer.unref?.();
}

/** Stop the supervisor and tear down any managed child. */
export async function stopLocalEngines() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  await stopEngine();
}

// ── Modal-facing lifecycle (install / uninstall / status) ─────────
// These back the Settings web-search modal's per-engine controls (Part 2c).

/** Fetch + install an engine WITHOUT spawning it (the modal's Install
 *  button, so a human can pre-install / see it succeed without activating). */
export async function installEngine(id) {
  const eng = ENGINES[id];
  if (!eng) throw new Error(`unknown engine "${id}"`);
  if (eng.available === false) throw new Error(`${eng.label} isn't available yet`);
  await eng.ensureInstalled();
  _depsEnsured.add(id);
  return { id, installed: true };
}

/** Kick off installEngine in the BACKGROUND and record progress, so the HTTP
 *  handler returns immediately (a real install — git fetch + venv — can take
 *  minutes) and the modal polls localEngineStatus for the phase. */
export function startInstall(id) {
  const eng = ENGINES[id];
  if (!eng) throw new Error(`unknown engine "${id}"`);
  if (eng.available === false) throw new Error(`${eng.label} isn't available yet`);
  if (_installing.has(id)) return { id, phase: 'installing' };
  _installing.add(id);
  _installErr.delete(id);
  installEngine(id)
    .then(()    => { _installing.delete(id); })
    .catch(err => { _installing.delete(id); _installErr.set(id, err.message); });
  return { id, phase: 'installing' };
}

/** Stop (if active) and delete an engine's installed files (the modal's
 *  Uninstall button). Falls back to keyless until another is selected. */
export async function uninstallEngine(id) {
  const eng = ENGINES[id];
  if (!eng) throw new Error(`unknown engine "${id}"`);
  if (_activeId === id) await stopEngine();
  _depsEnsured.delete(id);
  await eng.uninstall();
  return { id, installed: false };
}

/** Snapshot for the modal: every known engine with its install/active state. */
export function localEngineStatus() {
  const engines = {};
  for (const [id, e] of Object.entries(ENGINES)) {
    const installed = e.installed();
    const active    = _activeId === id && _state === 'ready';
    // The single phase the modal renders its buttons from.
    let phase;
    if (e.available === false)  phase = 'unavailable';   // not-yet-wired → greyed
    else if (_installing.has(id)) phase = 'installing';
    else if (active)            phase = 'active';
    else if (installed)         phase = 'installed';
    else if (_installErr.has(id)) phase = 'failed';
    else                        phase = 'absent';
    engines[id] = {
      id,
      label:     e.label,
      strain:    e.strain,       // 'low' | 'med' | 'high'
      runtime:   e.runtime,      // 'python' | 'php'
      available: e.available !== false,
      installed,
      active,
      phase,
      error:     _installErr.get(id) || null,
    };
  }
  return {
    active:       _state === 'ready' ? _activeId : null,
    url:          managedEngineUrl(),
    hardDisabled: localEngineHardDisabled(),
    engines,
  };
}

/** Trigger an immediate reconcile (the modal's Apply, so a backend change
 *  takes effect now rather than on the next 30s tick). Fire-and-forget —
 *  spawning can be slow; the modal polls localEngineStatus for the outcome. */
export function applyLocalEngine() {
  reconcile({ readSettings: _readSettings }).catch(() => {});
  return localEngineStatus();
}

/**
 * Query the currently-running managed engine, in its own JSON dialect. Bound
 * into searchWeb (cerebellum injects this as deps.managedSearch) so web search
 * can use whichever engine is active without knowing its shape. Returns
 * { error } when nothing is ready — searchWeb degrades that to the keyless
 * floor. Never throws.
 */
export async function managedEngineSearch(q, deps = {}) {
  if (_state !== 'ready' || !_activeEngine || !_url) {
    return { error: 'no managed search engine is running right now.' };
  }
  if (!_activeEngine.search) return { error: 'the running engine has no search adapter.' };
  try {
    return await _activeEngine.search(_url, q, deps);
  } catch (err) {
    return { error: `my ${_activeEngine.label} search failed (${err.message}).` };
  }
}

// ════════════════════════════════════════════════════════════════
//  Engine descriptors
// ════════════════════════════════════════════════════════════════
// Each descriptor is the ONLY engine-specific code; the supervisor above is
// generic. Adding an engine (Part 3: 4get, LibreY) = one descriptor here
// (+ its fetched runtime) and one ENGINES entry.

// ── SearXNG (Python, uv-managed) ──────────────────────────────────
// NOT vendored into the repo (its ~970-file source bloated it). Fetched on
// first install, pinned to this exact commit, then the tracked patches under
// vendor/searxng-patches/ are re-applied. Moving the pin = bump SEARXNG_PIN +
// re-run the spawn smoke-test (CLAUDE.md cadence).
const SEARXNG_DIR     = path.join(__dirname, 'vendor', 'searxng');
const SEARXNG_PATCHES = path.join(__dirname, 'vendor', 'searxng-patches');
const SEARXNG_REPO    = 'https://github.com/searxng/searxng';
const SEARXNG_PIN     = 'b5ef7ec8f32b7020cc0f887e26f0d01b85949d17';
const SEARXNG_RUNTIME = path.join(__dirname, 'tomes', '.searxng');   // generated settings.yml
const SEARXNG_YML     = path.join(SEARXNG_RUNTIME, 'settings.yml');
let _searxngSourceRetryTs = 0;

function searxngVenvPython() {
  const venvDir = path.join(SEARXNG_DIR, '.venv');
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

function searxngInstalled() {
  return existsSync(path.join(SEARXNG_DIR, 'searx', 'webapp.py'));
}

// Fetch the pinned SearXNG source (it's not in the repo), then re-apply the
// tracked patches. Idempotent. On failure backs off 1h and cleans up a
// half-clone, so a missing git / no network degrades to keyless cleanly.
async function ensureSearxngSource() {
  if (searxngInstalled()) return;
  if (Date.now() < _searxngSourceRetryTs) throw new Error('source fetch backing off after a recent failure');
  try {
    console.log(`[local-engine] fetching SearXNG source (pinned ${SEARXNG_PIN.slice(0, 7)}) — one-time, on first install…`);
    await gitFetchPinned(SEARXNG_DIR, SEARXNG_REPO, SEARXNG_PIN);
    await applySearxngPatches();
    if (!searxngInstalled()) throw new Error('fetched but searx/webapp.py is missing (unexpected layout)');
    console.log('[local-engine] SearXNG source fetched + patched.');
  } catch (err) {
    _searxngSourceRetryTs = Date.now() + SOURCE_RETRY_COOLDOWN_MS;
    try { rmSync(SEARXNG_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw new Error(`could not fetch SearXNG source (${err.message}); web search stays on the keyless backend`);
  }
}

async function applySearxngPatches() {
  let patches;
  try { patches = readdirSync(SEARXNG_PATCHES).filter(f => f.endsWith('.patch')).sort(); }
  catch { return; }
  for (const p of patches) {
    await runToCompletion('git', ['apply', path.join(SEARXNG_PATCHES, p)], { cwd: SEARXNG_DIR });
  }
}

async function ensureSearxngDeps() {
  await ensureSearxngSource();   // fetch the pinned source if it isn't here yet
  if (existsSync(searxngVenvPython())) return; // venv already materialised
  await runToCompletion('uv', ['venv', '.venv'], { cwd: SEARXNG_DIR });
  await runToCompletion(
    'uv', ['pip', 'install', '--python', searxngVenvPython(), '-r', 'requirements.txt'],
    { cwd: SEARXNG_DIR },
  );
}

async function spawnSearxng() {
  const port = await getFreePort();
  const url  = `http://127.0.0.1:${port}`;
  writeSearxngSettings(port);
  const child = spawn(searxngVenvPython(), ['-m', 'searx.webapp'], {
    cwd: SEARXNG_DIR,
    // bind/port come from settings.yml (not env); SEARXNG_SETTINGS_PATH points
    // the app at our generated file (verified: settings_loader.py:93).
    env: { ...process.env, SEARXNG_SETTINGS_PATH: SEARXNG_YML },
    stdio: 'ignore',
  });
  await waitHealthy(`${url}/healthz`, { label: 'SearXNG' });
  return { child, url };
}

function writeSearxngSettings(port) {
  mkdirSync(SEARXNG_RUNTIME, { recursive: true });
  const secret = crypto.randomBytes(32).toString('hex');
  const yml = [
    'use_default_settings: true',
    'server:',
    `  port: ${port}`,
    '  bind_address: "127.0.0.1"',
    `  secret_key: "${secret}"`,
    'search:',
    '  formats:',
    '    - html',
    '    - json',
    '',
  ].join('\n');
  writeFileSync(SEARXNG_YML, yml, 'utf8');
}

// Poll a health URL until it answers 2xx. Generic across engines — the caller
// passes the full URL (SearXNG: …/healthz; php engines: the app root).
async function waitHealthy(healthUrl, { timeoutMs = HEALTH_TIMEOUT_MS, pollMs = HEALTH_POLL_MS, fetchFn = fetch, label = 'engine' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'no response';
  while (Date.now() < deadline) {
    try {
      const res = await fetchFn(healthUrl);
      if (res.ok) return true;
      lastErr = `HTTP ${res.status}`;
    } catch (err) { lastErr = err.message; }
    await sleep(pollMs);
  }
  throw new Error(`${label} did not become healthy within ${Math.round(timeoutMs / 1000)}s (${lastErr})`);
}

// Shallow-clone a repo at a pinned ref into `dir`, then strip .git so the
// files are vendored (not an embedded repo). Shared by SearXNG and the PHP
// engines so the fetch dance lives in one place.
async function gitFetchPinned(dir, repo, pin) {
  mkdirSync(dir, { recursive: true });
  await runToCompletion('git', ['init', '-q'], { cwd: dir });
  await runToCompletion('git', ['remote', 'add', 'origin', repo], { cwd: dir }).catch(() => {});
  await runToCompletion('git', ['fetch', '-q', '--depth', '1', 'origin', pin], { cwd: dir });
  await runToCompletion('git', ['checkout', '-q', 'FETCH_HEAD'], { cwd: dir });
  rmSync(path.join(dir, '.git'), { recursive: true, force: true });
}

const searxngEngine = {
  id:      'searxng',
  label:   'SearXNG',
  strain:  'high',
  runtime: 'python',
  installed:       searxngInstalled,
  ensureInstalled: ensureSearxngDeps,
  spawn:           spawnSearxng,
  search:          searxngSearch,   // (base, q, deps) → {rows}|{error}
  uninstall: async () => {
    rmSync(SEARXNG_DIR, { recursive: true, force: true });
    _searxngSourceRetryTs = 0;
  },
};

// ── PHP engines (4get / LibreY) ───────────────────────────────────
// Built from a descriptor template: each fetches its own source (pinned) and
// runs under the static PHP binary php-runtime.js fetches, via `php -S` bound
// to loopback. `available` is false where there's no static PHP build
// (Windows), so the modal greys them and they're never desired/installed
// there — SearXNG (uv) still covers Windows. The real spawn is the
// on-real-machine integration point (Linux/macOS); confirm each engine's API
// route/config against its fetched source on first install (build-spec §4b).
//
// `router` (optional): a front-controller script passed to `php -S` for apps
// that rely on URL rewriting (4get). Flat-file apps (LibreY: api.php is a real
// file) need none.
function makePhpEngine({ id, label, strain, repo, pin, entry, configExample, router, search }) {
  const dir = path.join(__dirname, 'vendor', id);
  let retryTs = 0;
  const installed = () => existsSync(path.join(dir, entry));
  return {
    id, label, strain, runtime: 'php',
    get available() { return phpSupported(); },
    installed,
    ensureInstalled: async () => {
      await ensurePhp();                 // fetch the static PHP runtime (throws where unsupported)
      if (installed()) return;
      if (Date.now() < retryTs) throw new Error('source fetch backing off after a recent failure');
      try {
        console.log(`[local-engine] fetching ${label} source (pinned ${String(pin).slice(0, 12)})…`);
        await gitFetchPinned(dir, repo, pin);
        if (configExample) {
          const src = path.join(dir, configExample[0]);
          const dst = path.join(dir, configExample[1]);
          if (existsSync(src) && !existsSync(dst)) copyFileSync(src, dst);
        }
        if (!installed()) throw new Error(`fetched but ${entry} is missing (unexpected layout)`);
        console.log(`[local-engine] ${label} source fetched.`);
      } catch (err) {
        retryTs = Date.now() + SOURCE_RETRY_COOLDOWN_MS;
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
        throw new Error(`could not fetch ${label} source (${err.message})`);
      }
    },
    spawn: async () => {
      const php  = await ensurePhp();
      const port = await getFreePort();
      const url  = `http://127.0.0.1:${port}`;
      const args = ['-S', `127.0.0.1:${port}`, '-t', dir, ...(router ? [router] : [])];
      const child = spawn(php, args, { cwd: dir, stdio: 'ignore' });
      try {
        await waitHealthy(`${url}/`, { label });
      } catch (err) {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        throw err;
      }
      return { child, url };
    },
    search,
    uninstall: async () => { rmSync(dir, { recursive: true, force: true }); retryTs = 0; },
  };
}

const libreyEngine = makePhpEngine({
  id: 'librey', label: 'LibreY', strain: 'low',
  repo: 'https://github.com/Ahwxorg/LibreY', pin: 'main',
  entry: 'index.php',
  configExample: ['config.php.example', 'config.php'],   // API on by default (disable_api:false)
  search: libreySearch,
});

const fourgetEngine = makePhpEngine({
  id: '4get', label: '4get', strain: 'med',
  repo: 'https://git.lolcat.ca/lolcat/4get', pin: 'master',
  entry: 'index.php',
  configExample: ['data/config.php.example', 'data/config.php'],
  router: 'index.php',   // front-controller routing (no apache rewrites under php -S)
  search: fourgetSearch,
});

const ENGINES = {
  searxng: searxngEngine,
  librey:  libreyEngine,
  '4get':  fourgetEngine,
};

// ── Shared spawn helpers ──────────────────────────────────────────

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function runToCompletion(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'ignore', ...opts });
    p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`)));
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
