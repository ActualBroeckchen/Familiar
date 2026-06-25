import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inferStakesTier,
  passesHardGates,
  selectSurfaceCandidates,
  formatSurfaceCandidatesBlock,
} from '../surface-context.js';

// ── Classifier ──────────────────────────────────────────────────────

test('inferStakesTier: external_obligation patterns', () => {
  assert.equal(inferStakesTier('submit tax return'),     'external_obligation');
  assert.equal(inferStakesTier('pay electricity bill'),  'external_obligation');
  assert.equal(inferStakesTier('rent due'),              'external_obligation');
  assert.equal(inferStakesTier('UC form deadline'),      'external_obligation');
  assert.equal(inferStakesTier('dentist appointment'),   'external_obligation');
  assert.equal(inferStakesTier('email back HR'),         'external_obligation');
  assert.equal(inferStakesTier('renew passport'),        'external_obligation');
});

test('inferStakesTier: personal_wellbeing patterns', () => {
  assert.equal(inferStakesTier('eat lunch'),             'personal_wellbeing');
  assert.equal(inferStakesTier('drink water'),           'personal_wellbeing');
  assert.equal(inferStakesTier('shower'),                'personal_wellbeing');
  assert.equal(inferStakesTier('take meds'),             'personal_wellbeing');
  assert.equal(inferStakesTier('tidy bedroom'),          'personal_wellbeing');
  assert.equal(inferStakesTier('do the dishes'),         'personal_wellbeing');
});

test('inferStakesTier: unknown → personal_wellbeing (safer default)', () => {
  assert.equal(inferStakesTier('finish chapter 3'),      'personal_wellbeing');
  assert.equal(inferStakesTier(''),                      'personal_wellbeing');
  assert.equal(inferStakesTier(null),                    'personal_wellbeing');
});

// ── Hard gates ──────────────────────────────────────────────────────

const NOW = Date.parse('2026-06-03T14:00:00Z');
const calm   = { tier: 'calm' };
const high   = { tier: 'high' };
const severe = { tier: 'severe' };

test('passesHardGates: severe threat kills everything opportunistic', () => {
  for (const tier of ['external_obligation', 'personal_wellbeing', 'purely_optional']) {
    assert.equal(
      passesHardGates(
        { id: 't1' },
        { threat: severe, routinePhaseLabel: '', surfacingHistory: {}, now: NOW, stakesTier: tier },
      ),
      false,
      `severe should block ${tier}`,
    );
  }
});

test('passesHardGates: high threat only allows external_obligation', () => {
  assert.equal(
    passesHardGates(
      { id: 't1' },
      { threat: high, routinePhaseLabel: '', surfacingHistory: {}, now: NOW, stakesTier: 'external_obligation' },
    ),
    true,
  );
  assert.equal(
    passesHardGates(
      { id: 't1' },
      { threat: high, routinePhaseLabel: '', surfacingHistory: {}, now: NOW, stakesTier: 'personal_wellbeing' },
    ),
    false,
  );
});

test('passesHardGates: quiet routine phase blocks non-external', () => {
  assert.equal(
    passesHardGates(
      { id: 't1' },
      { threat: calm, routinePhaseLabel: 'sleep', surfacingHistory: {}, now: NOW, stakesTier: 'personal_wellbeing' },
    ),
    false,
  );
  assert.equal(
    passesHardGates(
      { id: 't1' },
      { threat: calm, routinePhaseLabel: 'sleep', surfacingHistory: {}, now: NOW, stakesTier: 'external_obligation' },
    ),
    true,
    'external_obligation breaks through quiet hours',
  );
  assert.equal(
    passesHardGates(
      { id: 't1' },
      { threat: calm, routinePhaseLabel: 'wind-down', surfacingHistory: {}, now: NOW, stakesTier: 'personal_wellbeing' },
    ),
    false,
    'wind-down also counts as quiet',
  );
});

test('passesHardGates: dedup window blocks recently-RAISED same-id, external bypasses', () => {
  const recent = { at: NOW - 60 * 60 * 1000, raised: true }; // raised 1h ago, inside 6h window
  assert.equal(
    passesHardGates(
      { id: 't1' },
      { threat: calm, routinePhaseLabel: '', surfacingHistory: { t1: recent }, now: NOW, stakesTier: 'personal_wellbeing' },
    ),
    false,
  );
  assert.equal(
    passesHardGates(
      { id: 't1' },
      { threat: calm, routinePhaseLabel: '', surfacingHistory: { t1: recent }, now: NOW, stakesTier: 'external_obligation' },
    ),
    true,
    'external bypasses dedup',
  );
  // Raised offer beyond the 6h window — re-eligible
  const old = { at: NOW - 12 * 60 * 60 * 1000, raised: true };
  assert.equal(
    passesHardGates(
      { id: 't1' },
      { threat: calm, routinePhaseLabel: '', surfacingHistory: { t1: old }, now: NOW, stakesTier: 'personal_wellbeing' },
    ),
    true,
  );
});

test('passesHardGates: un-raised offers get the SHORT window — silence never buys 6h', () => {
  // Offered 2h ago but never actually mentioned → past the 90min
  // unraised window → eligible again. Under the old single 6h window
  // this would have been suppressed.
  for (const raised of [false, null, undefined]) {
    assert.equal(
      passesHardGates(
        { id: 't1' },
        { threat: calm, routinePhaseLabel: '', surfacingHistory: { t1: { at: NOW - 2 * 60 * 60 * 1000, raised } }, now: NOW, stakesTier: 'personal_wellbeing' },
      ),
      true,
      `un-raised (raised=${raised}) past 90min must be re-eligible`,
    );
  }
  // Offered 30min ago, not raised → still inside the short window.
  assert.equal(
    passesHardGates(
      { id: 't1' },
      { threat: calm, routinePhaseLabel: '', surfacingHistory: { t1: { at: NOW - 30 * 60 * 1000, raised: false } }, now: NOW, stakesTier: 'personal_wellbeing' },
    ),
    false,
    'inside the 90min unraised window stays suppressed',
  );
  // Legacy plain-number history entry (pre-raised-tag events) → treated
  // as un-raised → short window.
  assert.equal(
    passesHardGates(
      { id: 't1' },
      { threat: calm, routinePhaseLabel: '', surfacingHistory: { t1: NOW - 2 * 60 * 60 * 1000 }, now: NOW, stakesTier: 'personal_wellbeing' },
    ),
    true,
    'legacy numeric entry gets the short window',
  );
});

test('passesHardGates: an active snooze blocks the task across tiers; expired snooze does not', () => {
  const future = new Date(NOW + 60 * 60 * 1000).toISOString();
  for (const tier of ['external_obligation', 'personal_wellbeing', 'purely_optional']) {
    assert.equal(
      passesHardGates(
        { id: 't1', payload: { snooze_until: future } },
        { threat: calm, routinePhaseLabel: '', surfacingHistory: {}, now: NOW, stakesTier: tier },
      ),
      false,
      `active snooze should block ${tier} (my human said not now)`,
    );
  }
  const past = new Date(NOW - 60 * 1000).toISOString();
  assert.equal(
    passesHardGates(
      { id: 't1', payload: { snooze_until: past } },
      { threat: calm, routinePhaseLabel: '', surfacingHistory: {}, now: NOW, stakesTier: 'personal_wellbeing' },
    ),
    true,
    'expired snooze must let the task surface again',
  );
});

// ── Candidate selection ────────────────────────────────────────────

test('selectSurfaceCandidates: returns nothing when no open tasks', async () => {
  const out = await selectSurfaceCandidates({
    openTasks: [], threat: calm, routinePhaseLabel: '', personModel: '', surfacingHistory: {}, now: NOW,
  });
  assert.deepEqual(out, []);
});

test('selectSurfaceCandidates: explicit payload stakes_tier overrides classifier', async () => {
  const out = await selectSurfaceCandidates({
    openTasks: [
      { id: 't1', label: 'finish chapter 3', type: 'task',
        payload: { stakes_tier: 'external_obligation' } },
    ],
    threat: high, // would block personal_wellbeing — proves stakes_tier override works
    routinePhaseLabel: '',
    personModel: '',
    surfacingHistory: {},
    now: NOW,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].stakesTier, 'external_obligation');
});

test('selectSurfaceCandidates: a FLOATING task ages from created_at (the bug fix)', async () => {
  // No `when` (floating), created 18 days ago. Before the fix, ageDays was
  // null and the task looked brand-new forever; now it carries real staleness.
  const created = new Date(NOW - 18 * 24 * 3600 * 1000).toISOString();
  const out = await selectSurfaceCandidates({
    openTasks: [{ id: 't1', label: 'file the housing form', type: 'task', created_at: created, payload: {} }],
    threat: calm, routinePhaseLabel: '', personModel: '', surfacingHistory: {}, now: NOW,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].floating, true, 'a task with no when is floating');
  assert.equal(out[0].ageDays, 18, 'age comes from created_at when there is no when');

  const block = formatSurfaceCandidatesBlock(out);
  assert.match(block, /\[floating — no time set\]/, 'block marks it floating');
  assert.match(block, /Floating for: 18d/, 'block shows how long it has drifted');
});

test('selectSurfaceCandidates: a scheduled task still ages from its when, not created_at', async () => {
  const when = new Date(NOW - 3 * 24 * 3600 * 1000).toISOString();      // 3 days ago
  const created = new Date(NOW - 30 * 24 * 3600 * 1000).toISOString();  // created 30 days ago
  const out = await selectSurfaceCandidates({
    openTasks: [{ id: 't1', label: 'pay rent', type: 'task', when, created_at: created,
                  payload: { stakes_tier: 'external_obligation' } }],
    threat: calm, routinePhaseLabel: '', personModel: '', surfacingHistory: {}, now: NOW,
  });
  assert.equal(out[0].floating, false);
  assert.equal(out[0].ageDays, 3, 'scheduled task ages from when, ignoring created_at');
});

test('selectSurfaceCandidates: caps at maxCandidates', async () => {
  const openTasks = Array.from({ length: 10 }, (_, i) => ({
    id: `t${i}`, label: `task ${i}`, type: 'task', payload: {},
  }));
  const out = await selectSurfaceCandidates({
    openTasks, threat: calm, routinePhaseLabel: '', personModel: '',
    surfacingHistory: {}, now: NOW, maxCandidates: 3,
  });
  assert.equal(out.length, 3);
});

test('selectSurfaceCandidates: confidence reflects available info', async () => {
  const out = await selectSurfaceCandidates({
    openTasks: [
      { id: 't1', label: 'eat lunch', type: 'task', payload: {} },
      { id: 't2', label: 'eat dinner', type: 'task',
        payload: { consequence_model: 'Eury crashes within 4h of skipping' } },
    ],
    threat: calm, routinePhaseLabel: '', personModel: '', surfacingHistory: {}, now: NOW,
  });
  assert.equal(out.length, 2);
  // t1: priors match, no person model, no task-specific → low
  assert.equal(out[0].confidence, 'low');
  // t2: task-specific present, no person model → medium
  assert.equal(out[1].confidence, 'medium');
});

test('selectSurfaceCandidates: confidence rises with person model present', async () => {
  const out = await selectSurfaceCandidates({
    openTasks: [
      { id: 't1', label: 'eat lunch', type: 'task',
        payload: { consequence_model: 'crashes within 4h' } },
    ],
    threat: calm,
    routinePhaseLabel: '',
    personModel: 'Skipping meals destabilises me within hours.',
    surfacingHistory: {}, now: NOW,
  });
  assert.equal(out[0].confidence, 'high');
});

// ── Block formatting ───────────────────────────────────────────────

test('formatSurfaceCandidatesBlock: empty list → empty string', () => {
  assert.equal(formatSurfaceCandidatesBlock([]), '');
  assert.equal(formatSurfaceCandidatesBlock(null), '');
});

test('formatSurfaceCandidatesBlock: includes label, framing, prompts probe on low confidence', () => {
  const block = formatSurfaceCandidatesBlock([
    {
      id: 't1', label: 'submit tax return', type: 'task',
      stakesTier: 'external_obligation',
      priorsBlock: 'paperwork:\n- Timescale: external\n- Stakes: external_obligation',
      personModel: '',
      taskSpecific: null,
      confidence: 'low',
      ageDays: 3,
    },
  ]);
  assert.match(block, /\[Surface candidates/);
  assert.match(block, /submit tax return/);
  assert.match(block, /external stakes/);
  assert.match(block, /Age: 3d/);
  assert.match(block, /confidence on the consequences here is low/);
  assert.match(block, /once, naturally, refusable/);
  // The id must be surfaced — schedule_assign_time / snooze / resolve are
  // addressed by id, so a candidate the Familiar can't identify is unactionable.
  assert.match(block, /id: t1/);
});

test('formatSurfaceCandidatesBlock: explicit green/red conditions, cost of silence named, no bias-toward-quiet', () => {
  const block = formatSurfaceCandidatesBlock([
    {
      id: 't1', label: 'eat lunch', type: 'task',
      stakesTier: 'personal_wellbeing', priorsBlock: '', personModel: '',
      taskSpecific: null, confidence: 'medium', ageDays: null,
    },
  ]);
  // Cost of silence named (CLAUDE.md proactivity rule 2). For an ADHD
  // ward the header is deliberately tuned toward action: it names the
  // cost of intrusion via the RED LIGHT list, and the cost of silence
  // as the task that waits forever.
  assert.match(block, /the task waits forever/i, 'cost of silence must be named');
  assert.match(block, /a missed task costs .* more than a check-in they can wave off/i,
    'silence outweighing a refusable check-in must be explicit');
  // Explicit inclusion + exclusion conditions, so the servile-default
  // model can't read vagueness as "better stay quiet" (rule 1 + the
  // recorded servile-default failure).
  assert.match(block, /GREEN LIGHT/);
  assert.match(block, /RED LIGHT/);
  // Identity framing, not permission framing (rule 4).
  assert.match(block, /mine to act on/i);
  // Regression guard: the bias-toward-quiet language that shipped once
  // (and mirrors the recorded 1.5h-silence failure) must never return.
  assert.doesNotMatch(block, /None of these need to be mentioned|let them rest|bias toward (staying )?quiet|only .{0,40}when the answer feels obvious|err on the side of not/i);
});

test('CONSEQUENCE & PLANNING block: both futures + predict-then-learn, no bias-toward-quiet', () => {
  const block = formatSurfaceCandidatesBlock([
    { id: 't1', label: 'x', type: 'task', stakesTier: 'personal_wellbeing',
      priorsBlock: '', personModel: '', taskSpecific: null, confidence: 'medium', ageDays: null },
  ]);
  assert.match(block, /CONSEQUENCE & PLANNING/);
  assert.match(block, /resolving/);          // the motivating future
  assert.match(block, /failing-to-resolve/);  // the cost future
  assert.match(block, /which future I called right|adjust what I believe|learn .* real patterns/i); // predict→learn
  // Honesty about projections, and no bias-toward-quiet creeping in here either.
  assert.match(block, /projection is a projection|hold a low-certainty hunch lightly/i);
  assert.doesNotMatch(block, /bias toward (staying )?quiet|err on the side of not|only .{0,40}when the answer feels obvious/i);
});

test('selectSurfaceCandidates: a task an imminent node requires gets a consequence reason + pressure', async () => {
  const imminent = new Date(NOW + 6 * 3600 * 1000).toISOString(); // 6h out → imminent
  const out = await selectSurfaceCandidates({
    openTasks: [{ id: 'prep', label: 'interview prep', type: 'task' }],
    threat: calm, routinePhaseLabel: '', personModel: '', surfacingHistory: {}, now: NOW,
    edges: [{ id: 'e', src: 'prep', dst: 'iv', kind: 'requires' }],
    scheduleNodes: [
      { id: 'prep', label: 'interview prep', type: 'task' },
      { id: 'iv', label: 'interview', type: 'event', when: imminent },
    ],
  });
  assert.equal(out.length, 1);
  assert.ok(out[0].consequencePressure >= 3, 'imminent dependent → pressure');
  assert.match(out[0].consequenceReasons.join(' '), /unblocks|needs this done first/i);
  // And it surfaces in the rendered block.
  assert.match(formatSurfaceCandidatesBlock(out), /Hangs off this —/);
});

test('selectSurfaceCandidates: an on_lapse harm consequence renders honestly (certainty shown)', async () => {
  const out = await selectSurfaceCandidates({
    openTasks: [{ id: 'din', label: 'dinner', type: 'task' }],
    threat: calm, routinePhaseLabel: '', personModel: '', surfacingHistory: {}, now: NOW,
    edges: [{ id: 'e', src: 'din', dst: 'crash', kind: 'causes',
      payload: { condition: 'on_lapse', valence: 'harm', certainty: 'high', horizon_hours: 4, severity: 'high' } }],
    scheduleNodes: [{ id: 'crash', label: 'crash', type: 'state', when: new Date(NOW).toISOString() }],
  });
  const reason = out[0].consequenceReasons.join(' ');
  assert.match(reason, /skipping this tends to cause crash/i);
  assert.match(reason, /high certainty/i); // projection wears its confidence
});

test('selectSurfaceCandidates: consequence pressure floats a task above the per-turn cap', async () => {
  // 4 plain tasks + 1 with an imminent dependent; cap at 2 → the
  // high-pressure one must survive the cut.
  const imminent = new Date(NOW + 3 * 3600 * 1000).toISOString();
  const openTasks = [
    { id: 'a', label: 'a', type: 'task' }, { id: 'b', label: 'b', type: 'task' },
    { id: 'c', label: 'c', type: 'task' }, { id: 'd', label: 'd', type: 'task' },
    { id: 'lever', label: 'lever', type: 'task' },
  ];
  const out = await selectSurfaceCandidates({
    openTasks, threat: calm, routinePhaseLabel: '', personModel: '', surfacingHistory: {}, now: NOW,
    maxCandidates: 2,
    edges: [{ id: 'e', src: 'lever', dst: 'iv', kind: 'blocks' }],
    scheduleNodes: [...openTasks, { id: 'iv', label: 'interview', type: 'event', when: imminent }],
  });
  assert.equal(out.length, 2);
  assert.ok(out.some(c => c.id === 'lever'), 'the consequence-bearing task survived the cap');
});

test('formatSurfaceCandidatesBlock: high-confidence omits the probe nudge', () => {
  const block = formatSurfaceCandidatesBlock([
    {
      id: 't1', label: 'eat lunch', type: 'task',
      stakesTier: 'personal_wellbeing',
      priorsBlock: '',
      personModel: 'Eury crashes within 4h of skipping meals.',
      taskSpecific: 'low blood sugar → mood crash',
      confidence: 'high',
      ageDays: null,
    },
  ]);
  assert.doesNotMatch(block, /confidence on the consequences here is low/);
  assert.match(block, /Eury crashes within 4h/);
});
