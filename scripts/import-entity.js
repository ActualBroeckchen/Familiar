#!/usr/bin/env node
/**
 * scripts/import-entity.js
 *
 * Imports an existing entity-core data directory into the local instance
 * managed by Familiar, overwriting the current data.
 *
 * Usage:
 *   npm run import-entity -- --from /path/to/entity-core
 *   npm run import-entity -- --from /path/to/entity-core/data
 *   npm run import-entity -- --from /path/to/entity-core --yes   (skip confirmation)
 *
 * The script auto-detects whether --from points to an entity-core root
 * (looks for a data/ subdirectory) or directly to a data directory
 * (looks for self/, memories/, or graph.db inside it).
 *
 * The destination is resolved the same way thalamus.js finds entity-core:
 *   1. $ENTITY_CORE_PATH  (env var pointing to entity-core's src/mod.ts)
 *   2. ../entity-core-alpha (sibling directory, default)
 * Then reads that install's .env for ENTITY_CORE_DATA_DIR, defaulting to ./data.
 *
 * Requires Node.js 18+ (uses fs.cpSync).
 */

import { existsSync, cpSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { resolve, dirname, basename, join } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Argument parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const fromArg  = getArg('--from');
const skipConfirm = args.includes('--yes') || args.includes('-y');

if (!fromArg) {
  console.error('Usage: npm run import-entity -- --from <path> [--yes]');
  process.exit(1);
}

// ── Resolve source data directory ────────────────────────────────────────────

const fromAbs = resolve(fromArg);

if (!existsSync(fromAbs)) {
  console.error(`Source path does not exist: ${fromAbs}`);
  process.exit(1);
}

function looksLikeDataDir(p) {
  return existsSync(join(p, 'self'))
    || existsSync(join(p, 'memories'))
    || existsSync(join(p, 'graph.db'));
}

function looksLikeEntityCoreRoot(p) {
  return existsSync(join(p, 'data')) && existsSync(join(p, 'src'));
}

let sourceDataDir;
if (looksLikeDataDir(fromAbs)) {
  sourceDataDir = fromAbs;
} else if (looksLikeEntityCoreRoot(fromAbs)) {
  // Read the source's own .env to find its ENTITY_CORE_DATA_DIR
  const srcDataDir = readEnvVar(join(fromAbs, '.env'), 'ENTITY_CORE_DATA_DIR')
    ?? join(fromAbs, 'data');
  sourceDataDir = resolve(fromAbs, srcDataDir);
} else {
  console.error(
    `Cannot identify "${fromAbs}" as an entity-core root or data directory.\n` +
    'Expected either:\n' +
    '  • An entity-core root (contains src/ and data/)\n' +
    '  • A data directory   (contains self/, memories/, or graph.db)',
  );
  process.exit(1);
}

if (!existsSync(sourceDataDir)) {
  console.error(`Source data directory does not exist: ${sourceDataDir}`);
  process.exit(1);
}

// ── Resolve destination data directory ───────────────────────────────────────

// Mirror the same resolution logic as thalamus.js:
//   ENTITY_CORE_PATH points to src/mod.ts, so the root is two levels up.
const entityCorePath = process.env.ENTITY_CORE_PATH;
const entityCoreRoot = entityCorePath
  ? resolve(dirname(dirname(entityCorePath)))            // .../entity-core-alpha
  : resolve(__dirname, '..', '..', 'entity-core-alpha'); // sibling default

const destEnvPath = join(entityCoreRoot, '.env');
const destDataRelative = readEnvVar(destEnvPath, 'ENTITY_CORE_DATA_DIR') ?? './data';
const destDataDir = resolve(entityCoreRoot, destDataRelative);

// ── Sanity checks ─────────────────────────────────────────────────────────────

if (resolve(sourceDataDir) === resolve(destDataDir)) {
  console.error('Source and destination are the same directory. Nothing to do.');
  process.exit(0);
}

const sourceItems = readdirSync(sourceDataDir);

console.log('');
console.log('  Source  :', sourceDataDir);
console.log('  Dest    :', destDataDir);
console.log('  Items   :', sourceItems.join(', ') || '(empty)');
console.log('');
console.log('  WARNING : This will OVERWRITE the destination data directory.');
console.log('            Stop the Familiar server before proceeding to avoid');
console.log('            file conflicts with the running entity-core process.');
console.log('');

// ── Confirmation ──────────────────────────────────────────────────────────────

async function confirm(question) {
  if (skipConfirm) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

const ok = await confirm('  Proceed? [y/N] ');
if (!ok) {
  console.log('Aborted.');
  process.exit(0);
}

// ── Copy ──────────────────────────────────────────────────────────────────────

console.log('\nCopying...');
mkdirSync(destDataDir, { recursive: true });

cpSync(sourceDataDir, destDataDir, {
  recursive: true,
  force: true,
  // Preserve timestamps so entity-core's recency ranking stays accurate.
  preserveTimestamps: true,
});

console.log('Done. entity-core data imported successfully.');
console.log('Start Familiar normally — thalamus.js will pick up the new data on next launch.');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Read a single KEY=value line from a .env file.  Returns undefined if the
 * file doesn't exist or the key isn't found.  Does not handle multiline
 * values or shell quoting — sufficient for simple path variables.
 *
 * @param {string} envPath
 * @param {string} key
 * @returns {string | undefined}
 */
function readEnvVar(envPath, key) {
  if (!existsSync(envPath)) return undefined;
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eqIdx = trimmed.indexOf('=');
    const k = trimmed.slice(0, eqIdx).trim();
    if (k !== key) continue;
    // Strip optional surrounding quotes
    return trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
  }
  return undefined;
}
