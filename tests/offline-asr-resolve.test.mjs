// resolveOfflineAsr: use the ward's selected model when it's downloaded, else
// fall back to SenseVoice, else none — so choosing an upgrade that isn't
// fetched yet never breaks a call (the deferred-opt-in promise).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { REPO_ROOT } from '../repo-root.js';
import { resolveOfflineAsr, offlineAsrModelPresent } from '../src/voice/voice-transcribe.js';

const AUDIO = path.join(REPO_ROOT, 'models', 'audio');
async function place(dir, files) {
  const d = path.join(AUDIO, dir);
  await fsp.mkdir(d, { recursive: true });
  for (const f of files) await fsp.writeFile(path.join(d, f), 'x');
  return d;
}
async function clear(dir) { await fsp.rm(path.join(AUDIO, dir), { recursive: true, force: true }); }

test('resolveOfflineAsr: selected whisper present → uses whisper; absent → falls back to sensevoice', async () => {
  await clear('asr-offline-whisper'); await clear('asr-offline');
  try {
    await place('asr-offline', ['model.int8.onnx', 'tokens.txt']);
    // whisper selected but not downloaded → fall back to sensevoice, flagged
    let r = resolveOfflineAsr({ voiceOfflineAsrModel: 'whisper' });
    assert.equal(r.usingKey, 'sensevoice');
    assert.equal(r.selectedKey, 'whisper');
    assert.equal(r.fellBack, true);
    assert.equal(r.kind, 'sensevoice');
    // now download whisper → it wins. The REAL sherpa-onnx layout: files are
    // prefixed and tokens is `small-tokens.txt`, not `tokens.txt` — the detector
    // must match that or a downloaded whisper reads as absent (the bug this fixes).
    await place('asr-offline-whisper', ['small-encoder.int8.onnx', 'small-decoder.int8.onnx', 'small-tokens.txt']);
    r = resolveOfflineAsr({ voiceOfflineAsrModel: 'whisper' });
    assert.equal(r.usingKey, 'whisper');
    assert.equal(r.kind, 'whisper');
    assert.equal(r.fellBack, false);
    assert.ok(offlineAsrModelPresent({ voiceOfflineAsrModel: 'whisper' }));
  } finally { await clear('asr-offline-whisper'); await clear('asr-offline'); }
});

test('resolveOfflineAsr: a downloaded parakeet (plain tokens.txt, int8 transducer files) is detected', async () => {
  await clear('asr-offline-parakeet'); await clear('asr-offline');
  try {
    await place('asr-offline-parakeet', ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']);
    const r = resolveOfflineAsr({ voiceOfflineAsrModel: 'parakeet' });
    assert.equal(r.usingKey, 'parakeet');
    assert.equal(r.kind, 'parakeet');
    assert.equal(r.present, true);
  } finally { await clear('asr-offline-parakeet'); await clear('asr-offline'); }
});

test('resolveOfflineAsr: nothing downloaded → present:false (call uses streaming text)', async () => {
  await clear('asr-offline'); await clear('asr-offline-parakeet');
  const r = resolveOfflineAsr({ voiceOfflineAsrModel: 'parakeet' });
  assert.equal(r.present, false);
  assert.equal(r.selectedKey, 'parakeet');
});
