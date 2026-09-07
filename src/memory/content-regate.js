// content-regate.js — Familiar-curated content-gating re-tag pass (ward-
// disclosure build spec, Phase B).
//
// The forward gate (Phase A) makes NEW ward-about-self facts content-gated. This
// pass brings the EXISTING ward-private history along — but with judgment, not a
// blind rule: the Familiar reviews its own private notes about my human and
// decides, per fact, which should be governed by the content rules (so the
// people my human granted a topic can know it) and which stay strictly private.
//
// Why the Familiar, not a mechanical bulk re-tag: it holds the context each fact
// needs, and "which of my people should be able to know this about me" is a
// judgment. Because this is DISCLOSURE — the one narrow cost the proactivity
// rules tell me to be genuinely careful about — three guardrails are structural
// here, not optional:
//   1. Conservative default: a fact I'm unsure about STAYS ward-private (the
//      parser fails closed to 'keep').
//   2. Ward-visible + revertible: every fact I open is written to the disclosure
//      notice my human reads, and can be reverted to private per-fact.
//   3. Ride existing requests, gate in code: candidates are code-selected
//      (ward-private, ward-self only — never a third-party fact), ONE batched
//      LLM judgment per tick, and a reviewed-tracker so a fact is judged once.
//
// Pure functions carry the behaviour; the loop (content-regate-loop.js) injects
// I/O. The apply step reuses the existing updateMemoryById wrapper (audience +
// content_tag) — no new mutation surface.

import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsp, mkdirSync } from 'fs';
import { normalizeTag } from './content-tags.js';
import { AUDIENCE_TAG_WARD_OPEN, AUDIENCE_TAG_WARD_PRIVATE } from '../../audience.js';

import { REPO_ROOT } from '../../repo-root.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOMES_DIR = path.join(REPO_ROOT, 'tomes');
mkdirSync(TOMES_DIR, { recursive: true });

// Ids the Familiar has already judged (kept OR opened), so a batch is never
// re-judged. A kept fact stays private forever unless the ward opens it by hand.
const REVIEWED_FILE = path.join(TOMES_DIR, '.content-regate-reviewed.json');
// Facts opened by this pass, waiting for my human to see (and revert if they
// want). Read by enrich() → the [DISCLOSURE NOTICE] block.
const DISCLOSURE_FILE = path.join(TOMES_DIR, '.disclosure-notices.json');

export const DEFAULT_BATCH_SIZE = 12;
const MAX_CONTENT_CHARS = 500;   // keep the prompt bounded

// ── Reviewed tracker ────────────────────────────────────────────────

export async function readReviewedIds() {
  try {
    const raw = await fsp.readFile(REVIEWED_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

async function writeReviewedIds(set) {
  const tmp = REVIEWED_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify([...set], null, 2), 'utf8');
  await fsp.rename(tmp, REVIEWED_FILE);
}

// ── Disclosure notices (ward-visible + revertible) ──────────────────

export async function readDisclosureNotices() {
  try {
    const raw = await fsp.readFile(DISCLOSURE_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function writeDisclosureNotices(list) {
  const tmp = DISCLOSURE_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8');
  await fsp.rename(tmp, DISCLOSURE_FILE);
}

/** Drop a notice once the ward has seen it (or reverted the fact). */
export async function clearDisclosureNotice(id) {
  const list = await readDisclosureNotices();
  const next = list.filter(n => n.id !== id);
  if (next.length !== list.length) await writeDisclosureNotices(next);
  return { ok: true, remaining: next.length };
}

// ── Selection (pure) ────────────────────────────────────────────────

/** Un-reviewed candidates, capped. Pure. */
export function selectBatch(candidates, reviewedSet, batchSize = DEFAULT_BATCH_SIZE) {
  const seen = reviewedSet instanceof Set ? reviewedSet : new Set(reviewedSet ?? []);
  return (Array.isArray(candidates) ? candidates : [])
    .filter(c => c?.id && !seen.has(c.id))
    .slice(0, Math.max(1, batchSize));
}

// ── Circle summary for the prompt (pure) ────────────────────────────

/**
 * A compact "which of my people could see which topics" summary, so the Familiar
 * understands what opening a fact of a given topic actually exposes. Only circles
 * that grant at least one topic are listed (strangers/empty are dropped).
 */
export function summarizeCircles(registry) {
  const cats = registry?.categories ?? [];
  const lines = [];
  for (const c of cats) {
    const topics = c?.grants?.topics;
    if (!topics || typeof topics !== 'object') continue;
    const grants = Object.entries(topics)
      .filter(([t, l]) => normalizeTag(`${t}:${l}`))
      .map(([t, l]) => `${t}:${l}`);
    if (grants.length) lines.push(`  - "${c.name ?? c.id}" may see: ${grants.join(', ')}`);
  }
  return lines.length
    ? lines.join('\n')
    : '  (none of my human\'s circles are granted any topic yet — so opening a fact exposes it to no one until they grant a circle its topic.)';
}

// ── Prompt (first-person, conservative — written like I'd actually think) ──

export function buildRetagPrompt({ candidates = [], circlesSummary = '' } = {}) {
  const items = candidates.map((c, i) => {
    const content = String(c.content ?? '').slice(0, MAX_CONTENT_CHARS);
    const tag = c.content_tag ? ` [currently tagged ${c.content_tag}]` : ' [no content tag yet]';
    const when = c.date ? ` (${c.date})` : '';
    return `${i + 1}. id=${c.id}${when}${tag}\n   ${content}`;
  }).join('\n\n');

  return `I'm going back through my own private notes about my human — things that, until now, only the two of us could see. For each one I decide: should it stay strictly between us, or can it be governed by my normal content-sharing rules?

What "opening" a fact means: it stops being locked to just us and instead follows its topic. Then only the people my human has trusted with that topic can ever see it — and if they've trusted no one with it, no one sees it. So opening a fact about, say, a medication only lets the people my human granted medical access know it, no one else.

Who could see what, if I open a fact of a given topic:
${circlesSummary}

How I decide, honestly:
- If I'm not sure, it STAYS private. This is my human's private life; erring toward keeping it between us is the safe direction, and I do.
- I only open a fact when I genuinely believe my human would be fine with the people who'd then be able to see it (per the rules above) knowing it. A mundane fact is usually fine; something tender, medical, or about their inner life I keep private unless I'm confident it belongs with a circle they'd want to have it.
- I can also fix a fact's topic tag if the current one is wrong or missing — that's what decides who could ever see it, so getting it right matters.

The facts:

${items}

I answer with ONLY a JSON array, one object per fact, no prose:
[{"id": "<the id>", "decision": "keep" | "open", "content_tag": "<topic>:<open|sensitive>"}]
- "keep" = stays strictly private (my default when unsure). "open" = governed by content rules.
- content_tag is optional; include it only to set or correct the topic (e.g. "medical:sensitive", "general:open"). Omit it to leave the current tag as-is.
- Any fact I leave out of the array stays private.`;
}

// ── Parse (fail-closed to keep) ─────────────────────────────────────

/**
 * Parse the batched decision into a Map id → { decision, contentTag|null }.
 * Fail-closed: anything unparseable, any unknown id, any decision that isn't a
 * clean "open" → treated as "keep" (stays private). A content_tag is applied
 * only when it normalises to a real topic:level; otherwise dropped.
 */
export function parseRetagDecision(raw, validIds) {
  const valid = validIds instanceof Set ? validIds : new Set(validIds ?? []);
  const out = new Map();
  let arr;
  try { arr = JSON.parse(String(raw ?? '').match(/\[[\s\S]*\]/)?.[0] ?? 'null'); }
  catch { arr = null; }
  if (!Array.isArray(arr)) return out;
  for (const d of arr) {
    const id = d?.id;
    if (!id || !valid.has(id)) continue;
    const open = String(d?.decision ?? '').trim().toLowerCase() === 'open';
    let contentTag = null;
    if (d?.content_tag != null) {
      const norm = normalizeTag(d.content_tag);
      if (norm) contentTag = `${norm.topic}:${norm.level}`;
    }
    out.set(id, { decision: open ? 'open' : 'keep', contentTag });
  }
  return out;
}

// ── One tick (injectable I/O) ───────────────────────────────────────

/**
 * Run one re-tag tick. All I/O injected so tests drive every branch:
 *   getCandidates() → { items: [{id, date, content, content_tag, category}] }
 *   getRegistry()   → village registry (for the circle summary)
 *   callLLM(messages) → raw text (the batched judgment)
 *   updateMemory({id, audience?, contentTag?}) → { ok }
 *   buildMessages({ prompt }) → provider messages (lets the loop add identity + macros)
 *
 * Returns { reason, reviewed, opened, kept, errors }. Never throws.
 */
export async function runOneRetagTick({
  getCandidates,
  getRegistry,
  callLLM,
  updateMemory,
  buildMessages = ({ prompt }) => [{ role: 'user', content: prompt }],
  batchSize = DEFAULT_BATCH_SIZE,
  now = () => new Date().toISOString(),
  // State I/O — injected for isolated tests; defaults are the real dotfiles.
  readReviewed = readReviewedIds,
  writeReviewed = writeReviewedIds,
  readNotices = readDisclosureNotices,
  writeNotices = writeDisclosureNotices,
} = {}) {
  for (const [name, fn] of Object.entries({ getCandidates, callLLM, updateMemory })) {
    if (typeof fn !== 'function') throw new Error(`${name} is required`);
  }
  let cand;
  try { cand = await getCandidates(); } catch (err) { return { reason: 'candidates_failed', error: err?.message ?? String(err), reviewed: 0, opened: 0, kept: 0 }; }
  const candidates = Array.isArray(cand?.items) ? cand.items : (Array.isArray(cand) ? cand : []);
  if (!candidates.length) return { reason: 'no_candidates', reviewed: 0, opened: 0, kept: 0 };

  const reviewedSet = await readReviewed();
  const batch = selectBatch(candidates, reviewedSet, batchSize);
  if (!batch.length) return { reason: 'all_reviewed', reviewed: 0, opened: 0, kept: 0 };

  const registry = (typeof getRegistry === 'function') ? await getRegistry().catch(() => null) : null;
  const prompt = buildRetagPrompt({ candidates: batch, circlesSummary: summarizeCircles(registry) });

  let text;
  try { text = await callLLM(buildMessages({ prompt })); }
  catch (err) { return { reason: 'llm_failed', error: err?.message ?? String(err), reviewed: 0, opened: 0, kept: 0 }; }

  const validIds = new Set(batch.map(c => c.id));
  const decisions = parseRetagDecision(text, validIds);

  const notices = await readNotices();
  let opened = 0, kept = 0;
  const errors = [];
  for (const c of batch) {
    const d = decisions.get(c.id) ?? { decision: 'keep', contentTag: null }; // fail-closed
    try {
      if (d.decision === 'open') {
        const r = await updateMemory({ id: c.id, audience: AUDIENCE_TAG_WARD_OPEN, ...(d.contentTag ? { contentTag: d.contentTag } : {}) });
        if (r?.ok === false) { errors.push({ id: c.id, error: r.error ?? 'update failed' }); continue; }
        opened++;
        notices.push({
          id: c.id,
          brief: String(c.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
          topic: d.contentTag ?? c.content_tag ?? 'general:sensitive',
          date: c.date ?? null,
          openedAt: now(),
        });
      } else {
        // Kept private. Still apply a corrected tag if given (harmless — stays
        // private — and improves accuracy for any future opening).
        if (d.contentTag && d.contentTag !== c.content_tag) {
          await updateMemory({ id: c.id, contentTag: d.contentTag }).catch(() => {});
        }
        kept++;
      }
    } catch (err) {
      errors.push({ id: c.id, error: err?.message ?? String(err) });
      continue;
    }
    reviewedSet.add(c.id); // judged (open or keep) → never re-judge
  }

  await writeReviewed(reviewedSet);
  if (opened > 0) await writeNotices(notices);

  return { reason: 'reviewed', reviewed: batch.length, opened, kept, errors };
}
