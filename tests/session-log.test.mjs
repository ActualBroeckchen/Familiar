import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeMessages, writeSessionLog } from '../src/sessions/session-log.js';

const m = (id, ts, content = id) => ({ id, role: 'user', content, timestamp: ts });

test('mergeMessages: union by id, ordered by timestamp', () => {
  const existing = [m('a', '2026-01-01T10:00:00Z'), m('b', '2026-01-01T10:05:00Z')];
  const incoming = [m('a', '2026-01-01T10:00:00Z'), m('c', '2026-01-01T10:10:00Z')];
  // 'b' exists on disk but not in incoming → spliced back at its time position.
  const out = mergeMessages(existing, incoming);
  assert.deepEqual(out.map(x => x.id), ['a', 'b', 'c']);
});

test('mergeMessages: nothing to add returns incoming unchanged', () => {
  const incoming = [m('a', '2026-01-01T10:00:00Z')];
  assert.equal(mergeMessages([m('a', '2026-01-01T10:00:00Z')], incoming), incoming);
});

test('mergeMessages: id-less legacy messages are a stable prefix (never diffed)', () => {
  const existing = [{ role: 'user', content: 'old' }, m('b', '2026-01-01T10:05:00Z')];
  const incoming = [{ role: 'user', content: 'old' }, m('c', '2026-01-01T10:10:00Z')];
  const out = mergeMessages(existing, incoming);
  // 'b' (id, disk-only) is preserved after the id-less legacy prefix, in ts order.
  assert.deepEqual(out.map(x => x.id ?? x.content), ['old', 'b', 'c']);
});

async function tmpLogs() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sesslog-'));
  return { dir, logsDir: dir };
}

test('writeSessionLog merge:true preserves a turn the other surface appended', async () => {
  const { dir, logsDir } = await tmpLogs();
  try {
    await writeSessionLog({ sessionId: 's1', messages: [m('a', '2026-01-01T10:00:00Z'), m('b', '2026-01-01T10:05:00Z')] }, { logsDir });
    // A stale writer that only knows about 'a' writes with merge → 'b' survives, 'c' added.
    await writeSessionLog({ sessionId: 's1', messages: [m('a', '2026-01-01T10:00:00Z'), m('c', '2026-01-01T10:10:00Z')] }, { logsDir, merge: true });
    const log = JSON.parse(await fsp.readFile(path.join(logsDir, 's1.json'), 'utf8'));
    assert.deepEqual(log.messages.map(x => x.id), ['a', 'b', 'c']);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('writeSessionLog: concurrent merged writes lose no turn (lock + union)', async () => {
  const { dir, logsDir } = await tmpLogs();
  try {
    await writeSessionLog({ sessionId: 's2', messages: [m('a', '2026-01-01T10:00:00Z')] }, { logsDir });
    // Two writers race, each with a different new turn on top of {a}.
    await Promise.all([
      writeSessionLog({ sessionId: 's2', messages: [m('a', '2026-01-01T10:00:00Z'), m('b', '2026-01-01T10:05:00Z')] }, { logsDir, merge: true }),
      writeSessionLog({ sessionId: 's2', messages: [m('a', '2026-01-01T10:00:00Z'), m('c', '2026-01-01T10:06:00Z')] }, { logsDir, merge: true }),
    ]);
    const log = JSON.parse(await fsp.readFile(path.join(logsDir, 's2.json'), 'utf8'));
    assert.deepEqual(log.messages.map(x => x.id).sort(), ['a', 'b', 'c']);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('writeSessionLog merge: location and startedAt are set-once (creator wins)', async () => {
  const { dir, logsDir } = await tmpLogs();
  try {
    await writeSessionLog({ sessionId: 's3', startedAt: 'A', location: { platform: 'discord', label: 'Discord DM' }, messages: [m('a', '2026-01-01T10:00:00Z')] }, { logsDir });
    // A later web write must not relabel the Discord-born session.
    await writeSessionLog({ sessionId: 's3', startedAt: 'B', location: { platform: 'web', label: 'Web chat' }, messages: [m('a', '2026-01-01T10:00:00Z'), m('b', '2026-01-01T10:05:00Z')] }, { logsDir, merge: true });
    const log = JSON.parse(await fsp.readFile(path.join(logsDir, 's3.json'), 'utf8'));
    assert.equal(log.location.platform, 'discord');
    assert.equal(log.startedAt, 'A');
    assert.deepEqual(log.messages.map(x => x.id), ['a', 'b']);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});
