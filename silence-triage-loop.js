/**
 * Silence triage (M12b) — proactive check-in when threat is elevated
 * AND my human has been quiet long enough.
 *
 * This is the part the design doc calls "the actual triage *decision*
 * is an LLM call with full context, not a threshold check." We
 * compute the threshold (was my human quiet long enough?) but the
 * yes/no on whether to reach out is the model's call, given context.
 * The model is asked to be honest: "no, just wait" is a valid answer.
 *
 * Cadence:
 *   - Tick every 5 minutes.
 *   - At each tick, look at current threat tier + silence duration.
 *   - Required silence by tier (calm → never, mild → never, ...).
 *   - If thresholds aren't met → skip silently.
 *   - If they ARE met → call LLM with a minimal "should I reach out?"
 *     prompt + recent threat signals. Parse the decision. On 'yes',
 *     enqueue an outbox item; my human sees a banner next time
 *     they're at the screen.
 *
 * Rate-limiting:
 *   - Outbox originId = `triage-<tier>-<4h-bucket>`. The outbox
 *     dedupes UNACKNOWLEDGED items, so my human can't get a second
 *     triage banner of the same tier within 4 hours while the
 *     first one is still visible. Dismissing releases the dedupe —
 *     if silence continues, a fresh triage can land in the next
 *     4-hour window.
 *
 * Honesty:
 *   - The check-in message is whatever the model writes; we don't
 *     template "are you okay?" or similar therapist-speak. Bad
 *     LLM output is preferable to fake care.
 *   - If the LLM returns 'wait', we wait. We never override its no.
 */

const DEFAULT_TICK_MS = 5 * 60_000;          // 5 min

// Tier gate: which threat tiers are even worth deliberating about.
// Infinity = skip without spending an LLM call (no concerning signals
// yet). For moderate/high/severe we ALWAYS hand the decision to the
// LLM with full context (silence duration, recent messages, signals)
// — no hardcoded silence threshold gate, because the LLM is the one
// with the judgement, and "my human was active 10 minutes ago at
// severe threat" deserves the LLM's call, not a heuristic block.
export const TRIAGE_SILENCE_THRESHOLD_MS = Object.freeze({
  calm:     Infinity,
  mild:     Infinity,
  moderate: 0,
  high:     0,
  severe:   0,
});

// Cool-down between LLM deliberations. The LLM may return a
// nextCheckInMs telling us when it wants to be re-pinged; we clamp
// that to [MIN, MAX] and fall back to per-tier defaults if the LLM
// doesn't specify. Floor protects against request-pile-up if the
// LLM hands back 0 / null / nonsense.
const MIN_RECHECK_MS = 30 * 1000;            // 30s — per the spec
const MAX_RECHECK_MS = 24 * 60 * 60_000;     // 24h — never forget forever
export const DEFAULT_RECHECK_MS = Object.freeze({
  severe:   15 * 60_000,
  high:     30 * 60_000,
  moderate: 60 * 60_000,
});

let _started           = false;
let _interval          = null;
let _activeTick        = null;
let _nextAllowedTickTs = 0;     // ms; gate for the next LLM deliberation
let _lastDecisionTier  = null;  // remember the tier the cooldown was set under,
                                // so a tier rise can preempt the wait

const RATE_LIMIT_BUCKET_MS = 4 * 60 * 60_000;

function clampCooldown(ms) {
  if (!Number.isFinite(ms)) return null;
  return Math.max(MIN_RECHECK_MS, Math.min(MAX_RECHECK_MS, ms));
}
const TIER_RANK = { calm: 0, mild: 1, moderate: 2, high: 3, severe: 4 };

/**
 * Run one triage tick. Pure-ish (all I/O injected) so tests can
 * exercise every decision branch deterministically.
 *
 * Returns { acted, reason, decision?, outbox?, threat?, silenceMs?, ... }.
 */
export async function runOneTriageTick({
  getThreat,                // async () => { weight, tier }
  getLastActivity,          // async () => { ts, ms } | null
  getRecentSignals,         // async () => array of {ts, signals[], delta} (optional, for the prompt)
  decideTriage,             // async ({ threat, silenceMs, signals }) => { action: 'reach_out' | 'wait', message?: string }
  enqueueOutboxFn,          // async ({ kind, originId, title, body }) => { id, deduped }
  thresholds = TRIAGE_SILENCE_THRESHOLD_MS,
  now        = Date.now,
}) {
  if (typeof getThreat       !== 'function') throw new Error('getThreat is required');
  if (typeof getLastActivity !== 'function') throw new Error('getLastActivity is required');
  if (typeof decideTriage    !== 'function') throw new Error('decideTriage is required');
  if (typeof enqueueOutboxFn !== 'function') throw new Error('enqueueOutboxFn is required');

  const threat = await getThreat();
  if (!threat || !threat.tier) return { acted: false, reason: 'no_threat_state', at: now() };
  if (threat.disabled)         return { acted: false, reason: 'detector_disabled', at: now() };

  // Tier gate: calm/mild → don't spend a token. moderate+ → consult
  // the LLM with full context (silence, signals, recent messages).
  const required = thresholds[threat.tier];
  if (required === Infinity) {
    return { acted: false, reason: 'low_threat', threat, at: now() };
  }

  // Cool-down gate: don't re-ping the LLM until the time it told us
  // (or the per-tier default) has elapsed. A tier RISE preempts the
  // wait — moving from moderate to severe deserves an immediate
  // re-deliberation, not "you said wait 60 min so we wait 60 min."
  const nowMs = now();
  const tierRose = _lastDecisionTier && TIER_RANK[threat.tier] > (TIER_RANK[_lastDecisionTier] ?? -1);
  if (nowMs < _nextAllowedTickTs && !tierRose) {
    return {
      acted:               false,
      reason:              'in_cooldown',
      cooldownUntilTs:     _nextAllowedTickTs,
      cooldownRemainingMs: _nextAllowedTickTs - nowMs,
      threat,
      at:                  nowMs,
    };
  }

  const last = await getLastActivity();
  if (!last) return { acted: false, reason: 'no_activity_record', threat, at: nowMs };
  const silenceMs = nowMs - last.ms;

  const signals = typeof getRecentSignals === 'function' ? (await getRecentSignals()) : [];

  const decision = await decideTriage({ threat, silenceMs, signals });

  // Set the cool-down regardless of action — wait OR reach_out both
  // mean "the LLM has spoken; don't ask again until it asked us to."
  // Floor at MIN_RECHECK_MS so a missing / zero / negative
  // nextCheckInMs can't cause request pile-up.
  const llmNextMs   = clampCooldown(decision?.nextCheckInMs);
  const fallbackMs  = DEFAULT_RECHECK_MS[threat.tier] ?? 60 * 60_000;
  const cooldownMs  = llmNextMs ?? fallbackMs;
  _nextAllowedTickTs = nowMs + cooldownMs;
  _lastDecisionTier  = threat.tier;

  if (!decision || decision.action !== 'reach_out' || !decision.message) {
    return {
      acted:        false,
      reason:       'llm_said_wait',
      threat,
      silenceMs,
      decision,
      nextCheckInMs: cooldownMs,
      at:           nowMs,
    };
  }

  // Dedup bucket: tier + a 4-hour bucket, so my human can't see two
  // triage banners of the same tier in the same window unless they
  // dismissed the first one.
  const bucket   = Math.floor(now() / RATE_LIMIT_BUCKET_MS);
  const originId = `triage-${threat.tier}-${bucket}`;

  const enq = await enqueueOutboxFn({
    kind:     'triage',
    originId,
    title:    'a thought from me',
    body:     decision.message,
    ts:       new Date(now()).toISOString(),
    // decision.meta carries pendingContact + contactDeadlineTs when the
    // LLM also requested a trusted-contact escalation. Stored on the item
    // so the triage loop can fire the deferred delivery once the deadline
    // passes without my human having acknowledged.
    ...(decision.meta && typeof decision.meta === 'object' ? { meta: decision.meta } : {}),
  });

  return {
    acted:        !enq?.deduped,
    reason:       enq?.deduped ? 'rate_limited' : 'reached_out',
    decision,
    outbox:       enq,
    threat,
    silenceMs,
    nextCheckInMs: cooldownMs,
    at:           nowMs,
  };
}

/**
 * Reset the deliberation cool-down so the next tick will call the LLM
 * unconditionally. Exposed for the case where my human manually resets
 * the threat or the operator wants to force an immediate re-evaluation.
 */
export function resetTriageCooldown() {
  _nextAllowedTickTs = 0;
  _lastDecisionTier  = null;
}

// ── Singleton lifecycle ──────────────────────────────────────────

export function startSilenceTriageLoop({
  tickMs    = DEFAULT_TICK_MS,
  onTick    = () => {},
  onError   = () => {},
  isEnabled = async () => true,
  ...tickConfig
}) {
  if (_started) throw new Error('silence-triage loop already running');
  _started = true;

  const fire = async () => {
    if (_activeTick) return;
    _activeTick = (async () => {
      try {
        if (!(await isEnabled())) { onTick({ skipped: true, reason: 'disabled' }); return; }
        const r = await runOneTriageTick(tickConfig);
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
  // No immediate fire on start — wait one tick. Boot is loud enough.
  return { stop: stopSilenceTriageLoop };
}

export async function stopSilenceTriageLoop() {
  if (!_started) return;
  if (_interval) { clearInterval(_interval); _interval = null; }
  const pending = _activeTick;
  _started           = false;
  _nextAllowedTickTs = 0;
  _lastDecisionTier  = null;
  if (pending) { try { await pending; } catch {} }
}
