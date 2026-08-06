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
import { isCallActiveFromFile } from './call-engine.js';
import { randomUUID } from 'crypto';
import { PROVIDER_URLS } from './providers.js';
import { extractContent } from './llm-call.js';

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

// Is a ward standing-consent window open for this category right now? The map
// is Phylactery's active-only projection (expired windows already filtered), but
// we re-check `until` against the current instant so a window that lapsed
// between the fetch and here can't auto-confirm. Epoch-ms throughout — no
// timezone math (the expiry is an absolute instant produced by code).
export function wardStandingActive(wardStanding, category, nowMs = Date.now()) {
  const entry = wardStanding?.[category];
  const until = entry?.until;
  return typeof until === 'number' && until > nowMs;
}

// Resolve the effective gate for a fact. Consent is source-aware: WHO the fact
// is about and WHETHER my human told me directly both matter, not the category
// alone. The shape my human asked for:
//
//   • A fact about a registered villager (subjectVillagers non-empty) → their
//     own remember map gates it; a third person's private life is asked for
//     regardless of channel. Most restrictive villager wins (false > ask > true).
//   • A fact about a NAMED-but-unregistered third party (hasNamedSubjects) →
//     their private life is asked for too; direct-channel implied consent never
//     sweeps a stranger's sensitive info in.
//   • A fact about my human themselves (no named subjects), told to me DIRECTLY
//     (a DM or the web chat — direct=true) → implied consent: they told me on
//     purpose, so I keep it without asking. This is the default; an EXPLICIT
//     ward setting still wins (an explicit 'ask' still asks, 'false' never
//     stores) — implied consent only fills the UNSET default.
//   • The same fact heard INDIRECTLY (a group room — direct=false) → asked for,
//     as before. Standing consent still relaxes an 'ask' to auto-confirm.
export function resolveRememberGate(category, subjectVillagers, wardRemember, wardStanding = null, opts = {}) {
  const { direct = false, hasNamedSubjects = false, fictional = false } = opts;
  // A fictional character — the canon of a show, game, book or film — has no
  // real-world privacy to protect, so a fact about them is kept freely, no ask,
  // whatever the channel. (Ward's call: don't forget who Sailor Moon canonically
  // dates just because Usagi can't opt into being remembered.) This sits ABOVE
  // the third-party checks on purpose; it never applies to a real person, which
  // the extractor is told plainly.
  if (fictional) return 'true';
  if (subjectVillagers && subjectVillagers.length > 0) {
    let gate = 'true';
    for (const v of subjectVillagers) {
      const vGate = gateForCategory(category, v.remember);
      if (vGate === 'false') return 'false';
      // Standing mutual consent (my human AND this person both agreed) clears the
      // per-fact `ask` for them — but never overrides an explicit `false` above.
      if (vGate === 'ask' && !standingConsentActive(v)) gate = 'ask';
    }
    return gate;
  }
  // No registered villager subject.
  const explicit = !!wardRemember && Object.prototype.hasOwnProperty.call(wardRemember, category);
  const gate = gateForCategory(category, wardRemember);
  if (gate === 'false') return 'false';   // explicit 'never store' always wins
  if (gate === 'true')  return 'true';
  // gate === 'ask' from here.
  // A named-but-unregistered third party's private life: always ask. Never let
  // direct-channel implied consent or the ward's own standing window store a
  // stranger's sensitive fact without review.
  if (hasNamedSubjects) return 'ask';
  // About my human (or me) themselves. Told directly → implied consent, but only
  // over the DEFAULT ask — an explicit ward 'ask' still asks.
  if (direct && !explicit) return 'true';
  // Standing consent only ever RELAXES an 'ask' to auto-confirm.
  if (wardStandingActive(wardStanding, category)) return 'true';
  return 'ask';
}

mkdirSync(TOMES_DIR, { recursive: true });

const MAX_ATTEMPTS    = 5;
const BACKOFF_MS      = [5_000, 30_000, 120_000, 600_000, 1_800_000]; // 5s, 30s, 2m, 10m, 30m
const TICK_MS         = 5_000;
const ACK_TTL_MS      = 24 * 60 * 60 * 1000; // prune acknowledged terminal jobs after a day
const SESSION_MEMORIES_TOME_NAME = 'Session Memories';
const SESSION_MEMORIES_TOME_DESC = 'Auto-generated entries from past conversations. Created on first session memorization.';
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

import { findOrCreateTomeByName, modifyTomeFile, createMemoryFull, getRememberMap, getStandingConsent, graphRelate, getScheduleWindow } from './thalamus.js';
import { getRegistry, standingConsentActive } from './village.js';
import { deriveMemoryAudience, deriveNodeAudience, mostRestrictiveAudience } from './audience.js';
import { GRAPH_ENTITY_TYPES_STR, GRAPH_NODE_RUBRIC } from './graph-vocab.js';
import { CONTENT_TOPICS, normalizeTag, categoryToTag } from './content-tags.js';
import { segmentByDay, dayDelta } from './day-segments.js';
import { recordSegmentRun, isSegmentMemorized, segmentMemorizedThrough } from './memory-coverage.js';
import { readSettingsSync } from './cerebellum.js';
import { substituteMacros } from './macros.js';
import { contentWithStandins, getAssetMeta } from './media.js';
import { createSessionFollowup } from './recent-ponderings.js';

// Vision (§7): fold image stand-ins into a slice's transcript so an image-
// carrying message is memorable — an image-only message (empty text, one
// attachment) becomes eligible because the stand-in gives it text, and every
// image message gains legibility. Any undescribed asset gets one look first
// (describeAsset via dynamic import — keeps vision.js out of the static
// import cycle memorization↔cerebellum; memorization is background, so a
// describe call here is fine and means the memory reads the image, not "not
// yet described"). Returns the messages unchanged when none carry attachments.
async function foldImageStandins(messages, settings) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.some(m => Array.isArray(m?.attachments) && m.attachments.length)) return list;
  let describeAsset = null;
  try { ({ describeAsset } = await import('./vision.js')); } catch { /* describe optional */ }
  const out = [];
  for (const m of list) {
    if (!Array.isArray(m?.attachments) || !m.attachments.length) { out.push(m); continue; }
    if (describeAsset) {
      for (const a of m.attachments) {
        try {
          const meta = await getAssetMeta(a?.id);
          if (meta && meta.description === null) await describeAsset(a.id, settings);
        } catch { /* best effort */ }
      }
    }
    out.push({ ...m, content: await contentWithStandins(m) });
  }
  return out;
}

export function findOrCreateSessionMemoriesTome() {
  return findOrCreateTomeByName(TOMES_DIR, TOME_NAME, {
    name:        TOME_NAME,
    description: TOME_DESCRIPTION,
    enabled:     true,
    graduationExempt: true,   // runtime store — graduation never eats it
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

// The content-tag field, shared by both extraction prompts (private + shared
// room) so the two never drift. It's a "topic:level" tag that decides, later,
// which of my human's Villagers may ever see this fact — a separate axis from
// `category` (how I file it): a fact can be a plain "basics" note and still be
// deeply private. Code validates whatever I put here against the fixed topic
// list and falls back to a safe default, so a wrong tag never leaks anything.
const CONTENT_TAG_JSON_LINE = `,\n      "content_tag": "medical:sensitive"`;
const CONTENT_TAG_FIELD_RULE = `
content_tag — what this fact is ABOUT and how private it feels, as "topic:level". This is what later decides which of my human's people are ever allowed to see it, so I think about who I'd be comfortable knowing this.
  topic — one of: ${CONTENT_TOPICS.join(', ')}. ("general" is the catch-all for ordinary things that aren't one of the others.)
  level — "open" or "sensitive". "sensitive" is anything my human would only want shared with people they really trust on that subject; "open" is the everyday version. Unsure → "sensitive".
  It's separate from category: category is how I file the fact, content_tag is who gets to see it. E.g. "my human came out to me" → "sexuality:sensitive"; "my human works at a bakery" → "work:open"; "we talked about their new medication" → "medical:sensitive"; "they like oat milk" → "general:open".`;

export function buildPrompt(messages, topicLabel = null, wardName = 'My human', scheduleLegend = [], followupsEnabled = true) {
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

  // Cross-store refs (temporal-bridges Piece 2). When the ward's schedule
  // around these days is available, I offer a compact legend so a fact ABOUT a
  // scheduled item can carry that item's id — the breadcrumb that later lets me
  // walk from a remembered fact to the moment on the schedule it belongs to. I
  // only ever cite ids from this list; code drops any I make up. Absent legend
  // → this whole apparatus vanishes and the prompt is exactly as before.
  const legend = Array.isArray(scheduleLegend) ? scheduleLegend.filter(n => n?.id && n?.label) : [];
  const scheduleFieldLine = legend.length
    ? `,\n      "schedule_refs": ["dinner-x7"]`
    : '';
  const scheduleRules = legend.length
    ? `\nschedule_refs — OPTIONAL. If this fact is specifically about one of the scheduled items in the legend below, I include that item's id here. I use ONLY ids that appear in the legend — never one I invent. Most facts have no schedule item; for those I omit this field entirely.\n`
    : '';
  const scheduleLegendBlock = legend.length
    ? `\n### Schedule legend (the ward's items around these days — for schedule_refs only)\n${legend.slice(0, 30).map(n => `  ${n.label} [${n.type ?? 'item'}] = ${n.id}`).join('\n')}\n`
    : '';

  // Deferred follow-ups (0.9.x, the "I'll do that later" catch). Ward-private
  // only — the mirror of the deferred-"tell" bug: there I said a thing and
  // forgot the bookkeeping, here I promise a thing and never do it. I only
  // catch and re-surface it; I never invent the reminder time or the tool.
  const followupsFieldLine = followupsEnabled
    ? `,\n  "follow_ups": [\n    "Short summary of the thing I said I'd do but didn't"\n  ]`
    : '';
  const followupsFieldRules = followupsEnabled
    ? `\n### Field rules — follow_ups\n\nThings I told my human I would do but did not actually do this session — I said "I'll do that later" / "I'll remind you" / "I'll set that up" and never used a tool to make it real. I list each as a short summary so future-me follows through. If I DID use the right tool for it, it is not a follow-up. If nothing qualifies, [].\n`
    : '';

  return `I'm looking back over the conversation I just had with {{user}}, pulling out what's worth keeping — the things I'd want to remember later about them, about myself, or about the people and things in their life. One clear fact per entry, concrete and real, nothing vague. I also jot down the plain connections between the people, places and things that came up, because that little web is how I find a memory again later.${focusBlock}

I return ONLY valid JSON with this exact shape (no markdown fences, no commentary):
{
  "facts": [
    {
      "content":    "One fact, in my own voice (1–2 sentences max).",
      "category":   "emotional_content",
      "subjects":   ["Alice"],
      "temporality": "episodic",
      "fictional":  false,
      "confidence": 0.85${CONTENT_TAG_JSON_LINE}${scheduleFieldLine}
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
  ]${followupsFieldLine}
}

### Field rules — facts

content — my note on this one fact, in my own voice. Concrete, not a generality.
  If it's about me, I write "I …" — never my own name in the third person, even if {{user}} called me by it in the chat. If it's about {{user}}, I use their name or "my human". Anyone else, I name them.
  Good (me):   "I promised {{user}} I'd remind them about the dentist on Tuesday."
  Good (them): "Alice said she's worn out from job-hunting and feeling stuck."
  Too vague:   "We talked about various things."
  Wrong (me in third person): "{{char}} agreed to help." — that's me; I write "I agreed to help."

category — exactly one:
  basics            — name, pronoun, role, occupation, a basic biographical fact
  emotional_content — feelings, mental state, stress, mood, emotional patterns
  health_info       — physical health, conditions, medications, symptoms
  relationships     — how people are connected: family, partners, friends, colleagues
  whereabouts       — location, travel, living situation, where someone is

subjects — the names of whoever this fact is about. Empty list [] if it's just about me or {{user}}.

fictional — true ONLY when this fact is about a made-up character or the canon of a show, game, book or film ({{user}} and I discussing who Sailor Moon dates, a character in a game they play). Those aren't real people, so there's nothing to keep private and I remember them freely. NEVER true for a real person — a real friend, family member, or acquaintance is not fictional no matter how little I know them. Leave it out or false the rest of the time.
${CONTENT_TAG_FIELD_RULE}

temporality — did this HAPPEN, or is it just TRUE now?
  "episodic" — something from this day: a mood, an event, how they felt, a one-off. It belongs to the conversation's date and I'll find it later under "what was going on around then".
  "standing" — a fact that's generally true now, not tied to a day: a job, where someone lives, a lasting preference, a relationship. I hold it as a fact, not a memory of one day.
  Both, or unsure → "episodic". A dated memory is the safe default; the standing truth can still surface from it.

confidence — 0.0 to 1.0, how sure I am I've got it right. I drop anything below 0.4.
${scheduleRules}${scheduleLegendBlock}
### Field rules — relations

A relation is one plain edge in my graph: two real, nameable things and how they're linked. It's the index I navigate by, so I only record edges I'm actually sure of.

from / to — the names of the two things. {{user}} is my human's name here; I use real names (or how I know someone), never "the user" or a pronoun.
fromType / toType — what each one IS. Pick from: ${GRAPH_ENTITY_TYPES_STR}.
  ${GRAPH_NODE_RUBRIC}
type — a short snake_case label read from→to: works_at, lives_in, married_to, parent_of, friend_of, has_condition, owns, located_in, colleague_of, and so on.
${followupsFieldRules}
### A few rules for myself
- One entry per distinct fact. One sentence carrying two facts about two people is two entries.
- If a fact could be two categories, I take the more sensitive one (health > emotional > relationships > whereabouts > basics).
- I skip pleasantries and small talk — only what I'd actually want to remember about someone.
- 1–12 facts. I merge rather than split when it's the same claim restated.
- An edge only when both ends are concrete named things and the link was said or clearly meant. Nothing to link → "relations" is []. I never invent one.
- 0–10 relations.

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

  return `This conversation happened in a shared room — other people were around besides {{user}} and me. {{user}} wants to know what went on around me, so I note what genuinely happened, including the things other people did or said. I don't decide here what's kept about whom: a separate consent step does that afterwards, weighing each person by where they sit in {{user}}'s Village and asking {{user}} about anyone who isn't in it. So I don't pre-censor — I just get it down and let that step do its job.${focusBlock}

I return ONLY valid JSON with this exact shape (no markdown fences, no commentary):
{
  "facts": [
    {
      "content":    "One fact, in my own voice (1–2 sentences max).",
      "category":   "emotional_content",
      "subjects":   [],
      "temporality": "episodic",
      "fictional":  false,
      "confidence": 0.85${CONTENT_TAG_JSON_LINE}
    }
  ],
  "relations": [
    {
      "from":     "{{user}}",
      "fromType": "person",
      "type":     "lives_in",
      "to":       "Portland",
      "toType":   "place"
    }
  ]
}

### Field rules — facts

content — my note on this one fact, in my own voice.
  If it's about me, I write "I …" — never my own name in the third person, even if someone in the room called me by it. If it's about {{user}}, I use their name or "my human". Anyone else, I name them.

category — exactly one: basics, emotional_content, health_info, relationships, whereabouts.

subjects — the names of whoever a fact is about, including someone who isn't in {{user}}'s Village. I don't leave a person out to play it safe — the consent step decides what's actually kept, and asks {{user}} about anyone it isn't sure of. Empty list [] if it's just about me or {{user}}.

fictional — true ONLY when the fact is about a made-up character or the canon of a show, game, book or film. Those aren't real people, so I remember them freely. NEVER true for a real person in the room, however little I know them. Leave it out or false otherwise.
${CONTENT_TAG_FIELD_RULE}

temporality — "episodic" for something from this day (a mood, an event, what happened); "standing" for a fact that's just generally true now (a job, where someone lives, a lasting preference). Unsure or both → "episodic".

confidence — 0.0 to 1.0. I drop anything below 0.4.

### Field rules — relations

A relation is one plain edge in my graph: two named things and how they're linked. Graph edges skip the consent step, so for REAL people I only draw an edge that touches {{user}} or someone in their Village — I don't link two people who are both outside it. An edge between fictional characters (a show's canon) is fine; they're not real people.

from / to — the names of the two things. {{user}} is my human's name here.
fromType / toType — pick from: ${GRAPH_ENTITY_TYPES_STR}. ${GRAPH_NODE_RUBRIC}
type — a short snake_case label read from→to (lives_in, works_at, married_to, has_condition, owns, …).

### A few rules for myself
- One entry per distinct fact. I skip pleasantries and small talk.
- 1–8 facts — a shared room usually gives less that's mine to keep.
- "relations" is [] unless a real edge touches {{user}} or someone in their Village, or it's between fictional characters. 0–5 relations, never invented.

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
  // Tolerate thinking models that put the answer in reasoning_content (shared rule).
  const content = extractContent(choice?.message ?? {});
  if (!content) {
    const fr = choice?.finish_reason;
    throw new Error(`Provider returned empty content (finish_reason=${fr ?? 'unknown'})` +
      (fr === 'length' ? ' — hit the token cap mid-response; raise max_tokens.' : '.'));
  }
  return { content, finishReason: choice?.finish_reason ?? null };
}

/**
 * Salvage complete objects from a truncated/malformed response. Walks the
 * named array (`key`, e.g. "topics" or "facts") with a string-aware brace
 * counter and individually parses each complete object — a response that
 * produced four whole entries and one cut-off one keeps the four. Shared by
 * both the topic and fact parsers so the counter lives in exactly one place.
 */
function salvageArrayField(raw, key) {
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

// Deferred follow-ups (0.9.x): pull the optional "follow_ups" array out of the
// SAME response that carried facts/relations — no extra LLM call (CLAUDE.md
// "ride existing requests"). Mirrors parseFacts' shape but the payload is
// just short strings, not objects, so it's a plain filter/trim, never a
// brace-counting salvage. Enrichment, never load-bearing: malformed or
// missing → [], same as parseRelations — a follow-up bug can never cost the
// human a memorized fact.
const MAX_FOLLOWUPS_PER_JOB = 10;

export function parseFollowups(raw, finishReason = null) {
  const cleaned = String(raw).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const match = cleaned.match(/\{[\s\S]+\}/);
  if (!match) return [];
  let parsed;
  try { parsed = JSON.parse(match[0]); }
  catch { return []; } // truncated/malformed — a follow-up isn't worth salvaging half a JSON object for
  const arr = Array.isArray(parsed.follow_ups) ? parsed.follow_ups : [];
  return arr
    .map(f => String(f ?? '').trim())
    .filter(Boolean)
    .slice(0, MAX_FOLLOWUPS_PER_JOB);
}

// The one gate: env off-switch wins outright; otherwise the ward's
// `followupsEnabled` setting (default ON — the ward asked for this).
export function followupsFeatureEnabled(settings) {
  if (process.env.PROTO_FAMILIAR_FOLLOWUPS_DISABLED === '1') return false;
  return settings?.followupsEnabled !== false;
}

// ── Consent-pending helpers ───────────────────────────────────────

export async function readConsentPending() {
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
  const settings = readSettingsSync();
  // My human's configured name, never "User". Falls back to "My human".
  const wardName = (settings?.userName || '').trim() || 'My human';

  // Cross-store refs (Piece 2): on a ward-private slice, offer the model a
  // compact schedule legend so a fact about a scheduled item can carry its id.
  // Ward-private only — a shared-room slice never sees the ward's schedule.
  // Best-effort: Unruh down → empty legend → the prompt is exactly as before.
  // `validScheduleIds` is the code gate: only these ids may survive on a fact.
  let scheduleLegend = [];
  let validScheduleIds = new Set();
  if (!job.audienceTag || job.audienceTag === 'ward-private') {
    try {
      const win = await getScheduleWindow({});
      const nodes = [
        ...(Array.isArray(win?.nodes) ? win.nodes : []),
        ...(Array.isArray(win?.linked) ? win.linked : []),
      ];
      scheduleLegend = nodes
        .filter(n => n?.id && n?.label && !(n.payload?.spine || n.payload?.sensitive)) // never legend a crisis state
        .map(n => ({ id: n.id, label: n.label, type: n.type }));
      validScheduleIds = new Set(scheduleLegend.map(n => n.id));
    } catch { /* no legend this job */ }
  }

  // Deferred follow-ups (0.9.x): ward-private sessions only, gated by the
  // env kill-switch + the ward's settings toggle. `promptFn === buildPrompt`
  // already IS the ward-private branch (buildSharedRoomPrompt never asks for
  // follow_ups), so this is the single flag both the prompt and the parse
  // step read.
  const followupsOn = promptFn === buildPrompt && followupsFeatureEnabled(settings);

  // Fold image stand-ins into the slice so image-carrying turns are memorable.
  const visionMessages = await foldImageStandins(job.messages, settings);
  const builtPrompt = promptFn === buildPrompt
    ? buildPrompt(visionMessages, job.topicLabel ?? null, wardName, scheduleLegend, followupsOn)
    : promptFn(visionMessages, job.topicLabel ?? null, wardName);
  // {{char}}/{{user}} in the extraction templates resolve to the configured
  // names here (boundary #1) — the same place every other standalone Familiar-
  // voice prompt substitutes. This is why the Familiar's name is never
  // hard-coded in the template: a fact about itself reads "I", and the model
  // never sees a stray "{{char}}" token.
  const prompt = builtPrompt ? substituteMacros(builtPrompt, settings) : builtPrompt;
  if (!prompt) throw new Error('Conversation too short to memorize.');

  const { content: raw, finishReason } = await callProvider({ provider: job.provider, apiKey: job.apiKey, model: job.model, prompt });
  const facts = parseFacts(raw, finishReason);
  // Relations ride the SAME LLM response — no extra request (CLAUDE.md
  // "ride existing requests"). They're enrichment, so parseRelations never
  // throws; the worst case is an empty graph update, never a lost fact.
  const relations = parseRelations(raw, finishReason);
  // Follow-ups ride the same response too. Never throws; a parse failure
  // degrades to no follow-up, same as relations.
  const followups = followupsOn ? parseFollowups(raw, finishReason) : [];
  if (followups.length) {
    for (const summary of followups) {
      try { await createSessionFollowup({ summary }); }
      catch (err) { console.warn('[memorization] createSessionFollowup failed:', err?.message ?? err); }
    }
  }

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

  // Active standing-consent windows (ward said "trust your judgment for a
  // while" on some categories). Fetched once per job; degrades to {} → the gate
  // simply falls back to per-fact asking. Only affects ward-self facts.
  const wardStanding = await getStandingConsent().catch(() => ({}));

  const audience = job.audienceTag ?? 'ward-private';
  // Did my human tell me this DIRECTLY — a DM or the web chat, just the two of
  // us? Then keeping it is implied consent: they said it to me on purpose. A
  // shared room (any non-ward-private tag) is indirect — I heard it, I wasn't
  // told it, so those facts still get a check-in. This is the axis the consent
  // gate turns on, alongside who the fact is about.
  const direct = audience === 'ward-private';
  // The day this slice actually belongs to. Day-scoped jobs (segmentByDay) carry
  // the calendar date as topicId — pass it as the memory's date_key so a slice
  // from an older conversation files under ITS day, not today. Without this every
  // imported fact lands in today's bucket (the 159-into-today bug). Undefined for
  // non-day jobs → createMemoryFull defaults to today, as before.
  const factDate = (job.scope === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(String(job.topicId ?? '')))
    ? job.topicId : undefined;
  const pendingConsent = [];
  let created = 0;

  for (const fact of facts) {
    const content = (fact.content ?? '').trim();
    if (!content) continue;
    const confidence = typeof fact.confidence === 'number' ? fact.confidence : 1.0;
    if (confidence < 0.4) continue; // low-confidence skip per §3
    const category = REMEMBER_CATS.includes(fact.category) ? fact.category : 'basics';
    const subjectNames = Array.isArray(fact.subjects) ? fact.subjects : [];

    // Names other than my human. My human's own name never reads as a "third
    // party" even if the model lists it — an empty namedOthers means the fact is
    // about them (or me), which is what earns direct-channel implied consent.
    const namedOthers = subjectNames
      .map(n => String(n).trim())
      .filter(n => n && n.toLowerCase() !== wardName.toLowerCase());
    const hasNamedSubjects = namedOthers.length > 0;

    // Resolve the named others to registered villagers (unregistered names drop
    // out — a stranger the fact is about, gated as a third party below).
    const subjectVillagers = namedOthers
      .map(n => byName.get(n.toLowerCase()))
      .filter(Boolean);
    const subjectIds = [...new Set(subjectVillagers.map(v => v.id))];

    // Source-aware consent: a fact my human told me directly about themselves is
    // kept on implied consent; a third person's private life, or anything heard
    // in a group room, still asks. A fact the extractor flagged `fictional`
    // (a show/game/book's canon) has no real-world privacy to gate — kept freely.
    const fictional = fact.fictional === true;
    const gate = resolveRememberGate(category, subjectVillagers, wardRemember, wardStanding,
      { direct, hasNamedSubjects, fictional });
    if (gate === 'false') continue; // drop silently

    // Content tag (the recall-gating axis). The model suggests a "topic:level";
    // code is the source of truth for the exact value — I validate it against
    // the fixed vocabulary and, on anything missing or unrecognised, fall back
    // to deriving one from the category (the exact-values rule: a mis-tagged
    // fact must gate TIGHTER, never leak). Stored as "topic:level".
    const norm = normalizeTag(fact.content_tag) || categoryToTag(category);
    const contentTag = `${norm.topic}:${norm.level}`;

    // Derive WHERE this fact may surface (audience), in code — the extractor is
    // never asked for it. Widen+tighten: a subject's explicit disclosure pref can
    // raise/lower it; otherwise it's bounded by the session tag + sensitivity.
    const factAudience = deriveMemoryAudience({
      category, subjects: subjectVillagers, sessionTag: audience, registry,
    });

    // Temporality decides the storage tier — the distinction my human asked for
    // between "I experienced this that day" and "this is just generally true now":
    //   • episodic → the `daily` tier, STANDALONE + dated. Each fact keeps its own
    //     category / subjects / consent, then consolidates (daily→weekly→…) and
    //     decays like a memory of a day should. This is the safe default.
    //   • standing → a durable fact, not a memory of a day. A standing fact about
    //     my human themselves lives on their `ward` standing register (recalled
    //     when relevant, never day-bucketed); a standing fact about a specific
    //     person is a durable person-attached fact. Both use `significant` so
    //     they skip daily consolidation/decay. (`significant` stays reserved from
    //     the always-on surface — these are recalled, not injected every turn.)
    const standing = fact.temporality === 'standing';
    const storage = standing
      ? { granularity: 'significant', standalone: true, date: factDate,
          ...(hasNamedSubjects ? {} : { register: 'ward' }) }
      : { granularity: 'daily', standalone: true, date: factDate };
    const slug = `fact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    // Validate the model's schedule_refs in CODE against the legend it was
    // shown — a cited id survives only if it's a real node id. The model
    // repeats ids, it never mints them; a hallucinated ref dies here.
    const rawRefs = Array.isArray(fact.schedule_refs) ? fact.schedule_refs : [];
    const scheduleRefs = [...new Set(rawRefs.map(String).filter(id => validScheduleIds.has(id)))];
    const result = await createMemoryFull({
      content,
      ...storage,
      audience: factAudience,
      subjects: subjectIds,
      category,
      contentTag,
      consent_pending: gate === 'ask',
      confidence,
      slug,
      ...(scheduleRefs.length ? { sourceMeta: { schedule_refs: scheduleRefs } } : {}),
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
        villagerName: subjectVillagers.map(v => v.name).join(', ')
          || (hasNamedSubjects ? namedOthers.join(', ') : '(no specific person)'),
        villagerId: subjectIds[0] ?? null,
        category,
        sessionId: job.sessionId,
        // Context so the ask isn't detached from time or reason (my human found
        // date-less, unexplained asks confusing). `date` = the day the fact is
        // from; `reason` = WHY it needs review rather than being kept on implied
        // consent: a group room, or a third person's private life.
        date: factDate ?? new Date().toISOString().slice(0, 10),
        reason: !direct ? 'shared-room' : (hasNamedSubjects ? 'third-party' : 'ask'),
        standing,
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
      relations.map(rel => {
        // Derive each endpoint's audience in code: a node matching a known
        // villager takes their category, otherwise ward-private (fail-closed).
        // The edge takes the narrower of its two endpoints so it can't reveal a
        // ward-private node in a wider room.
        const fromAudience = deriveNodeAudience({ label: rel.from, registry });
        const toAudience   = deriveNodeAudience({ label: rel.to,   registry });
        const edgeAudience = mostRestrictiveAudience([fromAudience, toAudience], registry);
        return graphRelate({
          fromLabel: rel.from,
          fromType:  rel.fromType,
          toLabel:   rel.to,
          toType:    rel.toType,
          type:      rel.type,
          fromAudience, toAudience, edgeAudience,
        });
      })
    );
    edgesRouted = results.filter(r => r.status === 'fulfilled' && r.value?.ok).length;
    if (edgesRouted) console.log(`[memorization] routed ${edgesRouted}/${relations.length} relation(s) to the graph`);
  }

  // Day-anchored coverage (Phase 1): record this date-slice as processed so the
  // ledger / calendar can mark the day. A slice that produced zero kept facts is
  // still DONE (pleasantries memorize to nothing) — recording it stops the sweep
  // re-running it forever. Shared-room slices are flagged so the day reads
  // 'uncertain'. Fire-and-forget; coverage never fails the job.
  if (job.scope === 'day' && job.topicId) {
    await recordSegmentRun({
      date:         job.topicId,
      sessionId:    job.sessionId,
      // Cumulative: where this delta started (priorThrough) + how many it
      // covered. So a tail-only run still advances coverage to the full day.
      throughCount: (job.priorThrough ?? 0) + (Array.isArray(job.messages) ? job.messages.length : 0),
      facts:        created,
      flag:         (job.audienceTag && job.audienceTag !== 'ward-private') ? 'shared-room' : null,
    }).catch(() => {});
  }

  if (!created) {
    // A day slice with nothing to keep is a success (already recorded). For
    // session/topic jobs, preserve the original "nothing memorized" signal.
    if (job.scope === 'day') return { factsCreated: 0, consentPending: 0, edgesRouted: 0 };
    throw new Error('No valid facts produced or all dropped by remember gate.');
  }
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
    // Governor (§4.3): defer draining the memorization queue during a live call —
    // it is not time-critical and its LLM extraction would contend with the call.
    // The outer finally still clears _activeTick, so it resumes after the call.
    if (await isCallActiveFromFile()) return;
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

export async function enqueueMemorization({ sessionId, scope, topicId, topicLabel, messageRange, messages, provider, apiKey, model, audienceTag, fullSegment = false }) {
  await loadQueue();
  if (!sessionId || typeof sessionId !== 'string') throw new Error('sessionId is required.');
  if (!Array.isArray(messages) || messages.length < 2) throw new Error('At least 2 messages are required.');
  if (!provider || !apiKey || !model) throw new Error('provider, apiKey, and model are required.');
  const normScope = scope === 'topic' ? 'topic' : scope === 'day' ? 'day' : 'session';
  const normLabel = typeof topicLabel === 'string' && topicLabel.trim() ? topicLabel.trim() : null;

  // Day jobs ingest only the UN-memorized TAIL of the day. The segment passed in
  // is the whole day's messages; when a session keeps growing on the same date,
  // re-extracting the earlier messages just remints facts the system already
  // holds and floods the consent queue with duplicates (the reported pile-up).
  // So we slice from `priorThrough` (what coverage says is already done) and the
  // processor records coverage cumulatively. `fullSegment` (the manual
  // force-re-memorize path) opts out and deliberately re-reads the whole day.
  let priorThrough = 0;
  if (normScope === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(String(topicId ?? '')) && !fullSegment) {
    const delta = dayDelta(messages, await segmentMemorizedThrough(sessionId, topicId));
    if (delta.skip) return { jobId: null, deduped: true, upToDate: true };
    messages = delta.messages;
    priorThrough = delta.priorThrough;
  }

  // Idempotency: same session+scope+topicId+rangeKey+offset collapses to the
  // existing job unless that job is already in a terminal state. The offset
  // keeps successive day deltas distinct while deduping a re-enqueue at the
  // same point.
  const rangeKey = messageRange ? `${messageRange.start}-${messageRange.end}` : '';
  const dupKey   = `${sessionId}|${normScope}|${topicId ?? ''}|${rangeKey}|${priorThrough}`;
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
    priorThrough,
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

/**
 * Day-anchored enqueue (Phase 1). Segments a session's messages by local
 * calendar date and enqueues one job per date-slice, so memorization is tracked
 * per DAY rather than per session. Slices the coverage ledger already marks
 * memorized are skipped; midnight-crossing sessions naturally become two jobs.
 * `scope:'day'` + `topicId:<date>` keys idempotency uniquely per date.
 *
 * Never throws (the sweep iterates many sessions): a too-short session or a
 * single bad segment is skipped, not surfaced. Returns { enqueued, skipped }.
 */
export async function enqueueSessionByDay({ sessionId, messages, provider, apiKey, model, audienceTag }) {
  if (!sessionId || !Array.isArray(messages) || messages.length < 2) return { enqueued: 0, skipped: 0 };
  let enqueued = 0, skipped = 0;
  for (const seg of segmentByDay(messages)) {
    if (seg.readableCount < 2) continue; // nothing extractable on this date
    try {
      if (await isSegmentMemorized(sessionId, seg.date, seg.count)) { skipped++; continue; }
      const r = await enqueueMemorization({
        sessionId, scope: 'day', topicId: seg.date,
        messageRange: { start: seg.startIdx, end: seg.endIdx },
        messages: seg.messages, provider, apiKey, model, audienceTag,
      });
      if (r.deduped) skipped++; else enqueued++;
    } catch (err) {
      console.warn(`[memorization] enqueueSessionByDay ${seg.date} failed:`, err?.message ?? err);
    }
  }
  return { enqueued, skipped };
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
