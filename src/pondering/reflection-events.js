/**
 * Reflection observability (temporal-bridges Piece 5).
 *
 * The consequence-graph visibility defect survived for weeks because a dead
 * learning loop looks identical to a quiet one: nothing renders either way.
 * So every reflection tick that RUNS writes a heartbeat here — INCLUDING
 * all-zero entries — and the ward can see "last ran, graded N, promoted M"
 * on demand. Absence of recent entries is then a real signal ("reflection
 * hasn't run"), distinct from emptiness ("it ran and found nothing yet").
 *
 * Mirrors the triage/reachout JSONL event-log pattern. Never throws — an
 * observability write can't break the reflection follow-through.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsp, mkdirSync } from 'fs';

import { REPO_ROOT } from '../../repo-root.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.join(REPO_ROOT, 'logs');
mkdirSync(LOGS_DIR, { recursive: true });

export const REFLECTION_LOG_FILE = path.join(LOGS_DIR, 'reflection-events.jsonl');

/**
 * Append one reflection heartbeat. `entry` carries whatever the tick knew:
 *   { title, edgesGraded, promotions, wroteIdentity, routineReview, error }
 * All optional — an all-zero entry is exactly the point.
 */
export async function appendReflectionEvent(entry = {}) {
  try {
    await fsp.appendFile(
      REFLECTION_LOG_FILE,
      JSON.stringify({ ...entry, loggedAt: new Date().toISOString() }) + '\n',
      'utf8',
    );
  } catch { /* non-critical — observability must not break the loop */ }
}

/** Newest first. Tolerates a missing or partly-corrupt log. */
export async function readReflectionEvents({ limit = 50 } = {}) {
  try {
    const raw = await fsp.readFile(REFLECTION_LOG_FILE, 'utf8');
    return raw.split('\n').filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .reverse()
      .slice(0, Math.max(1, Math.min(500, limit)));
  } catch {
    return [];
  }
}
