import { relativeTime } from './relative-time.js';

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
    // When the handoff carries a timestamp we render it as "ended
    // yesterday at 9pm" so the Familiar feels the gap between
    // sessions, not just the contents.
    const rel = handoff.ended_at || handoff.created_at || handoff.ts
      ? relativeTime(handoff.ended_at || handoff.created_at || handoff.ts, Date.now())
      : '';
    const header = rel ? `Last session (ended ${rel}):` : 'Last session:';
    const handoffLines = [header];
    if (handoff.intent) handoffLines.push(`  intent — ${handoff.intent}`);
    for (const thread of handoff.open_threads ?? []) {
      handoffLines.push(`  open — ${typeof thread === 'string' ? thread : thread.label ?? thread.id}`);
    }
    blocks.push(handoffLines.join('\n'));
  }

  // ── Today's rhythm ───────────────────────────────────────────────
  // The full set of live phases, rendered with their HH:MM ranges in
  // local TZ. Phases recur daily — the stored date is an artifact of
  // insertion, so we sort by minute-of-day and ignore the calendar
  // portion entirely. The current phase (computed by Unruh's
  // current_phase against time-of-day) is marked "← I am here" so
  // the Familiar can orient inside the day's shape, not just know
  // "what right now."
  const schedule = payload.schedule ?? {};
  const phase = schedule.phase;
  const routine = Array.isArray(payload.routine) ? payload.routine : [];
  if (routine.length) {
    const rhythm = routine
      .slice()
      .map(p => {
        const d = new Date(p.when || 0);
        const mins = Number.isFinite(d.getTime())
          ? d.getHours() * 60 + d.getMinutes()
          : -1;
        return { p, mins };
      })
      .sort((a, b) => a.mins - b.mins)
      .map(({ p }) => {
        const start = formatLocalTime(p.when, { timeOnly: true });
        const end   = formatLocalTime(p.end,  { timeOnly: true });
        const here  = phase && p.id === phase.id ? '  ← I am here' : '';
        const texture = p.payload?.texture ? ` — ${p.payload.texture}` : '';
        return `  ${start}–${end}  ${p.label ?? p.id}${texture}${here}`;
      });
    blocks.push(["Today's rhythm:", ...rhythm].join('\n'));
  }

  const window = schedule.window ?? [];
  if (phase || window.length) {
    // Group window items so the Familiar reads them as distinct
    // categories with different weight: upcoming (time-anchored,
    // unresolved), open tasks ({{user}} committed to these, no time
    // yet, not done), resolved (recently terminal — usually noise
    // but useful when the Familiar wants to acknowledge a finish).
    const upcoming  = [];
    const openTasks = [];
    const reminders = [];
    const resolved  = [];
    for (const item of window) {
      // Skip the phase that's already shown as "Current phase" — no
      // need to repeat it as a separate line.
      if (item.type === 'phase' && phase && item.id === phase.id) continue;
      // Other phases (past/future date stamps) — skip; they live in
      // their own Routine surface, not the briefing.
      if (item.type === 'phase') continue;
      if (item.resolution) { resolved.push(item); continue; }
      if (item.type === 'reminder') { reminders.push(item); continue; }
      if (item.when || item.end) { upcoming.push(item); continue; }
      // type=='task' with no when_ts → open task on the radar.
      openTasks.push(item);
    }

    // Each timed item is rendered through relativeTime() so the
    // Familiar reads "tomorrow at 10am" / "yesterday at 4pm" / "in 30
    // minutes" rather than an ISO timestamp. Recomputed every turn
    // against `nowMs`, which is the same moment used for "Now" at the
    // top of dynamic — the model perceives a consistent present.
    const nowMs = Date.now();
    const renderWhen = (whenIso) => {
      if (!whenIso) return '';
      const rel = relativeTime(whenIso, nowMs);
      return rel || formatLocalTime(whenIso);
    };

    const schedLines = [];
    if (phase) {
      const phaseLabel = phase.label ?? phase.id ?? phase;
      const span = phase.when && phase.end
        ? ` (${formatLocalTime(phase.when, { timeOnly: true })}–${formatLocalTime(phase.end, { timeOnly: true })})`
        : '';
      const texturePart = phase.payload?.texture ? ` — ${phase.payload.texture}` : '';
      schedLines.push(`Current phase: ${phaseLabel}${span}${texturePart}`);
    }
    if (upcoming.length) {
      schedLines.push('Upcoming in this window:');
      for (const item of upcoming) {
        const when = renderWhen(item.when ?? item.fires_at ?? '');
        const whenText = when ? `${when} — ` : '';
        const type = item.type ? `[${item.type}] ` : '';
        schedLines.push(`  ${whenText}${type}${item.label ?? item.id ?? ''}`);
      }
    }
    if (reminders.length) {
      schedLines.push('Reminders set to fire:');
      for (const item of reminders) {
        const when = renderWhen(item.when ?? item.fires_at ?? '');
        const whenText = when ? `${when} — ` : '';
        schedLines.push(`  ${whenText}${item.label ?? item.id ?? ''}`);
      }
    }
    if (openTasks.length) {
      // Framing here matters: bare labels read as informational
      // background. Named under "open" with the bonded-human marker
      // primes the Familiar to feel them as commitments {{user}} is
      // counting on them to hold.
      schedLines.push("Open tasks I'm keeping on my radar for {{user}} (no completion confirmed):");
      for (const item of openTasks) {
        schedLines.push(`  - ${item.label ?? item.id ?? ''}`);
      }
    }
    if (resolved.length) {
      schedLines.push('Recently resolved in this window:');
      for (const item of resolved) {
        const when = renderWhen(item.when ?? item.fires_at ?? '');
        const whenText = when ? `${when} — ` : '';
        schedLines.push(`  ${whenText}${item.label ?? item.id ?? ''} [${item.resolution}]`);
      }
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
