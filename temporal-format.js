/**
 * Pure renderer for Unruh's temporal_context payload.
 *
 * Kept in its own file (rather than inline in thalamus.js) so it can be
 * imported by tests without triggering thalamus.js's startup-time MCP
 * child-process spawns.
 *
 * Returns '' when there's nothing meaningful to surface (Unruh down,
 * payload missing, or every sub-block empty) so the assembler in
 * thalamus.js can omit the [Temporal Context] header entirely.
 *
 * Sub-block order — handoff, schedule, interests — mirrors the design
 * doc's daily-briefing order from docs/unruh-design.md.
 *
 * Payload shape (kept stable; Unruh's server.py mirrors this):
 *   {
 *     ts: '2026-01-15T10:00:00Z',
 *     schedule:  { window: [...], phase: {...} | null },
 *     interests: { standing: [...], live: [...] },
 *     handoff:   { intent: '...' | null, open_threads: [...] }
 *   }
 */
/**
 * Render an ISO-8601 UTC timestamp as a local-TZ string the model
 * can reason about — landmarks-style ("today at 22:00") rather than
 * coordinates ("2026-05-18T22:00:00+00:00", which it can technically
 * read but tends to mis-summarise).
 *
 * Format chosen by recency relative to "now":
 *   today          → "HH:MM"
 *   yesterday      → "yesterday HH:MM"
 *   tomorrow       → "tomorrow HH:MM"
 *   other this yr  → "Mon DD HH:MM"
 *   other year     → "YYYY-MM-DD HH:MM"
 *
 * timeOnly forces "HH:MM" regardless of date — used for phase span
 * brackets where the date is implicit from context.
 *
 * Returns the input string unchanged if it can't be parsed as a date.
 */
function formatLocalTime(iso, opts = {}) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const hhmm = `${hh}:${mm}`;
  if (opts.timeOnly) return hhmm;

  const now = new Date();
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return hhmm;

  const oneDay = 86_400_000;
  const yesterday = new Date(now.getTime() - oneDay);
  const tomorrow  = new Date(now.getTime() + oneDay);
  if (sameDay(d, yesterday)) return `yesterday ${hhmm}`;
  if (sameDay(d, tomorrow))  return `tomorrow ${hhmm}`;

  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (d.getFullYear() === now.getFullYear()) {
    return `${months[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')} ${hhmm}`;
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hhmm}`;
}

export function formatTemporalContext(payload) {
  if (!payload || typeof payload !== 'object') return '';

  const blocks = [];

  const handoff = payload.handoff ?? {};
  if (handoff.intent || (handoff.open_threads ?? []).length) {
    const handoffLines = ['Last session:'];
    if (handoff.intent) handoffLines.push(`  intent — ${handoff.intent}`);
    for (const thread of handoff.open_threads ?? []) {
      handoffLines.push(`  open — ${typeof thread === 'string' ? thread : thread.label ?? thread.id}`);
    }
    blocks.push(handoffLines.join('\n'));
  }

  const schedule = payload.schedule ?? {};
  const phase = schedule.phase;
  const window = schedule.window ?? [];
  if (phase || window.length) {
    const schedLines = [];
    if (phase) {
      const phaseLabel = phase.label ?? phase.id ?? phase;
      const span = phase.when && phase.end
        ? ` (${formatLocalTime(phase.when, { timeOnly: true })}–${formatLocalTime(phase.end, { timeOnly: true })})`
        : '';
      schedLines.push(`Current phase: ${phaseLabel}${span}`);
    }
    for (const item of window) {
      // Skip the phase that's already shown as "Current phase" — no
      // need to repeat it as a separate line in the window list.
      if (item.type === 'phase' && phase && item.id === phase.id) continue;
      const when = item.when ?? item.fires_at ?? '';
      const label = item.label ?? item.id ?? '';
      const resolution = item.resolution ? ` [${item.resolution}]` : '';
      const whenText = when ? `${formatLocalTime(when)} — ` : '';
      schedLines.push(`  ${whenText}${label}${resolution}`);
    }
    if (schedLines.length) blocks.push(schedLines.join('\n'));
  }

  const interests = payload.interests ?? {};
  const standing = interests.standing ?? [];
  const live = interests.live ?? [];
  if (standing.length || live.length) {
    const interestLines = [];
    if (standing.length) {
      interestLines.push('Standing values:');
      for (const v of standing) interestLines.push(`  ${v.label ?? v}`);
    }
    if (live.length) {
      interestLines.push('Live interests (by weight):');
      for (const i of live) {
        const w = typeof i.weight === 'number' ? ` [${i.weight.toFixed(2)}]` : '';
        interestLines.push(`  ${i.label ?? i.id}${w}`);
      }
    }
    blocks.push(interestLines.join('\n'));
  }

  return blocks.join('\n\n');
}
