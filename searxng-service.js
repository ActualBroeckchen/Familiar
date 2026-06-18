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
import { existsSync, mkdirSync, writeFileSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VENDORED_DIR = path.join(__dirname, 'vendor', 'searxng');
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
  present  = searxngSourcePresent,
  disabled = searxngHardDisabled,
} = {}) {
  if (disabled()) return false;
  if (settings?.webSearchEnabled !== true) return false;
  if (String(settings?.webSearchBaseUrl || '').trim()) return false; // custom URL → not ours
  if (!present()) return false;
  return true;
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
    console.log('[searxng] no vendored SearXNG source — web search uses the built-in keyless backend (this is fine; the managed backend is optional)');
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
// These are the default implementations; tests inject fakes. The exact uv
// invocation and module entrypoint must be confirmed against the vendored
// SearXNG version when the source is dropped in.

async function ensureDeps() {
  // Lazily materialise the SearXNG venv with uv — only the first time the
  // human enables web search, never at every boot.
  await runToCompletion('uv', ['sync'], { cwd: VENDORED_DIR });
}

async function spawnSearxng() {
  const port = await getFreePort();
  const url  = `http://127.0.0.1:${port}`;
  writeManagedSettings(port);

  const child = spawn('uv', ['run', '--no-sync', 'python', '-m', 'searx.webapp'], {
    cwd: VENDORED_DIR,
    // SearXNG reads the bind address + port from settings.yml (server.bind_address
    // / server.port), which writeManagedSettings sets — NOT from env (verified
    // against the pinned SHA's searx/webapp.py). SEARXNG_SETTINGS_PATH is the
    // documented way to point it at our generated file (read by settings_loader);
    // confirm that path is honoured on the first real boot.
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
