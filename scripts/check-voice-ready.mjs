#!/usr/bin/env node
/**
 * Can this machine speak? — reported in plain language, at install time.
 *
 * `sherpa-onnx-node` is an OPTIONAL dependency, which means npm skips it in
 * silence on a platform with no prebuilt binary, or when someone installs with
 * `--omit=optional`. The install then "succeeds" and voice simply never works,
 * with nothing anywhere saying why. That is the same shape as every other bug
 * in this milestone: a gate that reports presence instead of health.
 *
 * So the installer asks the real question — can the binding actually be
 * imported — and says what it found. Three states, three different sentences,
 * because "voice unavailable" tells nobody what to do next.
 *
 * Never fails the install. Voice is a feature, not a precondition; a machine
 * that cannot speak should still get a working Familiar. Exit code is always 0
 * unless --strict is passed.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const quiet = process.argv.includes('--quiet');
const say = (s = '') => { if (!quiet) console.log(s); };

const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };

async function main() {
  // 1. The binding. This is the one that fails silently.
  let binding = false;
  let bindingWhy = '';
  try {
    const mod = await import('sherpa-onnx-node');
    binding = Boolean(mod?.default ?? mod);
  } catch (err) {
    bindingWhy = String(err?.message ?? err).split('\n')[0];
  }

  // 2. The speaking model — a download, offered in the app on first use.
  const modelDir = path.join(ROOT, 'models', 'audio', 'tts-pocket');
  const model = await exists(path.join(modelDir, 'lm_main.int8.onnx'));

  // 3. The listening model — a separate, opt-in download for voice notes.
  const listening = await exists(path.join(ROOT, 'models', 'audio', 'asr-offline', 'model.int8.onnx'));

  // 4. The optional sidecar.
  let sidecar = false;
  try {
    const { inspectBackends, BACKENDS } = await import('../src/voice/voice-backend.js');
    sidecar = Boolean((await inspectBackends(ROOT))[BACKENDS.POCKET].available);
  } catch { /* voice-backend is part of the app; absence just means "no" */ }

  say('');
  if (!binding) {
    // The honest bad case. Say what it means and that nothing else is broken.
    say('  Reading aloud: NOT available on this machine.');
    say('    The speech engine did not install — this happens on platforms with no');
    say('    prebuilt binary, or when installing with --omit=optional.');
    if (bindingWhy) say(`    (${bindingWhy})`);
    say('    Everything else works. To retry later:  npm install sherpa-onnx-node');
  } else if (!model) {
    say('  Reading aloud: ready — the voice downloads the first time you use it.');
    say('    Open a conversation and press "🔊 Read aloud" under any of your');
    say('    Familiar\'s messages. It asks first: 94 MB to fetch, 194 MB unpacked.');
  } else {
    say('  Reading aloud: ready to go.');
    say('    Press "🔊 Read aloud" under any of your Familiar\'s messages.');
  }

  if (binding) {
    say(sidecar
      ? '    A steadier speaking engine is installed — pick it in Settings.'
      : '    A steadier engine for long messages can be added in Settings (~600 MB, optional).');
    say('');
    // Listening is a SEPARATE consent and default-off, so this reports it as
    // available-if-wanted rather than as something missing. Nothing here is a
    // problem to fix; it is a thing that exists.
    say(listening
      ? '  Voice notes: ready — turn on "Hearing voice notes" in Settings to record.'
      : '  Voice notes: available. Turn on "Hearing voice notes" in Settings and');
    if (!listening) say('    your Familiar offers the download when you record: 158 MB to fetch, 233 MB unpacked.');
  }
  say('');

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ binding, model, listening, sidecar, bindingWhy: bindingWhy || null }));
  }
  return process.argv.includes('--strict') && !binding ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    // A broken check must never break an install.
    if (!quiet) console.log(`  Reading aloud: could not be checked (${String(err?.message ?? err)}).`);
    process.exitCode = 0;
  });
