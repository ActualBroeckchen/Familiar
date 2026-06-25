// surface-events.js
//
// The Familiar's record of surface offers and their outcomes. Slice
// 2's heart: every time the consumer pipeline offers a candidate, an
// event is appended; later (next chat turn, or at reflection time)
// the outcome tagger reads the current schedule state and classifies
// what happened. The reflection-mode pondering loop reads tagged
// outcomes to learn patterns for `what_lapses_cost.md`.
//
// Storage lives at `tomes/.surface-events.json` — per-embodiment, like
// ponderings. The derived insights (lifted to Phylactery's identity
// layer) belong to the human's continuity; the raw behavioural stream
// belongs to this instance.
//
// Concurrency: every read-modify-write goes through `withLock` so
// fire-and-forget callers (chat-turn tagOutcomes, recordSurfaceOffers
// queued in parallel, markReflected during a pondering tick) can't
// race each other into lost data. Pattern mirrors pondering.js.

import fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_TOMES_DIR = path.resolve(__dirname, 'tomes');

function eventsPathFor(tomesDir) {
  return path.join(tomesDir, '.surface-events.json');
}

// Retention bounds — prune events whose age and outcome no longer
// have analytical value. Reflection looks at the tail; ancient events
// were either tagged long ago or never will be.
const EVENT_RETENTION_MS = 30 * 24 * 3600 * 1000;
const EVENT_HARD_CAP     = 500;

// How long to wait before declaring a task "unresponded" if no
// resolution arrived. Longer than the dedup window so we don't tag
// "ignored" on a task that's about to surface again to the same
// person who was just asleep.
const UNRESPONDED_THRESHOLD_MS = 24 * 3600 * 1000;

// Outcome class constants — keep these exported so the reflection
// prompt can list them and tests can assert against the same set.
export const OUTCOMES = Object.freeze({
  ENGAGED_AND_COMPLETED: 'engaged_and_completed',
  CANCELLED:             'cancelled',
  DEFERRED:              'deferred',
  FIRED:                 'fired',
  // I offered this to myself as a candidate, it aged out unresolved, AND
  // I actually raised it with my human (the post-turn scan saw it in my
  // reply) — yet nothing came of it. This says something about my human.
  UNRESPONDED:           'unresponded',
  // I offered this to myself, it aged out unresolved, but I never actually
  // brought it up (raised !== true). My human can't respond to something
  // they never saw. This says something about MY surfacing, not about them
  // — reflection must not read it as disengagement.
  NOT_RAISED:            'not_raised',
});

// ── Locks ────────────────────────────────────────────────────────
//
// Routed through thalamus's withLock so the events file shares one
// coordination point with the tome writers. Tests pass a fresh
// tomesDir per test (mkdtempSync) — different key, no contention
// with production traffic.

import { withLock } from './thalamus.js';

// ── File I/O ─────────────────────────────────────────────────────

const EMPTY_STORE = { version: 2, last_reflection_at: null, events: [] };

/**
 * Read the events file. Lock-free — writes are atomic
 * (.tmp + rename) so a concurrent reader either sees the old or new
 * snapshot, never a half-written file.
 */
export async function loadSurfaceEvents(tomesDir = DEFAULT_TOMES_DIR) {
  try {
    const raw = await fs.readFile(eventsPathFor(tomesDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.events)) {
      return {
        version: parsed.version ?? 2,
        last_reflection_at: parsed.last_reflection_at ?? null,
        events: parsed.events,
      };
    }
  } catch { /* missing or malformed → empty store */ }
  return { ...EMPTY_STORE, events: [] };
}

/**
 * Atomic write: serialise to a `.tmp` file, then rename onto the
 * target. The rename is atomic at the filesystem level, so a reader
 * never sees a partial file even if the writer crashes mid-write.
 * Must run inside withLock; the public mutators all do.
 */
async function saveSurfaceEvents(store, tomesDir = DEFAULT_TOMES_DIR) {
  try {
    mkdirSync(tomesDir, { recursive: true });
    const pruned = pruneEvents(store);
    const eventsPath = eventsPathFor(tomesDir);
    const tmp = eventsPath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(pruned, null, 2), 'utf8');
    await fs.rename(tmp, eventsPath);
  } catch (err) {
    console.error('[surface-events] save failed:', err?.message ?? err);
  }
}

function pruneEvents(store) {
  const now = Date.now();
  const cutoff = now - EVENT_RETENTION_MS;
  const kept = (store.events ?? []).filter(e =>
    typeof e?.offered_at === 'number' && e.offered_at >= cutoff
  );
  // If still over hard cap, keep the most-recent N. Sorted ascending
  // by offered_at; slice from the tail.
  kept.sort((a, b) => a.offered_at - b.offered_at);
  const capped = kept.length > EVENT_HARD_CAP
    ? kept.slice(kept.length - EVENT_HARD_CAP)
    : kept;
  return { ...store, events: capped };
}

// ── Recording offers ─────────────────────────────────────────────

/**
 * Append a surface-offer event for each candidate the pipeline
 * decided to expose this turn. State-snapshot is what I knew when
 * I offered — used later by reflection to correlate state with
 * outcome.
 *
 * Serialised through withLock so concurrent offers + tagger
 * runs can't lose data.
 */
export async function recordSurfaceOffers(
  candidates,
  stateSnapshot = {},
  nowMs = Date.now(),
  tomesDir = DEFAULT_TOMES_DIR,
) {
  if (!Array.isArray(candidates) || candidates.length === 0) return;
  return withLock(tomesDir, async () => {
    const store = await loadSurfaceEvents(tomesDir);
    for (const c of candidates) {
      if (!c?.id) continue;
      store.events.push({
        id:             randomUUID(),
        task_id:        c.id,
        task_label:     c.label,
        task_type:      c.type,
        stakes_tier:    c.stakesTier,
        confidence:     c.confidence,
        offered_at:     nowMs,
        state_snapshot: { ...stateSnapshot },
        // Did I actually say something about this task in the turn it
        // was offered? Tagged post-turn by tagRaisedOutcomes (pure-code
        // response scan). null = not yet tagged. Distinct from
        // `outcome`, which tracks how the TASK eventually closed.
        raised:         null,
        raised_at:      null,
        outcome:        null,
        outcome_at:     null,
      });
    }
    await saveSurfaceEvents(store, tomesDir);
  });
}

// ── Dedup lookup ─────────────────────────────────────────────────

/**
 * Return { taskId → { at, raised } } for the most-recent offer of each
 * task. `raised` is true only when the post-turn scan found I actually
 * mentioned the task (true | false | null = untagged). The dedup gate
 * uses it to give a raised task the long suppression window and an
 * un-raised one a short window — staying quiet never buys long
 * suppression. Read-only — no lock needed.
 */
export async function getRecentOfferInfo(tomesDir = DEFAULT_TOMES_DIR) {
  const store = await loadSurfaceEvents(tomesDir);
  const map = {};
  for (const e of store.events ?? []) {
    if (!e?.task_id) continue;
    const t = e.offered_at;
    if (typeof t !== 'number') continue;
    if (map[e.task_id] == null || t > map[e.task_id].at) {
      map[e.task_id] = { at: t, raised: e.raised ?? null };
    }
  }
  return map;
}

// ── Raised tagger ────────────────────────────────────────────────

/**
 * After a chat turn completes, scan my response text for the tasks
 * that were offered this turn and tag each offer raised / not raised.
 * Pure code, zero LLM calls — the same accepted-imprecision pattern as
 * the M8 bookmark outcome scan: a paraphrase I didn't catch counts as
 * not-raised, which only means the task comes back to me sooner. The
 * safe direction.
 *
 * `tasks` is the surfacedTasks array from enrich(): [{ id, label }].
 * Only the most recent untagged offer per task is touched, so a
 * re-offer in a later turn gets its own fresh tag.
 */
export async function tagRaisedOutcomes({ responseText, tasks, now = Date.now(), tomesDir = DEFAULT_TOMES_DIR } = {}) {
  if (!responseText || !Array.isArray(tasks) || tasks.length === 0) {
    return { raised: 0, notRaised: 0 };
  }
  const lower = String(responseText).toLowerCase();
  return withLock(tomesDir, async () => {
    const store = await loadSurfaceEvents(tomesDir);
    if (!store.events?.length) return { raised: 0, notRaised: 0 };

    let raised = 0, notRaised = 0, mutated = false;
    for (const task of tasks) {
      if (!task?.id) continue;
      let latest = null;
      for (const e of store.events) {
        if (e.task_id !== task.id || e.raised != null) continue;
        if (!latest || e.offered_at > latest.offered_at) latest = e;
      }
      if (!latest) continue; // offer write hadn't landed — harmless no-op
      const wasRaised = !!task.label && lower.includes(String(task.label).toLowerCase());
      latest.raised    = wasRaised;
      latest.raised_at = now;
      mutated = true;
      if (wasRaised) raised += 1; else notRaised += 1;
    }
    if (mutated) await saveSurfaceEvents(store, tomesDir);
    return { raised, notRaised };
  });
}

// ── Outcome tagger ───────────────────────────────────────────────

/**
 * Map Unruh schedule resolution → my outcome enum. Resolutions are
 * the source of truth for "did this task close, and how."
 */
function resolutionToOutcome(resolution) {
  switch (String(resolution || '').toLowerCase()) {
    case 'done':            return OUTCOMES.ENGAGED_AND_COMPLETED;
    case 'cancelled':       return OUTCOMES.CANCELLED;
    case 'carried_forward': return OUTCOMES.DEFERRED;
    case 'fired':           return OUTCOMES.FIRED;
    default:                return null;
  }
}

/**
 * Classify any untagged events against the current schedule state.
 * Pure code — no LLM. The current schedule comes from the same
 * temporal_context payload the chat turn already loaded, so this
 * adds zero MCP calls.
 *
 * Serialised through withLock so a concurrent recordSurfaceOffers
 * can't clobber tag writes.
 */
export async function tagOutcomes({ windowItems, now = Date.now(), tomesDir = DEFAULT_TOMES_DIR } = {}) {
  return withLock(tomesDir, async () => {
    const store = await loadSurfaceEvents(tomesDir);
    if (!store.events?.length) return { tagged: 0, skipped: 0 };

    const byId = new Map();
    for (const item of windowItems ?? []) {
      if (item?.id) byId.set(item.id, item);
    }

    let tagged = 0;
    let skipped = 0;
    let mutated = false;

    for (const ev of store.events) {
      if (ev.outcome) continue; // already tagged
      const item = byId.get(ev.task_id);
      let outcome = null;

      if (item && item.resolution) {
        outcome = resolutionToOutcome(item.resolution);
        // Where in its window the ward acted — recorded on the node at
        // resolve. Carried onto the outcome so reflection can learn whether
        // start-timing tracks with how things went.
        const wf = Number(item.payload?.window_fraction);
        if (Number.isFinite(wf)) ev.window_fraction = wf;
      } else if (now - ev.offered_at >= UNRESPONDED_THRESHOLD_MS) {
        // Old enough to give up waiting, no resolution we can see. Split
        // on whether I actually raised it: only a confirmed raise
        // (raised === true) that went nowhere is UNRESPONDED — evidence
        // about my human. If I never brought it up (raised false, or
        // untagged/null = unconfirmed), it's NOT_RAISED — evidence about
        // ME. Conflating the two is how a quiet stretch where I simply
        // didn't speak gets misread as my human withdrawing.
        outcome = ev.raised === true ? OUTCOMES.UNRESPONDED : OUTCOMES.NOT_RAISED;
      } else {
        skipped += 1;
        continue;
      }

      if (outcome) {
        ev.outcome    = outcome;
        ev.outcome_at = now;
        tagged += 1;
        mutated = true;
      } else {
        skipped += 1;
      }
    }

    if (mutated) await saveSurfaceEvents(store, tomesDir);
    return { tagged, skipped };
  });
}

// ── Reflection inputs ────────────────────────────────────────────

/**
 * Return tagged outcomes whose outcome_at is after last_reflection_at.
 * Read-only — no lock needed.
 */
export async function getNewOutcomesSinceLastReflection(tomesDir = DEFAULT_TOMES_DIR) {
  const store = await loadSurfaceEvents(tomesDir);
  const since = typeof store.last_reflection_at === 'number'
    ? store.last_reflection_at
    : 0;
  return (store.events ?? [])
    .filter(e => e.outcome && typeof e.outcome_at === 'number' && e.outcome_at > since)
    .sort((a, b) => a.outcome_at - b.outcome_at);
}

/**
 * Should the next pondering tick run in reflection mode? Returns
 * true once enough new outcomes have accumulated to make patterns
 * visible. Threshold is intentionally conservative — one or two
 * outcomes is noise; reflection on noise produces noise in
 * what_lapses_cost.md.
 */
export async function shouldReflectNow({ minOutcomes = 5, tomesDir = DEFAULT_TOMES_DIR } = {}) {
  const fresh = await getNewOutcomesSinceLastReflection(tomesDir);
  return fresh.length >= minOutcomes;
}

/**
 * Mark a reflection as having happened — subsequent fresh-outcome
 * queries will only see events tagged AFTER this moment. Serialised
 * through withLock so it can't race a concurrent tagger run.
 */
export async function markReflected(nowMs = Date.now(), tomesDir = DEFAULT_TOMES_DIR) {
  return withLock(tomesDir, async () => {
    const store = await loadSurfaceEvents(tomesDir);
    store.last_reflection_at = nowMs;
    await saveSurfaceEvents(store, tomesDir);
  });
}
