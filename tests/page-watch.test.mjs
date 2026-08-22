import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  addWatch, listWatches, removeWatch, readWatches,
  normalizeForHash, hashText, dueWatches, runOnePageWatchTick,
  buildPageWatchPrompt, parsePageWatchDecision, DEFAULT_WATCH_INTERVAL_MS,
} from '../page-watch.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pagewatch-'));
}

test('addWatch registers, dedups on url, and mints a readable id', () => {
  const dir = tmpDir();
  const r = addWatch({ url: 'https://example.com/tickets', label: 'Tickets', note: 'tell me on restock' }, { tomesDir: dir });
  assert.equal(r.ok, true);
  assert.match(r.watch.id, /tickets/);
  assert.equal(r.watch.url, 'https://example.com/tickets');
  // A second add on the same URL (trailing slash / fragment normalized) updates, not twins.
  const r2 = addWatch({ url: 'https://example.com/tickets/#section', label: 'Ticket page' }, { tomesDir: dir });
  assert.equal(r2.updated, true);
  assert.equal(readWatches(dir).length, 1);
  assert.equal(readWatches(dir)[0].label, 'Ticket page');
});

test('addWatch rejects a non-URL', () => {
  const dir = tmpDir();
  assert.equal(addWatch({ url: 'not a url' }, { tomesDir: dir }).ok, false);
  assert.equal(readWatches(dir).length, 0);
});

test('removeWatch accepts id or url', () => {
  const dir = tmpDir();
  const { watch } = addWatch({ url: 'https://a.example' }, { tomesDir: dir });
  assert.equal(removeWatch('https://a.example', { tomesDir: dir }).ok, true);
  assert.equal(readWatches(dir).length, 0);
  assert.equal(removeWatch(watch.id, { tomesDir: dir }).ok, false);   // already gone
});

test('normalizeForHash ignores whitespace + the read_webpage meta header', () => {
  const a = hashText('---\ntitle: X\n---\nHello   world\n\n');
  const b = hashText('Hello world');
  assert.equal(a, b);
});

test('dueWatches respects per-watch interval (above the 15-min floor)', () => {
  const now = 10_000_000_000;
  const H = 60 * 60 * 1000;
  const watches = [
    { active: true, lastCheckedAt: now - 7 * H, intervalMs: 6 * H },     // elapsed
    { active: true, lastCheckedAt: now - 60_000, intervalMs: 6 * H },    // not yet
    { active: false, lastCheckedAt: 0, intervalMs: 6 * H },              // inactive
  ];
  assert.equal(dueWatches(watches, now).length, 1);
});

// A clock that advances well past a watch's interval between ticks, so each
// tick actually comes due (the 15-min floor / 6h default are real in code).
function advancingClock(start = 1_000_000_000_000) {
  let t = start;
  return { now: () => t, tick() { t += 7 * 60 * 60 * 1000; } };   // +7h per tick
}

test('first observation is a silent baseline; unchanged never calls the LLM', async () => {
  const dir = tmpDir();
  addWatch({ url: 'https://p.example' }, { tomesDir: dir });
  const clock = advancingClock();
  let decideCalls = 0, enqueued = 0;
  const deps = {
    tomesDir: dir, now: clock.now,
    fetchReadable: async () => ({ ok: true, text: 'stable content' }),
    decideChange: async () => { decideCalls++; return { surface: true, summary: 'x' }; },
    enqueue: async () => { enqueued++; },
  };
  const r1 = await runOnePageWatchTick(deps);
  assert.deepEqual([r1.checked, r1.changed, r1.surfaced], [1, 0, 0]);   // baseline only
  assert.equal(decideCalls, 0);
  clock.tick();
  const r2 = await runOnePageWatchTick(deps);
  assert.deepEqual([r2.checked, r2.changed], [1, 0]);                   // same content → no change
  assert.equal(decideCalls, 0, 'the LLM is never consulted for an unchanged page');
  assert.equal(enqueued, 0);
});

test('a real change consults the LLM and surfaces only when it says so', async () => {
  const dir = tmpDir();
  addWatch({ url: 'https://q.example', label: 'Q' }, { tomesDir: dir });
  const clock = advancingClock();
  let text = 'v1';
  let surface = true;
  const enq = [];
  const deps = {
    tomesDir: dir, now: clock.now,
    fetchReadable: async () => ({ ok: true, text }),
    decideChange: async ({ label, oldSnapshot, newText }) => {
      assert.equal(label, 'Q');
      return { surface, summary: `changed: ${oldSnapshot} -> ${newText}` };
    },
    enqueue: async (e) => enq.push(e),
  };
  await runOnePageWatchTick(deps);         // baseline v1
  clock.tick(); text = 'v2';
  const r = await runOnePageWatchTick(deps);   // change → surface
  assert.deepEqual([r.changed, r.surfaced], [1, 1]);
  assert.equal(enq.length, 1);
  assert.match(enq[0].summary, /v1 -> v2/);
  assert.ok(enq[0].hash, 'the change hash rides for outbox dedup');

  // Next change, but the LLM judges it noise → no banner.
  clock.tick(); text = 'v3'; surface = false;
  const r2 = await runOnePageWatchTick(deps);
  assert.deepEqual([r2.changed, r2.surfaced], [1, 0]);
  assert.equal(enq.length, 1, 'noise change was not surfaced');
});

test('a persistently failing fetch backs off and deactivates after repeated failures', async () => {
  const dir = tmpDir();
  addWatch({ url: 'https://dead.example' }, { tomesDir: dir });
  const clock = advancingClock();
  const deps = {
    tomesDir: dir, now: clock.now,
    fetchReadable: async () => ({ ok: false, error: 'http 500' }),
    decideChange: async () => ({ surface: true }),
    enqueue: async () => {},
  };
  let last;
  for (let i = 0; i < 5; i++) { last = await runOnePageWatchTick(deps); clock.tick(); }
  assert.equal(last.failed, 1);
  const w = readWatches(dir)[0];
  assert.equal(w.active, false, 'deactivated after 5 failures');
  assert.match(w.deactivatedReason, /couldn't read/);
});

test('the tick never throws even if the fetch dep throws', async () => {
  const dir = tmpDir();
  addWatch({ url: 'https://boom.example' }, { tomesDir: dir });
  const r = await runOnePageWatchTick({
    tomesDir: dir, now: () => Date.now() + 10 * 24 * 60 * 60 * 1000,   // safely due
    fetchReadable: async () => { throw new Error('kaboom'); },
  });
  assert.equal(r.failed, 1);
});

test('buildPageWatchPrompt names the page and carries {{user}}; parse reads the JSON', () => {
  const p = buildPageWatchPrompt({ url: 'https://x', label: 'X', note: 'why', oldSnapshot: 'a', newText: 'b' });
  assert.match(p, /\{\{user\}\}/);
  assert.match(p, /X/);
  assert.deepEqual(parsePageWatchDecision('{"surface": true, "summary": "it changed"}'), { surface: true, summary: 'it changed' });
  assert.deepEqual(parsePageWatchDecision('nonsense'), { surface: false, summary: '' });
  assert.equal(parsePageWatchDecision('{"surface": false}').surface, false);
});

test('DEFAULT_WATCH_INTERVAL_MS is a sane multi-hour default', () => {
  assert.ok(DEFAULT_WATCH_INTERVAL_MS >= 60 * 60 * 1000);
});
