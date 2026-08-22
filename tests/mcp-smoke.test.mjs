import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Cross-process MCP smoke test. The static contract checker
// (scripts/audit-mcp-contracts.mjs) matches argument NAMES against the Python
// signatures, and unit tests cover the pure result helpers — but neither runs a
// real call end-to-end, so a TYPE or SEMANTIC mismatch (a value the Python tool
// rejects, a return shape the wrapper misreads) is invisible until a ward hits
// it. This spawns the real Phylactery + Unruh MCP children through thalamus and
// round-trips representative tools, asserting real behaviour and real returns.
//
// Isolation: the stores are pointed at a throwaway temp dir via UNRUH_DB_PATH /
// PHYLACTERY_DB_PATH (thalamus forwards them into the spawn env), so the test
// never touches the dev data. Self-skips when uv / the venvs aren't present
// (CI without Python) — the wrappers then report "not connected" and we bail
// rather than fail.

let thalamus;
let available = false;
let tmp;

const SPAWN_TIMEOUT = 90_000; // first `uv run` spawn + migrations can be slow

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'pf-mcp-smoke-'));
  mkdirSync(path.join(tmp, 'unruh'), { recursive: true });
  mkdirSync(path.join(tmp, 'phylactery'), { recursive: true });
  process.env.UNRUH_DB_PATH = path.join(tmp, 'unruh', 'unruh.db');
  process.env.PHYLACTERY_DB_PATH = path.join(tmp, 'phylactery', 'phylactery.db');

  thalamus = await import('../thalamus.js');
  await thalamus.startThalamus();

  // Probe: a wrapper returns { ok:false, error:'unruh not connected' } (or an
  // empty list with ok:false) when the child never spawned. If Unruh isn't
  // there, uv/venv is missing — skip the whole suite.
  const probe = await thalamus.listBookmarks();
  available = !(probe && probe.ok === false && /not connected/i.test(probe.error ?? ''));
}, { timeout: SPAWN_TIMEOUT });

after(async () => {
  try { thalamus?.shutdownUnruh?.(); } catch { /* best-effort */ }
  try { thalamus?.shutdownPhylactery?.(); } catch { /* best-effort */ }
  delete process.env.UNRUH_DB_PATH;
  delete process.env.PHYLACTERY_DB_PATH;
  if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } }
});

test('Unruh: saveBookmark → listBookmarks round-trips cross-process (M8 write side)', { timeout: SPAWN_TIMEOUT }, async (t) => {
  if (!available) return t.skip('Unruh not connected (uv/venv absent)');
  const saved = await thalamus.saveBookmark({ topic: 'smoke topic', resource: 'https://example/smoke', note: 'from the smoke test' });
  assert.equal(saved.ok, true, `saveBookmark should succeed: ${saved.error ?? ''}`);

  const { bookmarks, ok } = await thalamus.listBookmarks();
  assert.equal(ok, true);
  const mine = bookmarks.find(b => b.resource === 'https://example/smoke' || /smoke/.test(b.label ?? ''));
  assert.ok(mine, 'the saved bookmark must come back from listBookmarks — proves interest_bookmark actually wrote');
});

test('Unruh: a missing REQUIRED arg is an isError result that surfaces as honest { ok:false } (not silent success)', { timeout: SPAWN_TIMEOUT }, async (t) => {
  if (!available) return t.skip('Unruh not connected (uv/venv absent)');
  // schedule_add_node requires `label`. Omitting it fails FastMCP's pydantic
  // validation at the framework layer → isError:true (a resolved result, NOT a
  // throw). This is exactly the shape the identity_update_section bug produced,
  // and the swallow the write wrappers used to turn into { ok:true }. unruhResult
  // must surface it honestly.
  const out = await thalamus.addScheduleNode({ type: 'event', when: '2026-01-01T12:00:00' }); // no label
  assert.equal(out.ok, false, 'a missing-required isError must surface as ok:false, never a fabricated success');
  assert.equal(typeof out.error, 'string');
  assert.match(out.error, /label|required|valid/i);
});

test('Unruh: bumpInterest → listInterests round-trips (a second tool family)', { timeout: SPAWN_TIMEOUT }, async (t) => {
  if (!available) return t.skip('Unruh not connected (uv/venv absent)');
  const bumped = await thalamus.bumpInterest({ topic: 'smoke-interest', delta: 2.0, source: 'smoke' });
  assert.equal(bumped.ok, true, `bumpInterest should succeed: ${bumped.error ?? ''}`);

  const list = await thalamus.listInterests({ limit: 100 });
  const interests = Array.isArray(list) ? list : (list.interests ?? list.live ?? []);
  assert.ok(interests.some(i => (i.label ?? i.topic ?? '').toLowerCase().includes('smoke-interest')),
    'the bumped interest must appear in listInterests');
});

test('Phylactery: getMemoryHealth answers a real payload cross-process', { timeout: SPAWN_TIMEOUT }, async (t) => {
  if (!available) return t.skip('peers not connected (uv/venv absent)');
  const health = await thalamus.getMemoryHealth();
  // The wrapper's not-connected degrade is { ok:false, dedup_mode:'unknown' };
  // a real answer carries row/vec counts and a real dedup_mode. Skip on the
  // degrade (Unruh up but Phylactery not), else assert the real payload.
  if (!health || health.ok === false || health.dedup_mode === 'unknown') {
    return t.skip('Phylactery not connected (Unruh present but Phylactery is not)');
  }
  assert.equal(typeof health, 'object');
  assert.ok('memory_rows' in health || 'vec_rows' in health,
    `getMemoryHealth should return real row counts, got: ${JSON.stringify(health).slice(0, 200)}`);
});
