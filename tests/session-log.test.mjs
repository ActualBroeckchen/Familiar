import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeSessionLog, stampMessages, turnMessages } from '../session-log.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'slog-'));

test('writeSessionLog persists a log readable back with its shape', async () => {
  const dir = await tmp();
  try {
    const data = {
      sessionId: 's-20260101-ab12', audienceTag: 'ward-private', origin: 'voice-call',
      messages: [{ id: 'a', role: 'user', content: 'hi' }, { id: 'b', role: 'assistant', content: 'hey' }],
    };
    const r = await writeSessionLog(data, { logsDir: dir });
    assert.equal(r.ok, true);
    const back = JSON.parse(await fs.readFile(path.join(dir, 's-20260101-ab12.json'), 'utf8'));
    assert.equal(back.sessionId, 's-20260101-ab12');
    assert.equal(back.audienceTag, 'ward-private');   // the tag rides along for the sessions list + gate
    assert.equal(back.messages.length, 2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('writeSessionLog never throws — bad input returns ok:false', async () => {
  const dir = await tmp();
  try {
    assert.equal((await writeSessionLog({ messages: [] }, { logsDir: dir })).ok, false, 'no sessionId');
    assert.equal((await writeSessionLog({ sessionId: 's-x' }, {})).ok, false, 'no logsDir');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('writeSessionLog overwrites cleanly (atomic tmp+rename leaves no .tmp)', async () => {
  const dir = await tmp();
  try {
    await writeSessionLog({ sessionId: 's-1', messages: [{ role: 'user', content: 'one' }] }, { logsDir: dir });
    await writeSessionLog({ sessionId: 's-1', messages: [{ role: 'user', content: 'two' }] }, { logsDir: dir });
    const back = JSON.parse(await fs.readFile(path.join(dir, 's-1.json'), 'utf8'));
    assert.equal(back.messages[0].content, 'two', 'second write wins');
    const files = await fs.readdir(dir);
    assert.deepEqual(files, ['s-1.json'], 'no stray .tmp left behind');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('stampMessages fills id + timestamp on plain turns, preserves existing ones', async () => {
  const stamped = stampMessages(
    [
      { role: 'user', content: 'plain' },
      { id: 'keep', role: 'assistant', content: 'has id', timestamp: '2020-01-01T00:00:00Z' },
      { role: 'user', content: 'with image', attachments: [{ id: 'img1' }] },
    ],
    '2026-01-01T00:00:00Z',
  );
  assert.ok(stamped[0].id && stamped[0].timestamp === '2026-01-01T00:00:00Z', 'plain turn gets id + the stamp time');
  assert.equal(stamped[1].id, 'keep', 'existing id preserved');
  assert.equal(stamped[1].timestamp, '2020-01-01T00:00:00Z', 'existing timestamp preserved');
  assert.deepEqual(stamped[2].attachments, [{ id: 'img1' }], 'attachments carried through');
  assert.equal(stamped[0].role, 'user');
  assert.equal(stampMessages(null).length, 0, 'non-array → empty, no throw');
});

test('turnMessages stamps a user+assistant pair and attributes the speaker (group calls)', () => {
  const [u, a] = turnMessages('hello', 'hi there', { speaker: 'Mira', at: '2026-01-01T00:00:00Z' });
  assert.equal(u.role, 'user');
  assert.equal(u.content, 'hello');
  assert.equal(u.speaker, 'Mira', 'the user turn carries who spoke');
  assert.equal(u.timestamp, '2026-01-01T00:00:00Z');
  assert.ok(u.id && a.id && u.id !== a.id, 'both turns get distinct ids');
  assert.equal(a.role, 'assistant');
  assert.equal(a.speaker, undefined, 'the assistant turn is the Familiar, never a speaker name');

  // No speaker (the ward alone, or a web call) → the field is omitted, matching
  // Discord text's unattributed ward turns.
  const [wu] = turnMessages('solo', 'ok');
  assert.equal('speaker' in wu, false, 'unattributed when no speaker given');
});
