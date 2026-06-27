import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  recordSegmentRun, isSegmentMemorized, segmentMemorizedThrough, computeCoverage,
  incompleteDates, deriveStatus, collectDateSlices,
} from '../memory-coverage.js';

const at = (y, mo, d, h = 12) => new Date(y, mo - 1, d, h).toISOString();
const msg = (content, ts, role = 'user') => ({ role, content, timestamp: ts });

let dir, logsDir, ledgerFile, opts;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'coverage-test-'));
  logsDir = path.join(dir, 'logs');
  ledgerFile = path.join(dir, '.memory-coverage.json');
  await fsp.mkdir(logsDir, { recursive: true });
  opts = { logsDir, ledgerFile };
});
afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

async function writeLog(sessionId, messages, extra = {}) {
  await fsp.writeFile(path.join(logsDir, `${sessionId}.json`),
    JSON.stringify({ sessionId, messages, ...extra }), 'utf8');
}

// ── deriveStatus (pure) ──────────────────────────────────────────────────────

test('deriveStatus: empty / partial / complete / uncertain', () => {
  assert.equal(deriveStatus([]), 'empty');
  assert.equal(deriveStatus([{ memorized: 1, total: 3, flag: null }]), 'partial');
  assert.equal(deriveStatus([{ memorized: 3, total: 3, flag: null }]), 'complete');
  assert.equal(deriveStatus([{ memorized: 3, total: 3, flag: 'shared-room' }]), 'uncertain');
  // one lagging session drags the whole day back to partial
  assert.equal(deriveStatus([
    { memorized: 3, total: 3, flag: null },
    { memorized: 1, total: 4, flag: null },
  ]), 'partial');
});

// ── compute over logs + ledger ───────────────────────────────────────────────

test('a never-memorized day reads partial; recording its slice completes it', async () => {
  await writeLog('s1', [msg('a', at(2026, 6, 20, 9)), msg('b', at(2026, 6, 20, 10), 'assistant')]);

  let cov = await computeCoverage(opts);
  assert.equal(cov.days['2026-06-20'].status, 'partial');

  await recordSegmentRun({ date: '2026-06-20', sessionId: 's1', throughCount: 2, facts: 3 }, opts);
  cov = await computeCoverage(opts);
  assert.equal(cov.days['2026-06-20'].status, 'complete');
  assert.equal(cov.days['2026-06-20'].facts, 3);
});

test('new messages after a run drop the active day back to partial', async () => {
  await writeLog('s1', [msg('a', at(2026, 6, 20, 9)), msg('b', at(2026, 6, 20, 10), 'assistant')]);
  await recordSegmentRun({ date: '2026-06-20', sessionId: 's1', throughCount: 2 }, opts);
  assert.equal((await computeCoverage(opts)).days['2026-06-20'].status, 'complete');

  // session grows on the same day → memorizedThrough (2) < total (3)
  await writeLog('s1', [
    msg('a', at(2026, 6, 20, 9)), msg('b', at(2026, 6, 20, 10), 'assistant'), msg('c', at(2026, 6, 20, 11)),
  ]);
  assert.equal((await computeCoverage(opts)).days['2026-06-20'].status, 'partial');
});

test('a shared-room flag makes a fully-memorized day uncertain', async () => {
  await writeLog('s1', [msg('a', at(2026, 6, 20, 9)), msg('b', at(2026, 6, 20, 10), 'assistant')]);
  await recordSegmentRun({ date: '2026-06-20', sessionId: 's1', throughCount: 2, flag: 'shared-room' }, opts);
  assert.equal((await computeCoverage(opts)).days['2026-06-20'].status, 'uncertain');
});

test('incompleteDates lists only partial days', async () => {
  await writeLog('s1', [msg('a', at(2026, 6, 20, 9)), msg('b', at(2026, 6, 20, 10), 'assistant')]);
  await writeLog('s2', [msg('a', at(2026, 6, 21, 9)), msg('b', at(2026, 6, 21, 10), 'assistant')]);
  await recordSegmentRun({ date: '2026-06-20', sessionId: 's1', throughCount: 2 }, opts);
  assert.deepEqual(await incompleteDates(opts), ['2026-06-21']);
});

test('isSegmentMemorized reflects recorded progress', async () => {
  assert.equal(await isSegmentMemorized('s1', '2026-06-20', 2, opts), false);
  await recordSegmentRun({ date: '2026-06-20', sessionId: 's1', throughCount: 2 }, opts);
  assert.equal(await isSegmentMemorized('s1', '2026-06-20', 2, opts), true);
  assert.equal(await isSegmentMemorized('s1', '2026-06-20', 3, opts), false); // grew past it
});

test('segmentMemorizedThrough returns the offset the pipeline slices from', async () => {
  assert.equal(await segmentMemorizedThrough('s1', '2026-06-20', opts), 0); // never run
  await recordSegmentRun({ date: '2026-06-20', sessionId: 's1', throughCount: 2 }, opts);
  assert.equal(await segmentMemorizedThrough('s1', '2026-06-20', opts), 2);
  // A delta run records cumulatively (priorThrough 2 + 3 new) → advances to 5.
  await recordSegmentRun({ date: '2026-06-20', sessionId: 's1', throughCount: 5 }, opts);
  assert.equal(await segmentMemorizedThrough('s1', '2026-06-20', opts), 5);
  assert.equal(await isSegmentMemorized('s1', '2026-06-20', 5, opts), true);
});

test('collectDateSlices returns a date\'s un-memorized slices; force includes done ones', async () => {
  await writeLog('s1', [msg('a', at(2026, 6, 20, 9)), msg('b', at(2026, 6, 20, 10), 'assistant')]);
  await writeLog('s2', [msg('c', at(2026, 6, 20, 14)), msg('d', at(2026, 6, 20, 15), 'assistant')]);

  // nothing memorized → both sessions' slices come back
  let slices = await collectDateSlices('2026-06-20', opts);
  assert.deepEqual(slices.map(s => s.sessionId).sort(), ['s1', 's2']);

  // memorize s1 → only s2 remains (skipped by default)
  await recordSegmentRun({ date: '2026-06-20', sessionId: 's1', throughCount: 2 }, opts);
  slices = await collectDateSlices('2026-06-20', opts);
  assert.deepEqual(slices.map(s => s.sessionId), ['s2']);

  // force re-includes the memorized one
  slices = await collectDateSlices('2026-06-20', { ...opts, force: true });
  assert.equal(slices.length, 2);

  // a different date with no logs → empty
  assert.deepEqual(await collectDateSlices('2026-06-25', opts), []);
});

test('a midnight-crossing session needs both days memorized to clear', async () => {
  await writeLog('s1', [
    msg('late', at(2026, 6, 20, 23)), msg('up', at(2026, 6, 20, 23), 'assistant'),
    msg('after', at(2026, 6, 21, 0)), msg('mm', at(2026, 6, 21, 1), 'assistant'),
  ]);
  await recordSegmentRun({ date: '2026-06-20', sessionId: 's1', throughCount: 2 }, opts);
  const cov = await computeCoverage(opts);
  assert.equal(cov.days['2026-06-20'].status, 'complete');
  assert.equal(cov.days['2026-06-21'].status, 'partial');
});
