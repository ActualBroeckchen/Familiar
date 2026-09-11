// The offline-ASR model choice: SenseVoice default, opt-in Whisper/Parakeet,
// and the per-family recogniser config the worker builds. Pure — no engine, no
// real model — so the branching that would otherwise only prove out on a live
// download is verified here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offlineAsrChoice, DEFAULT_OFFLINE_ASR, OFFLINE_ASR_MODELS, offlineRecognizerConfig } from '../src/voice/offline-asr-models.js';

const at = (f) => `/m/${f}`;

test('offlineAsrChoice: default is sensevoice; unknown/empty falls back; known keys resolve', () => {
  assert.equal(offlineAsrChoice({}).key, DEFAULT_OFFLINE_ASR);
  assert.equal(offlineAsrChoice({ voiceOfflineAsrModel: 'nonsense' }).key, 'sensevoice');
  assert.equal(offlineAsrChoice({ voiceOfflineAsrModel: 'WHISPER' }).key, 'whisper');   // case-insensitive
  assert.equal(offlineAsrChoice({ voiceOfflineAsrModel: 'parakeet' }).key, 'parakeet');
  // Each has a distinct per-model dir so switching never overwrites another.
  const dirs = Object.values(OFFLINE_ASR_MODELS).map((m) => m.dir);
  assert.equal(new Set(dirs).size, dirs.length);
});

test('offlineRecognizerConfig: SenseVoice (default + unknown kind) uses the senseVoice block', () => {
  const files = ['model.int8.onnx', 'tokens.txt'];
  for (const kind of ['sensevoice', 'nonsense', undefined]) {
    const cfg = offlineRecognizerConfig({ kind, files, at });
    assert.ok(cfg.modelConfig.senseVoice, `${kind} → senseVoice`);
    assert.equal(cfg.modelConfig.senseVoice.model, '/m/model.int8.onnx');
    assert.equal(cfg.modelConfig.tokens, '/m/tokens.txt');
    assert.equal(cfg.featConfig.sampleRate, 16000);
  }
});

test('offlineRecognizerConfig: Whisper discovers encoder/decoder, detects language, transcribes', () => {
  const files = ['tiny-encoder.int8.onnx', 'tiny-decoder.int8.onnx', 'tokens.txt'];
  const cfg = offlineRecognizerConfig({ kind: 'whisper', files, at });
  assert.deepEqual(cfg.modelConfig.whisper, { encoder: '/m/tiny-encoder.int8.onnx', decoder: '/m/tiny-decoder.int8.onnx', language: '', task: 'transcribe' });
  assert.ok(!cfg.modelConfig.senseVoice && !cfg.modelConfig.transducer);
});

test('offlineRecognizerConfig: real whisper layout — prefixed tokens + both precisions → int8 preferred', () => {
  // The actual sherpa-onnx-whisper-small archive (strip=1): fp32 AND int8 side by
  // side, and tokens is `small-tokens.txt`, not `tokens.txt`. Verified against the
  // downloaded archive; the old code hard-coded `tokens.txt` and took whichever
  // encoder readdir returned first (often the heavy fp32).
  const files = ['small-encoder.onnx', 'small-encoder.int8.onnx', 'small-decoder.onnx', 'small-decoder.int8.onnx', 'small-tokens.txt', 'test_wavs'];
  const cfg = offlineRecognizerConfig({ kind: 'whisper', files, at });
  assert.equal(cfg.modelConfig.tokens, '/m/small-tokens.txt', 'discovers the prefixed tokens file');
  assert.equal(cfg.modelConfig.whisper.encoder, '/m/small-encoder.int8.onnx', 'prefers the int8 encoder over fp32');
  assert.equal(cfg.modelConfig.whisper.decoder, '/m/small-decoder.int8.onnx', 'prefers the int8 decoder over fp32');
});

test('offlineRecognizerConfig: Parakeet builds a transducer from encoder/decoder/joiner', () => {
  const files = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'];
  const cfg = offlineRecognizerConfig({ kind: 'parakeet', files, at });
  assert.deepEqual(cfg.modelConfig.transducer, { encoder: '/m/encoder.int8.onnx', decoder: '/m/decoder.int8.onnx', joiner: '/m/joiner.int8.onnx' });
});

test('offlineRecognizerConfig: a missing required file throws a clear, family-named error', () => {
  assert.throws(() => offlineRecognizerConfig({ kind: 'whisper', files: ['tokens.txt'], at }), /whisper/);
  assert.throws(() => offlineRecognizerConfig({ kind: 'parakeet', files: ['encoder.onnx', 'decoder.onnx', 'tokens.txt'], at }), /parakeet/);
});
