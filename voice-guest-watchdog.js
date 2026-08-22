/**
 * voice-guest-watchdog.js — "is there someone other than my human in the room?"
 * (voice spec §8.2). SAFETY-CRITICAL: this decides when ward-private context is
 * withheld from a live call, so its thresholds and its fail direction are
 * ward-signed. Behavioural changes here need the ward, same as the audience gate.
 *
 * The shape, deliberately asymmetric (a Familiar asked "what's M?"):
 *
 *   ENTER  — fast, on negative evidence. N consecutive segments on the ward's
 *            own stream that DON'T match the ward's print → a guest is present.
 *            (N not 1: TVs, sneezes, a cough exist. `voiceGuestEnterSegments`=3.)
 *
 *   RELEASE — slow, needs positive evidence AND time. Ward-matched segments
 *            alone can't prove the guest left — they only prove the ward is the
 *            one talking now, and a quiet guest emits no segments. So release
 *            needs BOTH: M consecutive ward-matched segments
 *            (`voiceGuestExitSegments`=6) AND ≥ quietSec since the last
 *            non-ward segment (`voiceGuestExitQuietSec`=90). A passer-through
 *            costs ~90 s of gated context, not five; a TV keeps emitting
 *            non-ward segments and correctly holds the gate.
 *
 * Two instant releases besides the timer: the ward SAYING so in a segment that
 * itself matches their print (a release the guest's voice cannot fake), and the
 * UI/manual control. Every transition is returned so the caller can log it —
 * "why did my Familiar suddenly go formal" must always be answerable.
 *
 * This module only DETECTS presence and emits transitions. What a transition
 * DOES (nothing / a note in context / stripping ward-private blocks) is the
 * ward's `voiceGuestPolicy`, applied by the caller — never decided here.
 *
 * Pure but stateful: a factory over closure state, `now` injected, no I/O, no
 * model — so every threshold and edge is unit-testable without audio.
 */

export const GUEST_DEFAULTS = Object.freeze({
  threshold: 0.5,       // cosine below this = "not the ward" (Pass-0 calibrated; ward-tunable)
  enterSegments: 3,     // consecutive non-ward segments to raise a guest
  exitSegments: 6,      // consecutive ward-matched segments needed to release
  exitQuietSec: 90,     // AND this long since the last non-ward segment
});

/**
 * @param {object} cfg  overrides for GUEST_DEFAULTS, plus `now` (injectable clock)
 * @returns {{ observe, forceRelease, snapshot }}
 */
export function createGuestWatchdog(cfg = {}) {
  const threshold     = numOr(cfg.threshold, GUEST_DEFAULTS.threshold);
  const enterSegments = Math.max(1, Math.trunc(numOr(cfg.enterSegments, GUEST_DEFAULTS.enterSegments)));
  const exitSegments  = Math.max(1, Math.trunc(numOr(cfg.exitSegments, GUEST_DEFAULTS.exitSegments)));
  const exitQuietMs   = Math.max(0, numOr(cfg.exitQuietSec, GUEST_DEFAULTS.exitQuietSec) * 1000);
  const now = typeof cfg.now === 'function' ? cfg.now : Date.now;

  let state = 'clear';          // 'clear' | 'guest'
  let nonWardRun = 0;           // consecutive non-ward segments (entry counter)
  let wardRun = 0;              // consecutive ward-matched segments (release counter)
  let lastNonWardTs = null;     // when we last heard a non-ward voice
  let enteredAt = null;

  /**
   * Feed one finalized ward-stream segment.
   * @param {object} seg
   * @param {number} seg.similarity     cosine of this segment vs the ward's print
   * @param {number} [seg.ts]           segment time (defaults to now())
   * @param {boolean} [seg.releasePhrase] transcript asked to release (e.g. "it's just me again")
   * @returns {{ state:'clear'|'guest', transition:null|'entered'|'released', reason?:string }}
   */
  function observe(seg = {}) {
    const ts = Number.isFinite(seg.ts) ? seg.ts : now();
    const isWard = numOr(seg.similarity, -1) >= threshold;

    if (isWard) {
      wardRun += 1;
      nonWardRun = 0;
    } else {
      nonWardRun += 1;
      wardRun = 0;
      lastNonWardTs = ts;
    }

    if (state === 'clear') {
      if (!isWard && nonWardRun >= enterSegments) {
        state = 'guest'; enteredAt = ts; wardRun = 0;
        return { state, transition: 'entered', reason: `${nonWardRun} non-ward segments` };
      }
      return { state, transition: null };
    }

    // state === 'guest'
    // Instant, un-fakeable release: the ward themselves saying so.
    if (isWard && seg.releasePhrase) {
      return finishRelease('spoken');
    }
    const quietEnough = lastNonWardTs == null || (ts - lastNonWardTs) >= exitQuietMs;
    if (isWard && wardRun >= exitSegments && quietEnough) {
      return finishRelease('quiet+matched');
    }
    return { state, transition: null };
  }

  /** UI / manual release, or any caller-driven force-clear. */
  function forceRelease(reason = 'manual') {
    if (state !== 'guest') return { state, transition: null };
    return finishRelease(reason);
  }

  function finishRelease(reason) {
    state = 'clear'; nonWardRun = 0; wardRun = 0; lastNonWardTs = null; enteredAt = null;
    return { state, transition: 'released', reason };
  }

  function snapshot() {
    return { state, nonWardRun, wardRun, lastNonWardTs, enteredAt, threshold, enterSegments, exitSegments, exitQuietMs };
  }

  return { observe, forceRelease, snapshot };
}

function numOr(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
