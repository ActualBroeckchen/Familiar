/**
 * Tests for spine-states.js (temporal-bridges Pass A).
 *
 * Run: node --test tests/spine-states.test.mjs
 *
 * Covers: the sensitive-node predicate + fail-closed strippers (villager
 * privacy), the co-occurrence overlap arithmetic, and the mint/climb/close
 * lifecycle of syncSpineState with fully injected deps (no fs, no MCP).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSensitiveNode,
  stripSensitiveScheduleNodes,
  deriveCooccurrenceEdges,
  decayCrossingMs,
  syncSpineState,
  SPINE_MIN_WEIGHT,
} from '../src/safety/spine-states.js';

// ── isSensitiveNode ────────────────────────────────────────────────

test('isSensitiveNode flags spine and sensitive, not plain nodes', () => {
  assert.equal(isSensitiveNode({ payload: { spine: true } }), true);
  assert.equal(isSensitiveNode({ payload: { sensitive: true } }), true);
  assert.equal(isSensitiveNode({ payload: { spine: false } }), false);
  assert.equal(isSensitiveNode({ payload: {} }), false);
  assert.equal(isSensitiveNode({}), false);
  assert.equal(isSensitiveNode(null), false);
});

// ── stripSensitiveScheduleNodes (villager privacy, fail-closed) ─────

test('stripSensitiveScheduleNodes removes spine nodes and edges touching them', () => {
  const payload = {
    schedule: {
      window: [
        { id: 'ev-1', type: 'event', label: 'interview' },
        { id: 'st-1', type: 'state', label: 'rough stretch', payload: { spine: true } },
      ],
      linked: [
        { id: 'st-2', type: 'state', label: 'crash', payload: { sensitive: true } },
        { id: 'tk-1', type: 'task', label: 'prep' },
      ],
      edges: [
        { id: 'e1', src: 'ev-1', dst: 'st-1', kind: 'co_occurs_with' },  // touches spine → drop
        { id: 'e2', src: 'tk-1', dst: 'ev-1', kind: 'requires' },        // clean → keep
        { id: 'e3', src: 'st-2', dst: 'tk-1', kind: 'causes' },          // touches sensitive → drop
      ],
    },
  };
  const out = stripSensitiveScheduleNodes(payload);
  const winIds = out.schedule.window.map(n => n.id);
  const linkedIds = out.schedule.linked.map(n => n.id);
  const edgeIds = out.schedule.edges.map(e => e.id);
  assert.deepEqual(winIds, ['ev-1']);
  assert.deepEqual(linkedIds, ['tk-1']);
  assert.deepEqual(edgeIds, ['e2']);
});

test('stripSensitiveScheduleNodes tolerates a missing schedule block', () => {
  assert.doesNotThrow(() => stripSensitiveScheduleNodes({}));
  assert.doesNotThrow(() => stripSensitiveScheduleNodes(null));
});

// ── deriveCooccurrenceEdges (overlap arithmetic) ───────────────────

const EP_START = Date.parse('2026-07-02T18:00:00');
const EP_END   = Date.parse('2026-07-03T09:00:00');

test('links an event whose time falls inside the episode', () => {
  const nodes = [{ id: 'session-1', type: 'event', when: '2026-07-02T20:00:00' }];
  assert.deepEqual(deriveCooccurrenceEdges('ep', EP_START, EP_END, nodes), ['session-1']);
});

test('does not link an event outside the episode', () => {
  const nodes = [{ id: 'far', type: 'event', when: '2026-07-10T20:00:00' }];
  assert.deepEqual(deriveCooccurrenceEdges('ep', EP_START, EP_END, nodes), []);
});

test('excludes the episode itself, sensitive states, phases, and holds', () => {
  const nodes = [
    { id: 'ep',    type: 'state', when: '2026-07-02T19:00:00' },                          // self
    { id: 'other', type: 'state', when: '2026-07-02T19:00:00', payload: { spine: true } }, // sensitive
    { id: 'ph',    type: 'phase', when: '2026-07-02T19:00:00' },                          // not linkable
    { id: 'hd',    type: 'hold',  when: '2026-07-02T19:00:00' },                          // not linkable
    { id: 'task',  type: 'task',  when: '2026-07-02T19:00:00' },                          // linkable ✓
  ];
  assert.deepEqual(deriveCooccurrenceEdges('ep', EP_START, EP_END, nodes), ['task']);
});

test('links a recurring anchor when an occurrence lands in the window', () => {
  // Daily anchor stamped months earlier — its when is outside the episode,
  // but an occurrence falls inside, so the anchor links once.
  const nodes = [{
    id: 'dinner', type: 'event', when: '2026-01-01T18:30:00',
    payload: { recurrence: { freq: 'daily' } },
  }];
  assert.deepEqual(deriveCooccurrenceEdges('ep', EP_START, EP_END, nodes), ['dinner']);
});

test('dedupes and caps at 12 edges', () => {
  const nodes = [];
  for (let i = 0; i < 20; i++) nodes.push({ id: `e${i}`, type: 'event', when: '2026-07-02T20:00:00' });
  const out = deriveCooccurrenceEdges('ep', EP_START, EP_END, nodes);
  assert.equal(out.length, 12);
  assert.equal(new Set(out).size, 12);
});

// ── syncSpineState lifecycle (injected deps) ───────────────────────

function makeDeps(initialPointer = null) {
  const calls = { addNode: [], updateNode: [], addEdge: [], getWindow: [] };
  let pointer = initialPointer;
  let nextId = 1;
  return {
    calls,
    getPointer: () => pointer,
    deps: {
      readPointer:  async () => pointer,
      writePointer: async (p) => { pointer = p; },
      addNode: async (args) => { calls.addNode.push(args); return { ok: true, id: `spine-${nextId++}` }; },
      updateNode: async (args) => { calls.updateNode.push(args); return { ok: true }; },
      addEdge: async (args) => { calls.addEdge.push(args); return { ok: true, id: `edge-${nextId++}` }; },
      getWindow: async (args) => { calls.getWindow.push(args); return { nodes: [], linked: [] }; },
      log: () => {},
    },
  };
}

const moderateThreat = { tier: 'moderate', weight: SPINE_MIN_WEIGHT, raw_weight: SPINE_MIN_WEIGHT, last_touched: '2026-07-02T18:00:00Z' };
// A realistic CLOSE reading: effective weight has decayed below moderate,
// but the stored raw (at last_touched) was elevated — so the decay-crossing
// end lands after the last signal, giving a real episode span. Explicit
// nowMs keeps the close deterministic (no dependence on the wall clock).
const closingThreat = { tier: 'mild', weight: 1.0, raw_weight: 4.0, last_touched: '2026-07-02T22:00:00Z' };
const CLOSE_NOW = Date.parse('2026-07-06T00:00:00Z');

test('opens an episode when threat crosses into moderate and none is open', async () => {
  const h = makeDeps(null);
  const r = await syncSpineState({ threat: moderateThreat, wardTimeZone: 'UTC', deps: h.deps });
  assert.equal(r.action, 'opened');
  assert.equal(h.calls.addNode.length, 1);
  assert.equal(h.calls.addNode[0].type, 'state');
  assert.equal(h.calls.addNode[0].payload.spine, true);
  assert.equal(h.calls.addNode[0].payload.source, 'threat-tracker');
  assert.ok(h.getPointer()?.id, 'pointer written');
});

test('climbs the recorded peak when a worse tier arrives', async () => {
  const h = makeDeps({ id: 'spine-x', startLocalIso: '2026-07-02T18:00:00', peakTier: 'moderate' });
  const severe = { tier: 'severe', weight: 8, raw_weight: 8, last_touched: '2026-07-02T19:00:00Z' };
  const r = await syncSpineState({ threat: severe, wardTimeZone: 'UTC', deps: h.deps });
  assert.equal(r.action, 'climbed');
  assert.equal(h.calls.updateNode[0].payload.peak_tier, 'severe');
  assert.equal(h.getPointer().peakTier, 'severe');
});

test('does nothing when open and the tier has not climbed', async () => {
  const h = makeDeps({ id: 'spine-x', startLocalIso: '2026-07-02T18:00:00', peakTier: 'high' });
  const r = await syncSpineState({ threat: moderateThreat, wardTimeZone: 'UTC', deps: h.deps });
  assert.equal(r.action, 'none');
  assert.equal(h.calls.addNode.length, 0);
  assert.equal(h.calls.updateNode.length, 0);
});

test('closes the episode and clears the pointer when threat falls below moderate', async () => {
  const h = makeDeps({ id: 'spine-x', startLocalIso: '2026-07-02T18:00:00', peakTier: 'high' });
  const r = await syncSpineState({ threat: closingThreat, nowMs: CLOSE_NOW, wardTimeZone: 'UTC', deps: h.deps });
  assert.equal(r.action, 'closed');
  assert.equal(h.calls.updateNode.length, 1);
  assert.ok(h.calls.updateNode[0].end, 'close sets an end timestamp');
  assert.equal(h.getPointer(), null, 'pointer cleared');
});

test('closing derives co-occurrence edges from the window', async () => {
  const h = makeDeps({ id: 'spine-x', startLocalIso: '2026-07-02T18:00:00', peakTier: 'moderate' });
  h.deps.getWindow = async () => ({
    nodes: [{ id: 'session-1', type: 'event', when: '2026-07-02T20:00:00' }],
    linked: [],
  });
  const r = await syncSpineState({ threat: closingThreat, nowMs: CLOSE_NOW, wardTimeZone: 'UTC', deps: h.deps });
  assert.equal(r.action, 'closed');
  assert.equal(r.edgesAdded, 1);
  assert.equal(h.calls.addEdge[0].kind, 'co_occurs_with');
  assert.equal(h.calls.addEdge[0].dst, 'session-1');
  assert.equal(h.calls.addEdge[0].payload.source, 'overlap');
});

test('decayCrossingMs: crossing lands after last signal for an elevated raw', () => {
  const last = Date.parse('2026-07-02T22:00:00Z');
  // raw 4 at 3-day half-life crosses 2 after exactly one half-life (3 days).
  const cross = decayCrossingMs(4.0, '2026-07-02T22:00:00Z', { threshold: 2, tauDays: 3 });
  assert.ok(Math.abs(cross - (last + 3 * 24 * 3600 * 1000)) < 1000);
});

test('decayCrossingMs: raw already at/below threshold ends at the last signal', () => {
  const last = Date.parse('2026-07-02T22:00:00Z');
  assert.equal(decayCrossingMs(2.0, '2026-07-02T22:00:00Z', { threshold: 2 }), last);
  assert.equal(decayCrossingMs(0, '2026-07-02T22:00:00Z', { threshold: 2 }), last);
});

test('is a no-op when disabled via settings', async () => {
  const h = makeDeps(null);
  const r = await syncSpineState({ threat: moderateThreat, settings: { spineStatesEnabled: false }, deps: h.deps });
  assert.equal(r.action, 'skipped');
  assert.equal(h.calls.addNode.length, 0);
});

test('is a no-op when required deps are missing', async () => {
  const r = await syncSpineState({ threat: moderateThreat, deps: {} });
  assert.equal(r.action, 'skipped');
  assert.equal(r.reason, 'no-deps');
});

test('never throws — a throwing dep resolves to skipped', async () => {
  const r = await syncSpineState({
    threat: moderateThreat,
    deps: {
      readPointer: async () => { throw new Error('boom'); },
      addNode: async () => ({ ok: true, id: 'x' }),
      updateNode: async () => ({ ok: true }),
      getWindow: async () => ({ nodes: [] }),
      addEdge: async () => ({ ok: true }),
    },
  });
  assert.equal(r.action, 'skipped');
  assert.equal(r.reason, 'threw');
});

test('does not open an episode below the moderate threshold', async () => {
  const h = makeDeps(null);
  const mild = { tier: 'mild', weight: 0.8, raw_weight: 0.8, last_touched: '2026-07-02T18:00:00Z' };
  const r = await syncSpineState({ threat: mild, wardTimeZone: 'UTC', deps: h.deps });
  assert.equal(r.action, 'none');
  assert.equal(h.calls.addNode.length, 0);
});
