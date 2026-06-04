/**
 * Tests for the standing-value → entity-core reference resolver (M7).
 * entity-ref.js is a clean ES module (no side effects), so unlike the
 * server/app helpers it imports directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEntityCoreRef, resolveEntityCoreRef, identityHasContent } from '../entity-ref.js';

// Sample identity_get_all shape.
const identity = {
  self: [
    { filename: 'my_wants.md', content: '# Caring for the user\nI want them to thrive.\n## Honesty\nTell the truth.' },
    { filename: 'my_persona.md', content: 'Warm, curious, direct.' },
  ],
  user: [
    { filename: 'user_identity.md', content: 'Name: Mel' },
  ],
  relationship: [],
  custom: [],
};

// ── parseEntityCoreRef ────────────────────────────────────────────────

test('parses file-level ref', () => {
  assert.deepEqual(parseEntityCoreRef('entity-core:self/my_wants.md'),
    { source: 'entity-core', category: 'self', filename: 'my_wants.md', section: null });
});

test('parses section-level ref (spaces + apostrophes ok)', () => {
  assert.deepEqual(parseEntityCoreRef("entity-core:self/my_wants.md#Caring for the user"),
    { source: 'entity-core', category: 'self', filename: 'my_wants.md', section: 'Caring for the user' });
});

test('rejects non-entity-core strings', () => {
  assert.equal(parseEntityCoreRef('caring for the user'), null);
  assert.equal(parseEntityCoreRef('https://example.com'), null);
  assert.equal(parseEntityCoreRef(''), null);
  assert.equal(parseEntityCoreRef(null), null);
  assert.equal(parseEntityCoreRef(42), null);
});

test('rejects unknown category', () => {
  assert.equal(parseEntityCoreRef('entity-core:bogus/x.md'), null);
});

test('rejects missing filename', () => {
  assert.equal(parseEntityCoreRef('entity-core:self/'), null);
  assert.equal(parseEntityCoreRef('entity-core:self/#section'), null);
});

// ── resolveEntityCoreRef ──────────────────────────────────────────────

test('non-entity-core ref → not-applicable (caller leaves it alone)', () => {
  assert.equal(resolveEntityCoreRef('just a free string', identity), 'not-applicable');
  assert.equal(resolveEntityCoreRef(null, identity), 'not-applicable');
});

test('file-level ref resolves when file exists', () => {
  assert.equal(resolveEntityCoreRef('entity-core:self/my_wants.md', identity), 'valid');
});

test('file-level ref is missing when file is gone', () => {
  assert.equal(resolveEntityCoreRef('entity-core:self/deleted.md', identity), 'missing');
});

test('section ref valid when heading present', () => {
  assert.equal(resolveEntityCoreRef('entity-core:self/my_wants.md#Caring for the user', identity), 'valid');
  assert.equal(resolveEntityCoreRef('entity-core:self/my_wants.md#Honesty', identity), 'valid');
});

test('section ref valid via lenient substring (not only headings)', () => {
  // "thrive" is body text, not a heading — still counts as present.
  assert.equal(resolveEntityCoreRef('entity-core:self/my_wants.md#thrive', identity), 'valid');
});

test('section ref missing when the anchor text is gone', () => {
  assert.equal(resolveEntityCoreRef('entity-core:self/my_wants.md#Ambition', identity), 'missing');
});

test('missing when the whole category is empty', () => {
  assert.equal(resolveEntityCoreRef('entity-core:custom/anything.md', identity), 'missing');
});

test('case-insensitive section match', () => {
  assert.equal(resolveEntityCoreRef('entity-core:self/my_wants.md#CARING FOR THE USER', identity), 'valid');
});

// ── Safety: a down entity-core must not look like "everything missing"
// to the caller. The resolver itself reports 'missing' for an empty
// identity, so the GUARD lives in the caller (thalamus only validates
// when entity-core actually responded). Document that contract here. ──

test('empty identity reports missing — caller must guard on entity-core being up', () => {
  assert.equal(resolveEntityCoreRef('entity-core:self/my_wants.md', {}), 'missing');
  assert.equal(resolveEntityCoreRef('entity-core:self/my_wants.md', null), 'missing');
});

// ── identityHasContent (the mass-demotion guard) ──────────────────────

test('identityHasContent: real identity → true', () => {
  assert.equal(identityHasContent(identity), true);
});

test('identityHasContent: empty / down entity-core → false (do NOT reconcile)', () => {
  assert.equal(identityHasContent({}), false);                                  // unparseable → {}
  assert.equal(identityHasContent(null), false);                               // no result
  assert.equal(identityHasContent(undefined), false);
  assert.equal(identityHasContent({ self: [], user: [], relationship: [], custom: [] }), false); // all empty
  assert.equal(identityHasContent('garbage'), false);
  assert.equal(identityHasContent({ self: 'not-an-array' }), false);
});

test('identityHasContent: any one non-empty category → true', () => {
  assert.equal(identityHasContent({ self: [], custom: [{ filename: 'x.md', content: 'y' }] }), true);
});
