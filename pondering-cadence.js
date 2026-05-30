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
 * Required interval (ms) between ponderings given the current top
 * interest weight. Returns Infinity when there's nothing eligible
 * to ponder about — the loop interprets that as "stay quiet."
 */
export function computeRequiredInterval(topWeight) {
  if (!Number.isFinite(topWeight) || topWeight <= 0) return Infinity;
  if (topWeight >= 8) return PONDER_INTERVAL_MS.high;
  if (topWeight >= 4) return PONDER_INTERVAL_MS.mid;
  if (topWeight >= 2) return PONDER_INTERVAL_MS.low;
  return PONDER_INTERVAL_MS.idle;
}

/** Human-readable tier name for the given top weight. For logs / UI. */
export function tierForWeight(topWeight) {
  if (!Number.isFinite(topWeight) || topWeight <= 0) return PONDER_TIER_LABEL.none;
  if (topWeight >= 8) return PONDER_TIER_LABEL.high;
  if (topWeight >= 4) return PONDER_TIER_LABEL.mid;
  if (topWeight >= 2) return PONDER_TIER_LABEL.low;
  return PONDER_TIER_LABEL.idle;
}
