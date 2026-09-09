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

import { resolveProviderUrl, authHeader } from './providers.js';

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
 * The reply for an INTERACTIVE chat turn, unlike extractContent's blanket
 * reasoning fallback. A reasoning model whose budget ran out mid-thought
 * (finish_reason === 'length', empty content) has produced NO answer — only
 * chain-of-thought parked in reasoning_content. Surfacing that raw CoT as the
 * reply is the GLM-5.3 "thinking dump" bug. So:
 *   - real content wins,
 *   - empty + finish_reason 'length' → '' (budget exhausted: the caller treats
 *     it as no-reply — an honest note or a closing round, never a CoT dump),
 *   - empty otherwise → the reasoning fallback (a proxy that legitimately parks
 *     a *finished* answer in reasoning_content, the case extractContent serves).
 * Pass the whole `choice` so finish_reason is in scope.
 */
export function extractTurnReply(choice = {}) {
  const message = choice?.message ?? {};
  const content = message?.content ?? '';
  if (content && content.trim()) return content;
  if (choice?.finish_reason === 'length') return '';
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
  baseUrl = null,
  maxTokens = DEFAULT_MAX_TOKENS, temperature = 0.7, fetchFn = fetch,
  reasoningEffort = null,
}) {
  const url = resolveProviderUrl({ provider, baseUrl });
  if (!url) throw new Error(`Unknown provider: ${provider}`);

  const msgs = Array.isArray(messages) ? messages : [{ role: 'user', content: prompt }];
  const resp = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      // Omitted for a keyless local/custom endpoint (a Bearer with an empty
      // key 400s on some servers); required cloud providers always carry one.
      ...authHeader(apiKey),
    },
    body: JSON.stringify({
      model:       String(model ?? '').trim(),
      messages:    msgs,
      stream:      false,
      temperature,
      max_tokens:  maxTokens,
      // Opt-in only: callers that want it pass a resolved value. The ward-signed
      // triage call does NOT pass it, so its request stays byte-identical.
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
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
