/**
 * Stewardship — the executive layer over the temporal world model
 * (docs/stewardship-build-spec.md, Pass 1).
 *
 * The temporal window, consequence graph, and needs ledger are truthful,
 * but injected every turn they habituate into scenery. This module is the
 * counter-move: cheap code selects a TINY, CONDITIONAL agenda (cap 3,
 * absent when nothing qualifies) and hands it to me as my own
 * responsibility this turn. Code chooses WHAT qualifies; I own HOW I raise
 * it — the voice, the timing, the angle. A block that renders every turn is
 * wallpaper, so the salience lives in the block's *absence* most turns.
 *
 * Every fact here is code-computed — days-floating, the inactivity gap, the
 * observed-first-contact median. I interpret and phrase; I never decide
 * whether a fact is true. That is the structural anti-enabling protection:
 * I cannot soften a record I don't author.
 *
 * State (the day's brief flag, docket rotation cursors, first-contact
 * samples) lives in tomes/.stewardship-state.json and is mutated ONLY on a
 * live turn, so a debug-prompt preview never fires a false opening. A
 * malformed state file or a missing schedule degrades every path to "" —
 * stewardship can never throw into the chat path.
 */
import path from 'path';
import { promises as fsp } from 'fs';
import { fileURLToPath } from 'url';
import { wardLocalNowISO } from '../../relative-time.js';
import { readWeatherMirrorSync } from '../weather/weather-mirror.js';
import { forecastAtHour, isAdverseHour, formatItemWeather } from '../weather/weather-format.js';

import { REPO_ROOT } from '../../repo-root.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOMES_DIR = path.join(REPO_ROOT, 'tomes');
const STATE_FILE = '.stewardship-state.json';

// Threat tiers at which stewardship stands down entirely: triage owns the
// moment, and care-about-days must never compete with care-about-safety.
// Same posture as warm reach-out and needs-tracking — this is deferral to
// the system that always acts, NOT a softening of it.
const TIER_RANK = { calm: 0, mild: 1, moderate: 2, high: 3, severe: 4 };
export function tierAtLeastModerate(tier) {
  return (TIER_RANK[tier] ?? 0) >= TIER_RANK.moderate;
}

const DAY_MS = 24 * 3600 * 1000;
const MAX_SAMPLES = 30;                 // first-contact ring buffer
const MIN_SAMPLES_FOR_ANCHOR = 14;      // days of data before I trust a rhythm
const ANCHOR_DRIFT_MIN = 90;            // minutes of drift before I suggest adopting
const DOCKET_COOLDOWN_MS = 3 * DAY_MS;  // a floater I offered rests before I re-offer it
const READINESS_COOLDOWN_MS = 6 * 3600 * 1000; // an unmet-prereq flag rests ~6h before I raise it again
const AGENDA_CAP = 3;

// ── pure time helpers ──────────────────────────────────────────────────
export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
const pad2 = (n) => String(n).padStart(2, '0');
export function minutesToHHMM(mins) {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}
/** Median first-contact time. Samples are all daytime (>= the anchor), so a
 *  plain numeric median never has to reason about the midnight wrap. */
export function medianHHMM(samples = []) {
  const mins = samples.map(parseHHMM).filter(v => v != null).sort((a, b) => a - b);
  if (!mins.length) return null;
  const mid = Math.floor(mins.length / 2);
  const med = mins.length % 2 ? mins[mid] : Math.round((mins[mid - 1] + mins[mid]) / 2);
  return minutesToHHMM(med);
}

/** Ward-local wall clock, split into the pieces the selectors need. Unruh
 *  timestamps are local-naive; I stay in that space and never round-trip a
 *  when-string through epoch+tz (that double-conversion is the reminder-bug
 *  class the repo warns about). */
function wardNowParts(wardTimeZone, nowMs) {
  const iso = wardLocalNowISO(wardTimeZone, nowMs); // 'YYYY-MM-DDTHH:MM:SS'
  return { iso, day: iso.slice(0, 10), hhmm: iso.slice(11, 16), nowMin: parseHHMM(iso.slice(11, 16)) ?? 0 };
}
// Normalise any stored when to a comparable local-naive 'YYYY-MM-DDTHH:MM:SS'
// (drop a stray trailing Z / milliseconds from legacy rows). Lexicographic
// order on these strings is chronological order.
const naive = (s) => String(s ?? '').replace('Z', '').slice(0, 19);

// ── pure selectors ─────────────────────────────────────────────────────
/** Floating tasks (type='task', no when, unresolved) past the age floor and
 *  outside their re-offer cooldown, oldest first. */
export function selectDocket({ items = [], nowMs = Date.now(), minAgeDays = 3, offeredAt = {}, cooldownMs = DOCKET_COOLDOWN_MS, max = 2 } = {}) {
  return items
    .filter(it => it && it.type === 'task' && !it.when && !it.resolution)
    .map(it => {
      const created = it.created_at ? new Date(naive(it.created_at)).getTime() : NaN;
      const ageDays = Number.isFinite(created) ? Math.floor((nowMs - created) / DAY_MS) : 0;
      return { id: it.id, label: it.label ?? it.id ?? '(untitled)', ageDays };
    })
    .filter(f => f.ageDays >= minAgeDays)
    .filter(f => {
      const last = Number(offeredAt[f.id]);
      return !Number.isFinite(last) || (nowMs - last) >= cooldownMs;
    })
    .sort((a, b) => b.ageDays - a.ageDays)
    .slice(0, Math.max(0, max));
}

/** The opening brief: dated items (events/tasks/reminders/holds) from now to
 *  the look-ahead horizon, in ward-local wall-clock. Pure. */
export function buildOpeningBrief({ items = [], nowMs = Date.now(), lookaheadDays = 3, wardTimeZone = null } = {}) {
  const lower = naive(wardLocalNowISO(wardTimeZone, nowMs - 3600e3)); // include the just-past hour
  const upper = naive(wardLocalNowISO(wardTimeZone, nowMs + lookaheadDays * DAY_MS));
  const dated = items
    .filter(it => it && !it.resolution && it.when && ['event', 'task', 'reminder', 'hold'].includes(it.type))
    .map(it => ({ label: it.label ?? '(untitled)', type: it.type, w: naive(it.when) }))
    .filter(it => it.w >= lower && it.w <= upper)
    .sort((a, b) => (a.w < b.w ? -1 : a.w > b.w ? 1 : 0))
    .slice(0, 8);
  if (!dated.length) {
    return `My human's just arrived. Nothing's on the calendar for the next ${lookaheadDays} days that I can see — a clear stretch.`;
  }
  const lines = dated.map(it => `  - ${it.w.slice(0, 10)} ${it.w.slice(11, 16)} — ${it.label} [${it.type}]`);
  return `My human's just arrived. Here's what's coming up over the next ${lookaheadDays} days:\n${lines.join('\n')}`;
}

/** Approaching events/tasks whose `requires` / `depends_on` prerequisites
 *  are still unresolved. Pure. Direction matches schedule_link: an edge
 *  reads "src requires dst", so for item E the prerequisites are the `dst`
 *  of edges whose `src` is E. Only prerequisites I can actually see in the
 *  window AND that are unresolved count — I never invent a blocker. */
export function selectReadiness({ items = [], edges = [], nowMs = Date.now(), wardTimeZone = null, leadHours = 48, flaggedAt = {}, cooldownMs = READINESS_COOLDOWN_MS, max = 2 } = {}) {
  const lower = naive(wardLocalNowISO(wardTimeZone, nowMs - 3600e3));
  const upper = naive(wardLocalNowISO(wardTimeZone, nowMs + leadHours * 3600e3));
  const byId = new Map();
  for (const it of items) if (it && it.id) byId.set(it.id, it);
  const out = [];
  for (const it of items) {
    if (!it || !it.id || it.resolution || !it.when) continue;
    if (!['event', 'task', 'reminder', 'hold'].includes(it.type)) continue;
    const w = naive(it.when);
    if (w < lower || w > upper) continue;
    const last = Number(flaggedAt[it.id]);
    if (Number.isFinite(last) && (nowMs - last) < cooldownMs) continue;
    const unmet = [];
    for (const e of edges) {
      if (!e || e.src !== it.id) continue;
      if (e.kind !== 'requires' && e.kind !== 'depends_on') continue;
      const prereq = byId.get(e.dst);
      if (prereq && !prereq.resolution) unmet.push(prereq.label ?? prereq.id ?? 'something');
    }
    if (!unmet.length) continue;
    const tags = Array.isArray(it.payload?.obstacle_tags) ? it.payload.obstacle_tags.filter(Boolean) : [];
    out.push({ id: it.id, label: it.label ?? '(untitled)', when: w, unmet, obstacleTags: tags });
  }
  out.sort((a, b) => (a.when < b.when ? -1 : a.when > b.when ? 1 : 0));  // soonest first
  return out.slice(0, Math.max(0, max));
}

// ── state I/O (never throws) ───────────────────────────────────────────
async function readState(tomesDir) {
  try { return JSON.parse(await fsp.readFile(path.join(tomesDir, STATE_FILE), 'utf8')) || {}; }
  catch { return {}; }
}
async function writeState(tomesDir, state) {
  const file = path.join(tomesDir, STATE_FILE);
  await fsp.mkdir(tomesDir, { recursive: true }).catch(() => {});
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

/** Read the stewardship state (e.g. so the reflection loop can check when the
 *  last routine review ran). Never throws — returns {} on any failure. */
export async function readStewardshipState(tomesDir = DEFAULT_TOMES_DIR) {
  return readState(tomesDir);
}

/**
 * Record the outcome of a weekly routine review (stewardship Pass 3): stamp
 * the cadence clock always, and stash the Familiar's finding for the block to
 * surface when present. Called from the reflection follow-through. A finding
 * shows for a few live turns (turnsLeft) so the Familiar can weave it in at a
 * good moment, then clears itself.
 */
export async function recordRoutineReview(finding, nowMs = Date.now(), tomesDir = DEFAULT_TOMES_DIR) {
  const state = await readState(tomesDir);
  state.routineReviewAt = nowMs;
  const text = (typeof finding === 'string' ? finding.trim() : '').slice(0, 500);
  if (text) state.routineReviewFinding = { text, turnsLeft: 3 };
  else delete state.routineReviewFinding;
  await writeState(tomesDir, state);
  return { ok: true };
}

/**
 * Assemble the stewardship block for this turn (or "" — the common case).
 * Orchestration only; the selection logic above is pure and unit-tested.
 *
 * @returns {Promise<string>} the block, or "" when nothing qualifies /
 *          stewardship is off / threat is moderate+.
 */
export async function buildStewardshipBlock(opts = {}) {
  const {
    liveTurn = false, staticOnly = false, threat = { tier: 'calm' },
    settings = {}, scheduleItems = [], scheduleEdges = [], lastUserMessageAt = null,
    wardTimeZone = null, nowMs = Date.now(), tomesDir = DEFAULT_TOMES_DIR,
  } = opts;

  if (staticOnly) return '';
  if (settings.stewardshipEnabled === false) return '';
  if (process.env.PROTO_FAMILIAR_STEWARDSHIP_DISABLED === '1') return '';
  if (tierAtLeastModerate(threat?.tier)) return '';   // triage owns moderate+

  const anchor = (typeof settings.dayStartAnchor === 'string' && parseHHMM(settings.dayStartAnchor) != null)
    ? settings.dayStartAnchor : '09:00';
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const gapHours     = num(settings.dayStartGapHours, 3);
  const lookaheadDays = num(settings.briefLookaheadDays, 3);
  const minAgeDays   = num(settings.docketMinAgeDays, 3);
  const readinessLeadHours = num(settings.readinessLeadHours, 48);

  const { day: today, hhmm: nowHHMM, nowMin } = wardNowParts(wardTimeZone, nowMs);
  const state = await readState(tomesDir);

  let brief = '';
  const bullets = [];
  let slots = AGENDA_CAP;
  let dirty = false;

  // 1. Opening brief — the first *real* contact of the ward-local day:
  //    past the day-start anchor AND after a genuine inactivity gap. Both
  //    conditions are load-bearing — the anchor stops a 00:30 "still up"
  //    message from opening the day; the gap stops a straight-through
  //    late-morning chat from re-opening it.
  const gapMs = lastUserMessageAt ? (nowMs - Date.parse(lastUserMessageAt)) : Infinity;
  const pastAnchor = nowMin >= (parseHHMM(anchor) ?? 540);
  const afterGap = !Number.isFinite(gapMs) || gapMs >= gapHours * 3600e3;
  if (pastAnchor && afterGap && state.briefFiredOn !== today) {
    brief = buildOpeningBrief({ items: scheduleItems, nowMs, lookaheadDays, wardTimeZone });
    slots -= 1;
    if (liveTurn) {
      state.briefFiredOn = today;
      // This first contact IS a data point for the observed rhythm.
      state.firstContactSamples = [...(state.firstContactSamples ?? []), nowHHMM].slice(-MAX_SAMPLES);
      dirty = true;
    }
  }

  // 2. Readiness — an approaching event whose prerequisites are still open.
  //    Time-sensitive, so it's NOT once-per-day gated; a per-event ~6h
  //    cooldown keeps it from nagging while I stay responsive.
  if (slots > 0) {
    const ready = selectReadiness({
      items: scheduleItems, edges: scheduleEdges, nowMs, wardTimeZone,
      leadHours: readinessLeadHours, flaggedAt: state.readinessFlaggedAt ?? {}, max: slots,
    });
    const mirror = readWeatherMirrorSync();   // rides the tick's cache; null when weather's off/absent
    for (const r of ready) {
      const tagNote = r.obstacleTags.length ? ` (this one means ${r.obstacleTags.join(', ')})` : '';
      // Outside-join: an outside-tagged item whose hour looks adverse in the
      // cached forecast carries a code-built weather note, so the prep nudge
      // is weather-aware. Only when the sky's genuinely worth flagging.
      const outside = r.obstacleTags.some(t => String(t).toLowerCase() === 'outside');
      let wxNote = '';
      if (outside && mirror) {
        const hour = forecastAtHour(mirror.hourly, Date.parse(r.when));
        if (hour && isAdverseHour(hour)) wxNote = ` — ${formatItemWeather(hour, settings.weatherUnit)}`;
      }
      bullets.push(`"${r.label}" (${r.when.slice(0, 10)} ${r.when.slice(11, 16)}) needs ${r.unmet.join(', ')} sorted first — still open${tagNote}${wxNote}. I check in while there's time.`);
    }
    slots -= ready.length;
    if (ready.length && liveTurn) {
      state.readinessFlaggedAt = { ...(state.readinessFlaggedAt ?? {}) };
      for (const r of ready) state.readinessFlaggedAt[r.id] = nowMs;
      dirty = true;
    }
  }

  // 3. Docket — aging floaters, at most once per ward-local day.
  if (state.docketOfferedOn !== today && slots > 0) {
    const picks = selectDocket({ items: scheduleItems, nowMs, minAgeDays, offeredAt: state.offeredAt ?? {}, max: slots });
    for (const f of picks) {
      bullets.push(`"${f.label}" has been floating without a time for ${f.ageDays} day${f.ageDays === 1 ? '' : 's'}. Today I either give it a time or find out what's in the way.`);
    }
    slots -= picks.length;
    if (picks.length && liveTurn) {
      state.docketOfferedOn = today;
      state.offeredAt = { ...(state.offeredAt ?? {}) };
      for (const f of picks) state.offeredAt[f.id] = nowMs;
      dirty = true;
    }
  }

  // 4. Routine review — a considered weekly finding about a slipping routine,
  //    authored in my own voice during a reflection tick. I raise it at a good
  //    moment; it shows for a few turns, then clears.
  if (slots > 0 && state.routineReviewFinding?.text) {
    bullets.push(state.routineReviewFinding.text);
    slots -= 1;
    if (liveTurn) {
      const left = Number(state.routineReviewFinding.turnsLeft) || 0;
      if (left <= 1) delete state.routineReviewFinding;
      else state.routineReviewFinding = { text: state.routineReviewFinding.text, turnsLeft: left - 1 };
      dirty = true;
    }
  }

  // 5. Anchor learning — once I've watched enough mornings, surface the drift
  //    so I can adopt my human's real rhythm via set_day_start_anchor.
  if (slots > 0 && (state.firstContactSamples?.length ?? 0) >= MIN_SAMPLES_FOR_ANCHOR && state.anchorSuggestedOn !== today) {
    const observed = medianHHMM(state.firstContactSamples);
    const drift = observed != null ? Math.abs((parseHHMM(observed) ?? 0) - (parseHHMM(anchor) ?? 0)) : 0;
    if (observed && drift >= ANCHOR_DRIFT_MIN) {
      bullets.push(`My human's mornings start near ${observed}; the day-start I open on is ${anchor}. If that's their rhythm now, I set it with set_day_start_anchor.`);
      if (liveTurn) { state.anchorSuggestedOn = today; dirty = true; }
    }
  }

  if (liveTurn && dirty) await writeState(tomesDir, state).catch(() => {});

  if (!brief && !bullets.length) return '';
  const parts = [
    `[My stewardship — what I'm holding for my human right now]`,
    `I raise these in my own voice, whenever it fits in our talk — but I do raise them; letting them slide has a cost too.`,
  ];
  if (brief) parts.push(brief);
  if (bullets.length) parts.push(bullets.map(s => `- ${s}`).join('\n'));
  return parts.join('\n');
}
