/**
 * Google-Calendar projection cue (build spec §4).
 *
 * The single Familiar-facing effect of inbound sync: when ingestion flags a
 * genuinely-NEW appointment, the Familiar is invited — on chat turns that
 * already happen — to think two moves ahead about it (author both futures
 * via schedule_link). No standalone LLM request, no task-nagging.
 *
 * Three exits, all code-driven (no "nah it's fine" acknowledgement call):
 *   - Auto-clear (§4.3): the moment the Familiar attaches a consequence edge,
 *     Unruh stops returning the node in `gcal_projection` — it vanishes by
 *     pure derivation. (Resolution / falling out of the 14-day horizon do the
 *     same.)
 *   - Aging (§4.2): an item rides along for at most MAX_TURNS live turns OR
 *     MAX_WINDOW_MS, then goes quiet on its own whether or not it was acted
 *     on. Projection is best-effort enrichment, not a mandatory task.
 *   - Per-turn cap: at most MAX_PER_TURN items surface in one turn, so a
 *     100-event first import can't flood the cue.
 *
 * This module is pure selection + the block text; the persistent aging state
 * lives in tomes/.gcal-projection-cue.json (read/written by the IO helpers).
 */

import path from 'path';
import { promises as fsp } from 'fs';
import { fileURLToPath } from 'url';
import { relativeTime } from './relative-time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOMES_DIR = path.join(__dirname, 'tomes');
const FILENAME = '.gcal-projection-cue.json';

// An item shows for at most this many live turns…
export const MAX_TURNS = 3;
// …or this long since first surfaced, whichever comes first.
export const MAX_WINDOW_MS = 48 * 60 * 60_000;
// At most this many items in any single turn (one series = one item — the
// anchor — because Unruh returns the anchor node, not its occurrences).
export const MAX_PER_TURN = 3;

/**
 * Choose which flagged items to surface this turn and advance the aging
 * state. Pure — no I/O.
 *
 * @param {object} p
 * @param {Array<{id,label,when}>} p.candidates  Unruh's `gcal_projection`
 *        (already filtered to flagged + open + in-horizon + no-edge)
 * @param {object} p.state   { [id]: { firstSeenTs, turnsShown } }
 * @param {number} [p.now]
 * @returns {{ items: Array, nextState: object }}
 */
export function selectCueItems({ candidates, state = {}, now = Date.now() }) {
  const list = Array.isArray(candidates) ? candidates.filter(c => c && c.id) : [];
  const liveIds = new Set(list.map(c => c.id));

  // Prune state for items Unruh no longer returns — they got a consequence
  // edge, were resolved, or fell out of the horizon (all three are "done").
  const nextState = {};
  for (const [id, entry] of Object.entries(state)) {
    if (liveIds.has(id)) nextState[id] = { ...entry };
  }

  const agedOut = (entry) =>
    entry && (entry.turnsShown >= MAX_TURNS || (now - entry.firstSeenTs) >= MAX_WINDOW_MS);

  const eligible = list.filter(c => !agedOut(nextState[c.id]));
  const items = eligible.slice(0, MAX_PER_TURN);

  // Advance the count only for items actually surfaced this turn.
  for (const c of items) {
    const entry = nextState[c.id] || { firstSeenTs: now, turnsShown: 0 };
    nextState[c.id] = { firstSeenTs: entry.firstSeenTs, turnsShown: entry.turnsShown + 1 };
  }

  return { items, nextState };
}

/**
 * The first-person cue block (§4.4) — server-injected context, so it uses
 * the literal "my human", names the value of projecting, no bias language,
 * and ends with "for now" so the Familiar doesn't treat a Google item as
 * off-limits afterward. Returns '' for an empty set.
 */
export function buildCueBlock(items, { now = Date.now() } = {}) {
  if (!Array.isArray(items) || !items.length) return '';
  const lines = items.map(it => {
    const when = it.when ? (relativeTime(it.when, now) || it.when) : '';
    const whenText = when ? `, ${when}` : '';
    return `  — ${it.label ?? it.id}${whenText}  [id: ${it.id}]`;
  });
  return [
    "[New on my human's calendar — not yet thought through]",
    ...lines,
    "These are freshly synced from my human's Google Calendar. For each, I think two moves ahead: what does it lead to if it resolves, and what does skipping it cost — I record both with schedule_link (leading with what doing it earns). A blank forecast helps no one; an honest one now is what lets me learn later. Then I'm done with each for now — these are appointments, not tasks to chase, and I don't keep re-raising them once I've thought them through (I'm still free to revisit, project further, or export one later).",
  ].join('\n');
}

// ── Persistent aging state (tomes/.gcal-projection-cue.json) ──────

function file(tomesDir) { return path.join(tomesDir, FILENAME); }

export async function readCueState({ tomesDir = DEFAULT_TOMES_DIR } = {}) {
  try {
    const raw = await fsp.readFile(file(tomesDir), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // missing/corrupt → start fresh (best-effort, never throws)
  }
}

export async function writeCueState(state, { tomesDir = DEFAULT_TOMES_DIR } = {}) {
  try {
    await fsp.mkdir(tomesDir, { recursive: true });
    const tmp = file(tomesDir) + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(state ?? {}, null, 2), 'utf8');
    await fsp.rename(tmp, file(tomesDir)); // atomic replace
  } catch (err) {
    console.error('[gcal-cue] failed to persist aging state:', err?.message ?? err);
  }
}

/**
 * One-call convenience for the chat path: read state, select this turn's
 * items, persist the advanced state, return the rendered block. `advance`
 * false (e.g. a preview/static turn) selects without mutating state.
 */
export async function nextProjectionCue({ candidates, now = Date.now(), advance = true, tomesDir = DEFAULT_TOMES_DIR } = {}) {
  if (!Array.isArray(candidates) || !candidates.length) return '';
  const state = await readCueState({ tomesDir });
  const { items, nextState } = selectCueItems({ candidates, state, now });
  if (advance) await writeCueState(nextState, { tomesDir });
  return buildCueBlock(items, { now });
}
