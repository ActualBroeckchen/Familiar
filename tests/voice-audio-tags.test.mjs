import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyRoomSounds, TAG_DEFAULTS } from '../voice-audio-tags.js';

const ev = (name, prob) => ({ name, prob });

test('a salient sound above the floor becomes a phrased "what I can hear" line', () => {
  const r = classifyRoomSounds([ev('Dog', 0.8), ev('Bark', 0.7)]);
  assert.match(r.line, /^\[I can hear .* in the room with my human\]$/);
  assert.match(r.line, /a dog barking/);
  assert.deepEqual(r.phrases, ['a dog barking'], 'Dog and Bark fold to ONE phrase, not two');
});

test('human vocalisations are dropped — the room, not the people (safety boundary)', () => {
  for (const label of ['Speech', 'Male speech, man speaking', 'Shout', 'Screaming', 'Crying, sobbing', 'Laughter', 'Baby cry, infant cry', 'Singing']) {
    const r = classifyRoomSounds([ev(label, 0.95)]);
    assert.equal(r.line, null, `${label} must not surface (care-detection territory §8.4 defers)`);
  }
});

test('bare acoustic-environment / generic labels are dropped', () => {
  for (const label of ['Silence', 'Inside, small room', 'Noise', 'Background noise', 'Echo']) {
    assert.equal(classifyRoomSounds([ev(label, 0.99)]).line, null, `${label} is not worth remarking on`);
  }
});

test('below the confidence floor → nothing', () => {
  assert.equal(classifyRoomSounds([ev('Dog', 0.3)]).line, null);
  assert.equal(classifyRoomSounds([ev('Dog', 0.3)], { floor: 0.2 }).line !== null, true, 'a lower floor lets it through');
});

test('several salient sounds are listed as a plain human list, capped at topN', () => {
  const events = [ev('Dog', 0.9), ev('Television', 0.8), ev('Water tap, faucet', 0.7), ev('Vacuum cleaner', 0.6)];
  const r = classifyRoomSounds(events, { topN: 3 });
  assert.equal(r.phrases.length, 3, 'capped at topN');
  assert.match(r.line, / and /, 'the last two are joined with "and"');
  assert.match(r.line, /, /, 'three items use commas');
});

test('dedup: a sound already mentioned this call is not repeated', () => {
  const seen = new Set();
  const first = classifyRoomSounds([ev('Television', 0.9)], { seen });
  assert.match(first.line, /a television/);
  for (const p of first.phrases) seen.add(p);
  const second = classifyRoomSounds([ev('Television', 0.9)], { seen });
  assert.equal(second.line, null, 'the TV is mentioned once, not every utterance');
});

test('an unmapped-but-confident sound is still surfaced honestly, not dropped', () => {
  const r = classifyRoomSounds([ev('Sewing machine', 0.9)]);
  assert.equal(r.line, '[I can hear the sound of sewing machine in the room with my human]');
});

test('a two-item list uses "and", no comma', () => {
  const r = classifyRoomSounds([ev('Dog', 0.9), ev('Rain', 0.8)], { topN: 2 });
  assert.equal(r.phrases.length, 2);
  assert.match(r.line, /a dog barking and rain/);
  assert.doesNotMatch(r.line, /,/);
});

test('empty / malformed input never throws, returns a clean null', () => {
  assert.deepEqual(classifyRoomSounds([]), { line: null, phrases: [] });
  assert.deepEqual(classifyRoomSounds(null), { line: null, phrases: [] });
  assert.deepEqual(classifyRoomSounds([{ name: '', prob: NaN }, { prob: 0.9 }]), { line: null, phrases: [] });
});

test('the default floor is a sane 0.5', () => {
  assert.equal(TAG_DEFAULTS.floor, 0.5);
});
