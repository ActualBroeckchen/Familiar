import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRAPH_ENTITY_TYPES, GRAPH_ENTITY_TYPES_STR } from '../graph-vocab.js';
import { BUILTIN_TOOLS } from '../cerebellum.js';
import { buildPrompt, buildSharedRoomPrompt } from '../memorization.js';

// The whole point of graph-vocab.js: ONE rubric, every surface. These pin that
// the chat-path graph tools and the autonomous memorization prompts now teach the
// same entity vocabulary and the same no-abstractions rule, so a node made
// mid-chat is held to the same standard as one made during memorization.

test('the canonical entity vocabulary is the one shared set', () => {
  for (const t of ['person', 'place', 'organisation', 'pet', 'condition', 'project', 'thing'])
    assert.ok(GRAPH_ENTITY_TYPES.includes(t), `missing ${t}`);
});

test('the chat-path graph tools carry the node + edge rubric', () => {
  const desc = (name) => BUILTIN_TOOLS.find(t => t.function.name === name).function.description;
  const node = desc('create_graph_node');
  const edge = desc('create_graph_edge');
  assert.match(node, /abstraction/i, 'create_graph_node teaches the no-abstractions rule');
  assert.ok(node.includes('condition') && node.includes('project'), 'and the unified type vocabulary');
  assert.match(edge, /snake_case/i, 'create_graph_edge teaches the edge rule');
  assert.match(edge, /never invent/i);
});

test('both memorization prompts use the shared entity vocabulary verbatim', () => {
  const msgs = [
    { role: 'user', content: 'Alice works at Acme in Bristol.' },
    { role: 'assistant', content: 'Noted — I will remember that.' },
  ];
  for (const p of [buildPrompt(msgs), buildSharedRoomPrompt(msgs)]) {
    assert.ok(p.includes(GRAPH_ENTITY_TYPES_STR), 'the canonical type list appears verbatim');
    assert.match(p, /abstraction|not entities/i, 'the no-abstractions rule is present');
  }
});
