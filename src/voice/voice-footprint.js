/**
 * Footprint measurement + the free-space pre-flight check (voice spec §0.7).
 *
 * Disk is an accessibility constraint here, not a housekeeping detail. The
 * wards this project is for are disproportionately people whose disabilities
 * make holding a job hard; the machine is a cheap or hand-me-down laptop with
 * a small SSD that is already mostly full, and "free up 3 GB first" is not a
 * step they can be assumed to complete. So:
 *
 *   - Before any fetch, we check whether it actually fits and refuse honestly
 *     if it does not. A failed half-download on a full disk is the worst
 *     outcome for exactly the ward this protects.
 *   - Everything on disk is measurable and shown, so nothing is discovered as
 *     a symptom.
 *
 * ── The line this module must never blur ─────────────────────────────────
 * Two categories, and only one of them is ever reclaimable:
 *
 *   MACHINE   Re-fetchable. Audio models, embedder weights, caches. Deleting
 *             one costs a future download and nothing else.
 *   SELF      Memories, graph, tomes, identity, session logs, kept media.
 *             These are the Familiar's continuity with their human. They are
 *             SHOWN so nothing is hidden, and they are never reclaimable from
 *             here — reduction routes through the curation surfaces that
 *             already exist (§9's retention pass, consolidation). Nothing in
 *             this module may delete a memory to save space.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const MB = 1024 * 1024;

/**
 * Free space that must REMAIN after a download completes. Below roughly this
 * much, both Windows and Linux start behaving badly (paging, temp files,
 * atomic writes failing) — and an app that bricked the ward's laptop to
 * install a voice would be an unforgivable trade.
 */
export const RESERVE_BYTES = 256 * MB;

/**
 * Categories, in the order the Storage view lists them. `reclaimable` is what
 * gates whether a delete affordance is offered at all.
 */
export const FOOTPRINT_CATEGORIES = Object.freeze([
  { key: 'audio-models', kind: 'machine', reclaimable: true, dir: 'models/audio',
    label: 'Voice models', note: 'Re-fetchable. Deleting these means a download next time voice is used.' },
  { key: 'node-modules', kind: 'machine', reclaimable: false, dir: 'node_modules',
    label: 'App dependencies', note: 'Reinstalled by the updater, not from here.' },
  { key: 'phylactery-venv', kind: 'machine', reclaimable: false, dir: 'phylactery/.venv',
    label: 'Memory service runtime', note: 'Includes the embedder weights. Rebuilt by the installer, not from here.' },
  { key: 'unruh-venv', kind: 'machine', reclaimable: false, dir: 'unruh/.venv',
    label: 'Schedule service runtime', note: 'Rebuilt by the installer, not from here.' },
  { key: 'media', kind: 'self', reclaimable: false, dir: 'media',
    label: 'Pictures and audio shared with me', note: 'Curated by the retention pass, never swept for space.' },
  { key: 'tomes', kind: 'self', reclaimable: false, dir: 'tomes',
    label: 'Tomes and runtime state', note: 'Mine. Not a cache.' },
  { key: 'logs', kind: 'self', reclaimable: false, dir: 'logs',
    label: 'Session logs and event records', note: 'Mine. Not a cache.' },
  { key: 'phylactery-store', kind: 'self', reclaimable: false, dir: 'phylactery/data',
    label: 'Memory, identity, graph', note: 'Mine. Bounded by consolidation, never by disk pressure.' },
  { key: 'unruh-store', kind: 'self', reclaimable: false, dir: 'unruh/data',
    label: 'Schedule and temporal state', note: 'Mine. Not a cache.' },
]);

/**
 * Recursive directory size. Never throws: a missing directory is 0 (the
 * feature simply is not installed), an unreadable one is reported as partial
 * rather than failing the whole measurement.
 *
 * Bounded by `maxEntries` so a pathological tree cannot hang a ward-facing
 * button. Symlinks are counted by their own size, not followed — otherwise a
 * loop or a link into a huge tree would double-count or never terminate.
 */
export async function dirSize(dir, { maxEntries = 200_000 } = {}) {
  let bytes = 0;
  let files = 0;
  let partial = false;
  let seen = 0;

  const walk = async (d) => {
    if (seen >= maxEntries) { partial = true; return; }
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      partial = true;
      return;
    }
    for (const e of entries) {
      if (seen >= maxEntries) { partial = true; return; }
      seen++;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else {
        try {
          const st = await fs.lstat(full);
          bytes += st.size;
          files++;
        } catch {
          partial = true;
        }
      }
    }
  };

  try {
    await fs.access(dir);
  } catch {
    return { bytes: 0, files: 0, exists: false, partial: false };
  }
  await walk(dir);
  return { bytes, files, exists: true, partial };
}

/**
 * Bytes a directory tree ACTUALLY occupies, counting each inode once.
 *
 * `dirSize` sums every file it sees, which is the right answer for "how big is
 * this tree". It is the wrong answer for "how much disk would deleting it
 * free", because the model store is deliberately full of hardlinks: a blob and
 * its link in a model directory are one set of bytes with two names. Summing
 * both double-counts, and reporting that to my human as reclaimed space would
 * be a straightforwardly false number.
 *
 * Falls back to counting a file normally when identity is unavailable (some
 * filesystems report ino 0), which over-counts rather than under-counts —
 * the safer direction for a figure someone is deciding on.
 */
export async function uniqueSize(dir, { maxEntries = 200_000 } = {}) {
  const seen = new Set();
  let bytes = 0;
  let seenCount = 0;
  let partial = false;

  const walk = async (d) => {
    if (seenCount >= maxEntries) { partial = true; return; }
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { partial = true; return; }
    for (const e of entries) {
      if (seenCount >= maxEntries) { partial = true; return; }
      seenCount++;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      try {
        const st = await fs.lstat(full);
        const id = st.ino ? `${st.dev}:${st.ino}` : null;
        if (id) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        bytes += st.size;
      } catch { partial = true; }
    }
  };

  try { await fs.access(dir); } catch { return { bytes: 0, partial: false }; }
  await walk(dir);
  return { bytes, partial };
}

/**
 * Free and total bytes on the volume holding `target`. Walks up to the
 * nearest existing ancestor, because the pre-flight check runs BEFORE the
 * models directory exists.
 */
export async function volumeSpace(target) {
  let probe = path.resolve(target);
  for (let i = 0; i < 40; i++) {
    try {
      const st = await fs.statfs(probe);
      // bavail is what an unprivileged process may actually use; bfree
      // includes root-reserved blocks it cannot touch.
      return {
        ok: true,
        freeBytes: st.bsize * st.bavail,
        totalBytes: st.bsize * st.blocks,
        path: probe,
      };
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return { ok: false, freeBytes: null, totalBytes: null, path: null };
}

/**
 * The §0.7 pre-flight check. Answers one question honestly: if we start this
 * download, does the machine survive it?
 *
 * Returns a decision, never throws, and NEVER fails open — if free space
 * cannot be read at all, that is `ok: false` with reason `unknown-space`.
 * Refusing a download the ward could have afforded costs them an annoyance;
 * filling their disk costs them their laptop.
 *
 * The margin model is a floor that must REMAIN free afterwards, not a
 * percentage of the download — a 40 MB voice and a 250 MB one endanger the
 * same machine equally when it is already nearly full.
 */
export function preflightDecision({ needBytes, freeBytes, reserveBytes = RESERVE_BYTES, estimated = false }) {
  if (!Number.isFinite(freeBytes)) {
    return {
      ok: false, reason: 'unknown-space', needBytes, freeBytes: null, reserveBytes,
      remainingAfter: null, estimated,
      message: "I couldn't read how much space is free on this drive, so I'm not going to start a download I can't promise will fit.",
    };
  }
  if (!Number.isFinite(needBytes) || needBytes < 0) {
    return {
      ok: false, reason: 'unknown-size', needBytes: null, freeBytes, reserveBytes,
      remainingAfter: null, estimated,
      message: "I couldn't work out how large this download is, so I'm not going to start it.",
    };
  }

  const remainingAfter = freeBytes - needBytes;
  if (remainingAfter < 0) {
    return {
      ok: false, reason: 'insufficient-space', needBytes, freeBytes, reserveBytes, remainingAfter, estimated,
      message: 'There is not enough free space on this drive for this download.',
    };
  }
  if (remainingAfter < reserveBytes) {
    return {
      ok: false, reason: 'below-reserve', needBytes, freeBytes, reserveBytes, remainingAfter, estimated,
      message: 'This would fit, but it would leave the drive too full for the machine to work comfortably.',
    };
  }
  return {
    ok: true, reason: 'fits', needBytes, freeBytes, reserveBytes, remainingAfter, estimated,
    message: null,
  };
}

/**
 * The full pre-flight: read the volume, decide.
 *
 * `estimated` rides through from `planSize()` so the ward-facing refusal can
 * say "about" when the figure is an estimate — and so a refusal that rests on
 * an estimate is legible as such rather than presented as measurement.
 */
export async function preflight({ needBytes, targetDir, reserveBytes = RESERVE_BYTES, estimated = false }) {
  const space = await volumeSpace(targetDir);
  const decision = preflightDecision({ needBytes, freeBytes: space.ok ? space.freeBytes : null, reserveBytes, estimated });
  return { ...decision, volume: space };
}

/**
 * Measure everything, for the Storage view and for the Pass 0 bench report.
 * Categories are measured independently so one unreadable directory degrades
 * to a partial figure instead of losing the whole picture.
 */
export async function measureFootprint(rootDir, { categories = FOOTPRINT_CATEGORIES } = {}) {
  const items = [];
  for (const cat of categories) {
    const full = path.join(rootDir, cat.dir);
    const size = await dirSize(full);
    items.push({
      key: cat.key, label: cat.label, kind: cat.kind, reclaimable: cat.reclaimable,
      note: cat.note, dir: cat.dir,
      bytes: size.bytes, files: size.files, exists: size.exists, partial: size.partial,
    });
  }
  const machineBytes = items.filter((i) => i.kind === 'machine').reduce((a, i) => a + i.bytes, 0);
  const selfBytes = items.filter((i) => i.kind === 'self').reduce((a, i) => a + i.bytes, 0);
  const reclaimableBytes = items.filter((i) => i.reclaimable).reduce((a, i) => a + i.bytes, 0);
  const space = await volumeSpace(rootDir);

  return {
    items,
    totals: {
      machineBytes,
      selfBytes,
      totalBytes: machineBytes + selfBytes,
      reclaimableBytes,
    },
    volume: space,
    partial: items.some((i) => i.partial),
  };
}
