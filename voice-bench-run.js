/**
 * The ward-facing benchmark run manager (voice spec §0.5).
 *
 * A benchmark takes minutes, not milliseconds — models load, audio decodes,
 * the interference phase samples repeatedly. So the HTTP surface is
 * start/poll/cancel rather than one long request that a proxy or a closed
 * laptop lid would kill halfway.
 *
 * ── Why this is its own module ──────────────────────────────────────────
 * `voice-bench.js` measures. This holds the *state of a run in progress* —
 * which stage, since when, cancelled or not — so the measuring core stays
 * pure and testable and the endpoint stays thin. Modular by default; the
 * orchestration files are for connective tissue, not for this.
 *
 * ── One run at a time, deliberately ─────────────────────────────────────
 * Two concurrent benchmarks would measure each other's contention and report
 * numbers that describe nothing real. A second start returns the run already
 * going rather than queueing or refusing — a ward who clicks twice meant to
 * run it once.
 */

import path from 'node:path';
import { runBenchmark, saveReport } from './voice-bench.js';
import { composePlan } from './voice-models.js';

/** Stages in the order they happen, with what to tell my human while each runs. */
export const STAGE_LABELS = Object.freeze({
  models: 'Checking which models are installed…',
  asr: 'Transcribing the test clips…',
  rtf: 'Measuring decoding speed…',
  tts: 'Measuring how quickly I can start speaking…',
  speaker: 'Measuring voice recognition cost…',
  enhance: 'Measuring noise cleanup cost…',
  interference: 'Checking whether a call would slow the rest of me down…',
  footprint: 'Measuring what all of this takes up on disk…',
  done: 'Finished.',
});

let current = null;

function freshState(plan) {
  return {
    id: `bench-${Date.now().toString(36)}`,
    startedAt: Date.now(),
    finishedAt: null,
    stage: 'models',
    detail: null,
    plan: { capabilityTier: plan.capabilityTier, voiceEngine: plan.voiceEngine, asrLangs: plan.asrLangs },
    status: 'running',
    error: null,
    result: null,
    savedTo: null,
    cancelled: false,
  };
}

/** What a poll returns. Never includes the full result until it is finished. */
export function statusOf(state = current) {
  if (!state) return { running: false, status: 'idle' };
  return {
    running: state.status === 'running',
    status: state.status,
    id: state.id,
    stage: state.stage,
    stageLabel: STAGE_LABELS[state.stage] ?? state.stage,
    detail: state.detail,
    elapsedMs: (state.finishedAt ?? Date.now()) - state.startedAt,
    plan: state.plan,
    error: state.error,
    markdown: state.status === 'done' ? state.result?.markdown ?? null : null,
    savedTo: state.savedTo,
  };
}

/**
 * Start a benchmark. Returns immediately with the run's status; the work
 * continues in the background and is read back by polling.
 *
 * `engineFactory` is injected so the endpoint can supply the real
 * sherpa-onnx adapter while tests supply a stub — the same boundary
 * `voice-bench.js` uses, for the same reason: a missing engine must be a
 * reported absence, never a crash inside a ward-facing button.
 */
export function startBenchmark({
  rootDir,
  planOptions = {},
  engineFactory = null,
  reportSaver = saveReport,
  probe = null,
  appVersion = null,
  samples = 12,
} = {}) {
  if (current?.status === 'running') {
    return { started: false, reason: 'already-running', status: statusOf(current) };
  }

  const plan = composePlan(planOptions);
  const state = freshState(plan);
  current = state;

  // Fire and forget on purpose: the endpoint returns now, the ward polls.
  (async () => {
    let engine = null;
    try {
      engine = typeof engineFactory === 'function' ? await engineFactory() : null;
    } catch (err) {
      // A broken engine is a measurement that reports itself missing, not a
      // failed run — every other stage still has something to say.
      engine = { available: false, reason: `the speech engine could not start: ${String(err?.message ?? err)}` };
    }

    try {
      const result = await runBenchmark({
        rootDir,
        plan,
        engine,
        probe,
        appVersion,
        samples,
        onStage: ({ stage, detail }) => {
          if (state.cancelled) return;
          state.stage = stage;
          state.detail = detail ?? null;
        },
      });

      if (state.cancelled) {
        state.status = 'cancelled';
      } else {
        state.result = result;
        // Persist before flipping to done, so a ward who closes the modal the
        // instant it finishes still has the file. The report surviving its
        // window is the whole point of §0.5's "send this back".
        try {
          const saved = await reportSaver({ rootDir, result });
          state.savedTo = saved;
        } catch (err) {
          state.savedTo = { error: String(err?.message ?? err) };
        }
        state.status = 'done';
      }
    } catch (err) {
      state.status = 'failed';
      state.error = String(err?.message ?? err);
    } finally {
      state.finishedAt = Date.now();
      try { await engine?.close?.(); } catch { /* a stubborn engine must not mask the result */ }
    }
  })();

  return { started: true, status: statusOf(state) };
}

/**
 * Ask a running benchmark to stop.
 *
 * Cooperative rather than forceful: the stage in flight finishes (an audio
 * decode mid-buffer cannot be torn out safely), then the run reports
 * `cancelled` instead of writing a partial report. A half-measured report
 * that looks complete is worse than no report.
 */
export function cancelBenchmark() {
  if (!current || current.status !== 'running') return { cancelled: false, reason: 'nothing-running' };
  current.cancelled = true;
  return { cancelled: true, id: current.id };
}

/** Clear a finished run so the next start begins clean. Refuses while one is live. */
export function resetBenchmark() {
  if (current?.status === 'running') return { reset: false, reason: 'still-running' };
  current = null;
  return { reset: true };
}

/** Where a finished report was written, relative to the app root — for the UI to name. */
export function reportPathsRelative(rootDir, saved) {
  if (!saved || saved.error) return null;
  return {
    json: path.relative(rootDir, saved.jsonPath),
    markdown: path.relative(rootDir, saved.mdPath),
  };
}
