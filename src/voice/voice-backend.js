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
import { spawn } from 'node:child_process';

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

  // The package lives under src/, and the worker is run as a file rather than a
  // module, so the interpreter needs telling where to import from.
  const env = { PYTHONPATH: path.join(root, VOICEBOX_SUBDIR, 'src') };
  // pocket-tts bakes temperature into the model at LOAD time (worker.py reads
  // PF_TTS_TEMPERATURE), unlike sherpa which takes it per request. So a ward's
  // chosen expressiveness rides in as env; currentAudioWorker reloads the worker
  // when this changes, which is why changing it takes effect on the next speak.
  const temp = Number(settings?.voiceTts?.temperature);
  if (Number.isFinite(temp) && temp > 0) env.PF_TTS_TEMPERATURE = String(temp);

  return {
    backend: BACKENDS.POCKET,
    command: pocket.python,
    workerScript: path.join(root, VOICEBOX_SUBDIR, 'src', 'voicebox', 'worker.py'),
    env,
    fellBackFrom: null,
    reason: null,
  };
}

// ── Repair the voicebox (Kyutai) environment ──────────────────────────────
// "Fix Kyutai": rebuild the Python venv when it's present but BROKEN — the
// classic symptom being torch's native DLL failing to load (Windows
// "[WinError 126] … c10.dll", a corrupt/partial install left behind by an
// update). inspectBackends only checks the interpreter + worker EXIST, so it
// reads "available" even when torch won't import; this actually verifies it.

function runCmd(cmd, args, { cwd, env, onLog = () => {} } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { cwd, env: { ...process.env, ...(env || {}) }, windowsHide: true }); }
    catch (err) { resolve({ ok: false, detail: `could not start ${cmd}: ${err?.message ?? err}` }); return; }
    let tail = '';
    const grab = (buf) => { const s = String(buf); tail = (tail + s).slice(-4000); s.split(/\r?\n/).forEach((l) => { if (l.trim()) onLog(l.trim()); }); };
    child.stdout?.on('data', grab);
    child.stderr?.on('data', grab);
    child.on('error', (err) => resolve({ ok: false, detail: `${cmd} failed to run: ${err?.message ?? err}` }));
    child.on('close', (code) => resolve(code === 0 ? { ok: true, output: tail } : { ok: false, detail: tail || `${cmd} exited ${code}`, code }));
  });
}

async function haveUv() {
  const r = await runCmd(process.platform === 'win32' ? 'uv.exe' : 'uv', ['--version']);
  return r.ok;
}

/**
 * The MSVC runtime DLLs torch's native libraries (c10.dll and friends) depend
 * on. We copy whichever of these we find; torch only strictly needs the first
 * three, but placing the whole set is harmless and covers future wheels.
 */
const TORCH_MSVC_DLLS = Object.freeze([
  'vcruntime140.dll', 'vcruntime140_1.dll',
  'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll',
  'concrt140.dll', 'vccorlib140.dll',
]);

/**
 * Find the MSVC runtime DLLs somewhere inside the venv.
 *
 * `msvc-runtime` doesn't put them in a stable place across versions — usually
 * next to python.exe (sys.prefix) or in Scripts/, sometimes as package data —
 * so this checks the known spots first, then falls back to a bounded walk of
 * site-packages (skipping torch itself, which is huge and whose own DLLs are
 * not the runtime we're placing).
 * @returns {Promise<Map<string,string>>} lowercase dll name → absolute path
 */
async function findMsvcDlls(venvDir) {
  const wanted = new Set(TORCH_MSVC_DLLS);
  const found = new Map();
  const collect = async (dir) => {
    let entries = [];
    try { entries = await fs.readdir(dir); } catch { return; }
    for (const name of entries) {
      const lower = name.toLowerCase();
      if (wanted.has(lower) && !found.has(lower)) found.set(lower, path.join(dir, name));
    }
  };
  for (const dir of [venvDir, path.join(venvDir, 'Scripts'), path.join(venvDir, 'Lib', 'site-packages')]) {
    await collect(dir);
  }
  if (found.size >= wanted.size) return found;

  const walk = async (dir, depth) => {
    if (depth < 0 || found.size >= wanted.size) return;
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (ent.name.toLowerCase() === 'torch') continue;   // huge, and not the source
        await walk(path.join(dir, ent.name), depth - 1);
      } else {
        const lower = ent.name.toLowerCase();
        if (wanted.has(lower) && !found.has(lower)) found.set(lower, path.join(dir, ent.name));
      }
    }
  };
  await walk(path.join(venvDir, 'Lib', 'site-packages'), 3);
  return found;
}

/**
 * Put the MSVC runtime DLLs where torch actually loads them from.
 *
 * The subtle bug this closes: `msvc-runtime` drops the DLLs beside python.exe
 * (sys.prefix / Scripts), but that is NOT where torch's native loader looks.
 * On Python 3.8+ Windows resolves a DLL's dependencies from the DLL's OWN
 * directory + any os.add_dll_directory() dirs + the system dirs — never
 * sys.prefix, never PATH. torch's c10.dll lives in torch/lib and torch
 * add_dll_directory's exactly that folder, so the runtime is only discoverable
 * if it sits THERE. Copying it in is the step that actually cures WinError 126.
 *
 * Pure file-ops and platform-independent (the Windows-only decision lives in the
 * caller) so the copy is unit-testable off Windows.
 * @returns {Promise<{libDir:string|null, found:string[], copied:string[]}>}
 */
export async function placeMsvcRuntimeBesideTorch({ venvDir, onLog = () => {} } = {}) {
  const libDir = path.join(venvDir, 'Lib', 'site-packages', 'torch', 'lib');
  if (!(await exists(libDir))) return { libDir: null, found: [], copied: [] };

  const dlls = await findMsvcDlls(venvDir);
  const copied = [];
  for (const [name, src] of dlls) {
    const dst = path.join(libDir, name);
    if (await exists(dst)) continue;   // torch shipped its own — leave it be
    try { await fs.copyFile(src, dst); copied.push(name); }
    catch (err) { onLog(`could not place ${name} beside torch: ${err?.message ?? err}`); }
  }
  return { libDir, found: [...dlls.keys()], copied };
}

/**
 * Give torch its Windows runtime, so a clean machine doesn't hit WinError 126.
 *
 * This is the real reason "same hardware, mine works, theirs doesn't": torch's
 * Windows wheels are built against the Microsoft Visual C++ runtime
 * (vcruntime140.dll, vcruntime140_1.dll, msvcp140.dll), and `uv`'s standalone
 * Python does NOT ship it the way conda does (astral-sh/uv#18413). A dev box
 * usually already has the redist from something else; a fresh one doesn't, and
 * torch's c10.dll then can't find its dependency and refuses to load.
 *
 * cgohlke's `msvc-runtime` wheel carries exactly those DLLs — but it drops them
 * beside python.exe (sys.prefix / Scripts), which the FIRST version of this fix
 * assumed torch would search. It doesn't: torch loads c10.dll from torch/lib and
 * Python 3.8+ resolves that DLL's own dependencies only from torch/lib +
 * add_dll_directory dirs + system dirs. So we install the wheel to ACQUIRE the
 * DLLs, then copy them into torch/lib where the loader will actually find them.
 * No admin, no system-wide redist, no separate step for my human, self-contained.
 *
 * Best-effort by design: `msvc-runtime` only has wheels for Python 3.11+, so on
 * an older interpreter (or any resolve failure) it logs and returns — the
 * built-in engine still speaks, and a hard failure here must never sink the whole
 * install. No-op off Windows, where torch needs nothing of the sort.
 */
export async function ensureWindowsMsvcRuntime({ rootDir = process.cwd(), onLog = () => {} } = {}) {
  if (process.platform !== 'win32') return { ok: true, skipped: 'not-windows' };
  const root = asRoot(rootDir);
  const py = await voiceboxPython(root);
  if (!py) return { ok: false, reason: 'no-python', detail: 'no venv interpreter to install the runtime into' };

  onLog('ensuring the Visual C++ runtime torch needs (msvc-runtime)…');
  const r = await runCmd('uv.exe', ['pip', 'install', '--python', py, 'msvc-runtime'], { onLog });
  if (!r.ok) {
    // Not fatal: an older Python has no wheel, and the built-in engine covers us.
    onLog('could not add the runtime automatically — the built-in voice still works; the Visual C++ redistributable would enable Kyutai.');
    return { ok: false, reason: 'runtime-install-failed', detail: r.detail };
  }

  // Installing the wheel is only half of it — the DLLs land where torch never
  // looks. Copy them into torch/lib, the one directory its native loader searches.
  const venvDir = path.join(root, VOICEBOX_SUBDIR, '.venv');
  const placed = await placeMsvcRuntimeBesideTorch({ venvDir, onLog });
  if (!placed.libDir) {
    onLog('torch/lib not found in the venv — cannot place the runtime where torch looks.');
    return { ok: false, reason: 'no-torch-lib', detail: 'torch is not installed in the voicebox venv' };
  }
  if (placed.found.length === 0) {
    onLog('installed msvc-runtime but found none of its DLLs to copy — the system Visual C++ redistributable is the fallback.');
    return { ok: false, reason: 'no-runtime-dlls', detail: 'msvc-runtime installed but its DLLs were not found in the venv' };
  }
  onLog(placed.copied.length
    ? `placed ${placed.copied.length} runtime DLL(s) where torch loads them (${placed.copied.join(', ')}).`
    : 'the runtime was already in place beside torch.');
  return { ok: true, installed: true, copied: placed.copied };
}

/**
 * Delete the voicebox venv and rebuild it, then PROVE torch loads. Never throws.
 * @returns {{ok:true, torch?:string} | {ok:false, reason:string, detail?:string, hint?:string}}
 */
export async function rebuildVoicebox({ rootDir = process.cwd(), onLog = () => {} } = {}) {
  const root = asRoot(rootDir);
  const dir = path.join(root, VOICEBOX_SUBDIR);
  if (!(await exists(path.join(dir, 'pyproject.toml')))) {
    return { ok: false, reason: 'no-voicebox', detail: 'voicebox/ is missing from this checkout — nothing to repair.' };
  }
  if (!(await haveUv())) {
    return { ok: false, reason: 'no-uv', detail: 'uv is not installed or not on PATH.', hint: 'Install uv: https://docs.astral.sh/uv/getting-started/installation/' };
  }

  // Remove the broken venv for a clean rebuild. On Windows a running worker can
  // hold python.exe open; the caller stops the audio worker first.
  onLog('removing the old Kyutai environment…');
  await fs.rm(path.join(dir, '.venv'), { recursive: true, force: true }).catch(() => {});

  onLog('rebuilding (uv sync --reinstall — torch is most of it, this takes a while)…');
  const sync = await runCmd(process.platform === 'win32' ? 'uv.exe' : 'uv', ['sync', '--reinstall', '--directory', dir], { onLog });
  if (!sync.ok) return { ok: false, reason: 'sync-failed', detail: sync.detail };

  const py = await voiceboxPython(root);
  if (!py) return { ok: false, reason: 'no-python', detail: 'the environment did not rebuild — no interpreter found.' };

  // The usual reason a rebuilt venv still can't load torch: the OS never had the
  // Visual C++ runtime, which uv doesn't provide. Supply it into the venv itself
  // so this repair is self-contained rather than sending my human to Microsoft.
  await ensureWindowsMsvcRuntime({ rootDir: root, onLog });

  // The real test: does torch actually import now? A rebuilt venv can still fail
  // if the OS is missing torch's runtime dependency — on Windows, the Microsoft
  // Visual C++ Redistributable — which no reinstall can supply.
  onLog('verifying torch loads…');
  const probe = await runCmd(py, ['-c', 'import torch; print(torch.__version__)'], { env: { PYTHONPATH: path.join(dir, 'src') }, onLog });
  if (!probe.ok) {
    const winDll = /WinError 126|DLL load failed|c10\.dll/i.test(probe.detail || '');
    return {
      ok: false, reason: 'torch-broken', detail: probe.detail,
      hint: winDll
        ? "I rebuilt the environment and copied the Visual C++ runtime into torch's own folder, but it still can't load its native library. As a last resort install the official Microsoft Visual C++ Redistributable (vc_redist.x64 — aka.ms/vs/17/release/vc_redist.x64.exe) and restart. Meanwhile the built-in voice still speaks."
        : 'torch rebuilt but still fails to import; see the detail for the underlying error.',
    };
  }
  onLog(`torch ${probe.output?.trim() || 'ok'} — Kyutai is repaired.`);
  return { ok: true, torch: (probe.output || '').trim() };
}
