import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { recordUserActivity, getLastUserActivity } from '../last-activity.js';

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'last-activity-test-'));
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

test('getLastUserActivity → null when nothing recorded', async () => {
  const { dir, cleanup } = tempDir();
  try {
    assert.equal(await getLastUserActivity({ tomesDir: dir }), null);
  } finally { cleanup(); }
});

test('recordUserActivity → readable by getLastUserActivity', async () => {
  const { dir, cleanup } = tempDir();
  try {
    await recordUserActivity({ tomesDir: dir, ts: '2026-05-30T12:00:00.000Z' });
    const r = await getLastUserActivity({ tomesDir: dir });
    assert.equal(r.ts, '2026-05-30T12:00:00.000Z');
    assert.equal(r.ms, Date.parse('2026-05-30T12:00:00.000Z'));
  } finally { cleanup(); }
});

test('recordUserActivity → later writes overwrite earlier', async () => {
  const { dir, cleanup } = tempDir();
  try {
    await recordUserActivity({ tomesDir: dir, ts: '2026-05-30T10:00:00.000Z' });
    await recordUserActivity({ tomesDir: dir, ts: '2026-05-30T12:00:00.000Z' });
    const r = await getLastUserActivity({ tomesDir: dir });
    assert.equal(r.ts, '2026-05-30T12:00:00.000Z');
  } finally { cleanup(); }
});

test('getLastUserActivity → null when file content is malformed', async () => {
  const { dir, cleanup } = tempDir();
  const fsp = await import('fs/promises');
  try {
    await fsp.writeFile(`${dir}/.last-activity.json`, 'not json', 'utf8');
    assert.equal(await getLastUserActivity({ tomesDir: dir }), null);
  } finally { cleanup(); }
});
