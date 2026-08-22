import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findChromium, status, extractPageData } from '../browser-driver.js';
import { buildRefTable, isProtectedField } from '../browser-lens.js';

test('status() before any launch reports not running, never throws', () => {
  const s = status();
  assert.equal(s.running, false);
  assert.equal(s.tabs, 0);
});

test('findChromium returns a path or null, never throws', () => {
  const p = findChromium();
  assert.ok(p === null || typeof p === 'string');
});

// ── Live extraction (skips when no Chromium is available) ──────────────────
const exe = findChromium();
const live = exe ? test : test.skip;

live('extractPageData walks the real DOM into the lens shape; css resolves + acts', async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  try {
    await page.setContent(`
      <main aria-label="shop">
        <h1>Oat Milk</h1>
        <div><button aria-label="Add to basket">Add</button></div>
        <label for="qty">Quantity</label><input id="qty" type="number">
        <input type="password" aria-label="Password">
        <p id="log"></p>
        <button id="danger" onclick="if(confirm('Delete everything?')) document.getElementById('log').textContent='DELETED'">Delete</button>
      </main>`);

    const data = await extractPageData(page);
    assert.equal(data.title !== undefined, true);
    const names = data.nodes.filter(n => n.interactable).map(n => n.name);
    assert.ok(names.includes('Add to basket'), `names: ${names.join(', ')}`);

    const { byRef, order } = buildRefTable(data);
    // The password field must be flagged protected.
    const pw = [...byRef.values()].find(e => e.node.type === 'password');
    assert.ok(pw && pw.protected, 'password field flagged protected');
    assert.equal(isProtectedField(pw.node), true);

    // Every interactable's css must resolve to exactly one element (the §3.2
    // unique-match guarantee) and be actionable.
    for (const ref of order) {
      const css = byRef.get(ref).node.css;
      assert.equal(await page.locator(css).count(), 1, `ref ${ref} css not unique: ${css}`);
    }

    // Act: click the "Add" button by its css → no crash, element was real.
    const addEntry = [...byRef.values()].find(e => e.node.name === 'Add to basket');
    await page.locator(addEntry.node.css).click();

    // Dialog policy: clicking Delete raises a confirm; dismissing it (default)
    // must leave the page unchanged — the page's own instruction is declined.
    page.once('dialog', d => d.dismiss());
    const danger = [...byRef.values()].find(e => e.node.name === 'Delete');
    await page.locator(danger.node.css).click();
    await page.waitForTimeout(100);
    assert.notEqual(await page.locator('#log').textContent(), 'DELETED');
  } finally {
    await browser.close();
  }
});

// ── Auto-fetch state machine (injected spawn — no real download) ───────────
import { startChromiumFetch, chromiumInstallState, systemBrowserCandidates } from '../browser-driver.js';
import { EventEmitter } from 'node:events';

test('systemBrowserCandidates finds Windows Chrome AND Edge (why the download was forced on Windows)', () => {
  const realPlat = Object.getOwnPropertyDescriptor(process, 'platform');
  const prevPF = process.env.ProgramFiles;
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.ProgramFiles = 'C:\\Program Files';
    const cands = systemBrowserCandidates();
    assert.ok(cands.some(p => /chrome\.exe$/i.test(p)), 'includes an installed Chrome');
    assert.ok(cands.some(p => /msedge\.exe$/i.test(p)), 'includes Edge — always present on Windows, so no download is ever needed');
  } finally {
    Object.defineProperty(process, 'platform', realPlat);
    if (prevPF === undefined) delete process.env.ProgramFiles; else process.env.ProgramFiles = prevPF;
  }
});

test('systemBrowserCandidates covers Chrome, Edge and Chromium on this (linux) host', () => {
  const cands = systemBrowserCandidates();
  assert.ok(cands.some(p => /google-chrome/.test(p)));
  assert.ok(cands.some(p => /chromium/.test(p)));
  assert.ok(cands.some(p => /microsoft-edge/.test(p)));
});

test('startChromiumFetch is a no-op when a browser already exists', () => {
  const st = startChromiumFetch({ findFn: () => '/exists/chrome', spawnFn: () => { throw new Error('should not spawn'); } });
  assert.equal(st.status, 'ready');
});

test('startChromiumFetch spawns the install when none exists, and tracks fetching→failed', async () => {
  // Force "no browser found" so the spawn branch runs; a fake child lets us
  // drive the state transition without a real 130 MB download.
  const child = new EventEmitter();
  let spawnedArgs = null;
  const st = startChromiumFetch({
    findFn: () => null,
    spawnFn: (cmd, args) => { spawnedArgs = args; return child; },
  });
  assert.equal(st.status, 'fetching');
  assert.ok(spawnedArgs.includes('install') && spawnedArgs.includes('chromium'), 'invokes the playwright install CLI');
  // Non-zero exit → failed (findFn still returns null on the recheck).
  child.emit('close', 1);
  assert.equal(chromiumInstallState().status, 'failed');
  assert.match(chromiumInstallState().error, /exited 1/);
  assert.ok(chromiumInstallState().logPath, 'the install log path is surfaced for diagnosis');
});

// A time base far beyond real Date.now(), so injected `now()` values stay
// monotonic and larger than any prior test's real timestamp (the module-level
// install state persists across tests; each test settles its child so the next
// doesn't start blocked on a lingering 'fetching').
const T = 2_000_000_000_000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('a stalled install is killed by the watchdog and reported failed, not fetching forever', async () => {
  const child = new EventEmitter();
  let killed = false;
  child.kill = () => { killed = true; };
  const st = startChromiumFetch({ findFn: () => null, spawnFn: () => child, now: () => T, timeoutMs: 20 });
  assert.equal(st.status, 'fetching');
  await sleep(60);                              // let the watchdog fire (the child never closes)
  assert.equal(killed, true, 'the hung installer is killed');
  assert.equal(chromiumInstallState().status, 'failed');
  assert.match(chromiumInstallState().error, /stalled/);
});

test('exit 0 but no binary is a failure, not a false "ready"', () => {
  const child = new EventEmitter();
  startChromiumFetch({ findFn: () => null, spawnFn: () => child, now: () => T + 100_000 });
  child.emit('close', 0);                       // installer "succeeded" but findFn still finds nothing
  assert.equal(chromiumInstallState().status, 'failed');
  assert.match(chromiumInstallState().error, /no chromium binary/i);
});

test('a recent failure is left to settle, then a later ask retries', () => {
  let spawns = 0;
  const children = [];
  const spawnFn = () => { spawns++; const c = new EventEmitter(); children.push(c); return c; };
  startChromiumFetch({ findFn: () => null, spawnFn, now: () => T + 500_000 });
  children.at(-1).emit('close', 1);             // first attempt fails
  assert.equal(chromiumInstallState().status, 'failed');
  startChromiumFetch({ findFn: () => null, spawnFn, now: () => T + 500_000 + 1_000 });   // within cooldown
  assert.equal(spawns, 1, 'no respawn during the cooldown');
  startChromiumFetch({ findFn: () => null, spawnFn, now: () => T + 500_000 + 60_000 });  // after cooldown
  assert.equal(spawns, 2, 'a fresh ask after the cooldown retries the fetch');
  assert.equal(chromiumInstallState().status, 'fetching');
  children.at(-1).emit('close', 1);             // settle so the next test isn't blocked on 'fetching'
});

test('the install child never inherits a download-skip flag', () => {
  const prev = process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
  process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1';   // as a container/CI env commonly sets
  try {
    let seenEnv = null;
    const child = new EventEmitter();
    startChromiumFetch({ findFn: () => null, spawnFn: (_c, _a, opts) => { seenEnv = opts?.env; return child; }, now: () => T + 2_000_000 });
    assert.ok(seenEnv, 'spawn received options with an env');
    assert.equal(seenEnv.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, undefined, 'the skip flag is stripped for our deliberate install');
    assert.ok(seenEnv.PLAYWRIGHT_BROWSERS_PATH, 'the install target path is set');
    child.emit('close', 1);
  } finally {
    if (prev === undefined) delete process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
    else process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = prev;
  }
});
