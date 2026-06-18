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
};
