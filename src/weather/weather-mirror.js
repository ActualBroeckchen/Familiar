/**
 * weather-mirror.js — the synchronous read-mirror (Weather sense, W-A).
 *
 * The [Now] block is assembled in hot paths (every chat turn, plus the
 * triage/warmth/noticing deliberations) that must never block on an MCP
 * round-trip. So the refresh loop writes the CURRENT location's current
 * conditions to a tiny local file, and buildTimeAnchorBlock reads it
 * synchronously. Weather is a per-location, low-churn value; a small file
 * read is the same pattern last-activity.js uses.
 *
 * The mirror is the gate: it exists only while weather is enabled AND a
 * current location has a fresh forecast. Absent/stale → no line (absence
 * renders as absence). The env off-switch short-circuits before any read.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsp, readFileSync, mkdirSync } from 'fs';

import { buildNowWeatherLine, formatWeatherVague, WEATHER_STALE_MS } from './weather-format.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOMES_DIR = path.join(__dirname, '..', '..', 'tomes');
const FILENAME = '.weather-now.json';

function file(tomesDir) { return path.join(tomesDir, FILENAME); }

function envDisabled() {
  return process.env.PROTO_FAMILIAR_WEATHER_DISABLED === '1';
}

/**
 * The one weather gate (env off-switch + the default-ON settings toggle),
 * shared so every surface reads it the same way. Weather is on unless the env
 * kill-switch is set or the ward turned `weatherEnabled` off.
 */
export function weatherEnabled(settings = {}) {
  if (envDisabled()) return false;
  return settings?.weatherEnabled !== false;   // default-ON
}

/** Write the current-location mirror atomically. `payload` is
 *  { provider, fetched_at, current, hourly }. */
export async function writeWeatherMirror(payload, { tomesDir = DEFAULT_TOMES_DIR } = {}) {
  try {
    mkdirSync(tomesDir, { recursive: true });
    const f = file(tomesDir), tmp = f + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(payload), 'utf8');
    await fsp.rename(tmp, f);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** Remove the mirror (weather disabled, or no current location) so the [Now]
 *  line drops on the next turn. Best-effort. */
export async function clearWeatherMirror({ tomesDir = DEFAULT_TOMES_DIR } = {}) {
  try { await fsp.rm(file(tomesDir), { force: true }); } catch { /* fine */ }
}

/** Synchronous read of the mirror. null on absent/corrupt/disabled. */
export function readWeatherMirrorSync({ tomesDir = DEFAULT_TOMES_DIR } = {}) {
  if (envDisabled()) return null;
  try {
    const data = JSON.parse(readFileSync(file(tomesDir), 'utf8'));
    return (data && typeof data === 'object') ? data : null;
  } catch {
    return null;
  }
}

/**
 * The [Now] weather line, or '' — the one call buildTimeAnchorBlock makes.
 * Sync, never throws. '' when disabled, absent, or stale (staleness enforced
 * again here belt-and-suspenders even if a stale mirror lingered on disk).
 */
export function readWeatherNowLine({ tomesDir = DEFAULT_TOMES_DIR, now = Date.now(), unit = 'celsius' } = {}) {
  try {
    const mirror = readWeatherMirrorSync({ tomesDir });
    if (!mirror) return '';
    return buildNowWeatherLine(mirror, { now, unit });
  } catch {
    return '';
  }
}

/**
 * The VAGUE [Now] weather line for a gated (non-ward-private) surface, or ''
 * (§5.6). Qualitative only — no numbers/units/times/labels, so precise values
 * can't leak a location to a shared audience. This is what a gated turn passes
 * to buildTimeAnchorBlock instead of readWeatherNowLine; it fails closed to ''.
 */
export function readWeatherVagueLine({ tomesDir = DEFAULT_TOMES_DIR, now = Date.now() } = {}) {
  try {
    const mirror = readWeatherMirrorSync({ tomesDir });
    if (!mirror) return '';
    return formatWeatherVague(mirror, { now });
  } catch {
    return '';
  }
}

export { WEATHER_STALE_MS };
