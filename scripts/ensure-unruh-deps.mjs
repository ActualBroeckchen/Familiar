/**
 * Pre-start hook: make sure Unruh's Python venv is ready before
 * server.js boots. Idempotent and fast in the steady state (uv sync
 * with no changes is sub-second), so safe to run on every `npm start`
 * / `npm run dev` via the prestart / predev npm script hooks.
 *
 * Behavior:
 *   - No unruh/ in this checkout → exit silently.
 *   - unruh/.venv/ already present → just `uv sync` to pick up any
 *     uv.lock changes from a recent `git pull`.
 *   - unruh/.venv/ missing → loud "first-run setup" message, then sync.
 *   - uv not installed → clear pointer to install.sh / install.bat
 *     (which DO auto-install uv), exit 0 so the server still boots
 *     and degrades gracefully. We deliberately do NOT auto-install uv
 *     from here: prestart is the wrong layer for a network install,
 *     and `npm start` shouldn't surprise a dev with a 30-second
 *     download.
 *
 * Exits 0 on every non-catastrophic path so the server boot continues
 * even when Unruh setup fails — thalamus.js already degrades gracefully
 * when Unruh is unavailable.
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = path.resolve(__dirname, '..');
const UNRUH_ROOT = path.join(REPO_ROOT, 'unruh');
const UNRUH_PYPROJECT = path.join(UNRUH_ROOT, 'pyproject.toml');
const UNRUH_VENV = path.join(UNRUH_ROOT, '.venv');

function say(msg)  { process.stdout.write(`[ensure-unruh] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[ensure-unruh] ${msg}\n`); }

// Mirror thalamus.js's resolveUvBinary() — same install-location probes
// so we find uv when the user installed it but their PATH hasn't picked
// it up yet (common on Windows after the Astral installer, or in a
// non-login terminal).
function resolveUv() {
  if (process.env.UV_BIN && existsSync(process.env.UV_BIN)) return process.env.UV_BIN;
  const home = os.homedir();
  const isWin = process.platform === 'win32';
  const candidates = isWin
    ? [
        path.join(home, '.local', 'bin', 'uv.exe'),
        path.join(process.env.LOCALAPPDATA ?? '', 'uv', 'bin', 'uv.exe'),
        path.join(home, '.cargo', 'bin', 'uv.exe'),
      ]
    : [
        path.join(home, '.local', 'bin', 'uv'),
        path.join(home, '.cargo', 'bin', 'uv'),
        '/usr/local/bin/uv',
        '/opt/homebrew/bin/uv',
      ];
  for (const c of candidates) { if (c && existsSync(c)) return c; }
  // Last-resort: rely on PATH. spawnSync below will surface ENOENT if
  // it's not actually there.
  return isWin ? 'uv.exe' : 'uv';
}

if (!existsSync(UNRUH_PYPROJECT)) process.exit(0); // no Unruh in this checkout
const uv = resolveUv();
const venvExists = existsSync(UNRUH_VENV);

// Probe uv runnability before assuming it's installed. `uv --version`
// is cheap (~10ms) and tells us both "binary exists" and "binary works".
const probe = spawnSync(uv, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
if (probe.status !== 0) {
  if (!venvExists) {
    warn('uv is not installed — Unruh (temporal context) will be disabled.');
    warn('Run `install.bat` (Windows) or `./install.sh` (macOS/Linux) once to install uv + sync Unruh.');
  }
  process.exit(0);
}

if (!venvExists) {
  say('First-run setup: materialising Unruh\'s Python venv (one-time, ~30s)…');
}
const sync = spawnSync(uv, ['sync', '--quiet'], {
  cwd: UNRUH_ROOT,
  stdio: 'inherit',
});
if (sync.status === 0) {
  if (!venvExists) say('Unruh dependencies ready.');
} else {
  warn(`uv sync exited with status ${sync.status} — Unruh may not work this boot.`);
}
process.exit(0);
