// Warm reach-out decision module — pure helpers + degradation.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getWarmVillagers,
  parseReachoutDecision,
  buildReachoutPrompt,
  decideReachoutViaLLM,
} from '../reachout.js';

// ── getWarmVillagers ────────────────────────────────────────────────

test('getWarmVillagers: only warm + Discord-reachable villagers', () => {
  const reg = {
    villagers: [
      { id: 'a', name: 'Warm Discord', relationToFamiliar: 'warm',
        aliases: [{ platform: 'discord', id: '111' }] },
      { id: 'b', name: 'Warm No-Discord', relationToFamiliar: 'warm',
        aliases: [{ platform: 'whatsapp', id: '+1' }] },
      { id: 'c', name: 'Neutral Discord', relationToFamiliar: 'neutral',
        aliases: [{ platform: 'discord', id: '222' }] },
      { id: 'd', name: 'Hostile', relationToFamiliar: 'hostile',
        aliases: [{ platform: 'discord', id: '333' }] },
      { id: 'e', name: 'Untagged', aliases: [{ platform: 'discord', id: '444' }] },
    ],
  };
  const warm = getWarmVillagers(reg);
  assert.equal(warm.length, 1);
  assert.equal(warm[0].id, 'a');
  assert.equal(warm[0].discordId, '111');
});

test('getWarmVillagers: empty/garbage registries never throw', () => {
  assert.deepEqual(getWarmVillagers(null), []);
  assert.deepEqual(getWarmVillagers({}), []);
  assert.deepEqual(getWarmVillagers({ villagers: [] }), []);
});

// ── parseReachoutDecision ───────────────────────────────────────────

test('parseReachoutDecision: wait', () => {
  assert.deepEqual(parseReachoutDecision('{"action":"wait","nextCheckInMs":7200000}'),
    { action: 'wait', nextCheckInMs: 7200000 });
});

test('parseReachoutDecision: ward reach-out', () => {
  const d = parseReachoutDecision('{"action":"reach_out","target":"ward","message":"hey, thinking of you","nextCheckInMs":7200000}');
  assert.equal(d.action, 'reach_out');
  assert.equal(d.target, 'ward');
  assert.equal(d.message, 'hey, thinking of you');
});

test('parseReachoutDecision: ward reach-out carries tell uid+index', () => {
  const d = parseReachoutDecision('{"action":"reach_out","target":"ward","message":"x","tellUid":"u1","tellIndex":2}');
  assert.equal(d.tellUid, 'u1');
  assert.equal(d.tellIndex, 2);
});

test('parseReachoutDecision: villager reach-out needs a villagerId', () => {
  const ok = parseReachoutDecision('{"action":"reach_out","target":"villager","villagerId":"v1","message":"hi Chen"}');
  assert.equal(ok.target, 'villager');
  assert.equal(ok.villagerId, 'v1');
  // Missing villagerId → falls back to wait, never a malformed send.
  const bad = parseReachoutDecision('{"action":"reach_out","target":"villager","message":"hi"}');
  assert.equal(bad.action, 'wait');
});

test('parseReachoutDecision: reach_out with empty message → wait', () => {
  assert.equal(parseReachoutDecision('{"action":"reach_out","target":"ward","message":"  "}').action, 'wait');
});

test('parseReachoutDecision: garbage → wait, never throws', () => {
  assert.equal(parseReachoutDecision('not json').action, 'wait');
  assert.equal(parseReachoutDecision('').action, 'wait');
  assert.equal(parseReachoutDecision(null).action, 'wait');
});

// ── buildReachoutPrompt — warmth framing, not crisis ────────────────

test('buildReachoutPrompt: is warm, names both costs, not bias-toward-quiet', () => {
  const p = buildReachoutPrompt({
    nowBlock: '[Now] test',
    identityContext: 'I am someone.',
    sessionBlock: '',
    pendingTells: [],
    warmVillagers: [],
    wardSilencePhrase: '2 hours',
  });
  // Explicitly NOT a crisis frame.
  assert.match(p, /not a crisis/i);
  // Both costs named (hollow outreach AND the cost of never reaching out).
  assert.match(p, /hollow/i);
  assert.match(p, /starves|withers|never reaching out/i);
  // No catastrophic bias-toward-quiet language.
  assert.doesNotMatch(p, /bias toward (staying )?quiet/i);
  assert.doesNotMatch(p, /only reach out when.*obvious/i);
  // Anchors to identity / own voice, not a default-care register.
  assert.match(p, /my own (voice|fondness)/i);
});

test('buildReachoutPrompt: lists warm villagers with ids and the no-covert mirror', () => {
  const p = buildReachoutPrompt({
    nowBlock: '', identityContext: '', sessionBlock: '',
    pendingTells: [],
    warmVillagers: [{ id: 'v1', name: 'Chen', relationToWard: 'friend', commStyleNotes: '' }],
    wardSilencePhrase: '1 hour',
  });
  assert.match(p, /Chen/);
  assert.match(p, /v1/);
  assert.match(p, /mirror/i);
});

test('buildReachoutPrompt: surfaces pending tells with uid+index', () => {
  const p = buildReachoutPrompt({
    nowBlock: '', identityContext: '', sessionBlock: '',
    pendingTells: [{ uid: 'u9', index: 0, summary: 'ask how the interview went' }],
    warmVillagers: [],
    wardSilencePhrase: '3 hours',
  });
  assert.match(p, /interview went/);
  assert.match(p, /u9/);
});

// ── decideReachoutViaLLM — degradation ──────────────────────────────

test('decideReachoutViaLLM: no primary connection → wait (no LLM call)', async () => {
  let called = false;
  const d = await decideReachoutViaLLM({
    callLLM: async () => { called = true; return '{}'; },
    enrichFn: async () => ({ static: '' }),
    getRecentMessagesFn: async () => [],
  });
  assert.equal(d.action, 'wait');
  assert.equal(called, false, 'no LLM call without a configured connection');
});
