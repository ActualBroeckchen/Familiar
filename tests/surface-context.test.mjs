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

test('passesHardGates: dedup window blocks recent same-id, external bypasses', () => {
  const recentMs = NOW - 60 * 60 * 1000; // 1h ago, inside 6h window
  assert.equal(
    passesHardGates(
      { id: 't1' },
      { threat: calm, routinePhaseLabel: '', surfacingHistory: { t1: recentMs }, now: NOW, stakesTier: 'personal_wellbeing' },
    ),
    false,
  );
  assert.equal(
    passesHardGates(
      { id: 't1' },
      { threat: calm, routinePhaseLabel: '', surfacingHistory: { t1: recentMs }, now: NOW, stakesTier: 'external_obligation' },
    ),
    true,
    'external bypasses dedup',
  );
  // Old offer beyond window — re-eligible
  const oldMs = NOW - 12 * 60 * 60 * 1000;
  assert.equal(
    passesHardGates(
      { id: 't1' },
      { threat: calm, routinePhaseLabel: '', surfacingHistory: { t1: oldMs }, now: NOW, stakesTier: 'personal_wellbeing' },
    ),
    true,
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
