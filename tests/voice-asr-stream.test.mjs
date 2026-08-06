import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { floatToPcm16, pcm16ToFloat, parseWav } from '../voice-audio-features.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// ── Pure: the PCM<->float round-trip the streaming path rides on ─────────
// pcm16ToFloat is the inverse of floatToPcm16; capture arrives as s16le and
// sherpa wants Float32, so a lossy or off-by-one conversion here would quietly
// degrade every transcript. These always run — no engine, no models.

test('pcm16ToFloat recovers a float signal within one quantization step', () => {
  const original = Float32Array.from([0, 0.5, -0.5, 1, -1, 0.123, -0.987]);
  const back = pcm16ToFloat(floatToPcm16(original));
  assert.equal(back.length, original.length);
  // Tolerance is a hair above one quantization step: the forward scale is
  // *32767 and the inverse /32768, so full-scale 1.0 recovers as 0.99997 — the
  // asymmetry is deliberate (the inverse can never exceed 1) and inaudible.
  for (let i = 0; i < original.length; i++) {
    assert.ok(Math.abs(back[i] - original[i]) < 1e-4, `sample ${i}: ${back[i]} vs ${original[i]}`);
  }
});

test('pcm16ToFloat never exceeds [-1, 1] and handles the extremes', () => {
  // s16le min/max: 0x8000 = -32768, 0x7fff = 32767.
  const buf = Buffer.alloc(4);
  buf.writeInt16LE(-32768, 0);
  buf.writeInt16LE(32767, 2);
  const f = pcm16ToFloat(buf);
  assert.ok(f[0] >= -1 && f[0] <= 1, `min -> ${f[0]}`);
  assert.ok(f[1] >= -1 && f[1] < 1, `max -> ${f[1]}`);
  assert.equal(f[0], -1); // -32768/32768
});

test('pcm16ToFloat drops a trailing half-sample rather than reading past the end', () => {
  const odd = Buffer.from([0x00, 0x40, 0x7f]); // 1.5 samples' worth of bytes
  const f = pcm16ToFloat(odd);
  assert.equal(f.length, 1, 'one whole sample, the stray byte ignored');
});

test('pcm16ToFloat tolerates empty and junk input without throwing', () => {
  assert.equal(pcm16ToFloat(Buffer.alloc(0)).length, 0);
  assert.equal(pcm16ToFloat(null).length, 0);
  assert.equal(pcm16ToFloat(undefined).length, 0);
});

// ── Pipeline: a real wav streamed through the real worker child ──────────
// Guarded — it needs sherpa-onnx-node AND a streaming ASR model on disk, which
// CI does not carry. Point PF_ASR_STREAMING_MODEL_DIR at an extracted
// sherpa-onnx-streaming-zipformer dir (the one with encoder/decoder/joiner +
// test_wavs) to run it. This is the cross-process test the 0.9 vision
// post-mortem made law: a stub of the worker cannot catch a routing or
// endpoint bug, so at least one test spawns the real child.

const MODEL_DIR = process.env.PF_ASR_STREAMING_MODEL_DIR || '';
const engineResolvable = existsSync(path.join(REPO, 'node_modules', 'sherpa-onnx-node'));
const canRun = MODEL_DIR && existsSync(MODEL_DIR) && engineResolvable
  && existsSync(path.join(MODEL_DIR, 'test_wavs', '0.wav'));

test('a wav streamed as PCM through the real worker yields partials and a final transcript', { skip: canRun ? false : 'set PF_ASR_STREAMING_MODEL_DIR to an extracted streaming-ASR model dir (and install sherpa-onnx-node) to run' }, async () => {
  const { createAudioWorker } = await import('../audio-worker-host.js');
  const partials = [];
  const finals = [];
  const worker = createAudioWorker({ idleMs: 0 });
  worker.on((frame) => {
    const op = frame?.message?.op;
    if (op === 'asr-partial') partials.push(frame.message.text);
    else if (op === 'asr-final') finals.push(frame.message.text);
  });
  try {
    const load = await worker.request({ op: 'load', role: 'asr-streaming', modelDir: MODEL_DIR }, { timeoutMs: 60000 });
    assert.equal(load.ok, true, `load: ${JSON.stringify(load)}`);

    const streamId = 1;
    const open = await worker.request({ op: 'asrStream', streamId });
    assert.equal(open.ok, true, `asrStream: ${JSON.stringify(open)}`);

    const { samples } = parseWav(readFileSync(path.join(MODEL_DIR, 'test_wavs', '0.wav')));
    const pcm = floatToPcm16(samples);
    const CHUNK = 3200; // 100 ms @ 16 kHz s16le
    for (let i = 0; i < pcm.length; i += CHUNK) {
      await worker.sendPcm(streamId, pcm.subarray(i, i + CHUNK));
      await new Promise((r) => setTimeout(r, 2));
    }
    const stop = await worker.request({ op: 'asrStreamStop', streamId });
    assert.equal(stop.ok, true, `asrStreamStop: ${JSON.stringify(stop)}`);

    assert.ok(partials.length > 0, 'the recognizer emitted running partials as speech arrived');
    assert.ok(finals.length > 0, 'a final transcript was emitted');
    assert.match(finals.join(' ').toUpperCase(), /YELLOW LAMPS/, 'the transcript is the expected utterance');
  } finally {
    worker.stop();
  }
});
