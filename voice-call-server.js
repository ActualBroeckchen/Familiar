/**
 * voice-call-server.js — the server-side glue that turns the tested Pass 2b
 * modules into a live web voice call (voice spec §6.4).
 *
 * ⚠️ ON-HARDWARE PATH. Everything under here needs a microphone, a live LLM
 * provider, and the streaming ASR + TTS models on disk — none of which exist in
 * CI. It is written against the proven seams (the 2a worker, `/api/chat`, the
 * read-aloud TTS pattern, `connectionForFeature`) and every module it composes
 * is unit-tested, but the assembled path is verified by my human speaking into
 * it on the reference laptop, not here. Logs are deliberately verbose for that.
 *
 * It owns three things and delegates the rest:
 *   1. the real `onTurn` deps — `runTurn` (a full `/api/chat` turn, so a voice
 *      reply has identity + memory + tools, §4.4), `synthesize` (the reply →
 *      TTS PCM), `scoreThreat` (D2), `threatEnabled` (the D2 gate);
 *   2. the singleton call engine (one call at a time) + `clearStaleCallState`
 *      at boot;
 *   3. the WebSocket endpoint that binds one browser connection to the engine
 *      via the web adapter, and tears the call down when the socket closes.
 */

import path from 'node:path';

import { WebSocketServer } from 'ws';

import { createCallEngine, clearStaleCallState, callsDisabled } from './call-engine.js';
import { createWebCallAdapter } from './voice-web-adapter.js';
import { createVoiceTurnRunner } from './voice-call-turn.js';
import { speakableText } from './voice-speech.js';
import { createSynthesizer } from './voice-synthesize.js';
import { scoreMessage } from './crisis-signals.js';
import { recordThreat } from './threat-tracker.js';
import { MODELS_SUBDIR } from './voice-fetch.js';
import { enqueueSessionByDay } from './memorization.js';
import { sessionSlugId } from './slug-ids.js';
import { registerPushAdapterFactory, formatItemForPush } from './cerebellum.js';
import { extractContent } from './llm-call.js';

const WS_PATH = '/api/voice/call';
// How long a single spoken turn may take before the call gives up and resets my
// human off "Thinking…". Generous — the first turn pays MCP cold-start + context
// enrichment + the model — but finite, so a hang can never masquerade as
// thinking forever.
const VOICE_TURN_TIMEOUT_MS = 90_000;

/** The D2 gate: is ward-voice→threat scoring on right now? Ward-signed ON by default. */
function voiceThreatEnabled(settings) {
  if (process.env.PROTO_FAMILIAR_THREAT_DISABLED === '1') return false;
  if (process.env.PROTO_FAMILIAR_VOICE_THREAT_DISABLED === '1') return false;
  return settings?.voiceThreatScoring !== false; // default ON
}

/**
 * @param {object} deps  server-bound helpers (all already exist in server.js)
 * @param {import('http').Server} deps.httpServer
 * @param {string}   deps.rootDir
 * @param {number}   deps.port
 * @param {function} deps.readSettings           () => settings
 * @param {function} deps.getListeningWorker      () => worker | Promise<worker>   (ASR)
 * @param {function} deps.getTtsWorker            () => Promise<worker>            (TTS, follows voice choice)
 * @param {function} deps.resolveVoiceForSettings (settings) => Promise<voice>
 * @param {function} deps.ensureTtsLoaded         (worker) => Promise<{ok, sampleRate}>
 * @param {function} deps.connectionForFeature    (settings, feature) => {provider, apiKey, model}
 * @param {function} [deps.log]
 */
export function attachVoiceCall(deps) {
  const {
    httpServer, rootDir, port,
    readSettings, getListeningWorker, getTtsWorker,
    resolveVoiceForSettings, ensureTtsLoaded, connectionForFeature,
    log = (m) => console.log(`[voice-call] ${m}`),
  } = deps;

  // Per-call chat history, keyed by callId (one call at a time, so at most one
  // live entry; a new call gets a new id and a fresh history).
  const histories = new Map();
  const HISTORY_MAX = 20;

  // The FULL call transcript, kept separate from `histories` (which is capped for
  // the LLM context). On hang-up it is memorized like any ward-private session —
  // otherwise a whole spoken conversation vanishes, unremembered and un-reviewable.
  // callId → { sessionId, messages: [{role, content}], startedAt }.
  const callSessions = new Map();

  // Enqueue a finished call's transcript for memorization, the same path web chat
  // and Discord use (`enqueueSessionByDay` → consent-gated fact extraction). Called
  // once, on hang-up. Never throws into the teardown.
  async function memorizeCall(callId) {
    const sess = callSessions.get(callId);
    callSessions.delete(callId);
    if (!sess || sess.messages.length < 2) return;
    try {
      const s = readSettings();
      const conn = connectionForFeature(s, 'chat') || connectionForFeature(s, 'pondering');
      if (!(conn?.apiKey && conn?.provider && conn?.model)) { log('call ended but no connection to memorize it with — transcript not stored'); return; }
      const r = await enqueueSessionByDay({
        sessionId: sess.sessionId, messages: sess.messages,
        provider: conn.provider, apiKey: conn.apiKey, model: conn.model,
        audienceTag: 'ward-private',   // a web call is my human on their own private surface
      });
      log(`call ${callId} ended — queued ${sess.messages.length} lines for memory (${r.enqueued} enqueued, ${r.skipped} skipped)`);
    } catch (err) { log(`memorizeCall failed: ${err?.message ?? err}`); }
  }

  // ── onTurn dep: a full chat turn via /api/chat ──────────────────────────
  async function runTurn(transcript, ctx) {
    const s = readSettings();
    const conn = connectionForFeature(s, 'chat') || connectionForFeature(s, 'pondering');
    if (!(conn?.apiKey && conn?.provider && conn?.model)) {
      log('no usable connection for a voice turn — staying silent');
      return null;
    }
    const hist = histories.get(ctx.callId) ?? [];
    const messages = [...hist, { role: 'user', content: transcript }];
    let reply = '';
    // A hung turn must not hang the call forever. The enriched, tool-looping
    // chat path can be slow — an MCP cold start on the first turn, a thinking
    // model — but it has to end, so the caller can reset my human off "Thinking…"
    // and they can try again. Generous, so a legitimately slow reply is not cut,
    // but finite.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), VOICE_TURN_TIMEOUT_MS);
    const started = Date.now();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          provider: conn.provider, apiKey: conn.apiKey, model: conn.model,
          // NO tool loop on a call. A spoken "Eury?" wants a fast "Hey?", not a
          // 19-tool research task — and a tool loop that ends in tool_calls with
          // no final text is dead air. Removing it is the single biggest latency
          // win for a live turn; tools during a call are a later, opt-in refinement.
          //
          // RULE A (0.9 post-mortem): with runToolLoop:false this request lands on
          // /api/chat's RAW non-stream passthrough — which, unlike the tool-loop
          // path, applies NEITHER of callProviderChat's guarantees. So we
          // replicate BOTH here: a generous max_tokens (a thinking model bills its
          // reasoning against the cap; with no cap it spends the provider default
          // reasoning and returns empty content — dead silence on the call), and
          // extractContent at the reply boundary below (the answer may sit in
          // reasoning_content, not content). This is the same fix Discord paid for
          // in 0.9.7; the voice path is the surface that hadn't gotten the memo.
          messages, stream: false, runToolLoop: false, enrich: true,
          max_tokens: 4000,
          userMessage: transcript,
          // Tell the turn it is spoken, so the reply comes out speech-shaped
          // (short, no markdown) instead of screen-shaped (2e).
          voiceMode: true,
          // A live spoken turn is the ward on their own private surface.
          sessionAudience: 'ward-private',
        }),
      });
      const data = await res.json().catch(() => null);
      // extractContent, not raw .content — a thinking model parks its answer in
      // reasoning_content when content is empty (RULE A). Reading .content alone
      // was the silence: the reply existed, we just weren't looking where it landed.
      reply = extractContent(data?.choices?.[0]?.message ?? {});
      // Silence with a reason. An error status or an empty body used to vanish
      // here — my human heard nothing and no log said why. Now every no-reply
      // path names itself, so "it thinks and never answers" is diagnosable.
      if (!res.ok) {
        log(`voice turn /api/chat returned ${res.status}: ${JSON.stringify(data)?.slice(0, 300)}`);
      } else if (!reply) {
        log(`voice turn produced no content after ${Date.now() - started}ms (thinking model with empty content? tool loop with no final text?)`);
      }
    } catch (err) {
      if (err?.name === 'AbortError') {
        log(`voice turn timed out after ${VOICE_TURN_TIMEOUT_MS}ms — giving up so the call can reset`);
      } else {
        log(`voice turn /api/chat failed: ${err?.message ?? err}`);
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (reply) {
      const next = [...messages, { role: 'assistant', content: reply }];
      histories.set(ctx.callId, next.slice(-HISTORY_MAX));
      // Accumulate the FULL exchange for the end-of-call memorization (uncapped).
      const sess = callSessions.get(ctx.callId);
      if (sess) sess.messages.push({ role: 'user', content: transcript }, { role: 'assistant', content: reply });
    }
    return reply;
  }

  // ── onTurn dep: reply text → TTS PCM, streamed as it is generated (2c) ───
  // The shared synthesizer (voice-synthesize.js) — the Discord transport uses
  // the exact same one, so it lives in one place, not copy-pasted per adapter.
  const synthesize = createSynthesizer({ readSettings, getTtsWorker, resolveVoiceForSettings, ensureTtsLoaded, log });

  // ── onTurn dep: D2 — the ward's spoken words can raise the threat tier ───
  async function scoreThreat(transcript) {
    const { level, signals } = scoreMessage(transcript);
    if (level > 0) await recordThreat({ delta: level, source: 'voice', signals });
  }

  // ── The engine ──────────────────────────────────────────────────────────
  const onTurn = createVoiceTurnRunner({
    runTurn,
    synthesize,
    speakable: speakableText,
    scoreThreat,
    threatEnabled: () => voiceThreatEnabled(readSettings()),
    log,
  });

  const engine = createCallEngine({
    worker: {
      request: (...a) => getWorkerThen((w) => w.request(...a)),
      sendPcm: (...a) => getWorkerThen((w) => w.sendPcm(...a)),
      on: (l) => {
        // The listening worker is resolved lazily; subscribe once it exists.
        let off = () => {};
        Promise.resolve(getListeningWorker()).then((w) => { if (w) off = w.on(l); }).catch(() => {});
        return () => off();
      },
    },
    onTurn,
    streamingModelDir: path.join(rootDir, MODELS_SUBDIR, `asr-streaming-${asrLang(readSettings())}`),
    tomesDir: path.join(rootDir, 'tomes'),
    log,
  });

  async function getWorkerThen(fn) {
    const w = await getListeningWorker();
    if (!w) return { ok: false, reason: 'no-worker' };
    return fn(w);
  }

  // ── Spoken-not-banner (spec §7, ward-signed) ────────────────────────────
  // While a call is live, proactive outbox items — triage check-ins, reminders,
  // event alerts, noticing reach-outs — are SPOKEN into the call instead of
  // bannered over it. A push adapter is the union point: `dispatchOutboxPush`
  // already fans every item out to the configured channels, so this adds one
  // that only exists during a call and speaks the item at the next gap.
  //
  // SAFETY: this changes nothing about escalation or the threat tier. Speaking
  // the item resolves as a confirmed delivery ONLY once it was actually heard
  // (the engine resolves false if the call ends first), and `dispatchOutboxPush`
  // records that under delivery['voice-call'] — which `contactDeadlineFor` reads
  // exactly as it reads a Discord-DM delivery. Ward decision: heard = delivered;
  // the human's own state/response (via the threat tier) still drives escalation.
  registerPushAdapterFactory(() => {
    if (!engine.isCallActive()) return null;   // only a live call speaks; otherwise the normal channels deliver
    return {
      name: 'voice-call',
      deliver: async (item) => {
        try {
          const text = speakableText(formatItemForPush(item))?.text?.trim();
          if (!text) return { ok: false, error: 'nothing speakable in this item' };
          const heard = await engine.speakProactive(() => synthesize(text));
          return heard ? { ok: true } : { ok: false, error: 'call ended before it could be spoken' };
        } catch (err) { return { ok: false, error: String(err?.message ?? err) }; }
      },
    };
  });

  clearStaleCallState(path.join(rootDir, 'tomes')).catch(() => {});

  // ── The WebSocket endpoint ──────────────────────────────────────────────
  const wss = new WebSocketServer({ server: httpServer, path: WS_PATH });
  wss.on('connection', async (ws) => {
    // A live call is push-to-talk: my human clicks Start, the browser asks for
    // mic permission (a hard OS-level gate), and audio only streams while the
    // button is held. That IS the consent — the same rule voice notes already
    // follow ("a press is the consent"), so a call is NOT gated behind the
    // voiceEnabled continuous-listening opt-in. It hid the feature with no way
    // to turn it on. Only the hard env off-switch (callsDisabled) stops a call.
    if (callsDisabled()) {
      try { ws.send(JSON.stringify({ t: 'error', reason: 'voice-disabled' })); } catch { /* */ }
      ws.close(); return;
    }
    if (engine.isCallActive()) {
      try { ws.send(JSON.stringify({ t: 'error', reason: 'busy' })); } catch { /* */ }
      ws.close(); return;
    }

    const send = (data) => { try { ws.send(data); } catch (err) { log(`ws send failed: ${err?.message ?? err}`); } };
    let web = null;
    let activeCallId = null;   // set once the call is live, so close can memorize it
    engine.registerCallAdapter((hooks) => { web = createWebCallAdapter({ hooks, send, log }); return web.adapter; });

    ws.on('message', (data, isBinary) => { try { web?.onMessage(data, isBinary); } catch (err) { log(`onMessage failed: ${err?.message ?? err}`); } });
    ws.on('close', () => {
      try { web?.onClose(); } catch { /* */ }
      engine.endCall().catch(() => {});
      // Memorize the conversation on hang-up (fire-and-forget; never blocks teardown).
      if (activeCallId) memorizeCall(activeCallId).catch(() => {});
    });
    ws.on('error', (err) => log(`ws error: ${err?.message ?? err}`));

    const start = await engine.startCall('web');
    if (!start.ok) {
      log(`call refused: ${start.reason}${start.detail ? ` (${start.detail})` : ''}`);
      send(JSON.stringify({ t: 'error', reason: start.reason, detail: start.detail ?? null }));
      ws.close(); return;
    }
    activeCallId = start.callId;
    callSessions.set(start.callId, { sessionId: sessionSlugId(), messages: [], startedAt: Date.now() });
    send(JSON.stringify({ t: 'ready', callId: start.callId }));
    log(`web call ${start.callId} live`);
  });

  log(`web voice call endpoint listening at ${WS_PATH}`);
  return { engine, wss };
}

/**
 * The ward's chosen streaming-ASR language, defaulting to English.
 *
 * `voiceAsrLanguage` is the one canonical setting — synced from the picker in
 * the voice pane. (An earlier `voiceLanguage` fallback was dropped: nothing
 * ever wrote it, so it only invited a second, drifting source of truth.)
 */
function asrLang(settings) {
  const l = String(settings?.voiceAsrLanguage ?? 'en').toLowerCase().trim();
  return /^[a-z]{2}$/.test(l) ? l : 'en';
}
