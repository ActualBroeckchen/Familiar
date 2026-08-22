import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readsRemaining, recordReads, PONDER_READS_PER_DAY_DEFAULT } from '../ponder-web-budget.js';

// The budget lives at a fixed file under tomes/ (git-ignored). Back it up around
// each test so a developer's real budget count is never clobbered.
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tomes', '.ponder-web-budget.json');

function withBudget(fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const had = fs.existsSync(file);
  const bak = had ? fs.readFileSync(file) : null;
  try { try { fs.unlinkSync(file); } catch {} return fn(); }
  finally {
    if (bak !== null) fs.writeFileSync(file, bak);
    else { try { fs.unlinkSync(file); } catch {} }
  }
}

const today = () => new Date().toLocaleDateString('en-CA');

test('fresh day starts with the full cap remaining', () => {
  withBudget(() => {
    assert.equal(readsRemaining({}), PONDER_READS_PER_DAY_DEFAULT);
    assert.equal(readsRemaining({ ponderWebReadsPerDay: 5 }), 5);
  });
});

test('recordReads decrements and clamps at zero', () => {
  withBudget(() => {
    const s = { ponderWebReadsPerDay: 3 };
    assert.equal(recordReads(1, s), 2);
    assert.equal(recordReads(1, s), 1);
    assert.equal(recordReads(5, s), 0);          // overshoot clamps, never negative
    assert.equal(readsRemaining(s), 0);
  });
});

test('a stale (previous-day) file resets to a fresh day', () => {
  withBudget(() => {
    fs.writeFileSync(file, JSON.stringify({ date: '2000-01-01', reads: 999 }));
    assert.equal(readsRemaining({ ponderWebReadsPerDay: 4 }), 4);   // yesterday's spend is ignored
  });
});

test('a malformed file degrades to a fresh day, never throws', () => {
  withBudget(() => {
    fs.writeFileSync(file, '{ not json');
    assert.equal(readsRemaining({ ponderWebReadsPerDay: 6 }), 6);
  });
});

test('a cap of 0 disables research (no reads remaining)', () => {
  withBudget(() => {
    assert.equal(readsRemaining({ ponderWebReadsPerDay: 0 }), 0);
  });
});

test('records persist across calls within the same day', () => {
  withBudget(() => {
    recordReads(2, { ponderWebReadsPerDay: 12 });
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(st.date, today());
    assert.equal(st.reads, 2);
    assert.equal(readsRemaining({ ponderWebReadsPerDay: 12 }), 10);
  });
});
