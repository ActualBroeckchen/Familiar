import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fsp, mkdtempSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';

import { ponderOnce, PONDERINGS_TOME_NAME } from '../pondering.js';
import { getRecentPonderings, formatPonderingsForPrompt } from '../recent-ponderings.js';

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ponder-recent-'));
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

async function seedTome(dir, entries) {
  const id = randomUUID();
  const tome = {
    id,
    name:        PONDERINGS_TOME_NAME,
    description: '',
    enabled:     true,
    entries:     Object.fromEntries(entries.map(e => [e.uid, {
      uid:           e.uid,
      comment:       e.title,
      content:       e.content,
      created_at:    e.created_at,
      learnedAt:     e.created_at,
      topic_pondered: e.topic ?? null,
      keys:          [],
      keysecondary:  [],
      enabled:       false,
      scope:         'pondering',
    }])),
  };
  await fsp.writeFile(path.join(dir, `${id}.json`), JSON.stringify(tome, null, 2));
}

test('returns [] when the tomes directory does not exist', async () => {
  assert.deepEqual(await getRecentPonderings({ tomesDir: '/nope/does/not/exist' }), []);
});

test('returns [] when no ponderings tome is present', async () => {
  const { dir, cleanup } = tempDir();
  try {
    await fsp.writeFile(path.join(dir, 'other.json'), JSON.stringify({ name: 'Other Tome', entries: {} }));
    assert.deepEqual(await getRecentPonderings({ tomesDir: dir }), []);
  } finally { cleanup(); }
});

test('returns entries newest-first and respects limit', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const now = Date.parse('2026-05-30T12:00:00Z');
    await seedTome(dir, [
      { uid: 'a', title: 'oldest', content: 'a', created_at: '2026-05-25T10:00:00Z' },
      { uid: 'b', title: 'middle', content: 'b', created_at: '2026-05-29T10:00:00Z' },
      { uid: 'c', title: 'newest', content: 'c', created_at: '2026-05-30T10:00:00Z' },
    ]);
    const got = await getRecentPonderings({ tomesDir: dir, limit: 2, now });
    assert.deepEqual(got.map(e => e.title), ['newest', 'middle']);
  } finally { cleanup(); }
});

test('filters out entries older than sinceDays', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const now = Date.parse('2026-05-30T12:00:00Z');
    await seedTome(dir, [
      { uid: 'old', title: 'last month', content: 'x', created_at: '2026-04-01T10:00:00Z' },
      { uid: 'new', title: 'yesterday',  content: 'y', created_at: '2026-05-29T10:00:00Z' },
    ]);
    const got = await getRecentPonderings({ tomesDir: dir, limit: 10, sinceDays: 7, now });
    assert.deepEqual(got.map(e => e.title), ['yesterday']);
  } finally { cleanup(); }
});

test('skips entries with empty content (corruption / interrupted writes)', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const now = Date.parse('2026-05-30T12:00:00Z');
    await seedTome(dir, [
      { uid: 'a', title: 'good',  content: 'real thought', created_at: '2026-05-30T08:00:00Z' },
      { uid: 'b', title: 'empty', content: '',             created_at: '2026-05-30T09:00:00Z' },
      { uid: 'c', title: 'ws',    content: '   \n  ',      created_at: '2026-05-30T10:00:00Z' },
    ]);
    const got = await getRecentPonderings({ tomesDir: dir, now });
    assert.deepEqual(got.map(e => e.title), ['good']);
  } finally { cleanup(); }
});

test('integrates with ponderOnce: real entries are recoverable in order', async () => {
  const { dir, cleanup } = tempDir();
  try {
    await ponderOnce({
      topic: 'first',  provider: 'nanogpt', apiKey: 'k', model: 'm',
      callLLM: async () => JSON.stringify({ title: 'A', content: 'thought A' }),
      tomesDir: dir,
    });
    await new Promise(r => setTimeout(r, 5));
    await ponderOnce({
      topic: 'second', provider: 'nanogpt', apiKey: 'k', model: 'm',
      callLLM: async () => JSON.stringify({ title: 'B', content: 'thought B' }),
      tomesDir: dir,
    });
    const got = await getRecentPonderings({ tomesDir: dir });
    assert.equal(got.length, 2);
    assert.equal(got[0].title,   'B');           // newest first
    assert.equal(got[0].content, 'thought B');
    assert.equal(got[1].title,   'A');
  } finally { cleanup(); }
});

test('formatPonderingsForPrompt returns empty string for no entries', () => {
  assert.equal(formatPonderingsForPrompt([]),        '');
  assert.equal(formatPonderingsForPrompt(undefined), '');
  assert.equal(formatPonderingsForPrompt(null),      '');
});

test('formatPonderingsForPrompt embeds title, content, and a relative-time framing', () => {
  // Timestamps are rendered via relativeTime so the Familiar perceives
  // WHEN each thought happened ("yesterday", "this morning", "last
  // Tuesday at 3pm") rather than as an ISO. The exact phrasing
  // depends on Date.now() at test time — assert on a flexible regex
  // that's true for any sensible relative-time output.
  const out = formatPonderingsForPrompt([
    { uid: 'a', title: 'On honesty', content: 'thinking about it', created_at: '2026-05-30T03:14:00.000Z' },
  ]);
  assert.match(out, /On honesty/);
  assert.match(out, /thinking about it/);
  assert.match(out, /(at \d|ago|in \d|today|yesterday|tomorrow|last |this |next |week)/i);
});

test('formatPonderingsForPrompt frames the entries as the Familiar\'s own real thoughts', () => {
  const out = formatPonderingsForPrompt([
    { uid: 'a', title: 'x', content: 'y', created_at: '2026-05-30T10:00:00.000Z' },
  ]);
  assert.match(out, /my own real, private thoughts/i);
  assert.match(out, /I never invent/i);
  assert.match(out, /I never force a reference/i);
});

test('formatPonderingsForPrompt handles multiple entries cleanly', () => {
  const out = formatPonderingsForPrompt([
    { uid: 'a', title: 't1', content: 'c1', created_at: '2026-05-30T10:00:00.000Z' },
    { uid: 'b', title: 't2', content: 'c2', created_at: '2026-05-29T10:00:00.000Z' },
  ]);
  assert.match(out, /t1[\s\S]*c1[\s\S]*t2[\s\S]*c2/);
});
