// Noticing turn (Initiative Pass 4) — the pure logic and the injectable tick.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  conditionPasses,
  gatherWakeConditions,
  buildSituationReport,
  buildNoticingPrompt,
  noticingMessages,
  classifyNoticingOutcome,
  clampNoticingCooldown,
  runOneNoticingTick,
  SITUATION_REPORT_CAP,
  DEFAULT_RECHECK_AFTER_ACT_MS,
  DEFAULT_RECHECK_AFTER_WAIT_MS,
} from '../src/safety/noticing.js';

const HOUR = 3_600_000;

// ── conditionPasses (the code-gate) ──────────────────────────────────

test('conditionPasses: no condition → passes', () => {
  assert.equal(conditionPasses(null), true);
  assert.equal(conditionPasses({}), true);
});

test('conditionPasses: minContactGapMs gate', () => {
  const c = { minContactGapMs: HOUR };
  assert.equal(conditionPasses(c, { contactGapMs: 2 * HOUR }), true);
  assert.equal(conditionPasses(c, { contactGapMs: 30 * 60_000 }), false);
  assert.equal(conditionPasses(c, {}), false, 'no gap known → fail closed');
});

test('conditionPasses: needsStatus/unresolvedRefs fail closed without evidence', () => {
  assert.equal(conditionPasses({ needsStatus: 'missed' }, { missedNeedIds: ['n1'] }), true);
  assert.equal(conditionPasses({ needsStatus: 'missed' }, {}), false);
  assert.equal(conditionPasses({ unresolvedRefs: true }, { unresolvedRefIds: new Set(['x']) }), true);
  assert.equal(conditionPasses({ unresolvedRefs: true }, {}), false);
});

test('conditionPasses: all present keys must pass', () => {
  const c = { minContactGapMs: HOUR, unresolvedRefs: true };
  assert.equal(conditionPasses(c, { contactGapMs: 2 * HOUR, unresolvedRefIds: ['a'] }), true);
  assert.equal(conditionPasses(c, { contactGapMs: 2 * HOUR }), false, 'unresolved missing → fail');
});

// ── gatherWakeConditions ─────────────────────────────────────────────

test('gather: no inputs → no wake', () => {
  assert.equal(gatherWakeConditions().any, false);
  assert.equal(gatherWakeConditions({}).any, false);
});

test('gather: a due intention whose condition passes wakes; one that fails does not', () => {
  const due = [
    { id: 'a', what: 'reach Chen', condition: { minContactGapMs: HOUR } },
    { id: 'b', what: 'no-cond', condition: {} },
  ];
  const g = gatherWakeConditions({ dueIntentions: due, signals: { contactGapMs: 30 * 60_000 } });
  // 'a' fails (gap too small), 'b' passes.
  const ids = g.conditions.filter(c => c.kind === 'due_intention').map(c => c.intention.id);
  assert.deepEqual(ids, ['b']);
});

test('gather: rhythm deviation only when contact gap exceeds the class p90', () => {
  const baseline = { classes: { weekday: { hasBaseline: true, p90GapMs: 4 * HOUR } } };
  const under = gatherWakeConditions({ baseline, contactGapMs: 3 * HOUR, weekdayClass: 'weekday' });
  assert.equal(under.conditions.some(c => c.kind === 'rhythm_deviation'), false);
  const over = gatherWakeConditions({ baseline, contactGapMs: 9 * HOUR, weekdayClass: 'weekday' });
  assert.equal(over.conditions.some(c => c.kind === 'rhythm_deviation'), true);
  // No baseline for the class → never a deviation.
  const noBase = gatherWakeConditions({ baseline: { classes: {} }, contactGapMs: 99 * HOUR, weekdayClass: 'weekend' });
  assert.equal(noBase.any, false);
});

test('gather: readiness gaps and aging intents wake', () => {
  const g = gatherWakeConditions({
    readiness: [{ id: 'r1', label: 'passport photos' }],
    agingIntents: [{ id: 'i1', what: 'that thing' }],
  });
  assert.equal(g.conditions.filter(c => c.kind === 'readiness_gap').length, 1);
  assert.equal(g.conditions.filter(c => c.kind === 'aging_intent').length, 1);
});

test('gather: aging floating tasks and overdue events wake', () => {
  const g = gatherWakeConditions({
    agingTasks: [{ id: 't1', label: 'file the housing form', created_at: '2026-06-01T09:00:00' }],
    overdueEvents: [{ id: 'ev1', label: 'Therapy 2nd session', when: '2026-07-02T15:00:00' }],
  });
  assert.equal(g.any, true);
  assert.equal(g.conditions.filter(c => c.kind === 'aging_task').length, 1);
  assert.equal(g.conditions.filter(c => c.kind === 'overdue_event').length, 1);
});

test('gather: an unresolved-attribution memory wakes the turn', () => {
  const g = gatherWakeConditions({
    unresolvedAttributions: [
      { id: 'mem-x7', content: 'took out the recycling', subjects: ['Alice'], attribution_confidence: 0.3 },
    ],
  });
  assert.equal(g.any, true);
  const attr = g.conditions.filter(c => c.kind === 'unresolved_attribution');
  assert.equal(attr.length, 1);
  assert.equal(attr[0].memory.id, 'mem-x7');
});

// ── buildSituationReport ─────────────────────────────────────────────

test('report: renders each kind, caps at 5, due intentions first', () => {
  const conditions = [
    { kind: 'aging_intent', intent: { id: 'i', what: 'aged thing' } },
    { kind: 'due_intention', intention: { id: 'd1', what: 'reach Chen', why: 'it has been a while' } },
    { kind: 'rhythm_deviation', contactGapMs: 19 * HOUR, p90GapMs: 4 * HOUR, weekdayClass: 'weekday' },
    { kind: 'readiness_gap', item: { label: 'photos' } },
    { kind: 'due_intention', intention: { id: 'd2', what: 'x' } },
    { kind: 'aging_intent', intent: { id: 'j', what: 'overflow' } },
  ];
  const lines = buildSituationReport(conditions, { relInterval: (ms) => `${Math.round(ms / HOUR)}h` });
  assert.equal(lines.length, SITUATION_REPORT_CAP);
  assert.match(lines[0], /intention of mine has come due: reach Chen/);
  assert.match(lines[0], /because it has been a while/);
  assert.match(lines.join('\n'), /past our usual weekday rhythm/);
});

test('report: overdue events are NOT in the report (they render in the notepad); other kinds still render', () => {
  const lines = buildSituationReport([
    { kind: 'overdue_event', event: { id: 'ev1', label: 'Therapy 2nd session', when: '2020-01-01T15:00:00' } },
    { kind: 'aging_task', task: { id: 't1', label: 'housing form', created_at: '2020-01-01T09:00:00' } },
  ], { relInterval: (ms) => `${Math.round(ms / HOUR)}h` });
  const joined = lines.join('\n');
  assert.doesNotMatch(joined, /Therapy 2nd session/);   // events are handled by buildNoticingPrompt now
  assert.match(joined, /floated without a time.*housing form/);
});

test('report: an unresolved-attribution memory renders with its id, snippet, pinned subject, and the fix tool', () => {
  const lines = buildSituationReport([
    { kind: 'unresolved_attribution', memory: { id: 'mem-x7', content: 'took out the recycling before work', subjects: ['Alice'], attribution_confidence: 0.3 } },
  ], { relInterval: (ms) => `${Math.round(ms / HOUR)}h` });
  const joined = lines.join('\n');
  assert.match(joined, /unsure who did what/);
  assert.match(joined, /pinned it on Alice/);
  assert.match(joined, /took out the recycling before work/);
  assert.match(joined, /\[id mem-x7\]/);
  assert.match(joined, /update_memory_by_id/);
});

// ── buildNoticingPrompt ──────────────────────────────────────────────

test('prompt: no threat line at calm/mild; present at moderate+', () => {
  const calm = buildNoticingPrompt({ otherItems: ['- x'], threatTier: 'calm' });
  assert.doesNotMatch(calm, /concern tier/);
  const mild = buildNoticingPrompt({ otherItems: ['- x'], threatTier: 'mild' });
  assert.doesNotMatch(mild, /concern tier/);
  const mod = buildNoticingPrompt({ otherItems: ['- x'], threatTier: 'moderate' });
  assert.match(mod, /concern tier is moderate/);
  assert.match(mod, /noticing matters most/);
});

test('prompt: reflection is the Familiar thinking (its own voice), not addressed to it', () => {
  const p = buildNoticingPrompt({ otherItems: ['- x'], threatTier: 'calm' });
  // First-person self-talk — this rides in `system`, never a `user` turn.
  assert.match(p, /BRIEF MOMENT TO THINK/);
  assert.match(p, /I've got a moment to gather my bearings/);
  assert.doesNotMatch(p, /A MOMENT OF MY OWN/);   // the old user-turn framing is gone
});

test('prompt: recent conversation + memories ride as neutral context when provided', () => {
  const withCtx = buildNoticingPrompt({
    otherItems: ['- x'], threatTier: 'calm',
    recentConversation: '  [Them · earlier]: sorted the therapy paperwork',
    recentMemories: '  · felt lighter after therapy',
  });
  assert.match(withCtx, /sorted the therapy paperwork/);
  assert.match(withCtx, /felt lighter after therapy/);
  assert.match(withCtx, /Our current conversation/);

  const noCtx = buildNoticingPrompt({ otherItems: ['- x'], threatTier: 'calm' });
  assert.doesNotMatch(noCtx, /Our current conversation/);
  assert.doesNotMatch(noCtx, /What I remember from today and yesterday/);
});

test('prompt: recent context never displaces the no-look-away posture at threat', () => {
  const mod = buildNoticingPrompt({
    otherItems: ['- x'], threatTier: 'moderate',
    recentConversation: '  [Them · earlier]: we already talked this through',
    recentMemories: '  · covered it',
  });
  assert.match(mod, /noticing matters most/);
  assert.match(mod, /do not look away/);
});

test('prompt: flag_distress clause only when the tool is in hand', () => {
  const withTool = buildNoticingPrompt({ otherItems: ['- x'], threatTier: 'severe', hasFlagDistress: true });
  assert.match(withTool, /flag_distress/);
  const without = buildNoticingPrompt({ otherItems: ['- x'], threatTier: 'severe', hasFlagDistress: false });
  assert.doesNotMatch(without, /flag_distress/);
  assert.match(without, /triage's to carry/);
});

test('prompt: carries the ward-signed framing, not an equal-weight balance-sheet', () => {
  const p = buildNoticingPrompt({ otherItems: ['- x'], threatTier: 'calm' });
  assert.match(p, /friend and custodian/);
  assert.match(p, /invited|welcome|loves and wants/i);
  assert.match(p, /endanger my human's body or wellbeing/);
  // No bias-toward-quiet, no "weigh both equally" scaffolding.
  assert.doesNotMatch(p, /bias toward|only reach out when|equal weight|weigh both/i);
});

// ── the notepad: open outcomes vs nothing open ───────────────────────

test('prompt: open events render with their id, the close-first flow, the named tools, and a graph ending', () => {
  const p = buildNoticingPrompt({
    openEvents: [{ id: 'doctor-visit-a3', label: "Doctor's appointment", agoText: '9h' }],
    otherItems: [], spanText: '9 hours', threatTier: 'calm', hasFlagDistress: true,
  });
  assert.match(p, /Events I haven't logged the outcome of/);
  assert.match(p, /\[id doctor-visit-a3\]/);                        // the id it needs to close (operability)
  assert.match(p, /schedule_calibrate_link and schedule_resolve/);  // tools named so I know I have them
  assert.match(p, /last 9 hours/);                                  // dynamic look-back span
  assert.match(p, /Time to update the graph/);                      // open-events ending
  assert.doesNotMatch(p, /What I can do right now/);                // the list is suppressed while open (it distracts)
});

test('prompt: with nothing open, the capabilities list + stand-down return', () => {
  const p = buildNoticingPrompt({ openEvents: [], otherItems: ['- x'], threatTier: 'calm' });
  assert.match(p, /What I can do right now/);
  assert.match(p, /I can also stand down by saying so plainly/);
  assert.doesNotMatch(p, /Events I haven't logged/);
});

test('prompt: a snippet the code spotted rides under its event', () => {
  const p = buildNoticingPrompt({
    openEvents: [{ id: 'ev-x', label: 'X', agoText: '2h', snippet: "wasn't as scary" }],
    spanText: '2 hours',
  });
  assert.match(p, /after it, my human said: "wasn't as scary"/);
});

// ── role (the entity-as-subject fix) ─────────────────────────────────

test('messages: the reflection rides in system; the user turn is only a bare cue', () => {
  const body = buildNoticingPrompt({ otherItems: ['- x'], threatTier: 'calm' });
  const msgs = noticingMessages({ identity: 'WHO-I-AM', body });
  const users = msgs.filter(m => m.role === 'user');
  assert.equal(users.length, 1, 'exactly one user turn');
  assert.equal(users[0].content, '(a quiet moment)');
  assert.doesNotMatch(users[0].content, /BRIEF MOMENT TO THINK/);   // reflection is NEVER in the user role
  assert.ok(msgs.some(m => m.role === 'system' && /BRIEF MOMENT TO THINK/.test(m.content)), 'the reflection is a system message');
  assert.ok(msgs.some(m => m.role === 'system' && m.content === 'WHO-I-AM'), 'identity still leads');
});

test('messages: identity omitted → still valid (system body + user cue)', () => {
  const msgs = noticingMessages({ body: 'BODY' });
  assert.deepEqual(msgs, [
    { role: 'system', content: 'BODY' },
    { role: 'user', content: '(a quiet moment)' },
  ]);
});

// ── classify + clamp ─────────────────────────────────────────────────

test('classify: proactive tools mark acted; neutral/reads do not', () => {
  assert.equal(classifyNoticingOutcome(['schedule_find', 'intention_mark_fired']).acted, false);
  assert.equal(classifyNoticingOutcome(['reach_out_to_ward']).acted, true);
  assert.equal(classifyNoticingOutcome(['intention_set']).acted, true);
  assert.equal(classifyNoticingOutcome([]).acted, false);
});

test('clampNoticingCooldown: floors and ceilings; null on nonsense', () => {
  assert.equal(clampNoticingCooldown(0), 5 * 60_000);
  assert.equal(clampNoticingCooldown(99 * HOUR), 6 * HOUR);
  assert.equal(clampNoticingCooldown(NaN), null);
  assert.equal(clampNoticingCooldown(30 * 60_000), 30 * 60_000);
});

// ── runOneNoticingTick ───────────────────────────────────────────────

function baseTick(overrides = {}) {
  return {
    getThreat:     async () => ({ tier: 'calm', disabled: false }),
    getWakeInputs: async () => ({ dueIntentions: [{ id: 'd', what: 'reach Chen', condition: {} }] }),
    isQuietHours:  async () => false,
    deliberate:    async () => ({ toolNamesCalled: [] }),
    relInterval:   (ms) => `${Math.round(ms / HOUR)}h`,
    now: () => 1_000_000,
    ...overrides,
  };
}

test('tick: no wake condition → quiet_window, no deliberation, no streak change', async () => {
  const calls = [];
  let deliberated = false;
  const r = await runOneNoticingTick(baseTick({
    getWakeInputs: async () => ({}),
    deliberate: async () => { deliberated = true; return { toolNamesCalled: [] }; },
    recordWaitFn: async () => calls.push('wait'),
    recordProactiveFn: async () => calls.push('proactive'),
  }));
  assert.equal(r.reason, 'quiet_window');
  assert.equal(deliberated, false);
  assert.deepEqual(calls, [], 'a quiet window is a gate skip, not a wait');
});

test('tick: runs at severe threat (NO stand-down) and passes the tier to deliberate', async () => {
  let seenTier = null;
  const r = await runOneNoticingTick(baseTick({
    getThreat: async () => ({ tier: 'severe', disabled: false }),
    deliberate: async ({ threatTier }) => { seenTier = threatTier; return { toolNamesCalled: [] }; },
  }));
  assert.equal(seenTier, 'severe', 'noticing does not stand down at threat');
  assert.equal(r.reason, 'stood_down');
});

test('tick: a proactive tool → acted + recordProactive + longer default cadence', async () => {
  const calls = [];
  const r = await runOneNoticingTick(baseTick({
    deliberate: async () => ({ toolNamesCalled: ['reach_out_to_ward'] }),
    recordProactiveFn: async (k) => calls.push(`proactive:${k}`),
    recordWaitFn: async () => calls.push('wait'),
  }));
  assert.equal(r.acted, true);
  assert.equal(r.reason, 'acted');
  assert.deepEqual(calls, ['proactive:noticing']);
  assert.equal(r.nextCheckInMs, DEFAULT_RECHECK_AFTER_ACT_MS);
});

test('tick: standing down → recordWait(noticing) + sooner default cadence', async () => {
  const calls = [];
  const r = await runOneNoticingTick(baseTick({
    deliberate: async () => ({ toolNamesCalled: ['schedule_find'] }),
    recordWaitFn: async (s) => calls.push(`wait:${s}`),
    recordProactiveFn: async () => calls.push('proactive'),
  }));
  assert.equal(r.acted, false);
  assert.deepEqual(calls, ['wait:noticing'], 'a noticing nothing is a wait (ward decision)');
  assert.equal(r.nextCheckInMs, DEFAULT_RECHECK_AFTER_WAIT_MS);
});

test('tick: model self-set nextCheckInMs is clamped and used', async () => {
  const r = await runOneNoticingTick(baseTick({
    deliberate: async () => ({ toolNamesCalled: ['reach_out_to_ward'], nextCheckInMs: 30 * 60_000 }),
  }));
  assert.equal(r.nextCheckInMs, 30 * 60_000);
});

test('tick: a throwing deliberate degrades quietly, no streak change', async () => {
  const calls = [];
  const r = await runOneNoticingTick(baseTick({
    deliberate: async () => { throw new Error('provider down'); },
    recordWaitFn: async () => calls.push('wait'),
    recordProactiveFn: async () => calls.push('proactive'),
  }));
  assert.equal(r.reason, 'deliberation_failed');
  assert.deepEqual(calls, [], 'no decision was made → no streak change');
});

test('tick: streakAtDecision rides the result', async () => {
  const r = await runOneNoticingTick(baseTick({
    getWaitStreakFn: () => ({ count: 12 }),
    deliberate: async () => ({ toolNamesCalled: [] }),
  }));
  assert.equal(r.streakAtDecision, 12);
});

test('tick: missing required dep throws a readable error', async () => {
  await assert.rejects(() => runOneNoticingTick({ getWakeInputs: async () => ({}), deliberate: async () => ({}) }), /getThreat/);
});
