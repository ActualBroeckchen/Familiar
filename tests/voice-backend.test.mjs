import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BACKENDS, DEFAULT_BACKEND, POCKET_FOOTPRINT,
  voiceboxPython, inspectBackends, resolveBackend, VOICEBOX_SUBDIR,
  ensureWindowsMsvcRuntime, placeMsvcRuntimeBesideTorch,
} from '../voice-backend.js';

async function tmpRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'backend-'));
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** A checkout where voicebox/ exists and its venv has been created. */
async function withVoicebox(dir, { venv = true } = {}) {
  await fs.mkdir(path.join(dir, VOICEBOX_SUBDIR, 'src', 'voicebox'), { recursive: true });
  await fs.writeFile(path.join(dir, VOICEBOX_SUBDIR, 'src', 'voicebox', 'worker.py'), '# stub');
  if (venv) {
    const bin = path.join(dir, VOICEBOX_SUBDIR, '.venv', 'bin');
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, 'python3'), '#!/bin/sh');
  }
}

test('the better engine is the default — but its cost is paid on first use, never at boot', () => {
  // pocket does not drop the tail of a long message the way sherpa's per-utterance
  // reset does, so it is the default CHOICE. The 600 MB it costs is deferred to the
  // first time voice is actually used, with a sherpa fallback carrying the machine
  // until then — so nothing downloads unasked at boot. See resolveBackend: a missing
  // venv still resolves to a working (sherpa) worker with fellBackFrom attached.
  assert.equal(DEFAULT_BACKEND, BACKENDS.POCKET);
});

test('a missing sidecar still SPEAKS on the default — the fallback carries first-use', async () => {
  // The default being pocket must never mean silence on a machine that has not
  // downloaded it yet. With no settings at all, the resolver falls back to sherpa
  // and says what it fell back from, so the caller can start the download.
  const { dir, cleanup } = await tmpRoot();
  try {
    const r = await resolveBackend({ rootDir: dir, settings: {} });
    assert.equal(r.backend, BACKENDS.SHERPA);
    assert.equal(r.fellBackFrom, BACKENDS.POCKET);
    assert.equal(r.command, process.execPath, 'and still spawns something that works');
  } finally { await cleanup(); }
});

test('sherpa is always available and says what it costs in quality', async () => {
  const { dir, cleanup } = await tmpRoot();
  try {
    const found = await inspectBackends(dir);
    assert.equal(found[BACKENDS.SHERPA].available, true);
    assert.match(found[BACKENDS.SHERPA].limitation, /shift between utterances/);
  } finally { await cleanup(); }
});

test('pocket is unavailable without a venv, and says exactly how to get one', async () => {
  const { dir, cleanup } = await tmpRoot();
  try {
    await withVoicebox(dir, { venv: false });
    const found = await inspectBackends(dir);
    assert.equal(found[BACKENDS.POCKET].available, false);
    assert.match(found[BACKENDS.POCKET].why, /uv sync --directory voicebox/,
      'a dead end should carry the command that ends it');
  } finally { await cleanup(); }
});

test('pocket is unavailable when voicebox/ is missing entirely, and says so differently', async () => {
  const { dir, cleanup } = await tmpRoot();
  try {
    const found = await inspectBackends(dir);
    assert.equal(found[BACKENDS.POCKET].available, false);
    assert.match(found[BACKENDS.POCKET].why, /missing from this checkout/);
  } finally { await cleanup(); }
});

test('a ready venv makes pocket available and names the interpreter', async () => {
  const { dir, cleanup } = await tmpRoot();
  try {
    await withVoicebox(dir);
    const found = await inspectBackends(dir);
    assert.equal(found[BACKENDS.POCKET].available, true);
    assert.ok((await voiceboxPython(dir)).endsWith('python3'));
  } finally { await cleanup(); }
});

test('choosing pocket without it installed falls back AND reports why', async () => {
  // Silently using sherpa would mean a ward who opted in, paid 600 MB, and
  // never learned their choice was not honoured.
  const { dir, cleanup } = await tmpRoot();
  try {
    const r = await resolveBackend({ rootDir: dir, settings: { voiceTts: { backend: 'pocket' } } });
    assert.equal(r.backend, BACKENDS.SHERPA);
    assert.equal(r.fellBackFrom, BACKENDS.POCKET);
    assert.ok(r.reason, 'the fallback must carry a reason');
    assert.equal(r.command, process.execPath, 'and still spawn something that works');
  } finally { await cleanup(); }
});

test('choosing pocket when it IS installed spawns the Python worker', async () => {
  const { dir, cleanup } = await tmpRoot();
  try {
    await withVoicebox(dir);
    const r = await resolveBackend({ rootDir: dir, settings: { voiceTts: { backend: 'pocket' } } });
    assert.equal(r.backend, BACKENDS.POCKET);
    assert.match(r.command, /python3$/);
    assert.match(r.workerScript, /worker\.py$/);
    assert.ok(r.env.PYTHONPATH.endsWith(path.join(VOICEBOX_SUBDIR, 'src')),
      'the package lives under src/, so the interpreter has to be told');
    assert.equal(r.fellBackFrom, null);
  } finally { await cleanup(); }
});

test('no choice at all lands on the default (pocket), which speaks when installed', async () => {
  // undefined / null mean "my human never picked one", so they take the default.
  // The default is pocket now, so with a venv present these resolve to it.
  const { dir, cleanup } = await tmpRoot();
  try {
    await withVoicebox(dir);
    for (const backend of [undefined, null]) {
      const r = await resolveBackend({ rootDir: dir, settings: { voiceTts: { backend } } });
      assert.equal(r.backend, BACKENDS.POCKET, `unset backend ${String(backend)} should take the default`);
      assert.equal(r.fellBackFrom, null, 'the default was available, so nothing fell back');
    }
  } finally { await cleanup(); }
});

test('an unrecognised choice lands on sherpa, not the pocket default', async () => {
  // A garbage value is not "no choice" — it is a choice we do not know. It must
  // NOT silently pull 600 MB by resolving to the default; it lands on the safe,
  // always-present engine instead.
  const { dir, cleanup } = await tmpRoot();
  try {
    await withVoicebox(dir);
    for (const backend of ['', 'sherpa', 'nonsense', 42]) {
      const r = await resolveBackend({ rootDir: dir, settings: { voiceTts: { backend } } });
      assert.equal(r.backend, BACKENDS.SHERPA, `backend ${String(backend)}`);
      assert.equal(r.fellBackFrom, null, 'not asking for pocket is not falling back from it');
    }
  } finally { await cleanup(); }
});

test('resolveBackend never throws, so a broken checkout still speaks', async () => {
  for (const rootDir of ['/definitely/not/here', '', null, undefined]) {
    const r = await resolveBackend({ rootDir, settings: { voiceTts: { backend: 'pocket' } } });
    assert.equal(typeof r.backend, 'string');
    assert.ok(r.command, 'something spawnable, always');
  }
});

test('the footprint is stated in parts, so the cost is legible before it is paid', () => {
  assert.ok(POCKET_FOOTPRINT.downloadBytes > 0);
  assert.ok(POCKET_FOOTPRINT.installedBytes > POCKET_FOOTPRINT.downloadBytes);
  const summed = POCKET_FOOTPRINT.parts.reduce((n, p) => n + p.bytes, 0);
  assert.ok(Math.abs(summed - POCKET_FOOTPRINT.downloadBytes) < 30 * 1024 * 1024,
    'the parts should roughly account for the total, or one of them is wrong');
  assert.ok(POCKET_FOOTPRINT.parts.some((p) => /torch/.test(p.what)));
});

test('ensureWindowsMsvcRuntime is a no-op off Windows and never throws', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows path is exercised on Windows only');
  // Off Windows torch needs no MSVC runtime, so this must skip cleanly rather
  // than spawn uv or blow up an install/repair that is otherwise fine.
  const r = await ensureWindowsMsvcRuntime({ rootDir: '/definitely/not/here' });
  assert.deepEqual(r, { ok: true, skipped: 'not-windows' });
});

// ── placeMsvcRuntimeBesideTorch: the actual cure for WinError 126 ──────────
// The bug this whole change fixes was NOT a failed install — msvc-runtime
// installed fine. It put the DLLs beside python.exe (sys.prefix / Scripts),
// which is exactly where torch's native loader never looks. torch loads
// c10.dll from torch/lib and Python 3.8+ resolves that DLL's dependencies from
// torch/lib + add_dll_directory dirs only. So the fix is a COPY into torch/lib,
// and that copy is what these tests pin. Platform-independent by design.

/** A fake venv: a torch/lib to copy INTO, and runtime DLLs to copy FROM. */
async function fakeVenv(dir, { dllsAt = 'Scripts', names = ['vcruntime140.dll', 'msvcp140.dll'], torchLib = true } = {}) {
  const venv = path.join(dir, VOICEBOX_SUBDIR, '.venv');
  if (torchLib) await fs.mkdir(path.join(venv, 'Lib', 'site-packages', 'torch', 'lib'), { recursive: true });
  const src = path.join(venv, ...dllsAt.split('/'));
  await fs.mkdir(src, { recursive: true });
  for (const n of names) await fs.writeFile(path.join(src, n), `bytes of ${n}`);
  return venv;
}

test('placeMsvcRuntimeBesideTorch copies the runtime INTO torch/lib', async () => {
  const { dir, cleanup } = await tmpRoot();
  try {
    const venv = await fakeVenv(dir, { dllsAt: 'Scripts', names: ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'] });
    const r = await placeMsvcRuntimeBesideTorch({ venvDir: venv });
    const libDir = path.join(venv, 'Lib', 'site-packages', 'torch', 'lib');
    assert.equal(r.libDir, libDir);
    assert.deepEqual(r.copied.sort(), ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']);
    for (const n of r.copied) {
      assert.ok(await fs.readFile(path.join(libDir, n)), `${n} landed where torch loads it`);
    }
  } finally { await cleanup(); }
});

test('placeMsvcRuntimeBesideTorch finds DLLs beside python.exe (sys.prefix), not only Scripts', async () => {
  // msvc-runtime is inconsistent about where it drops them across versions; the
  // venv ROOT is the other common spot, and the finder must cover it.
  const { dir, cleanup } = await tmpRoot();
  try {
    const venv = await fakeVenv(dir, { dllsAt: '.', names: ['vcruntime140.dll', 'msvcp140.dll'] });
    const r = await placeMsvcRuntimeBesideTorch({ venvDir: venv });
    assert.deepEqual(r.copied.sort(), ['msvcp140.dll', 'vcruntime140.dll']);
  } finally { await cleanup(); }
});

test('placeMsvcRuntimeBesideTorch is idempotent — a second pass copies nothing', async () => {
  const { dir, cleanup } = await tmpRoot();
  try {
    const venv = await fakeVenv(dir, { names: ['vcruntime140.dll', 'msvcp140.dll'] });
    await placeMsvcRuntimeBesideTorch({ venvDir: venv });
    const again = await placeMsvcRuntimeBesideTorch({ venvDir: venv });
    assert.deepEqual(again.copied, [], 'already in place, so nothing to do the second time');
    assert.deepEqual(again.found.sort(), ['msvcp140.dll', 'vcruntime140.dll'], 'but it still SEES them');
  } finally { await cleanup(); }
});

test('placeMsvcRuntimeBesideTorch signals no-torch when torch is not installed', async () => {
  // No torch/lib → nowhere to copy to. The caller turns this into the redist
  // hint rather than pretending it fixed anything.
  const { dir, cleanup } = await tmpRoot();
  try {
    const venv = await fakeVenv(dir, { torchLib: false, names: ['vcruntime140.dll'] });
    const r = await placeMsvcRuntimeBesideTorch({ venvDir: venv });
    assert.equal(r.libDir, null);
    assert.deepEqual(r.copied, []);
  } finally { await cleanup(); }
});

test('placeMsvcRuntimeBesideTorch never throws on a bad venv path', async () => {
  const r = await placeMsvcRuntimeBesideTorch({ venvDir: '/definitely/not/here' });
  assert.equal(r.libDir, null);
  assert.deepEqual(r.copied, []);
});
