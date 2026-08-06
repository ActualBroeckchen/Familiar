import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWav, measureVoiceClip, frameF0, describeMeasurement,
  F0_MIN_HZ, F0_MAX_HZ, chunkIsSilent, createSilenceTracker
} from '../voice-audio-features.js';

/**
 * Build a real 16-bit PCM WAV in memory. Synthesised rather than recorded, so
 * the expected pitch is known exactly and the detector is checked against
 * ground truth instead of against my impression of a clip.
 */
function makeWav({ hz = 150, seconds = 1, sampleRate = 24000, channels = 1, amplitude = 0.5, harmonics = 3, silenceLead = 0 } = {}) {
  const frames = Math.round(seconds * sampleRate);
  const lead = Math.round(silenceLead * sampleRate);
  const total = frames + lead;
  const dataLen = total * channels * 2;
  const buf = Buffer.alloc(44 + dataLen);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);              // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);

  for (let i = 0; i < total; i++) {
    let v = 0;
    if (i >= lead) {
      const t = (i - lead) / sampleRate;
      // A few harmonics: a bare sine is easier to track than a voice, and the
      // detector should cope with the harmonic structure speech actually has.
      for (let h = 1; h <= harmonics; h++) v += (amplitude / h) * Math.sin(2 * Math.PI * hz * h * t);
    }
    const s = Math.max(-1, Math.min(1, v));
    for (let c = 0; c < channels; c++) {
      buf.writeInt16LE(Math.round(s * 32767), 44 + (i * channels + c) * 2);
    }
  }
  return buf;
}

// ── WAV parsing ──────────────────────────────────────────────────────────

test('a real WAV parses to mono float samples with its true duration', () => {
  const w = parseWav(makeWav({ seconds: 0.5, sampleRate: 16000 }));
  assert.equal(w.sampleRate, 16000);
  assert.equal(w.channels, 1);
  assert.equal(w.bitsPerSample, 16);
  assert.ok(Math.abs(w.durationSec - 0.5) < 0.01);
  assert.equal(w.samples.length, 8000);
});

test('stereo is mixed down — a reference clip is one voice, not an image', () => {
  const w = parseWav(makeWav({ channels: 2, seconds: 0.25 }));
  assert.equal(w.channels, 2);
  assert.equal(w.samples.length, Math.round(0.25 * 24000));
});

test('anything unparseable returns null rather than throwing', () => {
  assert.equal(parseWav(Buffer.from('not a wav at all')), null);
  assert.equal(parseWav(Buffer.alloc(0)), null);
  assert.equal(parseWav(Buffer.alloc(100)), null, 'right size, wrong magic');
  const truncated = makeWav({ seconds: 0.2 }).subarray(0, 60);
  // Declares more data than it holds; must not read past the end.
  assert.doesNotThrow(() => parseWav(truncated));
});

// ── Pitch, against known ground truth ────────────────────────────────────

test('the detector finds the pitch it was given, across the speaking range', () => {
  for (const hz of [90, 120, 150, 185, 220, 260]) {
    const f = measureVoiceClip(makeWav({ hz, seconds: 1 }));
    assert.equal(f.ok, true);
    assert.ok(f.medianF0Hz, `no pitch found for ${hz} Hz`);
    const errPct = Math.abs(f.medianF0Hz - hz) / hz * 100;
    assert.ok(errPct < 5, `${hz} Hz measured as ${f.medianF0Hz} Hz (${errPct.toFixed(1)}% off)`);
  }
});

test('a low voice and a high voice are not confused for each other', () => {
  const low = measureVoiceClip(makeWav({ hz: 100 }));
  const high = measureVoiceClip(makeWav({ hz: 240 }));
  assert.ok(low.medianF0Hz < 130);
  assert.ok(high.medianF0Hz > 200);
  assert.ok(high.medianF0Hz > low.medianF0Hz * 1.5);
});

test('silence contributes no pitch — an unvoiced frame drops out instead of adding noise', () => {
  const f = measureVoiceClip(makeWav({ hz: 150, seconds: 1, silenceLead: 1 }));
  assert.ok(f.medianF0Hz);
  assert.ok(Math.abs(f.medianF0Hz - 150) / 150 < 0.05, 'the lead silence must not drag the median');
  assert.ok(f.voicedFraction < 0.75, 'and it is reported as partly unvoiced');
  assert.ok(f.voicedFraction > 0.25);
});

test('pure silence yields no pitch at all rather than a fabricated one', () => {
  const f = measureVoiceClip(makeWav({ hz: 150, amplitude: 0, seconds: 1 }));
  assert.equal(f.ok, true);
  assert.equal(f.medianF0Hz, null, 'no number is better than an invented one');
  assert.equal(f.pitchSamples, 0);
});

test('frameF0 refuses a frame too short to hold a full low period', () => {
  const w = parseWav(makeWav({ hz: 150, seconds: 1 }));
  assert.equal(frameF0(w.samples, 0, 50, w.sampleRate), null);
});

test('the detector stays inside the range it declares', () => {
  const w = parseWav(makeWav({ hz: 150, seconds: 1 }));
  const f0 = frameF0(w.samples, 0, Math.round(0.04 * w.sampleRate) * 3, w.sampleRate);
  assert.ok(f0 >= F0_MIN_HZ && f0 <= F0_MAX_HZ);
});

// ── Reported shape ───────────────────────────────────────────────────────

test('confidence in the pitch is reported, so a thin measurement is visible as one', () => {
  const solid = measureVoiceClip(makeWav({ hz: 160, seconds: 2 }));
  const thin = measureVoiceClip(makeWav({ hz: 160, seconds: 0.15 }));
  assert.ok(solid.pitchSamples > thin.pitchSamples);
  assert.ok(solid.pitchSamples > 10);
});

test('an unreadable clip reports a reason instead of pretending to have measured it', () => {
  const f = measureVoiceClip(Buffer.from('nonsense'));
  assert.equal(f.ok, false);
  assert.equal(f.reason, 'unreadable');
  assert.match(describeMeasurement(f), /could not be measured/);
});

// ── The wording ──────────────────────────────────────────────────────────

test('the description describes the MEASUREMENT, never the person', () => {
  for (const hz of [95, 140, 175, 210, 260]) {
    const text = describeMeasurement(measureVoiceClip(makeWav({ hz, seconds: 1 })));
    assert.match(text, /Hz/, 'the number is shown, not hidden behind an adjective');
    // A donated voice is a person's. Guessing their gender from a number would
    // be wrong a good fraction of the time and presumptuous every time.
    assert.doesNotMatch(text, /\b(male|female|man|woman|androgynous|feminine|masculine)\b/i,
      `"${text}" assigns a gender from a pitch measurement`);
  }
});

test('a pitch measured from very little speech says so, rather than reading as confident', () => {
  const text = describeMeasurement({ ok: true, medianF0Hz: 170, f0LowHz: 160, f0HighHz: 180, pitchSamples: 3 });
  assert.match(text, /worth a listen/);
});

test('a steady voice and a moving one are described differently', () => {
  const steady = describeMeasurement({ ok: true, medianF0Hz: 170, f0LowHz: 165, f0HighHz: 180, pitchSamples: 40 });
  const moving = describeMeasurement({ ok: true, medianF0Hz: 170, f0LowHz: 110, f0HighHz: 260, pitchSamples: 40 });
  assert.match(steady, /steady/);
  assert.match(moving, /moves around/);
});

// ── The cached and fresh paths must agree ────────────────────────────────

test('a measurement describes itself the same way whether or not it was cached', async () => {
  const { measureClip } = await import('../voice-clips.js');
  const os = await import('node:os');
  const fsp = (await import('node:fs')).promises;
  const pathm = await import('node:path');

  const root = await fsp.mkdtemp(pathm.join(os.tmpdir(), 'vclip-'));
  try {
    const wav = makeWav({ hz: 150, seconds: 1 });
    const { createHash } = await import('node:crypto');
    const sha256 = createHash('sha256').update(wav).digest('hex');
    await fsp.writeFile(pathm.join(root, 'voice-clips.json'), JSON.stringify({
      clips: [{ id: 'x', variant: 'original', source: 'voice-zero', file: 'x.wav', url: 'https://e.test/x.wav', sha256, bytes: wav.length }],
      counts: { clips: 1, voices: 1 },
    }));

    const { _resetCatalogue } = await import('../voice-clips.js');
    _resetCatalogue();
    const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => wav });

    const fresh = await measureClip({ rootDir: root, key: 'voice-zero/x/original', fetchImpl });
    const cached = await measureClip({ rootDir: root, key: 'voice-zero/x/original', fetchImpl });

    assert.equal(fresh.cached, false);
    assert.equal(cached.cached, true, 'the second call should come from cache');
    assert.equal(cached.medianF0Hz, fresh.medianF0Hz);
    assert.ok(fresh.description, 'a fresh measurement describes itself');
    assert.equal(cached.description, fresh.description, 'and a cached one describes itself identically');
    _resetCatalogue();
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('a clip whose bytes do not match the catalogue is refused, not measured', async () => {
  const { measureClip, _resetCatalogue } = await import('../voice-clips.js');
  const os = await import('node:os');
  const fsp = (await import('node:fs')).promises;
  const pathm = await import('node:path');

  const root = await fsp.mkdtemp(pathm.join(os.tmpdir(), 'vclip-'));
  try {
    await fsp.writeFile(pathm.join(root, 'voice-clips.json'), JSON.stringify({
      clips: [{ id: 'x', variant: 'original', source: 'voice-zero', file: 'x.wav', url: 'https://e.test/x.wav', sha256: 'a'.repeat(64), bytes: 10 }],
      counts: { clips: 1, voices: 1 },
    }));
    _resetCatalogue();
    const r = await measureClip({
      rootDir: root, key: 'voice-zero/x/original',
      fetchImpl: async () => ({ ok: true, arrayBuffer: async () => makeWav({ hz: 150, seconds: 0.5 }) }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'checksum', 'the pitch shown must describe the clip that would install');
    _resetCatalogue();
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

// ── Silence inside a render (the 22-second hole my human heard) ──────────

test('a silent chunk is recognised and speech is not', () => {
  const silent = new Float32Array(2048);
  const speech = Float32Array.from({ length: 2048 }, (_, i) => Math.sin(i / 8) * 0.4);
  assert.equal(chunkIsSilent(silent), true);
  assert.equal(chunkIsSilent(speech), false);
  assert.equal(chunkIsSilent(new Float32Array(0)), true, 'nothing is silence');
});

test('the tracker reports the LONGEST unbroken silence, not the total', () => {
  const t = createSilenceTracker(24000);
  const silent = new Float32Array(24000);            // 1s
  const speech = Float32Array.from({ length: 24000 }, (_, i) => Math.sin(i / 8) * 0.4);
  t.push(silent); t.push(silent); t.push(silent);    // a 3s run
  t.push(speech);                                    // broken
  t.push(silent); t.push(silent);                    // a 2s run
  assert.equal(t.longestSeconds(), 3, 'the worst stretch, not 5s of total quiet');
});

test('an all-speech render reports no silence', () => {
  const t = createSilenceTracker(24000);
  const speech = Float32Array.from({ length: 12000 }, (_, i) => Math.sin(i / 8) * 0.4);
  for (let i = 0; i < 10; i++) t.push(speech);
  assert.equal(t.longestSeconds(), 0);
});
