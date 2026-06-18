import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  WARD_PRIVATE,
  GRANT_LADDERS,
  MARKER_GRANT_MAP,
  grantUnion,
  grantIntersection,
  resolveAudience,
  isGranted,
  stripGatedSections,
  fetchEligibility,
  audienceTagFor,
  AUDIENCE_TAG_WARD_PRIVATE,
} from '../audience.js';

// ── resolveAudience helpers ───────────────────────────────────────

function makeRegistry(overrides = {}) {
  return {
    categories: [
      { id: 'strangers',          name: 'Strangers',          builtin: true,  grants: {} },
      { id: 'emergency-contacts', name: 'Emergency Contacts', builtin: true,  grants: { wardPresence: true, triageContact: true } },
      { id: 'cat-friends',        name: 'Friends',            builtin: false, grants: { identityBasic: true, memories: true, graph: true, schedule: 'full' } },
      { id: 'cat-acquaint',       name: 'Acquaintances',      builtin: false, grants: { identityBasic: true, memories: 'shared' } },
    ],
    villagers: [
      {
        id: 'v-alice', name: 'Alice', categoryIds: ['cat-friends'],
        aliases: [{ platform: 'discord', id: 'alice#1234', handle: 'Alice_D' }],
        connection: '', aliases_extra: [],
      },
      {
        id: 'v-bob', name: 'Bob', categoryIds: ['cat-acquaint'],
        aliases: [],
        connection: '',
      },
      {
        id: 'v-multi', name: 'Charlie', categoryIds: ['cat-friends', 'cat-acquaint'],
        aliases: [],
        connection: '',
      },
    ],
    locations: [
      { key: 'loc:private', label: 'Private',           assignedCategoryId: 'cat-friends' },
      { key: 'loc:public',  label: 'Public Room',       assignedCategoryId: 'strangers' },
      { key: 'loc:unset',   label: 'Unassigned Room' },
    ],
    ...overrides,
  };
}

// ── WARD_PRIVATE sentinel ─────────────────────────────────────────

describe('resolveAudience — ward-private sentinel', () => {
  it('returns WARD_PRIVATE for null audience', () => {
    assert.equal(resolveAudience(null, makeRegistry()), WARD_PRIVATE);
  });

  it('returns WARD_PRIVATE for empty participants and no location', () => {
    assert.equal(resolveAudience({ location: null, participants: [] }, makeRegistry()), WARD_PRIVATE);
  });

  it('returns WARD_PRIVATE for missing participants key', () => {
    assert.equal(resolveAudience({}, makeRegistry()), WARD_PRIVATE);
  });
});

// ── Fail-closed: unknown participant ─────────────────────────────

describe('resolveAudience — fail-closed for unknown participants', () => {
  it('unknown participant yields strangers floor ({} grants)', () => {
    const result = resolveAudience(
      { participants: [{ id: null, name: 'Ghost' }] },
      makeRegistry(),
    );
    assert.deepEqual(result, {});
  });

  it('one unknown among knowns collapses everything to strangers', () => {
    const result = resolveAudience(
      { participants: [{ id: 'v-alice', name: 'Alice' }, { id: null, name: 'Ghost' }] },
      makeRegistry(),
    );
    // Intersection with {} yields {}
    assert.deepEqual(result, {});
  });

  it('fail-closed with empty registry → no categories → strangers floor', () => {
    const result = resolveAudience(
      { participants: [{ id: 'v-alice', name: 'Alice' }] },
      { categories: [], villagers: [], locations: [] },
    );
    assert.deepEqual(result, {});
  });
});

// ── Single known participant ──────────────────────────────────────

describe('resolveAudience — single known participant', () => {
  it('resolves by villager id', () => {
    const result = resolveAudience(
      { participants: [{ id: 'v-alice' }] },
      makeRegistry(),
    );
    assert.equal(result.identityBasic, true);
    assert.equal(result.memories, true);
    assert.equal(result.schedule, 'full');
  });

  it('resolves by name (case-insensitive)', () => {
    const result = resolveAudience(
      { participants: [{ id: null, name: 'alice' }] },
      makeRegistry(),
    );
    assert.equal(result.identityBasic, true);
  });

  it('resolves by alias handle (case-insensitive)', () => {
    const result = resolveAudience(
      { participants: [{ id: null, name: 'alice_d' }] },
      makeRegistry(),
    );
    assert.equal(result.identityBasic, true);
  });
});

// ── Intersection rule ─────────────────────────────────────────────

describe('resolveAudience — intersection across participants', () => {
  it('two friends: result = full friend grants', () => {
    const result = resolveAudience(
      { participants: [{ id: 'v-alice' }, { id: 'v-alice' }] },
      makeRegistry(),
    );
    assert.equal(result.identityBasic, true);
    assert.equal(result.schedule, 'full');
  });

  it('friend + acquaintance: schedule drops to shared memories level', () => {
    const result = resolveAudience(
      { participants: [{ id: 'v-alice' }, { id: 'v-bob' }] },
      makeRegistry(),
    );
    // identityBasic: both have it → true
    assert.equal(result.identityBasic, true);
    // memories: friend=true, acquaintance='shared' → min = 'shared'
    assert.equal(result.memories, 'shared');
    // schedule: friend='full', acquaintance=absent(false) → denied (absent)
    assert.ok(!result.schedule);
    // graph: friend=true, acquaintance=absent → denied (absent)
    assert.ok(!result.graph);
  });

  it('friend + stranger: everything collapses to {}', () => {
    const result = resolveAudience(
      { participants: [{ id: 'v-alice' }, { id: null, name: 'Unknown' }] },
      makeRegistry(),
    );
    assert.deepEqual(result, {});
  });
});

// ── Multi-category union ──────────────────────────────────────────

describe('resolveAudience — multi-category villager (union)', () => {
  it('villager in two categories gets the union of their grants', () => {
    // Charlie is in both friends (schedule: full, graph: true) and acquaintances (memories: 'shared')
    const result = resolveAudience(
      { participants: [{ id: 'v-multi' }] },
      makeRegistry(),
    );
    // Union: friends has schedule: 'full', acquaintances has schedule: absent → max = 'full'
    assert.equal(result.schedule, 'full');
    // Union: friends has memories: true, acquaintances has memories: 'shared' → max = true
    assert.equal(result.memories, true);
  });
});

// ── Location ceiling ──────────────────────────────────────────────

describe('resolveAudience — location ceiling', () => {
  it('private location (assigned cat-friends) does not narrow friend grants', () => {
    const result = resolveAudience(
      { location: 'loc:private', participants: [{ id: 'v-alice' }] },
      makeRegistry(),
    );
    assert.equal(result.identityBasic, true);
    assert.equal(result.schedule, 'full');
  });

  it('public location (assigned strangers) floors everything even with known participant', () => {
    const result = resolveAudience(
      { location: 'loc:public', participants: [{ id: 'v-alice' }] },
      makeRegistry(),
    );
    assert.deepEqual(result, {});
  });

  it('unassigned location acts as strangers ceiling', () => {
    const result = resolveAudience(
      { location: 'loc:unset', participants: [{ id: 'v-alice' }] },
      makeRegistry(),
    );
    assert.deepEqual(result, {});
  });

  it('location alone (no participants) contributes a ceiling', () => {
    const result = resolveAudience(
      { location: 'loc:private', participants: [] },
      makeRegistry(),
    );
    // Only the location ceiling participant → friend grants
    assert.equal(result.identityBasic, true);
  });

  it('location alone public → strangers grants', () => {
    const result = resolveAudience(
      { location: 'loc:public' },
      makeRegistry(),
    );
    assert.deepEqual(result, {});
  });
});

// ── grantUnion ────────────────────────────────────────────────────

describe('grantUnion', () => {
  it('boolean OR: false ∪ true = true', () => {
    assert.equal(grantUnion({ a: false }, { a: true }).a, true);
  });

  it('boolean OR: absent ∪ true = true', () => {
    assert.equal(grantUnion({}, { a: true }).a, true);
  });

  it('ladder max: shared ∪ true = true', () => {
    assert.equal(grantUnion({ memories: 'shared' }, { memories: true }).memories, true);
  });

  it('ladder max: false ∪ shared = shared', () => {
    assert.equal(grantUnion({ memories: false }, { memories: 'shared' }).memories, 'shared');
  });

  it('ladder max: absent ∪ coarse = coarse', () => {
    assert.equal(grantUnion({}, { schedule: 'coarse' }).schedule, 'coarse');
  });

  it('does not mutate inputs', () => {
    const g1 = { a: true };
    const g2 = { a: false };
    grantUnion(g1, g2);
    assert.equal(g1.a, true);
  });
});

// ── grantIntersection ─────────────────────────────────────────────

describe('grantIntersection', () => {
  it('boolean AND: true ∩ true = true', () => {
    assert.equal(grantIntersection({ a: true }, { a: true }).a, true);
  });

  it('boolean AND: true ∩ false = denied', () => {
    assert.ok(!grantIntersection({ a: true }, { a: false }).a);
  });

  it('boolean AND: absent ∩ true = denied', () => {
    assert.ok(!grantIntersection({}, { a: true }).a);
  });

  it('ladder min: shared ∩ true = shared', () => {
    assert.equal(grantIntersection({ memories: 'shared' }, { memories: true }).memories, 'shared');
  });

  it('ladder min: coarse ∩ full = coarse', () => {
    assert.equal(grantIntersection({ schedule: 'coarse' }, { schedule: 'full' }).schedule, 'coarse');
  });

  it('ladder min: false ∩ full = denied', () => {
    assert.ok(!grantIntersection({ schedule: false }, { schedule: 'full' }).schedule);
  });

  it('intersect {} with anything = {} (strangers floor propagates)', () => {
    const result = grantIntersection({}, { a: true, memories: true, schedule: 'full' });
    assert.deepEqual(result, {});
  });
});

// ── isGranted ─────────────────────────────────────────────────────

describe('isGranted', () => {
  it('boolean true → granted', () => assert.equal(isGranted('a', { a: true }), true));
  it('boolean false → not granted', () => assert.equal(isGranted('a', { a: false }), false));
  it('absent → not granted', () => assert.equal(isGranted('a', {}), false));
  it("'full' string → granted", () => assert.equal(isGranted('schedule', { schedule: 'full' }), true));
  it("'coarse' string → granted", () => assert.equal(isGranted('schedule', { schedule: 'coarse' }), true));
  it("'none' string → not granted", () => assert.equal(isGranted('schedule', { schedule: 'none' }), false));
  it("'false' string → not granted", () => assert.equal(isGranted('schedule', { schedule: 'false' }), false));
  it('empty string → not granted', () => assert.equal(isGranted('schedule', { schedule: '' }), false));
});

// ── stripGatedSections ────────────────────────────────────────────

describe('stripGatedSections — ward-private passthrough', () => {
  it('WARD_PRIVATE: returns content unchanged including markers', () => {
    const content = 'Hello\n<!-- gate: health -->\nsecret\n<!-- /gate -->\nworld';
    assert.equal(stripGatedSections(content, WARD_PRIVATE), content);
  });
});

describe('stripGatedSections — gated mode', () => {
  const grants = { identitySensitive: true, health: false };

  it('strips section with ungranted health class', () => {
    const content = 'A\n<!-- gate: health -->\nhidden\n<!-- /gate -->\nB';
    const result = stripGatedSections(content, grants);
    assert.ok(!result.includes('hidden'), 'health section should be stripped');
    assert.ok(result.includes('A'), 'unmarked content preserved');
    assert.ok(result.includes('B'), 'unmarked content preserved');
  });

  it('keeps content for granted sensitive class (strips markers only)', () => {
    const content = 'A\n<!-- gate: sensitive -->\norientation info\n<!-- /gate -->\nB';
    const result = stripGatedSections(content, grants);
    assert.ok(result.includes('orientation info'), 'sensitive content kept when granted');
    assert.ok(!result.includes('<!-- gate:'), 'markers stripped');
  });

  it('strips section with unknown class (fail-closed)', () => {
    const content = 'A\n<!-- gate: unknown_class -->\nwhoops\n<!-- /gate -->\nB';
    const result = stripGatedSections(content, grants);
    assert.ok(!result.includes('whoops'), 'unknown class stripped');
    assert.ok(result.includes('A') && result.includes('B'));
  });

  it('handles multiple gated sections', () => {
    const content = [
      'Header',
      '<!-- gate: sensitive -->',
      'sensitive data',
      '<!-- /gate -->',
      'Middle',
      '<!-- gate: health -->',
      'health data',
      '<!-- /gate -->',
      'Footer',
    ].join('\n');
    const result = stripGatedSections(content, { identitySensitive: true, health: true });
    assert.ok(result.includes('sensitive data'));
    assert.ok(result.includes('health data'));
    assert.ok(result.includes('Header') && result.includes('Middle') && result.includes('Footer'));
    assert.ok(!result.includes('<!-- gate:'));
  });

  it('multiline content inside gate is handled correctly', () => {
    const content = '<!-- gate: health -->\nline1\nline2\nline3\n<!-- /gate -->';
    const result = stripGatedSections(content, { health: true });
    assert.ok(result.includes('line1'));
    assert.ok(result.includes('line3'));
    assert.ok(!result.includes('<!-- gate:'));
  });

  it('no markers: content passes through unchanged', () => {
    const content = 'no markers here at all';
    assert.equal(stripGatedSections(content, {}), content);
  });

  it('non-string content returns empty string', () => {
    assert.equal(stripGatedSections(null, {}), '');
    assert.equal(stripGatedSections(undefined, {}), '');
  });
});

// ── fetchEligibility (gate-before-fetch, fail-closed ladders) ─────

describe('fetchEligibility', () => {
  it('WARD_PRIVATE → everything eligible, marked ward-private', () => {
    const e = fetchEligibility(WARD_PRIVATE);
    assert.deepEqual(e, { wardPrivate: true, memory: true, graph: true, temporal: true });
  });

  it('strangers floor ({}) → nothing eligible', () => {
    const e = fetchEligibility({});
    assert.equal(e.wardPrivate, false);
    assert.equal(e.memory, false);
    assert.equal(e.graph, false);
    assert.equal(e.temporal, false);
  });

  it('memories: true → memory fetch eligible', () => {
    assert.equal(fetchEligibility({ memories: true }).memory, true);
  });

  it("memories: 'shared' → memory fetch eligible (Pillar E: audience tags + outgoing filter now in place)", () => {
    assert.equal(fetchEligibility({ memories: 'shared' }).memory, true);
  });

  it("schedule: 'full' → temporal fetch eligible", () => {
    assert.equal(fetchEligibility({ schedule: 'full' }).temporal, true);
  });

  it("schedule: 'coarse' → temporal fetch NOT eligible (no coarse renderer yet — fail-closed)", () => {
    assert.equal(fetchEligibility({ schedule: 'coarse' }).temporal, false);
  });

  it('graph: true → graph fetch eligible; absent → not', () => {
    assert.equal(fetchEligibility({ graph: true }).graph, true);
    assert.equal(fetchEligibility({ memories: true }).graph, false);
  });
});

// ── GRANT_LADDERS constant ────────────────────────────────────────

describe('GRANT_LADDERS structure', () => {
  it('memories ladder starts at false', () => assert.equal(GRANT_LADDERS.memories[0], false));
  it('memories ladder ends at true', () => assert.equal(GRANT_LADDERS.memories.at(-1), true));
  it('schedule ladder has coarse between false and full', () => {
    const i = GRANT_LADDERS.schedule;
    assert.equal(i[0], false);
    assert.equal(i[1], 'coarse');
    assert.equal(i[2], 'full');
  });
  it('contacts ladder has care-visible as middle tier', () => {
    assert.equal(GRANT_LADDERS.contacts[1], 'care-visible');
  });
});

// ── MARKER_GRANT_MAP constant ─────────────────────────────────────

describe('MARKER_GRANT_MAP', () => {
  it('sensitive maps to identitySensitive', () => {
    assert.equal(MARKER_GRANT_MAP.sensitive, 'identitySensitive');
  });
  it('health maps to health', () => assert.equal(MARKER_GRANT_MAP.health, 'health'));
  it('location maps to location', () => assert.equal(MARKER_GRANT_MAP.location, 'location'));
});

// ── audienceTagFor — durable room-audience label ──────────────────

describe('audienceTagFor', () => {
  const reg = makeRegistry();

  it('null audience (ward-private session) → ward-private', () => {
    assert.equal(audienceTagFor(null, reg), AUDIENCE_TAG_WARD_PRIVATE);
    assert.equal(AUDIENCE_TAG_WARD_PRIVATE, 'ward-private');
  });

  it('empty audience (no location, no participants) → ward-private', () => {
    assert.equal(audienceTagFor({ location: null, participants: [] }, reg), AUDIENCE_TAG_WARD_PRIVATE);
  });

  it('a single known participant → their own permission level', () => {
    // A DM with a friend is tagged at the friend level (scan the present
    // user, compare to the database, take their level).
    assert.equal(audienceTagFor({ location: null, participants: [{ id: 'v-alice' }] }, reg), 'cat-friends');
    assert.equal(audienceTagFor({ location: null, participants: [{ id: 'v-bob' }] }, reg), 'cat-acquaint');
  });

  it('multiple participants → the LOWEST permission level present', () => {
    // friend + acquaintance → acquaintance (the more restrictive of the two).
    assert.equal(
      audienceTagFor({ location: null, participants: [{ id: 'v-alice' }, { id: 'v-bob' }] }, reg),
      'cat-acquaint',
    );
  });

  it('any unknown user present floors the whole room to strangers', () => {
    assert.equal(
      audienceTagFor({ location: null, participants: [{ id: 'v-alice' }, { id: 'nobody' }] }, reg),
      'strangers',
    );
  });

  it('multi-category villager is represented by their most-permissive category', () => {
    // Charlie ∈ {friends, acquaintances}; alone, the room is friends-level.
    assert.equal(audienceTagFor({ location: null, participants: [{ id: 'v-multi' }] }, reg), 'cat-friends');
  });

  it('the location ceiling can only ever LOWER the tag', () => {
    // A friend speaking in a public (strangers) channel → strangers.
    assert.equal(audienceTagFor({ location: 'loc:public', participants: [{ id: 'v-alice' }] }, reg), 'strangers');
    // A friend in a friends-ceiling channel stays at friends.
    assert.equal(audienceTagFor({ location: 'loc:private', participants: [{ id: 'v-alice' }] }, reg), 'cat-friends');
  });

  it('unassigned / unknown location → strangers floor (fail-closed)', () => {
    assert.equal(audienceTagFor({ location: 'loc:unset', participants: [] }, reg), 'strangers');
    assert.equal(audienceTagFor({ location: 'loc:does-not-exist', participants: [] }, reg), 'strangers');
  });

  it('location pointing at a category that no longer exists → strangers floor', () => {
    const r = makeRegistry({
      locations: [{ key: 'loc:orphan', label: 'Orphan', assignedCategoryId: 'cat-deleted' }],
    });
    assert.equal(audienceTagFor({ location: 'loc:orphan', participants: [] }, r), 'strangers');
  });
});
