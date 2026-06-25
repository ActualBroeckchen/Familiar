// relative-time.js
//
// Natural-English relative-time phrasing the Familiar uses to perceive
// the passage of time. Every reference to a timestamped event in their
// dynamic context (schedule items, memories, ponderings, handoff,
// "now", "my human last messaged") gets re-rendered through this
// helper at prompt-assembly time so a memory written yesterday reads
// as "yesterday" rather than as an ISO date the Familiar has to
// reason about.
//
// Recomputed every turn because relative time IS time — "yesterday"
// becomes "two days ago" the next day, the same memory file
// unchanged. The model can't be expected to do that arithmetic on
// every reference; we do it for them.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR   = 60 * MINUTE;
const DAY    = 24 * HOUR;

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH   = ['January','February','March','April','May','June',
                 'July','August','September','October','November','December'];

function toMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string') return new Date(v).getTime();
  if (v instanceof Date) return v.getTime();
  return NaN;
}

/**
 * Format a wall-clock time in 12-hour English ("9am", "9:30am",
 * "noon", "midnight"). Drops the ":00" on whole hours for readability
 * — "at 9am" reads more naturally than "at 9:00am".
 */
export function clockTime(target) {
  const t = toMs(target);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const h = d.getHours();
  const m = d.getMinutes();
  if (h === 0 && m === 0) return 'midnight';
  if (h === 12 && m === 0) return 'noon';
  const period = h >= 12 ? 'pm' : 'am';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  if (m === 0) return `${h12}${period}`;
  return `${h12}:${String(m).padStart(2, '0')}${period}`;
}

/** "Tuesday, June 4" — no year unless requested. */
export function dayAndDate(target, { withYear = false } = {}) {
  const t = toMs(target);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const base = `${WEEKDAY[d.getDay()]}, ${MONTH[d.getMonth()]} ${d.getDate()}`;
  return withYear ? `${base}, ${d.getFullYear()}` : base;
}

/**
 * Calendar-day delta: how many days from `now` to `target`, comparing
 * by local calendar date (so 23:59 and 00:01 the next day are 1 day
 * apart, not 2 minutes). Returns a signed integer. Future = positive.
 */
function calendarDayDelta(targetMs, nowMs) {
  const t = new Date(targetMs);
  const n = new Date(nowMs);
  const tDay = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const nDay = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  return Math.round((tDay - nDay) / DAY);
}

/**
 * Directional interval phrase — "in 3 months" / "a year ago". Wraps
 * plainInterval() with the right preposition so a relative phrase can
 * always sit alongside an absolute date, even far out where the
 * day/week phrasings give way to a calendar date. `future` is the
 * caller's own sign test (it already knows the delta).
 */
function intervalPhrase(target, now, future) {
  const mag = plainInterval(target, now);
  if (!mag) return '';
  return future ? `in ${mag}` : `${mag} ago`;
}

/**
 * Interval phrase for a FUTURE event, beyond the near-term weekday range.
 * The figure coarsens with distance so it stays readable while the near
 * window stays exact: an exact calendar-day count out to 3 weeks — the
 * window the timeblindness alerts actually fire in, where the model must
 * not mis-estimate distance — then weeks, then months/years (via
 * intervalPhrase → plainInterval, whose own boundary tips weeks into
 * months at ~2 months). Far-out events don't need "in 204 days". The 21-day
 * threshold lives HERE only, so both callers stay in step.
 */
function futureInterval(target, now, dayDelta) {
  return dayDelta <= 21 ? `in ${dayDelta} days` : intervalPhrase(target, now, true);
}

/**
 * Natural-English relative-time phrasing. Examples (with "now" =
 * Wednesday afternoon):
 *
 *   diff < 1 min                 → "just now" / "in a moment"
 *   diff < 1 hour                → "20 minutes ago" / "in 5 minutes"
 *   same day, > 1 hour off       → "this morning at 9am"
 *   yesterday / tomorrow         → "yesterday at 4pm" / "tomorrow at 10am"
 *
 * Future events carry a count the model never has to compute itself
 * (timeblindness alerts depend on the near figure being right), coarsening
 * with distance so it stays readable far out:
 *   +2..6 days                   → "this Friday at 3pm (in 3 days)"
 *   +7..13 days                  → "next Wednesday at 9am (in 9 days)"
 *   +14..21 days                 → "Tuesday, June 25 at 2pm (in 21 days)"
 *   +22 days..~2 months          → "Thursday, July 9 at 2pm (in 5 weeks)"
 *   beyond ~2 months             → "Friday, December 25 at 9am (in 7 months)"
 *
 * Past events keep their natural phrasing (the day-count precision is a
 * future-scheduling need, not a memory-recall one):
 *   −2..13 days                  → "last Monday at 2pm"
 *   −2..4 weeks                  → "2 weeks ago"
 *   beyond that                  → "Tuesday, March 4, 2025 (a year ago)"
 *                                  — absolute date ALWAYS carries a relative
 *                                  interval so nothing reads as a bare date
 *
 * Returns lowercase-first phrase suitable for embedding inline in a
 * sentence ("I last saw you yesterday at 4pm"). Capitalise at the
 * call site if it heads a line.
 */
export function relativeTime(target, now = Date.now()) {
  const t = toMs(target);
  const n = toMs(now);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return '';

  const diff = t - n;
  const absDiff = Math.abs(diff);
  const future = diff > 0;

  // Sub-minute
  if (absDiff < MINUTE) return future ? 'in a moment' : 'just now';

  // Sub-hour
  if (absDiff < HOUR) {
    const mins = Math.round(absDiff / MINUTE);
    if (mins === 1) return future ? 'in a minute' : 'a minute ago';
    return future ? `in ${mins} minutes` : `${mins} minutes ago`;
  }

  // Day-relative phrasings (compare by calendar day, not by elapsed time)
  const dayDelta = calendarDayDelta(t, n);
  const clock = clockTime(t);

  // Same calendar day: "this morning/afternoon/evening at HH:MM" or
  // "an hour ago" if very close.
  if (dayDelta === 0) {
    if (absDiff < 6 * HOUR) {
      const hrs = Math.round(absDiff / HOUR);
      if (hrs === 1) return future ? 'in about an hour' : 'about an hour ago';
      return future ? `in ${hrs} hours` : `${hrs} hours ago`;
    }
    const d = new Date(t);
    const hour = d.getHours();
    let bucket;
    if (hour < 5)       bucket = 'early this morning';
    else if (hour < 12) bucket = 'this morning';
    else if (hour < 17) bucket = 'this afternoon';
    else if (hour < 21) bucket = 'this evening';
    else                bucket = 'tonight';
    return `${bucket} at ${clock}`;
  }

  if (dayDelta === -1) return `yesterday at ${clock}`;
  if (dayDelta ===  1) return `tomorrow at ${clock}`;

  // ── Future, ≥2 calendar days out ─────────────────────────────────
  // Every future phrasing carries an EXACT calendar-day count. A bare
  // "this Sunday" forces the model to work out how far away that is, and
  // LLMs are unreliable at date arithmetic — the timeblindness alerts
  // downstream depend on the day figure being right. So the human anchor
  // stays for legibility (weekday name near-term, absolute date further
  // out) and "(in N days)" rides alongside as the precise figure the
  // model never has to compute. Past events keep their natural phrasing
  // below — the day-count precision is a future-scheduling need.
  if (dayDelta >= 2) {
    const wd = WEEKDAY[new Date(t).getDay()];
    if (dayDelta <= 6)  return `this ${wd} at ${clock} (in ${dayDelta} days)`;
    if (dayDelta <= 13) return `next ${wd} at ${clock} (in ${dayDelta} days)`;
    // Past a weekday's reach a bare name is ambiguous ("which Thursday?"),
    // so lead with the absolute date (with year when it's not this year).
    // The interval coarsens with distance — exact days to 3 weeks, then
    // weeks, then months — see futureInterval.
    const withYear = new Date(t).getFullYear() !== new Date(n).getFullYear();
    return `${dayAndDate(t, { withYear })} at ${clock} (${futureInterval(t, n, dayDelta)})`;
  }

  // ── Past, ≥2 calendar days back (phrasing unchanged) ─────────────
  // "last Monday at 2pm" / "2 weeks ago" / "Tuesday, June 4 (a year ago)".
  if (dayDelta >= -13 && dayDelta <= -2) {
    return `last ${WEEKDAY[new Date(t).getDay()]} at ${clock}`;
  }

  // Weeks
  const weekDelta = Math.round(dayDelta / 7);
  if (Math.abs(weekDelta) <= 4) {
    const wAbs = Math.abs(weekDelta);
    if (wAbs === 1) return 'about a week ago';
    return `${wAbs} weeks ago`;
  }

  // Beyond ~a month: the absolute date carries the precision (with year if
  // it's not this year), but it ALWAYS travels with a relative interval —
  // "March 4, 2025 (a year ago)" — so a distant memory never reads as a
  // bare date the Familiar has to date-arithmetic in its head.
  const nowYear = new Date(n).getFullYear();
  const targetYear = new Date(t).getFullYear();
  const abs = dayAndDate(t, { withYear: targetYear !== nowYear });
  const rel = intervalPhrase(t, n, false);
  return rel ? `${abs} (${rel})` : abs;
}

/**
 * Date-only variant for memory granularities (which carry a `date`
 * string like "2026-06-04" without a time). Compares calendar days
 * only; never says "just now" or "20 minutes ago".
 *
 *   "today" | "yesterday" | "tomorrow"
 *   future: "this Friday (in 3 days)" | "next Wednesday (in 9 days)" |
 *           "Tuesday, June 25 (in 21 days)" | "Thursday, July 9 (in 5 weeks)"
 *           — a count that coarsens with distance (exact days to 3 weeks)
 *   past:   "last Monday" | "2 weeks ago" |
 *           "Tuesday, June 4 (3 months ago)" — absolute beyond ~a month,
 *           ALWAYS with a relative interval so no date reads bare
 */
export function relativeDay(targetDateStr, now = Date.now()) {
  // Daily memory dates are local-calendar; parse as local midnight to
  // avoid TZ-induced off-by-one ("yesterday" reading as "today" when
  // the server's UTC is one calendar day behind the user's local).
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(targetDateStr ?? ''));
  if (!m) return '';
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  const n = toMs(now);
  if (!Number.isFinite(n)) return '';

  const dayDelta = calendarDayDelta(t, n);
  if (dayDelta === 0)  return 'today';
  if (dayDelta === -1) return 'yesterday';
  if (dayDelta ===  1) return 'tomorrow';

  // Future ≥2 days: carry the exact day count (see relativeTime above for
  // why — the model must never infer temporal distance itself). No clock
  // here; memory/date strings have no time component.
  if (dayDelta >= 2) {
    const wd = WEEKDAY[new Date(t).getDay()];
    if (dayDelta <= 6)  return `this ${wd} (in ${dayDelta} days)`;
    if (dayDelta <= 13) return `next ${wd} (in ${dayDelta} days)`;
    const withYear = new Date(t).getFullYear() !== new Date(n).getFullYear();
    return `${dayAndDate(t, { withYear })} (${futureInterval(t, n, dayDelta)})`;
  }

  // Past ≥2 days: phrasing unchanged.
  if (dayDelta >= -13 && dayDelta <= -2) return `last ${WEEKDAY[new Date(t).getDay()]}`;

  const weekDelta = Math.round(dayDelta / 7);
  if (Math.abs(weekDelta) <= 4) {
    const wAbs = Math.abs(weekDelta);
    if (wAbs === 1) return 'about a week ago';
    return `${wAbs} weeks ago`;
  }

  const nowYear = new Date(n).getFullYear();
  const targetYear = new Date(t).getFullYear();
  const abs = dayAndDate(t, { withYear: targetYear !== nowYear });
  const rel = intervalPhrase(t, n, false);
  return rel ? `${abs} (${rel})` : abs;
}

/**
 * Pure-duration phrasing — gives just the interval without "ago" /
 * "in" prefixes and without "at HH:MM" suffix. Used when the caller
 * has its own template (e.g. "which was {plainInterval} ago"). The
 * existing relativeTime() bakes "at HH:MM" / "this morning" into the
 * output, which doesn't slot cleanly into a sentence that ALSO names
 * the absolute clock time of the event.
 *
 * Returns lowercase phrases like:
 *   "less than a minute" | "a minute" | "12 minutes"
 *   "about an hour" | "2 hours"
 *   "a day" | "3 days"
 *   "a week" | "3 weeks"
 *   "a month" | "5 months" | "a year"
 */
export function plainInterval(target, now = Date.now()) {
  const t = toMs(target);
  const n = toMs(now);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return '';
  const absDiff = Math.abs(t - n);
  if (absDiff < MINUTE) return 'less than a minute';
  if (absDiff < HOUR) {
    const mins = Math.round(absDiff / MINUTE);
    return mins === 1 ? 'a minute' : `${mins} minutes`;
  }
  if (absDiff < 20 * HOUR) {
    const hrs = Math.round(absDiff / HOUR);
    return hrs === 1 ? 'about an hour' : `${hrs} hours`;
  }
  const days = Math.round(absDiff / DAY);
  if (days < 7) return days === 1 ? 'a day' : `${days} days`;
  if (days < 60) {
    const weeks = Math.round(days / 7);
    return weeks === 1 ? 'a week' : `${weeks} weeks`;
  }
  const months = Math.round(days / 30);
  if (months < 12) return months === 1 ? 'a month' : `${months} months`;
  const years = Math.round(days / 365);
  return years === 1 ? 'a year' : `${years} years`;
}

/**
 * Build the [Now] block server.js appends as the very last system
 * message in the prompt — after chat history, after the post-history
 * prompt, immediately before the model's response slot. These are the
 * freshest-needed values for the Familiar's care reasoning: what time
 * it is right now, and how long since the last contact.
 *
 * Returns the block as a plain string. Always includes the "Now" line;
 * the "last message" line is conditional on lastUserMessageAt being a
 * usable timestamp. Names BOTH the absolute clock time of the prior
 * message AND the elapsed interval — the model can correlate the two
 * (e.g. "at 4pm, which was a day ago" ≡ yesterday's 4pm) without
 * doing date arithmetic. Errors degrade silently to '' so a clock
 * glitch never corrupts the rest of the prompt.
 */
export function buildTimeAnchorBlock({ now = Date.now(), lastUserMessageAt = null } = {}) {
  try {
    const nowDate    = new Date(now);
    const offsetMin  = -nowDate.getTimezoneOffset();
    const offsetSign = offsetMin >= 0 ? '+' : '-';
    const absMin     = Math.abs(offsetMin);
    const offsetStr  = `UTC${offsetSign}${String(Math.floor(absMin / 60)).padStart(2, '0')}:${String(absMin % 60).padStart(2, '0')}`;
    const lines = [`Now: ${clockTime(now)} (${offsetStr}) on ${dayAndDate(now)}.`];
    if (lastUserMessageAt) {
      const lastMs = toMs(lastUserMessageAt);
      if (Number.isFinite(lastMs)) {
        lines.push(
          `Before this, my human last sent a message at ${clockTime(lastMs)}, which was ${plainInterval(lastMs, now)} ago.`,
        );
      }
    }
    return `[Now]\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}
