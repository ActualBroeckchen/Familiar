/**
 * Threat-level tracker — persistent decaying scalar.
 *
 * Stores the Familiar's current "how concerned should I be about my
 * human right now" weight. Read paths compute the effective (decayed)
 * value on the fly, so a paused or restarted system sees the right
 * level when it next reads — no background job needed.
 *
 * Storage: JSON file at tomes/.threat-state.json (gitignored, local
 * to this install). Picked over Unruh SQLite for v1 because the
 * shape is trivial (one scalar + small history) and JSON iterates
 * faster across the JS/Python boundary.
 *
 * Atomic writes via tmp+rename (same pattern memorization.js uses).
 *
 * Off switches:
 *   - PROTO_FAMILIAR_THREAT_DISABLED=1  → record() becomes a no-op,
 *                                          get() returns calm/0.
 *   - resetThreat()                      → zero the level (audit-logged).
 *
 * Limits (deliberate):
 *   - History capped to last 50 events (FIFO).
 *   - Raw weight capped to MAX_RAW_WEIGHT to prevent runaway.
 *   - Default tau (decay) is 3 days half-life — distress shouldn't
 *     linger as long as a deep interest, but shouldn't vanish in hours
 *     either.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsp, mkdirSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOMES_DIR  = path.join(__dirname, 'tomes');
const STATE_FILENAME     = '.threat-state.json';

const DEFAULT_TAU_DAYS   = 3.0;
const DAY_MS             = 24 * 60 * 60 * 1000;

export const MAX_RAW_WEIGHT = 10.0;
export const MIN_RAW_WEIGHT = 0.0;
export const HISTORY_CAP    = 50;

// Threat tiers — keep in lockstep with crisis-signals tier weights
// AND with the cadence multipliers in pondering-cadence.js.
export const THREAT_TIERS = Object.freeze({
  severe:   7,
  high:     4,
  moderate: 2,
  mild:     0.5,
  calm:     0,
});

export function tierForThreat(weight) {
  if (!Number.isFinite(weight) || weight <= THREAT_TIERS.calm)     return 'calm';
  if (weight >= THREAT_TIERS.severe)                                return 'severe';
  if (weight >= THREAT_TIERS.high)                                  return 'high';
  if (weight >= THREAT_TIERS.moderate)                              return 'moderate';
  if (weight >= THREAT_TIERS.mild)                                  return 'mild';
  return 'calm';
}

function isDisabled() {
  return process.env.PROTO_FAMILIAR_THREAT_DISABLED === '1';
}

function stateFile(tomesDir) {
  return path.join(tomesDir, STATE_FILENAME);
}

// ── Persistence ────────────────────────────────────────────────────

let _writeLock = Promise.resolve();
function withWriteLock(fn) {
  const prev = _writeLock;
  let release;
  const next = new Promise(r => { release = r; });
  _writeLock = prev.then(() => next);
  return (async () => {
    await prev;
    try { return await fn(); } finally { release(); }
  })();
}

async function readState(tomesDir) {
  try {
    const raw = await fsp.readFile(stateFile(tomesDir), 'utf8');
    const s   = JSON.parse(raw);
    return {
      raw_weight:   Number.isFinite(s?.raw_weight) ? s.raw_weight : 0,
      last_touched: typeof s?.last_touched === 'string' ? s.last_touched : null,
      history:      Array.isArray(s?.history) ? s.history : [],
    };
  } catch {
    return { raw_weight: 0, last_touched: null, history: [] };
  }
}

async function writeState(tomesDir, state) {
  mkdirSync(tomesDir, { recursive: true });
  const file = stateFile(tomesDir);
  const tmp  = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

// ── Decay ──────────────────────────────────────────────────────────

/**
 * Effective weight given raw + last_touched + clock. Exponential decay
 * with half-life ~ tauDays. Pure — exposed for tests.
 */
export function effectiveWeight(raw, lastTouchedIso, { now = Date.now(), tauDays = DEFAULT_TAU_DAYS } = {}) {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (!lastTouchedIso) return Math.max(0, raw);
  const lastMs = Date.parse(lastTouchedIso);
  if (!Number.isFinite(lastMs)) return raw;
  const elapsedDays = Math.max(0, (now - lastMs) / DAY_MS);
  // Half-life form: w(t) = raw * 0.5^(t / tau)
  const decayed = raw * Math.pow(0.5, elapsedDays / tauDays);
  return Math.max(0, decayed);
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Get current threat state. Decays on read.
 *
 * Returns { weight, raw_weight, tier, last_touched, disabled }.
 */
export async function getThreat({
  tomesDir = DEFAULT_TOMES_DIR,
  now      = Date.now(),
  tauDays  = DEFAULT_TAU_DAYS,
} = {}) {
  if (isDisabled()) {
    return { weight: 0, raw_weight: 0, tier: 'calm', last_touched: null, disabled: true };
  }
  const s   = await readState(tomesDir);
  const eff = effectiveWeight(s.raw_weight, s.last_touched, { now, tauDays });
  return {
    weight:       Math.round(eff * 1000) / 1000,
    raw_weight:   s.raw_weight,
    tier:         tierForThreat(eff),
    last_touched: s.last_touched,
    disabled:     false,
  };
}

/**
 * Record a delta to the threat level.
 *
 *   recordThreat({ delta: 4, source: 'chat', signals: [...] })
 *
 * Decays the current value first, then adds delta, then writes.
 * Caps at MAX_RAW_WEIGHT, floors at 0. Appends an audit entry to
 * history (FIFO-capped at HISTORY_CAP).
 *
 * No-op when PROTO_FAMILIAR_THREAT_DISABLED=1.
 *
 * Returns { ok, weight, raw_weight, tier, disabled? }.
 */
export async function recordThreat({
  delta,
  source   = 'chat',
  signals  = [],
  tomesDir = DEFAULT_TOMES_DIR,
  now      = Date.now(),
  tauDays  = DEFAULT_TAU_DAYS,
} = {}) {
  if (!Number.isFinite(delta)) return { ok: false, error: 'delta must be a finite number' };
  if (isDisabled())           return { ok: true, weight: 0, raw_weight: 0, tier: 'calm', disabled: true };
  if (delta === 0)            return getThreat({ tomesDir, now, tauDays }).then(s => ({ ok: true, ...s }));

  return await withWriteLock(async () => {
    const s   = await readState(tomesDir);
    const eff = effectiveWeight(s.raw_weight, s.last_touched, { now, tauDays });
    const newRaw = Math.max(MIN_RAW_WEIGHT, Math.min(MAX_RAW_WEIGHT, eff + delta));
    const ts  = new Date(now).toISOString();

    const entry = {
      ts,
      delta,
      effective_before: Math.round(eff * 1000) / 1000,
      raw_after:        Math.round(newRaw * 1000) / 1000,
      source,
      signals,
    };
    const history = [...s.history, entry].slice(-HISTORY_CAP);

    await writeState(tomesDir, { raw_weight: newRaw, last_touched: ts, history });

    return {
      ok:           true,
      weight:       Math.round(newRaw * 1000) / 1000,
      raw_weight:   newRaw,
      tier:         tierForThreat(newRaw),
      disabled:     false,
    };
  });
}

/**
 * Manually reset threat to zero. Always works (even when disabled —
 * disabled only blocks RECORDING; reset is an explicit user action
 * and should always succeed). Audit entry is appended.
 */
export async function resetThreat({
  tomesDir = DEFAULT_TOMES_DIR,
  now      = Date.now(),
  source   = 'manual_reset',
} = {}) {
  return await withWriteLock(async () => {
    const s  = await readState(tomesDir);
    const ts = new Date(now).toISOString();
    const entry = {
      ts,
      delta:            -s.raw_weight,
      effective_before: s.raw_weight,
      raw_after:        0,
      source,
      signals:          [{ id: 'manual_reset', tier: 'safety' }],
    };
    const history = [...s.history, entry].slice(-HISTORY_CAP);
    await writeState(tomesDir, { raw_weight: 0, last_touched: ts, history });
    return { ok: true, weight: 0, raw_weight: 0, tier: 'calm' };
  });
}

/**
 * Read recent threat history (most-recent first). For UI / audit views.
 */
export async function getThreatHistory({
  tomesDir = DEFAULT_TOMES_DIR,
  limit    = 20,
} = {}) {
  const s = await readState(tomesDir);
  return [...s.history].reverse().slice(0, limit);
}
