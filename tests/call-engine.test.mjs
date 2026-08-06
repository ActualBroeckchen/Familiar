import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCallEngine, clearStaleCallState, isCallActiveFromFile } from '../call-engine.js';
import { floatToPcm16, parseWav } from '../voice-audio-features.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'ce-'));
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** A worker stub with the {request, sendPcm, on} shape, plus `emit` to inject frames. */
function fakeWorker() {
  let listener = null;
  const calls = { requests: [], pcm: [] };
  return {
    request: async (m) => { calls.requests.push(m); return { ok: true, ...m }; },
    sendPcm: async (streamId, pcm) => { calls.pcm.push({ streamId, len: pcm.length }); return { ok: true }; },
    on: (l) => { listener = l; return () => { listener = null; }; },
    emit: (message) => listener?.({ kind: 0, message }),
    calls,
  };
}

/** A transport-only adapter that records what the engine asked of it. */
function fakeAdapterFactory(rec) {
  return (hooks) => {
    rec.hooks = hooks;
    return {
      id: 'fake',
      capabilities: { perSpeakerStreams: true, roster: false, ring: false },
      joinCall: async (target) => { rec.joined = target; return { callId: 'c1' }; },
      leaveCall: async (id) => { rec.left = id; },
      playAudio: async (id, reply) => { rec.played.push({ id, reply }); },
      stopPlayback: async () => { rec.stopped = true; },
    };
  };
}

test('registered adapters are enumerable; a factory with no id is dropped', () => {
  const engine = createCallEngine({ worker: fakeWorker(), onTurn: async () => null });
  engine.registerCallAdapter(fakeAdapterFactory({ played: [] }));
  engine.registerCallAdapter(() => ({ /* no id */ capabilities: {} }));
  assert.deepEqual(engine.adapterIds(), ['fake']);
});

test('audio → transcript → turn → playback, then a clean end', async () => {
  const dir = await tmp();
  try {
    const rec = { played: [] };
    const worker = fakeWorker();
    const turns = [];
    const engine = createCallEngine({
      worker,
      onTurn: async (t, ctx) => { turns.push({ t, ctx }); return `SPOKEN:${t}`; },
      streamingModelDir: '',  // no model in a pure test
      tomesDir: dir,
    });
    engine.registerCallAdapter(fakeAdapterFactory(rec));

    const start = await engine.startCall('fake', 'room-1');
    assert.equal(start.ok, true);
    assert.equal(start.callId, 'c1');
    assert.equal(engine.isCallActive(), true);
    assert.equal(await isCallActiveFromFile(dir), true, 'call-state file went active');
    assert.equal(rec.joined, 'room-1');

    // First audio for a speaker opens exactly one ASR stream, then feeds it.
    await rec.hooks.pushAudio({ callId: 'c1', speakerRef: 'ward', pcm: Buffer.alloc(320) });
    await rec.hooks.pushAudio({ callId: 'c1', speakerRef: 'ward', pcm: Buffer.alloc(320) });
    const opens = worker.calls.requests.filter((r) => r.op === 'asrStream');
    assert.equal(opens.length, 1, 'one stream per speaker, not one per frame');
    assert.equal(worker.calls.pcm.length, 2, 'both frames were forwarded');

    // The worker reports an endpoint → the engine assembles a turn and speaks it.
    worker.emit({ op: 'asr-final', streamId: opens[0].streamId, text: 'hello there' });
    await tick();
    assert.equal(turns.length, 1);
    assert.equal(turns[0].t, 'hello there');
    assert.equal(turns[0].ctx.speakerRef, 'ward');
    assert.equal(rec.played[0].reply, 'SPOKEN:hello there');

    const end = await engine.endCall();
    assert.equal(end.wasActive, true);
    assert.equal(engine.isCallActive(), false);
    assert.equal(await isCallActiveFromFile(dir), false, 'call-state file cleared');
    assert.equal(rec.left, 'c1');
    assert.ok(worker.calls.requests.some((r) => r.op === 'asrStreamStop'), 'the stream was closed');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('endUtterance (push-to-talk release) stops the stream and reopens it for the next press', async () => {
  const dir = await tmp();
  try {
    const worker = fakeWorker();
    const rec = { played: [] };
    const engine = createCallEngine({ worker, onTurn: async () => 'x', tomesDir: dir });
    engine.registerCallAdapter(fakeAdapterFactory(rec));
    const start = await engine.startCall('fake');
    await rec.hooks.pushAudio({ callId: start.callId, speakerRef: 'ward', pcm: Buffer.alloc(320) });
    const streamId = worker.calls.requests.find((r) => r.op === 'asrStream').streamId;

    await rec.hooks.endUtterance({ callId: start.callId, speakerRef: 'ward' });
    const ops = worker.calls.requests.map((r) => r.op);
    // open, then (on release) stop, then reopen — same streamId throughout
    assert.deepEqual(ops, ['asrStream', 'asrStreamStop', 'asrStream']);
    assert.ok(worker.calls.requests.every((r) => !('streamId' in r) || r.streamId === streamId));
    await engine.endCall();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('stray audio for no call, and an empty final, are ignored not crashed', async () => {
  const dir = await tmp();
  try {
    const worker = fakeWorker();
    const turns = [];
    const rec = { played: [] };
    const engine = createCallEngine({ worker, onTurn: async (t) => { turns.push(t); return 'x'; }, tomesDir: dir });
    engine.registerCallAdapter(fakeAdapterFactory(rec));
    // no call yet — pushing audio must not throw or open a stream
    await rec.hooks?.pushAudio?.({ callId: 'c1', speakerRef: 'ward', pcm: Buffer.alloc(160) });
    assert.equal(worker.calls.requests.length, 0);

    await engine.startCall('fake');
    worker.emit({ op: 'asr-final', streamId: 999, text: '   ' }); // whitespace-only, unknown stream
    await tick();
    assert.equal(turns.length, 0, 'an empty transcript is not a turn');
    await engine.endCall();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('speakProactive speaks at a gap and resolves once actually heard', async () => {
  const dir = await tmp();
  try {
    const rec = { played: [] };
    const engine = createCallEngine({ worker: fakeWorker(), onTurn: async () => null, tomesDir: dir });
    engine.registerCallAdapter(fakeAdapterFactory(rec));
    await engine.startCall('fake');
    // No inbound audio yet → lastUserAudioAt is 0 → the gap is open right now.
    const reply = { sampleRate: 24000, async *[Symbol.asyncIterator]() { yield Buffer.alloc(8); } };
    const heard = await engine.speakProactive(() => reply);
    assert.equal(heard, true, 'resolves true only once spoken');
    assert.ok(rec.played.some((p) => p.reply === reply), 'the proactive reply reached the adapter');
    await engine.endCall();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a queued proactive item resolves false if the call ends before a gap opens', async () => {
  const dir = await tmp();
  try {
    const rec = { played: [] };
    const engine = createCallEngine({ worker: fakeWorker(), onTurn: async () => null, tomesDir: dir });
    // isSpeaking() always true → the gap never opens on its own, so the item stays queued.
    engine.registerCallAdapter((hooks) => {
      rec.hooks = hooks;
      return {
        id: 'fake', capabilities: { perSpeakerStreams: true },
        joinCall: async () => ({ callId: 'c1' }),
        leaveCall: async () => {},
        playAudio: async (id, reply) => { rec.played.push({ id, reply }); },
        isSpeaking: () => true,
      };
    });
    await engine.startCall('fake');
    const p = engine.speakProactive(() => ({ async *[Symbol.asyncIterator]() { yield Buffer.alloc(8); } }));
    await tick();
    await engine.endCall();
    assert.equal(await p, false, 'ending the call resolves the un-spoken item as NOT heard');
    assert.equal(rec.played.length, 0, 'and it never played — the escalation clock must not count it');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('one call at a time; a second start is refused as busy', async () => {
  const dir = await tmp();
  try {
    const engine = createCallEngine({ worker: fakeWorker(), onTurn: async () => null, tomesDir: dir });
    engine.registerCallAdapter(fakeAdapterFactory({ played: [] }));
    const a = await engine.startCall('fake');
    const b = await engine.startCall('fake');
    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
    assert.equal(b.reason, 'busy');
    await engine.endCall();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('startCall with no adapter, and endCall with no call, both answer honestly', async () => {
  const dir = await tmp();
  try {
    const engine = createCallEngine({ worker: fakeWorker(), onTurn: async () => null, tomesDir: dir });
    assert.equal((await engine.startCall('fake')).reason, 'no-adapter');
    assert.deepEqual(await engine.endCall(), { ok: true, wasActive: false });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('the hard off-switch refuses to start a call', async () => {
  const dir = await tmp();
  const prev = process.env.PROTO_FAMILIAR_VOICE_CALL_DISABLED;
  process.env.PROTO_FAMILIAR_VOICE_CALL_DISABLED = '1';
  try {
    const engine = createCallEngine({ worker: fakeWorker(), onTurn: async () => null, tomesDir: dir });
    engine.registerCallAdapter(fakeAdapterFactory({ played: [] }));
    assert.equal((await engine.startCall('fake')).reason, 'disabled');
  } finally {
    if (prev === undefined) delete process.env.PROTO_FAMILIAR_VOICE_CALL_DISABLED;
    else process.env.PROTO_FAMILIAR_VOICE_CALL_DISABLED = prev;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a stale active call-state file is cleared at boot, and reads fail-safe', async () => {
  const dir = await tmp();
  try {
    await fs.writeFile(path.join(dir, '.call-state.json'), JSON.stringify({ active: true, callId: 'ghost' }));
    assert.equal(await isCallActiveFromFile(dir), true);
    await clearStaleCallState(dir);
    assert.equal(await isCallActiveFromFile(dir), false);
    // a missing / broken file is never "active"
    assert.equal(await isCallActiveFromFile(path.join(dir, 'nowhere')), false);
    await fs.writeFile(path.join(dir, '.call-state.json'), 'not json');
    assert.equal(await isCallActiveFromFile(dir), false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ── End-to-end through the REAL worker (guarded; skips in CI) ────────────
const MODEL_DIR = process.env.PF_ASR_STREAMING_MODEL_DIR || '';
const canRun = MODEL_DIR && existsSync(MODEL_DIR)
  && existsSync(path.join(REPO, 'node_modules', 'sherpa-onnx-node'))
  && existsSync(path.join(MODEL_DIR, 'test_wavs', '0.wav'));

test('real worker: a wav pushed through the adapter drives a transcript turn', { skip: canRun ? false : 'set PF_ASR_STREAMING_MODEL_DIR (and install sherpa-onnx-node) to run' }, async () => {
  const dir = await tmp();
  const { createAudioWorker } = await import('../audio-worker-host.js');
  const worker = createAudioWorker({ idleMs: 0 });
  const rec = { played: [] };
  const turns = [];
  const engine = createCallEngine({ worker, onTurn: async (t) => { turns.push(t); return 'ok'; }, streamingModelDir: MODEL_DIR, tomesDir: dir });
  engine.registerCallAdapter(fakeAdapterFactory(rec));
  try {
    const start = await engine.startCall('fake');
    assert.equal(start.ok, true, `startCall: ${JSON.stringify(start)}`);

    const { samples } = parseWav(readFileSync(path.join(MODEL_DIR, 'test_wavs', '0.wav')));
    const pcm = floatToPcm16(samples);
    const CHUNK = 3200;
    for (let i = 0; i < pcm.length; i += CHUNK) {
      await rec.hooks.pushAudio({ callId: start.callId, speakerRef: 'ward', pcm: pcm.subarray(i, i + CHUNK) });
      await tick(2);
    }
    // Push-to-talk release: finalise the utterance (this wav has no long trailing
    // silence, so no mid-stream endpoint fires — the release is the boundary).
    await rec.hooks.endUtterance({ callId: start.callId, speakerRef: 'ward' });
    for (let i = 0; i < 100 && turns.length === 0; i++) await tick(20);

    assert.ok(turns.length > 0, 'a transcript turn fired from the streamed audio');
    assert.match(turns.join(' ').toUpperCase(), /YELLOW LAMPS/);
    assert.ok(rec.played.length > 0, 'the reply was handed to the adapter to speak');
  } finally {
    await engine.endCall();
    worker.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
