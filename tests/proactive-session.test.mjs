// Proactive messages (reminders, "a thought from me", alerts, triage check-ins)
// must land in the unified ward session, so the Familiar knows it said them and a
// Discord DM reply isn't context-less.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendWardProactiveTurn, isWardConversationalKind, WARD_CONVERSATIONAL_KINDS,
} from '../src/sessions/proactive-session.js';
import { getSessionBinding, WARD_PRIVATE_KEY } from '../src/sessions/session-bindings.js';

const HOUR = 3_600_000;

async function ctx() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prox-'));
  return { logsDir: dir, bindingsFile: path.join(dir, 'bindings.json'), dir };
}
const readLog = async (logsDir, id) => JSON.parse(await fs.readFile(path.join(logsDir, `${id}.json`), 'utf8'));

test('isWardConversationalKind: the Familiar\'s own voice, not relays/notices', () => {
  for (const k of ['reminder', 'event_alert', 'weather_alert', 'reachout', 'triage']) assert.ok(isWardConversationalKind(k));
  for (const k of ['relay', 'relay_to_ward', 'flag_distress_relay', 'page_watch', 'crisis_resources', 'outbound_alert']) {
    assert.equal(isWardConversationalKind(k), false, `${k} is not conversational`);
  }
  assert.equal(WARD_CONVERSATIONAL_KINDS.size, 5);
});

test('no bound session → mints one, records the message as an assistant turn, binds it', async () => {
  const { logsDir, bindingsFile } = await ctx();
  try {
    const r = await appendWardProactiveTurn({ text: '⏰ **Wash day** — bins out tonight', kind: 'reminder', logsDir, bindingsFile, now: () => 1000 });
    assert.equal(r.ok, true);
    const log = await readLog(logsDir, r.sessionId);
    assert.equal(log.messages.length, 1);
    assert.equal(log.messages[0].role, 'assistant', 'it is the Familiar speaking, not a user turn');
    assert.match(log.messages[0].content, /Wash day/);
    assert.equal(log.messages[0].meta.proactive, true);
    assert.equal(log.messages[0].meta.kind, 'reminder');
    assert.equal(log.audienceTag, 'ward-private');
    // The binding now points at this session, so a reply continues it.
    const b = await getSessionBinding(WARD_PRIVATE_KEY, { bindingsFile });
    assert.equal(b.sessionId, r.sessionId);
  } finally { await fs.rm(logsDir, { recursive: true, force: true }); }
});

test('a live bound session → the message appends to it (no re-say lives in a fresh thread)', async () => {
  const { logsDir, bindingsFile } = await ctx();
  try {
    const a = await appendWardProactiveTurn({ text: 'first thought', kind: 'reachout', logsDir, bindingsFile, now: () => 1000 });
    const b = await appendWardProactiveTurn({ text: 'second thought', kind: 'reachout', logsDir, bindingsFile, now: () => 1000 + 60_000 });
    assert.equal(a.sessionId, b.sessionId, 'both land in the same live session');
    const log = await readLog(logsDir, b.sessionId);
    assert.equal(log.messages.length, 2);
    assert.deepEqual(log.messages.map(m => m.content), ['first thought', 'second thought']);
  } finally { await fs.rm(logsDir, { recursive: true, force: true }); }
});

test('an idled session → a fresh one, so the reply threads to THIS message not a stale one', async () => {
  const { logsDir, bindingsFile } = await ctx();
  try {
    const a = await appendWardProactiveTurn({ text: 'morning reminder', kind: 'reminder', logsDir, bindingsFile, now: () => 1_000_000 });
    const b = await appendWardProactiveTurn({ text: 'evening reminder', kind: 'reminder', logsDir, bindingsFile, now: () => 1_000_000 + 7 * HOUR });
    assert.notEqual(a.sessionId, b.sessionId, 'past the 6h rollover → a new session');
    const log = await readLog(logsDir, b.sessionId);
    assert.equal(log.messages.length, 1, 'the fresh session holds only the new message');
  } finally { await fs.rm(logsDir, { recursive: true, force: true }); }
});

test('LLM-style timestamp tokens are stripped from the stored content', async () => {
  const { logsDir, bindingsFile } = await ctx();
  try {
    const r = await appendWardProactiveTurn({ text: '⫸14:35⫷ don\'t forget the meds', kind: 'reminder', logsDir, bindingsFile, now: () => 1000 });
    const log = await readLog(logsDir, r.sessionId);
    assert.doesNotMatch(log.messages[0].content, /⫸14:35⫷/);
    assert.match(log.messages[0].content, /don't forget the meds/);
  } finally { await fs.rm(logsDir, { recursive: true, force: true }); }
});

test('the hard off-switch skips the append (delivery is unaffected elsewhere)', async () => {
  const { logsDir, bindingsFile } = await ctx();
  const prev = process.env.PROTO_FAMILIAR_PROACTIVE_SESSION_DISABLED;
  process.env.PROTO_FAMILIAR_PROACTIVE_SESSION_DISABLED = '1';
  try {
    const r = await appendWardProactiveTurn({ text: 'a reminder', kind: 'reminder', logsDir, bindingsFile, now: () => 1000 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'disabled');
    assert.deepEqual(await fs.readdir(logsDir), [], 'nothing was written');
  } finally {
    if (prev === undefined) delete process.env.PROTO_FAMILIAR_PROACTIVE_SESSION_DISABLED;
    else process.env.PROTO_FAMILIAR_PROACTIVE_SESSION_DISABLED = prev;
    await fs.rm(logsDir, { recursive: true, force: true });
  }
});

test('empty text or missing logsDir → a clean no-op, never a throw', async () => {
  const { logsDir, bindingsFile } = await ctx();
  try {
    assert.equal((await appendWardProactiveTurn({ text: '   ', kind: 'reminder', logsDir, bindingsFile })).ok, false);
    assert.equal((await appendWardProactiveTurn({ text: 'hi', kind: 'reminder', bindingsFile })).ok, false);
  } finally { await fs.rm(logsDir, { recursive: true, force: true }); }
});
