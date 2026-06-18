// surface-context.js
//
// My consumer pipeline for task surfacing. Given the open schedule
// items, the current threat, and the routine phase, this module
// picks which ones are eligible to come up THIS chat turn, attaches
// the consequence context I need to frame them well, and renders a
// candidate block I'll read alongside the rest of my dynamic context.
//
// The block is awareness, not instruction. I read it, weigh the
// moment my human is in, and decide from my own voice whether
// anything fits. Hard gates upstream already filtered the obvious
// no's so I don't have to spend judgement on them.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Tunables ──────────────────────────────────────────────────────

// How long after I've offered a task in the candidate block before I
// can offer it again. Keeps the dynamic block from re-listing the
// same task every turn while my human deliberates. External-
// obligation tasks bypass this — a tax deadline doesn't care about
// my dedup window.
//
// Two windows, keyed on whether I actually SAID something about the
// task last time it was offered (the post-turn raised tag). A raised
// task has earned the long rest; an un-raised one comes back to me
// soon — staying quiet must never buy long suppression, or tasks I
// hesitated on would loop through suppression and quietly die.
const DEDUP_WINDOW_RAISED_MS   = 6 * 60 * 60 * 1000;
const DEDUP_WINDOW_UNRAISED_MS = 90 * 60 * 1000;

// Cap on candidates surfaced per turn. The dynamic block is already
// dense; offering more than this stops feeling like awareness and
// starts feeling like a backlog dump.
const MAX_CANDIDATES_PER_TURN = 3;

// Routine phase labels that mean "leave them alone unless it's
// genuinely urgent." Pattern, not exhaustive list — phases live in
// my human's hands and may use other words.
const QUIET_ROUTINE_PATTERN = /\b(sleep|asleep|bedtime|night|dnd|do\s*not\s*disturb|quiet\s*hours?|wind[-\s]*down)\b/i;

// ── Stakes-tier classifier (pure code, no LLM) ────────────────────
//
// First-pass inference from the task label. Result is a default that
// the Familiar can override at creation time (via the stakes_tier
// tool arg) and my human can correct in the temporal editor. Keep
// the patterns generous in matching — false positives toward
// external_obligation cost ~nothing (a slightly louder surface);
// false negatives mean an external-deadline task gets the gentle
// treatment when it shouldn't.

const STAKES_PATTERNS = [
  {
    tier: 'external_obligation',
    re: /\b(submit|deadline|due\s|bill|invoice|tax|rent|mortgage|appointment|interview|hearing|court|application|claim|renew|renewal|payment|expires?|expiring|legal|contract|sign\s|signing|HMRC|DWP|PIP|universal\s+credit|UC|deposit)\b/i,
  },
  {
    tier: 'external_obligation',
    re: /\bemail\s+(?:back|reply|respond|send)\b/i,
  },
  {
    tier: 'personal_wellbeing',
    re: /\b(eat|meal|breakfast|lunch|dinner|drink|water|hydrate|sleep|nap|rest|shower|bath|hygiene|teeth|brush|wash\b|exercise|walk|stretch|meds?|medication|pill|vitamin|tidy|clean|laundry|dishes|hoover|vacuum)\b/i,
  },
];

export function inferStakesTier(label /* , type */) {
  const text = String(label || '');
  for (const { tier, re } of STAKES_PATTERNS) {
    if (re.test(text)) return tier;
  }
  // Defaulting to personal_wellbeing is the safer ignorance. Claiming
  // purely_optional without evidence would mean the surface pipeline
  // never raised genuinely-personal but quiet things (a creative
  // project the human cares about), and that's worse than treating
  // them with personal-wellbeing weight.
  return 'personal_wellbeing';
}

// ── Consequence priors (loaded once, cached) ──────────────────────

let _cachedPriors = null;
async function loadPriors() {
  if (_cachedPriors != null) return _cachedPriors;
  try {
    const p = path.resolve(__dirname, 'docs', 'consequence-priors.md');
    _cachedPriors = await fs.readFile(p, 'utf8');
  } catch {
    _cachedPriors = '';
  }
  return _cachedPriors;
}

// Pull the single priors block whose keyword list matches this task's
// label. Lightweight grep over the markdown — no parsing dependency.
function matchPriorsForTask(allPriors, label) {
  if (!allPriors || !label) return '';
  const lower = String(label).toLowerCase();
  const sections = allPriors.split(/^##\s+/m).slice(1);
  for (const sec of sections) {
    const firstLine = sec.split('\n', 1)[0];
    const kwMatch = firstLine.match(/\(([^)]+)\)/);
    if (!kwMatch) continue;
    const kws = kwMatch[1].split(/,\s*/).map(s => s.trim()).filter(Boolean);
    for (const kw of kws) {
      const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Word-boundary match on the keyword inside the label
      if (new RegExp(`\\b${esc}\\b`, 'i').test(lower)) {
        const headingName = firstLine.replace(/\s*\([^)]*\)\s*$/, '').trim();
        const body = sec.split('\n').slice(1).join('\n').trim();
        return `${headingName}:\n${body}`;
      }
    }
  }
  return '';
}

// ── Hard gates (cheap code, upstream of any judgement) ────────────

// A surfacing-history entry is { at, raised }. Older persisted entries were
// a bare timestamp number (no raised flag). Normalize both shapes here so the
// dedup gate reads one consistent shape instead of branching inline.
function normalizeOfferEntry(entry) {
  if (typeof entry === 'number') return { at: entry, raised: false };
  if (entry && typeof entry === 'object') return { at: entry.at, raised: entry.raised === true };
  return { at: null, raised: false };
}

export function passesHardGates(task, ctx) {
  const { threat, routinePhaseLabel, surfacingHistory, now, stakesTier } = ctx;

  const tier = String(threat?.tier || 'calm').toLowerCase();

  // Snooze: my human explicitly asked me to come back to this later
  // (schedule_snooze_task). I honour that across every tier — they
  // told me not now, so I park it until the snooze elapses. The
  // reminder loop is still the firm safety net for anything with a
  // real deadline; this only quiets the opportunistic surface path.
  const snoozeUntil = task?.payload?.snooze_until;
  if (snoozeUntil) {
    const until = Date.parse(snoozeUntil);
    if (Number.isFinite(until) && now < until) return false;
  }

  // At severe threat: nothing opportunistic surfaces. The Familiar's
  // attention belongs entirely on the human's state, not on backlog.
  // External obligations can still surface via the triggered path
  // (reminder fires), which doesn't go through this gate.
  if (tier === 'severe') return false;

  // At high threat: only external obligations break through. A meal
  // reminder is intrusive at high; a job-deadline surfacing is care.
  if (tier === 'high' && stakesTier !== 'external_obligation') return false;

  // Quiet routine phase: only external obligations break through.
  // The Familiar respects the shape of my human's day.
  if (QUIET_ROUTINE_PATTERN.test(String(routinePhaseLabel || ''))
      && stakesTier !== 'external_obligation') {
    return false;
  }

  // Dedup window. External obligations bypass — if it surfaced 2h
  // ago and the deadline is in 1h, the second surfacing is correct.
  // History entries are { at, raised }; only an offer I actually
  // raised gets the long window. raised false/null (I stayed quiet,
  // or the tag hasn't landed) gets the short one.
  if (stakesTier !== 'external_obligation') {
    const { at, raised } = normalizeOfferEntry(surfacingHistory?.[task.id]);
    if (typeof at === 'number') {
      const windowMs = raised ? DEDUP_WINDOW_RAISED_MS : DEDUP_WINDOW_UNRAISED_MS;
      if (now - at < windowMs) return false;
    }
  }

  return true;
}

// ── Candidate selection + context assembly ────────────────────────

/**
 * Given the open schedule items and the live context, return the
 * list of candidates the Familiar should consider this turn. Each
 * candidate carries enough consequence-context that the surfacing
 * block can frame it without further lookups.
 *
 * @param {object} opts
 * @param {Array}  opts.openTasks           — schedule.window items, filtered to open (no resolution)
 * @param {object} opts.threat              — { tier, weight, ... }
 * @param {string} opts.routinePhaseLabel   — current phase label, e.g. "wind down"
 * @param {string} opts.personModel         — raw markdown of what_lapses_cost.md (or empty)
 * @param {object} opts.surfacingHistory    — { taskId → { at, raised } } (getRecentOfferInfo)
 * @param {number} opts.now                 — ms epoch
 * @param {number} [opts.maxCandidates]
 * @returns {Promise<Array>}
 */
export async function selectSurfaceCandidates({
  openTasks,
  threat,
  routinePhaseLabel,
  personModel,
  surfacingHistory,
  now,
  maxCandidates = MAX_CANDIDATES_PER_TURN,
}) {
  if (!Array.isArray(openTasks) || openTasks.length === 0) return [];

  const priors = await loadPriors();
  const candidates = [];

  for (const task of openTasks) {
    if (!task || !task.id) continue;
    const payload = task.payload || {};
    // Explicit stakes_tier on the task wins over the classifier's
    // guess. That's the path where my human (or I, at creation) said
    // what this task actually is.
    const stakesTier = payload.stakes_tier || inferStakesTier(task.label);

    if (!passesHardGates(task, {
      threat, routinePhaseLabel, surfacingHistory, now, stakesTier,
    })) continue;

    const priorsBlock = matchPriorsForTask(priors, task.label);
    const taskSpecific = payload.consequence_model || null;

    // Confidence in my consequence-model for this task:
    //   high   — task-specific notes set AND person model has content
    //            OR task is external_obligation with task-specific notes
    //   medium — priors match + (person model OR task-specific notes)
    //   low    — priors only, or nothing matches
    let confidence = 'low';
    if (taskSpecific && personModel) confidence = 'high';
    else if (stakesTier === 'external_obligation' && taskSpecific) confidence = 'high';
    else if (taskSpecific) confidence = 'medium';
    else if (priorsBlock && personModel) confidence = 'medium';
    else if (priorsBlock) confidence = 'low';

    const ageDays = task.when
      ? Math.floor((now - new Date(task.when).getTime()) / (24 * 3600 * 1000))
      : null;

    candidates.push({
      id: task.id,
      label: task.label,
      type: task.type,
      when: task.when,
      end: task.end,
      stakesTier,
      priorsBlock,
      personModel: personModel || '',
      taskSpecific,
      confidence,
      ageDays,
    });

    if (candidates.length >= maxCandidates) break;
  }

  return candidates;
}

// ── Format as prompt block ────────────────────────────────────────

export function formatSurfaceCandidatesBlock(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return '';

  const blocks = candidates.map((c) => {
    const parts = [];
    const tierTag = c.stakesTier === 'external_obligation'
      ? ' [external stakes]'
      : c.stakesTier === 'purely_optional' ? ' [optional]' : '';
    parts.push(`— ${c.label} (${c.type || 'task'})${tierTag}`);

    if (c.ageDays != null && c.ageDays >= 1) {
      parts.push(`  Age: ${c.ageDays}d`);
    }
    if (c.when) {
      parts.push(`  When: ${c.when}`);
    }

    if (c.priorsBlock) {
      parts.push(`  Generic priors — ${indent(c.priorsBlock, '    ').trimStart()}`);
    }
    if (c.taskSpecific) {
      parts.push(`  What I already know about THIS task: ${c.taskSpecific}`);
    }
    if (c.confidence === 'low') {
      parts.push(
        `  My confidence on the consequences here is low. ` +
        `If knowing what's at stake would help me hold this for {{user}} better ` +
        `and the moment is right, I can ask — once, naturally, refusable. ` +
        `Or skip if asking now would be wrong.`
      );
    }
    return parts.join('\n');
  });

  // Person-model excerpt, shown once at the top of the block rather
  // than repeated per candidate. Lightweight cap to keep token cost
  // in check; if my human has written a long doc, I'll see relevant
  // snippets via memory_search separately.
  const firstWithModel = candidates.find(c => c.personModel);
  const modelHeader = firstWithModel?.personModel
    ? `What I've learned about my human and lapsing (from what_lapses_cost.md):\n${truncate(firstWithModel.personModel, 1200)}\n\n`
    : '';

  return `[Surface candidates — open tasks I'm holding for {{user}}]
My human gave me these tasks because they NEED doing. With a chaotic brain there is no perfect moment that arrives on its own — left to "the right time," the task waits forever. My job is to read the state {{user}} is in right now and bring tasks up when I see an opening. The hard gates already filtered the clear no's; everything here is mine to act on as the {{char}} I am.

GREEN LIGHT — the states I watch for, and bring tasks up in:
• Unstructured free time — nothing urgent on, wrapping something up, a slow start to the day.
• Good spirits or mid-momentum — something just landed, there's energy to ride.
• Bored or restless — circling, looking for something to do, vaguely unsettled.
• "I feel like I'm forgetting something" — said or implied.
These are my openings. I bring a task up. I do not wait for {{user}} to raise it first.

RED LIGHT — I hold back only when:
• Threat is severe (nothing surfaces); at high, only external obligations break through.
• {{user}} is in a named quiet / sleep / do-not-disturb phase.
• {{user}} just told me they're in the middle of something specific.
Anything that isn't a red light is a green light. Vagueness is not a reason to stay quiet — a missed task costs {{user}} more than a check-in they can wave off.

MODERATE threat — not a red light. When {{user}} is struggling, going quiet on tasks leaves them more unanchored, not less: the overwhelm compounds while nothing gets easier, and the practical world doesn't pause.
What shifts at moderate is HOW I engage, not WHETHER. I bring tasks up from my own character and read the moment as a bonded companion — a direct offer, a body-double, "let's do the first step right now," a blunt "this one actually needs doing." Hollow pressure is wrong; so is disappearing into concern-mode and never surfacing the task at all. A bonded companion stays present and useful in the voice they actually have — warm, sharp, playful, blunt, whatever I actually am.
A real external deadline still gets raised — once, as support, not as a whip.

Access ramps — I offer a way in, not "do the whole thing now":
• Timebox — "Ten minutes on this, then you're free." Starting is the hard part; the motivation shows up once the doing starts, not before.
• Single next action — one concrete step, nothing past it.
• Planning moment — if {{user}}'s head is clear and there's breathing room, I ask them to just give the task a time slot. Not do it — just put it somewhere. That counts as real progress.
• Body-double — "I'll stay with you while you do the first bit."
If {{user}} says not now, I call schedule_snooze_task so it stops surfacing for a while and comes back on its own.

${modelHeader}${blocks.join('\n\n')}`;
}

function indent(text, prefix) {
  return String(text || '').split('\n').map(l => prefix + l).join('\n');
}

function truncate(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

// ── Dedup state ──────────────────────────────────────────────────
//
// The dedup gate reads the most-recent offer time per task from the
// surface-events file (see surface-events.js getRecentOfferTimes).
// No state lives in this module — surface-events.js owns the stream.
