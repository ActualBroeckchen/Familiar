import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveMemoryAudience } from '../audience.js';

// Categories with ascending trust (by permissionScore of their grants):
//   strangers (0, public) < friends (1) < family (3, narrowest among categories).
// A memory tagged with a HIGHER-score category surfaces in FEWER rooms — so for
// audience derivation, a higher score = a narrower (more restrictive) circle.
const registry = {
  categories: [
    { id: 'strangers', grants: {} },
    { id: 'friends',   grants: { memories: 'shared' } },
    { id: 'family',    grants: { memories: true, graph: true } },
  ],
};

test('no subjects, non-sensitive → bounded by the session tag', () => {
  assert.equal(deriveMemoryAudience({ category: 'basics', sessionTag: 'friends', registry }), 'friends');
});

test('no subjects, sensitive category → tightened to ward-private', () => {
  assert.equal(deriveMemoryAudience({ category: 'health_info', sessionTag: 'friends', registry }), 'ward-private');
  assert.equal(deriveMemoryAudience({ category: 'emotional_content', sessionTag: 'family', registry }), 'ward-private');
  // already ward-private stays ward-private
  assert.equal(deriveMemoryAudience({ category: 'health_info', sessionTag: 'ward-private', registry }), 'ward-private');
});

test('an explicit subject disclosure WIDENS past the session default', () => {
  const subjects = [{ disclosure: { basics: 'friends' } }];
  // made in a ward-private session, but the subject is OK with basics → friends
  assert.equal(deriveMemoryAudience({ category: 'basics', subjects, sessionTag: 'ward-private', registry }), 'friends');
});

test('an explicit subject disclosure overrides the sensitivity floor', () => {
  const subjects = [{ disclosure: { health_info: 'family' } }];
  // the data subject explicitly consents to family seeing their health
  assert.equal(deriveMemoryAudience({ category: 'health_info', subjects, sessionTag: 'strangers', registry }), 'family');
});

test('multiple subjects → the narrowest circle wins (everyone must be OK)', () => {
  const subjects = [
    { disclosure: { basics: 'strangers' } }, // public-OK
    { disclosure: { basics: 'family' } },     // family-only
  ];
  assert.equal(deriveMemoryAudience({ category: 'basics', subjects, sessionTag: 'friends', registry }), 'family');
});

test('a subject with no explicit pref falls to the session default (never auto-widened)', () => {
  const subjects = [{ name: 'Pat' }];
  assert.equal(deriveMemoryAudience({ category: 'basics', subjects, sessionTag: 'friends', registry }), 'friends');
});

test('an unknown/deleted disclosure target is ignored → session default (fail-safe)', () => {
  const subjects = [{ disclosure: { basics: 'ghost-circle' } }];
  assert.equal(deriveMemoryAudience({ category: 'basics', subjects, sessionTag: 'friends', registry }), 'friends');
});
