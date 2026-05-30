/**
 * Autonomous pondering loop — step 4a of the caring spine.
 *
 * The Familiar wakes on its own cadence (governed by current interest
 * weights), picks one interest with weight-proportional sampling, and
 * ponders it. No human invocation required. The result is a real,
 * timestamped tome entry — same honesty rule as steps 1-3 ́.
 *
 * Architecture:
 *
 *   runOneTick({...})            ← pure, fully injectable: takes
 *                                    getInterests + runPonder + clock
 *                                    + rng + cadence formula and
 *                                    returns {acted, reason, ...}.
 *                                    The whole behavioural surface.
 *                                    All tests target this directly.
 *
 *   startPonderingLoop({...})    ← thin singleton wrapper: setInterval
 *   stopPonderingLoop()            on top of runOneTick, mirrors
 *                                    memorization.js's lifecycle so
 *                                    server.js can boot/shutdown it
 *                                    the same way.
 *
 * Safety:
 *   - Reentrancy guard: one tick at a time. Slow LLM calls don't pile up.
 *   - stopPonderingLoop() awaits any in-flight tick, so demos / shutdown
 *     don't strand a running ponder.
 *   - Errors in the tick don't kill the loop; they go to onError and
 *     the next tick tries again.
 *   - No eligible interests → quietly sleeps. Never invents a topic.
 */

import { pickInterest }            from './interest-picker.js';
import { computeRequiredInterval } from './pondering-cadence.js';

const DEFAULT_TICK_MS = 60_000; // poll once per minute by default

/**
 * Run a single tick. Pure-ish — all I/O comes through injected callbacks
 * so tests can drive every branch deterministically.
 *
 * Return shape: { acted: boolean, ... }
 *   acted:false carries `reason`:
 *     - 'no_interests'     — interest layer empty
 *     - 'no_eligible_pick' — entries present but none eligible (zero weight, etc.)
 *     - 'too_soon'         — cooldown not yet elapsed
 *   acted:true carries:
 *     - picked  — the interest object that won the weighted draw
 *     - result  — whatever runPonder() returned (typically ponderOnce's result)
 */
export async function runOneTick({
  getInterests,
  runPonder,
  computeInterval = computeRequiredInterval,
  rng             = Math.random,
  now             = Date.now,
  lastPonderAt    = 0,
}) {
  if (typeof getInterests !== 'function') throw new Error('getInterests is required');
  if (typeof runPonder    !== 'function') throw new Error('runPonder is required');

  const interests = await getInterests();
  if (!Array.isArray(interests) || interests.length === 0) {
    return { acted: false, reason: 'no_interests', at: now() };
  }

  const topWeight = Math.max(0, ...interests.map(i => Number(i?.weight) || 0));
  const required  = computeInterval(topWeight);
  const since     = now() - lastPonderAt;
  if (since < required) {
    return { acted: false, reason: 'too_soon', sinceMs: since, requiredMs: required, topWeight, at: now() };
  }

  const picked = pickInterest(interests, { rng });
  if (!picked) {
    return { acted: false, reason: 'no_eligible_pick', at: now() };
  }

  const result = await runPonder(picked.label, picked);
  return { acted: true, picked, result, at: now(), topWeight, requiredMs: required };
}

// ── Singleton lifecycle ───────────────────────────────────────────

let _started     = false;
let _interval    = null;
let _activeTick  = null;
let _lastPonderAt = 0;

/**
 * Start the loop. Wraps runOneTick with a setInterval at `tickMs`
 * cadence (default 60 s). The actual ponder cadence is set by
 * `computeInterval(topWeight)` — the tick is just how often we
 * ask "is it time yet?"
 *
 * Required: getInterests, runPonder.
 * Optional callbacks: onTick(result), onError(err).
 *
 * Returns { stop: stopPonderingLoop } for ergonomic teardown.
 */
export function startPonderingLoop({
  tickMs   = DEFAULT_TICK_MS,
  onTick   = () => {},
  onError  = () => {},
  immediate = true,    // run one tick on start so demos don't wait a full tickMs
  ...tickConfig
}) {
  if (_started) throw new Error('pondering loop already running');
  _started      = true;
  _lastPonderAt = 0;

  const fire = async () => {
    if (_activeTick) return;
    _activeTick = (async () => {
      try {
        const r = await runOneTick({ ...tickConfig, lastPonderAt: _lastPonderAt });
        if (r.acted) _lastPonderAt = r.at;
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

  if (immediate) fire();

  return { stop: stopPonderingLoop };
}

/**
 * Stop the loop. Awaits any in-flight tick so the caller can be
 * sure no ponder is mid-flight when we return.
 */
export async function stopPonderingLoop() {
  if (!_started) return;
  if (_interval) { clearInterval(_interval); _interval = null; }
  const pending = _activeTick;
  _started      = false;
  _lastPonderAt = 0;
  if (pending) { try { await pending; } catch { /* surfaced through onError already */ } }
}

export function isRunning() { return _started; }
