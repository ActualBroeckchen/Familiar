/**
 * core-prompts.js — the ward's four authored prompt fields, assembled server-side.
 *
 * System Prompt, Character Profile, User (Human) Profile, and Post-History Prompt
 * are what make the Familiar *itself* on every surface: who they are, who their
 * human is, and the standing instruction that rides after the conversation. On
 * the web these are assembled by the browser (`_buildApiMessagesInner` in
 * public/app.js) and POSTed inside the messages array. A server-initiated turn —
 * Discord text, a voice call — has NO browser, so without this the Familiar
 * answered those surfaces with none of its identity: the reported "my Familiar
 * doesn't see the user prompt at all on Discord."
 *
 * This is the ONE server-side mirror of that client assembly. Keep it in step
 * with public/app.js: the order (system → [Character Profile] → [Human Profile]),
 * the exact headers, and the join. Macros resolve here the way `applyNameVars`
 * resolves them there — {{user}}/{{char}} become the configured names, so a
 * literal token never reaches the model. (The client also expands two chat-timing
 * macros that have no meaning off the web session model; they aren't mirrored.)
 *
 * Lorebook/tome interleaving is deliberately NOT here — that is a richer,
 * browser-only assembly. This module is exactly the four identity fields the
 * ward configures, the ones that must be present on every surface.
 */

import { substituteMacros } from './macros.js';

/**
 * The system-message segment built from the three system-level fields, in the
 * same order and with the same headers the web client uses. Empty string when
 * none are configured (so a `.filter(Boolean)` drops it cleanly).
 * @param {object} settings
 * @returns {string}
 */
export function coreSystemSegment(settings = {}) {
  const sys  = String(settings?.systemPrompt      ?? '').trim();
  const char = String(settings?.characterProfile  ?? '').trim();
  const user = String(settings?.userProfile       ?? '').trim();

  const parts = [];
  if (sys)  parts.push(sys);
  if (char) parts.push('[Character Profile]\n' + char);
  if (user) parts.push('[Human Profile]\n' + user);
  if (parts.length === 0) return '';

  return substituteMacros(parts.join('\n\n---\n\n'), settings);
}

/**
 * The post-history prompt as its own message, appended AFTER the conversation
 * (the web client pushes it last). Role is ward-configurable (default 'system');
 * an unknown value falls back to 'system' exactly as the client does. Returns
 * null when unconfigured.
 * @param {object} settings
 * @returns {{role:'system'|'user'|'assistant', content:string} | null}
 */
export function postHistoryMessage(settings = {}) {
  const text = String(settings?.postHistoryPrompt ?? '').trim();
  if (!text) return null;
  const role = ['system', 'user', 'assistant'].includes(settings?.postHistoryRole)
    ? settings.postHistoryRole : 'system';
  return { role, content: substituteMacros(text, settings) };
}

/**
 * Fold the four core prompts into a bare message array the way a server surface
 * needs: the core system segment LEADS (so a static-identity prepend lands in
 * front of it, matching the web order static → persona), the post-history prompt
 * TRAILS the conversation (the web client appends it last). This is the single
 * source for the `injectCorePrompts` path in /api/chat — kept here, and tested,
 * rather than inline in the endpoint. A missing/empty field simply contributes
 * nothing.
 * @param {Array}  messages  the caller's messages (history + user turn)
 * @param {object} settings
 * @returns {Array}
 */
export function withCorePrompts(messages, settings = {}) {
  const base = Array.isArray(messages) ? messages : [];
  const coreSeg = coreSystemSegment(settings);
  const ph = postHistoryMessage(settings);
  return [
    ...(coreSeg ? [{ role: 'system', content: coreSeg }] : []),
    ...base,
    ...(ph ? [ph] : []),
  ];
}
