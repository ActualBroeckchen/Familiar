/**
 * Spine states (temporal-bridges Pass A) — the caring spine mints graph
 * citizens for the ward's hard stretches.
 *
 * The problem this closes: the emotional middle of the chains that matter —
 * a crisis evening between a therapy session and a provider change — lived
 * only in the decaying threat scalar and (maybe) in prose memory. It had no
 * node the Familiar's reasoning could relate to schedule events, so a
 * reconstruction of "what led to X" could only tell a logistics-shaped
 * story and confabulated the emotional cause. Here, when threat crosses
 * into moderate+, CODE (never the LLM) mints a schedule-layer `state` node
 * for the episode; on close it derives `co_occurs_with` edges to schedule
 * items whose spans overlapped it — the honest bottom rung of the epistemic
 * ladder (noticed, not concluded; promotion to `causes` stays reflection's
 * job).
 *
 * Design constraints (from the build spec + CLAUDE.md):
 *  - All machine values are code-derived: timestamps, overlap arithmetic,
 *    peak tracking. The model never authors a spine state.
 *  - This NEVER moves the threat tier, gates nothing, delays no triage. It
 *    is a *record* of what the spine already did, written where reasoning
 *    can reach it. It adds visibility of the past; it changes nothing about
 *    when the Familiar acts.
 *  - Ward-private and structurally villager-filtered (isSensitiveNode +
 *    stripSensitiveScheduleNodes, fail-closed) — a spine state is the ward's
 *    crisis history and never surfaces on a gated turn.
 *  - Fire-and-forget on a live ward turn; never throws into the chat path.
 *  - Off-switch PROTO_FAMILIAR_SPINE_STATES_DISABLED=1 + spineStatesEnabled.
 *
 * No cycle with thalamus: the schedule wrappers (addNode/updateNode/
 * getWindow/addEdge) are injected by the enrich() call site; only pure
 * helpers + the fs pointer live here.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsp, mkdirSync } from 'fs';
import { THREAT_TIERS, DEFAULT_TAU_DAYS } from './threat-tracker.js';
import { wardLocalNowISO } from './relative-time.js';
import { expandOccurrences } from './src/schedule/recurrence.js';

const DAY_MS = 24 * 3600 * 1000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOMES_DIR = path.join(__dirname, 'tomes');
const POINTER_FILENAME  = '.spine-episode.json';

// Minting threshold: moderate and above (ward-signed granularity). Reuses the
// tracker's own tier weight so the two can never drift apart.
export const SPINE_MIN_WEIGHT = THREAT_TIERS.moderate;

// Tier severity rank, for "did the episode climb?" comparisons.
const TIER_RANK = { calm: 0, mild: 1, moderate: 2, high: 3, severe: 4 };
const rank = (tier) => TIER_RANK[tier] ?? 0;

// Types worth linking on close. Events/tasks/reminders are life-items; phases
// (routine backbone) and holds (keep-free blocks) would be noise, and other
// state nodes (incl. spine/sensitive) are never linked.
const LINKABLE_TYPES = new Set(['event', 'task', 'reminder']);

// Cap on co-occurrence edges derived per episode — over-gathering `co_occurs`
// is cheap (reflection prunes), but a runaway link count is not.
const MAX_COOCCUR_EDGES = 12;

function isDisabled(settings) {
  if (process.env.PROTO_FAMILIAR_SPINE_STATES_DISABLED === '1') return true;
  // Default ON: only an explicit false disables.
  return settings?.spineStatesEnabled === false;
}

/**
 * Is this a sensitive schedule node that must never reach a villager surface?
 * `spine` marks a caring-spine crisis episode; `sensitive` is the general
 * ward-only marker. Fail-closed: anything shaped like either is filtered.
 */
export function isSensitiveNode(n) {
  const p = n?.payload;
  return !!(p && (p.spine === true || p.sensitive === true));
}

/**
 * Strip sensitive nodes (and any edge touching one) from a temporal_context
 * payload, in place. Applied in enrich() on every GATED (non-ward) turn so a
 * villager with a schedule grant can never see the ward's crisis states in
 * the injected [Temporal Context]. Pure structural filter — fail-closed.
 * Returns the same payload for convenience.
 */
export function stripSensitiveScheduleNodes(payload) {
  const sched = payload?.schedule;
  if (!sched || typeof sched !== 'object') return payload;
  const removed = new Set();
  const keep = (arr) => (Array.isArray(arr) ? arr.filter(n => {
    if (isSensitiveNode(n)) { if (n?.id) removed.add(n.id); return false; }
    return true;
  }) : arr);
  sched.window = keep(sched.window);
  sched.linked = keep(sched.linked);
  if (Array.isArray(sched.edges)) {
    sched.edges = sched.edges.filter(e => !removed.has(e?.src) && !removed.has(e?.dst));
  }
  return payload;
}

// ── Overlap arithmetic (pure) ──────────────────────────────────────

const toMs = (iso) => {
  const t = Date.parse(String(iso ?? ''));
  return Number.isFinite(t) ? t : null;
};

/**
 * The instant a decaying threat crosses back below `threshold` — the true
 * end of a rough stretch (when the caring system stood down), not the last
 * distress *signal*. Uses the tracker's own half-life so the two can't
 * drift. If the stored raw was already at/below threshold, the stretch
 * ended at the last signal. Pure; exposed for tests.
 *
 *   raw * 0.5^((t - last)/tau) = threshold
 *   → t = last + tau * log2(raw / threshold)
 */
export function decayCrossingMs(rawWeight, lastTouchedIso, { threshold = SPINE_MIN_WEIGHT, tauDays = DEFAULT_TAU_DAYS } = {}) {
  const lastMs = toMs(lastTouchedIso);
  if (lastMs == null) return null;
  if (!Number.isFinite(rawWeight) || rawWeight <= threshold) return lastMs;
  const days = tauDays * Math.log2(rawWeight / threshold);
  return lastMs + days * DAY_MS;
}

/**
 * Given the episode's [startMs, endMs] and the schedule nodes fetched for
 * that window, return the node ids whose span overlaps the episode. Recurring
 * anchors are linked once (by anchor id) if ANY occurrence falls in the
 * window. Excludes non-linkable types, sensitive states, and the episode
 * itself. Capped + deduped. Pure — exposed for tests.
 */
export function deriveCooccurrenceEdges(episodeId, startMs, endMs, nodes = []) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return [];
  const seen = new Set();
  const out = [];
  for (const n of nodes) {
    if (!n || n.id === episodeId || seen.has(n.id)) continue;
    if (!LINKABLE_TYPES.has(n.type)) continue;
    if (isSensitiveNode(n)) continue;
    let overlaps = false;
    if (n.payload?.recurrence) {
      // Membership test only: does a generated occurrence land in the window?
      const occ = expandOccurrences(n, startMs, endMs);
      overlaps = Array.isArray(occ) && occ.length > 0;
    } else {
      const s = toMs(n.when ?? n.when_ts);
      if (s == null) continue;
      const e = toMs(n.end ?? n.end_ts) ?? s;
      overlaps = s <= endMs && e >= startMs;
    }
    if (!overlaps) continue;
    seen.add(n.id);
    out.push(n.id);
    if (out.length >= MAX_COOCCUR_EDGES) break;
  }
  return out;
}

// ── Pointer persistence (which episode is currently open) ──────────

function pointerFile(tomesDir) {
  return path.join(tomesDir, POINTER_FILENAME);
}

async function defaultReadPointer(tomesDir) {
  try {
    const raw = await fsp.readFile(pointerFile(tomesDir), 'utf8');
    const p = JSON.parse(raw);
    return (p && typeof p.id === 'string') ? p : null;
  } catch { return null; }
}

async function defaultWritePointer(tomesDir, pointer) {
  mkdirSync(tomesDir, { recursive: true });
  const file = pointerFile(tomesDir);
  if (pointer == null) { await fsp.rm(file, { force: true }); return; }
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(pointer, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

// ── The orchestrator ───────────────────────────────────────────────

/**
 * Reconcile the open spine episode against the current threat reading.
 * Idempotent — safe to call every live ward turn. Never throws.
 *
 *   threat: { tier, weight, raw_weight, last_touched }
 *   nowMs:  real epoch ms (for the pointer/label clock)
 *   wardTimeZone: IANA zone, for ward-local-naive node timestamps
 *   settings: for the off-switch
 *   deps: { addNode, updateNode, getWindow, addEdge } REQUIRED (thalamus
 *         wrappers); readPointer/writePointer/tomesDir/log optional.
 *
 * Returns a small status object for logging/tests:
 *   { action: 'opened'|'climbed'|'closed'|'none'|'skipped', ... }
 */
export async function syncSpineState({
  threat,
  nowMs = Date.now(),
  wardTimeZone = null,
  settings = null,
  deps = {},
} = {}) {
  try {
    if (isDisabled(settings)) return { action: 'skipped', reason: 'disabled' };
    if (!threat || threat.disabled) return { action: 'skipped', reason: 'no-threat' };
    const { addNode, updateNode, getWindow, addEdge } = deps;
    if (!addNode || !updateNode || !getWindow || !addEdge) {
      return { action: 'skipped', reason: 'no-deps' };
    }
    const tomesDir     = deps.tomesDir ?? DEFAULT_TOMES_DIR;
    const readPointer  = deps.readPointer  ?? (() => defaultReadPointer(tomesDir));
    const writePointer = deps.writePointer ?? ((p) => defaultWritePointer(tomesDir, p));
    const log          = deps.log ?? (() => {});

    const weight = Number.isFinite(threat.weight) ? threat.weight : 0;
    const tier   = threat.tier ?? 'calm';
    const open   = await readPointer();

    // ── Above threshold: open or climb ──────────────────────────────
    if (weight >= SPINE_MIN_WEIGHT) {
      if (!open) {
        const nowLocal = wardLocalNowISO(wardTimeZone, nowMs);
        const dateLabel = nowLocal.slice(0, 10);
        const res = await addNode({
          type: 'state',
          label: `rough stretch — ${dateLabel}`,
          when: nowLocal,
          payload: { spine: true, source: 'threat-tracker', peak_tier: tier, opened_at: nowLocal },
        });
        if (!res?.ok || !res.id) return { action: 'none', reason: 'mint-failed', error: res?.error };
        await writePointer({ id: res.id, startLocalIso: nowLocal, peakTier: tier });
        log(`[spine] opened episode ${res.id} (${tier})`);
        return { action: 'opened', id: res.id, tier };
      }
      // Already open — climb the recorded peak if this reading is worse.
      if (rank(tier) > rank(open.peakTier)) {
        await updateNode({ id: open.id, payload: { peak_tier: tier } });
        await writePointer({ ...open, peakTier: tier });
        log(`[spine] episode ${open.id} climbed to ${tier}`);
        return { action: 'climbed', id: open.id, tier };
      }
      return { action: 'none', id: open.id };
    }

    // ── Below threshold: close an open episode ──────────────────────
    if (!open) return { action: 'none' };

    // End at the instant the decaying threat crossed back below moderate —
    // when the caring system stood down — clamped to now (never a future
    // end), rendered ward-local-naive. Code-derived from the tracker's own
    // half-life; the model never touches it.
    const crossMs = decayCrossingMs(threat.raw_weight, threat.last_touched);
    const endMs   = Math.min(nowMs, crossMs == null ? nowMs : crossMs);
    const endLocal = wardLocalNowISO(wardTimeZone, endMs);

    await updateNode({ id: open.id, end: endLocal, payload: { closed_at: endLocal } });

    // Derive co-occurrence edges over the episode span. Best-effort — a
    // failed derivation must not block the close (the episode is already
    // recorded; edges can be added by reflection or a later pass).
    let edgesAdded = 0;
    try {
      const startMs = toMs(open.startLocalIso) ?? endMs;
      const win = await getWindow({ from_ts: open.startLocalIso, to_ts: endLocal, limit: 200 });
      const nodes = [
        ...(Array.isArray(win?.nodes) ? win.nodes : []),
        ...(Array.isArray(win?.linked) ? win.linked : []),
      ];
      const dsts = deriveCooccurrenceEdges(open.id, startMs, Date.parse(endLocal), nodes);
      for (const dst of dsts) {
        const r = await addEdge({ src: open.id, dst, kind: 'co_occurs_with', payload: { source: 'overlap' } });
        if (r?.ok) edgesAdded++;
      }
    } catch (err) {
      log(`[spine] co-occurrence derivation failed for ${open.id}: ${err?.message ?? err}`);
    }

    await writePointer(null);
    log(`[spine] closed episode ${open.id} (+${edgesAdded} co-occurrence edge(s))`);
    return { action: 'closed', id: open.id, edgesAdded };
  } catch (err) {
    // Never throw into the chat path.
    return { action: 'skipped', reason: 'threw', error: err?.message ?? String(err) };
  }
}
