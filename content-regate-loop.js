/**
 * Content-gating re-tag loop (ward-disclosure build spec, Phase B) — the driver.
 *
 * Thin wrapper around content-regate.js's pure runOneRetagTick: it wires the real
 * I/O (candidate query, village registry, the batched LLM judgment, the
 * updateMemoryById write) and paces itself on a slow interval.
 *
 * DEFAULT OFF. It re-tags my human's EXISTING private facts, so it stays dormant
 * until they enable "Review my private notes for content-sharing" in Settings —
 * and every fact it opens is written to the disclosure notice they read, and is
 * revertible. Hard off-switch: PROTO_FAMILIAR_CONTENT_REGATE_DISABLED=1. Mirrors
 * the tome-graduation loop shape. Never on the chat path.
 */

import { listContentGateCandidates, updateMemoryById, enrich } from './thalamus.js';
import { getRegistry } from './village.js';
import { isCallActiveFromFile } from './call-engine.js';
import { readSettingsSync, connectionForFeature } from './cerebellum.js';
import { PROVIDER_URLS } from './providers.js';
import { callProviderChat } from './llm-call.js';
import { substituteMacros } from './macros.js';
import { runOneRetagTick, DEFAULT_BATCH_SIZE } from './content-regate.js';

const DEFAULT_TICK_MS = 30 * 60_000;   // 30 min — draining a backlog wants no urgency
const CANDIDATE_LIMIT = 40;

let _started  = false;
let _interval = null;
let _active   = null;

function hardDisabled() {
  return process.env.PROTO_FAMILIAR_CONTENT_REGATE_DISABLED === '1';
}

function isEnabled() {
  if (hardDisabled()) return false;
  return readSettingsSync().contentRegateEnabled === true;   // opt-in
}

async function runTick() {
  if (!isEnabled()) return { reason: 'disabled' };
  const s = readSettingsSync();
  const conn = connectionForFeature(s, 'contentRegate');
  if (!conn?.apiKey || !conn?.model || !PROVIDER_URLS[conn.provider]) return { reason: 'no_connection' };

  // Identity rides as a leading system message so the Familiar judges in its own
  // voice; degrades to none. Fetched once per tick.
  const { static: identity } = await enrich('', { staticOnly: true }).catch(() => ({ static: '' }));

  const summary = await runOneRetagTick({
    getCandidates: () => listContentGateCandidates({ limit: CANDIDATE_LIMIT }),
    getRegistry:   () => getRegistry(),
    buildMessages: ({ prompt }) => [
      ...(identity ? [{ role: 'system', content: identity }] : []),
      // Standalone provider prompt → macro boundary #1 (a no-op here, the prompt
      // authors "my human" literally, but kept for consistency with the rule).
      { role: 'user', content: substituteMacros(prompt, readSettingsSync()) },
    ],
    // Reasoning model room (RULE A): callProviderChat gives a generous cap +
    // reasoning-content recovery. temperature low — this is careful judgment.
    callLLM: (messages) => callProviderChat({
      provider: conn.provider, apiKey: conn.apiKey, model: conn.model,
      messages, temperature: 0.2, maxTokens: 3000,
    }),
    updateMemory: ({ id, audience, contentTag }) => updateMemoryById({
      id, ...(audience ? { audience } : {}), ...(contentTag ? { contentTag } : {}),
    }),
    batchSize: DEFAULT_BATCH_SIZE,
  });

  if (summary.opened || summary.errors?.length) {
    console.log(`[regate] reviewed ${summary.reviewed}: opened ${summary.opened}, kept ${summary.kept}`
      + (summary.errors?.length ? `, errors ${summary.errors.length}` : ''));
  }
  return summary;
}

export function startContentRegateLoop({ tickMs = DEFAULT_TICK_MS } = {}) {
  if (_started) return { stop: stopContentRegateLoop };
  if (hardDisabled()) {
    console.log('[regate] content-gating re-tag hard-disabled via PROTO_FAMILIAR_CONTENT_REGATE_DISABLED=1');
    return { stop: () => {} };
  }
  _started = true;
  console.log('[regate] content-gating re-tag loop armed (opt-in; idles until "Review my private notes for content-sharing" is enabled in Settings)');
  _interval = setInterval(async () => {
    if (_active) return;                 // never overlap ticks
    if (await isCallActiveFromFile()) return;   // governor (§4.3): defer during a live call
    _active = runTick()
      .catch(err => console.warn('[regate] tick error:', err?.message ?? err))
      .finally(() => { _active = null; });
  }, tickMs);
  _interval.unref?.();
  return { stop: stopContentRegateLoop };
}

export async function stopContentRegateLoop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  if (_active) { try { await _active; } catch { /* already logged */ } }
  _started = false;
}
