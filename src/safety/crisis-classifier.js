/**
 * crisis-classifier.js — in-app inference for the ML distress classifier, and
 * the tier-asymmetric combination with the regex scorer (crisis-signals.js).
 * See docs/crisis-classifier-build-spec.md.
 *
 * ⚠️ SAFETY-CRITICAL and, right now, INERT. Nothing here is called from the live
 *    threat path yet — wiring happens only after a validated model + ward
 *    sign-off (gate 3). The module is built + tested standalone so the seam is
 *    reviewable in isolation.
 *
 * Runtime reads a JSON artifact (models/crisis-classifier.json, git-ignored,
 * produced offline by scripts/train-crisis-classifier.py). It NEVER trains and
 * never runs Python. Pure JS: normalize → tokenize → TF-IDF (sublinear + l2) →
 * dot(coef)+intercept → sigmoid. No network, no native dep.
 *
 * Graceful degradation is absolute: a missing / unparseable / version-mismatch
 * artifact, or any thrown inference, yields NO signal — and because the
 * combination is raise-only for severe/high, "no classifier" degrades toward the
 * CURRENT (more sensitive) behaviour, never a softer one.
 */

import fs from 'fs';
import path from 'path';
import { REPO_ROOT } from '../../repo-root.js';
import { THREAT_TIERS, tierForThreat } from './threat-tracker.js';

const ARTIFACT_PATH = path.join(REPO_ROOT, 'models', 'crisis-classifier.json');
const ARTIFACT_VERSION = 1;   // must match the trainer's `version`

// ── The shared normalization — BYTE-FOR-BYTE mirror of the Python trainer's
// `normalize` (normalizer version "letters-v1"). If these ever diverge, every
// score is quietly wrong, so a parity test pins both to the same fixtures. ──
export function normalizeForMl(text) {
  let t = String(text ?? '').toLowerCase();
  t = t.replace(/https?:\/\/\S+|www\.\S+/g, ' ');   // URLs
  t = t.replace(/[^a-z'\s]/g, ' ');                  // keep a-z, apostrophe, whitespace
  t = t.replace(/(.)\1{2,}/g, '$1$1');               // 3+ char repeats → 2
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

/** Whitespace tokens of already-normalized text (mirrors the Python tokenize). */
export function tokenizeMl(norm) {
  return norm ? norm.split(' ').filter(Boolean) : [];
}

/** 1- and 2-grams, joined by a space for bigrams (mirrors sklearn's default). */
function grams(tokens) {
  const out = tokens.slice();
  for (let i = 0; i < tokens.length - 1; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

/**
 * Score one head (a {vocab, idf, coef, intercept}) on raw text → probability.
 * Replicates sklearn TfidfVectorizer(sublinear_tf=True, norm='l2') + logreg,
 * exactly matching the trainer's `score_head`.
 */
export function scoreHead(head, text) {
  const toks = tokenizeMl(normalizeForMl(text));
  const counts = new Map();
  for (const g of grams(toks)) counts.set(g, (counts.get(g) ?? 0) + 1);
  const { vocab, idf, coef, intercept } = head;
  const vec = new Map();   // idx → tf-idf
  for (const [g, c] of counts) {
    const idx = vocab[g];
    if (idx === undefined) continue;
    vec.set(idx, (1 + Math.log(c)) * idf[idx]);   // sublinear tf × idf
  }
  let norm = 0;
  for (const v of vec.values()) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  let dot = 0;
  for (const [idx, v] of vec) dot += (v / norm) * coef[idx];
  return sigmoid(dot + intercept);
}

// ── Artifact loading (cached; graceful) ─────────────────────────────────────
let _cache;   // undefined = not loaded; null = absent/invalid; object = artifact
function validHead(h) {
  return h && typeof h === 'object' && h.vocab && Array.isArray(h.idf)
    && Array.isArray(h.coef) && typeof h.intercept === 'number';
}
export function loadArtifact(file = ARTIFACT_PATH) {
  if (_cache !== undefined && file === ARTIFACT_PATH) return _cache;
  let art = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && parsed.version === ARTIFACT_VERSION && validHead(parsed.distress)) {
      art = parsed;   // normalization head is optional
    }
  } catch { art = null; }
  if (file === ARTIFACT_PATH) _cache = art;
  return art;
}
export function _resetArtifactCache() { _cache = undefined; }

// ── Off-switches (spec §1.7 + §5.5) ─────────────────────────────────────────
export function classifierDisabled(settings = {}) {
  return process.env.PROTO_FAMILIAR_THREAT_DISABLED === '1'
    || process.env.PROTO_FAMILIAR_CRISIS_CLASSIFIER_DISABLED === '1'
    || settings?.crisisClassifierEnabled === false;
}
export function normalizationDisabled(settings = {}) {
  return process.env.PROTO_FAMILIAR_CRISIS_NORMALIZATION_DISABLED === '1'
    || settings?.crisisNormalizationEnabled === false;
}

/**
 * The ML read of a message, or null when off / unavailable. Returns
 * { distress:0..1, normalization:0..1|undefined }. Never throws.
 */
export function scoreMessageMl(message, { settings = {}, artifact } = {}) {
  if (typeof message !== 'string' || !message) return null;
  if (classifierDisabled(settings)) return null;
  const art = artifact ?? loadArtifact();
  if (!art) return null;
  try {
    const out = { distress: scoreHead(art.distress, message) };
    if (art.normalization && validHead(art.normalization) && !normalizationDisabled(settings)) {
      out.normalization = scoreHead(art.normalization, message);
    }
    return out;
  } catch { return null; }
}

// ── The combination seam (tier-asymmetric; spec §5) — PURE, not yet wired ────
// Provisional thresholds: tuned on held-out data + ward-reviewed at gate 3.
export const CLASSIFIER_TUNING = Object.freeze({
  RAISE_P: 0.60,        // distress p at/above which the classifier adds concern
  SOFTEN_P: 0.25,       // distress p at/below which a MILD/MODERATE regex hit may be eased
  SOFTEN_FACTOR: 0.30,  // how much of the eased hit remains
  NORM_P: 0.60,         // normalization p at/above which the warning posture arms
  CLASSIFIER_MAX: THREAT_TIERS.high,   // classifier ALONE tops out at HIGH (4), never SEVERE
});

/**
 * Combine the regex result with the ML read into a final per-message level +
 * an audit trail + a posture flag. The invariants, made obvious in code:
 *   - severe/high are RAISE-ONLY (never eased here);
 *   - the classifier ALONE can't cross into SEVERE (only a regex severe signal can);
 *   - MILD/MODERATE may be eased when the model is confidently not-distress;
 *   - the normalization signal only ever RAISES + arms a pushback posture.
 * `ml` null (off/unavailable) → returns the regex level untouched.
 */
export function combineThreat(regex, ml, { settings = {}, tuning = CLASSIFIER_TUNING } = {}) {
  const base = Number.isFinite(regex?.level) ? regex.level : 0;
  const adjustments = [];
  const posture = {};
  let level = base;
  if (!ml) return { level, adjustments, posture };

  const regexSevere = tierForThreat(base) === 'severe';
  const regexTier = tierForThreat(base);

  // RAISE — distress the lexicon missed. Bounded so the classifier alone ≤ HIGH.
  if (Number.isFinite(ml.distress) && ml.distress >= tuning.RAISE_P) {
    const contribution = ((ml.distress - tuning.RAISE_P) / (1 - tuning.RAISE_P)) * tuning.CLASSIFIER_MAX;
    if (contribution > 0) { level += contribution; adjustments.push({ id: 'ml_distress_raise', p: ml.distress, delta: contribution }); }
  }

  // SOFTEN — a confidently-not-distress read may ease a MILD/MODERATE over-fire
  // (the ward's reported softening). NEVER touches severe/high.
  if (Number.isFinite(ml.distress) && ml.distress <= tuning.SOFTEN_P
      && (regexTier === 'mild' || regexTier === 'moderate')) {
    const eased = base * tuning.SOFTEN_FACTOR;
    if (eased < level) { adjustments.push({ id: 'ml_soften', p: ml.distress, from: level, to: eased }); level = eased; }
  }

  // NORMALIZATION — pro-suicide register: raise + arm the pushback posture.
  if (Number.isFinite(ml.normalization) && ml.normalization >= tuning.NORM_P) {
    const contribution = ((ml.normalization - tuning.NORM_P) / (1 - tuning.NORM_P)) * tuning.CLASSIFIER_MAX;
    if (contribution > 0) { level += contribution; adjustments.push({ id: 'ml_normalization_raise', p: ml.normalization, delta: contribution }); }
    posture.normalization = true;   // steer toward help; challenge the framing (spec §5.5)
  }

  // SEVERE ceiling: only a REGEX severe signal (or flag_distress elsewhere) may
  // reach severe. The classifier/normalization alone cap just below it.
  if (!regexSevere && level >= THREAT_TIERS.severe) {
    level = THREAT_TIERS.severe - 0.001;
    adjustments.push({ id: 'ml_severe_ceiling' });
  }

  return { level, adjustments, posture };
}
