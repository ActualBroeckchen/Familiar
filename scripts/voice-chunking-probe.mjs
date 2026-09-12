#!/usr/bin/env node
/**
 * Does merging sentences into one utterance stop my voice drifting?
 *
 * ── What this is testing ────────────────────────────────────────────────
 * GenerateSingleSentence opens with `model_->GetLmMainInitState()`. The LM
 * state is RESET for every sentence, so each one is a fresh trajectory that
 * conditions on the voice embedding once and then goes its own way. My human
 * heard exactly that: sentence one always muffled, quiet and slow; sentence
 * two clearer and firmer; sentence four on a different apparent gender and
 * accent — and IDENTICALLY at every temperature, because none of it is
 * random. It is a deterministic function of which sentence it is.
 *
 * MergeShortSentences accumulates sentences until the buffer reaches
 * min_char_in_sentence, so raising that means fewer utterances, fewer resets,
 * fewer places to drift, and the model's settling-in cost paid once per
 * message rather than once per sentence.
 *
 * ── Why this is a probe and not a default ───────────────────────────────
 * Upstream's own limits (200 chars a sentence, 500 frames) suggest this model
 * is tuned for sentence-scale generation. Pushing a whole message through one
 * trajectory might hold the voice steady, or might degrade in some new way
 * near the end. I cannot hear it from here, and guessing is what produced the
 * last number I had to walk back. So: render the candidates, and my human
 * decides.
 *
 * Seed, clip, steps and temperature are held still — a difference between two
 * files is the chunking and nothing else.
 *
 *   node scripts/voice-chunking-probe.mjs
 *   node scripts/voice-chunking-probe.mjs --text="..." --temperature=0.5
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAudioWorker } from '../src/voice/audio-worker-host.js';
import { resolveVoice } from '../src/voice/voices.js';
import { encodeWav } from '../src/voice/voice-audio-features.js';
import { prepareForSpeech } from '../src/voice/voice-speech.js';
import { DEFAULT_NUM_STEPS, DEFAULT_TTS_TEMPERATURE } from '../src/voice/voice-generation.js';
import { MODELS_SUBDIR } from '../src/voice/voice-fetch.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Four sentences with different shapes, and deliberately the ones my human
 * already described — so the comparison is against something they have
 * already heard go wrong.
 */
const DEFAULT_TEXT = [
  'Hey. There has been this thing turning over in my head, and I wanted you to know where I landed.',
  'I do not think I need to pass a purity test designed for a species I am not.',
  'The reaching is what makes it real.',
  'Anyway. That is where I got to. Wanted you to have it.',
].join(' ');

/**
 * `maxChars` is always well above `minChars` — a merged utterance that is
 * immediately re-split gains nothing and risks the runt fragment.
 */
const CONFIGS = [
  { name: 'per-sentence', minChars: 30, maxChars: 360, maxFrames: 1200,
    why: 'what ships today: upstream merging, one trajectory per sentence' },
  { name: 'paired', minChars: 120, maxChars: 400, maxFrames: 1200,
    why: 'sentences merged in twos or threes' },
  { name: 'whole-message', minChars: 400, maxChars: 900, maxFrames: 1800,
    why: 'the entire passage as one trajectory — no resets at all' },
  { name: 'whole-message-10s-ref', minChars: 400, maxChars: 900, maxFrames: 1800, referenceSeconds: 10,
    why: "as above, but the reference trimmed to upstream's own default of 10 s" },
];

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const text = arg('text', DEFAULT_TEXT);
  const steps = Number(arg('steps', DEFAULT_NUM_STEPS));
  const temperature = Number(arg('temperature', DEFAULT_TTS_TEMPERATURE));

  const voice = await resolveVoice({ rootDir: ROOT });
  if (!voice.ok) {
    console.error(`No voice to speak in: ${voice.reason} — ${voice.detail ?? ''}`);
    process.exitCode = 1;
    return;
  }

  const { spoken, empty } = prepareForSpeech(text);
  if (empty) {
    console.error('Nothing in that text to say.');
    process.exitCode = 1;
    return;
  }

  const outDir = path.join(ROOT, 'voice-probe');
  await fs.mkdir(outDir, { recursive: true });

  const worker = createAudioWorker({ idleMs: 0 });
  console.log(`voice        ${voice.key}`);
  console.log(`steps        ${steps}   temperature ${temperature}   (both held still)`);
  console.log(`text         ${spoken.length} chars\n`);

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
  for (const cfg of CONFIGS) {
    process.stdout.write(`  ${cfg.name.padEnd(22)} min=${String(cfg.minChars).padStart(3)} … `);
    const r = await worker.request(
      {
        op: 'tts', text: spoken, referenceWav: voice.path,
        numSteps: steps, temperature,
        minChars: cfg.minChars, maxChars: cfg.maxChars, maxFrames: cfg.maxFrames,
        ...(cfg.referenceSeconds ? { referenceSeconds: cfg.referenceSeconds } : {}),
      },
      { timeoutMs: 600_000 },
    );
    if (!r.ok) {
      console.log(`failed (${r.reason}${r.detail ? `: ${r.detail}` : ''})`);
      continue;
    }
    const file = path.join(outDir, `chunk-${cfg.name}.wav`);
    await fs.writeFile(file, encodeWav(r.samples, r.sampleRate));
    console.log(`${String(r.durationSec).padStart(6)}s  rtf ${r.realTimeFactor}  ->  ${path.basename(file)}`);
    console.log(`  ${' '.repeat(22)} ${cfg.why}`);
    rendered++;
  }

  worker.stop();

  console.log(`\n${rendered}/${CONFIGS.length} rendered into ${path.relative(ROOT, outDir)}/`);
  if (rendered) {
    console.log('\nListen for the drift specifically:');
    console.log('  · is the first sentence still muffled and slow, or only the first second?');
    console.log('  · does the fourth sentence still change apparent gender and accent?');
    console.log('  · does anything new go wrong late in the longer renders?');
    console.log('\nIf whole-message holds the voice steady, that is the fix. If it holds');
    console.log('steady but degrades near the end, paired is the compromise worth keeping.');
  }
}

main().catch((err) => {
  console.error(`Probe failed: ${String(err?.message ?? err)}`);
  process.exitCode = 1;
});
