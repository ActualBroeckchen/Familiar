// recurrence.js
//
// Expansion logic for recurring schedule nodes. A node's
// `payload.recurrence` describes a rule (freq + optional modifiers);
// expandOccurrences() generates the concrete occurrence timestamps
// within a given window. Pure functions over inputs, no I/O — easy
// to test in isolation.
//
// Schema for payload.recurrence (all fields optional except `freq`):
//
//   freq: 'daily' | 'weekly' | 'monthly' | 'yearly'
//   interval: number   (default 1; every N freq units — e.g. interval:2 + freq:'weekly' = biweekly)
//   until:   ISO date  (no occurrences strictly after this date)
//   bysetpos:  integer in {-1, 1, 2, 3, 4}   (monthly only — 1=first, -1=last)
//   byweekday: integer in 0..6 (0=Sunday)    (pairs with bysetpos for "last Friday of month")
//
// Two patterns the schema covers:
//
//   { freq: 'monthly', bysetpos: -1, byweekday: 5 }
//     → "last Friday of every month" (5 = Friday in JS getDay())
//
//   { freq: 'weekly' }
//     → "every week on the same day-of-week as the anchor when_ts"

const DAY_MS = 24 * 3600 * 1000;

function toMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string') return new Date(v).getTime();
  if (v instanceof Date) return v.getTime();
  return NaN;
}

/**
 * Add days to a Date returning a new Date. Preserves time-of-day in
 * the local TZ so a recurring event "every Tuesday at 9am" stays at
 * 9am across DST shifts.
 */
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function addMonths(date, n) {
  const d = new Date(date);
  // setMonth handles year rollover. JS's behaviour: if the original
  // day-of-month doesn't exist in the target month (e.g. anchor on
  // Jan 31, going to Feb), it overflows to March 3 by default. We
  // clamp to the last valid day of the target month instead so a
  // "monthly on the 31st" anchor stays at the end of each month.
  const origDay = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(origDay, lastDay));
  return d;
}

function addYears(date, n) {
  const d = new Date(date);
  // Same Feb-29 clamp as addMonths — Feb 29 in a leap year goes to
  // Feb 28 in non-leap years rather than overflowing into March 1.
  const origMonth = d.getMonth();
  const origDay = d.getDate();
  d.setMonth(0); // park on Jan to avoid mid-step overflow
  d.setDate(1);
  d.setFullYear(d.getFullYear() + n);
  d.setMonth(origMonth);
  const lastDay = new Date(d.getFullYear(), origMonth + 1, 0).getDate();
  d.setDate(Math.min(origDay, lastDay));
  return d;
}

/**
 * Compute the date of the nth weekday in the given month.
 *   nthWeekdayOfMonth(2026, 5, 4, -1)  // last Friday of June 2026
 *
 * `pos`: 1..4 = first..fourth occurrence in the month, -1 = last.
 * Returns null if pos doesn't resolve (e.g. asking for the 5th Friday
 * of a month that only has 4).
 */
function nthWeekdayOfMonth(year, month, weekday, pos) {
  if (pos === -1) {
    // Walk backward from the last day of the month
    const lastDay = new Date(year, month + 1, 0).getDate();
    for (let day = lastDay; day >= lastDay - 6; day--) {
      const d = new Date(year, month, day);
      if (d.getDay() === weekday) return d;
    }
    return null;
  }
  if (pos >= 1 && pos <= 4) {
    // Find the first occurrence then add (pos-1) weeks
    for (let day = 1; day <= 7; day++) {
      const d = new Date(year, month, day);
      if (d.getDay() === weekday) {
        const target = new Date(year, month, day + (pos - 1) * 7);
        // Ensure we stayed in the same month
        return target.getMonth() === month ? target : null;
      }
    }
  }
  return null;
}

/**
 * Generate occurrence timestamps for a recurring node within the
 * window [fromMs, toMs] (inclusive on both ends).
 *
 * Returns an array of millisecond timestamps, sorted ascending.
 * Empty array if the node has no recurrence rule, or if no
 * occurrences fall in the window.
 *
 * Capped at MAX_OCCURRENCES (50) so a malformed rule can't produce an
 * unbounded loop. If the cap is hit, a warning is logged.
 *
 * @param {object} node       schedule node with `when` ISO + payload.recurrence
 * @param {number} fromMs     window start (ms epoch)
 * @param {number} toMs       window end (ms epoch)
 * @returns {number[]} occurrence start timestamps within the window
 */
const MAX_OCCURRENCES = 50;

/**
 * Format a millisecond timestamp as a local-TZ YYYY-MM-DD key — the
 * same shape per-occurrence resolutions are stored under in
 * payload.resolutions (a map of { 'YYYY-MM-DD': 'done'|'cancelled'|... }).
 * Local-TZ matters: a resolution recorded on "2026-06-04" in the
 * user's timezone shouldn't disappear when the server interprets it
 * against UTC and decides the actual occurrence is on Jun 3 or Jun 5.
 */
export function localDateKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function expandOccurrences(node, fromMs, toMs) {
  const rec = node?.payload?.recurrence;
  if (!rec || typeof rec !== 'object') return [];
  const anchorMs = toMs.toMs ? toMs.toMs(node.when) : new Date(node.when ?? '').getTime();
  // Use our local toMs since the param name clashes with the function
  const anchor = new Date(node.when ?? '');
  if (!Number.isFinite(anchor.getTime())) return [];

  const fromT = Number(fromMs);
  const toT = Number(toMs);
  if (!Number.isFinite(fromT) || !Number.isFinite(toT) || fromT > toT) return [];

  const untilMs = rec.until ? new Date(rec.until).getTime() : Infinity;
  const interval = Math.max(1, Math.floor(Number(rec.interval) || 1));
  const out = [];

  const push = (d) => {
    const ms = d.getTime();
    if (ms > untilMs) return false;
    if (ms >= fromT && ms <= toT) out.push(ms);
    return true;
  };

  // Per-occurrence resolutions live on the same payload as the
  // recurrence rule. Marking THIS Sunday's cleaning done doesn't kill
  // next Sunday — we just skip resolved occurrence-dates when
  // expanding. Map keys are local-TZ YYYY-MM-DD; values are the
  // resolution status ('done' | 'cancelled' | 'carried_forward').
  const resolutions = (node.payload && node.payload.resolutions) || {};
  const isResolved = (ms) => Object.prototype.hasOwnProperty.call(resolutions, localDateKey(ms));

  const freq = String(rec.freq || '').toLowerCase();

  if (freq === 'daily') {
    // Walk forward from anchor, stepping `interval` days at a time.
    // Skip any occurrences before the window starts (cheap forward
    // arithmetic, no need for a per-day loop).
    let cur = new Date(anchor);
    const daysFromAnchor = Math.max(0, Math.floor((fromT - cur.getTime()) / DAY_MS / interval));
    cur = addDays(cur, daysFromAnchor * interval);
    while (cur.getTime() <= toT && cur.getTime() <= untilMs) {
      if (cur.getTime() >= fromT) out.push(cur.getTime());
      if (out.length >= MAX_OCCURRENCES) break;
      cur = addDays(cur, interval);
    }
    return out.filter(ms => !isResolved(ms));
  }

  if (freq === 'weekly') {
    // Step 7*interval days at a time from anchor.
    let cur = new Date(anchor);
    const step = 7 * interval;
    const daysFromAnchor = Math.max(0, Math.floor((fromT - cur.getTime()) / DAY_MS / step) * step);
    cur = addDays(cur, daysFromAnchor);
    while (cur.getTime() <= toT && cur.getTime() <= untilMs) {
      if (cur.getTime() >= fromT) out.push(cur.getTime());
      if (out.length >= MAX_OCCURRENCES) break;
      cur = addDays(cur, step);
    }
    return out.filter(ms => !isResolved(ms));
  }

  if (freq === 'monthly') {
    // Two sub-modes:
    //   bysetpos + byweekday → "first/last Xday of every Nth month"
    //   otherwise            → "same day-of-month as anchor every Nth month"
    const usePos = Number.isInteger(rec.bysetpos) && Number.isInteger(rec.byweekday);
    // Start from the anchor month and walk forward in steps of `interval`.
    let monthIdx = 0;
    while (true) {
      const baseMonth = addMonths(anchor, monthIdx * interval);
      let occ;
      if (usePos) {
        occ = nthWeekdayOfMonth(baseMonth.getFullYear(), baseMonth.getMonth(), rec.byweekday, rec.bysetpos);
        if (occ) {
          // Preserve the anchor's time-of-day on the computed date.
          occ.setHours(anchor.getHours(), anchor.getMinutes(), anchor.getSeconds(), anchor.getMilliseconds());
        }
      } else {
        occ = baseMonth;
      }
      if (!occ) { monthIdx++; if (monthIdx > 600) break; continue; }
      if (occ.getTime() > toT) break;
      if (!push(occ)) break;
      if (out.length >= MAX_OCCURRENCES) break;
      monthIdx++;
      if (monthIdx > 600) break; // 50 years of months — overflow guard
    }
    return out.filter(ms => !isResolved(ms));
  }

  if (freq === 'yearly') {
    let yearIdx = 0;
    while (true) {
      const occ = addYears(anchor, yearIdx * interval);
      if (occ.getTime() > toT) break;
      if (!push(occ)) break;
      if (out.length >= MAX_OCCURRENCES) break;
      yearIdx++;
      if (yearIdx > 200) break;
    }
    return out.filter(ms => !isResolved(ms));
  }

  return [];
}

/**
 * Given a list of schedule nodes (some plain, some recurring) and a
 * window, return a flat list of "rendered" items: plain nodes are
 * passed through verbatim; recurring nodes are expanded into one
 * synthetic item per occurrence within the window.
 *
 * Synthetic occurrences inherit the source node's id, label, type,
 * end (relative to the new when), resolution, and payload, but get
 * fresh `when` / `end` timestamps and an `__occurrence_of` marker so
 * downstream renderers can tell apart "the original node" from "an
 * expanded occurrence."
 *
 * @param {Array} nodes  raw schedule nodes (mix of recurring + plain)
 * @param {number} fromMs
 * @param {number} toMs
 * @returns {Array} expanded item list (no sorting — caller decides)
 */
export function expandWindow(nodes, fromMs, toMs) {
  const out = [];
  for (const n of nodes ?? []) {
    if (!n) continue;
    if (n.payload?.recurrence) {
      const occurrences = expandOccurrences(n, fromMs, toMs);
      const anchorMs = new Date(n.when ?? '').getTime();
      // Compute the original event duration so each occurrence's `end`
      // stays the right length.
      const dur = (n.end && Number.isFinite(new Date(n.end).getTime()))
        ? new Date(n.end).getTime() - anchorMs
        : 0;
      for (const occMs of occurrences) {
        out.push({
          ...n,
          when: new Date(occMs).toISOString(),
          end:  dur > 0 ? new Date(occMs + dur).toISOString() : null,
          // The occurrence isn't "resolved" just because the anchor
          // was — resolution applies per-instance and we don't track
          // instance-level resolution yet, so wipe it for occurrences.
          resolution: null,
          __occurrence_of: n.id,
        });
      }
    } else {
      out.push(n);
    }
  }
  return out;
}
