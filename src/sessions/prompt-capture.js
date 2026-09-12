/**
 * prompt-capture.js — the LAST message array actually sent to the model, per surface.
 *
 * The prompt inspector used to be a reconstruction: the web client re-derived
 * what it *believed* the prompt was from its own state plus the thalamus
 * envelope. That can only ever show the web path, and it shows what *should* be
 * assembled, not what left the building. When the Familiar reported not seeing
 * its core prompts on Discord, the inspector still cheerfully showed them —
 * because it was describing the web assembly, not the Discord payload.
 *
 * This captures the real thing at the real send boundary: whatever message array
 * is handed to the provider, on whichever surface, is recorded here verbatim
 * (last one per surface). `GET /api/last-prompt` reads it, so the inspector can
 * show ground truth for web, voice, AND Discord — the surfaces that have no
 * browser of their own to introspect.
 *
 * A ring of one-per-surface, not a log: the question this answers is "what did
 * the Familiar actually just receive on <surface>", and the newest answer is the
 * only one that matters. Capture must NEVER throw into a turn — a broken
 * inspector must not break the reply.
 */

const LAST = new Map(); // surface -> capture

/** How many characters of any single message we keep (safety valve on memory). */
const MAX_CHARS_PER_MESSAGE = 200_000;

function flatten(content) {
  if (typeof content === 'string') return content;
  // Vision turns carry content-parts (an array). Stringify so the inspector can
  // still show the shape without choking; the text parts stay readable.
  try { return JSON.stringify(content); } catch { return String(content ?? ''); }
}

/**
 * Record the outgoing payload for a surface. Overwrites the previous capture for
 * that surface. Best-effort — swallows everything.
 * @param {string} surface  'web' | 'voice' | 'discord' | 'discord-revisit' | …
 * @param {object} info
 * @param {Array}  info.messages   the exact array sent to the provider
 * @param {string} [info.model]
 * @param {string} [info.provider]
 */
export function recordOutgoingPrompt(surface, { messages, model = null, provider = null } = {}) {
  try {
    const list = Array.isArray(messages) ? messages : [];
    LAST.set(String(surface || 'unknown'), {
      surface: String(surface || 'unknown'),
      at: Date.now(),
      model,
      provider,
      messages: list.map((m) => {
        const content = flatten(m?.content).slice(0, MAX_CHARS_PER_MESSAGE);
        return {
          role: m?.role ?? 'user',
          content,
          ...(m?.name ? { name: m.name } : {}),
          ...(Array.isArray(m?.attachments) && m.attachments.length ? { attachmentCount: m.attachments.length } : {}),
          ...(m?.tool_calls ? { tool_calls: m.tool_calls } : {}),
        };
      }),
    });
  } catch { /* capture must never break a turn */ }
}

/** Every surface's latest capture, newest first. */
export function lastOutgoingPrompts() {
  return [...LAST.values()].sort((a, b) => b.at - a.at);
}

/** One surface's latest capture, or null. */
export function lastOutgoingPrompt(surface) {
  return LAST.get(String(surface || '')) ?? null;
}

/** Test/util: clear all captures. */
export function _clearOutgoingPrompts() {
  LAST.clear();
}
