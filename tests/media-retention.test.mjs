import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectRetentionCandidates, runMediaRetention, parseKeepRefs } from '../media-retention.js';

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-08-14T12:00:00Z');

function audio(over = {}) {
  return {
    id: over.id ?? 'a1', kind: 'audio', ext: 'wav',
    slugs: over.slugs ?? ['wish-me-luck-x7'],
    receivedAt: over.receivedAt ?? new Date(NOW - 30 * DAY).toISOString(),
    description: over.description ?? { text: 'wish me luck at the interview' },
    ...over,
  };
}

// ── candidate selection (pure gates) ───────────────────────────────────────

test('selects aged audio with a transcript; skips young / stripped / kept / image', async () => {
  const assets = [
    audio({ id: 'old' }),                                           // eligible
    audio({ id: 'young', receivedAt: new Date(NOW - 2 * DAY).toISOString() }),  // inside window
    audio({ id: 'stripped', audio: { deletedAt: 'x' } }),          // already transcript-only
    audio({ id: 'kept', audio: { keep: true } }),                  // I chose to keep this
    audio({ id: 'notranscript', description: { text: '  ' } }),     // nothing to judge by
    { id: 'img', kind: 'image', receivedAt: new Date(NOW - 90 * DAY).toISOString() }, // never audio
  ];
  const got = await selectRetentionCandidates({ now: NOW, retentionDays: 14, listAssetsFn: async () => assets });
  assert.deepEqual(got.map(m => m.id), ['old'], 'only the aged, un-stripped, un-kept, transcribed clip');
});

test('retentionDays 0 makes everything past its receipt eligible; a huge window makes nothing', async () => {
  const assets = [audio({ id: 'x', receivedAt: new Date(NOW - 1 * DAY).toISOString() })];
  assert.equal((await selectRetentionCandidates({ now: NOW, retentionDays: 0, listAssetsFn: async () => assets })).length, 1);
  assert.equal((await selectRetentionCandidates({ now: NOW, retentionDays: 3650, listAssetsFn: async () => assets })).length, 0);
});

// ── the judgment → apply loop (injected LLM + strip/keep) ───────────────────

test('keeps the sounds the judgment names, lets the rest go to transcript', async () => {
  const assets = [
    audio({ id: 'a', slugs: ['a-laugh-x1'], description: { text: 'a long warm laugh' } }),
    audio({ id: 'b', slugs: ['milk-x2'], description: { text: "don't forget the milk" } }),
  ];
  const stripped = [], kept = [];
  const r = await runMediaRetention({
    settings: { voiceNoteRetentionDays: 14 },
    now: NOW,
    selectFn: (o) => selectRetentionCandidates({ ...o, listAssetsFn: async () => assets }),
    llmFn: async () => JSON.stringify({ keep: ['a-laugh-x1'] }),
    stripFn: async (ref) => { stripped.push(ref); return { ok: true }; },
    keepFn: async (ref) => { kept.push(ref); return { ok: true }; },
  });
  assert.equal(r.kept, 1);
  assert.equal(r.stripped, 1);
  assert.deepEqual(kept, ['a-laugh-x1'], 'the laugh is kept by its slug');
  assert.deepEqual(stripped, ['milk-x2'], 'the errand reminder drops to transcript');
});

test('a garbled judgment keeps EVERYTHING — a wrong response never strips a sound', async () => {
  const assets = [audio({ id: 'a' })];
  const stripped = [];
  const r = await runMediaRetention({
    settings: {},
    now: NOW,
    selectFn: (o) => selectRetentionCandidates({ ...o, listAssetsFn: async () => assets }),
    llmFn: async () => 'sorry, I could not decide',   // no JSON at all
    stripFn: async (ref) => { stripped.push(ref); return { ok: true }; },
    keepFn: async () => ({ ok: true }),
  });
  assert.equal(r.stripped, 0, 'nothing stripped on an unparseable judgment');
  assert.deepEqual(stripped, []);
  assert.equal(r.reason, 'judgment-unparseable');
});

test('an LLM error keeps everything this pass (never strips on doubt)', async () => {
  const assets = [audio({ id: 'a' })];
  const stripped = [];
  const r = await runMediaRetention({
    settings: {}, now: NOW,
    selectFn: (o) => selectRetentionCandidates({ ...o, listAssetsFn: async () => assets }),
    llmFn: async () => { throw new Error('provider down'); },
    stripFn: async (ref) => { stripped.push(ref); return { ok: true }; },
    keepFn: async () => ({ ok: true }),
  });
  assert.equal(r.ok, false);
  assert.deepEqual(stripped, []);
});

test('no candidates → a clean no-op', async () => {
  const r = await runMediaRetention({ settings: {}, now: NOW, selectFn: async () => [] });
  assert.deepEqual(r, { ok: true, considered: 0, kept: 0, stripped: 0 });
});

// ── parseKeepRefs contract (valid-empty vs unparseable) ─────────────────────

test('parseKeepRefs: valid JSON → Set (possibly empty); unparseable → null', () => {
  assert.deepEqual([...parseKeepRefs('{"keep":["x","y"]}')], ['x', 'y']);
  assert.equal(parseKeepRefs('{"keep":[]}').size, 0, 'valid "keep none" is an empty Set, not null');
  assert.equal(parseKeepRefs('no json here'), null, 'no object → null (keep-all fallback)');
  assert.equal(parseKeepRefs('{"other":1}'), null, 'object without keep → null (ambiguous, keep all)');
  // tolerates fences / surrounding prose
  assert.deepEqual([...parseKeepRefs('here you go:\n```json\n{"keep":["z"]}\n```')], ['z']);
});
