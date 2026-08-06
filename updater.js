/**
 * updater.js — self-update against the repo/branch this install came from.
 *
 * Two install shapes, one seam:
 *
 *  • GIT checkout (cloned) → everything keys off `origin` + the checked-out
 *    branch, read live from git. `git fetch` + compare + `merge --ff-only`.
 *    Repo-agnostic: a fork tracks the fork, an upstream clone tracks upstream.
 *
 *  • DOWNLOAD (a release archive, no `.git`) → the default macOS/Windows install
 *    path. A download has no git history and no record of where it came from, so
 *    it keys off the `repository` field baked into package.json instead. Update
 *    is download-and-replace: fetch the latest source tarball from GitHub and
 *    lay its files over the install. This needs NO git on the machine — only
 *    `tar`, which ships in the base OS on macOS/Linux and Windows 10+ (git needs
 *    the heavy Xcode tools on macOS, which non-technical users won't have).
 *
 * Both paths NEVER restart the process — new code is live only after a restart.
 * On that restart the launchers (and the prestart hook) run
 * `scripts/ensure-node-deps.mjs`, which reinstalls any npm dependency the
 * update added or changed — so an update that introduces a new package does
 * not leave the ward to run `npm install` by hand. The caller tells the ward
 * to restart. User data is safe by construction: the tarball contains
 * only the repo's tracked files, so gitignored data (settings.json, tomes/,
 * logs/, the Python venvs, node_modules) is never in the source and is never
 * overwritten or deleted.
 *
 * Hard off-switch: PROTO_FAMILIAR_UPDATE_DISABLED=1.
 * Branch override:  PROTO_FAMILIAR_UPDATE_BRANCH=<name> (download mode).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { promises as fsp } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileP = promisify(execFile);

export function updateDisabled() {
  return process.env.PROTO_FAMILIAR_UPDATE_DISABLED === '1';
}

/** Default git runner (repo cwd, no shell → no injection). Tests inject a fake. */
async function defaultGit(args, { timeout = 20000 } = {}) {
  const { stdout } = await execFileP('git', args, { cwd: __dirname, timeout, windowsHide: true });
  return String(stdout).trim();
}

function localVersion() {
  try { return JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || 'unknown'; }
  catch { return 'unknown'; }
}

/** A friendly "owner/repo" from any git remote URL (ssh or https), else the URL. */
export function repoSlug(url) {
  if (!url) return null;
  const m = String(url).match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : String(url);
}

/**
 * Compare two `MAJOR.MINOR.PATCH[-suffix]` versions on their numeric core.
 * Returns 1 if a>b, -1 if a<b, 0 if equal. The `-alpha` suffix is ignored — the
 * numeric version bumps on every change, so the core is the source of truth
 * (and comparing prerelease tags across identical cores isn't meaningful here).
 */
export function cmpVersions(a, b) {
  const core = (v) => String(v ?? '').trim().replace(/^v/, '').split('-')[0]
    .split('.').map(n => parseInt(n, 10) || 0);
  const [a1 = 0, a2 = 0, a3 = 0] = core(a);
  const [b1 = 0, b2 = 0, b3 = 0] = core(b);
  if (a1 !== b1) return a1 > b1 ? 1 : -1;
  if (a2 !== b2) return a2 > b2 ? 1 : -1;
  if (a3 !== b3) return a3 > b3 ? 1 : -1;
  return 0;
}

/**
 * The upstream repo baked into package.json, for a download install that has no
 * git origin to read. Returns { owner, name, repo:"owner/name", branch, url } or
 * null. A fork sets its own `repository` field, so this stays repo-agnostic.
 */
export function packageRepo() {
  let pkg;
  try { pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')); }
  catch { return null; }
  const url = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url;
  const slug = repoSlug(url);
  if (!slug || !slug.includes('/')) return null;
  const [owner, name] = slug.split('/');
  const branch = (process.env.PROTO_FAMILIAR_UPDATE_BRANCH || '').trim()
    || (pkg?.repository && pkg.repository.branch) || 'main';
  return { owner, name, repo: `${owner}/${name}`, branch, url: `https://github.com/${owner}/${name}` };
}

/**
 * What repo/branch/commit/version this install currently is, and HOW it updates.
 * mode:'git' when it's a checkout; mode:'download' when it's a release archive
 * with a package.json repository to fall back to; mode:'none' when neither.
 */
export async function getRepoInfo({ git = defaultGit } = {}) {
  const [origin, branch, commit] = await Promise.all([
    git(['remote', 'get-url', 'origin']).catch(() => null),
    git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null),
    git(['rev-parse', 'HEAD']).catch(() => null),
  ]);
  if (origin && branch && commit) {
    return { mode: 'git', origin, repo: repoSlug(origin), branch, commit, version: localVersion() };
  }
  const pr = packageRepo();
  if (pr) {
    return {
      mode: 'download', origin: pr.url, repo: pr.repo, owner: pr.owner, name: pr.name,
      branch: pr.branch, commit: null, version: localVersion(),
    };
  }
  return { mode: 'none', origin, repo: repoSlug(origin), branch, commit, version: localVersion() };
}

/** GET the version out of the remote branch's package.json (download mode). */
async function fetchRemoteVersion(info, httpFetch) {
  const url = `https://raw.githubusercontent.com/${info.owner}/${info.name}/${info.branch}/package.json`;
  const res = await httpFetch(url, { headers: { 'User-Agent': 'proto-familiar-updater' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} reading remote package.json`);
  const pkg = JSON.parse(await res.text());
  return pkg.version || null;
}

/**
 * Check for a newer version. Returns a status object the UI + Discord render.
 * Never throws — a network/git failure comes back as { ok:false, error } with
 * the current info still populated. Shape is identical across modes so the UI is
 * mode-agnostic (git mode adds remote.commit/subject).
 */
export async function checkForUpdate({ git = defaultGit, fetch: doGitFetch = true, httpFetch = globalThis.fetch } = {}) {
  if (updateDisabled()) return { ok: false, disabled: true, checkedAt: Date.now() };
  const info = await getRepoInfo({ git });
  const base = {
    repo: info.repo, branch: info.branch, mode: info.mode,
    current: { version: info.version, commit: info.commit },
    checkedAt: Date.now(),
  };

  if (info.mode === 'none') {
    return { ...base, ok: false, error: 'not a git checkout, and no repository is set in package.json to update from' };
  }

  // ── Download install: compare versions over HTTPS, no git needed. ──
  if (info.mode === 'download') {
    if (typeof httpFetch !== 'function') {
      return { ...base, ok: false, error: 'this runtime has no fetch — cannot check for updates' };
    }
    try {
      const remoteVersion = await fetchRemoteVersion(info, httpFetch);
      const newer = remoteVersion && cmpVersions(remoteVersion, info.version) > 0;
      return {
        ...base, ok: true, dirty: false,
        remote: { version: remoteVersion, commit: null, subject: null },
        behind: newer ? 1 : 0, updateAvailable: !!newer,
      };
    } catch (e) {
      return { ...base, ok: false, error: `couldn't reach ${info.repo}: ${e?.message ?? e}` };
    }
  }

  // ── Git checkout: fetch origin/<branch> and compare commits. ──
  if (doGitFetch) {
    try { await git(['fetch', '--quiet', 'origin', info.branch], { timeout: 30000 }); }
    catch (e) { return { ...base, ok: false, error: `couldn't reach the remote: ${e?.message ?? e}` }; }
  }
  let remoteCommit = null;
  try { remoteCommit = await git(['rev-parse', `origin/${info.branch}`]); }
  catch { return { ...base, ok: false, error: `no origin/${info.branch} to track` }; }

  let behind = 0;
  try { behind = Number(await git(['rev-list', '--count', `HEAD..origin/${info.branch}`])) || 0; } catch {}
  let dirty = false;
  try { dirty = (await git(['status', '--porcelain'])).length > 0; } catch {}

  let remoteVersion = null, remoteSubject = null;
  if (behind > 0) {
    try { remoteVersion = JSON.parse(await git(['show', `origin/${info.branch}:package.json`])).version || null; } catch {}
    try { remoteSubject = await git(['log', '-1', '--format=%s', `origin/${info.branch}`]); } catch {}
  }
  return {
    ...base, ok: true,
    remote: { version: remoteVersion, commit: remoteCommit, subject: remoteSubject },
    behind, updateAvailable: behind > 0, dirty,
  };
}

/** Download the branch tarball to a temp file and return its path. */
async function downloadTarball(info, httpFetch, tmpDir) {
  const url = `https://codeload.github.com/${info.owner}/${info.name}/tar.gz/refs/heads/${info.branch}`;
  const res = await httpFetch(url, { headers: { 'User-Agent': 'proto-familiar-updater' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading the update archive`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error('the downloaded archive was suspiciously small — aborting');
  const tarPath = path.join(tmpDir, 'update.tar.gz');
  await fsp.writeFile(tarPath, buf);
  return tarPath;
}

/** Extract a .tar.gz with the system `tar`, stripping the top-level dir. */
async function extractTarball(tarPath, destDir) {
  // --strip-components=1 drops GitHub's `owner-repo-<sha>/` wrapper directory so
  // the repo contents land directly in destDir. `tar` is in the base OS on
  // macOS/Linux and Windows 10+ (unlike git), which is why download mode uses it.
  await execFileP('tar', ['-xzf', tarPath, '-C', destDir, '--strip-components=1'], {
    timeout: 120000, windowsHide: true,
  });
}

/**
 * Download-and-replace update for a non-git install. Lays the freshly-downloaded
 * source over the install, overwriting tracked files and adding new ones, never
 * deleting anything — so any local data the archive doesn't contain is untouched.
 * Injectable download/extract for tests.
 */
export async function applyDownloadUpdate(info, {
  httpFetch = globalThis.fetch,
  download = downloadTarball,
  extract = extractTarball,
  installDir = __dirname,
} = {}) {
  if (typeof httpFetch !== 'function') return { ok: false, error: 'this runtime has no fetch — cannot download an update' };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'proto-familiar-update-'));
  try {
    const tarPath = await download(info, httpFetch, tmpDir);
    const extractDir = path.join(tmpDir, 'src');
    await fsp.mkdir(extractDir, { recursive: true });
    try { await extract(tarPath, extractDir); }
    catch (e) { return { ok: false, error: `couldn't unpack the update (is 'tar' available?): ${e?.message ?? e}` }; }

    // Sanity: a real checkout has package.json at its root. If it's missing the
    // archive was junk — refuse rather than smear a broken tree over the install.
    try { await fsp.access(path.join(extractDir, 'package.json')); }
    catch { return { ok: false, error: 'the downloaded archive did not look like a Proto-Familiar checkout — aborting' }; }

    // Copy source → install. force overwrites tracked files that exist in both;
    // files only in the install (gitignored user data — settings, tomes, logs,
    // venvs, node_modules — none of which are in the archive) are left untouched.
    await fsp.cp(extractDir, installDir, { recursive: true, force: true });

    return { ok: true, restartRequired: true, repo: info.repo, branch: info.branch, version: localVersion() };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Apply the latest version. Git checkout → fast-forward (refuses on a dirty
 * tree). Download install → download-and-replace. Returns
 * { ok, version, restartRequired } or { ok:false, error }.
 */
export async function applyUpdate({ git = defaultGit, httpFetch = globalThis.fetch, download, extract } = {}) {
  if (updateDisabled()) return { ok: false, disabled: true };
  const info = await getRepoInfo({ git });

  if (info.mode === 'none') return { ok: false, error: 'not a git checkout, and no repository is set in package.json to update from' };

  if (info.mode === 'download') {
    return applyDownloadUpdate(info, { httpFetch, ...(download ? { download } : {}), ...(extract ? { extract } : {}) });
  }

  // Git checkout: refuse on a dirty tree, then fast-forward.
  try {
    if ((await git(['status', '--porcelain'])).length > 0) {
      return { ok: false, error: 'local changes present — commit or stash them first, then update.' };
    }
  } catch { /* if status fails, the merge --ff-only below will still fail safely */ }
  try {
    await git(['fetch', '--quiet', 'origin', info.branch], { timeout: 30000 });
    await git(['merge', '--ff-only', `origin/${info.branch}`], { timeout: 30000 });
  } catch (e) {
    return { ok: false, error: `update failed (not a fast-forward, or the remote was unreachable): ${e?.message ?? e}` };
  }
  return { ok: true, restartRequired: true, repo: info.repo, branch: info.branch, version: localVersion() };
}
