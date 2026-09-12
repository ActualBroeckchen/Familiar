// The "already asked" ledger that stops the noticing turn re-asking about the
// same overdue event (the reported "answered three times" bug).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ASK_COOLDOWN_MS, filterRecentlyAsked, stampAsked, pruneAsked,
  readAskedMap, writeAskedMap,
} from '../src/safety/noticing-outcomes.js';

const now = 1_000_000_000_000;
const ev = (id) => ({ id, label: id });

test('filterRecentlyAsked: a just-asked event is suppressed; a cooled-down one returns', () => {
  const map = { fresh: now - 60_000, stale: now - (ASK_COOLDOWN_MS + 60_000) };
  const kept = filterRecentlyAsked([ev('fresh'), ev('stale'), ev('never')], map, { now });
  assert.deepEqual(kept.map(e => e.id), ['stale', 'never'], 'only the recently-asked one is held back');
});

test('filterRecentlyAsked: an unasked event always surfaces (unprompted-answer path can close it)', () => {
  const kept = filterRecentlyAsked([ev('a'), ev('b')], {}, { now });
  assert.deepEqual(kept.map(e => e.id), ['a', 'b']);
});

test('stampAsked: records ids as asked-now without mutating the input', () => {
  const before = { old: 5 };
  const after = stampAsked(before, ['x', 'y'], now);
  assert.deepEqual(after, { old: 5, x: now, y: now });
  assert.deepEqual(before, { old: 5 }, 'input map is not mutated');
  // A blank id is ignored.
  assert.deepEqual(stampAsked({}, ['', null, 'z'], now), { z: now });
});

test('pruneAsked: keeps still-live or still-cooling stamps, drops the rest', () => {
  const map = {
    live:    now - (ASK_COOLDOWN_MS + 1),   // stale by time, but still an open event → keep
    cooling: now - 60_000,                  // within cooldown → keep
    gone:    now - (ASK_COOLDOWN_MS + 1),   // stale AND no longer overdue → drop
  };
  const pruned = pruneAsked(map, ['live'], { now });
  assert.deepEqual(Object.keys(pruned).sort(), ['cooling', 'live']);
});

test('the ledger round-trips on disk and reads empty when missing/broken', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nask-'));
  try {
    assert.deepEqual(await readAskedMap(dir), {}, 'missing file → empty ledger (fail-safe)');
    await writeAskedMap(dir, { ev1: now });
    assert.deepEqual(await readAskedMap(dir), { ev1: now }, 'what was written comes back');
    await fs.writeFile(path.join(dir, '.noticing-asked.json'), 'not json');
    assert.deepEqual(await readAskedMap(dir), {}, 'a broken file reads as empty, never throws');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
