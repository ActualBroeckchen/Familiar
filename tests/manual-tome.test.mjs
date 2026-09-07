// The self-documenting manual tome + live tome macros.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { resolveTomeMacros, TOME_MACROS, TOME_MACRO_NAMES } from '../src/tomes/tome-macros.js';
import { buildManualTome, ensureManualTome, MANUAL_TOME_ID, MANUAL_TOME_NAME, MANUAL_TOME_VERSION } from '../src/tomes/manual-tome.js';
import { foldLoreForPrompt } from '../src/tomes/tome-lore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── macros ─────────────────────────────────────────────────────────
test('resolveTomeMacros: toggles reflect the actual setting (on/off)', () => {
  // vision defaults ON (active unless explicitly false); voice defaults OFF.
  assert.match(resolveTomeMacros('vision is {{visionActive}}', {}), /vision is on/);
  assert.match(resolveTomeMacros('vision is {{visionActive}}', { visionEnabled: false }), /vision is off/);
  assert.match(resolveTomeMacros('voice is {{voiceActive}}', {}), /voice is off/);
  assert.match(resolveTomeMacros('voice is {{voiceActive}}', { voiceEnabled: true }), /voice is on/);
  assert.match(resolveTomeMacros('discord {{discordActive}}', { discordEnabled: true }), /discord on/);
  assert.match(resolveTomeMacros('pondering {{ponderingActive}}', { ponderingEnabled: false }), /pondering off/);
});

test('resolveTomeMacros: value macros + name macros', () => {
  const s = { charName: 'Hogsworth', userName: 'Zara', tomeScanDepth: 6,
    primaryConnectionId: 'c1', connections: [{ id: 'c1', name: 'GLM', model: 'glm-5.3' }] };
  const out = resolveTomeMacros('{{char}} runs on {{activeModel}} for {{userName}}, depth {{scanDepth}}', s);
  assert.equal(out, 'Hogsworth runs on GLM for Zara, depth 6');
  assert.match(resolveTomeMacros('model {{activeModel}}', {}), /model not set/);   // no connection
});

test('resolveTomeMacros: unknown tokens untouched, whitespace tolerant, never throws', () => {
  assert.equal(resolveTomeMacros('keep {{unknownThing}}', {}), 'keep {{unknownThing}}');
  assert.match(resolveTomeMacros('v {{ visionActive }}', {}), /v on/);   // spaces inside braces
  assert.doesNotThrow(() => resolveTomeMacros(null, null));
});

test('foldLoreForPrompt applies the injected resolver to entry content', () => {
  const activated = { sys_top: [{ content: 'Vision: {{visionActive}}' }], before_char: [], after_char: [], sys_bottom: [], at_depth: [] };
  const folded = foldLoreForPrompt(activated, (t) => resolveTomeMacros(t, { visionEnabled: false }));
  assert.equal(folded.lead, 'Vision: off');
});

// ── manual tome shape ──────────────────────────────────────────────
test('buildManualTome: enabled + graduation-protected, keyed entries with content', () => {
  const t = buildManualTome();
  assert.equal(t.id, MANUAL_TOME_ID);
  assert.equal(t.name, MANUAL_TOME_NAME);
  assert.equal(t.enabled, true);
  assert.equal(t.graduationExempt, true);
  const entries = Object.values(t.entries);
  assert.ok(entries.length >= 10, 'comprehensive: at least ~10 topic entries');
  for (const e of entries) {
    assert.ok(Array.isArray(e.keys) && e.keys.length > 0, 'every entry has keywords');
    assert.ok(typeof e.content === 'string' && e.content.trim().length > 0, 'every entry has content');
    assert.ok(e.enabled, 'entries enabled');
  }
});

test('buildManualTome: the images entry is keyed to "send you pictures" and quotes {{visionActive}}', () => {
  const t = buildManualTome();
  const imgEntry = Object.values(t.entries).find(e => e.keys.includes('send you pictures'));
  assert.ok(imgEntry, 'there is a pictures entry');
  assert.match(imgEntry.content, /\{\{visionActive\}\}/);
});

test('buildManualTome: the video entry quotes {{videoActive}} and names GLM 5.3 Flash', () => {
  const t = buildManualTome();
  const vid = Object.values(t.entries).find(e => e.keys.includes('watch a video'));
  assert.ok(vid, 'there is a video entry');
  assert.match(vid.content, /\{\{videoActive\}\}/);
  assert.match(vid.content, /GLM 5\.3 Flash/);
  assert.match(vid.content, /Can watch video\?/);
});

// ── seed-once behavior ─────────────────────────────────────────────
test('ensureManualTome: seeds once, then respects deletion (flag-tracked)', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pf-manual-'));
  try {
    const first = await ensureManualTome(dir);
    assert.equal(first.seeded, true);
    const file = path.join(dir, `${MANUAL_TOME_ID}.json`);
    const written = JSON.parse(await fsp.readFile(file, 'utf8'));
    assert.equal(written.name, MANUAL_TOME_NAME);
    assert.equal(written.graduationExempt, true);

    // Ward deletes it — a second boot must NOT resurrect it (flag remains).
    await fsp.rm(file);
    const second = await ensureManualTome(dir);
    assert.equal(second.seeded, false);
    assert.equal(second.reason, 'already-current');
    await assert.rejects(() => fsp.access(file));   // stays gone
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

const FLAG = '.manual-tome-seeded.json';

// Force a "the app shipped a newer manual" state by rewinding the flag's version.
async function rewindFlag(dir, over = {}) {
  const flagPath = path.join(dir, FLAG);
  const flag = JSON.parse(await fsp.readFile(flagPath, 'utf8'));
  await fsp.writeFile(flagPath, JSON.stringify({ ...flag, version: MANUAL_TOME_VERSION - 1, ...over }, null, 2), 'utf8');
}

test('ensureManualTome: refreshes an UNEDITED manual when the version bumps', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pf-manual-'));
  try {
    await ensureManualTome(dir);                    // seed at current version + hash
    const file = path.join(dir, `${MANUAL_TOME_ID}.json`);
    await fsp.writeFile(file, JSON.stringify({ id: MANUAL_TOME_ID, stale: true }, null, 2), 'utf8');
    // Flag now claims the OLD version but its hash matches the ORIGINAL seed, not
    // this stale file — so re-point the hash at the stale file to model "unedited
    // since we last wrote it", then rewind the version.
    const flagPath = path.join(dir, FLAG);
    const { createHash } = await import('crypto');
    const staleHash = createHash('sha256').update(await fsp.readFile(file, 'utf8')).digest('hex');
    const flag = JSON.parse(await fsp.readFile(flagPath, 'utf8'));
    await fsp.writeFile(flagPath, JSON.stringify({ ...flag, version: MANUAL_TOME_VERSION - 1, contentHash: staleHash }, null, 2), 'utf8');

    const r = await ensureManualTome(dir);
    assert.equal(r.refreshed, true);
    const rewritten = JSON.parse(await fsp.readFile(file, 'utf8'));
    assert.equal(rewritten.name, MANUAL_TOME_NAME);   // real manual restored
    assert.ok(!rewritten.stale);
    const flag2 = JSON.parse(await fsp.readFile(flagPath, 'utf8'));
    assert.equal(flag2.version, MANUAL_TOME_VERSION);  // caught up
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('ensureManualTome: does NOT clobber a ward-edited manual on a version bump', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pf-manual-'));
  try {
    await ensureManualTome(dir);
    const file = path.join(dir, `${MANUAL_TOME_ID}.json`);
    // Ward edits the manual (hash now diverges from the flag's contentHash)...
    await fsp.writeFile(file, JSON.stringify({ id: MANUAL_TOME_ID, name: 'My Custom Manual' }, null, 2), 'utf8');
    await rewindFlag(dir);   // ...and the app ships a newer version

    const r = await ensureManualTome(dir);
    assert.equal(r.refreshed, false);
    assert.equal(r.reason, 'ward-edited');
    const kept = JSON.parse(await fsp.readFile(file, 'utf8'));
    assert.equal(kept.name, 'My Custom Manual');   // the ward's edit survives
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('ensureManualTome: a pre-hash flag (old install) refreshes on upgrade', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pf-manual-'));
  try {
    const file = path.join(dir, `${MANUAL_TOME_ID}.json`);
    const flagPath = path.join(dir, FLAG);
    // Model an install seeded by the pre-hash code: a v1 flag with NO contentHash.
    await fsp.writeFile(file, JSON.stringify({ id: MANUAL_TOME_ID, old: true }, null, 2), 'utf8');
    await fsp.writeFile(flagPath, JSON.stringify({ seededAt: '2026-01-01T00:00:00Z', version: 1 }, null, 2), 'utf8');

    const r = await ensureManualTome(dir);
    assert.equal(r.refreshed, true);   // treated as pristine → refreshed
    const rewritten = JSON.parse(await fsp.readFile(file, 'utf8'));
    assert.equal(rewritten.name, MANUAL_TOME_NAME);
    const flag2 = JSON.parse(await fsp.readFile(flagPath, 'utf8'));
    assert.equal(flag2.version, MANUAL_TOME_VERSION);
    assert.ok(flag2.contentHash);   // now hash-tracked going forward
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ── client/server parity ───────────────────────────────────────────
test('every server tome macro is mirrored in app.js applyNameVars', async () => {
  const app = await fsp.readFile(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  for (const name of TOME_MACRO_NAMES) {
    assert.ok(app.includes(name), `app.js applyNameVars is missing the "${name}" macro (parity drift)`);
  }
  // and there is at least one of each kind wired
  assert.ok(TOME_MACRO_NAMES.includes('visionActive'));
  assert.equal(typeof TOME_MACROS.visionActive, 'function');
});
