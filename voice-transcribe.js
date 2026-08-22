/**
 * Listening to a voice note, once (voice spec §9).
 *
 * The exact shape of `describeAsset` in vision.js, in the register of hearing:
 * I listen to a recording one time, and what was said is cached on the asset
 * forever. Everything downstream — the stand-in, memorization, search, the
 * meaning-bearing slug — reads that cached text rather than the audio, which
 * is why a transcript outlives the bytes it came from.
 *
 * ── Why the transcript sits in `description` ────────────────────────────
 * Not a shortcut: it is the same slot for the same reason. `description` is
 * "the words I have for this thing" — everything that consumes it (the
 * stand-in builder, the slug graduation, memorization's fold) already treats
 * it that way and needed no change to hold a transcript. Giving audio its own
 * parallel field would have meant teaching every one of those consumers about
 * a second place to look.
 *
 * ── Pressing the button IS the consent ──────────────────────────────────
 * Voice notes consult ONLY `PROTO_FAMILIAR_VOICE_DISABLED`. Do not put
 * `voiceEnabled` back in front of them: it gated them once, which hid the
 * button and so hid the feature, and a deliberate press already carries the
 * browser's own permission prompt.
 *
 * `voiceEnabled` is for CONTINUOUS listening (live calls, Pass 2) — a mic
 * left open is a different thing and does need an explicit opt-in.
 *
 * ── It never throws ─────────────────────────────────────────────────────
 * Every caller is a chat path. A missing model, a dead worker, an unreadable
 * file — each becomes a recorded reason and a stand-in that says so. An
 * absent transcript renders as absence; it does not 500 a turn.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getAssetMeta, setAssetDescription, assetBytesPath } from './media.js';
import { composePlan } from './voice-models.js';
import { fetchPlan, MODELS_SUBDIR } from './voice-fetch.js';
import { normalizeTranscriptCase } from './voice-speech.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the recogniser is unpacked. Written by `POST /api/voice/install-models`
 * with `{what:'listen'}` (the path a ward actually takes), or by
 * `scripts/ensure-audio-models.mjs --extras=asr-offline` from a terminal.
 */
export const ASR_MODEL_DIR = path.join(__dirname, 'models', 'audio', 'asr-offline');

/**
 * Hybrid call transcription: re-transcribe each finished call utterance with this
 * accurate offline model instead of trusting the lossy streaming one. Default ON
 * (the streaming zipformer's "ENGRAVED"/"TOLL STO" errors make calls hard to
 * follow); the ward can turn it off — `voiceCallOfflineTranscribe:false` — if the
 * small per-utterance latency ever bothers them on their hardware. Hard
 * off-switch `PROTO_FAMILIAR_VOICE_OFFLINE_ASR_DISABLED=1`.
 */
export function voiceOfflineAsrEnabled(settings) {
  if (process.env.PROTO_FAMILIAR_VOICE_OFFLINE_ASR_DISABLED === '1') return false;
  return settings?.voiceCallOfflineTranscribe !== false;
}

/**
 * How long to wait for my human to actually STOP before I answer — the settle
 * window that stops me interrupting a longer thought (a pause between sentences
 * is not my cue to speak). Ward-tunable `voiceCallSettleMs` (clamped [0, 4000]);
 * default 1.5s. 0 disables (push-to-talk, where the release is the definitive end).
 */
export function voiceCallSettleMs(settings) {
  const n = Number(settings?.voiceCallSettleMs);
  if (Number.isFinite(n) && n >= 0) return Math.min(4000, Math.floor(n));
  return 1500;
}

/** Is the offline recogniser actually unpacked on disk (not just the dir)? */
export function offlineModelPresent() {
  return existsSync(path.join(ASR_MODEL_DIR, 'model.int8.onnx'));
}

let _offlineFetchInFlight = null;
/**
 * Make sure the offline recogniser is downloaded — the half that makes hybrid
 * call transcription an actual capability rather than a dead setting (the
 * every-capability-reachable rule). Idempotent + in-flight-guarded: a no-op when
 * already present, and concurrent calls share one download. Fetches ONLY the
 * `asr-offline` extra (not a whole voice), reusing the same plan the
 * `/api/voice/install-models {what:'listen'}` path uses. Never throws.
 */
export function ensureOfflineAsrModel({ rootDir, log = () => {} } = {}) {
  if (offlineModelPresent()) return Promise.resolve({ ok: true, already: true });
  if (_offlineFetchInFlight) return _offlineFetchInFlight;
  const plan = composePlan({ capabilityTier: 'read-aloud', voiceEngine: 'pocket', extras: ['asr-offline'] });
  const narrowed = { ...plan, voice: null, capability: [], all: plan.extras };
  const modelsDir = path.join(rootDir, MODELS_SUBDIR);
  log('accurate call-transcription model (SenseVoice) not installed — fetching it in the background; calls use basic transcription until it is ready');
  let lastPct = -1;
  _offlineFetchInFlight = fetchPlan({
    plan: narrowed, modelsDir,
    onProgress: (e) => {
      if (e?.phase === 'download' && e.totalBytes > 0) {
        const pct = Math.floor((e.receivedBytes / e.totalBytes) * 10) * 10;
        if (pct > lastPct) { lastPct = pct; log(`transcription model ${pct}%`); }
      } else if (e?.phase && e.phase !== 'download') { log(`transcription model ${e.phase}${e.file ? ` ${e.file}` : ''}`); }
    },
  })
    .then((r) => { log(r?.ok === false ? `transcription model download failed: ${r?.message ?? r?.reason}` : 'transcription model ready — the next call will use it'); return r; })
    .catch((err) => { log(`transcription model fetch errored: ${err?.message ?? err}`); return { ok: false }; })
    .finally(() => { _offlineFetchInFlight = null; });
  return _offlineFetchInFlight;
}

/**
 * Loading 226 MB of ONNX off a laptop disk is slow enough that an ordinary
 * request timeout would report a failure for something that was working —
 * the same trap the TTS load hit, so the same generous window.
 */
const LOAD_TIMEOUT_MS = 180_000;

/**
 * Decoding is roughly real-time on the reference machine, so the ceiling
 * scales with the clip and keeps a floor for short ones. A note that somehow
 * runs away is a failed transcription, not a hung turn.
 */
export function transcribeTimeoutMs(durationSec) {
  const d = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 60;
  return Math.min(15 * 60_000, Math.max(60_000, Math.round(d * 4 * 1000)));
}

/** The hard switch. Kills every part of voice, listening and speaking alike. */
export const voiceHardDisabled = () => process.env.PROTO_FAMILIAR_VOICE_DISABLED === '1';

/**
 * May I transcribe a note my human deliberately recorded? Only the hard
 * switch says no — the press was the consent.
 */
export const transcriptionAllowed = () => !voiceHardDisabled();

/**
 * May I listen CONTINUOUSLY (live calls, Pass 2)? That is the one that needs
 * an explicit opt-in, default OFF, and an explicit `false` honoured — `?? true`
 * here would silently leave a microphone open.
 */
export const continuousListeningAllowed = (settings = {}) =>
  settings?.voiceEnabled === true && !voiceHardDisabled();

/**
 * Listen to one voice note and cache what was said.
 *
 * @param {string} idOrSlug
 * @param {object} deps
 * @param {Function} deps.getWorker  async () => ({ worker }) — injected rather
 *   than imported, because the worker is owned by server.js and importing it
 *   here would be a cycle. It also makes this testable with a fake.
 * @returns {Promise<{ok:boolean, text?:string, reason?:string, cached?:boolean}>}
 */
export async function transcribeAsset(idOrSlug, { getWorker } = {}) {
  const meta = await getAssetMeta(idOrSlug);
  if (!meta) return { ok: false, reason: 'not-found' };
  if (meta.kind !== 'audio') return { ok: false, reason: 'not-audio' };

  // Listen ONCE. A cached transcript — even a recorded refusal — is not
  // re-derived; that is what makes this cheap to call from a chat path.
  if (meta.description !== null && meta.description !== undefined) {
    return { ok: true, cached: true, text: meta.description?.text ?? '' };
  }

  if (!transcriptionAllowed()) {
    // NOT cached — the hard switch can be taken off again, and a refusal that
    // outlives its own cause would leave a note permanently unheard. Same
    // reasoning as `no-worker` and `load-failed`.
    return { ok: false, reason: 'voice-disabled' };
  }

  // Only wav can be read without a decoder we do not ship. The browser
  // records straight to wav for exactly this reason, so this bites only on an
  // audio file that arrived from somewhere else — and then it says so rather
  // than failing obscurely.
  if (meta.ext !== 'wav') {
    await remember(meta.id, { text: '', reason: 'unreadable-format', detail: meta.mime });
    return { ok: false, reason: 'unreadable-format' };
  }

  let worker = null;
  let why = null;
  try { ({ worker, reason: why } = (await getWorker?.()) ?? {}); } catch { worker = null; }
  if (!worker) {
    // Deliberately NOT remembered: a worker that is down right now will be up
    // after a restart, and caching that as the asset's permanent transcript
    // would mean a note I could have heard stays unheard forever.
    //
    // `no-listening-engine` is its own answer: the speech engine isn't
    // installed on this machine at all, which is a different problem from a
    // worker that happens to be down, and my human deserves to be told which.
    return { ok: false, reason: why === 'no-listening-engine' ? 'no-listening-engine' : 'no-worker' };
  }

  try {
    const loaded = await worker.request(
      { op: 'load', role: 'asr-offline', modelDir: ASR_MODEL_DIR },
      { timeoutMs: LOAD_TIMEOUT_MS },
    );
    if (!loaded?.ok) {
      // Same reasoning: a model that has not been downloaded yet is a
      // "not yet", not a "never". My human can fetch it and the note is
      // waiting to be heard.
      return { ok: false, reason: loaded?.reason ?? 'load-failed', detail: loaded?.detail ?? null };
    }

    const said = await worker.request(
      { op: 'transcribe', wavPath: assetBytesPath(meta) },
      { timeoutMs: transcribeTimeoutMs(meta.durationSec) },
    );
    if (!said?.ok) {
      return { ok: false, reason: said?.reason ?? 'transcribe-failed', detail: said?.detail ?? null };
    }

    // Un-shout an all-caps result (a no-op on SenseVoice's already-cased output).
    const text = normalizeTranscriptCase(typeof said.text === 'string' ? said.text.trim() : '');
    // A recording with no speech in it is a real outcome, not an error — my
    // human's pocket, a false start, a room with nobody talking. It is cached
    // so the same silence is not decoded twice, and it is said plainly.
    await remember(meta.id, text
      ? { text, lang: said.lang ?? null, at: new Date().toISOString() }
      : { text: '', reason: 'no-speech', at: new Date().toISOString() });

    return { ok: true, text, lang: said.lang ?? null, elapsedMs: said.elapsedMs ?? null };
  } catch (err) {
    return { ok: false, reason: 'transcribe-failed', detail: String(err?.message ?? err) };
  }
}

/** Cache-write that never throws into a chat path. */
async function remember(id, description) {
  try { await setAssetDescription(id, description); } catch { /* the note stays untranscribed; the stand-in says so */ }
}

/**
 * My human fixes what I misheard.
 *
 * A recogniser mishears names, jargon, and anyone whose speech it wasn't
 * trained on — "wish me luck" came back as "Wish May Look". That transcript is
 * not a display detail: it IS the content of the note. It's what I read in the
 * turn, what memorisation folds into a memory, and what the asset's slug was
 * minted from. So a wrong one is wrong everywhere, and the person who knows
 * what they said should be able to say so.
 *
 * What this keeps:
 *   · `text`      — my human's words, now the transcript everything reads.
 *   · `auto`      — what I actually heard, kept rather than overwritten. I
 *                   should be able to tell the difference between what was said
 *                   and what I made of it, and it's the only way to see whether
 *                   my hearing is getting better or worse.
 *   · `corrected` — so nothing downstream mistakes a correction for my own
 *                   transcription, and I never claim I heard it correctly.
 *
 * The slug re-graduates from the corrected words (old ones keep resolving), so
 * a note I could only find as `wish-may-look-x7` becomes findable by what my
 * human actually said.
 */
export async function correctTranscript(idOrSlug, text, { getMeta = getAssetMeta, save = setAssetDescription } = {}) {
  const corrected = typeof text === 'string' ? text.trim() : '';
  if (!corrected) return { ok: false, reason: 'empty', detail: 'a correction needs words' };
  if (corrected.length > 20000) return { ok: false, reason: 'too-long', detail: 'that is longer than any voice note transcript' };

  const meta = await getMeta(idOrSlug);
  if (!meta) return { ok: false, reason: 'not-found' };
  if (meta.kind !== 'audio') return { ok: false, reason: 'not-audio' };

  const prior = meta.description ?? null;
  // Keep the FIRST machine transcript as `auto`, not the previous correction —
  // correcting twice must not overwrite what I originally heard with my human's
  // own earlier wording.
  const auto = typeof prior?.auto === 'string' ? prior.auto : (typeof prior?.text === 'string' ? prior.text : '');

  const next = {
    ...(prior && typeof prior === 'object' ? prior : {}),
    text: corrected,
    auto,
    corrected: true,
    correctedAt: new Date().toISOString(),
  };
  // A note that was silence or unreadable and now has words is no longer a
  // failure — drop the reason so nothing keeps rendering it as one.
  delete next.reason;

  const saved = await save(meta.id, next, { regraduate: true });

  if (saved?.ok === false) return { ok: false, reason: 'write-failed', detail: saved.error };
  return { ok: true, id: meta.id, slug: saved?.slugs?.[0] ?? meta.slugs?.[0] ?? null, text: corrected, auto };
}

/**
 * Transcribe every voice note in a turn's messages that has not been heard
 * yet, BEFORE the prompt is assembled.
 *
 * This is `ensureDescribed`'s sibling and exists for the same reason it does:
 * a fire-and-forget transcription lands *after* the prompt was built, so the
 * model answers a message it has not actually heard — and confidently, which
 * is worse. For a voice note there is no live-modality fallback at all; the
 * transcript is the only content there will ever be. So it happens first.
 *
 * Bounded: newest-first, capped, and each one is raced against a timeout so a
 * cold model load falls back to a stand-in that says "not yet" rather than
 * hanging my human's turn.
 */
export async function ensureTranscribed(messages, { getWorker, max = 4, perNoteTimeoutMs = 120_000 } = {}) {
  if (!transcriptionAllowed()) return { transcribed: 0, skipped: 'voice-disabled' };
  const list = Array.isArray(messages) ? messages : [];

  const ids = [];
  for (const m of list) {
    for (const a of Array.isArray(m?.attachments) ? m.attachments : []) {
      if (a?.id) ids.push(a.id);
    }
  }
  if (!ids.length) return { transcribed: 0 };

  // ⚠️ Filter BEFORE capping. This sliced the raw id list first, so the budget
  // counted items EXAMINED rather than notes transcribed — four images newer
  // than a voice note consumed the whole allowance on `continue`s and the note
  // was never heard, despite no work having been done. Newest-first so that if
  // the budget genuinely runs out, the note my human just recorded is the one
  // that got heard.
  const pending = [];
  for (const id of [...ids].reverse()) {
    if (pending.length >= max) break;
    const meta = await getAssetMeta(id);
    if (!meta || meta.kind !== 'audio' || meta.description !== null) continue;
    pending.push(id);
  }
  if (!pending.length) return { transcribed: 0 };

  let done = 0;
  for (const id of pending) {
    let timer = null;
    try {
      const raced = await Promise.race([
        transcribeAsset(id, { getWorker }),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), perNoteTimeoutMs); }),
      ]);
      if (raced?.ok) done++;
    } catch { /* one note failing never stops the turn */ }
    // An uncleared race timer keeps the event loop alive — the exact leak that
    // showed up as a 25s hang in the test suite when ensureDescribed shipped.
    finally { if (timer) clearTimeout(timer); }
  }
  return { transcribed: done };
}

/**
 * The one call a turn makes to hear what was spoken to it.
 *
 * Both surfaces call THIS, not `ensureTranscribed` with their own worker
 * wiring — RULE C, stated as code rather than as a matrix someone has to keep
 * up to date. It supplies the worker itself, self-gates on the listening
 * consent, and never throws.
 *
 * Deliberately NOT inside either surface's vision block: hearing is not
 * governed by whether the model can see, and nesting it there would mean
 * switching vision off silently made me deaf as well.
 */
export async function hearVoiceNotes(messages, { rootDir, label = 'voice' } = {}) {
  if (!transcriptionAllowed()) return { transcribed: 0 };
  try {
    // The LISTENING worker, not whichever one my human chose to speak with.
    const { listeningWorker } = await import('./audio-worker-current.js');
    const got = await ensureTranscribed(messages, {
      getWorker: () => listeningWorker({ rootDir }),
    });
    if (got.transcribed) console.log(`[${label}] listened to ${got.transcribed} voice note(s) before the turn`);
    return got;
  } catch (err) {
    console.warn(`[${label}] could not listen to a voice note: ${String(err?.message ?? err)}`);
    return { transcribed: 0 };
  }
}
