import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createVoiceTurnRunner } from '../voice-call-turn.js';

const tick = () => new Promise((r) => setTimeout(r, 5));
/** A recognisable async-iterable of PCM, so we can assert synthesize's output flows through. */
async function* pcmStream() { yield Buffer.alloc(10); }

function make(overrides = {}) {
  const rec = { scored: [], ran: [], synth: [] };
  const deps = {
    runTurn: async (t, ctx) => { rec.ran.push({ t, ctx }); return `reply to ${t}`; },
    synthesize: (text) => { rec.synth.push(text); return pcmStream(); },
    speakable: (t) => ({ text: t }),
    scoreThreat: (t, ctx) => { rec.scored.push({ t, ctx }); },
    threatEnabled: () => true,
    log: () => {},
    ...overrides,
  };
  return { rec, onTurn: createVoiceTurnRunner(deps) };
}

test('an empty transcript is a no-op: no scoring, no turn, no speech', async () => {
  const { rec, onTurn } = make();
  assert.equal(await onTurn('   ', { speakerRef: 'ward' }), null);
  assert.deepEqual(rec.ran, []);
  assert.deepEqual(rec.scored, []);
  assert.deepEqual(rec.synth, []);
});

test('the happy path: score → run → speakable → synthesize, returning the PCM stream', async () => {
  const { rec, onTurn } = make();
  const out = await onTurn('hello', { speakerRef: 'ward' });
  assert.equal(rec.scored[0].t, 'hello', 'the transcript was scored');
  assert.equal(rec.ran[0].t, 'hello');
  assert.equal(rec.synth[0], 'reply to hello', 'the speakable reply was synthesized');
  assert.equal(typeof out[Symbol.asyncIterator], 'function', 'the PCM stream is returned to the adapter');
});

// ── D2 gate: the safety-critical behaviour ───────────────────────────────

test('D2: a non-ward speaker never moves the threat tier, but the turn still runs', async () => {
  const { rec, onTurn } = make();
  await onTurn('hi', { speakerRef: 'villager:mara' });
  assert.deepEqual(rec.scored, [], 'a villager voice is never scored');
  assert.equal(rec.ran.length, 1, 'the turn still happens');
});

test('D2: with scoring disabled, the ward is not scored either', async () => {
  const { rec, onTurn } = make({ threatEnabled: () => false });
  await onTurn('hi', { speakerRef: 'ward' });
  assert.deepEqual(rec.scored, []);
  assert.equal(rec.ran.length, 1);
});

test('D2: threat scoring never blocks or breaks the reply', async () => {
  // A throwing scorer (sync) and a rejecting one (async) both leave the turn intact.
  for (const scoreThreat of [
    () => { throw new Error('sync boom'); },
    () => Promise.reject(new Error('async boom')),
  ]) {
    const { rec, onTurn } = make({ scoreThreat });
    const out = await onTurn('hello', { speakerRef: 'ward' });
    await tick();
    assert.equal(rec.ran.length, 1, 'the turn ran despite the scorer failing');
    assert.ok(out, 'a reply was still produced');
  }
});

test('scoreThreat is optional — a runner without it still works', async () => {
  const { rec, onTurn } = make({ scoreThreat: null });
  const out = await onTurn('hello', { speakerRef: 'ward' });
  assert.ok(out);
  assert.equal(rec.ran.length, 1);
});

// ── Graceful degradation ─────────────────────────────────────────────────

test('a reply with nothing to say is a valid silent turn (null, no synth)', async () => {
  const { rec, onTurn } = make({ runTurn: async () => '   ' });
  assert.equal(await onTurn('hello', { speakerRef: 'ward' }), null);
  assert.deepEqual(rec.synth, [], 'nothing is synthesized for an empty reply');
});

test('a turn that throws degrades to silence, not a crash', async () => {
  const { rec, onTurn } = make({ runTurn: async () => { throw new Error('provider down'); } });
  assert.equal(await onTurn('hello', { speakerRef: 'ward' }), null);
  assert.deepEqual(rec.synth, []);
});

test('speakable shapes the text that is synthesized', async () => {
  // speakable is the outgoing boundary — markdown/stage-directions stripped, etc.
  const { rec, onTurn } = make({
    runTurn: async () => '**hi** there',
    speakable: (t) => ({ text: t.replace(/\*\*/g, '') }),
  });
  await onTurn('hello', { speakerRef: 'ward' });
  assert.equal(rec.synth[0], 'hi there', 'synthesize receives the speakable form, not the raw reply');
});
