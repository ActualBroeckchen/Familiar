import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveCallAudience, wardVoiceState } from '../voice-call-audience.js';

// Fakes: a villager registry by uid, and a tag resolver that models the real
// audience gate — a stranger present tightens to 'strangers', otherwise the
// villagers' shared circle (here just echoed as 'room:<names>').
const WARD = 'ward-1';
const BOT  = 'bot-1';
const villagers = { 'v-mira': { id: 'mira', name: 'Mira' }, 'v-tom': { id: 'tom', name: 'Tom' } };
const resolveVillager = async (uid) => villagers[uid] ?? null;
const resolveTag = (input) => {
  const ps = input.participants;
  if (ps.some(p => p.id === null)) return 'strangers';       // any unregistered listener → strangers ceiling
  return `room:${ps.map(p => p.name).sort().join(',')}`;
};
const base = { wardUserId: WARD, botId: BOT, resolveVillager, resolveTag, location: 'vc-1' };

test('ward ALONE in the channel → ward-private (nobody else can hear)', async () => {
  const r = await resolveCallAudience({ ...base, members: [WARD] });
  assert.equal(r.othersPresent, false);
  assert.equal(r.audienceTag, 'ward-private');
  assert.equal(r.sessionAudience, 'ward-private', 'the literal sentinel — full context');
});

test('the bot in the channel does NOT count as a listener (still ward-private)', async () => {
  const r = await resolveCallAudience({ ...base, members: [WARD, BOT] });
  assert.equal(r.othersPresent, false, 'the Familiar’s own bot never tightens the gate');
  assert.equal(r.audienceTag, 'ward-private');
});

test('a registered villager present → the room tag, and the reply is room-gated', async () => {
  const r = await resolveCallAudience({ ...base, members: [WARD, BOT, 'v-mira'] });
  assert.equal(r.othersPresent, true);
  assert.equal(r.audienceTag, 'room:Mira');
  assert.notEqual(r.sessionAudience, 'ward-private', 'NOT ward-private — the room object scopes recall');
  assert.equal(r.sessionAudience.participants.length, 1, 'only the villager gates; ward + bot are excluded');
  assert.equal(r.sessionAudience.participants[0].name, 'Mira');
});

test('a STRANGER present tightens to the strangers ceiling', async () => {
  const r = await resolveCallAudience({ ...base, members: [WARD, 'someone-unknown'] });
  assert.equal(r.othersPresent, true);
  assert.equal(r.audienceTag, 'strangers');
  assert.equal(r.sessionAudience.participants[0].id, null, 'an unresolved uid is a stranger, still a listener');
});

test('multiple villagers → the shared room tag over all of them', async () => {
  const r = await resolveCallAudience({ ...base, members: [WARD, BOT, 'v-mira', 'v-tom'] });
  assert.equal(r.audienceTag, 'room:Mira,Tom');
  assert.equal(r.sessionAudience.participants.length, 2);
});

test('mid-call join: the tag CHANGES when a villager joins — the signal to reset history', async () => {
  const before = await resolveCallAudience({ ...base, members: [WARD] });          // ward alone
  const after  = await resolveCallAudience({ ...base, members: [WARD, 'v-mira'] }); // Mira joins
  assert.equal(before.audienceTag, 'ward-private');
  assert.equal(after.audienceTag, 'room:Mira');
  assert.notEqual(before.audienceTag, after.audienceTag,
    'a clearance change: the server resets the shared history so the private stretch never reaches the newcomer');
});

test('never throws — a bad resolveTag degrades to shared-room, not a crash', async () => {
  const r = await resolveCallAudience({
    ...base, members: [WARD, 'v-mira'], resolveTag: () => { throw new Error('boom'); },
  });
  assert.equal(r.audienceTag, 'shared-room', 'a tag resolver failure fails to the safe shared-room, not ward-private');
  assert.equal(r.othersPresent, true);
});

// ── wardVoiceState — the proactive-voice privacy gate (§7) ─────────────────
// A private check-in is only ever spoken aloud when my human is the ONLY human
// present. These lock that gate down.

test('wardVoiceState: my human alone → present AND alone', () => {
  const r = wardVoiceState([WARD], { wardUserId: WARD, botId: BOT });
  assert.equal(r.wardPresent, true);
  assert.equal(r.wardAlone, true);
  assert.deepEqual(r.others, []);
});

test('wardVoiceState: the bot alongside my human still counts as alone', () => {
  const r = wardVoiceState([WARD, BOT], { wardUserId: WARD, botId: BOT });
  assert.equal(r.wardAlone, true, 'my own bot is not a listener');
});

test('wardVoiceState: a villager present → present but NOT alone', () => {
  const r = wardVoiceState([WARD, 'v-mira'], { wardUserId: WARD, botId: BOT });
  assert.equal(r.wardPresent, true);
  assert.equal(r.wardAlone, false, 'someone else can hear — never spoken aloud');
  assert.deepEqual(r.others, ['v-mira']);
});

test('wardVoiceState: any unidentified member (even another bot) → NOT alone (fail-closed)', () => {
  const r = wardVoiceState([WARD, 'other-bot'], { wardUserId: WARD, botId: BOT });
  assert.equal(r.wardAlone, false, 'an unknown voice is never treated as alone-with-my-human');
});

test('wardVoiceState: my human not in the channel → not present, not alone', () => {
  const r = wardVoiceState(['v-mira', 'v-tom'], { wardUserId: WARD, botId: BOT });
  assert.equal(r.wardPresent, false);
  assert.equal(r.wardAlone, false);
});

test('wardVoiceState: an empty roster, or no ward id, is a clean not-present (never throws)', () => {
  assert.deepEqual(wardVoiceState([], { wardUserId: WARD, botId: BOT }), { wardPresent: false, wardAlone: false, others: [] });
  const noId = wardVoiceState([WARD], { wardUserId: '', botId: BOT });
  assert.equal(noId.wardPresent, false, 'no configured ward id → nobody is the ward');
  assert.equal(noId.wardAlone, false);
});
