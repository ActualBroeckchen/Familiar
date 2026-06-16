import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  discordLocationKey,
  classifyMessage,
  chunkReply,
  mergeParticipant,
  GATEWAY_INTENTS,
  checkRateLimit,
  consumeRateSlot,
  resetRateLimitState,
  decideAmbientReply,
  isAmbientAbstain,
  resolveMentions,
  directedAtOthers,
} from '../discord-gateway.js';

// ── Fixtures ──────────────────────────────────────────────────────

const BOT_ID  = '999000999000999000';
const WARD_ID = '111222333444555666';

function makeRegistry() {
  return {
    categories: [
      { id: 'strangers',   name: 'Strangers', builtin: true,  grants: {} },
      { id: 'cat-friends', name: 'Friends',   builtin: false, grants: { identityBasic: true } },
    ],
    villagers: [
      {
        id: 'v-chen', name: 'Chen', categoryIds: ['cat-friends'],
        aliases: [{ platform: 'discord', id: '777888999000111222', handle: 'chen_draws' }],
        connection: '',
      },
    ],
    locations: [
      { key: 'discord:guild:42:channel:1001', label: 'Cozy #general', assignedCategoryId: 'cat-friends' },
      { key: 'discord:dm:5005',               label: 'Chen DM',       assignedCategoryId: 'cat-friends' },
    ],
  };
}

function dmFrom(authorId, content = 'hello', extra = {}) {
  return { channel_id: '5005', author: { id: authorId, username: 'someone' }, content, ...extra };
}

function guildMsg(authorId, content = 'hello', extra = {}) {
  return {
    guild_id: '42', channel_id: '1001',
    author: { id: authorId, username: 'someone' },
    content, mentions: [], ...extra,
  };
}

const ctx = () => ({ registry: makeRegistry(), botUserId: BOT_ID, wardUserId: WARD_ID });

// ── discordLocationKey ────────────────────────────────────────────

describe('discordLocationKey', () => {
  it('guild message → guild:channel key matching the registry convention', () => {
    assert.equal(discordLocationKey(guildMsg('x')), 'discord:guild:42:channel:1001');
  });
  it('DM → dm key', () => {
    assert.equal(discordLocationKey(dmFrom('x')), 'discord:dm:5005');
  });
});

// ── classifyMessage: universal ignores ────────────────────────────

describe('classifyMessage — universal ignores', () => {
  it('own message ignored', () => {
    const d = classifyMessage(dmFrom(BOT_ID), ctx());
    assert.equal(d.action, 'ignore');
    assert.equal(d.reason, 'own-message');
  });
  it('other bots ignored (no bot loops)', () => {
    const d = classifyMessage(dmFrom('123', 'hi', { author: { id: '123', bot: true } }), ctx());
    assert.equal(d.action, 'ignore');
    assert.equal(d.reason, 'bot-author');
  });
  it('empty content ignored', () => {
    const d = classifyMessage(dmFrom(WARD_ID, '   '), ctx());
    assert.equal(d.action, 'ignore');
    assert.equal(d.reason, 'no-content');
  });
  it('malformed payload ignored', () => {
    assert.equal(classifyMessage(null, ctx()).action, 'ignore');
  });
});

// ── classifyMessage: DM policy ────────────────────────────────────

describe('classifyMessage — DM policy', () => {
  it('ward DM → respond ward-private (audience null)', () => {
    const d = classifyMessage(dmFrom(WARD_ID), ctx());
    assert.equal(d.action, 'respond');
    assert.equal(d.kind, 'ward-dm');
    assert.equal(d.isWard, true);
    assert.equal(d.audience, null);
  });

  it('registered villager DM → respond gated with villager as participant', () => {
    const d = classifyMessage(dmFrom('777888999000111222'), ctx());
    assert.equal(d.action, 'respond');
    assert.equal(d.kind, 'villager-dm');
    assert.equal(d.isWard, false);
    assert.equal(d.villager.id, 'v-chen');
    assert.deepEqual(d.audience.participants, [{ id: 'v-chen', name: 'Chen' }]);
  });

  it('villager DM registered as a location → location ceiling included', () => {
    const d = classifyMessage(dmFrom('777888999000111222'), ctx());
    // discord:dm:5005 IS in the registry locations
    assert.equal(d.audience.location, 'discord:dm:5005');
  });

  it('villager DM NOT registered as a location → no auto-floor (location null)', () => {
    const registry = makeRegistry();
    registry.locations = registry.locations.filter(l => !l.key.startsWith('discord:dm:'));
    const d = classifyMessage(dmFrom('777888999000111222'), { ...ctx(), registry });
    assert.equal(d.audience.location, null);
  });

  it('unregistered user DM → silently ignored', () => {
    const d = classifyMessage(dmFrom('424242424242'), ctx());
    assert.equal(d.action, 'ignore');
    assert.equal(d.reason, 'unregistered-dm');
  });

  it('ward id matching beats villager alias (ward registered as villager is still ward)', () => {
    const registry = makeRegistry();
    registry.villagers.push({
      id: 'v-ward', name: 'Ward-as-villager', categoryIds: ['cat-friends'],
      aliases: [{ platform: 'discord', id: WARD_ID }], connection: '',
    });
    const d = classifyMessage(dmFrom(WARD_ID), { ...ctx(), registry });
    assert.equal(d.kind, 'ward-dm');
    assert.equal(d.audience, null);
  });
});

// ── classifyMessage: guild policy ─────────────────────────────────

describe('classifyMessage — guild policy', () => {
  it('not mentioned → ignored', () => {
    const d = classifyMessage(guildMsg('777888999000111222'), ctx());
    assert.equal(d.action, 'ignore');
    assert.equal(d.reason, 'not-mentioned');
  });

  it('@-mention → respond with location ceiling always present', () => {
    const msg = guildMsg('777888999000111222', 'hey bot', { mentions: [{ id: BOT_ID }] });
    const d = classifyMessage(msg, ctx());
    assert.equal(d.action, 'respond');
    assert.equal(d.kind, 'guild');
    assert.equal(d.audience.location, 'discord:guild:42:channel:1001');
    assert.deepEqual(d.audience.participants, [{ id: 'v-chen', name: 'Chen' }]);
  });

  it('reply to the bot counts as a mention', () => {
    const msg = guildMsg('777888999000111222', 'sure', {
      referenced_message: { author: { id: BOT_ID } },
    });
    const d = classifyMessage(msg, ctx());
    assert.equal(d.action, 'respond');
  });

  it('unknown speaker mentioned the bot → respond, unknown participant (will floor via resolver)', () => {
    const msg = guildMsg('424242', 'hi bot', { mentions: [{ id: BOT_ID }] });
    const d = classifyMessage(msg, ctx());
    assert.equal(d.action, 'respond');
    assert.deepEqual(d.audience.participants, [{ id: null, name: 'someone' }]);
  });

  it('ward speaking in guild → respond, ward NOT in participants, location still gates', () => {
    const msg = guildMsg(WARD_ID, 'hi bot', { mentions: [{ id: BOT_ID }] });
    const d = classifyMessage(msg, ctx());
    assert.equal(d.action, 'respond');
    assert.equal(d.isWard, true);
    assert.deepEqual(d.audience.participants, []);
    assert.equal(d.audience.location, 'discord:guild:42:channel:1001');
  });

  it('mention of someone else (not the bot) → ignored', () => {
    const msg = guildMsg('777888999000111222', 'hey @other', { mentions: [{ id: 'someone-else' }] });
    const d = classifyMessage(msg, ctx());
    assert.equal(d.action, 'ignore');
  });
});

// ── classifyMessage: guild presence modes (V8) ────────────────────

describe('classifyMessage — guild presence modes', () => {
  const GUILD_KEY = 'discord:guild:42:channel:1001';
  // ctx with the guild location set to a given mode.
  const ctxMode = (mode, extra = {}) => {
    const registry = makeRegistry();
    const loc = registry.locations.find(l => l.key === GUILD_KEY);
    Object.assign(loc, { mode, ...extra });
    return { registry, botUserId: BOT_ID, wardUserId: WARD_ID };
  };

  it('strict (default): not-mentioned → ignore', () => {
    const d = classifyMessage(guildMsg('777888999000111222'), ctxMode('strict'));
    assert.equal(d.action, 'ignore');
    assert.equal(d.reason, 'not-mentioned');
  });

  it('lurk: not-mentioned → observe (read the room, no reply)', () => {
    const d = classifyMessage(guildMsg('777888999000111222'), ctxMode('lurk'));
    assert.equal(d.action, 'observe');
    assert.equal(d.kind, 'guild');
    assert.equal(d.audience.location, GUILD_KEY);
    assert.deepEqual(d.audience.participants, [{ id: 'v-chen', name: 'Chen' }]);
  });

  it('lurk: still replies when addressed', () => {
    const msg = guildMsg('777888999000111222', 'hey bot', { mentions: [{ id: BOT_ID }] });
    const d = classifyMessage(msg, ctxMode('lurk'));
    assert.equal(d.action, 'respond');
    assert.equal(d.ambient, false);
  });

  it('active: not-mentioned → respond with ambient flag + cadence config', () => {
    const d = classifyMessage(guildMsg('777888999000111222'),
      ctxMode('active', { activeStrategy: 'tiers', activeCooldownSec: 45 }));
    assert.equal(d.action, 'respond');
    assert.equal(d.ambient, true);
    assert.equal(d.activeStrategy, 'tiers');
    assert.equal(d.activeCooldownSec, 45);
  });

  it('active: defaults to llm strategy + 60s when unset', () => {
    const d = classifyMessage(guildMsg('777888999000111222'), ctxMode('active'));
    assert.equal(d.ambient, true);
    assert.equal(d.activeStrategy, 'llm');
    assert.equal(d.activeCooldownSec, 60);
  });

  it('active: an @-mention is a direct (non-ambient) reply', () => {
    const msg = guildMsg('777888999000111222', 'hey bot', { mentions: [{ id: BOT_ID }] });
    const d = classifyMessage(msg, ctxMode('active'));
    assert.equal(d.action, 'respond');
    assert.equal(d.ambient, false);
  });

  it('DMs are unaffected by location mode (always respond, never ambient)', () => {
    const d = classifyMessage(dmFrom(WARD_ID), ctxMode('active'));
    assert.equal(d.action, 'respond');
    assert.equal(d.kind, 'ward-dm');
    assert.notEqual(d.ambient, true);
  });
});

describe('classifyMessage — readBots (other bots & Familiars)', () => {
  const GUILD_KEY = 'discord:guild:42:channel:1001';
  // ctx with the guild location set to a mode + optional readBots flag.
  const ctxBots = (readBots, mode = 'strict') => {
    const registry = makeRegistry();
    Object.assign(registry.locations.find(l => l.key === GUILD_KEY), { mode, readBots });
    return { registry, botUserId: BOT_ID, wardUserId: WARD_ID };
  };
  const botMsg = (extra = {}) => guildMsg('555000555000555000', 'beep',
    { author: { id: '555000555000555000', username: 'hogsworth_bot', bot: true }, ...extra });

  it('default: a bot message is ignored (loop guard)', () => {
    const d = classifyMessage(botMsg(), ctxBots(undefined, 'active'));
    assert.equal(d.action, 'ignore');
    assert.equal(d.reason, 'bot-author');
  });

  it('readBots on + active: a bot message becomes an ambient turn', () => {
    const d = classifyMessage(botMsg(), ctxBots(true, 'active'));
    assert.equal(d.action, 'respond');
    assert.equal(d.ambient, true);
  });

  it('readBots on + strict: a bot message that addresses me earns a reply', () => {
    const d = classifyMessage(botMsg({ mentions: [{ id: BOT_ID }] }), ctxBots(true, 'strict'));
    assert.equal(d.action, 'respond');
    assert.equal(d.ambient, false);
  });

  it('readBots on + lurk: an un-addressing bot message is observed', () => {
    const d = classifyMessage(botMsg(), ctxBots(true, 'lurk'));
    assert.equal(d.action, 'observe');
  });

  it('my own message is ignored even where readBots is on (inner loop guard)', () => {
    const mine = guildMsg(BOT_ID, 'beep', { author: { id: BOT_ID, username: 'me', bot: true } });
    const d = classifyMessage(mine, ctxBots(true, 'active'));
    assert.equal(d.action, 'ignore');
    assert.equal(d.reason, 'own-message');
  });
});

// ── decideAmbientReply (the active-mode pacing gate) ───────────────

describe('decideAmbientReply', () => {
  const NOW = 1_000_000_000_000;

  it('llm: first turn (no prior) acts', () => {
    const r = decideAmbientReply({ strategy: 'llm', now: NOW, lastTurnAt: 0, cooldownMs: 60_000 });
    assert.equal(r.act, true);
    assert.equal(r.reason, 'llm');
  });

  it('llm: inside the cooldown window does not act', () => {
    const r = decideAmbientReply({ strategy: 'llm', now: NOW, lastTurnAt: NOW - 30_000, cooldownMs: 60_000 });
    assert.equal(r.act, false);
    assert.equal(r.reason, 'cooldown');
  });

  it('llm: past the cooldown acts again', () => {
    const r = decideAmbientReply({ strategy: 'llm', now: NOW, lastTurnAt: NOW - 61_000, cooldownMs: 60_000 });
    assert.equal(r.act, true);
  });

  it('tiers: a quiet room is "slow" and acts after the base cooldown', () => {
    const r = decideAmbientReply({
      strategy: 'tiers', now: NOW, lastTurnAt: NOW - 61_000, cooldownMs: 60_000,
      recentMsgTimestamps: [NOW - 10_000], // 1 msg in window → slow
    });
    assert.equal(r.tier, 'slow');
    assert.equal(r.act, true);
  });

  it('tiers: a busy room is "medium" and holds off far longer than slow would', () => {
    const recent = Array.from({ length: 6 }, (_, i) => NOW - i * 1000); // 6 msgs in window
    // 90s since last turn: past slow (60s) but inside medium (60s×5=300s).
    const r = decideAmbientReply({
      strategy: 'tiers', now: NOW, lastTurnAt: NOW - 90_000, cooldownMs: 60_000,
      recentMsgTimestamps: recent,
    });
    assert.equal(r.tier, 'medium');
    assert.equal(r.act, false);
    assert.equal(r.reason, 'tier-cooldown');
  });

  it('tiers: a lively room is "fast"', () => {
    const recent = Array.from({ length: 15 }, (_, i) => NOW - i * 1000);
    const r = decideAmbientReply({
      strategy: 'tiers', now: NOW, lastTurnAt: 0, cooldownMs: 60_000,
      recentMsgTimestamps: recent,
    });
    assert.equal(r.tier, 'fast');
    assert.equal(r.act, true);
  });
});

// ── isAmbientAbstain ──────────────────────────────────────────────

describe('isAmbientAbstain', () => {
  it('treats empty / whitespace as abstain', () => {
    assert.equal(isAmbientAbstain(''), true);
    assert.equal(isAmbientAbstain('   \n '), true);
    assert.equal(isAmbientAbstain(null), true);
  });
  it('matches [pass] and [silence] in their canonical and bare forms', () => {
    for (const t of ['[pass]', 'pass', '(pass)', 'PASS.', '[silence]', 'silence', 'SILENCE.']) {
      assert.equal(isAmbientAbstain(t), true, `should abstain: ${t}`);
    }
  });
  it('bare words that are valid chat replies are NOT abstains', () => {
    assert.equal(isAmbientAbstain('nothing'), false);
    assert.equal(isAmbientAbstain('quiet'),   false);
    assert.equal(isAmbientAbstain('skip'),     false);
  });
  it('a real reply is not an abstain', () => {
    assert.equal(isAmbientAbstain('I can pass the salt!'), false);
    assert.equal(isAmbientAbstain('Sure, happy to help.'), false);
  });
});

// ── chunkReply ────────────────────────────────────────────────────

describe('chunkReply', () => {
  it('short reply → single chunk', () => {
    assert.deepEqual(chunkReply('hello'), ['hello']);
  });

  it('empty → no chunks', () => {
    assert.deepEqual(chunkReply(''), []);
    assert.deepEqual(chunkReply(null), []);
  });

  it('long reply split under the limit', () => {
    const text = 'word '.repeat(1000); // 5000 chars
    const chunks = chunkReply(text);
    assert.ok(chunks.length >= 3);
    for (const c of chunks) assert.ok(c.length <= 1900, `chunk too long: ${c.length}`);
  });

  it('prefers newline breaks', () => {
    const para = 'a'.repeat(1000);
    const text = `${para}\n${para}\n${para}`;
    const chunks = chunkReply(text);
    assert.ok(chunks.every(c => c.length <= 1900));
    // No chunk should start or end mid-paragraph with a dangling partial line
    assert.ok(chunks[0].endsWith('a'));
  });

  it('content preserved across chunks (modulo trimmed whitespace)', () => {
    const text = 'word '.repeat(1000).trim();
    const joined = chunkReply(text).join(' ');
    assert.equal(joined.replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
  });
});

// ── mergeParticipant ──────────────────────────────────────────────

describe('mergeParticipant', () => {
  it('adds a new villager participant', () => {
    const out = mergeParticipant([], { id: 'v-chen', name: 'Chen' });
    assert.deepEqual(out, [{ id: 'v-chen', name: 'Chen' }]);
  });

  it('dedupes by villager id', () => {
    const out = mergeParticipant(
      [{ id: 'v-chen', name: 'Chen' }],
      { id: 'v-chen', name: 'Chen (renamed)' },
    );
    assert.equal(out.length, 1);
  });

  it('dedupes unknowns by case-insensitive name', () => {
    const out = mergeParticipant(
      [{ id: null, name: 'Rando' }],
      { id: null, name: 'rando' },
    );
    assert.equal(out.length, 1);
  });

  it('different unknowns accumulate', () => {
    const out = mergeParticipant(
      [{ id: null, name: 'Rando' }],
      { id: null, name: 'OtherRando' },
    );
    assert.equal(out.length, 2);
  });

  it('does not mutate the input array', () => {
    const input = [{ id: null, name: 'Rando' }];
    mergeParticipant(input, { id: null, name: 'New' });
    assert.equal(input.length, 1);
  });
});

// ── GATEWAY_INTENTS ───────────────────────────────────────────────

describe('GATEWAY_INTENTS', () => {
  it('includes GUILDS, GUILD_MESSAGES, DIRECT_MESSAGES, MESSAGE_CONTENT', () => {
    assert.ok(GATEWAY_INTENTS & (1 << 0),  'GUILDS');
    assert.ok(GATEWAY_INTENTS & (1 << 9),  'GUILD_MESSAGES');
    assert.ok(GATEWAY_INTENTS & (1 << 12), 'DIRECT_MESSAGES');
    assert.ok(GATEWAY_INTENTS & (1 << 15), 'MESSAGE_CONTENT');
  });
  it('does not include presence or member intents (privileged, unneeded)', () => {
    assert.equal(GATEWAY_INTENTS & (1 << 8), 0,  'GUILD_PRESENCES not requested');
    assert.equal(GATEWAY_INTENTS & (1 << 1), 0,  'GUILD_MEMBERS not requested');
  });
});

// ── Rate-limit bucket (V5) ────────────────────────────────────────

describe('checkRateLimit', () => {
  beforeEach(() => resetRateLimitState());

  it('passes when no limit is set (perHour=0)', () => {
    assert.deepEqual(checkRateLimit('loc:A', 0), { ok: true });
  });

  it('passes when no limit is set (perHour=null)', () => {
    assert.deepEqual(checkRateLimit('loc:A', null), { ok: true });
  });

  it('passes on first call within the limit', () => {
    assert.equal(checkRateLimit('loc:A', 5).ok, true);
  });

  it('passes when count is below the limit', () => {
    checkRateLimit('loc:A', 3);           // initialises bucket
    consumeRateSlot('loc:A');             // count = 1
    consumeRateSlot('loc:A');             // count = 2
    assert.equal(checkRateLimit('loc:A', 3).ok, true);
  });

  it('blocks when count reaches the limit', () => {
    checkRateLimit('loc:A', 2);
    consumeRateSlot('loc:A');
    consumeRateSlot('loc:A');
    const r = checkRateLimit('loc:A', 2);
    assert.equal(r.ok, false);
    assert.ok(typeof r.resetAt === 'number' && r.resetAt > Date.now(), 'resetAt is a future timestamp');
  });

  it('resetRateLimitState clears all buckets (simulates window expiry)', () => {
    checkRateLimit('loc:B', 1);
    consumeRateSlot('loc:B');
    assert.equal(checkRateLimit('loc:B', 1).ok, false, 'exhausted before reset');
    resetRateLimitState();
    assert.equal(checkRateLimit('loc:B', 1).ok, true,  'fresh after reset');
  });

  it('different location keys are independent buckets', () => {
    checkRateLimit('loc:X', 1);
    consumeRateSlot('loc:X');
    assert.equal(checkRateLimit('loc:X', 1).ok, false, 'loc:X exhausted');
    assert.equal(checkRateLimit('loc:Y', 1).ok, true,  'loc:Y unaffected');
  });
});

describe('resolveMentions — making the room legible', () => {
  const villagers = [{
    id: 'v-chen', name: 'Chen',
    aliases: [{ platform: 'discord', id: '777' }],
  }];

  it('resolves a villager mention to their configured name', () => {
    const out = resolveMentions('hey <@777> look', { villagers, mentions: [{ id: '777' }] });
    assert.equal(out, 'hey @Chen look');
  });

  it('resolves my own id to my character name', () => {
    const out = resolveMentions('<@999> hi', { botUserId: '999', charName: 'Hogsworth', mentions: [{ id: '999' }] });
    assert.equal(out, '@Hogsworth hi');
  });

  it('falls back to the payload display name for unknown users (other Familiars/bots)', () => {
    const out = resolveMentions('<@555> Liar', {
      villagers, mentions: [{ id: '555', global_name: 'Hogsworth', username: 'hogsworth_bot' }],
    });
    assert.equal(out, '@Hogsworth Liar');
  });

  it('handles the nickname form <@!id>', () => {
    const out = resolveMentions('<@!777>!', { villagers, mentions: [{ id: '777' }] });
    assert.equal(out, '@Chen!');
  });

  it('leaves text without mentions untouched (cheap fast-path)', () => {
    assert.equal(resolveMentions('no pings here', { villagers }), 'no pings here');
  });

  it('unknown id with no payload entry becomes @someone, never a raw snowflake', () => {
    const out = resolveMentions('<@12345> who?', {});
    assert.equal(out, '@someone who?');
  });
});

describe('directedAtOthers — recognising an exchange is not mine', () => {
  const villagers = [{
    id: 'v-chen', name: 'Chen',
    aliases: [{ platform: 'discord', id: '777' }],
  }];

  it('names another Familiar a message was @-mentioned at (the reported case)', () => {
    const msg = { mentions: [{ id: '555', global_name: 'Hogsworth' }], content: '<@555> Liar' };
    assert.deepEqual(directedAtOthers(msg, { botUserId: '999', villagers }), ['Hogsworth']);
  });

  it('prefers the villager name over the payload display name', () => {
    const msg = { mentions: [{ id: '777', global_name: 'chen_draws' }] };
    assert.deepEqual(directedAtOthers(msg, { botUserId: '999', villagers }), ['Chen']);
  });

  it('excludes me — a mention of my own id is not "directed at others"', () => {
    const msg = { mentions: [{ id: '999', global_name: 'Me' }] };
    assert.deepEqual(directedAtOthers(msg, { botUserId: '999', villagers }), []);
  });

  it('includes a reply target when replying to someone else', () => {
    const msg = { mentions: [], referenced_message: { author: { id: '555', global_name: 'Hogsworth' } } };
    assert.deepEqual(directedAtOthers(msg, { botUserId: '999', villagers }), ['Hogsworth']);
  });

  it('de-duplicates when the same person is both mentioned and the reply target', () => {
    const msg = {
      mentions: [{ id: '777' }],
      referenced_message: { author: { id: '777', global_name: 'chen_draws' } },
    };
    assert.deepEqual(directedAtOthers(msg, { botUserId: '999', villagers }), ['Chen']);
  });

  it('open-room chatter (no mentions, no reply) is directed at no one', () => {
    assert.deepEqual(directedAtOthers({ content: 'lol' }, { botUserId: '999', villagers }), []);
  });
});
