import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkAndFirePendingContacts,
  deliverToTrustedContact,
  CONTACT_ESCALATION_DELAY_MS,
} from '../cerebellum.js';

// ── checkAndFirePendingContacts — escalation deadlines ───────────
// All I/O injected: a fake outbox list, a meta recorder, a delivery
// recorder, and a fixed clock. No real settings / webhooks / files.

function triageItem(overrides = {}) {
  return {
    id:   'item-1',
    kind: 'triage',
    acknowledged: false,
    pendingContact: { name: 'Sam', message: 'please check on them', channel: 'discord' },
    contactDeadlineTs: 1_000_000,
    ...overrides,
  };
}

test('fires exactly one delivery once the deadline passes, marking delivered BEFORE the async fire', async () => {
  const events = [];
  const item = triageItem();
  const r = await checkAndFirePendingContacts({
    now: () => 1_000_001,                       // 1ms past deadline
    listOutboxFn:       async () => [item],
    updateOutboxMetaFn: async ({ id, meta }) => { events.push(['meta', id, meta]); },
    deliverFn:          async (args) => { events.push(['deliver', args]); return { ok: true }; },
  });
  assert.equal(r.fired, 1);
  // The double-delivery guard: pendingContact.delivered=true is written
  // before deliverFn runs.
  assert.equal(events[0][0], 'meta');
  assert.equal(events[0][2].pendingContact.delivered, true);
  assert.ok(events[0][2].pendingContact.deliveredAt);
  const deliverEvents = events.filter(e => e[0] === 'deliver');
  assert.equal(deliverEvents.length, 1);
  assert.deepEqual(deliverEvents[0][1], { name: 'Sam', message: 'please check on them', channel: 'discord' });
});

test('does NOT fire before the deadline', async () => {
  const deliveries = [];
  const r = await checkAndFirePendingContacts({
    now: () => 999_999,                         // 1ms before deadline
    listOutboxFn:       async () => [triageItem()],
    updateOutboxMetaFn: async () => { throw new Error('should not be called'); },
    deliverFn:          async (args) => { deliveries.push(args); return { ok: true }; },
  });
  assert.equal(r.fired, 0);
  assert.equal(deliveries.length, 0);
});

test('an acknowledged item never escalates (pendingOnly list excludes it)', async () => {
  // The pendingOnly outbox read is the acknowledgement veto: an acked
  // item simply never appears in the candidate list. Model that here —
  // the list is empty because the user acknowledged in time.
  const deliveries = [];
  const r = await checkAndFirePendingContacts({
    now: () => 5_000_000,
    listOutboxFn:       async () => [],
    updateOutboxMetaFn: async () => {},
    deliverFn:          async (args) => { deliveries.push(args); return { ok: true }; },
  });
  assert.equal(r.fired, 0);
  assert.equal(deliveries.length, 0);
});

test('an item already marked delivered does not re-fire', async () => {
  const deliveries = [];
  const item = triageItem({ pendingContact: { name: 'Sam', message: 'm', channel: 'discord', delivered: true } });
  const r = await checkAndFirePendingContacts({
    now: () => 5_000_000,
    listOutboxFn:       async () => [item],
    updateOutboxMetaFn: async () => {},
    deliverFn:          async (args) => { deliveries.push(args); return { ok: true }; },
  });
  assert.equal(r.fired, 0);
  assert.equal(deliveries.length, 0);
});

test('non-triage and no-pendingContact items are ignored', async () => {
  const deliveries = [];
  const r = await checkAndFirePendingContacts({
    now: () => 5_000_000,
    listOutboxFn: async () => [
      triageItem({ id: 'a', kind: 'reminder' }),
      triageItem({ id: 'b', pendingContact: undefined }),
    ],
    updateOutboxMetaFn: async () => {},
    deliverFn:          async (args) => { deliveries.push(args); return { ok: true }; },
  });
  assert.equal(r.fired, 0);
  assert.equal(deliveries.length, 0);
});

// ── deliverToTrustedContact — "no covert contact" invariant ──────

const SETTINGS = { trustedContacts: [{ name: 'Sam', channel: 'discord', webhook: 'https://discord.test/hook' }] };

test('successful delivery mirrors an outbound_alert to the outbox', async () => {
  const enqueued = [];
  const r = await deliverToTrustedContact({
    name: 'Sam', message: 'checking in', channel: 'discord',
    readSettings:    () => SETTINGS,
    fetchFn:         async () => ({ ok: true }),
    enqueueOutboxFn: async (item) => { enqueued.push(item); return { id: 'x' }; },
  });
  assert.equal(r.ok, true);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].kind, 'outbound_alert');
  assert.match(enqueued[0].title, /Reached out to Sam/);
  assert.match(enqueued[0].body, /checking in/);
});

test('FAILED delivery still mirrors to the outbox, with the error visible', async () => {
  const enqueued = [];
  const r = await deliverToTrustedContact({
    name: 'Sam', message: 'checking in', channel: 'discord',
    readSettings:    () => SETTINGS,
    fetchFn:         async () => ({ ok: false, status: 404, text: async () => 'unknown webhook' }),
    enqueueOutboxFn: async (item) => { enqueued.push(item); return { id: 'x' }; },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /404/);
  assert.equal(enqueued.length, 1);
  assert.match(enqueued[0].title, /delivery failed/);
  assert.match(enqueued[0].body, /unknown webhook/);
});

test('a thrown network error still mirrors to the outbox', async () => {
  const enqueued = [];
  const r = await deliverToTrustedContact({
    name: 'Sam', message: 'checking in', channel: 'discord',
    readSettings:    () => SETTINGS,
    fetchFn:         async () => { throw new Error('ECONNREFUSED'); },
    enqueueOutboxFn: async (item) => { enqueued.push(item); return { id: 'x' }; },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNREFUSED/);
  assert.equal(enqueued.length, 1);
  assert.match(enqueued[0].title, /delivery failed/);
});

test('unknown contact returns contact_not_found without calling the webhook', async () => {
  let fetched = false;
  const r = await deliverToTrustedContact({
    name: 'Nobody', message: 'hi', channel: 'discord',
    readSettings:    () => SETTINGS,
    fetchFn:         async () => { fetched = true; return { ok: true }; },
    enqueueOutboxFn: async () => ({ id: 'x' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'contact_not_found');
  assert.equal(fetched, false);
});

// ── Escalation delay table sanity ────────────────────────────────

test('CONTACT_ESCALATION_DELAY_MS keeps severe shorter than high shorter than moderate', () => {
  assert.ok(CONTACT_ESCALATION_DELAY_MS.severe < CONTACT_ESCALATION_DELAY_MS.high);
  assert.ok(CONTACT_ESCALATION_DELAY_MS.high   < CONTACT_ESCALATION_DELAY_MS.moderate);
});

// ── Tool dispatch ────────────────────────────────────────────────

import {
  BUILTIN_TOOLS,
  TOOL_EXECUTORS,
  executeToolCall,
  composeActiveTools,
  runToolCallLoop,
  MAX_TOOL_ROUNDS,
} from '../cerebellum.js';

test('BUILTIN_TOOLS carries the full registry in OpenAI function format', () => {
  assert.ok(BUILTIN_TOOLS.length >= 20);
  for (const t of BUILTIN_TOOLS) {
    assert.equal(t.type, 'function');
    assert.equal(typeof t.function.name, 'string');
    assert.equal(typeof t.function.description, 'string');
  }
  const names = BUILTIN_TOOLS.map(t => t.function.name);
  for (const expected of ['get_datetime', 'save_to_tome', 'save_memory', 'schedule_add_reminder', 'contact_trusted_person', 'show_crisis_resources']) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
  // Every advertised built-in has an executor, and vice versa.
  for (const n of names) assert.ok(n in TOOL_EXECUTORS, `no executor for ${n}`);
  for (const n of Object.keys(TOOL_EXECUTORS)) assert.ok(names.includes(n), `executor ${n} not advertised`);
});

test('composeActiveTools appends custom tool objects after the built-ins', () => {
  const custom = [{ type: 'function', function: { name: 'my_tool', description: 'x', parameters: {} } }];
  const tools = composeActiveTools(custom);
  assert.equal(tools.length, BUILTIN_TOOLS.length + 1);
  assert.equal(tools.at(-1).function.name, 'my_tool');
  // Non-arrays and junk entries are ignored, never thrown on.
  assert.equal(composeActiveTools(undefined).length, BUILTIN_TOOLS.length);
  assert.equal(composeActiveTools([null, 'junk']).length, BUILTIN_TOOLS.length);
});

test('executeToolCall: unknown / custom tool returns advertise-only notice, not a throw', async () => {
  const out = await executeToolCall('my_custom_tool', '{}');
  assert.match(out, /advertised but has no implementation yet/);
});

test('executeToolCall: malformed JSON args produce a structured failure into the loop', async () => {
  const out = await executeToolCall('get_datetime', '{not json');
  assert.match(out, /^Error executing get_datetime: /);
});

test('executeToolCall: a throwing executor produces a structured failure, not an exception', async () => {
  TOOL_EXECUTORS.__test_throw = () => { throw new Error('peer is down'); };
  try {
    const out = await executeToolCall('__test_throw', '{}');
    assert.equal(out, 'Error executing __test_throw: peer is down');
  } finally {
    delete TOOL_EXECUTORS.__test_throw;
  }
});

test('get_session_info renders ctx.sessionInfo and degrades to nulls without it', async () => {
  const withCtx = JSON.parse(await executeToolCall('get_session_info', '{}', {
    sessionInfo: { startedAt: 't0', messageCount: 7, provider: 'zai', model: 'm', elapsedMsSinceLastMessage: 123 },
  }));
  assert.equal(withCtx.messageCount, 7);
  assert.equal(withCtx.elapsedMsSinceLastMessage, 123);
  const bare = JSON.parse(await executeToolCall('get_session_info', '{}'));
  assert.equal(bare.messageCount, null);
});

// ── runToolCallLoop ──────────────────────────────────────────────

function toolCallResponse(name, args = '{}') {
  return {
    choices: [{
      finish_reason: 'tool_calls',
      message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: args } }] },
    }],
  };
}
const finalResponse = { choices: [{ finish_reason: 'stop', message: { content: 'done' } }] };

test('runToolCallLoop: executes tools and feeds results into the next round', async () => {
  const upstreamCalls = [];
  let round = 0;
  const { data, toolRounds } = await runToolCallLoop({
    callUpstream: async (msgs) => {
      upstreamCalls.push(msgs);
      return round++ === 0 ? toolCallResponse('fake_tool') : finalResponse;
    },
    baseMessages: [{ role: 'user', content: 'hi' }],
    executeTool:  async (name) => `result of ${name}`,
  });
  assert.equal(data.choices[0].message.content, 'done');
  assert.equal(toolRounds.length, 1);
  assert.equal(toolRounds[0].results[0].content, 'result of fake_tool');
  // Round 2's messages include the assistant tool_calls turn + the tool result.
  const second = upstreamCalls[1];
  assert.equal(second.at(-2).role, 'assistant');
  assert.ok(Array.isArray(second.at(-2).tool_calls));
  assert.equal(second.at(-1).role, 'tool');
  assert.equal(second.at(-1).content, 'result of fake_tool');
});

test('runToolCallLoop: caps at maxRounds even if the model keeps calling tools', async () => {
  let calls = 0;
  const { toolRounds } = await runToolCallLoop({
    callUpstream: async () => { calls++; return toolCallResponse('fake_tool'); },
    baseMessages: [{ role: 'user', content: 'hi' }],
    executeTool:  async () => 'r',
  });
  assert.equal(calls, MAX_TOOL_ROUNDS + 1);     // initial + one per executed round
  assert.equal(toolRounds.length, MAX_TOOL_ROUNDS);
});

test('runToolCallLoop: re-appends the time anchor as the LAST message every round', async () => {
  const seen = [];
  let round = 0;
  await runToolCallLoop({
    callUpstream: async (msgs) => { seen.push(msgs.at(-1)); return round++ === 0 ? toolCallResponse('t') : finalResponse; },
    baseMessages: [{ role: 'user', content: 'hi' }],
    timeAnchor:   '[Now] it is teatime',
    executeTool:  async () => 'r',
  });
  assert.equal(seen.length, 2);
  for (const last of seen) {
    assert.equal(last.role, 'system');
    assert.equal(last.content, '[Now] it is teatime');
  }
});

test('runToolCallLoop: no tool calls means a single round and no toolRounds', async () => {
  let calls = 0;
  const { data, toolRounds } = await runToolCallLoop({
    callUpstream: async () => { calls++; return finalResponse; },
    baseMessages: [{ role: 'user', content: 'hi' }],
    executeTool:  async () => { throw new Error('should not run'); },
  });
  assert.equal(calls, 1);
  assert.equal(toolRounds.length, 0);
  assert.equal(data.choices[0].message.content, 'done');
});
