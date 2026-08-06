/**
 * voice-discord-adapter.js — the Discord `CallAdapter` (voice Pass 3, spec §3.3).
 *
 * Transport only, exactly like `voice-web-adapter.js`: it bridges ONE Discord
 * voice connection to the call engine and nothing else. Inbound speaker audio
 * (Opus → PCM) goes to the engine's hooks; the engine's spoken reply (24 kHz
 * mono) goes back out through an AudioPlayer. It never touches a session, an
 * audience, or a model — that is the engine's job (§3), which is what let a
 * second transport be a drop-in behind the same contract.
 *
 * ── The two format seams (the only real work here) ──────────────────────────
 * Discord voice is always 48 kHz stereo s16le Opus; the ASR wants 16 kHz mono
 * and TTS emits 24 kHz mono. So:
 *   receive:  Opus packet → decode (opusscript) → 48 kHz stereo → 16 kHz mono → pushAudio
 *   play:     24 kHz mono reply → 48 kHz stereo → AudioResource(Raw) → the player
 * Discord's own SPEAKING start/end events are the utterance boundary — no
 * push-to-talk, no VAD guessing (cleaner than the web adapter): speaking-start
 * opens a per-speaker subscription + decoder; speaking-end finalises the
 * utterance and tears them down.
 *
 * ── Testability ─────────────────────────────────────────────────────────────
 * The `@discordjs/voice` functions and the Opus decoder are INJECTED (`deps`),
 * defaulting to the real libraries, so the adapter is unit-tested against a fake
 * voice connection with no socket, no UDP, no Opus — the same seam discipline as
 * the web adapter's injected `send`. The resample helpers are pure and exported.
 */

import { PassThrough } from 'node:stream';

// ── Pure format helpers (exported for tests — no discord dep) ────────────────

/** Read a whole s16le Buffer as an Int16Array view (no copy when aligned). */
function asInt16(buf) {
  // A Buffer's byteOffset may be non-zero (it's a view into a shared pool), so
  // slice the underlying ArrayBuffer to the exact region before viewing it as
  // Int16 — otherwise the view starts at the wrong sample and the audio is noise.
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
}

/** Int16Array → s16le Buffer. */
function fromInt16(arr) {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.length * 2);
}

/**
 * Linear-interpolation resample of a mono Int16Array from inRate to outRate.
 * Linear is plenty for speech at these ratios (3:1 down, 2:1 up) and needs no
 * FIR/anti-alias table — the whole point of staying pure-JS with no native lib.
 */
export function resampleMono(mono, inRate, outRate) {
  if (inRate === outRate) return mono;
  const outLen = Math.max(0, Math.floor((mono.length * outRate) / inRate));
  const out = new Int16Array(outLen);
  const step = inRate / outRate;
  const lastIdx = mono.length - 1;
  for (let j = 0; j < outLen; j++) {
    const pos = j * step;
    const i = Math.floor(pos);
    const frac = pos - i;
    const a = mono[i] ?? 0;
    const b = mono[Math.min(i + 1, lastIdx)] ?? a;
    out[j] = (a * (1 - frac) + b * frac) | 0;
  }
  return out;
}

/** Interleaved stereo Int16Array → mono Int16Array by averaging L+R. */
export function downmixStereoToMono(stereo) {
  const out = new Int16Array(stereo.length >> 1);
  for (let k = 0; k < out.length; k++) out[k] = (stereo[2 * k] + stereo[2 * k + 1]) >> 1;
  return out;
}

/** Mono Int16Array → interleaved stereo Int16Array by duplicating each sample. */
export function monoToStereo(mono) {
  const out = new Int16Array(mono.length * 2);
  for (let k = 0; k < mono.length; k++) { out[2 * k] = mono[k]; out[2 * k + 1] = mono[k]; }
  return out;
}

/**
 * A decoded Discord frame (48 kHz stereo s16le Buffer) → 16 kHz mono s16le
 * Buffer for the ASR. Downmix first, then decimate — cheaper and identical
 * to the reverse order for a linear pass.
 */
export function stereo48ToMono16(pcm48Stereo) {
  const mono48 = downmixStereoToMono(asInt16(pcm48Stereo));
  const mono16 = resampleMono(mono48, 48000, 16000);
  return fromInt16(mono16);
}

/**
 * A reply frame (mono s16le at `inRate`, TTS is 24 kHz) → 48 kHz stereo s16le
 * Buffer for `createAudioResource(..., { inputType: Raw })`. Discord voice is
 * 48 kHz stereo; the library encodes our raw PCM to Opus itself.
 */
export function monoToStereo48(pcmMono, inRate = 24000) {
  const up = resampleMono(asInt16(pcmMono), inRate, 48000);
  return fromInt16(monoToStereo(up));
}

// ── Default dependency wiring (lazy so a missing dep degrades, never crashes) ─

/**
 * Load the real transport libraries. Kept behind a function + injectable so the
 * whole adapter is testable with fakes, and so a failed install surfaces as an
 * honest "Discord voice unavailable" instead of a boot crash (graceful
 * degradation — no module may take down the chat path).
 */
export async function loadDiscordVoiceDeps({ log = () => {} } = {}) {
  const voice = await import('@discordjs/voice');
  const { default: OpusScript } = await import('opusscript');
  // libsodium is what @discordjs/voice uses for packet encryption. Its WASM must
  // be READY before the first voice packet, or the connection handshakes and
  // then silently never reaches Ready (the "joins but join-failed" symptom). We
  // await it for real and surface a failure — a missing/broken encryption lib is
  // the single most common cause of a voice connection that won't come up.
  try {
    const sodium = await import('libsodium-wrappers');
    await (sodium.ready ?? sodium.default?.ready);
  } catch (err) {
    log(`libsodium not ready — voice packets can't be encrypted: ${err?.message ?? err}`);
  }
  return {
    joinVoiceChannel: voice.joinVoiceChannel,
    createAudioPlayer: voice.createAudioPlayer,
    createAudioResource: voice.createAudioResource,
    entersState: voice.entersState,
    generateDependencyReport: voice.generateDependencyReport,
    EndBehaviorType: voice.EndBehaviorType,
    StreamType: voice.StreamType,
    VoiceConnectionStatus: voice.VoiceConnectionStatus,
    AudioPlayerStatus: voice.AudioPlayerStatus,
    NoSubscriberBehavior: voice.NoSubscriberBehavior,
    makeOpusDecoder: () => new OpusScript(48000, 2, OpusScript.Application.AUDIO),
  };
}

/**
 * @param {object}   opts
 * @param {object}   opts.hooks    engine hooks: { pushAudio, endUtterance, rosterChanged }
 * @param {object}   opts.joinSpec { guildId, channelId, adapterCreator, wardUserId?, nameForUser? }
 * @param {object}   opts.deps     injected transport lib (defaults to loadDiscordVoiceDeps())
 * @param {function} [opts.slugId] display-name → readable speakerRef slug
 * @param {function} [opts.log]
 * @returns {{ adapter: object }}
 */
export function createDiscordCallAdapter({ hooks, joinSpec, deps, slugId = (s) => s, log = () => {} } = {}) {
  let connection = null;
  let player = null;
  let callId = null;
  let speaking = false;
  let barged = false;
  const decoders = new Map();       // speakerRef → { decoder, sub }
  const roster = new Set();         // userIds currently in the channel

  // Resolve a Discord user id to the engine's speakerRef. The ward is reserved
  // for discordWardUserId (their voice, and only theirs, can move the threat
  // tier — Pass 2 D2); everyone else is a readable slug of their display name so
  // the audience gate (Pass 3b) can key on a stable, greppable id.
  function speakerRefFor(userId) {
    if (joinSpec.wardUserId && userId === joinSpec.wardUserId) return 'ward';
    const name = joinSpec.nameForUser?.(userId) || `user-${userId}`;
    return slugId(name);
  }

  function openSpeaker(userId) {
    const speakerRef = speakerRefFor(userId);
    if (decoders.has(speakerRef)) return;   // already subscribed (a second speaking-start)
    let entry;
    try {
      const decoder = deps.makeOpusDecoder();
      const sub = connection.receiver.subscribe(userId, { end: { behavior: deps.EndBehaviorType.Manual } });
      entry = { decoder, sub };
      decoders.set(speakerRef, entry);
      sub.on('data', (opusPacket) => {
        try {
          const pcm48 = decoder.decode(opusPacket);            // 48 kHz stereo s16le
          if (pcm48?.length) hooks.pushAudio({ callId, speakerRef, pcm: stereo48ToMono16(pcm48) });
        } catch (err) { log(`opus decode failed for ${speakerRef}: ${err?.message ?? err}`); }
      });
      sub.on('error', (err) => log(`receive stream error for ${speakerRef}: ${err?.message ?? err}`));
    } catch (err) { log(`subscribe failed for ${userId}: ${err?.message ?? err}`); return; }
  }

  function closeSpeaker(userId) {
    const speakerRef = speakerRefFor(userId);
    const entry = decoders.get(speakerRef);
    if (!entry) return;
    decoders.delete(speakerRef);
    // Discord's speaking-end IS the utterance boundary (like push-to-talk's
    // release): finalise this speaker's stream now so the engine transcribes it.
    try { hooks.endUtterance({ callId, speakerRef }); } catch (err) { log(`endUtterance failed for ${speakerRef}: ${err?.message ?? err}`); }
    try { entry.sub.destroy(); } catch { /* already gone */ }
    try { entry.decoder.delete?.(); } catch { /* opusscript frees its wasm */ }
  }

  const adapter = {
    id: 'discord',
    capabilities: { perSpeakerStreams: true, roster: true, ring: false },

    async joinCall() {
      connection = deps.joinVoiceChannel({
        channelId: joinSpec.channelId,
        guildId: joinSpec.guildId,
        adapterCreator: joinSpec.adapterCreator,
        selfDeaf: false,   // I have to HEAR my human to answer them
        selfMute: false,
      });

      // Observability first: the voice handshake is a multi-step dance over a
      // second WebSocket + UDP that we can't see from the main gateway. Log every
      // state transition and error so a stall is diagnosable from the terminal
      // instead of a bare "join-failed" (the failures-that-matter-are-observable
      // rule). One-time dependency report names the encryption/Opus libs in play.
      try { log(`voice deps: ${deps.generateDependencyReport?.() ?? 'n/a'}`); } catch { /* */ }
      connection.on('stateChange', (oldS, newS) => log(`voice connection: ${oldS?.status} → ${newS?.status}`));
      connection.on('error', (err) => log(`voice connection error: ${err?.message ?? err}`));

      try {
        await deps.entersState(connection, deps.VoiceConnectionStatus.Ready, 30_000);
      } catch (err) {
        // Name WHERE it stalled — the last state is the clue (stuck in
        // 'signalling' = no VOICE_SERVER_UPDATE; 'connecting' = UDP/encryption).
        const stuckAt = connection?.state?.status ?? 'unknown';
        try { connection.destroy(); } catch { /* */ }
        connection = null;
        throw new Error(`voice connection never reached Ready (stuck at '${stuckAt}'): ${err?.message ?? err}`);
      }

      player = deps.createAudioPlayer({ behaviors: { noSubscriber: deps.NoSubscriberBehavior.Pause } });
      connection.subscribe(player);

      // Per-speaker capture is driven by Discord's speaking events.
      connection.receiver.speaking.on('start', (userId) => openSpeaker(userId));
      connection.receiver.speaking.on('end', (userId) => closeSpeaker(userId));

      callId = `discord-${joinSpec.guildId}-${Date.now()}`;
      log(`joined voice channel ${joinSpec.channelId} in guild ${joinSpec.guildId}`);
      return { callId };
    },

    async leaveCall() {
      for (const [, entry] of decoders) {
        try { entry.sub.destroy(); } catch { /* */ }
        try { entry.decoder.delete?.(); } catch { /* */ }
      }
      decoders.clear();
      roster.clear();
      try { player?.stop(true); } catch { /* */ }
      try { connection?.destroy(); } catch (err) { log(`connection destroy failed: ${err?.message ?? err}`); }
      connection = null; player = null; callId = null;
    },

    /**
     * Speak a reply. `reply` is an async iterable of mono PCM Buffers (the TTS
     * worker's stream, 24 kHz) or null. We pump resampled 48 kHz stereo into a
     * PassThrough that a Raw AudioResource consumes, so first audio is one
     * sentence in, not the whole reply — and a barge stops both the pull and
     * the player. Resolves when playback goes idle (or is barged/stopped).
     */
    async playAudio(_id, reply) {
      if (reply == null) return;             // nothing to say — Discord just stays quiet
      if (!player) { log('playAudio with no player — reply dropped'); return; }
      const inRate = reply?.sampleRate || 24000;
      const pass = new PassThrough();
      const resource = deps.createAudioResource(pass, { inputType: deps.StreamType.Raw });
      barged = false;
      speaking = true;

      const idle = new Promise((resolve) => {
        const onIdle = () => { player.off('error', onErr); resolve(); };
        const onErr = (err) => { log(`audio player error: ${err?.message ?? err}`); player.off(deps.AudioPlayerStatus.Idle, onIdle); resolve(); };
        player.once(deps.AudioPlayerStatus.Idle, onIdle);
        player.once('error', onErr);
      });

      player.play(resource);
      (async () => {
        try {
          for await (const chunk of reply) {
            if (barged) break;
            if (chunk?.length) pass.write(monoToStereo48(chunk, inRate));
          }
        } catch (err) { log(`discord playback stream failed: ${err?.message ?? err}`); }
        finally { pass.end(); }
      })();

      try { await idle; } finally { speaking = false; }
    },

    async stopPlayback() {
      barged = true;                 // makes the in-flight pump break on its next chunk
      try { player?.stop(); } catch { /* */ }   // → AudioPlayerStatus.Idle, which resolves playAudio
    },

    isSpeaking() { return speaking; },

    /**
     * Roster change from a VOICE_STATE_UPDATE the gateway forwards. `present` is
     * whether the user is now in THIS call's channel. Feeds the engine's roster
     * hook so the Pass 3b audience set knows who is in the room.
     */
    onVoiceStateChange({ userId, channelId } = {}) {
      if (!callId) return;
      const present = channelId === joinSpec.channelId;
      const was = roster.has(userId);
      if (present && !was) roster.add(userId);
      else if (!present && was) { roster.delete(userId); closeSpeaker(userId); }
      else return;
      try { hooks.rosterChanged({ callId, members: [...roster] }); } catch (err) { log(`rosterChanged failed: ${err?.message ?? err}`); }
    },
  };

  return { adapter };
}
