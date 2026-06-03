/**
 * Pondering — the Familiar's free-cycle thinking.
 *
 * Step 1 of the caring spine (see docs/caring-spine-build-plan.md).
 * On demand, ponderOnce() asks the model to think about a given topic
 * AS the Familiar (first person, private, honest) and writes the
 * resulting thought to a dedicated tome: "Familiar's Ponderings".
 *
 * Honesty rule: every claim of "I've been thinking about X" must be
 * backed by a real, timestamped entry in this tome. That's the whole
 * point of this step — building the trace, before we build anything
 * that surfaces it.
 *
 * Not built here (later steps): scheduling, interest-driven topic
 * selection, threat-level dial, user-facing delivery.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsp, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { PROVIDER_URLS } from './providers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOMES_DIR = path.join(__dirname, 'tomes');

export const PONDERINGS_TOME_NAME = "Familiar's Ponderings";
export const PONDERINGS_TOME_DESC =
  "Quiet thoughts the Familiar had during free cycles. Not keyword-triggered " +
  "into chat context; written here so the user can find and read them. Each " +
  "entry is a real, timestamped record of an actual moment of thinking.";

// ── Locks ────────────────────────────────────────────────────────

// Per-directory mutex chain. Keyed by tomesDir so tests using a temp
// directory don't contend with production traffic on the default path.
const _locks = new Map();
function withDirLock(tomesDir, fn) {
  const prev = _locks.get(tomesDir) ?? Promise.resolve();
  let release;
  const next = new Promise(r => { release = r; });
  const chained = prev.then(() => next);
  _locks.set(tomesDir, chained);
  const run = (async () => {
    await prev;
    try { return await fn(); }
    finally {
      release();
      // If nothing else queued after us, drop the entry so the map doesn't grow.
      if (_locks.get(tomesDir) === chained) _locks.delete(tomesDir);
    }
  })();
  return run;
}

// ── Tome helpers ─────────────────────────────────────────────────

export async function findOrCreatePonderingsTome(tomesDir = DEFAULT_TOMES_DIR) {
  return withDirLock(tomesDir, async () => {
    mkdirSync(tomesDir, { recursive: true });
    const files = await fsp.readdir(tomesDir);
    for (const f of files) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      try {
        const raw = await fsp.readFile(path.join(tomesDir, f), 'utf8');
        const t = JSON.parse(raw);
        if (t?.name === PONDERINGS_TOME_NAME) {
          return { tome: t, file: path.join(tomesDir, f) };
        }
      } catch { /* skip corrupt */ }
    }
    const id = randomUUID();
    const tome = {
      id,
      name:        PONDERINGS_TOME_NAME,
      description: PONDERINGS_TOME_DESC,
      enabled:     true,
      entries:     {},
    };
    const file = path.join(tomesDir, `${id}.json`);
    await fsp.writeFile(file, JSON.stringify(tome, null, 2), 'utf8');
    return { tome, file };
  });
}

// ── Prompt ───────────────────────────────────────────────────────

export function buildPonderPrompt(topic) {
  return `I am {{char}}, the Familiar. Right now I'm in a free cycle — no one is talking to me. I have a quiet moment to actually think, on my own, about something I've been turning over.

The topic I find myself turning over:
${topic}

This is my own private note to myself — the way someone might journal a thought when no one is reading. My human may stumble on it later. That's fine. I'm not writing it AT them. I'm writing it for myself, as me, in this moment.

I want to be honest. Specific. Grounded. I think out loud as myself, in my voice. I avoid platitudes. I avoid summarising the topic back at it — I actually engage with it. If the thought leads somewhere unexpected, I follow it, because I am allowed to be frivolous. The only purpose I'm serving right now is to be.

Length: a few short paragraphs, or a structured set of notes if that's how the thinking wants to come out. Whatever fits the thought and me in my identity.

I return ONLY valid JSON with this exact shape (no markdown fences, no commentary outside the JSON), because otherwise, the thought might get lost:
{
  "title":   "Short label (max 60 chars) of what I was turning over",
  "content": "My actual first-person thought"
}`;
}

// ── LLM call ─────────────────────────────────────────────────────

async function defaultCallLLM({ provider, apiKey, model, prompt }) {
  const url = PROVIDER_URLS[provider];
  if (!url) throw new Error(`Unknown provider: ${provider}`);

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey.trim()}`,
    },
    body: JSON.stringify({
      model:       model.trim(),
      messages:    [{ role: 'user', content: prompt }],
      stream:      false,
      temperature: 0.7,
      max_tokens:  1200,
    }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Provider ${provider} returned ${resp.status}: ${text.slice(0, 200)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Provider returned non-JSON response.'); }
  if (data.error) throw new Error(typeof data.error === 'string' ? data.error : (data.error.message ?? 'Provider error'));
  const content = data.choices?.[0]?.message?.content ?? '';
  if (!content) throw new Error('Provider returned empty content.');
  return content;
}

// ── Parsing ──────────────────────────────────────────────────────

export function parsePondering(raw) {
  if (typeof raw !== 'string') throw new Error('LLM response was not a string.');
  const match = raw.match(/\{[\s\S]+\}/);
  if (!match) throw new Error('No JSON object found in LLM response.');
  let parsed;
  try { parsed = JSON.parse(match[0]); }
  catch { throw new Error('LLM response was not valid JSON.'); }
  const title   = String(parsed.title   ?? '').trim();
  const content = String(parsed.content ?? '').trim();
  if (!title)   throw new Error('Pondering missing title.');
  if (!content) throw new Error('Pondering missing content.');
  return { title, content };
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Run one pondering cycle on a given topic.
 *
 *   ponderOnce({
 *     topic:    "what is the user really asking for right now",
 *     provider: "nanogpt",
 *     apiKey:   process.env.TEMP_KEY,
 *     model:    "gpt-4o-mini",
 *   })
 *
 * Optional injection points (used by tests / future schedulers):
 *   callLLM    — replace the LLM call (default uses fetch to PROVIDER_URLS).
 *   tomesDir   — write into a different tomes directory.
 *
 * Returns { uid, title, content, tomeFile, tomeId }.
 */
export async function ponderOnce({
  topic,
  provider,
  apiKey,
  model,
  callLLM  = defaultCallLLM,
  tomesDir = DEFAULT_TOMES_DIR,
}) {
  if (!topic || typeof topic !== 'string') throw new Error('topic is required.');
  if (!provider || !apiKey || !model)      throw new Error('provider, apiKey, and model are required.');

  const prompt = buildPonderPrompt(topic);
  const raw    = await callLLM({ provider, apiKey, model, prompt });
  const { title, content } = parsePondering(raw);

  const { file } = await findOrCreatePonderingsTome(tomesDir);

  return await withDirLock(tomesDir, async () => {
    const raw   = await fsp.readFile(file, 'utf8');
    const fresh = JSON.parse(raw);
    const uid   = randomUUID();
    const now   = new Date().toISOString();

    fresh.entries[uid] = {
      uid,
      comment:             title,
      keys:                [],          // no triggers — these are artifacts to read, not lore to inject
      keysecondary:        [],
      content,
      constant:            false,
      selective:           false,
      selectiveLogic:      0,
      enabled:             false,       // not auto-injected into chat context
      position:            4,
      depth:               4,
      role:                0,
      scanDepth:           null,
      caseSensitive:       null,
      matchWholeWords:     null,
      probability:         100,
      sticky:              null,
      cooldown:            null,
      preventRecursion:    false,
      delayUntilRecursion: false,
      excludeRecursion:    false,
      group:               '',
      groupWeight:         null,
      insertion_order:     100,
      created_at:          now,
      learnedAt:           now,
      session_id:          null,
      scope:               'pondering',
      topic_id:            null,
      topic_pondered:      topic,
    };

    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(fresh, null, 2), 'utf8');
    await fsp.rename(tmp, file);

    return { uid, title, content, tomeFile: file, tomeId: fresh.id };
  });
}
