/**
 * Tome → Phylactery graduation (Phase 4).
 *
 * The autonomous pass that drains durable facts STRANDED in tomes into
 * their right Phylactery home, without my human initiating it. Phase 3
 * stopped new mis-filing; this cleans up the backlog. It inherits the
 * Phase 3 routing rubric (durable facts about who someone is → identity;
 * moments with a 'when' → memory; keyword-context that fits neither →
 * stays a tome).
 *
 * Distinct from Pillar H graduation (phylactery/graduation.py), which moves
 * stale IDENTITY detail into RAG to keep the always-injected surface lean.
 * This is TOME → Phylactery.
 *
 * Design per CLAUDE.md:
 *   - Code gates pick candidates; ONE batched LLM call judges them; the
 *     loop self-cools. No per-entry request cadence.
 *   - Conservative: when the model isn't sure, the entry STAYS a tome
 *     (false-negative is cheap; mis-filing the canonical self is not).
 *   - Writes go through thalamus's wrappers (injected here). A tome entry
 *     is tidied ONLY after its route is confirmed — a failed route leaves
 *     it intact to retry.
 *   - v1 routes to identity + memory only. Autonomous graph construction
 *     (resolve/create both endpoints + an edge from free text) is the one
 *     risky route and is deferred to v2 — a graph-worthy fact files to
 *     identity prose for now.
 *
 * The behavioural surface lives in pure, fully-injectable functions so the
 * loop wrapper (tome-graduation-loop.js) is a thin driver and the routing
 * is unit-testable without an LLM or a real store.
 */

// Tomes that are never graduation candidates: the Familiar's own episodic /
// runtime stores, not stranded user knowledge.
export const EXCLUDED_TOME_NAMES = new Set([
  'Session Memories',
  "Familiar's Ponderings",
  'Ponderings',
]);

export const DEFAULT_BATCH_SIZE = 5;

/**
 * Pure candidate selection. Given loaded tomes ([{ file, tome }]), return up
 * to `batchSize` entries that are eligible to review: from a non-excluded,
 * enabled tome, enabled, with real content, and not already reviewed.
 * Returns [{ file, tomeName, uid, entry }].
 */
export function selectCandidates(tomes, { excludeNames = EXCLUDED_TOME_NAMES, batchSize = DEFAULT_BATCH_SIZE } = {}) {
  const out = [];
  for (const { file, tome } of (Array.isArray(tomes) ? tomes : [])) {
    if (!tome || tome.enabled === false) continue;
    if (excludeNames.has(tome.name)) continue;
    const entries = tome.entries && typeof tome.entries === 'object' ? tome.entries : {};
    for (const [uid, entry] of Object.entries(entries)) {
      if (!entry || entry.enabled === false) continue;
      if (entry.graduationReviewedAt) continue;          // already judged once
      const content = typeof entry.content === 'string' ? entry.content.trim() : '';
      if (!content) continue;
      out.push({ file, tomeName: tome.name ?? '(unnamed tome)', uid, entry });
      if (out.length >= batchSize) return out;
    }
  }
  return out;
}

/**
 * Parse the batched graduation decision. The model returns a JSON array,
 * one object per candidate uid:
 *   { uid, home: 'self'|'ward'|'relationship'|'memory'|'tome',
 *     already_held: bool, content, filename?, granularity? }
 * Unknown / malformed entries default to the safe "stays a tome" outcome.
 * Returns a Map uid → normalised decision.
 */
export function parseGraduationDecision(raw) {
  const map = new Map();
  let arr;
  try {
    const m = String(raw ?? '').match(/\[[\s\S]*\]/);
    arr = m ? JSON.parse(m[0]) : JSON.parse(String(raw));
  } catch { return map; }
  if (!Array.isArray(arr)) return map;
  const HOMES = new Set(['self', 'ward', 'relationship', 'memory', 'tome']);
  for (const d of arr) {
    if (!d || typeof d.uid !== 'string') continue;
    const home = HOMES.has(d.home) ? d.home : 'tome';
    map.set(d.uid, {
      uid:         d.uid,
      home,
      alreadyHeld: d.already_held === true,
      content:     typeof d.content === 'string' ? d.content.trim() : '',
      filename:    typeof d.filename === 'string' ? d.filename.trim() : '',
      granularity: typeof d.granularity === 'string' ? d.granularity.trim() : 'significant',
    });
  }
  return map;
}

const GRAD_GRANULARITIES = new Set(['daily', 'weekly', 'monthly', 'yearly', 'significant']);

/**
 * Route ONE confirmed decision into Phylactery, then return whether the
 * route succeeded. Does NOT tidy — the caller tidies only on { ok:true }.
 * `deps` are the injected thalamus wrappers.
 *
 *   home 'self'|'ward'|'relationship' → appendIdentity (identity file)
 *   home 'memory'                     → createMemoryFull (ward long-term →
 *                                       consent-pending via the greenlight)
 *   home 'tome' / already-held        → nothing to route (ok:true, no write)
 */
export async function routeDecision(decision, candidate, deps = {}) {
  const { home, content } = decision;

  // Nothing to write: it stays a tome, or it's already held (we'll still
  // tidy a duplicate, but there's no new write).
  if (home === 'tome' || decision.alreadyHeld) return { ok: true, wrote: false };
  if (!content) return { ok: false, error: 'empty content' };

  try {
    if (home === 'self' || home === 'ward' || home === 'relationship') {
      const filename = decision.filename || (
        home === 'self' ? 'my_identity.md'
        : home === 'ward' ? 'ward_notes.md'
        : 'relationship_notes.md'
      );
      const r = await deps.appendIdentity({ category: home, filename, content });
      return { ok: r?.ok !== false, wrote: true, home, filename };
    }
    if (home === 'memory') {
      const granularity = GRAD_GRANULARITIES.has(decision.granularity) ? decision.granularity : 'significant';
      // A long-term memory about my human goes through the consent greenlight,
      // same as the memorization worker — never silently kept.
      const r = await deps.createMemoryFull({ content, granularity, consent_pending: true });
      return { ok: r?.ok !== false, wrote: true, home, granularity };
    }
    return { ok: false, error: `unknown home ${home}` };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/**
 * Tidy a tome entry AFTER a confirmed route. `mode`:
 *   'delete'  → remove the entry outright (the fact now lives in Phylactery).
 *   'pointer' → keep a slim breadcrumb so the keyword trigger still resolves.
 * Either way the entry is marked reviewed so the pass advances. Entries that
 * stayed a tome are marked reviewed but otherwise untouched. Runs through the
 * injected `modifyTome(file, fn)` (thalamus.modifyTomeFile) for the lock +
 * atomic write.
 */
export async function tidyEntry({ file, uid, decision, mode = 'pointer', now = Date.now }, modifyTome) {
  const ts = new Date(now()).toISOString();
  await modifyTome(file, (tome) => {
    const entry = tome?.entries?.[uid];
    if (!entry) return tome;

    // Stayed a tome (no route): just mark it reviewed so we don't re-judge it.
    if (decision.home === 'tome') {
      entry.graduationReviewedAt = ts;
      return tome;
    }

    if (mode === 'delete') {
      delete tome.entries[uid];
      return tome;
    }
    // pointer: replace content with a breadcrumb, keep keys so the trigger
    // still resolves to "this now lives in my <home>".
    const where = decision.home === 'memory' ? 'memory' : `${decision.home} identity`;
    entry.content = `(Graduated to my ${where} on ${ts.slice(0, 10)} — I keep it there now.)`;
    entry.graduationReviewedAt = ts;
    entry.graduatedTo = decision.home;
    return tome;
  });
}

/**
 * One full graduation tick. Pure-ish — all I/O injected:
 *   loadTomes()        → [{ file, tome }] for every non-dot tome
 *   decide(candidates) → raw LLM output (string) for the batch
 *   deps               → { appendIdentity, createMemoryFull } write wrappers
 *   modifyTome(file,fn)→ thalamus.modifyTomeFile
 *   tidyMode           → 'delete' | 'pointer'
 *
 * Returns { reviewed, graduated, keptAsTome, alreadyHeld, failed }.
 * Never throws — a single entry's failure leaves that entry intact and
 * moves on.
 */
export async function runOneGraduationTick({
  loadTomes,
  decide,
  deps = {},
  modifyTome,
  tidyMode = 'pointer',
  excludeNames = EXCLUDED_TOME_NAMES,
  batchSize = DEFAULT_BATCH_SIZE,
  now = Date.now,
} = {}) {
  const summary = { reviewed: 0, graduated: 0, keptAsTome: 0, alreadyHeld: 0, failed: 0 };

  let tomes;
  try { tomes = await loadTomes(); }
  catch (err) { console.warn('[grad] could not load tomes:', err?.message ?? err); return summary; }

  const candidates = selectCandidates(tomes, { excludeNames, batchSize });
  if (candidates.length === 0) return summary;

  let raw;
  try { raw = await decide(candidates); }
  catch (err) { console.warn('[grad] judgment call failed (leaving tomes untouched this tick):', err?.message ?? err); return summary; }

  const decisions = parseGraduationDecision(raw);

  for (const cand of candidates) {
    const decision = decisions.get(cand.uid) ?? { uid: cand.uid, home: 'tome', alreadyHeld: false, content: '' };
    summary.reviewed += 1;
    try {
      const routed = await routeDecision(decision, cand, deps);
      if (!routed.ok) { summary.failed += 1; continue; }   // leave entry intact, retry next time
      await tidyEntry({ file: cand.file, uid: cand.uid, decision, mode: tidyMode, now }, modifyTome);
      if (decision.home === 'tome')         summary.keptAsTome += 1;
      else if (decision.alreadyHeld)        summary.alreadyHeld += 1;
      else                                  summary.graduated += 1;
    } catch (err) {
      console.warn(`[grad] entry ${cand.uid} failed (left intact):`, err?.message ?? err);
      summary.failed += 1;
    }
  }
  return summary;
}
