// Warm reach-out loop — the gates, routing, and delivery of runOneReachoutTick.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { runOneReachoutTick, resetReachoutCooldown } from '../reachout-loop.js';

beforeEach(() => resetReachoutCooldown());

// A baseline set of injected deps; individual tests override what they need.
function deps(overrides = {}) {
  return {
    getThreat:        async () => ({ tier: 'calm', weight: 0, disabled: false }),
    getLastActivity:  async () => ({ ts: new Date().toISOString(), ms: Date.now() - 3 * 3600_000 }),
    getPendingTells:  async () => [],
    getWarmVillagers: async () => [],
    isQuietHours:     async () => false,
    decideReachout:   async () => ({ action: 'wait', nextCheckInMs: 7200000 }),
    deliverWardKnock: async () => ({ ok: true }),
    deliverVillagerReach: async () => ({ ok: true }),
    now: Date.now,
    ...overrides,
  };
}

// ── Crisis-defer gate ───────────────────────────────────────────────

for (const tier of ['moderate', 'high', 'severe']) {
  test(`crisis-defer: stands down at ${tier} threat (triage owns it)`, async () => {
    let deliberated = false;
    const r = await runOneReachoutTick(deps({
      getThreat: async () => ({ tier, weight: 5, disabled: false }),
      decideReachout: async () => { deliberated = true; return { action: 'wait' }; },
    }));
    assert.equal(r.acted, false);
    assert.equal(r.reason, 'crisis_defer');
    assert.equal(deliberated, false, 'no LLM deliberation when deferring to triage');
  });
}

test('crisis-defer: proceeds at calm/mild, and when the detector is disabled', async () => {
  for (const threat of [{ tier: 'calm', disabled: false }, { tier: 'mild', disabled: false }, { tier: 'severe', disabled: true }]) {
    resetReachoutCooldown();
    let deliberated = false;
    await runOneReachoutTick(deps({
      getThreat: async () => threat,
      decideReachout: async () => { deliberated = true; return { action: 'wait' }; },
    }));
    assert.equal(deliberated, true, `deliberates for ${JSON.stringify(threat)}`);
  }
});

// ── Quiet hours ─────────────────────────────────────────────────────

test('quiet hours: skips without deliberating', async () => {
  let deliberated = false;
  const r = await runOneReachoutTick(deps({
    isQuietHours: async () => true,
    decideReachout: async () => { deliberated = true; return { action: 'wait' }; },
  }));
  assert.equal(r.reason, 'quiet_hours');
  assert.equal(deliberated, false);
});

// ── Cooldown ────────────────────────────────────────────────────────

test('cooldown: a second tick within the window is suppressed', async () => {
  const d = deps({ decideReachout: async () => ({ action: 'wait', nextCheckInMs: 3600_000 }) });
  const first = await runOneReachoutTick(d);
  assert.equal(first.reason, 'llm_said_wait');
  const second = await runOneReachoutTick(d);
  assert.equal(second.reason, 'in_cooldown');
});

// ── Ward knock ──────────────────────────────────────────────────────

test('ward knock: delivers and reports reached_ward', async () => {
  const sent = [];
  const r = await runOneReachoutTick(deps({
    decideReachout: async () => ({ action: 'reach_out', target: 'ward', message: 'thinking of you' }),
    deliverWardKnock: async (a) => { sent.push(a); return { ok: true }; },
  }));
  assert.equal(r.acted, true);
  assert.equal(r.reason, 'reached_ward');
  assert.equal(sent[0].message, 'thinking of you');
});

test('ward knock: passes the tell handle through so it can be marked', async () => {
  let received;
  await runOneReachoutTick(deps({
    decideReachout: async () => ({ action: 'reach_out', target: 'ward', message: 'how did the interview go?', tellUid: 'u1', tellIndex: 0 }),
    deliverWardKnock: async (a) => { received = a; return { ok: true }; },
  }));
  assert.deepEqual(received.tell, { uid: 'u1', index: 0 });
});

test('ward knock: dedup reports rate_limited, not acted', async () => {
  const r = await runOneReachoutTick(deps({
    decideReachout: async () => ({ action: 'reach_out', target: 'ward', message: 'hi' }),
    deliverWardKnock: async () => ({ ok: true, deduped: true }),
  }));
  assert.equal(r.acted, false);
  assert.equal(r.reason, 'rate_limited');
});

// ── Villager reach ──────────────────────────────────────────────────

test('villager reach: delivers to a warm villager named by id', async () => {
  const sent = [];
  const r = await runOneReachoutTick(deps({
    getWarmVillagers: async () => [{ id: 'v1', name: 'Chen', discordId: '111' }],
    decideReachout: async () => ({ action: 'reach_out', target: 'villager', villagerId: 'v1', message: 'hey Chen!' }),
    deliverVillagerReach: async (a) => { sent.push(a); return { ok: true }; },
  }));
  assert.equal(r.acted, true);
  assert.equal(r.reason, 'reached_villager');
  assert.equal(sent[0].villager.id, 'v1');
  assert.equal(sent[0].message, 'hey Chen!');
});

test('villager reach: an id not on the warm list is refused, no send', async () => {
  let sends = 0;
  const r = await runOneReachoutTick(deps({
    getWarmVillagers: async () => [{ id: 'v1', name: 'Chen', discordId: '111' }],
    decideReachout: async () => ({ action: 'reach_out', target: 'villager', villagerId: 'v-ghost', message: 'hi' }),
    deliverVillagerReach: async () => { sends++; return { ok: true }; },
  }));
  assert.equal(r.reason, 'unknown_villager');
  assert.equal(sends, 0);
});

test('villager reach: a failed delivery reports delivery_failed', async () => {
  const r = await runOneReachoutTick(deps({
    getWarmVillagers: async () => [{ id: 'v1', name: 'Chen', discordId: '111' }],
    decideReachout: async () => ({ action: 'reach_out', target: 'villager', villagerId: 'v1', message: 'hi' }),
    deliverVillagerReach: async () => ({ ok: false, error: 'discord down' }),
  }));
  assert.equal(r.acted, false);
  assert.equal(r.reason, 'delivery_failed');
  assert.equal(r.error, 'discord down');
});

// ── Required deps ───────────────────────────────────────────────────

test('runOneReachoutTick: missing required dep throws a readable error', async () => {
  await assert.rejects(
    () => runOneReachoutTick({ getThreat: async () => ({ tier: 'calm' }) }),
    /is required/,
  );
});
