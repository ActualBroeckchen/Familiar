import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readerSiteFor, runReaderChain, READER_SITES } from '../src/browser/reader-router.js';

test('readerSiteFor: Reddit hosts resolve; others are null', () => {
  assert.equal(readerSiteFor('https://www.reddit.com/r/x')?.id, 'reddit');
  assert.equal(readerSiteFor('https://old.reddit.com/r/x')?.id, 'reddit');
  assert.equal(readerSiteFor('https://example.com'), null);
  assert.equal(readerSiteFor('garbage'), null);
});

test('READER_SITES: every site declares an ordered non-empty backend chain', () => {
  for (const s of READER_SITES) {
    assert.ok(Array.isArray(s.backends) && s.backends.length, `${s.id} has no backends`);
    assert.ok(s.hosts.length && s.label, `${s.id} missing hosts/label`);
  }
});

test('runReaderChain: returns the first success and records every attempt', async () => {
  const runners = {
    oauth: async () => ({ ok: false, detail: 'no creds' }),
    'browser-session': async () => ({ ok: true, text: 'the post', detail: 'session' }),
    'public-json': async () => { throw new Error('should not reach'); },
  };
  const r = await runReaderChain(['oauth', 'browser-session', 'public-json'], runners);
  assert.equal(r.ok, true);
  assert.equal(r.via, 'browser-session');
  assert.equal(r.text, 'the post');
  assert.deepEqual(r.tried.map(t => `${t.backend}:${t.ok}`), ['oauth:false', 'browser-session:true']);
});

test('runReaderChain: all fail → ok:false, tried lists each; unknown backend is skipped', async () => {
  const r = await runReaderChain(['oauth', 'nope'], { oauth: async () => ({ ok: false, detail: 'x' }) });
  assert.equal(r.ok, false);
  assert.equal(r.via, null);
  assert.equal(r.tried.length, 2);
  assert.equal(r.tried[1].detail, 'unavailable');
});

test('runReaderChain: a thrown runner is caught, not fatal', async () => {
  const r = await runReaderChain(['a', 'b'], {
    a: async () => { throw new Error('boom'); },
    b: async () => ({ ok: true, text: 'ok' }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'b');
  assert.equal(r.tried[0].ok, false);
});
