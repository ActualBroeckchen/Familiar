/**
 * Day-segmentation — group a session's messages by LOCAL calendar date.
 *
 * The Hybrid model (see docs/day-anchoring-build-spec.md): the live session log
 * stays one intact file; a "day-segment" is DERIVED here at memorization time.
 * Dates are computed in the server's local timezone (the ward's machine time),
 * which the coverage ledger stamps for the record.
 *
 * Pure + synchronous → trivially testable; no I/O, no Phylactery.
 */

// Local calendar date 'YYYY-MM-DD' of an ISO/epoch timestamp, or null if the
// timestamp is missing/unparseable. Uses local-time accessors on purpose.
export function localDateOf(ts) {
  if (ts === undefined || ts === null || ts === '') return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// The readable-message test the memorizer uses (skip tool turns, skip the
// assistant turn that only carries tool_calls, require non-empty string body).
// Shared so day-segment "is there enough here" counts match what extraction sees.
export function isReadableMessage(m) {
  if (!m || m.role === 'tool') return false;
  if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return false;
  return typeof m.content === 'string' && m.content.trim().length > 0;
}

/**
 * Day-delta: given a day-segment's full messages and how many were already
 * memorized (`priorThrough`, from the coverage ledger), return the tail to
 * ingest this run plus whether to skip it entirely.
 *
 *   { messages, priorThrough, skip }
 *
 * - priorThrough <= 0 → first run: ingest the whole segment (it already passed
 *   the caller's ≥2 gate), no skip.
 * - priorThrough >= length → nothing new on this date; skip.
 * - otherwise → slice off the un-memorized tail; skip only if that tail is too
 *   thin to extract from (< 2 readable), so it waits for more rather than
 *   spawning a job that re-mints nothing.
 *
 * This is what stops a growing same-day session from re-reading its earlier
 * messages and flooding the consent queue with duplicate facts. Pure.
 */
export function dayDelta(messages, priorThrough = 0) {
  const all = Array.isArray(messages) ? messages : [];
  if (!(priorThrough > 0)) return { messages: all, priorThrough: 0, skip: false };
  if (priorThrough >= all.length) return { messages: [], priorThrough, skip: true };
  const tail = all.slice(priorThrough);
  return { messages: tail, priorThrough, skip: tail.filter(isReadableMessage).length < 2 };
}

/**
 * Group `messages` by local calendar date. Returns one segment per date, in
 * date order:
 *   { date, startIdx, endIdx, count, readableCount, messages }
 *
 * - Grouping is by DATE, not by contiguous run, so an out-of-order timestamp
 *   can't split one date into two ledger entries (start/end span the date's
 *   indices; dupKey uniqueness comes from the date anyway).
 * - A message with no usable timestamp inherits the previous message's resolved
 *   date; a leading run with none inherits the first dated message's date.
 *   If NOTHING is dated, everything falls under today's local date.
 */
export function segmentByDay(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const rawDates = messages.map(m => localDateOf(m?.timestamp));
  const firstKnown = rawDates.find(Boolean) ?? localDateOf(new Date().toISOString());
  let prev = firstKnown;
  const resolved = rawDates.map(d => {
    if (d) { prev = d; return d; }
    return prev;
  });

  const byDate = new Map(); // date -> { idxs:[], messages:[] }
  messages.forEach((m, i) => {
    const date = resolved[i];
    if (!byDate.has(date)) byDate.set(date, { idxs: [], messages: [] });
    const e = byDate.get(date);
    e.idxs.push(i);
    e.messages.push(m);
  });

  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, e]) => ({
      date,
      startIdx: e.idxs[0],
      endIdx: e.idxs[e.idxs.length - 1],
      count: e.messages.length,
      readableCount: e.messages.filter(isReadableMessage).length,
      messages: e.messages,
    }));
}
