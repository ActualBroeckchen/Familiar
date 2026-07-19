// updater.js — repo/branch-aware self-update. Git is injected so the tests
// exercise the check/apply logic without a real remote.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkForUpdate, applyUpdate, applyDownloadUpdate, cmpVersions, packageRepo, repoSlug, getRepoInfo } from '../updater.js';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

afterEach(() => { delete process.env.PROTO_FAMILIAR_UPDATE_DISABLED; });

// A fake git driven by a response map keyed on the first meaningful args.
function fakeGit(overrides = {}) {
  const calls = [];
  const base = {
    'remote get-url origin': 'git@github.com:ActualBroeckchen/Familiar.git',
    'rev-parse --abbrev-ref HEAD': 'main',
    'rev-parse HEAD': 'aaaaaaa',
    'fetch --quiet origin main': '',
    'rev-parse origin/main': 'aaaaaaa',
    'rev-list --count HEAD..origin/main': '0',
    'status --porcelain': '',
    'merge --ff-only origin/main': 'Fast-forward',
    'show origin/main:package.json': JSON.stringify({ version: '0.9.0-alpha' }),
    'log -1 --format=%s origin/main': 'feat: something new',
  };
  const map = { ...base, ...overrides };
  const git = async (args) => {
    const key = args.join(' ');
    calls.push(key);
    if (key in map) {
      const v = map[key];
      if (v instanceof Error) throw v;
      return v;
    }
    throw new Error(`unexpected git ${key}`);
  };
  git.calls = calls;
  return git;
}

test('repoSlug: ssh + https + trailing slash', () => {
  assert.equal(repoSlug('git@github.com:Owner/Repo.git'), 'Owner/Repo');
  assert.equal(repoSlug('https://github.com/Owner/Repo.git'), 'Owner/Repo');
  assert.equal(repoSlug('https://github.com/Owner/Repo/'), 'Owner/Repo');
  assert.equal(repoSlug(null), null);
});

test('getRepoInfo: reads origin/branch/commit + slug', async () => {
  const info = await getRepoInfo({ git: fakeGit() });
  assert.equal(info.repo, 'ActualBroeckchen/Familiar');
  assert.equal(info.branch, 'main');
  assert.equal(info.commit, 'aaaaaaa');
});

test('checkForUpdate: up to date → no update', async () => {
  const r = await checkForUpdate({ git: fakeGit() });
  assert.equal(r.ok, true);
  assert.equal(r.updateAvailable, false);
  assert.equal(r.behind, 0);
  assert.equal(r.branch, 'main');
});

test('checkForUpdate: behind → update available with remote version + subject', async () => {
  const r = await checkForUpdate({ git: fakeGit({
    'rev-parse origin/main': 'bbbbbbb',
    'rev-list --count HEAD..origin/main': '3',
  }) });
  assert.equal(r.ok, true);
  assert.equal(r.updateAvailable, true);
  assert.equal(r.behind, 3);
  assert.equal(r.remote.version, '0.9.0-alpha');
  assert.match(r.remote.subject, /something new/);
});

test('checkForUpdate: tracks whatever branch is checked out (fork-agnostic)', async () => {
  const git = fakeGit({
    'remote get-url origin': 'https://github.com/SomeFork/Proto-Familiar.git',
    'rev-parse --abbrev-ref HEAD': 'dev',
    'fetch --quiet origin dev': '',
    'rev-parse origin/dev': 'ccccccc',
    'rev-list --count HEAD..origin/dev': '1',
    'show origin/dev:package.json': JSON.stringify({ version: '1.0.0' }),
    'log -1 --format=%s origin/dev': 'fork change',
  });
  const r = await checkForUpdate({ git });
  assert.equal(r.repo, 'SomeFork/Proto-Familiar');
  assert.equal(r.branch, 'dev');
  assert.equal(r.updateAvailable, true);
  assert.equal(r.remote.version, '1.0.0');
});

test('checkForUpdate: fetch failure degrades to ok:false with current info intact', async () => {
  const r = await checkForUpdate({ git: fakeGit({ 'fetch --quiet origin main': new Error('network down') }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /couldn't reach the remote/);
  assert.equal(r.current.version && r.current.commit, r.current.commit); // current still populated
  assert.equal(r.branch, 'main');
});

test('checkForUpdate: off-switch disables', async () => {
  process.env.PROTO_FAMILIAR_UPDATE_DISABLED = '1';
  const r = await checkForUpdate({ git: fakeGit() });
  assert.equal(r.ok, false);
  assert.equal(r.disabled, true);
});

test('applyUpdate: clean tree → fast-forward, reports restart required', async () => {
  const git = fakeGit({ 'rev-list --count HEAD..origin/main': '2' });
  const r = await applyUpdate({ git });
  assert.equal(r.ok, true);
  assert.equal(r.restartRequired, true);
  assert.ok(git.calls.includes('merge --ff-only origin/main'));
});

test('applyUpdate: dirty tree → refuses, never merges', async () => {
  const git = fakeGit({ 'status --porcelain': ' M server.js' });
  const r = await applyUpdate({ git });
  assert.equal(r.ok, false);
  assert.match(r.error, /local changes present/);
  assert.ok(!git.calls.includes('merge --ff-only origin/main'));
});

// ── Download-install path (no .git — the macOS/Windows default) ───────────────

// A git runner that behaves like "no repository here", so getRepoInfo falls back
// to the package.json `repository` field (download mode).
const noGit = async () => { throw new Error('not a git repository'); };

test('cmpVersions compares on the numeric core, ignoring the -alpha suffix', () => {
  assert.equal(cmpVersions('0.9.0-alpha', '0.8.90-alpha'), 1);
  assert.equal(cmpVersions('0.8.90-alpha', '0.9.0-alpha'), -1);
  assert.equal(cmpVersions('1.2.3', '1.2.3-alpha'), 0);
  assert.equal(cmpVersions('0.8.9', '0.8.10'), -1); // numeric, not lexical
});

test('packageRepo reads the repository field baked into package.json', () => {
  const pr = packageRepo();
  assert.ok(pr, 'expected a repository in package.json');
  assert.equal(pr.repo, 'ActualBroeckchen/Familiar');
  assert.equal(pr.branch, 'main');
});

test('getRepoInfo: no git → download mode from package.json', async () => {
  const info = await getRepoInfo({ git: noGit });
  assert.equal(info.mode, 'download');
  assert.equal(info.repo, 'ActualBroeckchen/Familiar');
  assert.equal(info.owner, 'ActualBroeckchen');
  assert.equal(info.name, 'Familiar');
});

test('checkForUpdate download mode: remote newer → update available', async () => {
  const httpFetch = async () => ({ ok: true, text: async () => JSON.stringify({ version: '99.0.0' }) });
  const r = await checkForUpdate({ git: noGit, httpFetch });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'download');
  assert.equal(r.updateAvailable, true);
  assert.equal(r.remote.version, '99.0.0');
  assert.equal(r.dirty, false);
});

test('checkForUpdate download mode: remote same/older → no update', async () => {
  const httpFetch = async () => ({ ok: true, text: async () => JSON.stringify({ version: '0.0.1' }) });
  const r = await checkForUpdate({ git: noGit, httpFetch });
  assert.equal(r.ok, true);
  assert.equal(r.updateAvailable, false);
});

test('checkForUpdate download mode: network failure → ok:false, current intact', async () => {
  const httpFetch = async () => { throw new Error('offline'); };
  const r = await checkForUpdate({ git: noGit, httpFetch });
  assert.equal(r.ok, false);
  assert.match(r.error, /couldn't reach/);
  assert.ok(r.current.version);
});

test('applyDownloadUpdate: lays the archive over the install, keeps user data', async () => {
  // A temp "install" with a pre-existing gitignored user-data file the update
  // must not touch, plus an old code file the update should overwrite.
  const installDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pf-install-'));
  await fsp.writeFile(path.join(installDir, 'settings.json'), '{"userName":"keep me"}');
  await fsp.writeFile(path.join(installDir, 'server.js'), 'OLD');

  // Injected download/extract: the "download" is a no-op path; "extract" writes a
  // fresh checkout (new server.js + a brand-new file + the required package.json).
  const download = async (_info, _fetch, tmpDir) => path.join(tmpDir, 'x.tar.gz');
  const extract = async (_tarPath, destDir) => {
    await fsp.writeFile(path.join(destDir, 'package.json'), JSON.stringify({ version: '99.0.0' }));
    await fsp.writeFile(path.join(destDir, 'server.js'), 'NEW');
    await fsp.writeFile(path.join(destDir, 'brand-new.js'), 'hello');
  };

  const info = { owner: 'o', name: 'n', repo: 'o/n', branch: 'main' };
  const r = await applyDownloadUpdate(info, { httpFetch: async () => ({}), download, extract, installDir });

  assert.equal(r.ok, true);
  assert.equal(r.restartRequired, true);
  assert.equal(await fsp.readFile(path.join(installDir, 'server.js'), 'utf8'), 'NEW');      // overwritten
  assert.equal(await fsp.readFile(path.join(installDir, 'brand-new.js'), 'utf8'), 'hello'); // added
  assert.equal(await fsp.readFile(path.join(installDir, 'settings.json'), 'utf8'), '{"userName":"keep me"}'); // untouched

  await fsp.rm(installDir, { recursive: true, force: true });
});

test('applyDownloadUpdate: junk archive (no package.json) → refuses, no smear', async () => {
  const installDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pf-install-'));
  await fsp.writeFile(path.join(installDir, 'server.js'), 'OLD');
  const download = async (_i, _f, tmpDir) => path.join(tmpDir, 'x.tar.gz');
  const extract = async (_t, destDir) => { await fsp.writeFile(path.join(destDir, 'random.txt'), 'junk'); };
  const r = await applyDownloadUpdate({ owner: 'o', name: 'n', repo: 'o/n', branch: 'main' },
    { httpFetch: async () => ({}), download, extract, installDir });
  assert.equal(r.ok, false);
  assert.match(r.error, /did not look like/);
  assert.equal(await fsp.readFile(path.join(installDir, 'server.js'), 'utf8'), 'OLD'); // not smeared
  await fsp.rm(installDir, { recursive: true, force: true });
});
