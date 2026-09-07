import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startBenchmark, statusOf, cancelBenchmark, resetBenchmark,
  reportPathsRelative, STAGE_LABELS,
} from '../src/voice/voice-bench-run.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'vbr-'));
const settle = async (predicate, ms = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

test('every stage the bench reports has ward-readable wording', () => {
  for (const [stage, label] of Object.entries(STAGE_LABELS)) {
    assert.ok(label.length > 0, `${stage} has no label`);
    // Plain language, not internals — a ward reads this while waiting.
    assert.doesNotMatch(label, /RTF|ASR|TTS|onnx/i, `${stage} leaks jargon: ${label}`);
  }
});

test('a run starts, progresses through stages, and finishes with a report', async () => {
  const root = await tmp();
  try {
    resetBenchmark();
    const seen = [];
    const started = startBenchmark({
      rootDir: root,
      appVersion: '0.0.1-test',
      samples: 2,
      probe: async () => { seen.push('probe'); },
    });
    assert.equal(started.started, true);
    assert.equal(started.status.running, true);

    assert.ok(await settle(() => statusOf().status === 'done'), 'the run should finish');
    const st = statusOf();
    assert.equal(st.status, 'done');
    assert.ok(st.markdown.includes('# Voice benchmark'));
    assert.ok(st.elapsedMs >= 0);
    assert.ok(seen.length > 0, 'the interference probe actually ran');
  } finally { resetBenchmark(); await fs.rm(root, { recursive: true, force: true }); }
});

test('the report is written to disk BEFORE the run reports done — closing the window loses nothing', async () => {
  const root = await tmp();
  try {
    resetBenchmark();
    startBenchmark({ rootDir: root, samples: 1, probe: async () => {} });
    assert.ok(await settle(() => statusOf().status === 'done'));

    const st = statusOf();
    assert.ok(st.savedTo?.mdPath, 'a finished run knows where it was saved');
    const md = await fs.readFile(st.savedTo.mdPath, 'utf8');
    assert.ok(md.startsWith('# Voice benchmark'));
    const rel = reportPathsRelative(root, st.savedTo);
    assert.match(rel.markdown, /^logs[\\/]voice-bench-/);
  } finally { resetBenchmark(); await fs.rm(root, { recursive: true, force: true }); }
});

test('polling never reports done before the report save finishes', async () => {
  const root = await tmp();
  try {
    resetBenchmark();
    let releaseSave;
    let markSaveStarted;
    const saveStarted = new Promise((resolve) => {
      markSaveStarted = resolve;
    });
    const saveMayFinish = new Promise((resolve) => {
      releaseSave = resolve;
    });

    startBenchmark({
      rootDir: root,
      samples: 1,
      probe: async () => {},
      reportSaver: async ({ rootDir, result }) => {
        markSaveStarted();
        await saveMayFinish;
        const logsDir = path.join(rootDir, 'logs');
        await fs.mkdir(logsDir, { recursive: true });
        const mdPath = path.join(logsDir, 'voice-bench-test.md');
        const jsonPath = path.join(logsDir, 'voice-bench-test.json');
        await fs.writeFile(mdPath, result.markdown, 'utf8');
        await fs.writeFile(jsonPath, JSON.stringify({ ok: true }), 'utf8');
        return { mdPath, jsonPath };
      },
    });

    await saveStarted;
    const mid = statusOf();
    assert.notEqual(mid.status, 'done', 'done must wait for the save to finish');
    releaseSave();
    assert.ok(await settle(() => statusOf().status === 'done'));
    assert.ok(statusOf().savedTo?.mdPath);
  } finally { resetBenchmark(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a second start returns the run already going — clicking twice means running once', async () => {
  const root = await tmp();
  try {
    resetBenchmark();
    const first = startBenchmark({ rootDir: root, samples: 8, probe: async () => { await new Promise((r) => setTimeout(r, 15)); } });
    const second = startBenchmark({ rootDir: root, samples: 8, probe: async () => {} });
    assert.equal(first.started, true);
    assert.equal(second.started, false);
    assert.equal(second.reason, 'already-running');
    assert.equal(second.status.id, first.status.id, 'the same run, not a new one');
    await settle(() => statusOf().status !== 'running');
  } finally { resetBenchmark(); await fs.rm(root, { recursive: true, force: true }); }
});

test('cancelling produces no report at all — a half-measured one that looks whole is worse', async () => {
  const root = await tmp();
  try {
    resetBenchmark();
    startBenchmark({ rootDir: root, samples: 30, probe: async () => { await new Promise((r) => setTimeout(r, 30)); } });
    assert.equal(cancelBenchmark().cancelled, true);
    assert.ok(await settle(() => statusOf().status === 'cancelled', 8000));

    const st = statusOf();
    assert.equal(st.status, 'cancelled');
    assert.equal(st.markdown, null, 'no report is offered');
    assert.equal(st.savedTo, null, 'and none was written');
    const logs = await fs.readdir(path.join(root, 'logs')).catch(() => []);
    assert.equal(logs.length, 0);
  } finally { resetBenchmark(); await fs.rm(root, { recursive: true, force: true }); }
});

test('cancelling when nothing is running is a no-op, not an error', () => {
  resetBenchmark();
  assert.deepEqual(cancelBenchmark(), { cancelled: false, reason: 'nothing-running' });
});

test('an engine that refuses to start becomes a reported absence, not a failed run', async () => {
  const root = await tmp();
  try {
    resetBenchmark();
    startBenchmark({
      rootDir: root, samples: 1, probe: async () => {},
      engineFactory: async () => { throw new Error('sherpa-onnx-node is not installed'); },
    });
    assert.ok(await settle(() => statusOf().status === 'done'));

    const st = statusOf();
    assert.equal(st.status, 'done', 'the run still completes');
    assert.match(st.markdown, /speech engine was not available/);
    assert.match(st.markdown, /sherpa-onnx-node is not installed/);
    assert.match(st.markdown, /## Disk/, 'and the stages that do not need an engine still report');
  } finally { resetBenchmark(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a working engine is measured, and its close() is called even so', async () => {
  const root = await tmp();
  let closed = false;
  try {
    resetBenchmark();
    startBenchmark({
      rootDir: root, samples: 1, probe: async () => {},
      engineFactory: async () => ({
        available: true,
        listFixtures: async () => [{ name: 'en-1', reference: 'hello there', conditions: ['clean'] }],
        transcribe: async () => ({ text: 'hello there', audioMs: 1000, processingMs: 200 }),
        measureRtf: async () => ({ processingMs: 200, audioMs: 1000 }),
        measureTts: async () => ({ firstChunkMs: 180 }),
        startLoad: async () => () => {},
        close: async () => { closed = true; },
      }),
    });
    assert.ok(await settle(() => statusOf().status === 'done'));
    assert.match(statusOf().markdown, /faster than real time/);
    assert.equal(closed, true, 'the engine must be released whatever happened');
  } finally { resetBenchmark(); await fs.rm(root, { recursive: true, force: true }); }
});

test('reset refuses while a run is live, so a report cannot be discarded mid-measurement', async () => {
  const root = await tmp();
  try {
    resetBenchmark();
    startBenchmark({ rootDir: root, samples: 20, probe: async () => { await new Promise((r) => setTimeout(r, 20)); } });
    assert.deepEqual(resetBenchmark(), { reset: false, reason: 'still-running' });
    cancelBenchmark();
    await settle(() => statusOf().status !== 'running', 8000);
    assert.equal(resetBenchmark().reset, true);
    assert.equal(statusOf().status, 'idle');
  } finally { resetBenchmark(); await fs.rm(root, { recursive: true, force: true }); }
});

test('polling an idle manager says idle rather than inventing a run', () => {
  resetBenchmark();
  const st = statusOf();
  assert.equal(st.running, false);
  assert.equal(st.status, 'idle');
});
