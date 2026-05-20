/**
 * Canonical OpenAI-compatible chat-completions URLs per provider tag.
 *
 * Used in two places:
 *   - server.js fetches these directly from POST /api/chat (proxy).
 *   - thalamus.js passes the matching URL to entity-core as
 *     ENTITY_CORE_LLM_BASE_URL (and ZAI_BASE_URL for z.ai providers).
 *     Despite the env name, entity-core treats it as the full endpoint
 *     (its createLLMClient does `fetch(baseUrl, { method: 'POST', ... })`
 *     with NO path appending), so the value really has to include
 *     /chat/completions — see Psycheros entity-core-v0.2.2,
 *     packages/entity-core/src/llm/client.ts:213.
 *
 * When adding a provider: add the full URL here, update the matching
 * provider-tag string in public/app.js's connection editor, and add a
 * server.js validation entry if necessary. Don't fork these per file.
 */
export const PROVIDER_URLS = {
  nanogpt:      'https://nano-gpt.com/api/v1/chat/completions',
  zai:          'https://api.z.ai/api/paas/v4/chat/completions',
  'zai-coding': 'https://api.z.ai/api/coding/paas/v4/chat/completions',
};
