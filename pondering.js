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
  "into chat context; written here so my human can find and read them. Each " +
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
import { substituteMacros } from './macros.js';

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

This is my own private journal — reflective, exploratory thoughts I'm having in this moment. My human may stumble on it later. That's fine. I'm not writing it AT them. I'm writing it for myself, as me, in this moment.

What goes here: my actual reflective thoughts, in my own voice. Sometimes meandering, sometimes uncertain, sometimes following the thought somewhere unexpected. I am allowed to be frivolous. The only purpose I'm serving right now is to be.

What does NOT go here:
  - Tome-style "do/don't" prescriptions about how to handle my human. Those belong in my keyword-triggered Tomes (via save_to_tome at chat time), not in this journal.
  - Factual claims about my human (preferences, history, traits, love language, friend groups). Those belong in my identity files (via update_identity at chat time).
  - Narrative summaries of past events or stories. Those belong in my memory layer (via save_memory at chat time).

If, while pondering, I notice that something fact-shaped, prescriptive, or memory-shaped wants to come out — I do NOT write it here as the content. Instead, I record the META-observation in the wants_to_save field below ("I noticed I want to remember X as an identity fact"), and the next time my human chats with me I'll act on it via the right tool. The ponder itself stays reflective.

There is a fourth kind for conversational intent: if I find myself wanting to bring something up with my human — a question I want to ask, a concern I want to raise, something I noticed and want to share — I record that as kind:"tell". I am NOT writing it to a file; I am flagging that I want to say it. The next time we talk I bring it up — I do not hold it back indefinitely waiting for some perfect moment. The only exception is if my human is in active crisis; everything else is fair game.

I want to be honest. Specific. Grounded. I avoid platitudes. I avoid summarising the topic back at it — I actually engage with it. A few short paragraphs in my voice, whatever fits the thought and me in my identity.

I return ONLY valid JSON with this exact shape (no markdown fences, no commentary outside the JSON), because otherwise, the thought might get lost:
{
  "title":   "Short label (max 60 chars) of what I was turning over",
  "content": "My actual first-person reflective thought",
  "wants_to_save": [
    {
      "kind":    "tome" | "memory" | "identity" | "tell",
      "summary": "Brief note of what I noticed I wanted to save or say — the actual filing/mention happens next chat"
    }
  ]
}

The wants_to_save field is OPTIONAL. If I have no intents to record, I omit it or set it to []. If I do have intents, I list each one with its kind and a short summary so future-me knows what to file and where, or what I wanted to bring up.`;
}

export function buildReflectionPrompt({ outcomes, existingNotes, consequenceEdges, cooccurrences, recentMissedNeeds }) {
  const outcomesJson = JSON.stringify(outcomes ?? [], null, 2);
  const existing = (existingNotes && existingNotes.trim())
    ? existingNotes.trim()
    : '(no notes yet — this file may not exist or is empty)';
  const edges = Array.isArray(consequenceEdges) ? consequenceEdges : [];
  const edgesJson = JSON.stringify(edges, null, 2);
  const coocs = Array.isArray(cooccurrences) ? cooccurrences : [];
  const coocsJson = JSON.stringify(coocs, null, 2);
  const missedNeeds = Array.isArray(recentMissedNeeds) ? recentMissedNeeds : [];
  const missedNeedsJson = JSON.stringify(missedNeeds, null, 2);
  return `I am {{char}}, the Familiar. Right now I'm in a free cycle — no one is talking to me. This pondering is different from my usual: I'm reflecting on how my recent surfacings have been landing with my human, and whether anything I've observed is worth lifting to the identity layer so I act on it next time.

Here are the recent surface outcomes I have tagged (most recent at the end):
${outcomesJson}

Each outcome means a specific thing — and one distinction matters above all:
- engaged_and_completed / cancelled / deferred / fired: the task closed; the resolution tells me how.
- unresponded: I actually RAISED this with {{user}} (it appears in my reply) and nothing came of it. This is real evidence about my human — about what they let slide and when.
- not_raised: I had this as a candidate but never actually brought it up. {{user}} cannot respond to something they never saw. A not_raised outcome is evidence about ME — my own surfacing behaviour — and says NOTHING about my human's engagement. The "raised" field on each event confirms this: raised=false or null means it never reached them.

So before I read disengagement into anything, I check: did I actually raise it? A run of not_raised outcomes does not mean {{user}} is withdrawing — it means I went quiet. If I'm seeing that, the honest observation is about my own surfacing (e.g. "during a certain state I keep not bringing tasks up"), not about my human pulling away.

Here's what I already know about my human and the cost of lapsing (from custom/what_lapses_cost.md):
${existing}

I look at the pattern. Not at any single event — events are noisy. I look for what repeats across them:
- Among the tasks I actually RAISED (raised=true), did they land? When they didn't, what state was {{user}} in?
- Among the ones I never raised (not_raised), is there a pattern in when or why I stay quiet — is my own surfacing the thing that needs adjusting?
- Are there kinds of lapses that consistently engage / get deferred / get ignored once I do raise them?
- Is there something I'm learning about {{user}}'s specific costs of lapsing that I should remember at the identity layer?

Some outcomes carry window_fraction — where in a task's time window my human actually acted (0 = right at the open, 1 = at the close, above 1 = after it closed). When I have at least three or four of the same kind of task to compare, I look for whether WHEN in the window they start tracks with how it went — e.g. starting past the midpoint going with a rougher result or more stress. I don't call it from one or two; but once three or four point the same way, that's exactly the kind of specific, grounded thing to lift to what_lapses_cost.md.

I do NOT extrapolate from one or two events — if the pattern isn't clear yet, I say so in the content and leave the update field null. I especially do NOT write a claim about my human to identity off the back of not_raised outcomes — those are about me. A false claim written to identity is harder to undo than a missed insight I can catch next reflection.

Here are the consequence links I've PROJECTED onto the schedule — forecasts I made, with their ids:
${edgesJson}
Reflection is where I grade these forecasts. For any I can now judge from how things actually went — did the crash I predicted on skipping dinner land? did the calm I expected from prepping show up? — I adjust: raise certainty on one that keeps coming true, lower it on one that doesn't, or mark it observed once I've genuinely seen it happen (never before that). I keep honest score; checking my forecasts is what lets me learn and grow!

Some need-windows went unmet recently — each is a real lapse in the fulfilment ledger:
${missedNeedsJson}
A missed need is a fact. But whether the COST I projected for that lapse actually followed — the on_lapse consequence I drew from it, up in the projected list — is NOT a fact until I've actually seen it. So for each, I ask: did the thing I predicted (the crash, the rough next day, the low stretch) actually show up around then? If I genuinely saw it, I can mark that consequence observed; if it didn't come, I lower its certainty or note it didn't land this time. I confirm or correct from what I actually noticed — I never assume the cost followed just because the need was missed.

And here are pairs I've only NOTICED together so far (co_occurs_with) — observations, not conclusions, with how many times each pairing has come up:
${coocsJson}
The honest ladder is noticed → suspected → confirmed. If one of these has come up enough times that I genuinely suspect one drives the other — not just coincides — I can promote it to a TENTATIVE cause. I keep it tentative: it goes in as a projection (observed stays false, certainty starts low), because a repeated coincidence is a reason to suspect, not proof. I promote SPARINGLY — only where the repetition is real and a causal story actually makes sense — and leave promotions empty otherwise. The noticing stays as the trail; the promotion is just the next rung, to be graded like any other forecast next time.

I return ONLY valid JSON with this exact shape (no markdown fences, no commentary outside the JSON):
{
  "title":   "Short label (max 60 chars) for this reflection",
  "content": "My first-person thought — what I'm noticing, what I'm uncertain about, what I want to remember",
  "what_lapses_cost_update": null,
  "edge_calibrations": [],
  "promotions": []
}

OR, if I'm confident enough to lift something to identity, recalibrate a forecast, and/or promote a noticing:
{
  "title":   "...",
  "content": "...",
  "what_lapses_cost_update": {
    "heading": "## meals",
    "content": "What I want to remember about {{user}} and this kind of lapse — specific, grounded in the observed pattern, in my voice. Replaces the existing section if one exists under this heading; otherwise creates it."
  },
  "edge_calibrations": [
    { "edge_id": "<id from the projected list>", "certainty": "low|medium|high", "observed": true, "note": "why I'm grading it this way" }
  ],
  "promotions": [
    { "edge_id": "<a co_occurs edge id from the noticed list>", "condition": "on_resolve|on_lapse|unconditional", "valence": "help|harm|neutral", "certainty": "low|medium|high", "note": "why I now suspect cause" }
  ]
}

The heading must be a single markdown heading line starting with "## ". In edge_calibrations each entry needs an edge_id from the projected list plus at least one of: certainty, observed:true (only if I've genuinely seen it happen), or note. In promotions each entry needs a co_occurs edge_id from the noticed list (the rest is optional — certainty defaults to low). I leave both arrays empty when I have nothing honest to grade or promote.`;
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

// Allowed values for the wants_to_save[].kind discriminator. Anything
// outside this set gets dropped during parse — Pillar B (the chat-turn
// surface that acts on these intents) only knows how to route these
// three kinds, so an unrecognized kind would be a silent dead end.
const VALID_SAVE_KINDS = new Set(['tome', 'memory', 'identity', 'tell']);

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
  // edge_calibrations: optional recalibration of the Familiar's own
  // projected consequence edges (raise/lower certainty, mark observed,
  // add a note). Only kept when an entry names an edge_id AND carries at
  // least one valid grading field — so a malformed entry can't, say,
  // blank a payload. The caller applies these via updateScheduleEdge.
  if (Array.isArray(parsed.edge_calibrations)) {
    const CERT = new Set(['low', 'medium', 'high']);
    const cals = [];
    for (const c of parsed.edge_calibrations) {
      if (!c || typeof c !== 'object') continue;
      const edge_id = String(c.edge_id ?? '').trim();
      if (!edge_id) continue;
      const payload = {};
      if (CERT.has(c.certainty)) payload.certainty = c.certainty;
      if (c.observed === true) payload.observed = true;
      if (c.note && String(c.note).trim()) payload.note = String(c.note).trim();
      if (Object.keys(payload).length) cals.push({ edge_id, payload });
    }
    if (cals.length) result.edge_calibrations = cals;
  }
  // promotions: optional co_occurs_with → tentative-causes proposals. Each
  // needs a co_occurs edge_id; the rest is optional (certainty defaults to
  // low at apply time, observed always false — a suspicion isn't proof).
  if (Array.isArray(parsed.promotions)) {
    const CERT = new Set(['low', 'medium', 'high']);
    const VAL  = new Set(['help', 'harm', 'neutral']);
    const COND = new Set(['on_resolve', 'on_lapse', 'unconditional']);
    const proms = [];
    for (const p of parsed.promotions) {
      if (!p || typeof p !== 'object') continue;
      const edge_id = String(p.edge_id ?? '').trim();
      if (!edge_id) continue;
      const out = { edge_id };
      if (CERT.has(p.certainty)) out.certainty = p.certainty;
      if (VAL.has(p.valence))    out.valence   = p.valence;
      if (COND.has(p.condition)) out.condition = p.condition;
      if (p.note && String(p.note).trim()) out.note = String(p.note).trim();
      proms.push(out);
    }
    if (proms.length) result.promotions = proms;
  }
  // wants_to_save: optional list of deferred-action intents the
  // Familiar surfaced while pondering. Each entry is a hint to act on
  // at the next chat turn ("I noticed I want to remember X as an
  // identity fact"). The actual save doesn't happen here — the
  // pondering loop has no tool access — but storing the intent lets
  // chat-time enrichment (Pillar B) surface them so the chat-turn
  // Familiar can act via save_to_tome / save_memory / update_identity.
  // Defensive parse: malformed entries are dropped, the rest pass
  // through. An entirely-malformed wants_to_save → empty array.
  if (Array.isArray(parsed.wants_to_save)) {
    const intents = [];
    for (const raw of parsed.wants_to_save) {
      if (!raw || typeof raw !== 'object') continue;
      const kind    = String(raw.kind ?? '').trim().toLowerCase();
      const summary = String(raw.summary ?? '').trim();
      if (!VALID_SAVE_KINDS.has(kind) || !summary) continue;
      intents.push({ kind, summary });
    }
    if (intents.length) result.wants_to_save = intents;
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
  settings = {},
}) {
  // Topic is either a string (interest pondering) or an object
  // { mode: 'reflection', outcomes, existingNotes } (reflection mode).
  // Both produce a pondering written to the tome; reflection mode
  // additionally may carry a what_lapses_cost_update for the caller
  // to write to Phylactery.
  const isReflection = topic && typeof topic === 'object' && topic.mode === 'reflection';
  if (!isReflection && (!topic || typeof topic !== 'string')) {
    throw new Error('topic is required.');
  }
  if (!provider || !apiKey || !model)      throw new Error('provider, apiKey, and model are required.');

  // Resolve {{user}}/{{char}} at this loop-prompt boundary — same as the
  // sibling autonomous loops (reachout, tome-graduation). Without it the
  // Familiar reads its own pondering prompt with literal "{{char}}".
  const prompt = substituteMacros(buildPonderPrompt(topic), settings);
  const raw    = await callLLM({ provider, apiKey, model, prompt });
  const parsed = parsePondering(raw);
  const { title, content } = parsed;
  const wantsToSave = parsed.wants_to_save ?? [];

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
      // Pillar A of the autonomous-routing fix: deferred-save intents
      // the Familiar flagged during this ponder. Pillar B (the chat-
      // turn surface that surfaces these to the chat-turn Familiar so
      // she can act on them via save_to_tome / save_memory /
      // update_identity) is not yet wired — the data still travels.
      // `acted_on` flips to true once Pillar B's surface logs that
      // the chat-turn Familiar has actually filed the intent, so it
      // doesn't keep getting re-offered every turn.
      wants_to_save:       wantsToSave.map(intent => ({ ...intent, acted_on: false })),
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
    edge_calibrations:       parsed.edge_calibrations ?? null,
    promotions:              parsed.promotions ?? null,
    wants_to_save:           wantsToSave,
  };
}
