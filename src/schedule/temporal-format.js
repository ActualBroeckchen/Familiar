import { relativeTime } from '../../relative-time.js';

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
// 📅 marks a Google-synced node; when it comes from a calendar attributed to
// someone OTHER than my human (a shared calendar — a villager's, a club's),
// the marker names them so the Familiar reads whose event it is.
function gcalMarkerFor(node) {
  if (node?.payload?.source !== 'gcal') return '';
  const a = node.payload?.gcal_attribution;
  if (a && a.kind && a.kind !== 'ward' && a.kind !== 'unassigned' && a.label) return ` 📅 ${a.label}`;
  return ' 📅';
}

// Render an intention's condition (the tiny tripwire vocab) as a readable
// clause the Familiar weighs before acting. '' when there's no condition.
// Pure. Mirrors the vocab in unruh/intention.py.
function formatIntentionCondition(condition) {
  if (!condition || typeof condition !== 'object') return '';
  const parts = [];
  if (Number.isFinite(condition.minContactGapMs)) {
    const h = condition.minContactGapMs / 3_600_000;
    const gap = h >= 1 ? `${h % 1 === 0 ? h : h.toFixed(1)}h` : `${Math.round(condition.minContactGapMs / 60_000)}min`;
    parts.push(`we haven't talked in at least ${gap}`);
  }
  if (condition.needsStatus) parts.push(`a referenced need is "${condition.needsStatus}"`);
  if (condition.unresolvedRefs) parts.push('a referenced item is still open');
  return parts.join(' and ');
}

// Salvage a wall-clock "HH:MM" out of a time string Date can't parse — a bare
// "23:00:00", or a legacy UTC artifact like "T13:00:00+00:00" (an old
// offset-stamped, date-less value from before the local-naive migration). The
// offset is dropped on purpose: routine phases are the ward's local wall-clock,
// so 13:00 is what they configured. Returns null if there's no HH:MM to find.
function hhmmFromString(s) {
  const m = String(s).match(/(?:^|T)(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return `${String(parseInt(m[1], 10)).padStart(2, '0')}:${m[2]}`;
}

function formatLocalTime(iso, opts = {}) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    // Unparseable (a date-less "HH:MM:SS" or a mangled "T…+00:00" artifact).
    // Salvage the wall-clock HH:MM so the rhythm never leaks a raw token.
    return hhmmFromString(iso) || iso;
  }
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
    // Minute-of-day for a phase's start/end, robust to the date-less/artifact
    // time strings (falls back to the salvaged HH:MM). -1 when nothing parses.
    const minsOfDay = (whenStr) => {
      const d = new Date(whenStr);
      if (!Number.isNaN(d.getTime())) return d.getHours() * 60 + d.getMinutes();
      const hhmm = hhmmFromString(whenStr);
      if (!hhmm) return -1;
      const [h, m] = hhmm.split(':').map(Number);
      return h * 60 + m;
    };
    const nowD = new Date();
    const nowMins = nowD.getHours() * 60 + nowD.getMinutes();
    const durMarker = (mins) => {
      if (mins < 60) return `${mins}min`;
      const h = Math.floor(mins / 60), m = mins % 60;
      return m ? `${h}h ${m}min` : `${h}h`;
    };
    const rhythm = routine
      .slice()
      .map(p => ({ p, startMins: minsOfDay(p.when), endMins: minsOfDay(p.end) }))
      .sort((a, b) => a.startMins - b.startMins)
      .map(({ p, startMins, endMins }) => {
        const start = formatLocalTime(p.when, { timeOnly: true });
        const end   = formatLocalTime(p.end,  { timeOnly: true });
        const texture = p.payload?.texture ? ` — ${p.payload.texture}` : '';
        // Where this phase sits relative to now, so passed and upcoming phases
        // read as such instead of a flat list. The current phase (Unruh's own
        // time-of-day computation) wins; otherwise start-of-day ordering decides.
        let marker;
        if (phase && p.id === phase.id) marker = '  ← I am here';
        else if (startMins > nowMins) marker = `  · begins in ${durMarker(startMins - nowMins)}`;
        else if (endMins >= 0 && endMins <= nowMins) marker = `  · ended ${durMarker(nowMins - endMins)} ago`;
        else marker = '  · earlier today';
        return `  ${start}–${end}  ${p.label ?? p.id}${texture}${marker}`;
      });
    blocks.push(["Today's rhythm:", ...rhythm].join('\n'));
  }

  const window = schedule.window ?? [];
  if (phase || window.length) {
    // Group window items so the Familiar reads them as distinct
    // categories with different weight: upcoming (time-anchored,
    // unresolved), open tasks (my human committed to these, no time
    // yet, not done), resolved (recently terminal — usually noise
    // but useful when the Familiar wants to acknowledge a finish).
    const nowMs = Date.now();
    const nowDate = new Date(nowMs);
    // A cancelled item, or one resolved more than this long ago, is noise in the
    // briefing — it surfaces only if my human brings it up. Keep "recently
    // resolved" to GENUINELY recent finishes, never a future or days-old one.
    const RESOLVE_RECENT_MS = 12 * 3600 * 1000;
    const resolvedRecently = (item) => {
      const ts = item.updated_at ? Date.parse(item.updated_at)
               : item.when ? Date.parse(item.when) : NaN;
      if (!Number.isFinite(ts)) return false;      // no signal → don't clutter
      const age = nowMs - ts;
      return age >= 0 && age <= RESOLVE_RECENT_MS; // recent PAST only
    };
    // Collapse exact duplicates (same label at the same time) — a Google-synced
    // node next to a hand-added twin shouldn't render two or three times.
    const seen = new Set();
    const isDup = (item) => {
      const key = `${(item.label ?? item.id ?? '').toLowerCase()}|${item.when ?? item.fires_at ?? ''}`;
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    };

    const upcoming  = [];
    const openTasks = [];
    const reminders = [];
    const resolved  = [];
    const elapsed   = [];
    for (const item of window) {
      // Phases live in "Today's rhythm", never repeated here.
      if (item.type === 'phase') continue;
      if (item.resolution) {
        // Cancelled leaves the briefing entirely; other resolutions show only
        // while genuinely recent (and never a future occurrence).
        if (item.resolution !== 'cancelled' && resolvedRecently(item) && !isDup(item)) resolved.push(item);
        continue;
      }
      if (isDup(item)) continue;
      // An elapsed-stamped event (piece 4) came and went without a word — it
      // must never read as still coming, so it gets its own group instead of
      // landing under "Coming days" with an "N days ago" time.
      if (item.payload?.elapsed_at) { elapsed.push(item); continue; }
      if (item.type === 'reminder') { reminders.push(item); continue; }
      if (item.when || item.end) { upcoming.push(item); continue; }
      // type=='task' with no when_ts → open task on the radar.
      openTasks.push(item);
    }

    // Each timed item is rendered through relativeTime() so the
    // Familiar reads "tomorrow at 10am" / "yesterday at 4pm" / "in 30
    // minutes" rather than an ISO timestamp. Recomputed every turn
    // against `nowMs` (defined above), the same moment used for "Now" at
    // the top of dynamic — the model perceives a consistent present.
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
    // Obstacle tags (stewardship Pass 2) rendered as ⟨outside⟩ so I can see
    // which items carry a real barrier for my human — and know a tag is set.
    const obstacleSuffix = (item) => {
      const t = Array.isArray(item.payload?.obstacle_tags) ? item.payload.obstacle_tags.filter(Boolean) : [];
      return t.length ? ` ⟨${t.join(', ')}⟩` : '';
    };
    // Split what's still to come TODAY from future days, so a day-away event is
    // never read as happening in the current phase/window. Each line still
    // carries its own relative time ("tomorrow at 3:30pm", "in 6 days").
    const isToday = (whenIso) => {
      const d = new Date(whenIso);
      if (Number.isNaN(d.getTime())) return false;
      return d.getFullYear() === nowDate.getFullYear()
        && d.getMonth() === nowDate.getMonth() && d.getDate() === nowDate.getDate();
    };
    const renderTimed = (item) => {
      const when = renderWhen(item.when ?? item.fires_at ?? '');
      const whenText = when ? `${when} — ` : '';
      const type = item.type ? `[${item.type}] ` : '';
      // 📅 marks an item the Google-Calendar sync manages (§5) — the Familiar
      // can tell which fields aren't its to hand-edit; a shared calendar also
      // names whose it is.
      return `  ${whenText}${type}${item.label ?? item.id ?? ''}${gcalMarkerFor(item)}${obstacleSuffix(item)}`;
    };
    const laterToday = upcoming.filter(it => isToday(it.when ?? it.fires_at ?? ''));
    const comingDays = upcoming.filter(it => !isToday(it.when ?? it.fires_at ?? ''));
    if (laterToday.length) {
      schedLines.push('Still to come today:');
      for (const item of laterToday) schedLines.push(renderTimed(item));
    }
    if (comingDays.length) {
      schedLines.push('Coming days:');
      for (const item of comingDays) schedLines.push(renderTimed(item));
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
      // commitments my human is counting on them to act on, not a
      // passive list to perceive.
      schedLines.push("Open tasks I'm holding for my human — mine to remember and to raise (no completion confirmed):");
      for (const item of openTasks) {
        // How long it's floated unscheduled — the signal that it's waiting to be
        // pinned to a real time. (created_at rides in from Unruh; a task without
        // one just renders bare.)
        const created = item.created_at ? new Date(item.created_at).getTime() : NaN;
        const floatDays = Number.isFinite(created)
          ? Math.floor((nowMs - created) / (24 * 3600 * 1000)) : null;
        const ageTag = (floatDays != null && floatDays >= 1) ? ` (floating ${floatDays}d — no time set)` : '';
        schedLines.push(`  - ${item.label ?? item.id ?? ''}${ageTag}${obstacleSuffix(item)}`);
      }
    }
    if (elapsed.length) {
      schedLines.push("Past events with no word on how they went — still open, not forgotten:");
      for (const item of elapsed) {
        const when = renderWhen(item.when ?? item.fires_at ?? '');
        const whenText = when ? `${when} — ` : '';
        schedLines.push(`  ${whenText}${item.label ?? item.id ?? ''}${gcalMarkerFor(item)}`);
      }
    }
    if (resolved.length) {
      schedLines.push('Just wrapped up (recent):');
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
    blocks.push(["Needs today — basic-needs windows I'm tracking for my human (met / open / missed):", ...needLines].join('\n'));
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
    // Linked endpoints — nodes that are NOT in the time window but are an
    // endpoint of some edge (undated consequence states, out-of-window
    // recurring anchors). Unruh sends them precisely so no edge ever has a
    // dangling end here; without them every consequence edge went invisible
    // once its state endpoint scrolled out of the window (~12h after
    // authoring — the "causal system doesn't work" defect).
    ...(Array.isArray(schedule.linked) ? schedule.linked : []),
  ];
  // Consequence links — the edges of the schedule graph. The both-endpoints
  // guard below stays as a last-resort safety net (a truly missing node
  // must not render as a dangling arrow), but with `linked` in the label
  // map it should never fire in practice.
  const nodeLabel = new Map();
  for (const n of scheduleNodes) { if (n?.id) nodeLabel.set(n.id, n.label ?? n.id); }
  const edges = Array.isArray(schedule.edges) ? schedule.edges : [];

  // Retire SETTLED consequence links so the map stays a picture of live pressure,
  // not history. A node is settled when it's resolved, or it's a dated event
  // whose time is well past (>24h) — its predicted futures are decided, not
  // pending. We then close over `requires` edges: a whole prerequisite chain
  // hanging off a settled node is settled too (the therapy-paperwork clutter — a
  // dozen "requires"/"on-lapse" links for an appointment that was two weeks ago,
  // which linger because nothing auto-resolves a past event). Pure derivation:
  // it hides stale links from the briefing, it never deletes an edge or a node.
  const STALE_PAST_MS = 24 * 3600 * 1000;
  const nowForLinks = Date.now();
  const settled = new Set();
  for (const n of scheduleNodes) {
    if (!n?.id) continue;
    const ms = n.when ? Date.parse(n.when) : NaN;
    if (n.resolution || (Number.isFinite(ms) && ms < nowForLinks - STALE_PAST_MS)) settled.add(n.id);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of edges) {
      if (e.kind !== 'requires') continue;
      if (settled.has(e.src) && !settled.has(e.dst)) { settled.add(e.dst); grew = true; }
      if (settled.has(e.dst) && !settled.has(e.src)) { settled.add(e.src); grew = true; }
    }
  }

  const linkLines = [];
  const linkedRefIds = new Set();   // node ids that survive in a VISIBLE link
  for (const e of edges) {
    const a = nodeLabel.get(e.src);
    const b = nodeLabel.get(e.dst);
    if (!a || !b) continue;
    if (settled.has(e.src) || settled.has(e.dst)) continue;   // history, not live pressure
    linkedRefIds.add(e.src);
    linkedRefIds.add(e.dst);
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

  // ── Recently past, unexamined (causal-chain fix, piece 2) ────────
  // An event whose time just passed and that still carries un-graded
  // forecasts is at the one moment a forecast can be checked against what
  // actually happened — while my human can still remember the answer.
  // Pure derivation, same class as the settled-links retirement above:
  // events with when/end in [now − 72h, now] whose consequence edges are
  // still unobserved, rendered as questions with the edge id so the
  // answer is actionable (schedule_calibrate_link). Capped at 3 lines;
  // a line drops when its edge is graded observed or the window closes.
  const HINDSIGHT_MS = 72 * 3600 * 1000;
  const isUngraded = (p) => p && typeof p === 'object'
    && (p.valence || p.condition || p.certainty) && p.observed !== true;
  const hindsightEdges = new Map();   // node id → its ungraded consequence edges
  for (const e of edges) {
    if (!e?.id || !isUngraded(e.payload)) continue;
    for (const end of [e.src, e.dst]) {
      if (!hindsightEdges.has(end)) hindsightEdges.set(end, []);
      hindsightEdges.get(end).push(e);
    }
  }
  const hindsightLines = [];
  const seenHindsight = new Set();
  for (const n of scheduleNodes) {
    if (hindsightLines.length >= 3) break;
    if (!n?.id || seenHindsight.has(n.id) || n.type !== 'event') continue;
    seenHindsight.add(n.id);
    const t = Date.parse(n.when ?? n.end ?? '');
    if (!Number.isFinite(t) || t > nowForLinks || nowForLinks - t > HINDSIGHT_MS) continue;
    const nodeEdges = hindsightEdges.get(n.id);
    if (!nodeEdges?.length) continue;
    const rel = relativeTime(n.when ?? n.end, nowForLinks) || formatLocalTime(n.when ?? n.end);
    for (const e of nodeEdges) {
      if (hindsightLines.length >= 3) break;
      const a = nodeLabel.get(e.src) ?? e.src;
      const b = nodeLabel.get(e.dst) ?? e.dst;
      const res = n.resolution ? ` [${n.resolution}]` : (n.payload?.elapsed_at ? ' [never marked done]' : '');
      hindsightLines.push(`  ${n.label ?? n.id} was ${rel}${res} — I projected: ${a} → ${EDGE_VERB[e.kind] ?? e.kind} → ${b}${consequenceTag(e.payload)}. Did that follow? (edge: ${e.id})`);
    }
  }
  if (hindsightLines.length) {
    blocks.push([
      'Recently past, not yet examined — forecasts whose moment has come:',
      ...hindsightLines,
      "  Before I ask how one of these went, I check my recent memories and what we've said lately — if my human already told me, I do NOT re-ask like I forgot; I grade the forecast with schedule_calibrate_link (the edge id above): observed if it really happened, certainty up or down. Only if I don't know yet is asking natural, while it's still fresh.",
    ].join('\n'));
  }

  // Legend = ids the Familiar might act on. Two prunes keep it from ballooning:
  // resolved nodes (done — nothing to act on), and orphaned link endpoints — a
  // `linked` state/anchor (e.g. "guilt crash", "therapy discontinued") that
  // Unruh sends only to complete an edge, but whose every edge was just retired
  // as settled. Those states were the bulk of the oversized legend. Live
  // schedule items (routine + window) always stay, addressable by id.
  const routineIds = new Set((Array.isArray(payload.routine) ? payload.routine : []).map(n => n?.id).filter(Boolean));
  const windowIds  = new Set((Array.isArray(schedule.window) ? schedule.window : []).map(n => n?.id).filter(Boolean));
  const idLegend = [];
  const seenScheduleIds = new Set();
  let anyGcal = false;
  for (const n of scheduleNodes) {
    if (!n?.id || seenScheduleIds.has(n.id)) continue;
    seenScheduleIds.add(n.id);
    if (n.resolution) continue;   // resolved → not an action surface
    // A pure link endpoint (in `linked`, not part of the live schedule) with no
    // surviving visible link is orphaned — drop it.
    if (!routineIds.has(n.id) && !windowIds.has(n.id) && !linkedRefIds.has(n.id)) continue;
    if (n.payload?.source === 'gcal') anyGcal = true;
    idLegend.push(`  ${n.label ?? n.id} [${n.type ?? 'task'}]${gcalMarkerFor(n)} = ${n.id}`);
  }
  if (idLegend.length) {
    blocks.push([
      '[schedule ids — to give a floating task a time (schedule_assign_time), park one (schedule_snooze_task), mark one done/cancelled (schedule_resolve), remove one entirely incl. a phase (schedule_delete), or connect two so I see how they bear on each other (schedule_link), pass the id(s). Anything NOT listed here — an appointment months out, an old series — I find with schedule_find(name)]',
      ...idLegend,
      // §5 legibility: a 📅 item is externally managed. Not forbidden — the
      // sync just owns its time/title (a hand-edit there loses on the next
      // reconcile, and a Google item isn't a task to resolve). I add
      // consequence links, export it, and reason about it freely.
      ...(anyGcal ? ['  (📅 = from my human\'s Google Calendar — the sync owns its time/title; I add consequence links and export it, but hand-edits to those fields get overwritten on the next sync)'] : []),
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
      // These feed the pondering loop — they're what I keep being drawn to think
      // about, character not task. The raw engagement WEIGHT is machinery, not
      // something I need in my working context: I show the top few as plain
      // labels (heaviest first), no numbers, so the surface stays light.
      interestLines.push('Lately I keep being drawn to think about:');
      const topLive = [...live]
        .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
        .slice(0, 6);
      for (const i of topLive) interestLines.push(`  ${i.label ?? i.id}`);
    }
    blocks.push(interestLines.join('\n'));
  }

  // ── Intentions coming due (Initiative Pass 3) ────────────────────
  // The intentions whose trigger timing has come around — a payoff turn.
  // The marker string travels with the intentions tool module (tool-
  // surfacing), so the tools to act (mark fired / complete / adjust) are
  // in hand this turn. Each carries its `why` (what I was reaching for) and
  // any condition as a readable clause I weigh before acting — I don't act
  // on a round whose condition plainly doesn't hold. Empty → nothing.
  const due = Array.isArray(payload.intentions_due) ? payload.intentions_due : [];
  if (due.length) {
    const dueLines = ['[Intentions coming due] — commitments I set my future self; the tools to see to them are in hand:'];
    for (const it of due) {
      const cond = formatIntentionCondition(it.condition);
      const why  = it.why ? ` — because ${it.why}` : '';
      dueLines.push(`  (${it.id}) ${it.what}${why}${cond ? ` [only if ${cond}]` : ''}`);
    }
    dueLines.push('  When I\'ve seen to one this occurrence, I mark it (intention_mark_fired); when it\'s done for good, intention_done. Marking without doing is erasing, not acting.');
    blocks.push(dueLines.join('\n'));
  }

  return blocks.join('\n\n');
}
