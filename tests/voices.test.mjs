import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  voiceFileName, resolveVoice, installVoice, saveWardVoice, listLocalVoices,
  bundledVoicePath, installedVoicePath, BUNDLED_FILE, BUNDLED_SUBDIR, WARD_SUBDIR, INSTALLED_SUBDIR,
} from '../src/voice/voices.js';
import { DEFAULT_VOICE, VOICE_PROVENANCE, attributionNotice, SHORTLIST, preferEnhanced } from '../src/voice/voice-catalogue.js';
import { loadCatalogue, clipKey } from '../src/voice/voice-clips.js';

/**
 * `loadCatalogue` memoises on first call and ignores `rootDir` afterwards.
 * That is harmless in production — there is exactly one root — but it means a
 * test using a temp root would silently get an empty catalogue or the repo's,
 * depending on ordering. So warm it against the repo deliberately, and let the
 * temp roots be about the FILESYSTEM only.
 */
const REPO = process.cwd();
loadCatalogue(REPO);

async function tmpRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voices-'));
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** A root with the bundled clip present, as a real checkout has. */
async function rootWithBundled() {
  const { dir, cleanup } = await tmpRoot();
  await fs.mkdir(path.join(dir, BUNDLED_SUBDIR), { recursive: true });
  await fs.writeFile(path.join(dir, BUNDLED_SUBDIR, BUNDLED_FILE), 'RIFFfake');
  return { dir, cleanup };
}

// ── Keys becoming filenames ─────────────────────────────────────────────

test('a catalogue key becomes one flat filename', () => {
  assert.equal(voiceFileName('vctk/p255_023/original'), 'vctk__p255_023__original.wav');
});

test('a key that would escape the voices directory is refused, not sanitised', () => {
  // Silently "fixing" a malformed key would mean reading or writing a file
  // nobody asked for. Refusing says so.
  for (const bad of [
    '../../etc/passwd',
    'vctk/../../../etc/passwd',
    'vctk/../etc/x',
    'vctk/p255/..',
    'vctk\\p255\\original',
    'vctk/p255',
    'vctk/p255/original/extra',
    '', null, undefined, 42,
  ]) {
    assert.equal(voiceFileName(bad), null, `${String(bad)} should not become a filename`);
  }
});

test('installedVoicePath refuses an unsafe key rather than returning a path outside voices/', () => {
  assert.equal(installedVoicePath('/root', '../../x/y/z'), null);
  assert.ok(installedVoicePath('/root', 'vctk/p255_023/original').includes(INSTALLED_SUBDIR));
});

// ── Resolving what I speak in ───────────────────────────────────────────

test('with nothing chosen I speak in the bundled voice', async () => {
  const { dir, cleanup } = await rootWithBundled();
  try {
    const r = await resolveVoice({ rootDir: dir, settings: {} });
    assert.equal(r.ok, true);
    assert.equal(r.key, DEFAULT_VOICE.key);
    assert.equal(r.path, bundledVoicePath(dir));
    assert.equal(r.provenance, VOICE_PROVENANCE.BUNDLED);
    assert.equal(r.fellBackFrom, null, 'the default is not a fallback — it is the choice');
  } finally { await cleanup(); }
});

test('a chosen voice that is not downloaded falls back AND says it fell back', async () => {
  // Speaking in a voice my human did not choose, without telling them, is the
  // silent-substitution failure. Refusing to speak at all takes read-aloud
  // from the people it is for. So: both.
  const { dir, cleanup } = await rootWithBundled();
  try {
    const r = await resolveVoice({ rootDir: dir, settings: { voiceTts: { voice: 'vctk/p254_023/original' } } });
    assert.equal(r.ok, true, 'read-aloud still works');
    assert.equal(r.key, DEFAULT_VOICE.key);
    assert.equal(r.fellBackFrom, 'vctk/p254_023/original', 'and the substitution is visible');
    assert.match(r.reason, /not downloaded/);
  } finally { await cleanup(); }
});

test('a chosen voice that IS downloaded is the one used', async () => {
  const { dir, cleanup } = await rootWithBundled();
  try {
    const key = 'vctk/p254_023/original';
    const p = installedVoicePath(dir, key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, 'RIFFfake');

    const r = await resolveVoice({ rootDir: dir, settings: { voiceTts: { voice: key } } });
    assert.equal(r.key, key);
    assert.equal(r.path, p);
    assert.equal(r.fellBackFrom, null);
  } finally { await cleanup(); }
});

test("a clip my human gave me resolves from their own directory", async () => {
  const { dir, cleanup } = await rootWithBundled();
  try {
    await fs.mkdir(path.join(dir, WARD_SUBDIR), { recursive: true });
    await fs.writeFile(path.join(dir, WARD_SUBDIR, 'grandmother.wav'), 'RIFFfake');

    const r = await resolveVoice({ rootDir: dir, settings: { voiceTts: { voice: 'ward:grandmother.wav' } } });
    assert.equal(r.ok, true);
    assert.equal(r.provenance, VOICE_PROVENANCE.WARD_SUPPLIED, 'so it can never ride out in a shared artifact');
    assert.equal(r.fellBackFrom, null);
  } finally { await cleanup(); }
});

test('a ward voice name carrying a path is refused, not opened', async () => {
  const { dir, cleanup } = await rootWithBundled();
  try {
    const r = await resolveVoice({ rootDir: dir, settings: { voiceTts: { voice: 'ward:../../../etc/passwd' } } });
    assert.equal(r.key, DEFAULT_VOICE.key, 'it fell back rather than reading outside voices/');
    assert.match(r.reason, /not a name I can open/);
  } finally { await cleanup(); }
});

test('a missing bundled clip is named, not reported as a vague failure', async () => {
  // This means a broken checkout. "Voice unavailable" would send someone
  // hunting through settings for a problem that is one absent file.
  const { dir, cleanup } = await tmpRoot();
  try {
    const r = await resolveVoice({ rootDir: dir, settings: {} });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-voice-on-disk');
    assert.match(r.detail, /p255_023_enhanced\.wav/);
  } finally { await cleanup(); }
});

test('resolveVoice never throws, whatever the settings hold', async () => {
  const { dir, cleanup } = await rootWithBundled();
  try {
    for (const voice of [null, 42, {}, [], '', 'nonsense', 'a/b/c/d', 'ward:']) {
      const r = await resolveVoice({ rootDir: dir, settings: { voiceTts: { voice } } });
      assert.equal(typeof r.ok, 'boolean', `${JSON.stringify(voice)} produced no structured result`);
    }
  } finally { await cleanup(); }
});

// ── Installing a chosen clip ────────────────────────────────────────────

const realClip = () => {
  const c = loadCatalogue(REPO).clips.find((x) => clipKey(x) === 'vctk/p254_023/original');
  assert.ok(c, 'the catalogue should hold the shortlist');
  return c;
};

test('an install verifies the checksum — a nearly-right voice is not the one they picked', async () => {
  const { dir, cleanup } = await rootWithBundled();
  try {
    const clip = realClip();
    const r = await installVoice({
      rootDir: dir, key: clipKey(clip),
      fetchImpl: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('not the right bytes') }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'checksum');
    assert.equal(await fs.readdir(path.join(dir, INSTALLED_SUBDIR)).then((f) => f.length, () => 0), 0,
      'nothing was kept');
  } finally { await cleanup(); }
});

test('matching bytes install, and installing twice is a no-op', async () => {
  const { dir, cleanup } = await rootWithBundled();
  try {
    const clip = realClip();
    // Bytes whose hash IS the pinned one cannot be fabricated, so stub the
    // clip's expectation instead: what is under test is the verify-then-keep
    // path, not sha256 itself.
    const bytes = Buffer.from('pretend this is a wav');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const patched = { ...clip, sha256: sha };
    const cat = loadCatalogue(REPO);
    const idx = cat.clips.findIndex((x) => clipKey(x) === clipKey(clip));
    const original = cat.clips[idx];
    cat.clips[idx] = patched;
    try {
      const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => bytes });
      const r = await installVoice({ rootDir: dir, key: clipKey(clip), fetchImpl });
      assert.equal(r.ok, true);
      assert.equal(r.alreadyInstalled, false);
      assert.equal(r.bytes, bytes.length);

      const again = await installVoice({ rootDir: dir, key: clipKey(clip), fetchImpl });
      assert.equal(again.alreadyInstalled, true, 'a second install re-downloads nothing');
    } finally { cat.clips[idx] = original; }
  } finally { await cleanup(); }
});

test('a network failure is a structured refusal, never a throw', async () => {
  const { dir, cleanup } = await rootWithBundled();
  try {
    const r = await installVoice({
      rootDir: dir, key: 'vctk/p254_023/original',
      fetchImpl: async () => { throw new Error('offline'); },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'network');
  } finally { await cleanup(); }
});

test('an unknown key installs nothing', async () => {
  const { dir, cleanup } = await rootWithBundled();
  try {
    const r = await installVoice({ rootDir: dir, key: 'made/up/key', fetchImpl: async () => { throw new Error('should not be reached'); } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unknown-clip');
  } finally { await cleanup(); }
});

// ── Ward-supplied clips ─────────────────────────────────────────────────

test('a ward clip is kept under their own directory', async () => {
  const { dir, cleanup } = await rootWithBundled();
  try {
    const r = await saveWardVoice({ rootDir: dir, name: 'a-friend.wav', bytes: Buffer.from('RIFFfake') });
    assert.equal(r.ok, true);
    assert.equal(r.key, 'ward:a-friend.wav');
    assert.ok(r.path.includes(WARD_SUBDIR));
  } finally { await cleanup(); }
});

test('a ward clip name that is a path, or not a wav, is refused', async () => {
  const { dir, cleanup } = await rootWithBundled();
  try {
    for (const name of ['../escape.wav', 'sub/dir.wav', 'notaudio.txt', '', null]) {
      const r = await saveWardVoice({ rootDir: dir, name, bytes: Buffer.from('x') });
      assert.equal(r.ok, false, `${String(name)} should be refused`);
    }
  } finally { await cleanup(); }
});

test('an empty clip is refused rather than written as a voice that cannot speak', async () => {
  const { dir, cleanup } = await rootWithBundled();
  try {
    const r = await saveWardVoice({ rootDir: dir, name: 'empty.wav', bytes: Buffer.alloc(0) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty');
  } finally { await cleanup(); }
});

test('what is on disk is listed by where it came from', async () => {
  const { dir, cleanup } = await rootWithBundled();
  try {
    await saveWardVoice({ rootDir: dir, name: 'mine.wav', bytes: Buffer.from('x') });
    const p = installedVoicePath(dir, 'vctk/p254_023/original');
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, 'x');

    const local = await listLocalVoices(dir);
    assert.deepEqual(local.bundled, [DEFAULT_VOICE.key]);
    assert.deepEqual(local.installed, ['vctk/p254_023/original'], 'the flat filename reads back as its key');
    assert.deepEqual(local.ward, ['ward:mine.wav']);
  } finally { await cleanup(); }
});

test('listing on a machine with nothing extra is empty, not an error', async () => {
  const { dir, cleanup } = await tmpRoot();
  try {
    const local = await listLocalVoices(dir);
    assert.deepEqual(local.installed, []);
    assert.deepEqual(local.ward, []);
  } finally { await cleanup(); }
});

// ── The licence obligation that shipping a clip creates ─────────────────

test('the bundled clip carries its CC BY credit, generated rather than written by hand', () => {
  const notice = attributionNotice(undefined, {
    bundled: { ...DEFAULT_VOICE, file: `voices/bundled/${BUNDLED_FILE}` },
  });
  assert.match(notice, /Shipped in this repository/);
  assert.match(notice, /p255_023_enhanced\.wav/);
  assert.match(notice, /University of Edinburgh/, 'the CC BY 4.0 attribution VCTK requires');
  assert.match(notice, /CC BY 4\.0/);
});

test('the notice still works with no bundled clip named — the old contract holds', () => {
  const notice = attributionNotice();
  assert.doesNotMatch(notice, /Shipped in this repository/);
  assert.match(notice, /VCTK/);
});

// ── Every offered voice must actually exist ─────────────────────────────

test('the default voice and every shortlist key resolve to a real clip', () => {
  // Caught a live bug: switching the shortlist to the enhanced recordings
  // pointed four entries at files that do not exist, because the LibriVox
  // clips were never given an enhanced pass. A key that resolves to nothing is
  // a voice my human can choose and then not have.
  const keys = new Set(loadCatalogue(REPO).clips.map(clipKey));
  const missing = [DEFAULT_VOICE.key, ...SHORTLIST.map((v) => v.key)].filter((k) => !keys.has(k));
  assert.deepEqual(missing, [], `offered but absent from the catalogue: ${missing.join(', ')}`);
});

test('the bundled default is the enhanced recording — upstream reproduces sample quality', () => {
  // "the audio quality of the sample is also reproduced" — Kyutai's own README.
  // Measured: same pitch, same duration, ~23% more high-frequency energy.
  assert.match(DEFAULT_VOICE.key, /\/enhanced$/);
  assert.equal(BUNDLED_FILE, 'p255_023_enhanced.wav');
});

test('preferEnhanced upgrades only where an enhanced recording exists', () => {
  const keys = new Set(loadCatalogue(REPO).clips.map(clipKey));
  assert.equal(preferEnhanced('vctk/p254_023/original', keys), 'vctk/p254_023/enhanced');
  assert.equal(
    preferEnhanced('voice-zero/caro_davy/original', keys),
    'voice-zero/caro_davy/original',
    'no enhanced pass exists for the LibriVox clips',
  );
  assert.equal(preferEnhanced('vctk/p254_023/enhanced', keys), 'vctk/p254_023/enhanced');
  for (const bad of [null, undefined, 42]) assert.equal(preferEnhanced(bad, keys), bad);
});
