/**
 * llm-call.js — one chat-completion call for the autonomous background loops.
 *
 * pondering / reach-out / memorization / tome-graduation each carried their own
 * byte-identical `defaultCallLLM` (differing only in temperature + max_tokens).
 * That duplication meant one shared bug: none handled THINKING models. On a
 * reasoning model (common via NanoGPT — GLM/DeepSeek think by default), the
 * chain-of-thought is billed against `max_tokens`, so a small cap (600–1200)
 * gets spent reasoning and the response comes back with an EMPTY
 * `message.content` — surfacing as the "Provider returned empty content" the
 * loops kept logging. This one helper fixes it in a single place:
 *
 *   - a generous default cap (a cap is free for non-thinking models — they stop
 *     when done — and gives a thinking model room to finish),
 *   - a fall back to `reasoning_content` / `reasoning` when `content` is empty
 *     (some proxies leave the answer only there), so a JSON-emitting caller can
 *     still find its object,
 *   - an error that names `finish_reason` so a genuine empty is DIAGNOSABLE
 *     ("finish_reason=length" = raise the cap) instead of a bare mystery.
 *
 * NOT used by the safety-critical triage path (cerebellum) — that call is
 * ward-signed and stays where it is; migrating it needs the ward's sign-off.
 */

import { PROVIDER_URLS } from './providers.js';

const DEFAULT_MAX_TOKENS = 4000;

/**
 * Pull the assistant text out of a completion's `message`, tolerating thinking
 * models: the answer is normally in `content`, but some OpenAI-compatible
 * proxies leave `content` empty and put everything (including the JSON a caller
 * wants) in `reasoning_content` / `reasoning` — fall back to those. Returns ''
 * when there's genuinely nothing. Exported so callers with their own response
 * handling (e.g. memorization, which also reads finish_reason) share the rule.
 */
export function extractContent(message = {}) {
  const content = message?.content ?? '';
  if (content) return content;
  return message?.reasoning_content || message?.reasoning || '';
}

/**
 * Normalise a completion's `message` in place so `content` carries the answer a
 * non-stream caller reads. A thinking model leaves `content` empty with the
 * answer in `reasoning_content`; without this, a raw passthrough hands the
 * caller an empty string and the reply silently vanishes (RULE A — the voice
 * turn, guide-chat, the handoff summariser all read `.content`). A response
 * carrying `tool_calls` is left untouched: empty content beside a tool call is
 * legitimate, and reasoning is not an answer there. Returns the same message.
 */
export function foldReasoningIntoContent(message) {
  if (!message || message.content || message.tool_calls?.length) return message;
  const recovered = extractContent(message);
  if (recovered) message.content = recovered;
  return message;
}

/**
 * Call the provider's chat-completions endpoint and return the assistant text.
 * Throws on a transport/HTTP/parse error or a genuinely empty completion (with
 * a diagnostic message). `fetchFn` is injectable for tests.
 */
export async function callProviderChat({
  provider, apiKey, model, prompt, messages,
  maxTokens = DEFAULT_MAX_TOKENS, temperature = 0.7, fetchFn = fetch,
}) {
  const url = PROVIDER_URLS[provider];
  if (!url) throw new Error(`Unknown provider: ${provider}`);

  const msgs = Array.isArray(messages) ? messages : [{ role: 'user', content: prompt }];
  const resp = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${String(apiKey ?? '').trim()}`,
    },
    body: JSON.stringify({
      model:       String(model ?? '').trim(),
      messages:    msgs,
      stream:      false,
      temperature,
      max_tokens:  maxTokens,
    }),
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Provider ${provider} returned ${resp.status}: ${text.slice(0, 200)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Provider returned non-JSON response.'); }
  if (data.error) throw new Error(typeof data.error === 'string' ? data.error : (data.error.message ?? 'Provider error'));

  const content = extractContent(data.choices?.[0]?.message ?? {});
  if (!content) {
    const fr = data.choices?.[0]?.finish_reason;
    const hint = fr === 'length'
      ? ' — the response hit the token cap (a thinking model likely spent the budget reasoning; raise max_tokens)'
      : '';
    throw new Error(`Provider returned empty content (finish_reason=${fr ?? 'unknown'})${hint}.`);
  }
  return content;
}
