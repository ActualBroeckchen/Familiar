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

// Directional edge kinds → readable verb. co_occurs_with is rendered
// undirected ("A — co-occurs — B") because it asserts no direction.
const EDGE_VERB = {
  causes: 'causes', requires: 'requires', depends_on: 'depends on',
  blocks: 'blocks', during: 'during', carries_forward: 'carries forward into',
};

/**
 * Compact human-readable tag for an edge's consequence payload, e.g.
 * " [on lapse · in ~4h · harms · high certainty]". Empty string when the
 * edge carries no consequence metadata (a bare structural link). Built so
 * the Familiar reads which future a consequence belongs to, when it lands,
 * whether it helps or harms, and how sure it is (observed fact vs guess).
 */
function consequenceTag(p) {
  if (!p || typeof p !== 'object') return '';
  const parts = [];
  if (p.condition === 'on_resolve') parts.push('on resolve');
  else if (p.condition === 'on_lapse') parts.push('on lapse');
  const h = Number(p.horizon_hours);
  if (Number.isFinite(h)) parts.push(h >= 48 ? `in ~${Math.round(h / 24)}d` : h >= 1 ? `in ~${Math.round(h)}h` : 'within the hour');
  if (p.valence === 'help') parts.push('helps');
  else if (p.valence === 'harm') parts.push('harms');
  if (p.severity === 'high') parts.push('high stakes');
  // Honesty: an observed edge is a fact; a projection wears its certainty.
  if (p.observed) parts.push('observed before');
  else if (p.certainty) parts.push(`${p.certainty} certainty`);
  return parts.length ? ` [${parts.join(' · ')}]` : '';
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
      // background. Named as something I'm actively holding — mine to
      // remember AND to raise — primes the Familiar to feel them as
      // commitments {{user}} is counting on them to act on, not a
      // passive list to perceive.
      schedLines.push("Open tasks I'm holding for {{user}} — mine to remember and to raise (no completion confirmed):");
      for (const item of openTasks) {
        // How long it's floated unscheduled — the signal that it's waiting to be
        // pinned to a real time. (created_at rides in from Unruh; a task without
        // one just renders bare.)
        const created = item.created_at ? new Date(item.created_at).getTime() : NaN;
        const floatDays = Number.isFinite(created)
          ? Math.floor((nowMs - created) / (24 * 3600 * 1000)) : null;
        const ageTag = (floatDays != null && floatDays >= 1) ? ` (floating ${floatDays}d — no time set)` : '';
        schedLines.push(`  - ${item.label ?? item.id ?? ''}${ageTag}`);
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

  // Needs-fulfilment view (Pass 2): today's status for each need-window
  // I'm tracking. Observational — I read it and decide in my own voice
  // whether a missed or still-open need is worth a gentle word. Sorted so
  // the ones that might want attention (missed, then open) read first.
  const needs = Array.isArray(payload.needs) ? payload.needs : [];
  if (needs.length) {
    const rank = { missed: 0, open: 1, upcoming: 2, met: 3 };
    const needLines = needs
      .slice()
      .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))
      .map(n => {
        const endT   = formatLocalTime(new Date(n.endMs).toISOString(),   { timeOnly: true });
        const startT = formatLocalTime(new Date(n.startMs).toISOString(), { timeOnly: true });
        let s;
        if (n.status === 'met')           s = 'met ✓';
        else if (n.status === 'missed')   s = `missed — window passed unmet (closed ${endT})`;
        else if (n.status === 'open')     s = `open now — window closes ${endT}`;
        else if (n.status === 'upcoming') s = `later today (${startT}–${endT})`;
        else                              s = n.status;
        return `  ${n.label ?? ''} — ${s}`;
      });
    blocks.push(["Needs today — basic-needs windows I'm tracking for {{user}} (met / open / missed):", ...needLines].join('\n'));
  }

  // Schedule-id legend. The human-readable lines above carry labels, not ids —
  // but every schedule editing tool (re-time, snooze, resolve, delete) is
  // addressed by id, and without this the Familiar can SEE its schedule yet
  // can't act on it. Mirrors the knowledge-graph block's id legend: ids live in
  // one compact list at the end rather than inline on every line. Covers both
  // routine phases and the window so a phase can be deleted and an event/task
  // re-timed or resolved. Deduped; skips nodes with no id.
  const scheduleNodes = [
    ...(Array.isArray(payload.routine) ? payload.routine : []),
    ...(Array.isArray(schedule.window) ? schedule.window : []),
  ];
  // Consequence links — the edges of the schedule graph, finally rendered
  // (they were stored but invisible). Only edges whose BOTH endpoints are
  // in the visible window are shown; one whose endpoint scrolled out (or is
  // a recurring anchor expanded under a different id) is dropped rather than
  // rendered with a dangling end. This is what lets the Familiar reason over
  // consequence instead of a flat list.
  const nodeLabel = new Map();
  for (const n of scheduleNodes) { if (n?.id) nodeLabel.set(n.id, n.label ?? n.id); }
  const edges = Array.isArray(schedule.edges) ? schedule.edges : [];
  const linkLines = [];
  for (const e of edges) {
    const a = nodeLabel.get(e.src);
    const b = nodeLabel.get(e.dst);
    if (!a || !b) continue;
    const tag = consequenceTag(e.payload);
    if (e.kind === 'co_occurs_with') {
      linkLines.push(`  ${a} — co-occurs — ${b}${tag || ' [noticed]'}`);
    } else {
      linkLines.push(`  ${a} → ${EDGE_VERB[e.kind] ?? e.kind} → ${b}${tag}`);
    }
  }
  if (linkLines.length) {
    blocks.push(['Consequence links — how my human\'s scheduled items bear on each other:', ...linkLines].join('\n'));
  }

  const idLegend = [];
  const seenScheduleIds = new Set();
  for (const n of scheduleNodes) {
    if (!n?.id || seenScheduleIds.has(n.id)) continue;
    seenScheduleIds.add(n.id);
    idLegend.push(`  ${n.label ?? n.id} [${n.type ?? 'task'}] = ${n.id}`);
  }
  if (idLegend.length) {
    blocks.push([
      '[schedule ids — to give a floating task a time (schedule_assign_time), park one (schedule_snooze_task), mark one done/cancelled (schedule_resolve), remove one entirely incl. a phase (schedule_delete), or connect two so I see how they bear on each other (schedule_link), pass the id(s)]',
      ...idLegend,
    ].join('\n'));
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
