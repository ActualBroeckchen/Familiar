import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  fetchPlan, inspectInstalled, outstandingBytes, sweepTemp,
  reclaimModels, consentSummary, blobPath, installedPath, hashFile,
} from '../src/voice/voice-fetch.js';

const MB = 1024 * 1024;
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** A local origin so the fetcher's real streaming/hashing path is exercised, not a stub. */
async function withServer(routes, fn) {
  const server = http.createServer((req, res) => {
    const body = routes[req.url];
    if (body === undefined) { res.writeHead(404); res.end(); return; }
    if (body === 'BOOM') { res.writeHead(500); res.end(); return; }
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { await new Promise((r) => server.close(r)); }
}

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'vfetch-'));
}

const model = (id, files) => ({ id, label: id, estBytes: 1000, files });

test('an unpinned model is refused outright — download-and-hope is not a fallback', async () => {
  const dir = await tmpDir();
  try {
    const plan = { all: [model('m1', [{ name: 'a.onnx', url: 'http://127.0.0.1:1/a', sha256: null, bytes: 10 }])] };
    const r = await fetchPlan({ plan, modelsDir: dir });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unpinned');
    assert.match(r.message, /pinning script/);
    assert.deepEqual(await fs.readdir(dir), [], 'nothing may be written when the plan is refused');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('an empty plan is a refusal, not a silent success', async () => {
  const dir = await tmpDir();
  try {
    const r = await fetchPlan({ plan: { all: [] }, modelsDir: dir });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty-plan');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('the pre-flight refusal happens BEFORE any bytes move', async () => {
  const dir = await tmpDir();
  const body = Buffer.alloc(2048, 7);
  try {
    await withServer({ '/a': body }, async (base) => {
      const plan = { all: [model('m1', [{ name: 'a.onnx', url: `${base}/a`, sha256: sha(body), bytes: body.length }])] };
      // An absurd reserve makes any real disk refuse.
      const r = await fetchPlan({ plan, modelsDir: dir, reserveBytes: 1024 * 1024 * MB });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'below-reserve');
      assert.equal(r.installed.length, 0);
      assert.equal(await fs.readdir(dir).then((f) => f.length), 0);
    });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a verified download installs, is content-addressed, and reports honestly', async () => {
  const dir = await tmpDir();
  const body = Buffer.alloc(4096, 3);
  try {
    await withServer({ '/a': body }, async (base) => {
      const digest = sha(body);
      const plan = { all: [model('m1', [{ name: 'a.onnx', url: `${base}/a`, sha256: digest, bytes: body.length }])] };

      const phases = [];
      const r = await fetchPlan({ plan, modelsDir: dir, onProgress: (e) => phases.push(e.phase) });

      assert.equal(r.ok, true);
      assert.equal(r.installed.length, 1);
      assert.equal(r.installed[0].reused, false);
      assert.equal(await hashFile(blobPath(dir, digest)), digest, 'the blob is the bytes we verified');
      assert.equal((await fs.stat(installedPath(dir, 'm1', 'a.onnx'))).size, body.length);
      assert.ok(phases.includes('preflight') && phases.includes('verified') && phases.includes('done'));
    });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a checksum mismatch deletes the download and installs nothing', async () => {
  const dir = await tmpDir();
  const body = Buffer.alloc(2048, 9);
  try {
    await withServer({ '/a': body }, async (base) => {
      const wrong = 'f'.repeat(64);
      const plan = { all: [model('m1', [{ name: 'a.onnx', url: `${base}/a`, sha256: wrong, bytes: body.length }])] };
      const r = await fetchPlan({ plan, modelsDir: dir });

      assert.equal(r.ok, false);
      assert.equal(r.reason, 'checksum');
      assert.match(r.message, /can't verify|isn't what I expected/);
      assert.equal(await fs.access(blobPath(dir, wrong)).then(() => true, () => false), false);
      const tmp = await fs.readdir(path.join(dir, '.tmp')).catch(() => []);
      assert.deepEqual(tmp, [], 'the partial must not survive a failed verification');
    });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a dead origin fails cleanly and leaves nothing behind', async () => {
  const dir = await tmpDir();
  const body = Buffer.alloc(512, 1);
  try {
    await withServer({ '/a': 'BOOM' }, async (base) => {
      const plan = { all: [model('m1', [{ name: 'a.onnx', url: `${base}/a`, sha256: sha(body), bytes: body.length }])] };
      const r = await fetchPlan({ plan, modelsDir: dir });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'http');
      assert.equal(r.installed.length, 0);
      const tmp = await fs.readdir(path.join(dir, '.tmp')).catch(() => []);
      assert.deepEqual(tmp, []);
    });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a second fetch reuses the held blob instead of downloading again', async () => {
  const dir = await tmpDir();
  const body = Buffer.alloc(4096, 5);
  try {
    await withServer({ '/a': body }, async (base) => {
      const digest = sha(body);
      const plan = { all: [model('m1', [{ name: 'a.onnx', url: `${base}/a`, sha256: digest, bytes: body.length }])] };
      await fetchPlan({ plan, modelsDir: dir });

      // Point the URL at a dead address: if it tried to download, this fails.
      const plan2 = { all: [model('m1', [{ name: 'a.onnx', url: 'http://127.0.0.1:1/gone', sha256: digest, bytes: body.length }])] };
      const r2 = await fetchPlan({ plan: plan2, modelsDir: dir });
      assert.equal(r2.ok, true);
      assert.equal(r2.installed[0].reused, true);
    });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('two models sharing a file store the bytes once — switching tiers does not duplicate a shared voice', async () => {
  const dir = await tmpDir();
  const body = Buffer.alloc(8192, 2);
  try {
    await withServer({ '/shared': body }, async (base) => {
      const digest = sha(body);
      const f = () => ({ name: 'shared.onnx', url: `${base}/shared`, sha256: digest, bytes: body.length });
      const plan = { all: [model('m1', [f()]), model('m2', [f()])] };
      const r = await fetchPlan({ plan, modelsDir: dir });

      assert.equal(r.ok, true);
      assert.equal(r.installed.length, 2);
      assert.equal(r.installed[1].reused, true, 'the second model reuses the first model\'s bytes');

      const shard = await fs.readdir(path.join(dir, 'blobs', digest.slice(0, 2)));
      assert.equal(shard.length, 1, 'exactly one copy of the bytes exists');
    });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('outstandingBytes counts only what is still missing, so a tier upgrade is not charged twice', async () => {
  const dir = await tmpDir();
  const body = Buffer.alloc(4096, 6);
  try {
    await withServer({ '/a': body }, async (base) => {
      const digest = sha(body);
      const plan = { all: [model('m1', [{ name: 'a.onnx', url: `${base}/a`, sha256: digest, bytes: body.length }])] };

      const before = await outstandingBytes({ plan, modelsDir: dir });
      assert.equal(before.bytes, body.length);
      // A plain file occupies what it downloads, so peak equals download here.
      assert.equal(before.peakBytes, body.length);
      assert.equal(before.estimated, false);

      await fetchPlan({ plan, modelsDir: dir });
      const after = await outstandingBytes({ plan, modelsDir: dir });
      assert.equal(after.bytes, 0);
      assert.equal(after.peakBytes, 0);
    });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('inspectInstalled distinguishes missing, present, and corrupt rather than trusting a filename', async () => {
  const dir = await tmpDir();
  const body = Buffer.alloc(2048, 4);
  try {
    await withServer({ '/a': body }, async (base) => {
      const digest = sha(body);
      const plan = { all: [model('m1', [{ name: 'a.onnx', url: `${base}/a`, sha256: digest, bytes: body.length }])] };

      let i = await inspectInstalled({ plan, modelsDir: dir });
      assert.equal(i.models[0].files[0].state, 'missing');
      assert.equal(i.allComplete, false);

      await fetchPlan({ plan, modelsDir: dir });
      i = await inspectInstalled({ plan, modelsDir: dir });
      assert.equal(i.models[0].files[0].state, 'present');
      assert.equal(i.allComplete, true);

      // Corrupt the blob; the shallow check still says present, the deep one catches it.
      await fs.writeFile(blobPath(dir, digest), Buffer.alloc(2048, 99));
      assert.equal((await inspectInstalled({ plan, modelsDir: dir })).models[0].files[0].state, 'present');
      assert.equal((await inspectInstalled({ plan, modelsDir: dir, deep: true })).models[0].files[0].state, 'corrupt');
    });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('an unpinned entry is reported as unpinned by inspection, not as missing', async () => {
  const dir = await tmpDir();
  try {
    const plan = { all: [model('m1', [{ name: 'a.onnx', url: 'http://x/', sha256: null, bytes: 1 }])] };
    const i = await inspectInstalled({ plan, modelsDir: dir });
    assert.equal(i.models[0].files[0].state, 'unpinned');
    assert.equal(i.models[0].pinned, false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('reclaim frees a model but never a blob another installed model still needs', async () => {
  const dir = await tmpDir();
  const shared = Buffer.alloc(8192, 8);
  const solo = Buffer.alloc(4096, 1);
  try {
    await withServer({ '/shared': shared, '/solo': solo }, async (base) => {
      const sd = sha(shared);
      const sl = sha(solo);
      const m1 = model('m1', [{ name: 's.onnx', url: `${base}/shared`, sha256: sd, bytes: shared.length }]);
      const m2 = model('m2', [
        { name: 's.onnx', url: `${base}/shared`, sha256: sd, bytes: shared.length },
        { name: 'o.onnx', url: `${base}/solo`, sha256: sl, bytes: solo.length },
      ]);
      await fetchPlan({ plan: { all: [m1, m2] }, modelsDir: dir });

      const r = await reclaimModels({ plan: { all: [m2] }, modelsDir: dir, keepBlobsFor: [m1] });
      assert.equal(r.freedBytes, solo.length, 'only the unshared blob is freed');
      assert.equal(await fs.access(blobPath(dir, sd)).then(() => true, () => false), true, 'the shared blob survives');
      assert.equal(await fs.access(blobPath(dir, sl)).then(() => true, () => false), false);
      assert.equal(await fs.access(installedPath(dir, 'm1', 's.onnx')).then(() => true, () => false), true);
    });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('sweepTemp clears partials and is safe when there is nothing to clear', async () => {
  const dir = await tmpDir();
  try {
    assert.deepEqual(await sweepTemp(dir), { removed: 0 });
    await fs.mkdir(path.join(dir, '.tmp'), { recursive: true });
    await fs.writeFile(path.join(dir, '.tmp', 'x.part'), 'junk');
    assert.deepEqual(await sweepTemp(dir), { removed: 1 });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('the consent summary refuses to say "can proceed" while anything is unpinned', async () => {
  const dir = await tmpDir();
  try {
    const plan = { all: [model('m1', [{ name: 'a.onnx', url: 'http://x/', sha256: null, bytes: 1 }])] };
    plan.voice = plan.all[0];
    plan.capability = [];
    plan.extras = [];
    const s = await consentSummary({ plan, modelsDir: dir });
    assert.equal(s.canProceed, false);
    assert.match(s.text, /^This downloads about /, 'an estimate must be hedged');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('the pre-flight sizes the PEAK — an archive and its unpacked copy both exist during install', async () => {
  const dir = await tmpDir();
  try {
    // A 100 MB archive that unpacks to 130 MB needs 230 MB of headroom at the
    // moment of installation, not 100. Sizing only the download would start a
    // fetch that cannot finish.
    const m = {
      id: 'arc', label: 'Arc', estBytes: 1,
      files: [{ name: 'model.tar.bz2', url: 'https://e.test/a', sha256: 'd'.repeat(64), bytes: 100, diskBytes: 130 }],
    };
    const need = await outstandingBytes({ plan: { all: [m] }, modelsDir: dir });
    assert.equal(need.bytes, 100, 'the download is what crosses the network');
    assert.equal(need.peakBytes, 230, 'the peak is what the disk must survive');

    // A plain file has no unpack step, so peak is just its size.
    const plain = {
      id: 'plain', label: 'Plain', estBytes: 1,
      files: [{ name: 'model.onnx', url: 'https://e.test/b', sha256: 'e'.repeat(64), bytes: 50, diskBytes: 50 }],
    };
    const p = await outstandingBytes({ plan: { all: [plain] }, modelsDir: dir });
    assert.equal(p.peakBytes, 50);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('an archive with no measured unpacked size falls back to the download and flags the estimate', async () => {
  const dir = await tmpDir();
  try {
    const m = {
      id: 'arc', label: 'Arc', estBytes: 1,
      files: [{ name: 'model.tar.bz2', url: 'https://e.test/a', sha256: 'f'.repeat(64), bytes: 100 }],
    };
    const need = await outstandingBytes({ plan: { all: [m] }, modelsDir: dir });
    assert.equal(need.peakBytes, 200, 'unknown unpacked size assumes at least the download again');
    assert.equal(need.estimated, true, 'and says the figure is not measured');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ── The never-throw contract ─────────────────────────────────────────────
//
// Raised by review on `downloadToTemp`'s unguarded mkdir. The audit that
// followed found six unguarded filesystem calls across this module and
// voice-extract.js, so these test the CONTRACT rather than the one line:
// every path returns a structured result, because this runs behind a
// ward-facing button that must never surface a stack trace.
//
// A file used as a parent directory forces a portable mkdir failure (ENOTDIR
// on Linux/macOS, ENOENT on Windows) without needing permission games.

async function dirUnderAFile() {
  const root = await tmpDir();
  const blocker = path.join(root, 'not-a-directory');
  await fs.writeFile(blocker, 'this is a file, so nothing can be created inside it');
  return { root, unusable: path.join(blocker, 'models') };
}

test('an unwritable models directory returns a result, it does not throw', async () => {
  const { root, unusable } = await dirUnderAFile();
  const body = Buffer.alloc(64, 1);
  try {
    await withServer({ '/a': body }, async (base) => {
      const plan = { all: [model('m1', [{ name: 'a.onnx', url: `${base}/a`, sha256: sha(body), bytes: body.length }])] };
      const r = await fetchPlan({ plan, modelsDir: unusable });
      assert.equal(r.ok, false, 'a structured refusal, not an exception');
      assert.ok(typeof r.message === 'string' && r.message.length > 0, 'and something a ward could read');
      assert.equal(r.installed.length, 0);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('every inspection path survives an unusable directory', async () => {
  const { root, unusable } = await dirUnderAFile();
  try {
    const plan = { all: [model('m1', [{ name: 'a.onnx', url: 'https://e.test/a', sha256: 'a'.repeat(64), bytes: 10 }])] };
    // None of these may throw; all report absence.
    assert.equal((await inspectInstalled({ plan, modelsDir: unusable })).allComplete, false);
    assert.equal((await outstandingBytes({ plan, modelsDir: unusable })).bytes, 10);
    assert.deepEqual(await sweepTemp(unusable), { removed: 0 });
    const rec = await reclaimModels({ plan, modelsDir: unusable });
    assert.equal(rec.freedBytes, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('the consent summary survives an unusable directory rather than exploding in the UI', async () => {
  const { root, unusable } = await dirUnderAFile();
  try {
    const m = model('m1', [{ name: 'a.onnx', url: 'https://e.test/a', sha256: 'a'.repeat(64), bytes: 10, diskBytes: 10 }]);
    const plan = { all: [m], voice: m, capability: [], extras: [] };
    const s = await consentSummary({ plan, modelsDir: unusable });
    assert.ok(typeof s.text === 'string');
    assert.ok('canProceed' in s);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an unpacked model whose marker cannot be written counts as NOT installed', async () => {
  // Files on disk with no marker are re-extracted forever and never recognised,
  // so reporting success there would be a lie that compounds.
  const dir = await tmpDir();
  try {
    const plan = { all: [model('m1', [{ name: 'm.tar.bz2', url: 'https://e.test/a', sha256: 'b'.repeat(64), bytes: 10 }])] };
    const i = await inspectInstalled({ plan, modelsDir: dir });
    assert.equal(i.models[0].complete, false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ── Reclaim, for archive models ──────────────────────────────────────────
//
// Raised in review: reclaim only unlinked `installedPath()` and then called
// `fs.rmdir`, which removes EMPTY directories only. An archive model unpacks
// into the model directory and leaves no file at `installedPath` at all, so
// for the common case reclaim silently freed almost nothing.

/** A real .tar.bz2, built with Python, so this exercises the true install shape. */
async function makeArchiveBuffer(dir, entries) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const out = path.join(dir, 'built.tar.bz2');
  await run('python3', ['-c', `
import tarfile, io
with tarfile.open(${JSON.stringify(out)}, 'w:bz2') as tf:
    for name, data in ${JSON.stringify(entries)}:
        b = data.encode()
        ti = tarfile.TarInfo('pkg/' + name)
        ti.size = len(b)
        tf.addfile(ti, io.BytesIO(b))
`]);
  const buf = await fs.readFile(out);
  await fs.rm(out, { force: true });
  return buf;
}

test('reclaiming an ARCHIVE model removes the unpacked directory, not just the blob', async () => {
  const dir = await tmpDir();
  const build = await tmpDir();
  try {
    const body = await makeArchiveBuffer(build, [['encoder.onnx', 'e'.repeat(5000)], ['tokens.txt', 'hello']]);
    await withServer({ '/m': body }, async (base) => {
      const digest = sha(body);
      const m = model('m1', [{ name: 'm.tar.bz2', url: `${base}/m`, sha256: digest, bytes: body.length }]);
      const r = await fetchPlan({ plan: { all: [m] }, modelsDir: dir });
      assert.equal(r.ok, true);

      const modelDir = path.join(dir, 'm1');
      assert.ok((await fs.readdir(modelDir)).includes('encoder.onnx'), 'precondition: it unpacked');

      const rec = await reclaimModels({ plan: { all: [m] }, modelsDir: dir });
      assert.equal(await fs.access(modelDir).then(() => true, () => false), false,
        'the unpacked directory must be gone, not left behind by an rmdir that only handles empty ones');
      assert.equal(await fs.access(blobPath(dir, digest)).then(() => true, () => false), false);

      // freedBytes must include the UNPACKED bytes, which are most of the disk:
      // counting only the blob would report a fraction of what was reclaimed.
      assert.ok(rec.freedBytes > body.length,
        `freed ${rec.freedBytes} should exceed the ${body.length}-byte archive alone`);
      assert.ok(rec.freedBytes >= 5000, 'the extracted payload is counted');
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(build, { recursive: true, force: true });
  }
});

test('reclaim still works for a plain-file model, and counts it once', async () => {
  const dir = await tmpDir();
  const body = Buffer.alloc(4096, 4);
  try {
    await withServer({ '/a': body }, async (base) => {
      const digest = sha(body);
      const m = model('m1', [{ name: 'a.onnx', url: `${base}/a`, sha256: digest, bytes: body.length }]);
      await fetchPlan({ plan: { all: [m] }, modelsDir: dir });

      const rec = await reclaimModels({ plan: { all: [m] }, modelsDir: dir });
      assert.equal(await fs.access(path.join(dir, 'm1')).then(() => true, () => false), false);
      // Blob + its hardlink in the model dir are the SAME bytes on disk, so the
      // figure should be about one copy, not two.
      assert.ok(rec.freedBytes >= body.length);
      assert.ok(rec.freedBytes <= body.length * 2, 'a hardlink is not a second copy of the disk');
    });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a model id that is not a plain path segment is skipped, never used for a recursive delete', async () => {
  const dir = await tmpDir();
  try {
    const canary = path.join(dir, 'do-not-delete');
    await fs.mkdir(canary, { recursive: true });
    await fs.writeFile(path.join(canary, 'keep.txt'), 'still here');

    for (const id of ['../do-not-delete', '..', '.', 'a/b', '']) {
      const rec = await reclaimModels({ plan: { all: [{ id, label: id, files: [] }] }, modelsDir: dir });
      assert.equal(rec.freedBytes, 0);
    }
    assert.equal(await fs.readFile(path.join(canary, 'keep.txt'), 'utf8'), 'still here');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('reclaim of one model never takes a blob another still needs, archives included', async () => {
  const dir = await tmpDir();
  const build = await tmpDir();
  try {
    const shared = await makeArchiveBuffer(build, [['shared.onnx', 's'.repeat(3000)]]);
    await withServer({ '/s': shared }, async (base) => {
      const digest = sha(shared);
      const f = () => ({ name: 'm.tar.bz2', url: `${base}/s`, sha256: digest, bytes: shared.length });
      const m1 = model('m1', [f()]);
      const m2 = model('m2', [f()]);
      await fetchPlan({ plan: { all: [m1, m2] }, modelsDir: dir });

      await reclaimModels({ plan: { all: [m2] }, modelsDir: dir, keepBlobsFor: [m1] });
      assert.equal(await fs.access(blobPath(dir, digest)).then(() => true, () => false), true,
        'the shared blob survives');
      assert.equal(await fs.access(path.join(dir, 'm1')).then(() => true, () => false), true,
        "and the other model's unpacked directory is untouched");
      assert.equal(await fs.access(path.join(dir, 'm2')).then(() => true, () => false), false);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(build, { recursive: true, force: true });
  }
});
