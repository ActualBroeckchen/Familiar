/**
 * Canonical OpenAI-compatible chat-completions URLs per provider tag.
 *
 * Used in two places:
 *   - server.js fetches these directly from POST /api/chat (proxy).
 *   - thalamus.js passes the matching URL to Phylactery as
 *     PHYLACTERY_LLM_BASE_URL (and ZAI_BASE_URL for z.ai providers).
 *     Phylactery's consolidate.py also accepts the legacy
 *     ENTITY_CORE_LLM_BASE_URL alias. The value must be the full
 *     endpoint including /chat/completions — consolidate.py posts
 *     directly to it with no path appending.
 *
 * When adding a provider: add the full URL here, update the matching
 * provider-tag string in public/app.js's connection editor, and add a
 * server.js validation entry if necessary. Don't fork these per file.
 */
export const PROVIDER_URLS = {
  nanogpt:      'https://nano-gpt.com/api/v1/chat/completions',
  zai:          'https://api.z.ai/api/paas/v4/chat/completions',
  'zai-coding': 'https://api.z.ai/api/coding/paas/v4/chat/completions',
  // Google AI Studio (Gemini) via its OpenAI-compatible surface — same
  // Bearer-auth chat/completions shape every other consumer here expects,
  // so streaming, tools, and Phylactery consolidation all work unchanged.
  google:       'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  // OpenAI-compatible cloud presets — the popular chat sources SillyTavern
  // lists, all the same Bearer-auth chat/completions shape. A key is required.
  openai:       'https://api.openai.com/v1/chat/completions',
  openrouter:   'https://openrouter.ai/api/v1/chat/completions',
  deepseek:     'https://api.deepseek.com/v1/chat/completions',
  groq:         'https://api.groq.com/openai/v1/chat/completions',
  mistral:      'https://api.mistral.ai/v1/chat/completions',
  togetherai:   'https://api.together.xyz/v1/chat/completions',
  // Local presets — default localhost, key OPTIONAL (these servers ignore it).
  // A different host/port is set via the connection's `baseUrl` override.
  ollama:       'http://localhost:11434/v1/chat/completions',
  lmstudio:     'http://localhost:1234/v1/chat/completions',
};

// Providers whose API key is OPTIONAL: `custom` is bring-your-own (some
// endpoints need no key), and local servers (Ollama, LM Studio, and any
// custom llama.cpp / KoboldCpp / TabbyAPI / oobabooga URL) ignore it.
export const PROVIDER_KEYLESS = new Set(['custom', 'ollama', 'lmstudio']);

// Providers whose endpoint URL comes from the connection's own `baseUrl` (when
// set) rather than the static map above — so `custom` points anywhere, and the
// local presets can be moved off their default host/port.
const BASE_URL_PROVIDERS = new Set(['custom', 'ollama', 'lmstudio']);

/**
 * Turn a user-typed base URL into a full chat/completions endpoint. Accepts a
 * bare host (`http://localhost:11434` → `…/v1/chat/completions`), a versioned
 * base (`…/v1` → `…/v1/chat/completions`), or a full endpoint (returned as-is).
 * Empty in → empty out. The exact-values rule applied to a URL: code canonicalises
 * it, the model never types one.
 */
export function normalizeBaseUrl(base) {
  const u = String(base ?? '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (/\/chat\/completions$/i.test(u)) return u;
  if (/\/v\d+$/i.test(u)) return `${u}/chat/completions`;
  return `${u}/v1/chat/completions`;
}

/**
 * The chat/completions URL for a connection, or null when it can't be resolved
 * (a `custom` connection with no baseUrl). A base-URL provider with a baseUrl
 * uses it; everything else uses the static map.
 */
export function resolveProviderUrl(conn = {}) {
  const provider = conn?.provider;
  const base = String(conn?.baseUrl ?? '').trim();
  if (BASE_URL_PROVIDERS.has(provider) && base) return normalizeBaseUrl(base);
  return PROVIDER_URLS[provider] || null;
}

/** Does this provider require an API key? (false for local / custom.) */
export function providerRequiresKey(provider) {
  return !PROVIDER_KEYLESS.has(provider);
}

/**
 * Is this connection usable — a model, and a key when the provider needs one?
 * The single readiness test, replacing the scattered `conn?.apiKey && conn?.model`
 * checks so a keyless local/custom connection is accepted where those would have
 * rejected it. Deliberately does NOT check URL-resolvability: the old gate never
 * did either, and the call sites resolve the URL themselves (`resolveProviderUrl`
 * + an `if (!url)` guard), so a misconfigured `custom` with no baseUrl degrades
 * there rather than being silently filtered here.
 */
export function connectionReady(conn = {}) {
  if (!conn || !String(conn.model ?? '').trim()) return false;
  return !!(String(conn.apiKey ?? '').trim() || !providerRequiresKey(conn.provider));
}

/** The Authorization header for a request, or {} when the connection is keyless
 *  and carries no key (local servers 400 on a malformed header, not a missing one). */
export function authHeader(apiKey) {
  const key = String(apiKey ?? '').trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

// ── Reasoning effort (always-on-thinking models, GLM-5.3+) ──────────────────
//
// GLM-5.3 made thinking MANDATORY: it no longer accepts thinking:off, and
// `reasoning_effort` defaults to `max`. So a normally-shaped request spends its
// whole token budget on chain-of-thought and comes back with EMPTY content —
// which our reasoning_content fallback then surfaces as a raw "thinking dump",
// and whose empty/oddly-shaped turns dropped the user's own message. Sending an
// explicit, modest effort keeps chat turns answer-first.
//
// A connection may carry `reasoningEffort`: 'low' | 'high' | 'max' | 'off'.
//   - low/high/max → sent verbatim (honored for ANY provider — the ward's call).
//   - off/none     → never sent (explicit opt-out).
//   - unset        → auto-'low', but ONLY for providers we KNOW accept the
//                    param (the z.ai GLM family). Other providers (Google's
//                    OpenAI-compat, arbitrary NanoGPT models) receive it only
//                    when set explicitly, so an unset default can never
//                    introduce an unknown-param 400.
export const REASONING_EFFORT_VALUES = new Set(['low', 'high', 'max']);
const ALWAYS_THINKING_PROVIDERS = new Set(['zai', 'zai-coding']);

/** The reasoning_effort to send for a connection, or null to send none. */
export function resolveReasoningEffort(conn = {}) {
  const raw = String(conn?.reasoningEffort ?? '').trim().toLowerCase();
  if (REASONING_EFFORT_VALUES.has(raw)) return raw;
  if (raw === 'off' || raw === 'none') return null;
  return ALWAYS_THINKING_PROVIDERS.has(conn?.provider) ? 'low' : null;
}
