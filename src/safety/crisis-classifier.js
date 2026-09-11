/**
 * crisis-classifier.js — in-app inference for the ML distress classifier, and
 * the tier-asymmetric combination with the regex scorer (crisis-signals.js).
 * See docs/crisis-classifier-build-spec.md.
 *
 * ⚠️ SAFETY-CRITICAL. `scoreThreatMessage` is the live seam: every place a
 *    message's threat is scored (chat, Discord ward, both voice paths, the
 *    diagnostics tracer) routes the regex floor + the ML read through here.
 *    Validated model (recall .93 / precision .94, threshold 0.714) + ward
 *    sign-off cleared gate 3. The combination is still reviewable in isolation
 *    (combineThreat is pure), and the regex floor still fires on its own when
 *    the artifact is absent.
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
import { scoreMessage } from './crisis-signals.js';

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
  // An explicitly-passed `artifact` is authoritative — including `null`, which
  // means "no model" (tests rely on this to force the absent path
  // deterministically whether or not the git-ignored real model is on disk).
  // Only load the default when the caller omitted the key entirely.
  const art = artifact === undefined ? loadArtifact() : artifact;
  if (!art) return null;
  try {
    const out = { distress: scoreHead(art.distress, message) };
    if (art.normalization && validHead(art.normalization) && !normalizationDisabled(settings)) {
      out.normalization = scoreHead(art.normalization, message);
    }
    return out;
  } catch { return null; }
}

// ── The combination seam (tier-asymmetric; spec §5) — PURE ───────────────────
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

// ── The live seam — the ONE place the threat path scores a message ───────────
const round3 = x => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);

/**
 * Turn the combine `adjustments` into audit signals so the classifier's say is
 * recorded in threat-history exactly like a regex trigger (spec §5). The raise
 * lands as `ml_classifier`; softening and the normalization warning keep their
 * own descriptive ids.
 */
function mlAuditSignals(adjustments = []) {
  const out = [];
  for (const a of adjustments) {
    if (a.id === 'ml_distress_raise') {
      out.push({ id: 'ml_classifier', tier: tierForThreat(a.delta), p: round3(a.p), contribution: round3(a.delta) });
    } else if (a.id === 'ml_soften') {
      out.push({ id: 'ml_soften', p: round3(a.p), from: round3(a.from), to: round3(a.to) });
    } else if (a.id === 'ml_normalization_raise') {
      out.push({ id: 'ml_normalization', p: round3(a.p), contribution: round3(a.delta) });
    } else if (a.id === 'ml_severe_ceiling') {
      out.push({ id: 'ml_severe_ceiling' });
    }
  }
  return out;
}

/**
 * Score one message for the live threat path: the regex floor (crisis-signals)
 * combined with the ML read under the tier-asymmetric rules. A DROP-IN for
 * `scoreMessage` — returns `{ level, signals }` — with the ML detail attached
 * (`ml`, `posture`, `adjustments`) for callers that want it.
 *
 * Synchronous and NEVER throws: on a disabled/absent/failed classifier it
 * returns the raw regex result, so "no classifier" degrades toward the current
 * (more sensitive) behaviour, never a softer one. The RAISE threshold is read
 * from the artifact's own calibrated `distress.threshold` (0.714 on the shipped
 * model), not guessed — the exact-values rule (code repeats the number the
 * trainer chose).
 */
export function scoreThreatMessage(message, { settings = {}, artifact } = {}) {
  const regex = scoreMessage(message);   // { level, signals } — the floor
  try {
    if (!classifierDisabled(settings)) {
      const art = artifact === undefined ? loadArtifact() : artifact;
      const ml = scoreMessageMl(message, { settings, artifact: art });
      if (ml) {
        const threshold = Number.isFinite(art?.distress?.threshold)
          ? art.distress.threshold : CLASSIFIER_TUNING.RAISE_P;
        const tuning = { ...CLASSIFIER_TUNING, RAISE_P: threshold };
        const c = combineThreat(regex, ml, { settings, tuning });
        return {
          level:       c.level,
          signals:     [...regex.signals, ...mlAuditSignals(c.adjustments)],
          ml,
          posture:     c.posture,
          adjustments: c.adjustments,
        };
      }
    }
  } catch { /* fall through to the regex floor */ }
  return { level: regex.level, signals: regex.signals, ml: null, posture: {}, adjustments: [] };
}
