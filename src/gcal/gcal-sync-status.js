/**
 * Google-Calendar sync status — the tiny persisted "did it actually work?"
 * record.
 *
 * The sync loop degrades silently by design (a failed fetch must never
 * touch the chat path), but silent-to-the-chat must not mean invisible-
 * to-the-ward: a dead iCal URL or an expired Google refresh token used to
 * be observable only in the server console, while the UI kept saying
 * "connected". Every real sync attempt (not 'disabled'/'not_due' wakes)
 * lands here, and the gcal modal reads it back so "last sync / last error"
 * is a surface the ward can actually see (CLAUDE.md: failures that matter
 * are observable).
 *
 * Storage: tomes/.gcal-sync-status.json (gitignored), atomic tmp+rename,
 * same shape of helper as last-activity.js.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsp } from 'fs';

import { REPO_ROOT } from '../../repo-root.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOMES_DIR = path.join(REPO_ROOT, 'tomes');
const FILENAME = '.gcal-sync-status.json';

function file(tomesDir) { return path.join(tomesDir, FILENAME); }

/**
 * Record the outcome of one real sync attempt. `result` is the tick result
 * from runOneGcalSyncTick ({synced, reason?, error?, new/updated/removed}).
 * Best-effort — a write failure only logs.
 */
export async function recordSyncOutcome(result, { tomesDir = DEFAULT_TOMES_DIR, now = Date.now } = {}) {
  if (!result || result.reason === 'disabled' || result.reason === 'not_due') return;
  const prev = await readSyncStatus({ tomesDir });
  const at = new Date(now()).toISOString();
  const next = {
    lastAttemptAt: at,
    lastOutcome: result.synced ? 'ok' : (result.reason || 'failed'),
    lastError: result.synced ? null : (result.error ?? 'unknown'),
    lastSuccessAt: result.synced ? at : (prev?.lastSuccessAt ?? null),
    lastChanges: result.synced
      ? { new: result.new?.length ?? 0, updated: result.updated?.length ?? 0, removed: result.removed?.length ?? 0 }
      : (prev?.lastChanges ?? null),
  };
  try {
    await fsp.mkdir(tomesDir, { recursive: true });
    const f = file(tomesDir);
    await fsp.writeFile(f + '.tmp', JSON.stringify(next, null, 2), 'utf8');
    await fsp.rename(f + '.tmp', f);
  } catch (err) {
    console.warn('[gcal] could not persist sync status:', err?.message ?? err);
  }
}

/** Read the last-recorded sync status, or null when no sync has run yet. */
export async function readSyncStatus({ tomesDir = DEFAULT_TOMES_DIR } = {}) {
  try {
    const raw = await fsp.readFile(file(tomesDir), 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}
