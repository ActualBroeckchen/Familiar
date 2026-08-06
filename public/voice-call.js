/*
 * voice-call.js — the browser end of a live voice call (Pass 2b, web adapter).
 *
 * ⚠️ ON-HARDWARE / UNVERIFIED-IN-CLOUD. This drives a microphone and Web Audio
 * playback against the server's WS endpoint (/api/voice/call). None of it can
 * run in CI (no mic), so it is written carefully and verified by my human
 * making a real call on the reference laptop.
 *
 * Flow: "Start call" opens the socket and asks for the mic once (the click is
 * the gesture that unlocks capture + the AudioContext). "Hold to talk" is
 * push-to-talk — while held, downsampled 16 kHz mono s16le PCM streams up; the
 * release finalises the utterance. The Familiar's reply arrives as one PCM
 * chunk (server buffers a whole reply so PocketTTS keeps one voice) framed by
 * speak-start / speak-end and plays back through the AudioContext.
 *
 * Plain script (matches app.js/graph-map.js): no imports, one IIFE, no globals
 * beyond the DOM ids it owns.
 */
(function () {
  'use strict';

  const TARGET_RATE = 16000; // the recogniser's rate
  const $ = (id) => document.getElementById(id);

  let ws = null;
  let ctx = null;
  let micStream = null;
  let sourceNode = null;
  let procNode = null;
  let usingWorklet = false;   // capture via AudioWorklet (preferred) vs ScriptProcessor (fallback)
  let talking = false;
  let sentChunks = 0;     // audio chunks sent during the current press — live feedback + a dead-mic tell
  let playHead = 0;       // AudioContext time the next reply chunk should start at
  let live = false;
  let replyPlaying = false;   // a spoken reply is currently playing (barge-in gate)
  let playingSources = [];    // scheduled AudioBufferSourceNodes, so a barge can stop them mid-reply
  let callMode = 'push';      // 'push' (hold to talk) or 'open' (hands-free, mic always live)

  // In open mic, a frame this loud while a reply is playing counts as my human
  // talking over it — the onset that triggers a barge. Above residual echo (the
  // reply leaking into the mic, mostly removed by echoCancellation), below normal
  // speech. Tuned conservatively; a false barge only cuts a reply my human can ask to repeat.
  const BARGE_PEAK = 0.12;

  function setState(msg) { const el = $('voice-call-state'); if (el) el.textContent = msg || ''; }

  // The talk button says different things in the two modes: a hold target in
  // push-to-talk, a mute toggle in open mic. Kept in one place so every state
  // change (go live, mute, barge) renders consistently.
  function updateTalkButton() {
    const talk = $('voice-call-talk');
    if (!talk) return;
    if (callMode === 'open') {
      talk.classList.toggle('is-talking', talking);
      talk.textContent = talking ? '🎙 Open mic — tap to mute' : '🔇 Muted — tap to talk';
    } else {
      talk.classList.toggle('is-talking', talking);
      talk.textContent = talking ? '🔴 Recording — release to send' : '🎙 Hold to talk';
    }
  }

  function setLive(on) {
    live = on;
    const start = $('voice-call-btn');
    const talk = $('voice-call-talk');
    if (start) start.textContent = on ? '⏹ End call' : '📞 Start voice call';
    if (talk) talk.hidden = !on;
    // Open mic starts capturing the moment the call is live — no press needed;
    // the recogniser's own endpointing segments what I say into turns.
    if (on && callMode === 'open') { talking = true; sentChunks = 0; }
    if (!on) talking = false;
    updateTalkButton();
  }

  // ── Capture: ctx-rate Float32 → 16 kHz mono s16le ──────────────────────
  function floatTo16kS16(input, inRate) {
    const ratio = inRate / TARGET_RATE;
    const outLen = Math.floor(input.length / ratio);
    const buf = new ArrayBuffer(outLen * 2);
    const view = new DataView(buf);
    for (let i = 0; i < outLen; i++) {
      // Linear interpolation between the two nearest input samples.
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const s = (input[i0] ?? 0) * (1 - frac) + (input[i0 + 1] ?? input[i0] ?? 0) * frac;
      const clamped = Math.max(-1, Math.min(1, s));
      view.setInt16(i * 2, Math.round(clamped * 32767), true);
    }
    return buf;
  }

  // One captured mono block (Float32 at ctx.sampleRate), from EITHER the
  // AudioWorklet or the ScriptProcessor fallback — both call this so the barge
  // detection, resample and send live in one place.
  function processCaptureBlock(input) {
    if (!talking || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (!input || !input.length) return;
    // Open mic: my human talking over a playing reply is a barge. Detect the
    // onset by level and stop the reply, so the mic captures the new utterance
    // cleanly and the echo stops. (Push-to-talk barges explicitly on press.)
    if (callMode === 'open' && replyPlaying) {
      let peak = 0;
      for (let i = 0; i < input.length; i++) { const a = input[i] < 0 ? -input[i] : input[i]; if (a > peak) peak = a; }
      if (peak >= BARGE_PEAK) {
        try { ws.send(JSON.stringify({ t: 'barge' })); } catch { /* socket gone */ }
        stopLocalPlayback();
        replyPlaying = false;
      }
    }
    try {
      ws.send(floatTo16kS16(input, ctx.sampleRate));
      sentChunks += 1;
      // Push-to-talk shows the count climbing as hold feedback; open mic is always
      // listening, so a per-frame counter would just churn — leave its status be.
      if (callMode === 'push' && sentChunks % 4 === 0) setState(`Listening… (${sentChunks})`);
    } catch { /* socket went away */ }
  }

  // ── Playback: s16le at the reply's rate → queued AudioBuffer ───────────
  function playPcm(arrayBuffer, sampleRate) {
    if (!ctx) return;
    const pcm = new DataView(arrayBuffer);
    const n = Math.floor(arrayBuffer.byteLength / 2);
    if (n === 0) return;
    const audio = ctx.createBuffer(1, n, sampleRate || 24000);
    const ch = audio.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = pcm.getInt16(i * 2, true) / 32768;
    const src = ctx.createBufferSource();
    src.buffer = audio;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, playHead);
    src.start(startAt);
    playHead = startAt + audio.duration;
    // Track it so a barge can stop everything still scheduled to play.
    playingSources.push(src);
    src.onended = () => { playingSources = playingSources.filter((s) => s !== src); };
  }

  // Wire the mic into a capture node. Prefer an AudioWorklet — it runs off the
  // main thread (no glitching under load) and ScriptProcessorNode is deprecated.
  // Fall back to ScriptProcessor if the worklet module can't load, so capture
  // ALWAYS works: the fallback is the path my human already made calls on.
  async function setupCapture() {
    sourceNode = ctx.createMediaStreamSource(micStream);
    try {
      await ctx.audioWorklet.addModule('voice-call-capture-worklet.js');
      const node = new AudioWorkletNode(ctx, 'capture-processor', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
      node.port.onmessage = (e) => processCaptureBlock(e.data);
      sourceNode.connect(node);   // a worklet with no outputs pulls its input without a destination connection
      procNode = node;
      usingWorklet = true;
    } catch (err) {
      const sp = ctx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = (e) => processCaptureBlock(e.inputBuffer.getChannelData(0));
      sourceNode.connect(sp);
      sp.connect(ctx.destination);   // ScriptProcessor must reach a destination to pull
      procNode = sp;
      usingWorklet = false;
    }
  }

  // Stop every scheduled reply chunk at once — barge-in, or a server `stop`.
  function stopLocalPlayback() {
    for (const s of playingSources) { try { s.stop(); } catch { /* already ended */ } }
    playingSources = [];
    if (ctx) playHead = ctx.currentTime;
  }

  // ── First-call setup: fetch the speech models if they aren't here yet ──
  //
  // The streaming recogniser + VAD (the "Listening" tier) are what a call
  // listens with. Reusing the existing install endpoint, which only fetches
  // what is missing, so a machine that already has read-aloud pays for the ASR
  // alone. Synchronous by nature (the download IS the setup); the message says
  // it happens once so a wait does not read as a hang.
  async function ensureCallModels() {
    let st = null;
    try { st = await (await fetch('/api/voice/models?what=call')).json(); } catch { /* treat as missing */ }
    if (st?.ok && st.allComplete) return { ok: true };

    setState('Setting up your first call — downloading the speech models (about 150 MB). This happens once; hang on…');
    let r = null;
    try {
      r = await (await fetch('/api/voice/install-models', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ what: 'call' }),
      })).json();
    } catch {
      return { ok: false, message: 'Could not download the call models — check the connection and try Start again.' };
    }
    if (!r?.ok) {
      const why = r?.reason || r?.error
        || (Array.isArray(r?.failed) ? r.failed.map((f) => f?.detail).filter(Boolean).join('; ') : '')
        || 'the download did not finish';
      return { ok: false, message: `Could not set up the call: ${why}. Press Start to try again.` };
    }
    return { ok: true };
  }

  // ── Socket lifecycle ───────────────────────────────────────────────────
  let replyRate = 24000;
  let starting = false;   // guards the async setup so a second click can't race the model install

  async function startCall() {
    if (live) { endCall(); return; }
    if (starting) return;   // already connecting / downloading — a second press must not start a second install
    starting = true;
    try {
      await beginCall();
    } finally {
      starting = false;
    }
  }

  async function beginCall() {
    // Lock in the capture mode for this call from the Settings control.
    callMode = ($('voice-call-mode')?.value === 'open') ? 'open' : 'push';
    setState('Connecting…');
    // The mic API only exists in a secure context (https:// or localhost). Over
    // Tailscale on plain http:// the whole `navigator.mediaDevices` is absent —
    // say so plainly instead of throwing "undefined is not an object".
    if (!navigator.mediaDevices?.getUserMedia) {
      setState(window.isSecureContext === false
        ? 'A voice call needs a secure connection. Open http://localhost:8742 on this machine, or serve over HTTPS (e.g. `tailscale serve`) to call from your phone.'
        : 'This browser did not expose a microphone. Use a current browser on https:// or localhost.');
      return;
    }
    // The call needs the streaming speech models (the "Listening" tier). Rather
    // than error and tell my human to go install them, fetch them here on the
    // first call — once — so a call just works. Done AFTER the secure-context
    // check, so a phone that can't use the mic never pulls 150 MB it can't use.
    const models = await ensureCallModels();
    if (!models.ok) { setState(models.message); return; }
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      await ctx.resume();
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      setState(`Couldn't open the microphone: ${err && err.message ? err.message : err}`);
      return;
    }

    await setupCapture();

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/voice/call`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => setState('Connected. Hold the button to talk.');
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'ready') { setLive(true); setState('On a call. Hold to talk.'); }
        else if (m.t === 'speak-start') { replyRate = Number(m.sampleRate) || replyRate; playHead = ctx.currentTime; replyPlaying = true; setState('…'); }
        else if (m.t === 'speak-end') { replyPlaying = false; setState('On a call. Hold to talk.'); }
        else if (m.t === 'no-reply') { replyPlaying = false; setState('No reply that time — hold to talk and try again.'); }
        else if (m.t === 'stop') { replyPlaying = false; stopLocalPlayback(); }
        else if (m.t === 'error') { setState(callErrorMessage(m.reason, m.detail)); endCall(); }
        return;
      }
      playPcm(ev.data, replyRate); // binary → TTS PCM
    };
    ws.onclose = () => { if (live) setState('Call ended.'); teardown(); };
    ws.onerror = () => setState('Connection error.');
  }

  // Turn the server's terse reason into something my human can act on. The most
  // common one is a missing streaming-ASR model: the call refuses at load, which
  // used to read as the cryptic "Call ended: load-failed" — no hint that the fix
  // is a one-click install. A call that never reaches `ready` also never shows
  // the Hold-to-talk button, so this message is the ONLY thing my human sees.
  function callErrorMessage(reason, detail) {
    const tail = detail ? ` (${detail})` : '';
    switch (reason) {
      case 'load-failed':
      case 'no-listening-engine':
      case 'not-loaded':
        return 'The call needs the streaming speech model, which isn’t installed. Open the voice models section and install the “Listening” tier, then try again.';
      case 'no-worker':
      case 'no-engine':
      case 'spawn-failed':
        return 'The speech engine could not start, so there’s nothing to listen with. Check the voice models are installed, then try again.' + tail;
      case 'voice-disabled':
        return 'Voice calls are switched off on this server (the PROTO_FAMILIAR_VOICE_CALL_DISABLED / VOICE_DISABLED env switch). Clear it to allow calls.';
      case 'busy':
        return 'A call is already in progress. End it before starting another.';
      case 'no-adapter':
      case 'join-failed':
        return 'The call could not connect.' + tail;
      default:
        return `Call ended: ${reason || 'error'}${tail}`;
    }
  }

  function pressTalk() {
    if (!live || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (callMode === 'open') {
      // Open mic: the button is a mute toggle, not a hold. No explicit release —
      // the recogniser's endpointing segments what I say into turns.
      talking = !talking;
      if (talking) sentChunks = 0;
      updateTalkButton();
      setState(talking ? 'Open mic — just talk.' : 'Muted — tap to talk again.');
      return;
    }
    // Push-to-talk. Pressing while a reply is playing barges it (2c): stop the
    // audio locally right away (no network wait) and tell the server to stop
    // generating and sending the rest.
    if (replyPlaying) {
      try { ws.send(JSON.stringify({ t: 'barge' })); } catch { /* socket gone */ }
      stopLocalPlayback();
      replyPlaying = false;
    }
    talking = true;
    sentChunks = 0;
    // Visible proof the press registered — the button looks identical held or
    // not otherwise; the chunk count then climbs so a dead mic is visible too.
    updateTalkButton();
    setState('Listening…');
  }
  function releaseTalk() {
    if (callMode === 'open') return;   // no hold in open mic — release is a no-op
    if (!talking) return;
    talking = false;
    updateTalkButton();
    try { ws.send(JSON.stringify({ t: 'release' })); } catch { /* */ }
    // If nothing was captured, say so plainly rather than spinning on "Thinking…"
    // for a turn that will never have input.
    setState(sentChunks > 0 ? 'Thinking…' : 'Didn’t catch any audio — is the mic working? Hold and speak again.');
  }

  function teardown() {
    try {
      if (procNode) {
        if (usingWorklet) { try { procNode.port.onmessage = null; } catch { /* */ } }
        else { try { procNode.onaudioprocess = null; } catch { /* */ } }
        procNode.disconnect();
      }
    } catch { /* */ }
    try { if (sourceNode) sourceNode.disconnect(); } catch { /* */ }
    try { if (micStream) micStream.getTracks().forEach((t) => t.stop()); } catch { /* */ }
    procNode = sourceNode = micStream = null;
    talking = false;
    setLive(false);
  }

  function endCall() {
    try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); } catch { /* */ }
    ws = null;
    teardown();
    setState('Call ended.');
  }

  // ── Wire the buttons once the DOM is ready ─────────────────────────────
  function init() {
    const start = $('voice-call-btn');
    const talk = $('voice-call-talk');
    if (!start) return;
    start.addEventListener('click', startCall);
    // Until a call is live the Hold-to-talk button is hidden, so on a phone my
    // human long-presses THIS button and gets the browser's context menu instead
    // of anything useful. Suppress it here too — the CSS stops the callout, this
    // stops the menu event.
    start.addEventListener('contextmenu', (e) => e.preventDefault());
    if (talk) {
      // Hold-to-talk has to survive the browser's gesture handling. On a
      // touchscreen (and a trackpad long-press) a plain held button is read as
      // a scroll/long-press gesture, which fires `pointercancel` almost at
      // once — releasing the hold instantly, so it behaves like a tap and never
      // captures speech. Two things stop that:
      //   1. CAPTURE the pointer on down, so every later move/up/cancel targets
      //      this button even if the finger drifts off it, and the browser does
      //      not hand the gesture to a scroller.
      //   2. `touch-action: none` (in CSS) so the hold is never claimed as a pan.
      const press = (e) => {
        e.preventDefault();
        try { talk.setPointerCapture(e.pointerId); } catch { /* some pointers can't be captured */ }
        pressTalk();
      };
      const release = (e) => {
        try { if (e?.pointerId != null) talk.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
        releaseTalk();
      };
      talk.addEventListener('pointerdown', press);
      talk.addEventListener('pointerup', release);
      talk.addEventListener('pointercancel', release);
      // A window-level pointerup is the fallback for the rare case capture did
      // not take and the finger lifted off the button — releaseTalk is
      // idempotent, so a double release is harmless.
      window.addEventListener('pointerup', releaseTalk);
      // A long-press must not raise the context menu or selection callout: both
      // steal the gesture and end the hold early — the reported "only a click".
      talk.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
