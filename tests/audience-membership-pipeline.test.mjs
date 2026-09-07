import { test } from 'node:test';
import assert from 'node:assert/strict';

import { visibleAudiences } from '../src/village/audience.js';
import { discordReadAudiences } from '../cerebellum.js';

// Pipeline test: pins the real gated-Discord seam end to end — the exact
// path a live turn takes from `visibleAudiences` (the membership-based read
// gate) into `discordReadAudiences` (the fail-closed ctx wrapper that scopes
// a villager's tool reads). This is the seam the old scalar-permissionScore
// bug lived behind: two circles with equal permissionScore used to see each
// other, so a fix confined to `visibleAudiences` alone wouldn't have caught a
// regression at this boundary.

const registry = {
  categories: [
    { id: 'strangers', grants: {} },
    { id: 'family',    grants: { memories: true } },
    { id: 'work',      grants: { memories: true } },   // same score as family, different circle
    { id: 'close',     grants: { memories: true, contacts: true } },
  ],
  villagers: [
    { id: 'mom-id',  name: 'Mom',  categoryIds: ['family'], aliases: [] },
    { id: 'boss-id', name: 'Boss', categoryIds: ['work'], aliases: [] },
    { id: 'sib-id',  name: 'Sib',  categoryIds: ['family', 'close'], aliases: [] },
  ],
  locations: [],
};

function gatedCtx(sessionAudience) {
  const audiences = visibleAudiences(sessionAudience, registry);
  return { discord: true, wardPrivate: false, audiences };
}

test('family DM: discordReadAudiences scopes to family + strangers + the ward-content-gated sentinel', () => {
  const ctx = gatedCtx({ participants: [{ id: 'mom-id', name: 'Mom' }] });
  assert.deepEqual(discordReadAudiences(ctx).sort(), ['family', 'strangers', 'ward-content-gated']);
});

test('mixed family+work room: discordReadAudiences scopes to strangers + the sentinel only (the audit fix, pinned at the seam)', () => {
  const ctx = gatedCtx({
    participants: [{ id: 'mom-id', name: 'Mom' }, { id: 'boss-id', name: 'Boss' }],
  });
  assert.deepEqual(discordReadAudiences(ctx).sort(), ['strangers', 'ward-content-gated']);
});

test('stranger room: discordReadAudiences scopes to strangers + the sentinel only', () => {
  const ctx = gatedCtx({ participants: [{ name: 'Nobody' }] });
  assert.deepEqual(discordReadAudiences(ctx).sort(), ['strangers', 'ward-content-gated']);
});

test('ward path: discord:false, wardPrivate:true → discordReadAudiences is unscoped (undefined, ward sees all)', () => {
  const ctx = { discord: false, wardPrivate: true };
  assert.equal(discordReadAudiences(ctx), undefined);
});
