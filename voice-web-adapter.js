/**
 * voice-web-adapter.js — the web `CallAdapter` (voice spec §6.4, Pass 2b).
 *
 * Transport only. It bridges ONE browser connection to the call engine and
 * nothing else: inbound audio and a push-to-talk release come off the socket
 * and go to the engine's hooks; the engine's spoken reply and control signals
 * go back down the socket. It never touches a session, an audience, or a model
 * — that is the engine's job (§3), which is what lets a second transport
 * (Discord, Pass 3) be a drop-in.
 *
 * ── The wire protocol (deliberately tiny) ───────────────────────────────
 * Browser → server:
 *   - binary frame            → 16 kHz mono s16le PCM for the current press
 *   - `{"t":"release"}`       → push-to-talk released: finalise this utterance
 *   - `{"t":"barge"}`         → my human started talking over the reply (2c)
 * Server → browser:
 *   - `{"t":"speak-start"}`   → a spoken reply begins (browser opens playback)
 *   - binary frame            → 24 kHz mono s16le TTS PCM to play
 *   - `{"t":"speak-end"}`     → the reply is complete
 *   - `{"t":"no-reply"}`      → the turn finished with nothing to say (reset the UI)
 *   - `{"t":"stop"}`          → stop playback now (barge-in)
 *
 * `send` is injected (the real one is a WebSocket's `send`), so the adapter is
 * testable without a socket — the same seam discipline as `call-engine.js`'s
 * `onTurn` and the push-adapter registry. A `reply` from the engine is an async
 * iterable of PCM Buffers (what the TTS worker streams); `null` means nothing
 * to say, which is a valid turn.
 */

/**
 * @param {object}   opts
 * @param {object}   opts.hooks  engine hooks: { pushAudio, endUtterance, rosterChanged }
 * @param {function} opts.send   transmit to the browser: (data) => void  (Buffer or JSON string)
 * @param {function} [opts.log]
 * @returns {{ adapter: object, onMessage: function, onClose: function }}
 */
export function createWebCallAdapter({ hooks, send, log = () => {} } = {}) {
  let callId = null;
  let speaking = false;   // a reply is currently streaming out
  let barged = false;     // my human talked over it — stop sending this reply

  const control = (obj) => { try { send(JSON.stringify(obj)); } catch (err) { log(`web send failed: ${err?.message ?? err}`); } };

  const adapter = {
    id: 'web',
    capabilities: {
      perSpeakerStreams: true, // one browser = one speaker (my human)
      roster: false,           // no join/leave roster on the web
      ring: false,             // a browser tab cannot summon a human
    },
    async joinCall() {
      callId = `web-${Date.now()}`;
      return { callId };
    },
    async leaveCall() {
      callId = null;
    },
    /**
     * Speak a reply. `reply` is an async iterable of PCM Buffers (the TTS
     * worker's stream) or null. Framed with speak-start / speak-end so the
     * browser knows when to open and close playback; a per-chunk send keeps
     * first-audio latency at one sentence, not the whole reply.
     */
    async playAudio(_id, reply) {
      // A silent turn still has to be announced, or the browser sits on
      // "Thinking…" forever waiting for a reply that is never coming. `no-reply`
      // tells it the turn finished with nothing to say (or an error the server
      // logged) so it can reset and wait for the next press.
      if (reply == null) { control({ t: 'no-reply' }); return; }
      // The reply MAY carry a sample rate (TTS output rate) so the browser can
      // configure playback; a bare async-iterable (the default) omits it.
      const sampleRate = reply?.sampleRate;
      barged = false;
      speaking = true;
      control(sampleRate ? { t: 'speak-start', sampleRate } : { t: 'speak-start' });
      try {
        for await (const chunk of reply) {
          // Barge-in (2c): my human started talking over the reply. Stop sending
          // AND stop pulling — breaking the for-await runs the synthesis
          // generator's return()/finally, so TTS stops generating the rest
          // instead of finishing a reply nobody is listening to.
          if (barged) break;
          if (chunk && chunk.length) send(chunk);
        }
      } catch (err) {
        log(`web playback stream failed: ${err?.message ?? err}`);
      } finally {
        speaking = false;
        control({ t: 'speak-end' });
      }
    },
    async stopPlayback() {
      barged = true;   // makes an in-flight playAudio loop break on its next chunk
      control({ t: 'stop' });
    },
    /** Is a reply streaming out right now? Lets the engine gate a barge on real playback. */
    isSpeaking() { return speaking; },
  };

  /**
   * Feed one inbound socket message. `isBinary` — the flag the `ws` library
   * passes — is the ONLY discriminator: binary PCM audio vs a control JSON.
   *
   * ⚠️ Do NOT fall back to `Buffer.isBuffer(data)` to detect audio. The `ws`
   * library delivers TEXT frames as Buffers too, so that check classified every
   * control frame (`{"t":"release"}`) as audio and fed it to the recogniser as
   * PCM — the release never fired, the utterance never finalised, and a held
   * call transcribed nothing. (The old test hid this by passing control frames
   * as plain strings, a shape ws never actually sends.) `String(data)` decodes a
   * Buffer or a string equally, so parsing is shape-agnostic; routing must not be.
   *
   * Never throws: a malformed control frame is logged and dropped, because a
   * browser bug must not take the call down.
   */
  function onMessage(data, isBinary) {
    if (!callId) return; // audio arriving before joinCall, or after leave — ignore
    if (isBinary) {
      hooks.pushAudio({ callId, speakerRef: 'ward', pcm: data });
      return;
    }
    let msg;
    try { msg = JSON.parse(String(data)); } catch { log('web: dropped a non-JSON control frame'); return; }
    switch (msg?.t) {
      case 'release': hooks.endUtterance({ callId, speakerRef: 'ward' }); break;
      case 'barge': adapter.stopPlayback(); break; // 2c will also gate the reply itself
      default: /* unknown control — ignore, forward-compatible */ break;
    }
  }

  /** The socket closed: end the utterance so a mid-press drop still flushes, and drop the call id. */
  function onClose() {
    if (callId) { try { hooks.endUtterance({ callId, speakerRef: 'ward' }); } catch { /* best effort */ } }
    callId = null;
  }

  return { adapter, onMessage, onClose };
}
