#!/usr/bin/env node
/**
 * scripts/import-entity.js
 *
 * Imports an existing entity-core data directory into Phylactery by
 * invoking the Python migration module.
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
 * The migration is performed by:
 *   cd <phylacteryRoot> && uv run python -m phylactery.migrate_from_entity_core \
 *       --source <sourceDataDir>
 *
 * The Python script is idempotent — safe to run more than once.
 * It snapshots Phylactery before any writes.
 */

import { existsSync, readFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Argument parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const fromArg      = getArg('--from');
const skipConfirm  = args.includes('--yes') || args.includes('-y');

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
  const srcEnvDataDir = readEnvVar(join(fromAbs, '.env'), 'ENTITY_CORE_DATA_DIR')
    ?? join(fromAbs, 'data');
  sourceDataDir = resolve(fromAbs, srcEnvDataDir);
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

// ── Resolve Phylactery root ───────────────────────────────────────────────────

// The Phylactery package lives two levels up from scripts/ (i.e. at the
// Proto-Familiar repo root) and then into phylactery/.
const phylacteryRoot = resolve(__dirname, '..', 'phylactery');
if (!existsSync(phylacteryRoot)) {
  console.error(`Phylactery root not found at: ${phylacteryRoot}`);
  console.error('Run the installer to set up Phylactery first.');
  process.exit(1);
}

// ── Print plan + confirm ──────────────────────────────────────────────────────

console.log('');
console.log('  Source     :', sourceDataDir);
console.log('  Phylactery :', phylacteryRoot);
console.log('');
console.log('  The Python migration script will:');
console.log('    1. Snapshot Phylactery before any writes (safe to run again).');
console.log('    2. Import identity markdown files (entity-core user/ → ward category).');
console.log('    3. Import memory markdown files (all tiers, date-key preserved).');
console.log('    4. Import graph.db nodes and edges.');
console.log('    5. Set audience=ward-private on all migrated records.');
console.log('');
console.log('  This is idempotent — already-migrated records are skipped.');
console.log('');

async function confirm(question) {
  if (skipConfirm) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => {
    rl.question(question, answer => {
      rl.close();
      res(answer.trim().toLowerCase() === 'y');
    });
  });
}

const ok = await confirm('  Proceed? [y/N] ');
if (!ok) {
  console.log('Aborted.');
  process.exit(0);
}

// ── Invoke migration ──────────────────────────────────────────────────────────

console.log('\nRunning migration…\n');

const result = spawnSync(
  'uv',
  ['run', 'python', '-m', 'phylactery.migrate_from_entity_core', '--source', sourceDataDir],
  {
    cwd:   phylacteryRoot,
    stdio: 'inherit',
  },
);

if (result.error) {
  console.error('\nFailed to spawn uv:', result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 0);

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
