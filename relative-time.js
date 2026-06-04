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
 * Natural-English relative-time phrasing. Examples (with "now" =
 * Wednesday afternoon):
 *
 *   diff < 1 min                 → "just now" / "in a moment"
 *   diff < 1 hour                → "20 minutes ago" / "in 5 minutes"
 *   same day, > 1 hour off       → "this morning at 9am"
 *   yesterday / tomorrow         → "yesterday at 4pm" / "tomorrow at 10am"
 *   ±2..6 days, same week        → "last Monday at 2pm" / "this Friday at 3pm"
 *   ±7..13 days                  → "last week" / "next week"
 *   ±2..4 weeks                  → "2 weeks ago" / "in 3 weeks"
 *   beyond that                  → "Tuesday, June 4" (absolute date)
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

  // Within the same week-ish: "last Monday" / "this Friday" / "next Wednesday"
  if (dayDelta >= -6 && dayDelta <= -2) {
    return `last ${WEEKDAY[new Date(t).getDay()]} at ${clock}`;
  }
  if (dayDelta >= 2 && dayDelta <= 6) {
    return `this ${WEEKDAY[new Date(t).getDay()]} at ${clock}`;
  }
  if (dayDelta >= 7 && dayDelta <= 13) {
    return `next ${WEEKDAY[new Date(t).getDay()]} at ${clock}`;
  }
  if (dayDelta >= -13 && dayDelta <= -7) {
    return `last ${WEEKDAY[new Date(t).getDay()]} at ${clock}`;
  }

  // Weeks
  const weekDelta = Math.round(dayDelta / 7);
  if (Math.abs(weekDelta) <= 4) {
    const wAbs = Math.abs(weekDelta);
    if (wAbs === 1) return future ? 'in about a week' : 'about a week ago';
    return future ? `in ${wAbs} weeks` : `${wAbs} weeks ago`;
  }

  // Beyond ~a month: fall back to absolute date (with year if it's not
  // this year, so a memory from January 2025 read in June 2026 doesn't
  // get rendered as just "January 22").
  const nowYear = new Date(n).getFullYear();
  const targetYear = new Date(t).getFullYear();
  return dayAndDate(t, { withYear: targetYear !== nowYear });
}

/**
 * Date-only variant for memory granularities (which carry a `date`
 * string like "2026-06-04" without a time). Compares calendar days
 * only; never says "just now" or "20 minutes ago".
 *
 *   "today" | "yesterday" | "tomorrow"
 *   "last Monday" | "this Friday" | "next Wednesday"
 *   "2 weeks ago" | "in 3 weeks"
 *   "Tuesday, June 4" (absolute, beyond ~a month)
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
  if (dayDelta >= -6 && dayDelta <= -2) return `last ${WEEKDAY[new Date(t).getDay()]}`;
  if (dayDelta >= 2 && dayDelta <= 6)   return `this ${WEEKDAY[new Date(t).getDay()]}`;
  if (dayDelta >= 7 && dayDelta <= 13)  return `next ${WEEKDAY[new Date(t).getDay()]}`;
  if (dayDelta >= -13 && dayDelta <= -7) return `last ${WEEKDAY[new Date(t).getDay()]}`;

  const weekDelta = Math.round(dayDelta / 7);
  if (Math.abs(weekDelta) <= 4) {
    const wAbs = Math.abs(weekDelta);
    if (wAbs === 1) return dayDelta > 0 ? 'in about a week' : 'about a week ago';
    return dayDelta > 0 ? `in ${wAbs} weeks` : `${wAbs} weeks ago`;
  }

  const nowYear = new Date(n).getFullYear();
  const targetYear = new Date(t).getFullYear();
  return dayAndDate(t, { withYear: targetYear !== nowYear });
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
 * usable timestamp. Errors degrade silently to '' so a clock glitch
 * never corrupts the rest of the prompt.
 */
export function buildTimeAnchorBlock({ now = Date.now(), lastUserMessageAt = null } = {}) {
  try {
    const lines = [`Now: ${clockTime(now)} on ${dayAndDate(now)}.`];
    if (lastUserMessageAt) {
      const lastMs = toMs(lastUserMessageAt);
      if (Number.isFinite(lastMs)) {
        lines.push(`My human last sent a message ${relativeTime(lastMs, now)}.`);
      }
    }
    return `[Now]\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}
