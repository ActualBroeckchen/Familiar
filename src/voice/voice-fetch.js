/**
 * Audio model fetcher (voice spec §0.1, §0.7).
 *
 * The module; `scripts/ensure-audio-models.mjs` is a thin CLI over it and the
 * bench endpoint calls it directly. One implementation, so the pre-flight
 * check and the checksum discipline cannot be true on one path and skipped on
 * another.
 *
 * Four properties this must hold, in priority order:
 *
 *   1. NOTHING UNVERIFIED IS INSTALLED. Every file is hashed while it streams
 *      and compared to the pinned sha256 before it is allowed anywhere near
 *      the models directory. A mismatch deletes the download. An unpinned
 *      model is refused outright — "download and hope" is not a smaller risk
 *      than not downloading, it is a silent one.
 *   2. IT FITS BEFORE IT STARTS. The §0.7 pre-flight runs first. A failed
 *      half-download on a nearly-full disk is the worst outcome for exactly
 *      the ward this is for.
 *   3. FAILURE LEAVES NOTHING BEHIND. Downloads land in a temp file and are
 *      renamed into place only after verification; any failure removes the
 *      partial. Voice stays cleanly off rather than half-installed.
 *   4. BYTES ARE STORED ONCE. Files are content-addressed by their hash, and
 *      the per-model directory holds hardlinks into that store — so switching
 *      voice tiers never duplicates a shared vocoder, and a re-fetch of an
 *      already-held blob costs nothing (§0.7 rule 5).
 *
 * Nothing here throws at the caller. Every path returns a structured result,
 * because this runs behind a ward-facing button and behind the runtime's
 * first-enable, and neither may surface a stack trace.
 */

import { promises as fs, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import { isPinned, planSize, describePlanForConsent } from './voice-models.js';
import { preflight, uniqueSize } from './voice-footprint.js';
import { isArchive, extractArchive, writeMarker, isExtractedFrom } from './voice-extract.js';

/** Where the bytes live, relative to the app root. Git-ignored; no model ships in the repo. */
export const MODELS_SUBDIR = path.join('models', 'audio');
const BLOBS = 'blobs';
const TMP = '.tmp';

const isSha256 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

export function blobPath(modelsDir, sha256) {
  // Two-char shard keeps the directory listing sane on filesystems that care.
  return path.join(modelsDir, BLOBS, sha256.slice(0, 2), sha256);
}

export function installedPath(modelsDir, modelId, fileName) {
  return path.join(modelsDir, modelId, fileName);
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function sizeOf(p) {
  try { return (await fs.stat(p)).size; } catch { return null; }
}

/**
 * mkdir that reports instead of throwing.
 *
 * Every filesystem call on this path has to be guarded, not just the ones that
 * look risky: `mkdir` fails on a full disk, a read-only volume, a permission
 * change, or a parent that turned out to be a file. This module promises the
 * caller a structured result — a ward-facing button must never surface a stack
 * trace — and an unguarded `await` is a hole in that promise regardless of how
 * unlikely it looks.
 */
async function mkdirp(dir) {
  try { await fs.mkdir(dir, { recursive: true }); return true; } catch { return false; }
}

/**
 * Hash a file that is already on disk. Used to re-verify a blob we think we
 * hold — cheap insurance against a truncated or corrupted store, and the only
 * way "already installed" can be an honest claim rather than a filename check.
 */
export async function hashFile(filePath) {
  try {
    const h = createHash('sha256');
    const fh = await fs.open(filePath, 'r');
    try {
      const stream = fh.createReadStream();
      for await (const chunk of stream) h.update(chunk);
    } finally {
      await fh.close();
    }
    return h.digest('hex');
  } catch {
    return null;
  }
}

/**
 * Put a verified blob where the loader will find it.
 *
 * Two shapes, because upstream ships both:
 *   - An ARCHIVE is unpacked into the model's directory and stamped with a
 *     marker naming the archive it came from. Extraction runs only on bytes
 *     already checked against the pin (see `voice-extract.js`).
 *   - A PLAIN FILE is hardlinked (no duplicate bytes); a copy is the fallback
 *     when the filesystem refuses, which some Windows setups and any
 *     cross-device layout will. A copy is a worse outcome, never a failure.
 */
async function materialize(blob, dest, { fileName, sha256, modelDir }) {
  if (isArchive(fileName)) {
    if (await isExtractedFrom(modelDir, sha256)) return { how: 'already-extracted', bytes: null };
    const out = await extractArchive({ archivePath: blob, destDir: modelDir, name: fileName });
    if (!out.ok) return { how: null, failed: out.reason, detail: out.detail };
    // The marker is what makes an unpacked directory RECOGNISABLE as installed
    // (`isExtractedFrom`). Without it the files are on disk but every future
    // check reports the model missing and re-extracts it. So a marker we could
    // not write is an install that did not happen, and it says so.
    const marked = await writeMarker(modelDir, { sha256, archiveName: fileName, files: out.files, bytes: out.bytes });
    if (!marked) return { how: null, failed: 'io', detail: 'unpacked, but the record of which archive produced it could not be written' };
    return { how: 'extracted', bytes: out.bytes, fileCount: out.fileCount };
  }

  if (!await mkdirp(path.dirname(dest))) {
    return { how: null, failed: 'io', detail: `could not create ${path.dirname(dest)}` };
  }
  try { await fs.unlink(dest); } catch { /* not there; fine */ }
  try {
    await fs.link(blob, dest);
    return { how: 'link' };
  } catch {
    // Hardlink refused (cross-device, or a Windows setup that disallows it).
    // A copy is a worse outcome, never a failure — but it can fail too.
    try {
      await fs.copyFile(blob, dest);
      return { how: 'copy' };
    } catch (err) {
      return { how: null, failed: 'io', detail: String(err?.message ?? err) };
    }
  }
}

/**
 * Download one file, hashing as it streams, into a temp path. Returns the
 * digest actually received — the caller compares. This function never decides
 * whether the file is acceptable; it only reports what arrived.
 */
async function downloadToTemp({ url, tmpPath, expectedBytes, onProgress, signal }) {
  if (!await mkdirp(path.dirname(tmpPath))) {
    return { ok: false, reason: 'io', detail: `could not create ${path.dirname(tmpPath)}` };
  }
  let res;
  try {
    res = await fetch(url, { signal, redirect: 'follow' });
  } catch (err) {
    return { ok: false, reason: 'network', detail: String(err?.message ?? err) };
  }
  if (!res.ok || !res.body) {
    return { ok: false, reason: 'http', detail: `HTTP ${res.status}` };
  }

  const declared = Number(res.headers.get('content-length'));
  const total = Number.isFinite(declared) && declared > 0 ? declared : (expectedBytes ?? null);

  const h = createHash('sha256');
  let received = 0;
  let lastTick = 0;

  const counting = async function* (source) {
    for await (const chunk of source) {
      h.update(chunk);
      received += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastTick > 250) {
        lastTick = now;
        onProgress({ receivedBytes: received, totalBytes: total });
      }
      yield chunk;
    }
  };

  try {
    await pipeline(Readable.fromWeb(res.body), counting, createWriteStream(tmpPath));
  } catch (err) {
    try { await fs.unlink(tmpPath); } catch { /* nothing to clean */ }
    return { ok: false, reason: signal?.aborted ? 'cancelled' : 'transfer', detail: String(err?.message ?? err) };
  }

  if (onProgress) onProgress({ receivedBytes: received, totalBytes: total ?? received });
  return { ok: true, sha256: h.digest('hex'), bytes: received };
}

/**
 * What of this plan is already correctly installed?
 *
 * `deep: true` re-hashes each blob rather than trusting its presence. The
 * bench and first-enable use the cheap check; a "something is wrong with my
 * voice" diagnostic uses the deep one.
 */
export async function inspectInstalled({ plan, modelsDir, deep = false }) {
  const out = [];
  for (const model of plan?.all ?? []) {
    const files = [];
    for (const f of model.files ?? []) {
      if (!isSha256(f.sha256)) {
        files.push({ name: f.name, state: 'unpinned' });
        continue;
      }
      const blob = blobPath(modelsDir, f.sha256);
      const dest = installedPath(modelsDir, model.id, f.name);
      const haveBlob = await exists(blob);
      // An archive counts as installed only when the model directory was
      // unpacked from THIS pin — a directory left by an older pin would
      // otherwise pass a mere existence check.
      const haveDest = isArchive(f.name)
        ? await isExtractedFrom(path.join(modelsDir, model.id), f.sha256)
        : await exists(dest);
      let state = haveBlob && haveDest ? 'present' : haveBlob ? 'blob-only' : 'missing';
      if (state !== 'missing' && deep) {
        const got = await hashFile(blob);
        if (got !== f.sha256) state = 'corrupt';
      }
      files.push({ name: f.name, state, bytes: await sizeOf(blob) });
    }
    const complete = files.length > 0 && files.every((f) => f.state === 'present');
    out.push({ id: model.id, label: model.label, complete, pinned: isPinned(model), files });
  }
  return { models: out, allComplete: out.length > 0 && out.every((m) => m.complete) };
}

/**
 * How many bytes this plan still needs to pull, given what is already held.
 * This is what the pre-flight check is asked about — not the plan's full
 * size, because a ward switching from listening to listening-plus should not
 * be refused for space they already spent.
 */
export async function outstandingBytes({ plan, modelsDir }) {
  let bytes = 0;
  let peakBytes = 0;
  let estimated = false;
  for (const model of plan?.all ?? []) {
    if (!isPinned(model)) {
      // Not fetchable at all — count its estimate so the ward-facing figure
      // still describes the whole plan honestly.
      const est = Number.isFinite(model.estBytes) ? model.estBytes : 0;
      bytes += est;
      peakBytes += est;
      estimated = true;
      continue;
    }
    for (const f of model.files) {
      if (await exists(blobPath(modelsDir, f.sha256))) continue;
      if (Number.isFinite(f.bytes)) {
        bytes += f.bytes;
        // PEAK, not steady state: an archive and its unpacked contents both
        // exist on disk during install. Sizing only the download would let a
        // fetch start that cannot finish — the exact failure the pre-flight
        // exists to prevent, on the exact machines it exists to protect.
        const archive = isArchive(f.name);
        const disk = Number.isFinite(f.diskBytes) ? f.diskBytes : f.bytes;
        peakBytes += archive ? f.bytes + disk : disk;
        // A plain file's disk size IS its download size — nothing is unpacked,
        // so nothing is being estimated. Only an archive whose unpacked size
        // was never measured leaves the figure uncertain.
        if (archive && !Number.isFinite(f.diskBytes)) estimated = true;
      } else {
        const est = Number.isFinite(model.estBytes) ? model.estBytes : 0;
        bytes += est; peakBytes += est; estimated = true;
      }
    }
  }
  return { bytes, peakBytes, estimated };
}

/**
 * Fetch everything a plan needs.
 *
 * Order matters and is the point:
 *   refuse unpinned → size what is outstanding → pre-flight → download →
 *   verify → materialize.
 *
 * `onProgress` receives staged updates suitable for a ward-facing progress
 * line ("downloading Silero VAD, 2 of 3…"), never raw internals.
 */
export async function fetchPlan({
  plan,
  modelsDir,
  onProgress = null,
  signal = null,
  reserveBytes = undefined,
  allowUnpinned = false,
} = {}) {
  const report = (evt) => { try { onProgress?.(evt); } catch { /* a progress sink must never break a download */ } };

  const models = plan?.all ?? [];
  if (models.length === 0) {
    return { ok: false, reason: 'empty-plan', installed: [], failed: [], message: 'There is nothing to download for this plan.' };
  }

  // 1. Refuse unpinned. This is the checksum discipline, and it fails closed.
  const unpinned = models.filter((m) => !isPinned(m));
  if (unpinned.length > 0 && !allowUnpinned) {
    return {
      ok: false,
      reason: 'unpinned',
      unpinned: unpinned.map((m) => ({ id: m.id, label: m.label })),
      installed: [], failed: [],
      message: `I don't have verified download details for ${unpinned.map((m) => m.label).join(', ')} yet, so I'm not going to fetch them. Run the pinning script first.`,
    };
  }
  const fetchable = models.filter((m) => isPinned(m));

  // 2 + 3. Size what is actually outstanding, then check it fits.
  const need = await outstandingBytes({ plan: { all: fetchable }, modelsDir });
  const pre = await preflight({ needBytes: need.peakBytes, targetDir: modelsDir, reserveBytes, estimated: need.estimated });
  if (!pre.ok) {
    return { ok: false, reason: pre.reason, preflight: pre, installed: [], failed: [], message: pre.message };
  }
  report({ phase: 'preflight', ok: true, needBytes: need.bytes, freeBytes: pre.freeBytes });

  // 4-6. Download, verify, materialize — one file at a time. Serial on
  // purpose: parallel downloads on a thin connection finish later and make
  // the progress line unreadable, and the pre-flight sized one at a time.
  const installed = [];
  const failed = [];
  const totalFiles = fetchable.reduce((a, m) => a + m.files.length, 0);
  let fileIndex = 0;

  for (const model of fetchable) {
    for (const f of model.files) {
      fileIndex++;
      if (signal?.aborted) {
        return { ok: false, reason: 'cancelled', installed, failed, message: 'Download cancelled.' };
      }

      const blob = blobPath(modelsDir, f.sha256);
      const dest = installedPath(modelsDir, model.id, f.name);

      if (await exists(blob)) {
        const put = await materialize(blob, dest, { fileName: f.name, sha256: f.sha256, modelDir: path.join(modelsDir, model.id) });
        if (put.failed) {
          failed.push({ id: model.id, file: f.name, reason: put.failed, detail: put.detail });
          return { ok: false, reason: put.failed, installed, failed,
            message: `I downloaded ${model.label} but couldn't unpack it (${put.failed}). Nothing was installed from it.` };
        }
        installed.push({ id: model.id, file: f.name, reused: true, linked: put.how, extractedBytes: put.bytes ?? null });
        report({ phase: 'reused', modelId: model.id, label: model.label, file: f.name, index: fileIndex, total: totalFiles });
        continue;
      }

      report({ phase: 'download', modelId: model.id, label: model.label, file: f.name, index: fileIndex, total: totalFiles, receivedBytes: 0, totalBytes: f.bytes ?? null });

      const tmpPath = path.join(modelsDir, TMP, `${f.sha256}.part`);
      const got = await downloadToTemp({
        url: f.url,
        tmpPath,
        expectedBytes: f.bytes,
        signal,
        onProgress: ({ receivedBytes, totalBytes }) =>
          report({ phase: 'download', modelId: model.id, label: model.label, file: f.name, index: fileIndex, total: totalFiles, receivedBytes, totalBytes }),
      });

      if (!got.ok) {
        failed.push({ id: model.id, file: f.name, reason: got.reason, detail: got.detail });
        return {
          ok: false, reason: got.reason, installed, failed,
          message: got.reason === 'cancelled'
            ? 'Download cancelled.'
            : got.reason === 'io'
              ? `I couldn't write to disk while fetching ${model.label}. Nothing was installed from it.`
              : `The download for ${model.label} didn't complete (${got.reason}). Nothing was installed from it.`,
        };
      }

      if (got.sha256 !== f.sha256) {
        try { await fs.unlink(tmpPath); } catch { /* already gone */ }
        failed.push({ id: model.id, file: f.name, reason: 'checksum', expected: f.sha256, got: got.sha256 });
        return {
          ok: false, reason: 'checksum', installed, failed,
          message: `What downloaded for ${model.label} isn't what I expected it to be, so I deleted it. I won't install a file I can't verify.`,
        };
      }

      if (!await mkdirp(path.dirname(blob))) {
        try { await fs.unlink(tmpPath); } catch { /* already gone */ }
        failed.push({ id: model.id, file: f.name, reason: 'io', detail: `could not create ${path.dirname(blob)}` });
        return { ok: false, reason: 'io', installed, failed, message: `I couldn't make room on disk for ${model.label}.` };
      }
      try {
        await fs.rename(tmpPath, blob);
      } catch (err) {
        try { await fs.unlink(tmpPath); } catch { /* already gone */ }
        failed.push({ id: model.id, file: f.name, reason: 'install', detail: String(err?.message ?? err) });
        return { ok: false, reason: 'install', installed, failed, message: `I couldn't move ${model.label} into place.` };
      }

      report({ phase: 'unpacking', modelId: model.id, label: model.label, file: f.name, index: fileIndex, total: totalFiles });
      const put = await materialize(blob, dest, { fileName: f.name, sha256: f.sha256, modelDir: path.join(modelsDir, model.id) });
      if (put.failed) {
        failed.push({ id: model.id, file: f.name, reason: put.failed, detail: put.detail });
        return { ok: false, reason: put.failed, installed, failed,
          message: `I downloaded ${model.label} and verified it, but couldn't unpack it (${put.failed}).` };
      }
      installed.push({ id: model.id, file: f.name, reused: false, linked: put.how, bytes: got.bytes, extractedBytes: put.bytes ?? null });
      report({ phase: 'verified', modelId: model.id, label: model.label, file: f.name, index: fileIndex, total: totalFiles });
    }
  }

  await sweepTemp(modelsDir);
  report({ phase: 'done', installed: installed.length });
  return { ok: true, reason: 'complete', installed, failed, message: null };
}

/** Remove any leftover partials — a crashed process must not leave the disk fuller than it found it. */
export async function sweepTemp(modelsDir) {
  const dir = path.join(modelsDir, TMP);
  let names;
  try { names = await fs.readdir(dir); } catch { return { removed: 0 }; }
  let removed = 0;
  for (const n of names) {
    try { await fs.unlink(path.join(dir, n)); removed++; } catch { /* leave what we can't remove */ }
  }
  return { removed };
}

/**
 * Delete the models a plan holds — the §0.7 Storage-view reclaim, and only
 * ever for machine artifacts. A blob is removed only when no OTHER installed
 * model still points at it, so reclaiming the piper voice cannot take a file
 * PocketTTS is using with it.
 */
export async function reclaimModels({ plan, modelsDir, keepBlobsFor = [] }) {
  const keep = new Set();
  for (const m of keepBlobsFor) for (const f of m.files ?? []) if (isSha256(f.sha256)) keep.add(f.sha256);

  // How much disk this actually frees is MEASURED, not accumulated: the store
  // is full of hardlinks by design, so adding up the things we delete would
  // count one set of bytes twice (a blob and its link in a model directory) or
  // credit us with freeing bytes another model still holds. Measuring the
  // whole store either side, counting each inode once, is the ground truth and
  // is correct for every shape at once — archives, hardlinks, copy fallbacks,
  // and blobs a second model still needs.
  const before = (await uniqueSize(modelsDir)).bytes;
  const removed = [];

  for (const model of plan?.all ?? []) {
    // A model id becomes a directory we delete RECURSIVELY, so it must be one
    // ordinary path segment. Ids come from the manifest today, but a recursive
    // delete keyed on a value that could ever carry `..` is the kind of thing
    // that is only safe until it isn't.
    if (!isSafeSegment(model.id)) continue;

    for (const f of model.files ?? []) {
      if (isSha256(f.sha256) && !keep.has(f.sha256)) {
        try {
          await fs.unlink(blobPath(modelsDir, f.sha256));
          removed.push({ id: model.id, file: f.name });
        } catch { /* already gone */ }
      }
    }

    // Recursive, because an ARCHIVE model unpacks into this directory and
    // leaves no file at `installedPath` at all. The previous `rmdir` removed
    // EMPTY directories only, so for archives — the common case — it silently
    // did nothing and reclaim freed almost none of the disk it reported.
    // (Raised in review.)
    try {
      await fs.rm(path.join(modelsDir, model.id), { recursive: true, force: true });
    } catch { /* leave what we cannot remove; the measurement stays honest */ }
  }

  const after = (await uniqueSize(modelsDir)).bytes;
  return { freedBytes: Math.max(0, before - after), removed };
}

/**
 * A path segment that is exactly one ordinary name — no separators, no
 * traversal.
 *
 * Exported because `voices.js` builds filenames out of catalogue keys and
 * ward-supplied names, and a security predicate that exists in two copies is
 * one that drifts. One definition, one place to correct it.
 */
export function isSafeSegment(name) {
  return typeof name === 'string'
    && name.length > 0
    && name !== '.' && name !== '..'
    && !/[\\/]/.test(name);
}

/** The consent payload a ward-facing surface shows before any of this runs. */
export async function consentSummary({ plan, modelsDir, reserveBytes = undefined }) {
  const described = describePlanForConsent(plan);
  const need = await outstandingBytes({ plan, modelsDir });
  const pre = await preflight({ needBytes: need.peakBytes, targetDir: modelsDir, reserveBytes, estimated: need.estimated });
  const full = planSize(plan.all);
  return {
    ...described,
    outstandingBytes: need.bytes,
    peakBytes: need.peakBytes,
    outstandingEstimated: need.estimated,
    alreadyHeldBytes: Math.max(0, full.bytes - need.bytes),
    preflight: pre,
    canProceed: pre.ok && plan.all.every((m) => isPinned(m)),
  };
}
