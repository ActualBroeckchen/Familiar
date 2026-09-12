// needs-tracking.js — pure logic for Pass 2 (needs-tracking).
//
// A "need" is a recurring window-task (payload.need === true) with a
// [when, end] window — dinner ~18–20, evening meds, wind-down for sleep.
// Each day its window is either MET (the ward resolved it) or, once the
// window has fully elapsed unresolved, MISSED. This module decides which
// occurrences are missed; the loop (needs-tracking-loop.js) does the I/O
// of marking them and the gating (opt-in, threat stand-down, off-switch).
//
// IMPORTANT (per the design sign-off): marking an occurrence "missed"
// makes only the LAPSE factual. It deliberately does NOT touch any
// projected on_lapse consequence edges — whether the predicted cost
// actually followed stays the Familiar's observation, confirmed or
// corrected through the reflection calibration loop (which only marks a
// consequence observed once genuinely seen). Nothing here auto-confirms a
// consequence.

import { expandOccurrences, localDateKey } from './recurrence.js';

const DAY_MS = 24 * 3600 * 1000;

/**
 * Is this schedule node a need-window? A recurring task carrying the
 * need marker and a real [when, end] window.
 */
export function isNeedWindow(node) {
  return !!(
    node &&
    node.payload?.need === true &&
    node.when && node.end &&
    node.payload?.recurrence && typeof node.payload.recurrence === 'object'
  );
}

/**
 * Across the given need nodes, return the occurrences whose window has
 * FULLY elapsed by `now` and are still unresolved — i.e. missed.
 *
 * `lookbackDays` bounds how far back we'll retro-mark (default 2) so a
 * loop that was off for a while doesn't suddenly mark a month of misses;
 * expandOccurrences already excludes any date already in payload.resolutions,
 * so a re-run never double-marks (natural dedup).
 *
 * Returns [{ id, date: 'YYYY-MM-DD', label }].
 */
/**
 * Today's status for each need-window — the live fulfilment view the
 * Familiar reads in [Temporal Context]. Derived fresh every turn, so a
 * missed window shows as "missed" whether or not the (opt-in) loop has
 * persisted it to the ledger yet.
 *
 * status ∈ 'met' | 'missed' | 'open' (window active now) | 'upcoming'
 *         | <other resolution> (cancelled / carried_forward).
 * Needs not scheduled today (e.g. a weekly need on the wrong weekday) are
 * omitted. Returns [{ label, status, startMs, endMs }].
 */
export function summarizeNeedsForDay(needNodes, now) {
  const todayKey = localDateKey(now);
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const dayEnd   = new Date(now); dayEnd.setHours(23, 59, 59, 999);
  const out = [];
  for (const node of needNodes || []) {
    if (!isNeedWindow(node)) continue;
    // Expand a resolutions-stripped clone so a day that's already resolved
    // (done/missed) still registers as an occurrence — we want its status,
    // and expandOccurrences otherwise drops resolved dates.
    const clone = { ...node, payload: { ...node.payload, resolutions: {} } };
    const todays = expandOccurrences(clone, dayStart.getTime(), dayEnd.getTime());
    if (!todays.length) continue;                       // not scheduled today
    const startMs = todays[0];
    const endMs = startMs + (new Date(node.end).getTime() - new Date(node.when).getTime());
    const res = node.payload?.resolutions?.[todayKey];
    let status;
    if (res === 'done')        status = 'met';
    else if (res === 'missed') status = 'missed';
    else if (res)              status = res;             // cancelled / carried_forward
    else if (now > endMs)      status = 'missed';        // live-derived: window passed unmet
    else if (now >= startMs)   status = 'open';          // window active right now
    else                       status = 'upcoming';
    out.push({ label: node.label, status, startMs, endMs });
  }
  return out;
}

export function selectMissedOccurrences(needNodes, now, { lookbackDays = 2 } = {}) {
  const out = [];
  const fromMs = now - lookbackDays * DAY_MS;
  for (const node of needNodes || []) {
    if (!isNeedWindow(node)) continue;
    const startAnchor = new Date(node.when).getTime();
    const duration = new Date(node.end).getTime() - startAnchor;
    if (!(duration > 0)) continue;                       // no real window → can't define "missed"
    // Unresolved occurrence-starts in the lookback window.
    const starts = expandOccurrences(node, fromMs, now);
    for (const startMs of starts) {
      if (startMs + duration < now) {                    // window fully closed, still unresolved
        out.push({ id: node.id, date: localDateKey(startMs), label: node.label });
      }
    }
  }
  return out;
}
