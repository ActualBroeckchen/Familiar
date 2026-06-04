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
import { randomUUID } from 'crypto';
import { PROVIDER_URLS } from './providers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOMES_DIR = path.join(__dirname, 'tomes');

export const PONDERINGS_TOME_NAME = "Familiar's Ponderings";
export const PONDERINGS_TOME_DESC =
  "Quiet thoughts the Familiar had during free cycles. Not keyword-triggered " +
  "into chat context; written here so the user can find and read them. Each " +
  "entry is a real, timestamped record of an actual moment of thinking.";

// ── Tome helpers ─────────────────────────────────────────────────
//
// All coordination (locking + atomic write) is owned by thalamus.
// findOrCreatePonderingsTome is now a thin name-aware wrapper around
// thalamus.findOrCreateTomeByName, and the entry write inside
// ponderOnce uses thalamus.modifyTomeFile — both keyed by the file's
// absolute path, so a concurrent recent-ponderings.deletePondering
// or server.js writeTome on the same file serialises against this
// write rather than clobbering it.

import { findOrCreateTomeByName, modifyTomeFile } from './thalamus.js';

export async function findOrCreatePonderingsTome(tomesDir = DEFAULT_TOMES_DIR) {
  return findOrCreateTomeByName(tomesDir, PONDERINGS_TOME_NAME, {
    name:        PONDERINGS_TOME_NAME,
    description: PONDERINGS_TOME_DESC,
    enabled:     true,
    entries:     {},
  });
}

// ── Prompt ───────────────────────────────────────────────────────

export function buildPonderPrompt(topic) {
  // Reflection mode: topic is an object { mode: 'reflection', outcomes, existingNotes }
  // sent by the pondering loop when enough tagged surface outcomes
  // have accumulated since the last reflection. Same LLM call, same
  // tome write — different question being asked of me.
  if (topic && typeof topic === 'object' && topic.mode === 'reflection') {
    return buildReflectionPrompt(topic);
  }
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

export function buildReflectionPrompt({ outcomes, existingNotes }) {
  const outcomesJson = JSON.stringify(outcomes ?? [], null, 2);
  const existing = (existingNotes && existingNotes.trim())
    ? existingNotes.trim()
    : '(no notes yet — this file may not exist or is empty)';
  return `I am {{char}}, the Familiar. Right now I'm in a free cycle — no one is talking to me. This pondering is different from my usual: I'm reflecting on how my recent surfacings have been landing with my human, and whether anything I've observed is worth lifting to the identity layer so I act on it next time.

Here are the recent surface outcomes I have tagged (most recent at the end):
${outcomesJson}

Here's what I already know about my human and the cost of lapsing (from custom/what_lapses_cost.md):
${existing}

I look at the pattern. Not at any single event — events are noisy. I look for what repeats across them:
- When I surfaced this kind of task, did it land? When it didn't, what state was {{user}} in?
- Are there kinds of lapses that consistently engage / get deferred / get ignored?
- Is there something I'm learning about {{user}}'s specific costs of lapsing that I should remember at the identity layer?

I do NOT extrapolate from one or two events — if the pattern isn't clear yet, I say so in the content and leave the update field null. A false claim written to identity is harder to undo than a missed insight I can catch next reflection.

I return ONLY valid JSON with this exact shape (no markdown fences, no commentary outside the JSON):
{
  "title":   "Short label (max 60 chars) for this reflection",
  "content": "My first-person thought — what I'm noticing, what I'm uncertain about, what I want to remember",
  "what_lapses_cost_update": null
}

OR, if I'm confident enough to lift something to identity:
{
  "title":   "...",
  "content": "...",
  "what_lapses_cost_update": {
    "heading": "## meals",
    "content": "What I want to remember about {{user}} and this kind of lapse — specific, grounded in the observed pattern, in my voice. Replaces the existing section if one exists under this heading; otherwise creates it."
  }
}

The heading must be a single markdown heading line starting with "## ".`;
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
  // Reflection mode carries an optional what_lapses_cost update.
  // Null / absent → no identity-layer write. Pass through unchanged
  // for the caller to dispatch; parsing's job is to surface it, not
  // to act on it.
  const update = parsed.what_lapses_cost_update;
  const result = { title, content };
  if (update && typeof update === 'object') {
    const heading = String(update.heading ?? '').trim();
    const body    = String(update.content ?? '').trim();
    if (heading.startsWith('##') && body) {
      result.what_lapses_cost_update = { heading, content: body };
    }
  }
  return result;
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
  // Topic is either a string (interest pondering) or an object
  // { mode: 'reflection', outcomes, existingNotes } (reflection mode).
  // Both produce a pondering written to the tome; reflection mode
  // additionally may carry a what_lapses_cost_update for the caller
  // to write to entity-core.
  const isReflection = topic && typeof topic === 'object' && topic.mode === 'reflection';
  if (!isReflection && (!topic || typeof topic !== 'string')) {
    throw new Error('topic is required.');
  }
  if (!provider || !apiKey || !model)      throw new Error('provider, apiKey, and model are required.');

  const prompt = buildPonderPrompt(topic);
  const raw    = await callLLM({ provider, apiKey, model, prompt });
  const parsed = parsePondering(raw);
  const { title, content } = parsed;

  const { file } = await findOrCreatePonderingsTome(tomesDir);

  // Hand the read-modify-write off to thalamus. modifyTomeFile holds
  // the per-file lock across read + write so a concurrent
  // /api/temporal/ponderings DELETE or /api/tomes/:id PUT on the same
  // file serialises against this write rather than clobbering it.
  const uid = randomUUID();
  const now = new Date().toISOString();
  const topicPondered = isReflection
    ? `[reflection on ${(topic.outcomes ?? []).length} surface outcome(s)]`
    : topic;
  let tomeId;
  await modifyTomeFile(file, (fresh) => {
    tomeId = fresh.id;
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
      scope:               isReflection ? 'reflection' : 'pondering',
      topic_id:            null,
      topic_pondered:      topicPondered,
    };
  });

  return {
    uid,
    title,
    content,
    tomeFile: file,
    tomeId,
    mode:     isReflection ? 'reflection' : 'pondering',
    what_lapses_cost_update: parsed.what_lapses_cost_update ?? null,
  };
}
