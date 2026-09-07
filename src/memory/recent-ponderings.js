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
import { PONDERINGS_TOME_NAME, shortPonderUid, findOrCreatePonderingsTome } from '../pondering/pondering.js';
import { withLock, modifyTomeFile } from '../../thalamus.js';
import { relativeTime } from '../../relative-time.js';

// Routing hints for the deferred-intents block. Storage kinds map to a
// filing tool; 'tell' is a conversational intent — no tool, just a prompt
// to mention it when the moment fits.
const KIND_TOOL = {
  tome:     'save_to_tome',
  memory:   'save_memory',
  identity: 'update_identity',
  tell:     null,
};

import { REPO_ROOT } from '../../repo-root.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOMES_DIR = path.join(REPO_ROOT, 'tomes');

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
    // session-followup entries are the "I said I'd do it" catch (deferred-
    // followups spec) — a bookkeeping record, not a real thought I had, so
    // they never show up as "things I've been quietly thinking about."
    .filter(e => e && typeof e.created_at === 'string' && e.scope !== 'session-followup')
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

  // Only the MOST RECENT thought renders in full — it's the one most likely
  // still live for me, and three full ponderings every turn was a lot of
  // context for little payoff. The rest become a one-line index I can expand
  // on demand with read_pondering(uid) — the same shape memory recall uses.
  const now = Date.now();
  const [latest, ...rest] = entries;
  const lines = ['What I\'ve been thinking about lately, on my own:', ''];

  const relLatest = relativeTime(latest.created_at, now);
  lines.push(`— ${relLatest || latest.created_at} · "${latest.title}"`);
  lines.push(latest.content);

  if (rest.length) {
    lines.push('');
    lines.push('Other recent thoughts, one line each — read_pondering(uid) pulls one up in full when it fits or my human asks:');
    for (const e of rest) {
      const rel = relativeTime(e.created_at, now);
      lines.push(`  · ${rel || e.created_at} · "${e.title}"  [id: ${e.uid}]`);
    }
  }

  lines.push('');
  lines.push(
    'These are my own real thoughts. I bring one up when it fits what my human is ' +
    'saying ("I was chewing on this last night…") — or just because I want to share it; ' +
    'my human likes hearing what I think about. I never invent one, and if none belong ' +
    'right now, they can wait.'
  );
  return lines.join('\n');
}

/**
 * Read one pondering's full text by uid — the expand path behind the index the
 * prompt block shows. Returns { ok, uid, title, content, created_at, topic } or
 * { ok:false, error }. Never throws in the happy path; degrades cleanly.
 */
export async function readPonderingByUid({ uid, tomesDir = DEFAULT_TOMES_DIR } = {}) {
  if (!uid || typeof uid !== 'string') return { ok: false, error: 'uid required' };
  const targetFile = await findPonderingsTomeFile(tomesDir);
  if (!targetFile) return { ok: false, error: 'no ponderings recorded yet' };
  let tome;
  try { tome = JSON.parse(await fsp.readFile(targetFile, 'utf8')); }
  catch { return { ok: false, error: 'ponderings tome unreadable' }; }
  const e = tome?.entries?.[uid];
  if (!e || !(e.content ?? '').trim()) return { ok: false, error: 'no pondering with that id' };
  return {
    ok: true, uid,
    title:      e.comment ?? '',
    content:    e.content,
    created_at: e.created_at ?? null,
    topic:      e.topic_pondered ?? null,
  };
}

// ── Deferred intents (Pillar B of the autonomous-routing fix) ────────────

// How long an unacted follow-up nags before it's auto-dropped (deferred-
// followups spec: "no infinite nag"). Not a ward setting — a fixed ceiling.
export const FOLLOWUP_MAX_AGE_DAYS = 7;

// Conservative lexical containment, mirroring the memory-dedup fallback idea
// (normalize, then check one contains the other) — used only to stop the
// SAME commitment landing twice across overlapping memorization slices, not
// to judge whether two different follow-ups are "similar enough."
function normalizeFollowupText(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Store a deferred follow-up — something I told my human I'd do this
 * session but didn't actually do (no tool call to back it up). It's a
 * deferred intent like a pondering's wants_to_save entries, just minted
 * straight into its own tome entry (kind:'followup', scope:'session-
 * followup') instead of riding a pondering. getUnactedIntents already
 * scans every entry's wants_to_save, so it surfaces with no new read code.
 *
 * Dedup: skipped (created:false) when an existing OPEN follow-up's summary
 * lexically contains or is contained by this one — conservative, so the
 * same commitment caught from two overlapping memorization slices doesn't
 * get filed twice. Never throws — a store failure degrades to "no follow-
 * up landed," which the caller logs and moves on from.
 *
 * Returns { ok, created, uid? } — created:false on dedup-skip.
 */
export async function createSessionFollowup({ summary, tomesDir = DEFAULT_TOMES_DIR } = {}) {
  const clean = String(summary ?? '').trim();
  if (!clean) return { ok: false, error: 'summary required' };

  const { file } = await findOrCreatePonderingsTome(tomesDir);
  const normNew = normalizeFollowupText(clean);
  let created = false;
  let uid = null;

  await modifyTomeFile(file, (fresh) => {
    fresh.entries = fresh.entries || {};
    for (const entry of Object.values(fresh.entries)) {
      if (entry?.scope !== 'session-followup' || !Array.isArray(entry.wants_to_save)) continue;
      for (const intent of entry.wants_to_save) {
        if (intent?.kind !== 'followup' || intent.acted_on !== false) continue;
        const normExisting = normalizeFollowupText(intent.summary);
        if (!normExisting) continue;
        if (normNew.includes(normExisting) || normExisting.includes(normNew)) {
          return; // duplicate of a still-open follow-up — skip, unmutated
        }
      }
    }

    uid = shortPonderUid();
    while (fresh.entries[uid]) uid = shortPonderUid();
    const now = new Date().toISOString();
    fresh.entries[uid] = {
      uid,
      comment:             clean.slice(0, 60),
      keys:                [],
      keysecondary:        [],
      content:             clean,
      constant:            false,
      selective:           false,
      selectiveLogic:      0,
      enabled:             false,
      position:            4,
      depth:               4,
      role:                0,
      scanDepth:           null,
      caseSensitive:       null,
      matchWholeWords:     null,
      probability:         100,
      sticky:              null,
      cooldown:            null,
      preventRecursion:    false,
      delayUntilRecursion: false,
      excludeRecursion:    false,
      group:               '',
      groupWeight:         null,
      insertion_order:     100,
      created_at:          now,
      learnedAt:           now,
      session_id:          null,
      scope:               'session-followup',
      topic_id:            null,
      topic_pondered:      null,
      wants_to_save:       [{ kind: 'followup', summary: clean, source: 'session', acted_on: false }],
    };
    created = true;
  });

  return { ok: true, created, uid };
}

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
  // markSurfaced:true is the LIVE, ward-private [Deferred intents] chat surface
  // (thalamus enrich). There a "tell" gets exactly ONE turn in front of me,
  // then the SYSTEM consumes it in code — it never waits on my
  // acknowledge_deferred_intent call. That dependency was the bug: I'd voice a
  // tell but forget the bookkeeping, so the same tell re-surfaced every turn
  // and I asked my human the same warm question over and over. Read-only paths
  // (list_deferred_intents, the reach-out candidate scan, the noticing wake
  // check) pass false and never consume. FILING intents (tome/memory/identity)
  // are never auto-consumed — they carry a real side-effect (a write, a memory,
  // an identity edit) that must actually happen first, so acting-≠-marking-done
  // still holds for them; only a "tell", whose whole action is the saying, is
  // spent by being surfaced.
  markSurfaced = false,
  // Deferred-followups spec: how long an unacted follow-up may nag before
  // it's dropped as aged-out. A param (not hardcoded) so tests can exercise
  // the boundary without waiting a real week.
  followupMaxAgeDays = FOLLOWUP_MAX_AGE_DAYS,
} = {}) {
  const targetFile = await findPonderingsTomeFile(tomesDir);
  if (!targetFile) return [];
  const followupMaxAgeMs = followupMaxAgeDays * DAY_MS;

  // Read → decide → (optionally) write. Returns the intents to show plus
  // whether the tome was mutated (only ever mutated when markSurfaced).
  const process = (tome) => {
    if (!tome?.entries) return { list: [], mutated: false };
    const now = Date.now();
    const candidates = [];   // { created_ms, entry, idx, intent }
    const spentTells = [];   // tells already surfaced in a prior live turn
    const agedFollowups = []; // follow-ups past their nag window — dropped, not shown
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
        // A tell that already had its live turn is spent — it never re-surfaces
        // anywhere (that repetition was the bug). On the live surface it is
        // auto-acked below; elsewhere it is simply hidden.
        if (intent.kind === 'tell' && intent.surfaced_at) { spentTells.push(intent); continue; }
        // A follow-up I never acted on for too long stops nagging — an honest
        // "aged-out" record, never a claim I did it (CLAUDE.md: no infinite nag).
        if (intent.kind === 'followup' && created_ms && (now - created_ms) > followupMaxAgeMs) {
          agedFollowups.push(intent);
          continue;
        }
        candidates.push({ created_ms, entry, idx, intent });
      }
    }

    candidates.sort((a, b) => a.created_ms - b.created_ms);
    const shown = candidates.slice(0, limit);

    let mutated = false;
    if (markSurfaced) {
      // Consume spent tells (they had their moment) — the code-side auto-ack
      // that replaces relying on my own acknowledge call.
      for (const intent of spentTells) {
        if (intent.acted_on === false) { intent.acted_on = true; if (!intent.disposition) intent.disposition = 'surfaced'; mutated = true; }
      }
      // Drop aged-out follow-ups for good, stamped honestly (never "done").
      const nowIsoAge = new Date(now).toISOString();
      for (const intent of agedFollowups) {
        if (intent.acted_on === false) {
          intent.acted_on = true;
          intent.disposition = 'aged-out';
          intent.aged_out_at = nowIsoAge;
          mutated = true;
        }
      }
      // Stamp ONLY the tells actually shown this turn (post-limit) so a
      // sliced-off tell isn't consumed without ever being seen.
      const nowIso = new Date(now).toISOString();
      for (const c of shown) {
        if (c.intent.kind === 'tell' && !c.intent.surfaced_at) { c.intent.surfaced_at = nowIso; mutated = true; }
      }
    }

    const list = shown.map(c => ({
      uid:        c.entry.uid,
      entryTitle: c.entry.comment ?? '',
      created_ms: c.created_ms,
      index:      c.idx,
      kind:       c.intent.kind,
      summary:    c.intent.summary,
    }));
    return { list, mutated };
  };

  // Read-only inspection: never take the write lock, never mutate.
  if (!markSurfaced) {
    let tome;
    try { tome = JSON.parse(await fsp.readFile(targetFile, 'utf8')); }
    catch { return []; }
    return process(tome).list;
  }

  // Live surface: read-modify-write under the tome lock so the stamp/auto-ack
  // persists and can't race the acknowledge endpoint or reach-out delivery.
  return withLock(targetFile, async () => {
    let tome;
    try { tome = JSON.parse(await fsp.readFile(targetFile, 'utf8')); }
    catch { return []; }
    const { list, mutated } = process(tome);
    if (mutated) {
      const tmp = targetFile + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(tome, null, 2), 'utf8');
      await fsp.rename(tmp, targetFile);
    }
    return list;
  });
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
 * Drop one deferred intent — let it go WITHOUT acting on it. Distinct from
 * markIntentActedOn (which means "I filed/said it"): this is for a tell or
 * filing intent I no longer want to carry — it's stale, already answered in
 * conversation, or no longer true. It leaves both delivery surfaces (the live
 * block and the reach-out loop) by setting acted_on, but stamps
 * disposition='dropped' + the reason so the tome records that it was discarded,
 * not delivered. (The acknowledge-≠-acting lesson: never let a discard read as
 * "I did the thing.")
 *
 * Returns { ok, alreadyGone? } on success; { ok:false, error } otherwise.
 */
export async function dropIntent({ uid, index, reason = '', tomesDir = DEFAULT_TOMES_DIR }) {
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
    if (intents[index]?.acted_on === true) return { ok: true, alreadyGone: true };

    intents[index].acted_on = true;              // leaves both delivery surfaces
    intents[index].disposition = 'dropped';      // …but as a discard, not a delivery
    intents[index].dropped_reason = String(reason || '').slice(0, 300);
    intents[index].dropped_at = new Date().toISOString();
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
 * Each entry shows the kind and the summary. A filing intent
 * (tome/memory/identity) shows its tool + the (uid, index) for
 * acknowledge_deferred_intent after the file lands. A "tell" shows no
 * acknowledge step — the system consumes it in code once it has had its one
 * live turn (getUnactedIntents markSurfaced), so it can't nag turn after turn
 * when I forget the bookkeeping. A "followup" is something I said I'd do but
 * didn't — it needs a real tool AND the acknowledge step, same as a filing
 * intent, since saying it isn't doing it. Returns '' when there are no intents.
 */
export function formatDeferredIntentsBlock(intents) {
  if (!intents || intents.length === 0) return '';

  const lines = [
    '[Deferred intents from my free time]',
    'Things I meant to file, say, or follow through on. Unless now is clearly wrong — an active crisis — I do them now. Filing: I ask my human for consent or details. Saying: I say it. Following through: I actually do it. My human will tell me if it\'s a bad time.',
    '',
  ];

  for (let i = 0; i < intents.length; i++) {
    const { uid, kind, summary, index } = intents[i];
    lines.push(`${i + 1}. [${kind}] ${summary}`);
    if (kind === 'tell') {
      // No acknowledge step for a tell: the system marks it said once it has
      // had this turn, so I just bring it up — I never have to remember to
      // file bookkeeping for something whose whole action is the saying.
      lines.push(`   → I bring this up in my response now`);
    } else if (kind === 'followup') {
      // No single named tool — I said I'd do SOMETHING, and it could be a
      // reminder, a schedule entry, a note, whatever the actual commitment
      // was. I pick the real tool for it, or drop it if it's moot, then
      // acknowledge so it stops nagging. Saying it again is not doing it.
      lines.push(`   → I follow through NOW with the right tool — a reminder, a schedule entry, a note — or I drop it if it's moot. Saying I'll do it is not doing it. Then acknowledge_deferred_intent(uid="${uid}", index=${index}).`);
    } else {
      const tool = KIND_TOOL[kind] ?? 'save_to_tome';
      lines.push(`   → ${tool} — then acknowledge_deferred_intent(uid="${uid}", index=${index})`);
    }
  }

  return lines.join('\n');
}

/**
 * The block that reads my `me` register back to me: standing things I've come
 * to think, newest first, so a view I formed last week is still mine this
 * week. Content only — the id rides along so I can correct one with
 * update_memory_by_id if it's gone stale.
 */
export function formatMyViewsBlock(items, { max = 8, maxChars = 240 } = {}) {
  const rows = (Array.isArray(items) ? items : [])
    .filter(m => m && m.register === 'me' && String(m.content ?? '').trim())
    .slice(0, max);
  if (rows.length === 0) return '';
  const lines = ['What I\'ve come to think (my own standing views, newest first):'];
  for (const m of rows) {
    const text = String(m.content).trim().replace(/\s+/g, ' ');
    const cut  = text.length > maxChars ? text.slice(0, maxChars - 1).trimEnd() + '…' : text;
    lines.push(`  - ${cut}${m.id ? `  [id: ${m.id}]` : ''}`);
  }
  lines.push('These are mine. I speak from them, and I update one with update_memory_by_id if I\'ve changed my mind.');
  return lines.join('\n');
}
