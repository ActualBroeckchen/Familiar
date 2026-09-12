import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTag, topicVisibleToGrants, unionTopicGrants,
  memoryVisibleToVillager, categoryToTag, levelRank,
  isTopic, isLevel, sanitizeTopicGrants,
} from '../src/memory/content-tags.js';

test('normalizeTag: accepts colon/hyphen strings and objects; unknown topic → null', () => {
  assert.deepEqual(normalizeTag('medical:sensitive'), { topic: 'medical', level: 'sensitive' });
  assert.deepEqual(normalizeTag('medical-open'), { topic: 'medical', level: 'open' });
  assert.deepEqual(normalizeTag({ topic: 'family', level: 'open' }), { topic: 'family', level: 'open' });
  assert.equal(normalizeTag('unicorns:open'), null);
  assert.equal(normalizeTag('nonsense'), null);
});

test('normalizeTag: a bare/mis-levelled topic defaults to sensitive (fail-closed tighter)', () => {
  assert.deepEqual(normalizeTag('sexuality'), { topic: 'sexuality', level: 'sensitive' });
  assert.deepEqual(normalizeTag('sexuality:weird'), { topic: 'sexuality', level: 'sensitive' });
});

test('topicVisibleToGrants: granted level must meet or exceed the memory level', () => {
  const grants = { general: 'open', medical: 'open', sexuality: 'sensitive' };
  assert.equal(topicVisibleToGrants(grants, 'medical', 'open'), true);
  assert.equal(topicVisibleToGrants(grants, 'medical', 'sensitive'), false); // only open granted
  assert.equal(topicVisibleToGrants(grants, 'sexuality', 'sensitive'), true);
  assert.equal(topicVisibleToGrants(grants, 'finances', 'open'), false);     // topic not granted at all
  assert.equal(topicVisibleToGrants({}, 'general', 'open'), false);          // nothing granted → nothing seen
});

test('unionTopicGrants: most-permissive level per topic wins across tiers', () => {
  const u = unionTopicGrants([
    { general: 'open', medical: 'open' },
    { medical: 'sensitive', family: 'open' },
    { unicorns: 'sensitive' },   // unknown topic ignored
  ]);
  assert.deepEqual(u, { general: 'open', medical: 'sensitive', family: 'open' });
});

test('memoryVisibleToVillager: overlapping tiers, most-permissive wins', () => {
  // A villager in Acquaintances (general only) AND Care Network (medical).
  const grants = unionTopicGrants([
    { general: 'open' },
    { general: 'open', medical: 'sensitive' },
  ]);
  assert.equal(memoryVisibleToVillager('medical:sensitive', grants), true);
  assert.equal(memoryVisibleToVillager('finances:open', grants), false);
  assert.equal(memoryVisibleToVillager('general:open', grants), true);
});

test('memoryVisibleToVillager: an untagged memory is treated as general:sensitive', () => {
  const baseline = { general: 'open' };            // ordinary tier
  const trusted  = { general: 'sensitive' };       // trusted with general at depth
  assert.equal(memoryVisibleToVillager(null, baseline), false); // baseline can't see it
  assert.equal(memoryVisibleToVillager(null, trusted), true);
});

test('categoryToTag: legacy categories map to topic + a sensible default level', () => {
  assert.deepEqual(categoryToTag('basics'), { topic: 'general', level: 'open' });
  assert.deepEqual(categoryToTag('health_info'), { topic: 'medical', level: 'sensitive' });
  assert.deepEqual(categoryToTag('relationships'), { topic: 'relationships', level: 'open' });
  // Explicit sensitivity overrides the category default.
  assert.deepEqual(categoryToTag('basics', { sensitive: true }), { topic: 'general', level: 'sensitive' });
});

test('helpers: levelRank ordering + validators', () => {
  assert.ok(levelRank('sensitive') > levelRank('open'));
  assert.ok(levelRank('open') > levelRank('none'));
  assert.equal(levelRank('bogus'), 0);
  assert.equal(isTopic('medical'), true);
  assert.equal(isTopic('bogus'), false);
  assert.equal(isLevel('open'), true);
  assert.equal(isLevel('meh'), false);
});

test('sanitizeTopicGrants: keeps valid topic→level, drops unknown topics/levels/junk', () => {
  assert.deepEqual(
    sanitizeTopicGrants({ medical: 'sensitive', general: 'open', unicorns: 'open', family: 'none', legal: 'bogus' }),
    { medical: 'sensitive', general: 'open' },
  );
  assert.deepEqual(sanitizeTopicGrants(null), {});
  assert.deepEqual(sanitizeTopicGrants('nope'), {});
  assert.deepEqual(sanitizeTopicGrants(['medical']), {});
});
