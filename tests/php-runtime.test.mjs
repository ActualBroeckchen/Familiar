import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  staticPhpArtifact,
  phpDownloadUrl,
  ensurePhp,
} from '../php-runtime.js';

// ── platform/arch → artifact mapping (the typo-prone part) ───────
test('staticPhpArtifact maps the supported Linux/macOS platforms', () => {
  assert.equal(staticPhpArtifact('linux',  'x64'),   'linux-x86_64');
  assert.equal(staticPhpArtifact('linux',  'arm64'), 'linux-aarch64');
  assert.equal(staticPhpArtifact('darwin', 'x64'),   'macos-x86_64');
  assert.equal(staticPhpArtifact('darwin', 'arm64'), 'macos-aarch64');
});

test('staticPhpArtifact returns null for Windows and unknown arches', () => {
  assert.equal(staticPhpArtifact('win32', 'x64'),   null);
  assert.equal(staticPhpArtifact('linux', 'ia32'),  null);
  assert.equal(staticPhpArtifact('sunos', 'x64'),   null);
});

// ── download URL builder ─────────────────────────────────────────
test('phpDownloadUrl builds the static-php.dev common path', () => {
  assert.equal(
    phpDownloadUrl('linux-x86_64', '8.3.31'),
    'https://dl.static-php.dev/static-php-cli/common/php-8.3.31-cli-linux-x86_64.tar.gz',
  );
});

// ── ensurePhp degrades on an unsupported platform ────────────────
test('ensurePhp rejects clearly on a platform with no static build', async (t) => {
  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }));

  await assert.rejects(() => ensurePhp(), /no static PHP build for this platform/);
});
