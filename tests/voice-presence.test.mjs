import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  humanCount, isGroupCall, attributeSpeaker, prefixTurn, joinNames,
  diffRoster, formatPresenceNote, buildGreetingPrompt, parseGreeting,
} from '../voice-presence.js';

const roster = (...names) => names.map((name, i) => ({ id: `u${i}`, name, isWard: name === 'my human' }));

test('isGroupCall / humanCount: solo vs group', () => {
  assert.equal(humanCount(roster('my human')), 1);
  assert.equal(isGroupCall(roster('my human')), false);
  assert.equal(isGroupCall(roster('my human', 'Sam')), true);
  assert.equal(isGroupCall([]), false);
  assert.equal(isGroupCall(null), false);
});

test('attributeSpeaker: labels in a group, null when solo', () => {
  assert.equal(attributeSpeaker({ name: 'Sam', isGroup: true }), 'Sam');
  assert.equal(attributeSpeaker({ name: 'my human', isGroup: true }), 'my human');  // ward labelled too
  assert.equal(attributeSpeaker({ name: 'Sam', isGroup: false }), null);            // solo → unattributed
  assert.equal(attributeSpeaker({ name: '  ', isGroup: true }), null);              // empty name → no label
});

test('attributeSpeaker: the ward carries a (WARD) marker in a group', () => {
  // The reported confusion: my human's turns read as mine or a villager's.
  assert.equal(attributeSpeaker({ name: 'Zara', isGroup: true, isWard: true }), 'Zara (WARD)');
  assert.equal(attributeSpeaker({ name: 'Sam', isGroup: true, isWard: false }), 'Sam');   // villager: plain name
  assert.equal(attributeSpeaker({ name: 'Zara', isGroup: false, isWard: true }), null);   // solo → still unattributed
  assert.equal(attributeSpeaker({ name: '  ', isGroup: true, isWard: true }), null);      // empty name → no label
});

test('prefixTurn: only prefixes when a label is present', () => {
  assert.equal(prefixTurn('Sam', 'hey there'), 'Sam: hey there');
  assert.equal(prefixTurn(null, 'hey there'), 'hey there');   // solo path byte-identical to before
});

test('joinNames: natural english lists', () => {
  assert.equal(joinNames([]), '');
  assert.equal(joinNames(['Sam']), 'Sam');
  assert.equal(joinNames(['Sam', 'Alex']), 'Sam and Alex');
  assert.equal(joinNames(['Sam', 'Alex', 'my human']), 'Sam, Alex, and my human');
  assert.equal(joinNames(['Sam', '', '  ']), 'Sam');           // blanks dropped
});

test('diffRoster: joins and leaves', () => {
  assert.deepEqual(diffRoster(['a', 'b'], ['b', 'c']), { joined: ['c'], left: ['a'] });
  assert.deepEqual(diffRoster([], ['a']), { joined: ['a'], left: [] });
  assert.deepEqual(diffRoster(['a'], ['a']), { joined: [], left: [] });
});

test('formatPresenceNote: names the room + who came/went', () => {
  const note = formatPresenceNote({ roster: roster('my human', 'Sam'), joined: ['Sam'], left: [] });
  assert.match(note, /Sam just joined the call\./);
  assert.match(note, /group call/);
  assert.match(note, /my human and Sam/);
});

test('formatPresenceNote: a leave in an otherwise-solo call still reports', () => {
  const note = formatPresenceNote({ roster: roster('my human'), joined: [], left: ['Alex'] });
  assert.match(note, /Alex just left the call\./);
  assert.doesNotMatch(note, /group call/);   // only my human left → not a group
});

test('formatPresenceNote: solo with no change says nothing', () => {
  assert.equal(formatPresenceNote({ roster: roster('my human'), joined: [], left: [] }), null);
});

test('buildGreetingPrompt: names the arrival, anchors to voice, allows [skip]', () => {
  const p = buildGreetingPrompt({ name: 'Sam', event: 'joined' });
  assert.match(p, /Sam just joined/);
  assert.match(p, /\{\{char\}\}/);            // macro left for the caller to resolve
  assert.match(p, /\[skip\]/);
  assert.match(p, /voice my identity holds/i);
});

test('parseGreeting: reads the line or the skip', () => {
  assert.equal(parseGreeting('oh hey Sam, good timing'), 'oh hey Sam, good timing');
  assert.equal(parseGreeting('[skip]'), null);
  assert.equal(parseGreeting('  skip. '), null);
  assert.equal(parseGreeting(''), null);
  assert.equal(parseGreeting(null), null);
});
