import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launcherPlan, launcherInstructions, findWardChrome, CDP_PORT } from '../src/browser/cdp-launcher.js';

const base = { chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', profileDir: '/home/ward/.proto-familiar/cdp-chrome' };

test('launcherPlan win32: a .cmd that starts Chrome with the debug port + dedicated profile', () => {
  const p = launcherPlan({ ...base, platform: 'win32', chromePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', profileDir: 'C:\\Users\\ward\\cdp' });
  assert.equal(p.filename, 'Start Familiar Chrome.cmd');
  assert.match(p.content, /start ""/);
  assert.match(p.content, /--remote-debugging-port=9222/);
  assert.match(p.content, /chrome\.exe/);
  assert.match(p.content, /--user-data-dir=/);
  assert.match(p.content, /cdp/);
});

test('launcherPlan darwin: an executable .command', () => {
  const p = launcherPlan({ ...base, platform: 'darwin' });
  assert.equal(p.filename, 'Start Familiar Chrome.command');
  assert.equal(p.mode, 0o755);
  assert.match(p.content, /^#!\/bin\/bash/);
  assert.match(p.content, /--remote-debugging-port=9222/);
  assert.match(p.content, /Google Chrome/);
});

test('launcherPlan linux: a .desktop entry with the full Exec', () => {
  const p = launcherPlan({ ...base, platform: 'linux', chromePath: '/usr/bin/google-chrome' });
  assert.equal(p.filename, 'Start Familiar Chrome.desktop');
  assert.equal(p.mode, 0o755);
  assert.match(p.content, /\[Desktop Entry\]/);
  assert.match(p.content, /Exec=.*google-chrome.*--remote-debugging-port=9222.*--user-data-dir=/);
});

test('launcherPlan: the debug port is the shared constant, not a literal drift', () => {
  const p = launcherPlan({ ...base, platform: 'linux', chromePath: '/usr/bin/google-chrome' });
  assert.match(p.content, new RegExp(`--remote-debugging-port=${CDP_PORT}`));
});

test('launcherPlan: an unsupported platform throws (caller turns it into guidance)', () => {
  assert.throws(() => launcherPlan({ ...base, platform: 'sunos' }));
});

test('launcherInstructions: mentions the Desktop and the fresh-Chrome login step', () => {
  for (const plat of ['darwin', 'win32', 'linux']) {
    const t = launcherInstructions(plat);
    assert.match(t, /Desktop/);
    assert.match(t, /log into/i);
  }
});

test('findWardChrome: never throws; returns a path string or null', () => {
  const r = findWardChrome();
  assert.ok(r === null || typeof r === 'string');
  // A platform with no candidates present resolves to null, not an error.
  assert.equal(findWardChrome('win32', {}), null);
});
