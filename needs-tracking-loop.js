/**
 * Needs-tracking loop (Pass 2) — the singleton driver.
 *
 * When a recurring NEED-WINDOW's [when, end] has fully elapsed for the day
 * and the ward never resolved it, this marks that day's occurrence
 * `missed` — turning a vague "did they eat?" into a concrete entry in the
 * needs-fulfilment ledger (the need's per-occurrence resolution history).
 *
 * **Default OFF.** It writes to the schedule autonomously, so it stays
 * dormant until the ward enables "Track unmet needs" in Settings. Hard
 * off-switch: PROTO_FAMILIAR_NEEDS_TRACKING_DISABLED=1. Mirrors the
 * tome-graduation loop shape.
 *
 * **Stands down at moderate+ threat** — it never competes with triage.
 * Marking misses is a wellbeing-bookkeeping job; when the ward is in
 * distress, triage owns the moment and this holds off (the same posture
 * as the warm reach-out loop).
 *
 * It only ever makes the LAPSE factual. It does NOT touch projected
 * consequence edges — see needs-tracking.js.
 */

import { listRecurring, resolveScheduleOccurrence } from './thalamus.js';
import { getThreat } from './threat-tracker.js';
import { readSettingsSync } from './cerebellum.js';
import { selectMissedOccurrences, isNeedWindow } from './needs-tracking.js';

const DEFAULT_TICK_MS = 30 * 60_000;   // 30 min — bookkeeping wants no urgency
const STAND_DOWN_TIERS = new Set(['moderate', 'high', 'severe']);

let _started  = false;
let _interval = null;
let _active   = null;

export function needsTrackingHardDisabled() {
  return process.env.PROTO_FAMILIAR_NEEDS_TRACKING_DISABLED === '1';
}

function isEnabled() {
  if (needsTrackingHardDisabled()) return false;
  return readSettingsSync().needsTrackingEnabled === true;   // opt-in
}

/**
 * One tick: gather need-windows, stand down if the ward is in distress,
 * else mark any fully-elapsed unresolved occurrences `missed`. Pure
 * selection lives in needs-tracking.js; this does the I/O. Exported for
 * tests with injectable deps.
 */
export async function runNeedsTick({
  now = Date.now(),
  list = listRecurring,
  resolveOccurrence = resolveScheduleOccurrence,
  threat = getThreat,
  enabled,                       // test seam; defaults to the Settings/env gate
} = {}) {
  if (!(enabled ?? isEnabled())) return { reason: 'disabled' };

  // Crisis-defer: triage owns the moment at moderate+.
  const t = await threat().catch(() => null);
  if (t && STAND_DOWN_TIERS.has(t.tier)) return { reason: 'stood-down', tier: t.tier };

  let recurring;
  try {
    const r = await list();
    recurring = Array.isArray(r?.nodes) ? r.nodes : [];
  } catch { return { reason: 'unruh-unavailable' }; }

  const needs = recurring.filter(isNeedWindow);
  if (!needs.length) return { reason: 'no-needs', marked: 0 };

  const missed = selectMissedOccurrences(needs, now);
  let marked = 0;
  for (const m of missed) {
    try {
      const res = await resolveOccurrence({ id: m.id, occurrence_date: m.date, resolution: 'missed' });
      if (res?.ok !== false) marked += 1;
    } catch { /* one failure never blocks the rest */ }
  }
  if (marked) console.log(`[needs] marked ${marked} unmet need-window(s) missed`);
  return { reason: 'ran', considered: needs.length, marked };
}

export function startNeedsTrackingLoop({ tickMs = DEFAULT_TICK_MS } = {}) {
  if (_started) return { stop: stopNeedsTrackingLoop };
  if (needsTrackingHardDisabled()) {
    console.log('[needs] needs-tracking hard-disabled via PROTO_FAMILIAR_NEEDS_TRACKING_DISABLED=1');
    return { stop: () => {} };
  }
  _started = true;
  console.log('[needs] needs-tracking loop armed (opt-in; idles until "Track unmet needs" is enabled in Settings)');
  _interval = setInterval(() => {
    if (_active) return;                 // never overlap ticks
    _active = runNeedsTick()
      .catch(err => console.warn('[needs] tick error:', err?.message ?? err))
      .finally(() => { _active = null; });
  }, tickMs);
  _interval.unref?.();
  return { stop: stopNeedsTrackingLoop };
}

export async function stopNeedsTrackingLoop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  if (_active) { try { await _active; } catch { /* already logged */ } }
  _started = false;
}
