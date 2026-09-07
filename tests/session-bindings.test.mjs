import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSessionBinding, setSessionBinding, WARD_PRIVATE_KEY } from '../src/sessions/session-bindings.js';

async function tmpFile() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bindings-'));
  return { dir, bindingsFile: path.join(dir, '.session-bindings.json') };
}

test('getSessionBinding: missing store reads as null', async () => {
  const { dir, bindingsFile } = await tmpFile();
  try {
    assert.equal(await getSessionBinding(WARD_PRIVATE_KEY, { bindingsFile }), null);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('set then get round-trips the pointer with a timestamp', async () => {
  const { dir, bindingsFile } = await tmpFile();
  try {
    const r = await setSessionBinding(WARD_PRIVATE_KEY, 's-abc', { bindingsFile, at: '2026-01-01T00:00:00Z' });
    assert.equal(r.ok, true);
    const b = await getSessionBinding(WARD_PRIVATE_KEY, { bindingsFile });
    assert.equal(b.sessionId, 's-abc');
    assert.equal(b.lastTurnAt, '2026-01-01T00:00:00Z');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('setSessionBinding overwrites the pointer and refreshes lastTurnAt', async () => {
  const { dir, bindingsFile } = await tmpFile();
  try {
    await setSessionBinding(WARD_PRIVATE_KEY, 's-old', { bindingsFile, at: '2026-01-01T00:00:00Z' });
    await setSessionBinding(WARD_PRIVATE_KEY, 's-new', { bindingsFile, at: '2026-01-02T00:00:00Z' });
    const b = await getSessionBinding(WARD_PRIVATE_KEY, { bindingsFile });
    assert.equal(b.sessionId, 's-new');
    assert.equal(b.lastTurnAt, '2026-01-02T00:00:00Z');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('setSessionBinding rejects missing args without throwing', async () => {
  const { dir, bindingsFile } = await tmpFile();
  try {
    assert.equal((await setSessionBinding(null, 's', { bindingsFile })).ok, false);
    assert.equal((await setSessionBinding(WARD_PRIVATE_KEY, null, { bindingsFile })).ok, false);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});
