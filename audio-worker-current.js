/**
 * The one live audio worker, and who is allowed to reach it.
 *
 * This used to live inside server.js, which was fine while the only thing that
 * spoke or listened was an HTTP endpoint. It stopped being fine the moment
 * Discord needed to hear a voice note too: a capability reachable from exactly
 * one surface is the shape of the bug RULE C exists to prevent — web got
 * `ensureDescribed`, Discord silently didn't, and I confidently described
 * images I had never looked at. So the worker moved out here, where every
 * surface can reach the same one, rather than each surface growing its own
 * wiring to drift out of step.
 *
 * ── Why it is built lazily and torn down on change ──────────────────────
 * Which engine speaks is a SETTING, and settings change while running. Build
 * at boot and a ward who installs voicebox and switches to it keeps hearing
 * the old engine until they restart. Build on demand and the switch takes
 * effect at the next thing they ask for.
 *
 * ── One at a time ───────────────────────────────────────────────────────
 * The old worker is stopped BEFORE the new one starts. Two engines holding
 * models at once is 400+ MB of ONNX on a machine that may have 8 GB, and the
 * reference laptop is the one I am built for, not a generous one.
 */

import { createAudioWorker } from './audio-worker-host.js';
import { resolveBackend, BACKENDS } from './voice-backend.js';

export const VOICE_HARD_DISABLED = process.env.PROTO_FAMILIAR_VOICE_DISABLED === '1';

let worker = null;
let backend = null;

/**
 * Once we learn the pocket (Kyutai) engine can't actually LOAD on this machine —
 * torch's native DLL won't load, a binding is missing — we stop trying to spawn
 * a Python process that dies on import and speak on the built-in engine instead.
 * null = not learned yet / fine; { reason, detail } = fall straight to sherpa.
 * Cleared by stopAudioWorker so a repair (Fix Kyutai) + fresh worker is retried.
 */
let pocketBroken = null;

/** The listening worker — separate from `worker`, and pinned to sherpa. */
let listener = null;

function build(resolved) {
  return createAudioWorker({
    command: resolved.command,
    workerScript: resolved.workerScript,
    env: resolved.env ?? {},
    onEvent: (e) => {
      // Failures that matter are observable — the repo rule. A parked worker
      // in particular must never be something a ward has to guess at.
      if (e.type === 'parked') console.warn(`[voice] worker parked: ${e.reason}`);
      else if (e.type === 'exit') console.warn(`[voice] worker exited (${e.signal ?? e.code})`);
      else if (e.type === 'protocol-error') console.warn(`[voice] protocol error: ${e.reason}`);
    },
  });
}

// Indirection so a test can inject a fake resolver/builder and exercise the
// pocket→sherpa fall-back without spawning real Python/ONNX processes.
// Production always uses the real ones; the hooks default straight back to them.
let resolver = resolveBackend;
let builder = build;
export function __setVoiceTestHooks({ resolveBackend: r, build: b } = {}) {
  resolver = r || resolveBackend;
  builder = b || build;
}

/**
 * The worker for the currently-chosen engine, spawning or re-spawning as
 * needed. Never throws — every caller is a request path or a chat turn.
 *
 * @param {object} deps
 * @param {string} deps.rootDir       where voicebox and the models live
 * @param {Function} deps.readSettings sync settings read (injected: this module
 *   must not care where settings come from)
 */
export async function currentAudioWorker({ rootDir, readSettings } = {}) {
  if (VOICE_HARD_DISABLED) return { worker: null, resolved: null };

  const s = (() => { try { return readSettings?.() || {}; } catch { return {}; } })();
  let resolved = await resolver({ rootDir, settings: s });

  // We already learned pocket can't load its engine here — go straight to the
  // built-in engine, which needs no torch and no downloads. It always speaks.
  if (resolved.backend === BACKENDS.POCKET && pocketBroken) {
    resolved = await sherpaFallback(rootDir, pocketBroken.reason);
  }

  // A change to the spawn env (e.g. PF_TTS_TEMPERATURE, which pocket bakes in at
  // load) must respawn the worker, not reuse the old one — otherwise a tuning
  // change would silently do nothing until the next restart.
  const sameEnv = JSON.stringify(backend?.env ?? {}) === JSON.stringify(resolved.env ?? {});
  if (worker && backend?.backend === resolved.backend && backend?.workerScript === resolved.workerScript && sameEnv) {
    // The WORKER can be reused (same engine + script), but the RESOLUTION
    // METADATA must not be stale: choosing the sidecar when it isn't installed
    // still resolves to sherpa, yet now carries fellBackFrom:'pocket'. Returning
    // the cached `backend` (fellBackFrom:null) is what made the engine picker
    // snap back to the default with no "chosen but not installed" prompt — the
    // status endpoint reads fellBackFrom from here. Refresh it, keep the worker.
    backend = resolved;
    return { worker, resolved };
  }

  if (worker) { try { worker.stop(); } catch { /* already gone */ } }
  worker = builder(resolved);
  backend = resolved;

  // A pocket worker whose files EXIST can still fail to load at runtime (torch's
  // DLL, a missing binding) — inspectBackends can't see that, it only checks the
  // files are present. The first time we build one, prove it actually loads; if
  // it doesn't, remember that and rebuild on the built-in engine. Every speaking
  // surface calls through here, so all of them get a working voice without
  // knowing pocket failed — the shared-path fix RULE C asks for, and the reason
  // a missing Visual C++ runtime no longer means silence, only a lesser voice.
  if (resolved.backend === BACKENDS.POCKET) {
    const health = await pocketEngineLoads(worker);
    if (!health.ok) {
      pocketBroken = { reason: 'the Kyutai engine could not load on this machine', detail: health.detail };
      console.warn(`[voice] Kyutai failed to load (${health.detail}) — speaking on the built-in engine instead. Repair with Fix Kyutai, then restart.`);
      try { worker.stop(); } catch { /* already gone */ }
      resolved = await sherpaFallback(rootDir, pocketBroken.reason);
      worker = builder(resolved);
      backend = resolved;
    }
  }

  if (resolved.fellBackFrom) {
    console.warn(`[voice] asked for ${resolved.fellBackFrom}, using ${resolved.backend}: ${resolved.reason}`);
  } else {
    console.log(`[voice] speaking through ${resolved.backend}`);
  }
  return { worker, resolved };
}

/** Resolve the built-in engine explicitly, tagged as a fall-back from pocket. */
async function sherpaFallback(rootDir, reason) {
  const r = await resolver({ rootDir, settings: { voiceTts: { backend: BACKENDS.SHERPA } } });
  return { ...r, fellBackFrom: BACKENDS.POCKET, reason };
}

/**
 * Does a freshly-built pocket worker's engine actually load? A pocket ping runs
 * the torch import + model load, so this both verifies AND warms it. Torch
 * failing to load throws almost immediately; a working engine may take a while
 * to read the model off disk, so the timeout matches a real cold load rather
 * than a short probe — otherwise a slow-but-fine laptop would be misread as
 * broken and demoted to the lesser engine.
 */
async function pocketEngineLoads(w) {
  try {
    const r = await w.request({ op: 'ping' }, { timeoutMs: 180_000 });
    if (!r?.ok) return { ok: false, detail: r?.detail ?? r?.reason ?? 'the engine did not respond' };
    if (!r.engineAvailable) return { ok: false, detail: r.engineDetail ?? 'the engine could not load' };
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: String(e?.message ?? e) };
  }
}

/**
 * The worker that LISTENS. Always sherpa, whatever is set for speaking.
 *
 * ⚠️ Which engine SPEAKS is my human's choice; which engine LISTENS is not —
 * the recogniser is a sherpa model, always. Transcription used to call
 * `currentAudioWorker()`, which returns whichever worker the SPEAKING setting
 * chose, so picking the voicebox voice sent every voice note to a Python
 * process that cannot listen. Do not merge these two back together.
 *
 * Two children when both are in use, which is fine: different models, each
 * unloads on idle.
 *
 * Returns `{ worker: null, reason }` rather than throwing — the caller is a
 * chat path, and "this machine cannot listen" has to arrive as a sentence my
 * human can act on, not an exception.
 */
export async function listeningWorker({ rootDir } = {}) {
  if (VOICE_HARD_DISABLED) return { worker: null, reason: 'voice-disabled' };
  if (listener) return { worker: listener };

  // Pinned to sherpa EXPLICITLY, not via the default. The speaking default is
  // pocket now, and `settings: {}` would resolve to it — routing every voice
  // note to a Python process that cannot listen the moment the sidecar is
  // installed. The recogniser is a sherpa model regardless of what speaks, so
  // ask for it by name. Not read from my human's voiceTts choice either: that
  // choice is about the voice they hear and has nothing to do with listening.
  const resolved = await resolveBackend({ rootDir, settings: { voiceTts: { backend: BACKENDS.SHERPA } } });
  if (resolved.backend !== BACKENDS.SHERPA) {
    return { worker: null, reason: 'no-listening-engine', detail: resolved.reason ?? null };
  }
  listener = build(resolved);
  console.log('[voice] listening through sherpa');
  return { worker: listener };
}

/** Stop whatever is running. Idempotent; used on shutdown. */
export function stopAudioWorker() {
  let stopped = false;
  // Forget what we learned about pocket: a stop precedes a repair (Fix Kyutai)
  // or a settings change, and the next worker deserves a fresh verification
  // rather than being demoted forever on one session's failure.
  pocketBroken = null;
  if (worker) { try { worker.stop(); } catch { /* already gone */ } worker = null; backend = null; stopped = true; }
  if (listener) { try { listener.stop(); } catch { /* already gone */ } listener = null; stopped = true; }
  return stopped;
}
