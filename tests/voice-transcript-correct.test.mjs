import { test } from 'node:test';
import assert from 'node:assert/strict';

import { correctTranscript } from '../voice-transcribe.js';

/** A stubbed asset store: records what would be written, returns the merged meta. */
function store(meta) {
  const rec = { saved: null, opts: null };
  return {
    rec,
    getMeta: async () => meta,
    save: async (id, description, opts) => {
      rec.saved = description;
      rec.opts = opts;
      return { ...meta, id, description, slugs: ['wish-me-luck-a1', ...(meta.slugs ?? [])] };
    },
  };
}

const audio = (description = null, slugs = ['snd-4kf2p1']) =>
  ({ id: 'a1', kind: 'audio', slugs, description });

test('a correction replaces the transcript everything downstream reads', async () => {
  const s = store(audio({ text: 'Wish May Look', lang: 'en', at: '2026-01-01T00:00:00Z' }));
  const r = await correctTranscript('a1', '  Wish me luck  ', s);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'Wish me luck', 'trimmed and stored');
  assert.equal(s.rec.saved.text, 'Wish me luck');
});

test('what I actually heard is kept, not overwritten', async () => {
  const s = store(audio({ text: 'Wish May Look', lang: 'en' }));
  await correctTranscript('a1', 'Wish me luck', s);
  assert.equal(s.rec.saved.auto, 'Wish May Look', 'the machine transcript survives the correction');
  assert.equal(s.rec.saved.corrected, true);
  assert.match(s.rec.saved.correctedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(s.rec.saved.lang, 'en', 'unrelated fields are preserved');
});

test('correcting twice keeps the ORIGINAL machine transcript as auto', async () => {
  // The second correction must not record my human's first wording as "what I
  // heard" — that would erase the only record of my actual hearing.
  const s = store(audio({ text: 'Wish me lock', auto: 'Wish May Look', corrected: true }));
  await correctTranscript('a1', 'Wish me luck', s);
  assert.equal(s.rec.saved.auto, 'Wish May Look');
  assert.equal(s.rec.saved.text, 'Wish me luck');
});

test('a note that was silence or unreadable stops being rendered as a failure', async () => {
  const s = store(audio({ text: '', reason: 'no-speech', at: '2026-01-01T00:00:00Z' }));
  const r = await correctTranscript('a1', 'the bins go out tonight', s);
  assert.equal(r.ok, true);
  assert.equal('reason' in s.rec.saved, false, 'the failure reason is cleared, not kept beside real words');
  assert.equal(s.rec.saved.text, 'the bins go out tonight');
});

test('the slug re-graduates so a mis-heard note becomes findable by what was said', async () => {
  const s = store(audio({ text: 'Wish May Look' }, ['wish-may-look-x7', 'snd-4kf2p1']));
  const r = await correctTranscript('a1', 'Wish me luck', s);
  assert.equal(s.rec.opts?.regraduate, true, 'correction asks for a fresh, meaning-bearing slug');
  assert.equal(r.slug, 'wish-me-luck-a1');
});

test('an empty correction is refused rather than blanking the transcript', async () => {
  const s = store(audio({ text: 'something real' }));
  for (const bad of ['', '   ', null, undefined, 42]) {
    const r = await correctTranscript('a1', bad, s);
    assert.equal(r.ok, false, `rejected: ${String(bad)}`);
    assert.equal(r.reason, 'empty');
  }
  assert.equal(s.rec.saved, null, 'nothing was written');
});

test('an absurdly long body is refused', async () => {
  const s = store(audio({ text: 'x' }));
  const r = await correctTranscript('a1', 'y'.repeat(20001), s);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too-long');
  assert.equal(s.rec.saved, null);
});

test('only audio can be corrected, and a missing asset says so', async () => {
  const img = store({ id: 'i1', kind: 'image', slugs: ['img-aaaaaa'], description: { text: 'a cat' } });
  assert.equal((await correctTranscript('i1', 'not a transcript', img)).reason, 'not-audio');
  assert.equal(img.rec.saved, null);

  const missing = { getMeta: async () => null, save: async () => { throw new Error('must not be called'); } };
  assert.equal((await correctTranscript('nope', 'words', missing)).reason, 'not-found');
});

test('a failed write is reported, never silently swallowed', async () => {
  const s = {
    getMeta: async () => audio({ text: 'old' }),
    save: async () => ({ ok: false, error: 'disk full' }),
  };
  const r = await correctTranscript('a1', 'new words', s);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'write-failed');
  assert.match(r.detail, /disk full/);
});
