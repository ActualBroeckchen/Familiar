/**
 * Archive extraction for fetched audio models (voice spec §0.1).
 *
 * Upstream ships every model as a `.tar.bz2`, so a verified download is an
 * archive nothing can load until it is unpacked. This is that step.
 *
 * ── Verify, THEN unpack ─────────────────────────────────────────────────
 * The order is the whole security argument for choosing archives over loose
 * files. `voice-fetch.js` hashes the archive as it streams and compares it to
 * the pin BEFORE calling anything here. So extraction only ever runs on bytes
 * we have already proven are the bytes we expected — we never unpack
 * something unverified and then decide whether we liked it.
 *
 * ── Path traversal ──────────────────────────────────────────────────────
 * A tar entry may name `../../etc/whatever`. `tar` defends against this by
 * default (it strips leading slashes and refuses `..`), but a defence that
 * lives entirely in someone else's default is a defence that can be turned
 * off by a future option change. So there is an explicit filter here too:
 * every entry path is resolved and required to stay inside the destination.
 * Two independent checks, because the cost of being wrong is arbitrary file
 * write on my human's machine.
 *
 * ── Failure leaves nothing ──────────────────────────────────────────────
 * Extraction goes to a temp sibling and is renamed into place only on
 * success. A half-unpacked model directory that looks installed is worse than
 * no model at all, because the loader would find files and fail confusingly.
 */

import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';

/** Archive kinds we understand, by extension. Anything else is a plain file. */
export function archiveKind(name) {
  const n = String(name ?? '').toLowerCase();
  if (n.endsWith('.tar.bz2') || n.endsWith('.tbz2') || n.endsWith('.tbz')) return 'tar.bz2';
  if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'tar.gz';
  if (n.endsWith('.tar')) return 'tar';
  return null;
}

export const isArchive = (name) => archiveKind(name) !== null;

/**
 * Reject any entry that would land outside the destination.
 *
 * `strip` is applied by tar before this filter sees the path, so the check
 * runs on the path that will actually be written.
 */
export function entryIsSafe(destDir, entryPath) {
  if (typeof entryPath !== 'string' || entryPath.length === 0) return false;
  if (path.isAbsolute(entryPath)) return false;
  if (entryPath.split(/[\\/]/).includes('..')) return false;
  const resolved = path.resolve(destDir, entryPath);
  const root = path.resolve(destDir);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Unpack an archive into `destDir`.
 *
 * `strip` defaults to 1 because every sherpa-onnx archive wraps its contents
 * in a single directory named after the model — keeping it would give paths
 * like `models/audio/asr-streaming-en/sherpa-onnx-streaming-zipformer-en-.../`.
 * Callers that know better can override.
 *
 * Returns what was written, so the caller can record real on-disk size
 * rather than assuming it matches the download.
 */
export async function extractArchive({ archivePath, destDir, strip = 1, onProgress = null, name = null } = {}) {
  // Kind comes from the ORIGINAL filename, not the path on disk. Blobs are
  // content-addressed — `blobs/9e/9e27b78…` carries no extension — so reading
  // the kind off `archivePath` would call every archive a plain file. (Found
  // by running a real fetch; no pure-function test could have surfaced it,
  // because the naming only diverges once the blob store is involved.)
  const kind = archiveKind(name ?? archivePath);
  if (!kind) return { ok: false, reason: 'not-an-archive', files: [], bytes: 0 };

  const tmpDir = `${destDir}.unpacking`;
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  try {
    await fs.mkdir(tmpDir, { recursive: true });
  } catch (err) {
    // Guarded like every other filesystem call here: this runs behind a
    // ward-facing button and must return a result, never throw.
    return { ok: false, reason: 'io', detail: String(err?.message ?? err), files: [], bytes: 0 };
  }

  const written = [];
  let rejected = 0;

  // Load the two pure-JS codecs by hand, so a MISSING dependency is reported as
  // exactly that rather than folded into a generic "extract-failed". `npm
  // install` places both, but a partial or production-pruned install can leave
  // them out — and "I couldn't unpack it" with no reason is undiagnosable from
  // a boot log, which is precisely how this failure first reached my human.
  let tar, makeBz2;
  try {
    tar = await import('tar');
    if (kind === 'tar.bz2') makeBz2 = (await import('unbzip2-stream')).default;
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    return {
      ok: false,
      reason: 'missing-dependency',
      detail: `a decompression dependency could not be loaded (${String(err?.message ?? err)}); reinstall with \`npm install\``,
      files: [], bytes: 0,
    };
  }

  try {
    // ── Why not `stream/promises.pipeline` here ──────────────────────────
    // `unbzip2-stream` is a legacy `through`-based stream. Driven through
    // `pipeline`, tar finishing before the source's trailing record-padding
    // drains gets reported to pipeline as ERR_STREAM_PREMATURE_CLOSE — an
    // environment-sensitive FALSE failure: a fast local disk hides it, a
    // slower machine or one whose antivirus briefly locks a freshly-written
    // file surfaces it as a bogus `extract-failed` with no real cause. So the
    // chain is wired with plain `.pipe()` and settled on tar's OWN completion,
    // with an explicit error handler on every stage so a genuine decode/IO
    // error still rejects. tar decompresses gzip itself; a plain tar and a
    // gzip tar need no decode stage.
    const src = createReadStream(archivePath);
    const bz2 = kind === 'tar.bz2' ? makeBz2() : null;
    const unpack = tar.x({
      cwd: tmpDir,
      strip,
      // Belt: tar's own protections. Braces: our explicit filter below.
      preservePaths: false,
      filter: (entryPath) => {
        const safe = entryIsSafe(tmpDir, entryPath);
        if (!safe) rejected++;
        return safe;
      },
      onReadEntry: (entry) => {
        written.push({ name: entry.path, bytes: entry.size ?? 0 });
        if (onProgress) {
          try { onProgress({ file: entry.path, count: written.length }); } catch { /* a sink must not break extraction */ }
        }
      },
    });

    const stages = bz2 ? [src, bz2, unpack] : [src, unpack];
    await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (err) => {
        if (settled) return;
        settled = true;
        if (err) {
          // Tear every stage down so a mid-stream failure never leaks an open
          // descriptor on the read side; on success the streams have already
          // ended on their own and destroying them could truncate a flush.
          for (const s of stages) { try { s.destroy(); } catch { /* already gone */ } }
          reject(err);
        } else {
          resolve();
        }
      };
      for (const s of stages) s.on('error', settle);
      // Success is tar having consumed the whole archive — NOT the source
      // reaching EOF, which may carry trailing padding tar deliberately drops.
      unpack.on('finish', () => settle());
      unpack.on('close', () => settle());
      let cur = src;
      for (const s of stages.slice(1)) cur = cur.pipe(s);
    });
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, reason: 'extract-failed', detail: String(err?.message ?? err), files: [], bytes: 0 };
  }

  if (written.length === 0) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, reason: 'empty-archive', files: [], bytes: 0, rejected };
  }

  // Only now does the destination become real.
  try {
    await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.dirname(destDir), { recursive: true });
    await fs.rename(tmpDir, destDir);
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, reason: 'install-failed', detail: String(err?.message ?? err), files: [], bytes: 0 };
  }

  const bytes = await dirBytes(destDir);
  return { ok: true, reason: 'extracted', files: written, fileCount: written.length, bytes, rejected };
}

/** Real bytes on disk after unpacking — the figure §0.7's ceilings actually care about. */
async function dirBytes(dir) {
  let total = 0;
  const walk = async (d) => {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else {
        try { total += (await fs.lstat(full)).size; } catch { /* skip what we cannot stat */ }
      }
    }
  };
  await walk(dir);
  return total;
}

/**
 * The marker recording which archive produced a model directory.
 *
 * Without it, "is this model installed?" can only be answered by looking for
 * files and hoping — and a directory left over from a previous pin would pass.
 * With it, the question is "were these files produced by the archive we
 * currently expect?", which is the question that actually matters.
 */
export const MARKER = '.installed.json';

export async function writeMarker(destDir, { sha256, archiveName, files, bytes }) {
  const marker = {
    sha256,
    archive: archiveName,
    fileCount: Array.isArray(files) ? files.length : null,
    bytes,
    extractedAt: new Date().toISOString(),
  };
  try {
    await fs.writeFile(path.join(destDir, MARKER), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    return marker;
  } catch {
    // Returns null rather than throwing. The caller treats a missing marker as
    // a failed install, because files without one are never recognised as
    // installed and would be re-extracted forever.
    return null;
  }
}

export async function readMarker(destDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(destDir, MARKER), 'utf8'));
  } catch {
    return null;
  }
}

/** Is `destDir` the unpacked form of exactly this archive? */
export async function isExtractedFrom(destDir, sha256) {
  const m = await readMarker(destDir);
  return Boolean(m && m.sha256 === sha256);
}
