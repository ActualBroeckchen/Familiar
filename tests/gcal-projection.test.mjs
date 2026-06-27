import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectCueItems, buildCueBlock, MAX_TURNS, MAX_PER_TURN, MAX_WINDOW_MS,
} from '../gcal-projection.js';

const cand = (id, label = id) => ({ id, label, when: new Date(Date.now() + 3 * 3600_000).toISOString() });

test('caps the number surfaced per turn', () => {
  const candidates = Array.from({ length: 10 }, (_, i) => cand(`n${i}`));
  const { items } = selectCueItems({ candidates, state: {}, now: 1000 });
  assert.equal(items.length, MAX_PER_TURN);
});

test('an item ages out after MAX_TURNS live turns', () => {
  let state = {};
  const candidates = [cand('a')];
  for (let i = 0; i < MAX_TURNS; i++) {
    const r = selectCueItems({ candidates, state, now: 1000 + i });
    assert.equal(r.items.length, 1, `turn ${i} should still surface`);
    state = r.nextState;
  }
  // MAX_TURNS+1: aged out.
  const r = selectCueItems({ candidates, state, now: 2000 });
  assert.equal(r.items.length, 0);
});

test('an item ages out after the time window even with turns left', () => {
  const state = { a: { firstSeenTs: 0, turnsShown: 1 } };
  const r = selectCueItems({ candidates: [cand('a')], state, now: MAX_WINDOW_MS + 1 });
  assert.equal(r.items.length, 0);
});

test('auto-clear: an item that disappears from candidates is pruned from state', () => {
  const state = { gone: { firstSeenTs: 0, turnsShown: 1 }, here: { firstSeenTs: 0, turnsShown: 1 } };
  const { nextState } = selectCueItems({ candidates: [cand('here')], state, now: 100 });
  assert.ok(!('gone' in nextState), 'a node Unruh no longer returns is dropped');
  assert.ok('here' in nextState);
});

test('only surfaced items advance their turn count', () => {
  const candidates = Array.from({ length: 5 }, (_, i) => cand(`n${i}`));
  const { items, nextState } = selectCueItems({ candidates, state: {}, now: 1 });
  // The 3 surfaced got a count; the 2 over-cap have no state entry yet.
  for (const it of items) assert.equal(nextState[it.id].turnsShown, 1);
  const unsurfaced = candidates.filter(c => !items.find(i => i.id === c.id));
  for (const u of unsurfaced) assert.ok(!(u.id in nextState));
});

test('buildCueBlock: first-person, literal "my human", no bias language', () => {
  const block = buildCueBlock([{ id: 'x1', label: 'Dentist', when: new Date(Date.now() + 3 * 3600_000).toISOString() }]);
  assert.match(block, /my human's calendar/);
  assert.match(block, /Dentist/);
  assert.match(block, /\[id: x1\]/);
  assert.match(block, /schedule_link/);
  assert.match(block, /for now/);              // "done for now", not "never touch"
  assert.doesNotMatch(block, /the user/);      // never "the user"
  assert.doesNotMatch(block, /bias toward|only reach out when|err on the side/i);
});

test('buildCueBlock empty for no items', () => {
  assert.equal(buildCueBlock([]), '');
  assert.equal(buildCueBlock(null), '');
});
