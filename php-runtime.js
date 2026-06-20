/**
 * php-runtime.js — fetch a PHP CLI runtime on demand for the PHP-based
 * local search engines (4get, LibreY).
 *
 * Rather than ask my human to install PHP (the friction the whole design
 * forbids), the Familiar fetches a PHP runtime on first install — the same
 * fetch-on-enable pattern SearXNG's source uses — caches it under
 * vendor/php-runtime/, and runs the engines with it via `php -S`.
 *
 * Two sources, by host:
 *   • Linux / macOS (x86_64 / aarch64) — a self-contained static binary from
 *     static-php-cli's prebuilt "common" build (extensions compiled in).
 *   • Windows (x64) — the official windows.php.net Non-Thread-Safe zip, plus a
 *     generated php.ini that enables the DLL extensions 4get/LibreY need
 *     (curl/openssl/mbstring/gd/…). NTS is correct for the single-process
 *     `php -S` server. (Needs the VS 2015-2022 x64 runtime, which is present on
 *     virtually all Windows; if php.exe won't start, that's the thing to add.)
 *
 * Integrity: the static source publishes no checksums and the Windows page
 * publishes per-file SHA-256, so the floor is HTTPS + a pinned-version URL + a
 * functional `php --version` check (a corrupt/wrong binary won't run and report
 * the pinned version). PHP_SHA256 can hold a hard pin per artifact. A failed
 * fetch/verify throws → the engine degrades to keyless; it never breaks search.
 */

import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_ROOT = path.join(__dirname, 'vendor', 'php-runtime');

// Pinned PHP version. Bump deliberately (re-run the engine spawn smoke-test).
// 8.3 over 8.4/8.5 for the broadest app compatibility. See CLAUDE.md cadence.
const PHP_VERSION   = '8.3.31';
const STATIC_BASE   = 'https://dl.static-php.dev/static-php-cli/common';
const WIN_BASE      = 'https://downloads.php.net/~windows/releases';

// node `${platform}-${arch}` → static-php-cli artifact (Linux/macOS only).
const STATIC_MAP = {
  'linux-x64':   'linux-x86_64',
  'linux-arm64': 'linux-aarch64',
  'darwin-x64':  'macos-x86_64',
  'darwin-arm64':'macos-aarch64',
};

// Optional HARD checksum pins, keyed by spec.dir (none published for the
// static builds; the Windows page lists SHA-256 if you want to pin one).
const PHP_SHA256 = {};

// ── Host PHP spec (the single source of platform truth) ───────────

/**
 * The PHP source descriptor for a host, or null if none exists. Pure;
 * platform/arch are injectable for tests.
 */
export function phpSpec(platform = process.platform, arch = process.arch) {
  const staticArtifact = STATIC_MAP[`${platform}-${arch}`];
  if (staticArtifact) {
    return {
      kind:    'static',
      dir:     staticArtifact,
      binary:  'php',
      archive: 'tar.gz',
      urls:    [`${STATIC_BASE}/php-${PHP_VERSION}-cli-${staticArtifact}.tar.gz`],
    };
  }
  if (platform === 'win32' && arch === 'x64') {
    const name = `php-${PHP_VERSION}-nts-Win32-vs16-x64.zip`;  // vs16 = PHP 8.3
    return {
      kind:    'windows',
      dir:     'win-x64',
      binary:  'php.exe',
      archive: 'zip',
      // Current patch lives under releases/; a superseded one moves to archives/.
      urls:    [`${WIN_BASE}/${name}`, `${WIN_BASE}/archives/${name}`],
    };
  }
  return null;
}

// Back-compat / focused helper: the static-build artifact (null on Windows).
export function staticPhpArtifact(platform = process.platform, arch = process.arch) {
  return STATIC_MAP[`${platform}-${arch}`] || null;
}

/** Does this host have any fetchable PHP build? */
export function phpSupported() {
  return !!phpSpec();
}

function phpBinaryPath() {
  const spec = phpSpec();
  return path.join(RUNTIME_ROOT, spec ? spec.dir : 'unsupported', spec ? spec.binary : 'php');
}

/** Is the PHP runtime already fetched + cached for this host? */
export function phpInstalled() {
  return phpSupported() && existsSync(phpBinaryPath());
}

// ── Install ───────────────────────────────────────────────────────

/**
 * Ensure a usable PHP binary exists for this host, fetching it once if needed.
 * Returns the binary path. Throws (caller degrades to keyless) on an
 * unsupported platform, a failed download/extract, a checksum mismatch, or a
 * binary that won't run. Side effects are injectable for tests.
 */
export async function ensurePhp(deps = {}) {
  const spec = phpSpec();
  if (!spec) {
    throw new Error(`no PHP build for this platform (${process.platform}-${process.arch}); the PHP-based engines need Linux, macOS, or 64-bit Windows`);
  }
  const dir = path.join(RUNTIME_ROOT, spec.dir);
  const bin = path.join(dir, spec.binary);
  if (existsSync(bin)) return bin;

  mkdirSync(dir, { recursive: true });
  const archivePath = path.join(dir, spec.archive === 'zip' ? 'php.zip' : 'php.tar.gz');

  try {
    await (deps.download || downloadFile)(spec.urls, archivePath);

    const want = PHP_SHA256[spec.dir];
    if (want) {
      const got = sha256File(archivePath);
      if (got !== want) throw new Error(`PHP download checksum mismatch for ${spec.dir}`);
    }

    await (deps.extract || extractArchive)(archivePath, dir);
    rmSync(archivePath, { force: true });
    if (!existsSync(bin)) throw new Error('PHP archive extracted but the php binary is missing');

    if (spec.kind === 'windows') writeWindowsIni(dir);
    else chmodSync(bin, 0o755);

    const ok = await (deps.verify || verifyPhp)(bin);
    if (!ok) throw new Error('the fetched PHP binary did not run as expected');
    return bin;
  } catch (err) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw new Error(`could not set up the PHP runtime (${err.message})`);
  }
}

/** Remove the cached PHP runtime entirely. */
export async function uninstallPhp() {
  rmSync(RUNTIME_ROOT, { recursive: true, force: true });
}

// ── Real side effects (the verify-on-real-install integration point) ──

// Try each candidate URL in order (Windows: releases/ then archives/).
async function downloadFile(urls, dest) {
  const list = Array.isArray(urls) ? urls : [urls];
  let lastErr = 'no url';
  for (const url of list) {
    try {
      const res = await fetch(url);
      if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      return;
    } catch (err) { lastErr = err.message; }
  }
  throw new Error(`download failed (${lastErr})`);
}

// `tar -xf` auto-detects compression and, via libarchive/bsdtar (present on
// Windows 10+ and macOS), also extracts .zip — so one call covers both kinds.
async function extractArchive(archive, dir) {
  await runToCompletion('tar', ['-xf', archive, '-C', dir]);
}

// Windows DLL extensions are off until enabled. php.exe auto-loads a php.ini
// sitting beside it, so drop one in that turns on what 4get/LibreY need.
function writeWindowsIni(dir) {
  const extDir = path.join(dir, 'ext').replace(/\\/g, '/');
  const ini = [
    `extension_dir = "${extDir}"`,
    'extension=curl',
    'extension=openssl',
    'extension=mbstring',
    'extension=gd',
    'extension=fileinfo',
    'extension=intl',
    '',
  ].join('\r\n');
  writeFileSync(path.join(dir, 'php.ini'), ini, 'utf8');
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
