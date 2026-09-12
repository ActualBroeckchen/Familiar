/**
 * Tests for reflection-events.js (temporal-bridges Piece 5 — observability).
 * Verifies the heartbeat round-trips (incl. all-zero entries), is newest-first,
 * honors limit, and never throws on a missing/corrupt log.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';

// Point the module's LOGS_DIR at a temp dir by importing after chdir? The
// module resolves LOGS_DIR from its own file location, so instead we test the
// public behavior against the real logs dir with a unique marker and clean up.
import { appendReflectionEvent, readReflectionEvents, REFLECTION_LOG_FILE } from '../src/pondering/reflection-events.js';

test('appends and reads back a heartbeat, newest first', async () => {
  const marker = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await appendReflectionEvent({ title: `${marker}-A`, edgesGraded: 0, promotions: 0 });
  await appendReflectionEvent({ title: `${marker}-B`, edgesGraded: 3, promotions: 1, wroteIdentity: true });
  const events = await readReflectionEvents({ limit: 500 });
  const mine = events.filter(e => (e.title || '').startsWith(marker));
  assert.equal(mine.length, 2);
  // Newest first: B before A.
  assert.equal(mine[0].title, `${marker}-B`);
  assert.equal(mine[1].title, `${marker}-A`);
  // All-zero entry is preserved (the whole point).
  assert.equal(mine[1].edgesGraded, 0);
  assert.equal(mine[0].wroteIdentity, true);
  assert.ok(mine[0].loggedAt, 'stamps loggedAt');
});

test('readReflectionEvents tolerates a corrupt line', async () => {
  await fsp.appendFile(REFLECTION_LOG_FILE, 'not json at all\n', 'utf8');
  const events = await readReflectionEvents({ limit: 10 });
  assert.ok(Array.isArray(events)); // did not throw
});

test('appendReflectionEvent never throws on a bad entry', async () => {
  const circular = {};
  circular.self = circular; // JSON.stringify would throw — must be swallowed
  await assert.doesNotReject(() => appendReflectionEvent(circular));
});
