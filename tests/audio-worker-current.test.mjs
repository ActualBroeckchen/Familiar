import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  currentAudioWorker,
  stopAudioWorker,
  __setVoiceTestHooks,
} from '../audio-worker-current.js';

/**
 * The bug this guards: a pocket (Kyutai) install whose FILES exist but whose
 * torch DLL won't load reported no-engine and read-aloud went silent, instead
 * of falling back to the built-in engine that needs no torch. inspectBackends
 * only checks the files are present, so the runtime verification lives here.
 *
 * A fake resolver returns pocket; a fake worker's ping decides whether the
 * engine "loads". No real Python/ONNX process is spawned.
 */

const POCKET = { backend: 'pocket', command: 'py', workerScript: '/x/voicebox/worker.py', env: {}, fellBackFrom: null, reason: null };
const SHERPA = { backend: 'sherpa', command: 'node', workerScript: '/x/audio-worker.mjs', env: {}, fellBackFrom: null, reason: null };

function fakeWorker(pingReply, calls) {
  return {
    request: async (msg) => {
      if (msg.op === 'ping') { calls.pings++; return pingReply; }
      return { ok: true };
    },
    stop() { calls.stops++; },
    on() { return () => {}; },
    status() { return { running: true }; },
  };
}

/** Resolver that hands back pocket when pocket is asked for, else sherpa. */
function resolverFor() {
  return async ({ settings }) => (settings?.voiceTts?.backend === 'sherpa' ? { ...SHERPA } : { ...POCKET });
}

test('a pocket engine that cannot load falls back to the built-in engine', async () => {
  stopAudioWorker();
  const calls = { builds: [], pings: 0, stops: 0 };
  __setVoiceTestHooks({
    resolveBackend: resolverFor(),
    build: (resolved) => {
      calls.builds.push(resolved.backend);
      // pocket ping says the engine could NOT load (the WinError case); sherpa
      // is not pinged (only pocket is verified), so its reply never matters.
      return fakeWorker({ ok: true, engineAvailable: false, engineDetail: 'OSError: [WinError 126] c10.dll' }, calls);
    },
  });

  const { resolved } = await currentAudioWorker({ rootDir: '/x' });
  assert.equal(resolved.backend, 'sherpa', 'speaks on the built-in engine when pocket cannot load');
  assert.equal(resolved.fellBackFrom, 'pocket', 'and records that it fell back from pocket');
  assert.deepEqual(calls.builds, ['pocket', 'sherpa'], 'built pocket, then rebuilt on sherpa');
  assert.equal(calls.pings, 1, 'verified pocket exactly once');

  // Second call must NOT re-probe the broken pocket — it goes straight to sherpa.
  const pingsBefore = calls.pings;
  const again = await currentAudioWorker({ rootDir: '/x' });
  assert.equal(again.resolved.backend, 'sherpa');
  assert.equal(calls.pings, pingsBefore, 'a known-broken pocket is not re-pinged every turn');

  stopAudioWorker();
  __setVoiceTestHooks({});
});

test('a healthy pocket engine is kept — no needless fall-back', async () => {
  stopAudioWorker();
  const calls = { builds: [], pings: 0, stops: 0 };
  __setVoiceTestHooks({
    resolveBackend: resolverFor(),
    build: (resolved) => {
      calls.builds.push(resolved.backend);
      return fakeWorker({ ok: true, engineAvailable: true, engineDetail: null }, calls);
    },
  });

  const { resolved } = await currentAudioWorker({ rootDir: '/x' });
  assert.equal(resolved.backend, 'pocket', 'a working pocket engine stays selected');
  assert.equal(resolved.fellBackFrom, null);
  assert.deepEqual(calls.builds, ['pocket'], 'built pocket once, no rebuild');

  stopAudioWorker();
  __setVoiceTestHooks({});
});

test('stopAudioWorker clears the broken flag so a repair gets a fresh chance', async () => {
  stopAudioWorker();
  const calls = { builds: [], pings: 0, stops: 0 };
  let engineAvailable = false;
  __setVoiceTestHooks({
    resolveBackend: resolverFor(),
    build: (resolved) => {
      calls.builds.push(resolved.backend);
      return fakeWorker({ ok: true, engineAvailable, engineDetail: engineAvailable ? null : 'WinError 126' }, calls);
    },
  });

  // First session: pocket broken → sherpa.
  let r = await currentAudioWorker({ rootDir: '/x' });
  assert.equal(r.resolved.backend, 'sherpa');

  // A repair happened (Fix Kyutai stops the worker), and now pocket loads.
  stopAudioWorker();
  engineAvailable = true;
  r = await currentAudioWorker({ rootDir: '/x' });
  assert.equal(r.resolved.backend, 'pocket', 'after a stop, pocket is verified again rather than demoted forever');

  stopAudioWorker();
  __setVoiceTestHooks({});
});
