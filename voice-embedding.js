/**
 * voice-embedding.js — the pure vector math under speaker recognition.
 *
 * A "voiceprint" is a speaker-embedding vector the audio worker computes from a
 * clip (sherpa-onnx's speaker-embedding extractor). Comparing two voices is a
 * cosine similarity; enrolling from several clips is an averaged, re-normalised
 * vector. None of that needs the model or the filesystem, so it lives here as
 * pure functions the watchdog, the diarizer, and the voiceprint store all share
 * — and that the tests can exercise without any audio at all.
 *
 * Everything is defensive: a malformed or mismatched vector yields 0 similarity
 * rather than a throw, because these run on the live-call path where an
 * exception must never reach my human's turn.
 */

/** L2 norm of a numeric vector. 0 for empty/garbage. */
export function norm(vec) {
  if (!Array.isArray(vec)) return 0;
  let s = 0;
  for (const x of vec) { const n = Number(x); if (Number.isFinite(n)) s += n * n; }
  return Math.sqrt(s);
}

/** Return a unit-length copy of `vec` (or a zero-length vector unchanged). */
export function l2normalize(vec) {
  const n = norm(vec);
  if (!(n > 0)) return Array.isArray(vec) ? vec.map(() => 0) : [];
  return vec.map(x => Number(x) / n);
}

/**
 * Cosine similarity of two embeddings, in [-1, 1]. Returns 0 (not a throw, not
 * NaN) when either is missing, the wrong length, or all-zero — the safe "these
 * don't match" answer on a path that must never crash.
 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]), y = Number(b[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Average several embeddings into one enrolled print: mean of the vectors, then
 * re-normalised to unit length (so the print sits on the same unit sphere as
 * the per-segment vectors it'll be compared against). Skips malformed rows;
 * returns [] if nothing usable remains.
 */
export function averageEmbeddings(list) {
  const rows = (Array.isArray(list) ? list : []).filter(v => Array.isArray(v) && v.length > 0);
  if (rows.length === 0) return [];
  const dim = rows[0].length;
  const usable = rows.filter(v => v.length === dim);
  if (usable.length === 0) return [];
  const sum = new Array(dim).fill(0);
  for (const v of usable) {
    for (let i = 0; i < dim; i++) {
      const x = Number(v[i]);
      if (Number.isFinite(x)) sum[i] += x;
    }
  }
  const mean = sum.map(x => x / usable.length);
  return l2normalize(mean);
}
