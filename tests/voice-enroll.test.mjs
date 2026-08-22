import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { embedClip, embedClips, enrollWard, enrollVillager } from '../voice-enroll.js';
import { getWardPrint, getVillagerPrint } from '../voiceprints.js';

// A fake worker: op:'load' succeeds; op:'embed' returns whatever embedding the
// test script maps for a given wavPath (or a failure reason).
function fakeWorker(embedMap) {
  return {
    getWorker: async () => ({
      worker: {
        request: async (msg) => {
          if (msg.op === 'load') return { ok: true, role: 'speaker' };
          if (msg.op === 'embed') {
            const v = embedMap[msg.wavPath];
            if (v === 'short') return { ok: false, reason: 'not-ready' };
            if (Array.isArray(v)) return { ok: true, embedding: v, dim: v.length };
            return { ok: false, reason: 'embed-failed' };
          }
          return { ok: false, reason: 'bad-op' };
        },
      },
    }),
  };
}

async function tmpFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enroll-'));
  return { file: path.join(dir, '.voiceprints.json'), cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test('embedClip loads the speaker model then returns the embedding', async () => {
  const r = await embedClip('/a.wav', fakeWorker({ '/a.wav': [1, 0, 0] }));
  assert.deepEqual(r, { ok: true, embedding: [1, 0, 0], dim: 3 });
});

test('embedClip surfaces a no-worker failure without throwing', async () => {
  const r = await embedClip('/a.wav', { getWorker: async () => ({ worker: null, reason: 'no-listening-engine' }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-listening-engine');
});

test('embedClips averages usable clips and skips the ones that fail', async () => {
  const deps = fakeWorker({ '/a.wav': [1, 0], '/b.wav': 'short', '/c.wav': [0, 1] });
  const r = await embedClips(['/a.wav', '/b.wav', '/c.wav'], deps);
  assert.equal(r.ok, true);
  assert.equal(r.used, 2, 'the too-short clip is skipped, not fatal');
});

test('embedClips fails cleanly when NO clip is usable', async () => {
  const r = await embedClips(['/a.wav'], fakeWorker({ '/a.wav': 'short' }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-ready');
  assert.equal((await embedClips([], fakeWorker({}))).reason, 'no-clips');
});

test('enrollWard writes the ward print to the store', async () => {
  const { file, cleanup } = await tmpFile();
  try {
    const r = await enrollWard(['/a.wav', '/b.wav'], { ...fakeWorker({ '/a.wav': [1, 0], '/b.wav': [1, 0] }), voiceprintsFile: file });
    assert.equal(r.ok, true);
    assert.ok(await getWardPrint({ file }), 'the ward print landed in the store');
  } finally { await cleanup(); }
});

test('enrollVillager needs an id and stores under it', async () => {
  const { file, cleanup } = await tmpFile();
  try {
    assert.equal((await enrollVillager('', ['/a.wav'], fakeWorker({}))).reason, 'no-id');
    const r = await enrollVillager('mira', ['/a.wav'], { name: 'Mira', ...fakeWorker({ '/a.wav': [0, 1] }), voiceprintsFile: file });
    assert.equal(r.ok, true);
    assert.ok(await getVillagerPrint('mira', { file }));
    assert.equal(await getWardPrint({ file }), null, 'enrolling a villager does not touch the ward');
  } finally { await cleanup(); }
});

test('enrollWard fails (not throws) when the model/worker is absent', async () => {
  const r = await enrollWard(['/a.wav'], { getWorker: async () => ({ worker: null }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-worker');
});
