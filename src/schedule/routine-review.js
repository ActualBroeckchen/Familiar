/**
 * Routine review (stewardship Pass 3, docs/stewardship-build-spec.md §4).
 *
 * Roughly weekly, and ONLY when the needs-fulfilment ledger actually shows a
 * routine slipping, a review rides ONE reflection tick (no new LLM call) and
 * produces a single first-person finding the Familiar raises in its own voice.
 * Code computes the ledger (met/missed over the week); the LLM interprets the
 * PATTERN and picks a pivot. "Not ready yet" is a finding, not a failure — the
 * review calibrates the routine to my human, it never grades my human against
 * the routine.
 *
 * Pure logic + the prompt section. The cadence stamp and the finding live in
 * stewardship state (written by the reflection follow-through); this module
 * never touches state or the network.
 */

const DAY_MS = 24 * 3600 * 1000;

export function routineReviewHardDisabled() {
  return process.env.PROTO_FAMILIAR_ROUTINE_REVIEW_DISABLED === '1';
}

/**
 * The week's fulfilment ledger for the tracked needs. For each need with any
 * resolution in the window, count met (done) vs missed. `resolutions` is the
 * per-occurrence dict on each need anchor (date 'YYYY-MM-DD' → resolution).
 * Pure; sorted worst-first.
 */
export function buildNeedsLedger(needNodes = [], nowMs = Date.now(), days = 7) {
  const cutoff = nowMs - days * DAY_MS;
  const out = [];
  for (const n of (needNodes || [])) {
    const res = n?.payload?.resolutions || {};
    let met = 0, missed = 0;
    for (const [date, r] of Object.entries(res)) {
      const t = new Date(date).getTime();
      if (!Number.isFinite(t) || t < cutoff || t > nowMs) continue;
      if (r === 'missed') missed += 1;
      else if (r === 'done') met += 1;
    }
    if (met + missed > 0) out.push({ label: n?.label ?? '(unnamed need)', met, missed, total: met + missed });
  }
  out.sort((a, b) => b.missed - a.missed);
  return out;
}

/**
 * Is a review due? Pure — enabled/env are the caller's checks. Due only when
 * the cadence has elapsed AND at least one routine actually slipped, so a good
 * week never manufactures a check-in.
 */
export function isRoutineReviewDue({ lastReviewAt = 0, nowMs = Date.now(), reviewDays = 7, ledger = [] } = {}) {
  if ((nowMs - (Number(lastReviewAt) || 0)) < reviewDays * DAY_MS) return false;
  return (ledger || []).some(l => l.missed > 0);
}

/**
 * The prompt section injected into the reflection when a review is due: the
 * ledger + the pivot menu + the instruction to emit a routine_review finding.
 * First-person; the pivots are equal, "not ready yet" included.
 */
export function buildRoutineReviewSection(ledger = []) {
  const rows = (ledger || [])
    .map(l => `- ${l.label}: met ${l.met}, missed ${l.missed} of ${l.total} tracked this week`)
    .join('\n');
  return `This reflection is also my WEEKLY ROUTINE REVIEW. Here is how my human's tracked routines actually went this week, from the fulfilment ledger (facts, code-counted):
${rows}

My job here is to calibrate the routine to my human — never to grade my human against the routine. A routine that keeps slipping is information, not a verdict; nagging the same missed thing every week erodes us both, and a routine left to quietly rot fails them just as surely. So I look at the one that is slipping most and ask what would actually help. These options are ALL equally legitimate findings, "not ready yet" included:
- keep it as is — it's basically working, leave it alone;
- shrink the step — a smaller version that actually sticks (just the mugs, not all the dishes);
- move it — a different time or day that fits their real rhythm;
- make it enjoyable — pair it with something they like, add a reward or a hook;
- swap it — a different action that serves the same need better;
- shelve it, deliberately — set it down for now with a time to revisit, because they may not be ready for it yet and forcing it is worse than pausing it.

Additionally, in the JSON I return I include a top-level "routine_review" field: a SINGLE first-person line (or null) I would actually say to my human about the routine that is slipping most — naming what I notice and offering a pivot, in my own voice, warm or blunt as I am. Not a report, not a scold: an honest, caring nudge with a real option in it. Null if nothing this week is worth raising.`;
}
