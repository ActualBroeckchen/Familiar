#!/usr/bin/env node
/**
 * scripts/import-tome.js
 *
 * Converts a SillyTavern lorebook export (.json) into Proto-Familiar
 * native tome format and writes it to the tomes/ directory.
 *
 * Usage:
 *   node scripts/import-tome.js path/to/lorebook.json
 *   node scripts/import-tome.js path/to/lorebook.json --name "My Tome"
 *   node scripts/import-tome.js path/to/lorebook.json --out path/to/output.json
 *
 * Field mapping (SillyTavern → Proto-Familiar):
 *   key          → keys
 *   order        → insertion_order
 *   disable:true → enabled:false  (inverted)
 *   (no top-level id/name/enabled) → generated
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

// ── Argument parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const inputPath  = args.find(a => !a.startsWith('--'));
const nameArg    = getArg('--name');
const outArg     = getArg('--out');

if (!inputPath) {
  console.error('Usage: node scripts/import-tome.js <lorebook.json> [--name "Title"] [--out path/to/output.json]');
  process.exit(1);
}

const inputAbs = resolve(inputPath);
if (!existsSync(inputAbs)) {
  console.error(`File not found: ${inputAbs}`);
  process.exit(1);
}

// ── Load source ──────────────────────────────────────────────────────────────

let source;
try {
  source = JSON.parse(readFileSync(inputAbs, 'utf-8'));
} catch (err) {
  console.error(`Failed to parse JSON: ${err.message}`);
  process.exit(1);
}

// ── Detect format ────────────────────────────────────────────────────────────

// SillyTavern export: top-level has "entries" but no "id" or "enabled"
// Proto-Familiar native: top-level has "id", "name", "enabled", "entries"
const isSillyTavern = source.entries && !source.id && !source.enabled;
if (!isSillyTavern) {
  console.warn('Warning: this file may already be in Proto-Familiar format. Proceeding anyway.');
}

// ── Normalize a single entry ─────────────────────────────────────────────────

function normalizeEntry(raw, uid) {
  const e = { ...raw };

  // Field renames
  if ('key' in e && !('keys' in e))              { e.keys = e.key;             delete e.key; }
  if ('order' in e && !('insertion_order' in e)) { e.insertion_order = e.order; delete e.order; }
  if ('disable' in e && !('enabled' in e))       { e.enabled = !e.disable;     delete e.disable; }

  // Ensure uid is a string (SillyTavern uses integer uids)
  e.uid = String(e.uid ?? uid);

  // Defaults for fields the engine expects
  if (e.keys          === undefined) e.keys          = [];
  if (e.keysecondary  === undefined) e.keysecondary  = [];
  if (e.enabled       === undefined) e.enabled       = true;
  if (e.constant      === undefined) e.constant      = false;
  if (e.selective     === undefined) e.selective      = false;
  if (e.selectiveLogic=== undefined) e.selectiveLogic = 0;
  if (e.position      === undefined) e.position      = 0;
  if (e.depth         === undefined) e.depth         = 4;
  if (e.role          === undefined) e.role          = 0;
  if (e.probability   === undefined) e.probability   = 100;
  if (e.insertion_order === undefined) e.insertion_order = 100;
  if (e.group         === undefined) e.group         = '';

  if (!e.created_at) e.created_at = new Date().toISOString();

  return e;
}

// ── Build Proto-Familiar tome ────────────────────────────────────────────────

const rawEntries = source.entries ?? {};
const tomeName   = nameArg
  ?? source.name
  ?? basename(inputAbs, '.json');

const entries = {};
for (const [key, raw] of Object.entries(rawEntries)) {
  const normalized = normalizeEntry(raw, key);
  entries[normalized.uid] = normalized;
}

const tome = {
  id:          randomUUID(),
  name:        tomeName,
  description: source.description ?? `Imported from ${basename(inputAbs)}`,
  enabled:     true,
  entries,
};

// ── Write output ─────────────────────────────────────────────────────────────

let outPath;
if (outArg) {
  outPath = resolve(outArg);
} else {
  const tomesDir = join(ROOT, 'tomes');
  if (!existsSync(tomesDir)) mkdirSync(tomesDir, { recursive: true });
  const safeName = tomeName.replace(/[^a-zA-Z0-9_\-]/g, '_');
  outPath = join(tomesDir, `${safeName}.json`);
}

writeFileSync(outPath, JSON.stringify(tome, null, 2), 'utf-8');

const entryCount = Object.keys(entries).length;
console.log(`✓ Imported ${entryCount} entr${entryCount !== 1 ? 'ies' : 'y'} → ${outPath}`);
