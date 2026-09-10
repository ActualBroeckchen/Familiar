// name-field.js — the shared OpenAI `name`-field machinery: the code-minted
// handle, the optimistic-with-400-fallback capability policy, and its persisted
// provider:model cap cache (survives restart; a model change re-probes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';

import {
  speakerNameField, nameFieldEnabledFor, recordNameFieldResult,
  _resetNameFieldCache, withNameFieldFallback, hydrateNameFieldCache,
  stampNamesOnTurns, sendWithNames,
} from '../name-field.js';

const NAME_SAFE = /^[^\s]+$/;   // the OpenAI `name` charset: no whitespace

// ── speakerNameField ────────────────────────────────────────────────
test('speakerNameField: handles are name-safe; ward/villager/material/assistant', () => {
  assert.equal(speakerNameField({ role: 'user', speaker: 'Chen Wei' }), 'chen-wei');
  assert.match(speakerNameField({ role: 'user', speaker: 'José García' }), NAME_SAFE);
  assert.equal(speakerNameField({ role: 'user', speaker: null, wardName: 'Mary Anne' }), 'ward-mary-anne');
  assert.equal(speakerNameField({ role: 'user', speaker: null, wardName: '' }), 'ward');
  assert.equal(speakerNameField({ role: 'user', material: true, speaker: 'x' }), 'session-archive');
  assert.equal(speakerNameField({ role: 'assistant', speaker: 'Chen' }), undefined);
});

// ── stampNamesOnTurns ───────────────────────────────────────────────
test('stampNamesOnTurns: stamps people-bearing user turns, leaves system/assistant alone', () => {
  const msgs = [
    { role: 'system', content: 'identity' },
    { role: 'user', content: 'hi', speaker: null },            // the ward
    { role: 'assistant', content: 'hey' },                     // the Familiar
    { role: 'user', content: '[Chen]: yo', speaker: 'Chen' },  // a villager
    { role: 'user', content: 'an old log', material: true },   // archived material
  ];
  const out = stampNamesOnTurns(msgs, { wardName: 'Mary Anne' });
  assert.equal('name' in out[0], false, 'system carries no name');
  assert.equal(out[1].name, 'ward-mary-anne');
  assert.equal('name' in out[2], false, 'assistant carries no name');
  assert.equal(out[3].name, 'chen');
  assert.equal(out[4].name, 'session-archive');
  // Pure: the input array is untouched (returns a copy).
  assert.equal('name' in msgs[1], false, 'original not mutated');
});

test('stampNamesOnTurns: stamp:false strips any name fields (the bare arm of the fallback)', () => {
  const msgs = [{ role: 'user', content: 'hi', name: 'ward-x' }, { role: 'assistant', content: 'hey' }];
  const bare = stampNamesOnTurns(msgs, { stamp: false });
  assert.equal('name' in bare[0], false, 'name stripped for the bare retry');
  assert.equal(bare[1].content, 'hey');
});

// ── capability policy (in-memory, persistence off) ──────────────────
test('nameFieldEnabledFor: optimistic default; ward tri-state and learned verdict override', () => {
  _resetNameFieldCache();
  const job = { provider: 'prov-a', model: 'm1', baseUrl: null };
  assert.equal(nameFieldEnabledFor(job, {}), true, 'optimistic default');
  assert.equal(nameFieldEnabledFor(job, { connections: [{ provider: 'prov-a', model: 'm1', baseUrl: null, nameFieldCapable: 'no' }] }), false);
  assert.equal(nameFieldEnabledFor(job, { connections: [{ provider: 'prov-a', model: 'm1', baseUrl: null, nameFieldCapable: 'yes' }] }), true);
  recordNameFieldResult(job, 'no');
  assert.equal(nameFieldEnabledFor(job, {}), false, 'learned no');
  // Ward tri-state still wins over a learned verdict.
  assert.equal(nameFieldEnabledFor(job, { connections: [{ provider: 'prov-a', model: 'm1', baseUrl: null, nameFieldCapable: 'yes' }] }), true);
  _resetNameFieldCache();
});

// ── 400 fallback ────────────────────────────────────────────────────
test('withNameFieldFallback: 400 on names retries bare once and learns no; a real error is not masked', async () => {
  _resetNameFieldCache();
  // names on, provider rejects with 400 → retry bare, learn 'no'
  let calls = 0; const learned = [];
  const recovered = await withNameFieldFallback({
    withNames: true,
    buildMessages: (names) => ({ names }),
    callProviderFn: (m) => { calls++; if (m.names) throw new Error('Provider x returned 400: bad name'); return 'bare-ok'; },
    onLearn: (v) => learned.push(v),
  });
  assert.equal(recovered, 'bare-ok');
  assert.equal(calls, 2);
  assert.deepEqual(learned, ['no']);

  // a non-400 error is a real error — propagates, no bare retry
  await assert.rejects(() => withNameFieldFallback({
    withNames: true,
    buildMessages: (names) => ({ names }),
    callProviderFn: () => { throw new Error('Provider x returned 500: boom'); },
    onLearn: () => {},
  }), /500/);
});

// ── sendWithNames: the surface seam (stamp → 400 → bare → learn) ────
test('sendWithNames: stamps, and on a name-field 400 retries bare once + learns no', async () => {
  _resetNameFieldCache();
  const job = { provider: 'p', model: 'm', baseUrl: null };
  const seen = [];
  const send = async (msgs) => {
    seen.push(msgs);
    if (msgs.some(m => 'name' in m)) throw new Error('provider p returned 400: name rejected');
    return 'bare-reply';
  };
  const out = await sendWithNames({
    job, settings: {}, wardName: 'Mary Anne',
    messages: [{ role: 'user', content: 'hi' }],
    send,
  });
  assert.equal(out, 'bare-reply');
  assert.equal(seen.length, 2, 'one stamped attempt, one bare retry');
  assert.equal(seen[0][0].name, 'ward-mary-anne', 'first attempt stamped the ward');
  assert.equal('name' in seen[1][0], false, 'retry was bare');
  assert.equal(nameFieldEnabledFor(job, {}), false, 'learned the provider 400s on names');
  _resetNameFieldCache();
});

test('sendWithNames: the off-switch sends bare and learns nothing', async () => {
  _resetNameFieldCache();
  const job = { provider: 'p2', model: 'm', baseUrl: null };
  let sawName = true;
  await sendWithNames({
    job, settings: {}, wardName: 'Bee', disabled: true,
    messages: [{ role: 'user', content: 'hi' }],
    send: async (msgs) => { sawName = 'name' in msgs[0]; return 'ok'; },
  });
  assert.equal(sawName, false, 'no name stamped when disabled');
  assert.equal(nameFieldEnabledFor(job, {}), true, 'nothing learned (still optimistic)');
  _resetNameFieldCache();
});

// ── persistence: survives a "restart"; a model change re-probes ─────
test('persistence: a learned no survives a rehydrate, and a model change re-probes', async () => {
  const file = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'namecap-')), 'cap.json');
  const jobM1 = { provider: 'prov-z', model: 'm1', baseUrl: null };
  const jobM2 = { provider: 'prov-z', model: 'm2', baseUrl: null };   // same connection, new model

  _resetNameFieldCache();
  hydrateNameFieldCache(file);                 // enable persistence to the temp file
  await recordNameFieldResult(jobM1, 'no');    // learn + write through (awaited for the test)

  // Simulate a restart: drop the in-memory cache, then reload from disk.
  _resetNameFieldCache();
  hydrateNameFieldCache(file);
  assert.equal(nameFieldEnabledFor(jobM1, {}), false, 'learned no survived the rehydrate');
  // A model change is a new provider:model key → nothing learned → optimistic.
  assert.equal(nameFieldEnabledFor(jobM2, {}), true, 'a model change re-probes (optimistic)');

  _resetNameFieldCache();
  await fsp.rm(path.dirname(file), { recursive: true, force: true });
});

// ── persistence OFF by default keeps tests hermetic (no stray file) ──
test('recordNameFieldResult writes nothing when persistence was never enabled', async () => {
  _resetNameFieldCache();                      // also disables persistence
  const job = { provider: 'prov-none', model: 'm', baseUrl: null };
  const ret = recordNameFieldResult(job, 'no');
  await ret;                                   // no-op promise; must not throw
  assert.equal(nameFieldEnabledFor(job, {}), false, 'still tracked in memory');
  _resetNameFieldCache();
});
