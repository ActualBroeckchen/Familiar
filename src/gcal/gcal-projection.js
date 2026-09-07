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
import { relativeTime } from '../../relative-time.js';

import { REPO_ROOT } from '../../repo-root.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOMES_DIR = path.join(REPO_ROOT, 'tomes');
const FILENAME = '.gcal-projection-cue.json';

// An item shows for at most this many live turns…
export const MAX_TURNS = 3;
// …or this long since first surfaced, whichever comes first.
export const MAX_WINDOW_MS = 48 * 60 * 60_000;
// At most this many items in any single turn (one series = one item — the
// anchor — because Unruh returns the anchor node, not its occurrences).
export const MAX_PER_TURN = 3;

// Projection candidates need at least this much runway before the event —
// cueing something 2h away invites a rushed, worthless forecast.
export const MIN_LEAD_MS = 6 * 60 * 60_000;
// An aged-out item gets ONE more look when the event is nearly here.
export const LAST_CHANCE_MS = 48 * 60 * 60_000;

/**
 * Gather projection candidates from the briefing window (causal-chain fix,
 * piece 1): ANY unresolved event with no consequence edges touching it and
 * at least MIN_LEAD_MS of runway — hand-added, chat-created, or synced —
 * unioned with Unruh's gcal-flagged list (which stays the fast path for
 * fresh sync arrivals). Pure; dedupes by id.
 */
export function gatherProjectionCandidates({ window = [], edges = [], gcalFlagged = [], now = Date.now() } = {}) {
  const touched = new Set();
  for (const e of (Array.isArray(edges) ? edges : [])) {
    if (e?.src) touched.add(e.src);
    if (e?.dst) touched.add(e.dst);
  }
  const out = new Map();
  for (const c of (Array.isArray(gcalFlagged) ? gcalFlagged : [])) {
    if (c?.id) out.set(c.id, { id: c.id, label: c.label, when: c.when });
  }
  for (const n of (Array.isArray(window) ? window : [])) {
    if (!n?.id || out.has(n.id)) continue;
    if (n.type !== 'event' || n.resolution) continue;
    if (touched.has(n.id)) continue;
    const when = n.when ?? n.when_ts;
    const t = when ? Date.parse(when) : NaN;
    if (!Number.isFinite(t) || t - now < MIN_LEAD_MS) continue;
    out.set(n.id, { id: n.id, label: n.label, when });
  }
  return [...out.values()];
}

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

  // Last-chance pass (causal-chain fix): an item that aged out unprojected
  // re-surfaces ONCE when the event is within LAST_CHANCE_MS — if I'm ever
  // going to think about what it sets in motion, it's now. One shot only.
  const lastChance = (c) => {
    const entry = nextState[c.id];
    if (!entry || !agedOut(entry) || entry.lastChanceShown) return false;
    const t = c.when ? Date.parse(c.when) : NaN;
    return Number.isFinite(t) && t > now && (t - now) <= LAST_CHANCE_MS;
  };

  const eligible = list.filter(c => !agedOut(nextState[c.id]) || lastChance(c));
  const items = eligible.slice(0, MAX_PER_TURN);

  // Advance the count only for items actually surfaced this turn.
  for (const c of items) {
    const entry = nextState[c.id] || { firstSeenTs: now, turnsShown: 0 };
    nextState[c.id] = {
      firstSeenTs: entry.firstSeenTs,
      turnsShown: entry.turnsShown + 1,
      ...(entry.lastChanceShown || (agedOut(entry) && lastChance(c)) ? { lastChanceShown: true } : {}),
    };
  }

  return { items, nextState };
}

/**
 * The first-person cue block (§4.4) — server-injected context, so it uses
 * the literal "my human", names the value of projecting, no bias language,
 * and ends with "for now" so the Familiar doesn't treat a Google item as
 * off-limits afterward. Returns '' for an empty set.
 */
export function buildCueBlock(items, { now = Date.now(), weatherOn = false } = {}) {
  if (!Array.isArray(items) || !items.length) return '';
  const lines = items.map(it => {
    const when = it.when ? (relativeTime(it.when, now) || it.when) : '';
    const whenText = when ? `, ${when}` : '';
    return `  — ${it.label ?? it.id}${whenText}  [id: ${it.id}]`;
  });
  // When weather's on, remind myself the sky bears on lead time for anything
  // outdoors — a wet crosstown trip wants more runway (schedule_set_lead).
  const weatherHint = weatherOn
    ? " If one takes my human outside, I can check weather_today while I think it through — rain or heat across town means more lead, which I set with schedule_set_lead."
    : '';
  return [
    "[Coming up with nothing hanging off it yet]",
    ...lines,
    `Upcoming things on my human's schedule that I haven't thought through. For each, I think two moves ahead: what does it lead to if it goes well, and what does skipping it cost — I record both with schedule_link (leading with what doing it earns). A blank forecast helps no one; an honest one now is what lets me learn later.${weatherHint} If one is genuinely routine, leaving it be is fine — then I'm done with each for now; I don't keep re-raising what I've already considered (I'm still free to revisit, project further, or export one later).`,
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
export async function nextProjectionCue({ candidates, now = Date.now(), advance = true, weatherOn = false, tomesDir = DEFAULT_TOMES_DIR } = {}) {
  if (!Array.isArray(candidates) || !candidates.length) return '';
  const state = await readCueState({ tomesDir });
  const { items, nextState } = selectCueItems({ candidates, state, now });
  if (advance) await writeCueState(nextState, { tomesDir });
  return buildCueBlock(items, { now, weatherOn });
}


/**
 * One-shot id tidy: re-key aging-state entries whose node id was re-keyed by
 * Unruh's ids_to_slugs (mapping: old→new). Keeps an item's turns-shown /
 * first-seen intact across the id overhaul instead of resetting its aging.
 */
export async function rekeyCueState(mapping = {}, { tomesDir = DEFAULT_TOMES_DIR } = {}) {
  const state = await readCueState({ tomesDir });
  let moved = 0;
  const next = {};
  for (const [id, entry] of Object.entries(state)) {
    const target = mapping[id];
    if (target) moved++;
    next[target || id] = entry;
  }
  if (moved) await writeCueState(next, { tomesDir });
  return { moved };
}
