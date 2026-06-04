/**
 * Pondering cadence — how often the Familiar should wake to think,
 * given the current top interest weight.
 *
 * Tiered, not continuous, so the cadence is predictable, debuggable,
 * and legible in the logs (instead of an opaque formula whose output
 * surprises everyone). Tune the tiers in one place if rebalancing.
 *
 * Cost shape: tokens spent scale with engagement. When the Familiar
 * isn't holding anything meaningful (no eligible interests), it
 * doesn't ponder at all. When something is genuinely on its mind
 * (high weight), it returns to it more often. That's the
 * preventative-care economics from the design doc.
 */

export const PONDER_INTERVAL_MS = Object.freeze({
  high:  30 * 60_000,   // weight >= 8: every 30 minutes
  mid:   60 * 60_000,   // weight >= 4: every 60 minutes
  low:  120 * 60_000,   // weight >= 2: every 2 hours
  idle: 360 * 60_000,   // weight  > 0: every 6 hours
});

export const PONDER_TIER_LABEL = Object.freeze({
  high: 'high',
  mid:  'mid',
  low:  'low',
  idle: 'idle',
  none: 'none',
});

/**
 * Threat-tier multipliers applied to the interest-tier base interval.
 * Higher threat → shorter interval (think about the user more often).
 * Calm doesn't change the base behaviour at all. Severe collapses
 * the interval ~7×, so a normally-30-minute ponder cycle becomes ~5
 * minutes — frequent but not constant.
 */
export const THREAT_CADENCE_MULTIPLIER = Object.freeze({
  calm:     1.00,
  mild:     0.80,
  moderate: 0.50,
  high:     0.30,
  severe:   0.15,
});

function threatMultiplier(threatLevel) {
  if (!Number.isFinite(threatLevel) || threatLevel <= 0)  return THREAT_CADENCE_MULTIPLIER.calm;
  if (threatLevel >= 7) return THREAT_CADENCE_MULTIPLIER.severe;
  if (threatLevel >= 4) return THREAT_CADENCE_MULTIPLIER.high;
  if (threatLevel >= 2) return THREAT_CADENCE_MULTIPLIER.moderate;
  if (threatLevel >= 0.5) return THREAT_CADENCE_MULTIPLIER.mild;
  return THREAT_CADENCE_MULTIPLIER.calm;
}

/**
 * Required interval (ms) between ponderings given the current top
 * interest weight, optional current threat level, and optional user
 * "stretch" scale (≥1.0).
 *
 * @param {number} topWeight   — highest live-interest weight
 * @param {number} threatLevel — current effective threat (default 0)
 * @param {object} options
 * @param {number} options.scale — user-set multiplier ≥1.0 (default 1.0).
 *                                 Values <1 are clamped to 1 — the UI
 *                                 only lets users SLOW the cadence,
 *                                 not speed it past the tier defaults.
 */
export function computeRequiredInterval(topWeight, threatLevel = 0, { scale = 1.0 } = {}) {
  if (!Number.isFinite(topWeight) || topWeight <= 0) return Infinity;
  let base;
  if (topWeight >= 8)      base = PONDER_INTERVAL_MS.high;
  else if (topWeight >= 4) base = PONDER_INTERVAL_MS.mid;
  else if (topWeight >= 2) base = PONDER_INTERVAL_MS.low;
  else                     base = PONDER_INTERVAL_MS.idle;
  const safeScale = Number.isFinite(scale) && scale >= 1 ? scale : 1;
  return Math.round(base * threatMultiplier(threatLevel) * safeScale);
}

/** Human-readable tier name for the given top weight. For logs / UI. */
export function tierForWeight(topWeight) {
  if (!Number.isFinite(topWeight) || topWeight <= 0) return PONDER_TIER_LABEL.none;
  if (topWeight >= 8) return PONDER_TIER_LABEL.high;
  if (topWeight >= 4) return PONDER_TIER_LABEL.mid;
  if (topWeight >= 2) return PONDER_TIER_LABEL.low;
  return PONDER_TIER_LABEL.idle;
}
