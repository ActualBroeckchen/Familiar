/**
 * Tome → Phylactery graduation loop (Phase 4) — the singleton driver.
 *
 * Thin wrapper around tome-graduation.js's pure runOneGraduationTick: it
 * wires the real I/O (load tomes, the LLM judgment, the thalamus write
 * wrappers, the locked tome edit) and paces itself on a slow interval.
 *
 * Default OFF. It writes to the canonical self, so it stays dormant until
 * my human enables it in Settings (and after they've watched the Phase 3
 * routing behave in live chat). Hard off-switch:
 * PROTO_FAMILIAR_TOME_GRADUATION_DISABLED=1. Mirrors the reachout/triage
 * loop shape.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsp } from 'fs';

import {
  modifyTomeFile, appendIdentity, createMemoryFull, searchMemory, enrich,
} from './thalamus.js';
import { readSettingsSync, primaryConnectionFrom } from './cerebellum.js';
import { PROVIDER_URLS } from './providers.js';
import { substituteMacros } from './macros.js';
import { runOneGraduationTick, EXCLUDED_TOME_NAMES } from './tome-graduation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOMES_DIR = path.join(__dirname, 'tomes');

const DEFAULT_TICK_MS = 30 * 60_000;   // 30 min — draining a backlog wants no urgency

let _started  = false;
let _interval = null;
let _active   = null;

export function tomeGraduationHardDisabled() {
  return process.env.PROTO_FAMILIAR_TOME_GRADUATION_DISABLED === '1';
}

function isEnabled() {
  if (tomeGraduationHardDisabled()) return false;
  return readSettingsSync().tomeGraduationEnabled === true;   // opt-in
}

// ── Load every non-dot tome ([{ file, tome }]) ────────────────────
async function loadTomes() {
  let files;
  try { files = await fsp.readdir(TOMES_DIR); }
  catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    try {
      const tome = JSON.parse(await fsp.readFile(path.join(TOMES_DIR, f), 'utf8'));
      out.push({ file: path.join(TOMES_DIR, f), tome });
    } catch { /* skip corrupt */ }
  }
  return out;
}

// ── The judgment prompt (first-person; reuses the Phase 3 rubric) ──
export function buildGraduationPrompt({ identityContext, items }) {
  const rubric =
`I'm tidying knowledge that's been sitting in my tomes, moving anything durable into its right home in my canonical self. For each entry I decide where it truly belongs:
- A standing fact about who I am, as I grow and change → my self identity (home "self").
- A standing fact about who {{user}} is → their identity (home "ward"). About our bond → our relationship (home "relationship").
- A moment, event, or pattern with a 'when' → my memory (home "memory").
- Keyword-triggered context or lore that fits none of those → it stays a tome (home "tome").
If I'm not sure an entry is a durable fact with a clear home, it STAYS a tome — I don't crowd my canonical self with maybes. I'm also given what I already hold close to each entry: if I already have this fact, I set already_held true and don't write a duplicate. When I do graduate a fact, I rewrite it cleanly in my own first-person voice as the content to file.`;

  const list = items.map((it, i) =>
`Entry ${i + 1} — uid ${it.uid} — from tome "${it.tomeName}"${it.comment ? `, titled "${it.comment}"` : ''}:
"""
${(it.content || '').slice(0, 1200)}
"""
What I already hold close to this:
${it.recall || '(nothing close)'}`).join('\n\n');

  return `${identityContext ? identityContext + '\n\n' : ''}${rubric}

The entries to review:

${list}

I reply with ONLY a JSON array — one object per uid, no prose:
[{ "uid": "…", "home": "self|ward|relationship|memory|tome", "already_held": false, "content": "the fact rewritten in my own voice (omit when home is tome or already_held)", "filename": "for an identity home: my_identity.md | ward_notes.md | relationship_notes.md", "granularity": "for memory: daily|significant" }]`;
}

// Provider call — mirrors the reachout/triage loops' shape. (If a fourth
// copy appears, extract a shared callProvider into providers.js.)
async function callLLM({ provider, apiKey, model, prompt }) {
  const url = PROVIDER_URLS[provider];
  if (!url) throw new Error(`Unknown provider: ${provider}`);
  const resp = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey.trim()}` },
    body: JSON.stringify({
      model: model.trim(),
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      temperature: 0.3,    // routing wants steadiness, not flourish
      max_tokens: 900,
    }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Provider ${provider} returned ${resp.status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  if (data.error) throw new Error(typeof data.error === 'string' ? data.error : (data.error.message ?? 'Provider error'));
  const content = data.choices?.[0]?.message?.content ?? '';
  if (!content) throw new Error('Provider returned empty content.');
  return content;
}

async function decideGraduation(candidates) {
  const s = readSettingsSync();
  const conn = primaryConnectionFrom(s);
  if (!conn?.apiKey || !conn?.model || !PROVIDER_URLS[conn.provider]) {
    throw new Error('no usable primary connection');
  }
  const [{ static: identityContext }] = await Promise.all([
    enrich('', { staticOnly: true }).catch(() => ({ static: '' })),
  ]);
  const items = await Promise.all(candidates.map(async (c) => {
    let recall = '';
    try {
      const r = await searchMemory({ query: (c.entry.content || '').slice(0, 200), maxResults: 3 });
      recall = (Array.isArray(r?.results) ? r.results : [])
        .map(h => `- (${[h.granularity, h.date].filter(Boolean).join('/')}) ${(h.excerpt || '').trim().slice(0, 160)}`)
        .join('\n');
    } catch { /* dedup context is best-effort */ }
    return { uid: c.uid, tomeName: c.tomeName, comment: c.entry.comment, content: c.entry.content || '', recall };
  }));
  const prompt = substituteMacros(buildGraduationPrompt({ identityContext, items }), s);
  return callLLM({ provider: conn.provider, apiKey: conn.apiKey, model: conn.model, prompt });
}

async function runTick() {
  if (!isEnabled()) return { reason: 'disabled' };
  const tidyMode = readSettingsSync().tomeGraduationTidy === 'delete' ? 'delete' : 'pointer';
  const summary = await runOneGraduationTick({
    loadTomes,
    decide:     decideGraduation,
    deps:       { appendIdentity, createMemoryFull },
    modifyTome: modifyTomeFile,
    tidyMode,
    excludeNames: EXCLUDED_TOME_NAMES,
  });
  if (summary.graduated || summary.failed) {
    console.log(`[grad] reviewed ${summary.reviewed}: graduated ${summary.graduated}, kept ${summary.keptAsTome}, dup ${summary.alreadyHeld}, failed ${summary.failed} (tidy: ${tidyMode})`);
  }
  return summary;
}

export function startTomeGraduationLoop({ tickMs = DEFAULT_TICK_MS } = {}) {
  if (_started) return { stop: stopTomeGraduationLoop };
  if (tomeGraduationHardDisabled()) {
    console.log('[grad] tome→Phylactery graduation hard-disabled via PROTO_FAMILIAR_TOME_GRADUATION_DISABLED=1');
    return { stop: () => {} };
  }
  _started = true;
  console.log('[grad] tome→Phylactery graduation loop armed (opt-in; idles until "Graduate tome knowledge" is enabled in Settings)');
  _interval = setInterval(() => {
    if (_active) return;                 // never overlap ticks
    _active = runTick()
      .catch(err => console.warn('[grad] tick error:', err?.message ?? err))
      .finally(() => { _active = null; });
  }, tickMs);
  _interval.unref?.();
  return { stop: stopTomeGraduationLoop };
}

export async function stopTomeGraduationLoop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  if (_active) { try { await _active; } catch { /* already logged */ } }
  _started = false;
}
