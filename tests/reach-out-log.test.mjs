import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  recordReachOut, recentReachOuts, formatReachOutBlock, WINDOW_HOURS, MAX_SHOWN,
} from '../reach-out-log.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'rol-'));
const HOUR = 3_600_000;

test('a knock comes back with what I said, what it was about, and why', async () => {
  const dir = await tmp();
  try {
    await recordReachOut({
      message: 'How did D&D go?',
      about: 'their D&D night this Tuesday',
      why: 'they were looking forward to it all week',
      tomesDir: dir,
    });
    const [got] = await recentReachOuts({ tomesDir: dir });
    assert.equal(got.message, 'How did D&D go?');
    assert.equal(got.about, 'their D&D night this Tuesday');
    assert.equal(got.why, 'they were looking forward to it all week');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('the block says it plainly, so a reply out of nowhere lands as a reply', async () => {
  const now = Date.now();
  const block = formatReachOutBlock([{
    id: 'ro-x', at: new Date(now - 3 * HOUR).toISOString(),
    message: 'How did D&D go?', about: 'their Tuesday D&D night', why: 'they were looking forward to it', shown: 0,
  }], { now });
  assert.match(block, /3 hours ago I said: "How did D&D go\?"/);
  assert.match(block, /what I was asking about: their Tuesday D&D night/);
  assert.match(block, /why I asked: they were looking forward to it/);
});

test('a knock with no about/why still surfaces — knowing I asked is most of the fix', async () => {
  const dir = await tmp();
  try {
    await recordReachOut({ message: 'thinking of you', tomesDir: dir });
    const items = await recentReachOuts({ tomesDir: dir });
    assert.equal(items.length, 1);
    const block = formatReachOutBlock(items);
    assert.match(block, /thinking of you/);
    assert.doesNotMatch(block, /what I was asking about/, 'no empty label for a field I do not have');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('an old knock stops being what they are answering', async () => {
  const dir = await tmp();
  const now = Date.now();
  try {
    await recordReachOut({ message: 'ancient', tomesDir: dir, now: now - (WINDOW_HOURS + 5) * HOUR });
    await recordReachOut({ message: 'recent', tomesDir: dir, now: now - HOUR });
    const items = await recentReachOuts({ tomesDir: dir, now });
    assert.deepEqual(items.map(i => i.message), ['recent']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('newest first — the last thing I said is the likeliest thing being answered', async () => {
  const dir = await tmp();
  const now = Date.now();
  try {
    await recordReachOut({ message: 'older', tomesDir: dir, now: now - 5 * HOUR });
    await recordReachOut({ message: 'newer', tomesDir: dir, now: now - 1 * HOUR });
    const items = await recentReachOuts({ tomesDir: dir, now });
    assert.deepEqual(items.map(i => i.message), ['newer', 'older']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('it ages out of the block after a few showings rather than nagging forever', async () => {
  const dir = await tmp();
  try {
    await recordReachOut({ message: 'did you eat?', tomesDir: dir });
    for (let i = 0; i < MAX_SHOWN; i++) {
      const items = await recentReachOuts({ tomesDir: dir, markSurfaced: true });
      assert.equal(items.length, 1, `still surfacing on showing ${i + 1}`);
    }
    assert.equal((await recentReachOuts({ tomesDir: dir })).length, 0, 'stops after its run');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('without markSurfaced nothing is consumed — a preview must not spend it', async () => {
  const dir = await tmp();
  try {
    await recordReachOut({ message: 'hey', tomesDir: dir });
    for (let i = 0; i < MAX_SHOWN + 2; i++) await recentReachOuts({ tomesDir: dir });
    assert.equal((await recentReachOuts({ tomesDir: dir })).length, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('an empty message is not a knock, and a bad directory never throws', async () => {
  const dir = await tmp();
  try {
    assert.equal((await recordReachOut({ message: '   ', tomesDir: dir })).ok, false);
    assert.equal((await recordReachOut({ tomesDir: dir })).ok, false);
    assert.deepEqual(await recentReachOuts({ tomesDir: path.join(dir, 'nowhere') }), []);
    assert.equal(formatReachOutBlock([]), '');
    assert.equal(formatReachOutBlock(null), '');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a corrupt log reads as no knocks rather than breaking the turn', async () => {
  const dir = await tmp();
  try {
    await fs.writeFile(path.join(dir, '.reachout-log.json'), 'not json at all');
    assert.deepEqual(await recentReachOuts({ tomesDir: dir }), []);
    // and it recovers on the next write
    assert.equal((await recordReachOut({ message: 'still here', tomesDir: dir })).ok, true);
    assert.equal((await recentReachOuts({ tomesDir: dir })).length, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('minutes and days both read like a person said them', async () => {
  const now = Date.now();
  const at = (ms) => [{ id: 'x', at: new Date(now - ms).toISOString(), message: 'm', about: '', why: '', shown: 0 }];
  assert.match(formatReachOutBlock(at(20 * 60_000), { now }), /20 minutes ago/);
  assert.match(formatReachOutBlock(at(1 * HOUR), { now }), /1 hour ago/);
  assert.match(formatReachOutBlock(at(26 * HOUR), { now }), /yesterday/);
  assert.match(formatReachOutBlock(at(72 * HOUR), { now }), /3 days ago/);
});
