// A standing fact about ME lands on my `me` register, not my human's `ward`
// one — the route that lets my own views accrue as mine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factStorage, buildPrompt } from '../src/memory/memorization.js';

const D = '2026-09-07';

test('factStorage: episodic stays daily regardless of about_me', () => {
  assert.deepEqual(factStorage({ temporality: 'episodic', about_me: true }, { factDate: D }),
    { granularity: 'daily', standalone: true, date: D });
});

test('factStorage: standing fact about my human → ward register', () => {
  assert.equal(factStorage({ temporality: 'standing' }, { factDate: D }).register, 'ward');
  assert.equal(factStorage({ temporality: 'standing', about_me: false }, { factDate: D }).register, 'ward');
});

test('factStorage: standing fact about me → me register', () => {
  const s = factStorage({ temporality: 'standing', about_me: true }, { factDate: D });
  assert.equal(s.register, 'me');
  assert.equal(s.granularity, 'significant');
});

test('factStorage: a named third party gets no register even when about_me is set', () => {
  const s = factStorage({ temporality: 'standing', about_me: true }, { factDate: D, hasNamedSubjects: true });
  assert.equal(s.register, undefined);
});

test('extraction prompt asks for about_me and invites my own views', () => {
  const msgs = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'I honestly think cricket is dull.' }];
  const p = buildPrompt(msgs);
  assert.match(p, /"about_me":\s+false/);
  assert.match(p, /about_me — true when the fact is about ME/);
  assert.match(p, /what I think, like, dislike/);
});

// ── views: a home for opinions ────────────────────────────────────

import { resolveRememberGate } from '../src/memory/memorization.js';
import { categoryToTag } from '../src/memory/content-tags.js';

test('my own view (about_me, no one else named) needs nobody\'s consent, even in a shared room', () => {
  assert.equal(resolveRememberGate('views', [], null, null, { direct: false, aboutMe: true }), 'true');
  // A named third party's view still asks.
  assert.equal(resolveRememberGate('views', [], null, null, { direct: false, aboutMe: true, hasNamedSubjects: true }), 'ask');
  // The flag alone never opens a fact ABOUT a villager.
  assert.equal(resolveRememberGate('views', [{ id: 'v1', remember: {} }], null, null, { aboutMe: true }), 'ask');
});

test('views is a known category: kept as itself, tagged general:open', () => {
  const p = buildPrompt([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'cricket is dull' }]);
  assert.match(p, /\n  views\s+— what someone thinks about something/);
  assert.deepEqual(categoryToTag('views'), { topic: 'general', level: 'open' });
});
