/**
 * searxng-service.js — optional Familiar-managed SearXNG backend.
 *
 * Web search works out of the box with a keyless in-process backend
 * (websearch.js → DuckDuckGo). That is the always-available floor and it
 * can never fail to "start." For a sturdier, self-hosted backend, the
 * Familiar can run its OWN SearXNG — brought up when my human turns on
 * "Web search & read" and taken down when they turn it off (or on server
 * shutdown). Same toggle-followed lifecycle the Discord gateway uses.
 *
 * The managed instance is a VENDORED THIRD-PARTY APP under ./vendor/searxng/
 * (uv-managed), not our own code. It is entirely optional: when the source
 * isn't present, or uv is missing, or the spawn fails, this module simply
 * stays down and search falls back to keyless. A managed instance can never
 * break search — that's the graceful-degradation contract.
 *
 * Resolution at the executor (cerebellum): the effective search backend is
 *     custom webSearchBaseUrl  ?? managedSearxngUrl()  ?? '' (keyless)
 * so managedSearxngUrl() returning null is always a safe keyless fallback.
 *
 * Hard off-switch: PROTO_FAMILIAR_SEARXNG_DISABLED=1 (keyless still works).
 *
 * Verification note: the real spawn (uv + `python -m searx.webapp`) cannot
 * be exercised until the SearXNG source is vendored in; that invocation is
 * the one integration point to smoke-test on a real install. Everything
 * around it — the desired-state logic and the reconcile loop — is pure and
 * unit-tested, and all side effects are injectable.
 */

import path from 'path';
import net from 'net';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VENDORED_DIR = path.join(__dirname, 'vendor', 'searxng');
const PATCHES_DIR  = path.join(__dirname, 'vendor', 'searxng-patches');

// SearXNG is NOT vendored into the repo (its ~970-file source bloated it).
// The managed backend FETCHES it on first enable, pinned to this exact commit,
// then re-applies the tracked patches under vendor/searxng-patches/. Moving the
// pin = bump SEARXNG_PIN + re-run the spawn smoke-test (CLAUDE.md cadence).
const SEARXNG_REPO = 'https://github.com/searxng/searxng';
const SEARXNG_PIN  = 'b5ef7ec8f32b7020cc0f887e26f0d01b85949d17';
const SOURCE_RETRY_COOLDOWN_MS = 60 * 60_000;   // back off 1h after a failed fetch
let _nextSourceAttemptTs = 0;
const RUNTIME_DIR  = path.join(__dirname, 'tomes', '.searxng');   // generated settings.yml (gitignored area)
const SETTINGS_YML = path.join(RUNTIME_DIR, 'settings.yml');

const SUPERVISOR_INTERVAL_MS = 30_000;
const HEALTH_TIMEOUT_MS      = 45_000;
const HEALTH_POLL_MS         = 1_000;

// ── Module state (single managed child) ───────────────────────────
let _state        = 'down';   // 'down' | 'starting' | 'ready' | 'stopping'
let _child        = null;
let _url          = null;
let _timer        = null;
let _depsEnsured  = false;
let _readSettings = () => ({});

/** The healthy managed URL, or null when nothing is running. Safe to call
 *  anytime — cerebellum uses it to resolve the effective search backend. */
export function managedSearxngUrl() {
  return _state === 'ready' ? _url : null;
}

export function searxngHardDisabled() {
  return process.env.PROTO_FAMILIAR_SEARXNG_DISABLED === '1';
}

/** Is the vendored SearXNG source actually present? Absent → stay keyless. */
export function searxngSourcePresent() {
  return existsSync(path.join(VENDORED_DIR, 'searx', 'webapp.py'));
}

/**
 * Pure desired-state: do we want our OWN managed SearXNG running right now?
 * Yes only when web access is on, the human hasn't pointed us at their own
 * SearXNG (a custom base URL means "use mine, don't manage one"), the env
 * switch is off, and the source is vendored in. Side-effect probes are
 * injected for tests.
 */
export function desiredManaged(settings, {
  disabled = searxngHardDisabled,
} = {}) {
  if (disabled()) return false;
  if (settings?.webSearchEnabled !== true) return false;
  if (String(settings?.webSearchBaseUrl || '').trim()) return false; // custom URL → not ours
  return true;   // source absence is handled by fetch-on-enable, not gated here
}

// ── Lifecycle ─────────────────────────────────────────────────────

/**
 * Reconcile actual vs desired once. Injectable: readSettings, the spawn,
 * the dep-ensure, and the desired-state probes. Never throws.
 */
export async function reconcile(deps = {}) {
  const readSettings = deps.readSettings || _readSettings;
  const want = desiredManaged(readSettings(), deps);

  if (want && _state === 'down') {
    await startManaged(deps);
  } else if (!want && (_state === 'ready' || _state === 'starting')) {
    await stopManaged();
  }
}

async function startManaged(deps = {}) {
  _state = 'starting';
  try {
    if (!_depsEnsured) {
      await (deps.ensureDeps || ensureDeps)();
      _depsEnsured = true;
    }
    const { child, url } = await (deps.spawnFn || spawnSearxng)();
    _child = child;
    _url   = url;
    _state = 'ready';
    // If the child dies on its own, drop back to down so the next reconcile
    // (or the next search via managedSearxngUrl) falls through to keyless.
    _child?.on?.('exit', () => {
      if (_child === child) { _child = null; _url = null; _state = 'down'; }
    });
    console.log(`[searxng] managed instance ready at ${url}`);
  } catch (err) {
    console.warn(`[searxng] could not start managed instance (${err.message}); web search falls back to the built-in keyless backend`);
    await stopManaged();
  }
}

async function stopManaged() {
  _state = 'stopping';
  if (_child) {
    try { _child.kill('SIGTERM'); } catch { /* already gone */ }
    _child = null;
  }
  _url   = null;
  _state = 'down';
}

/**
 * Start the supervisor: reconcile immediately, then every 30s so toggling
 * the setting brings the instance up/down without a restart (mirrors the
 * Discord gateway). No-op (keyless only) when hard-disabled.
 */
export function startSearxngSupervisor({ readSettings = () => ({}), intervalMs = SUPERVISOR_INTERVAL_MS } = {}) {
  _readSettings = readSettings;
  if (searxngHardDisabled()) {
    console.log('[searxng] managed backend hard-disabled via PROTO_FAMILIAR_SEARXNG_DISABLED=1 (keyless search still works)');
    return;
  }
  if (!searxngSourcePresent()) {
    console.log('[searxng] managed SearXNG source not present yet — it will be fetched (pinned) the first time web search is enabled; keyless search works meanwhile');
    // Still arm the supervisor: if the source is dropped in later, the next
    // tick picks it up without a restart.
  }
  reconcile({ readSettings }).catch(() => { /* never throws into boot */ });
  _timer = setInterval(() => reconcile({ readSettings }).catch(() => {}), intervalMs);
  _timer.unref?.();
}

/** Stop the supervisor and tear down any managed child. */
export async function stopManagedSearxng() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  await stopManaged();
}

// ── Real side effects (the verify-on-real-install integration point) ──
// These are the default implementations; tests inject fakes.
//
// SearXNG uses requirements.txt + setup.py (not pyproject.toml), so the
// uv sync / uv run flow doesn't apply. Instead: uv venv .venv to create the
// environment, uv pip install --python <venv-py> -r requirements.txt to
// populate it, then invoke the venv Python directly to spawn the webapp.
// Verified at SHA b5ef7ec: entrypoint `python -m searx.webapp`, bind/port
// from settings.yml only, health endpoint GET /healthz → 200 "OK",
// SEARXNG_SETTINGS_PATH read by settings_loader (settings_loader.py:93).

function getVenvPython() {
  const venvDir = path.join(VENDORED_DIR, '.venv');
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

// Fetch the pinned SearXNG source on first enable (it's not in the repo), then
// re-apply the tracked patches. Idempotent: returns immediately once present.
// On failure it backs off 1h and cleans up a half-clone, so a missing git /
// no network degrades to keyless without re-cloning every tick.
async function ensureSource() {
  if (searxngSourcePresent()) return;
  if (Date.now() < _nextSourceAttemptTs) throw new Error('source fetch backing off after a recent failure');
  try {
    console.log(`[searxng] fetching SearXNG source (pinned ${SEARXNG_PIN.slice(0, 7)}) — one-time, on first enable…`);
    mkdirSync(VENDORED_DIR, { recursive: true });
    await runToCompletion('git', ['init', '-q'], { cwd: VENDORED_DIR });
    await runToCompletion('git', ['remote', 'add', 'origin', SEARXNG_REPO], { cwd: VENDORED_DIR }).catch(() => {});
    await runToCompletion('git', ['fetch', '-q', '--depth', '1', 'origin', SEARXNG_PIN], { cwd: VENDORED_DIR });
    await runToCompletion('git', ['checkout', '-q', 'FETCH_HEAD'], { cwd: VENDORED_DIR });
    rmSync(path.join(VENDORED_DIR, '.git'), { recursive: true, force: true }); // vendored files, not an embedded repo
    await applyPatches();
    if (!searxngSourcePresent()) throw new Error('fetched but searx/webapp.py is missing (unexpected layout)');
    console.log('[searxng] SearXNG source fetched + patched.');
  } catch (err) {
    _nextSourceAttemptTs = Date.now() + SOURCE_RETRY_COOLDOWN_MS;
    try { rmSync(VENDORED_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw new Error(`could not fetch SearXNG source (${err.message}); web search stays on the keyless backend`);
  }
}

// Apply every tracked vendor/searxng-patches/*.patch (e.g. the Windows pwd
// guard) in order. `git apply` patches files in a plain dir — no repo needed.
async function applyPatches() {
  let patches;
  try { patches = readdirSync(PATCHES_DIR).filter(f => f.endsWith('.patch')).sort(); }
  catch { return; }
  for (const p of patches) {
    await runToCompletion('git', ['apply', path.join(PATCHES_DIR, p)], { cwd: VENDORED_DIR });
  }
}

async function ensureDeps() {
  await ensureSource();   // fetch the pinned source if it isn't here yet
  // Fast path: venv already materialised from a previous boot.
  if (existsSync(getVenvPython())) return;
  await runToCompletion('uv', ['venv', '.venv'], { cwd: VENDORED_DIR });
  await runToCompletion(
    'uv', ['pip', 'install', '--python', getVenvPython(), '-r', 'requirements.txt'],
    { cwd: VENDORED_DIR },
  );
}

async function spawnSearxng() {
  const port = await getFreePort();
  const url  = `http://127.0.0.1:${port}`;
  writeManagedSettings(port);

  const child = spawn(getVenvPython(), ['-m', 'searx.webapp'], {
    cwd: VENDORED_DIR,
    // SearXNG reads bind address + port from settings.yml (server.bind_address
    // / server.port) — NOT from env. SEARXNG_SETTINGS_PATH is the documented
    // env var for pointing it at our generated file (verified: settings_loader.py:93).
    env: {
      ...process.env,
      SEARXNG_SETTINGS_PATH: SETTINGS_YML,
    },
    stdio: 'ignore',
  });

  await waitHealthy(url);
  return { child, url };
}

function writeManagedSettings(port) {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const secret = crypto.randomBytes(32).toString('hex');
  // Minimal, JSON-enabled, loopback-bound config. We own this file; the
  // human never edits it. Generated secret_key keeps SearXNG happy.
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
  writeFileSync(SETTINGS_YML, yml, 'utf8');
}

async function waitHealthy(url, { timeoutMs = HEALTH_TIMEOUT_MS, pollMs = HEALTH_POLL_MS, fetchFn = fetch } = {}) {
  // webapp.py exposes GET /healthz → 200 "OK" (verified against the pinned SHA);
  // cheaper and more reliable than driving a real search to test readiness.
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'no response';
  while (Date.now() < deadline) {
    try {
      const res = await fetchFn(`${url}/healthz`);
      if (res.ok) return true;
      lastErr = `HTTP ${res.status}`;
    } catch (err) { lastErr = err.message; }
    await sleep(pollMs);
  }
  throw new Error(`SearXNG did not become healthy within ${Math.round(timeoutMs / 1000)}s (${lastErr})`);
}

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
