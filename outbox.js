/**
 * Delivery outbox — a tiny persistent queue for things the Familiar
 * wants to surface to the user when they're not in the middle of
 * typing.
 *
 * Step in M11 (reminders) + M12 (proactive messaging) deliveries.
 * Each item has a kind ('reminder' | 'triage' | …), an origin id
 * (the schedule node id, the triage tick id, …), a message body,
 * and an acknowledged flag.
 *
 * Storage: JSON file at tomes/.outbox.json. Atomic writes via
 * tmp+rename. Gitignored, same posture as the threat tracker and
 * the memorization queue.
 *
 * Reads are unauthenticated and unfiltered — the UI polls
 * GET /api/outbox and shows pending items as gentle banners.
 * Acknowledge marks an item read so it stops showing.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsp, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOMES_DIR = path.join(__dirname, 'tomes');
const FILENAME = '.outbox.json';

const HISTORY_CAP = 200;

function file(tomesDir) { return path.join(tomesDir, FILENAME); }

let _lock = Promise.resolve();
function withLock(fn) {
  const prev = _lock;
  let release;
  const next = new Promise(r => { release = r; });
  _lock = prev.then(() => next);
  return (async () => {
    await prev;
    try { return await fn(); } finally { release(); }
  })();
}

async function readAll(tomesDir) {
  try {
    const raw = await fsp.readFile(file(tomesDir), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data?.items) ? data.items : [];
  } catch {
    return [];
  }
}

async function writeAll(tomesDir, items) {
  mkdirSync(tomesDir, { recursive: true });
  const trimmed = items.slice(-HISTORY_CAP);
  const tmp = file(tomesDir) + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify({ items: trimmed }, null, 2), 'utf8');
  await fsp.rename(tmp, file(tomesDir));
}

/**
 * Enqueue a new outbox item.
 *
 *   enqueueOutbox({
 *     kind:       'reminder' | 'triage',
 *     originId:   '<schedule node id or similar>',
 *     title:      'short label (rendered as banner)',
 *     body:       'optional longer text',
 *     ts:         optional ISO timestamp (defaults to now),
 *   })
 *
 * Idempotent on originId — if an unacknowledged item with the same
 * (kind, originId) is already in the queue, returns its id instead
 * of creating a duplicate. Important so a flaky reminders tick that
 * fires twice doesn't spam the user with the same banner.
 */
export async function enqueueOutbox({ kind, originId, title, body = '', ts, meta, tomesDir = DEFAULT_TOMES_DIR }) {
  if (!kind || typeof kind !== 'string') throw new Error('kind is required');
  if (!title || typeof title !== 'string') throw new Error('title is required');
  return await withLock(async () => {
    const items = await readAll(tomesDir);
    if (originId) {
      const dup = items.find(i => !i.acknowledged && i.kind === kind && i.originId === originId);
      if (dup) return { id: dup.id, deduped: true };
    }
    const id = randomUUID();
    // Spread meta first so core fields (id, kind, acknowledged, etc.) always win.
    const item = {
      ...(meta && typeof meta === 'object' ? meta : {}),
      id,
      kind,
      originId:     originId ?? null,
      title:        title.trim(),
      body:         (body ?? '').trim(),
      ts:           ts ?? new Date().toISOString(),
      acknowledged: false,
    };
    items.push(item);
    await writeAll(tomesDir, items);
    return { id, deduped: false };
  });
}

export async function listOutbox({ pendingOnly = true, limit = 50, tomesDir = DEFAULT_TOMES_DIR } = {}) {
  const items = await readAll(tomesDir);
  const filtered = pendingOnly ? items.filter(i => !i.acknowledged) : items;
  // Newest first.
  return filtered.slice().sort((a, b) => (b.ts || '').localeCompare(a.ts || '')).slice(0, limit);
}

export async function acknowledgeOutbox({ id, tomesDir = DEFAULT_TOMES_DIR }) {
  return await withLock(async () => {
    const items = await readAll(tomesDir);
    const item  = items.find(i => i.id === id);
    if (!item) return { ok: true, found: false };
    item.acknowledged = true;
    item.acknowledgedAt = new Date().toISOString();
    await writeAll(tomesDir, items);
    return { ok: true, found: true };
  });
}

export async function clearAcknowledged({ tomesDir = DEFAULT_TOMES_DIR } = {}) {
  return await withLock(async () => {
    const items = await readAll(tomesDir);
    const kept  = items.filter(i => !i.acknowledged);
    await writeAll(tomesDir, kept);
    return { ok: true, removed: items.length - kept.length };
  });
}

/**
 * Merge additional fields into an existing outbox item (by id).
 * Used by the triage loop to mark pendingContact.delivered = true
 * once a deferred trusted-contact delivery fires.
 */
export async function updateOutboxMeta({ id, meta, tomesDir = DEFAULT_TOMES_DIR }) {
  if (!id || typeof meta !== 'object' || meta === null) return { ok: false, error: 'id and meta object required' };
  return await withLock(async () => {
    const items = await readAll(tomesDir);
    const item  = items.find(i => i.id === id);
    if (!item) return { ok: false, found: false };
    Object.assign(item, meta);
    await writeAll(tomesDir, items);
    return { ok: true, found: true };
  });
}
