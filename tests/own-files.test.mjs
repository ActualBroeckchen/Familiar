import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listOwnFiles, readOwnFile } from '../own-files.js';

// Build a throwaway "repo root" so tests don't depend on the real tree.
async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-ownfiles-'));
  await fs.mkdir(path.join(root, 'tomes'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.mkdir(path.join(root, '.git'));
  await fs.writeFile(path.join(root, 'tomes', 'ponderings.json'), '{"a":1}');
  await fs.writeFile(path.join(root, 'settings.json'), '{"apiKey":"SECRET"}');
  await fs.writeFile(path.join(root, '.env'), 'TOKEN=SECRET');
  await fs.writeFile(path.join(root, 'README.md'), '# hi');
  await fs.writeFile(path.join(root, 'node_modules', 'junk.js'), 'x');
  await fs.writeFile(path.join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
  // A secret one level up, to prove traversal can't reach it.
  await fs.writeFile(path.join(root, '..', path.basename(root) + '-OUTSIDE.txt'), 'NOPE');
  return root;
}

// ── Sandbox: escape attempts are refused ────────────────────────────

test('readOwnFile: rejects ../ traversal', async () => {
  const root = await makeRoot();
  const r = await readOwnFile('../' + path.basename(root) + '-OUTSIDE.txt', { root });
  assert.equal(r.ok, false);
  assert.match(r.error, /outside my own folder/);
});

test('readOwnFile: rejects absolute paths', async () => {
  const root = await makeRoot();
  const r = await readOwnFile('/etc/passwd', { root });
  assert.equal(r.ok, false);
  assert.match(r.error, /outside my own folder/);
});

test('readOwnFile: nested ../../ escape is refused', async () => {
  const root = await makeRoot();
  const r = await readOwnFile('tomes/../../secret', { root });
  assert.equal(r.ok, false);
  assert.match(r.error, /outside my own folder/);
});

// ── Denylist: secrets + noise are never served ──────────────────────

test('readOwnFile: settings.json is denied (holds keys)', async () => {
  const root = await makeRoot();
  const r = await readOwnFile('settings.json', { root });
  assert.equal(r.ok, false);
  assert.match(r.error, /off-limits/);
});

test('readOwnFile: .env is denied', async () => {
  const root = await makeRoot();
  const r = await readOwnFile('.env', { root });
  assert.equal(r.ok, false);
});

test('listOwnFiles: omits node_modules, .git, and the secret files', async () => {
  const root = await makeRoot();
  const r = await listOwnFiles('.', { root });
  assert.equal(r.ok, true);
  const names = r.entries.map(e => e.name);
  assert.ok(names.includes('tomes'), 'real folders show');
  assert.ok(names.includes('README.md'), 'real files show');
  assert.ok(!names.includes('node_modules'), 'node_modules hidden');
  assert.ok(!names.includes('.git'), '.git hidden');
  assert.ok(!names.includes('settings.json'), 'settings.json hidden');
  assert.ok(!names.includes('.env'), '.env hidden');
});

test('listOwnFiles: cannot list inside a denied folder', async () => {
  const root = await makeRoot();
  const r = await listOwnFiles('node_modules', { root });
  assert.equal(r.ok, false);
  assert.match(r.error, /off-limits/);
});

// ── Happy path ──────────────────────────────────────────────────────

test('readOwnFile: reads a real text file', async () => {
  const root = await makeRoot();
  const r = await readOwnFile('tomes/ponderings.json', { root });
  assert.equal(r.ok, true);
  assert.equal(r.content, '{"a":1}');
  assert.equal(r.truncated, false);
});

test('readOwnFile: refuses binary files', async () => {
  const root = await makeRoot();
  const r = await readOwnFile('bin.dat', { root });
  assert.equal(r.ok, false);
  assert.match(r.error, /binary/);
});

test('readOwnFile: caps size and flags truncation', async () => {
  const root = await makeRoot();
  await fs.writeFile(path.join(root, 'big.txt'), 'x'.repeat(5000));
  const r = await readOwnFile('big.txt', { root, maxBytes: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.content.length, 1000);
  assert.equal(r.truncated, true);
});

test('listOwnFiles: directories sort before files', async () => {
  const root = await makeRoot();
  const r = await listOwnFiles('.', { root });
  const firstFileIdx = r.entries.findIndex(e => e.type === 'file');
  const lastDirIdx = r.entries.map(e => e.type).lastIndexOf('dir');
  assert.ok(lastDirIdx < firstFileIdx, 'all dirs come before files');
});
