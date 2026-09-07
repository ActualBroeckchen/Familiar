#!/usr/bin/env node
/**
 * Pin an audio model: download it, measure what actually arrived, and record
 * that in `voice-model-pins.json`.
 *
 * This exists so no human and no model ever types a sha256 or a byte count
 * into source. CLAUDE.md's exact-values rule is blunt about it — a value the
 * model formats by hand is a value that will be wrong some fraction of the
 * time, and the failure is silent. Here the failure would be worse than
 * silent: a wrong checksum means either a permanently un-installable model or,
 * if someone "fixes" it by pasting what the download produced, a verification
 * step that verifies nothing.
 *
 * So: the machine downloads, the machine hashes, the machine writes the file.
 *
 * Usage:
 *   node scripts/pin-audio-models.mjs <model-id> <url> [<url> ...]
 *   node scripts/pin-audio-models.mjs <model-id> --upstream    # use the recorded asset url
 *   node scripts/pin-audio-models.mjs <model-id> --measure     # fill unpacked size from an install
 *   node scripts/pin-audio-models.mjs --verify                 # re-check every pin
 *   node scripts/pin-audio-models.mjs --list              # what is pinned
 *
 * The file name stored for each url is its last path segment. Pass
 * `--name=foo.onnx` before a url to override it.
 */

import { promises as fs, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { Readable } from 'node:stream';

import { BASE_MODELS, applyPins, formatBytes, upstreamUrl } from '../src/voice/voice-models.js';
import { isArchive, extractArchive, readMarker } from '../src/voice/voice-extract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PINS = path.join(ROOT, 'voice-model-pins.json');

async function readPins() {
  try { return JSON.parse(await fs.readFile(PINS, 'utf8')); } catch { return {}; }
}

async function writePins(pins) {
  const tmp = `${PINS}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(pins, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, PINS);
}

/**
 * Download once, hashing in flight, optionally keeping the bytes.
 *
 * `keepAt` matters: measuring what an archive unpacks to needs the archive on
 * disk, and re-downloading a 250 MB file to learn that is wasteful and slow.
 * One download serves both the checksum and the unpacked measurement.
 *
 * Returns exactly what arrived — no interpretation.
 */
async function measure(url, keepAt = null) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  const h = createHash('sha256');
  let bytes = 0;
  let lastLog = 0;

  const counting = async function* (source) {
    for await (const chunk of source) {
      h.update(chunk);
      bytes += chunk.length;
      if (Date.now() - lastLog > 2000) {
        lastLog = Date.now();
        process.stderr.write(`    …${formatBytes(bytes)}\n`);
      }
      yield chunk;
    }
  };

  if (keepAt) {
    await fs.mkdir(path.dirname(keepAt), { recursive: true });
    await pipeline(Readable.fromWeb(res.body), counting, createWriteStream(keepAt));
  } else {
    for await (const _ of counting(Readable.fromWeb(res.body))) { /* discard; we only want the digest */ }
  }
  return { sha256: h.digest('hex'), bytes };
}

function usage(code = 1) {
  process.stderr.write(`Usage:
  node scripts/pin-audio-models.mjs <model-id> --upstream          # use the recorded asset url\n  node scripts/pin-audio-models.mjs <model-id> [--name=f.onnx] <url> [more urls...]
  node scripts/pin-audio-models.mjs <model-id> --measure     # fill unpacked size from an install
  node scripts/pin-audio-models.mjs --verify
  node scripts/pin-audio-models.mjs --list

Known model ids:
${BASE_MODELS.map((m) => `  ${m.id.padEnd(20)} ${m.label}`).join('\n')}
`);
  process.exit(code);
}

async function cmdList() {
  const merged = applyPins(BASE_MODELS, await readPins());
  for (const m of merged) {
    const state = m.files.length ? `pinned (${m.files.length} file${m.files.length > 1 ? 's' : ''}, ${formatBytes(m.files.reduce((a, f) => a + f.bytes, 0))})` : 'UNPINNED';
    process.stdout.write(`${m.id.padEnd(20)} ${state}\n`);
  }
}

async function cmdVerify() {
  const pins = await readPins();
  let bad = 0;
  for (const [id, entry] of Object.entries(pins)) {
    for (const f of entry.files ?? []) {
      process.stderr.write(`  checking ${id}/${f.name}\n`);
      try {
        const got = await measure(f.url);
        const ok = got.sha256 === f.sha256 && got.bytes === f.bytes;
        if (!ok) {
          bad++;
          process.stdout.write(`MISMATCH ${id}/${f.name}\n  pinned: ${f.sha256} (${f.bytes})\n  actual: ${got.sha256} (${got.bytes})\n`);
        } else {
          process.stdout.write(`ok       ${id}/${f.name}\n`);
        }
      } catch (err) {
        bad++;
        process.stdout.write(`UNREACHABLE ${id}/${f.name}: ${err.message}\n`);
      }
    }
  }
  process.stdout.write(bad === 0 ? '\nAll pins verify.\n' : `\n${bad} problem(s). A pin that no longer matches means the upstream file changed — re-pin deliberately, do not paste the new hash in.\n`);
  process.exit(bad === 0 ? 0 : 1);
}

/**
 * Complete a pin's unpacked-size field from a model that is already installed.
 *
 * Pinning a large model on a slow connection means downloading it twice — once
 * to pin, once to install — and on a thin link that is a real cost, not a
 * theoretical one. If the fetcher has already unpacked this model, the marker
 * it wrote holds the measured size and the sha256 that produced it. Reading it
 * back is exact and free.
 *
 * It only fills the field when the marker's sha256 MATCHES the pin, so a stale
 * install from an older pin can never contribute a wrong number.
 */
async function cmdMeasure(modelId) {
  const pins = await readPins();
  const entry = pins[modelId];
  if (!entry?.files?.length) {
    process.stderr.write(`${modelId} is not pinned yet — pin it first.\n`);
    process.exit(1);
  }
  const marker = await readMarker(path.join(ROOT, 'models', 'audio', modelId));
  if (!marker) {
    process.stderr.write(`${modelId} is not installed, so there is nothing to measure. Fetch it first, or re-pin.\n`);
    process.exit(1);
  }
  const target = entry.files.find((f) => f.sha256 === marker.sha256);
  if (!target) {
    process.stderr.write(`The installed ${modelId} came from a different archive than the current pin — refusing to record its size.\n`);
    process.exit(1);
  }
  target.diskBytes = marker.bytes;
  await writePins(pins);
  process.stdout.write(`${modelId}: recorded unpacked size ${formatBytes(marker.bytes)} (${(marker.bytes / target.bytes).toFixed(2)}x the download).\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) usage(0);
  if (argv[0] === '--list') return cmdList();
  if (argv[0] === '--verify') return cmdVerify();
  if (argv[1] === '--measure') return cmdMeasure(argv[0]);

  const modelId = argv[0];
  const known = BASE_MODELS.find((m) => m.id === modelId);
  if (!known) {
    process.stderr.write(`Unknown model id: ${modelId}\n\n`);
    usage();
  }

  const rest = argv.slice(1);

  // `--upstream` builds the URL from the model's recorded `upstream.asset`
  // instead of asking anyone to retype it. One fewer place a character can go
  // wrong, and the language table stays the single source of truth for which
  // asset a language means.
  if (rest.length === 1 && rest[0] === '--upstream') {
    const url = upstreamUrl(known.upstream);
    if (!url) {
      process.stderr.write(`${modelId} has no recorded upstream asset — pass the url explicitly.\n`);
      process.exit(1);
    }
    rest.length = 0;
    rest.push(url);
  }

  if (rest.length === 0) usage();

  const targets = [];
  let nameOverride = null;
  for (const arg of rest) {
    if (arg.startsWith('--name=')) { nameOverride = arg.slice('--name='.length); continue; }
    if (!/^https:\/\//.test(arg)) {
      process.stderr.write(`Refusing a non-https url: ${arg}\n`);
      process.exit(1);
    }
    targets.push({ url: arg, name: nameOverride || path.basename(new URL(arg).pathname) || 'model.bin' });
    nameOverride = null;
  }

  process.stderr.write(`Pinning ${modelId} (${known.label})\n`);
  // Scratch lives on local temp storage, not in the repo: the measurement
  // writes and re-reads the whole archive, and a network- or container-
  // mounted working directory makes that pathologically slow.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-pin-'));
  const files = [];
  try {
    for (const t of targets) {
      process.stderr.write(`  downloading ${t.name}\n`);
      const archive = isArchive(t.name);
      const keepAt = archive ? path.join(scratch, 'archive') : null;
      const got = await measure(t.url, keepAt);
      process.stderr.write(`    ${got.sha256}  ${formatBytes(got.bytes)}\n`);
      const rec = { name: t.name, url: t.url, sha256: got.sha256, bytes: got.bytes };

      // What it becomes ON DISK. §0.7's ceilings are about disk, and bz2
      // archives expand — German is 55 MB to fetch and 68 MB unpacked. The
      // figure ships in the pin so a ward's machine can size the install and
      // check the budget BEFORE downloading anything.
      if (!archive) {
        rec.diskBytes = got.bytes;
      } else {
        const out = await extractArchive({ archivePath: keepAt, destDir: path.join(scratch, 'unpacked'), name: t.name });
        if (out.ok) {
          rec.diskBytes = out.bytes;
          process.stderr.write(`    unpacks to ${formatBytes(out.bytes)} (${(out.bytes / got.bytes).toFixed(2)}x)\n`);
        } else {
          process.stderr.write(`    could not measure unpacked size (${out.reason}); leaving it unknown\n`);
        }
        await fs.rm(path.join(scratch, 'unpacked'), { recursive: true, force: true }).catch(() => {});
        await fs.rm(keepAt, { force: true }).catch(() => {});
      }
      files.push(rec);
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  const pins = await readPins();
  pins[modelId] = { files, pinnedAt: new Date().toISOString().slice(0, 10) };
  await writePins(pins);

  const total = files.reduce((a, f) => a + f.bytes, 0);
  process.stdout.write(`\nPinned ${modelId}: ${files.length} file(s), ${formatBytes(total)}\n`);
  if (total > known.estBytes * 1.5) {
    process.stdout.write(`Note: this is well above the ${formatBytes(known.estBytes)} the spec estimated. Worth checking against the §0.7 ceilings before it becomes a default.\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
