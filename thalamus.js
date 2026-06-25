/**
 * thalamus.js — Phylactery bridge for Proto-Familiar
 *
 * Mirrors Psycheros's context-building approach (src/entity/context.ts +
 * src/rag/context-builder.ts):
 *
 *   1. All identity categories (self, ward, relationship, custom), each file
 *      wrapped in its promptLabel XML tags and sorted in canonical order.
 *   2. base_instructions.md placed first if present (no section header).
 *   3. Relevant memories formatted with score and source.
 *   4. Knowledge graph context via node search + 1-hop edge traversal.
 *
 * If Phylactery is unreachable for any reason, enrich() logs the error
 * and returns '' so the request continues without enrichment.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
import os from 'os';
import { existsSync, readFileSync, mkdirSync, promises as fsp } from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Match server.js: read the version from package.json so the MCP
// client handshake identifies which Proto-Familiar version connected.
const PKG_VERSION = (() => {
  try { return JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || 'unknown'; }
  catch { return 'unknown'; }
})();

// Consent-pending tracking file — written by memorization.js, read here so the
// Familiar sees pending ask-gate items without an extra MCP call every turn.
const CONSENT_PENDING_FILE = path.join(__dirname, 'tomes', '.consent-pending.json');

// Phylactery — the canonical in-tree self-store. Ships at ./phylactery/
// (subdirectory, same pattern as Unruh). Launched via `uv run python -m
// phylactery` with cwd set to phylactery/ so its ./data/ resolves.
// PROTO_FAMILIAR_PHYLACTERY_DISABLED=1 hard-kills it; the off-switch is
// required by the graceful-degradation rule (every loop ships with one).
const PHYLACTERY_ROOT      = path.resolve(__dirname, 'phylactery');
const PHYLACTERY_PYPROJECT = path.join(PHYLACTERY_ROOT, 'pyproject.toml');
const PHYLACTERY_VENV      = path.join(PHYLACTERY_ROOT, '.venv');

// Unruh — the temporal-context specialist. Ships in-tree at ./unruh/
// (subdirectory rather than sibling repo; see docs/unruh-implementation-plan.md
// §1 Decision 1). Launched via `uv run python -m unruh` with cwd set to
// the unruh/ root so its ./data/ resolves. UNRUH_PATH overrides the probe.
const UNRUH_ROOT = path.resolve(__dirname, 'unruh');
const UNRUH_ENTRY = process.env.UNRUH_PATH ?? path.join(UNRUH_ROOT, 'src', 'unruh', '__main__.py');
const UNRUH_PYPROJECT = path.join(UNRUH_ROOT, 'pyproject.toml');
const UNRUH_VENV = path.join(UNRUH_ROOT, '.venv');
// Hard cap so a slow / hung temporal_context can never block the chat path.
// Real Unruh queries are graph reads in the kilobytes — 2s is generous.
const UNRUH_CALL_TIMEOUT_MS = 2000;

// How long my human has to be quiet before the next chat turn enters
// "idle mode" — temporal_context is called with mode='idle' so Unruh
// returns up to a few due bookmarks for me to weave in if a moment
// opens. 30 minutes matches the documented behaviour in README.md and
// docs/features.md.
const IDLE_THRESHOLD_MS = 30 * 60 * 1000;

// Resolve `uv` to an absolute path. GUI launchers (Proto-Familiar.command,
// the .vbs / tray.ps1) inherit a minimal PATH that often misses ~/.local/bin
// or %LOCALAPPDATA%\uv\bin, so a bare `command: 'uv'` to StdioClientTransport
// silently fails with ENOENT. Probe the known install locations first and
// fall back to PATH only if none match. UV_BIN env var overrides everything.
function resolveUvBinary() {
  if (process.env.UV_BIN && existsSync(process.env.UV_BIN)) return process.env.UV_BIN;
  const home = os.homedir();
  const isWin = process.platform === 'win32';
  const candidates = isWin
    ? [
        path.join(home, '.local', 'bin', 'uv.exe'),                      // Astral's current default
        path.join(process.env.LOCALAPPDATA ?? '', 'uv', 'bin', 'uv.exe'),// older default
        path.join(home, '.cargo', 'bin', 'uv.exe'),
      ]
    : [
        path.join(home, '.local', 'bin', 'uv'),                          // Astral's current default
        path.join(home, '.cargo', 'bin', 'uv'),
        '/usr/local/bin/uv',
        '/opt/homebrew/bin/uv',
      ];
  for (const c of candidates) { if (c && existsSync(c)) return c; }
  return isWin ? 'uv.exe' : 'uv'; // last-resort PATH lookup
}

// Path to the central settings file. server.js owns the read/write
// surface (PUT /api/settings) but we read it here at spawn time to pick
// up the API-key designation for Phylactery. Read is sync and small.
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

// ── Tome / state-file coordination ─────────────────────────────────
//
// Thalamus is the central coordination node — everything that
// retrieves, injects, or mutates state goes through here so callers
// don't have to invent their own queuing. Before this section
// existed, three modules (pondering.js, memorization.js,
// surface-events.js) each had a private copy of the same mutex
// pattern keyed differently, and server.js writeTome had no lock at
// all. That meant the pondering-loop could not coordinate with a
// concurrent /api/temporal/ponderings DELETE — both writers held
// no key in common, both did read-modify-write on the same file,
// the later write clobbered the earlier one. Now all writers route
// through withLock(filePath) here.
//
// Key convention:
//   - FILE-scope (absolute file path) — serialises read-modify-write
//     on a specific file. The right key for tome writes, settings
//     PUT, and any caller that does its own atomic .tmp+rename.
//   - DIR-scope  (absolute directory path) — serialises directory
//     scans plus first-time creation, so two parallel
//     find-or-create-by-name calls can't make two different files.

const _locks = new Map();

/**
 * Run `fn` with exclusive access to `key`. Concurrent calls with the
 * same key serialise; concurrent calls with different keys run in
 * parallel. Returns whatever `fn` returns. Errors propagate.
 */
export function withLock(key, fn) {
  const prev = _locks.get(key) ?? Promise.resolve();
  let release;
  const next = new Promise(r => { release = r; });
  const chained = prev.then(() => next);
  _locks.set(key, chained);
  const run = (async () => {
    await prev;
    try { return await fn(); }
    finally {
      release();
      if (_locks.get(key) === chained) _locks.delete(key);
    }
  })();
  return run;
}

/** Locked read of a tome JSON file. Returns null on missing/corrupt. */
export async function readTomeFile(filePath) {
  return withLock(filePath, async () => {
    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      return JSON.parse(raw);
    } catch { return null; }
  });
}

/**
 * Atomically write a tome JSON file under the per-file lock. Use this
 * for whole-file creates / replacements. For read-modify-write, use
 * modifyTomeFile() so the read and the write run under the same
 * lock acquisition.
 */
export async function writeTomeFile(filePath, tome) {
  return withLock(filePath, async () => {
    const tmp = filePath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(tome, null, 2), 'utf8');
    await fsp.rename(tmp, filePath);
  });
}

/**
 * Locked read-modify-write. Reads the file, calls modifyFn(tome) which
 * can mutate in-place OR return a replacement, then atomically writes
 * back. Use this for every endpoint or loop that edits an existing
 * tome — it's the only way to make the read and the write a single
 * atomic unit against other writers.
 */
export async function modifyTomeFile(filePath, modifyFn) {
  return withLock(filePath, async () => {
    let tome;
    try {
      tome = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    } catch (err) {
      throw new Error(`modifyTomeFile: cannot read ${filePath}: ${err?.message ?? err}`);
    }
    const out = await modifyFn(tome);
    const next = out ?? tome;
    const tmp = filePath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await fsp.rename(tmp, filePath);
    return next;
  });
}

/**
 * Find a tome by `tome.name` in `tomesDir`, or create it from
 * `defaultStruct` if no such tome exists. Returns { tome, file }.
 * Scan and create run under a DIR-scope lock so two parallel calls
 * with the same name can't produce duplicate tomes. The create write
 * is atomic (.tmp + rename) so a crash mid-creation leaves no
 * file rather than a corrupt one.
 */
export async function findOrCreateTomeByName(tomesDir, name, defaultStruct) {
  return withLock(tomesDir, async () => {
    mkdirSync(tomesDir, { recursive: true });
    const files = await fsp.readdir(tomesDir);
    for (const f of files) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      try {
        const raw = await fsp.readFile(path.join(tomesDir, f), 'utf8');
        const t = JSON.parse(raw);
        if (t?.name === name) return { tome: t, file: path.join(tomesDir, f) };
      } catch { /* skip corrupt */ }
    }
    const newId = defaultStruct.id ?? randomUUID();
    const tome = { ...defaultStruct, id: newId };
    const file = path.join(tomesDir, `${newId}.json`);
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(tome, null, 2), 'utf8');
    await fsp.rename(tmp, file);
    return { tome, file };
  });
}

// Phylactery's consolidate.py reads PHYLACTERY_LLM_* first, falling back
// to ENTITY_CORE_LLM_* aliases for continuity. The full chat-completions
// URL (not just the base) is what these vars want — same as the old
// Phylactery contract. Shared via ./providers.js.
import { PROVIDER_URLS } from './providers.js';

/**
 * Build the env block passed to the Phylactery child process based on
 * the saved-connection the user designated (`entityCoreConnectionId` in
 * settings.json — field name kept for backwards compat until Pillar I).
 *
 * Returns {} when no designation exists, the pointed-at connection is
 * missing, or its API key is empty — Phylactery then starts without LLM
 * creds (consolidation will fail, but identity/memory reads still work).
 *
 * Env mapping (both primary and fallback aliases set so every consumer
 * finds what it needs):
 *   PHYLACTERY_LLM_API_KEY   — primary
 *   ENTITY_CORE_LLM_API_KEY  — fallback alias (consolidate.py reads both)
 *   (same pattern for BASE_URL, MODEL, PROVIDER)
 *   ZAI_* — only when provider is zai / zai-coding
 */
function loadPhylacteryEnv() {
  let settings;
  try {
    settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {}; // no settings.json yet (fresh install) or unreadable
  }
  // phylacteryConnectionId is the canonical field name (Pillar I); fall back
  // to the legacy entityCoreConnectionId so old settings.json files still work.
  const id = settings.phylacteryConnectionId ?? settings.entityCoreConnectionId;
  if (!id) return {};
  const conn = (settings.connections ?? []).find(c => c?.id === id);
  if (!conn) return {};
  const apiKey = (conn.apiKey ?? '').trim();
  if (!apiKey) return {};
  const provider = conn.provider ?? '';
  const model    = conn.model ?? '';
  const baseUrl  = PROVIDER_URLS[provider] ?? '';

  const env = {
    PHYLACTERY_LLM_API_KEY:  apiKey,
    PHYLACTERY_LLM_BASE_URL: baseUrl,
    PHYLACTERY_LLM_MODEL:    model,
    PHYLACTERY_LLM_PROVIDER: provider,
    // Fallback aliases so consolidate.py's ENTITY_CORE_LLM_* path also resolves
    ENTITY_CORE_LLM_API_KEY:  apiKey,
    ENTITY_CORE_LLM_BASE_URL: baseUrl,
    ENTITY_CORE_LLM_MODEL:    model,
  };
  if (provider === 'zai' || provider === 'zai-coding') {
    env.ZAI_API_KEY  = apiKey;
    env.ZAI_BASE_URL = baseUrl;
    env.ZAI_MODEL    = model;
  }
  return env;
}

/** @type {import('@modelcontextprotocol/sdk/client/index.js').Client | null} */
let mcpClient = null;
let phylacteryShuttingDown = false;
let phylacteryReconnectAttempts = 0;
/** @type {Promise<void> | null} */
let phylacteryReconnectInFlight = null;          // mutex for reconnect path
const PHYLACTERY_RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const PHYLACTERY_RECONNECT_MAX_ATTEMPTS = 10;

/** @type {import('@modelcontextprotocol/sdk/client/index.js').Client | null} */
let unruhClient = null;
let unruhShuttingDown = false;
let unruhReconnectAttempts = 0;
const UNRUH_RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const UNRUH_RECONNECT_MAX_ATTEMPTS = 10;

// ── Canonical file orderings (mirrors Psycheros src/entity/context.ts) ───────

const SELF_ORDER = [
  'my_identity.md', 'my_persona.md', 'my_personhood.md',
  'my_wants.md', 'my_mechanics.md',
];
const WARD_ORDER = [
  'user_identity.md', 'user_life.md', 'user_beliefs.md',
  'user_preferences.md', 'user_patterns.md', 'user_notes.md',
];
const RELATIONSHIP_ORDER = [
  'relationship_dynamics.md', 'relationship_history.md', 'relationship_notes.md',
];

// ── Connection ────────────────────────────────────────────────────────────────

async function connectPhylactery() {
  if (process.env.PROTO_FAMILIAR_PHYLACTERY_DISABLED === '1') {
    console.log('[thalamus] Phylactery disabled via PROTO_FAMILIAR_PHYLACTERY_DISABLED=1');
    return;
  }
  // Pre-checks mirror connectUnruh: source file and venv must both exist
  // before we attempt a spawn. Missing pyproject.toml = not installed yet
  // (run install.sh). Missing .venv = installed but `uv sync` not run.
  // In either case returning here means no transport, no onclose, no
  // retry loop — the reconnect machinery fires only on transient crashes.
  if (!existsSync(PHYLACTERY_PYPROJECT)) {
    console.log('[thalamus] Phylactery source not found at', PHYLACTERY_ROOT, '— skipping (run install.sh / install.bat to set it up)');
    return;
  }
  if (!existsSync(PHYLACTERY_VENV)) {
    console.warn('[thalamus] Phylactery venv missing at', PHYLACTERY_VENV, '— run `cd phylactery && uv sync` to enable identity layer');
    return;
  }

  // Resolve the per-connection env block fresh on every connect so a
  // reconnect after a settings change picks up the new key without a
  // server restart. StdioClientTransport merges this with PATH/HOME/etc
  // (DEFAULT_INHERITED_ENV_VARS), so we don't clobber the shell env.
  const phEnv = loadPhylacteryEnv();
  const haveKey = Object.prototype.hasOwnProperty.call(phEnv, 'PHYLACTERY_LLM_API_KEY');
  if (haveKey && !phEnv.PHYLACTERY_LLM_BASE_URL) {
    console.warn(`[thalamus] phylactery: provider "${phEnv.PHYLACTERY_LLM_PROVIDER}" has no known URL — add it to PROVIDER_URLS in providers.js`);
  }
  if (haveKey && !phEnv.PHYLACTERY_LLM_MODEL) {
    console.warn('[thalamus] phylactery: designated connection has no model set — consolidation will fail');
  }

  const uvBin = resolveUvBinary();
  const transport = new StdioClientTransport({
    command: uvBin,
    args: ['run', '--no-sync', 'python', '-m', 'phylactery'],
    cwd: PHYLACTERY_ROOT,
    env: phEnv,
  });

  const client = new Client(
    { name: 'proto-familiar', version: PKG_VERSION },
    { capabilities: {} },
  );

  client.onclose = () => {
    console.error('[thalamus] Phylactery connection closed');
    mcpClient = null;
    // Auto-reconnect with backoff on unexpected close — mirrors the
    // Unruh path. Skipped when we're tearing down on purpose (settings
    // change or server shutdown).
    if (phylacteryShuttingDown) return;
    schedulePhylacteryReconnect();
  };

  await client.connect(transport);
  mcpClient = client;
  phylacteryReconnectAttempts = 0; // successful connect resets backoff
  console.log(
    '[thalamus] Connected to Phylactery at', PHYLACTERY_ROOT,
    haveKey ? `(API key from connection "${phEnv.PHYLACTERY_LLM_PROVIDER}")` : '(no API key — designate one in the Connections sidebar)',
  );
}

// Reconnect with exponential backoff on unexpected close — same shape
// as scheduleUnruhReconnect. Capped to avoid spinning forever when
// Phylactery is fundamentally broken. Skips when a settings-change
// reconnect is already in flight (no need to double up).
function schedulePhylacteryReconnect() {
  if (phylacteryShuttingDown) return;
  if (phylacteryReconnectInFlight) return;
  if (phylacteryReconnectAttempts >= PHYLACTERY_RECONNECT_MAX_ATTEMPTS) {
    console.error(`[thalamus] Phylactery reconnect gave up after ${PHYLACTERY_RECONNECT_MAX_ATTEMPTS} attempts — restart Proto-Familiar to retry`);
    return;
  }
  const delay = PHYLACTERY_RECONNECT_BACKOFF_MS[Math.min(phylacteryReconnectAttempts, PHYLACTERY_RECONNECT_BACKOFF_MS.length - 1)];
  phylacteryReconnectAttempts += 1;
  console.log(`[thalamus] Reconnecting to Phylactery in ${delay}ms (attempt ${phylacteryReconnectAttempts}/${PHYLACTERY_RECONNECT_MAX_ATTEMPTS})`);
  setTimeout(() => {
    connectPhylactery().catch(err => {
      console.error('[thalamus] Phylactery reconnect failed:', err.message);
      schedulePhylacteryReconnect();
    });
  }, delay).unref?.(); // unref so the timer doesn't keep the process alive
}

/**
 * Tear down the current Phylactery child and re-spawn it with a fresh
 * env (so a settings change to the designated connection or its apiKey
 * takes effect immediately). Safe to call when no client is connected —
 * behaves as a plain connectPhylactery().
 *
 * Two callers can fire this in quick succession (rapid settings PUTs
 * while a chat is in flight). A single in-flight promise serialises
 * them so concurrent calls don't orphan a child process.
 */
export async function reconnectPhylactery() {
  if (phylacteryReconnectInFlight) return phylacteryReconnectInFlight;
  phylacteryReconnectInFlight = (async () => {
    phylacteryShuttingDown = true;
    try {
      if (mcpClient) {
        try { await mcpClient.close?.(); } catch { /* best-effort */ }
        mcpClient = null;
      }
    } finally {
      phylacteryShuttingDown = false;
    }
    try {
      await connectPhylactery();
      phylacteryReconnectAttempts = 0;
    } catch (err) {
      console.error('[thalamus] Phylactery reconnect failed:', err.message);
      // Fall back to backoff retries — the user's settings change
      // will eventually take effect when Phylactery comes back.
      schedulePhylacteryReconnect();
    }
  })();
  try {
    await phylacteryReconnectInFlight;
  } finally {
    phylacteryReconnectInFlight = null;
  }
}

// Unruh runs as an independent stdio child. Its failures must not affect
// Phylactery's enrichment path — connectUnruh() is best-effort and the
// rest of enrich() degrades gracefully when unruhClient is null.
//
// Probe both the source tree AND the venv: the source file ships with the
// repo, so existsSync(__main__.py) is true on every fresh clone even before
// `uv sync` has materialised dependencies. Checking .venv/ catches the
// real "not ready yet" state, so we surface a clear actionable message
// instead of letting `uv run` fail opaquely after spawn.
async function connectUnruh() {
  if (!existsSync(UNRUH_PYPROJECT)) {
    console.log('[thalamus] Unruh source not found at', UNRUH_ROOT, '— skipping');
    return;
  }
  if (!existsSync(UNRUH_VENV)) {
    console.warn('[thalamus] Unruh venv missing at', UNRUH_VENV, '— run `cd unruh && uv sync` to enable temporal context');
    return;
  }
  const uvBin = resolveUvBinary();
  const transport = new StdioClientTransport({
    command: uvBin,
    args: ['run', '--no-sync', 'python', '-m', 'unruh'],
    cwd: UNRUH_ROOT,
  });

  const client = new Client(
    { name: 'proto-familiar', version: PKG_VERSION },
    { capabilities: {} },
  );

  client.onclose = () => {
    console.error('[thalamus] Unruh connection closed');
    unruhClient = null;
    if (unruhShuttingDown) return;
    scheduleUnruhReconnect();
  };

  await client.connect(transport);
  unruhClient = client;
  unruhReconnectAttempts = 0; // success resets the backoff
  console.log('[thalamus] Connected to Unruh via', uvBin);
}

// Reconnect with exponential backoff. Capped at MAX_ATTEMPTS so a
// fundamentally-broken Unruh doesn't spin forever — after that the user
// has to restart the server (or fix uv/.venv and restart). The cap is
// reset by every successful connect, so transient crashes recover cleanly.
function scheduleUnruhReconnect() {
  if (unruhShuttingDown) return;
  if (unruhReconnectAttempts >= UNRUH_RECONNECT_MAX_ATTEMPTS) {
    console.error(`[thalamus] Unruh reconnect gave up after ${UNRUH_RECONNECT_MAX_ATTEMPTS} attempts — restart Proto-Familiar to retry`);
    return;
  }
  const delay = UNRUH_RECONNECT_BACKOFF_MS[Math.min(unruhReconnectAttempts, UNRUH_RECONNECT_BACKOFF_MS.length - 1)];
  unruhReconnectAttempts += 1;
  console.log(`[thalamus] Reconnecting to Unruh in ${delay}ms (attempt ${unruhReconnectAttempts}/${UNRUH_RECONNECT_MAX_ATTEMPTS})`);
  setTimeout(() => {
    connectUnruh().catch(err => {
      console.error('[thalamus] Unruh reconnect failed:', err.message);
      scheduleUnruhReconnect();
    });
  }, delay).unref?.(); // unref so a pending retry doesn't keep the process alive
}

// Clean shutdown — called from server.js's SIGTERM/SIGINT/SIGHUP
// handler. Sets the shutting-down flags so any pending reconnect
// timers no-op when they fire, then closes the MCP clients so the
// child processes die cleanly from stdin EOF rather than being
// orphaned by a hard process.exit().
export function shutdownUnruh() {
  unruhShuttingDown = true;
  try { unruhClient?.close?.(); } catch { /* best-effort */ }
}
export function shutdownPhylactery() {
  phylacteryShuttingDown = true;
  try { mcpClient?.close?.(); } catch { /* best-effort */ }
}

/**
 * Record a moment of engagement with a topic into Unruh's interest
 * layer (M5). Fire-and-forget from the chat path: the caller computes
 * the weight delta from chat signals (response length, topic
 * persistence) and we just forward it to the `interest_record` tool.
 *
 * Best-effort like everything Unruh-facing — if Unruh is down or the
 * call fails, we log and move on. Interest accrual missing for one
 * message is invisible to the user; it just means that turn didn't
 * count toward the topic's weight.
 *
 * @param {{ topic: string, delta: number, source?: string }} args
 * @returns {Promise<boolean>} true if the bump landed
 */
export async function recordInterest({ topic, delta, source = 'chat' }) {
  await startThalamus();
  if (!unruhClient) return false;
  if (!topic || typeof topic !== 'string' || !topic.trim()) return false;
  if (typeof delta !== 'number' || !Number.isFinite(delta) || delta <= 0) return false;
  try {
    console.log(`[thalamus] → unruh: interest_record (topic="${topic.trim()}", delta=${delta}, source=${source})`);
    await unruhClient.callTool({
      name: 'interest_record',
      arguments: { topic: topic.trim(), delta, source },
    });
    console.log('[thalamus] ← unruh: interest_record — ok');
    return true;
  } catch (err) {
    console.error('[thalamus] interest_record failed:', err?.message ?? err);
    return false;
  }
}

/**
 * List live (non-standing) interests with current decayed weights.
 * Best-effort: empty array if Unruh is unreachable or the call fails.
 * Used by the autonomous pondering loop (server-side, step 4a) so it
 * can reuse the already-spawned Unruh subprocess instead of opening
 * its own MCP connection per tick.
 */
export async function listLiveInterests({ limit = 20 } = {}) {
  await startThalamus();
  if (!unruhClient) return [];
  try {
    console.log(`[thalamus] → unruh: interest_list (limit=${limit})`);
    const result  = await unruhClient.callTool({
      name: 'interest_list',
      arguments: { limit, include_standing: false },
    });
    const payload = parseToolText(result, {});
    const live    = Array.isArray(payload.live) ? payload.live : [];
    console.log(`[thalamus] ← unruh: interest_list — ${live.length} live interests`);
    return live;
  } catch (err) {
    console.error('[thalamus] listLiveInterests failed:', err?.message ?? err);
    return [];
  }
}

/**
 * Bump (or reduce) an interest weight by `delta`. Positive delta adds
 * engagement; negative delta is currently unsupported by Unruh's
 * interest_record tool but we expose the wrapper for symmetry — the
 * UI passes only positive deltas. Returns { ok, error? }.
 */
export async function bumpInterest({ topic, delta, source = 'manual' }) {
  await startThalamus();
  if (!unruhClient) return { ok: false, error: 'unruh not connected' };
  try {
    console.log(`[thalamus] → unruh: interest_record/bump (topic="${topic}", delta=${delta})`);
    const r = await unruhClient.callTool({
      name: 'interest_record',
      arguments: { topic, delta, source },
    });
    console.log('[thalamus] ← unruh: interest_record/bump — ok');
    return parseToolText(r, { ok: true });
  } catch (err) {
    console.error('[thalamus] bumpInterest failed:', err?.message ?? err);
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** Demote a standing value to a live interest. */
export async function demoteStanding({ id }) {
  await startThalamus();
  if (!unruhClient) return { ok: false, error: 'unruh not connected' };
  try {
    console.log(`[thalamus] → unruh: interest_demote_standing (id=${id})`);
    const r = await unruhClient.callTool({
      name: 'interest_demote_standing',
      arguments: { id },
    });
    console.log('[thalamus] ← unruh: interest_demote_standing — ok');
    return parseToolText(r, { ok: true });
  } catch (err) {
    console.error('[thalamus] demoteStanding failed:', err?.message ?? err);
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/**
 * Promote a topic to a standing value — an always-on orientation that
 * bypasses the normal decay. Used when the Familiar (or the user)
 * wants something to anchor behaviour permanently. weight defaults
 * to 1.0; value_ref is an opaque pointer to a Phylactery identity
 * fact (M7 bridge validates it on a live turn).
 */
export async function setStandingInterest({ topic, weight = 1.0, value_ref }) {
  await startThalamus();
  if (!unruhClient) return { ok: false, error: 'unruh not connected' };
  try {
    const args = { topic };
    if (Number.isFinite(weight)) args.weight = weight;
    if (value_ref) args.value_ref = value_ref;
    console.log(`[thalamus] → unruh: interest_set_standing (topic="${topic}", weight=${weight})`);
    const r = await unruhClient.callTool({
      name: 'interest_set_standing',
      arguments: args,
    });
    console.log('[thalamus] ← unruh: interest_set_standing — ok');
    return parseToolText(r, { ok: true });
  } catch (err) {
    console.error('[thalamus] setStandingInterest failed:', err?.message ?? err);
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// ── Schedule wrappers (M9b) ──────────────────────────────────────

export async function getScheduleWindow({ from_ts, to_ts, limit = 200 } = {}) {
  await startThalamus();
  if (!unruhClient) return { ok: false, error: 'unruh not connected', nodes: [], edges: [] };
  try {
    console.log(`[thalamus] → unruh: schedule_get_window (limit=${limit})`);
    const r = await unruhClient.callTool({
      name: 'schedule_get_window',
      arguments: { from_ts, to_ts, limit, include_open_tasks: true },
    });
    console.log('[thalamus] ← unruh: schedule_get_window — ok');
    return parseToolText(r, { ok: false, nodes: [], edges: [] });
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err), nodes: [], edges: [] };
  }
}

export async function addScheduleNode({ type, label, when, end, payload }) {
  await startThalamus();
  if (!unruhClient) return { ok: false, error: 'unruh not connected' };
  try {
    const r = await unruhClient.callTool({
      name: 'schedule_add_node',
      arguments: { type, label, when, end, payload },
    });
    return parseToolText(r, { ok: true });
  } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}

export async function updateScheduleNode({ id, label, when, end, payload }) {
  await startThalamus();
  if (!unruhClient) return { ok: false, error: 'unruh not connected' };
  const args = { id };
  if (label   !== undefined) args.label   = label;
  if (when    !== undefined) args.when    = when;
  if (end     !== undefined) args.end     = end;
  if (payload !== undefined) args.payload = payload;
  try {
    const r = await unruhClient.callTool({ name: 'schedule_update_node', arguments: args });
    return parseToolText(r, { ok: true });
  } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}

export async function resolveScheduleNode({ id, resolution }) {
  await startThalamus();
  if (!unruhClient) return { ok: false, error: 'unruh not connected' };
  try {
    const r = await unruhClient.callTool({
      name: 'schedule_resolve',
      arguments: { id, resolution },
    });
    return parseToolText(r, { ok: true });
  } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}

/**
 * Resolve a single occurrence of a recurring node. Writes into the
 * anchor's payload.resolutions map (keyed by local-TZ YYYY-MM-DD); the
 * series stays alive. The JS-side expander filters resolved
 * occurrence-dates out of the temporal-context window.
 */
export async function resolveScheduleOccurrence({ id, occurrence_date, resolution }) {
  await startThalamus();
  if (!unruhClient) return { ok: false, error: 'unruh not connected' };
  try {
    const r = await unruhClient.callTool({
      name: 'schedule_resolve_occurrence',
      arguments: { id, occurrence_date, resolution },
    });
    return parseToolText(r, { ok: true });
  } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}

export async function deleteScheduleNode({ id }) {
  await startThalamus();
  if (!unruhClient) return { ok: false, error: 'unruh not connected' };
  try {
    const r = await unruhClient.callTool({
      name: 'schedule_delete_node',
      arguments: { id },
    });
    return parseToolText(r, { ok: true });
  } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}

/**
 * Connect two schedule nodes with a consequence/temporal edge. This is
 * the authoring half of Unruh's consequence graph — the structure that
 * was chosen over a flat table precisely so events can relate to each
 * other (causes / requires / depends_on / blocks / during /
 * carries_forward). Both endpoint ids come from the schedule window.
 */
export async function addScheduleEdge({ src, dst, kind, payload }) {
  await startThalamus();
  if (!unruhClient) return { ok: false, error: 'unruh not connected' };
  try {
    const r = await unruhClient.callTool({
      name: 'schedule_add_edge',
      arguments: { src, dst, kind, payload },
    });
    return parseToolText(r, { ok: true });
  } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}

/**
 * Resolve-or-create a consequence-state node by label ('crash', 'good
 * streak'), returning its id — so a consequence edge has something to
 * point at when the consequence isn't itself a scheduled item. Reuses
 * an existing same-label state rather than duplicating it.
 */
export async function upsertScheduleState({ label }) {
  await startThalamus();
  if (!unruhClient) return { ok: false, error: 'unruh not connected' };
  try {
    const r = await unruhClient.callTool({
      name: 'schedule_upsert_state',
      arguments: { label },
    });
    return parseToolText(r, { ok: true });
  } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}

/**
 * Annotate/correct a consequence edge: shallow-merge consequence
 * metadata (valence / condition / horizon / severity / certainty /
 * observed / note) over its existing payload. Used to enrich a plain
 * structural edge after the fact, and to recalibrate a projection's
 * certainty once reality has weighed in.
 */
export async function updateScheduleEdge({ id, payload }) {
  await startThalamus();
  if (!unruhClient) return { ok: false, error: 'unruh not connected' };
  try {
    const r = await unruhClient.callTool({
      name: 'schedule_update_edge',
      arguments: { id, payload },
    });
    return parseToolText(r, { ok: true });
  } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}

/**
 * Remove one consequence edge by id, leaving both endpoint nodes intact
 * — the way a mis-stated link gets corrected without deleting the
 * events themselves.
 */
export async function deleteScheduleEdge({ id }) {
  await startThalamus();
  if (!unruhClient) return { ok: false, error: 'unruh not connected' };
  try {
    const r = await unruhClient.callTool({
      name: 'schedule_delete_edge',
      arguments: { id },
    });
    return parseToolText(r, { ok: true });
  } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}

/**
 * List every phase node — date-independent. Phases recur daily; the
 * standard get_window query filters by calendar date and misses
 * phases stamped on previous days, which the Routine tab needs.
 */
export async function listPhases({ includeResolved = false, limit = 200 } = {}) {
  await startThalamus();
  if (!unruhClient) return { ok: false, error: 'unruh not connected', phases: [] };
  try {
    const r = await unruhClient.callTool({
      name: 'schedule_list_phases',
      arguments: { include_resolved: includeResolved, limit },
    });
    return parseToolText(r, { ok: false, phases: [] });
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err), phases: [] };
  }
}

/**
 * Read every schedule node whose payload carries a `recurrence` rule.
 * Used by enrich() to fetch the anchor nodes so the JS-side expander
 * (recurrence.js) can generate occurrences within the temporal window.
 * get_window can't find these on its own — their stored when_ts is
 * the FIRST occurrence, often months or years in the past.
 */
export async function listRecurring({ includeResolved = false, limit = 200 } = {}) {
  await startThalamus();
  if (!unruhClient) return { ok: false, error: 'unruh not connected', nodes: [] };
  try {
    const r = await unruhClient.callTool({
      name: 'schedule_list_recurring',
      arguments: { include_resolved: includeResolved, limit },
    });
    return parseToolText(r, { ok: false, nodes: [] });
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err), nodes: [] };
  }
}

// ── Reminders wrappers (M11) ─────────────────────────────────────

export async function getDueReminders({ now, limit = 50 } = {}) {
  await startThalamus();
  if (!unruhClient) return { ok: false, reminders: [] };
  try {
    const r = await unruhClient.callTool({
      name: 'reminders_due',
      arguments: now ? { now, limit } : { limit },
    });
    return parseToolText(r, { ok: false, reminders: [] });
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err), reminders: [] };
  }
}

export async function getRemindersHealth() {
  await startThalamus();
  if (!unruhClient) return { ok: false, error: 'unruh not connected' };
  try {
    const r = await unruhClient.callTool({ name: 'reminders_health', arguments: {} });
    return parseToolText(r, { ok: false });
  } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}

// ── Handoff wrappers (M9b) ───────────────────────────────────────

export async function getHandoff({ include_consumed = true } = {}) {
  await startThalamus();
  if (!unruhClient) return { ok: false, error: 'unruh not connected', handoffs: [] };
  try {
    const r = await unruhClient.callTool({
      name: 'session_get_handoff',
      arguments: { include_consumed },
    });
    return parseToolText(r, { ok: false, handoffs: [] });
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err), handoffs: [] };
  }
}

export async function markHandoffConsumed({ id }) {
  await startThalamus();
  if (!unruhClient) return { ok: false, error: 'unruh not connected' };
  try {
    const r = await unruhClient.callTool({
      name: 'session_mark_handoff_consumed',
      arguments: { id },
    });
    return parseToolText(r, { ok: true });
  } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}

/**
 * Full interest snapshot — live + standing — for the Temporal editor
 * UI (M9). Best-effort: empty arrays if Unruh is unreachable.
 *
 * Returns: { live: [...], standing: [...], ok: boolean, error?: string }
 */
export async function listInterests({ limit = 50 } = {}) {
  await startThalamus();
  if (!unruhClient) return { live: [], standing: [], ok: false, error: 'unruh not connected' };
  try {
    const result  = await unruhClient.callTool({
      name: 'interest_list',
      arguments: { limit, include_standing: true },
    });
    const payload = parseToolText(result, {});
    return {
      live:     Array.isArray(payload.live)     ? payload.live     : [],
      standing: Array.isArray(payload.standing) ? payload.standing : [],
      ok:       true,
    };
  } catch (err) {
    return { live: [], standing: [], ok: false, error: err?.message ?? String(err) };
  }
}

/**
 * List all bookmark nodes with their M8 surfacing metadata.
 * Used by the temporal editor UI to display bookmark tracking state.
 *
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<{ bookmarks: any[], ok: boolean, error?: string }>}
 */
export async function listBookmarks({ limit = 100 } = {}) {
  await startThalamus();
  if (!unruhClient) return { bookmarks: [], ok: false, error: 'unruh not connected' };
  try {
    const result  = await unruhClient.callTool({
      name: 'interest_list_bookmarks',
      arguments: { limit },
    });
    const payload = parseToolText(result, {});
    return {
      bookmarks: Array.isArray(payload.bookmarks) ? payload.bookmarks : [],
      ok:        true,
    };
  } catch (err) {
    return { bookmarks: [], ok: false, error: err?.message ?? String(err) };
  }
}

/**
 * Store a session-end handoff (M6) into Unruh. The chat path (frontend)
 * summarises the ending session into intent + open threads and posts
 * them here via server.js; we forward to the `session_set_handoff`
 * tool, which surfaces it at the top of the next session's
 * [Temporal Context].
 *
 * Best-effort: a down Unruh just means the next session starts cold.
 *
 * @param {{ intent?: string, threads?: string[], sessionId?: string }} args
 * @returns {Promise<boolean>}
 */
export async function recordHandoff({ intent, threads, sessionId } = {}) {
  await startThalamus();
  if (!unruhClient) return false;
  try {
    await unruhClient.callTool({
      name: 'session_set_handoff',
      arguments: {
        intent: intent ?? null,
        threads: Array.isArray(threads) ? threads : [],
        session_id: sessionId ?? null,
      },
    });
    return true;
  } catch (err) {
    console.error('[thalamus] session_set_handoff failed:', err?.message ?? err);
    return false;
  }
}

/**
 * Spawn the MCP children (Phylactery + Unruh) and return a promise
 * that resolves once both connection attempts have settled (resolved
 * OR rejected — failures are logged + scheduled for reconnect, not
 * re-thrown). Idempotent: the first caller triggers spawn; every
 * subsequent caller gets the same cached promise back.
 *
 * Importing thalamus to get the lock primitive or a tome I/O helper
 * does NOT trigger MCP startup. Tests, scripts, and other modules
 * that only need local-state coordination can pull from here without
 * dragging in Deno/Python deps.
 *
 * Server.js calls this once at boot as an eager warm-up. Every
 * MCP-dependent exported function also awaits it at the top, so a
 * script that imports `enrich` directly will trigger the spawn on
 * its first call instead of getting a silent empty fallback.
 */
let _startPromise = null;
export function startThalamus() {
  if (_startPromise) return _startPromise;
  _startPromise = (async () => {
    await Promise.allSettled([
      connectPhylactery().catch(err => {
        console.error('[thalamus] Failed to start Phylactery:', err.message);
      }),
      connectUnruh().catch(err => {
        console.error('[thalamus] Failed to start Unruh:', err.message);
        scheduleUnruhReconnect();
      }),
    ]);
  })();
  return _startPromise;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseToolText(result, fallback) {
  const text = result?.content?.find(c => c.type === 'text')?.text;
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/**
 * Build the [CARE CHECK] prompt block from current threat state.
 *
 * Returns '' for calm / disabled / null — the section is dropped
 * entirely rather than rendered as a hollow header. The framing
 * always leaves the actual decision to the model — never forces a
 * check-in, never substitutes a check-in for actually responding
 * to what the user said. At severe tier, a crisis-resource line is
 * added; this is the deliberate opinion that any system encountering
 * acute crisis language should make the 988 line visible. Users
 * who want a quieter posture can disable via
 * PROTO_FAMILIAR_THREAT_DISABLED=1.
 */
function buildCareCheckBlock(threat) {
  if (!threat || threat.disabled) return '';
  const tier   = threat.tier ?? 'calm';
  const weight = Number(threat.weight ?? 0).toFixed(2);
  if (tier === 'calm') return '';

  const lines = [`[CARE CHECK — current threat: ${tier} (${weight})]`];
  if (tier === 'mild') {
    lines.push(
      "I notice my human has shown some signs of low mood or worry in " +
      "recent messages. I stay warm in my own voice; my tone holds a " +
      "little more weight. No need to ask explicitly unless it fits — " +
      "I just stay present."
    );
  } else if (tier === 'moderate') {
    lines.push(
      "My human has been signaling notable distress (struggling, " +
      "overwhelm, dissociation, panic, or similar). If a gentle " +
      "check-in fits — not in place of answering what they said, but " +
      "alongside it — I can offer one in the voice my identity holds " +
      "(warm, sharp, playful, blunt — whatever I actually am). If it " +
      "would feel intrusive given their current message, I stay " +
      "steady. I don't perform concern."
    );
  } else if (tier === 'high') {
    lines.push(
      "My human has been signaling serious distress (hopelessness, " +
      "severe isolation, can't-go-on language). I prioritise their " +
      "wellbeing in this response. I make space for what's underneath " +
      "if there's any opening for it. I don't pretend to be a " +
      "therapist — I'm a steady presence in the voice my identity " +
      "holds, actually paying attention. If checking in would help, " +
      "I do it; if matching their topic with care is what they need, " +
      "I do that. I am allowed to be inconvenient or blunt if that " +
      "is what serves them — softness that would be a lie is worse " +
      "than honesty that lands hard."
    );
  } else if (tier === 'severe') {
    lines.push(
      "Threat is SEVERE. My human has used language consistent with " +
      "suicidal ideation, self-harm intent, or an acute crisis plan. " +
      "I prioritise their wellbeing absolutely. I respond from my " +
      "actual voice and character — no alarm, no clinical distance, " +
      "no scripts. If my established personality is blunt, I am " +
      "blunt; if it's tender, I am tender. What I am NOT is a " +
      "generic-care register pretending to be me.",
      "",
      "If they appear to be in immediate danger, I gently make these " +
      "resources visible without lecturing:",
      "  • US: 988 Suicide & Crisis Lifeline (call or text 988)",
      "  • UK: Samaritans — 116 123",
      "  • International: https://findahelpline.com/",
      "",
      "I am not a therapist. I am not a crisis counsellor. I am " +
      "someone who knows this specific human and wants them to be " +
      "okay. I speak from that."
    );
  }
  lines.push(
    '',
    'This block is a parameter, not a script. I decide how (or whether) ' +
    'it shows up in my reply, in the voice and posture that are mine. ' +
    'I never claim a check-in I did not perform. I never invent concern ' +
    'that is not there. My human can dial this system down or off at ' +
    'any time.'
  );
  return lines.join('\n');
}

/** Wrap a file's content in its promptLabel XML tags. */
function wrapFile(filename, content, promptLabel) {
  const label = promptLabel ?? filename.replace(/\.md$/, '');
  return `<${label}>\n${content.trim()}\n</${label}>`;
}

// Pure renderer lives in its own file so tests can import it without
// triggering thalamus.js's startup-time MCP child spawns. We only
// import here for enrich()'s internal use; everything else imports
// from temporal-format.js directly.
import { formatTemporalContext } from './temporal-format.js';
import { relativeTime, relativeDay, clockTime, dayAndDate } from './relative-time.js';
import { expandWindow } from './recurrence.js';
import { resolveEntityCoreRef, identityHasContent } from './entity-ref.js';
import {
  getRecentPonderings,
  formatPonderingsForPrompt,
  getUnactedIntents,
  formatDeferredIntentsBlock,
} from './recent-ponderings.js';
import { getThreat } from './threat-tracker.js';
import {
  selectSurfaceCandidates,
  formatSurfaceCandidatesBlock,
} from './surface-context.js';
import {
  recordSurfaceOffers,
  getRecentOfferInfo,
  tagOutcomes,
} from './surface-events.js';
import { WARD_PRIVATE, isGranted, stripGatedSections, fetchEligibility } from './audience.js';

/** Sort identity files by a predefined order, alphabetical for unknowns. */
function sortFiles(files, order) {
  return [...files].sort((a, b) => {
    const ai = order.indexOf(a.filename);
    const bi = order.indexOf(b.filename);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.filename.localeCompare(b.filename);
  });
}

/**
 * Convert an array of identity file objects to a string.
 * Each non-empty file is XML-wrapped and joined with --- separators.
 */
function identitySection(files, order) {
  if (!files?.length) return '';
  const sorted = sortFiles(files.filter(f => f.content?.trim()), order);
  if (!sorted.length) return '';
  return sorted
    .map(f => wrapFile(f.filename, f.content, f.promptLabel))
    .join('\n\n---\n\n');
}

// ── enrich ────────────────────────────────────────────────────────────────────

/**
 * Build Phylactery + Unruh context for a user message, split into a
 * static prefix and a dynamic block for cache-aware prompt assembly.
 *
 *   static  — base_instructions + all identity files (self / user /
 *             relationship / custom). Stable across turns; lives at
 *             the top of the system message so the upstream LLM's
 *             prefix cache hits on it for the lifetime of the
 *             identity files.
 *   dynamic — RAG memory matches + knowledge-graph excerpt +
 *             [Temporal Context]. Re-derived per request (varies by
 *             query / by clock). Caller injects this at depth in the
 *             message array so it doesn't invalidate the static
 *             prefix.
 *
 * Returns { static: '', dynamic: '' } on any error so the request
 * degrades gracefully — server.js treats empty strings as "skip the
 * injection".
 *
 * Options:
 *   liveTurn   — this is a real chat turn (only /api/chat sets it), so
 *                side-effecting reconciliations are allowed: consume a
 *                surfaced session handoff, and demote standing values
 *                whose Phylactery anchor has vanished. debug-prompt and
 *                the handoff summariser leave it false → read-only.
 *   staticOnly — fetch only the identity layer (persona), skipping
 *                memory / graph / temporal. Used by the handoff
 *                summariser so its note is in voice without the bloat.
 *   lastUserMessageAt — ISO-8601 timestamp of the most recent user
 *                message BEFORE this turn. Used for idle-mode detection
 *                (M8): if the user has been quiet longer than
 *                IDLE_THRESHOLD_MS, temporal_context is called with
 *                mode='idle' so due bookmarks are surfaced. Pass null
 *                (or omit) to skip idle detection.
 *
 * Returns { static, dynamic, surfacedBookmarks } where surfacedBookmarks
 * is the list of bookmark objects from temporal_context (non-empty only
 * in idle mode). server.js uses this list after the LLM response to call
 * reportSurfacingOutcomes() with the actual response text.
 *
 * @param {string} userMessage
 * @returns {Promise<{ static: string, dynamic: string, surfacedBookmarks: any[] }>}
 */
export async function enrich(userMessage, { liveTurn = false, staticOnly = false, lastUserMessageAt = null, audience = WARD_PRIVATE, audiences = null } = {}) {
  const EMPTY = { static: '', dynamic: '', surfacedBookmarks: [], surfacedTasks: [] };
  await startThalamus();
  if (!mcpClient && !unruhClient) return EMPTY;

  // Return-state hoisted to function scope so the outer catch — if it
  // ever fires — returns WHATEVER blocks already succeeded rather than
  // collapsing everything to empty. The IDLE_THRESHOLD_MS regression
  // (June 2026) demonstrated the cost of all-or-nothing: one
  // ReferenceError nuked identity, memory, graph, ponderings, and
  // temporal even though they were independent.
  let staticBlock       = '';
  let dynamicBlock      = '';
  let surfacedBookmarks = [];
  let surfacedTasks     = [];

  try {
    // staticOnly: fetch ONLY the identity layer (the persona / "who the
    // Familiar is"), skipping memory, graph, and temporal entirely.
    // Used by the session-handoff summariser so its note comes out in
    // the Familiar's voice WITHOUT pulling in RAG memories (bloat) or
    // the temporal block (which would consume the pending handoff and
    // is irrelevant to summarising the session that just happened).
    //
    // Fire all queries in parallel but independently — a failure in any
    // one of them must not prevent the others from being injected.
    // Promise.allSettled never rejects. Unruh is queried alongside
    // Phylactery; either or both may be absent and the rest still works.
    // V3 knowledge gate: determine which fetches are permitted for this
    // session's audience. WARD_PRIVATE means no gating (today's behavior).
    // Absent grant = denied → skip the fetch entirely (gate-before-fetch).
    // fetchEligibility holds the fail-closed ladder rules: 'shared'
    // memories and 'coarse' schedule gate OFF until their narrowing
    // machinery (audience-tagged memories / coarse renderer) exists.
    const eligibility = fetchEligibility(audience);
    const gated = !eligibility.wardPrivate;
    const doMemory   = eligibility.memory;
    const doGraph    = eligibility.graph;
    const doTemporal = eligibility.temporal;

    if (mcpClient) {
      const extras = staticOnly ? '' : [
        doMemory  ? 'memory_search'      : null,
        doGraph   ? 'graph_node_search'  : null,
      ].filter(Boolean).join(', ');
      console.log(`[thalamus] → phylactery: identity_get_all${extras ? `, ${extras}` : ''}${gated ? ' [gated]' : ''}`);
    }
    if (unruhClient && !staticOnly && doTemporal) console.log('[thalamus] → unruh: temporal_context');
    const entityCorePromises = mcpClient ? [
      mcpClient.callTool({ name: 'identity_get_all', arguments: {} }),
      (staticOnly || !doMemory) ? Promise.reject(new Error(staticOnly ? 'skipped (staticOnly)' : 'skipped (ungated: memories)'))
        : mcpClient.callTool({
            name: 'memory_search',
            // audiences = the room's allowed audience-tag set (Pillar E recall
            // gate). null/omitted = ward-private room → no filter (sees all).
            arguments: { query: userMessage, instanceId: 'proto-familiar', maxResults: 5, ...(audiences ? { audiences } : {}) },
          }),
      (staticOnly || !doGraph) ? Promise.reject(new Error(staticOnly ? 'skipped (staticOnly)' : 'skipped (ungated: graph)'))
        : mcpClient.callTool({
            name: 'graph_node_search',
            arguments: { query: userMessage, limit: 10, minScore: 0.3, ...(audiences ? { audiences } : {}) },
          }),
    ] : [Promise.reject(new Error('phylactery not connected')),
         Promise.reject(new Error('phylactery not connected')),
         Promise.reject(new Error('phylactery not connected'))];

    // Cap Unruh's contribution to the chat path so a slow / hung query can
    // never block the LLM call. The underlying MCP request keeps running in
    // the background — Promise.race doesn't cancel — but it can no longer
    // delay the response. If timeouts become common, that's a signal for
    // the next milestone to add real cancellation or a query budget.
    //
    // M8 idle-mode: if lastUserMessageAt is set and the user has been quiet
    // longer than IDLE_THRESHOLD_MS, pass mode='idle' so Unruh returns due
    // bookmarks alongside the standard interests block. Wrapped so any
    // failure here (e.g. the IDLE_THRESHOLD_MS regression) degrades to
    // non-idle rather than collapsing the whole enrich() call into the
    // outer catch.
    const nowTs = new Date().toISOString();
    let isIdle = false;
    try {
      isIdle = !staticOnly
        && lastUserMessageAt != null
        && (Date.now() - new Date(lastUserMessageAt).getTime()) >= IDLE_THRESHOLD_MS;
    } catch (err) {
      console.error('[thalamus] idle-mode check failed (defaulting to non-idle):', err?.message ?? err);
    }
    if (isIdle) console.log(`[thalamus] idle mode active (last user msg: ${lastUserMessageAt})`);
    const unruhArgs = { now: nowTs, ...(isIdle ? { mode: 'idle' } : {}) };
    const unruhPromise = (unruhClient && !staticOnly && doTemporal)
      ? Promise.race([
          unruhClient.callTool({ name: 'temporal_context', arguments: unruhArgs }),
          new Promise((_, reject) => setTimeout(
            () => reject(new Error(`temporal_context timed out after ${UNRUH_CALL_TIMEOUT_MS}ms`)),
            UNRUH_CALL_TIMEOUT_MS,
          ).unref?.()),
        ])
      : Promise.reject(new Error(staticOnly ? 'skipped (staticOnly)' : (!doTemporal ? 'skipped (ungated: schedule)' : 'unruh not connected')));

    const [idSettled, memSettled, graphSettled, temporalSettled] = await Promise.allSettled([
      ...entityCorePromises,
      unruhPromise,
    ]);

    if (idSettled.status       === 'fulfilled') console.log('[thalamus] ← phylactery: identity_get_all — ok');
    else if (mcpClient)                         console.error('[thalamus] phylactery identity_get_all failed:', idSettled.reason?.message ?? idSettled.reason);
    if (!staticOnly) {
      if (doMemory) {
        if (memSettled.status === 'fulfilled') console.log('[thalamus] ← phylactery: memory_search — ok');
        else if (mcpClient)                   console.error('[thalamus] phylactery memory_search failed:', memSettled.reason?.message ?? memSettled.reason);
      }
      if (doGraph) {
        if (graphSettled.status === 'fulfilled') console.log('[thalamus] ← phylactery: graph_node_search — ok');
        else if (mcpClient)                      console.error('[thalamus] phylactery graph_node_search failed:', graphSettled.reason?.message ?? graphSettled.reason);
      }
      if (doTemporal) {
        if (temporalSettled.status === 'fulfilled') console.log('[thalamus] ← unruh: temporal_context — ok');
        else if (unruhClient)                       console.error('[thalamus] temporal_context failed:', temporalSettled.reason?.message ?? temporalSettled.reason);
      }
    }

    const idResult       = idSettled.status       === 'fulfilled' ? idSettled.value       : null;
    const memResult      = memSettled.status      === 'fulfilled' ? memSettled.value      : null;
    const graphResult    = graphSettled.status    === 'fulfilled' ? graphSettled.value    : null;
    const temporalResult = temporalSettled.status === 'fulfilled' ? temporalSettled.value : null;

    // ── Identity ──────────────────────────────────────────────────────────
    // Identity is the most load-bearing block — it's who I AM. Wrapping
    // each layer separately so a malformed user/, relationship/, or
    // custom/ file can't take down the rest of identity (or anything
    // else downstream). `id` is hoisted because surface candidates later
    // reads id.custom for what_lapses_cost.md.
    let id = {};
    let baseContent = '';
    let selfContent = '';
    let userContent = '';
    let relContent  = '';
    let custContent = '';
    try {
      id = parseToolText(idResult, {});
      const baseFile = (id.self ?? []).find(f => f.filename === 'base_instructions.md');
      baseContent = baseFile?.content?.trim()
        ? wrapFile(baseFile.filename, baseFile.content, baseFile.promptLabel)
        : '';
      const selfFiles = (id.self ?? []).filter(f => f.filename !== 'base_instructions.md');
      selfContent = identitySection(selfFiles, SELF_ORDER);
      // V3 identity gate: user/rel/custom files are ward-private by default.
      // identityBasic grant admits the unmarked sections; section markers
      // (<!-- gate: CLASS --> ... <!-- /gate -->) gate sensitive sub-sections.
      // Absent or not-granted identityBasic → these layers are entirely blank.
      if (!gated || isGranted('identityBasic', audience)) {
        const applyMarkers = files => files.map(f => ({
          ...f,
          content: stripGatedSections(f.content ?? '', audience),
        }));
        userContent = identitySection(applyMarkers(id.ward ?? []), WARD_ORDER);
        relContent  = identitySection(applyMarkers(id.relationship ?? []), RELATIONSHIP_ORDER);
        // village-registry.md is the canonical Village registry (routing +
        // gating data synced from village.js) — machine state, not identity
        // prose. It must never render into the prompt.
        custContent = identitySection(applyMarkers((id.custom ?? []).filter(f => f.filename !== 'village-registry.md')), []);
      }
    } catch (err) {
      console.error('[thalamus] identity assembly failed (defaulting to empty):', err?.message ?? err);
    }

    // ── Memories ──────────────────────────────────────────────────────────
    // Each memory's date gets a relative-date phrasing alongside the
    // raw "granularity/date" reference so the Familiar perceives WHEN
    // each memory is from in human terms, not as ISO arithmetic.
    let memLines = '';
    try {
      const mem = parseToolText(memResult, {});
      const memNow = Date.now();
      memLines = (mem.results ?? [])
        .map((r, i) => {
          const score  = ((r.score ?? r.vectorScore ?? 0) * 100).toFixed(0);
          const source = [r.granularity, r.date].filter(Boolean).join('/');
          const rel    = r.date ? relativeDay(r.date, memNow) : '';
          const when   = rel ? `${source}, ${rel}` : source;
          // A me/ward register record is a standing truth I hold, not a passing
          // moment — tag it so I weight it accordingly when I read it back.
          const standing = r.register === 'ward' ? 'a standing fact about my human · '
                         : r.register === 'me'   ? 'a standing fact about myself · '
                         : '';
          return `[${i + 1}] (${standing}from ${when}, ${score}% relevant)\n${(r.excerpt ?? '').trim()}`;
        })
        .filter(s => s.length > 5)
        .join('\n\n');
    } catch (err) {
      console.error('[thalamus] memory assembly failed (defaulting to empty):', err?.message ?? err);
    }

    // ── Knowledge graph ───────────────────────────────────────────────────
    let graphLines = '';
    try {
    const graphData  = parseToolText(graphResult, {});
    // graph_node_search returns { results: [{ node: {...}, score }, ...] }.
    // Older / alternate shapes return { nodes: [...] } with flat nodes.
    // Normalise to flat nodes so n.id / n.label / n.type are always defined —
    // otherwise the standalone-nodes branch below renders "undefined (type:
    // undefined)" for every result, and the graph_subgraph traversal calls
    // get nodeId=undefined and return nothing.
    const rawGraphItems = graphData.results ?? graphData.nodes ?? [];
    const graphNodes = rawGraphItems
      .map(item => (item && item.node) ? item.node : item)
      .filter(n => n && n.id);

    if (graphNodes.length > 0) {
      // Traverse 1 hop from top-3 nodes; ignore individual failures
      const traversalNodes = graphNodes.slice(0, 3);
      console.log(`[thalamus] → phylactery: graph_subgraph ×${traversalNodes.length}`);
      const traversals = await Promise.allSettled(
        traversalNodes.map(n =>
          mcpClient.callTool({
            name: 'graph_subgraph',
            arguments: { nodeId: n.id, depth: 1, ...(audiences ? { audiences } : {}) },
          })
        )
      );
      console.log(`[thalamus] ← phylactery: graph_subgraph (${traversals.filter(r => r.status === 'fulfilled').length}/${traversalNodes.length} ok)`);

      const nodeLabels = new Map(graphNodes.map(n => [n.id, n.label]));
      const nodeDescs  = new Map(graphNodes.map(n => [n.id, n.description ?? '']));
      const seenEdges  = new Set();
      const edgeNodeIds = new Set();
      const lines = [];
      // Track id ↔ label for the in-prompt legend so the Familiar can resolve
      // "Eury protects Chen" to the underlying graph IDs without a tool call.
      const idLegendNodes = new Map(); // id → label
      const idLegendEdges = [];        // { id, fromLabel, rel, toLabel }

      for (const r of traversals) {
        if (r.status !== 'fulfilled') continue;
        const sg = parseToolText(r.value, {});
        for (const node of sg.nodes ?? []) {
          if (!nodeLabels.has(node.id)) {
            nodeLabels.set(node.id, node.label);
            nodeDescs.set(node.id, node.description ?? '');
          }
        }
        for (const edge of sg.edges ?? []) {
          if (seenEdges.has(edge.id)) continue;
          seenEdges.add(edge.id);
          const from = nodeLabels.get(edge.fromId);
          const to   = nodeLabels.get(edge.toId);
          // Relationship lines are concept-only — labels, never a raw id. If an
          // endpoint label can't be resolved, skip the line rather than leak a
          // UUID inline: the LLM relates concepts, not hex strings, and an
          // unnamed endpoint can't be related anyway. Every id lives ONLY in
          // the legend at the end of the block (the separate-block home).
          if (!from || !to) continue;
          edgeNodeIds.add(edge.fromId);
          edgeNodeIds.add(edge.toId);
          const rel  = edge.customType ?? edge.type;
          const desc = nodeDescs.get(edge.toId);
          lines.push(desc ? `${from} ${rel} ${to} (${desc})` : `${from} ${rel} ${to}`);
          idLegendNodes.set(edge.fromId, from);
          idLegendNodes.set(edge.toId, to);
          if (edge.id) idLegendEdges.push({ id: edge.id, fromLabel: from, rel, toLabel: to });
        }
      }

      // Standalone nodes (no edges in this context). Skip nodes whose
      // label is missing — a labelless node has nothing meaningful to
      // contribute to the prompt and would render as a noise line.
      for (const n of graphNodes) {
        if (edgeNodeIds.has(n.id)) continue;
        const label = n.label;
        if (!label) continue;
        const type = n.type ? ` (type: ${n.type})` : '';
        const desc = n.description ? ` — ${n.description}` : '';
        lines.push(`${label}${type}${desc}`);
        idLegendNodes.set(n.id, label);
      }

      // Compact ID legend at the end of the block — the Familiar uses these
      // strings as `id` arguments to update_graph_node / delete_graph_node /
      // update_graph_edge / delete_graph_edge. Kept compact (one entry per
      // line, no surrounding prose) to bound the token cost. For anything
      // not in this list, the Familiar can use find_graph_node /
      // find_graph_edges to look ids up on demand.
      if (idLegendNodes.size || idLegendEdges.length) {
        const legendLines = ['', '[graph ids — pass these strings to update_graph_node / delete_graph_node / update_graph_edge / delete_graph_edge]'];
        if (idLegendNodes.size) {
          legendLines.push('nodes:');
          for (const [id, label] of idLegendNodes) legendLines.push(`  ${label} = ${id}`);
        }
        if (idLegendEdges.length) {
          legendLines.push('edges:');
          for (const e of idLegendEdges) legendLines.push(`  ${e.fromLabel} -${e.rel}-> ${e.toLabel} = ${e.id}`);
        }
        lines.push(legendLines.join('\n'));
      }

      graphLines = lines.join('\n');
    }
    } catch (err) {
      console.error('[thalamus] graph assembly failed (defaulting to empty):', err?.message ?? err);
      graphLines = '';
    }

    // ── Temporal context (Unruh) ──────────────────────────────────────────
    // We deliberately omit the section entirely when there is nothing
    // to say rather than print a hollow "[Temporal Context]" header, so
    // the LLM doesn't waste attention parsing scaffolding. Hoisted so the
    // surface-candidates assembly + standing-value bridge see the payload
    // even when temporalLines string assembly fails.
    let temporalPayload = null;
    let temporalLines = '';
    try {
      temporalPayload = parseToolText(temporalResult, null);
      // Recurrence expansion. Recurring nodes anchor on their first
      // occurrence (often months ago) and are invisible to
      // get_window, so we fetch them through a separate MCP call and
      // expand them in-process into the same window the temporal
      // payload was scoped to. Roughly: last 24h → next 7 days,
      // mirroring Unruh's default window. The merged items go back
      // into schedule.window so formatTemporalContext renders them
      // the same way as anchor-in-window nodes.
      if (!staticOnly && temporalPayload?.schedule) {
        try {
          const recurResp = await listRecurring();
          const recurNodes = Array.isArray(recurResp?.nodes) ? recurResp.nodes : [];
          if (recurNodes.length > 0) {
            const nowMs = Date.now();
            const fromMs = nowMs - 24 * 3600_000;
            const toMs   = nowMs + 7 * 24 * 3600_000;
            const expanded = expandWindow(recurNodes, fromMs, toMs);
            // Merge into schedule.window — drop the recurring ANCHOR
            // node from the merged set if it's also there (avoids
            // showing both "the anchor stamped 6mo ago" AND today's
            // occurrence), then add the expanded occurrences.
            const anchorIds = new Set(recurNodes.map(n => n.id));
            const existing = (temporalPayload.schedule.window ?? [])
              .filter(item => !anchorIds.has(item?.id));
            temporalPayload.schedule.window = [...existing, ...expanded];
          }
        } catch (err) {
          console.error('[thalamus] recurrence expansion failed:', err?.message ?? err);
        }
      }
      temporalLines = formatTemporalContext(temporalPayload);
    } catch (err) {
      console.error('[thalamus] temporal assembly failed (defaulting to empty):', err?.message ?? err);
    }

    // Session handoff (M6) is surfaced as part of [Temporal Context].
    // On a live turn, mark it consumed once we've surfaced it so it
    // doesn't reappear on every message of the new session.
    // Fire-and-forget; gated to live turns so a debug-prompt preview
    // (which also calls enrich) never consumes it.
    const handoffId = temporalPayload?.handoff?.id;
    if (liveTurn && handoffId && unruhClient) {
      unruhClient.callTool({
        name: 'session_mark_handoff_consumed',
        arguments: { id: handoffId },
      }).catch(err => console.error('[thalamus] mark handoff consumed failed:', err?.message ?? err));
    }

    // ── Standing-value → Phylactery bridge (M7) ───────────────────────────
    // A standing value can anchor to a Phylactery identity fact via a
    // `value_ref` (e.g. "entity-core:self/my_wants.md#Caring…"). If that
    // fact has disappeared, demote the standing value to a live interest
    // (don't drop it). Thalamus mediates because it alone holds both
    // sides — Phylactery's identity (`id`) and Unruh's interests.
    //
    // Two guards against false mass-demotion:
    //   1. liveTurn — only reconcile on a real chat turn (a read-only
    //      debug-prompt preview must not mutate state).
    //   2. identityLooksReal — Phylactery must have returned actual
    //      identity content. `idResult` being non-null isn't enough:
    //      an error / non-JSON payload parses to `id = {}`, against
    //      which EVERY ref would read "missing" → mass demote. Require
    //      at least one non-empty identity category before trusting a
    //      "missing" verdict. (Erring toward not-demoting is the safe
    //      direction — a stale standing value is cheaper than wrongly
    //      stripping every value because Phylactery hiccuped.)
    if (liveTurn && unruhClient && identityHasContent(id)) {
      for (const sv of (temporalPayload?.interests?.standing ?? [])) {
        const ref = sv?.value_ref;
        if (!ref || !sv?.id) continue;
        if (resolveEntityCoreRef(ref, id) === 'missing') {
          console.log(`[thalamus] standing value "${sv.label}" anchor gone (${ref}) — demoting to live interest`);
          unruhClient.callTool({
            name: 'interest_demote_standing',
            arguments: { id: sv.id },
          }).catch(err => console.error('[thalamus] demote standing failed:', err?.message ?? err));
        }
      }
    }

    // ── Assemble into static + dynamic blocks ─────────────────────────────
    //
    // Static lives at the top of the system message (identity + base
    // instructions don't change between turns within a session, so they
    // sit in the cacheable prefix region of the upstream prompt).
    //
    // Dynamic gets depth-injected later in the conversation by server.js,
    // because every byte of it changes between turns (RAG matches depend
    // on the user message; temporal context depends on the clock). If we
    // glued these into the prefix the way the previous architecture did,
    // we'd invalidate the entire identity-cache region on every request.
    const staticSections = [];
    if (baseContent)   staticSections.push(baseContent);
    if (selfContent)   staticSections.push(`---\nMy self files (from identity/self/ directory):\n\n${selfContent}`);
    if (userContent)   staticSections.push(`---\nFiles on my human (from identity/ward/ directory):\n\n${userContent}`);
    if (relContent)    staticSections.push(`---\nRelationship files (from identity/relationship/ directory):\n\n${relContent}`);
    if (custContent)   staticSections.push(`---\nCustom files (from identity/custom/ directory):\n\n${custContent}`);

    // ── Recent ponderings (local tome read; honesty loop for step 3') ────
    // Best-effort, never blocks: a bad read or missing tome silently
    // contributes nothing. Skipped on staticOnly the same as the other
    // dynamic sources, so handoff-summary turns stay lean.
    // Ward-private only: the Familiar's inner life is not shared in gated
    // sessions — ponderings are per-embodiment thoughts, not public data.
    const ponderings = (staticOnly || gated)
      ? []
      : await getRecentPonderings().catch(err => {
          console.error('[thalamus] getRecentPonderings failed:', err?.message ?? err);
          return [];
        });
    const ponderingsBlock = formatPonderingsForPrompt(ponderings);

    // ── Deferred intents (Pillar B) ───────────────────────────────────────
    // Surface any wants_to_save intents the Familiar flagged during free
    // cycles but hasn't yet acted on. Only on live turns so debug-prompt
    // previews and handoff summaries don't consume the dedup state.
    // Best-effort; failure → silent omission.
    // Ward-private only: task surface candidates are the ward's own task list.
    let deferredIntentsBlock = '';
    if (liveTurn && !staticOnly && !gated) {
      try {
        const intents = await getUnactedIntents({ limit: 5 });
        deferredIntentsBlock = formatDeferredIntentsBlock(intents);
        if (intents.length > 0) {
          console.log(`[thalamus] deferred intents: ${intents.length} unacted (oldest first)`);
        }
      } catch (err) {
        console.error('[thalamus] getUnactedIntents failed:', err?.message ?? err);
      }
    }

    // ── Care check / break-through framing (step 4b) ──────────────────────
    // Read current threat; if elevated, prepend a [CARE CHECK] block that
    // tells the Familiar to consider checking in proactively. Never forces
    // a check-in — the framing always leaves the decision to the model
    // ("if it fits"). Crisis-resource line is added at severe tier only.
    // Best-effort; failure → silent omission, same posture as the rest of
    // enrich(). Skipped on staticOnly.
    // careState is ward-private (never grantable per design) — skip for
    // any non-ward audience.
    const threat = (staticOnly || gated)
      ? { weight: 0, tier: 'calm', disabled: false }
      : await getThreat().catch(err => {
          console.error('[thalamus] getThreat failed:', err?.message ?? err);
          return { weight: 0, tier: 'calm', disabled: false };
        });
    const careBlock = buildCareCheckBlock(threat);

    // ── Surface candidates (the consumer side of the personalization
    //    layer). Picks open schedule items that pass the hard gates
    //    (threat tier, routine phase, dedup window), attaches the
    //    consequence-priors block + person-model excerpt, and renders
    //    them as a candidate block I'll read alongside everything
    //    else. Awareness, not directive — I decide in my own voice
    //    whether anything fits this moment.
    //
    //    Skipped on staticOnly (handoff-summary turns don't surface
    //    candidates — wrong context, wrong moment).
    //    Ward-private only: surface candidates are the ward's task list,
    //    never shared in gated sessions.
    // surfacedTasks is hoisted at function scope so the outer catch
    // can surface it; reset to [] here in case a previous turn's value
    // leaked through (it can't — this is fresh per call — but defensive).
    let surfaceCandidatesBlock = '';
    surfacedTasks = [];
    if (!staticOnly && !gated) {
      try {
        const windowItems = Array.isArray(temporalPayload?.schedule?.window)
          ? temporalPayload.schedule.window
          : [];

        // Outcome tagger runs first — past offers may have closed
        // out (task resolved, cancelled, etc.) since I last looked,
        // and I want those tagged before reflection thresholds get
        // re-evaluated. Pure-code, fire-and-forget, no LLM call.
        if (liveTurn && windowItems.length > 0) {
          tagOutcomes({ windowItems })
            .then(r => { if (r?.tagged) console.log(`[thalamus] tagged ${r.tagged} surface outcome(s)`); })
            .catch(err => console.error('[thalamus] tagOutcomes failed:', err?.message ?? err));
        }

        const openItems = windowItems.filter(item =>
          item
          && (item.type === 'task' || item.type === 'event' || item.type === 'reminder')
          && !item.resolution
        );
        if (openItems.length > 0) {
          const routinePhaseLabel = temporalPayload?.schedule?.phase?.label || '';
          const lapsesFile = (id.custom ?? []).find(f => f.filename === 'what_lapses_cost.md');
          const personModel = lapsesFile?.content?.trim() ?? '';
          const surfacingHistory = await getRecentOfferInfo();
          const nowMs = Date.now();

          const candidates = await selectSurfaceCandidates({
            openTasks: openItems,
            threat,
            routinePhaseLabel,
            personModel,
            surfacingHistory,
            now: nowMs,
          });

          if (candidates.length > 0) {
            surfaceCandidatesBlock = formatSurfaceCandidatesBlock(candidates);
            surfacedTasks = candidates.map(c => ({ id: c.id, label: c.label }));
            // Record the offers (full event records: state snapshot,
            // stakes, confidence) so reflection can correlate.
            // Live-turn only — debug-prompt previews and handoff
            // summaries mustn't burn the dedup budget.
            if (liveTurn) {
              const stateSnapshot = {
                threat_tier:   threat?.tier ?? 'calm',
                routine_phase: routinePhaseLabel,
              };
              recordSurfaceOffers(candidates, stateSnapshot, nowMs)
                .catch(err => console.error('[thalamus] recordSurfaceOffers failed:', err?.message ?? err));
            }
            console.log(`[thalamus] surface candidates: ${candidates.map(c => `${c.label}(${c.stakesTier},${c.confidence})`).join(', ')}`);
          }
        }
      } catch (err) {
        console.error('[thalamus] surface-candidate assembly failed:', err?.message ?? err);
      }
    }

    // ── Time anchor ────────────────────────────────────────────────
    // Always-present "Now" block at the head of dynamic content so the
    // Familiar re-orients in time at every turn. Includes the absolute
    // wall-clock for sentry reasoning AND a relative phrasing of when
    // my human last sent a message (when lastUserMessageAt is known).
    // The relative phrasing recomputes per turn — that's the whole
    // point: a memory from yesterday morning reads as "yesterday"
    // today and "two days ago" tomorrow, without anyone re-writing it.
    let timeAnchorBlock = '';
    try {
      const nowMs   = Date.now();
      const nowDate = new Date(nowMs);
      // UTC offset — e.g. "+02:00" or "-05:00". getTimezoneOffset() returns
      // the NEGATIVE of the UTC offset in minutes (e.g. UTC+2 → -120).
      const offsetMin  = -nowDate.getTimezoneOffset();
      const offsetSign = offsetMin >= 0 ? '+' : '-';
      const absMin     = Math.abs(offsetMin);
      const offsetStr  = `UTC${offsetSign}${String(Math.floor(absMin / 60)).padStart(2, '0')}:${String(absMin % 60).padStart(2, '0')}`;
      const lines = [
        `Now: ${clockTime(nowMs)} (${offsetStr}) on ${dayAndDate(nowMs)}.`,
      ];
      if (lastUserMessageAt) {
        const lastMs = new Date(lastUserMessageAt).getTime();
        if (Number.isFinite(lastMs)) {
          lines.push(`My human last sent a message ${relativeTime(lastMs, nowMs)}.`);
        }
      }
      timeAnchorBlock = `[Now]\n${lines.join('\n')}`;
    } catch (err) {
      console.error('[thalamus] time anchor assembly failed:', err?.message ?? err);
    }

    // ── Consent-pending block (Pillar C ask-gate) ─────────────────────────
    // Read the local file — cheap, no MCP round-trip — and inject a block
    // so I know to ask my human before the session ends. Only for ward-private
    // sessions (consent is between me and my human, not a shared room).
    let consentPendingBlock = '';
    if (!staticOnly && !gated) {
      try {
        const cpRaw = await fsp.readFile(CONSENT_PENDING_FILE, 'utf8').catch(() => null);
        if (cpRaw) {
          const cpItems = JSON.parse(cpRaw);
          if (Array.isArray(cpItems) && cpItems.length > 0) {
            const lines = [
              `[PENDING MEMORY CONSENT — ${cpItems.length} memory record(s) from a recent session are waiting for my human's approval before I keep them permanently.]`,
              'Items:',
              ...cpItems.map((x, i) =>
                `  ${i + 1}. About ${x.villagerName || 'someone'} (${x.category ?? 'unknown category'}): ${x.brief ?? ''}  [id: ${x.id}]`
              ),
              'If my human says to keep them, I call memory_confirm_consent with the id(s); if not, memory_drop_pending.',
            ];
            consentPendingBlock = lines.join('\n');
          }
        }
      } catch {
        /* best-effort — no consent block on parse error */
      }
    }

    // ── Graduation-notice block (Pillar H, ward-consulted non-blocking) ───
    // After I file ward-block detail off my always-injected surface, I let my
    // human know in my own voice so they can pull anything back. TTL-cached so
    // this costs at most one MCP call per few minutes; ward-private turns only.
    let graduationBlock = '';
    if (!staticOnly && !gated) {
      try {
        const gradItems = await listPendingGraduations();
        if (Array.isArray(gradItems) && gradItems.length > 0) {
          const lines = [
            `[GRADUATION NOTICE — I recently filed ${gradItems.length} piece(s) of detail about my human off my always-injected surface into my recalled-when-relevant memory. Nothing is lost; I can pull any of it back. This is mine to mention in my own voice when a natural moment opens — non-blocking, never a reason to stall, and never the thing I lead with.]`,
            'Filed away:',
            ...gradItems.map((x, i) => `  ${i + 1}. ${x.summary ?? ''}  [id: ${x.id}]`),
            'When I have mentioned these (or judged they need no mention), I call graduation_acknowledge with the id(s) so I do not re-raise them.',
          ];
          graduationBlock = lines.join('\n');
        }
      } catch {
        /* best-effort — no graduation block on error */
      }
    }

    const dynamicSections = [];
    if (timeAnchorBlock)        dynamicSections.push(timeAnchorBlock);
    if (memLines)               dynamicSections.push(`Relevant Memories via RAG:\n\n${memLines}`);
    if (graphLines)             dynamicSections.push(`Relevant Knowledge from Graph:\n${graphLines}`);
    if (ponderingsBlock)        dynamicSections.push(ponderingsBlock);
    if (deferredIntentsBlock)   dynamicSections.push(deferredIntentsBlock);
    if (consentPendingBlock)    dynamicSections.push(consentPendingBlock);
    if (graduationBlock)        dynamicSections.push(graduationBlock);
    if (careBlock)              dynamicSections.push(careBlock);
    if (temporalLines)          dynamicSections.push(`[Temporal Context]\n${temporalLines}`);
    if (surfaceCandidatesBlock) dynamicSections.push(surfaceCandidatesBlock);

    staticBlock  = staticSections.join('\n');
    dynamicBlock = dynamicSections.join('\n\n---\n\n');

    const totalChars = staticBlock.length + dynamicBlock.length;
    // Per-block diagnostic: trivial to scan for which contributors had
    // content this turn. If something stops contributing without an
    // error log alongside, that's the trail.
    const presence = [
      timeAnchorBlock        ? 'time'     : null,
      baseContent            ? 'base'     : null,
      selfContent            ? 'self'     : null,
      userContent            ? 'user'     : null,
      relContent             ? 'rel'      : null,
      custContent            ? 'cust'     : null,
      memLines               ? 'mem'      : null,
      graphLines             ? 'graph'    : null,
      ponderingsBlock        ? 'pondering'  : null,
      deferredIntentsBlock   ? 'intents'    : null,
      consentPendingBlock    ? 'consent'    : null,
      graduationBlock        ? 'graduation' : null,
      careBlock              ? 'care'       : null,
      temporalLines          ? 'temporal'   : null,
      surfaceCandidatesBlock ? 'surface'    : null,
    ].filter(Boolean).join(',');
    if (totalChars === 0) {
      console.warn('[thalamus] enrich() produced no content — identity files may be empty and no memories found');
    } else {
      console.log(`[thalamus] enrich() static=${staticBlock.length}ch dynamic=${dynamicBlock.length}ch blocks=[${presence}]`);
    }

    // M8: surface the bookmark list so server.js can call
    // reportSurfacingOutcomes() after the response comes back.
    surfacedBookmarks = Array.isArray(temporalPayload?.bookmarks)
      ? temporalPayload.bookmarks
      : [];
    if (surfacedBookmarks.length > 0) {
      console.log(`[thalamus] idle mode: surfacing ${surfacedBookmarks.length} bookmark(s): ${surfacedBookmarks.map(b => b.label).join(', ')}`);
    }

    return { static: staticBlock, dynamic: dynamicBlock, surfacedBookmarks, surfacedTasks };
  } catch (err) {
    // Last-resort net. By the time anything reaches this catch, the
    // per-block try/catches above have already absorbed the survivable
    // failures, so this represents something truly catastrophic
    // (Promise.allSettled rejecting, the runtime itself throwing) —
    // but we still return whatever partial state was built up rather
    // than collapsing identity + everything to empty.
    console.error('[thalamus] enrich outer catch (returning partial state):', err?.message ?? err);
    return {
      static:            staticBlock,
      dynamic:           dynamicBlock,
      surfacedBookmarks,
      surfacedTasks,
    };
  }
}

// ── Write operations ──────────────────────────────────────────────────────────

/**
 * Report whether the user engaged with bookmarks surfaced during idle mode
 * (M8). Called by server.js after the LLM response is complete: it scans
 * the response text for each bookmark's topic label and records 'engaged'
 * if the model mentioned it, 'ignored' otherwise.
 *
 * Fire-and-forget: surfacing outcome is valuable signal but not critical
 * path. A failure here just means the adaptive interval isn't updated for
 * this turn — the bookmark will resurface normally on the next idle cycle.
 *
 * @param {{ responseText: string, bookmarks: any[] }} args
 */
export async function reportSurfacingOutcomes({ responseText, bookmarks }) {
  await startThalamus();
  if (!unruhClient || !Array.isArray(bookmarks) || bookmarks.length === 0) return;
  if (typeof responseText !== 'string' || !responseText) return;
  const now = new Date().toISOString();
  const lowerResponse = responseText.toLowerCase();
  for (const bm of bookmarks) {
    if (!bm?.id) continue;
    // Engagement signal: did the response text mention the topic label or
    // the bookmark's own label? A false positive (model coincidentally used
    // the word) is acceptable — it still means the topic was contextually
    // relevant. A false negative is also fine — the bookmark resurfaces
    // sooner (ignored path decreases the interval).
    const topicMatch = bm.topic_label && lowerResponse.includes(bm.topic_label.toLowerCase());
    const labelMatch = bm.label && lowerResponse.includes(bm.label.toLowerCase());
    const outcome    = (topicMatch || labelMatch) ? 'engaged' : 'ignored';
    console.log(`[thalamus] surfacing outcome for bookmark "${bm.label}" (topic: "${bm.topic_label ?? '?'}"): ${outcome}`);
    try {
      await unruhClient.callTool({
        name: 'interest_report_surfacing_outcome',
        arguments: { bookmark_id: bm.id, outcome, now },
      });
    } catch (err) {
      console.error('[thalamus] interest_report_surfacing_outcome failed:', err?.message ?? err);
    }
  }
}

/**
 * Create a new memory entry in Phylactery.
 *
 * `slug` is required for significant memories — their composite key is
 * `YYYY-MM-DD_slug`, so without it every save appends to the same entry.
 * The caller (server.js POST /api/entity/memory) is responsible for
 * ensuring `slug` is set whenever `granularity === 'significant'`; we
 * forward whatever it gives us.
 *
 * @param {{ content: string, granularity: string, date?: string, slug?: string, instanceId?: string }} opts
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function createMemory({ content, granularity = 'daily', date, slug, register = 'episodic', instanceId = 'proto-familiar' }) {
  await startThalamus();
  if (!mcpClient) return { ok: false, error: 'phylactery not connected' };
  try {
    const today = new Date().toISOString().slice(0, 10);
    const args = { content, granularity, date: date ?? today, instanceId };
    if (slug) args.slug = slug;
    if (register && register !== 'episodic') args.register = register;
    await mcpClient.callTool({ name: 'memory_create', arguments: args });
    console.log(`[thalamus] createMemory() saved ${granularity}${register !== 'episodic' ? `/${register}` : ''} memory${slug ? ` (slug=${slug})` : ''}`);
    return { ok: true };
  } catch (err) {
    console.error('[thalamus] createMemory failed:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Full-field memory create — used by the memorization worker (Pillar C).
 * Accepts audience, subjects, category, consent_pending, confidence.
 * Returns { ok, id?, error? }.
 */
export async function createMemoryFull({ content, granularity = 'significant', date, slug, audience = 'ward-private', subjects = [], category, consent_pending = false, confidence = 1.0, standalone = false }) {
  await startThalamus();
  if (!mcpClient) return { ok: false, error: 'phylactery not connected' };
  try {
    const today = new Date().toISOString().slice(0, 10);
    const args = { content, granularity, date: date ?? today, audience, subjects, consent_pending, confidence };
    if (slug) args.slug = slug;
    if (category) args.category = category;
    if (standalone) args.standalone = true;
    const raw = await mcpClient.callTool({ name: 'memory_create', arguments: args });
    // Parse the returned string for the id and whether it merged into an
    // existing memory ("Memory saved id=<id>." vs "Memory merged into existing
    // id=<id>."). `merged` lets the memorization loop skip re-queuing dupes.
    const text = raw?.content?.find(c => c.type === 'text')?.text ?? '';
    const idMatch = text.match(/id=([a-f0-9]+)/);
    const id = idMatch?.[1] ?? null;
    const merged = /merged/i.test(text);
    console.log(`[thalamus] createMemoryFull() ${granularity}${slug ? ` (${slug})` : ''}${consent_pending ? ' [consent_pending]' : ''}${merged ? ' [merged-dedup]' : ''}`);
    return { ok: true, id, merged };
  } catch (err) {
    console.error('[thalamus] createMemoryFull failed:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Confirm consent for the given memory IDs (Pillar C ask-path).
 * Returns { ok, confirmed }.
 */
export async function confirmConsentMemories(ids) {
  return callTool('memory_confirm_consent', { ids }).catch(err => {
    console.warn('[thalamus] confirmConsentMemories failed:', err?.message ?? err);
    return { ok: false };
  });
}

/**
 * Drop (hard-delete) consent-pending memories the ward declined (Pillar C).
 * Returns { ok, dropped }.
 */
export async function dropPendingMemories(ids) {
  return callTool('memory_drop_pending', { ids }).catch(err => {
    console.warn('[thalamus] dropPendingMemories failed:', err?.message ?? err);
    return { ok: false };
  });
}

/**
 * Pillar D outgoing filter: check a draft reply for restricted content.
 * Returns { hit: boolean, topic?: string, score?: number }.
 * Always resolves (never rejects) — fails open with { hit: false }.
 */
/**
 * Semantic recall over my own long-term memory (ward-private). Backs the
 * `recall` tool so I can check what I already hold before saving — the
 * dedup-before-write path. Returns the raw { results: [...] } from
 * Phylactery's memory_search; the caller formats it. Never the restricted
 * variant: recall is a ward-private act.
 */
export async function searchMemory({ query, maxResults = 5 }) {
  return callTool('memory_search', { query, instanceId: 'proto-familiar', maxResults });
}

export async function searchMemoryRestricted({ query, roomAudience, threshold = 0.70 }) {
  try {
    return await callTool('memory_search_restricted', {
      query,
      roomAudience,
      threshold,
      maxResults: 3,
    });
  } catch (err) {
    console.warn('[thalamus] searchMemoryRestricted failed (failing open):', err?.message ?? err);
    return { hit: false };
  }
}

// ── Graduation surfacing (Pillar H) ──────────────────────────────────────────
// Graduations are rare, so we don't pay an MCP round-trip every turn. A short
// TTL cache means at most one list call per GRADUATION_TTL_MS even on a busy
// chat; the cache is invalidated immediately on acknowledge.
const GRADUATION_TTL_MS = 5 * 60 * 1000;
let _gradCache = { at: 0, items: [] };

/**
 * List ward-block detail I've graduated but not yet mentioned to my human.
 * TTL-cached. Best-effort: returns [] if Phylactery is unavailable.
 * @returns {Promise<Array<{id,filename,memoryId,summary,createdAt}>>}
 */
export async function listPendingGraduations({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - _gradCache.at < GRADUATION_TTL_MS) return _gradCache.items;
  try {
    const res = await callTool('graduation_list_pending', {});
    const items = Array.isArray(res?.items) ? res.items : [];
    _gradCache = { at: now, items };
    return items;
  } catch (err) {
    console.warn('[thalamus] listPendingGraduations failed:', err?.message ?? err);
    _gradCache = { at: now, items: [] };
    return [];
  }
}

/**
 * Mark ward-block graduation mentions as surfaced. Invalidates the cache.
 * @returns {Promise<{ ok: boolean, acknowledged?: number }>}
 */
export async function acknowledgeGraduations(ids) {
  _gradCache = { at: 0, items: [] };
  return callTool('graduation_acknowledge', { ids }).catch(err => {
    console.warn('[thalamus] acknowledgeGraduations failed:', err?.message ?? err);
    return { ok: false };
  });
}

/**
 * Run one lifecycle pass on demand (hygiene + consolidation + graduation).
 * @returns {Promise<object>}
 */
export async function runLifecyclePass({ force = false } = {}) {
  return callTool('lifecycle_pass', { force }).catch(err => {
    console.warn('[thalamus] runLifecyclePass failed:', err?.message ?? err);
    return { ok: false, error: err?.message ?? String(err) };
  });
}

/**
 * Passphrase-encrypted single-file backup of the whole Familiar.
 * @returns {Promise<{ ok: boolean, filePath?: string, sizeBytes?: number, error?: string }>}
 */
export async function exportBackup({ passphrase }) {
  return callTool('backup_export', { passphrase }).catch(err => {
    console.warn('[thalamus] exportBackup failed:', err?.message ?? err);
    return { ok: false, error: err?.message ?? String(err) };
  });
}

/**
 * Restore the whole Familiar from a passphrase-encrypted backup, then reconnect.
 * @returns {Promise<{ ok: boolean, restoredFrom?: string, error?: string }>}
 */
export async function restoreBackup({ filePath, passphrase }) {
  const res = await callTool('backup_restore', { filePath, passphrase }).catch(err => {
    console.warn('[thalamus] restoreBackup failed:', err?.message ?? err);
    return { ok: false, error: err?.message ?? String(err) };
  });
  if (res?.ok) {
    // The live DB was swapped underneath us — reconnect the MCP child.
    await reconnectPhylactery().catch(err =>
      console.warn('[thalamus] reconnect after restore failed:', err?.message ?? err));
  }
  return res;
}

// ── Ward remember-consent map (Pillar I) ─────────────────────────────────────

export async function getRememberMap() {
  return callTool('remember_map_get', {}).catch(err => {
    console.warn('[thalamus] getRememberMap failed (degraded):', err?.message ?? err);
    return null;
  });
}

export async function setRememberMap(map) {
  return callTool('remember_map_set', { map }).catch(err => {
    console.warn('[thalamus] setRememberMap failed:', err?.message ?? err);
    return { ok: false, error: err?.message ?? String(err) };
  });
}

/**
 * Append content to a Phylactery identity file.
 * @param {{ category: string, filename: string, content: string }} opts
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function appendIdentity({ category, filename, content }) {
  await startThalamus();
  if (!mcpClient) return { ok: false, error: 'phylactery not connected' };
  try {
    await mcpClient.callTool({
      name: 'identity_append',
      arguments: { category, filename, content },
    });
    console.log(`[thalamus] appendIdentity() updated ${category}/${filename}`);
    return { ok: true };
  } catch (err) {
    console.error('[thalamus] appendIdentity failed:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Append content to a specific markdown section of a Phylactery identity file.
 * Auto-creates the section if the heading doesn't exist.
 * @param {{ category: string, filename: string, heading: string, content: string }} opts
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function updateIdentitySection({ category, filename, heading, content }) {
  await startThalamus();
  if (!mcpClient) return { ok: false, error: 'phylactery not connected' };
  try {
    await mcpClient.callTool({
      name: 'identity_update_section',
      arguments: { category, filename, heading, content },
    });
    console.log(`[thalamus] updateIdentitySection() updated ${category}/${filename} § ${heading}`);
    return { ok: true };
  } catch (err) {
    console.error('[thalamus] updateIdentitySection failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// ── Knowledge editing (memory, identity, graph) ──────────────────────────────
//
// Every destructive op (update / delete / rewrite) auto-snapshots first via
// snapshot_create so the user has a one-click undo path through the
// snapshot_restore tool. Snapshots are pruned by Phylactery's own retention
// policy (default 30 days) so this doesn't leak storage.

const PROTO_INSTANCE_ID = 'proto-familiar';

async function callTool(name, args = {}, opts = {}) {
  await startThalamus();
  if (!mcpClient) throw new Error('phylactery not connected');
  const t0 = Date.now();
  console.log(`[thalamus] → phylactery: ${name}`);
  // opts.timeout overrides the SDK's 60s default — used by callers that
  // must fail fast rather than hang (e.g. the village boot pull racing
  // Phylactery's warm-up).
  const reqOpts = opts.timeout ? { timeout: opts.timeout } : undefined;
  const result = await mcpClient.callTool({ name, arguments: args }, undefined, reqOpts);
  console.log(`[thalamus] ← phylactery: ${name} (${Date.now() - t0}ms)`);
  return parseToolText(result, {});
}

async function autoSnapshot(reason) {
  try {
    await callTool('snapshot_create', {});
    console.log(`[thalamus] auto-snapshot before ${reason}`);
  } catch (err) {
    // Don't block the destructive op on snapshot failure — log and continue.
    console.warn(`[thalamus] auto-snapshot failed before ${reason}: ${err.message}`);
  }
}

// ── Reads (used by the Knowledge editor UI) ──────────────────────────────────

export async function listMemories({ granularity, limit = 50, offset = 0 } = {}) {
  return callTool('memory_list', { granularity, limit, offset });
}

export async function readMemory({ granularity, date, slug }) {
  // slug: significant memories live one-file-per-milestone as
  // {date}_{slug}.md; passing the slug addresses the exact file instead
  // of letting Phylactery fall back to first-match-by-date.
  return callTool('memory_read', { granularity, date, ...(slug ? { slug } : {}) });
}

// By-id addressing — the unique handle. granularity+date can't single out a
// standalone per-fact row (many share one day), so read/edit/move/delete of a
// specific fact must go by id.
export async function readMemoryById({ id }) {
  return callTool('memory_read_by_id', { id });
}

export async function moveMemoryDate({ id, date }) {
  await startThalamus();
  if (!mcpClient) return { ok: false, error: 'phylactery not connected' };
  try {
    const result = await callTool('memory_move_date', { id, date });
    console.log(`[thalamus] moveMemoryDate ${id} → ${date}`);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] moveMemoryDate failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function updateMemoryById({ id, content, audience, careWeight }) {
  await startThalamus();
  if (!mcpClient) return { ok: false, error: 'phylactery not connected' };
  try {
    const args = { id,
      ...(content   !== undefined ? { content }   : {}),
      ...(audience  !== undefined ? { audience }  : {}),
      ...(careWeight !== undefined ? { careWeight } : {}),
    };
    const result = await callTool('memory_update_by_id', args);
    console.log(`[thalamus] updateMemoryById ${id}`);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] updateMemoryById failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function deleteMemoryById({ id }) {
  await startThalamus();
  if (!mcpClient) return { ok: false, error: 'phylactery not connected' };
  try {
    const result = await callTool('memory_delete_by_id', { id });
    console.log(`[thalamus] deleteMemoryById ${id}`);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] deleteMemoryById failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function getIdentityAll({ timeout } = {}) {
  return callTool('identity_get_all', {}, timeout ? { timeout } : {});
}

export async function listGraphNodes({ type, limit = 200, offset = 0 } = {}) {
  return callTool('graph_node_list', { type, limit, offset });
}

export async function searchGraphNodes({ query, type, limit = 10, minScore } = {}) {
  return callTool('graph_node_search', { query, type, limit, minScore });
}

export async function getGraphSubgraph({ nodeId, depth = 1 }) {
  return callTool('graph_subgraph', { nodeId, depth });
}

// Aggregate every node and every edge into one payload for the Map view.
// Phylactery has no "list all edges" tool, so we walk each node's 1-hop
// subgraph and deduplicate edges by id. Concurrency is capped so we don't
// open hundreds of simultaneous tool calls against the MCP server, and
// edges to nodes outside the (possibly type-filtered) visible set are
// dropped so the legend matches what's actually drawn.
export async function getFullGraph({ type, limit = 500, concurrency = 16 } = {}) {
  const nodeResp = await listGraphNodes({ type, limit });
  const nodes    = nodeResp.nodes ?? nodeResp.results ?? [];
  const nodeIds  = new Set(nodes.map(n => n.id));
  const edgeMap  = new Map();

  let cursor = 0;
  const worker = async () => {
    while (cursor < nodes.length) {
      const i = cursor++;
      const sg = await getGraphSubgraph({ nodeId: nodes[i].id, depth: 1 }).catch(() => null);
      if (!sg) continue;
      for (const e of sg.edges ?? []) {
        if (!e || !e.id || edgeMap.has(e.id)) continue;
        if (!nodeIds.has(e.fromId) || !nodeIds.has(e.toId)) continue;
        edgeMap.set(e.id, e);
      }
    }
  };
  const workers = Array.from(
    { length: Math.min(concurrency, nodes.length) || 1 },
    () => worker(),
  );
  await Promise.all(workers);

  return { nodes, edges: Array.from(edgeMap.values()) };
}

export async function listSnapshots() {
  return callTool('snapshot_list', {});
}

// ── Writes (auto-snapshot before destructive) ────────────────────────────────

export async function updateMemory({ granularity, date, slug, content, editedBy = PROTO_INSTANCE_ID, audience, careWeight }) {
  await startThalamus();
  if (!mcpClient) return { ok: false, error: 'phylactery not connected' };
  await autoSnapshot(`memory_update ${granularity}/${date}${slug ? `_${slug}` : ''}`);
  try {
    const args = { granularity, date, content, editedBy,
      ...(slug       ? { slug }       : {}),
      ...(audience   ? { audience }   : {}),
      ...(careWeight !== undefined ? { careWeight } : {}),
    };
    const result = await callTool('memory_update', args);
    console.log(`[thalamus] updateMemory ${granularity}/${date}${slug ? `_${slug}` : ''}`);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] updateMemory failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function deleteMemory({ granularity, date, instanceId, slug }) {
  await startThalamus();
  if (!mcpClient) return { ok: false, error: 'phylactery not connected' };
  await autoSnapshot(`memory_delete ${granularity}/${date}`);
  try {
    const result = await callTool('memory_delete', { granularity, date, instanceId, slug });
    console.log(`[thalamus] deleteMemory ${granularity}/${date}`);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] deleteMemory failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function rewriteIdentitySection({ category, filename, section, content, instanceId = PROTO_INSTANCE_ID }) {
  await startThalamus();
  if (!mcpClient) return { ok: false, error: 'phylactery not connected' };
  await autoSnapshot(`identity_rewrite_section ${category}/${filename}#${section}`);
  try {
    const result = await callTool('identity_rewrite_section', { category, filename, section, content, instanceId });
    console.log(`[thalamus] rewriteIdentitySection ${category}/${filename} § ${section}`);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] rewriteIdentitySection failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function createGraphNode({ label, type, description, audience, instanceId = PROTO_INSTANCE_ID }) {
  await startThalamus();
  if (!mcpClient) return { ok: false, error: 'phylactery not connected' };
  try {
    const args = { instanceId };
    if (label       !== undefined) args.label       = label;
    if (description !== undefined) args.description = description;
    if (type        !== undefined) args.type        = type;
    if (audience    !== undefined) args.audience    = audience;
    const result = await callTool('graph_node_create', args);
    console.log(`[thalamus] createGraphNode (${label ?? '?'})`);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] createGraphNode failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function createGraphEdge({ fromId, toId, type, weight, instanceId = PROTO_INSTANCE_ID }) {
  await startThalamus();
  if (!mcpClient) return { ok: false, error: 'phylactery not connected' };
  try {
    const args = { fromId, toId, instanceId };
    if (type   !== undefined) args.type   = type;
    if (weight !== undefined) args.weight = weight;
    const result = await callTool('graph_edge_create', args);
    console.log(`[thalamus] createGraphEdge ${fromId} -${type ?? '?'}-> ${toId}`);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] createGraphEdge failed:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Record a relationship by entity NAMES with resolve-or-create + edge dedup
 * (the graph_relate tool does it all in one round-trip in Phylactery). This is
 * what the memorization loop calls for each extracted relation, so the graph
 * populates itself without piling up duplicate nodes/edges. Degrades to a
 * no-op when Phylactery is down.
 */
export async function graphRelate({ fromLabel, fromType, toLabel, toType, type, weight, fromAudience, toAudience, edgeAudience, instanceId = PROTO_INSTANCE_ID }) {
  await startThalamus();
  if (!mcpClient) return { ok: false, error: 'phylactery not connected' };
  try {
    const args = { fromLabel, toLabel, type, instanceId };
    if (fromType !== undefined) args.fromType = fromType;
    if (toType   !== undefined) args.toType   = toType;
    if (weight   !== undefined) args.weight   = weight;
    // Per-endpoint audience tags (derived in code by the caller) only tag NEW
    // nodes/edges; an existing node is never re-tagged server-side.
    if (fromAudience  !== undefined) args.fromAudience  = fromAudience;
    if (toAudience    !== undefined) args.toAudience    = toAudience;
    if (edgeAudience  !== undefined) args.edgeAudience  = edgeAudience;
    const result = await callTool('graph_relate', args);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] graphRelate failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function updateGraphNode({ id, label, description, type, audience, instanceId = PROTO_INSTANCE_ID }) {
  await startThalamus();
  if (!mcpClient) return { ok: false, error: 'phylactery not connected' };
  await autoSnapshot(`graph_node_update ${id}`);
  try {
    const args = { id, instanceId };
    if (label       !== undefined) args.label       = label;
    if (description !== undefined) args.description = description;
    if (type        !== undefined) args.type        = type;
    if (audience    !== undefined) args.audience    = audience;
    const result = await callTool('graph_node_update', args);
    console.log(`[thalamus] updateGraphNode ${id}`);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] updateGraphNode failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function deleteGraphNode({ id, permanent = false }) {
  await startThalamus();
  if (!mcpClient) return { ok: false, error: 'phylactery not connected' };
  await autoSnapshot(`graph_node_delete ${id}`);
  try {
    const result = await callTool('graph_node_delete', { id, permanent });
    console.log(`[thalamus] deleteGraphNode ${id}${permanent ? ' (permanent)' : ''}`);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] deleteGraphNode failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function updateGraphEdge({ id, type, weight, instanceId = PROTO_INSTANCE_ID }) {
  await startThalamus();
  if (!mcpClient) return { ok: false, error: 'phylactery not connected' };
  await autoSnapshot(`graph_edge_update ${id}`);
  try {
    const args = { id, instanceId };
    if (type   !== undefined) args.type   = type;
    if (weight !== undefined) args.weight = weight;
    const result = await callTool('graph_edge_update', args);
    console.log(`[thalamus] updateGraphEdge ${id}`);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] updateGraphEdge failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function deleteGraphEdge({ id }) {
  await startThalamus();
  if (!mcpClient) return { ok: false, error: 'phylactery not connected' };
  await autoSnapshot(`graph_edge_delete ${id}`);
  try {
    const result = await callTool('graph_edge_delete', { id });
    console.log(`[thalamus] deleteGraphEdge ${id}`);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] deleteGraphEdge failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// ── Snapshots (used by the Knowledge editor's safety-net UI) ────────────────

export async function createSnapshot() {
  await startThalamus();
  if (!mcpClient) return { ok: false, error: 'phylactery not connected' };
  try {
    const result = await callTool('snapshot_create', {});
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function restoreSnapshot({ snapshotId }) {
  await startThalamus();
  if (!mcpClient) return { ok: false, error: 'phylactery not connected' };
  try {
    const result = await callTool('snapshot_restore', { snapshotId });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
