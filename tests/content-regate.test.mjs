import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectBatch, parseRetagDecision, summarizeCircles, buildRetagPrompt,
  runOneRetagTick,
} from '../src/memory/content-regate.js';
import { AUDIENCE_TAG_WARD_OPEN } from '../src/village/audience.js';

// ── selectBatch ──────────────────────────────────────────────────────

test('selectBatch: filters out reviewed ids and caps to batchSize', () => {
  const candidates = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const reviewed = new Set(['b']);
  const batch = selectBatch(candidates, reviewed, 2);
  assert.deepEqual(batch.map(c => c.id), ['a', 'c']);
});

test('selectBatch: no cap needed when fewer candidates than batchSize', () => {
  const candidates = [{ id: 'a' }, { id: 'b' }];
  const batch = selectBatch(candidates, new Set(), 12);
  assert.deepEqual(batch.map(c => c.id), ['a', 'b']);
});

test('selectBatch: handles empty/undefined candidates and reviewed set', () => {
  assert.deepEqual(selectBatch([], undefined, 5), []);
  assert.deepEqual(selectBatch(undefined, undefined, 5), []);
  assert.deepEqual(selectBatch(null, new Set(), 5), []);
});

test('selectBatch: accepts a plain array/iterable as reviewedSet too', () => {
  const candidates = [{ id: 'a' }, { id: 'b' }];
  const batch = selectBatch(candidates, ['a'], 5);
  assert.deepEqual(batch.map(c => c.id), ['b']);
});

// ── parseRetagDecision ───────────────────────────────────────────────

test('parseRetagDecision: valid open with a valid content_tag', () => {
  const valid = new Set(['m1']);
  const out = parseRetagDecision(
    JSON.stringify([{ id: 'm1', decision: 'open', content_tag: 'medical:sensitive' }]),
    valid,
  );
  assert.deepEqual(out.get('m1'), { decision: 'open', contentTag: 'medical:sensitive' });
});

test('parseRetagDecision: valid keep (no content_tag)', () => {
  const valid = new Set(['m1']);
  const out = parseRetagDecision(JSON.stringify([{ id: 'm1', decision: 'keep' }]), valid);
  assert.deepEqual(out.get('m1'), { decision: 'keep', contentTag: null });
});

test('parseRetagDecision: an id not in validIds is dropped entirely', () => {
  const valid = new Set(['m1']);
  const out = parseRetagDecision(
    JSON.stringify([{ id: 'm1', decision: 'open' }, { id: 'm-unknown', decision: 'open' }]),
    valid,
  );
  assert.equal(out.has('m-unknown'), false);
  assert.equal(out.size, 1);
});

test('parseRetagDecision: decision "maybe" (not a clean "open") → treated as keep', () => {
  const valid = new Set(['m1']);
  const out = parseRetagDecision(JSON.stringify([{ id: 'm1', decision: 'maybe' }]), valid);
  assert.deepEqual(out.get('m1'), { decision: 'keep', contentTag: null });
});

test('parseRetagDecision: "OPEN" (any case) still counts as open', () => {
  const valid = new Set(['m1']);
  const out = parseRetagDecision(JSON.stringify([{ id: 'm1', decision: 'OPEN' }]), valid);
  assert.equal(out.get('m1').decision, 'open');
});

test('parseRetagDecision: a bad content_tag ("bogus:nonsense") is dropped but decision still parses', () => {
  const valid = new Set(['m1']);
  const out = parseRetagDecision(
    JSON.stringify([{ id: 'm1', decision: 'open', content_tag: 'bogus:nonsense' }]),
    valid,
  );
  assert.deepEqual(out.get('m1'), { decision: 'open', contentTag: null });
});

test('parseRetagDecision: pure garbage (unparseable) → empty Map', () => {
  const valid = new Set(['m1']);
  assert.equal(parseRetagDecision('not json at all', valid).size, 0);
  assert.equal(parseRetagDecision(undefined, valid).size, 0);
  assert.equal(parseRetagDecision('', valid).size, 0);
});

test('parseRetagDecision: valid JSON that is not an array → empty Map', () => {
  const valid = new Set(['m1']);
  const out = parseRetagDecision(JSON.stringify({ id: 'm1', decision: 'open' }), valid);
  assert.equal(out.size, 0);
});

// ── summarizeCircles ─────────────────────────────────────────────────

test('summarizeCircles: a circle with grants.topics is listed with its topics', () => {
  const registry = {
    categories: [
      { id: 'c1', name: 'Close Friends', grants: { topics: { medical: 'open', general: 'sensitive' } } },
    ],
  };
  const summary = summarizeCircles(registry);
  assert.match(summary, /Close Friends/);
  assert.match(summary, /medical:open/);
  assert.match(summary, /general:sensitive/);
});

test('summarizeCircles: a circle with no grants.topics (e.g. strangers/{}) is dropped', () => {
  const registry = {
    categories: [
      { id: 'strangers', name: 'Strangers', grants: {} },
      { id: 'c1', name: 'Family', grants: { topics: { general: 'open' } } },
    ],
  };
  const summary = summarizeCircles(registry);
  assert.doesNotMatch(summary, /Strangers/);
  assert.match(summary, /Family/);
});

test('summarizeCircles: empty/absent registry → the "(none…)" fallback', () => {
  assert.match(summarizeCircles({}), /none/i);
  assert.match(summarizeCircles(null), /none/i);
  assert.match(summarizeCircles({ categories: [] }), /none/i);
  // also: every category present but none granting a topic
  const registry = { categories: [{ id: 'c1', name: 'Family', grants: {} }] };
  assert.match(summarizeCircles(registry), /none/i);
});

// ── buildRetagPrompt ─────────────────────────────────────────────────

test('buildRetagPrompt: contains each candidate id= and the JSON-array output contract', () => {
  const candidates = [
    { id: 'm1', content: 'Something about my human.', content_tag: 'general:open', date: '2026-01-01' },
    { id: 'm2', content: 'Something else entirely.' },
  ];
  const prompt = buildRetagPrompt({ candidates, circlesSummary: '  (none…)' });
  assert.match(prompt, /id=m1/);
  assert.match(prompt, /id=m2/);
  assert.match(prompt, /\[\{"id":\s*"<the id>",\s*"decision":\s*"keep"\s*\|\s*"open",\s*"content_tag":/);
});

// ── runOneRetagTick ──────────────────────────────────────────────────

function makeState() {
  let reviewed = new Set();
  let notices = [];
  return {
    readReviewed: async () => new Set(reviewed),
    writeReviewed: async (set) => { reviewed = new Set(set); },
    readNotices: async () => notices.slice(),
    writeNotices: async (list) => { notices = list.slice(); },
    getReviewed: () => reviewed,
    getNotices: () => notices,
  };
}

const CANDIDATES = [
  { id: 'm1', content: 'My human mentioned feeling anxious at work.', content_tag: 'mental-health:sensitive', date: '2026-07-01' },
  { id: 'm2', content: 'My human likes tea in the mornings.', content_tag: 'general:open', date: '2026-07-02' },
  { id: 'm3', content: 'My human is on a new medication.', content_tag: 'medical:sensitive', date: '2026-07-03' },
];

test('runOneRetagTick: open two, keep one — result counts, updateMemory calls, notices, reviewed', async () => {
  const state = makeState();
  const updateCalls = [];
  const result = await runOneRetagTick({
    getCandidates: async () => ({ items: CANDIDATES }),
    getRegistry: async () => ({ categories: [] }),
    callLLM: async () => JSON.stringify([
      { id: 'm1', decision: 'open' },
      { id: 'm2', decision: 'open', content_tag: 'mental-health:sensitive' },
      { id: 'm3', decision: 'keep' },
    ]),
    updateMemory: async (args) => { updateCalls.push(args); return { ok: true }; },
    ...state,
  });

  assert.equal(result.opened, 2);
  assert.equal(result.kept, 1);
  assert.equal(result.reviewed, 3);
  assert.deepEqual(result.errors, []);

  const m1Call = updateCalls.find(c => c.id === 'm1');
  assert.deepEqual(m1Call, { id: 'm1', audience: AUDIENCE_TAG_WARD_OPEN });

  const m2Call = updateCalls.find(c => c.id === 'm2');
  assert.deepEqual(m2Call, { id: 'm2', audience: AUDIENCE_TAG_WARD_OPEN, contentTag: 'mental-health:sensitive' });

  // m3 kept — no update call needed since its content_tag wasn't corrected
  assert.equal(updateCalls.some(c => c.id === 'm3'), false);

  const notices = state.getNotices();
  assert.equal(notices.length, 2);
  assert.deepEqual(notices.map(n => n.id).sort(), ['m1', 'm2']);

  const reviewedIds = state.getReviewed();
  assert.deepEqual([...reviewedIds].sort(), ['m1', 'm2', 'm3']);
});

test('runOneRetagTick: conservative default — an id omitted by the LLM is treated as keep', async () => {
  const state = makeState();
  const updateCalls = [];
  const result = await runOneRetagTick({
    getCandidates: async () => ({ items: CANDIDATES }),
    getRegistry: async () => ({ categories: [] }),
    callLLM: async () => JSON.stringify([]),
    updateMemory: async (args) => { updateCalls.push(args); return { ok: true }; },
    ...state,
  });

  assert.equal(result.opened, 0);
  assert.equal(result.kept, 3);
  assert.equal(updateCalls.length, 0);
  assert.deepEqual([...state.getReviewed()].sort(), ['m1', 'm2', 'm3']);
  assert.equal(state.getNotices().length, 0);
});

test('runOneRetagTick: no re-judge — all-reviewed candidates never call the LLM', async () => {
  const state = makeState();
  // Pre-seed reviewed with all candidate ids.
  await state.writeReviewed(new Set(['m1', 'm2', 'm3']));

  const result = await runOneRetagTick({
    getCandidates: async () => ({ items: CANDIDATES }),
    getRegistry: async () => ({ categories: [] }),
    callLLM: async () => { throw new Error('should never be called'); },
    updateMemory: async () => { throw new Error('should never be called'); },
    ...state,
  });

  assert.equal(result.reason, 'all_reviewed');
  assert.equal(result.opened, 0);
  assert.equal(result.kept, 0);
});

test('runOneRetagTick: error retry — a failed updateMemory keeps the id un-reviewed and reports the error', async () => {
  const state = makeState();
  const result = await runOneRetagTick({
    getCandidates: async () => ({ items: CANDIDATES }),
    getRegistry: async () => ({ categories: [] }),
    callLLM: async () => JSON.stringify([
      { id: 'm1', decision: 'open' },
      { id: 'm2', decision: 'keep' },
      { id: 'm3', decision: 'keep' },
    ]),
    updateMemory: async (args) => {
      if (args.id === 'm1') return { ok: false, error: 'boom' };
      return { ok: true };
    },
    ...state,
  });

  assert.equal(result.opened, 0);
  assert.equal(result.kept, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].id, 'm1');
  assert.equal(result.errors[0].error, 'boom');

  // m1 was NOT added to reviewed (retries next tick); m2/m3 were.
  const reviewedIds = state.getReviewed();
  assert.equal(reviewedIds.has('m1'), false);
  assert.equal(reviewedIds.has('m2'), true);
  assert.equal(reviewedIds.has('m3'), true);

  // No disclosure notice for the failed open.
  assert.equal(state.getNotices().length, 0);
});

test('runOneRetagTick: getCandidates throwing degrades to candidates_failed, never throws', async () => {
  const state = makeState();
  const result = await runOneRetagTick({
    getCandidates: async () => { throw new Error('db down'); },
    getRegistry: async () => ({ categories: [] }),
    callLLM: async () => { throw new Error('should never be called'); },
    updateMemory: async () => { throw new Error('should never be called'); },
    ...state,
  });
  assert.equal(result.reason, 'candidates_failed');
  assert.equal(result.opened, 0);
  assert.equal(result.kept, 0);
});

test('runOneRetagTick: callLLM throwing degrades to llm_failed, never throws', async () => {
  const state = makeState();
  const result = await runOneRetagTick({
    getCandidates: async () => ({ items: CANDIDATES }),
    getRegistry: async () => ({ categories: [] }),
    callLLM: async () => { throw new Error('provider down'); },
    updateMemory: async () => { throw new Error('should never be called'); },
    ...state,
  });
  assert.equal(result.reason, 'llm_failed');
  assert.equal(result.opened, 0);
  assert.equal(result.kept, 0);
});

test('runOneRetagTick: no candidates at all → no_candidates, no LLM call', async () => {
  const state = makeState();
  const result = await runOneRetagTick({
    getCandidates: async () => ({ items: [] }),
    getRegistry: async () => ({ categories: [] }),
    callLLM: async () => { throw new Error('should never be called'); },
    updateMemory: async () => { throw new Error('should never be called'); },
    ...state,
  });
  assert.equal(result.reason, 'no_candidates');
});
