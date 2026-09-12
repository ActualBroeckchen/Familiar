/**
 * organs.js — the "organ status" readout (pure presentation).
 *
 * The Familiar's context is assembled from several organs: Phylactery (the
 * canonical self — identity + memory), Unruh (temporal context), the Village
 * registry (who the Familiar knows), and the Tomes (keyword-lore). Any of them
 * can be down without breaking the chat path (graceful degradation) — which is
 * good, but it also means a silent gap is easy to miss. This renders a small
 * at-a-glance readout of which organs answered, for a diagnostic tool the
 * Familiar can run and for an optional in-context section.
 *
 * Pure: the probing (which organ actually responded) lives in thalamus.js /
 * the tool executor; this only shapes a status object into the bubble block.
 */

// Order + the label shown; the status object is keyed by the lowercase name.
export const ORGAN_ORDER = ['Phylactery', 'Unruh', 'Village', 'Tomes'];
const UP = '🟢';
const DOWN = '⚫';

/** Render a status object ({ phylactery, unruh, village, tomes } booleans). */
export function formatOrganStatus(status = {}, { title = '[Organ status]' } = {}) {
  const lines = ORGAN_ORDER.map(o => `${o}: ${status[o.toLowerCase()] ? UP : DOWN}`);
  return `${title}\n${lines.join('\n')}`;
}

/** True if any organ didn't respond (⚫) — the trigger for the degraded-only inject. */
export function anyDown(status = {}) {
  return ORGAN_ORDER.some(o => !status[o.toLowerCase()]);
}
