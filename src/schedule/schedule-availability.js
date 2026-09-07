/**
 * Coarse availability (stewardship Pass 4, villager scheduling).
 *
 * A LABEL-FREE-by-construction free/busy view of my human's days, for
 * coordinating with a villager the ward has permitted (the `schedule` grant:
 * 'coarse' | 'full'). The derivation NEVER emits a label — it reports only
 * whether a day-part is free or busy — so nothing about WHAT fills my human's
 * time can leak through this path, regardless of what the model would say.
 * That structural guarantee is the privacy protection; the grant is the ward's
 * control over WHO gets coordinated with. A 'full' grant (a spouse, say) may
 * additionally see the actual upcoming items, since the ward chose to share
 * them; 'coarse' never does.
 *
 * Pure. Times are ward-local-naive (Unruh's model); lexical/naive comparison,
 * no timezone math here.
 */
import { relativeTime } from '../../relative-time.js';

// Day-parts. Outside 06:00–22:00 is "night" — not offered for coordination.
export const DAY_PARTS = [
  { key: 'morning',   start: 6 * 60,  end: 12 * 60 },
  { key: 'afternoon', start: 12 * 60, end: 17 * 60 },
  { key: 'evening',   start: 17 * 60, end: 22 * 60 },
];

const DAY_MS = 24 * 3600 * 1000;
const DEFAULT_BUSY_MINUTES = 60;   // a commitment with no end still blocks an hour

// Normalise Unruh's field spellings (schedule_get_window → when_ts/end_ts;
// temporal_context → when/end) and strip a stray offset to local-naive.
const startOf = (n) => String(n?.when ?? n?.when_ts ?? '').replace('Z', '').slice(0, 19);
const endOf   = (n) => String(n?.end ?? n?.end_ts ?? '').replace('Z', '').slice(0, 19);

// A node that OCCUPIES time (so a day-part is busy): an event or a hold —
// real commitments and ward-protected "keep free" blocks. Tasks/reminders are
// not time-blocking. Resolved/cancelled items don't count.
function isBusyNode(n) {
  return n && !n.resolution && (n.type === 'event' || n.type === 'hold') && startOf(n);
}

function dateAndMinutes(naive) {
  if (!naive || naive.length < 16) return null;
  const date = naive.slice(0, 10);
  const h = Number(naive.slice(11, 13)), m = Number(naive.slice(14, 16));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return { date, minutes: h * 60 + m };
}

/**
 * Free/busy per day-part across the next `days` ward-local days.
 * @returns {Array<{date, parts: {morning, afternoon, evening}}>} — each part
 *          'free' | 'busy'. Pure; no labels.
 */
export function computeAvailability(nodes = [], { nowMs = Date.now(), days = 7 } = {}) {
  // Enumerate the ward-local calendar days from today. We build date keys from
  // nowMs in the process-local zone (Unruh's now is already ward-local; the
  // caller passes a ward-anchored nowMs), matching how nodes' naive dates read.
  const out = [];
  const dayKeys = [];
  for (let i = 0; i < Math.max(1, days); i++) {
    const d = new Date(nowMs + i * DAY_MS);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    dayKeys.push(key);
    out.push({ date: key, parts: { morning: 'free', afternoon: 'free', evening: 'free' } });
  }
  const byDate = new Map(out.map(o => [o.date, o]));

  for (const n of nodes) {
    if (!isBusyNode(n)) continue;
    const raw = startOf(n);
    // A date-only start ("2026-07-06", ≤10 chars) is an all-day item — it has
    // no minutes to parse, only a day to occupy. Handle it BEFORE the
    // minute-parse so it can't fall through as unparseable.
    const allDay = !!(n.payload?.all_day) || raw.length <= 10;
    const s = dateAndMinutes(raw)
      ?? (allDay && raw.length >= 10 ? { date: raw.slice(0, 10), minutes: 0 } : null);
    if (!s) continue;
    const row = byDate.get(s.date);
    if (!row) continue;                       // outside the window
    const e = dateAndMinutes(endOf(n));
    const startMin = allDay ? 0 : s.minutes;
    // Same-day end only; a multi-day item marks its start day's remaining parts.
    const endMin = allDay ? 24 * 60
      : (e && e.date === s.date ? e.minutes : s.minutes + DEFAULT_BUSY_MINUTES);
    for (const part of DAY_PARTS) {
      if (startMin < part.end && endMin > part.start) row.parts[part.key] = 'busy';
    }
  }
  return out;
}

const dayName = (key) => {
  const d = new Date(`${key}T12:00:00`);
  return Number.isNaN(d.getTime()) ? key : d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
};

/** Render coarse free/busy rows (one per day) — no labels. Shared by the
 *  villager block and the Familiar's own schedule_availability check. */
export function formatAvailabilityLines(avail = []) {
  return avail.map(day => {
    const free = DAY_PARTS.filter(p => day.parts[p.key] === 'free').map(p => p.key);
    const busy = DAY_PARTS.filter(p => day.parts[p.key] === 'busy').map(p => p.key);
    if (!busy.length) return `  ${dayName(day.date)}: open`;
    if (!free.length) return `  ${dayName(day.date)}: full`;
    return `  ${dayName(day.date)}: ${free.join(' & ')} free`;
  });
}

/**
 * The availability block injected on a PERMITTED villager's DM turn (grant
 * 'coarse' | 'full'). First-person, literal "my human". Coarse free/busy only;
 * a 'full' grant appends the actual upcoming items (labels), which the ward
 * chose to share. Returns '' when the grant doesn't permit anything.
 */
export function buildAvailabilityBlock(nodes = [], { grant, nowMs = Date.now(), days = 7 } = {}) {
  if (grant !== 'coarse' && grant !== 'full') return '';
  const avail = computeAvailability(nodes, { nowMs, days });
  const lines = formatAvailabilityLines(avail);
  const parts = [
    `[Coordinating my human's schedule — this person is permitted to arrange time with them]`,
    `My human has allowed me to help arrange time with this person. I share only whether a stretch is FREE or BUSY — never what fills it — and I speak in broad day-parts (morning / afternoon / evening). If they propose a time, I check it against this and answer plainly ("that afternoon's taken; Thursday morning works"). If anything feels like it should go through my human directly, I say so. When we settle on something, I tell my human.`,
    `My human's next ${days} days (free/busy only):`,
    lines.join('\n'),
  ];
  if (grant === 'full') {
    const upcoming = nodes
      .filter(n => n && !n.resolution && (n.type === 'event' || n.type === 'hold') && startOf(n))
      .sort((a, b) => (startOf(a) < startOf(b) ? -1 : 1))
      .slice(0, 12)
      .map(n => `  - ${relativeTime(startOf(n), nowMs) || startOf(n)} — ${n.label ?? '(untitled)'}`);
    if (upcoming.length) parts.push(`They have full access, so I can also name what's on:`, upcoming.join('\n'));
  }
  return parts.join('\n');
}
