/**
 * voice-synthesize.js — reply text → streamed TTS PCM, shared by every call
 * transport (web Pass 2, Discord Pass 3).
 *
 * Extracted from voice-call-server.js when the Discord adapter needed the exact
 * same synthesis (the no-copy-paste rule: a second consumer is the signal to
 * share, not to duplicate). Transport-neutral — it yields an async iterable of
 * PCM Buffers carrying a `sampleRate`; who plays them (a browser socket, a
 * Discord AudioResource) is the adapter's job.
 *
 * PocketTTS clones zero-shot per call, so each `prepareForSpeech` part is ONE
 * ttsStream — splitting a part per sentence would re-clone and drift the voice
 * (the read-aloud lesson). But the engine emits PCM incrementally during that
 * one generation, so this yields each frame as it lands: first audio arrives
 * after the first chunk, not the whole reply, with no extra clones and no drift.
 * An abort signal (barge-in) stops it between frames.
 */

import { prepareForSpeech } from './voice-speech.js';
import { KIND_PCM } from './audio-frame.js';

// A rolling 16-bit-safe stream id in a high band, kept clear of read-aloud's low
// ids so a read-aloud and a call in the same second don't share one. Shared
// across transports — only one call is ever live, so a single sequence is fine.
let ttsStreamSeq = 40000;
const nextTtsStreamId = () => (ttsStreamSeq = ttsStreamSeq >= 65500 ? 40000 : ttsStreamSeq + 1);

/** A well-formed empty stream — a reply with nothing speakable in it. */
export function emptyStream() {
  return { sampleRate: 24000, text: '', async *[Symbol.asyncIterator]() { /* nothing */ } };
}

/**
 * @param {object}   deps
 * @param {function} deps.readSettings            () => settings
 * @param {function} deps.getTtsWorker            () => Promise<worker>
 * @param {function} deps.resolveVoiceForSettings (settings) => Promise<{ok, path, reason?}>
 * @param {function} deps.ensureTtsLoaded         (worker) => Promise<{ok, sampleRate, reason?}>
 * @param {function} [deps.log]
 * @returns {function} synthesize(text, { signal }) => Promise<AsyncIterable<Buffer>&{sampleRate}>
 */
export function createSynthesizer({ readSettings, getTtsWorker, resolveVoiceForSettings, ensureTtsLoaded, log = () => {} } = {}) {
  return async function synthesize(text, { signal } = {}) {
    const s = readSettings();
    const parts = prepareForSpeech(text).parts;
    if (parts.length === 0) return emptyStream();

    const ttsWorker = await getTtsWorker();
    if (!ttsWorker) { log('no TTS worker — reply goes unspoken'); return emptyStream(); }
    const voice = await resolveVoiceForSettings(s);
    if (!voice?.ok) { log(`no voice resolved (${voice?.reason}) — reply goes unspoken`); return emptyStream(); }
    const loaded = await ensureTtsLoaded(ttsWorker);
    if (!loaded?.ok) { log(`TTS model not loaded (${loaded?.reason}) — reply goes unspoken`); return emptyStream(); }
    const sampleRate = Number(loaded.sampleRate) || 24000;

    // Bridge the worker's frame CALLBACK into a pull-based async generator: a
    // queue holds frames that have arrived; the generator awaits the next one
    // when the queue is empty, and ends when the request settles or a barge
    // aborts. This is what lets `for await` in the adapter play frame-by-frame.
    async function* streamPart(part) {
      const streamId = nextTtsStreamId();
      const queue = [];
      let wake = null;
      let settled = false;
      const bump = () => { if (wake) { wake(); wake = null; } };
      const unsub = ttsWorker.on((frame) => {
        if (frame.kind === KIND_PCM && frame.streamId === streamId && frame.pcm?.length) { queue.push(Buffer.from(frame.pcm)); bump(); }
      });
      const req = ttsWorker.request({ op: 'ttsStream', streamId, text: part, referenceWav: voice.path }, { timeoutMs: 300_000 })
        .then((r) => { if (!r?.ok) log(`ttsStream part failed: ${r?.reason ?? '?'}`); })
        .catch((err) => log(`ttsStream threw: ${err?.message ?? err}`))
        .finally(() => { settled = true; bump(); });
      try {
        while (true) {
          if (signal?.aborted) break;
          if (queue.length) { yield queue.shift(); continue; }
          if (settled) break;
          await new Promise((res) => { wake = res; });
        }
      } finally {
        unsub();
        await req.catch(() => {});   // let the request settle so a late frame can't leak past teardown
      }
    }

    return {
      sampleRate,
      // The spoken text rides along so a barge can be mapped back to "how far
      // did I get" without the engine having to know how the reply was built.
      text: String(text ?? ''),
      async *[Symbol.asyncIterator]() {
        for (const part of parts) {
          if (signal?.aborted) return;
          yield* streamPart(part);
        }
      },
    };
  };
}
