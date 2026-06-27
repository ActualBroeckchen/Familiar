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

const BASE_TICK_MS = 60_000;                 // how often the loop wakes to check
export const DEFAULT_SYNC_INTERVAL_MS = 60 * 60_000;  // hourly (§1.6)
const MIN_SYNC_INTERVAL_MS = 5 * 60_000;     // floor so a heavy user can't hammer Google
const MAX_SYNC_INTERVAL_MS = 24 * 60 * 60_000;

let _started      = false;
let _interval     = null;
let _activeTick   = null;
let _lastSyncTs   = 0;

export function clampSyncIntervalMs(ms) {
  if (!Number.isFinite(ms)) return DEFAULT_SYNC_INTERVAL_MS;
  return Math.max(MIN_SYNC_INTERVAL_MS, Math.min(MAX_SYNC_INTERVAL_MS, ms));
}

/**
 * Run one sync. Pure-ish — all I/O injected.
 *
 *   fetchSource  async () => { ok, icsText?, events?, reconcileDeletes? }
 *                The adapter; ok:false on ANY failure (never throws).
 *   ingest       async ({ icsText, events, reconcileDeletes }) =>
 *                { ok, new, updated, removed }
 *   routeNew     async (newIds[]) => void  (flags them for the projection cue)
 *
 * Returns { synced, reason, new, updated, removed }. synced:false reasons:
 *   'fetch_failed' | 'ingest_failed'
 */
export async function runOneGcalSyncTick({ fetchSource, ingest, routeNew = async () => {} }) {
  if (typeof fetchSource !== 'function') throw new Error('fetchSource is required');
  if (typeof ingest      !== 'function') throw new Error('ingest is required');

  const src = await fetchSource().catch(err => ({ ok: false, error: err?.message ?? String(err) }));
  if (!src || !src.ok) {
    return { synced: false, reason: 'fetch_failed', error: src?.error ?? 'unknown' };
  }

  const result = await ingest({
    icsText: src.icsText,
    events: src.events,
    // A windowed/partial read tells the adapter so; default to a full
    // reconcile for the link tier (a complete snapshot).
    reconcileDeletes: src.reconcileDeletes !== false,
  }).catch(err => ({ ok: false, error: err?.message ?? String(err) }));

  if (!result || result.ok === false) {
    return { synced: false, reason: 'ingest_failed', error: result?.error ?? 'unknown' };
  }

  const newIds = Array.isArray(result.new) ? result.new : [];
  if (newIds.length) {
    try { await routeNew(newIds); } catch { /* projection cue is best-effort */ }
  }
  return {
    synced: true,
    new: newIds,
    updated: Array.isArray(result.updated) ? result.updated : [],
    removed: Array.isArray(result.removed) ? result.removed : [],
    complex_series: Array.isArray(result.complex_series) ? result.complex_series : [],
  };
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
  _lastSyncTs = 0;

  const fire = async () => {
    if (_activeTick) return;
    _activeTick = (async () => {
      try {
        if (!(await isEnabled())) { onTick({ synced: false, reason: 'disabled' }); return; }
        const intervalMs = clampSyncIntervalMs(await getIntervalMs());
        const nowMs = now();
        if (_lastSyncTs && nowMs - _lastSyncTs < intervalMs) {
          onTick({ synced: false, reason: 'not_due' });
          return;
        }
        _lastSyncTs = nowMs;
        const r = await runOneGcalSyncTick(tickConfig);
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
  _started    = false;
  _lastSyncTs = 0;
  if (pending) { try { await pending; } catch { /* surfaced via onError */ } }
}

/** Force the next wake to sync regardless of the interval gate (the "Sync now" button). */
export function resetGcalSyncCadence() { _lastSyncTs = 0; }

export function isRunning() { return _started; }
