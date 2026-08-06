/**
 * Memory coverage sweep (day-anchoring Phase 2).
 *
 * The always-on answer to unreliable rollover: a slow background pass that
 * memorizes any PAST day whose conversations never got ingested — for when a
 * session didn't roll over cleanly (the ward switched sessions or cleared
 * history). It only ENQUEUES into the existing memorization worker (no LLM call
 * of its own — ride existing requests, gate in code) and never throws.
 *
 * Two cheap gates keep it cheap and correct:
 *   - skips the CURRENT local day (handled live by session-end / memorize_now —
 *     sweeping it would re-extract a growing slice every tick);
 *   - skips days already complete (incompleteDates() only returns 'partial').
 *
 * Hard off-switch PROTO_FAMILIAR_MEMORY_SWEEP_DISABLED=1 (wired in server.js).
 */

import { incompleteDates, collectDateSlices } from './memory-coverage.js';
import { isCallActiveFromFile } from './call-engine.js';
import { enqueueMemorization } from './memorization.js';

const DEFAULT_TICK_MS = 10 * 60_000; // 10 min — coverage doesn't need a fast pulse

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * One sweep pass. `getConnection()` returns { provider, apiKey, model } (the
 * primary connection) or null. Enqueues the missing slices of every past
 * incomplete day. Returns a small summary for logging; never throws.
 */
export async function runMemorySweepTick({
  getConnection,
  today = todayLocal,
  // Injectable for tests; default to the real coverage/queue functions.
  listIncomplete = incompleteDates,
  dateSlices = collectDateSlices,
  enqueue = enqueueMemorization,
}) {
  const conn = getConnection();
  if (!conn?.apiKey || !conn?.provider || !conn?.model) return { acted: false, reason: 'no-connection' };

  const cutoff = today();
  const dates = (await listIncomplete()).filter(d => d < cutoff); // past days only
  if (dates.length === 0) return { acted: false, reason: 'covered' };

  let enqueued = 0;
  for (const date of dates) {
    for (const { sessionId, audienceTag, seg } of await dateSlices(date)) {
      try {
        const r = await enqueue({
          sessionId, scope: 'day', topicId: date,
          messageRange: { start: seg.startIdx, end: seg.endIdx },
          messages: seg.messages,
          provider: conn.provider, apiKey: conn.apiKey, model: conn.model,
          audienceTag,
        });
        if (!r.deduped) enqueued++;
      } catch (err) {
        console.warn(`[sweep] ${date} slice failed:`, err?.message ?? err);
      }
    }
  }
  return { acted: enqueued > 0, reason: enqueued ? 'swept' : 'in-flight', enqueued, days: dates.length };
}

// ── Singleton lifecycle (mirrors reachout-loop) ──────────────────────────────

let _started = false;
let _interval = null;
let _activeTick = null;

export function startMemorySweepLoop({
  tickMs = DEFAULT_TICK_MS,
  isEnabled = async () => true,
  getConnection,
  onTick = () => {},
  onError = () => {},
} = {}) {
  if (_started) throw new Error('memory sweep loop already running');
  _started = true;

  const fire = async () => {
    if (_activeTick) return;
    _activeTick = (async () => {
      try {
        // Governor (§4.3): defer the coverage sweep during a live call.
        if (await isCallActiveFromFile()) return;
        if (!(await isEnabled())) { onTick({ acted: false, reason: 'disabled' }); return; }
        const r = await runMemorySweepTick({ getConnection });
        try { onTick(r); } catch (err) { onError(err); }
      } catch (err) {
        try { onError(err); } catch { /* swallow */ }
      } finally {
        _activeTick = null;
      }
    })();
    return _activeTick;
  };

  _interval = setInterval(() => { fire(); }, tickMs);
  _interval.unref?.();
  // No immediate fire — let the server settle first; past days aren't urgent.
  return { stop: stopMemorySweepLoop };
}

export async function stopMemorySweepLoop() {
  if (!_started) return;
  if (_interval) { clearInterval(_interval); _interval = null; }
  const pending = _activeTick;
  _started = false;
  if (pending) { try { await pending; } catch { /* surfaced via onError */ } }
}

export function isRunning() { return _started; }
