/**
 * offline-asr-models.js — the offline ASR models the ward can choose between for
 * the voice-note / call FINAL transcription (the accurate, no-one-waiting pass).
 *
 * SenseVoice is the default and the only one bundled through the normal fetch;
 * Whisper and NeMo Parakeet are OPT-IN upgrades — selectable here, but the repo
 * refuses to download an unpinned model, so choosing one never pulls anything on
 * its own. Until the ward pins + installs the chosen model, the call final falls
 * back to SenseVoice (or, if that too is absent, the streaming text). Choosing a
 * model is free and instant; paying for it is a separate, deliberate step.
 *
 * Trade-offs (why three):
 *   sensevoice — multilingual (zh/en/ja/ko/yue) in one model, the bilingual-
 *                household default. int8, decent, punctuation + ITN built in.
 *   whisper    — multilingual, markedly better English, heavier + slower, 30 s
 *                input window. The accuracy upgrade that keeps both languages.
 *   parakeet   — English ONLY, but a transducer, so it is the one that supports
 *                hotword biasing (feeding it names like "Aura"/"Elizabeth") and
 *                is very accurate on English. Not for a bilingual call.
 *
 * `kind` drives the worker's recogniser config; `dir` is the per-model folder
 * under models/audio/ so switching never overwrites another model; `catalogueId`
 * ties it to voice-models.js for fetch/pin.
 */
export const OFFLINE_ASR_MODELS = {
  sensevoice: { key: 'sensevoice', kind: 'sensevoice', dir: 'asr-offline',         catalogueId: 'asr-offline',         label: 'SenseVoice — multilingual (default)' },
  whisper:    { key: 'whisper',    kind: 'whisper',    dir: 'asr-offline-whisper', catalogueId: 'asr-offline-whisper', label: 'Whisper — multilingual, higher accuracy (heavier)' },
  parakeet:   { key: 'parakeet',   kind: 'parakeet',   dir: 'asr-offline-parakeet',catalogueId: 'asr-offline-parakeet',label: 'NeMo Parakeet — English only, very accurate, name hints' },
};

export const DEFAULT_OFFLINE_ASR = 'sensevoice';

/** The chosen offline model from settings, falling back to the default on any
 *  unknown/absent value. Pure. */
export function offlineAsrChoice(settings) {
  const k = String(settings?.voiceOfflineAsrModel ?? '').trim().toLowerCase();
  return OFFLINE_ASR_MODELS[k] || OFFLINE_ASR_MODELS[DEFAULT_OFFLINE_ASR];
}

/**
 * Build the sherpa OfflineRecognizer *config* for a model — pure, so it is
 * testable without loading the engine or a real model. `files` is the model
 * dir's file list (readdirSync); `at` joins a name onto the dir. Discovers
 * encoder/decoder/joiner/model by shape rather than assuming an exact filename
 * (each family + quantisation names them differently). Throws with a clear
 * message when a required file is absent. An unknown kind builds SenseVoice, so
 * a mis-threaded value degrades to the working default rather than throwing.
 */
export function offlineRecognizerConfig({ kind = 'sensevoice', files = [], at, numThreads = 1 }) {
  const find = (re) => files.find((f) => re.test(f)) ?? null;
  const common = { tokens: at('tokens.txt'), numThreads, provider: 'cpu', debug: false };
  const featConfig = { sampleRate: 16000, featureDim: 80 };

  if (kind === 'whisper') {
    const encoder = find(/encoder.*\.onnx$/i), decoder = find(/decoder.*\.onnx$/i);
    if (!encoder || !decoder) throw new Error('whisper: encoder/decoder .onnx not found');
    // language:'' → detect per clip (keeps both languages); transcribe, never translate.
    return { featConfig, modelConfig: { whisper: { encoder: at(encoder), decoder: at(decoder), language: '', task: 'transcribe' }, ...common } };
  }
  if (kind === 'parakeet') {
    const encoder = find(/encoder.*\.onnx$/i), decoder = find(/decoder.*\.onnx$/i), joiner = find(/joiner.*\.onnx$/i);
    if (!encoder || !decoder || !joiner) throw new Error('parakeet: transducer encoder/decoder/joiner .onnx not found');
    return { featConfig, modelConfig: { transducer: { encoder: at(encoder), decoder: at(decoder), joiner: at(joiner) }, ...common } };
  }
  const model = find(/^model.*\.onnx$/i) ?? 'model.int8.onnx';
  return { featConfig, modelConfig: { senseVoice: { model: at(model), language: '', useInverseTextNormalization: 1 }, ...common } };
}
