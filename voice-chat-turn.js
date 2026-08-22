/**
 * voice-chat-turn.js — one spoken chat turn over /api/chat, shared by every call
 * transport (web Pass 2, Discord Pass 3b).
 *
 * Extracted from voice-call-server.js when the Discord ward turn needed the exact
 * same request (the no-copy-paste rule). It owns only the provider round-trip and
 * its RULE-A guarantees; the caller owns history, sessions, and who is allowed to
 * speak (the audience gate). `sessionAudience` is passed THROUGH to /api/chat so
 * the server enriches + gates the turn for the right surface — this module never
 * decides audience itself.
 */

import { extractContent } from './llm-call.js';

// A hung turn must not hang the call forever. The enriched chat path can be slow
// (an MCP cold start on the first turn, a thinking model), but it has to end so
// the caller can reset my human off "Thinking…". Generous, but finite.
const VOICE_TURN_TIMEOUT_MS = 90_000;

/**
 * @param {object}   deps
 * @param {number}   deps.port
 * @param {function} deps.readSettings          () => settings
 * @param {function} deps.connectionForFeature  (settings, feature) => {provider, apiKey, model}
 * @param {function} [deps.log]
 * @param {function} [deps.fetchFn]             injectable for tests
 * @returns {function} runVoiceTurn({ transcript, history?, sessionAudience? }) => Promise<string|null>
 */
export function createVoiceChatTurn({ port, readSettings, connectionForFeature, log = () => {}, fetchFn = fetch } = {}) {
  return async function runVoiceTurn({ transcript, history = [], sessionAudience = 'ward-private' } = {}) {
    const text = String(transcript ?? '').trim();
    if (!text) return null;
    const s = readSettings();
    const conn = connectionForFeature(s, 'chat') || connectionForFeature(s, 'pondering');
    if (!(conn?.apiKey && conn?.provider && conn?.model)) {
      log('no usable connection for a voice turn — staying silent');
      return null;
    }
    const messages = [...history, { role: 'user', content: text }];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), VOICE_TURN_TIMEOUT_MS);
    const started = Date.now();
    try {
      const res = await fetchFn(`http://127.0.0.1:${port}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          provider: conn.provider, apiKey: conn.apiKey, model: conn.model,
          // NO tool loop on a call — a spoken "Eury?" wants a fast "Hey?", not a
          // 19-tool research task. That lands the request on /api/chat's RAW
          // non-stream passthrough, so we replicate BOTH of callProviderChat's
          // guarantees ourselves (RULE A, 0.9 post-mortem): a generous max_tokens
          // (a thinking model bills reasoning against the cap — no cap = empty
          // content = dead silence) and extractContent at the reply boundary
          // (the answer may sit in reasoning_content, not content).
          messages, stream: false, runToolLoop: false, enrich: true,
          max_tokens: 4000,
          userMessage: text,
          voiceMode: true,          // reply comes out speech-shaped, not screen-shaped
          injectCorePrompts: true,  // no browser here — the server folds in the ward's four core prompts
          sessionAudience,          // the caller's gate decides this — passed through, never invented here
        }),
      });
      const data = await res.json().catch(() => null);
      const reply = extractContent(data?.choices?.[0]?.message ?? {});
      if (!res.ok) { log(`voice turn /api/chat returned ${res.status}: ${JSON.stringify(data)?.slice(0, 300)}`); return null; }
      if (!reply) { log(`voice turn produced no content after ${Date.now() - started}ms (thinking model with empty content?)`); return null; }
      return reply;
    } catch (err) {
      if (err?.name === 'AbortError') log(`voice turn timed out after ${VOICE_TURN_TIMEOUT_MS}ms — giving up so the call can reset`);
      else log(`voice turn /api/chat failed: ${err?.message ?? err}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
