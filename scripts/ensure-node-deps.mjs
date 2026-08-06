/**
 * Pre-start hook: make sure the Node dependencies match what package.json now
 * declares, before server.js boots — the npm counterpart to
 * `ensure-phylactery-deps.mjs` / `ensure-unruh-deps.mjs`.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 * The launchers only ran the installer when `node_modules` was entirely
 * ABSENT. After an update (the in-app "Update" button, `update.*`, or a plain
 * `git pull`) `node_modules` is still there but STALE: a release that adds a
 * dependency — `tar` and `unbzip2-stream` did, for voice model unpacking —
 * leaves it uninstalled, and the feature fails with "Cannot find package
 * 'tar'". My human should never have to run `npm install` by hand to recover
 * from that; the app must notice its own dependencies drifted and close the
 * gap. So this runs on every start and installs only when something is
 * actually missing or changed.
 *
 * ── Cheap in the steady state ───────────────────────────────────────────
 * A fingerprint of the declared dependency set is compared to the one written
 * after the last successful install. Unchanged and all present → it does
 * nothing and touches no network. It only shells out to `npm install` when a
 * required package is missing from `node_modules`, or the declared set changed
 * since the fingerprint was written.
 *
 * ── Graceful ────────────────────────────────────────────────────────────
 * Exits 0 on every path so a failed or offline install never blocks the app
 * from booting — the rest of it works, and the missing capability degrades
 * with a loud, honest log rather than a broken page. optionalDependencies
 * (the native `sherpa-onnx-node`, which legitimately may not install on every
 * platform) never force a reinstall on their own.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const NODE_MODULES = path.join(REPO_ROOT, 'node_modules');
const FINGERPRINT_FILE = path.join(REPO_ROOT, '.pf-node-deps.json');

function say(msg) { process.stdout.write(`[ensure-node-deps] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[ensure-node-deps] ${msg}\n`); }

function readPkg() {
  try { return JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')); }
  catch (err) { warn(`could not read package.json (${err?.message ?? err}); skipping`); return null; }
}

const pkg = readPkg();
if (!pkg) process.exit(0);

const required = pkg.dependencies ?? {};
const optional = pkg.optionalDependencies ?? {};

/**
 * A stable fingerprint of the DECLARED dependency set. Sorted so key order in
 * package.json never changes it; covers optional deps too so removing one is
 * still noticed, but their absence from disk never forces an install (they are
 * allowed to be missing).
 */
function fingerprint() {
  const entries = [...Object.entries(required), ...Object.entries(optional)]
    .map(([name, range]) => `${name}@${range}`)
    .sort();
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}

function storedFingerprint() {
  try { return JSON.parse(readFileSync(FINGERPRINT_FILE, 'utf8'))?.fingerprint ?? null; }
  catch { return null; }
}

function writeFingerprint(fp) {
  try {
    writeFileSync(FINGERPRINT_FILE, `${JSON.stringify({ fingerprint: fp, at: new Date().toISOString() }, null, 2)}\n`);
  } catch { /* a marker we could not write just means we re-check next boot — harmless */ }
}

// A required dependency counts as present when its package directory exists.
// Scoped names (`@scope/name`) resolve correctly because the slash becomes a
// path separator. This is what catches the exact failure that prompted this:
// node_modules exists, but `tar` inside it does not.
const missing = Object.keys(required).filter((name) => !existsSync(path.join(NODE_MODULES, name)));

const fp = fingerprint();
const stored = storedFingerprint();

const nodeModulesMissing = !existsSync(NODE_MODULES);
// First run with everything already present but no fingerprint yet (the
// installer just ran): adopt the current state, do NOT reinstall.
const changed = stored !== null && stored !== fp;

if (!nodeModulesMissing && missing.length === 0 && !changed) {
  if (stored === null) writeFingerprint(fp); // record the baseline; stay quiet
  process.exit(0);
}

if (nodeModulesMissing) {
  say('Node dependencies are not installed yet — installing…');
} else if (missing.length > 0) {
  say(`Node dependencies drifted from package.json (missing: ${missing.join(', ')}) — installing…`);
} else {
  say('Node dependencies changed since the last install — refreshing…');
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['install', '--no-audit', '--no-fund'], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32', // npm.cmd needs the shell on Windows
});

if (result.error) {
  warn(`could not run npm install (${result.error.message}). If a feature reports a missing package, run \`npm install\` in ${REPO_ROOT}.`);
  process.exit(0); // never block boot
}
if (result.status !== 0) {
  warn(`npm install exited with status ${result.status}. Some dependencies may still be missing — the app will boot, but a feature that needs them may be degraded this run.`);
  process.exit(0);
}

// Only stamp the fingerprint on a clean install, so a partial failure re-tries
// next boot rather than being recorded as done.
const stillMissing = Object.keys(required).filter((name) => !existsSync(path.join(NODE_MODULES, name)));
if (stillMissing.length > 0) {
  warn(`npm install finished but these are still missing: ${stillMissing.join(', ')}. Not recording success; will retry next start.`);
  process.exit(0);
}

writeFingerprint(fp);
say('Node dependencies ready.');
process.exit(0);
