#!/usr/bin/env node
/**
 * Set up the voicebox sidecar — the engine that holds a voice across a message.
 *
 * Deliberately NOT part of the prestart hook. `ensure-phylactery-deps.mjs` runs
 * on every boot because the canonical self is not optional; this is ~600 MB for
 * a quality improvement, and downloading that because someone typed `npm start`
 * would be a hostile surprise on a laptop that is nearly full.
 *
 * So it is a thing my human runs on purpose, once, after being told the price.
 *
 *   node scripts/ensure-voicebox.mjs            what it would cost, and stop
 *   node scripts/ensure-voicebox.mjs --install   actually do it
 *   node scripts/ensure-voicebox.mjs --check     just report the state
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectBackends, POCKET_FOOTPRINT, BACKENDS, VOICEBOX_SUBDIR, ensureWindowsMsvcRuntime } from '../voice-backend.js';
import { formatBytes } from '../voice-models.js';
import { preflight } from '../voice-footprint.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const has = (flag) => process.argv.includes(flag);

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
    p.on('error', (err) => resolve({ ok: false, detail: String(err?.message ?? err) }));
    p.on('close', (code) => resolve({ ok: code === 0, code }));
  });
}

async function haveUv() {
  const r = await run('uv', ['--version'], { stdio: 'ignore' });
  return r.ok;
}

function printCost() {
  console.log('\nWhat this installs:\n');
  for (const part of POCKET_FOOTPRINT.parts) {
    console.log(`    ${formatBytes(part.bytes).padStart(9)}   ${part.what}`);
  }
  console.log(`    ${'—'.repeat(9)}`);
  console.log(`    ${formatBytes(POCKET_FOOTPRINT.downloadBytes).padStart(9)}   downloaded`);
  console.log(`    ${formatBytes(POCKET_FOOTPRINT.installedBytes).padStart(9)}   on disk once unpacked\n`);
  console.log('What it buys:\n');
  console.log('    · one continuous voice across a whole message, instead of a shift');
  console.log('      at every utterance boundary');
  console.log('    · upstream\'s current english_2026-04 model, rather than the older');
  console.log('      2026-01 that the ONNX port exports\n');
  console.log('What stays true either way: the engine that ships already works, and');
  console.log('nothing here is required to speak.\n');
}

async function main() {
  const found = await inspectBackends(ROOT);
  const pocket = found[BACKENDS.POCKET];

  console.log(`voicebox — ${pocket.available ? 'installed and ready' : 'not installed'}`);
  if (pocket.available) {
    console.log(`  interpreter: ${path.relative(ROOT, pocket.python)}`);
    console.log('\nTurn it on in Settings, or set voiceTts.backend to "pocket".');
    return 0;
  }
  console.log(`  ${pocket.why}`);

  if (has('--check')) return 1;

  printCost();

  // Refuse before downloading rather than halfway through. A disk that fills
  // during a 400 MB install leaves a broken venv AND no room to clean it up.
  //
  // The need is install + download, not just install: uv holds the wheels
  // while it unpacks them, so both exist at once at the peak.
  const decision = await preflight({
    targetDir: ROOT,
    needBytes: POCKET_FOOTPRINT.installedBytes + POCKET_FOOTPRINT.downloadBytes,
    estimated: true,
  });
  if (!decision.ok) {
    const free = Number.isFinite(decision.freeBytes) ? formatBytes(decision.freeBytes) : 'unknown';
    console.error(`Not enough room (${decision.reason}). Free: ${free}, needed: ${formatBytes(decision.needBytes ?? 0)}.`);
    console.error('Nothing was downloaded.');
    return 1;
  }

  if (!has('--install')) {
    console.log('Run it for real with:  node scripts/ensure-voicebox.mjs --install\n');
    return 0;
  }

  if (!(await haveUv())) {
    console.error('uv is not on PATH, and this needs it to build the environment.');
    console.error('  https://docs.astral.sh/uv/getting-started/installation/');
    return 1;
  }

  console.log('Installing (this takes a while — torch is most of it)…\n');
  const sync = await run('uv', ['sync', '--directory', path.join(ROOT, VOICEBOX_SUBDIR)]);
  if (!sync.ok) {
    console.error(`\nuv sync failed${sync.detail ? `: ${sync.detail}` : ''}. Nothing else was changed.`);
    return 1;
  }

  // On Windows, give torch the Visual C++ runtime uv doesn't provide, so a clean
  // machine doesn't hit WinError 126 the first time it tries to speak. Best-effort
  // — the built-in engine covers any failure here.
  await ensureWindowsMsvcRuntime({ rootDir: ROOT, onLog: (m) => console.log(`  ${m}`) });

  const after = await inspectBackends(ROOT);
  if (!after[BACKENDS.POCKET].available) {
    console.error(`\nThe install finished but the environment still is not usable: ${after[BACKENDS.POCKET].why}`);
    return 1;
  }

  console.log('\nDone. The model itself downloads on first use, the same way the');
  console.log('ONNX one does.\n');
  console.log('Turn it on in Settings, or set voiceTts.backend to "pocket".');
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(`Setup failed: ${String(err?.message ?? err)}`);
    process.exitCode = 1;
  });
