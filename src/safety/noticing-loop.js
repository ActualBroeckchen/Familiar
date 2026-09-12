/**
 * Noticing loop — the heartbeat that gives the Familiar its own turn.
 *
 * The counterpart to silence-triage and warm reach-out, but pointed inward:
 * on each tick, code checks whether anything is worth noticing (a due
 * intention, a rhythm deviation, a readiness gap, an aging commitment) and
 * ONLY THEN does the Familiar get a deliberation. No wake condition → no
 * turn (the OpenClaw anti-pattern avoided: code decides when there's
 * something to look at, not a fixed hourly checklist).
 *
 * Shape mirrors reachout-loop.js: a pure, fully-injectable runOneNoticingTick
 * (in noticing.js) carries the behaviour; this thin singleton drives it on an
 * interval with a self-set cadence.
 *
 * Unlike the caring loops, this one does NOT stand down at elevated threat —
 * that's the ward-signed decision (noticing matters most in distress). The
 * cadence gate here is the only pacing; the wake-condition gate inside the
 * tick is what keeps it from firing needlessly.
 *
 * Off-switch: settings `noticingEnabled` (default ON) or
 * PROTO_FAMILIAR_NOTICING_DISABLED=1 (checked by the wrapper's isEnabled in
 * server.js).
 */

import { runOneNoticingTick, DEFAULT_NOTICING_TICK_MS } from './noticing.js';

let _started           = false;
let _interval          = null;
let _activeTick        = null;
let _nextAllowedTickTs = 0;

export function startNoticingLoop({
  tickMs    = DEFAULT_NOTICING_TICK_MS,
  onTick    = () => {},
  onError   = () => {},
  isEnabled = async () => true,
  now       = Date.now,
  ...tickConfig
}) {
  if (_started) throw new Error('noticing loop already running');
  _started = true;

  const fire = async () => {
    if (_activeTick) return;
    _activeTick = (async () => {
      try {
        if (!(await isEnabled())) { onTick({ acted: false, reason: 'disabled' }); return; }
        // Cadence gate: don't deliberate again until the self-set (or default)
        // cool-down has elapsed. The wake-condition gate inside the tick is
        // separate — this only paces how often we even look.
        const nowMs = now();
        if (nowMs < _nextAllowedTickTs) {
          onTick({ acted: false, reason: 'in_cooldown', cooldownUntilTs: _nextAllowedTickTs });
          return;
        }
        const r = await runOneNoticingTick({ now, ...tickConfig });
        // Set the cool-down from the tick's chosen cadence. A quiet window
        // (no wake condition) uses the base tick interval — cheap to re-check
        // soon since it costs no LLM call.
        if (r.reason === 'quiet_window') {
          _nextAllowedTickTs = nowMs + tickMs;
        } else if (Number.isFinite(r.nextCheckInMs)) {
          _nextAllowedTickTs = nowMs + r.nextCheckInMs;
        }
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
  // No immediate fire — one tick after boot, like the other loops.
  return { stop: stopNoticingLoop };
}

/** Reset the cadence gate so the next tick deliberates unconditionally. */
export function resetNoticingCooldown() { _nextAllowedTickTs = 0; }

export async function stopNoticingLoop() {
  if (!_started) return;
  if (_interval) { clearInterval(_interval); _interval = null; }
  const pending = _activeTick;
  _started           = false;
  _nextAllowedTickTs = 0;
  if (pending) { try { await pending; } catch { /* surfaced via onError */ } }
}

export function isRunning() { return _started; }
