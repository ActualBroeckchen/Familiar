import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  staticPhpArtifact,
  phpSpec,
  ensurePhp,
} from '../php-runtime.js';

// ── static-build artifact mapping (Linux/macOS) ──────────────────
test('staticPhpArtifact maps the supported Linux/macOS platforms', () => {
  assert.equal(staticPhpArtifact('linux',  'x64'),   'linux-x86_64');
  assert.equal(staticPhpArtifact('linux',  'arm64'), 'linux-aarch64');
  assert.equal(staticPhpArtifact('darwin', 'x64'),   'macos-x86_64');
  assert.equal(staticPhpArtifact('darwin', 'arm64'), 'macos-aarch64');
  assert.equal(staticPhpArtifact('win32',  'x64'),   null); // no STATIC build for Windows
});

// ── phpSpec: the full per-host source descriptor ─────────────────
test('phpSpec returns a static tar.gz spec on Linux/macOS', () => {
  const s = phpSpec('linux', 'x64');
  assert.equal(s.kind, 'static');
  assert.equal(s.binary, 'php');
  assert.equal(s.archive, 'tar.gz');
  assert.match(s.urls[0], /dl\.static-php\.dev\/static-php-cli\/common\/php-8\.3\.31-cli-linux-x86_64\.tar\.gz$/);
});

test('phpSpec returns a Windows zip spec (php.exe + releases/archives fallback)', () => {
  const s = phpSpec('win32', 'x64');
  assert.equal(s.kind, 'windows');
  assert.equal(s.binary, 'php.exe');
  assert.equal(s.archive, 'zip');
  assert.match(s.urls[0], /downloads\.php\.net\/~windows\/releases\/php-8\.3\.31-nts-Win32-vs16-x64\.zip$/);
  assert.match(s.urls[1], /\/archives\/php-8\.3\.31-nts-Win32-vs16-x64\.zip$/); // archives fallback
});

test('phpSpec is null for platforms with no build (32-bit Windows, exotic OSes)', () => {
  assert.equal(phpSpec('win32', 'ia32'), null);
  assert.equal(phpSpec('linux', 'ia32'), null);
  assert.equal(phpSpec('sunos', 'x64'),  null);
});

// ── ensurePhp degrades on an unsupported platform ────────────────
test('ensurePhp rejects clearly on a platform with no PHP build', async (t) => {
  const real = process.platform;
  Object.defineProperty(process, 'platform', { value: 'sunos', configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', { value: real, configurable: true }));

  await assert.rejects(() => ensurePhp(), /no PHP build for this platform/);
});
