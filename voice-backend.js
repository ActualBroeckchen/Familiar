/**
 * Which engine does the speaking (voice spec §11).
 *
 * Two workers speak the same framed protocol, and they are not equivalent.
 *
 *   sherpa   audio-worker.mjs, ONNX Runtime. Ships by default: ~22 MB of
 *            binding plus a 194 MB model, no Python. Resets the LM state per
 *            utterance, so a voice drifts at every utterance boundary — which
 *            merging makes rarer and cannot remove.
 *
 *   pocket   voicebox/, Kyutai's own PyTorch implementation. Carries the KV
 *            cache across chunks (`copy_state=False`), so a whole message is
 *            one continuous trajectory with nothing to drift at. Also runs
 *            english_2026-04; the only sherpa export is the older 2026-01.
 *            Costs ~600 MB installed.
 *
 * ── Why pocket is the default, without a hostile download ───────────────
 * pocket is the better engine — it does not drop the tail of a long message
 * the way sherpa's per-utterance reset does — so it is the DEFAULT choice.
 * But 600 MB is a real amount of disk, and pulling it the moment someone
 * types `npm start` would be a hostile surprise on a nearly-full laptop.
 *
 * The reconciliation: the default is pocket, but nothing downloads at boot.
 * A machine with no venv still SPEAKS immediately — the resolver falls back
 * to sherpa (always present) with `fellBackFrom: 'pocket'` attached — and the
 * ~600 MB is fetched the first time voice is actually USED, with visible,
 * cancellable progress. So the good engine is what you get, the built-in one
 * carries you until it arrives, and no one eats the download unasked at boot.
 *
 * ── Listening is NOT governed by this default ───────────────────────────
 * Only SPEAKING honours `voiceTts.backend`. The recogniser is a sherpa model
 * always, resolved explicitly (`listeningWorker`), never through this default
 * — flipping the speaking default to pocket must never route a voice note to
 * a Python process that cannot listen.
 *
 * ── Availability is checked, never assumed ──────────────────────────────
 * Selecting `pocket` on a machine with no venv must not mean silence. The
 * resolver reports what it found and falls back with a reason attached, the
 * same discipline as a voice that is chosen but not downloaded.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const BACKENDS = Object.freeze({
  SHERPA: 'sherpa',
  POCKET: 'pocket',
});

export const DEFAULT_BACKEND = BACKENDS.POCKET;

/** Where the Python peer lives, mirroring phylactery/ and unruh/. */
export const VOICEBOX_SUBDIR = 'voicebox';

/**
 * Measured on Windows/py3.13 before this was built, so the number in the UI is
 * one somebody checked rather than one somebody remembered.
 */
export const POCKET_FOOTPRINT = Object.freeze({
  downloadBytes: 395 * 1024 * 1024,
  installedBytes: 600 * 1024 * 1024,
  parts: Object.freeze([
    { what: 'torch (CPU)', bytes: 122 * 1024 * 1024 },
    { what: 'scipy', bytes: 37 * 1024 * 1024 },
    { what: 'numpy', bytes: 12 * 1024 * 1024 },
    { what: 'model english_2026-04', bytes: 219 * 1024 * 1024 },
  ]),
});

const exists = async (p) => {
  try { await fs.access(p); return true; } catch { return false; }
};

/**
 * A usable root, whatever was passed.
 *
 * A destructuring default only catches `undefined`, so `rootDir: null` reached
 * `path.join` and threw — on the path that decides whether I can speak at all.
 * Absence of a root is not a reason to be silent.
 */
const asRoot = (rootDir) => (typeof rootDir === 'string' && rootDir ? rootDir : process.cwd());

/**
 * The venv interpreter uv creates, per platform.
 *
 * Windows puts it in Scripts/, POSIX in bin/. Both are checked rather than
 * branching on `process.platform`, because a WSL checkout can carry either and
 * guessing wrong reads as "not installed".
 */
export async function voiceboxPython(rootDir = process.cwd()) {
  const venv = path.join(asRoot(rootDir), VOICEBOX_SUBDIR, '.venv');
  for (const rel of [['Scripts', 'python.exe'], ['bin', 'python3'], ['bin', 'python']]) {
    const candidate = path.join(venv, ...rel);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

/**
 * What each backend needs, and whether it is actually there.
 *
 * Never throws: this feeds a status endpoint and a settings pane, and both are
 * places where an exception would read as "voice is broken" rather than "the
 * optional engine is not installed".
 */
export async function inspectBackends(rootDir = process.cwd()) {
  const root = asRoot(rootDir);
  const python = await voiceboxPython(root);
  const worker = path.join(root, VOICEBOX_SUBDIR, 'src', 'voicebox', 'worker.py');
  const hasWorker = await exists(worker);

  return {
    [BACKENDS.SHERPA]: {
      available: true,
      why: 'ships with me; nothing to install',
      installedBytes: null,
      limitation: 'the voice can shift between utterances — the engine restarts its state at each one',
    },
    [BACKENDS.POCKET]: {
      available: Boolean(python && hasWorker),
      why: python && hasWorker
        ? 'ready'
        : !hasWorker
          ? 'voicebox/ is missing from this checkout'
          : 'the Python environment has not been set up — run: uv sync --directory voicebox',
      python,
      footprint: POCKET_FOOTPRINT,
      limitation: null,
    },
  };
}

/**
 * Turn a setting into the process to actually spawn.
 *
 * Returns the shape `createAudioWorker` takes, plus `fellBackFrom` when the
 * choice could not be honoured. Falling back silently would mean a ward who
 * opted into the better engine, paid 600 MB for it, and never learned it was
 * not being used.
 */
export async function resolveBackend({ rootDir = process.cwd(), settings = {} } = {}) {
  const root = asRoot(rootDir);
  const wanted = settings?.voiceTts?.backend ?? DEFAULT_BACKEND;
  const found = await inspectBackends(root);

  const sherpa = {
    backend: BACKENDS.SHERPA,
    command: process.execPath,
    workerScript: path.join(root, 'audio-worker.mjs'),
    fellBackFrom: null,
    reason: null,
  };

  if (wanted !== BACKENDS.POCKET) return sherpa;

  const pocket = found[BACKENDS.POCKET];
  if (!pocket.available) {
    return { ...sherpa, fellBackFrom: BACKENDS.POCKET, reason: pocket.why };
  }

  return {
    backend: BACKENDS.POCKET,
    command: pocket.python,
    workerScript: path.join(root, VOICEBOX_SUBDIR, 'src', 'voicebox', 'worker.py'),
    // The package lives under src/, and the worker is run as a file rather than
    // a module, so the interpreter needs telling where to import from.
    env: { PYTHONPATH: path.join(root, VOICEBOX_SUBDIR, 'src') },
    fellBackFrom: null,
    reason: null,
  };
}
