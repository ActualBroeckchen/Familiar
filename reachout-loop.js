/**
 * Warm reach-out loop — the Familiar's companionship heartbeat.
 *
 * The counterpart to silence-triage: triage breaks through in crisis;
 * this knocks gently when nothing is wrong, because a companion reaches
 * out for warm and frivolous reasons too. It can reach my human (a gentle
 * banner via the outbox) or a Village member tagged warm toward me (a DM
 * via relayToDiscord, always mirrored to my human — never covert).
 *
 * Shape mirrors silence-triage-loop.js: a pure, fully-injectable
 * runOneReachoutTick() carries the whole behavioural surface; a thin
 * singleton wrapper drives it on an interval.
 *
 * Hard gates, all in cheap code BEFORE any LLM call (CLAUDE.md "gate in
 * code"):
 *   - off-switch (env + settings toggle, checked by the wrapper's isEnabled)
 *   - crisis-defer: if threat is moderate or above, this loop stands down
 *     entirely and lets silence-triage own the moment. This does NOT
 *     reduce care — triage always acts at moderate+; it only keeps a
 *     frivolous "thinking of you" from landing on someone in distress.
 *   - quiet hours: no warm knocks during my human's configured night.
 *   - cooldown: warmth has its own slow rhythm; the LLM self-sets the
 *     next check via nextCheckInMs (clamped), default a couple of hours.
 *
 * Ward-recent-activity gates ONLY the ward-knock channel: if my human is
 * actively here (a message within WARD_ACTIVE_THRESHOLD_MS), a banner would
 * talk over our live chat, so it's suppressed and I say it in chat instead
 * (the live [Deferred intents] block already surfaces pending tells there). A
 * warm VILLAGER reach is never gated by this — they aren't in the conversation
 * — so the model still decides that freely from context.
 *
 * Wait-streak (initiative-build-spec Pass 1): a deliberated 'wait'
 * increments the streak; a reach_out decision (either target) resets it
 * at decision time. Gate-skipped ticks (crisis-defer, quiet hours,
 * cooldown) never touch it — I was never asked (invariant W1). Recording
 * is fire-and-forget and can never change an outcome (invariant W5).
 */

import { getWaitStreak, recordWait, recordProactive, isWaitStreakEnabled } from './wait-streak.js';
import { isCallActiveFromFile } from './call-engine.js';

const DEFAULT_TICK_MS = 10 * 60_000;     // 10 min — warmth doesn't need a fast pulse

// Cool-down between deliberations (the LLM may shorten/lengthen via
// nextCheckInMs). Floor keeps a 0/null/nonsense value from piling up
// requests; default is deliberately leisurely.
const MIN_RECHECK_MS     = 15 * 60_000;          // 15 min
const MAX_RECHECK_MS     = 24 * 60 * 60_000;     // 24 h
const DEFAULT_REACHOUT_RECHECK_MS = 2 * 60 * 60_000;   // 2 h

// Threat tiers at or above which the warm loop stands down for triage.
const CRISIS_TIERS = new Set(['moderate', 'high', 'severe']);

// Ward-only active-conversation gate. If my human sent something within this
// window they're right here with me, so a warm BANNER would talk over our live
// chat — and the live [Deferred intents] block already gives any pending tell
// its moment there. This suppresses the ward-knock channel ONLY; a warm
// villager reach is untouched (they aren't in this conversation), and this is
// warmth, not safety — triage owns distress on its own track regardless. When
// suppressed I re-check soon (once they go quiet) instead of burning the full
// cooldown, so the warm thought isn't lost, just deferred off the live chat.
const WARD_ACTIVE_THRESHOLD_MS = 10 * 60_000;    // 10 min

// Dedup bucket for ward knocks — at most one warm banner per window while
// the previous one is still unacknowledged (mirrors triage's bucket idea,
// wider because warmth is slower).
const RATE_LIMIT_BUCKET_MS = 2 * 60 * 60_000;

let _started           = false;
let _interval          = null;
let _activeTick        = null;
let _nextAllowedTickTs = 0;

function clampCooldown(ms) {
  if (!Number.isFinite(ms)) return null;
  return Math.max(MIN_RECHECK_MS, Math.min(MAX_RECHECK_MS, ms));
}

/**
 * Run one reach-out tick. Pure-ish — all I/O injected.
 *
 * Returns { acted, reason, decision?, ... }. acted:false reasons:
 *   'crisis_defer' | 'quiet_hours' | 'in_cooldown' | 'no_activity_record'
 *   | 'llm_said_wait' | 'delivery_failed' | 'rate_limited' | 'ward_active'
 *   | 'unknown_villager'
 */
export async function runOneReachoutTick({
  getThreat,             // async () => { weight, tier, disabled }
  getLastActivity,       // async () => { ts, ms } | null
  getPendingTells,       // async () => [{ uid, index, summary }]
  getWarmVillagers,      // async () => [{ id, name, discordId, ... }]
  isQuietHours,          // async () => boolean
  decideReachout,        // async ({ pendingTells, warmVillagers, wardSilenceMs }) => decision
  deliverWardKnock,      // async ({ message, tell, about, why }) => { ok, deduped? }
  deliverVillagerReach,  // async ({ villager, message }) => { ok, error? }
  now = Date.now,
  // Wait-streak recording (injectable for tests; defaults never throw).
  getWaitStreakFn   = () => (isWaitStreakEnabled() ? getWaitStreak() : null),
  recordWaitFn      = recordWait,
  recordProactiveFn = recordProactive,
}) {
  for (const [name, fn] of Object.entries({ getThreat, getLastActivity, decideReachout, deliverWardKnock, deliverVillagerReach })) {
    if (typeof fn !== 'function') throw new Error(`${name} is required`);
  }

  const nowMs = now();

  // Crisis-defer: when my human's threat is elevated, triage owns the
  // moment. The warm loop stays out of the way.
  const threat = await getThreat().catch(() => null);
  if (threat && !threat.disabled && CRISIS_TIERS.has(threat.tier)) {
    return { acted: false, reason: 'crisis_defer', threat, at: nowMs };
  }

  // Quiet hours: no warm knocks during the configured night.
  if (typeof isQuietHours === 'function') {
    let quiet = false;
    try { quiet = !!(await isQuietHours()); } catch { /* treat as not-quiet */ }
    if (quiet) return { acted: false, reason: 'quiet_hours', at: nowMs };
  }

  // Cool-down: warmth has a slow rhythm.
  if (nowMs < _nextAllowedTickTs) {
    return { acted: false, reason: 'in_cooldown', cooldownUntilTs: _nextAllowedTickTs, at: nowMs };
  }

  // null (not 0) when no activity was ever recorded: telling the LLM "they
  // were around just now" on a fresh install is a standing nudge to wait.
  const last = await getLastActivity().catch(() => null);
  const wardSilenceMs = last?.ms ? Math.max(0, nowMs - last.ms) : null;

  const [pendingTells, warmVillagers] = await Promise.all([
    (typeof getPendingTells === 'function' ? getPendingTells().catch(() => []) : Promise.resolve([])),
    (typeof getWarmVillagers === 'function' ? getWarmVillagers().catch(() => []) : Promise.resolve([])),
  ]);

  // Streak value at deliberation time — the same state the prompt line was
  // rendered from; recording happens only after the decision returns.
  let streakAtDecision = null;
  try { streakAtDecision = getWaitStreakFn()?.count ?? null; } catch { /* never gates warmth */ }

  const decision = await decideReachout({ pendingTells, warmVillagers, wardSilenceMs });

  // Set the cool-down regardless of outcome — the LLM has spoken.
  const cooldownMs = clampCooldown(decision?.nextCheckInMs) ?? DEFAULT_REACHOUT_RECHECK_MS;
  _nextAllowedTickTs = nowMs + cooldownMs;

  if (!decision || decision.action !== 'reach_out' || !decision.message) {
    // Offered the choice, chose to wait — increment (fire-and-forget).
    Promise.resolve(recordWaitFn('warmth')).catch(() => {});
    return { acted: false, reason: 'llm_said_wait', decision, streakAtDecision, nextCheckInMs: cooldownMs, at: nowMs };
  }

  // A reach_out decision (either target) resets the streak at decision
  // time — delivery state is the outbox's concern, not the streak's.
  Promise.resolve(recordProactiveFn('warmth')).catch(() => {});

  if (decision.target === 'villager') {
    const villager = warmVillagers.find(v => v.id === decision.villagerId);
    if (!villager) {
      // The LLM named someone not on the warm list — refuse, don't guess.
      return { acted: false, reason: 'unknown_villager', decision, streakAtDecision, nextCheckInMs: cooldownMs, at: nowMs };
    }
    const res = await deliverVillagerReach({ villager, message: decision.message }).catch(err => ({ ok: false, error: err?.message }));
    return {
      acted:  !!res?.ok,
      reason: res?.ok ? 'reached_villager' : 'delivery_failed',
      decision, target: 'villager', villager: { id: villager.id, name: villager.name },
      error:  res?.ok ? undefined : (res?.error ?? 'unknown'),
      streakAtDecision,
      nextCheckInMs: cooldownMs, at: nowMs,
    };
  }

  // Ward-only active-conversation gate (Bug 3): don't banner my human while
  // they're actively here — I say it in our live chat instead. A pending tell
  // still surfaces to me there via the [Deferred intents] block, so nothing is
  // lost; I just re-check soon rather than talking over the conversation.
  if (Number.isFinite(wardSilenceMs) && wardSilenceMs < WARD_ACTIVE_THRESHOLD_MS) {
    _nextAllowedTickTs = nowMs + MIN_RECHECK_MS;
    return { acted: false, reason: 'ward_active', decision, streakAtDecision, nextCheckInMs: MIN_RECHECK_MS, at: nowMs };
  }

  // Ward knock.
  const tell = (decision.tellUid && Number.isInteger(decision.tellIndex))
    ? { uid: decision.tellUid, index: decision.tellIndex }
    : null;
  const res = await deliverWardKnock({ message: decision.message, tell, about: decision.about, why: decision.why }).catch(err => ({ ok: false, error: err?.message }));
  return {
    acted:  !!res?.ok && !res?.deduped,
    reason: !res?.ok ? 'delivery_failed' : (res?.deduped ? 'rate_limited' : 'reached_ward'),
    decision, target: 'ward',
    streakAtDecision,
    nextCheckInMs: cooldownMs, at: nowMs,
  };
}

/** Reset the cool-down so the next tick deliberates unconditionally. */
export function resetReachoutCooldown() { _nextAllowedTickTs = 0; }

// ── Singleton lifecycle ──────────────────────────────────────────

export function startReachoutLoop({
  tickMs    = DEFAULT_TICK_MS,
  onTick    = () => {},
  onError   = () => {},
  isEnabled = async () => true,
  ...tickConfig
}) {
  if (_started) throw new Error('reach-out loop already running');
  _started = true;

  const fire = async () => {
    if (_activeTick) return;
    _activeTick = (async () => {
      try {
        // Governor (§4.3): a warm reach-out is redundant during a live call — the
        // ward is maximally present, which is exactly the state warmth exists to
        // break. Defer; the call also feeds the ward-active gate.
        if (await isCallActiveFromFile()) return;
        if (!(await isEnabled())) { onTick({ acted: false, reason: 'disabled' }); return; }
        const r = await runOneReachoutTick(tickConfig);
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
  // No immediate fire — warmth waits one tick after boot.
  return { stop: stopReachoutLoop };
}

export async function stopReachoutLoop() {
  if (!_started) return;
  if (_interval) { clearInterval(_interval); _interval = null; }
  const pending = _activeTick;
  _started           = false;
  _nextAllowedTickTs = 0;
  if (pending) { try { await pending; } catch { /* surfaced via onError */ } }
}

export function isRunning() { return _started; }

// Exported for the ward-knock delivery dedup bucket (used by server.js wiring).
export function reachoutBucketOriginId(now = Date.now) {
  return `reachout-${Math.floor(now() / RATE_LIMIT_BUCKET_MS)}`;
}
