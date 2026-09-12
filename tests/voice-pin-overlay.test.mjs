// Runtime voice-model pins go in a git-IGNORED overlay, never the tracked
// voice-model-pins.json — so installing an optional model in-UI can't make the
// ward's next `git pull` abort on "local changes" to a file they never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../repo-root.js';
import { mergePinTables } from '../src/voice/voice-models.js';

test('mergePinTables: overlay wins per id, both tables visible, junk ignored', () => {
  const shipped = { 'asr-offline': { files: [{ sha256: 'a' }] }, 'tts-pocket': { files: [] } };
  const local = { 'asr-offline': { files: [{ sha256: 'b' }] }, 'speaker-campp': { files: [{ sha256: 'c' }] } };
  const merged = mergePinTables(shipped, local);
  assert.equal(merged['asr-offline'].files[0].sha256, 'b', 'the local overlay overrides the shipped pin of the same id');
  assert.ok(merged['tts-pocket'], 'a shipped-only id survives');
  assert.ok(merged['speaker-campp'], 'a runtime-only id is visible');
  assert.deepEqual(mergePinTables(null, undefined, ['x'], { k: 1 }), { k: 1 }, 'non-objects are skipped');
});

test('the runtime overlay is git-ignored (so an in-UI install never dirties the tree)', async () => {
  const ignore = await fsp.readFile(path.join(REPO_ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^voice-model-pins\.local\.json$/m,
    'voice-model-pins.local.json must be gitignored — without it the pull-abort bug returns');
});

test('voice-pin.js writes the LOCAL overlay, never the tracked pins file', async () => {
  const src = await fsp.readFile(path.join(REPO_ROOT, 'src/voice/voice-pin.js'), 'utf8');
  // The write target is the overlay constant; the tracked file is only ever read.
  assert.match(src, /writeLocalPins\(/, 'the runtime writer targets the overlay');
  assert.doesNotMatch(src, /writeFile\([^)]*\bPINS_FILE\b/, 'the tracked voice-model-pins.json must not be written at runtime');
});
