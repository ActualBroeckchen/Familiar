// V6 relay_message — target resolution, restricted-memory gate, ward mirror.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOL_EXECUTORS,
  initCerebellumTools,
  BUILTIN_TOOLS,
} from '../cerebellum.js';
import { discordChannelIdFromKey } from '../discord-gateway.js';

const relay = TOOL_EXECUTORS.relay_message;

// A registry with one reachable villager, one unreachable villager,
// one Discord guild location, and one non-Discord location.
function makeRegistry() {
  return {
    categories: [
      { id: 'strangers',   name: 'Strangers',     builtin: true,  grants: {} },
      { id: 'cat-friends', name: 'Close Friends', builtin: false, grants: { identityBasic: true } },
    ],
    villagers: [
      {
        id: 'v-chen', name: 'Chen', categoryIds: ['cat-friends'],
        aliases: [{ platform: 'discord', id: '777888999000111222', handle: 'chen_draws' }],
      },
      {
        id: 'v-pat', name: 'Pat', categoryIds: ['cat-friends'],
        aliases: [{ platform: 'whatsapp', id: '+49123' }], // no discord → unreachable
      },
    ],
    locations: [
      { key: 'discord:guild:42:channel:1001', label: 'Cozy #general', assignedCategoryId: 'cat-friends' },
      { key: 'web:session',                    label: 'Web',           assignedCategoryId: 'cat-friends' },
    ],
  };
}

// Reset injected deps after each test so one test's stubs don't bleed.
afterEach(() => {
  initCerebellumTools({
    getVillageRegistry: async () => makeRegistry(),
    relayToDiscord:     async () => ({ ok: true, channelId: 'x' }),
    searchRestricted:   async () => ({ hit: false }),
    mirrorToWard:       async () => ({ id: 'mirror' }),
  });
});

// ── Pure helper ─────────────────────────────────────────────────────

test('discordChannelIdFromKey: parses guild + dm keys, rejects others', () => {
  assert.equal(discordChannelIdFromKey('discord:guild:42:channel:1001'), '1001');
  assert.equal(discordChannelIdFromKey('discord:dm:5005'), '5005');
  assert.equal(discordChannelIdFromKey('web:session'), null);
  assert.equal(discordChannelIdFromKey(''), null);
  assert.equal(discordChannelIdFromKey(null), null);
});

// ── Argument + dependency guards ────────────────────────────────────

test('relay_message: missing args produce readable hints, never throw', async () => {
  initCerebellumTools({ getVillageRegistry: async () => makeRegistry(), relayToDiscord: async () => ({ ok: true }) });
  assert.match(await relay({ message: 'hi' }), /who to reach/i);
  assert.match(await relay({ to: 'Chen' }), /message to carry/i);
});

// ── Target resolution ───────────────────────────────────────────────

test('relay_message: delivers to a villager with a Discord alias and mirrors to the ward', async () => {
  const sent = [];
  const mirrored = [];
  initCerebellumTools({
    getVillageRegistry: async () => makeRegistry(),
    relayToDiscord:     async (args) => { sent.push(args); return { ok: true, channelId: 'dm-1' }; },
    searchRestricted:   async () => ({ hit: false }),
    mirrorToWard:       async (item) => { mirrored.push(item); return { id: 'm1' }; },
  });

  const out = await relay({ to: 'Chen', message: "I'm running late." });
  assert.match(out, /Sent to Chen/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].recipientUserId, '777888999000111222');
  assert.equal(sent[0].message, "I'm running late.");
  // No covert contact: a ward mirror always fires.
  assert.equal(mirrored.length, 1);
  assert.equal(mirrored[0].kind, 'relay');
  assert.match(mirrored[0].body, /Chen/);
});

test('relay_message: delivers to a Discord location by label', async () => {
  const sent = [];
  initCerebellumTools({
    getVillageRegistry: async () => makeRegistry(),
    relayToDiscord:     async (args) => { sent.push(args); return { ok: true }; },
    searchRestricted:   async () => ({ hit: false }),
    mirrorToWard:       async () => ({ id: 'm' }),
  });
  const out = await relay({ to: 'Cozy #general', message: 'Be offline tonight.' });
  assert.match(out, /Sent to Cozy #general/);
  assert.equal(sent[0].channelId, '1001');
});

test('relay_message: unknown target is refused, no send', async () => {
  let sends = 0;
  initCerebellumTools({
    getVillageRegistry: async () => makeRegistry(),
    relayToDiscord:     async () => { sends++; return { ok: true }; },
  });
  assert.match(await relay({ to: 'Nobody', message: 'hi' }), /don't know anyone or any place/i);
  assert.equal(sends, 0);
});

test('relay_message: villager with no Discord account is refused', async () => {
  let sends = 0;
  initCerebellumTools({
    getVillageRegistry: async () => makeRegistry(),
    relayToDiscord:     async () => { sends++; return { ok: true }; },
  });
  assert.match(await relay({ to: 'Pat', message: 'hi' }), /don't have a Discord account/i);
  assert.equal(sends, 0);
});

test('relay_message: non-Discord location is refused', async () => {
  let sends = 0;
  initCerebellumTools({
    getVillageRegistry: async () => makeRegistry(),
    relayToDiscord:     async () => { sends++; return { ok: true }; },
  });
  assert.match(await relay({ to: 'Web', message: 'hi' }), /isn't a Discord location/i);
  assert.equal(sends, 0);
});

// ── Restricted-memory gate ──────────────────────────────────────────

test('relay_message: restricted-memory hit holds the message back, no send, no mirror', async () => {
  let sends = 0, mirrors = 0;
  initCerebellumTools({
    getVillageRegistry: async () => makeRegistry(),
    relayToDiscord:     async () => { sends++; return { ok: true }; },
    searchRestricted:   async () => ({ hit: true, topic: 'health' }),
    mirrorToWard:       async () => { mirrors++; return {}; },
  });
  const out = await relay({ to: 'Chen', message: 'Something ward-private.' });
  assert.match(out, /held that back/i);
  assert.match(out, /health/);
  assert.equal(sends, 0, 'nothing is sent when the gate hits');
  assert.equal(mirrors, 0, 'no mirror when nothing was sent');
});

test('relay_message: gate failure fails OPEN (a benign relay still goes through)', async () => {
  let sends = 0;
  initCerebellumTools({
    getVillageRegistry: async () => makeRegistry(),
    relayToDiscord:     async () => { sends++; return { ok: true }; },
    searchRestricted:   async () => { throw new Error('phylactery down'); },
    mirrorToWard:       async () => ({}),
  });
  const out = await relay({ to: 'Chen', message: 'hi' });
  assert.match(out, /Sent to Chen/);
  assert.equal(sends, 1);
});

// ── Delivery failure ────────────────────────────────────────────────

test('relay_message: a failed Discord send surfaces the error, no mirror', async () => {
  let mirrors = 0;
  initCerebellumTools({
    getVillageRegistry: async () => makeRegistry(),
    relayToDiscord:     async () => ({ ok: false, error: 'channel gone' }),
    searchRestricted:   async () => ({ hit: false }),
    mirrorToWard:       async () => { mirrors++; return {}; },
  });
  const out = await relay({ to: 'Chen', message: 'hi' });
  assert.match(out, /couldn't get that to Chen: channel gone/);
  assert.equal(mirrors, 0);
});

// ── Registry advertises the tool ────────────────────────────────────

test('relay_message is advertised in BUILTIN_TOOLS with required to + message', () => {
  const tool = BUILTIN_TOOLS.find(t => t.function.name === 'relay_message');
  assert.ok(tool, 'relay_message advertised');
  assert.deepEqual(tool.function.parameters.required, ['to', 'message']);
});
