/**
 * session-bindings.js — the shared "current conversation" pointer.
 *
 * The ward's web private chat and their Discord DM are ONE continuous session
 * (auto-unify). This tiny locked JSON store is how both surfaces agree on WHICH
 * session that is: a canonical key (`ward-private`) → `{ sessionId, lastTurnAt }`.
 *
 * The web claims its active session here on send / new-chat; the Discord ward-DM
 * path resolves the same pointer instead of minting a per-DM session, so a DM
 * appends to the web's current conversation (and vice versa). Idle-rollover is
 * the caller's call (it reads `lastTurnAt` against its own threshold) — this
 * module only stores and returns the pointer.
 *
 * Degrades like every tome file: an unreadable/missing store reads as "no
 * binding", and a failed write is swallowed (never sinks a chat turn). Both
 * surfaces run in one process, so an in-process promise-chain lock serializes
 * concurrent updates.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, promises as fsp } from 'node:fs';

import { REPO_ROOT } from '../../repo-root.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOMES_DIR = path.join(REPO_ROOT, 'tomes');
export const DEFAULT_BINDINGS_FILE = path.join(TOMES_DIR, '.session-bindings.json');

export const WARD_PRIVATE_KEY = 'ward-private';

// Idle gap after which a session is considered stale and the next turn starts a
// fresh one. Shared so the gateway's ward-DM rollover and the proactive-append
// path (proactive-session.js) use the SAME threshold — a proactive message must
// land in the very session the ward's reply will continue, not a stale one.
export const SESSION_IDLE_ROTATE_MS = 6 * 3600_000; // 6h

try { mkdirSync(TOMES_DIR, { recursive: true }); } catch { /* best-effort */ }

let _chain = Promise.resolve();
function withLock(fn) {
  const run = _chain.then(fn, fn);
  _chain = run.then(() => {}, () => {});
  return run;
}

async function load(file) {
  try {
    const data = JSON.parse(await fsp.readFile(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch { return {}; }
}

async function persist(file, data) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

/** The bound session for a key, or null. Read-only; never throws. */
export async function getSessionBinding(key = WARD_PRIVATE_KEY, { bindingsFile = DEFAULT_BINDINGS_FILE } = {}) {
  const data = await load(bindingsFile);
  const b = data?.[key];
  return b && b.sessionId ? { sessionId: b.sessionId, lastTurnAt: b.lastTurnAt ?? null } : null;
}

/**
 * Point a key at `sessionId` and stamp `lastTurnAt = now`. Idempotent; used both
 * to claim a session (web send / new-chat / handoff) and to touch it on a new
 * turn. Never throws — returns { ok }.
 */
export async function setSessionBinding(key, sessionId, { bindingsFile = DEFAULT_BINDINGS_FILE, at = new Date().toISOString() } = {}) {
  if (!key || !sessionId) return { ok: false, reason: 'missing key or sessionId' };
  try {
    return await withLock(async () => {
      const data = await load(bindingsFile);
      data[key] = { sessionId, lastTurnAt: at };
      await persist(bindingsFile, data);
      return { ok: true, sessionId, lastTurnAt: at };
    });
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) };
  }
}
