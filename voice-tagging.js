/**
 * voice-tagging.js — the room-sound tagger seam a live call hands to the engine
 * (voice spec §8.4), plus the per-call classify/dedup wrapper the servers use.
 *
 * ANNOTATION-ONLY this milestone. The engine calls `tagSegment(samples, rate)` on
 * each finalized utterance when tagging is on; it loads the tagging model on the
 * worker (idempotent), runs the `tag` op, and hands back the RAW AudioSet events.
 * The classification into a plain "what I can hear" line — and the safety-shaped
 * decisions about which sounds to drop — live in `voice-audio-tags.js`, so this
 * module is only the model plumbing. Nothing here reads tone or moves the threat
 * tier; §8.4's care ambitions are a separate, ward-signed spec.
 *
 * Both call servers (web + Discord) share this so the tagger is wired ONE way, not
 * copy-pasted per transport. The worker is injected (`getWorkerThen`), never
 * imported — the same discipline as voice-enroll.js.
 *
 * Off-switch: `PROTO_FAMILIAR_AUDIO_TAGGING_DISABLED=1` hard-disables it even if
 * the ward's setting is on; the setting `voiceAudioTaggingEnabled` (default OFF)
 * is the ward's toggle.
 */

import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyRoomSounds } from './voice-audio-tags.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TAGGING_MODEL_DIR = path.join(__dirname, 'models', 'audio', 'tagging-audioset');

const LOAD_TIMEOUT_MS = 180_000;   // a cold onnx load off laptop disk
const TAG_TIMEOUT_MS  = 30_000;    // one short clip

/** The hard off-switch, checked wherever tagging would run. */
export function audioTaggingDisabled() {
  return process.env.PROTO_FAMILIAR_AUDIO_TAGGING_DISABLED === '1'
    || process.env.PROTO_FAMILIAR_VOICE_DISABLED === '1';
}

/** Is the tagging model actually unpacked (an .onnx present), not just the dir? */
export function taggingModelPresent(dir = TAGGING_MODEL_DIR) {
  try {
    if (existsSync(path.join(dir, 'model.onnx'))) return true;
    return readdirSync(dir).some((f) => f.endsWith('.onnx'));
  } catch { return false; }
}

/**
 * Build the `tagSegment` seam for a call engine. Returns null-resolution (no tags)
 * whenever tagging is off, hard-disabled, or the model isn't installed — so the
 * engine's tap stays inert until the ward opts in AND the model is present, never
 * guessing and never throwing into the call.
 *
 * @param {object} deps
 * @param {function} deps.getWorkerThen  async (fn) => fn(worker) | {ok:false}
 * @param {function} deps.readSettings   () => settings
 * @param {function} [deps.taggingEnabled] (settings) => boolean  (defaults to the setting)
 * @param {string}   [deps.modelDir]
 * @param {function} [deps.log]
 * @returns {(samples:Float32Array, sampleRate:number) => Promise<Array|null>}
 */
export function createTagSegment({ getWorkerThen, readSettings, taggingEnabled, modelDir = TAGGING_MODEL_DIR, log = () => {} } = {}) {
  const enabled = typeof taggingEnabled === 'function'
    ? taggingEnabled
    : (s) => s?.voiceAudioTaggingEnabled === true;
  return async function tagSegment(samples, sampleRate) {
    try {
      if (audioTaggingDisabled()) return null;
      if (!enabled(readSettings() || {})) return null;
      if (!taggingModelPresent(modelDir)) return null;
      const out = await getWorkerThen(async (w) => {
        const loaded = await w.request({ op: 'load', role: 'tagging', modelDir }, { timeoutMs: LOAD_TIMEOUT_MS });
        if (!loaded?.ok) return null;
        const r = await w.request({ op: 'tag', samples: Array.from(samples), sampleRate }, { timeoutMs: TAG_TIMEOUT_MS });
        return r?.ok && Array.isArray(r.events) ? r.events : null;
      });
      return Array.isArray(out) ? out : null;
    } catch (err) { log(`room-sound tagging failed: ${err?.message ?? err}`); return null; }
  };
}

/**
 * A per-call room-listener: keeps the "already mentioned" set for one call and
 * turns raw events into a one-off annotation line, deduped so a TV on the whole
 * time isn't re-announced every utterance. `note(events)` returns a string to
 * inject into the next turn's context (as a system line, never stored), or null.
 */
export function createRoomListener() {
  const seen = new Set();
  return {
    note(events) {
      const { line, phrases } = classifyRoomSounds(events, { seen });
      for (const p of phrases) seen.add(p);
      return line;
    },
    reset() { seen.clear(); },
  };
}

/**
 * A per-call map of room listeners, so both call servers (web + Discord) share ONE
 * lazy get-or-create instead of each keeping its own identical Map + helper.
 * `.for(callId)` returns (creating on first use) that call's listener; `.forget`
 * drops it on hang-up.
 */
export function createRoomListenerMap() {
  const byCall = new Map();
  return {
    for(callId) {
      let l = byCall.get(callId);
      if (!l) { l = createRoomListener(); byCall.set(callId, l); }
      return l;
    },
    forget(callId) { byCall.delete(callId); },
  };
}
