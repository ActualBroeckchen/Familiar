import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { mkdtempSync, rmSync } from 'fs';

import { enqueueOutbox, listOutbox, acknowledgeOutbox, clearAcknowledged, acknowledgePendingByKind } from '../outbox.js';

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'outbox-test-'));
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

test('enqueueOutbox writes an item readable by listOutbox', async () => {
  const { dir, cleanup } = tempDir();
  try {
    await enqueueOutbox({ kind: 'reminder', originId: 'r1', title: 'take a break', tomesDir: dir });
    const items = await listOutbox({ tomesDir: dir });
    assert.equal(items.length, 1);
    assert.equal(items[0].title,   'take a break');
    assert.equal(items[0].kind,    'reminder');
    assert.equal(items[0].acknowledged, false);
  } finally { cleanup(); }
});

test('enqueueOutbox dedups on (kind, originId) while not acknowledged', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const a = await enqueueOutbox({ kind: 'reminder', originId: 'r1', title: 'first',  tomesDir: dir });
    const b = await enqueueOutbox({ kind: 'reminder', originId: 'r1', title: 'second', tomesDir: dir });
    assert.equal(b.id,      a.id);
    assert.equal(b.deduped, true);
    const items = await listOutbox({ tomesDir: dir });
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'first');   // first wins; later sends collapse
  } finally { cleanup(); }
});

test('after acknowledge, a NEW item with the same originId is allowed', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const a = await enqueueOutbox({ kind: 'reminder', originId: 'r1', title: 'one', tomesDir: dir });
    await acknowledgeOutbox({ id: a.id, tomesDir: dir });
    const b = await enqueueOutbox({ kind: 'reminder', originId: 'r1', title: 'two', tomesDir: dir });
    assert.notEqual(b.id, a.id);
    const all = await listOutbox({ pendingOnly: false, tomesDir: dir });
    assert.equal(all.length, 2);
  } finally { cleanup(); }
});

test('acknowledgeOutbox marks an item read and listOutbox hides it by default', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const a = await enqueueOutbox({ kind: 'reminder', originId: 'r1', title: 'x', tomesDir: dir });
    await acknowledgeOutbox({ id: a.id, tomesDir: dir });
    const pending = await listOutbox({ tomesDir: dir });
    assert.equal(pending.length, 0);
    const all = await listOutbox({ pendingOnly: false, tomesDir: dir });
    assert.equal(all.length, 1);
    assert.equal(all[0].acknowledged, true);
  } finally { cleanup(); }
});

test('listOutbox returns newest-first', async () => {
  const { dir, cleanup } = tempDir();
  try {
    await enqueueOutbox({ kind: 'reminder', originId: 'r1', title: 'first',  ts: '2026-05-01T10:00:00Z', tomesDir: dir });
    await enqueueOutbox({ kind: 'reminder', originId: 'r2', title: 'middle', ts: '2026-05-02T10:00:00Z', tomesDir: dir });
    await enqueueOutbox({ kind: 'reminder', originId: 'r3', title: 'newest', ts: '2026-05-03T10:00:00Z', tomesDir: dir });
    const items = await listOutbox({ tomesDir: dir });
    assert.deepEqual(items.map(i => i.title), ['newest', 'middle', 'first']);
  } finally { cleanup(); }
});

test('clearAcknowledged removes acknowledged items only', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const a = await enqueueOutbox({ kind: 'reminder', originId: 'a', title: 'a', tomesDir: dir });
    await enqueueOutbox({ kind: 'reminder', originId: 'b', title: 'b', tomesDir: dir });
    await acknowledgeOutbox({ id: a.id, tomesDir: dir });
    const r = await clearAcknowledged({ tomesDir: dir });
    assert.equal(r.removed, 1);
    const all = await listOutbox({ pendingOnly: false, tomesDir: dir });
    assert.equal(all.length, 1);
    assert.equal(all[0].title, 'b');
  } finally { cleanup(); }
});

test('enqueueOutbox rejects missing kind / title', async () => {
  const { dir, cleanup } = tempDir();
  try {
    await assert.rejects(enqueueOutbox({ title: 'x',         tomesDir: dir }), /kind/i);
    await assert.rejects(enqueueOutbox({ kind:  'reminder',  tomesDir: dir }), /title/i);
  } finally { cleanup(); }
});

test('acknowledgePendingByKind settles only the named kind — the escalation veto', async () => {
  const { dir, cleanup } = tempDir();
  try {
    // Two pending check-ins (triage) and a reminder that must NOT be touched.
    await enqueueOutbox({ kind: 'triage', originId: 't1', title: 'checking in', body: 'you ok?', tomesDir: dir });
    await enqueueOutbox({ kind: 'triage', originId: 't2', title: 'checking in', body: 'still there?', tomesDir: dir });
    await enqueueOutbox({ kind: 'reminder', originId: 'r1', title: 'water',       tomesDir: dir });

    const r = await acknowledgePendingByKind('triage', { tomesDir: dir });
    assert.equal(r.ok, true);
    assert.equal(r.acknowledged, 2, 'both pending check-ins settled');

    // Both triage items are now acknowledged (out of the escalation check);
    // the reminder is still pending.
    const pending = await listOutbox({ pendingOnly: true, tomesDir: dir });
    assert.deepEqual(pending.map(i => i.kind), ['reminder'], 'only the reminder is still pending');

    const all = await listOutbox({ pendingOnly: false, tomesDir: dir });
    const triage = all.filter(i => i.kind === 'triage');
    assert.ok(triage.every(i => i.acknowledged && i.acknowledgedAt), 'triage items carry an ack timestamp');
  } finally { cleanup(); }
});

test('acknowledgePendingByKind is a no-op when nothing of that kind is pending', async () => {
  const { dir, cleanup } = tempDir();
  try {
    await enqueueOutbox({ kind: 'reminder', originId: 'r1', title: 'x', tomesDir: dir });
    const r = await acknowledgePendingByKind('triage', { tomesDir: dir });
    assert.equal(r.acknowledged, 0);
    assert.equal((await listOutbox({ pendingOnly: true, tomesDir: dir })).length, 1, 'reminder untouched');
    // A blank kind settles nothing rather than everything.
    const blank = await acknowledgePendingByKind('', { tomesDir: dir });
    assert.equal(blank.ok, false);
  } finally { cleanup(); }
});
