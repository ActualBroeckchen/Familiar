// discord-emotes.js — custom emotes → readable alt-text via a describe-once cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';

import {
  parseEmotes, emoteCdnUrl, rewriteEmotes, describeUnseenEmotes, readEmoteCache,
} from '../src/discord/discord-emotes.js';

// ── parseEmotes ─────────────────────────────────────────────────────
test('parseEmotes: pulls static + animated custom emotes, dedups by id, ignores unicode', () => {
  const got = parseEmotes('hi <:tiredcat:123456> and <a:party:789012> and 😺 and <:tiredcat:123456> again');
  assert.equal(got.length, 2, 'the repeated emote is deduped, unicode ignored');
  assert.deepEqual(got[0], { raw: '<:tiredcat:123456>', animated: false, name: 'tiredcat', id: '123456' });
  assert.equal(got[1].animated, true);
  assert.equal(got[1].name, 'party');
});

test('parseEmotes: empty / non-string → []', () => {
  assert.deepEqual(parseEmotes(''), []);
  assert.deepEqual(parseEmotes(null), []);
  assert.deepEqual(parseEmotes('just text, no emotes'), []);
});

// ── emoteCdnUrl ─────────────────────────────────────────────────────
test('emoteCdnUrl: animated → gif, static → png', () => {
  assert.match(emoteCdnUrl('123', false), /cdn\.discordapp\.com\/emojis\/123\.png\?size=/);
  assert.match(emoteCdnUrl('123', true), /\/emojis\/123\.gif\?size=/);
});

// ── rewriteEmotes ───────────────────────────────────────────────────
test('rewriteEmotes: described → alt-text; undescribed → plain :name:', () => {
  const cache = { 123456: { name: 'tiredcat', description: 'a very tired-looking cat' } };
  const out = rewriteEmotes('look <:tiredcat:123456> and <:mystery:999888>', cache);
  assert.equal(out, 'look :tiredcat: [= a very tired-looking cat] and :mystery:');
});

test('rewriteEmotes: no cache → all plain shorthands (fail-soft)', () => {
  assert.equal(rewriteEmotes('<a:party:789012>', {}), ':party:');
  assert.equal(rewriteEmotes('plain text'), 'plain text');
});

// ── describeUnseenEmotes ────────────────────────────────────────────
test('describeUnseenEmotes: describes an unseen emote once and caches by id', async () => {
  const cacheFile = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'emotes-')), 'c.json');
  let saved = 0, described = 0;
  await describeUnseenEmotes(
    [{ id: '123', name: 'tiredcat', animated: false }],
    {
      cacheFile,
      fetchEmote: async () => ({ buffer: Buffer.from('png'), mime: 'image/png' }),
      saveAsset: async () => { saved++; return { id: 'asset-x', slugs: ['tiredcat-x1'] }; },
      describeAsset: async () => { described++; return { description: { text: 'a very tired-looking cat' } }; },
    },
  );
  assert.equal(saved, 1);
  assert.equal(described, 1);
  const cache = await readEmoteCache(cacheFile);
  assert.equal(cache['123'].description, 'a very tired-looking cat');
  assert.equal(cache['123'].assetId, 'tiredcat-x1');

  // A second pass over the same emote is a no-op (already described).
  await describeUnseenEmotes(
    [{ id: '123', name: 'tiredcat', animated: false }],
    { cacheFile, fetchEmote: async () => { throw new Error('should not fetch'); }, saveAsset: async () => { saved++; return {}; }, describeAsset: async () => { described++; return {}; } },
  );
  assert.equal(saved, 1, 'no re-save');
  assert.equal(described, 1, 'no re-describe');
  await fsp.rm(path.dirname(cacheFile), { recursive: true, force: true });
});

const quiet = { warn() {}, log() {} };

test('describeUnseenEmotes: fail-soft — a fetch miss leaves it uncached, never throws', async () => {
  const cacheFile = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'emotes-')), 'c.json');
  await describeUnseenEmotes(
    [{ id: '404', name: 'gone', animated: false }],
    { cacheFile, fetchEmote: async () => null, saveAsset: async () => ({ id: 'x' }), describeAsset: async () => ({}), log: quiet },
  );
  const cache = await readEmoteCache(cacheFile);
  assert.equal(cache['404'], undefined, 'nothing cached when the fetch fails');
  await fsp.rm(path.dirname(cacheFile), { recursive: true, force: true });
});

test('describeUnseenEmotes: a describe that returns no text is LOGGED (not silent) and left uncached', async () => {
  const cacheFile = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'emotes-')), 'c.json');
  const warnings = [];
  await describeUnseenEmotes(
    [{ id: '555', name: 'feral', animated: false }],
    {
      cacheFile,
      fetchEmote: async () => ({ buffer: Buffer.from('png'), mime: 'image/png' }),
      saveAsset: async () => ({ id: 'a', slugs: ['feral-x1'] }),
      describeAsset: async () => ({ ok: false, reason: 'no-vision-connection' }),   // e.g. no vision configured
      log: { warn: (m) => warnings.push(m), log() {} },
    },
  );
  assert.equal((await readEmoteCache(cacheFile))['555'], undefined, 'not cached without a description');
  assert.ok(warnings.some(w => /feral/.test(w) && /no-vision-connection/.test(w)),
    'the reason it produced nothing is logged, so the miss is diagnosable');
  await fsp.rm(path.dirname(cacheFile), { recursive: true, force: true });
});

test('describeUnseenEmotes: missing deps or empty list → no-op, no throw', async () => {
  await describeUnseenEmotes([], {});                                             // empty
  await describeUnseenEmotes([{ id: '1', name: 'x' }], { log: quiet });           // no saveAsset/describeAsset
  assert.ok(true, 'returned without throwing');
});
