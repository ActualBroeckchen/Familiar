/**
 * voice-call-guard.js — apply the guest watchdog to a live call (spec §8.2).
 * SAFETY-CRITICAL (privacy): decides when ward-private context is withheld from a
 * call. Ward-signed; behavioural changes need the ward, like the audience gate.
 *
 * The watchdog (`voice-guest-watchdog.js`) is the pure detector — it only says
 * "a second voice appeared / the ward is alone again." This wraps it with the
 * ward's print (so a segment's embedding becomes a similarity) and the ward's
 * standing `voiceGuestPolicy`, turning a detection into an effect the voice
 * server applies to the turn:
 *
 *   ignore → nothing.
 *   note   → a first-person line joins the next turn's context; nothing stripped.
 *   gate   → ward-private context is WITHHELD while a guest is present; the turn's
 *            audience resolves to its stranger-tier equivalent. Fail-closed.
 *
 * The embedding is computed upstream (the call engine, which owns the worker);
 * this module is pure over `(embedding, wardPrint)` so the policy logic and every
 * transition is unit-testable without audio. No print → the watchdog is inert
 * (a call with no enrolled ward can't tell voices apart — it never guesses).
 */

import { cosineSimilarity } from './voice-embedding.js';
import { createGuestWatchdog, GUEST_DEFAULTS } from './voice-guest-watchdog.js';

// The ward saying, in their own words, that they're alone again — an instant
// release the guest's voice can't fake (it only counts in a ward-matched
// segment; the watchdog enforces that). Kept small and literal on purpose.
const RELEASE_PHRASES = [
  /\bit'?s just me\b/i, /\bit'?s only me\b/i, /\bwe'?re alone\b/i,
  /\bjust us\b/i, /\bthey'?re gone\b/i, /\bthey left\b/i, /\bwe'?re good now\b/i,
];

export function detectReleasePhrase(text) {
  const t = String(text ?? '');
  return RELEASE_PHRASES.some(re => re.test(t));
}

/** The note line, first-person, server-injected (literal "my human"). */
export const GUEST_NOTE_LINE =
  "[I can hear a second voice in the room with my human — someone I haven't been introduced to. I stay myself; I'm just aware we may not be alone.]";

/**
 * @param {object} cfg
 * @param {number[]} cfg.wardPrint     the ward's enrolled embedding (null/[] → inert)
 * @param {string}   [cfg.policy]      'ignore' | 'note' | 'gate'
 * @param {object}   [cfg.thresholds]  { threshold, enterSegments, exitSegments, exitQuietSec }
 * @returns {{ observeWardSegment, forceRelease, withholdWardPrivate, noteLine, guestPresent, active, policy }}
 */
export function createCallGuard({ wardPrint, policy = 'note', thresholds = {}, now = Date.now } = {}) {
  const active = Array.isArray(wardPrint) && wardPrint.length > 0;
  const pol = ['ignore', 'note', 'gate'].includes(policy) ? policy : 'note';
  const wd = createGuestWatchdog({
    threshold:     thresholds.threshold     ?? GUEST_DEFAULTS.threshold,
    enterSegments: thresholds.enterSegments ?? GUEST_DEFAULTS.enterSegments,
    exitSegments:  thresholds.exitSegments  ?? GUEST_DEFAULTS.exitSegments,
    exitQuietSec:  thresholds.exitQuietSec  ?? GUEST_DEFAULTS.exitQuietSec,
    now,
  });
  let guestPresent = false;

  /**
   * Feed one finalized segment from the WARD's stream.
   * @param {number[]} embedding  the segment's voiceprint (from the worker)
   * @param {object} [o] { text, ts }
   * @returns {{ transition:null|'entered'|'released', reason?:string, guestPresent:boolean }}
   */
  function observeWardSegment(embedding, { text = '', ts } = {}) {
    if (!active || pol === 'ignore') return { transition: null, guestPresent };
    const similarity = cosineSimilarity(embedding, wardPrint);
    const r = wd.observe({ similarity, ts, releasePhrase: detectReleasePhrase(text) });
    if (r.transition === 'entered') guestPresent = true;
    else if (r.transition === 'released') guestPresent = false;
    return { transition: r.transition, reason: r.reason, guestPresent };
  }

  function forceRelease(reason = 'manual') {
    const r = wd.forceRelease(reason);
    if (r.transition === 'released') guestPresent = false;
    return r;
  }

  /** gate policy + a guest present → withhold ward-private context this turn. */
  function withholdWardPrivate() { return pol === 'gate' && guestPresent; }

  /** note policy + a guest present → the line to add to the turn's context. */
  function noteLine() { return (pol === 'note' && guestPresent) ? GUEST_NOTE_LINE : null; }

  return {
    observeWardSegment, forceRelease, withholdWardPrivate, noteLine,
    get guestPresent() { return guestPresent; },
    active, policy: pol,
  };
}
