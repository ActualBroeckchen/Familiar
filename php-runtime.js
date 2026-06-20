/**
 * php-runtime.js — fetch a self-contained static PHP CLI binary on demand.
 *
 * The PHP-based local search engines (4get, LibreY) need a PHP runtime we
 * don't otherwise ship. Rather than ask my human to install PHP (exactly the
 * friction the whole design forbids), the Familiar fetches a single
 * self-contained static PHP binary on first install — the same fetch-on-enable
 * pattern SearXNG's source uses — caches it under vendor/php-runtime/, and runs
 * the engines with it.
 *
 * Source: static-php-cli's prebuilt "common" CLI builds (≈30 extensions incl.
 * curl / openssl / mbstring / dom / simplexml / gd — the set 4get/LibreY need),
 * at https://dl.static-php.dev/static-php-cli/common/php-<ver>-cli-<platform>.tar.gz
 * Builds exist for Linux + macOS (x86_64 / aarch64) only — there is no Windows
 * build, so phpSupported() is false on win32 and the PHP engines degrade to
 * "unavailable" there (SearXNG, which runs via uv, still works on Windows).
 *
 * Integrity: static-php.dev publishes no per-file checksums, so the floor is
 * HTTPS + a pinned version URL + a functional `php --version` check (a
 * corrupt/truncated/wrong binary won't run and report the pinned version). A
 * security-conscious operator can pin a hard SHA-256 in PHP_SHA256 to enforce
 * a cryptographic match. A failed fetch/verify throws → the engine degrades to
 * keyless; it never breaks search.
 */

import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_ROOT = path.join(__dirname, 'vendor', 'php-runtime');

// Pinned PHP version. Bump deliberately (re-run the engine spawn smoke-test).
// 8.3 over 8.4 for the broadest app compatibility. See CLAUDE.md cadence.
const PHP_VERSION  = '8.3.31';
const PHP_BASE_URL = 'https://dl.static-php.dev/static-php-cli/common';

// node `${platform}-${arch}` → static-php-cli artifact platform string.
// win32 is absent on purpose (no static build) → unsupported.
const PLATFORM_MAP = {
  'linux-x64':   'linux-x86_64',
  'linux-arm64': 'linux-aarch64',
  'darwin-x64':  'macos-x86_64',
  'darwin-arm64':'macos-aarch64',
};

// Optional HARD checksum pins (static-php.dev publishes none, so empty by
// default → integrity rests on HTTPS + the functional version check below).
// Fill in `<artifact>: '<sha256 hex>'` to enforce a cryptographic match.
const PHP_SHA256 = {};

// ── Pure helpers (unit-tested) ────────────────────────────────────

/** static-php-cli artifact string for a node platform/arch, or null if
 *  there's no prebuilt static PHP for it (e.g. Windows). */
export function staticPhpArtifact(platform = process.platform, arch = process.arch) {
  return PLATFORM_MAP[`${platform}-${arch}`] || null;
}

/** The download URL for a given artifact platform string. */
export function phpDownloadUrl(artifact, version = PHP_VERSION) {
  return `${PHP_BASE_URL}/php-${version}-cli-${artifact}.tar.gz`;
}

/** Does this host have a static PHP build available at all? */
export function phpSupported() {
  return !!staticPhpArtifact();
}

function phpBinaryPath() {
  const artifact = staticPhpArtifact() || 'unsupported';
  return path.join(RUNTIME_ROOT, artifact, 'php');
}

/** Is the PHP runtime already fetched + cached for this host? */
export function phpInstalled() {
  return phpSupported() && existsSync(phpBinaryPath());
}

// ── Install ───────────────────────────────────────────────────────

/**
 * Ensure a usable static PHP binary exists for this host, fetching it once if
 * needed. Returns the binary path. Throws (caller degrades to keyless) on an
 * unsupported platform, a failed download/extract, a checksum mismatch, or a
 * binary that won't run. Side effects (download/extract/verify) are injectable
 * for tests.
 */
export async function ensurePhp(deps = {}) {
  const artifact = staticPhpArtifact();
  if (!artifact) {
    throw new Error(`no static PHP build for this platform (${process.platform}-${process.arch}); the PHP-based engines need Linux or macOS`);
  }
  const bin = phpBinaryPath();
  if (existsSync(bin)) return bin;

  const dir = path.dirname(bin);
  mkdirSync(dir, { recursive: true });
  const url = phpDownloadUrl(artifact);
  const tar = path.join(dir, 'php.tar.gz');

  try {
    await (deps.download || downloadFile)(url, tar);

    const want = PHP_SHA256[artifact];
    if (want) {
      const got = sha256File(tar);
      if (got !== want) throw new Error(`PHP download checksum mismatch for ${artifact}`);
    }

    await (deps.extract || extractTarGz)(tar, dir);
    rmSync(tar, { force: true });
    if (!existsSync(bin)) throw new Error('PHP archive extracted but the php binary is missing');
    if (process.platform !== 'win32') chmodSync(bin, 0o755);

    const ok = await (deps.verify || verifyPhp)(bin);
    if (!ok) throw new Error('the fetched PHP binary did not run as expected');
    return bin;
  } catch (err) {
    // Leave no half-installed runtime behind.
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw new Error(`could not set up the PHP runtime (${err.message})`);
  }
}

/** Remove the cached PHP runtime entirely. */
export async function uninstallPhp() {
  rmSync(RUNTIME_ROOT, { recursive: true, force: true });
}

// ── Real side effects (the verify-on-real-install integration point) ──

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function extractTarGz(tar, dir) {
  // The tarball holds a single `php` binary. System tar is present on the
  // Linux/macOS hosts these builds target.
  await runToCompletion('tar', ['-xzf', tar, '-C', dir]);
}

// Functional integrity: the binary runs and reports the pinned major.minor.
function verifyPhp(bin) {
  const wantPrefix = `PHP ${PHP_VERSION.split('.').slice(0, 2).join('.')}`;
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(bin, ['--version']);
    p.stdout?.on('data', d => { out += d; });
    p.on('error', () => resolve(false));
    p.on('exit', code => resolve(code === 0 && out.includes(wantPrefix)));
  });
}

function sha256File(p) {
  return crypto.createHash('sha256').update(readFileSync(p)).digest('hex');
}

function runToCompletion(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'ignore', ...opts });
    p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`)));
  });
}

export { RUNTIME_ROOT, PHP_VERSION };
