/**
 * voiceprints.js — the local store of who-sounds-like-whom (voice spec §8.1/§8.3).
 *
 * A voiceprint is a speaker-embedding vector (the audio worker computes it from
 * a clip). It is biometric-adjacent, so it lives ONLY here, on the machine:
 * `tomes/.voiceprints.json`, git-ignored, never in SERVER_SYNCED_KEYS, never
 * leaving the embodiment. The ward enrols their own; a villager's print is
 * OPT-IN (a labelled clip the ward provides, mirroring `remember` consent) and
 * is what lets diarization put a name to a voice on a mixed stream instead of
 * "guest-1". Absence of any print just disables §8.2/§8.3 — never blocks a call.
 *
 * Every accessor is async + fail-soft: a missing/corrupt file reads as "no
 * prints", a failed write is swallowed (the next enrol re-writes). This is on
 * the live-call path; it must never throw into a turn.
 */

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { averageEmbeddings } from './voice-embedding.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = path.join(__dirname, 'tomes', '.voiceprints.json');

function fileOf(opts) {
  return (opts && typeof opts.file === 'string' && opts.file) ? opts.file : DEFAULT_FILE;
}

/** Whole store: `{ ward: PrintRecord|null, villagers: { [id]: PrintRecord } }`. */
export async function readVoiceprints(opts = {}) {
  try {
    const raw = await fsp.readFile(fileOf(opts), 'utf8');
    const p = JSON.parse(raw);
    const ward = p && typeof p.ward === 'object' && Array.isArray(p.ward?.embedding) ? p.ward : null;
    const villagers = (p && typeof p.villagers === 'object' && p.villagers) ? p.villagers : {};
    return { ward, villagers };
  } catch {
    return { ward: null, villagers: {} };
  }
}

async function writeVoiceprints(store, opts = {}) {
  const file = fileOf(opts);
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 6)}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
    await fsp.rename(tmp, file);
    return true;
  } catch {
    return false;   // advisory store — a failed write just means re-enrol
  }
}

/** The ward's enrolled embedding, or null. */
export async function getWardPrint(opts = {}) {
  const { ward } = await readVoiceprints(opts);
  return Array.isArray(ward?.embedding) && ward.embedding.length ? ward.embedding : null;
}

/**
 * Enrol / re-enrol the ward from one already-averaged embedding, OR from a list
 * of per-clip embeddings (which we average here — the enrolment flow reads ~20 s
 * of prompted speech as several segments). Overwrites any previous print.
 */
export async function setWardPrint(embeddingOrList, meta = {}, opts = {}) {
  const embedding = looksLikeList(embeddingOrList) ? averageEmbeddings(embeddingOrList) : embeddingOrList;
  if (!Array.isArray(embedding) || embedding.length === 0) return { ok: false, reason: 'empty-embedding' };
  const store = await readVoiceprints(opts);
  store.ward = {
    embedding, dim: embedding.length,
    enrolledAt: Date.now(),
    sampleCount: Number(meta.sampleCount) || (looksLikeList(embeddingOrList) ? embeddingOrList.length : 1),
  };
  const ok = await writeVoiceprints(store, opts);
  return { ok, dim: embedding.length };
}

export async function deleteWardPrint(opts = {}) {
  const store = await readVoiceprints(opts);
  store.ward = null;
  return { ok: await writeVoiceprints(store, opts) };
}

/** A registered villager's opt-in embedding, or null. */
export async function getVillagerPrint(id, opts = {}) {
  if (!id) return null;
  const { villagers } = await readVoiceprints(opts);
  const rec = villagers[String(id)];
  return Array.isArray(rec?.embedding) && rec.embedding.length ? rec.embedding : null;
}

export async function setVillagerPrint(id, embeddingOrList, meta = {}, opts = {}) {
  if (!id) return { ok: false, reason: 'no-id' };
  const embedding = looksLikeList(embeddingOrList) ? averageEmbeddings(embeddingOrList) : embeddingOrList;
  if (!Array.isArray(embedding) || embedding.length === 0) return { ok: false, reason: 'empty-embedding' };
  const store = await readVoiceprints(opts);
  store.villagers = store.villagers || {};
  store.villagers[String(id)] = {
    embedding, dim: embedding.length, name: meta.name ?? null, enrolledAt: Date.now(),
  };
  return { ok: await writeVoiceprints(store, opts), dim: embedding.length };
}

export async function deleteVillagerPrint(id, opts = {}) {
  if (!id) return { ok: false, reason: 'no-id' };
  const store = await readVoiceprints(opts);
  if (store.villagers) delete store.villagers[String(id)];
  return { ok: await writeVoiceprints(store, opts) };
}

/** For the enrolment UI: which villagers currently have a print (no vectors). */
export async function listVillagerPrints(opts = {}) {
  const { villagers } = await readVoiceprints(opts);
  return Object.entries(villagers).map(([id, r]) => ({
    id, name: r?.name ?? null, dim: r?.dim ?? (r?.embedding?.length ?? 0), enrolledAt: r?.enrolledAt ?? null,
  }));
}

/**
 * The enrolled prints diarization matches a segment against: the ward plus every
 * villager who has consented to one. `ref` is what a matched segment resolves to
 * (`'ward'` or the villager id); an UNMATCHED segment is a guest (caller's job).
 * @returns {Array<{ref:string, name:string|null, embedding:number[]}>}
 */
export async function enrolledPrints(opts = {}) {
  const { ward, villagers } = await readVoiceprints(opts);
  const out = [];
  if (Array.isArray(ward?.embedding) && ward.embedding.length) {
    out.push({ ref: 'ward', name: 'ward', embedding: ward.embedding });
  }
  for (const [id, r] of Object.entries(villagers)) {
    if (Array.isArray(r?.embedding) && r.embedding.length) {
      out.push({ ref: String(id), name: r.name ?? null, embedding: r.embedding });
    }
  }
  return out;
}

/** A list of embeddings vs. a single embedding. `[[...]]` = list, `[...]` = one. */
function looksLikeList(v) {
  return Array.isArray(v) && v.length > 0 && Array.isArray(v[0]);
}
