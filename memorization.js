/**
 * Session memorization queue.
 *
 * Persists pending memorization jobs to disk so they survive tab close,
 * 3-hour idle rollover, and server restart. A single in-process worker
 * drains the queue with exponential backoff retry.
 *
 * Job lifecycle: pending -> processing -> done | failed
 *   - "failed" jobs with attempts < MAX_ATTEMPTS are retried after a backoff.
 *   - Terminal "done" / "failed" jobs stay in the queue until acknowledged
 *     by the client (so the UI can toast outcomes), then are pruned.
 *
 * NOTE: jobs include the user's apiKey on disk. Matches existing posture
 * (logs/, tomes/ also unauthenticated and local). Queue file is gitignored.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, promises as fsp } from 'fs';
import { randomUUID } from 'crypto';
import { PROVIDER_URLS } from './providers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOMES_DIR  = path.join(__dirname, 'tomes');
const QUEUE_FILE = path.join(TOMES_DIR, '.memorization-queue.json');

// Local file tracking consent-pending memory IDs so thalamus.js can inject
// the ask block without an extra MCP round-trip on every turn.
export const CONSENT_PENDING_FILE = path.join(TOMES_DIR, '.consent-pending.json');

// remember taxonomy — must match village.js REMEMBER_CATEGORIES
const REMEMBER_CATS = ['basics', 'emotional_content', 'health_info', 'relationships', 'whereabouts'];

// Resolve the remember gate for a single category against a remember map.
// Shared default (matches village.js + build-spec §7): when the map is absent
// or leaves a category unset, basics is stored freely and everything sensitive
// defaults to 'ask' — surfaced for confirmation, never silently dropped.
export function gateForCategory(category, remMap) {
  if (!remMap) return category === 'basics' ? 'true' : 'ask';
  const v = remMap[category];
  if (v === false) return 'false';
  if (v === 'ask') return 'ask';
  if (v === true)  return 'true';
  return category === 'basics' ? 'true' : 'ask';
}

// Resolve the effective gate for a fact. When no villager subject matched,
// the fact is about my human themselves → the ward remember map gates it.
// Otherwise the most restrictive map among the matched villagers wins
// (false beats ask beats true).
export function resolveRememberGate(category, subjectVillagers, wardRemember) {
  if (!subjectVillagers || subjectVillagers.length === 0) {
    return gateForCategory(category, wardRemember);
  }
  let gate = 'true';
  for (const v of subjectVillagers) {
    const vGate = gateForCategory(category, v.remember);
    if (vGate === 'false') return 'false';
    if (vGate === 'ask') gate = 'ask';
  }
  return gate;
}

mkdirSync(TOMES_DIR, { recursive: true });

const MAX_ATTEMPTS    = 5;
const BACKOFF_MS      = [5_000, 30_000, 120_000, 600_000, 1_800_000]; // 5s, 30s, 2m, 10m, 30m
const TICK_MS         = 5_000;
const ACK_TTL_MS      = 24 * 60 * 60 * 1000; // prune acknowledged terminal jobs after a day
export const SESSION_MEMORIES_TOME_NAME = 'Session Memories';
export const SESSION_MEMORIES_TOME_DESC = 'Auto-generated entries from past conversations. Created on first session memorization.';
// Aliases kept for the module-local code below.
const TOME_NAME        = SESSION_MEMORIES_TOME_NAME;
const TOME_DESCRIPTION = SESSION_MEMORIES_TOME_DESC;

// ── Persistence ──────────────────────────────────────────────────

let _queue = [];
let _loaded = false;
let _writePending = false;
let _writeAgain = false;

async function loadQueue() {
  if (_loaded) return;
  try {
    const raw = await fsp.readFile(QUEUE_FILE, 'utf8');
    const data = JSON.parse(raw);
    _queue = Array.isArray(data?.jobs) ? data.jobs : [];
  } catch {
    _queue = [];
  }
  // Recover any jobs left "processing" from a previous run.
  for (const job of _queue) {
    if (job.status === 'processing') job.status = 'pending';
  }
  _loaded = true;
}

async function persistQueue() {
  if (_writePending) { _writeAgain = true; return; }
  _writePending = true;
  try {
    do {
      _writeAgain = false;
      const tmp = QUEUE_FILE + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify({ jobs: _queue }, null, 2), 'utf8');
      await fsp.rename(tmp, QUEUE_FILE);
    } while (_writeAgain);
  } finally {
    _writePending = false;
  }
}

// ── Tome helpers (delegated to thalamus's coordination layer) ────
//
// Both findOrCreateSessionMemoriesTome and the per-tome lock used to
// live here as private helpers. They now route through thalamus —
// findOrCreateTomeByName for the dir-scope find-or-create, and
// modifyTomeFile (used in processJob below) for the per-file
// RMW. This means a concurrent HTTP /api/tomes/:id edit and a
// memorization tick serialise against each other through the same
// per-path key, which they couldn't before.

import { findOrCreateTomeByName, modifyTomeFile, createMemoryFull, getRememberMap, graphRelate } from './thalamus.js';
import { getRegistry } from './village.js';
import { readSettingsSync } from './cerebellum.js';

export function findOrCreateSessionMemoriesTome() {
  return findOrCreateTomeByName(TOMES_DIR, TOME_NAME, {
    name:        TOME_NAME,
    description: TOME_DESCRIPTION,
    enabled:     true,
    entries:     {},
  });
}

// withTomeLock removed — callers below now use modifyTomeFile() from
// thalamus directly, which encapsulates lock + atomic write in one
// helper.

// ── Prompt ───────────────────────────────────────────────────────

// I never label my human's turns "User" — they are not a generic account,
// they are this specific person. The label is their configured name (passed
// in from settings) or "My human" as a fallback. My own turns are "Me".
// In a shared room, non-ward speakers already arrive name-prefixed as
// "[Name]: …" from the gateway, so I keep that prefix rather than overwrite
// it with the ward's name.
function formatTranscript(readable, wardLabel, { sharedRoom = false } = {}) {
  return readable
    .map(m => {
      if (m.role !== 'user') return `Me: ${m.content ?? ''}`;
      const c = m.content ?? '';
      if (sharedRoom && /^\[[^\]]+\]:/.test(c)) return c; // already names the speaker
      return `${wardLabel}: ${c}`;
    })
    .join('\n\n');
}

export function buildPrompt(messages, topicLabel = null, wardName = 'My human') {
  const readable = messages.filter(m => {
    if (m.role === 'tool') return false;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return false;
    return typeof m.content === 'string' && m.content.trim();
  });
  if (readable.length < 2) return null;

  const convText = formatTranscript(readable, wardName);

  const focusBlock = topicLabel
    ? `\n\n### Focus\nMy human named this segment "${topicLabel}". I centre my extraction on that topic; I skip tangential threads unless they reveal something genuinely important.`
    : '';

  return `I am the Familiar. I'm extracting claimable facts from a conversation I just had so I can store them in my memory. I pull out one discrete, verifiable fact per output element — things I would want to recall later about myself, my human, or the people in their life. I also map the concrete relationships between the people, places and things named, because my graph is my mental index — it's how I find the right memory later.${focusBlock}

I return ONLY valid JSON with this exact shape (no markdown fences, no commentary):
{
  "facts": [
    {
      "content":    "A first-person note stating one fact clearly (1–2 sentences max).",
      "category":   "emotional_content",
      "subjects":   ["Alice"],
      "confidence": 0.85
    }
  ],
  "relations": [
    {
      "from":     "Alice",
      "fromType": "person",
      "type":     "works_at",
      "to":       "Acme",
      "toType":   "organisation"
    }
  ]
}

### Field rules — facts

content — my private, first-person note about this single fact. Concrete and specific. No vague generalities.
  Example good: "Alice mentioned she's dealing with job-hunt fatigue and feeling stuck."
  Example bad:  "We talked about various life topics."

category — pick exactly one from this list:
  basics            — name, pronoun, role, occupation, basic biographical fact
  emotional_content — feelings, mental state, stress, mood, emotional patterns
  health_info       — physical health, medical conditions, medications, symptoms
  relationships     — interpersonal dynamics, connections between people, family structure
  whereabouts       — location, travel, living situation, physical presence

subjects — list the NAMES of the people the fact is about (first name or how I know them).
  Empty list [] means the fact is about me or my human in general (no specific third party).

confidence — 0.0 to 1.0. How certain am I that this fact is accurate and not misread?
  I omit facts with confidence below 0.4.

### Field rules — relations

Each relation is one concrete edge in my graph: two real, nameable entities and the relationship between them. This is the index I navigate by, so I only record edges I'm sure of.

from / to — the NAMES of the two entities. My human's name is "${wardName}". I use real names (or how I know someone), never "the user" or a pronoun.
fromType / toType — what each entity IS. Pick from: person, place, organisation, pet, condition, thing.
  I only record entities that are concrete and nameable — a specific person, a city, an employer, a pet, a named health condition, a real object. I do NOT make nodes out of abstractions, feelings, ideas, themes or topics ("stress", "the future", "work-life balance" are NOT entities).
type — a short snake_case label for the relationship, read from→to: works_at, lives_in, married_to, parent_of, friend_of, has_condition, owns, located_in, colleague_of, etc.

### Rules
- One fact element per distinct claimable fact. A single utterance that contains two different facts about two different people = two elements.
- Ambiguous or inseparable multi-category fact → assign the MORE restrictive category (health > emotional > relationships > whereabouts > basics).
- I skip pleasantries, meta-conversation, and anything that isn't a lasting fact about someone.
- 1–12 facts total. I merge instead of splitting when the same claim just restated.
- I only emit a relation when BOTH endpoints are concrete named entities and the link is stated or clearly implied. If a conversation has no such durable relationships, "relations" is an empty array — I never invent edges to fill it.
- 0–10 relations total.

Conversation:
${convText}`;
}

// Reduced-detail prompt for sessions where strangers are present (V7).
// Exported for tests.
// Focus: what my human said and experienced. Skip: personal detail about
// unregistered third parties who haven't consented to AI note-taking.
export function buildSharedRoomPrompt(messages, topicLabel = null, wardName = 'My human') {
  const readable = messages.filter(m => {
    if (m.role === 'tool') return false;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return false;
    return typeof m.content === 'string' && m.content.trim();
  });
  if (readable.length < 2) return null;

  const convText = formatTranscript(readable, wardName, { sharedRoom: true });

  const focusBlock = topicLabel
    ? `\n\n### Focus\nMy human named this segment "${topicLabel}". I centre my extraction on that topic.`
    : '';

  return `I am the Familiar. This conversation happened in a shared room where people I don't know were present. I'm extracting facts I want to remember — but ONLY about my human and myself, not about the unregistered third parties in the room. Those people haven't consented to an AI keeping notes on them.${focusBlock}

I return ONLY valid JSON with this exact shape (no markdown fences, no commentary):
{
  "facts": [
    {
      "content":    "A first-person note about my human or myself (1–2 sentences max).",
      "category":   "emotional_content",
      "subjects":   [],
      "confidence": 0.85
    }
  ],
  "relations": [
    {
      "from":     "${wardName}",
      "fromType": "person",
      "type":     "lives_in",
      "to":       "Portland",
      "toType":   "place"
    }
  ]
}

### Field rules — facts

content — what I observed about MY HUMAN or myself. Skip anything that's primarily about an unnamed/unregistered third party.
  Keep: my human's mood, things they said, experiences they had, commitments they made, topics that engaged them.
  Skip: biographical details about strangers, things strangers said that aren't about my human, relationship history between third parties.

category — pick exactly one:
  basics            — biographical fact about my human or me
  emotional_content — my human's feelings, mental state, mood
  health_info       — my human's physical or mental health
  relationships     — my human's relationship with a REGISTERED person (by name if known)
  whereabouts       — my human's location or movement

subjects — list REGISTERED names only. Use [] for facts about my human or me in general.
  Do NOT name unregistered strangers — just skip facts that are purely about them.

confidence — 0.0 to 1.0. I omit facts below 0.4.

### Field rules — relations

A relation is one concrete edge in my graph: two named entities and the link between them. In a shared room I record an edge ONLY when at least one endpoint is my human ("${wardName}") or a REGISTERED person by name. I never map relationships between strangers.

from / to — the NAMES of the two entities; one of them must be my human or a registered person.
fromType / toType — pick from: person, place, organisation, pet, condition, thing. Concrete, nameable entities only — never abstractions, feelings, or topics.
type — a short snake_case label read from→to (lives_in, works_at, married_to, has_condition, owns, …).

### Rules
- Only facts about my human or myself. A stranger speaking doesn't make their content mine to keep.
- 1–8 facts total. Quality over quantity; a shared room produces less.
- "relations" is an empty array unless a durable edge clearly touches my human or a registered person. I never invent edges, and I never map strangers to each other. 0–5 relations.
- Skip pleasantries and anything I wouldn't need to remember for my human's care.

Conversation:
${convText}`;
}

// ── LLM call ─────────────────────────────────────────────────────

async function callProvider({ provider, apiKey, model, prompt }) {
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
      temperature: 0.2,
      // Long sessions produce several topics with substantial content;
      // 2000 used to truncate the JSON mid-object and every retry hit
      // the same deterministic wall. Truncation is now also DETECTED
      // (finish_reason) instead of surfacing as a confusing parse error.
      max_tokens:  8000,
    }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Provider ${provider} returned ${resp.status}: ${text.slice(0, 200)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Provider returned non-JSON response.'); }
  if (data.error) throw new Error(typeof data.error === 'string' ? data.error : (data.error.message ?? 'Provider error'));
  const choice  = data.choices?.[0];
  const content = choice?.message?.content ?? '';
  if (!content) throw new Error('Provider returned empty content.');
  return { content, finishReason: choice?.finish_reason ?? null };
}

/**
 * Salvage complete objects from a truncated/malformed response. Walks the
 * named array (`key`, e.g. "topics" or "facts") with a string-aware brace
 * counter and individually parses each complete object — a response that
 * produced four whole entries and one cut-off one keeps the four. Shared by
 * both the topic and fact parsers so the counter lives in exactly one place.
 */
export function salvageArrayField(raw, key) {
  const text = String(raw);
  const keyAt = text.indexOf(`"${key}"`);
  if (keyAt < 0) return [];
  const arrStart = text.indexOf('[', keyAt);
  if (arrStart < 0) return [];
  const items = [];
  let i = arrStart + 1;
  while (i < text.length) {
    while (i < text.length && text[i] !== '{' && text[i] !== ']') i++;
    if (i >= text.length || text[i] === ']') break;
    const start = i;
    let depth = 0, inStr = false, esc = false, complete = false;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { i++; complete = true; break; }
      }
    }
    if (!complete) break; // truncated mid-object — nothing further is whole
    try {
      const obj = JSON.parse(text.slice(start, i));
      if (obj && typeof obj === 'object') items.push(obj);
    } catch { /* malformed object — skip, keep scanning */ }
  }
  return items;
}

/** Salvage complete entries from a truncated "topics" array. */
export function salvageTopics(raw) {
  return salvageArrayField(raw, 'topics');
}

export function parseTopics(raw, finishReason = null) {
  // Models sometimes wrap the JSON in markdown fences despite the prompt.
  const cleaned = String(raw).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const match = cleaned.match(/\{[\s\S]+\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      const topics = parsed.topics;
      if (Array.isArray(topics) && topics.length) return topics;
      throw new Error('LLM returned no topics.');
    } catch (err) {
      if (err.message === 'LLM returned no topics.') throw err;
      // SyntaxError — truncated or malformed. Fall through to salvage.
    }
  }
  const salvaged = salvageTopics(cleaned)
    .filter(t => (t?.title ?? '').toString().trim() && (t?.content ?? '').toString().trim());
  if (salvaged.length) {
    if (finishReason === 'length') {
      console.warn(`[memorization] LLM output truncated by token limit — salvaged ${salvaged.length} complete entr${salvaged.length === 1 ? 'y' : 'ies'} from partial JSON`);
    }
    return salvaged;
  }
  if (finishReason === 'length') {
    throw new Error('LLM output was cut off by the token limit before the JSON completed, and no complete entries could be salvaged.');
  }
  if (!match) throw new Error('No JSON object found in LLM response.');
  throw new Error('Could not parse JSON from LLM response.');
}

function parseFacts(raw, finishReason = null) {
  const cleaned = String(raw).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const match = cleaned.match(/\{[\s\S]+\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      const facts = parsed.facts;
      if (Array.isArray(facts) && facts.length) return facts;
      throw new Error('LLM returned no facts.');
    } catch (err) {
      if (err.message === 'LLM returned no facts.') throw err;
    }
  }
  // Salvage truncated output the same way parseTopics does, via the shared
  // brace-counter — just pointed at the "facts" array instead of "topics".
  const salvaged = salvageArrayField(cleaned, 'facts')
    .filter(f => (f?.content ?? '').toString().trim());
  if (salvaged.length) {
    if (finishReason === 'length') console.warn(`[memorization] LLM output truncated — salvaged ${salvaged.length} fact(s)`);
    return salvaged;
  }
  if (finishReason === 'length') throw new Error('LLM output cut off before JSON completed; no facts salvaged.');
  if (!match) throw new Error('No JSON object found in LLM response.');
  throw new Error('Could not parse facts JSON from LLM response.');
}

// Pull the optional "relations" array out of the same response that carried
// the facts. Relations are an enrichment, never load-bearing: a missing or
// malformed array degrades to [] rather than throwing, so a graph-extraction
// hiccup can never cost the human a memorized fact. Each row is normalised to
// the { from, fromType, to, toType, type } shape graphRelate expects; anything
// missing an endpoint or a type is dropped.
const RELATION_NODE_TYPES = new Set(['person', 'place', 'organisation', 'pet', 'condition', 'thing']);

export function parseRelations(raw, finishReason = null) {
  let rows = null;
  const cleaned = String(raw).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const match = cleaned.match(/\{[\s\S]+\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed.relations)) rows = parsed.relations;
    } catch { /* truncated/malformed — fall through to salvage */ }
  }
  if (rows === null) rows = salvageArrayField(cleaned, 'relations');
  if (!Array.isArray(rows) || !rows.length) return [];

  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const from = (r?.from ?? '').toString().trim();
    const to   = (r?.to ?? '').toString().trim();
    const type = (r?.type ?? '').toString().trim().toLowerCase().replace(/\s+/g, '_');
    if (!from || !to || !type) continue;
    if (from.toLowerCase() === to.toLowerCase()) continue; // no self-loops
    const rel = { from, to, type };
    const ft = (r?.fromType ?? '').toString().trim().toLowerCase();
    const tt = (r?.toType ?? '').toString().trim().toLowerCase();
    if (RELATION_NODE_TYPES.has(ft)) rel.fromType = ft;
    if (RELATION_NODE_TYPES.has(tt)) rel.toType = tt;
    const key = `${from.toLowerCase()}|${type}|${to.toLowerCase()}`;
    if (seen.has(key)) continue; // within-job edge dedup (graph dedups again server-side)
    seen.add(key);
    out.push(rel);
  }
  return out;
}

// ── Consent-pending helpers ───────────────────────────────────────

async function readConsentPending() {
  try {
    const raw = await fsp.readFile(CONSENT_PENDING_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

async function writeConsentPending(items) {
  const tmp = CONSENT_PENDING_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(items, null, 2), 'utf8');
  await fsp.rename(tmp, CONSENT_PENDING_FILE);
}

async function appendConsentPending(newItems) {
  if (!newItems.length) return;
  const existing = await readConsentPending();
  const existingIds = new Set(existing.map(x => x.id));
  const fresh = newItems.filter(x => !existingIds.has(x.id));
  if (!fresh.length) return;
  await writeConsentPending([...existing, ...fresh]);
}

/** Remove handled IDs from the local tracking file. Called by cerebellum
 *  after memory_confirm_consent or memory_drop_pending tool calls. */
export async function pruneConsentPending(handledIds) {
  if (!handledIds?.length) return;
  const items = await readConsentPending();
  const idSet = new Set(handledIds);
  const remaining = items.filter(x => !idSet.has(x.id));
  if (remaining.length !== items.length) await writeConsentPending(remaining);
}

// ── Worker ───────────────────────────────────────────────────────

async function processJob(job) {
  // V7: use reduced-detail prompt for sessions where strangers were present.
  const promptFn = job.audienceTag && job.audienceTag !== 'ward-private'
    ? buildSharedRoomPrompt
    : buildPrompt;
  // My human's configured name, never "User". Falls back to "My human".
  const wardName = (readSettingsSync()?.userName || '').trim() || 'My human';
  const prompt = promptFn(job.messages, job.topicLabel ?? null, wardName);
  if (!prompt) throw new Error('Conversation too short to memorize.');

  const { content: raw, finishReason } = await callProvider({ provider: job.provider, apiKey: job.apiKey, model: job.model, prompt });
  const facts = parseFacts(raw, finishReason);
  // Relations ride the SAME LLM response — no extra request (CLAUDE.md
  // "ride existing requests"). They're enrichment, so parseRelations never
  // throws; the worst case is an empty graph update, never a lost fact.
  const relations = parseRelations(raw, finishReason);

  // Build name → villager lookup for the remember gate
  const registry = await getRegistry().catch(() => ({ villagers: [] }));
  const byName = new Map();
  for (const v of registry.villagers ?? []) {
    byName.set(v.name.toLowerCase(), v);
    for (const a of v.aliases ?? []) {
      if (a.handle) byName.set(a.handle.toLowerCase(), v);
    }
  }

  // Ward remember map — gates facts about my human themselves (no matched
  // villager subject). The Village registry covers OTHER people; the ward is
  // not a villager, so without this the human's own sensitive facts would
  // bypass the gate entirely. Fetched once per job; degrades to null (→ shared
  // defaults: basics=true, rest=ask) if Phylactery is unreachable.
  const wardRemember = await getRememberMap().catch(() => null);

  const audience = job.audienceTag ?? 'ward-private';
  const pendingConsent = [];
  let created = 0;

  for (const fact of facts) {
    const content = (fact.content ?? '').trim();
    if (!content) continue;
    const confidence = typeof fact.confidence === 'number' ? fact.confidence : 1.0;
    if (confidence < 0.4) continue; // low-confidence skip per §3
    const category = REMEMBER_CATS.includes(fact.category) ? fact.category : 'basics';
    const subjectNames = Array.isArray(fact.subjects) ? fact.subjects : [];

    // Resolve names to villagers
    const subjectVillagers = subjectNames
      .map(n => byName.get(String(n).toLowerCase()))
      .filter(Boolean);
    const subjectIds = [...new Set(subjectVillagers.map(v => v.id))];

    // Apply the remember gate (ward map for self-facts, most-restrictive
    // villager map for facts about others).
    const gate = resolveRememberGate(category, subjectVillagers, wardRemember);
    if (gate === 'false') continue; // drop silently

    const slug = `fact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const result = await createMemoryFull({
      content,
      granularity: 'significant',
      audience,
      subjects: subjectIds,
      category,
      consent_pending: gate === 'ask',
      confidence,
      slug,
    });
    if (!result?.ok) throw new Error(`Phylactery memory_create failed: ${result?.error ?? 'unknown'}`);

    // Only queue for consent when this actually created a NEW pending memory.
    // result.merged means the fact folded into an existing entry (a near-dup):
    // if that entry was already pending it's already in the queue; if it was
    // already confirmed, re-queuing it would ask consent for something the
    // human already greenlit. Either way, skip — this is what stops the
    // consent queue filling with duplicates.
    if (gate === 'ask' && !result.merged) {
      pendingConsent.push({
        id: result.id,
        brief: content.slice(0, 120),
        villagerName: subjectVillagers.map(v => v.name).join(', ') || '(no specific person)',
        villagerId: subjectIds[0] ?? null,
        category,
        sessionId: job.sessionId,
      });
    }
    created++;
  }

  if (pendingConsent.length > 0) {
    await appendConsentPending(pendingConsent).catch(err =>
      console.warn('[memorization] failed to write consent-pending file:', err?.message ?? err)
    );
  }

  // Populate the graph from the same extraction. The graph is the Familiar's
  // mental index, and left to manual tool calls it almost never gets written —
  // so the relations the model already surfaced are routed here automatically.
  // Each edge resolves-or-creates its endpoints and dedups server-side
  // (graph_relate), so re-running a session can't pile up duplicate nodes/edges.
  // Gated on created > 0: if the remember gate dropped every fact in this
  // session, I don't quietly rebuild the same relationships in the graph.
  // Fire-and-forget per edge — a graph write failing never fails the job, and
  // Phylactery being down degrades to a no-op.
  let edgesRouted = 0;
  if (created && relations.length) {
    const results = await Promise.allSettled(
      relations.map(rel => graphRelate({
        fromLabel: rel.from,
        fromType:  rel.fromType,
        toLabel:   rel.to,
        toType:    rel.toType,
        type:      rel.type,
      }))
    );
    edgesRouted = results.filter(r => r.status === 'fulfilled' && r.value?.ok).length;
    if (edgesRouted) console.log(`[memorization] routed ${edgesRouted}/${relations.length} relation(s) to the graph`);
  }

  if (!created) throw new Error('No valid facts produced or all dropped by remember gate.');
  return { factsCreated: created, consentPending: pendingConsent.length, edgesRouted };
}

function pickNextJob(now) {
  return _queue.find(j => j.status === 'pending' && (!j.nextAttemptAt || j.nextAttemptAt <= now));
}

// Track the in-flight tick promise so stopMemorizationWorker can
// await it on shutdown. Mirrors the pattern in pondering-loop.js,
// reminders-loop.js, silence-triage-loop.js — without this, a
// SIGTERM during a processJob can leave the tome write half-done
// and the queue file out of sync with what actually persisted.
let _activeTick = null;
async function tick() {
  if (_activeTick) return _activeTick;
  _activeTick = (async () => {
    await loadQueue();
    const now = Date.now();
    const job = pickNextJob(now);
    if (!job) return;

    job.status      = 'processing';
    job.startedAt   = new Date().toISOString();
    job.attempts    = (job.attempts ?? 0) + 1;
    await persistQueue();

    try {
      const result = await processJob(job);
      job.status     = 'done';
      job.result     = result;
      job.finishedAt = new Date().toISOString();
      job.lastError  = null;
    } catch (err) {
      job.lastError = err?.message ?? String(err);
      if (job.attempts >= MAX_ATTEMPTS) {
        job.status     = 'failed';
        job.finishedAt = new Date().toISOString();
      } else {
        job.status         = 'pending';
        job.nextAttemptAt  = Date.now() + BACKOFF_MS[Math.min(job.attempts - 1, BACKOFF_MS.length - 1)];
      }
    }
    await persistQueue();
  })();
  try {
    return await _activeTick;
  } finally {
    _activeTick = null;
  }
}

function pruneAcknowledged() {
  const now    = Date.now();
  const before = _queue.length;
  _queue = _queue.filter(j => {
    if (!j.acknowledged) return true;
    if (j.status !== 'done' && j.status !== 'failed') return true;
    const finishedMs = j.finishedAt ? Date.parse(j.finishedAt) : now;
    return (now - finishedMs) < ACK_TTL_MS;
  });
  return _queue.length !== before;
}

let _started = false;
let _tickInterval = null;
let _pruneInterval = null;
export function startMemorizationWorker() {
  if (process.env.PROTO_FAMILIAR_MEMORIZE_DISABLED === '1') {
    console.log('[memorization] worker disabled via PROTO_FAMILIAR_MEMORIZE_DISABLED=1');
    return;
  }
  if (_started) return;
  _started = true;
  loadQueue().then(() => {
    _tickInterval  = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
    _pruneInterval = setInterval(() => { if (pruneAcknowledged()) persistQueue().catch(() => {}); }, 60 * 60 * 1000);
    tick().catch(() => {});
  });
}

// Stop the worker cleanly so process exit can complete. Called by
// server.js's SIGTERM/SIGINT handler. Without this, the setIntervals
// here keep the event loop alive past server.close().
//
// Awaits any in-flight tick so a processJob mid-tome-write isn't
// left torn between persistQueue calls — matches the pattern in
// pondering-loop / reminders-loop / silence-triage-loop.
export async function stopMemorizationWorker() {
  if (_tickInterval)  { clearInterval(_tickInterval);  _tickInterval  = null; }
  if (_pruneInterval) { clearInterval(_pruneInterval); _pruneInterval = null; }
  const pending = _activeTick;
  _started = false;
  if (pending) { try { await pending; } catch { /* surfaced via job.lastError already */ } }
}

// ── Public API used by server endpoints ─────────────────────────

// L4 (audit, deferred): the load → dedup-check → push → persist
// sequence below is not wrapped in a lock. If two POST /api/memorize
// arrive within the same microtask window — say both fire from a
// chat-turn-end (server-side) and a sendBeacon (browser-side) for
// the same session — they can both see "not present yet" before
// either persistQueue runs, and we end up with two near-duplicate
// jobs. The originId-style dedup that exists on outbox isn't here.
//
// Symptom to watch for: same session getting memorized twice with
// slightly different message ranges, or two parallel "processing"
// jobs of the same scope showing up in the queue.
//
// If this turns up in live testing, fix is: wrap the body in
// withLock(QUEUE_FILE, ...) from thalamus so the load + dedup +
// push + persist run as one atomic unit.

export async function enqueueMemorization({ sessionId, scope, topicId, topicLabel, messageRange, messages, provider, apiKey, model, audienceTag }) {
  await loadQueue();
  if (!sessionId || typeof sessionId !== 'string') throw new Error('sessionId is required.');
  if (!Array.isArray(messages) || messages.length < 2) throw new Error('At least 2 messages are required.');
  if (!provider || !apiKey || !model) throw new Error('provider, apiKey, and model are required.');
  const normScope = scope === 'topic' ? 'topic' : 'session';
  const normLabel = typeof topicLabel === 'string' && topicLabel.trim() ? topicLabel.trim() : null;

  // Idempotency: same session+scope+topicId+rangeKey collapses to the existing job
  // unless that job is already in a terminal state.
  const rangeKey = messageRange ? `${messageRange.start}-${messageRange.end}` : '';
  const dupKey   = `${sessionId}|${normScope}|${topicId ?? ''}|${rangeKey}`;
  const existing = _queue.find(j => j.dupKey === dupKey && (j.status === 'pending' || j.status === 'processing'));
  if (existing) return { jobId: existing.id, deduped: true };

  const job = {
    id:            randomUUID(),
    dupKey,
    sessionId,
    scope:         normScope,
    topicId:       topicId ?? null,
    topicLabel:    normLabel,
    messageRange:  messageRange ?? null,
    messages,
    provider,
    apiKey,
    model,
    audienceTag:   typeof audienceTag === 'string' ? audienceTag : 'ward-private',
    status:        'pending',
    attempts:      0,
    createdAt:     new Date().toISOString(),
    lastError:     null,
    acknowledged:  false,
  };
  _queue.push(job);
  await persistQueue();
  // Kick the worker immediately rather than waiting for the next tick.
  tick().catch(() => {});
  return { jobId: job.id, deduped: false };
}

export async function listJobs() {
  await loadQueue();
  // Strip apiKey and message bodies from listings to avoid leaking secrets/bloat.
  return _queue.map(j => ({
    id:            j.id,
    sessionId:     j.sessionId,
    scope:         j.scope,
    topicId:       j.topicId,
    status:        j.status,
    attempts:      j.attempts,
    createdAt:     j.createdAt,
    startedAt:     j.startedAt ?? null,
    finishedAt:    j.finishedAt ?? null,
    nextAttemptAt: j.nextAttemptAt ?? null,
    lastError:     j.lastError ?? null,
    result:        j.result ?? null,
    acknowledged:  !!j.acknowledged,
  }));
}

export async function acknowledgeJob(id) {
  await loadQueue();
  const job = _queue.find(j => j.id === id);
  if (!job) return false;
  if (job.status !== 'done' && job.status !== 'failed') return false;
  job.acknowledged = true;
  await persistQueue();
  return true;
}

export async function cancelJob(id) {
  await loadQueue();
  const idx = _queue.findIndex(j => j.id === id);
  if (idx < 0) return false;
  if (_queue[idx].status === 'processing') return false;
  _queue.splice(idx, 1);
  await persistQueue();
  return true;
}
