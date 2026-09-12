import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  archiveKind, isArchive, entryIsSafe, extractArchive,
  writeMarker, readMarker, isExtractedFrom, MARKER,
} from '../src/voice/voice-extract.js';

const run = promisify(execFile);
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'vx-'));

/**
 * Build a real .tar.bz2 with Python, so these tests exercise the actual
 * decompress→untar path rather than a mock of it.
 */
async function makeArchive(dir, { root = 'pkg', entries, evilPath = null }) {
  const script = `
import tarfile, io, os
out = ${JSON.stringify(path.join(dir, 'a.tar.bz2'))}
with tarfile.open(out, 'w:bz2') as tf:
    for name, data in ${JSON.stringify(entries)}:
        b = data.encode()
        ti = tarfile.TarInfo(${JSON.stringify(root)} + '/' + name)
        ti.size = len(b)
        tf.addfile(ti, io.BytesIO(b))
    evil = ${evilPath ? JSON.stringify(evilPath) : 'None'}
    if evil:
        b = b'pwned'
        ti = tarfile.TarInfo(evil)
        ti.size = len(b)
        tf.addfile(ti, io.BytesIO(b))
`;
  await run('python3', ['-c', script]);
  return path.join(dir, 'a.tar.bz2');
}

test('archive kinds are recognized by extension; anything else is a plain file', () => {
  assert.equal(archiveKind('m.tar.bz2'), 'tar.bz2');
  assert.equal(archiveKind('M.TBZ2'), 'tar.bz2');
  assert.equal(archiveKind('m.tgz'), 'tar.gz');
  assert.equal(archiveKind('m.tar'), 'tar');
  assert.equal(archiveKind('silero_vad_v5.onnx'), null);
  assert.equal(isArchive('silero_vad_v5.onnx'), false);
  assert.equal(isArchive('sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2'), true);
});

test('entryIsSafe rejects every shape of escape', () => {
  const dest = '/tmp/dest';
  assert.equal(entryIsSafe(dest, 'model.onnx'), true);
  assert.equal(entryIsSafe(dest, 'nested/model.onnx'), true);
  assert.equal(entryIsSafe(dest, '../escape.onnx'), false);
  assert.equal(entryIsSafe(dest, 'a/../../escape.onnx'), false);
  assert.equal(entryIsSafe(dest, '/etc/passwd'), false);
  assert.equal(entryIsSafe(dest, 'a\\..\\..\\escape'), false);
  assert.equal(entryIsSafe(dest, ''), false);
  assert.equal(entryIsSafe(dest, null), false);
});

test('a real .tar.bz2 unpacks, strips its wrapper directory, and reports on-disk bytes', async () => {
  const dir = await tmp();
  try {
    const archive = await makeArchive(dir, {
      root: 'sherpa-onnx-model-2026',
      entries: [['encoder.onnx', 'x'.repeat(500)], ['tokens.txt', 'hello'], ['sub/decoder.onnx', 'y'.repeat(300)]],
    });
    const dest = path.join(dir, 'out');
    const r = await extractArchive({ archivePath: archive, destDir: dest });

    assert.equal(r.ok, true);
    assert.equal(r.fileCount, 3);
    assert.equal(r.bytes, 805, 'on-disk bytes, not the compressed download size');

    // strip:1 removed the wrapper — files land directly in the model dir
    assert.deepEqual((await fs.readdir(dest)).sort(), ['encoder.onnx', 'sub', 'tokens.txt']);
    assert.equal(await fs.readFile(path.join(dest, 'tokens.txt'), 'utf8'), 'hello');
    assert.equal(await fs.readFile(path.join(dest, 'sub', 'decoder.onnx'), 'utf8'), 'y'.repeat(300));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a traversal entry is rejected and nothing is written outside the destination', async () => {
  const dir = await tmp();
  try {
    const archive = await makeArchive(dir, {
      root: 'pkg',
      entries: [['good.onnx', 'fine']],
      evilPath: '../../pwned.txt',
    });
    const dest = path.join(dir, 'nest', 'out');
    const r = await extractArchive({ archivePath: archive, destDir: dest });

    assert.equal(r.ok, true);
    assert.ok(r.rejected >= 1, 'the escaping entry must be counted as rejected');
    assert.deepEqual(await fs.readdir(dest), ['good.onnx']);
    assert.equal(await fs.access(path.join(dir, 'pwned.txt')).then(() => true, () => false), false);
    assert.equal(await fs.access(path.join(dir, 'nest', 'pwned.txt')).then(() => true, () => false), false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a corrupt archive fails cleanly and leaves no half-unpacked directory', async () => {
  const dir = await tmp();
  try {
    const bad = path.join(dir, 'bad.tar.bz2');
    await fs.writeFile(bad, Buffer.from('this is not bzip2 at all'));
    const dest = path.join(dir, 'out');
    const r = await extractArchive({ archivePath: bad, destDir: dest });

    assert.equal(r.ok, false);
    assert.equal(r.reason, 'extract-failed');
    assert.equal(await fs.access(dest).then(() => true, () => false), false, 'no directory that looks installed');
    assert.equal(await fs.access(`${dest}.unpacking`).then(() => true, () => false), false, 'no leftover temp');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a non-archive is refused rather than silently treated as one', async () => {
  const dir = await tmp();
  try {
    const r = await extractArchive({ archivePath: path.join(dir, 'x.onnx'), destDir: path.join(dir, 'out') });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-an-archive');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('extraction replaces a previous unpack rather than merging into it', async () => {
  const dir = await tmp();
  try {
    const dest = path.join(dir, 'out');
    await fs.mkdir(dest, { recursive: true });
    await fs.writeFile(path.join(dest, 'stale-from-old-pin.onnx'), 'old');

    const archive = await makeArchive(dir, { root: 'pkg', entries: [['fresh.onnx', 'new']] });
    const r = await extractArchive({ archivePath: archive, destDir: dest });

    assert.equal(r.ok, true);
    assert.deepEqual(await fs.readdir(dest), ['fresh.onnx'], 'a stale file from an older pin must not survive');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('the marker records which archive produced the directory, and answers the question that matters', async () => {
  const dir = await tmp();
  try {
    const dest = path.join(dir, 'out');
    await fs.mkdir(dest, { recursive: true });
    const sha = 'a'.repeat(64);
    await writeMarker(dest, { sha256: sha, archiveName: 'm.tar.bz2', files: [{ name: 'x' }], bytes: 123 });

    const m = await readMarker(dest);
    assert.equal(m.sha256, sha);
    assert.equal(m.bytes, 123);
    assert.match(m.extractedAt, /^\d{4}-\d{2}-\d{2}T/);

    assert.equal(await isExtractedFrom(dest, sha), true);
    assert.equal(await isExtractedFrom(dest, 'b'.repeat(64)), false, 'a directory from a DIFFERENT pin is not installed');
    assert.equal(await isExtractedFrom(path.join(dir, 'nowhere'), sha), false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a model directory with files but no marker does not count as installed', async () => {
  const dir = await tmp();
  try {
    const dest = path.join(dir, 'out');
    await fs.mkdir(dest, { recursive: true });
    await fs.writeFile(path.join(dest, 'encoder.onnx'), 'looks convincing');
    assert.equal(await isExtractedFrom(dest, 'a'.repeat(64)), false);
    assert.equal(await readMarker(dest), null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('the marker lives inside the model directory under a known name', async () => {
  const dir = await tmp();
  try {
    const dest = path.join(dir, 'out');
    await fs.mkdir(dest, { recursive: true });
    await writeMarker(dest, { sha256: 'c'.repeat(64), archiveName: 'm.tar.bz2', files: [], bytes: 0 });
    assert.ok((await fs.readdir(dest)).includes(MARKER));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('kind is read from the original filename, not the content-addressed blob path', async () => {
  // Regression: blobs are named by sha256 with no extension, so deriving the
  // archive kind from the on-disk path called every archive a plain file.
  const dir = await tmp();
  try {
    const archive = await makeArchive(dir, { root: 'pkg', entries: [['m.onnx', 'data']] });
    const blobLike = path.join(dir, '9e27b783c20e67b0d0f13a258c1861fce199917c969d9176a438bee38df64962');
    await fs.rename(archive, blobLike);

    const bare = await extractArchive({ archivePath: blobLike, destDir: path.join(dir, 'a') });
    assert.equal(bare.ok, false, 'no extension and no hint: correctly refused');
    assert.equal(bare.reason, 'not-an-archive');

    const hinted = await extractArchive({ archivePath: blobLike, destDir: path.join(dir, 'b'), name: 'model.tar.bz2' });
    assert.equal(hinted.ok, true, 'the original filename is what says it is an archive');
    assert.deepEqual(await fs.readdir(path.join(dir, 'b')), ['m.onnx']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
