// Raw-transcript search — how the Familiar finds what was literally said
// (an outcome my human mentioned) when it isn't in the look-back window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { searchSessionLogs, messageText, isWardReadableLog } from '../src/sessions/session-search.js';

const HOUR = 3_600_000;
const T0 = 1_000_000_000_000;
const iso = (ms) => new Date(ms).toISOString();

async function seed() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssearch-'));
  // Ward session: a morning debrief that names no keyword, plus later chatter.
  await fs.writeFile(path.join(dir, 's-ward.json'), JSON.stringify({
    sessionId: 's-ward', audienceTag: 'ward-private',
    messages: [
      { role: 'user', content: 'just got back from the doctor', timestamp: iso(T0 - 9 * HOUR) },
      { role: 'user', content: 'honestly it wasn\'t as scary as I thought', timestamp: iso(T0 - 9 * HOUR + 60_000) },
      { role: 'assistant', content: 'that\'s a relief to hear', timestamp: iso(T0 - 9 * HOUR + 120_000) },
      { role: 'user', content: 'the silkie chickens look like clouds', timestamp: iso(T0 - 30 * 60_000) },
    ],
  }));
  // A GROUP room the ward shares — searchable (its results only ever reach the
  // ward's private reasoning, and the ward is part of the room).
  await fs.writeFile(path.join(dir, 's-group.json'), JSON.stringify({
    sessionId: 's-group', audienceTag: 'circle:friends',
    location: { platform: 'discord', kind: 'group', key: 'discord:guild:g1:channel:c1' },
    messages: [{ role: 'user', content: 'told the group the doctor visit went fine', speaker: 'Ward', timestamp: iso(T0 - 2 * HOUR) }],
  }));
  // A villager's 1:1 DM — private to THAT villager; held back by default.
  await fs.writeFile(path.join(dir, 's-villager-dm.json'), JSON.stringify({
    sessionId: 's-villager-dm', audienceTag: 'villager:sam',
    location: { platform: 'discord', kind: 'private', key: 'discord:dm:sam' },
    messages: [{ role: 'user', content: 'sam mentioned the doctor thing', speaker: 'Sam', timestamp: iso(T0 - HOUR) }],
  }));
  return dir;
}

test('isWardReadableLog: ward + group readable; a villager DM is not', () => {
  assert.equal(isWardReadableLog({ audienceTag: null }), true);
  assert.equal(isWardReadableLog({ audienceTag: 'ward-private' }), true);
  assert.equal(isWardReadableLog({ audienceTag: 'circle:friends', location: { kind: 'group' } }), true);
  assert.equal(isWardReadableLog({ audienceTag: 'x', location: { key: 'discord:guild:g:channel:c' } }), true);
  assert.equal(isWardReadableLog({ audienceTag: 'villager:sam', location: { kind: 'private', key: 'discord:dm:sam' } }), false);
});

test('messageText: pulls text from a string or a vision-era parts array', () => {
  assert.equal(messageText({ content: 'hi' }), 'hi');
  assert.equal(messageText({ content: [{ type: 'image' }, { type: 'text', text: 'a caption' }] }), 'a caption');
  assert.equal(messageText({ content: null }), '');
});

test('keyword search reads ward + group logs, but NOT a villager DM', async () => {
  const dir = await seed();
  try {
    const r = await searchSessionLogs({ logsDir: dir, query: 'doctor', now: () => T0, days: 30 });
    const ids = new Set(r.map(m => m.sessionId));
    assert.ok(ids.has('s-ward'), 'the ward session is searched');
    assert.ok(ids.has('s-group'), 'the group room the ward shares is searched');
    assert.ok(!ids.has('s-villager-dm'), 'a villager 1:1 DM is held back');
    assert.ok(r.some(m => /told the group the doctor visit went fine/.test(m.text)));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('includeVillagerDms opens the 1:1 DMs too (opt-in)', async () => {
  const dir = await seed();
  try {
    const r = await searchSessionLogs({ logsDir: dir, query: 'doctor', now: () => T0, days: 30, includeVillagerDms: true });
    assert.ok(r.some(m => m.sessionId === 's-villager-dm'), 'the villager DM is searched only when opted in');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('time-window mode returns what was said since then, keyword-free (finds the debrief)', async () => {
  const dir = await seed();
  try {
    // No query — read back the last ~9.5h. The "wasn't as scary" line has none of
    // the event's keywords, so ONLY the time mode surfaces it.
    const r = await searchSessionLogs({ logsDir: dir, sinceMs: T0 - 9.5 * HOUR, now: () => T0, limit: 20 });
    assert.ok(r.some(m => /wasn't as scary/.test(m.text)), 'the keyword-free answer is in the window');
    // The 30-min-ago chicken line is also in range; the >9h-old items are the boundary.
    assert.ok(r.some(m => /silkie chickens/.test(m.text)));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('sinceMs excludes anything older than the window', async () => {
  const dir = await seed();
  try {
    const r = await searchSessionLogs({ logsDir: dir, sinceMs: T0 - HOUR, now: () => T0, limit: 20 });
    assert.ok(r.every(m => !/from the doctor/.test(m.text)), 'the 9h-old debrief is outside a 1h window');
    assert.ok(r.some(m => /silkie chickens/.test(m.text)), 'the 30-min-ago line is inside it');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('more query-terms present ranks higher', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssearch-'));
  try {
    await fs.writeFile(path.join(dir, 's.json'), JSON.stringify({
      sessionId: 's', audienceTag: null,
      messages: [
        { role: 'user', content: 'the appointment', timestamp: iso(T0 - 2 * HOUR) },
        { role: 'user', content: 'the doctor appointment went fine', timestamp: iso(T0 - 3 * HOUR) },
      ],
    }));
    const r = await searchSessionLogs({ logsDir: dir, query: 'doctor appointment', now: () => T0, days: 30 });
    assert.match(r[0].text, /doctor appointment went fine/, 'both terms beats one, even though it is older');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a query with nothing matching, and a missing dir, both yield []', async () => {
  const dir = await seed();
  try {
    assert.deepEqual(await searchSessionLogs({ logsDir: dir, query: 'zebra', now: () => T0, days: 30 }), []);
    assert.deepEqual(await searchSessionLogs({ logsDir: path.join(dir, 'nope'), query: 'x' }), []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
