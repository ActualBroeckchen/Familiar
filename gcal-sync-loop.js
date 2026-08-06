/**
 * Google Calendar sync loop (build spec §1.6).
 *
 * A thin loop on the established singleton pattern (mirrors
 * reminders-loop / reachout-loop): a pure, fully-injectable
 * runOneGcalSyncTick() carries the behaviour; a singleton wrapper drives
 * it. Each due tick: fetch the calendar via the configured source adapter
 * → hand the bytes/events to Unruh's gcal_ingest → route ONLY the `new`
 * ids into the projection cue (§4). A re-sync that changes nothing routes
 * nothing.
 *
 * Cadence is ward-configurable (default hourly). Rather than recreate the
 * timer when the interval changes, the loop wakes on a short base tick and
 * runs a sync only once the configured interval has elapsed — so a settings
 * change applies on the next wake, no restart (the supervisor discipline the
 * Discord gateway uses, kept lightweight here).
 *
 * Graceful degradation (CLAUDE.md): the source adapter NEVER throws — a bad
 * URL / network blip / non-iCal body returns ok:false and the tick skips,
 * logged loudly, never surfaced in chat, never reconciling deletions (a
 * failed fetch must not look like "the calendar is empty", §1.3).
 *
 * Off-switch: env PROTO_FAMILIAR_GCAL_DISABLED=1 (hard) + the
 * "Google Calendar sync" Settings toggle (soft), both checked by isEnabled.
 */

import { isCallActiveFromFile } from './call-engine.js';

const BASE_TICK_MS = 60_000;                 // how often the loop wakes to check
export const DEFAULT_SYNC_INTERVAL_MS = 60 * 60_000;  // hourly (§1.6)
const MIN_SYNC_INTERVAL_MS = 5 * 60_000;     // floor so a heavy user can't hammer Google
const MAX_SYNC_INTERVAL_MS = 24 * 60 * 60_000;
// A FAILED sync retries on this short leash instead of burning the whole
// configured interval — a transient blip (network, expired token, flaky CLI)
// must not turn "hourly sync" into "an hour of silence per hiccup".
export const FAILURE_RETRY_MS = 5 * 60_000;

let _started      = false;
let _interval     = null;
let _activeTick   = null;
let _nextDueTs    = 0;

export function clampSyncIntervalMs(ms) {
  if (!Number.isFinite(ms)) return DEFAULT_SYNC_INTERVAL_MS;
  return Math.max(MIN_SYNC_INTERVAL_MS, Math.min(MAX_SYNC_INTERVAL_MS, ms));
}

/**
 * Run one sync. Pure-ish — all I/O injected.
 *
 *   fetchSource  async () => { ok, snapshots?: [...], icsText?, events?, reconcileDeletes? }
 *                The adapter; ok:false on ANY failure (never throws). May
 *                return a LIST of per-calendar snapshots (multi-calendar) or a
 *                single legacy snapshot (icsText/events at top level).
 *   ingest       async ({ icsText, events, reconcileDeletes, calendarId, includeLegacy }) =>
 *                { ok, new, updated, removed }
 *   routeNew     async (newIds[]) => void  (flags them for the projection cue)
 *
 * Returns { synced, reason, new, updated, removed }. synced:false reasons:
 *   'fetch_failed' | 'ingest_failed'. With multiple calendars, the tick
 *   succeeds if AT LEAST ONE calendar ingested — one bad calendar never
 *   blanks the others (per-source independence, CLAUDE.md).
 */
export async function runOneGcalSyncTick({ fetchSource, ingest, routeNew = async () => {} }) {
  if (typeof fetchSource !== 'function') throw new Error('fetchSource is required');
  if (typeof ingest      !== 'function') throw new Error('ingest is required');

  const src = await fetchSource().catch(err => ({ ok: false, error: err?.message ?? String(err) }));
  if (!src || !src.ok) {
    return { synced: false, reason: 'fetch_failed', error: src?.error ?? 'unknown' };
  }

  // Normalise to a list of per-calendar snapshots. A legacy single-snapshot
  // source (no `snapshots`) is wrapped as one unscoped snapshot so old
  // adapters keep working unchanged.
  const snapshots = Array.isArray(src.snapshots)
    ? src.snapshots
    : [{ icsText: src.icsText, events: src.events, reconcileDeletes: src.reconcileDeletes, calendarId: src.calendarId, includeLegacy: src.includeLegacy }];

  const newIds = [], updatedIds = [], removedIds = [], complex = [];
  let anyOk = false, lastErr = null;
  for (const snap of snapshots) {
    const result = await ingest({
      icsText: snap.icsText,
      events: snap.events,
      // A windowed/partial read tells the adapter so; default to a full
      // reconcile for the link tier (a complete snapshot).
      reconcileDeletes: snap.reconcileDeletes !== false,
      calendarId: snap.calendarId,
      includeLegacy: snap.includeLegacy === true,
      attribution: snap.attribution,
    }).catch(err => ({ ok: false, error: err?.message ?? String(err) }));
    if (!result || result.ok === false) { lastErr = result?.error ?? 'unknown'; continue; }
    anyOk = true;
    if (Array.isArray(result.new))            newIds.push(...result.new);
    if (Array.isArray(result.updated))        updatedIds.push(...result.updated);
    if (Array.isArray(result.removed))        removedIds.push(...result.removed);
    if (Array.isArray(result.complex_series)) complex.push(...result.complex_series);
  }

  if (!anyOk) {
    return { synced: false, reason: 'ingest_failed', error: lastErr ?? 'unknown' };
  }
  if (newIds.length) {
    try { await routeNew(newIds); } catch { /* projection cue is best-effort */ }
  }
  return { synced: true, new: newIds, updated: updatedIds, removed: removedIds, complex_series: complex };
}

// ── Singleton lifecycle ──────────────────────────────────────────

export function startGcalSyncLoop({
  baseTickMs    = BASE_TICK_MS,
  isEnabled     = async () => true,
  getIntervalMs = async () => DEFAULT_SYNC_INTERVAL_MS,
  onTick        = () => {},
  onError       = () => {},
  now           = Date.now,
  ...tickConfig
}) {
  if (_started) throw new Error('gcal sync loop already running');
  _started = true;
  _nextDueTs = 0;

  const fire = async () => {
    if (_activeTick) return;
    _activeTick = (async () => {
      try {
        // Governor (§4.3): defer the calendar sync during a live call.
        if (await isCallActiveFromFile()) return;
        if (!(await isEnabled())) { onTick({ synced: false, reason: 'disabled' }); return; }
        const intervalMs = clampSyncIntervalMs(await getIntervalMs());
        const nowMs = now();
        if (nowMs < _nextDueTs) {
          onTick({ synced: false, reason: 'not_due' });
          return;
        }
        const r = await runOneGcalSyncTick(tickConfig);
        // Success consumes the full interval; failure retries on the short
        // leash (never longer than the interval itself).
        _nextDueTs = nowMs + (r?.synced ? intervalMs : Math.min(intervalMs, FAILURE_RETRY_MS));
        try { onTick(r); } catch (err) { onError(err); }
      } catch (err) {
        try { onError(err); } catch { /* swallow */ }
      } finally {
        _activeTick = null;
      }
    })();
    return _activeTick;
  };

  _interval = setInterval(() => { fire(); }, baseTickMs);
  _interval.unref?.();
  // One immediate wake so a freshly-configured calendar syncs at boot
  // rather than waiting a full base tick.
  fire();
  return { stop: stopGcalSyncLoop };
}

export async function stopGcalSyncLoop() {
  if (!_started) return;
  if (_interval) { clearInterval(_interval); _interval = null; }
  const pending = _activeTick;
  _started   = false;
  _nextDueTs = 0;
  if (pending) { try { await pending; } catch { /* surfaced via onError */ } }
}

/** Force the next wake to sync regardless of the interval gate (the "Sync now" button). */
export function resetGcalSyncCadence() { _nextDueTs = 0; }

export function isRunning() { return _started; }
