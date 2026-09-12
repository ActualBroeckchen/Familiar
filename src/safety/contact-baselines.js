/**
 * contact-baselines.js — a model of "normal contact rhythm," in code.
 *
 * Initiative build spec, Pass 2. The ward's partner worries after a day of
 * absence because he *holds her rhythm* — he knows a quiet Tuesday morning
 * is ordinary and a quiet Saturday afternoon is not. A snapshot can't hold
 * that: every deliberation today sees only "last around N hours ago," with
 * no sense of whether N is ordinary. This module turns the contact history
 * the system already records into arithmetic: typical gap, long-but-ordinary
 * gap (p90), longest seen — per ward-local weekday-class.
 *
 * It changes no behaviour on its own. It produces *deviation facts* consumed
 * by exactly two surfaces:
 *   - the warm reach-out prompt's rhythm line (Pass 0's silence line gains
 *     "our usual rhythm is …" once a baseline exists), and
 *   - the noticing tick's situation report (Pass 4).
 * Triage and surface-candidates stay untouched — triage has the threat tier;
 * baselines are companionship territory, not a safety signal.
 *
 * Honesty rule (non-negotiable): below a minimum history the module reports
 * `hasBaseline: false` and consumers render NOTHING. A fabricated rhythm is
 * worse than no rhythm — it would let the Familiar assert "this is unusual
 * for us" on two data points.
 *
 * Ward-contact signal (conservative by design): a contact timestamp is a
 * `role:'user'` message from a session that is unambiguously the ward's —
 * web-chat sessions (no audienceTag) and Discord ward-DM sessions
 * (audienceTag === 'ward-private'). Group-room messages are never counted,
 * so a villager can never be mistaken for the ward. This is exactly the
 * "rhythm with my human" signal; it under-counts (a ward who lives in a
 * group channel) rather than over-counts, which is the safe direction for a
 * "should I worry about their silence" input.
 *
 * No loop, no LLM call: recomputed lazily on read, cached in
 * tomes/.contact-baselines.json and refreshed at most every few hours.
 * Off-switch: settings `contactBaselinesEnabled` (default ON) or
 * PROTO_FAMILIAR_BASELINES_DISABLED=1 — disabled means no baseline is ever
 * reported, so every consumer renders nothing.
 *
 * Exports never throw — a baseline is an enrichment, never load-bearing.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsp, readFileSync } from 'fs';

import { REPO_ROOT } from '../../repo-root.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOGS_DIR  = path.join(REPO_ROOT, 'logs');
const DEFAULT_TOMES_DIR = path.join(REPO_ROOT, 'tomes');
const SETTINGS_FILE     = path.join(REPO_ROOT, 'settings.json');
const CACHE_FILENAME    = '.contact-baselines.json';

const DAY_MS = 24 * 60 * 60_000;

// Tunables (fixed in code — these shape the meaning of "a gap," not a ward
// preference). A rolling four-week window; timestamps within COALESCE_MS of
// each other are the SAME contact episode (a burst of messages then quiet is
// one contact, and the absence that matters is the gap AFTER it); a class
// needs at least MIN_SAMPLES observed gaps and the data must span at least
// MIN_SPAN_DAYS before any baseline is reported.
export const WINDOW_MS      = 28 * DAY_MS;
const COALESCE_MS    = 3 * 60 * 60_000;   // 3h — one contact "episode"
const MIN_SAMPLES    = 4;                 // gaps per class before it counts
export const MIN_SPAN_DAYS  = 14;
const CACHE_REFRESH_MS      = 3 * 60 * 60_000;   // recompute at most every ~3h

function cacheFile(tomesDir) { return path.join(tomesDir, CACHE_FILENAME); }

/** Feature gate: env hard-off wins; settings key defaults ON. */
export function isBaselinesEnabled(settings = null) {
  if (process.env.PROTO_FAMILIAR_BASELINES_DISABLED === '1') return false;
  let s = settings;
  if (!s) { try { s = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')); } catch { s = {}; } }
  return s?.contactBaselinesEnabled !== false;
}

// ── Pure helpers (unit-tested on fixture timestamp sets) ─────────────

/**
 * Ward-local weekday-class of a moment. 'weekend' = Sat/Sun in the ward's
 * zone; 'weekday' otherwise. Uses Intl so it's DST- and zone-correct
 * (wardTimeZone may differ from the server's). Falls back to server-local
 * when no zone is given (the co-located install).
 */
export function weekdayClass(ms, timeZone = null) {
  let dow;
  if (timeZone) {
    try {
      const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(ms));
      dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd] ?? new Date(ms).getDay();
    } catch { dow = new Date(ms).getDay(); }
  } else {
    dow = new Date(ms).getDay();
  }
  return (dow === 0 || dow === 6) ? 'weekend' : 'weekday';
}

/** Collapse near-together timestamps into contact episodes [{start,end}]. */
export function coalesceEpisodes(sortedMs, coalesceMs = COALESCE_MS) {
  const episodes = [];
  for (const t of sortedMs) {
    const last = episodes[episodes.length - 1];
    if (last && t - last.end <= coalesceMs) last.end = t;
    else episodes.push({ start: t, end: t });
  }
  return episodes;
}

/**
 * Absence gaps between consecutive episodes: the quiet stretch from one
 * episode's end to the next episode's start. `startMs` is when the quiet
 * began (used to classify the gap by weekday-class — "how long is she
 * usually away when she goes quiet at this kind of time").
 */
export function episodeGaps(episodes) {
  const gaps = [];
  for (let i = 1; i < episodes.length; i++) {
    gaps.push({ gapMs: episodes[i].start - episodes[i - 1].end, startMs: episodes[i - 1].end });
  }
  return gaps;
}

/** Linear-interpolated percentile of an ascending-sorted numeric array. */
export function percentile(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  if (n === 1) return sortedAsc[0];
  const rank = p * (n - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (rank - lo);
}

/**
 * Compute the baseline from ward-contact timestamps (ms). Pure — all inputs
 * explicit. Returns:
 *   { hasBaseline, spanDays, episodeCount,
 *     classes: { weekday: {hasBaseline, medianGapMs, p90GapMs, longestGapMs, sampleCount},
 *                weekend: {…} } }
 * hasBaseline (top level) is true only when the data spans ≥ MIN_SPAN_DAYS
 * AND at least one class has enough samples. Each class carries its own
 * hasBaseline so a consumer can honestly say nothing for a class that's thin
 * even when the other is rich.
 */
export function computeBaseline(timestampsMs, {
  now = Date.now(),
  timeZone = null,
  windowMs = WINDOW_MS,
  coalesceMs = COALESCE_MS,
  minSamples = MIN_SAMPLES,
  minSpanDays = MIN_SPAN_DAYS,
} = {}) {
  const cutoff = now - windowMs;
  const inWindow = (Array.isArray(timestampsMs) ? timestampsMs : [])
    .filter(t => Number.isFinite(t) && t >= cutoff && t <= now)
    .sort((a, b) => a - b);

  const emptyClass = () => ({ hasBaseline: false, medianGapMs: null, p90GapMs: null, longestGapMs: null, sampleCount: 0 });
  const result = { hasBaseline: false, spanDays: 0, episodeCount: 0, classes: { weekday: emptyClass(), weekend: emptyClass() } };
  if (inWindow.length < 2) return result;

  result.spanDays = (inWindow[inWindow.length - 1] - inWindow[0]) / DAY_MS;

  const episodes = coalesceEpisodes(inWindow, coalesceMs);
  result.episodeCount = episodes.length;
  const gaps = episodeGaps(episodes);

  const byClass = { weekday: [], weekend: [] };
  for (const g of gaps) byClass[weekdayClass(g.startMs, timeZone)].push(g.gapMs);

  const spanOk = result.spanDays >= minSpanDays;
  for (const cls of ['weekday', 'weekend']) {
    const arr = byClass[cls].slice().sort((a, b) => a - b);
    const c = result.classes[cls];
    c.sampleCount = arr.length;
    if (spanOk && arr.length >= minSamples) {
      c.hasBaseline  = true;
      c.medianGapMs  = percentile(arr, 0.5);
      c.p90GapMs     = percentile(arr, 0.9);
      c.longestGapMs = arr[arr.length - 1];
    }
  }
  result.hasBaseline = result.classes.weekday.hasBaseline || result.classes.weekend.hasBaseline;
  return result;
}

// ── I/O: gather ward-contact timestamps from session logs ────────────

/** A session is the ward's iff it's a web session (no audienceTag) or a
 *  Discord ward-DM (audienceTag === 'ward-private'). Group rooms never
 *  qualify — a villager must never be counted as the ward. */
export function isWardSession(session) {
  const tag = session?.audienceTag;
  return !tag || tag === 'ward-private';
}

/**
 * Read ward-contact timestamps (ms) within the window from the session
 * logs. Never throws — a bad file is skipped, an unreadable dir yields [].
 */
export async function readWardContactTimestamps({ logsDir = DEFAULT_LOGS_DIR, now = Date.now(), windowMs = WINDOW_MS } = {}) {
  const cutoff = now - windowMs;
  const out = [];
  let files;
  try { files = (await fsp.readdir(logsDir)).filter(f => f.endsWith('.json')); }
  catch { return out; }
  for (const f of files) {
    try {
      const data = JSON.parse(await fsp.readFile(path.join(logsDir, f), 'utf8'));
      if (!isWardSession(data) || !Array.isArray(data.messages)) continue;
      for (const m of data.messages) {
        if (m?.role !== 'user' || !m.timestamp) continue;
        const t = Date.parse(m.timestamp);
        if (Number.isFinite(t) && t >= cutoff && t <= now) out.push(t);
      }
    } catch { /* skip corrupt session file */ }
  }
  out.sort((a, b) => a - b);
  return out;
}

// ── Cache-aware read ─────────────────────────────────────────────────

async function readCache(tomesDir) {
  try { return JSON.parse(await fsp.readFile(cacheFile(tomesDir), 'utf8')); }
  catch { return null; }
}

async function writeCache(tomesDir, payload) {
  try {
    await fsp.mkdir(tomesDir, { recursive: true });
    const f = cacheFile(tomesDir), tmp = f + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await fsp.rename(tmp, f);
  } catch { /* cache is an optimisation; a write failure just means recompute next time */ }
}

/**
 * The main entry: the current contact baseline, cached. Recomputes at most
 * every CACHE_REFRESH_MS; otherwise serves the cached result. Returns
 * `{ hasBaseline: false, disabled: true }` when the feature is off, so every
 * consumer renders nothing. Never throws.
 */
export async function getContactBaseline({
  now = Date.now(),
  timeZone = undefined,          // undefined → read wardTimeZone from settings
  logsDir = DEFAULT_LOGS_DIR,
  tomesDir = DEFAULT_TOMES_DIR,
  settings = null,
  force = false,
} = {}) {
  let s = settings;
  if (!s) { try { s = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')); } catch { s = {}; } }
  if (!isBaselinesEnabled(s)) return { hasBaseline: false, disabled: true };
  const tz = timeZone !== undefined ? timeZone : (s?.wardTimeZone || null);

  try {
    if (!force) {
      const cached = await readCache(tomesDir);
      if (cached && Number.isFinite(cached.computedAt) && (now - cached.computedAt) < CACHE_REFRESH_MS && cached.result) {
        return cached.result;
      }
    }
    const timestamps = await readWardContactTimestamps({ logsDir, now });
    const result = computeBaseline(timestamps, { now, timeZone: tz });
    await writeCache(tomesDir, { computedAt: now, result });
    return result;
  } catch {
    return { hasBaseline: false };
  }
}

// ── Consumer helper: the Pass 0 rhythm line ──────────────────────────

// Machine-formatted gap phrase ("about 2 hours", "a day", "3 days"). Rounds
// generously — a rhythm is approximate by nature, and this never feeds a
// machine-exact surface. Kept local (not relative-time's plainInterval)
// because that clamps sub-hour to "less than a minute"-style precision the
// rhythm line doesn't want.
function roughInterval(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const hours = ms / 3_600_000;
  if (hours < 1.5)  return 'about an hour';
  if (hours < 20)   return `about ${Math.round(hours)} hours`;
  const days = ms / DAY_MS;
  if (days < 1.5)   return 'about a day';
  if (days < 13)    return `about ${Math.round(days)} days`;
  const weeks = days / 7;
  return weeks < 1.5 ? 'about a week' : `about ${Math.round(weeks)} weeks`;
}

/**
 * The rhythm line the warm reach-out prompt appends to its silence line —
 * or '' when there is no honest baseline for the relevant weekday-class (so
 * the prompt stays byte-identical to its pre-baseline shape). The class is
 * chosen by WHEN the ward went quiet (`lastContactMs`), which is the moment
 * the "is this gap unusual?" question is really about. `now` is unused today
 * but kept in the signature for symmetry with the other builders.
 */
export function buildRhythmLine(baseline, { lastContactMs, timeZone = null } = {}) {
  if (!baseline?.hasBaseline || !Number.isFinite(lastContactMs)) return '';
  const cls = weekdayClass(lastContactMs, timeZone);
  const c = baseline.classes?.[cls];
  if (!c?.hasBaseline) return '';
  const median = roughInterval(c.medianGapMs);
  const p90    = roughInterval(c.p90GapMs);
  if (!median) return '';
  const kind = cls === 'weekend' ? 'weekend' : 'weekday';
  const base = `- Our usual rhythm: on a ${kind} we're typically back in contact within ${median}`;
  return p90 ? `${base}; the longest ordinary ${kind} gap lately has been ${p90}.` : `${base}.`;
}
