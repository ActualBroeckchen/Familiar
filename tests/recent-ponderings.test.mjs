import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fsp, mkdtempSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';

import { ponderOnce, PONDERINGS_TOME_NAME } from '../src/pondering/pondering.js';
import { getRecentPonderings, formatPonderingsForPrompt, readPonderingByUid, getUnactedIntents } from '../src/memory/recent-ponderings.js';

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
  assert.match(out, /my own real thoughts/i);
  assert.match(out, /never invent/i);
  assert.match(out, /because I want to share it/i);
});

test('formatPonderingsForPrompt renders only the latest in full; the rest are a one-line index', () => {
  const out = formatPonderingsForPrompt([
    { uid: 'a', title: 't1', content: 'c1-full', created_at: '2026-05-30T10:00:00.000Z' },
    { uid: 'b', title: 't2', content: 'c2-full', created_at: '2026-05-29T10:00:00.000Z' },
  ]);
  // Latest thought in full…
  assert.match(out, /t1[\s\S]*c1-full/);
  // …older ones indexed by title + id, with the expand hint — NOT dumped in full.
  assert.match(out, /t2.*\[id: b\]/);
  assert.equal(out.includes('c2-full'), false);
  assert.match(out, /read_pondering/);
});

// ── Deferred-intent surfacing / auto-consume ──────────────────────────────
// A "tell" whose whole action is the saying must be consumed by the system
// once it has had its one live turn — it must NOT wait on the LLM's
// acknowledge call (forgetting that was the "asked the same warm question
// three times in one chat" bug). Filing intents keep needing a real action.

async function seedIntentsTome(dir, entries) {
  const id = randomUUID();
  const file = path.join(dir, `${id}.json`);
  const tome = {
    id, name: PONDERINGS_TOME_NAME, description: '', enabled: false,
    entries: Object.fromEntries(entries.map(e => [e.uid, {
      uid: e.uid, comment: e.title ?? '', content: e.content ?? 'p', created_at: e.created_at,
      enabled: false, scope: 'pondering',
      wants_to_save: (e.wants_to_save ?? []).map(w => ({ acted_on: false, ...w })),
    }])),
  };
  await fsp.writeFile(file, JSON.stringify(tome, null, 2));
  return file;
}
const readTome = async (file) => JSON.parse(await fsp.readFile(file, 'utf8'));

test('a tell surfaces once under markSurfaced, then auto-consumes on the next live turn', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const file = await seedIntentsTome(dir, [
      { uid: 'e1', created_at: '2026-05-30T10:00:00Z',
        wants_to_save: [{ kind: 'tell', summary: 'ask how the garden is doing' }] },
    ]);

    // Turn 1: the tell is shown and stamped surfaced_at (still unacted).
    const first = await getUnactedIntents({ tomesDir: dir, markSurfaced: true });
    assert.deepEqual(first.map(i => i.summary), ['ask how the garden is doing']);
    let tome = await readTome(file);
    assert.equal(tome.entries.e1.wants_to_save[0].acted_on, false);
    assert.ok(tome.entries.e1.wants_to_save[0].surfaced_at, 'surfaced_at stamped on turn 1');

    // Turn 2: it has had its turn → auto-acked in code and no longer shown.
    const second = await getUnactedIntents({ tomesDir: dir, markSurfaced: true });
    assert.deepEqual(second, [], 'a spent tell never re-surfaces');
    tome = await readTome(file);
    assert.equal(tome.entries.e1.wants_to_save[0].acted_on, true, 'auto-consumed without an LLM ack');
    assert.equal(tome.entries.e1.wants_to_save[0].disposition, 'surfaced');
  } finally { cleanup(); }
});

test('read-only inspection (markSurfaced:false) never mutates and hides spent tells', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const file = await seedIntentsTome(dir, [
      { uid: 'e1', created_at: '2026-05-30T10:00:00Z',
        wants_to_save: [
          { kind: 'tell', summary: 'fresh tell' },
          { kind: 'tell', summary: 'already surfaced', surfaced_at: '2026-05-29T10:00:00Z' },
        ] },
    ]);
    const before = await fsp.readFile(file, 'utf8');
    const got = await getUnactedIntents({ tomesDir: dir, markSurfaced: false });
    assert.deepEqual(got.map(i => i.summary), ['fresh tell'], 'spent tell hidden, fresh one shown');
    assert.equal(await fsp.readFile(file, 'utf8'), before, 'read-only path wrote nothing');
  } finally { cleanup(); }
});

test('filing intents are never auto-consumed by surfacing (they need the real action)', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const file = await seedIntentsTome(dir, [
      { uid: 'e1', created_at: '2026-05-30T10:00:00Z',
        wants_to_save: [{ kind: 'memory', summary: 'remember the vet appointment' }] },
    ]);
    for (let turn = 0; turn < 3; turn++) {
      const got = await getUnactedIntents({ tomesDir: dir, markSurfaced: true });
      assert.deepEqual(got.map(i => i.summary), ['remember the vet appointment'],
        'a filing intent keeps surfacing until actually acted on');
    }
    const tome = await readTome(file);
    assert.equal(tome.entries.e1.wants_to_save[0].acted_on, false);
    assert.equal(tome.entries.e1.wants_to_save[0].surfaced_at, undefined, 'filing intents are never stamped');
  } finally { cleanup(); }
});

test('only tells actually shown (post-limit) are stamped; sliced-off tells are untouched', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const file = await seedIntentsTome(dir, [
      { uid: 'a', created_at: '2026-05-25T10:00:00Z', wants_to_save: [{ kind: 'tell', summary: 'oldest' }] },
      { uid: 'b', created_at: '2026-05-26T10:00:00Z', wants_to_save: [{ kind: 'tell', summary: 'middle' }] },
      { uid: 'c', created_at: '2026-05-27T10:00:00Z', wants_to_save: [{ kind: 'tell', summary: 'newest' }] },
    ]);
    const got = await getUnactedIntents({ tomesDir: dir, limit: 2, markSurfaced: true });
    assert.deepEqual(got.map(i => i.summary), ['oldest', 'middle'], 'oldest-first, limited to 2');
    const tome = await readTome(file);
    assert.ok(tome.entries.a.wants_to_save[0].surfaced_at, 'shown tell stamped');
    assert.ok(tome.entries.b.wants_to_save[0].surfaced_at, 'shown tell stamped');
    assert.equal(tome.entries.c.wants_to_save[0].surfaced_at, undefined, 'sliced-off tell NOT stamped');
  } finally { cleanup(); }
});

test('readPonderingByUid returns the full text by id, and errors cleanly on a miss', async () => {
  const { dir, cleanup } = tempDir();
  try {
    await seedTome(dir, [
      { uid: 'p1', title: 'On loyalty', content: 'the full text of the thought', created_at: '2026-05-30T10:00:00.000Z' },
    ]);
    const hit = await readPonderingByUid({ uid: 'p1', tomesDir: dir });
    assert.equal(hit.ok, true);
    assert.equal(hit.title, 'On loyalty');
    assert.equal(hit.content, 'the full text of the thought');

    const miss = await readPonderingByUid({ uid: 'nope', tomesDir: dir });
    assert.equal(miss.ok, false);
    const bad = await readPonderingByUid({ tomesDir: dir });
    assert.equal(bad.ok, false);
  } finally { cleanup(); }
});
