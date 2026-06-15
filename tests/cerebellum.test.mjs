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
  for (const expected of ['get_datetime', 'save_to_tome', 'save_memory', 'schedule_add_reminder', 'contact_trusted_person', 'show_crisis_resources',
    // Graph creation + on-demand memory recall — the Familiar can now build
    // graph structure (not just edit/delete) and look up its own entries.
    'create_graph_node', 'create_graph_edge', 'list_memories', 'read_memory']) {
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

// ── Channel adapters + delivery records ──────────────────────────

import {
  dispatchOutboxPush,
  enqueueAndDispatch,
  activePushAdapters,
  formatDeliveryNote,
  contactDeadlineFor,
  DISPATCH_GRACE_MS,
} from '../cerebellum.js';

test('dispatchOutboxPush records per-adapter outcomes; a failing adapter never blocks the next one', async () => {
  const metas = [];
  const { delivery } = await dispatchOutboxPush(
    { id: 'i1', kind: 'triage', title: 't', body: 'b' },
    {
      adapters: [
        { name: 'broken',     deliver: async () => { throw new Error('boom'); } },
        { name: 'discord-dm', deliver: async () => ({ ok: true }) },
      ],
      updateMetaFn: async ({ id, meta }) => { metas.push([id, meta]); },
      now: () => 1_000,
    },
  );
  assert.equal(delivery.broken.status, 'failed');
  assert.match(delivery.broken.error, /boom/);
  assert.equal(delivery['discord-dm'].status, 'delivered');
  // The outcome is persisted on the item — the observable record.
  assert.equal(metas.length, 1);
  assert.equal(metas[0][0], 'i1');
  assert.deepEqual(Object.keys(metas[0][1].delivery).sort(), ['broken', 'discord-dm']);
});

test('dispatchOutboxPush with no adapters is a quiet no-op', async () => {
  const { delivery } = await dispatchOutboxPush(
    { id: 'i1', kind: 'reminder', title: 't' },
    { adapters: [], updateMetaFn: async () => { throw new Error('should not be called'); } },
  );
  assert.equal(delivery, null);
});

test('activePushAdapters: discord-dm appears only when userDiscordWebhook is set', () => {
  assert.equal(activePushAdapters({ readSettings: () => ({}) }).length, 0);
  assert.equal(activePushAdapters({ readSettings: () => ({ userDiscordWebhook: '   ' }) }).length, 0);
  const a = activePushAdapters({ readSettings: () => ({ userDiscordWebhook: 'https://discord.test/me' }) });
  assert.equal(a.length, 1);
  assert.equal(a[0].name, 'discord-dm');
});

test('the discord-dm adapter posts the item to the user webhook', async () => {
  const calls = [];
  const [adapter] = activePushAdapters({
    readSettings: () => ({ userDiscordWebhook: 'https://discord.test/me' }),
    fetchFn: async (url, opts) => { calls.push([url, JSON.parse(opts.body)]); return { ok: true }; },
  });
  const r = await adapter.deliver({ kind: 'reminder', title: 'water the plants', body: 'they are thirsty' });
  assert.equal(r.ok, true);
  assert.equal(calls[0][0], 'https://discord.test/me');
  assert.match(calls[0][1].content, /water the plants/);
  assert.match(calls[0][1].content, /they are thirsty/);
  // Never ping roles/users from a webhook push.
  assert.deepEqual(calls[0][1].allowed_mentions, { parse: [] });
});

test('formatDeliveryNote covers delivered / failed / none-configured / pending', () => {
  assert.match(formatDeliveryNote({ delivery: { 'discord-dm': { status: 'delivered', at: 'x' } } }), /delivered to my human's Discord/);
  const failed = formatDeliveryNote({ delivery: { 'discord-dm': { status: 'failed', at: 'x', error: 'discord 404' } } });
  assert.match(failed, /FAILED/);
  assert.match(failed, /discord 404/);
  assert.match(formatDeliveryNote({}, { hasPushChannel: false }), /no push channel configured/);
  assert.match(formatDeliveryNote({}, { hasPushChannel: true }), /pending/);
});

// ── Escalation deadline from confirmed delivery ──────────────────

const T0 = Date.parse('2026-06-11T12:00:00Z');

function newStyleItem(overrides = {}) {
  return {
    id:   'n1',
    kind: 'triage',
    ts:   new Date(T0).toISOString(),
    pendingContact: { name: 'Sam', message: 'm', channel: 'discord' },
    contactDelayMs: 30 * 60_000,
    ...overrides,
  };
}

test('contactDeadlineFor: clock starts at confirmed push delivery, not enqueue', () => {
  const deliveredAt = T0 + 10 * 60_000; // pushed 10 min after enqueue
  const item = newStyleItem({ delivery: { 'discord-dm': { status: 'delivered', at: new Date(deliveredAt).toISOString() } } });
  assert.equal(contactDeadlineFor(item, { pushConfigured: true }), deliveredAt + 30 * 60_000);
});

test('contactDeadlineFor: failed push falls back to the enqueue clock', () => {
  const item = newStyleItem({ delivery: { 'discord-dm': { status: 'failed', at: 'x', error: 'e' } } });
  assert.equal(contactDeadlineFor(item, { pushConfigured: true }), T0 + 30 * 60_000);
});

test('contactDeadlineFor: no push channel configured falls back to the enqueue clock', () => {
  assert.equal(contactDeadlineFor(newStyleItem(), { pushConfigured: false }), T0 + 30 * 60_000);
});

test('contactDeadlineFor: push pending inside the grace window holds the clock; after grace it falls back', () => {
  const item = newStyleItem(); // push configured, no delivery record yet
  assert.equal(contactDeadlineFor(item, { pushConfigured: true, now: () => T0 + 60_000 }), null);
  assert.equal(
    contactDeadlineFor(item, { pushConfigured: true, now: () => T0 + DISPATCH_GRACE_MS + 1 }),
    T0 + 30 * 60_000,
  );
});

test('contactDeadlineFor: pre-0.5.0 items with precomputed contactDeadlineTs are honored as-is', () => {
  const item = newStyleItem({ contactDelayMs: undefined, contactDeadlineTs: 123_456 });
  assert.equal(contactDeadlineFor(item, { pushConfigured: true }), 123_456);
});

test('checkAndFirePendingContacts honors the delivered-at clock end-to-end', async () => {
  const deliveredAt = T0 + 10 * 60_000;
  const item = newStyleItem({ delivery: { 'discord-dm': { status: 'delivered', at: new Date(deliveredAt).toISOString() } } });
  const deliveries = [];
  // 35 min after enqueue = 25 min after delivery: NOT yet expired
  let r = await checkAndFirePendingContacts({
    now: () => T0 + 35 * 60_000,
    listOutboxFn:       async () => [item],
    updateOutboxMetaFn: async () => {},
    deliverFn:          async (a) => { deliveries.push(a); return { ok: true }; },
    hasPushChannel:     () => true,
  });
  assert.equal(r.fired, 0);
  // 41 min after enqueue = 31 min after delivery: expired
  r = await checkAndFirePendingContacts({
    now: () => T0 + 41 * 60_000,
    listOutboxFn:       async () => [item],
    updateOutboxMetaFn: async () => {},
    deliverFn:          async (a) => { deliveries.push(a); return { ok: true }; },
    hasPushChannel:     () => true,
  });
  assert.equal(r.fired, 1);
  assert.equal(deliveries.length, 1);
});

test('enqueueAndDispatch: dedup short-circuits the push', async () => {
  // Same (kind, originId) twice — second enqueue dedups, so the adapter
  // must run exactly once. Uses a temp outbox dir via the real enqueue.
  const { mkdtempSync, rmSync } = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cereb-dispatch-'));
  let pushes = 0;
  const deps = {
    adapters: [{ name: 'discord-dm', deliver: async () => { pushes++; return { ok: true }; } }],
    updateMetaFn: async () => {},
  };
  try {
    await enqueueAndDispatch({ kind: 'reminder', originId: 'r1', title: 'x', tomesDir: dir }, deps);
    await enqueueAndDispatch({ kind: 'reminder', originId: 'r1', title: 'x', tomesDir: dir }, deps);
    assert.equal(pushes, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── parseMemoryKey — composite significant-memory keys ───────────

import { parseMemoryKey, TOOL_EXECUTORS as EXECS } from '../cerebellum.js';

test('parseMemoryKey: plain dates pass through for every granularity shape', () => {
  assert.deepEqual(parseMemoryKey('2026-06-11'), { date: '2026-06-11', slug: null });
  assert.deepEqual(parseMemoryKey('2026-06'),    { date: '2026-06',    slug: null });
  assert.deepEqual(parseMemoryKey('2026'),       { date: '2026',       slug: null });
  assert.deepEqual(parseMemoryKey('2026-W24'),   { date: '2026-W24',   slug: null });
});

test('parseMemoryKey: splits the composite significant key into date + slug', () => {
  assert.deepEqual(
    parseMemoryKey('2026-06-11_why-melian-trusts-me'),
    { date: '2026-06-11', slug: 'why-melian-trusts-me' },
  );
  // Slugs may themselves contain underscores — split happens at the FIRST one.
  assert.deepEqual(
    parseMemoryKey('2026-06-11_a_b_c'),
    { date: '2026-06-11', slug: 'a_b_c' },
  );
});

test('parseMemoryKey: rejects junk, empty slugs, and path-smuggling keys', () => {
  assert.equal(parseMemoryKey('garbage'), null);
  assert.equal(parseMemoryKey(''), null);
  assert.equal(parseMemoryKey(undefined), null);
  assert.equal(parseMemoryKey('2026-06-11_'), null);            // empty slug
  assert.equal(parseMemoryKey('2026-06-11_../escape'), null);   // dot segments
  assert.equal(parseMemoryKey('2026-06-11_a/b'), null);         // slashes
  assert.equal(parseMemoryKey('2026-06-11_.hidden'), null);     // leading dot
});

test('update_memory / delete_memory executors reject malformed keys with a readable hint', async () => {
  const upd = await EXECS.update_memory({ granularity: 'significant', date: 'not-a-date', content: 'x' });
  assert.match(upd, /invalid date format .*YYYY-MM-DD_slug/);
  const del = await EXECS.delete_memory({ granularity: 'significant', date: '2026-06-11_a/b' });
  assert.match(del, /invalid date format .*YYYY-MM-DD_slug/);
});

test('new graph/memory executors validate input before touching Phylactery', async () => {
  // These guards run before any MCP call, so they return their hint even
  // with Phylactery absent (the test env has no peer connected).
  assert.match(await EXECS.create_graph_node({}), /label \(string\) is required/);
  assert.match(await EXECS.create_graph_edge({ fromId: 'a', toId: 'b' }), /fromId, toId, and type are all required/);
  assert.match(await EXECS.create_graph_edge({ fromId: 'a', toId: 'b', type: 'x', weight: 2 }), /weight must be a number in \[0, 1\]/);
  assert.match(await EXECS.read_memory({ granularity: 'bogus', date: '2026-06-11' }), /invalid granularity/);
  assert.match(await EXECS.read_memory({ granularity: 'daily', date: 'not-a-date' }), /invalid date format/);
  assert.match(await EXECS.list_memories({ granularity: 'bogus' }), /invalid granularity/);
});
