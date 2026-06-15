// own-files.js
//
// Sandboxed read access to my own folder — the Proto-Familiar checkout.
// This is how I (the Familiar) can look things up on purpose: re-read a
// Tome, scan a session log, check a doc. It is READ-ONLY and fenced:
//
//   - Every path resolves inside the repo root. Anything that escapes
//     (`..`, absolute paths, a symlink pointing out) is refused.
//   - Secrets and noise are denied outright: settings.json (API keys,
//     bot token, contact webhooks), .env files, node_modules, .git, the
//     Python venvs, caches, backups. Reading an API key into my context
//     would be a real harm — so the gate is mechanical, not my judgement.
//   - Reads are size-capped and text-only; binaries report as binary
//     rather than dumping bytes into my context.
//
// The audience gate (ward-private only) lives in cerebellum's executors;
// this module is the pure sandbox so it can be unit-tested in isolation.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This file sits at the repo root, so its dir IS the root.
export const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));

export const MAX_READ_BYTES   = 64 * 1024;
export const MAX_LIST_ENTRIES = 500;

// Path segments that are never traversed or listed — secrets + noise.
const DENY_SEGMENTS = new Set([
  'node_modules', '.git', '.venv', '__pycache__', '.pf-backups',
]);
// Filenames denied wherever they appear — these hold credentials.
const DENY_FILES = [
  /^\.env(\..*)?$/i,                 // .env, .env.local, …
  /^settings\.json$/i,               // API keys, Discord bot token, webhooks
  /^\.proto-familiar-config\.json$/i // tailscale/runtime config
];

function denied(relPath) {
  const parts = String(relPath).split(/[/\\]/).filter(Boolean);
  for (const seg of parts) if (DENY_SEGMENTS.has(seg)) return true;
  const base = parts[parts.length - 1] ?? '';
  return DENY_FILES.some(re => re.test(base));
}

// Resolve a user-supplied relative path inside root, or null if it
// escapes. Uses realpath on the *parent* so a symlink can't tunnel out.
function safeResolve(root, rel) {
  const cleaned = String(rel ?? '').trim();
  // Reject absolute inputs up front; everything is relative to root.
  if (path.isAbsolute(cleaned)) return null;
  const resolved = path.resolve(root, cleaned || '.');
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function relFromRoot(root, abs) {
  const r = path.relative(root, abs);
  return r === '' ? '.' : r;
}

/**
 * List the entries directly under a repo-relative directory.
 * @returns {Promise<{ok:true, dir, entries:Array}|{ok:false,error}>}
 */
export async function listOwnFiles(relDir = '.', { root = REPO_ROOT } = {}) {
  const abs = safeResolve(root, relDir);
  if (abs == null) return { ok: false, error: 'that path is outside my own folder' };
  const rel = relFromRoot(root, abs);
  if (rel !== '.' && denied(rel)) return { ok: false, error: 'that path is off-limits (secrets or build noise)' };

  let dirents;
  try {
    const st = await fs.stat(abs);
    if (!st.isDirectory()) return { ok: false, error: 'that is a file, not a folder — use read_file' };
    dirents = await fs.readdir(abs, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, error: 'no such folder' };
    return { ok: false, error: err.message };
  }

  const entries = [];
  for (const d of dirents) {
    const childRel = rel === '.' ? d.name : `${rel}/${d.name}`;
    if (denied(childRel)) continue;
    const isDir = d.isDirectory();
    let size = null;
    if (!isDir) {
      try { size = (await fs.stat(path.join(abs, d.name))).size; } catch { /* ignore */ }
    }
    entries.push({ name: d.name, path: childRel, type: isDir ? 'dir' : 'file', ...(size != null ? { size } : {}) });
    if (entries.length >= MAX_LIST_ENTRIES) break;
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { ok: true, dir: rel, entries };
}

/**
 * Read a repo-relative text file (size-capped, text-only).
 * @returns {Promise<{ok:true, path, content, truncated}|{ok:false,error}>}
 */
export async function readOwnFile(relPath, { root = REPO_ROOT, maxBytes = MAX_READ_BYTES } = {}) {
  const abs = safeResolve(root, relPath);
  if (abs == null) return { ok: false, error: 'that path is outside my own folder' };
  const rel = relFromRoot(root, abs);
  if (rel === '.' || denied(rel)) return { ok: false, error: 'that file is off-limits (secrets or build noise) or not a file' };

  let buf;
  try {
    const st = await fs.stat(abs);
    if (st.isDirectory()) return { ok: false, error: 'that is a folder — use list_files' };
    const fh = await fs.open(abs, 'r');
    try {
      const len = Math.min(st.size, maxBytes);
      buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, 0);
    } finally { await fh.close(); }
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, error: 'no such file' };
    return { ok: false, error: err.message };
  }

  // Binary guard: a NUL byte in the sampled head means "not text".
  if (buf.includes(0)) return { ok: false, error: 'that looks like a binary file — I only read text' };

  let truncated = false;
  try {
    const fullSize = (await fs.stat(abs)).size;
    truncated = fullSize > buf.length;
  } catch { /* ignore */ }

  return { ok: true, path: rel, content: buf.toString('utf8'), truncated };
}
