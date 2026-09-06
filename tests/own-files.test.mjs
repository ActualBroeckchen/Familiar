import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listOwnFiles, readOwnFile, searchSessions } from '../own-files.js';

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

// ── searchSessions: glance back through past conversations ──────────

async function makeLogsRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-sessions-'));
  await fs.mkdir(path.join(root, 'logs'));
  const write = (name, obj) => fs.writeFile(path.join(root, 'logs', name), JSON.stringify(obj));
  // An older web DM where the ward mentions the dentist.
  await write('s-old.json', {
    sessionId: 's-old', startedAt: '2026-01-01T09:00:00Z', updatedAt: '2026-01-01T09:10:00Z',
    location: { platform: 'web', label: 'Web chat' },
    messages: [
      { id: 'a', role: 'user', content: 'I have a dentist appointment next week', timestamp: '2026-01-01T09:00:00Z' },
      { id: 'b', role: 'assistant', content: 'Noted — want a reminder?', timestamp: '2026-01-01T09:01:00Z' },
    ],
  });
  // A newer group room where someone else also says "dentist".
  await write('s-new.json', {
    sessionId: 's-new', startedAt: '2026-03-02T18:00:00Z', updatedAt: '2026-03-02T18:30:00Z',
    location: { platform: 'discord', kind: 'guild', label: 'Cozy Server #general' },
    messages: [
      { id: 'c', role: 'user', speaker: 'Chen', content: 'my dentist is great', timestamp: '2026-03-02T18:00:00Z' },
    ],
  });
  // A secret file living in logs/ must never surface.
  await fs.writeFile(path.join(root, 'logs', 'settings.json'), '{"apiKey":"dentist SECRET"}');
  // A corrupt log must be skipped, not throw.
  await fs.writeFile(path.join(root, 'logs', 's-bad.json'), '{ this is not json');
  return root;
}

test('searchSessions: finds a term across logs, newest first, with the log path', async () => {
  const root = await makeLogsRoot();
  const r = await searchSessions('dentist', { root });
  assert.equal(r.ok, true);
  // Two real matches (s-new group room + s-old web) — newest first.
  assert.equal(r.hits.length, 2);
  assert.equal(r.hits[0].sessionId, 's-new');
  assert.equal(r.hits[1].sessionId, 's-old');
  // Each hit names where to read next.
  assert.equal(r.hits[0].path, 'logs/s-new.json');
  assert.equal(r.hits[0].locationLabel, 'Cozy Server #general');
});

test('searchSessions: snippet carries the speaker in a group room', async () => {
  const root = await makeLogsRoot();
  const r = await searchSessions('dentist', { root });
  const group = r.hits.find(h => h.sessionId === 's-new');
  assert.equal(group.snippets[0].speaker, 'Chen');
  assert.match(group.snippets[0].text, /dentist/);
});

test('searchSessions: never returns a secret file, and skips corrupt logs', async () => {
  const root = await makeLogsRoot();
  const r = await searchSessions('dentist', { root });
  assert.ok(r.hits.every(h => !h.path.endsWith('settings.json')), 'secret file must never surface');
  // s-bad.json is corrupt — it is silently skipped, the call still succeeds.
  assert.equal(r.ok, true);
});

test('searchSessions: all terms must appear in the same message', async () => {
  const root = await makeLogsRoot();
  // "dentist" is in s-old, "reminder" is in s-old's assistant turn, but never
  // together in one message — so a two-term query requiring both finds nothing.
  const r = await searchSessions('dentist reminder', { root });
  assert.equal(r.ok, true);
  assert.equal(r.hits.length, 0);
});

test('searchSessions: empty query is refused; missing logs dir is empty not an error', async () => {
  const root = await makeLogsRoot();
  const bad = await searchSessions('   ', { root });
  assert.equal(bad.ok, false);
  const noLogs = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-nologs-'));
  const r = await searchSessions('anything', { root: noLogs });
  assert.equal(r.ok, true);
  assert.equal(r.hits.length, 0);
});
