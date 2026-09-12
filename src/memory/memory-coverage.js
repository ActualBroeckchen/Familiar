/**
 * Per-day memory-coverage ledger.
 *
 * Records, for each local calendar date, how much of each session's
 * messages-on-that-date has been run through the memorization pipeline — so we
 * can tell a fully-memorized day from one with gaps or one that's uncertain
 * (a shared-room session, a failed extraction). See
 * docs/day-anchoring-build-spec.md.
 *
 * The ledger stores only what's been MEMORIZED (per session: memorizedThrough +
 * flag); what EXISTS is read live from the session logs at compute time. Status
 * is derived by comparing the two, so the active day shows "partial" the moment
 * new messages land, and a past day reads "complete" once its slice is done.
 *
 * Proto-Familiar-local (sessions are per-embodiment, like ponderings). Degrades
 * like every tome file: unreadable/missing → treated as empty, never throws.
 *
 * Path params (logsDir/ledgerFile) default to the real dirs; tests override them.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, promises as fsp } from 'fs';
import { segmentByDay } from '../schedule/day-segments.js';

import { REPO_ROOT } from '../../repo-root.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOMES_DIR = path.join(REPO_ROOT, 'tomes');
export const DEFAULT_LOGS_DIR = path.join(REPO_ROOT, 'logs');
const DEFAULT_LEDGER_FILE = path.join(TOMES_DIR, '.memory-coverage.json');
const LEDGER_VERSION = 1;

mkdirSync(TOMES_DIR, { recursive: true });

// Local timezone the dates are computed in (machine time), stamped for the
// record so a future configurable-tz change isn't ambiguous.
function localTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'; }
  catch { return 'local'; }
}

async function load(ledgerFile) {
  try {
    const data = JSON.parse(await fsp.readFile(ledgerFile, 'utf8'));
    if (data && typeof data === 'object') {
      data.days ??= {};
      data.tz ??= localTz();
      data.version ??= LEDGER_VERSION;
      return data;
    }
  } catch { /* missing/corrupt → fresh */ }
  return { version: LEDGER_VERSION, tz: localTz(), days: {} };
}

async function persist(ledgerFile, ledger) {
  const tmp = ledgerFile + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(ledger, null, 2), 'utf8');
  await fsp.rename(tmp, ledgerFile);
}

/**
 * Mark a (date, session) slice as memorized through `throughCount` messages.
 *
 * `flag` is now REPLACE-and-clearable, and reserved for genuine UNCERTAINTY
 * (a failed extraction): `undefined` leaves it untouched, `null` clears it, a
 * string sets it. A successful run passes `null`, so a slice that once failed
 * and later succeeds reads complete again — "clear once resolved".
 *
 * `sharedRoom` is a separate, sticky, INFORMATIONAL marker ("this day had group
 * activity"). It does NOT drive status — a fully-memorized group-room day reads
 * complete, not permanently "uncertain". (The old behaviour flagged every
 * shared-room slice 'shared-room' forever, turning whole months purple; that
 * legacy flag is migrated to `sharedRoom` on read here and in computeCoverage.)
 * Never throws.
 */
export async function recordSegmentRun({ date, sessionId, throughCount = 0, facts = 0, flag = undefined, sharedRoom = undefined }, { ledgerFile = DEFAULT_LEDGER_FILE } = {}) {
  if (!date || !sessionId) return;
  try {
    const ledger = await load(ledgerFile);
    ledger.days[date] ??= { segments: {}, updatedAt: null };
    const seg = ledger.days[date].segments[sessionId] ?? { memorizedThrough: 0, facts: 0, flag: null };
    seg.memorizedThrough = Math.max(seg.memorizedThrough ?? 0, throughCount);
    seg.facts = (seg.facts ?? 0) + (facts ?? 0);
    if (flag !== undefined) seg.flag = flag;
    // Migrate the legacy sticky 'shared-room' status-flag → the info marker.
    if (seg.flag === 'shared-room') { seg.flag = null; seg.sharedRoom = true; }
    if (sharedRoom) seg.sharedRoom = true;
    seg.lastRun = new Date().toISOString();
    ledger.days[date].segments[sessionId] = seg;
    ledger.days[date].updatedAt = seg.lastRun;
    await persist(ledgerFile, ledger);
  } catch (err) {
    console.warn('[coverage] recordSegmentRun failed:', err?.message ?? err);
  }
}

/**
 * How many messages of this (session, date) slice have been memorized — the
 * `memorizedThrough` count, or 0 if never run. This is the offset the
 * memorization pipeline slices from so it only ingests the un-memorized tail of
 * a day instead of re-reading (and re-minting facts from) the whole thing.
 */
export async function segmentMemorizedThrough(sessionId, date, { ledgerFile = DEFAULT_LEDGER_FILE } = {}) {
  try {
    const ledger = await load(ledgerFile);
    return ledger.days?.[date]?.segments?.[sessionId]?.memorizedThrough ?? 0;
  } catch { return 0; }
}

/** Has this (session, date) slice already been memorized to at least `count`? */
export async function isSegmentMemorized(sessionId, date, count, opts = {}) {
  return (await segmentMemorizedThrough(sessionId, date, opts)) >= count;
}

export function deriveStatus(sessions) {
  if (sessions.length === 0) return 'empty';
  if (!sessions.every(s => s.memorized >= s.total)) return 'partial';
  return sessions.some(s => s.flag) ? 'uncertain' : 'complete';
}

// Read every session log under logsDir → [{ sessionId, messages, audienceTag }].
// Shared by computeCoverage and collectDateSlices so the scan lives in one place.
async function readSessionLogs(logsDir) {
  let files = [];
  try {
    files = (await fsp.readdir(logsDir)).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const log = JSON.parse(await fsp.readFile(path.join(logsDir, f), 'utf8'));
      const messages = Array.isArray(log?.messages) ? log.messages : [];
      if (messages.length === 0) continue;
      out.push({
        sessionId: log?.sessionId ?? f.replace(/\.json$/, ''),
        messages,
        audienceTag: log?.audienceTag ?? 'ward-private',
      });
    } catch { /* skip unreadable log */ }
  }
  return out;
}

/**
 * Live coverage: scan the session logs, derive day-segments, and compare what
 * EXISTS against what the ledger says is MEMORIZED. Returns per-date status for
 * the calendar and the sweep. Only slices with ≥2 readable messages count (a
 * stub exchange is never "missing"). Read-only; never throws.
 */
export async function computeCoverage({ logsDir = DEFAULT_LOGS_DIR, ledgerFile = DEFAULT_LEDGER_FILE } = {}) {
  const ledger = await load(ledgerFile);
  const days = {}; // date -> { sessions: {sessionId:{memorized,total,flag}}, facts }

  for (const { sessionId, messages } of await readSessionLogs(logsDir)) {
    for (const seg of segmentByDay(messages)) {
      if (seg.readableCount < 2) continue;
      const led = ledger.days?.[seg.date]?.segments?.[sessionId];
      // Legacy 'shared-room' flags are informational, not a status — heal them
      // at read-time so existing months un-purple without a re-run.
      const legacyShared = led?.flag === 'shared-room';
      (days[seg.date] ??= { sessions: {}, facts: 0 }).sessions[sessionId] = {
        memorized: led?.memorizedThrough ?? 0,
        total: seg.count,
        flag: legacyShared ? null : (led?.flag ?? null),
        sharedRoom: !!(led?.sharedRoom || legacyShared),
      };
      days[seg.date].facts += led?.facts ?? 0;
    }
  }

  const out = {};
  for (const [date, d] of Object.entries(days)) {
    const sessions = Object.entries(d.sessions).map(([sessionId, s]) => ({ sessionId, ...s }));
    out[date] = {
      status: deriveStatus(sessions),
      facts: d.facts,
      flags: [...new Set(sessions.map(s => s.flag).filter(Boolean))],
      sharedRoom: sessions.some(s => s.sharedRoom),
      sessions,
    };
  }
  return { tz: ledger.tz, days: out };
}

/** Dates with un-memorized slices (status 'partial') — what the sweep feeds. */
export async function incompleteDates(opts = {}) {
  const { days } = await computeCoverage(opts);
  return Object.entries(days).filter(([, d]) => d.status === 'partial').map(([date]) => date);
}

/**
 * Every session's slice that touches `date` — what "Memorize this day" feeds.
 * Returns [{ sessionId, audienceTag, seg }] for slices with ≥2 readable
 * messages. By default already-memorized slices are dropped; `force` includes
 * them (a manual re-run, made safe by the write-time dedup).
 */
export async function collectDateSlices(date, { logsDir = DEFAULT_LOGS_DIR, ledgerFile = DEFAULT_LEDGER_FILE, force = false } = {}) {
  const out = [];
  for (const { sessionId, messages, audienceTag } of await readSessionLogs(logsDir)) {
    const seg = segmentByDay(messages).find(s => s.date === date);
    if (!seg || seg.readableCount < 2) continue;
    if (!force && await isSegmentMemorized(sessionId, date, seg.count, { ledgerFile })) continue;
    out.push({ sessionId, audienceTag, seg });
  }
  return out;
}
