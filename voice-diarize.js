/**
 * voice-diarize.js — "which known voice is this?" on a MIXED stream (spec §8.3).
 *
 * When an adapter can't hand us one audio stream per speaker (the web mic; some
 * future platforms — Discord gives per-SSRC streams and skips this entirely),
 * the engine drops this stage between VAD and ASR: each finalized segment's
 * speaker-embedding is matched against the enrolled prints (the ward, plus any
 * villager who consented to one) and, failing that, against short-lived online
 * clusters so two unknown voices in one call stay distinct as `guest-1` /
 * `guest-2` instead of blurring together.
 *
 * The fail-closed default matters for the audience gate: an UNMATCHED voice
 * resolves to a guest ref, which the caller treats as stranger-tier — the same
 * disposition as an unknown Discord user. A name only attaches to a guest if the
 * conversation introduces one; the print is what makes it `ward` or a villager.
 *
 * Pure vector math + a call-scoped cluster map. No model, no I/O — the model
 * produced the embedding upstream; here we only compare. Fully unit-testable.
 */

import { cosineSimilarity, averageEmbeddings } from './voice-embedding.js';

export const DIARIZE_DEFAULTS = Object.freeze({
  matchThreshold: 0.5,     // cosine to accept an enrolled print (same scale as the watchdog)
  clusterThreshold: 0.55,  // cosine to fold a segment into an existing guest cluster
  clusterTtlMs: 5 * 60_000, // a guest cluster is call-scoped; forget it after this idle
});

/**
 * @param {object} cfg
 * @param {Array<{ref,name,embedding}>} cfg.prints  enrolled prints (voiceprints.enrolledPrints())
 * @returns {{ assign, reset, snapshot }}
 */
export function createDiarizer(cfg = {}) {
  const prints = Array.isArray(cfg.prints) ? cfg.prints.filter(p => Array.isArray(p?.embedding) && p.embedding.length) : [];
  const matchThreshold   = numOr(cfg.matchThreshold, DIARIZE_DEFAULTS.matchThreshold);
  const clusterThreshold = numOr(cfg.clusterThreshold, DIARIZE_DEFAULTS.clusterThreshold);
  const clusterTtlMs     = Math.max(0, numOr(cfg.clusterTtlMs, DIARIZE_DEFAULTS.clusterTtlMs));
  const now = typeof cfg.now === 'function' ? cfg.now : Date.now;

  /** @type {Map<string,{centroid:number[], members:number[][], lastTs:number}>} */
  const clusters = new Map();
  let guestSeq = 0;

  /**
   * @param {number[]} embedding
   * @param {object} [o] { ts }
   * @returns {{ ref:string, name:string|null, similarity:number, source:'print'|'cluster'|'new' }}
   */
  function assign(embedding, o = {}) {
    const ts = Number.isFinite(o.ts) ? o.ts : now();
    if (!Array.isArray(embedding) || embedding.length === 0) {
      return { ref: newGuest(embedding, ts), name: null, similarity: 0, source: 'new' };
    }
    expire(ts);

    // 1) Enrolled prints win — a known voice is a known voice.
    let best = null, bestSim = -Infinity;
    for (const p of prints) {
      const sim = cosineSimilarity(embedding, p.embedding);
      if (sim > bestSim) { bestSim = sim; best = p; }
    }
    if (best && bestSim >= matchThreshold) {
      return { ref: best.ref, name: best.name ?? null, similarity: bestSim, source: 'print' };
    }

    // 2) Otherwise, is it one of the guests we've already been hearing?
    let cRef = null, cSim = -Infinity;
    for (const [ref, c] of clusters) {
      const sim = cosineSimilarity(embedding, c.centroid);
      if (sim > cSim) { cSim = sim; cRef = ref; }
    }
    if (cRef && cSim >= clusterThreshold) {
      const c = clusters.get(cRef);
      c.members.push(embedding);
      c.centroid = averageEmbeddings(c.members);
      c.lastTs = ts;
      return { ref: cRef, name: null, similarity: cSim, source: 'cluster' };
    }

    // 3) A voice we haven't placed → a new guest.
    return { ref: newGuest(embedding, ts), name: null, similarity: 0, source: 'new' };
  }

  function newGuest(embedding, ts) {
    guestSeq += 1;
    const ref = `guest-${guestSeq}`;
    clusters.set(ref, {
      centroid: Array.isArray(embedding) && embedding.length ? averageEmbeddings([embedding]) : [],
      members: Array.isArray(embedding) && embedding.length ? [embedding] : [],
      lastTs: ts,
    });
    return ref;
  }

  function expire(ts) {
    if (clusterTtlMs <= 0) return;
    for (const [ref, c] of clusters) {
      if (ts - c.lastTs > clusterTtlMs) clusters.delete(ref);
    }
  }

  function reset() { clusters.clear(); guestSeq = 0; }
  function snapshot() { return { guests: clusters.size, guestSeq, matchThreshold, clusterThreshold }; }

  return { assign, reset, snapshot };
}

function numOr(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
