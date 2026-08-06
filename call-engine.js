/**
 * call-engine.js — the platform-neutral heart of a live voice call (voice spec
 * §3, Pass 2).
 *
 * The engine owns everything that is NOT transport: routing a speaker's audio to
 * the streaming recogniser, assembling an endpointed transcript into a turn,
 * running that turn, and handing the reply back to the platform to speak. An
 * adapter (web now; Discord in Pass 3) provides only transport — `joinCall`,
 * `leaveCall`, `playAudio`, `stopPlayback`, and a way to push inbound audio in.
 * That split is the whole point of §3: the next platform is a transport-only
 * job because it never touches a session, an audience, or a model.
 *
 * ── One call at a time ──────────────────────────────────────────────────
 * `voiceMaxCalls` is 1 on the reference hardware. The engine is written
 * N-call-clean (state hangs off the `call` object, not module globals) so the
 * cap is a setting, not an assumption baked into the code.
 *
 * ── Nothing here throws at a caller or an adapter ───────────────────────
 * A call runs alongside the chat path and the autonomous loops; a rejected
 * promise escaping into an adapter's audio callback would surface as a broken
 * call, not a handled one. Every seam that can fail is caught and logged, and
 * the call degrades to an honest end rather than a crash.
 *
 * ── The call-state file is the governor's gate ──────────────────────────
 * `tomes/.call-state.json` (`{active, callId, since}`) is written on start and
 * cleared on end. The compute governor (§4.3) and the deferring loops read it
 * via `isCallActiveFromFile`; a crash mid-call must not leave it stuck `active`,
 * so `clearStaleCallState` runs at server boot.
 *
 * The turn runner (`onTurn`) is injected: the engine does not know how a turn
 * becomes speech, only that a transcript goes in and a speakable reply comes
 * out. server.js wires the real one (enrich → provider → `speakable()` → TTS);
 * a test injects a fake. Same discipline as the push-adapter registry.
 */

import { promises as fsp, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOMES_DIR = path.join(__dirname, 'tomes');
const CALL_STATE_FILE = '.call-state.json';

const callStatePath = (tomesDir) => path.join(tomesDir, CALL_STATE_FILE);

/** The hard off-switch, checked where a call would START. */
export function callsDisabled() {
  return process.env.PROTO_FAMILIAR_VOICE_CALL_DISABLED === '1'
    || process.env.PROTO_FAMILIAR_VOICE_DISABLED === '1';
}

export function createCallEngine({
  worker,                 // listeningWorker(): { request, sendPcm, on }
  onTurn,                 // async (transcript, ctx) => reply | null   (injected)
  streamingModelDir = '', // asr-streaming model dir; loaded once on call start
  tomesDir = DEFAULT_TOMES_DIR,
  maxCalls = 1,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const adapters = new Map();
  let call = null;   // { callId, adapter, startedAt, streams: Map<speakerRef,{streamId}> }
  let nextStreamId = 1;
  let unsub = null;

  // ── Proactive speech (spec §7 — "spoken not banner") ────────────────────
  // Outbox items (triage check-ins, reminders, noticing) are SPOKEN into a live
  // call rather than bannered over it. Queued and delivered only at a natural
  // GAP — never over my human or a reply (ward decision: always wait for a gap).
  // `speakProactive` resolves true only once the item was ACTUALLY spoken (or
  // false if the call ended first), so the caller records delivery on a real
  // "heard" — which is exactly what the escalation clock keys on. No escalation
  // or threat logic lives here; this only adds a delivery channel.
  const proactiveQueue = [];   // { makeReply, resolve }
  let speaking = false;        // a turn reply OR a proactive item is playing right now
  let lastUserAudioAt = 0;     // last inbound audio frame — tells us my human is mid-utterance
  let proactiveTimer = null;
  const PROACTIVE_QUIET_MS = 1500;   // this much quiet from my human before it counts as a gap

  function speakProactive(makeReply) {
    return new Promise((resolve) => {
      proactiveQueue.push({ makeReply, resolve });
      drainProactive();
    });
  }

  function drainProactive() {
    if (proactiveTimer) { clearTimeout(proactiveTimer); proactiveTimer = null; }
    if (speaking || !call || proactiveQueue.length === 0) return;
    // Wait for the gap: not while a reply is playing, not while my human is still
    // talking. Re-check after a quiet interval rather than dropping the item.
    const quietFor = now() - lastUserAudioAt;
    if (call.adapter?.isSpeaking?.() || quietFor < PROACTIVE_QUIET_MS) {
      proactiveTimer = setTimeout(() => { proactiveTimer = null; drainProactive(); }, PROACTIVE_QUIET_MS);
      proactiveTimer.unref?.();
      return;
    }
    const c = call;
    const { makeReply, resolve } = proactiveQueue.shift();
    speaking = true;
    (async () => {
      let spoken = false;
      try {
        const reply = await makeReply();
        if (reply && call === c) { await c.adapter.playAudio(c.callId, reply); spoken = true; }
      } catch (err) { log(`proactive speech failed: ${err?.message ?? err}`); }
      finally {
        speaking = false;
        resolve(spoken && call === c);
        drainProactive();
      }
    })();
  }

  async function writeCallState(active) {
    try {
      mkdirSync(tomesDir, { recursive: true });
      const body = active
        ? JSON.stringify({ active: true, callId: call?.callId ?? null, since: call?.startedAt ?? now() })
        : JSON.stringify({ active: false });
      const tmp = callStatePath(tomesDir) + '.tmp';
      await fsp.writeFile(tmp, body);
      await fsp.rename(tmp, callStatePath(tomesDir));
    } catch (err) { log(`call-state write failed: ${err?.message ?? err}`); }
  }

  /**
   * Register a transport. The factory receives the hooks it pushes inbound
   * events through and returns the adapter object. A factory that throws or
   * yields no id is dropped with a log — one bad adapter never blocks another.
   */
  function registerCallAdapter(factory) {
    const hooks = {
      pushAudio: (frame) => { handleAudio(frame).catch((e) => log(`audio route failed: ${e?.message ?? e}`)); },
      // Push-to-talk's turn boundary: the RELEASE. A continuous/VAD adapter never
      // calls this — the recogniser's own endpointing finds the boundary and
      // fires `asr-final` mid-stream. An explicit-boundary adapter (push-to-talk)
      // calls it on release to finalise the current utterance now.
      endUtterance: (frame) => { finalizeUtterance(frame).catch((e) => log(`finalize failed: ${e?.message ?? e}`)); },
      rosterChanged: (_ev) => { /* Pass 3 (Discord roster→audience) consumes this; the contract carries it now */ },
    };
    let adapter;
    try { adapter = factory(hooks); } catch (err) { log(`call adapter factory failed: ${err?.message ?? err}`); return null; }
    if (!adapter?.id) { log('call adapter has no id — ignored'); return null; }
    adapters.set(adapter.id, adapter);
    return adapter.id;
  }

  function speakerForStream(streamId) {
    if (!call) return null;
    for (const [ref, s] of call.streams) if (s.streamId === streamId) return ref;
    return null;
  }

  function onWorkerFrame(frame) {
    const msg = frame?.message;
    if (!msg || !call) return;
    if (msg.op === 'asr-final') {
      const text = String(msg.text ?? '').trim();
      // The peak + duration make an empty result diagnosable: a low peak means
      // silence (a dead/muted mic or the wrong input device); a healthy peak with
      // no words means real sound the model did not recognise (format, accent,
      // too quiet, too short). Speech is roughly peak > 0.05.
      const meta = `peak=${msg.peak ?? '?'} ${msg.seconds ?? '?'}s`;
      log(`asr-final on stream ${msg.streamId}: ${text ? `"${text}"` : '(empty — no words recognised)'} [${meta}]`);
      if (text) {
        handleTurn(speakerForStream(msg.streamId), text);   // serialised dispatcher; errors handled inside
      } else if (call?.adapter) {
        // Nothing recognised — release my human from "Thinking…" so the call is
        // usable again, instead of waiting on a turn that will never start.
        try { call.adapter.playAudio(call.callId, null); } catch (e) { log(`reset after empty asr failed: ${e?.message ?? e}`); }
      }
    }
    // asr-partial is reserved for live captions + barge-in (Pass 2c / web adapter).
  }

  async function handleAudio({ callId, speakerRef, pcm } = {}) {
    if (!call || call.callId !== callId) return;   // stray audio for no call / an old one
    lastUserAudioAt = now();   // my human is speaking — proactive speech waits for the gap after

    let s = call.streams.get(speakerRef);
    if (!s) {
      const streamId = nextStreamId++;
      const r = await worker.request({ op: 'asrStream', streamId });
      if (!r?.ok) { log(`asrStream open failed for ${speakerRef}: ${r?.reason ?? '?'}`); return; }
      s = { streamId, frames: 0, bytes: 0 };
      call.streams.set(speakerRef, s);
      // The first audio frame of a press — proof the capture path works end to
      // end. If this never appears in the log, my human's mic audio is not
      // reaching the server (a client capture / socket problem), not an ASR one.
      log(`${speakerRef} started speaking — ASR stream ${streamId} open`);
    }
    s.frames += 1;
    s.bytes += pcm?.length ?? 0;
    await worker.sendPcm(s.streamId, pcm);
  }

  /**
   * Finalise the current utterance for one speaker without ending the call.
   * Stopping the stream flushes the recogniser's tail and emits its `asr-final`
   * (which drives the turn); a fresh stream is reopened on the SAME streamId so
   * the next press starts clean. Reuses the proven Pass 2a ops rather than a new
   * "force endpoint" the engine would be the only caller of.
   */
  async function finalizeUtterance({ callId, speakerRef } = {}) {
    if (!call || call.callId !== callId) return;
    const s = call.streams.get(speakerRef);
    if (!s) {
      // A release with no open stream means NO audio arrived during the press —
      // the recogniser has nothing to finalise, so there will be no asr-final
      // and no turn. This is the signature of a client that isn't sending audio.
      log(`${speakerRef} released, but no audio was captured this press — nothing to transcribe`);
      return;
    }
    log(`${speakerRef} released after ${s.frames} audio frame(s) (${s.bytes} bytes) — finalising`);
    await worker.request({ op: 'asrStreamStop', streamId: s.streamId });   // emits asr-final → handleTurn
    if (call && call.streams.get(speakerRef) === s) {
      s.frames = 0; s.bytes = 0;
      await worker.request({ op: 'asrStream', streamId: s.streamId });     // reopen for the next press
    }
  }

  // Turns are SERIALISED. Open mic fires an asr-final per utterance, so a burst
  // of them ("Eury?" … "Hey?" … "can you hear me?") would otherwise launch
  // overlapping heavy turns that thrash and none replies in time. One turn runs
  // at a time; anything said DURING it coalesces to the LATEST, so the freshest
  // thing my human said gets answered rather than a stale backlog.
  let turnBusy = false;
  let pendingTurn = null;

  function handleTurn(speakerRef, transcript) {
    if (turnBusy) { pendingTurn = { speakerRef, transcript }; return; }
    turnBusy = true;
    runOneTurn(speakerRef, transcript).finally(() => {
      turnBusy = false;
      const next = pendingTurn;
      pendingTurn = null;
      if (next && call) handleTurn(next.speakerRef, next.transcript);
    });
  }

  async function runOneTurn(speakerRef, transcript) {
    const c = call;
    if (!c) return;
    let reply = null;
    try { reply = await onTurn(transcript, { callId: c.callId, speakerRef }); }
    catch (err) { log(`onTurn threw: ${err?.message ?? err}`); }
    if (call !== c) return;   // the call ended mid-turn — nothing to deliver to
    // Always hand the turn's outcome to the adapter, even when there is nothing
    // to say. playAudio(null) signals the browser to leave "Thinking…" and wait
    // for the next press — otherwise a silent turn (no connection, empty reply,
    // timeout) hangs the UI forever, which is the "thinks and never answers" bug.
    try { speaking = true; await c.adapter.playAudio(c.callId, reply); }
    catch (err) { log(`playAudio failed: ${err?.message ?? err}`); }
    finally { speaking = false; }
    drainProactive();   // a turn just ended — a good moment to speak anything queued
  }

  async function startCall(adapterId, target) {
    if (callsDisabled()) return { ok: false, reason: 'disabled' };
    if (call) return { ok: false, reason: 'busy', callId: call.callId };
    if (adapters.size >= maxCalls && call) return { ok: false, reason: 'busy' };
    const adapter = adapterId ? adapters.get(adapterId) : [...adapters.values()][0];
    if (!adapter) return { ok: false, reason: 'no-adapter' };

    // The model must be resident before the first PCM frame, or the opening of
    // the utterance is decoded against nothing.
    if (streamingModelDir) {
      const load = await worker.request({ op: 'load', role: 'asr-streaming', modelDir: streamingModelDir }, { timeoutMs: 60000 });
      if (!load?.ok) return { ok: false, reason: load?.reason ?? 'load-failed', detail: load?.detail };
    }

    let joined;
    try { joined = await adapter.joinCall(target); }
    catch (err) { return { ok: false, reason: 'join-failed', detail: String(err?.message ?? err) }; }

    call = { callId: joined?.callId ?? `call-${now()}`, adapter, startedAt: now(), streams: new Map() };
    unsub = worker.on(onWorkerFrame);
    await writeCallState(true);
    log(`call ${call.callId} started on ${adapter.id}`);
    return { ok: true, callId: call.callId, adapterId: adapter.id };
  }

  async function endCall() {
    if (!call) return { ok: true, wasActive: false };
    const c = call;
    call = null;   // flip first — isCallActive() must read false the instant teardown begins
    // Anything queued to be spoken never got heard — resolve it as NOT delivered
    // so the caller doesn't record a "heard" the escalation clock would trust.
    if (proactiveTimer) { clearTimeout(proactiveTimer); proactiveTimer = null; }
    while (proactiveQueue.length) { try { proactiveQueue.shift().resolve(false); } catch { /* */ } }
    try { if (unsub) unsub(); } catch { /* already gone */ }
    unsub = null;
    for (const s of c.streams.values()) {
      try { await worker.request({ op: 'asrStreamStop', streamId: s.streamId }); } catch { /* best effort */ }
    }
    try { await c.adapter.leaveCall(c.callId); } catch (err) { log(`leaveCall failed: ${err?.message ?? err}`); }
    await writeCallState(false);
    log(`call ${c.callId} ended`);
    return { ok: true, wasActive: true, callId: c.callId };
  }

  return {
    registerCallAdapter,
    startCall,
    endCall,
    speakProactive,   // spoken-not-banner: queue text to speak at the next gap; resolves true once heard
    isCallActive: () => Boolean(call),
    currentCallId: () => call?.callId ?? null,
    adapterIds: () => [...adapters.keys()],
  };
}

/**
 * Clear a stale call-state file at boot. A crash mid-call would otherwise leave
 * it `active:true` forever, and every deferring loop would sit out indefinitely
 * — the caring spine included is fail-safe against that, but the background work
 * that legitimately defers must not be stuck off after a restart.
 */
export async function clearStaleCallState(tomesDir = DEFAULT_TOMES_DIR) {
  try {
    mkdirSync(tomesDir, { recursive: true });
    await fsp.writeFile(callStatePath(tomesDir), JSON.stringify({ active: false }));
  } catch { /* if we cannot write it, isCallActiveFromFile still fails safe to inactive */ }
}

/**
 * The governor's read side (§4.3): is a call active right now? Fail-safe — an
 * absent or unparseable file reads as NOT active, so a broken state file can
 * never wedge the background loops off.
 */
export async function isCallActiveFromFile(tomesDir = DEFAULT_TOMES_DIR) {
  try {
    const raw = await fsp.readFile(callStatePath(tomesDir), 'utf8');
    return Boolean(JSON.parse(raw)?.active);
  } catch { return false; }
}
