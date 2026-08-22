#!/usr/bin/env node
/**
 * The audio worker (voice spec §2).
 *
 * A plain Node child process that owns the speech models and nothing else. It
 * speaks the framed stdio protocol in `audio-frame.js` and is supervised by
 * `audio-worker-host.js`; it knows nothing about HTTP, my human, or the rest
 * of me.
 *
 * ── It must never take anything down with it ────────────────────────────
 * Native inference is blocking C++ and this process exists to contain that.
 * So: no unhandled rejection escapes, every op answers its `reqId` even when
 * it fails, and a missing engine is reported once at load rather than thrown
 * per request. If this process dies anyway, the supervisor restarts it — and
 * that is the design, not a fallback.
 *
 * ── Thread caps come from the environment ───────────────────────────────
 * The host sets `PF_AUDIO_THREADS*`; the caps live with the supervision, not
 * buried in here. `total` is the ceiling this process holds concurrent work
 * beneath, so on a 4c/8t machine there is always a physical core's worth of
 * headroom left for Node and the Python children even mid-burst.
 *
 * ── Not yet built ───────────────────────────────────────────────────────
 * Pass 1 is the spine: load, unload, report, synthesise, and transcribe a
 * finished file. Streaming ASR, VAD gating and barge-in belong to Pass 2 and
 * are absent rather than stubbed —
 * an op that answers `unsupported` is honest; one that pretends is not.
 */

import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { encodeJson, encodePcm, createFrameReader, KIND_JSON, KIND_PCM } from './audio-frame.js';
import { floatToPcm16, pcm16ToFloat, createSilenceTracker } from './voice-audio-features.js';
import {
  generationExtras, runawaySampleLimit, pendingTailStart,
  DEFAULT_NUM_STEPS, DEFAULT_TTS_SEED, DEFAULT_TTS_TEMPERATURE,
} from './voice-generation.js';

const send = (obj) => {
  try { process.stdout.write(encodeJson(obj)); } catch { /* the pipe is gone; the supervisor will notice */ }
};

const threads = {
  total: Number(process.env.PF_AUDIO_THREADS) || 3,
  vad: Number(process.env.PF_AUDIO_THREADS_VAD) || 1,
  asr: Number(process.env.PF_AUDIO_THREADS_ASR) || 2,
  tts: Number(process.env.PF_AUDIO_THREADS_TTS) || 2,
  speaker: Number(process.env.PF_AUDIO_THREADS_SPEAKER) || 1,
  tagging: Number(process.env.PF_AUDIO_THREADS_TAGGING) || 1,
};

/**
 * Generation knobs live in `voice-generation.js` so they are testable — this
 * file is a script with top-level stdio handlers and cannot be imported from
 * a test without hanging it. The seed in particular decides whether I sound
 * like one person across a message, so it does not get to be unverifiable.
 *
 * Env overrides stay here: they are how a ward tunes by ear on their own
 * machine without editing code.
 */
const NUM_STEPS = Number(process.env.PF_TTS_NUM_STEPS) || DEFAULT_NUM_STEPS;
const TTS_SEED = Number(process.env.PF_TTS_SEED) || DEFAULT_TTS_SEED;
const TTS_TEMPERATURE = Number(process.env.PF_TTS_TEMPERATURE) || DEFAULT_TTS_TEMPERATURE;
const TTS_DEBUG = process.env.PF_TTS_DEBUG === '1';

/**
 * Build the PocketTTS session from an unpacked model directory.
 *
 * The seven file names are upstream's, and the extractor strips the archive's
 * wrapper directory (voice-extract.js), so they sit directly in modelDir.
 * numThreads comes from the host's cap — the whole point of §2's thread
 * discipline is that it is set at session creation, not hoped for.
 */
function buildPocketTts(modelDir) {
  const at = (f) => path.join(modelDir, f);
  return new engine.OfflineTts({
    model: {
      pocket: {
        lmFlow: at('lm_flow.int8.onnx'),
        lmMain: at('lm_main.int8.onnx'),
        encoder: at('encoder.onnx'),
        decoder: at('decoder.int8.onnx'),
        textConditioner: at('text_conditioner.onnx'),
        vocabJson: at('vocab.json'),
        tokenScoresJson: at('token_scores.json'),
        voiceEmbeddingCacheCapacity: 50,
      },
      // PF_TTS_DEBUG=1 makes sherpa log "Processing i/total: <sentence>" for
      // every utterance it generates. Off by default (it is noisy), but it is
      // the only way to learn WHICH sentence produced a silence my human heard,
      // since nothing else in the engine reports one.
      debug: TTS_DEBUG,
      numThreads: threads.tts,
      provider: 'cpu',
    },
    // PocketTTS IGNORES this — its Generate does its own SplitByPunctuation
    // and never consults maxNumSentences. Left at upstream's own value and
    // documented rather than deleted, so nobody reaches for it again as a
    // consistency lever: it is not one. The seed is.
    maxNumSentences: 1,
  });
}

/**
 * Build the offline recogniser from an unpacked SenseVoice directory.
 *
 * Two file names, both upstream's, both sitting directly in modelDir once the
 * extractor has stripped the archive's wrapper.
 *
 * `useInverseTextNormalization` is what turns "twenty five" into "25" and adds
 * the punctuation — the difference between a transcript my human can read back
 * and a wall of lowercase. It is a number, not a boolean, because the binding
 * passes it straight through to C++.
 *
 * `language` is left empty deliberately: SenseVoice does its own language ID
 * per utterance, and pinning it to one language would break the bilingual
 * household this model was chosen for.
 */
function buildRecognizer(modelDir) {
  const at = (f) => path.join(modelDir, f);
  return new engine.OfflineRecognizer({
    // Stated rather than inherited. SenseVoice is a 16 kHz, 80-dimension fbank
    // model; sherpa's C++ FeatureExtractorConfig defaults to exactly that, so
    // omitting this block PROBABLY works — but the Node binding builds the
    // struct from whatever JS properties are present, and I could not verify
    // from the installed package whether an absent `featConfig` leaves the C++
    // defaults or zeroes them. A silently zeroed sample rate would produce
    // garbage, not an error. So the two values that matter are written down.
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: at('model.int8.onnx'),
        language: '',
        useInverseTextNormalization: 1,
      },
      tokens: at('tokens.txt'),
      numThreads: threads.asr,
      provider: 'cpu',
      debug: false,
    },
  });
}

/**
 * Streaming ASR endpoint rules (Pass 2).
 *
 * These are sherpa's own trailing-silence endpoint rules, named here so the
 * one place they live is legible and tunable against the latency budget on the
 * ward's hardware (the parent spec's §6.1 mouth-to-ear target). Verified on the
 * real engine with the en-20M streaming zipformer: chunk-by-chunk decoding is
 * byte-identical to a whole-file decode, and no false endpoint fires
 * mid-utterance at these values.
 *   rule1 — end after this much trailing silence with NOTHING decoded yet.
 *   rule2 — end after this much trailing silence AFTER something was decoded.
 *   rule3 — end once the utterance reaches this many frames regardless.
 */
const ASR_ENDPOINT = Object.freeze({
  rule1MinTrailingSilence: 2.4,
  rule2MinTrailingSilence: 1.2,
  rule3MinUtteranceLength: 300,
});

/**
 * Build the streaming (online) recognizer — the Pass 2 counterpart to
 * `buildRecognizer`'s offline one. A zipformer TRANSDUCER: encoder + decoder +
 * joiner, each an int8 onnx sitting directly in modelDir once the archive's
 * wrapper is stripped. `featConfig` is stated for the same reason it is on the
 * offline recognizer — the binding builds the C++ struct from whatever JS
 * properties are present, and a silently zeroed sample rate transcribes
 * garbage rather than erroring.
 */
function buildOnlineRecognizer(modelDir) {
  const at = (f) => path.join(modelDir, f);
  return new engine.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: at('encoder-epoch-99-avg-1.int8.onnx'),
        decoder: at('decoder-epoch-99-avg-1.int8.onnx'),
        joiner: at('joiner-epoch-99-avg-1.int8.onnx'),
      },
      tokens: at('tokens.txt'),
      numThreads: threads.asr,
      provider: 'cpu',
      debug: false,
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: true,
    ...ASR_ENDPOINT,
  });
}

/**
 * Build the Silero VAD. Loadable as its own role so the streaming path can gate
 * decode on detected speech (the parent spec's "VAD-gates everything" thermal
 * argument). `bufferSizeInSeconds` bounds the internal ring the detector holds
 * while it waits to confirm a segment.
 */
function buildVad(modelDir, bufferSizeInSeconds = 30) {
  return new engine.Vad({
    sileroVad: {
      model: path.join(modelDir, 'silero_vad_v5.onnx'),
      threshold: 0.5,
      minSilenceDuration: 0.25,
      minSpeechDuration: 0.25,
      maxSpeechDuration: 8,
      windowSize: 512,
    },
    sampleRate: 16000,
    numThreads: threads.vad,
    debug: false,
  }, bufferSizeInSeconds);
}

/**
 * Build the speaker-embedding extractor (voice spec §8) — a 3D-Speaker /
 * WeSpeaker onnx that turns a clip into a fixed-length voiceprint vector. Unlike
 * the recognisers this is a SINGLE onnx, so the model dir holds one `.onnx`; we
 * accept an explicit `model.onnx` or the sole onnx in the directory.
 */
function buildSpeakerExtractor(modelDir) {
  let model = path.join(modelDir, 'model.onnx');
  if (!existsSync(model)) {
    const onnx = readdirSync(modelDir).filter(f => f.endsWith('.onnx'));
    if (onnx.length) model = path.join(modelDir, onnx[0]);
  }
  return new engine.SpeakerEmbeddingExtractor({
    model, numThreads: threads.speaker, provider: 'cpu', debug: false,
  });
}

/**
 * Build the audio-tagging model (voice spec §8.4) — a zipformer AudioSet tagger
 * that turns a clip into event probabilities ("Dog", "Television", …). The model
 * dir holds ONE `.onnx` plus a class-labels file; we accept an explicit
 * `model.onnx` or the sole onnx in the directory, and the labels CSV by its
 * conventional name or the sole `.csv` present. A missing labels file is a clear
 * throw (the tagger can't name events without it), not a silent mislabel.
 */
function buildAudioTagger(modelDir) {
  let model = path.join(modelDir, 'model.onnx');
  if (!existsSync(model)) {
    const onnx = readdirSync(modelDir).filter((f) => f.endsWith('.onnx'));
    if (onnx.length) model = path.join(modelDir, onnx[0]);
  }
  let labels = path.join(modelDir, 'class_labels_indices.csv');
  if (!existsSync(labels)) {
    const csv = readdirSync(modelDir).filter((f) => f.endsWith('.csv'));
    if (csv.length) labels = path.join(modelDir, csv[0]);
  }
  if (!existsSync(labels)) throw new Error('audio-tagging labels file (class_labels_indices.csv) not found in the model dir');
  return new engine.AudioTagging({
    model: { zipformer: { model }, numThreads: threads.tagging, provider: 'cpu', debug: false },
    labels,
  });
}

/** Loaded models, by role. Lazy: nothing loads until something needs it. */
const loaded = new Map();
/**
 * Active streaming-ASR sessions, by streamId (Pass 2). One entry per live
 * listening stream; each holds its own online stream so two speakers in a
 * group call never share decode state.
 */
const decoders = new Map();
let engine = null;
let engineError = null;

/**
 * Load the native binding, once.
 *
 * A missing binding is the ordinary case on a platform with no prebuilt, or
 * for a ward who installed with `--omit=optional` (§0.8). It is reported as a
 * reason, not thrown — every op then answers honestly instead of the process
 * dying and being restarted three times into a park.
 */
async function ensureEngine() {
  if (engine) return { ok: true };
  if (engineError) return { ok: false, reason: 'no-engine', detail: engineError };
  try {
    // CommonJS: the namespace object puts module.exports on `.default`.
    const mod = await import('sherpa-onnx-node');
    engine = mod.default ?? mod;
    return { ok: true };
  } catch (err) {
    engineError = `the speech engine is not installed (${String(err?.message ?? err).split('\n')[0]})`;
    return { ok: false, reason: 'no-engine', detail: engineError };
  }
}

function reportState() {
  send({ op: 'state', loadedModels: [...loaded.keys()], liveDecoders: decoders.size, threads });
}

/**
 * Feed one PCM frame into a live streaming-ASR session and emit transcript
 * frames as they form.
 *
 * The loop is sherpa's proven online contract (verified on the real engine,
 * chunk-by-chunk identical to a whole-file decode): accept the samples, decode
 * while the stream is ready, read the running result. A partial is emitted only
 * when the text actually CHANGES — one PCM frame arrives every few tens of ms,
 * and re-sending an unchanged partial would flood the pipe. On an endpoint the
 * final text is emitted and the stream reset so the next utterance starts
 * clean.
 *
 * Unsolicited frames (no `reqId`): the host routes them to its listeners, which
 * is where the call engine subscribes — the same path `ttsStream`'s PCM takes
 * outward. Never throws into the frame reader: a decode failure ends this one
 * session with an `asr-error` and leaves every other stream untouched.
 */
/** Concatenate this utterance's buffered Float32 chunks into one clip. */
function joinUtterance(chunks, total) {
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * Emit the utterance's final transcript. With `offlineFinal` on and the offline
 * model loaded, the streaming recogniser was only for endpointing: re-transcribe
 * the buffered clip with SenseVoice — punctuation, casing, and far better words
 * than the 20 M streaming zipformer — and emit THAT. Falls back to the streaming
 * text if the offline model isn't loaded, the clip is empty, or it errors, so a
 * hybrid failure degrades to the old behaviour rather than dropping the turn.
 * `clip` is captured by the caller BEFORE the buffer is cleared, so this can run
 * async without racing the next utterance.
 */
async function emitFinal(streamId, dec, streamingText, clip, meta) {
  const base = { op: 'asr-final', streamId, text: streamingText, final: true, ...meta };
  // Why offline was or wasn't used — rides out on the frame so the host can log
  // it. Blind success/failure here is what made "hybrid isn't engaging"
  // undiagnosable: we couldn't tell not-loaded from empty-result from a throw.
  const hasModel = Boolean(loaded.get('asr-offline')?.session);
  const clipSec = clip ? Number((clip.length / 16000).toFixed(2)) : 0;
  const offline = dec.offlineFinal ? loaded.get('asr-offline')?.session : null;
  if (offline && clip && clip.length > 0) {
    try {
      const os = offline.createStream();
      os.acceptWaveform({ samples: clip, sampleRate: 16000 });
      const r = await offline.decodeAsync(os);
      const text = (typeof r?.text === 'string' ? r.text : '').trim();
      if (text) { send({ ...base, text, asrEngine: 'offline', clipSec }); return; }
      send({ ...base, asrEngine: 'streaming', asrOfflineNote: `offline returned empty on ${clipSec}s clip`, clipSec });
      return;
    } catch (err) {
      send({ ...base, asrEngine: 'streaming', asrOfflineNote: `offline threw: ${String(err?.message ?? err)}`, clipSec });
      return;
    }
  }
  // Not attempted — say precisely why (flag off, model not loaded, empty clip).
  const why = !dec.offlineFinal ? (hasModel ? 'flag-off' : 'flag-off,model-not-loaded')
    : (!hasModel ? 'model-not-loaded' : (!clip || clip.length === 0 ? 'empty-clip' : 'unknown'));
  send({ ...base, asrEngine: 'streaming', asrOfflineNote: `not attempted: ${why}`, clipSec });
}

function feedDecoder(streamId, pcmBytes) {
  const dec = decoders.get(streamId);
  if (!dec) return; // audio for a stream that isn't listening — ignore, don't error
  try {
    const samples = pcm16ToFloat(pcmBytes);
    if (samples.length === 0) return;
    // Track the loudest sample and how much audio was fed, so a stop can report
    // whether this was silence (a dead/muted mic) or real sound the model simply
    // did not turn into words — two very different fixes that look identical
    // otherwise.
    for (let i = 0; i < samples.length; i++) { const a = samples[i] < 0 ? -samples[i] : samples[i]; if (a > dec.peak) dec.peak = a; }
    dec.samples += samples.length;
    // Buffer this utterance's audio for the offline re-transcription (cheap: a
    // few seconds of 16 kHz float; cleared on every final).
    if (dec.offlineFinal) { dec.utterance.push(samples); dec.uSamples += samples.length; }
    dec.stream.acceptWaveform({ samples, sampleRate: 16000 });
    while (dec.recognizer.isReady(dec.stream)) dec.recognizer.decode(dec.stream);

    const text = dec.recognizer.getResult(dec.stream).text.trim();
    if (text && text !== dec.lastPartial) {
      dec.lastPartial = text;
      send({ op: 'asr-partial', streamId, text });
    }
    if (dec.recognizer.isEndpoint(dec.stream)) {
      const finalText = dec.recognizer.getResult(dec.stream).text.trim();
      dec.recognizer.reset(dec.stream);
      dec.lastPartial = '';
      // Capture + clear the utterance buffer BEFORE the async offline pass, so
      // the next utterance starts clean and can't race this clip.
      const clip = dec.offlineFinal ? joinUtterance(dec.utterance, dec.uSamples) : null;
      dec.utterance = []; dec.uSamples = 0;
      if (finalText || clip) emitFinal(streamId, dec, finalText, clip, {}).catch(() => {});
    }
  } catch (err) {
    decoders.delete(streamId);
    reportState();
    send({ op: 'asr-error', streamId, detail: String(err?.message ?? err) });
  }
}

const OPS = {
  /** Liveness plus what this worker can currently do. Cheap, and never loads anything. */
  async ping({ reqId }) {
    const e = await ensureEngine();
    send({
      reqId, ok: true,
      engineAvailable: e.ok,
      engineDetail: e.ok ? null : e.detail,
      loadedModels: [...loaded.keys()],
      threads,
    });
  },

  /**
   * Load a model for a role. Idempotent: loading what is already loaded is a
   * no-op rather than a second copy in RAM.
   */
  async load({ reqId, role, modelDir }) {
    const e = await ensureEngine();
    if (!e.ok) return send({ reqId, ok: false, reason: e.reason, detail: e.detail });
    if (!role || !modelDir) return send({ reqId, ok: false, reason: 'bad-request', detail: 'role and modelDir are required' });
    // Idempotent for the SAME model, but reload when the dir changed — otherwise
    // switching the speaker model (CAM++ ↔ TitaNet-Large) would keep serving the
    // old one until a restart, since roles are keyed by name not path.
    const held = loaded.get(role);
    if (held) {
      if (held.modelDir === modelDir) return send({ reqId, ok: true, alreadyLoaded: true, role });
      loaded.delete(role);
    }

    try {
      if (role === 'tts') loaded.set(role, { session: buildPocketTts(modelDir), modelDir, at: Date.now() });
      else if (role === 'asr-offline') loaded.set(role, { session: buildRecognizer(modelDir), modelDir, at: Date.now() });
      else if (role === 'asr-streaming') loaded.set(role, { session: buildOnlineRecognizer(modelDir), modelDir, at: Date.now() });
      else if (role === 'vad') loaded.set(role, { session: buildVad(modelDir), modelDir, at: Date.now() });
      else if (role === 'speaker') loaded.set(role, { session: buildSpeakerExtractor(modelDir), modelDir, at: Date.now() });
      else if (role === 'tagging') loaded.set(role, { session: buildAudioTagger(modelDir), modelDir, at: Date.now() });
      else loaded.set(role, { modelDir, at: Date.now() });   // roles beyond these arrive later
      reportState();
      // The sample rate rides back on the load, because a streaming caller has
      // to write a wav header BEFORE any audio exists. Asking the engine beats
      // hard-coding 24000 and hoping a future model agrees.
      send({ reqId, ok: true, role, modelDir, sampleRate: loaded.get(role)?.session?.sampleRate ?? null });
    } catch (err) {
      send({ reqId, ok: false, reason: 'load-failed', detail: String(err?.message ?? err) });
    }
  },

  /** Drop a role's model. Used by idle unload and by a ward reclaiming RAM. */
  async unload({ reqId, role }) {
    if (role) loaded.delete(role); else loaded.clear();
    reportState();
    send({ reqId, ok: true, unloaded: role ?? 'all' });
  },

  /**
   * Listen to a file and return what was said.
   *
   * Offline, one shot, nobody waiting — the opposite of the streaming path
   * Pass 2 brings. The caller hands over a wav path rather than samples
   * because `readWave` is the engine's own reader and resamples nothing we
   * would have to reimplement badly.
   *
   * `decodeAsync` rather than `decode`: decoding a several-minute note is
   * blocking C++, and this process still has to answer a ping while it works.
   *
   * SenseVoice returns emotion and audio-event tags alongside the text. They
   * are passed back but NOT used for anything — reading tone into a care
   * decision is the safety-critical territory §8 says gets its own spec and
   * its own sign-off, and it does not get to arrive quietly as a side effect
   * of transcription.
   */
  async transcribe({ reqId, wavPath }) {
    const e = await ensureEngine();
    if (!e.ok) return send({ reqId, ok: false, reason: e.reason, detail: e.detail });
    if (!wavPath || typeof wavPath !== 'string') {
      return send({ reqId, ok: false, reason: 'bad-request', detail: 'wavPath is required' });
    }
    const held = loaded.get('asr-offline');
    if (!held?.session) return send({ reqId, ok: false, reason: 'not-loaded', detail: 'the listening model is not loaded' });

    try {
      const wave = engine.readWave(wavPath);
      const started = Date.now();
      const stream = held.session.createStream();
      stream.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate });
      const result = await held.session.decodeAsync(stream);
      const elapsedMs = Date.now() - started;
      const durationSec = wave.samples.length / wave.sampleRate;

      send({
        reqId, ok: true,
        text: typeof result?.text === 'string' ? result.text.trim() : '',
        lang: result?.lang ?? null,
        emotion: result?.emotion ?? null,
        event: result?.event ?? null,
        durationSec: Number(durationSec.toFixed(3)),
        elapsedMs,
        realTimeFactor: durationSec > 0 ? Number((elapsedMs / 1000 / durationSec).toFixed(3)) : null,
      });
    } catch (err) {
      send({ reqId, ok: false, reason: 'transcribe-failed', detail: String(err?.message ?? err) });
    }
  },

  /**
   * Compute a speaker-embedding voiceprint (voice spec §8) from either a wav
   * file (`wavPath` — the enrolment path) or raw float samples + rate
   * (`samples`/`sampleRate` — a live VAD segment for the watchdog/diarizer).
   * Returns a plain number[] embedding; the caller compares it (cosine) — the
   * math lives in voice-embedding.js, not here. The extractor resamples to its
   * own rate internally, so we pass the audio's native rate. A clip too short to
   * be ready is an honest `not-ready`, never a fabricated vector.
   */
  async embed({ reqId, wavPath, samples, sampleRate }) {
    const e = await ensureEngine();
    if (!e.ok) return send({ reqId, ok: false, reason: e.reason, detail: e.detail });
    const held = loaded.get('speaker');
    if (!held?.session) return send({ reqId, ok: false, reason: 'not-loaded', detail: 'the speaker model is not loaded' });
    try {
      let s = samples, rate = sampleRate;
      if (!(Array.isArray(s) || s instanceof Float32Array)) {
        if (!wavPath || typeof wavPath !== 'string') {
          return send({ reqId, ok: false, reason: 'bad-request', detail: 'wavPath or samples+sampleRate is required' });
        }
        const wave = engine.readWave(wavPath);
        s = wave.samples; rate = wave.sampleRate;
      }
      const stream = held.session.createStream();
      stream.acceptWaveform({ samples: s, sampleRate: Number(rate) || 16000 });
      stream.inputFinished();
      if (!held.session.isReady(stream)) {
        return send({ reqId, ok: false, reason: 'not-ready', detail: 'clip too short to embed' });
      }
      const emb = held.session.compute(stream);
      send({ reqId, ok: true, embedding: Array.from(emb), dim: emb.length });
    } catch (err) {
      send({ reqId, ok: false, reason: 'embed-failed', detail: String(err?.message ?? err) });
    }
  },

  /**
   * Audio tagging (voice spec §8.4) — name the salient sounds in a clip, from a
   * wav (`wavPath`) or raw float samples + rate (`samples`/`sampleRate`, a live
   * VAD segment). Returns raw AudioSet events (`[{name, prob, index}]`); the
   * CALLER classifies + phrases them (voice-audio-tags.js) — no judgment lives
   * here, and nothing about tone/threat is read from them. `topK` bounds the
   * result; the caller filters by confidence.
   */
  async tag({ reqId, wavPath, samples, sampleRate, topK = 8 }) {
    const e = await ensureEngine();
    if (!e.ok) return send({ reqId, ok: false, reason: e.reason, detail: e.detail });
    const held = loaded.get('tagging');
    if (!held?.session) return send({ reqId, ok: false, reason: 'not-loaded', detail: 'the audio-tagging model is not loaded' });
    try {
      let s = samples, rate = sampleRate;
      if (!(Array.isArray(s) || s instanceof Float32Array)) {
        if (!wavPath || typeof wavPath !== 'string') {
          return send({ reqId, ok: false, reason: 'bad-request', detail: 'wavPath or samples+sampleRate is required' });
        }
        const wave = engine.readWave(wavPath);
        s = wave.samples; rate = wave.sampleRate;
      }
      const stream = held.session.createStream();
      stream.acceptWaveform({ samples: s, sampleRate: Number(rate) || 16000 });
      const events = held.session.compute(stream, Number(topK) || 8);
      send({ reqId, ok: true, events: Array.isArray(events) ? events.map((ev) => ({ name: ev?.name ?? '', prob: Number(ev?.prob) || 0, index: ev?.index ?? -1 })) : [] });
    } catch (err) {
      send({ reqId, ok: false, reason: 'tag-failed', detail: String(err?.message ?? err) });
    }
  },

  /**
   * Speak. Returns the samples; the caller decides what to do with them.
   *
   * PocketTTS clones zero-shot, so a reference clip is REQUIRED — there is no
   * built-in voice to fall back on. A missing reference is a clear refusal
   * rather than a default nobody chose.
   */
  async tts({ reqId, text, referenceWav, speed = 1.0, numSteps = NUM_STEPS, seed = TTS_SEED, temperature = TTS_TEMPERATURE, minChars, maxChars, maxFrames, referenceSeconds }) {
    const e = await ensureEngine();
    if (!e.ok) return send({ reqId, ok: false, reason: e.reason, detail: e.detail });
    if (!text || typeof text !== 'string') return send({ reqId, ok: false, reason: 'bad-request', detail: 'text is required' });
    if (!referenceWav) return send({ reqId, ok: false, reason: 'no-voice', detail: 'a reference clip is required — PocketTTS has no built-in voice' });

    const held = loaded.get('tts');
    if (!held?.session) return send({ reqId, ok: false, reason: 'not-loaded', detail: 'the speaking model is not loaded' });

    try {
      const ref = engine.readWave(referenceWav);
      const generationConfig = new engine.GenerationConfig({
        speed,
        referenceAudio: ref.samples,
        referenceSampleRate: ref.sampleRate,
        numSteps,
        extra: generationExtras({ seed, temperature, minChars, maxChars, maxFrames, referenceSeconds }),
      });

      const started = Date.now();
      const audio = held.session.generate({ text, generationConfig });
      const elapsedMs = Date.now() - started;
      const durationSec = audio.samples.length / audio.sampleRate;

      send({
        reqId, ok: true,
        sampleRate: audio.sampleRate,
        durationSec: Number(durationSec.toFixed(3)),
        elapsedMs,
        realTimeFactor: durationSec > 0 ? Number((elapsedMs / 1000 / durationSec).toFixed(3)) : null,
        // Float samples as a plain array: the host writes the wav, because the
        // worker's job is inference and nothing else.
        samples: Array.from(audio.samples),
      });
    } catch (err) {
      send({ reqId, ok: false, reason: 'tts-failed', detail: String(err?.message ?? err) });
    }
  },
  /**
   * Speak a whole message as ONE generation, streaming the audio out as it
   * arrives.
   *
   * This exists because the obvious alternative is wrong. Splitting a message
   * into sentences and calling `tts` per sentence gives low latency, but
   * PocketTTS clones ZERO-SHOT PER CALL and exposes no seed — so every call
   * re-derives the voice and samples the flow-matching decoder afresh. Three
   * sentences came out sounding like three different speakers at three
   * different levels, which is what my human heard. The clone has to happen
   * once, and the audio has to stream out of that one clone.
   *
   * `maxNumSentences` is raised for exactly this reason: the session must be
   * free to carry the whole text through a single generation rather than
   * being forced to stop at one sentence.
   *
   * Each `onProgress` callback becomes a PCM frame on the same pipe the
   * protocol was built for. The final JSON frame closes the request and
   * carries the totals — a caller must be able to tell "finished" from
   * "the pipe went quiet".
   */
  async ttsStream({ reqId, streamId, text, referenceWav, speed = 1.0, numSteps = NUM_STEPS, seed = TTS_SEED, temperature = TTS_TEMPERATURE, minChars, maxChars, maxFrames, referenceSeconds }) {
    const e = await ensureEngine();
    if (!e.ok) return send({ reqId, ok: false, reason: e.reason, detail: e.detail });
    if (!text || typeof text !== 'string') return send({ reqId, ok: false, reason: 'bad-request', detail: 'text is required' });
    if (!referenceWav) return send({ reqId, ok: false, reason: 'no-voice', detail: 'a reference clip is required — PocketTTS has no built-in voice' });
    if (!Number.isFinite(streamId)) return send({ reqId, ok: false, reason: 'bad-request', detail: 'streamId is required' });

    const held = loaded.get('tts');
    if (!held?.session) return send({ reqId, ok: false, reason: 'not-loaded', detail: 'the speaking model is not loaded' });

    try {
      const ref = engine.readWave(referenceWav);
      const generationConfig = new engine.GenerationConfig({
        speed,
        referenceAudio: ref.samples,
        referenceSampleRate: ref.sampleRate,
        numSteps,
        extra: generationExtras({ seed, temperature, minChars, maxChars, maxFrames, referenceSeconds }),
      });

      const started = Date.now();
      let sampleCount = 0;
      let firstChunkMs = null;
      let runaway = false;
      // The engine can decode a normal-length generation into silence — my
      // human heard twenty-two seconds of it mid-message, with nothing
      // anywhere recording that it happened. Now it is measured.
      const silence = createSilenceTracker(held.session.sampleRate ?? 24000);

      // Containment for a bug I cannot patch. If the LM reaches EOS on its
      // first step, upstream's `if (eos_step > 0 …)` never fires and the loop
      // runs its full 500-frame budget — up to forty seconds of degenerating
      // noise. `capSentenceLength` should stop the fragment that triggers it
      // from ever being generated, but I would rather not stake my human's
      // ears on having found the only trigger.
      const sampleCeiling = runawaySampleLimit(text, held.session.sampleRate ?? 24000, { speed, maxFrames });

      const audio = await held.session.generateAsync({
        text,
        generationConfig,
        onProgress: ({ samples }) => {
          if (!samples?.length) return 1;
          if (firstChunkMs === null) firstChunkMs = Date.now() - started;

          if (sampleCount + samples.length > sampleCeiling) {
            // Stop BEFORE forwarding this chunk. Whatever is being produced
            // past this point is not speech, and it is aimed at someone who
            // may have opened this because they were already struggling.
            runaway = true;
            return 0;
          }

          silence.push(samples);
          sampleCount += samples.length;
          try {
            process.stdout.write(encodePcm(streamId, floatToPcm16(samples)));
          } catch {
            // The pipe is gone. Returning 0 asks the engine to stop rather
            // than finish generating audio with nowhere to go.
            return 0;
          }
          return 1;
        },
      });

      // Reconcile the stream against the authoritative full clip. `onProgress`
      // is supposed to hand over every sample, but an engine may deliver its
      // final chunk only in the returned `audio` — so the last sentence was
      // generated yet never reached the pipe, and the message stops a sentence
      // early. Emit exactly the remainder the callback did not (`pendingTailStart`
      // returns where it begins, or -1). Skipped on a runaway stop, where the
      // bytes past the streamed count are the noise the cap cut on purpose.
      const tailStart = pendingTailStart(sampleCount, audio?.samples?.length ?? 0, { runaway });
      if (tailStart >= 0) {
        const tail = audio.samples.slice(tailStart);
        try {
          process.stdout.write(encodePcm(streamId, floatToPcm16(tail)));
          sampleCount += tail.length;
        } catch { /* the pipe is gone; the completion frame still reports what was sent */ }
      }

      const elapsedMs = Date.now() - started;
      const sampleRate = audio?.sampleRate ?? held.session.sampleRate;
      // Report what was actually streamed (now including any reconciled tail),
      // not `audio.samples.length` — on a runaway stop the clip is longer than
      // what the caller was allowed to receive.
      const durationSec = sampleCount / sampleRate;

      send({
        reqId, ok: true, streamId, sampleRate,
        sampleCount,
        durationSec: Number(durationSec.toFixed(3)),
        elapsedMs,
        firstChunkMs,
        // Never silent about it: a truncated sentence is something my human
        // may notice, and they should be able to find out why rather than
        // wonder whether they misheard.
        runaway,
        // Reported on every render, not only when it looks wrong, so "does this
        // happen often, and with which voice" is answerable from the logs.
        longestSilenceSec: silence.longestSeconds(),
        realTimeFactor: durationSec > 0 ? Number((elapsedMs / 1000 / durationSec).toFixed(3)) : null,
      });
    } catch (err) {
      send({ reqId, ok: false, reason: 'tts-failed', detail: String(err?.message ?? err) });
    }
  },

  /**
   * Open a live streaming-ASR session on `streamId`. After this returns ok, the
   * caller pushes 16 kHz mono s16le PCM frames for the same streamId (the host's
   * `sendPcm`) and receives `asr-partial` / `asr-final` frames back until it
   * calls `asrStreamStop`. One session per streamId — opening an already-open
   * one is a no-op, not a second decode state, so a stutter in the call setup
   * cannot double-decode a speaker.
   */
  async asrStream({ reqId, streamId, offlineFinal }) {
    const e = await ensureEngine();
    if (!e.ok) return send({ reqId, ok: false, reason: e.reason, detail: e.detail });
    if (!Number.isFinite(streamId)) return send({ reqId, ok: false, reason: 'bad-request', detail: 'streamId is required' });
    const held = loaded.get('asr-streaming');
    if (!held?.session) return send({ reqId, ok: false, reason: 'not-loaded', detail: 'the streaming listening model is not loaded' });
    if (decoders.has(streamId)) return send({ reqId, ok: true, streamId, alreadyOpen: true });
    try {
      const stream = held.session.createStream();
      // `offlineFinal`: re-transcribe each finished utterance with the accurate
      // offline model (SenseVoice) and emit THAT as asr-final, using the streaming
      // recogniser only for endpointing. `utterance` buffers this utterance's raw
      // 16 kHz samples since the last final so the offline pass has the audio.
      decoders.set(streamId, {
        recognizer: held.session, stream, lastPartial: '', peak: 0, samples: 0,
        offlineFinal: offlineFinal === true, utterance: [], uSamples: 0,
      });
      reportState();
      send({ reqId, ok: true, streamId, sampleRate: 16000 });
    } catch (err) {
      send({ reqId, ok: false, reason: 'asr-open-failed', detail: String(err?.message ?? err) });
    }
  },

  /**
   * Close a streaming-ASR session: flush whatever the recognizer still holds
   * after the last PCM (my human stopped talking / the call ended), emit a last
   * `asr-final` for that tail, and drop the session. Idempotent — stopping a
   * streamId that isn't open still answers ok, so a double hang-up is harmless.
   */
  async asrStreamStop({ reqId, streamId }) {
    const dec = decoders.get(streamId);
    if (!dec) return send({ reqId, ok: true, streamId, wasOpen: false });
    try {
      dec.stream.inputFinished();
      while (dec.recognizer.isReady(dec.stream)) dec.recognizer.decode(dec.stream);
      const tail = dec.recognizer.getResult(dec.stream).text.trim();
      const peak = Number(dec.peak.toFixed(4));
      const seconds = Number((dec.samples / 16000).toFixed(2));
      // Capture the utterance clip before dropping the session.
      const clip = dec.offlineFinal ? joinUtterance(dec.utterance, dec.uSamples) : null;
      decoders.delete(streamId);
      reportState();
      // ALWAYS emit the final, even when empty. A push-to-talk release with no
      // recognised words used to send nothing, so the caller waited forever with
      // no way to know the recogniser had finished with nothing to say. The
      // peak + duration ride along so the host can tell silence from unrecognised
      // speech in one log line. With offlineFinal, the accurate SenseVoice text
      // replaces `tail` (awaited so this stop's asr-final carries it).
      await emitFinal(streamId, dec, tail, clip, { peak, seconds });
      send({ reqId, ok: true, streamId, wasOpen: true, peak, seconds });
    } catch (err) {
      decoders.delete(streamId);
      reportState();
      send({ reqId, ok: false, reason: 'asr-stop-failed', detail: String(err?.message ?? err) });
    }
  },

  // ⚠️ A `transcribe` STUB used to sit here, left over from before the real one
  // was written above. Two keys of the same name in one object literal: the
  // later silently wins, so the real implementation was dead from the day it
  // landed and every voice note got `unsupported`. `node --check` does not
  // flag a duplicate key, and every test stubbed the worker rather than
  // exercising this table — so nothing caught it but my human, four times.
  // Do not add a placeholder for an op that already has an implementation.
};

const reader = createFrameReader({
  onFrame: async (frame) => {
    // Inbound audio for a live listening stream (Pass 2). Routed straight to
    // its decoder — synchronous, cheap, and never awaited, so a burst of PCM
    // frames can't queue behind a slow JSON op.
    if (frame.kind === KIND_PCM) { feedDecoder(frame.streamId, frame.pcm); return; }
    if (frame.kind !== KIND_JSON) return;
    const msg = frame.message ?? {};
    const op = OPS[msg.op];
    if (!op) return send({ reqId: msg.reqId, ok: false, reason: 'unknown-op', detail: String(msg.op) });
    try {
      await op(msg);
    } catch (err) {
      // A reqId that never gets an answer is a caller waiting until its
      // timeout for nothing. Answer even the unexpected.
      send({ reqId: msg.reqId, ok: false, reason: 'op-failed', detail: String(err?.message ?? err) });
    }
  },
  onError: (e) => send({ op: 'protocol-error', ...e }),
});

process.stdin.on('data', (chunk) => reader.push(chunk));
process.stdin.on('end', () => process.exit(0));      // EOF from the supervisor: clean exit

process.on('uncaughtException', (err) => {
  send({ op: 'fatal', detail: String(err?.message ?? err) });
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  send({ op: 'fatal', detail: String(err?.message ?? err) });
  process.exit(1);
});

reportState();
