import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortPonderUid } from '../src/pondering/pondering.js';

test('shortPonderUid: compact slug shape, no lookalike chars', () => {
  for (let i = 0; i < 200; i++) {
    const uid = shortPonderUid();
    assert.match(uid, /^ponder-[a-hj-km-np-z2-9]{6}$/);
    assert.ok(uid.length <= 14);
  }
});

test('shortPonderUid: effectively unique across a large draw', () => {
  const seen = new Set(Array.from({ length: 5000 }, () => shortPonderUid()));
  assert.ok(seen.size > 4995);  // collisions this rare; the writer re-rolls anyway
});

import { sessionSlugId, outboxSlugId, isLegacyId, shortSlug } from '../slug-ids.js';
import { rekeyOutboxIds, enqueueOutbox, listOutbox } from '../outbox.js';
import { rekeyCueState, readCueState, writeCueState } from '../src/gcal/gcal-projection.js';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

test('sessionSlugId: dated, readable, path-safe', () => {
  const id = sessionSlugId(new Date('2026-07-04T12:00:00'));
  assert.match(id, /^s-20260704-[a-hj-km-np-z2-9]{4}$/);
});

test('outboxSlugId: kind-prefixed', () => {
  assert.match(outboxSlugId('reminder'), /^reminder-[a-hj-km-np-z2-9]{6}$/);
  assert.match(outboxSlugId('RELAY!'), /^relay-/);
  assert.match(outboxSlugId(''), /^item-/);
});

test('isLegacyId: hex32 + uuid36 yes, slugs no', () => {
  assert.equal(isLegacyId('6512ce4f9a2b4c8d9e1f0a3b5c7d9e2f'), true);
  assert.equal(isLegacyId('f47ac10b-58cc-4372-a567-0e02b2c3d479'), true);
  assert.equal(isLegacyId('dentist-k3'), false);
  assert.equal(isLegacyId('s-20260704-x7k2'), false);
});

test('rekeyOutboxIds: slugs legacy item ids + follows the node-id mapping', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pf-outbox-'));
  await enqueueOutbox({ kind: 'reminder', originId: 'aaaa1111aaaa1111aaaa1111aaaa1111', title: 'x', tomesDir: dir });
  // Force a legacy item id to simulate a pre-overhaul store.
  const items = await listOutbox({ pendingOnly: false, tomesDir: dir });
  const { promises: fsp } = await import('fs');
  const f = path.join(dir, '.outbox.json');
  const raw = JSON.parse(await fsp.readFile(f, 'utf8'));
  raw.items[0].id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  await fsp.writeFile(f, JSON.stringify(raw));
  const r = await rekeyOutboxIds({ mapping: { aaaa1111aaaa1111aaaa1111aaaa1111: 'dentist-k3' }, tomesDir: dir });
  assert.equal(r.ids, 1);
  assert.equal(r.origins, 1);
  const after = await listOutbox({ pendingOnly: false, tomesDir: dir });
  assert.match(after[0].id, /^reminder-/);
  assert.equal(after[0].originId, 'dentist-k3');
});

test('rekeyCueState: follows the mapping, preserves aging', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pf-cue-'));
  await writeCueState({ oldhex: { firstSeenTs: 5, turnsShown: 2 }, keep: { firstSeenTs: 9, turnsShown: 1 } }, { tomesDir: dir });
  const r = await rekeyCueState({ oldhex: 'dentist-k3' }, { tomesDir: dir });
  assert.equal(r.moved, 1);
  const s = await readCueState({ tomesDir: dir });
  assert.deepEqual(s['dentist-k3'], { firstSeenTs: 5, turnsShown: 2 });
  assert.ok(s.keep);
});
