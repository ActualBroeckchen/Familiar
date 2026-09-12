import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectCueItems, buildCueBlock, gatherProjectionCandidates,
  MAX_TURNS, MAX_PER_TURN, MAX_WINDOW_MS, MIN_LEAD_MS, LAST_CHANCE_MS,
} from '../src/gcal/gcal-projection.js';

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
  assert.match(block, /my human's schedule/);
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

// ── gatherProjectionCandidates (causal-chain fix, piece 1) ────────

test('gather: a bare upcoming event with runway is a candidate, any source', () => {
  const now = Date.now();
  const when = new Date(now + 2 * MIN_LEAD_MS).toISOString();
  const out = gatherProjectionCandidates({
    window: [{ id: 'ev1', type: 'event', label: 'Dentist', when }],
    edges: [], gcalFlagged: [], now,
  });
  assert.deepEqual(out.map(c => c.id), ['ev1']);
});

test('gather: excludes events already touched by an edge, resolved ones, non-events, and short-runway ones', () => {
  const now = Date.now();
  const far = new Date(now + 2 * MIN_LEAD_MS).toISOString();
  const near = new Date(now + MIN_LEAD_MS / 2).toISOString();
  const out = gatherProjectionCandidates({
    window: [
      { id: 'linked-ev', type: 'event', label: 'Has edge', when: far },
      { id: 'done-ev', type: 'event', label: 'Done', when: far, resolution: 'done' },
      { id: 'a-task', type: 'task', label: 'Not an event', when: far },
      { id: 'soon-ev', type: 'event', label: 'Too soon', when: near },
      { id: 'ok-ev', type: 'event', label: 'Fine', when: far },
    ],
    edges: [{ id: 'e1', src: 'linked-ev', dst: 'somewhere', kind: 'causes' }],
    gcalFlagged: [], now,
  });
  assert.deepEqual(out.map(c => c.id), ['ok-ev']);
});

test('gather: unions gcal-flagged with window candidates, deduped by id', () => {
  const now = Date.now();
  const far = new Date(now + 2 * MIN_LEAD_MS).toISOString();
  const out = gatherProjectionCandidates({
    window: [
      { id: 'both', type: 'event', label: 'In both', when: far },
      { id: 'window-only', type: 'event', label: 'Hand-added', when: far },
    ],
    edges: [],
    gcalFlagged: [
      { id: 'both', label: 'In both', when: far },
      { id: 'gcal-only', label: 'Fresh sync', when: far },
    ],
    now,
  });
  const ids = out.map(c => c.id).sort();
  assert.deepEqual(ids, ['both', 'gcal-only', 'window-only']);
});

test('gather: tolerates missing/garbage inputs', () => {
  assert.deepEqual(gatherProjectionCandidates({}), []);
  assert.deepEqual(gatherProjectionCandidates({ window: null, edges: null, gcalFlagged: null }), []);
  assert.deepEqual(
    gatherProjectionCandidates({ window: [{ type: 'event' }, null], edges: [null], gcalFlagged: [{}] }),
    []);
});

// ── Last-chance pass (causal-chain fix) ───────────────────────────

test('last chance: an aged-out item re-surfaces once when the event is near', () => {
  const now = Date.now();
  const soon = new Date(now + LAST_CHANCE_MS / 2).toISOString();
  const c = { id: 'lc', label: 'Nearly here', when: soon };
  const state = { lc: { firstSeenTs: now - MAX_WINDOW_MS - 1, turnsShown: MAX_TURNS } };
  const first = selectCueItems({ candidates: [c], state, now });
  assert.equal(first.items.length, 1, 'aged-out + near → one more look');
  assert.equal(first.nextState.lc.lastChanceShown, true);
  // Second pass: the one shot is spent.
  const second = selectCueItems({ candidates: [c], state: first.nextState, now });
  assert.equal(second.items.length, 0, 'last chance fires exactly once');
});

test('last chance: does NOT fire for an aged-out item still far out or already past', () => {
  const now = Date.now();
  const state = { far: { firstSeenTs: 0, turnsShown: MAX_TURNS }, past: { firstSeenTs: 0, turnsShown: MAX_TURNS } };
  const r = selectCueItems({
    candidates: [
      { id: 'far', label: 'Far', when: new Date(now + LAST_CHANCE_MS * 2).toISOString() },
      { id: 'past', label: 'Past', when: new Date(now - 3600_000).toISOString() },
    ],
    state, now,
  });
  assert.equal(r.items.length, 0);
});
