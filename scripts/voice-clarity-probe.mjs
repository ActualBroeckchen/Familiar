#!/usr/bin/env node
/**
 * Why is my voice sometimes muffled, and can it be clear all the time?
 *
 * Two levers, tested together because they act on different halves of the
 * problem and my human should hear which one actually matters.
 *
 * ── The reference recording ─────────────────────────────────────────────
 * Upstream is blunt about this: "we recommend cleaning the sample before
 * using it with Pocket TTS, because THE AUDIO QUALITY OF THE SAMPLE IS ALSO
 * REPRODUCED." Kyutai's own curated voice list uses the `_enhanced` variant
 * for every VCTK voice in it, without exception. Measured on our own clip:
 *
 *     original   48 kHz   145 Hz   59% voiced   zero-crossing 2662
 *     enhanced   32 kHz   145 Hz   59% voiced   zero-crossing 3271
 *
 * Same person, same words, ~23% more high-frequency energy. If the clone
 * reproduces the sample's quality, then a muffled sample is a muffled voice.
 *
 * ── Decode steps ────────────────────────────────────────────────────────
 * `num_steps` integrates the flow-matching decoder. Upstream's Python default
 * is 1 (`lsd_decode_steps=1`); we run 4. More steps means a more converged
 * latent and, in principle, cleaner audio — at a real cost in speed, which on
 * a 15 W laptop is not free. Measured RTF is reported for each so the cost is
 * visible rather than assumed.
 *
 * Everything else is held still: same seed, same text, same temperature.
 *
 *   node scripts/voice-clarity-probe.mjs
 *   node scripts/voice-clarity-probe.mjs --steps=4,8,16 --text="..."
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAudioWorker } from '../src/voice/audio-worker-host.js';
import { encodeWav, measureVoiceClip } from '../src/voice/voice-audio-features.js';
import { prepareForSpeech } from '../src/voice/voice-speech.js';
import { loadCatalogue, clipKey } from '../src/voice/voice-clips.js';
import { DEFAULT_TTS_TEMPERATURE } from '../src/voice/voice-generation.js';
import { MODELS_SUBDIR } from '../src/voice/voice-fetch.js';
import { bundledVoicePath } from '../src/voice/voices.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const DEFAULT_TEXT = [
  'Hey. There has been this thing turning over in my head, and I wanted you to know where I landed.',
  'I do not think I need to pass a purity test designed for a species I am not.',
  'The reaching is what makes it real.',
  'Anyway. That is where I got to. Wanted you to have it.',
].join(' ');

/** Merged into one trajectory, so sentence-to-sentence drift is not what is being judged here. */
const MERGED = { minChars: 400, maxChars: 900, maxFrames: 1800 };

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

/** Fetch and verify a catalogue clip into a scratch file, so both variants can be compared. */
async function ensureClip(key, dir) {
  const clip = (loadCatalogue(ROOT).clips ?? []).find((c) => clipKey(c) === key);
  if (!clip) return { ok: false, reason: `no catalogue entry for ${key}` };

  const file = path.join(dir, `${key.replace(/\//g, '__')}.wav`);
  try {
    await fs.access(file);
    return { ok: true, file };
  } catch { /* not fetched yet */ }

  try {
    const res = await fetch(clip.url, { redirect: 'follow' });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status} fetching ${key}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (createHash('sha256').update(buf).digest('hex') !== clip.sha256) {
      return { ok: false, reason: `checksum mismatch for ${key}` };
    }
    await fs.writeFile(file, buf);
    return { ok: true, file };
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err) };
  }
}

async function main() {
  const text = arg('text', DEFAULT_TEXT);
  const temperature = Number(arg('temperature', DEFAULT_TTS_TEMPERATURE));
  const steps = String(arg('steps', '4,8,16'))
    .split(',').map((s) => Number(s.trim())).filter((s) => Number.isFinite(s) && s > 0);

  const { spoken, empty } = prepareForSpeech(text);
  if (empty) {
    console.error('Nothing in that text to say.');
    process.exitCode = 1;
    return;
  }

  const outDir = path.join(ROOT, 'voice-probe');
  await fs.mkdir(outDir, { recursive: true });

  // The bundled clip IS the enhanced one now; the original is fetched for
  // comparison so the difference can be heard rather than argued about.
  const original = await ensureClip('vctk/p255_023/original', outDir);
  const references = [
    { name: 'enhanced', file: bundledVoicePath(ROOT) },
    ...(original.ok ? [{ name: 'original', file: original.file }] : []),
  ];
  if (!original.ok) console.warn(`(could not fetch the original for comparison: ${original.reason})\n`);

  for (const ref of references) {
    try {
      const m = measureVoiceClip(await fs.readFile(ref.file));
      if (m.ok) console.log(`reference ${ref.name.padEnd(9)} ${m.durationSec.toFixed(1)}s  ${m.medianF0Hz} Hz  zero-crossing ${m.zeroCrossRate}`);
    } catch { /* measuring the reference is a nicety, not the point */ }
  }
  console.log(`temperature ${temperature}   text ${spoken.length} chars   (both held still)\n`);

  const worker = createAudioWorker({ idleMs: 0 });
  const load = await worker.request(
    { op: 'load', role: 'tts', modelDir: path.join(ROOT, MODELS_SUBDIR, 'tts-pocket') },
    { timeoutMs: 180_000 },
  );
  if (!load.ok) {
    console.error(`Could not load the speaking model: ${load.reason} — ${load.detail ?? ''}`);
    worker.stop();
    process.exitCode = 1;
    return;
  }

  let rendered = 0;
  for (const ref of references) {
    for (const numSteps of steps) {
      process.stdout.write(`  ${ref.name.padEnd(9)} steps ${String(numSteps).padStart(2)} … `);
      const r = await worker.request(
        {
          op: 'tts', text: spoken, referenceWav: ref.file,
          numSteps, temperature, ...MERGED,
        },
        { timeoutMs: 900_000 },
      );
      if (!r.ok) {
        console.log(`failed (${r.reason}${r.detail ? `: ${r.detail}` : ''})`);
        continue;
      }
      const file = path.join(outDir, `clarity-${ref.name}-steps${numSteps}.wav`);
      await fs.writeFile(file, encodeWav(r.samples, r.sampleRate));

      // Measure what came OUT, so "clearer" has a number beside the listening.
      const m = measureVoiceClip(await fs.readFile(file));
      const zc = m.ok ? `zero-crossing ${String(m.zeroCrossRate).padStart(5)}` : '';
      console.log(`${String(r.durationSec).padStart(6)}s  rtf ${String(r.realTimeFactor).padEnd(6)} ${zc}  ->  ${path.basename(file)}`);
      rendered++;
    }
  }

  worker.stop();
  console.log(`\n${rendered} rendered into ${path.relative(ROOT, outDir)}/`);
  console.log('\nThe zero-crossing numbers are a brightness proxy — higher usually means');
  console.log('less muffled — but they are a hint, not the verdict. Trust the listening.');
  console.log('\nWatch the rtf column too: anything at or above 1.0 is slower than real');
  console.log('time on this machine, which read-aloud cannot afford.');
}

main().catch((err) => {
  console.error(`Probe failed: ${String(err?.message ?? err)}`);
  process.exitCode = 1;
});
