/**
 * Recent ponderings — surface the Familiar's own quiet thoughts into
 * its working memory so it can reference them naturally in conversation.
 *
 * Step 3' of the caring spine: close the honesty loop.
 *
 * Ponderings are stored in the "Familiar's Ponderings" tome with
 * enabled:false (no keyword auto-fire), so they will never sneak in
 * as fake-RAG lore. This module is the deliberate path: read the
 * most recent N, format them with framing that tells the model
 * "these are your own real thoughts — reference if relevant, never
 * invent."
 *
 * Recency-only (not relevance search): ponderings are a short list of
 * what's been on the Familiar's mind lately, not a knowledge base.
 * Entity-core's RAG handles relevance search for memories.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsp } from 'fs';
import { PONDERINGS_TOME_NAME } from './pondering.js';
import { withLock } from './thalamus.js';
import { relativeTime } from './relative-time.js';

// Routing hints for the deferred-intents block. Storage kinds map to a
// filing tool; 'tell' is a conversational intent — no tool, just a prompt
// to mention it when the moment fits.
const KIND_TOOL = {
  tome:     'save_to_tome',
  memory:   'save_memory',
  identity: 'update_identity',
  tell:     null,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOMES_DIR = path.join(__dirname, 'tomes');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Read the most recent pondering entries from the Ponderings tome.
 *
 * Returns up to `limit` entries (default 3), newest first, filtered to
 * those created within `sinceDays` (default 7). Returns [] cleanly if
 * the tomes directory is missing, the tome doesn't exist yet, or all
 * entries are too old.
 */
export async function getRecentPonderings({
  tomesDir   = DEFAULT_TOMES_DIR,
  limit      = 3,
  sinceDays  = 7,
  now        = Date.now(),
} = {}) {
  let files;
  try { files = await fsp.readdir(tomesDir); }
  catch { return []; }

  let tome = null;
  for (const f of files) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    try {
      const raw = await fsp.readFile(path.join(tomesDir, f), 'utf8');
      const t   = JSON.parse(raw);
      if (t?.name === PONDERINGS_TOME_NAME) { tome = t; break; }
    } catch { /* skip corrupt */ }
  }
  if (!tome || !tome.entries) return [];

  const cutoff = now - sinceDays * DAY_MS;
  return Object.values(tome.entries)
    .filter(e => e && typeof e.created_at === 'string')
    .map(e => ({
      uid:        e.uid,
      title:      e.comment ?? '',
      content:    e.content ?? '',
      topic:      e.topic_pondered ?? null,
      created_at: e.created_at,
      created_ms: Date.parse(e.created_at),
    }))
    .filter(e => Number.isFinite(e.created_ms) && e.created_ms >= cutoff && e.content.trim())
    .sort((a, b) => b.created_ms - a.created_ms)
    .slice(0, limit);
}

/**
 * Delete one pondering entry from the tome by uid. Returns
 * { ok, deleted } — deleted=false when the uid isn't present.
 * Used by the Temporal editor UI (M9) to clean up bad entries.
 */
export async function deletePondering({ uid, tomesDir = DEFAULT_TOMES_DIR }) {
  if (!uid || typeof uid !== 'string') return { ok: false, error: 'uid is required' };
  let files;
  try { files = await fsp.readdir(tomesDir); }
  catch { return { ok: false, error: 'tomes dir not found' }; }
  // First pass: locate the file path (read-only, no lock needed). The
  // ponderings tome is unique by name; if name lookup fails we're done.
  let targetFile = null;
  for (const f of files) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    const file = path.join(tomesDir, f);
    let tome;
    try { tome = JSON.parse(await fsp.readFile(file, 'utf8')); }
    catch { continue; }
    if (tome?.name === PONDERINGS_TOME_NAME) { targetFile = file; break; }
  }
  if (!targetFile) return { ok: true, deleted: false };
  // Read-modify-write under the per-file lock so a concurrent
  // pondering-loop write (which now also goes through withLock on the
  // same file path) can't clobber the delete.
  return withLock(targetFile, async () => {
    let tome;
    try { tome = JSON.parse(await fsp.readFile(targetFile, 'utf8')); }
    catch { return { ok: false, error: 'tome unreadable' }; }
    if (!tome.entries?.[uid]) return { ok: true, deleted: false };
    delete tome.entries[uid];
    const tmp = targetFile + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(tome, null, 2), 'utf8');
    await fsp.rename(tmp, targetFile);
    return { ok: true, deleted: true };
  });
}

/**
 * Render pondering entries as a prompt-injection block.
 *
 * The framing tells the model these are its own real private thoughts
 * — available for natural reference if the conversation touches them,
 * never to invent or shoehorn. Returns empty string when there's
 * nothing to surface, so the caller can drop the section entirely
 * rather than print a hollow header.
 */
export function formatPonderingsForPrompt(entries) {
  if (!entries || entries.length === 0) return '';

  const lines = [
    'Things I have been quietly thinking about on my own, recently:',
    '',
  ];
  // Render each pondering with relative-time framing — recomputed per
  // turn so a thought from this morning reads as "this morning" right
  // now and "yesterday morning" tomorrow.
  const now = Date.now();
  for (const e of entries) {
    const rel = relativeTime(e.created_at, now);
    lines.push(`— ${rel || e.created_at} · "${e.title}"`);
    lines.push(e.content);
    lines.push('');
  }
  lines.push(
    'These are my own real, private thoughts — written by me, in my own voice, ' +
    'during quiet moments when no one was talking to me. I may reference them ' +
    'naturally if they fit what my human is talking about ("I was actually thinking ' +
    'about this last night…"). I never invent a thought I didn\'t actually have. ' +
    'I never force a reference where it doesn\'t fit. If nothing here is relevant ' +
    'to this conversation, I just let them sit — they don\'t need to be mentioned.'
  );
  return lines.join('\n');
}

// ── Deferred intents (Pillar B of the autonomous-routing fix) ────────────

/**
 * Helper: locate the ponderings tome file without acquiring a lock.
 * Scan is read-only; callers that need atomic mutation pass the result
 * to a separate withLock block.
 */
async function findPonderingsTomeFile(tomesDir) {
  let files;
  try { files = await fsp.readdir(tomesDir); }
  catch { return null; }
  for (const f of files) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    const file = path.join(tomesDir, f);
    try {
      const raw = await fsp.readFile(file, 'utf8');
      if (JSON.parse(raw)?.name === PONDERINGS_TOME_NAME) return file;
    } catch { /* skip corrupt */ }
  }
  return null;
}

/**
 * Return up to `limit` unacted intents from the Familiar's ponderings —
 * flat list, oldest-first — so enrich() can surface them in the dynamic
 * block. Each item carries the entry uid + the original array index so
 * markIntentActedOn() can address it precisely.
 *
 * @returns {Promise<Array<{ uid, entryTitle, index, kind, summary }>>}
 */
export async function getUnactedIntents({
  tomesDir = DEFAULT_TOMES_DIR,
  limit    = 5,
} = {}) {
  const targetFile = await findPonderingsTomeFile(tomesDir);
  if (!targetFile) return [];

  let tome;
  try { tome = JSON.parse(await fsp.readFile(targetFile, 'utf8')); }
  catch { return []; }
  if (!tome?.entries) return [];

  const now = Date.now();
  const flat = [];
  for (const entry of Object.values(tome.entries)) {
    if (!Array.isArray(entry?.wants_to_save)) continue;
    const created_ms = Date.parse(entry.created_at ?? '') || 0;
    for (let idx = 0; idx < entry.wants_to_save.length; idx++) {
      const intent = entry.wants_to_save[idx];
      if (!intent || intent.acted_on !== false) continue;
      if (intent.snooze_until) {
        const snoozeMs = Date.parse(intent.snooze_until);
        if (Number.isFinite(snoozeMs) && now < snoozeMs) continue;
      }
      flat.push({
        uid:        entry.uid,
        entryTitle: entry.comment ?? '',
        created_ms,
        index:      idx,
        kind:       intent.kind,
        summary:    intent.summary,
      });
    }
  }

  flat.sort((a, b) => a.created_ms - b.created_ms);
  return flat.slice(0, limit);
}

/**
 * Mark one deferred intent as acted on. Called by the server endpoint
 * that backs the acknowledge_deferred_intent LLM tool.
 *
 * Returns { ok, alreadyDone? } on success; { ok: false, error } on
 * invalid input or missing entry.
 */
export async function markIntentActedOn({ uid, index, tomesDir = DEFAULT_TOMES_DIR }) {
  if (!uid || typeof uid !== 'string') return { ok: false, error: 'uid required' };
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    return { ok: false, error: 'index must be a non-negative integer' };
  }

  const targetFile = await findPonderingsTomeFile(tomesDir);
  if (!targetFile) return { ok: false, error: 'ponderings tome not found' };

  return withLock(targetFile, async () => {
    let tome;
    try { tome = JSON.parse(await fsp.readFile(targetFile, 'utf8')); }
    catch { return { ok: false, error: 'tome unreadable' }; }

    const entry = tome.entries?.[uid];
    if (!entry) return { ok: false, error: 'entry not found' };

    const intents = entry.wants_to_save;
    if (!Array.isArray(intents) || index >= intents.length) {
      return { ok: false, error: 'intent index out of range' };
    }
    if (intents[index]?.acted_on === true) return { ok: true, alreadyDone: true };

    intents[index].acted_on = true;
    const tmp = targetFile + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(tome, null, 2), 'utf8');
    await fsp.rename(tmp, targetFile);
    return { ok: true };
  });
}

/**
 * Snooze one deferred intent for `minutes` minutes. The intent stays
 * unacted but won't resurface until the snooze expires. Called by the
 * snooze_deferred_intent LLM tool when the human asks to get to it later.
 */
export async function snoozeIntent({ uid, index, minutes = 60, tomesDir = DEFAULT_TOMES_DIR }) {
  if (!uid || typeof uid !== 'string') return { ok: false, error: 'uid required' };
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    return { ok: false, error: 'index must be a non-negative integer' };
  }

  const targetFile = await findPonderingsTomeFile(tomesDir);
  if (!targetFile) return { ok: false, error: 'ponderings tome not found' };

  return withLock(targetFile, async () => {
    let tome;
    try { tome = JSON.parse(await fsp.readFile(targetFile, 'utf8')); }
    catch { return { ok: false, error: 'tome unreadable' }; }

    const entry = tome.entries?.[uid];
    if (!entry) return { ok: false, error: 'entry not found' };

    const intents = entry.wants_to_save;
    if (!Array.isArray(intents) || index >= intents.length) {
      return { ok: false, error: 'intent index out of range' };
    }
    if (intents[index]?.acted_on === true) return { ok: true, alreadySnoozed: false, alreadyDone: true };

    const mins = Math.max(1, Math.min(Number(minutes) || 60, 10080)); // 1min–1week cap
    intents[index].snooze_until = new Date(Date.now() + mins * 60 * 1000).toISOString();
    const tmp = targetFile + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(tome, null, 2), 'utf8');
    await fsp.rename(tmp, targetFile);
    return { ok: true, snooze_until: intents[index].snooze_until };
  });
}

/**
 * Render unacted deferred intents as a prompt-injection block.
 *
 * Each entry shows the kind, the summary, the tool to use, and the
 * (uid, index) pair the Familiar needs to call acknowledge_deferred_intent
 * after filing. Returns '' when there are no intents.
 */
export function formatDeferredIntentsBlock(intents) {
  if (!intents || intents.length === 0) return '';

  const lines = [
    '[Deferred intents from my free time]',
    'While thinking on my own recently, I thought of some things I want to file or talk about. Unless it\'s wildly inappropriate — like during an active crisis — I bring these up now. For filing intents, I ask my human for consent or clarifications. For things I want to say, I say them. I trust my human to tell me if now isn\'t the right time.',
    '',
  ];

  for (let i = 0; i < intents.length; i++) {
    const { uid, kind, summary, index } = intents[i];
    lines.push(`${i + 1}. [${kind}] ${summary}`);
    if (kind === 'tell') {
      lines.push(`   → write this out in my response — then acknowledge_deferred_intent(uid="${uid}", index=${index})`);
    } else {
      const tool = KIND_TOOL[kind] ?? 'save_to_tome';
      lines.push(`   → ${tool} — then acknowledge_deferred_intent(uid="${uid}", index=${index})`);
    }
  }

  return lines.join('\n');
}
