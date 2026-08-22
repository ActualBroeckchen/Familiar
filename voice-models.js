/**
 * Voice model registry + tier composition (voice spec §0.1, §0.7).
 *
 * Two jobs, both pure:
 *   1. Hold the pinned manifest — what each audio model is, where it comes
 *      from, its sha256, its exact size on disk.
 *   2. Compose a fetch PLAN from the ward's two independent choices
 *      (capability tier × voice engine) and evaluate that plan against the
 *      §0.7 footprint ceilings.
 *
 * Why the two axes are separate: collapsing them makes the ward with the
 * smallest disk the one whose Familiar sounds least like themselves. Voice is
 * part of identity (§6.5), so the expressive engine is the default at every
 * capability tier — piper is a fallback the ward is *offered*, never one they
 * are silently assigned.
 *
 * ── The exact-values rule, applied to downloads ──────────────────────────
 * `sha256` and `bytes` are machine facts. They are NEVER hand-written: they
 * are computed by `scripts/pin-audio-models.mjs`, which downloads a candidate
 * and records what it actually got. Until an entry is pinned, `sha256` is
 * null and `isPinned()` is false — and the fetcher REFUSES to install it.
 * An unverifiable download is not a smaller risk than no download; it is a
 * silent one.
 *
 * `estBytes` exists only so the ward can be shown a size and the pre-flight
 * free-space check has something to work with BEFORE a pin exists. Every
 * surface that reports an estimated figure must say so — see `planSize()`,
 * which returns `estimated: true` whenever any entry fell back to it.
 */

import { readFileSync } from 'node:fs';
import { isArchive } from './voice-extract.js';

// ── Axes ─────────────────────────────────────────────────────────────────

/** Capability: how much of me is listening. Chosen independently of voice. */
export const CAPABILITY_TIERS = ['read-aloud', 'listening', 'listening-plus'];

/** Voice engine. `pocket` is the default at EVERY capability tier (§0.7). */
export const VOICE_ENGINES = ['pocket', 'piper'];

export const DEFAULT_CAPABILITY_TIER = 'listening';
export const DEFAULT_VOICE_ENGINE = 'pocket';

/** Roles a capability tier pulls in, beyond the chosen voice. */
const TIER_ROLES = {
  'read-aloud': [],
  'listening': ['vad', 'asr-streaming'],
  'listening-plus': ['vad', 'asr-streaming', 'enhance', 'speaker'],
};

/**
 * Opt-in extras. Never implied by a tier — each is fetched only when the ward
 * names it, with its size stated at the point of choice (§0.7).
 */
export const EXTRA_ROLES = ['asr-offline', 'lid', 'kws', 'punct', 'tagging'];

/**
 * §0.7 ceilings, in bytes. These are the budget the build is measured
 * against, not decoration: `evaluatePlan()` reports violations and Pass 0's
 * bench replaces the estimates behind them with measurements.
 *
 * `capability` ceilings cover what the tier adds BEYOND the voice, which is
 * why they are additive and why the voice engine has its own line.
 */
const MB = 1024 * 1024;
export const CEILINGS = {
  voice: { pocket: 250 * MB, piper: 60 * MB },
  capability: {
    'read-aloud': 0,
    'listening': 150 * MB,
    'listening-plus': 250 * MB,   // listening's 150 + 100 for enhance/speaker
  },
};

// ── Languages ────────────────────────────────────────────────────────────

/**
 * ASR languages we know upstream has a streaming model for.
 *
 * **English is the default and the only thing fetched unless a ward asks for
 * something else.** A second language is a deliberate second choice, priced
 * separately (§0.7 rule 2) — nothing here is bundled because it exists.
 *
 * Adding a language is a row here plus a pin, never a code change. `asset` is
 * the upstream filename, recorded so the pinning script's URL and this table
 * cannot drift apart silently; `DEFAULT_ASR_LANG` is what an unconfigured
 * install listens in.
 *
 * Every row was checked against the `asr-models` release listing (2026-07).
 * A language absent from this table is *unsupported*, not broken — and
 * `composePlan` reports the request rather than dropping it (see
 * `unavailableLangs`), because silently listening in the wrong language is
 * the sort of failure a ward would never think to look for.
 */
export const DEFAULT_ASR_LANG = 'en';

/**
 * Upstream publishes assets under per-kind release tags on one repo. A model
 * records `{tag, asset}` and the url is built from it — so nobody retypes a
 * release path, and a model's home is a fact in the manifest rather than
 * knowledge someone has to hold.
 */
const UPSTREAM_REPO = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
export const upstreamUrl = (upstream) =>
  (upstream?.tag && upstream?.asset) ? `${UPSTREAM_REPO}/${upstream.tag}/${upstream.asset}` : null;

export const ASR_LANGUAGES = Object.freeze([
  { lang: 'en', label: 'English', upstream: { tag: 'asr-models', asset: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17.tar.bz2' }, estBytes: 80 * 1024 * 1024 },
  { lang: 'de', label: 'German', upstream: { tag: 'asr-models', asset: 'sherpa-onnx-streaming-zipformer-de-kroko-2025-08-06.tar.bz2' }, estBytes: 80 * 1024 * 1024 },
  { lang: 'fr', label: 'French', upstream: { tag: 'asr-models', asset: 'sherpa-onnx-streaming-zipformer-fr-2023-04-14.tar.bz2' }, estBytes: 80 * 1024 * 1024 },
  { lang: 'ko', label: 'Korean', upstream: { tag: 'asr-models', asset: 'sherpa-onnx-streaming-zipformer-korean-2024-06-16.tar.bz2' }, estBytes: 80 * 1024 * 1024 },
  { lang: 'zh', label: 'Chinese', upstream: { tag: 'asr-models', asset: 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23.tar.bz2' }, estBytes: 80 * 1024 * 1024 },
]);

/** Every language we have curated a model for — the table, regardless of pin state. */
export const supportedAsrLangs = () => ASR_LANGUAGES.map((l) => l.lang);
export const asrLanguage = (lang) => ASR_LANGUAGES.find((l) => l.lang === lang) ?? null;

/**
 * Languages a ward can actually pick right now: curated AND pinned.
 *
 * There are three states here, not two, and conflating them would put a
 * language in a menu that cannot be fetched:
 *   - not in the table      → unsupported; `composePlan` reports it
 *   - in the table, no pin  → curated but not yet verified; not offered
 *   - in the table, pinned  → offered
 *
 * Ward-facing surfaces use THIS list. `supportedAsrLangs()` is for tooling
 * that needs to know what exists to be pinned.
 */
export const availableAsrLangs = () =>
  ASR_LANGUAGES.filter((l) => isPinned(modelById(`asr-streaming-${l.lang}`))).map((l) => l.lang);

// ── The manifest ─────────────────────────────────────────────────────────

/**
 * One entry per fetchable model. `files` is the unit of download and of
 * content-addressing: two entries sharing a file (a vocoder, a shared voice)
 * name the same `sha256`, so the store holds the bytes once and switching
 * tiers never duplicates them (§0.7 rule 5).
 *
 * `estBytes` figures come from the spec's §0.1 table and are explicitly
 * estimates pending Pass 0.
 *
 * The `files` arrays here are deliberately EMPTY. Urls, checksums and byte
 * counts are machine facts and live in `voice-model-pins.json`, written by
 * `scripts/pin-audio-models.mjs` from what it actually downloaded. Keeping
 * them out of hand-edited source is the exact-values rule made structural:
 * there is no line here for someone to type a hash into.
 */
const BASE_MODELS = Object.freeze([
  {
    id: 'vad-silero',
    role: 'vad',
    engine: null,
    lang: null,
    label: 'Silero VAD',
    why: 'Gates everything — no speech, no decoding, no bytes kept.',
    estBytes: 2 * MB,
    // A bare .onnx, not an archive — the one model that needs no extraction.
    upstream: { tag: 'asr-models', asset: 'silero_vad_v5.onnx' },
    files: [],
  },
  ...ASR_LANGUAGES.map((l) => ({
    id: `asr-streaming-${l.lang}`,
    role: 'asr-streaming',
    engine: null,
    lang: l.lang,
    label: `Streaming ASR (${l.label})`,
    why: `Live transcription with partials and endpointing, in ${l.label}.`,
    estBytes: l.estBytes,
    upstream: l.upstream,
    files: [],
  })),
  {
    id: 'tts-pocket',
    role: 'tts',
    engine: 'pocket',
    // Upstream ships and documents this as English. Treated as English until
    // measured otherwise rather than assumed multilingual — a voice that
    // mangles a ward's language is worse than one that never claimed to speak it.
    lang: 'en',
    label: 'PocketTTS',
    why: 'Expressive prosody, and zero-shot voice cloning from a short reference clip — no reference transcript needed. The voice that can actually be mine (§6.5).',
    estBytes: 200 * MB,
    upstream: { tag: 'tts-models', asset: 'sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2' },
    // Seven files in one archive (lm_flow, lm_main, encoder, decoder,
    // text_conditioner, vocab.json, token_scores.json) plus sample reference
    // wavs — which is why the archive, not the loose file, is the pin unit.
    needsReferenceAudio: true,
    files: [],
  },
  {
    id: 'tts-piper',
    role: 'tts',
    engine: 'piper',
    lang: 'multi',
    label: 'piper / VITS voice',
    why: 'The fallback: small and fast, fixed speakers, flatter delivery. Offered when PocketTTS will not fit, and the mid-call shed target.',
    estBytes: 40 * MB,
    files: [],
  },
  {
    id: 'enhance-gtcrn',
    role: 'enhance',
    engine: null,
    lang: null,
    label: 'GTCRN denoiser',
    why: 'Cleans a bad microphone before the decoder sees it — most wards will not have a voice-isolating mic.',
    estBytes: 10 * MB,
    files: [],
  },
  {
    // DEFAULT speaker model: 3D-Speaker CAM++ (English VoxCeleb). Small + fast
    // (tens of ms/utterance — matters for the live guest watchdog) and plenty
    // accurate to tell a household's voices apart. Speaker embeddings are
    // language-independent (timbre, not words), so it serves a bilingual home.
    // NOTE: the asset filename below is the standard sherpa name; the fetch is
    // self-verifying (a wrong name 404s) and `pin-audio-models.mjs` records the
    // real sha256 + size — those are never hand-written (see the file header).
    id: 'speaker-embed',
    role: 'speaker',
    engine: null,
    lang: null,
    label: '3D-Speaker CAM++ (English VoxCeleb)',
    why: 'Voiceprint enrollment, the guest watchdog, diarization. The default.',
    upstream: { tag: 'speaker-recongition-models', asset: '3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx' },
    estBytes: 28 * MB,
    files: [],
  },
  {
    // OPTIONAL "swanky" upgrade: NeMo TitaNet-Large. ~3.5× the disk and a touch
    // slower, for a bit more speaker-verification accuracy. Opt-in — the ward
    // downloads it and sets voiceSpeakerModel:'titanet-large' to activate; it
    // unpacks to models/audio/speaker-embed-large/ and the loader finds it there.
    id: 'speaker-embed-large',
    role: 'speaker',
    engine: null,
    lang: null,
    label: 'NeMo TitaNet-Large (English, higher accuracy)',
    why: 'Optional upgrade for the speaker model — more accurate, larger.',
    upstream: { tag: 'speaker-recongition-models', asset: 'nemo_en_titanet_large.onnx' },
    estBytes: 97 * MB,
    files: [],
  },
  {
    id: 'asr-offline',
    role: 'asr-offline',
    // SenseVoice, not a per-language streaming model: a voice note is decoded
    // once with no one waiting, so accuracy is the only axis that matters and
    // latency is free. It also covers zh/en/ja/ko/yue in ONE model, which is
    // the difference between a bilingual household being supported and being
    // asked to pick a language before speaking. Punctuation and number
    // normalisation come built in, so the transcript reads like writing.
    engine: null,
    lang: 'multi',
    label: 'Offline ASR (SenseVoice)',
    why: 'Voice notes, where accuracy matters and latency does not.',
    // Measured from upstream's own listing: model.int8.onnx is 226 MB and
    // tokens.txt 308 KB. The 150 MB in the spec was a Pass-0 estimate made
    // before a model was chosen; this is the real one.
    estBytes: 240 * MB,
    upstream: { tag: 'asr-models', asset: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2' },
    /**
     * Pinned 2026-07-29 (archive sha256 7305f790…, 158 MB down / 233 MB on
     * disk) — see voice-model-pins.json, which is where machine facts live.
     *
     * The pin can be CHECKED rather than merely trusted, which matters for a
     * trust-on-first-download. Upstream publishes the same model on Hugging
     * Face as an LFS file, and an LFS oid IS the sha256 of the content:
     *
     *   model.int8.onnx  237,115,547 bytes
     *   sha256  12ca1a2ae7ecf3e0019ef2822307ee0b5cadc9196569e379b4c4026f8205276d
     *   (huggingface.co/api/models/csukuangfj/
     *    sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/tree/main)
     *
     * The pin records the ARCHIVE's hash, so the two are not directly
     * comparable — but after extraction that file must hash to the value
     * above, and the pinned 243,957,894 unpacked bytes are consistent with it
     * plus tokens.txt and the sample wavs. If either ever disagrees, what was
     * downloaded is not what upstream published.
     */
    files: [],
  },
  {
    id: 'lid-whisper',
    role: 'lid',
    engine: null,
    lang: null,
    label: 'Spoken language ID',
    why: 'Routes each utterance to the right decoder when two ASR languages are enabled.',
    estBytes: 30 * MB,
    files: [],
  },
  {
    id: 'kws-zipformer',
    role: 'kws',
    engine: null,
    lang: null,
    label: 'Keyword spotting',
    why: 'Name activation in strict-mode calls.',
    estBytes: 15 * MB,
    files: [],
  },
  {
    id: 'punct',
    role: 'punct',
    engine: null,
    lang: null,
    label: 'Punctuation restoration',
    why: 'Legible transcripts in session logs.',
    estBytes: 30 * MB,
    files: [],
  },
  {
    id: 'tagging-audioset',
    role: 'tagging',
    engine: null,
    lang: null,
    label: 'Audio tagging (AudioSet)',
    why: 'Opt-in, default OFF, annotation-only in this milestone (§8.4).',
    // The sherpa-onnx zipformer AudioSet tagger — a `.onnx` plus a
    // class-labels CSV, unpacked into models/audio/tagging-audioset/. The asset
    // name is upstream's published archive; like the speaker models it carries NO
    // pinned sha until `pin-audio-models.mjs tagging-audioset --upstream` records
    // one against a live download (sha/bytes are never hand-written).
    estBytes: 50 * MB,
    upstream: { tag: 'audio-tagging-models', asset: 'sherpa-onnx-zipformer-audio-tagging-2024-04-09.tar.bz2' },
    files: [],
  },
]);

/**
 * Merge a pins file into the base manifest. Pure, so it can be tested without
 * touching disk, and so a malformed pins file degrades to "unpinned" rather
 * than to a crash at module load — a broken pin must leave voice cleanly
 * unavailable, never take the server down with it.
 *
 * Only whole, well-formed file records are accepted: a url, a 64-hex sha256,
 * and a finite byte count. Anything short of that is dropped, because a
 * half-pin is exactly the state that would let an unverified file through.
 */
export function applyPins(baseModels, pins) {
  const table = (pins && typeof pins === 'object' && !Array.isArray(pins)) ? pins : {};
  return Object.freeze(baseModels.map((m) => {
    const entry = table[m.id];
    const raw = Array.isArray(entry?.files) ? entry.files : [];
    const files = raw
      .filter((f) => f && typeof f.name === 'string' && f.name
        && typeof f.url === 'string' && /^https:\/\//.test(f.url)
        && typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.sha256)
        && Number.isFinite(f.bytes) && f.bytes > 0)
      .map((f) => Object.freeze({
        name: f.name, url: f.url, sha256: f.sha256, bytes: f.bytes,
        // What it becomes once unpacked. Absent means unmeasured, and every
        // consumer must fall back to the download size rather than assume
        // they are the same — bz2 archives expand by ~1.2-1.3x.
        diskBytes: Number.isFinite(f.diskBytes) && f.diskBytes > 0 ? f.diskBytes : null,
      }));
    return Object.freeze({ ...m, files: Object.freeze(files) });
  }));
}

/** Read the generated pins file, if one exists. Absence is normal, not an error. */
function loadPins() {
  try {
    const url = new URL('./voice-model-pins.json', import.meta.url);
    return JSON.parse(readFileSync(url, 'utf8'));
  } catch {
    return {};
  }
}

/** The manifest as the rest of the app sees it: base entries plus whatever has been pinned. */
export const AUDIO_MODELS = applyPins(BASE_MODELS, loadPins());

export { BASE_MODELS };

const BY_ID = new Map(AUDIO_MODELS.map((m) => [m.id, m]));

export function modelById(id) {
  return BY_ID.get(id) ?? null;
}

/**
 * A model is fetchable only when every file carries a url AND a sha256. An
 * entry with files but no checksum is a pinning bug, and the fetcher must
 * treat it as "not available" rather than "download and hope".
 */
export function isPinned(model) {
  if (!model || !Array.isArray(model.files) || model.files.length === 0) return false;
  return model.files.every((f) => typeof f?.url === 'string' && f.url && typeof f?.sha256 === 'string' && f.sha256.length === 64);
}

// ── Composition ──────────────────────────────────────────────────────────

function pickAsr(lang) {
  return AUDIO_MODELS.find((m) => m.role === 'asr-streaming' && m.lang === lang) ?? null;
}

function pickRole(role) {
  return AUDIO_MODELS.find((m) => m.role === role) ?? null;
}

/**
 * Turn the ward's choices into the exact set of models to fetch.
 *
 * `asrLangs` is a list because a bilingual household is a supported shape —
 * but only ever what the ward named. One language is the default; a second
 * is a deliberate second choice, priced separately (§0.7 rule 2).
 *
 * Unknown tiers/engines fall back to the defaults rather than throwing: a
 * malformed setting must not be able to make voice un-configurable.
 */
export function composePlan({
  capabilityTier = DEFAULT_CAPABILITY_TIER,
  voiceEngine = DEFAULT_VOICE_ENGINE,
  asrLangs = [DEFAULT_ASR_LANG],
  extras = [],
} = {}) {
  const tier = CAPABILITY_TIERS.includes(capabilityTier) ? capabilityTier : DEFAULT_CAPABILITY_TIER;
  const engine = VOICE_ENGINES.includes(voiceEngine) ? voiceEngine : DEFAULT_VOICE_ENGINE;

  const voice = AUDIO_MODELS.find((m) => m.role === 'tts' && m.engine === engine) ?? null;

  const requested = [...new Set(
    (Array.isArray(asrLangs) && asrLangs.length ? asrLangs : [DEFAULT_ASR_LANG])
      .map((l) => String(l ?? '').trim().toLowerCase())
      .filter(Boolean),
  )];
  const unavailableLangs = requested.filter((l) => !asrLanguage(l));
  const resolvedLangs = requested.filter((l) => asrLanguage(l));

  const capability = [];
  for (const role of TIER_ROLES[tier]) {
    if (role === 'asr-streaming') {
      // If every requested language is unsupported, fall back to the default
      // rather than composing a listening tier with no ears — but the
      // `unavailableLangs` field still carries what was asked for, so the
      // surface can say so instead of quietly listening in English.
      const langs = resolvedLangs.length ? resolvedLangs : [DEFAULT_ASR_LANG];
      for (const l of langs) {
        const m = pickAsr(l);
        if (m) capability.push(m);
      }
    } else {
      const m = pickRole(role);
      if (m) capability.push(m);
    }
  }

  // A second ASR language implies LID — it is how an utterance reaches the
  // right decoder. Named here rather than silently bundled, so the size shows
  // up in the plan the ward is shown.
  const wantLid = capability.filter((m) => m.role === 'asr-streaming').length > 1;

  const extraSet = new Set(Array.isArray(extras) ? extras.filter((e) => EXTRA_ROLES.includes(e)) : []);
  if (wantLid) extraSet.add('lid');
  const extraModels = [...extraSet].map(pickRole).filter(Boolean);

  return {
    capabilityTier: tier,
    voiceEngine: engine,
    asrLangs: capability.filter((m) => m.role === 'asr-streaming').map((m) => m.lang),
    requestedLangs: requested,
    unavailableLangs,
    voice,
    capability,
    extras: extraModels,
    all: [voice, ...capability, ...extraModels].filter(Boolean),
  };
}

/**
 * Size a set of models. Returns `estimated: true` if any entry had no pinned
 * `bytes` and fell back to `estBytes` — every ward-facing surface that shows
 * the figure has to pass that flag through, because "about 180 MB" and
 * "180 MB" are different promises.
 */
export function planSize(models) {
  const list = (Array.isArray(models) ? models : []).filter(Boolean);
  let bytes = 0;
  let diskBytes = 0;
  let peakBytes = 0;
  let estimated = false;
  let diskEstimated = false;
  for (const m of list) {
    // A size is only a measurement if the entry is actually pinned. A byte
    // count sitting next to a missing checksum came from somewhere we cannot
    // verify, so it is treated as the estimate it really is.
    const exact = isPinned(m) && m.files.every((f) => Number.isFinite(f?.bytes))
      ? m.files.reduce((a, f) => a + f.bytes, 0)
      : null;
    if (exact === null) estimated = true;
    const download = exact ?? (Number.isFinite(m.estBytes) ? m.estBytes : 0);
    bytes += download;

    // Disk: what it occupies once unpacked. Unmeasured falls back to the
    // download size and is flagged, never silently assumed equal.
    // A plain file occupies exactly what it downloads; only archives need a
    // measured unpacked size before the disk figure is trustworthy.
    const diskKnown = isPinned(m) && m.files.every((f) => Number.isFinite(f?.diskBytes) || !isArchive(f?.name));
    const disk = diskKnown
      ? m.files.reduce((a, f) => a + (Number.isFinite(f.diskBytes) ? f.diskBytes : f.bytes), 0)
      : null;
    if (disk === null) diskEstimated = true;
    diskBytes += disk ?? download;

    // Peak: during install an archive and its unpacked form BOTH exist. That
    // moment, not the steady state, is what the disk has to survive.
    peakBytes += (Array.isArray(m.files) && m.files.some((f) => isArchive(f?.name)))
      ? download + (disk ?? download)
      : (disk ?? download);
  }
  return { bytes, diskBytes, peakBytes, estimated, diskEstimated, count: list.length };
}

/**
 * Evaluate a plan against the §0.7 ceilings. Violations are reported, never
 * thrown — a ward who deliberately adds three extras is not doing something
 * wrong, they are spending disk they have. The ceilings bind the DEFAULTS;
 * this function is what makes that testable.
 */
export function evaluatePlan(plan) {
  const voice = planSize(plan?.voice ? [plan.voice] : []);
  const capability = planSize(plan?.capability ?? []);
  const extras = planSize(plan?.extras ?? []);
  const total = voice.bytes + capability.bytes + extras.bytes;

  const voiceCeiling = CEILINGS.voice[plan?.voiceEngine] ?? null;
  const capCeiling = CEILINGS.capability[plan?.capabilityTier] ?? null;

  // The §0.7 ceilings are about DISK, so they are checked against unpacked
  // size — checking the download would let a model that fetches at 120 MB and
  // lands at 160 MB pass a 150 MB budget it actually breaches.
  const violations = [];
  if (voiceCeiling !== null && voice.diskBytes > voiceCeiling) {
    violations.push({ axis: 'voice', of: plan.voiceEngine, bytes: voice.diskBytes, ceiling: voiceCeiling });
  }
  if (capCeiling !== null && capability.diskBytes > capCeiling) {
    violations.push({ axis: 'capability', of: plan.capabilityTier, bytes: capability.diskBytes, ceiling: capCeiling });
  }

  return {
    voice, capability, extras,
    totalBytes: total,
    totalDiskBytes: voice.diskBytes + capability.diskBytes + extras.diskBytes,
    peakBytes: voice.peakBytes + capability.peakBytes + extras.peakBytes,
    estimated: voice.estimated || capability.estimated || extras.estimated,
    diskEstimated: voice.diskEstimated || capability.diskEstimated || extras.diskEstimated,
    ceilings: { voice: voiceCeiling, capability: capCeiling },
    violations,
    withinBudget: violations.length === 0,
  };
}

/** Human-readable size for ward-facing copy. Code owns the number; the sentence only quotes it. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * MB) return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
  return `${(bytes / (1024 * MB)).toFixed(2)} GB`;
}

/**
 * The sentence the ward sees before a download. Built here so the figure and
 * the words can never drift apart, and so "estimated" is impossible to drop.
 */
export function describePlanForConsent(plan) {
  const ev = evaluatePlan(plan);
  const size = formatBytes(ev.totalBytes);
  const about = ev.estimated ? 'about ' : '';
  const names = plan.all.map((m) => m.label).join(', ');
  return {
    bytes: ev.totalBytes,
    estimated: ev.estimated,
    text: `This downloads ${about}${size}: ${names}.`,
    models: plan.all.map((m) => ({ id: m.id, label: m.label, why: m.why, bytes: planSize([m]).bytes, pinned: isPinned(m) })),
  };
}
