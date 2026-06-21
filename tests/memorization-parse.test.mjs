// Regression tests for the memorization JSON parser. The original
// parseTopics threw a bare SyntaxError whenever the provider's output
// was truncated by the max_tokens cap ("missing or incomplete JSON"),
// discarding every entry even when most of them were complete.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTopics, salvageTopics, parseRelations } from '../memorization.js';

const topic = (n) => ({
  title:    `Topic ${n}`,
  content:  `Content for topic ${n} with some "quoted" text and {braces}.`,
  keywords: [`key${n}a`, `key${n}b`],
  sticky:   3,
});

const wellFormed = JSON.stringify({ topics: [topic(1), topic(2), topic(3)] }, null, 2);

test('parses well-formed JSON', () => {
  const topics = parseTopics(wellFormed);
  assert.equal(topics.length, 3);
  assert.equal(topics[0].title, 'Topic 1');
});

test('strips markdown fences despite the prompt forbidding them', () => {
  const fenced = '```json\n' + wellFormed + '\n```';
  const topics = parseTopics(fenced);
  assert.equal(topics.length, 3);
});

test('salvages complete entries from output truncated mid-object', () => {
  // Cut the third topic off mid-content — what a max_tokens truncation
  // actually looks like.
  const cut = wellFormed.slice(0, wellFormed.lastIndexOf('"content"') + 30);
  const topics = parseTopics(cut, 'length');
  assert.equal(topics.length, 2);
  assert.equal(topics[0].title, 'Topic 1');
  assert.equal(topics[1].title, 'Topic 2');
});

test('truncation with zero complete entries names the token limit', () => {
  const cut = '{\n  "topics": [\n    { "title": "Topic 1", "content": "cut off her';
  assert.throws(() => parseTopics(cut, 'length'), /token limit/);
});

test('non-truncated garbage still reports missing JSON', () => {
  assert.throws(() => parseTopics('I could not produce entries, sorry!'), /No JSON object/);
});

test('empty topics array is rejected', () => {
  assert.throws(() => parseTopics('{ "topics": [] }'), /no topics/);
});

test('salvage skips entries with missing title or content', () => {
  const partial = '{ "topics": [ { "title": "Only title" }, '
    + JSON.stringify(topic(2)) + ', { "title": "Half", "content": "trunc';
  const topics = parseTopics(partial, 'length');
  assert.equal(topics.length, 1);
  assert.equal(topics[0].title, 'Topic 2');
});

test('salvageTopics handles braces and escaped quotes inside strings', () => {
  const tricky = '{ "topics": [ { "title": "A", "content": "has } and { and \\" inside", "keywords": [] } ] }';
  const out = salvageTopics(tricky);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'has } and { and " inside');
});

// ── parseRelations (auto-graph extraction) ───────────────────────────

const factsAnd = (relations) => JSON.stringify({
  facts: [{ content: 'Alice is stressed.', category: 'emotional_content', subjects: ['Alice'], confidence: 0.9 }],
  relations,
});

test('parses well-formed relations and normalises the type to snake_case', () => {
  const raw = factsAnd([
    { from: 'Alice', fromType: 'person', type: 'Works At', to: 'Acme', toType: 'organisation' },
  ]);
  const rels = parseRelations(raw);
  assert.equal(rels.length, 1);
  assert.deepEqual(rels[0], { from: 'Alice', to: 'Acme', type: 'works_at', fromType: 'person', toType: 'organisation' });
});

test('a response with no relations array degrades to an empty list (never throws)', () => {
  const onlyFacts = JSON.stringify({ facts: [{ content: 'x', category: 'basics', subjects: [], confidence: 1 }] });
  assert.deepEqual(parseRelations(onlyFacts), []);
  assert.deepEqual(parseRelations('total garbage, no json at all'), []);
});

test('drops edges missing an endpoint or a type, and self-loops', () => {
  const raw = factsAnd([
    { from: 'Alice', type: 'works_at', to: '' },          // no to
    { from: '', type: 'works_at', to: 'Acme' },           // no from
    { from: 'Alice', to: 'Bob' },                         // no type
    { from: 'Alice', type: 'same_as', to: 'alice' },      // self-loop (case-insensitive)
    { from: 'Alice', fromType: 'person', type: 'friend_of', to: 'Bob', toType: 'person' }, // keeper
  ]);
  const rels = parseRelations(raw);
  assert.equal(rels.length, 1);
  assert.equal(rels[0].to, 'Bob');
});

test('drops unknown node types but keeps the edge', () => {
  const raw = factsAnd([
    { from: 'Alice', fromType: 'wizard', type: 'lives_in', to: 'Portland', toType: 'place' },
  ]);
  const rels = parseRelations(raw);
  assert.equal(rels.length, 1);
  assert.equal(rels[0].fromType, undefined); // invalid type stripped
  assert.equal(rels[0].toType, 'place');
});

test('dedups identical edges within one response', () => {
  const raw = factsAnd([
    { from: 'Alice', type: 'works_at', to: 'Acme' },
    { from: 'alice', type: 'Works_At', to: 'ACME' }, // same edge, different casing
  ]);
  assert.equal(parseRelations(raw).length, 1);
});

test('salvages relations from output truncated mid-object', () => {
  const full = factsAnd([
    { from: 'Alice', fromType: 'person', type: 'works_at', to: 'Acme', toType: 'organisation' },
    { from: 'Bob', fromType: 'person', type: 'lives_in', to: 'Portland', toType: 'place' },
  ]);
  const cut = full.slice(0, full.lastIndexOf('"toType":"place"'));
  const rels = parseRelations(cut, 'length');
  assert.equal(rels.length, 1);
  assert.equal(rels[0].from, 'Alice');
});
