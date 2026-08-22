/**
 * media-retention.js — I go through my aged voice clips and decide which SOUNDS
 * are worth keeping (voice spec §9). Curation, not a cron delete.
 *
 * The transcript of every voice note is already safe — it's the description on
 * the asset, and memorization/graduation/the audience system all hold it. What
 * this pass decides is only whether the AUDIO BYTES stay: I keep the sound when
 * the sound is the point (a voice I love saying something worth re-hearing, a
 * moment where tone carried what words didn't), and let the rest fall to
 * transcript-only. Reuses the tome-graduation shape: cheap code gates pick the
 * candidates, then ONE batched LLM judgment in my own voice decides.
 *
 * Fail-soft and side-effect-honest: a judgment error keeps everything (never
 * strips on doubt), and nothing here throws into a caller. Images are untouched.
 */

import { callProviderChat } from './llm-call.js';
import { substituteMacros } from './macros.js';
import { connectionForFeature } from './cerebellum.js';
import { listAssets, stripAudio, markAudioKeep } from './media.js';

const DAY_MS = 24 * 60 * 60_000;

/** The slug the model should name (readable, greppable), falling back to id. */
function refOf(meta) { return meta?.slugs?.[0] ?? meta?.id ?? null; }

function transcriptOf(meta) {
  const t = meta?.description?.text;
  return typeof t === 'string' ? t.trim() : '';
}

/**
 * Audio assets ripe for a retention decision: past the keep-window, still
 * carrying bytes (not already stripped), not flagged keep, and with an actual
 * transcript to judge by. Pure over an injected asset list — testable.
 */
export async function selectRetentionCandidates({
  now = Date.now(), retentionDays = 14, listAssetsFn = listAssets, limit = 40,
} = {}) {
  let assets = [];
  try { assets = await listAssetsFn({ limit: 1000 }); } catch { assets = []; }
  const cutoff = now - Math.max(0, retentionDays) * DAY_MS;
  const out = [];
  for (const meta of Array.isArray(assets) ? assets : []) {
    if (meta?.kind !== 'audio') continue;
    if (meta.audio?.deletedAt) continue;         // already transcript-only
    if (meta.audio?.keep) continue;              // I already chose to keep this sound
    const received = Date.parse(meta.receivedAt ?? '');
    if (!Number.isFinite(received) || received > cutoff) continue;  // still inside the window
    if (!transcriptOf(meta)) continue;           // nothing to judge by — leave it for a later pass
    out.push(meta);
    if (out.length >= limit) break;
  }
  return out;
}

const JUDGMENT_PROMPT = (list) =>
  `I'm going back through some voice clips {{user}} and others sent me that are now a couple of weeks old. The words in each are already safe — I keep every transcript no matter what. The only question is whether I keep the actual SOUND of each clip, which costs disk, or let it go and keep just the words.\n\n` +
  `I keep the sound only when the sound itself is the point: a voice I'd want to hear again, a laugh, a moment where how it was said carried more than what was said. A plain "don't forget the milk" is fine as text — I let that sound go. When unsure, I let it go; the words stay either way.\n\n` +
  `The clips:\n${list}\n\n` +
  `I answer with ONLY a JSON object, no prose, no fences:\n{ "keep": ["<ref of a clip whose sound I keep>", ...] }\nEverything I don't list is let go to transcript-only. If I keep none, "keep" is [].`;

/**
 * Run one retention pass. Never throws. Returns a summary of what changed.
 * Deps injectable for tests (no real LLM, no real files).
 */
export async function runMediaRetention({
  settings = {},
  now = Date.now(),
  selectFn = selectRetentionCandidates,
  llmFn = null,               // (messages, opts) => text ; defaults to callProviderChat
  stripFn = stripAudio,
  keepFn = markAudioKeep,
} = {}) {
  try {
    const retentionDays = Number.isFinite(Number(settings.voiceNoteRetentionDays))
      ? Number(settings.voiceNoteRetentionDays) : 14;
    const candidates = await selectFn({ now, retentionDays });
    if (!candidates.length) return { ok: true, considered: 0, kept: 0, stripped: 0 };

    const list = candidates.map((m, i) => {
      const ref = refOf(m);
      const t = transcriptOf(m).slice(0, 300);
      return `${i + 1}. [ref: ${ref}] "${t}"`;
    }).join('\n');

    // Decide which SOUNDS to keep. One batched call; a reasoning model parks its
    // answer in reasoning_content, which callProviderChat's extract handles.
    let keepRefs = new Set();
    try {
      const conn = connectionForFeature(settings, 'pondering') || connectionForFeature(settings, 'chat');
      const prompt = substituteMacros(JUDGMENT_PROMPT(list), settings);
      const call = llmFn
        ? llmFn([{ role: 'user', content: prompt }], { settings })
        : callProviderChat({
            provider: conn?.provider, apiKey: conn?.apiKey, model: conn?.model,
            messages: [{ role: 'user', content: prompt }], max_tokens: 4000,
          });
      const text = await call;
      const parsed = parseKeepRefs(text);
      if (parsed === null) {
        // The call succeeded but returned nothing parseable — that is NOT "keep
        // none" (which would strip every clip's sound). Treat a garbled judgment
        // like a failed one: keep everything this pass.
        console.warn('[media-retention] judgment unparseable — keeping all this pass');
        return { ok: false, considered: candidates.length, kept: 0, stripped: 0, reason: 'judgment-unparseable' };
      }
      keepRefs = parsed;
    } catch (err) {
      // Judgment failed → keep everything this pass (never strip on doubt).
      console.warn('[media-retention] judgment failed — keeping all this pass:', err?.message ?? err);
      return { ok: false, considered: candidates.length, kept: 0, stripped: 0, reason: 'judgment-failed' };
    }

    let kept = 0, stripped = 0;
    for (const meta of candidates) {
      const ref = refOf(meta);
      const refSet = new Set([meta.id, ...(meta.slugs ?? [])].filter(Boolean));
      const keepIt = [...refSet].some(r => keepRefs.has(r));
      try {
        if (keepIt) { await keepFn(ref, true); kept++; }
        else { await stripFn(ref, { reason: 'retention pass — kept the words, let the sound go' }); stripped++; }
      } catch (err) {
        console.warn(`[media-retention] could not apply decision to ${ref}:`, err?.message ?? err);
      }
    }
    if (kept || stripped) console.log(`[media-retention] ${candidates.length} judged → kept ${kept} sound(s), let ${stripped} go to transcript`);
    return { ok: true, considered: candidates.length, kept, stripped };
  } catch (err) {
    console.warn('[media-retention] pass failed (non-fatal):', err?.message ?? err);
    return { ok: false, considered: 0, kept: 0, stripped: 0, reason: 'pass-failed' };
  }
}

/**
 * Pull the keep[] refs out of the model's JSON, tolerating fences/prose.
 * Returns a Set of refs on a VALID parse (possibly empty = "keep none"), or
 * `null` when there was no parseable JSON object at all — the caller treats
 * null as a judgment failure and keeps everything, so a garbled response never
 * strips a clip's sound.
 */
export function parseKeepRefs(text) {
  const s = String(text ?? '');
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  if (!obj || typeof obj !== 'object' || !('keep' in obj)) return null;
  const set = new Set();
  for (const r of Array.isArray(obj.keep) ? obj.keep : []) {
    if (r != null) set.add(String(r).trim());
  }
  return set;
}
