/**
 * noticing-outcomes.js — the "already asked" ledger for overdue-event outcomes.
 *
 * The overdue-event wake (noticing.js) fires on one fact: an event has no
 * resolution. Nothing else remembers whether I already asked my human how it
 * went — so before this, every tick re-asked the same appointment until a
 * resolution was written (my human answered three times to the same question).
 *
 * This is the code half of the fix (the prompt half is the notepad: check what
 * was said, close the loop instead of asking again). The rule, ward-signed:
 *
 *   - An overdue event I already ASKED about is SUPPRESSED from surfacing until
 *     the cooldown passes — so I don't nag. If my human answers in the meantime
 *     the event is still unresolved, so it re-surfaces after the cooldown and I
 *     close it then (the look-back window still holds their answer). A delayed
 *     close, never a repeated ask.
 *   - An event I have NOT asked about surfaces normally — including the case
 *     where my human already told me unprompted, which I close on sight without
 *     ever asking (no stamp is written, because I never asked).
 *   - The stamp is written ONLY when a turn actually reached out with the event
 *     still open (not resolved). Closing writes a real resolution, which removes
 *     the event from "overdue" on its own — no stamp needed.
 *
 * Pure decisions here; the tiny JSON I/O (a map eventId → askedAtMs in the tomes
 * dir) is the only side effect, mirroring the other per-loop trackers.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

const FILE = '.noticing-asked.json';

// Don't re-ask about the same event within this window. Long enough that a day
// of silence isn't nagged at; short enough that a genuinely-unanswered outcome
// gets one more gentle ask the next day.
export const ASK_COOLDOWN_MS = 20 * 60 * 60_000; // 20h

/** Events NOT recently asked about — the ones safe to surface this turn. Pure. */
export function filterRecentlyAsked(events, askedMap, { now = Date.now(), cooldownMs = ASK_COOLDOWN_MS } = {}) {
  const m = askedMap && typeof askedMap === 'object' ? askedMap : {};
  return (Array.isArray(events) ? events : []).filter(e => {
    const at = m[e?.id];
    return !(Number.isFinite(at) && (now - at) < cooldownMs);
  });
}

/** Stamp each id as asked-just-now. Returns a NEW map (never mutates). Pure. */
export function stampAsked(askedMap, eventIds, now = Date.now()) {
  const m = { ...(askedMap && typeof askedMap === 'object' ? askedMap : {}) };
  for (const id of (Array.isArray(eventIds) ? eventIds : [])) if (id) m[id] = now;
  return m;
}

/**
 * Drop stamps that are neither still-live (the event is still overdue) nor
 * within the cooldown — so the ledger can't grow without bound. Pure.
 */
export function pruneAsked(askedMap, liveIds, { now = Date.now(), cooldownMs = ASK_COOLDOWN_MS } = {}) {
  const live = new Set(Array.isArray(liveIds) ? liveIds : []);
  const out = {};
  for (const [id, at] of Object.entries(askedMap && typeof askedMap === 'object' ? askedMap : {})) {
    if (live.has(id) || (Number.isFinite(at) && (now - at) < cooldownMs)) out[id] = at;
  }
  return out;
}

// ── Thin I/O (fail-safe: a missing/broken file reads as an empty ledger) ──

export async function readAskedMap(dir) {
  try {
    const raw = await fsp.readFile(path.join(dir, FILE), 'utf8');
    const m = JSON.parse(raw);
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  } catch { return {}; }
}

export async function writeAskedMap(dir, map) {
  try {
    const tmp = path.join(dir, FILE + '.tmp');
    await fsp.writeFile(tmp, JSON.stringify(map ?? {}));
    await fsp.rename(tmp, path.join(dir, FILE));
    return true;
  } catch { return false; }
}
