import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCallEngine, clearStaleCallState, isCallActiveFromFile, isCallActiveFromFileSync, spokenTextForMs } from '../call-engine.js';
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

test('speaker embedding: a finalized utterance is embedded and the vector rides to onTurn (§8.2)', async () => {
  const dir = await tmp();
  try {
    const worker = fakeWorker();
    const rec = { played: [] };
    const turns = [];
    const embedCalls = [];
    const engine = createCallEngine({
      worker,
      onTurn: async (_t, ctx) => { turns.push(ctx); return null; },
      embedSegment: async (samples, rate) => { embedCalls.push({ len: samples.length, rate }); return [0.5, 0.5]; },
      tomesDir: dir,
    });
    engine.registerCallAdapter(fakeAdapterFactory(rec));
    await engine.startCall('fake', 'room');

    // Ward speaks (640 bytes PCM16 = 320 samples), then releases → finalize embeds.
    await rec.hooks.pushAudio({ callId: 'c1', speakerRef: 'ward', pcm: Buffer.alloc(640) });
    await rec.hooks.endUtterance({ callId: 'c1', speakerRef: 'ward' });
    await tick();
    assert.equal(embedCalls.length, 1, 'the utterance was embedded once on release');
    assert.equal(embedCalls[0].len, 320, 'PCM16 → float samples');
    assert.equal(embedCalls[0].rate, 16000);

    // The asr-final drives the turn, which carries the freshly-computed embedding.
    const opens = worker.calls.requests.filter((r) => r.op === 'asrStream');
    worker.emit({ op: 'asr-final', streamId: opens[0].streamId, text: 'hey' });
    await tick();
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0].embedding, [0.5, 0.5], 'the voiceprint rode to onTurn for the guard');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('no embedSegment → no embedding work, ctx.embedding is null (off by default)', async () => {
  const dir = await tmp();
  try {
    const worker = fakeWorker();
    const rec = { played: [] };
    const turns = [];
    const engine = createCallEngine({ worker, onTurn: async (_t, ctx) => { turns.push(ctx); return null; }, tomesDir: dir });
    engine.registerCallAdapter(fakeAdapterFactory(rec));
    await engine.startCall('fake', 'room');
    await rec.hooks.pushAudio({ callId: 'c1', speakerRef: 'ward', pcm: Buffer.alloc(640) });
    await rec.hooks.endUtterance({ callId: 'c1', speakerRef: 'ward' });
    await tick();
    const opens = worker.calls.requests.filter((r) => r.op === 'asrStream');
    worker.emit({ op: 'asr-final', streamId: opens[0].streamId, text: 'hey' });
    await tick();
    assert.equal(turns[0].embedding, null, 'speaker ID off → no vector, no behavior change');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('diarization (§8.3): a mixed-stream utterance is attributed to the diarized speaker', async () => {
  const dir = await tmp();
  try {
    const worker = fakeWorker();
    const rec = { played: [] };
    const turns = [];
    const diarizeCalls = [];
    const engine = createCallEngine({
      worker,
      onTurn: async (_t, ctx) => { turns.push(ctx); return null; },
      embedSegment: async () => [0.1, 0.2, 0.3],
      // A mixed stream can't tell us who spoke — this resolves it to a villager.
      diarize: async (emb, o) => { diarizeCalls.push({ emb, o }); return { ref: 'villager-jules', name: 'Jules' }; },
      diarizeSegments: () => true,
      tomesDir: dir,
    });
    engine.registerCallAdapter(fakeAdapterFactory(rec));
    await engine.startCall('fake', 'room');

    // Audio arrives on the adapter's single mixed-stream ref ('ward'); the
    // recogniser endpoints the utterance itself (open-mic — no PTT release).
    await rec.hooks.pushAudio({ callId: 'c1', speakerRef: 'ward', pcm: Buffer.alloc(640) });
    const open = worker.calls.requests.find((r) => r.op === 'asrStream');
    worker.emit({ op: 'asr-final', streamId: open.streamId, text: 'who is this' });
    await tick(20);

    assert.equal(diarizeCalls.length, 1, 'the utterance was diarized once');
    assert.deepEqual(diarizeCalls[0].emb, [0.1, 0.2, 0.3], 'the embedding was handed to the matcher');
    assert.equal(typeof diarizeCalls[0].o.callId, 'string', 'the call id scopes the diarizer');
    assert.equal(turns.length, 1);
    assert.equal(turns[0].speakerRef, 'villager-jules', 'the turn is attributed to the diarized speaker, not the adapter ref');
    assert.equal(turns[0].speakerName, 'Jules', 'the resolved name rides to onTurn');
    assert.deepEqual(turns[0].embedding, [0.1, 0.2, 0.3], 'the embedding rides too');
    await engine.endCall();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('diarizeSegments()=false keeps the adapter ref — push-to-talk / per-speaker unaffected', async () => {
  const dir = await tmp();
  try {
    const worker = fakeWorker();
    const rec = { played: [] };
    const turns = [];
    let diarizeCalled = false;
    const engine = createCallEngine({
      worker,
      onTurn: async (_t, ctx) => { turns.push(ctx); return null; },
      embedSegment: async () => [0.9],
      diarize: async () => { diarizeCalled = true; return { ref: 'guest-1' }; },
      diarizeSegments: () => false,   // per-speaker adapter → diarization off
      tomesDir: dir,
    });
    engine.registerCallAdapter(fakeAdapterFactory(rec));
    await engine.startCall('fake');
    await rec.hooks.pushAudio({ callId: 'c1', speakerRef: 'ward', pcm: Buffer.alloc(640) });
    await rec.hooks.endUtterance({ callId: 'c1', speakerRef: 'ward' });   // PTT release embeds
    const open = worker.calls.requests.find((r) => r.op === 'asrStream');
    worker.emit({ op: 'asr-final', streamId: open.streamId, text: 'hey' });
    await tick(20);
    assert.equal(diarizeCalled, false, 'diarization never ran on a per-speaker stream');
    assert.equal(turns[0].speakerRef, 'ward', 'the adapter ref is preserved');
    assert.equal(turns[0].speakerName, null, 'no diarized name on the PTT path');
    await engine.endCall();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a null diarization keeps the adapter ref (no ward print baseline → stays ward)', async () => {
  const dir = await tmp();
  try {
    const worker = fakeWorker();
    const rec = { played: [] };
    const turns = [];
    const engine = createCallEngine({
      worker,
      onTurn: async (_t, ctx) => { turns.push(ctx); return null; },
      embedSegment: async () => [0.4, 0.4],
      diarize: async () => null,   // e.g. no ward print to contrast against
      diarizeSegments: () => true,
      tomesDir: dir,
    });
    engine.registerCallAdapter(fakeAdapterFactory(rec));
    await engine.startCall('fake');
    await rec.hooks.pushAudio({ callId: 'c1', speakerRef: 'ward', pcm: Buffer.alloc(640) });
    const open = worker.calls.requests.find((r) => r.op === 'asrStream');
    worker.emit({ op: 'asr-final', streamId: open.streamId, text: 'hi' });
    await tick(20);
    assert.equal(turns[0].speakerRef, 'ward', 'a null resolution leaves the call ward-private by default');
    assert.deepEqual(turns[0].embedding, [0.4, 0.4], 'the embedding was still computed and rode along');
    await engine.endCall();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('room-sound tagging (§8.4): a finalized utterance is tagged and the events ride to onTurn', async () => {
  const dir = await tmp();
  try {
    const worker = fakeWorker();
    const rec = { played: [] };
    const turns = [];
    const tagCalls = [];
    const engine = createCallEngine({
      worker,
      onTurn: async (_t, ctx) => { turns.push(ctx); return null; },
      // No speaker ID this call — tagging must run independently of it.
      tagSegment: async (samples, rate) => { tagCalls.push({ len: samples.length, rate }); return [{ name: 'Dog', prob: 0.9 }]; },
      tomesDir: dir,
    });
    engine.registerCallAdapter(fakeAdapterFactory(rec));
    await engine.startCall('fake', 'room');

    await rec.hooks.pushAudio({ callId: 'c1', speakerRef: 'ward', pcm: Buffer.alloc(640) });
    await rec.hooks.endUtterance({ callId: 'c1', speakerRef: 'ward' });   // PTT release → analyse + tag
    await tick();
    assert.equal(tagCalls.length, 1, 'the utterance was tagged once, with no speaker model loaded');
    assert.equal(tagCalls[0].len, 320, 'PCM16 → float samples');
    assert.equal(tagCalls[0].rate, 16000);

    const opens = worker.calls.requests.filter((r) => r.op === 'asrStream');
    worker.emit({ op: 'asr-final', streamId: opens[0].streamId, text: 'hey' });
    await tick();
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0].roomSounds, [{ name: 'Dog', prob: 0.9 }], 'the raw events rode to onTurn for the caller to classify');
    await engine.endCall();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('embedding and tagging share ONE materialised copy of the utterance (both ride to onTurn)', async () => {
  const dir = await tmp();
  try {
    const worker = fakeWorker();
    const rec = { played: [] };
    const turns = [];
    let embeds = 0, tags = 0;
    const engine = createCallEngine({
      worker,
      onTurn: async (_t, ctx) => { turns.push(ctx); return null; },
      embedSegment: async () => { embeds++; return [0.1, 0.2]; },
      tagSegment: async () => { tags++; return [{ name: 'Television', prob: 0.8 }]; },
      tomesDir: dir,
    });
    engine.registerCallAdapter(fakeAdapterFactory(rec));
    await engine.startCall('fake');
    await rec.hooks.pushAudio({ callId: 'c1', speakerRef: 'ward', pcm: Buffer.alloc(640) });
    await rec.hooks.endUtterance({ callId: 'c1', speakerRef: 'ward' });
    await tick();
    const open = worker.calls.requests.find((r) => r.op === 'asrStream');
    worker.emit({ op: 'asr-final', streamId: open.streamId, text: 'hi' });
    await tick();
    assert.equal(embeds, 1, 'embedded once');
    assert.equal(tags, 1, 'tagged once');
    assert.deepEqual(turns[0].embedding, [0.1, 0.2]);
    assert.deepEqual(turns[0].roomSounds, [{ name: 'Television', prob: 0.8 }]);
    await engine.endCall();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('no tagSegment → ctx.roomSounds is null (off by default)', async () => {
  const dir = await tmp();
  try {
    const worker = fakeWorker();
    const rec = { played: [] };
    const turns = [];
    const engine = createCallEngine({ worker, onTurn: async (_t, ctx) => { turns.push(ctx); return null; }, tomesDir: dir });
    engine.registerCallAdapter(fakeAdapterFactory(rec));
    await engine.startCall('fake');
    await rec.hooks.pushAudio({ callId: 'c1', speakerRef: 'ward', pcm: Buffer.alloc(640) });
    await rec.hooks.endUtterance({ callId: 'c1', speakerRef: 'ward' });
    await tick();
    const open = worker.calls.requests.find((r) => r.op === 'asrStream');
    worker.emit({ op: 'asr-final', streamId: open.streamId, text: 'hi' });
    await tick();
    assert.equal(turns[0].roomSounds, null, 'tagging off → no events, no behaviour change');
    await engine.endCall();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('hybrid ASR: offlineFinal loads the offline model and flags the stream; off does neither', async () => {
  // ON: offlineFinal() true + a model dir → startCall loads asr-offline, and every
  // asrStream the engine opens carries offlineFinal:true so the worker re-transcribes.
  {
    const dir = await tmp();
    try {
      const worker = fakeWorker();
      const rec = { played: [] };
      const engine = createCallEngine({
        worker, onTurn: async () => null, tomesDir: dir,
        streamingModelDir: '/models/stream', offlineModelDir: '/models/offline',
        offlineFinal: () => true,
      });
      engine.registerCallAdapter(fakeAdapterFactory(rec));
      await engine.startCall('fake');
      const loads = worker.calls.requests.filter((r) => r.op === 'load');
      assert.ok(loads.some((r) => r.role === 'asr-offline'), 'offline model was loaded');
      await rec.hooks.pushAudio({ callId: 'c1', speakerRef: 'ward', pcm: Buffer.alloc(320) });
      const open = worker.calls.requests.find((r) => r.op === 'asrStream');
      assert.equal(open.offlineFinal, true, 'the stream is opened in offline-final mode');
      await engine.endCall();
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
  // OFF: no offline load, and the stream opens streaming-only.
  {
    const dir = await tmp();
    try {
      const worker = fakeWorker();
      const rec = { played: [] };
      const engine = createCallEngine({
        worker, onTurn: async () => null, tomesDir: dir,
        streamingModelDir: '/models/stream', offlineModelDir: '/models/offline',
        offlineFinal: () => false,
      });
      engine.registerCallAdapter(fakeAdapterFactory(rec));
      await engine.startCall('fake');
      assert.ok(!worker.calls.requests.some((r) => r.op === 'load' && r.role === 'asr-offline'), 'offline model not loaded when off');
      await rec.hooks.pushAudio({ callId: 'c1', speakerRef: 'ward', pcm: Buffer.alloc(320) });
      const open = worker.calls.requests.find((r) => r.op === 'asrStream');
      assert.equal(open.offlineFinal, false, 'the stream is opened streaming-only');
      await engine.endCall();
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
});

test('transcriptFilter drops an ambient-noise transcript — no turn fires', async () => {
  const dir = await tmp();
  try {
    const worker = fakeWorker();
    const turns = [];
    const engine = createCallEngine({
      worker, onTurn: async (t) => { turns.push(t); return 'x'; }, tomesDir: dir,
      transcriptFilter: (t) => t !== 'noise',   // reject the string "noise"
    });
    engine.registerCallAdapter(fakeAdapterFactory({ played: [] }));
    await engine.startCall('fake');

    worker.emit({ op: 'asr-final', streamId: 1, text: 'noise' });
    await tick();
    assert.equal(turns.length, 0, 'the noise transcript was dropped, no turn');

    worker.emit({ op: 'asr-final', streamId: 1, text: 'real words' });
    await tick();
    assert.deepEqual(turns, ['real words'], 'a real transcript still turns');
    await engine.endCall();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('turnSettleMs coalesces utterances within the gap into ONE turn', async () => {
  const dir = await tmp();
  try {
    const worker = fakeWorker();
    const turns = [];
    const engine = createCallEngine({
      worker, onTurn: async (t) => { turns.push(t); return 'x'; }, tomesDir: dir,
      turnSettleMs: () => 40,
    });
    engine.registerCallAdapter(fakeAdapterFactory({ played: [] }));
    await engine.startCall('fake');

    // Two sentences separated by a short pause → one settled turn, joined.
    worker.emit({ op: 'asr-final', streamId: 1, text: 'first sentence' });
    await tick(15);
    worker.emit({ op: 'asr-final', streamId: 1, text: 'second sentence' });
    assert.equal(turns.length, 0, 'nothing fires while my human is still going');
    await tick(90);
    assert.deepEqual(turns, ['first sentence second sentence'], 'one turn, both sentences');
    await engine.endCall();
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

test('isCallActiveFromFileSync mirrors the async read (used by the proactive-voice factory)', async () => {
  const dir = await tmp();
  try {
    // No file yet → not active (fail-safe), same as the async read.
    assert.equal(isCallActiveFromFileSync(dir), false);
    assert.equal(isCallActiveFromFileSync(path.join(dir, 'nowhere')), false);
    await fs.writeFile(path.join(dir, '.call-state.json'), JSON.stringify({ active: true, callId: 'c' }));
    assert.equal(isCallActiveFromFileSync(dir), true, 'a live call reads active');
    assert.equal(isCallActiveFromFileSync(dir), await isCallActiveFromFile(dir), 'sync and async agree');
    await fs.writeFile(path.join(dir, '.call-state.json'), 'not json');
    assert.equal(isCallActiveFromFileSync(dir), false, 'a broken file fails safe to inactive');
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

// ── 2c: spokenUpTo — how much of a reply was heard before a barge ──────────

test('spokenTextForMs maps play time to spoken text, snapped to a word boundary', () => {
  const text = 'one two three four five six seven eight';
  assert.equal(spokenTextForMs(text, 0), '', 'nothing heard yet → empty');
  const at1s = spokenTextForMs(text, 1000);           // ~14 chars at 14 chars/sec
  assert.ok(at1s.length > 0 && at1s.length < text.length, 'a prefix, not the whole thing');
  assert.ok(text.startsWith(at1s), 'it IS a prefix of the reply');
  assert.equal(at1s, at1s.trim(), 'trimmed, no trailing space');
  // Never a half-word: the char right after the slice is a boundary (a space).
  assert.ok(at1s.length === text.length || text[at1s.length] === ' ', 'cut lands on a word boundary');
  assert.equal(spokenTextForMs(text, 60_000), text, 'ample play time → the whole reply');
  assert.equal(spokenTextForMs('', 5000), '', 'empty reply stays empty');
});

test('a barge records how far the reply got (onReplyInterrupted)', async () => {
  const dir = await tmp();
  try {
    const worker = fakeWorker();
    const rec = { played: [] };
    const interrupts = [];
    const engine = createCallEngine({
      worker,
      onTurn: async () => ({ text: 'this is the spoken reply' }),
      onReplyInterrupted: (ctx, info) => interrupts.push({ ctx, info }),
      streamingModelDir: '', tomesDir: dir,
    });
    engine.registerCallAdapter((hooks) => { rec.hooks = hooks; return {
      id: 'fake', capabilities: { perSpeakerStreams: true },
      joinCall: async () => ({ callId: 'c1' }),
      leaveCall: async () => {},
      playAudio: async () => ({ barged: true }),   // my human talked over it
      stopPlayback: async () => {},
    }; });
    await engine.startCall('fake');
    await rec.hooks.pushAudio({ callId: 'c1', speakerRef: 'ward', pcm: Buffer.alloc(320) });
    const open = worker.calls.requests.find((r) => r.op === 'asrStream');
    worker.emit({ op: 'asr-final', streamId: open.streamId, text: 'hi' });
    await tick();
    assert.equal(interrupts.length, 1, 'the barge was recorded exactly once');
    assert.equal(interrupts[0].info.fullText, 'this is the spoken reply');
    assert.equal(typeof interrupts[0].info.spokenUpTo, 'string');
    assert.equal(interrupts[0].ctx.speakerRef, 'ward');
    await engine.endCall();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a reply that plays to the end does NOT fire onReplyInterrupted', async () => {
  const dir = await tmp();
  try {
    const worker = fakeWorker();
    const rec = { played: [] };
    let interrupted = 0;
    const engine = createCallEngine({
      worker,
      onTurn: async () => ({ text: 'the whole reply' }),
      onReplyInterrupted: () => { interrupted++; },
      streamingModelDir: '', tomesDir: dir,
    });
    engine.registerCallAdapter((hooks) => { rec.hooks = hooks; return {
      id: 'fake', capabilities: {},
      joinCall: async () => ({ callId: 'c1' }),
      leaveCall: async () => {},
      playAudio: async () => ({ barged: false }),   // played to completion
      stopPlayback: async () => {},
    }; });
    await engine.startCall('fake');
    await rec.hooks.pushAudio({ callId: 'c1', speakerRef: 'ward', pcm: Buffer.alloc(320) });
    const open = worker.calls.requests.find((r) => r.op === 'asrStream');
    worker.emit({ op: 'asr-final', streamId: open.streamId, text: 'hi' });
    await tick();
    assert.equal(interrupted, 0, 'no barge → no interruption record');
    await engine.endCall();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
