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
  const resolved = await resolveBackend({ rootDir, settings: s });

  if (worker && backend?.backend === resolved.backend && backend?.workerScript === resolved.workerScript) {
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
  worker = build(resolved);
  backend = resolved;
  if (resolved.fellBackFrom) {
    console.warn(`[voice] asked for ${resolved.fellBackFrom}, using ${resolved.backend}: ${resolved.reason}`);
  } else {
    console.log(`[voice] speaking through ${resolved.backend}`);
  }
  return { worker, resolved };
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
  if (worker) { try { worker.stop(); } catch { /* already gone */ } worker = null; backend = null; stopped = true; }
  if (listener) { try { listener.stop(); } catch { /* already gone */ } listener = null; stopped = true; }
  return stopped;
}
