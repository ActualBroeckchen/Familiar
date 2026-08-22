/**
 * page-watch-loop.js — the singleton that drives page watches (§9 Horizon #1).
 *
 * Thin wrapper on the established loop pattern (mirrors gcal-sync-loop /
 * reminders-loop): a short base tick wakes the loop; the pure
 * `runOnePageWatchTick` (page-watch.js) does the work — it re-reads each DUE
 * watched page over the cheap static read path, diffs it in code, and only on a
 * real change asks the injected LLM decider whether to surface a banner. Per-watch
 * cadence lives in each watch's own `intervalMs`, so the loop just wakes often
 * and lets the core decide what's due.
 *
 * Graceful degradation: the tick never throws; a fetch failure backs that one
 * watch off (and deactivates it after repeated failures) without touching the
 * others, and nothing here can reach the chat path.
 *
 * Off-switch: env PROTO_FAMILIAR_PAGE_WATCH_DISABLED=1 (hard) + the
 * `pageWatchEnabled` Settings toggle (soft), both checked by isEnabled. Inert
 * until my human (or the Familiar on their behalf) actually registers a watch.
 */

import { isCallActiveFromFile } from './call-engine.js';
import { runOnePageWatchTick } from './page-watch.js';

const BASE_TICK_MS = 5 * 60_000;   // wake every 5 min; per-watch intervalMs gates actual reads

let _started    = false;
let _interval   = null;
let _activeTick = null;

/**
 * Start the loop.
 *   isEnabled     async () => boolean
 *   fetchReadable async (url) => { ok, text } | { ok:false, error }
 *   decideChange  async ({url,label,note,oldSnapshot,newText}) => { surface, summary }
 *   enqueue       async ({id,url,label,summary,hash}) => void
 *   onTick/onError callbacks; the rest is forwarded to runOnePageWatchTick.
 */
export function startPageWatchLoop({
  baseTickMs = BASE_TICK_MS,
  isEnabled  = async () => true,
  onTick     = () => {},
  onError    = () => {},
  ...tickConfig
}) {
  if (_started) throw new Error('page watch loop already running');
  _started = true;

  const fire = async () => {
    if (_activeTick) return;
    _activeTick = (async () => {
      try {
        if (await isCallActiveFromFile()) return;                 // governor: not during a live call
        if (!(await isEnabled())) { onTick({ ran: false, reason: 'disabled' }); return; }
        const r = await runOnePageWatchTick(tickConfig);
        try { onTick({ ran: true, ...r }); } catch (err) { onError(err); }
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
  fire();   // one wake at boot so a freshly-added watch is picked up promptly
  return { stop: stopPageWatchLoop };
}

export async function stopPageWatchLoop() {
  if (!_started) return;
  if (_interval) { clearInterval(_interval); _interval = null; }
  const pending = _activeTick;
  _started = false;
  if (pending) { try { await pending; } catch { /* surfaced via onError */ } }
}

export function isRunning() { return _started; }
