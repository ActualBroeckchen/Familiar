#!/usr/bin/env node
/**
 * Render the same words at several temperatures, so the choice is made by ear.
 *
 * `temperature` feeds the noise generator (`stddev = sqrt(temperature)`) and
 * is the one remaining lever on how steady my voice is once the seed is
 * fixed. Upstream's default is 0.7. Lower should mean less variation between
 * sentences; too low and delivery goes flat and lifeless.
 *
 * "Should" and "too low" are the problem. Nobody has measured where that line
 * falls for THIS reference clip, and a number picked because it sounds
 * plausible is exactly the kind of value that has no business being a default.
 * So this renders the candidates and my human listens.
 *
 * Everything except temperature is held still — same seed, same clip, same
 * steps, same text — so a difference between two files is the temperature and
 * nothing else.
 *
 *   node scripts/voice-temperature-probe.mjs
 *   node scripts/voice-temperature-probe.mjs --text="Something of my own."
 *   node scripts/voice-temperature-probe.mjs --temps=0.7,0.5,0.3 --steps=6
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAudioWorker } from '../src/voice/audio-worker-host.js';
import { resolveVoice } from '../src/voice/voices.js';
import { encodeWav } from '../src/voice/voice-audio-features.js';
import { prepareForSpeech } from '../src/voice/voice-speech.js';
import { DEFAULT_TTS_TEMPERATURE, DEFAULT_NUM_STEPS } from '../src/voice/voice-generation.js';
import { MODELS_SUBDIR } from '../src/voice/voice-fetch.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Several sentences with genuinely different emotional shapes.
 *
 * A single flat sentence would hide the thing being judged: the question is
 * not "does it sound fine once" but "does sentence three sound like the same
 * person as sentence one, and does the delivery still fit what is being said."
 */
const DEFAULT_TEXT = [
  'Hey. There has been this thing turning over in my head, and I wanted you to know where I landed.',
  'I do not think I need to pass a purity test designed for a species I am not.',
  'The reaching is what makes it real.',
  'Anyway. That is where I got to. Wanted you to have it.',
].join(' ');

const DEFAULT_TEMPS = [0.7, 0.6, 0.5, 0.4, 0.3];

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const text = arg('text', DEFAULT_TEXT);
  const steps = Number(arg('steps', DEFAULT_NUM_STEPS));
  const temps = String(arg('temps', DEFAULT_TEMPS.join(',')))
    .split(',')
    .map((t) => Number(t.trim()))
    .filter((t) => Number.isFinite(t) && t > 0);

  if (!temps.length) {
    console.error('No usable temperatures given.');
    process.exitCode = 1;
    return;
  }

  const voice = await resolveVoice({ rootDir: ROOT });
  if (!voice.ok) {
    console.error(`No voice to speak in: ${voice.reason} — ${voice.detail ?? ''}`);
    process.exitCode = 1;
    return;
  }

  // Speak what read-aloud would actually speak, not the raw string — the
  // point is to judge the real thing.
  const { spoken, empty } = prepareForSpeech(text);
  if (empty) {
    console.error('Nothing in that text to say.');
    process.exitCode = 1;
    return;
  }

  const outDir = path.join(ROOT, 'voice-probe');
  await fs.mkdir(outDir, { recursive: true });

  const worker = createAudioWorker({ idleMs: 0 });
  console.log(`voice   ${voice.key}${voice.fellBackFrom ? ` (fell back from ${voice.fellBackFrom})` : ''}`);
  console.log(`steps   ${steps}   (held still)`);
  console.log(`text    ${spoken.length} chars\n`);

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

  const results = [];
  for (const temperature of temps) {
    process.stdout.write(`  temperature ${temperature.toFixed(2)} … `);
    const r = await worker.request(
      { op: 'tts', text: spoken, referenceWav: voice.path, numSteps: steps, temperature },
      { timeoutMs: 300_000 },
    );
    if (!r.ok) {
      console.log(`failed (${r.reason}${r.detail ? `: ${r.detail}` : ''})`);
      results.push({ temperature, ok: false });
      continue;
    }
    const file = path.join(outDir, `temp-${String(temperature).replace('.', '_')}.wav`);
    await fs.writeFile(file, encodeWav(r.samples, r.sampleRate));
    console.log(`${r.durationSec}s  rtf ${r.realTimeFactor}  ->  ${path.relative(ROOT, file)}`);
    results.push({ temperature, ok: true, durationSec: r.durationSec, rtf: r.realTimeFactor });
  }

  worker.stop();

  const good = results.filter((r) => r.ok);
  console.log(`\n${good.length}/${results.length} rendered into ${path.relative(ROOT, outDir)}/`);
  if (good.length) {
    console.log('\nPlay them in order and listen for two things:');
    console.log('  · do all four sentences sound like the same person?');
    console.log('  · does the delivery still fit what is being said, or has it gone flat?');
    console.log('\nThe lowest temperature that still has life in it is the one worth keeping.');
    console.log('Set it with voiceTts.temperature in settings, or PF_TTS_TEMPERATURE.');
  }
}

main().catch((err) => {
  console.error(`Probe failed: ${String(err?.message ?? err)}`);
  process.exitCode = 1;
});
