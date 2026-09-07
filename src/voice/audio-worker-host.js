/**
 * Supervision for the audio worker child process (voice spec §2).
 *
 * The worker runs speech models; this runs the worker. Spawn, talk to it,
 * notice when it dies, restart it — and know when to stop restarting.
 *
 * ── Why a child process at all ──────────────────────────────────────────
 * Three reasons, spelled out in §2 because an earlier draft gave only the
 * first and it did not cover the question people actually ask:
 *   1. Native inference calls are blocking C++; in-process they would stall
 *      the server's event loop, which is the one thing that must never happen.
 *   2. The stages are largely serial anyway, so sharing a runtime with the
 *      embedder would buy nothing — and ONNX thread pools are per-process, so
 *      "sharing" would mean co-locating audio with the canonical self-store.
 *   3. Isolation buys supervision. Audio crashes restart audio, not memory.
 *
 * ── Nothing here throws at a caller ─────────────────────────────────────
 * Every request resolves, including the failures: a dead worker, a timeout, a
 * parked supervisor. Voice runs behind a ward-facing button and inside the
 * runtime's first-enable, and a rejected promise nobody caught is exactly the
 * shape of failure that reaches my human as a broken page instead of an
 * honest "I can't speak right now".
 *
 * ── Parking ─────────────────────────────────────────────────────────────
 * Restart-with-backoff, but bounded: three crashes inside a minute and the
 * worker is PARKED rather than restarted forever. A model that segfaults on
 * every load would otherwise spin a restart loop on a 15 W laptop until the
 * battery died — the ward would notice the fan, not the feature. Parked is a
 * reported state; chat carries on untouched.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeJson, encodePcm, createFrameReader, KIND_JSON } from './audio-frame.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Hard ONNX Runtime intra-op thread caps (§2).
 *
 * Set at session creation inside the worker, and passed in from here so the
 * numbers live with the supervision rather than being buried in the child.
 * `total` is the ceiling the worker's own scheduler holds concurrent work
 * beneath — on a 4c/8t machine, leaving a physical core's worth of headroom
 * for Node and the Python children even mid-burst.
 */
export const DEFAULT_THREADS = Object.freeze({
  vad: 1, asr: 2, tts: 2, speaker: 1, total: 3,
});

export const DEFAULTS = Object.freeze({
  maxCrashes: 3,          // within the window, before parking
  crashWindowMs: 60_000,
  backoffMs: [250, 1000, 3000],
  requestTimeoutMs: 30_000,
  idleMs: 10 * 60_000,    // voiceModelIdleMin: a machine not in a call pays no RAM
});

/**
 * Create a supervisor. Nothing spawns until the first request — a ward who
 * never enables voice never pays for a process.
 *
 * `workerScript` is injectable so tests can drive a stub child that speaks the
 * same protocol without a speech engine installed. Same boundary discipline as
 * the bench's `engineFactory`, for the same reason: supervision has to be
 * testable separately from the thing being supervised.
 *
 * `command` exists because the worker is not always Node. `voicebox/` is the
 * same protocol spoken by a Python process running Kyutai's own implementation
 * — the one that can hold a voice across a whole message. Supervision does not
 * care which language is on the other end of the pipe, and this is the only
 * line that had to learn that.
 */
export function createAudioWorker({
  command = process.execPath,
  workerScript = path.join(HERE, 'audio-worker.mjs'),
  nodeArgs = [],
  env = {},
  threads = DEFAULT_THREADS,
  maxCrashes = DEFAULTS.maxCrashes,
  crashWindowMs = DEFAULTS.crashWindowMs,
  backoffMs = DEFAULTS.backoffMs,
  requestTimeoutMs = DEFAULTS.requestTimeoutMs,
  idleMs = DEFAULTS.idleMs,
  onEvent = null,
  spawnImpl = spawn,
} = {}) {
  let child = null;
  let reader = null;
  let starting = null;
  let parked = null;              // { reason, since } once we stop restarting
  let stopped = false;            // stop() called; not a crash, do not restart
  let crashes = [];               // timestamps inside the window
  let restartAttempt = 0;
  let idleTimer = null;
  let nextReqId = 1;
  const pending = new Map();      // reqId -> { resolve, timer }
  const listeners = new Set();    // for unsolicited frames (partials, endpoints)

  const emit = (evt) => { try { onEvent?.(evt); } catch { /* a reporter must not break supervision */ } };

  const state = {
    startedAt: null,
    restarts: 0,
    lastExit: null,
    loadedModels: [],
    liveDecoders: 0,
  };

  function clearIdle() { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } }

  function armIdle() {
    clearIdle();
    if (!idleMs || idleMs <= 0) return;
    idleTimer = setTimeout(() => {
      if (pending.size > 0) { armIdle(); return; }   // still working; not idle
      emit({ type: 'idle-unload', afterMs: idleMs });
      teardown('idle');
    }, idleMs);
    idleTimer.unref?.();
  }

  /** Settle every in-flight request with an honest result rather than leaving them hanging. */
  function failPending(reason, detail) {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, reason, detail });
    }
    pending.clear();
  }

  function teardown(why) {
    clearIdle();
    const c = child;
    child = null;
    reader = null;
    if (c) {
      try { c.stdin.end(); } catch { /* already closed */ }
      try { c.kill(); } catch { /* already gone */ }
    }
    failPending('worker-stopped', why);
  }

  function recordCrash(code, signal) {
    const now = Date.now();
    crashes = crashes.filter((t) => now - t < crashWindowMs);
    crashes.push(now);
    state.lastExit = { code, signal, at: new Date(now).toISOString() };

    if (crashes.length >= maxCrashes) {
      parked = {
        reason: `the speech engine stopped ${crashes.length} times in under a minute`,
        since: new Date(now).toISOString(),
      };
      emit({ type: 'parked', ...parked });
      return true;
    }
    return false;
  }

  function handleFrame(frame) {
    if (frame.kind !== KIND_JSON) {
      for (const l of listeners) { try { l(frame); } catch { /* ignore */ } }
      return;
    }
    const msg = frame.message ?? {};

    // Worker-initiated status, so `/api/voice/status` reports what is loaded
    // rather than what we assume is loaded.
    if (msg.op === 'state') {
      if (Array.isArray(msg.loadedModels)) state.loadedModels = msg.loadedModels;
      if (Number.isFinite(msg.liveDecoders)) state.liveDecoders = msg.liveDecoders;
    }

    if (msg.reqId && pending.has(msg.reqId)) {
      const p = pending.get(msg.reqId);
      pending.delete(msg.reqId);
      clearTimeout(p.timer);
      p.resolve(msg.ok === false ? { ok: false, reason: msg.reason ?? 'worker-error', detail: msg.detail } : { ok: true, ...msg });
      armIdle();
      return;
    }

    for (const l of listeners) { try { l(frame); } catch { /* ignore */ } }
  }

  async function ensureStarted() {
    if (child) return { ok: true };
    if (parked) return { ok: false, reason: 'parked', detail: parked.reason };
    if (stopped) return { ok: false, reason: 'stopped', detail: 'voice was shut down' };
    if (starting) return starting;

    // The in-flight latch is cleared by the CALLER, in a finally, not by the
    // async body clearing its own variable. When there is no await before it
    // (the very first spawn), the body runs synchronously to completion — so
    // `starting = null` inside would execute BEFORE the outer assignment, and
    // the assignment would then overwrite null with the settled promise. The
    // latch would stay set forever and every later call would return a stale
    // "already started" without spawning anything. Found by an integration
    // test; no unit test of this function could have seen it.
    const attempt = (async () => {
      const wait = backoffMs[Math.min(restartAttempt, backoffMs.length - 1)];
      if (restartAttempt > 0) await new Promise((r) => setTimeout(r, wait));

      let proc;
      try {
        proc = spawnImpl(command, [...nodeArgs, workerScript], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            ...env,
            PF_AUDIO_THREADS: String(threads.total),
            PF_AUDIO_THREADS_VAD: String(threads.vad),
            PF_AUDIO_THREADS_ASR: String(threads.asr),
            PF_AUDIO_THREADS_TTS: String(threads.tts),
            PF_AUDIO_THREADS_SPEAKER: String(threads.speaker),
          },
        });
      } catch (err) {
        // Cannot even spawn — a missing node, a missing script. Not a crash
        // loop, just unavailable, and said so.
        return { ok: false, reason: 'spawn-failed', detail: String(err?.message ?? err) };
      }

      child = proc;
      state.startedAt = new Date().toISOString();
      reader = createFrameReader({
        onFrame: handleFrame,
        onError: (e) => {
          emit({ type: 'protocol-error', ...e });
          // Framing lost means the pipe cannot be read any more. Restarting is
          // the only recovery; guessing where the next frame starts is not.
          if (e.reason === 'frame-too-large') { try { child?.kill(); } catch { /* gone */ } }
        },
      });

      proc.stdout.on('data', (chunk) => reader?.push(chunk));
      proc.stderr.on('data', (chunk) => emit({ type: 'worker-stderr', text: String(chunk).trim().slice(0, 500) }));

      proc.on('error', (err) => emit({ type: 'worker-error', detail: String(err?.message ?? err) }));

      proc.on('exit', (code, signal) => {
        const wasChild = child === proc;
        if (wasChild) { child = null; reader = null; }
        clearIdle();
        failPending('worker-died', `exited ${signal ?? code}`);
        if (stopped || !wasChild) return;

        emit({ type: 'exit', code, signal });
        if (!recordCrash(code, signal)) {
          restartAttempt++;
          state.restarts++;
          emit({ type: 'restarting', attempt: restartAttempt, inMs: backoffMs[Math.min(restartAttempt, backoffMs.length - 1)] });
        }
      });

      emit({ type: 'started', attempt: restartAttempt });
      return { ok: true };
    })();

    starting = attempt;
    try {
      return await attempt;
    } finally {
      if (starting === attempt) starting = null;
    }
  }

  return {
    /**
     * Ask the worker to do something. Always resolves.
     *
     * A timeout is a *reported* failure and the request is forgotten, but the
     * worker is left alone: a slow first model load is not a crash, and
     * killing it would turn a long wait into a restart loop.
     */
    async request(message, { timeoutMs = requestTimeoutMs } = {}) {
      const up = await ensureStarted();
      if (!up.ok) return up;
      // ⚠️ `stop()` can land in the gap created by that await — it runs
      // synchronously, tears the child down and sets `child = null`, all before
      // this line resumes. Writing then threw a TypeError that surfaced to the
      // caller as `write-failed: Cannot read properties of null (reading
      // 'stdin')`. Harmless but incomprehensible, and reachable in production
      // because shutdown stops the worker while a read-aloud may be in flight.
      if (stopped || !child) return { ok: false, reason: 'stopped', detail: 'the worker was stopped' };

      const reqId = `r${nextReqId++}`;
      clearIdle();

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(reqId);
          emit({ type: 'request-timeout', op: message?.op, timeoutMs });
          resolve({ ok: false, reason: 'timeout', detail: `no answer in ${timeoutMs} ms` });
          armIdle();
        }, timeoutMs);
        timer.unref?.();

        pending.set(reqId, { resolve, timer });
        try {
          child.stdin.write(encodeJson({ ...message, reqId }));
        } catch (err) {
          pending.delete(reqId);
          clearTimeout(timer);
          resolve({ ok: false, reason: 'write-failed', detail: String(err?.message ?? err) });
        }
      });
    },

    /** Push audio at a stream. Fire-and-forget: PCM has no reply and waiting for one would stall capture. */
    async sendPcm(streamId, pcm) {
      const up = await ensureStarted();
      if (!up.ok) return up;
      if (stopped || !child) return { ok: false, reason: 'stopped', detail: 'the worker was stopped' };
      try {
        child.stdin.write(encodePcm(streamId, pcm));
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: 'write-failed', detail: String(err?.message ?? err) };
      }
    },

    /** Listen for unsolicited frames: partial transcripts, endpoints, audio out. */
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** What `/api/voice/status` reports. Honest about parked and about why. */
    status() {
      return {
        running: Boolean(child),
        parked: Boolean(parked),
        parkedReason: parked?.reason ?? null,
        parkedSince: parked?.since ?? null,
        stopped,
        startedAt: state.startedAt,
        restarts: state.restarts,
        lastExit: state.lastExit,
        crashesInWindow: crashes.filter((t) => Date.now() - t < crashWindowMs).length,
        loadedModels: state.loadedModels,
        liveDecoders: state.liveDecoders,
        pendingRequests: pending.size,
        threads,
      };
    },

    /** Clear a park after the ward has fixed something. Deliberate, never automatic. */
    unpark() {
      if (!parked) return { unparked: false, reason: 'not-parked' };
      parked = null;
      crashes = [];
      restartAttempt = 0;
      emit({ type: 'unparked' });
      return { unparked: true };
    },

    /** Shut down for good. Not a crash: no restart follows. */
    stop() {
      stopped = true;
      teardown('stopped');
      return { stopped: true };
    },

    /** Allow use after stop() — the settings toggle turning voice back on. */
    resume() {
      stopped = false;
      restartAttempt = 0;
      return { resumed: true };
    },
  };
}
