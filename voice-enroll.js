/**
 * voice-enroll.js — turning recorded clips into a stored voiceprint (spec §8.1/§8.3).
 *
 * The orchestration between the audio worker's `embed` op (which turns a wav
 * into a speaker-embedding vector) and the local voiceprint store: load the
 * speaker model once, embed each enrolment clip, average them into one print,
 * and write it. The ward enrols themselves from ~20 s of prompted speech (several
 * clips); a villager is enrolled — opt-in — from a labelled clip the ward provides.
 *
 * Worker is INJECTED (`getWorker`), never imported, for the same reasons
 * transcribeAsset injects it: the worker is server-owned (a static import would
 * cycle) and injection makes this testable with a fake. Never throws into a
 * caller; a failure is a structured `{ok:false, reason}`.
 */

import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setWardPrint, setVillagerPrint } from './voiceprints.js';
import { averageEmbeddings } from './voice-embedding.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Models unpack to models/audio/<model.id>/ (same as asr-offline). The default
// speaker model is CAM++ (BASE_MODELS id `speaker-embed`); the optional "swanky"
// upgrade is NeMo TitaNet-Large (`speaker-embed-large`). Whichever the ward has
// active is loaded — the extractor just finds the sole .onnx in the dir.
export const SPEAKER_MODEL_DIR       = path.join(__dirname, 'models', 'audio', 'speaker-embed');
export const SPEAKER_MODEL_DIR_LARGE = path.join(__dirname, 'models', 'audio', 'speaker-embed-large');

/** The active speaker-model directory for these settings (default = CAM++). */
export function speakerModelDir(settings = {}) {
  return settings?.voiceSpeakerModel === 'titanet-large' ? SPEAKER_MODEL_DIR_LARGE : SPEAKER_MODEL_DIR;
}

const LOAD_TIMEOUT_MS  = 180_000;   // a cold onnx load off laptop disk
const EMBED_TIMEOUT_MS = 30_000;    // one short clip

/** Is the speaker model actually unpacked (an .onnx present), not just the dir? */
export function speakerModelPresent(dir = SPEAKER_MODEL_DIR) {
  try {
    if (existsSync(path.join(dir, 'model.onnx'))) return true;
    return readdirSync(dir).some(f => f.endsWith('.onnx'));
  } catch { return false; }
}

/**
 * Embed ONE wav into a number[] voiceprint. Loads the speaker model on the
 * worker (idempotent), then runs the `embed` op. Returns `{ok, embedding, dim}`
 * or a structured failure. Never throws.
 */
export async function embedClip(wavPath, { getWorker, modelDir = SPEAKER_MODEL_DIR } = {}) {
  if (!wavPath || typeof wavPath !== 'string') return { ok: false, reason: 'bad-request' };
  let worker = null, why = null;
  try { ({ worker, reason: why } = (await getWorker?.()) ?? {}); } catch { worker = null; }
  if (!worker) return { ok: false, reason: why === 'no-listening-engine' ? 'no-listening-engine' : 'no-worker' };

  try {
    const loaded = await worker.request({ op: 'load', role: 'speaker', modelDir }, { timeoutMs: LOAD_TIMEOUT_MS });
    if (!loaded?.ok) return { ok: false, reason: loaded?.reason ?? 'load-failed', detail: loaded?.detail ?? null };
    const r = await worker.request({ op: 'embed', wavPath }, { timeoutMs: EMBED_TIMEOUT_MS });
    if (!r?.ok) return { ok: false, reason: r?.reason ?? 'embed-failed', detail: r?.detail ?? null };
    if (!Array.isArray(r.embedding) || r.embedding.length === 0) return { ok: false, reason: 'empty-embedding' };
    return { ok: true, embedding: r.embedding, dim: r.dim ?? r.embedding.length };
  } catch (err) {
    return { ok: false, reason: 'embed-failed', detail: String(err?.message ?? err) };
  }
}

/**
 * Embed several clips and average them into one enrolment vector. A clip that
 * fails to embed (too short, silence) is skipped, not fatal — but we require at
 * least one usable clip so a print is never written from nothing.
 * @returns {Promise<{ok:boolean, embedding?:number[], used?:number, reason?:string}>}
 */
export async function embedClips(wavPaths, deps = {}) {
  const paths = Array.isArray(wavPaths) ? wavPaths.filter(p => typeof p === 'string' && p) : [];
  if (!paths.length) return { ok: false, reason: 'no-clips' };
  const embeddings = [];
  let lastReason = 'no-usable-clip';
  for (const p of paths) {
    const r = await embedClip(p, deps);
    if (r.ok) embeddings.push(r.embedding);
    else lastReason = r.reason;
  }
  if (!embeddings.length) return { ok: false, reason: lastReason };
  const embedding = averageEmbeddings(embeddings);
  if (!embedding.length) return { ok: false, reason: 'empty-embedding' };
  return { ok: true, embedding, used: embeddings.length };
}

/** Enrol / re-enrol the ward from their prompted clips. `voiceprintsFile`
 *  overrides the store path (tests point it at a temp file). */
export async function enrollWard(wavPaths, { voiceprintsFile, ...deps } = {}) {
  const r = await embedClips(wavPaths, deps);
  if (!r.ok) return r;
  const opts = voiceprintsFile ? { file: voiceprintsFile } : {};
  const saved = await setWardPrint(r.embedding, { sampleCount: r.used }, opts);
  return saved.ok ? { ok: true, dim: saved.dim, used: r.used } : { ok: false, reason: 'store-write-failed' };
}

/** Enrol a villager (opt-in) from a labelled clip the ward provides. */
export async function enrollVillager(id, wavPaths, { name = null, voiceprintsFile, ...deps } = {}) {
  if (!id) return { ok: false, reason: 'no-id' };
  const r = await embedClips(wavPaths, deps);
  if (!r.ok) return r;
  const opts = voiceprintsFile ? { file: voiceprintsFile } : {};
  const saved = await setVillagerPrint(id, r.embedding, { name }, opts);
  return saved.ok ? { ok: true, dim: saved.dim, used: r.used } : { ok: false, reason: 'store-write-failed' };
}
