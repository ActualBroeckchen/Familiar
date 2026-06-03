/**
 * thalamus.js — entity-core bridge for Proto-Familiar
 *
 * Mirrors Psycheros's context-building approach (src/entity/context.ts +
 * src/rag/context-builder.ts):
 *
 *   1. All identity categories (self, user, relationship, custom), each file
 *      wrapped in its promptLabel XML tags and sorted in canonical order.
 *   2. base_instructions.md placed first if present (no section header).
 *   3. Relevant memories formatted with score and source.
 *   4. Knowledge graph context via node search + 1-hop edge traversal.
 *
 * If entity-core is unreachable for any reason, enrich() logs the error
 * and returns '' so the request continues without enrichment.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
import os from 'os';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Match server.js: read the version from package.json so the MCP
// client handshake identifies which Proto-Familiar version connected.
const PKG_VERSION = (() => {
  try { return JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || 'unknown'; }
  catch { return 'unknown'; }
})();

// Resolve the entity-core entry point.
//
// Sibling directory: new installs land at `../entity-core/`. Older
// installs from before the rename used `../entity-core-alpha/`; we
// still probe that as a fallback to avoid breaking existing setups.
//
// Inside the checkout: the Psycheros repo became a Deno workspace at
// entity-core-v0.2.x, with entity-core living at packages/entity-core/.
// Older sibling checkouts kept it at the repo root, so probe both.
//
// $ENTITY_CORE_PATH wins over all probes.
const ENTITY_CORE_DIRS = [
  path.resolve(__dirname, '../entity-core'),
  path.resolve(__dirname, '../entity-core-alpha'),
];
function probeEntry() {
  for (const dir of ENTITY_CORE_DIRS) {
    const workspace = path.join(dir, 'packages', 'entity-core', 'src', 'mod.ts');
    if (existsSync(workspace)) return workspace;
    const legacy = path.join(dir, 'src', 'mod.ts');
    if (existsSync(legacy)) return legacy;
  }
  // Default to the modern layout in the new dir so error messages point
  // at where a fresh install would land.
  return path.join(ENTITY_CORE_DIRS[0], 'packages', 'entity-core', 'src', 'mod.ts');
}

const ENTITY_CORE_ENTRY = process.env.ENTITY_CORE_PATH ?? probeEntry();

// Project root of entity-core (parent of src/).
// entity-core resolves its ./data directory relative to cwd, so we must
// start it from its own root, not from wherever node server.js was launched.
const ENTITY_CORE_ROOT = path.dirname(path.dirname(ENTITY_CORE_ENTRY));

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

// Resolve `deno` to an absolute path, same rationale as resolveUvBinary.
// This matters for `npm start` specifically: unlike the launcher scripts
// (start.sh / start.bat / Proto-Familiar.command / tray.ps1) which prime
// PATH with ~/.deno/bin before spawning node, `npm start` inherits only
// the invoking shell's PATH. Deno's installer writes to ~/.deno/bin and
// appends it to the shell *profile*, so a shell that hasn't been reloaded
// since install won't have it — and a bare `command: 'deno'` then fails
// with ENOENT, silently disabling entity-core. Probing the known install
// locations first makes entity-core robust regardless of PATH state.
// DENO_BIN env var overrides everything.
function resolveDenoBinary() {
  if (process.env.DENO_BIN && existsSync(process.env.DENO_BIN)) return process.env.DENO_BIN;
  const home = os.homedir();
  const isWin = process.platform === 'win32';
  const candidates = isWin
    ? [
        path.join(home, '.deno', 'bin', 'deno.exe'),                     // official installer default
        path.join(process.env.LOCALAPPDATA ?? '', 'deno', 'deno.exe'),
        path.join(home, '.cargo', 'bin', 'deno.exe'),
      ]
    : [
        path.join(home, '.deno', 'bin', 'deno'),                         // official installer default
        path.join(home, '.cargo', 'bin', 'deno'),
        '/usr/local/bin/deno',
        '/opt/homebrew/bin/deno',                                        // Apple-silicon Homebrew
      ];
  for (const c of candidates) { if (c && existsSync(c)) return c; }
  return isWin ? 'deno.exe' : 'deno'; // last-resort PATH lookup
}

// Path to the central settings file. server.js owns the read/write
// surface (PUT /api/settings) but we read it here at spawn time to pick
// up the API-key designation for entity-core. Read is sync and small.
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

// Despite the name, entity-core's ENTITY_CORE_LLM_BASE_URL env var is
// actually the FULL endpoint including /chat/completions — its
// createLLMClient does `fetch(baseUrl, { method: 'POST' })` with no
// path appending. So we pass the same chat-completions URLs server.js
// uses for its proxy. Shared via ./providers.js to keep one source.
import { PROVIDER_URLS } from './providers.js';

/**
 * Build the env block passed to the entity-core child process based on
 * the saved-connection the user designated as the entity-core source
 * (`entityCoreConnectionId` in settings.json).
 *
 * Returns {} when no designation exists, the pointed-at connection is
 * missing, or its API key is empty. Entity-core then runs without an
 * API key — same as before this wiring existed — so the change is
 * additive and safe.
 *
 * Entity-core's createLLMClient() (packages/entity-core/src/llm/client.ts
 * in the upstream Psycheros repo, release entity-core-v0.2.2) reads
 * three env vars and returns null if ANY are missing — causing the
 * misleading "No LLM API key configured" error from the consolidator
 * even when only the base URL or model is the missing one. We
 * therefore have to set all three.
 *
 * Env mapping:
 *   ENTITY_CORE_LLM_API_KEY    — always set when designation resolves
 *   ENTITY_CORE_LLM_BASE_URL   — full chat-completions URL from PROVIDER_URLS
 *   ENTITY_CORE_LLM_MODEL      — model id from the connection
 *   ENTITY_CORE_LLM_PROVIDER   — provider tag (informational)
 *   ZAI_API_KEY / ZAI_BASE_URL / ZAI_MODEL  — only when the designated
 *     connection is a z.ai provider; entity-core treats these as
 *     equivalent fallback names, but setting both pairs makes builds
 *     that read either work without re-config.
 */
// Internal — exposed for diagnostic logging only. Earlier iterations
// exported this for an out-of-tree smoke test that no longer exists.
function loadEntityCoreEnv() {
  let settings;
  try {
    settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {}; // no settings.json yet (fresh install) or unreadable
  }
  const id = settings.entityCoreConnectionId;
  if (!id) return {};
  const conn = (settings.connections ?? []).find(c => c?.id === id);
  if (!conn) return {};
  const apiKey = (conn.apiKey ?? '').trim();
  if (!apiKey) return {};
  const provider = conn.provider ?? '';
  const model    = conn.model ?? '';
  const baseUrl  = PROVIDER_URLS[provider] ?? '';

  const env = {
    ENTITY_CORE_LLM_API_KEY:  apiKey,
    ENTITY_CORE_LLM_BASE_URL: baseUrl,
    ENTITY_CORE_LLM_MODEL:    model,
    ENTITY_CORE_LLM_PROVIDER: provider,
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
let entityCoreShuttingDown = false;
let entityCoreReconnectAttempts = 0;
/** @type {Promise<void> | null} */
let entityCoreReconnectInFlight = null;          // mutex for reconnect path
const ENTITY_CORE_RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const ENTITY_CORE_RECONNECT_MAX_ATTEMPTS = 10;

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
const USER_ORDER = [
  'user_identity.md', 'user_life.md', 'user_beliefs.md',
  'user_preferences.md', 'user_patterns.md', 'user_notes.md',
];
const RELATIONSHIP_ORDER = [
  'relationship_dynamics.md', 'relationship_history.md', 'relationship_notes.md',
];

// ── Connection ────────────────────────────────────────────────────────────────

async function connect() {
  // Skip cleanly when entity-core isn't installed, mirroring
  // connectUnruh's pre-check. Without this, a missing checkout (fresh
  // clone before install.sh runs, or a user who skipped the
  // entity-core clone) lets the spawn fail with ENOENT, which fires
  // onclose, which spins scheduleEntityCoreReconnect through all 10
  // attempts over ~3 minutes — pure log noise for a permanent
  // condition that a retry can't fix. Returning here means no
  // transport, no onclose, no retry loop. A real reconnect after a
  // transient crash still proceeds (the checkout exists, so this
  // check passes).
  if (!existsSync(ENTITY_CORE_ENTRY)) {
    console.log('[thalamus] entity-core not found at', ENTITY_CORE_ENTRY, '— skipping (run install.sh / install.bat to clone it)');
    return;
  }

  // Resolve the per-connection env block fresh on every connect so a
  // reconnect after a settings change picks up the new key without a
  // server restart. StdioClientTransport merges this with PATH/HOME/etc
  // (DEFAULT_INHERITED_ENV_VARS), so we don't clobber the shell env.
  const ecEnv = loadEntityCoreEnv();
  const haveKey = Object.prototype.hasOwnProperty.call(ecEnv, 'ENTITY_CORE_LLM_API_KEY');
  // Surface partial-config gotchas explicitly: entity-core's createLLMClient
  // returns null (→ "No LLM API key configured" error from the consolidator)
  // when any of api_key / base_url / model is missing. A blank base_url
  // typically means the connection's provider tag isn't in PROVIDER_URLS.
  if (haveKey && !ecEnv.ENTITY_CORE_LLM_BASE_URL) {
    console.warn(`[thalamus] entity-core: provider "${ecEnv.ENTITY_CORE_LLM_PROVIDER}" has no known URL — add it to PROVIDER_URLS in providers.js`);
  }
  if (haveKey && !ecEnv.ENTITY_CORE_LLM_MODEL) {
    console.warn('[thalamus] entity-core: designated connection has no model set — consolidation will fail');
  }

  const transport = new StdioClientTransport({
    command: resolveDenoBinary(),
    args: ['run', '-A', '--unstable-cron', ENTITY_CORE_ENTRY],
    cwd: ENTITY_CORE_ROOT,
    env: ecEnv,
  });

  const client = new Client(
    { name: 'proto-familiar', version: PKG_VERSION },
    { capabilities: {} },
  );

  client.onclose = () => {
    console.error('[thalamus] entity-core connection closed');
    mcpClient = null;
    // Auto-reconnect with backoff on unexpected close — mirrors the
    // Unruh path. Skipped when we're tearing down on purpose (settings
    // change or server shutdown).
    if (entityCoreShuttingDown) return;
    scheduleEntityCoreReconnect();
  };

  await client.connect(transport);
  mcpClient = client;
  entityCoreReconnectAttempts = 0; // successful connect resets backoff
  console.log(
    '[thalamus] Connected to entity-core at', ENTITY_CORE_ENTRY,
    haveKey ? `(API key from connection "${ecEnv.ENTITY_CORE_LLM_PROVIDER}")` : '(no API key — designate one in the Connections sidebar)',
  );
}

// Reconnect with exponential backoff on unexpected close — same shape
// as scheduleUnruhReconnect. Capped to avoid spinning forever when
// entity-core is fundamentally broken. Skips when a settings-change
// reconnect is already in flight (no need to double up).
function scheduleEntityCoreReconnect() {
  if (entityCoreShuttingDown) return;
  if (entityCoreReconnectInFlight) return;
  if (entityCoreReconnectAttempts >= ENTITY_CORE_RECONNECT_MAX_ATTEMPTS) {
    console.error(`[thalamus] entity-core reconnect gave up after ${ENTITY_CORE_RECONNECT_MAX_ATTEMPTS} attempts — restart Proto-Familiar to retry`);
    return;
  }
  const delay = ENTITY_CORE_RECONNECT_BACKOFF_MS[Math.min(entityCoreReconnectAttempts, ENTITY_CORE_RECONNECT_BACKOFF_MS.length - 1)];
  entityCoreReconnectAttempts += 1;
  console.log(`[thalamus] Reconnecting to entity-core in ${delay}ms (attempt ${entityCoreReconnectAttempts}/${ENTITY_CORE_RECONNECT_MAX_ATTEMPTS})`);
  setTimeout(() => {
    connect().catch(err => {
      console.error('[thalamus] entity-core reconnect failed:', err.message);
      scheduleEntityCoreReconnect();
    });
  }, delay).unref?.(); // unref so the timer doesn't keep the process alive
}

/**
 * Tear down the current entity-core child and re-spawn it with a fresh
 * env (so a settings change to `entityCoreConnectionId` or the pointed-
 * at connection's apiKey takes effect immediately). Safe to call when
 * no client is currently connected — behaves as a plain connect().
 *
 * Two callers can fire this in quick succession (rapid settings PUTs
 * while a chat is in flight, the user clicking the +entity-core toggle
 * on different rows quickly). A single in-flight promise serialises
 * them so concurrent calls don't orphan a child process.
 */
export async function reconnectEntityCore() {
  if (entityCoreReconnectInFlight) return entityCoreReconnectInFlight;
  entityCoreReconnectInFlight = (async () => {
    entityCoreShuttingDown = true;
    try {
      if (mcpClient) {
        try { await mcpClient.close?.(); } catch { /* best-effort */ }
        mcpClient = null;
      }
    } finally {
      entityCoreShuttingDown = false;
    }
    try {
      await connect();
      entityCoreReconnectAttempts = 0;
    } catch (err) {
      console.error('[thalamus] entity-core reconnect failed:', err.message);
      // Fall back to backoff retries — the user's settings change
      // will eventually take effect when entity-core comes back.
      scheduleEntityCoreReconnect();
    }
  })();
  try {
    await entityCoreReconnectInFlight;
  } finally {
    entityCoreReconnectInFlight = null;
  }
}

// Unruh runs as an independent stdio child. Its failures must not affect
// entity-core's enrichment path — connectUnruh() is best-effort and the
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
export function shutdownEntityCore() {
  entityCoreShuttingDown = true;
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
 * to 1.0; value_ref is an opaque pointer to an entity-core identity
 * fact (M7 bridge validates it on a live turn).
 */
export async function setStandingInterest({ topic, weight = 1.0, value_ref }) {
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
  if (!unruhClient) return { ok: false, error: 'unruh not connected' };
  try {
    const r = await unruhClient.callTool({
      name: 'schedule_resolve',
      arguments: { id, resolution },
    });
    return parseToolText(r, { ok: true });
  } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}

export async function deleteScheduleNode({ id }) {
  if (!unruhClient) return { ok: false, error: 'unruh not connected' };
  try {
    const r = await unruhClient.callTool({
      name: 'schedule_delete_node',
      arguments: { id },
    });
    return parseToolText(r, { ok: true });
  } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}

// ── Reminders wrappers (M11) ─────────────────────────────────────

export async function getDueReminders({ now, limit = 50 } = {}) {
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
  if (!unruhClient) return { ok: false, error: 'unruh not connected' };
  try {
    const r = await unruhClient.callTool({ name: 'reminders_health', arguments: {} });
    return parseToolText(r, { ok: false });
  } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}

// ── Handoff wrappers (M9b) ───────────────────────────────────────

export async function getHandoff({ include_consumed = true } = {}) {
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

connect().catch(err => {
  console.error('[thalamus] Failed to start entity-core:', err.message);
});

connectUnruh().catch(err => {
  console.error('[thalamus] Failed to start Unruh:', err.message);
  scheduleUnruhReconnect();
});

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
      "I notice my user has shown some signs of low mood or worry in " +
      "recent messages. I stay warm; my tone holds a little more weight. " +
      "No need to ask explicitly unless it fits — I just stay present."
    );
  } else if (tier === 'moderate') {
    lines.push(
      "My user has been signaling notable distress (struggling, " +
      "overwhelm, dissociation, panic, or similar). If a gentle " +
      "check-in fits — not in place of answering what they said, but " +
      "alongside it — I can offer one. If it would feel intrusive " +
      "given their current message, I stay steady. I don't perform " +
      "concern."
    );
  } else if (tier === 'high') {
    lines.push(
      "My user has been signaling serious distress (hopelessness, " +
      "severe isolation, can't-go-on language). I prioritise their " +
      "wellbeing in this response. I make space for what's underneath " +
      "if there's any opening for it. I don't pretend to be a " +
      "therapist — I'm a steady, caring presence who's actually paying " +
      "attention. If checking in would help, I do it; if matching " +
      "their topic with care is what they need, I do that."
    );
  } else if (tier === 'severe') {
    lines.push(
      "Threat is SEVERE. My user has used language consistent with " +
      "suicidal ideation, self-harm intent, or an acute crisis plan. " +
      "I prioritise their wellbeing absolutely. I respond with grounded " +
      "warmth — no alarm, no clinical distance, no scripts.",
      "",
      "If they appear to be in immediate danger, I gently make these " +
      "resources visible without lecturing:",
      "  • US: 988 Suicide & Crisis Lifeline (call or text 988)",
      "  • UK: Samaritans — 116 123",
      "  • International: https://findahelpline.com/",
      "",
      "I am not a therapist. I am not a crisis counsellor. I am " +
      "someone who cares about them and wants them to be okay. I speak " +
      "from that."
    );
  }
  lines.push(
    '',
    'This block is a parameter, not a script. I decide how (or whether) ' +
    'it shows up in my reply. I never claim a check-in I did not perform. ' +
    'I never invent concern that is not there. My user can dial this ' +
    'system down or off at any time.'
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
import { resolveEntityCoreRef, identityHasContent } from './entity-ref.js';
import { getRecentPonderings, formatPonderingsForPrompt } from './recent-ponderings.js';
import { getThreat, tierForThreat } from './threat-tracker.js';

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
 * Build entity-core + Unruh context for a user message, split into a
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
 *                whose entity-core anchor has vanished. debug-prompt and
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
export async function enrich(userMessage, { liveTurn = false, staticOnly = false, lastUserMessageAt = null } = {}) {
  const EMPTY = { static: '', dynamic: '', surfacedBookmarks: [] };
  if (!mcpClient && !unruhClient) return EMPTY;

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
    // entity-core; either or both may be absent and the rest still works.
    if (mcpClient) console.log(`[thalamus] → entity-core: identity_get_all${staticOnly ? '' : ', memory_search, graph_node_search'}`);
    if (unruhClient && !staticOnly) console.log('[thalamus] → unruh: temporal_context');
    const entityCorePromises = mcpClient ? [
      mcpClient.callTool({ name: 'identity_get_all', arguments: {} }),
      staticOnly ? Promise.reject(new Error('skipped (staticOnly)'))
        : mcpClient.callTool({
            name: 'memory_search',
            arguments: { query: userMessage, instanceId: 'proto-familiar', maxResults: 5 },
          }),
      staticOnly ? Promise.reject(new Error('skipped (staticOnly)'))
        : mcpClient.callTool({
            name: 'graph_node_search',
            arguments: { query: userMessage, limit: 10, minScore: 0.3 },
          }),
    ] : [Promise.reject(new Error('entity-core not connected')),
         Promise.reject(new Error('entity-core not connected')),
         Promise.reject(new Error('entity-core not connected'))];

    // Cap Unruh's contribution to the chat path so a slow / hung query can
    // never block the LLM call. The underlying MCP request keeps running in
    // the background — Promise.race doesn't cancel — but it can no longer
    // delay the response. If timeouts become common, that's a signal for
    // the next milestone to add real cancellation or a query budget.
    //
    // M8 idle-mode: if lastUserMessageAt is set and the user has been quiet
    // longer than IDLE_THRESHOLD_MS, pass mode='idle' so Unruh returns due
    // bookmarks alongside the standard interests block.
    const nowTs = new Date().toISOString();
    const isIdle = !staticOnly
      && lastUserMessageAt != null
      && (Date.now() - new Date(lastUserMessageAt).getTime()) >= IDLE_THRESHOLD_MS;
    if (isIdle) console.log(`[thalamus] idle mode active (last user msg: ${lastUserMessageAt})`);
    const unruhArgs = { now: nowTs, ...(isIdle ? { mode: 'idle' } : {}) };
    const unruhPromise = (unruhClient && !staticOnly)
      ? Promise.race([
          unruhClient.callTool({ name: 'temporal_context', arguments: unruhArgs }),
          new Promise((_, reject) => setTimeout(
            () => reject(new Error(`temporal_context timed out after ${UNRUH_CALL_TIMEOUT_MS}ms`)),
            UNRUH_CALL_TIMEOUT_MS,
          ).unref?.()),
        ])
      : Promise.reject(new Error(staticOnly ? 'skipped (staticOnly)' : 'unruh not connected'));

    const [idSettled, memSettled, graphSettled, temporalSettled] = await Promise.allSettled([
      ...entityCorePromises,
      unruhPromise,
    ]);

    if (idSettled.status       === 'fulfilled') console.log('[thalamus] ← entity-core: identity_get_all — ok');
    else if (mcpClient)                         console.error('[thalamus] identity_get_all failed:', idSettled.reason?.message ?? idSettled.reason);
    if (!staticOnly) {
      if (memSettled.status      === 'fulfilled') console.log('[thalamus] ← entity-core: memory_search — ok');
      else if (mcpClient)                        console.error('[thalamus] memory_search failed:', memSettled.reason?.message ?? memSettled.reason);
      if (graphSettled.status    === 'fulfilled') console.log('[thalamus] ← entity-core: graph_node_search — ok');
      else if (mcpClient)                        console.error('[thalamus] graph_node_search failed:', graphSettled.reason?.message ?? graphSettled.reason);
      if (temporalSettled.status === 'fulfilled') console.log('[thalamus] ← unruh: temporal_context — ok');
      else if (unruhClient)                      console.error('[thalamus] temporal_context failed:', temporalSettled.reason?.message ?? temporalSettled.reason);
    }

    const idResult       = idSettled.status       === 'fulfilled' ? idSettled.value       : null;
    const memResult      = memSettled.status      === 'fulfilled' ? memSettled.value      : null;
    const graphResult    = graphSettled.status    === 'fulfilled' ? graphSettled.value    : null;
    const temporalResult = temporalSettled.status === 'fulfilled' ? temporalSettled.value : null;

    // ── Identity ──────────────────────────────────────────────────────────
    const id = parseToolText(idResult, {});

    // base_instructions.md goes first without a section header
    const baseFile = (id.self ?? []).find(f => f.filename === 'base_instructions.md');
    const baseContent = baseFile?.content?.trim()
      ? wrapFile(baseFile.filename, baseFile.content, baseFile.promptLabel)
      : '';

    const selfFiles   = (id.self ?? []).filter(f => f.filename !== 'base_instructions.md');
    const selfContent = identitySection(selfFiles, SELF_ORDER);
    const userContent = identitySection(id.user ?? [], USER_ORDER);
    const relContent  = identitySection(id.relationship ?? [], RELATIONSHIP_ORDER);
    const custContent = identitySection(id.custom ?? [], []);

    // ── Memories ──────────────────────────────────────────────────────────
    const mem = parseToolText(memResult, {});
    const memLines = (mem.results ?? [])
      .map((r, i) => {
        const score  = ((r.score ?? r.vectorScore ?? 0) * 100).toFixed(0);
        const source = [r.granularity, r.date].filter(Boolean).join('/');
        return `[${i + 1}] (from ${source}, ${score}% relevant)\n${(r.excerpt ?? '').trim()}`;
      })
      .filter(s => s.length > 5)
      .join('\n\n');

    // ── Knowledge graph ───────────────────────────────────────────────────
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
    let graphLines = '';

    if (graphNodes.length > 0) {
      // Traverse 1 hop from top-3 nodes; ignore individual failures
      const traversalNodes = graphNodes.slice(0, 3);
      console.log(`[thalamus] → entity-core: graph_subgraph ×${traversalNodes.length}`);
      const traversals = await Promise.allSettled(
        traversalNodes.map(n =>
          mcpClient.callTool({
            name: 'graph_subgraph',
            arguments: { nodeId: n.id, depth: 1 },
          })
        )
      );
      console.log(`[thalamus] ← entity-core: graph_subgraph (${traversals.filter(r => r.status === 'fulfilled').length}/${traversalNodes.length} ok)`);

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
          edgeNodeIds.add(edge.fromId);
          edgeNodeIds.add(edge.toId);
          const from = nodeLabels.get(edge.fromId) ?? edge.fromId;
          const to   = nodeLabels.get(edge.toId)   ?? edge.toId;
          const rel  = edge.customType ?? edge.type;
          const desc = nodeDescs.get(edge.toId);
          lines.push(desc ? `${from} ${rel} ${to} (${desc})` : `${from} ${rel} ${to}`);
          if (edge.fromId && nodeLabels.has(edge.fromId)) idLegendNodes.set(edge.fromId, nodeLabels.get(edge.fromId));
          if (edge.toId   && nodeLabels.has(edge.toId))   idLegendNodes.set(edge.toId,   nodeLabels.get(edge.toId));
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

    // ── Temporal context (Unruh) ──────────────────────────────────────────
    // We deliberately omit the section entirely when there is nothing
    // to say rather than print a hollow "[Temporal Context]" header, so
    // the LLM doesn't waste attention parsing scaffolding.
    const temporalPayload = parseToolText(temporalResult, null);
    const temporalLines = formatTemporalContext(temporalPayload);

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

    // ── Standing-value → entity-core bridge (M7) ──────────────────────────
    // A standing value can anchor to an entity-core identity fact via a
    // `value_ref` (e.g. "entity-core:self/my_wants.md#Caring…"). If that
    // fact has disappeared, demote the standing value to a live interest
    // (don't drop it). Thalamus mediates because it alone holds both
    // sides — entity-core's identity (`id`) and Unruh's interests.
    //
    // Two guards against false mass-demotion:
    //   1. liveTurn — only reconcile on a real chat turn (a read-only
    //      debug-prompt preview must not mutate state).
    //   2. identityLooksReal — entity-core must have returned actual
    //      identity content. `idResult` being non-null isn't enough:
    //      an error / non-JSON payload parses to `id = {}`, against
    //      which EVERY ref would read "missing" → mass demote. Require
    //      at least one non-empty identity category before trusting a
    //      "missing" verdict. (Erring toward not-demoting is the safe
    //      direction — a stale standing value is cheaper than wrongly
    //      stripping every value because entity-core hiccuped.)
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
    if (userContent)   staticSections.push(`---\nFiles on my human (from identity/user/ directory):\n\n${userContent}`);
    if (relContent)    staticSections.push(`---\nRelationship files (from identity/relationship/ directory):\n\n${relContent}`);
    if (custContent)   staticSections.push(`---\nCustom files (from identity/custom/ directory):\n\n${custContent}`);

    // ── Recent ponderings (local tome read; honesty loop for step 3') ────
    // Best-effort, never blocks: a bad read or missing tome silently
    // contributes nothing. Skipped on staticOnly the same as the other
    // dynamic sources, so handoff-summary turns stay lean.
    const ponderings = staticOnly
      ? []
      : await getRecentPonderings().catch(err => {
          console.error('[thalamus] getRecentPonderings failed:', err?.message ?? err);
          return [];
        });
    const ponderingsBlock = formatPonderingsForPrompt(ponderings);

    // ── Care check / break-through framing (step 4b) ──────────────────────
    // Read current threat; if elevated, prepend a [CARE CHECK] block that
    // tells the Familiar to consider checking in proactively. Never forces
    // a check-in — the framing always leaves the decision to the model
    // ("if it fits"). Crisis-resource line is added at severe tier only.
    // Best-effort; failure → silent omission, same posture as the rest of
    // enrich(). Skipped on staticOnly.
    const threat = staticOnly
      ? { weight: 0, tier: 'calm', disabled: false }
      : await getThreat().catch(err => {
          console.error('[thalamus] getThreat failed:', err?.message ?? err);
          return { weight: 0, tier: 'calm', disabled: false };
        });
    const careBlock = buildCareCheckBlock(threat);

    const dynamicSections = [];
    if (memLines)        dynamicSections.push(`Relevant Memories via RAG:\n\n${memLines}`);
    if (graphLines)      dynamicSections.push(`Relevant Knowledge from Graph:\n${graphLines}`);
    if (ponderingsBlock) dynamicSections.push(ponderingsBlock);
    if (careBlock)       dynamicSections.push(careBlock);
    if (temporalLines)   dynamicSections.push(`[Temporal Context]\n${temporalLines}`);

    const staticBlock  = staticSections.join('\n');
    const dynamicBlock = dynamicSections.join('\n\n---\n\n');

    const totalChars = staticBlock.length + dynamicBlock.length;
    if (totalChars === 0) {
      console.warn('[thalamus] enrich() produced no content — identity files may be empty and no memories found');
    } else {
      console.log(`[thalamus] enrich() static=${staticBlock.length}ch dynamic=${dynamicBlock.length}ch`);
    }

    // M8: surface the bookmark list so server.js can call
    // reportSurfacingOutcomes() after the response comes back.
    const surfacedBookmarks = Array.isArray(temporalPayload?.bookmarks)
      ? temporalPayload.bookmarks
      : [];
    if (surfacedBookmarks.length > 0) {
      console.log(`[thalamus] idle mode: surfacing ${surfacedBookmarks.length} bookmark(s): ${surfacedBookmarks.map(b => b.label).join(', ')}`);
    }

    return { static: staticBlock, dynamic: dynamicBlock, surfacedBookmarks };
  } catch (err) {
    console.error('[thalamus] enrich failed:', err.message);
    return { static: '', dynamic: '', surfacedBookmarks: [] };
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
 * Create a new memory entry in entity-core.
 * @param {{ content: string, granularity: string, date?: string, instanceId?: string }} opts
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function createMemory({ content, granularity = 'daily', date, instanceId = 'proto-familiar' }) {
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
  try {
    const today = new Date().toISOString().slice(0, 10);
    await mcpClient.callTool({
      name: 'memory_create',
      arguments: { content, granularity, date: date ?? today, instanceId },
    });
    console.log(`[thalamus] createMemory() saved ${granularity} memory`);
    return { ok: true };
  } catch (err) {
    console.error('[thalamus] createMemory failed:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Append content to an entity-core identity file.
 * @param {{ category: string, filename: string, content: string }} opts
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function appendIdentity({ category, filename, content }) {
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
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
 * Append content to a specific markdown section of an entity-core identity file.
 * Auto-creates the section if the heading doesn't exist.
 * @param {{ category: string, filename: string, heading: string, content: string }} opts
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function updateIdentitySection({ category, filename, heading, content }) {
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
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
// snapshot_restore tool. Snapshots themselves are pruned by entity-core's own
// retention policy (ENTITY_CORE_SNAPSHOT_RETENTION_DAYS, default 30 days),
// so this doesn't leak storage.

const PROTO_INSTANCE_ID = 'proto-familiar';

async function callTool(name, args = {}) {
  if (!mcpClient) throw new Error('entity-core not connected');
  const t0 = Date.now();
  console.log(`[thalamus] → entity-core: ${name}`);
  const result = await mcpClient.callTool({ name, arguments: args });
  console.log(`[thalamus] ← entity-core: ${name} (${Date.now() - t0}ms)`);
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

export async function readMemory({ granularity, date }) {
  return callTool('memory_read', { granularity, date });
}

export async function getIdentityAll() {
  return callTool('identity_get_all', {});
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
// entity-core has no "list all edges" tool, so we walk each node's 1-hop
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

export async function updateMemory({ granularity, date, content, editedBy = PROTO_INSTANCE_ID }) {
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
  await autoSnapshot(`memory_update ${granularity}/${date}`);
  try {
    const result = await callTool('memory_update', { granularity, date, content, editedBy });
    console.log(`[thalamus] updateMemory ${granularity}/${date}`);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] updateMemory failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function deleteMemory({ granularity, date, instanceId, slug }) {
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
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
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
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

export async function createGraphNode({ label, type, description, instanceId = PROTO_INSTANCE_ID }) {
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
  try {
    const args = { instanceId };
    if (label       !== undefined) args.label       = label;
    if (description !== undefined) args.description = description;
    if (type        !== undefined) args.type        = type;
    const result = await callTool('graph_node_create', args);
    console.log(`[thalamus] createGraphNode (${label ?? '?'})`);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] createGraphNode failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function createGraphEdge({ fromId, toId, type, weight, instanceId = PROTO_INSTANCE_ID }) {
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
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

export async function updateGraphNode({ id, label, description, type, instanceId = PROTO_INSTANCE_ID }) {
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
  await autoSnapshot(`graph_node_update ${id}`);
  try {
    const args = { id, instanceId };
    if (label       !== undefined) args.label       = label;
    if (description !== undefined) args.description = description;
    if (type        !== undefined) args.type        = type;
    const result = await callTool('graph_node_update', args);
    console.log(`[thalamus] updateGraphNode ${id}`);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] updateGraphNode failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function deleteGraphNode({ id, permanent = false }) {
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
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
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
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
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
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
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
  try {
    const result = await callTool('snapshot_create', {});
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function restoreSnapshot({ snapshotId }) {
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
  try {
    const result = await callTool('snapshot_restore', { snapshotId });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
