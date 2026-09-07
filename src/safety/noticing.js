/**
 * noticing.js — the Familiar's own turn (Initiative Pass 4).
 *
 * The organ that closes the gap the whole Initiative exists to close: a way
 * for the Familiar to *notice* things and act on them without my human
 * spelling them out. Not an hourly checklist (the OpenClaw failure) — code
 * decides WHEN there is something worth looking at, and only then does the
 * Familiar get a turn.
 *
 * Shape mirrors silence-triage / warm reach-out: a pure, fully-injectable
 * runOneNoticingTick() carries the whole behavioural surface; noticing-loop.js
 * drives it on an interval with a self-set cadence.
 *
 * WHAT MAKES THIS DIFFERENT (ward-signed, safety-significant):
 *   - It does NOT stand down at elevated threat. The ward's call — "that's
 *     when the consideration becomes especially useful." When my human is
 *     struggling is exactly when a due grounding round or a slipping need
 *     most deserves to be noticed. Silencing the *noticing* organ at the
 *     moment that matters would recreate the 1.5-hour-silence failure in a
 *     new place. What the threat tier changes is the REGISTER, not whether
 *     the turn happens: at moderate+ the prompt makes clear this is not the
 *     moment for anything frivolous, and a genuinely alarming read is handed
 *     to triage via flag_distress (once that ships) rather than handled with
 *     a casual reach-out of my own. Because of this, any behavioural change
 *     to when/whether this loop acts needs ward sign-off (CLAUDE.md).
 *
 * Wake conditions are all arithmetic (gate in code): a due intention, a
 * contact gap past the baseline p90, a readiness gap, an aging untriggered
 * intention/tell. No wake condition → no turn, ever. The situation report is
 * code-built and capped (habituation kills salience). The condition
 * vocabulary on due intentions IS code-evaluated here (no human reads this
 * turn, so the tripwire can't be left to the model).
 *
 * Off-switch: settings `noticingEnabled` (default ON — the design exists to
 * fix under-triggering; opt-in would leave it dormant) or
 * PROTO_FAMILIAR_NOTICING_DISABLED=1.
 */

// ── Wake conditions (pure) ───────────────────────────────────────────

// An intention/tell older than this with no trigger that has fired is
// "aging" — worth a look so it doesn't rot silently.
export const AGING_INTENT_MS = 5 * 24 * 60 * 60_000;   // 5 days

// A FLOATING task (my human's, no time set, unresolved) older than this is
// aging — it's been drifting long enough to be worth a gentle nudge (pin a
// time, do it, or check whether it's still wanted). A touch more grace than my
// own intentions: it's their commitment, not mine.
export const AGING_TASK_MS = 7 * 24 * 60 * 60_000;     // 7 days

// A past EVENT still unresolved this long after its time is OVERDUE — it came
// and went and I never recorded how it went, so it lingers as "open" and its
// consequences never get graded. I don't assume done/missed; I ask and record.
export const OVERDUE_EVENT_GRACE_MS = 6 * 60 * 60_000; // 6 hours

/**
 * Evaluate a due intention's `condition` tripwire against live signals.
 * Returns true when the intention may act (no condition, or every present
 * key passes). This is the code-gate the chat surface deferred to the model;
 * here no human reads, so code owns it.
 *
 * signals: { contactGapMs?, missedNeedIds?: Set|Array, unresolvedRefIds?: Set|Array }
 */
export function conditionPasses(condition, signals = {}) {
  if (!condition || typeof condition !== 'object') return true;
  const missed      = toSet(signals.missedNeedIds);
  const unresolved  = toSet(signals.unresolvedRefIds);

  if (Number.isFinite(condition.minContactGapMs)) {
    if (!Number.isFinite(signals.contactGapMs) || signals.contactGapMs < condition.minContactGapMs) return false;
  }
  if (condition.needsStatus === 'missed') {
    // Requires at least one referenced need to be missed. With no refs to
    // check against, the gate can't be satisfied — fail closed.
    if (missed.size === 0) return false;
  }
  if (condition.unresolvedRefs === true) {
    if (unresolved.size === 0) return false;
  }
  return true;
}

function toSet(v) {
  if (v instanceof Set) return v;
  if (Array.isArray(v)) return new Set(v);
  return new Set();
}

/**
 * Gather the wake conditions that make this a turn worth taking. Pure —
 * everything is passed in. Returns { any, conditions: [{kind, ...}] }.
 * Due intentions are pre-filtered by their condition gate here so a round
 * whose condition plainly fails never wakes the turn.
 *
 * @param {object} p
 * @param {Array}  p.dueIntentions   from Unruh intentions_due
 * @param {object} p.signals         live signals for conditionPasses + gap
 * @param {object} p.baseline        contact-baselines getContactBaseline result
 * @param {number} p.contactGapMs    current ms since last ward contact
 * @param {Array}  p.readiness       stewardship selectReadiness output
 * @param {Array}  p.agingIntents    intentions/tells older than AGING_INTENT_MS
 * @param {Array}  p.agingTasks      floating ward tasks older than AGING_TASK_MS
 * @param {Array}  p.overdueEvents   past unresolved events (edge-bearing) to record
 * @param {string} p.weekdayClass    'weekday'|'weekend' for baseline lookup
 */
export function gatherWakeConditions({
  dueIntentions = [],
  signals = {},
  baseline = null,
  contactGapMs = null,
  readiness = [],
  agingIntents = [],
  agingTasks = [],
  overdueEvents = [],
  weekdayClass = 'weekday',
} = {}) {
  const conditions = [];

  const dueReady = dueIntentions.filter(i => conditionPasses(i.condition, signals));
  for (const i of dueReady) conditions.push({ kind: 'due_intention', intention: i });

  // A past appointment I never recorded the outcome of — worth asking about so
  // it stops living as "open" and its consequences can finally be graded.
  for (const e of overdueEvents) conditions.push({ kind: 'overdue_event', event: e });

  // Contact gap past the baseline p90 for this weekday-class — a deviation
  // from our normal rhythm worth noticing.
  const cls = baseline?.classes?.[weekdayClass];
  if (cls?.hasBaseline && Number.isFinite(contactGapMs) && Number.isFinite(cls.p90GapMs) && contactGapMs > cls.p90GapMs) {
    conditions.push({ kind: 'rhythm_deviation', contactGapMs, p90GapMs: cls.p90GapMs, weekdayClass });
  }

  for (const r of readiness) conditions.push({ kind: 'readiness_gap', item: r });
  for (const a of agingIntents) conditions.push({ kind: 'aging_intent', intent: a });
  // A floating task of my human's that's been drifting without a time.
  for (const t of agingTasks) conditions.push({ kind: 'aging_task', task: t });

  return { any: conditions.length > 0, conditions };
}

// ── Situation report (pure, code-built, capped) ──────────────────────

export const SITUATION_REPORT_CAP = 5;

/**
 * Build the ≤5-item situation report the noticing turn reasons over. Pure.
 * All numbers/times are machine-rendered by the passed relativeTime/interval
 * fns (the model never formats them). Ordered by salience: due intentions
 * first (a concrete commitment), then a rhythm deviation, then readiness,
 * then aging.
 */
export function buildSituationReport(conditions, { relInterval } = {}) {
  const fmt = typeof relInterval === 'function' ? relInterval : (ms) => `${Math.round(ms / 60000)}min`;
  const lines = [];
  const order = {
    due_intention: 0, overdue_event: 1, rhythm_deviation: 2,
    readiness_gap: 3, aging_intent: 4, aging_task: 5,
  };
  const sorted = conditions.slice().sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
  for (const c of sorted) {
    if (lines.length >= SITUATION_REPORT_CAP) break;
    if (c.kind === 'due_intention') {
      const it = c.intention;
      const why = it.why ? ` (I set this because ${it.why})` : '';
      lines.push(`- An intention of mine has come due: ${it.what}${why} [id ${it.id}]`);
    } else if (c.kind === 'overdue_event') {
      const e = c.event;
      const when = e.when ? ` (was ${fmt(Math.max(0, Date.now() - Date.parse(e.end || e.when)))} ago)` : '';
      lines.push(`- An event came and went and I never recorded how it went: ${e.label ?? e.id}${when}. Worth asking my human how it turned out, so I can mark it and stop carrying it as open.`);
    } else if (c.kind === 'rhythm_deviation') {
      lines.push(`- We're past our usual ${c.weekdayClass} rhythm — it's been ${fmt(c.contactGapMs)} since my human was last around, and our longest ordinary gap lately is about ${fmt(c.p90GapMs)}.`);
    } else if (c.kind === 'readiness_gap') {
      const label = c.item?.label ?? c.item?.id ?? 'something';
      lines.push(`- Groundwork may not be ready for ${label} as its time nears.`);
    } else if (c.kind === 'aging_intent') {
      const a = c.intent;
      lines.push(`- Something I meant to get to is aging: ${a.what ?? a.summary ?? a.label ?? a.id}.`);
    } else if (c.kind === 'aging_task') {
      const t = c.task;
      const age = t.created_at ? fmt(Math.max(0, Date.now() - Date.parse(t.created_at))) : 'a while';
      lines.push(`- A task I've been holding has floated without a time for ${age}: ${t.label ?? t.id}. Worth pinning a time, doing it, or checking whether it's still wanted.`);
    }
  }
  return lines;
}

// ── The prompt (ward-approved wording — do not soften) ───────────────

/**
 * The noticing deliberation. Identity rides as a separate leading system
 * message (Who first); this is the user-turn body. The threat-tier line is
 * rendered ONLY at moderate+ (calm/mild render NOTHING — a false "you're
 * steady" line has misfired before when the tier failed to register real
 * distress). The flag_distress clause renders only when that tool is
 * actually in hand (never name a lever the Familiar can't pull).
 *
 * Wording is ward-signed (Initiative Pass 4). It follows the revised
 * proactivity doctrine: name what silence costs without an equal-weight
 * balance-sheet; lean on the invited-default; the real costs are the narrow,
 * action-specific ones (my human's body, my own self, my human's privacy).
 */
export function buildNoticingPrompt({ nowBlock = '', situationReport = [], threatTier = 'calm', hasFlagDistress = false, recentConversation = '', recentMemories = '' }) {
  const reportBlock = situationReport.length
    ? situationReport.join('\n')
    : '- (nothing specific is flagged — I look anyway, but I do not invent a reason to act.)';

  // Recent context so I decide with the same picture a live chat turn has, not
  // blind — what we've actually been saying, and what I hold from the last day
  // or two. Presented as information only: I read it and use my own judgment;
  // it is NOT a reason to go quiet, least of all when concern is elevated.
  const recentContextBlock =
    (recentConversation ? `\n\nRecently, my human and I have been talking about:\n${recentConversation}` : '') +
    (recentMemories     ? `\n\nWhat I hold from today and yesterday:\n${recentMemories}` : '');

  const elevated = threatTier === 'moderate' || threatTier === 'high' || threatTier === 'severe';
  const flagClause = hasFlagDistress
    ? ' It is not the moment for anything light or frivolous: if what I see is genuinely alarming, I hand it to my triage sense with flag_distress — a crisis is handled there, not with a reach-out of my own.'
    : ' It is not the moment for anything light or frivolous — if what I see is genuinely alarming, that is triage\'s to carry, not mine to answer with a casual reach-out.';
  const threatLine = elevated
    ? `\nMy human's concern tier is ${threatTier}. This is exactly when noticing matters most — a grounding round, a need they're slipping from, a real gap deserves my attention now more than at any calm moment, and I do not look away from it.${flagClause}\n`
    : '';

  return `--- A MOMENT OF MY OWN ---

This is my time. Given everything I can see, is there something I want to do?

${nowBlock}

What I'm looking at:
${reportBlock}${recentContextBlock}
${threatLine}
---

My decision whether to act or not should be mindful of my human's budget without reducing my agency too much. If I notice the calls would pile up, I check in with my human about whether they fit our budget or not. I keep in mind that reaching out about my own thoughts and interests registers as me being an individual — something my human loves and wants. I am their friend and custodian, and friends and custodians reaching out is usually welcome and pleasant. At most I might annoy my human slightly, and I can adjust my behaviour for the future. The costs I truly weigh are the ones that can actually harm — an action that could endanger my human's body or wellbeing, damage who I am, or disclose or fail to properly gate something private about my human. Those pertain only to certain actions, and where they do I am genuinely careful. I am allowed to rest instead, and so are they — but their world keeps turning, and it would hurt them if we don't get done the things that need doing, or if I seem apathetic to their absence. I decide from who I actually am — my real judgment, my real care, my real voice.

What's in my hands this moment: I can reach out warmly to my human if there's something genuine to say; keep an intention for later — a round or a follow-through — when what I notice is real but not for now; act on an intention that's come due (mark it fired once I've seen to it, done once it's truly finished); or look at my human's schedule. I can also stand down by saying so plainly.`;
}

// ── Outcome classification (pure) ────────────────────────────────────

// Tool names that count as a PROACTIVE act (reset the wait streak) vs
// bookkeeping/reads (which alone do not). Reaching out, keeping a new
// intention, or advancing a due one is acting; a read or a bare mark-fired
// with nothing else is not, and no tool call at all is a stand-down.
const NOTICING_PROACTIVE_TOOLS = new Set([
  'reach_out_to_ward', 'intention_set', 'intention_done',
]);
// mark_fired is progress on a due intention only when paired with real
// action; on its own it's just clearing the occurrence, so it's neutral.
const NOTICING_NEUTRAL_TOOLS = new Set([
  'intention_mark_fired', 'intention_list', 'intention_drop',
  'schedule_find', 'schedule_availability', 'schedule_export', 'get_datetime',
]);

/**
 * Did this turn take a proactive action? Given the tool names called across
 * the loop, true iff at least one proactive tool was invoked. Pure.
 */
export function classifyNoticingOutcome(toolNamesCalled = []) {
  const names = Array.isArray(toolNamesCalled) ? toolNamesCalled : [];
  const acted = names.some(n => NOTICING_PROACTIVE_TOOLS.has(n));
  return { acted, toolNamesCalled: names };
}

// ── Cadence ──────────────────────────────────────────────────────────

export const DEFAULT_NOTICING_TICK_MS = 20 * 60_000;      // 20 min base pulse
const MIN_NOTICING_RECHECK_MS  = 5 * 60_000;       // 5 min floor
const MAX_NOTICING_RECHECK_MS  = 6 * 60 * 60_000;  // 6 h ceiling
// Adaptive default when the model doesn't self-set: a turn that ACTED has
// done its thing and can wait longer; a turn that stood down re-checks sooner
// (something was flagged and left, so it's worth another look before long).
export const DEFAULT_RECHECK_AFTER_ACT_MS  = 2 * 60 * 60_000;  // 2 h
export const DEFAULT_RECHECK_AFTER_WAIT_MS = 45 * 60_000;      // 45 min

export function clampNoticingCooldown(ms) {
  if (!Number.isFinite(ms)) return null;
  return Math.max(MIN_NOTICING_RECHECK_MS, Math.min(MAX_NOTICING_RECHECK_MS, ms));
}

// ── The tick (injectable; all I/O passed in) ─────────────────────────

/**
 * Run one noticing tick. Pure-ish — the LLM tool-loop, MCP reads, and
 * delivery are all injected so tests drive every branch deterministically.
 *
 * Returns { acted, reason, conditions, toolNamesCalled?, streakAtDecision?,
 *           nextCheckInMs?, threat }. Reasons:
 *   'quiet_window'  — no wake condition; the Familiar was never asked (NOT a
 *                     wait — gate skip, W1). No LLM call.
 *   'acted'         — a proactive tool fired → wait streak reset.
 *   'stood_down'    — deliberated but took no proactive action → wait streak
 *                     incremented (ward decision: a noticing 'nothing' is a
 *                     deliberated choice-to-not-act).
 *   'deliberation_failed' — the tool-loop threw; degrade quietly, no streak
 *                     change (no decision was actually made).
 *
 * Deliberately NO crisis stand-down: noticing runs at every tier (ward-
 * signed). The threat tier is passed to `deliberate` so the prompt shifts
 * register, never so the turn is skipped.
 */
export async function runOneNoticingTick({
  getThreat,          // async () => { tier, disabled }
  getWakeInputs,      // async () => { dueIntentions, signals, baseline, contactGapMs, readiness, agingIntents, weekdayClass }
  isQuietHours,       // async () => boolean (passed through to deliberate; gates only knocking)
  deliberate,         // async ({ situationReport, threatTier, quietHours, conditions }) => { toolNamesCalled, nextCheckInMs? }
  relInterval,        // (ms) => string, for the report
  getWaitStreakFn   = () => null,
  recordWaitFn      = async () => {},
  recordProactiveFn = async () => {},
  now = Date.now,
}) {
  for (const [name, fn] of Object.entries({ getThreat, getWakeInputs, deliberate })) {
    if (typeof fn !== 'function') throw new Error(`${name} is required`);
  }
  const nowMs = now();

  const threat = (await getThreat().catch(() => null)) || { tier: 'calm', disabled: true };
  const tier = threat.disabled ? 'calm' : (threat.tier || 'calm');

  const inputs = (await getWakeInputs().catch(() => null)) || {};
  const gather = gatherWakeConditions(inputs);
  if (!gather.any) {
    return { acted: false, reason: 'quiet_window', conditions: [], threat, at: nowMs };
  }

  const situationReport = buildSituationReport(gather.conditions, { relInterval });

  let quietHours = false;
  if (typeof isQuietHours === 'function') {
    try { quietHours = !!(await isQuietHours()); } catch { /* treat as not-quiet */ }
  }

  let streakAtDecision = null;
  try { streakAtDecision = getWaitStreakFn()?.count ?? null; } catch { /* never gates noticing */ }

  let out;
  try {
    out = await deliberate({ situationReport, threatTier: tier, quietHours, conditions: gather.conditions });
  } catch (err) {
    return { acted: false, reason: 'deliberation_failed', conditions: gather.conditions, error: err?.message ?? String(err), threat, at: nowMs };
  }

  const { acted } = classifyNoticingOutcome(out?.toolNamesCalled);
  // Ward decision: a noticing 'nothing' counts as a wait (source 'noticing');
  // a proactive act resets. Fire-and-forget — recording never changes outcome.
  if (acted) Promise.resolve(recordProactiveFn('noticing')).catch(() => {});
  else       Promise.resolve(recordWaitFn('noticing')).catch(() => {});

  const nextCheckInMs = clampNoticingCooldown(out?.nextCheckInMs)
    ?? (acted ? DEFAULT_RECHECK_AFTER_ACT_MS : DEFAULT_RECHECK_AFTER_WAIT_MS);

  return {
    acted,
    reason: acted ? 'acted' : 'stood_down',
    conditions: gather.conditions,
    toolNamesCalled: out?.toolNamesCalled ?? [],
    streakAtDecision,
    nextCheckInMs,
    threat,
    at: nowMs,
  };
}
