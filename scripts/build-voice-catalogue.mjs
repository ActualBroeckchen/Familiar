#!/usr/bin/env node
/**
 * Build the reference-voice catalogue from upstream's file listing.
 *
 * Writes `voice-clips.json`: every CC0 voice clip a ward may preview or pick,
 * with the checksum needed to install it safely.
 *
 * ── Why this needs no downloads ─────────────────────────────────────────
 * HuggingFace stores these as Git LFS objects, and an LFS oid IS the file's
 * sha256. So the listing endpoint hands us a verified checksum for 200+ clips
 * without fetching a single byte — which is what makes a pinned catalogue
 * cheap enough to be the default rather than a chore.
 *
 * The checksum still gets verified on install: `voice-fetch.js` hashes what it
 * downloads and compares. This just means we know the expected value up front
 * instead of having to download everything to learn it.
 *
 * ── Only CC0 sources ────────────────────────────────────────────────────
 * `voice-catalogue.js` decides which upstream directories may ship at all;
 * this script asks it rather than carrying its own list, so the licensing
 * rule has exactly one home. Non-commercial sources cannot appear here even
 * if someone adds them to the SOURCE_DIRS map by mistake.
 *
 * Usage:
 *   node scripts/build-voice-catalogue.mjs
 *   node scripts/build-voice-catalogue.mjs --dry-run
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { shippableSources, sourceByKey } from '../src/voice/voice-catalogue.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'voice-clips.json');

const REPO = 'kyutai/tts-voices';
const API = `https://huggingface.co/api/models/${REPO}/tree/main`;
const RAW = `https://huggingface.co/${REPO}/resolve/main`;

/** Which upstream directory each catalogue source lives in. */
const SOURCE_DIRS = {
  'voice-zero': 'voice-zero',
  'voice-donations': 'voice-donations',
  'alba-mackenna': 'alba-mackenna',
  'vctk': 'vctk',
  'cml-tts-fr': 'cml-tts/fr',
};

async function listDir(dir) {
  const out = [];
  let cursor = null;
  // Paginate: 228 donation voices with four files each is well past one page.
  for (let page = 0; page < 40; page++) {
    const url = `${API}/${dir}?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} listing ${dir}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);

    const link = res.headers.get('link') ?? '';
    const next = /<([^>]+)>;\s*rel="next"/.exec(link);
    if (!next) break;
    cursor = new URL(next[1]).searchParams.get('cursor');
    if (!cursor) break;
  }
  return out;
}

/**
 * A clip record. `sha256` comes from the LFS oid — a machine value read from
 * upstream, never typed. Entries without one are dropped: an unverifiable clip
 * is one we cannot install, so listing it would offer a ward something that
 * fails at the last step.
 */
function toClip(entry, sourceKey) {
  const rel = entry.path;
  const base = path.posix.basename(rel);
  if (!base.toLowerCase().endsWith('.wav')) return null;

  const sha256 = entry?.lfs?.oid;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null;

  const enhanced = /_enhanced\.wav$/i.test(base);
  const id = base.replace(/_enhanced\.wav$/i, '').replace(/\.wav$/i, '');

  return {
    id,
    variant: enhanced ? 'enhanced' : 'original',
    source: sourceKey,
    file: base,
    url: `${RAW}/${rel}`,
    sha256,
    bytes: entry?.lfs?.size ?? entry?.size ?? null,
  };
}

const dry = process.argv.includes('--dry-run');
const sources = shippableSources();
const clips = [];
const perSource = {};

for (const s of sources) {
  const dir = SOURCE_DIRS[s.key];
  if (!dir) {
    process.stderr.write(`  ${s.key}: no upstream directory recorded, skipping\n`);
    continue;
  }
  process.stderr.write(`Listing ${dir}…\n`);
  let entries;
  try {
    entries = await listDir(dir);
  } catch (err) {
    process.stderr.write(`  ${dir}: ${err.message} — skipped\n`);
    continue;
  }
  const found = entries.map((e) => toClip(e, s.key)).filter(Boolean);
  clips.push(...found);
  perSource[s.key] = found.length;
  const voices = new Set(found.map((c) => c.id)).size;
  process.stderr.write(`  ${found.length} clips across ${voices} voices\n`);
}

clips.sort((a, b) => (a.source === b.source ? a.id.localeCompare(b.id) || a.variant.localeCompare(b.variant) : a.source.localeCompare(b.source)));

const catalogue = {
  repo: REPO,
  builtAt: new Date().toISOString().slice(0, 10),
  // Recorded so a reader can check the licence claim without trusting this file.
  licences: Object.fromEntries(sources.map((s) => [s.key, sourceByKey(s.key).license.id])),
  counts: { clips: clips.length, voices: new Set(clips.map((c) => `${c.source}/${c.id}`)).size, ...perSource },
  clips,
};

if (dry) {
  process.stdout.write(`${JSON.stringify(catalogue.counts, null, 2)}\n`);
  process.stdout.write(`(dry run — ${OUT} not written)\n`);
} else {
  await fs.writeFile(OUT, `${JSON.stringify(catalogue, null, 2)}\n`, 'utf8');
  const kb = (await fs.stat(OUT)).size / 1024;
  process.stdout.write(`Wrote ${path.relative(ROOT, OUT)}: ${catalogue.counts.voices} voices, ${catalogue.counts.clips} clips (${kb.toFixed(0)} KB)\n`);
}
