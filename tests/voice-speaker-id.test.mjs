import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cosineSimilarity, l2normalize, norm, averageEmbeddings } from '../voice-embedding.js';
import {
  readVoiceprints, setWardPrint, getWardPrint, deleteWardPrint,
  setVillagerPrint, getVillagerPrint, deleteVillagerPrint, listVillagerPrints, enrolledPrints,
} from '../voiceprints.js';
import { createGuestWatchdog, GUEST_DEFAULTS } from '../voice-guest-watchdog.js';
import { createDiarizer } from '../voice-diarize.js';

// ── voice-embedding: the pure math everything else stands on ───────────────

test('cosineSimilarity: identical vectors → 1, opposite → -1, orthogonal → 0', () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-9);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('cosineSimilarity never throws or NaNs on garbage — returns 0 (the safe "no match")', () => {
  assert.equal(cosineSimilarity(null, [1]), 0);
  assert.equal(cosineSimilarity([1, 2], [1]), 0, 'length mismatch');
  assert.equal(cosineSimilarity([0, 0], [0, 0]), 0, 'zero vectors');
  assert.equal(cosineSimilarity([1, NaN], [1, 1]), 0, 'a NaN component fails safe');
  assert.equal(cosineSimilarity([], []), 0);
});

test('averageEmbeddings means then re-normalises; skips malformed rows', () => {
  const avg = averageEmbeddings([[1, 0], [0, 1]]);
  assert.ok(Math.abs(norm(avg) - 1) < 1e-9, 'unit length');
  assert.ok(Math.abs(avg[0] - avg[1]) < 1e-9, 'symmetric inputs → symmetric output');
  assert.deepEqual(averageEmbeddings([]), []);
  assert.deepEqual(averageEmbeddings([[1, 0], [1, 2, 3]]).length, 2, 'wrong-dim row dropped, not crashing');
});

test('l2normalize returns unit length, leaves a zero vector as zeros', () => {
  assert.ok(Math.abs(norm(l2normalize([3, 4])) - 1) < 1e-9);
  assert.deepEqual(l2normalize([0, 0]), [0, 0]);
});

// ── voiceprints: the local biometric store ─────────────────────────────────

async function tmpStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-'));
  return { file: path.join(dir, '.voiceprints.json'), cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test('ward print: enrol from a list (averaged), read back, delete', async () => {
  const { file, cleanup } = await tmpStore();
  try {
    assert.equal(await getWardPrint({ file }), null, 'no print before enrol');
    const r = await setWardPrint([[1, 0, 0], [1, 0, 0], [0.9, 0.1, 0]], {}, { file });
    assert.ok(r.ok);
    const print = await getWardPrint({ file });
    assert.ok(Array.isArray(print) && print.length === 3);
    await deleteWardPrint({ file });
    assert.equal(await getWardPrint({ file }), null, 'gone after delete');
  } finally { await cleanup(); }
});

test('villager prints are opt-in, listed without vectors, and separable from the ward', async () => {
  const { file, cleanup } = await tmpStore();
  try {
    await setWardPrint([[1, 0, 0]], {}, { file });
    await setVillagerPrint('mira', [[0, 1, 0]], { name: 'Mira' }, { file });
    assert.ok(await getVillagerPrint('mira', { file }));
    const list = await listVillagerPrints({ file });
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'Mira');
    assert.equal(list[0].embedding, undefined, 'the list never leaks the raw vector');

    const enrolled = await enrolledPrints({ file });
    assert.deepEqual(enrolled.map(p => p.ref).sort(), ['mira', 'ward']);

    await deleteVillagerPrint('mira', { file });
    assert.equal(await getVillagerPrint('mira', { file }), null);
    assert.ok(await getWardPrint({ file }), 'deleting a villager leaves the ward untouched');
  } finally { await cleanup(); }
});

test('voiceprints never throw on a missing/corrupt file', async () => {
  assert.deepEqual(await readVoiceprints({ file: '/definitely/nope/.voiceprints.json' }), { ward: null, villagers: {} });
  const { file, cleanup } = await tmpStore();
  try {
    await fs.writeFile(file, 'not json{{');
    assert.deepEqual(await readVoiceprints({ file }), { ward: null, villagers: {} });
    assert.equal(await getWardPrint({ file }), null);
  } finally { await cleanup(); }
});

// ── guest watchdog: the privacy state machine (safety-critical) ─────────────

const WARD = 0.9;   // a ward-matched segment's similarity (>= threshold 0.5)
const GUEST = 0.1;  // a non-ward segment's similarity (< threshold)

test('watchdog ENTERS only after N consecutive non-ward segments, not one blip', () => {
  const w = createGuestWatchdog({ now: () => 1000 });
  assert.equal(w.observe({ similarity: GUEST }).transition, null, '1 blip is a sneeze, not a guest');
  assert.equal(w.observe({ similarity: WARD }).transition, null, 'ward resets the run');
  assert.equal(w.observe({ similarity: GUEST }).transition, null);
  assert.equal(w.observe({ similarity: GUEST }).transition, null);
  const r = w.observe({ similarity: GUEST });   // 3rd consecutive
  assert.equal(r.transition, 'entered');
  assert.equal(r.state, 'guest');
});

test('watchdog RELEASE needs BOTH M ward segments AND the quiet window', () => {
  let t = 0; const w = createGuestWatchdog({ now: () => t });
  for (let i = 0; i < 3; i++) { t += 1000; w.observe({ similarity: GUEST, ts: t }); }  // enter
  assert.equal(w.snapshot().state, 'guest');
  // 6 ward segments but only seconds after the guest — quiet window NOT met.
  let last;
  for (let i = 0; i < 6; i++) { t += 1000; last = w.observe({ similarity: WARD, ts: t }); }
  assert.equal(last.transition, null, 'ward is talking, but the guest was heard <90s ago — hold');
  // Now jump past the quiet window and give one more ward segment.
  t += GUEST_DEFAULTS.exitQuietSec * 1000 + 1000;
  const r = w.observe({ similarity: WARD, ts: t });
  assert.equal(r.transition, 'released');
  assert.equal(r.state, 'clear');
});

test('a non-ward blip during release resets BOTH the ward run and the quiet clock', () => {
  let t = 0; const w = createGuestWatchdog({ now: () => t });
  for (let i = 0; i < 3; i++) { t += 1000; w.observe({ similarity: GUEST, ts: t }); }
  for (let i = 0; i < 5; i++) { t += 1000; w.observe({ similarity: WARD, ts: t }); }
  t += 1000; w.observe({ similarity: GUEST, ts: t });   // guest speaks again → reset
  t += GUEST_DEFAULTS.exitQuietSec * 1000 + 1000;
  for (let i = 0; i < 5; i++) { t += 1000; assert.equal(w.observe({ similarity: WARD, ts: t }).transition, null); }
  const r = w.observe({ similarity: WARD, ts: t + 1000 });  // 6th ward after the reset
  assert.equal(r.transition, 'released', 'needs a fresh run of 6 after the guest reappeared');
});

test('spoken release is instant — but only in a segment that matches the ward print', () => {
  let t = 0; const w = createGuestWatchdog({ now: () => t });
  for (let i = 0; i < 3; i++) { t += 1000; w.observe({ similarity: GUEST, ts: t }); }
  // A release phrase in a NON-ward segment cannot fake the release.
  assert.equal(w.observe({ similarity: GUEST, ts: ++t, releasePhrase: true }).transition, null);
  // The ward saying it releases immediately, no quiet window needed.
  const r = w.observe({ similarity: WARD, ts: ++t, releasePhrase: true });
  assert.equal(r.transition, 'released');
  assert.equal(r.reason, 'spoken');
});

test('forceRelease (UI) clears immediately, and is a no-op when already clear', () => {
  const w = createGuestWatchdog({ now: () => 1 });
  assert.equal(w.forceRelease().transition, null, 'nothing to release when clear');
  for (let i = 0; i < 3; i++) w.observe({ similarity: GUEST });
  assert.equal(w.forceRelease('manual').transition, 'released');
});

// ── diarizer: known voices vs guests on a mixed stream ──────────────────────

test('diarizer matches enrolled prints; unknown voices become distinct guests', () => {
  const prints = [
    { ref: 'ward', name: 'ward', embedding: [1, 0, 0] },
    { ref: 'mira', name: 'Mira', embedding: [0, 1, 0] },
  ];
  const d = createDiarizer({ prints, now: () => 1 });
  assert.equal(d.assign([0.95, 0.05, 0]).ref, 'ward', 'close to the ward print');
  assert.equal(d.assign([0.02, 0.98, 0]).ref, 'mira');
  const g1 = d.assign([0, 0, 1]);   // nobody enrolled sounds like this
  assert.equal(g1.source, 'new');
  assert.match(g1.ref, /^guest-\d+$/);
  // The same unknown voice again folds into the SAME guest cluster, not a new one.
  const g1again = d.assign([0, 0.02, 0.98]);
  assert.equal(g1again.ref, g1.ref, 'one guest stays one guest');
  // A different unknown voice is a different guest.
  const g2 = d.assign([0.7, 0.7, 0.1]);
  assert.notEqual(g2.ref, g1.ref);
});

test('diarizer with no prints treats everyone as a guest (fail-closed to stranger-tier)', () => {
  const d = createDiarizer({ prints: [], now: () => 1 });
  assert.equal(d.assign([1, 0, 0]).source, 'new');
});

test('diarizer never throws on a bad embedding', () => {
  const d = createDiarizer({ prints: [{ ref: 'ward', name: 'ward', embedding: [1, 0] }], now: () => 1 });
  assert.doesNotThrow(() => d.assign(null));
  assert.doesNotThrow(() => d.assign([]));
});
