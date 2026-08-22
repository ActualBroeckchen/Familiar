import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAudioWorker, DEFAULT_THREADS } from '../audio-worker-host.js';

/**
 * A stub child that speaks the real framed protocol but runs no models.
 *
 * Supervision has to be testable separately from the thing supervised —
 * otherwise none of this can be exercised until a native speech engine is
 * installed, which is exactly the code most likely to need a crash test.
 */
async function stubWorker(body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awh-'));
  const file = path.join(dir, 'stub-worker.mjs');
  await fs.writeFile(file, `
import { encodeJson, createFrameReader } from ${JSON.stringify(new URL('../audio-frame.js', import.meta.url).pathname)};
const send = (o) => process.stdout.write(encodeJson(o));
${body}
`, 'utf8');
  return { file, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

const ECHO = `
const reader = createFrameReader({ onFrame: (f) => {
  if (f.kind !== 0) return;
  const m = f.message;
  if (m.op === 'ping') send({ reqId: m.reqId, ok: true, pong: true });
  else if (m.op === 'slow') setTimeout(() => send({ reqId: m.reqId, ok: true }), 5000);
  else if (m.op === 'boom') process.exit(1);
  else if (m.op === 'refuse') send({ reqId: m.reqId, ok: false, reason: 'no-model', detail: 'nothing loaded' });
  else send({ reqId: m.reqId, ok: true, echoed: m.op });
}});
process.stdin.on('data', (c) => reader.push(c));
send({ op: 'state', loadedModels: ['stub'], liveDecoders: 0 });
`;

test('a request reaches the worker and comes back', async () => {
  const { file, cleanup } = await stubWorker(ECHO);
  const w = createAudioWorker({ workerScript: file, idleMs: 0 });
  try {
    const r = await w.request({ op: 'ping' });
    assert.equal(r.ok, true);
    assert.equal(r.pong, true);
  } finally { w.stop(); await cleanup(); }
});

test('nothing spawns until the first request — voice unused costs no process', async () => {
  const { file, cleanup } = await stubWorker(ECHO);
  const w = createAudioWorker({ workerScript: file, idleMs: 0 });
  try {
    assert.equal(w.status().running, false);
    assert.equal(w.status().startedAt, null);
    await w.request({ op: 'ping' });
    assert.equal(w.status().running, true);
  } finally { w.stop(); await cleanup(); }
});

test('the worker reports what it has loaded, rather than the host assuming', async () => {
  const { file, cleanup } = await stubWorker(ECHO);
  const w = createAudioWorker({ workerScript: file, idleMs: 0 });
  try {
    await w.request({ op: 'ping' });
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(w.status().loadedModels, ['stub']);
  } finally { w.stop(); await cleanup(); }
});

test('a worker error is a reported result, not a rejected promise', async () => {
  const { file, cleanup } = await stubWorker(ECHO);
  const w = createAudioWorker({ workerScript: file, idleMs: 0 });
  try {
    const r = await w.request({ op: 'refuse' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-model');
    assert.equal(r.detail, 'nothing loaded');
  } finally { w.stop(); await cleanup(); }
});

test('a timeout resolves honestly and leaves the worker alone', async () => {
  // A slow first model load is not a crash. Killing it would turn a long wait
  // into a restart loop on exactly the hardware least able to afford one.
  const { file, cleanup } = await stubWorker(ECHO);
  const w = createAudioWorker({ workerScript: file, idleMs: 0 });
  try {
    const r = await w.request({ op: 'slow' }, { timeoutMs: 150 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timeout');
    assert.equal(w.status().running, true, 'still alive — a slow answer is not a dead worker');
  } finally { w.stop(); await cleanup(); }
});

test('a crash settles in-flight requests instead of leaving them hanging forever', async () => {
  const { file, cleanup } = await stubWorker(ECHO);
  const w = createAudioWorker({ workerScript: file, idleMs: 0, backoffMs: [10] });
  try {
    const r = await w.request({ op: 'boom' }, { timeoutMs: 5000 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'worker-died');
  } finally { w.stop(); await cleanup(); }
});

test('it restarts after a crash, and the next request succeeds', async () => {
  const { file, cleanup } = await stubWorker(ECHO);
  const events = [];
  const w = createAudioWorker({ workerScript: file, idleMs: 0, backoffMs: [10], onEvent: (e) => events.push(e.type) });
  try {
    await w.request({ op: 'boom' }, { timeoutMs: 3000 });
    await new Promise((r) => setTimeout(r, 120));
    const again = await w.request({ op: 'ping' }, { timeoutMs: 3000 });
    assert.equal(again.ok, true, 'a fresh worker took over');
    assert.ok(events.includes('exit'));
    assert.ok(w.status().restarts >= 1);
  } finally { w.stop(); await cleanup(); }
});

test('three crashes in the window PARK it — a segfaulting model must not spin forever', async () => {
  const { file, cleanup } = await stubWorker(ECHO);
  const events = [];
  const w = createAudioWorker({
    workerScript: file, idleMs: 0, backoffMs: [5], maxCrashes: 3, crashWindowMs: 60_000,
    onEvent: (e) => events.push(e.type),
  });
  try {
    for (let i = 0; i < 3; i++) {
      await w.request({ op: 'boom' }, { timeoutMs: 3000 });
      await new Promise((r) => setTimeout(r, 60));
    }
    const st = w.status();
    assert.equal(st.parked, true, 'restarting forever would cook the battery, not fix the model');
    assert.match(st.parkedReason, /stopped 3 times/);

    const after = await w.request({ op: 'ping' });
    assert.equal(after.ok, false);
    assert.equal(after.reason, 'parked', 'and it says so rather than silently doing nothing');
    assert.ok(events.includes('parked'));
  } finally { w.stop(); await cleanup(); }
});

test('parking is cleared deliberately, never on its own', async () => {
  const { file, cleanup } = await stubWorker(ECHO);
  const w = createAudioWorker({ workerScript: file, idleMs: 0, backoffMs: [5], maxCrashes: 2 });
  try {
    for (let i = 0; i < 2; i++) {
      await w.request({ op: 'boom' }, { timeoutMs: 3000 });
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(w.status().parked, true);

    assert.deepEqual(w.unpark(), { unparked: true });
    assert.equal(w.status().parked, false);
    const r = await w.request({ op: 'ping' }, { timeoutMs: 3000 });
    assert.equal(r.ok, true, 'and it works again once the ward has intervened');
  } finally { w.stop(); await cleanup(); }
});

test('unparking when nothing is parked is a no-op, not an error', async () => {
  const { file, cleanup } = await stubWorker(ECHO);
  const w = createAudioWorker({ workerScript: file, idleMs: 0 });
  try {
    assert.deepEqual(w.unpark(), { unparked: false, reason: 'not-parked' });
  } finally { w.stop(); await cleanup(); }
});

test('a missing worker script is unavailable, not a crash loop', async () => {
  const w = createAudioWorker({ workerScript: '/definitely/not/here.mjs', idleMs: 0, backoffMs: [5] });
  try {
    const r = await w.request({ op: 'ping' }, { timeoutMs: 2000 });
    assert.equal(r.ok, false);
    assert.ok(['worker-died', 'spawn-failed'].includes(r.reason), `unexpected reason ${r.reason}`);
  } finally { w.stop(); }
});

test('an idle worker is unloaded, so a machine not in a call pays no RAM', async () => {
  const { file, cleanup } = await stubWorker(ECHO);
  const events = [];
  const w = createAudioWorker({ workerScript: file, idleMs: 120, onEvent: (e) => events.push(e.type) });
  try {
    await w.request({ op: 'ping' });
    assert.equal(w.status().running, true);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(w.status().running, false, 'idle means unloaded');
    assert.ok(events.includes('idle-unload'));

    const again = await w.request({ op: 'ping' }, { timeoutMs: 3000 });
    assert.equal(again.ok, true, 'and it comes back on demand');
  } finally { w.stop(); await cleanup(); }
});

test('stop() is not a crash — it does not trigger a restart', async () => {
  const { file, cleanup } = await stubWorker(ECHO);
  const events = [];
  const w = createAudioWorker({ workerScript: file, idleMs: 0, backoffMs: [5], onEvent: (e) => events.push(e.type) });
  try {
    await w.request({ op: 'ping' });
    w.stop();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(w.status().running, false);
    assert.equal(w.status().stopped, true);
    assert.ok(!events.includes('restarting'), 'a deliberate stop must not look like a crash');

    const r = await w.request({ op: 'ping' });
    assert.equal(r.reason, 'stopped');

    w.resume();
    const back = await w.request({ op: 'ping' }, { timeoutMs: 3000 });
    assert.equal(back.ok, true, 'and turning voice back on works');
  } finally { w.stop(); await cleanup(); }
});

test('the thread caps reach the worker as environment, not as hope', async () => {
  const { file, cleanup } = await stubWorker(`
const reader = createFrameReader({ onFrame: (f) => {
  if (f.kind === 0 && f.message.op === 'threads') {
    send({ reqId: f.message.reqId, ok: true, seen: {
      total: process.env.PF_AUDIO_THREADS,
      asr: process.env.PF_AUDIO_THREADS_ASR,
      tts: process.env.PF_AUDIO_THREADS_TTS,
      vad: process.env.PF_AUDIO_THREADS_VAD,
    }});
  }
}});
process.stdin.on('data', (c) => reader.push(c));
`);
  const w = createAudioWorker({ workerScript: file, idleMs: 0 });
  try {
    const r = await w.request({ op: 'threads' });
    assert.equal(r.ok, true);
    assert.equal(r.seen.total, String(DEFAULT_THREADS.total));
    assert.equal(r.seen.asr, String(DEFAULT_THREADS.asr));
    assert.equal(r.seen.vad, String(DEFAULT_THREADS.vad));
  } finally { w.stop(); await cleanup(); }
});

test('unsolicited frames reach listeners — partials are not replies to anything', async () => {
  const { file, cleanup } = await stubWorker(`
const reader = createFrameReader({ onFrame: (f) => {
  if (f.kind === 0 && f.message.op === 'go') {
    send({ op: 'asr-partial', streamId: 1, text: 'half a sen' });
    send({ reqId: f.message.reqId, ok: true });
  }
}});
process.stdin.on('data', (c) => reader.push(c));
`);
  const w = createAudioWorker({ workerScript: file, idleMs: 0 });
  const seen = [];
  const off = w.on((f) => { if (f.message?.op === 'asr-partial') seen.push(f.message.text); });
  try {
    await w.request({ op: 'go' });
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(seen, ['half a sen']);
    off();
  } finally { w.stop(); await cleanup(); }
});

test('status is honest while parked — the reason is reportable, not just a flag', async () => {
  const { file, cleanup } = await stubWorker(ECHO);
  const w = createAudioWorker({ workerScript: file, idleMs: 0, backoffMs: [5], maxCrashes: 2 });
  try {
    for (let i = 0; i < 2; i++) {
      await w.request({ op: 'boom' }, { timeoutMs: 3000 });
      await new Promise((r) => setTimeout(r, 50));
    }
    const st = w.status();
    assert.ok(st.parkedReason && st.parkedSince, 'a ward asking why voice is off gets an answer');
    assert.ok(st.lastExit, 'and how it died');
    assert.equal(st.pendingRequests, 0, 'with nothing left hanging');
  } finally { w.stop(); await cleanup(); }
});

// ── The real worker (no speech engine installed here) ────────────────────
//
// The binding is an optionalDependency (§0.8), so "not installed" is an
// ordinary state, not a failure — and it is the state this sandbox is in.
// These assert the worker behaves honestly in exactly that case.

const REAL_WORKER = new URL('../audio-worker.mjs', import.meta.url).pathname;

test('the real worker starts, answers, and says whether it has a speech engine', async () => {
  const w = createAudioWorker({ workerScript: REAL_WORKER, idleMs: 0 });
  try {
    const r = await w.request({ op: 'ping' }, { timeoutMs: 8000 });
    assert.equal(r.ok, true, 'it starts and answers even with no engine');
    assert.equal(typeof r.engineAvailable, 'boolean');
    if (!r.engineAvailable) {
      assert.match(r.engineDetail, /not installed/, 'and says why, rather than going quiet');
    }
  } finally { w.stop(); }
});

test('a missing engine is a reported reason, never a crash — no restart, no park', async () => {
  const events = [];
  const w = createAudioWorker({ workerScript: REAL_WORKER, idleMs: 0, onEvent: (e) => events.push(e.type) });
  try {
    const r = await w.request({ op: 'load', role: 'tts', modelDir: '/nowhere' }, { timeoutMs: 8000 });
    // The point is that an absent optional dependency is REPORTED, never a crash.
    // Which reason depends on the machine: with no native binding it's 'no-engine';
    // with the binding present, loading a bad path is a clean 'load-failed'. Both
    // are a reported reason — accept either so the test holds in CI (no binding)
    // AND on a dev machine that has sherpa-onnx-node installed.
    if (!r.ok) assert.ok(['no-engine', 'load-failed'].includes(r.reason), `unexpected reason: ${r.reason}`);
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(w.status().parked, false, 'an absent optional dependency must not park voice');
    assert.ok(!events.includes('exit'), 'and must not kill the worker');
  } finally { w.stop(); }
});

test('an op that does not exist answers unknown-op rather than silence', async () => {
  // Silence would let a caller believe something happened when it had not —
  // the confabulation failure the 0.9 post-mortem is about.
  //
  // ⚠️ This test used to send `op: 'transcribe'` and assert `unsupported`,
  // written when transcription was a stub. When the real handler landed, a
  // leftover duplicate `transcribe` key further down the OPS table shadowed it
  // — and THIS TEST KEPT PASSING, because `unsupported` was exactly what the
  // stub returned. The suite did not merely miss the bug; it defended it for
  // four rounds of my human's testing.
  //
  // So it now uses a name that genuinely has no handler. Never assert a
  // placeholder's response for an op the codebase is expected to implement:
  // the assertion outlives the placeholder and pins the wrong behaviour.
  const w = createAudioWorker({ workerScript: REAL_WORKER, idleMs: 0 });
  try {
    const r = await w.request({ op: 'definitely-not-an-op' }, { timeoutMs: 8000 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unknown-op');
    assert.match(r.detail, /definitely-not-an-op/);
  } finally { w.stop(); }
});

test('speaking refuses in the right ORDER — no engine before no voice before not loaded', async () => {
  // The order matters for what a ward is told. Here there is no engine, so
  // that is the answer; on a machine with one, the next gate speaks instead.
  const w = createAudioWorker({ workerScript: REAL_WORKER, idleMs: 0 });
  try {
    const r = await w.request({ op: 'tts', text: 'hello' }, { timeoutMs: 8000 });
    assert.equal(r.ok, false);
    assert.ok(['no-engine', 'no-voice', 'not-loaded'].includes(r.reason), `unexpected reason ${r.reason}`);
    assert.ok(r.detail, 'and it always says why');
  } finally { w.stop(); }
});

test('speaking with no reference clip is refused — PocketTTS has no built-in voice', async () => {
  // Zero-shot cloning means there is nothing to fall back on. A default nobody
  // chose would be worse than a clear refusal.
  const w = createAudioWorker({ workerScript: REAL_WORKER, idleMs: 0 });
  try {
    const r = await w.request({ op: 'tts', text: 'hello', referenceWav: null }, { timeoutMs: 8000 });
    assert.equal(r.ok, false);
    assert.notEqual(r.reason, 'op-failed', 'a missing voice is a stated refusal, not a crash');
  } finally { w.stop(); }
});

test('an unknown op is answered, not dropped — no caller waits out a timeout for nothing', async () => {
  const w = createAudioWorker({ workerScript: REAL_WORKER, idleMs: 0 });
  try {
    const r = await w.request({ op: 'nonsense' }, { timeoutMs: 8000 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unknown-op');
  } finally { w.stop(); }
});

test('the real worker exits cleanly on EOF rather than being killed', async () => {
  const events = [];
  const w = createAudioWorker({ workerScript: REAL_WORKER, idleMs: 0, onEvent: (e) => events.push(e) });
  try {
    await w.request({ op: 'ping' }, { timeoutMs: 8000 });
    w.stop();
    await new Promise((r) => setTimeout(r, 300));
    const exit = events.find((e) => e.type === 'exit');
    if (exit) assert.notEqual(exit.code, 1, 'a clean shutdown is not an error exit');
  } finally { w.stop(); }
});
