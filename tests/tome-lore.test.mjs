// tome-lore.js — server-side keyword-lorebook engine (parity with public/app.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchKeyword, testSecondaryLogic, buildScanText, applyGroupLogic,
  activateLore, foldLoreForPrompt, hasLore, normEntryPos,
} from '../src/tomes/tome-lore.js';

const entry = (o) => ({ uid: o.uid ?? Math.random().toString(36).slice(2), enabled: true, keys: [], ...o });
const tome  = (...entries) => ({ enabled: true, entries });

// ── matchKeyword ───────────────────────────────────────────────────
test('matchKeyword: substring, case, whole-word, regex', () => {
  assert.equal(matchKeyword('the Dragon flew', 'dragon', {}, {}), true);            // default case-insensitive
  assert.equal(matchKeyword('the Dragon flew', 'dragon', { caseSensitive: true }), false);
  assert.equal(matchKeyword('a cat sat', 'cat', { matchWholeWords: true }), true);
  assert.equal(matchKeyword('concatenate', 'cat', { matchWholeWords: true }), false); // not a whole word
  assert.equal(matchKeyword('concatenate', 'cat', {}), true);                        // substring on
  assert.equal(matchKeyword('HP is 42', '/\\d+/', {}), true);                        // regex keyword
  assert.equal(matchKeyword('the Dragon', 'dragon', {}, { caseSensitive: true }), false); // global cs
});

// ── secondary logic ────────────────────────────────────────────────
test('testSecondaryLogic: AND_ANY / NOT_ANY / AND_ALL / NOT_ALL', () => {
  const base = { keysecondary: ['red', 'blue'] };
  assert.equal(testSecondaryLogic('a red thing', { ...base, selectiveLogic: 0 }), true);  // AND_ANY: one matches
  assert.equal(testSecondaryLogic('a green thing', { ...base, selectiveLogic: 0 }), false);
  assert.equal(testSecondaryLogic('a red thing', { ...base, selectiveLogic: 1 }), false); // NOT_ANY: a match fails
  assert.equal(testSecondaryLogic('a green thing', { ...base, selectiveLogic: 1 }), true);
  assert.equal(testSecondaryLogic('red and blue', { ...base, selectiveLogic: 2 }), true);  // AND_ALL
  assert.equal(testSecondaryLogic('red only', { ...base, selectiveLogic: 2 }), false);
  assert.equal(testSecondaryLogic('red only', { ...base, selectiveLogic: 3 }), true);      // NOT_ALL: not all present
  assert.equal(testSecondaryLogic('anything', { keysecondary: [] }), true);               // no secondary → pass
});

// ── buildScanText ──────────────────────────────────────────────────
test('buildScanText: last N msgs + current input, roles filtered', () => {
  const msgs = [
    { role: 'user', content: 'one' }, { role: 'assistant', content: 'two' },
    { role: 'system', content: 'SKIP' }, { role: 'user', content: 'three' },
  ];
  assert.equal(buildScanText(msgs, 'now', 2), 'two\nthree\nnow');
  assert.equal(buildScanText(msgs, 'now', 0), 'now');           // depth 0 → only current
});

// ── activation end-to-end ──────────────────────────────────────────
test('activateLore: a keyword in the current message activates its entry', () => {
  const tomes = [tome(entry({ uid: 'a', keys: ['dragon'], content: 'Dragons breathe fire.', position: 'before_char' }))];
  const out = activateLore(tomes, 'tell me about the dragon', { opts: {} });
  assert.equal(out.before_char.length, 1);
  assert.equal(out.before_char[0].content, 'Dragons breathe fire.');
});

test('activateLore: no match → nothing; disabled entry/tome → nothing', () => {
  const tomes = [tome(entry({ uid: 'a', keys: ['dragon'], content: 'x' }))];
  assert.equal(hasLore(activateLore(tomes, 'a quiet day', { opts: {} })), false);
  const disabledEntry = [tome(entry({ uid: 'a', enabled: false, keys: ['dragon'], content: 'x' }))];
  assert.equal(hasLore(activateLore(disabledEntry, 'dragon!', { opts: {} })), false);
  const disabledTome = [{ enabled: false, entries: [entry({ uid: 'a', keys: ['dragon'], content: 'x' })] }];
  assert.equal(hasLore(activateLore(disabledTome, 'dragon!', { opts: {} })), false);
});

test('activateLore: constant entry activates without a keyword', () => {
  const tomes = [tome(entry({ uid: 'c', constant: true, keys: [], content: 'always here', position: 'sys_top' }))];
  const out = activateLore(tomes, 'anything at all', { opts: {} });
  assert.equal(out.sys_top.length, 1);
});

test('activateLore: entries map (object) form is supported', () => {
  const tomes = [{ enabled: true, entries: { k1: entry({ uid: 'a', keys: ['sword'], content: 'sharp', position: 'at_depth' }) } }];
  const out = activateLore(tomes, 'the sword gleams', { opts: {} });
  assert.equal(out.at_depth.length, 1);
});

test('activateLore: scanDepth limits how far back a key can match', () => {
  const tomes = [tome(entry({ uid: 'a', keys: ['ancient'], content: 'lore', position: 'sys_top' }))];
  const messages = [
    { role: 'user', content: 'the ancient rune' },   // 2 turns back
    { role: 'assistant', content: 'I see' },
    { role: 'user', content: 'and now' },
  ];
  // Global depth 1 → only the last message ("and now") + current input scanned → no match.
  assert.equal(hasLore(activateLore(tomes, 'hello', { messages, opts: { scanDepth: 1 } })), false);
  // Depth 4 → "ancient" is in range.
  assert.equal(hasLore(activateLore(tomes, 'hello', { messages, opts: { scanDepth: 4 } })), true);
});

test('activateLore: recursion pulls in an entry keyed off another entry\'s content', () => {
  const tomes = [tome(
    entry({ uid: 'a', keys: ['dragon'], content: 'The dragon guards the Sunstone.', position: 'sys_top' }),
    entry({ uid: 'b', keys: ['sunstone'], content: 'The Sunstone grants fire immunity.', position: 'sys_top' }),
  )];
  const noRec = activateLore(tomes, 'about the dragon', { opts: { recursive: false } });
  assert.equal(noRec.sys_top.length, 1);
  const rec = activateLore(tomes, 'about the dragon', { opts: { recursive: true, maxRecursionSteps: 3 } });
  assert.equal(rec.sys_top.length, 2);   // sunstone pulled in via the dragon entry's content
});

test('activateLore: group exclusion keeps only the heaviest entry', () => {
  const tomes = [tome(
    entry({ uid: 'a', keys: ['weather'], content: 'sunny', group: 'wx', groupWeight: 50, position: 'sys_top' }),
    entry({ uid: 'b', keys: ['weather'], content: 'stormy', group: 'wx', groupWeight: 100, position: 'sys_top' }),
  )];
  const out = activateLore(tomes, 'the weather today', { opts: {} });
  assert.equal(out.sys_top.length, 1);
  assert.equal(out.sys_top[0].content, 'stormy');   // higher groupWeight wins
});

test('activateLore: probability 0 with a stubbed rng never activates; 100 always', () => {
  const tomes = [tome(entry({ uid: 'a', keys: ['maybe'], probability: 0, content: 'x', position: 'sys_top' }))];
  assert.equal(hasLore(activateLore(tomes, 'maybe now', { opts: {}, env: { rng: () => 0.5 } })), false);
  const always = [tome(entry({ uid: 'a', keys: ['maybe'], probability: 100, content: 'x', position: 'sys_top' }))];
  assert.equal(hasLore(activateLore(always, 'maybe now', { opts: {}, env: { rng: () => 0.99 } })), true);
});

test('activateLore: per-entry delay respects turnCount', () => {
  const tomes = [tome(entry({ uid: 'a', keys: ['secret'], delay: 5, content: 'x', position: 'sys_top' }))];
  assert.equal(hasLore(activateLore(tomes, 'the secret', { opts: {}, env: { turnCount: 2 } })), false); // too early
  assert.equal(hasLore(activateLore(tomes, 'the secret', { opts: {}, env: { turnCount: 9 } })), true);
});

// ── positions + ordering + folding ─────────────────────────────────
test('normEntryPos: names and numbers map to the five slots', () => {
  assert.equal(normEntryPos('sys_top'), 2);
  assert.equal(normEntryPos('at_depth'), 4);
  assert.equal(normEntryPos(3), 3);
  assert.equal(normEntryPos('nonsense'), 0);   // default before_char
});

test('applyGroupLogic: ungrouped entries pass through untouched', () => {
  const es = [entry({ uid: 'a', group: '' }), entry({ uid: 'b' })];
  assert.equal(applyGroupLogic(es).length, 2);
});

test('foldLoreForPrompt: lead = top+before, tail = after+bottom, atDepth separate', () => {
  const activated = {
    sys_top:     [{ content: 'TOP' }],
    before_char: [{ content: 'BEFORE' }],
    after_char:  [{ content: 'AFTER' }],
    sys_bottom:  [{ content: 'BOTTOM' }],
    at_depth:    [{ content: 'DEPTH' }],
  };
  const f = foldLoreForPrompt(activated);
  assert.equal(f.lead, 'TOP\n\nBEFORE');
  assert.equal(f.tail, 'AFTER\n\nBOTTOM');
  assert.equal(f.atDepth, 'DEPTH');
});

test('foldLoreForPrompt: empty activation → all empty strings', () => {
  const f = foldLoreForPrompt({ sys_top: [], before_char: [], after_char: [], sys_bottom: [], at_depth: [] });
  assert.deepEqual(f, { lead: '', tail: '', atDepth: '' });
});
