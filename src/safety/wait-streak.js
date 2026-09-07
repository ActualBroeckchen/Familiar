/**
 * Wait-streak — how many times I have chosen to wait since I last acted.
 *
 * My human is running an experiment (initiative-build-spec, Pass 1):
 * whenever I am offered an explicit choice to wait on an outreach or to
 * defer an action, the deliberation tells me ONE bare fact — the number
 * of times I have chosen to wait since my last proactive act. No advice,
 * no framing, no threshold. Whether that number moves me is mine to read.
 *
 * Counter semantics (spec §1.1):
 *   - A "wait" increments ONLY when I was actually offered the choice and
 *     chose to wait/defer. Ticks that never reach a deliberation — cool-down
 *     skips, quiet hours, crisis-defer stand-downs, tier gates — are NOT
 *     waits; I was never asked. (Invariant W1.)
 *   - Increment sources: triage `wait`, warmth `wait`, a Discord
 *     `[later:…]` defer, snoozing a deferred tell.
 *   - Reset events (count → 0): triage reach_out, warmth reach_out, a
 *     Discord revisit where I actually speak, acknowledging a deferred
 *     intent after genuinely acting on it. Decisions count at decision
 *     time; delivery state is the outbox's concern.
 *   - Excluded, deliberately — do NOT "complete" this list: the ambient
 *     `[pass]` abstain (room pacing, not outreach deferral),
 *     surface-candidate non-raising (implicit, never an offered choice),
 *     `schedule_snooze_task` (deferring my human's task, not my own act),
 *     and my human speaking first (their reaching out never resets my
 *     streak — that asymmetry is part of what the number is for).
 *
 * Storage: tomes/.wait-streak.json (gitignored). Atomic tmp+rename with a
 * write lock, same shape as last-activity.js. A corrupt or missing file
 * reads as zero state. Per-source tallies are cumulative (analysis data);
 * only `count` resets.
 *
 * Off-switch: settings `waitStreakEnabled` (default ON) or
 * PROTO_FAMILIAR_WAIT_STREAK_DISABLED=1. Disabled = no recording AND no
 * line — the experiment is fully on or fully off. Settings are read
 * directly from settings.json (sync, cerebellum-style) to avoid an import
 * cycle with cerebellum.
 *
 * Exports never throw — a poisoned state file must never change a
 * deliberation outcome (invariant W5).
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsp, mkdirSync, readFileSync } from 'fs';

import { plainInterval } from '../../relative-time.js';

import { REPO_ROOT } from '../../repo-root.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOMES_DIR = path.join(REPO_ROOT, 'tomes');
const SETTINGS_FILE     = path.join(REPO_ROOT, 'settings.json');
const FILENAME          = '.wait-streak.json';

function file(tomesDir) { return path.join(tomesDir, FILENAME); }

// How each proactive kind renders inside the §1.3 line.
export const PROACTIVE_KIND_PHRASES = Object.freeze({
  triage:        'a check-in',
  warmth:        'a warm reach-out',
  revisit:       'a revisit',
  'tell-payoff': 'a told intent',
});

const ZERO_STATE = Object.freeze({
  count:             0,
  lastWaitAt:        null,
  lastProactiveAt:   null,
  lastProactiveKind: null,
  tallies:           Object.freeze({}),
});

let _writeLock = Promise.resolve();
function withWriteLock(fn) {
  const prev = _writeLock;
  let release;
  const next = new Promise(r => { release = r; });
  _writeLock = prev.then(() => next);
  return (async () => {
    await prev;
    try { return await fn(); } finally { release(); }
  })();
}

/** Feature gate: env hard-off wins; settings key defaults ON. */
export function isWaitStreakEnabled(settings = null) {
  if (process.env.PROTO_FAMILIAR_WAIT_STREAK_DISABLED === '1') return false;
  let s = settings;
  if (!s) {
    try { s = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')); } catch { s = {}; }
  }
  return s?.waitStreakEnabled !== false;
}

function readStateSync(tomesDir) {
  try {
    const data = JSON.parse(readFileSync(file(tomesDir), 'utf8'));
    if (!data || typeof data !== 'object') return { ...ZERO_STATE, tallies: {} };
    return {
      count:             Number.isInteger(data.count) && data.count >= 0 ? data.count : 0,
      lastWaitAt:        typeof data.lastWaitAt === 'string' ? data.lastWaitAt : null,
      lastProactiveAt:   typeof data.lastProactiveAt === 'string' ? data.lastProactiveAt : null,
      lastProactiveKind: typeof data.lastProactiveKind === 'string' ? data.lastProactiveKind : null,
      tallies:           (data.tallies && typeof data.tallies === 'object') ? { ...data.tallies } : {},
    };
  } catch {
    return { ...ZERO_STATE, tallies: {} };
  }
}

async function writeState(tomesDir, state) {
  mkdirSync(tomesDir, { recursive: true });
  const f   = file(tomesDir);
  const tmp = f + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fsp.rename(tmp, f);
}

/**
 * Read the current streak. Sync (the file is tiny and this runs only on
 * deliberations), never throws. `sinceMs` is code-computed — the model
 * never does the arithmetic.
 */
export function getWaitStreak({ tomesDir = DEFAULT_TOMES_DIR, now = Date.now() } = {}) {
  const state = readStateSync(tomesDir);
  const at = state.lastProactiveAt ? Date.parse(state.lastProactiveAt) : NaN;
  return { ...state, sinceMs: Number.isFinite(at) ? Math.max(0, now - at) : null };
}

/** I chose to wait when offered the choice. Fire-and-forget safe. */
export async function recordWait(source, { tomesDir = DEFAULT_TOMES_DIR, now = Date.now(), settings = null } = {}) {
  try {
    if (!isWaitStreakEnabled(settings)) return { ok: false, disabled: true };
    return await withWriteLock(async () => {
      const state = readStateSync(tomesDir);
      state.count += 1;
      state.lastWaitAt = new Date(now).toISOString();
      const key = String(source || 'unknown');
      state.tallies[key] = (Number.isInteger(state.tallies[key]) ? state.tallies[key] : 0) + 1;
      await writeState(tomesDir, state);
      return { ok: true, count: state.count };
    });
  } catch (err) {
    console.warn('[wait-streak] recordWait failed (ignored):', err?.message ?? err);
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** I acted proactively — the streak resets. Fire-and-forget safe. */
export async function recordProactive(kind, { tomesDir = DEFAULT_TOMES_DIR, now = Date.now(), settings = null } = {}) {
  try {
    if (!isWaitStreakEnabled(settings)) return { ok: false, disabled: true };
    return await withWriteLock(async () => {
      const state = readStateSync(tomesDir);
      state.count             = 0;
      state.lastProactiveAt   = new Date(now).toISOString();
      state.lastProactiveKind = String(kind || 'unknown');
      await writeState(tomesDir, state);
      return { ok: true };
    });
  } catch (err) {
    console.warn('[wait-streak] recordProactive failed (ignored):', err?.message ?? err);
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/**
 * Render the §1.3 line — VERBATIM per the spec. A neutral, code-built
 * fact: no advice, no evaluation, no framing of what the number means.
 * All numbers and relative times are machine values.
 */
export function formatWaitStreakLine(state, nowMs = Date.now()) {
  if (!state || typeof state !== 'object') return '';
  const n = Number.isInteger(state.count) && state.count >= 0 ? state.count : 0;
  if (!state.lastProactiveAt) {
    return `- I have no proactive reach-out on record; since tracking began I have chosen to wait ${n} time(s) when given this choice.`;
  }
  // plainInterval — a bare "<N> hours" that slots into "… ago" (the
  // relativeTime phrasings already carry their own "ago"/day words).
  const when = plainInterval(state.lastProactiveAt, nowMs) || 'a while';
  const kind = PROACTIVE_KIND_PHRASES[state.lastProactiveKind] ?? 'a reach-out';
  if (n === 0) {
    return `- My last proactive reach-out was ${when} ago (${kind}); I have not waited since.`;
  }
  return `- Since my last proactive reach-out (${when} ago, ${kind}), I have chosen to wait ${n} time(s) when given this choice.`;
}

/**
 * The one call injection points use: '' when the feature is off (the
 * affected prompts must be byte-identical to their pre-feature output —
 * invariant W3), the verbatim line otherwise.
 */
export function buildWaitStreakLine({ tomesDir = DEFAULT_TOMES_DIR, now = Date.now(), settings = null } = {}) {
  try {
    if (!isWaitStreakEnabled(settings)) return '';
    return formatWaitStreakLine(getWaitStreak({ tomesDir, now }), now);
  } catch {
    return '';
  }
}
