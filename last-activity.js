/**
 * Last-activity tracker — when did the user last send a chat message?
 *
 * Tiny persistent timestamp used by the silence-triage loop (M12b)
 * to decide "has the user been quiet long enough that I should
 * consider checking in?" Persistent because the answer should
 * survive a server restart — if the user closed their laptop 12
 * hours ago, the next boot needs to know.
 *
 * Storage: tomes/.last-activity.json (gitignored). Atomic
 * tmp+rename. Race-safe enough for the chat path (one writer at a
 * time in practice; the lock is just defensive).
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsp, mkdirSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOMES_DIR = path.join(__dirname, 'tomes');
const FILENAME = '.last-activity.json';

function file(tomesDir) { return path.join(tomesDir, FILENAME); }

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

/** Stamp "user was active right now." Called from the chat path. */
export async function recordUserActivity({ tomesDir = DEFAULT_TOMES_DIR, ts } = {}) {
  return await withWriteLock(async () => {
    mkdirSync(tomesDir, { recursive: true });
    const payload = JSON.stringify({ lastUserMessageAt: ts ?? new Date().toISOString() });
    const f   = file(tomesDir);
    const tmp = f + '.tmp';
    await fsp.writeFile(tmp, payload, 'utf8');
    await fsp.rename(tmp, f);
    return { ok: true };
  });
}

/**
 * Read the last-user-activity timestamp. Returns null when no
 * activity has been recorded yet (fresh install) — the caller
 * should treat that as "user has never been active here," which
 * for the silence-triage loop means: do nothing.
 */
export async function getLastUserActivity({ tomesDir = DEFAULT_TOMES_DIR } = {}) {
  try {
    const raw = await fsp.readFile(file(tomesDir), 'utf8');
    const data = JSON.parse(raw);
    const ts = data?.lastUserMessageAt;
    if (!ts || typeof ts !== 'string') return null;
    const ms = Date.parse(ts);
    if (!Number.isFinite(ms)) return null;
    return { ts, ms };
  } catch {
    return null;
  }
}
