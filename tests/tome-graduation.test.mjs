import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectCandidates,
  parseGraduationDecision,
  routeDecision,
  tidyEntry,
  runOneGraduationTick,
} from '../tome-graduation.js';

const entry = (over = {}) => ({ uid: over.uid ?? 'u1', content: 'a fact', enabled: true, ...over });

// ── selectCandidates ─────────────────────────────────────────────
test('selectCandidates skips excluded, disabled, reviewed, and empty entries', () => {
  const tomes = [
    { file: 'a.json', tome: { name: 'Knowledge', enabled: true, entries: {
      good:     entry({ uid: 'good', content: 'real fact' }),
      reviewed: entry({ uid: 'reviewed', content: 'x', graduationReviewedAt: '2026-01-01' }),
      off:      entry({ uid: 'off', content: 'x', enabled: false }),
      empty:    entry({ uid: 'empty', content: '   ' }),
    } } },
    { file: 'p.json', tome: { name: "Familiar's Ponderings", enabled: true, entries: { x: entry({ uid: 'x' }) } } },
    { file: 's.json', tome: { name: 'Session Memories', enabled: true, entries: { y: entry({ uid: 'y' }) } } },
    { file: 'd.json', tome: { name: 'Disabled', enabled: false, entries: { z: entry({ uid: 'z' }) } } },
  ];
  const got = selectCandidates(tomes);
  assert.deepEqual(got.map(c => c.uid), ['good']);
});

test('selectCandidates respects batchSize', () => {
  const entries = {}; for (let i = 0; i < 10; i++) entries[`u${i}`] = entry({ uid: `u${i}`, content: `f${i}` });
  const got = selectCandidates([{ file: 'a.json', tome: { name: 'K', entries } }], { batchSize: 3 });
  assert.equal(got.length, 3);
});

// ── parseGraduationDecision ──────────────────────────────────────
test('parseGraduationDecision parses, normalises, and defaults unknown home to tome', () => {
  const raw = 'prose… [{"uid":"a","home":"ward","content":"x","already_held":false},{"uid":"b","home":"wat"},{"uid":"c","home":"memory","already_held":true}] trailing';
  const m = parseGraduationDecision(raw);
  assert.equal(m.get('a').home, 'ward');
  assert.equal(m.get('b').home, 'tome');     // unknown → safe default
  assert.equal(m.get('c').alreadyHeld, true);
});

test('parseGraduationDecision returns empty map on garbage', () => {
  assert.equal(parseGraduationDecision('not json').size, 0);
});

// ── routeDecision ────────────────────────────────────────────────
test('routeDecision writes identity for an identity home', async () => {
  const calls = [];
  const deps = { appendIdentity: async (a) => { calls.push(['id', a]); return { ok: true }; } };
  const r = await routeDecision({ home: 'self', content: 'I value honesty', filename: 'my_identity.md' }, {}, deps);
  assert.equal(r.ok, true);
  assert.equal(calls[0][1].category, 'self');
  assert.equal(calls[0][1].filename, 'my_identity.md');
});

test('routeDecision routes memory through the consent greenlight', async () => {
  let got = null;
  const deps = { createMemoryFull: async (a) => { got = a; return { ok: true }; } };
  const r = await routeDecision({ home: 'memory', content: 'the day X happened', granularity: 'significant' }, {}, deps);
  assert.equal(r.ok, true);
  assert.equal(got.consent_pending, true);    // ward long-term memory is consent-gated
});

test('routeDecision does not write for tome / already-held', async () => {
  let wrote = false;
  const deps = { appendIdentity: async () => { wrote = true; }, createMemoryFull: async () => { wrote = true; } };
  assert.equal((await routeDecision({ home: 'tome' }, {}, deps)).wrote, false);
  assert.equal((await routeDecision({ home: 'ward', alreadyHeld: true, content: 'x' }, {}, deps)).wrote, false);
  assert.equal(wrote, false);
});

// ── routeDecision: graph (resolve-or-create + edge dedup) ────────
test('routeDecision (graph) reuses an existing node, creates a missing one, wires the edge', async () => {
  const created = [];
  const edges = [];
  const deps = {
    searchGraphNodes: async ({ query }) =>
      query.toLowerCase() === 'chen'
        ? { results: [{ node: { id: 'chen-id', label: 'Chen' }, score: 0.9 }] }
        : { results: [] },
    createGraphNode: async ({ label }) => { created.push(label); return { ok: true, id: `${label}-id` }; },
    getGraphSubgraph: async () => ({ nodes: [], edges: [] }),
    createGraphEdge: async (e) => { edges.push(e); return { ok: true, id: 'e1' }; },
  };
  const r = await routeDecision({ home: 'graph', relations: [
    { subject: { label: 'Chen', type: 'person' }, edge: 'lives_in', object: { label: 'Berlin', type: 'place' } },
  ] }, {}, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(created, ['Berlin']);            // Chen reused, Berlin created
  assert.deepEqual(edges[0], { fromId: 'chen-id', toId: 'Berlin-id', type: 'lives_in' });
});

test('routeDecision (graph) skips an edge that already connects them', async () => {
  const edges = [];
  const deps = {
    searchGraphNodes: async ({ query }) => ({ results: [{ node: { id: `${query.toLowerCase()}-id`, label: query }, score: 1 }] }),
    createGraphNode: async ({ label }) => ({ ok: true, id: `${label}-id` }),
    getGraphSubgraph: async () => ({ nodes: [], edges: [{ id: 'x', toId: 'berlin-id', type: 'lives_in' }] }),
    createGraphEdge: async (e) => { edges.push(e); return { ok: true }; },
  };
  const r = await routeDecision({ home: 'graph', relations: [
    { subject: { label: 'Chen' }, edge: 'lives_in', object: { label: 'Berlin' } },
  ] }, {}, deps);
  assert.equal(r.ok, true);
  assert.equal(edges.length, 0);                    // already connected → no duplicate edge
});

test('routeDecision (graph) fails cleanly on an incomplete relation (entry left to retry)', async () => {
  const r = await routeDecision({ home: 'graph', relations: [{ subject: { label: 'Chen' }, edge: '' }] }, {}, {
    searchGraphNodes: async () => ({ results: [] }), createGraphNode: async () => ({ id: 'x' }),
    getGraphSubgraph: async () => ({ edges: [] }), createGraphEdge: async () => ({ ok: true }),
  });
  assert.equal(r.ok, false);
});

// ── tidyEntry ────────────────────────────────────────────────────
function fakeTome(entries) {
  const store = { 'f.json': { name: 'K', entries } };
  const modify = async (file, fn) => { const out = await fn(store[file]); store[file] = out ?? store[file]; };
  return { store, modify };
}

test('tidyEntry delete removes the entry; pointer leaves a breadcrumb + marks reviewed', async () => {
  const { store, modify } = fakeTome({ u1: entry({ uid: 'u1', content: 'fact' }), u2: entry({ uid: 'u2', content: 'fact2' }) });
  await tidyEntry({ file: 'f.json', uid: 'u1', decision: { home: 'ward' }, mode: 'delete', now: () => 0 }, modify);
  assert.equal(store['f.json'].entries.u1, undefined);

  await tidyEntry({ file: 'f.json', uid: 'u2', decision: { home: 'memory' }, mode: 'pointer', now: () => 0 }, modify);
  assert.match(store['f.json'].entries.u2.content, /Graduated to my memory/);
  assert.ok(store['f.json'].entries.u2.graduationReviewedAt);
});

test('tidyEntry for a stays-tome decision only marks reviewed', async () => {
  const { store, modify } = fakeTome({ u1: entry({ uid: 'u1', content: 'lore' }) });
  await tidyEntry({ file: 'f.json', uid: 'u1', decision: { home: 'tome' }, mode: 'delete', now: () => 0 }, modify);
  assert.equal(store['f.json'].entries.u1.content, 'lore');        // untouched
  assert.ok(store['f.json'].entries.u1.graduationReviewedAt);      // but advanced
});

// ── runOneGraduationTick ─────────────────────────────────────────
test('a failed route leaves the entry intact (not tidied), and retries are possible', async () => {
  const { store, modify } = fakeTome({ u1: entry({ uid: 'u1', content: 'a ward fact' }) });
  const summary = await runOneGraduationTick({
    loadTomes: async () => [{ file: 'f.json', tome: store['f.json'] }],
    decide:    async () => '[{"uid":"u1","home":"ward","content":"x"}]',
    deps:      { appendIdentity: async () => { throw new Error('phylactery down'); } },
    modifyTome: modify,
    tidyMode: 'delete',
  });
  assert.equal(summary.failed, 1);
  assert.equal(summary.graduated, 0);
  assert.ok(store['f.json'].entries.u1);                            // still there for retry
  assert.equal(store['f.json'].entries.u1.graduationReviewedAt, undefined);
});

test('runOneGraduationTick graduates, dedups, and keeps — and tidies only on success', async () => {
  const { store, modify } = fakeTome({
    grad: entry({ uid: 'grad', content: 'lives in Berlin' }),
    dup:  entry({ uid: 'dup',  content: 'already known' }),
    keep: entry({ uid: 'keep', content: 'keyword lore' }),
  });
  const ids = [];
  const summary = await runOneGraduationTick({
    loadTomes: async () => [{ file: 'f.json', tome: store['f.json'] }],
    decide:    async () => JSON.stringify([
      { uid: 'grad', home: 'ward', content: '{{user}} lives in Berlin', filename: 'ward_notes.md' },
      { uid: 'dup',  home: 'ward', already_held: true },
      { uid: 'keep', home: 'tome' },
    ]),
    deps:      { appendIdentity: async (a) => { ids.push(a); return { ok: true }; } },
    modifyTome: modify,
    tidyMode: 'delete',
  });
  assert.deepEqual(
    { g: summary.graduated, d: summary.alreadyHeld, k: summary.keptAsTome, f: summary.failed },
    { g: 1, d: 1, k: 1, f: 0 },
  );
  assert.equal(ids.length, 1);                                      // only the new fact was written
  assert.equal(store['f.json'].entries.grad, undefined);            // graduated → deleted
  assert.equal(store['f.json'].entries.dup, undefined);             // dup → tidied (no write)
  assert.ok(store['f.json'].entries.keep.graduationReviewedAt);     // kept → marked reviewed
});
