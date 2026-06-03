/**
 * Silence triage (M12b) — proactive check-in when threat is elevated
 * AND the user has been quiet long enough.
 *
 * This is the part the design doc calls "the actual triage *decision*
 * is an LLM call with full context, not a threshold check." We
 * compute the threshold (was the user quiet long enough?) but the
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
 *     enqueue an outbox item; the user sees a banner next time
 *     they're at the screen.
 *
 * Rate-limiting:
 *   - Outbox originId = `triage-<tier>-<4h-bucket>`. The outbox
 *     dedupes UNACKNOWLEDGED items, so the user can't get a second
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

// Required silence (ms) before triage even CONSIDERS firing, by tier.
// Calm/mild explicitly never trigger — mild distress alone shouldn't
// prompt active outreach, just the framing already in [CARE CHECK].
export const TRIAGE_SILENCE_THRESHOLD_MS = Object.freeze({
  calm:     Infinity,
  mild:     Infinity,
  moderate: 4 * 60 * 60_000,    // 4 hours
  high:         60 * 60_000,    // 1 hour
  severe:   15 * 60_000,        // 15 min
});

let _started     = false;
let _interval    = null;
let _activeTick  = null;

const RATE_LIMIT_BUCKET_MS = 4 * 60 * 60_000;

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

  const required = thresholds[threat.tier];
  if (!Number.isFinite(required)) {
    return { acted: false, reason: 'low_threat', threat, at: now() };
  }

  const last = await getLastActivity();
  if (!last)               return { acted: false, reason: 'no_activity_record', threat, at: now() };
  const silenceMs = now() - last.ms;
  if (silenceMs < required) {
    return { acted: false, reason: 'too_recent_activity', silenceMs, requiredMs: required, threat, at: now() };
  }

  const signals = typeof getRecentSignals === 'function' ? (await getRecentSignals()) : [];

  const decision = await decideTriage({ threat, silenceMs, signals });
  if (!decision || decision.action !== 'reach_out' || !decision.message) {
    return { acted: false, reason: 'llm_said_wait', threat, silenceMs, decision, at: now() };
  }

  // Dedup bucket: tier + a 4-hour bucket, so the user can't see two
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
    // passes without the user having acknowledged.
    ...(decision.meta && typeof decision.meta === 'object' ? { meta: decision.meta } : {}),
  });

  return {
    acted:     !enq?.deduped,
    reason:    enq?.deduped ? 'rate_limited' : 'reached_out',
    decision,
    outbox:    enq,
    threat,
    silenceMs,
    at:        now(),
  };
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
  _started = false;
  if (pending) { try { await pending; } catch {} }
}
