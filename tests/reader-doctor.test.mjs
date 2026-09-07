import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readerConfigStatus, buildReaderReport, formatReaderReport } from '../src/browser/reader-doctor.js';

test('readerConfigStatus: Reddit configured iff full credentials present', () => {
  assert.equal(readerConfigStatus({}).reddit.configured, false);
  const full = { redditClientId: 'a', redditClientSecret: 'b', redditUsername: 'c', redditPassword: 'd' };
  assert.equal(readerConfigStatus(full).reddit.configured, true);
});

test('buildReaderReport: a reachable probe reports via; unreachable reports detail', async () => {
  const rep = await buildReaderReport({
    settings: {},
    browserUp: true,
    probes: { reddit: async () => ({ reachable: true, via: 'browser-session' }) },
  });
  const reddit = rep.sites.find(s => s.id === 'reddit');
  assert.equal(reddit.reachable, true);
  assert.equal(reddit.via, 'browser-session');
});

test('buildReaderReport: no browser session → adds the unavailable hint on a blocked site', async () => {
  const rep = await buildReaderReport({
    settings: {},
    browserUp: false,
    probes: { reddit: async () => ({ reachable: false, detail: 'http 403' }) },
  });
  const reddit = rep.sites.find(s => s.id === 'reddit');
  assert.equal(reddit.reachable, false);
  assert.match(reddit.detail, /browser session not active/);
});

test('buildReaderReport: a throwing probe is reported, not fatal', async () => {
  const rep = await buildReaderReport({ settings: {}, probes: { reddit: async () => { throw new Error('nope'); } } });
  assert.equal(rep.sites[0].reachable, false);
  assert.match(rep.sites[0].detail, /probe error/);
});

test('formatReaderReport: renders reachable/blocked marks + unlock guidance', () => {
  const text = formatReaderReport({
    browserUp: false,
    sites: [
      { id: 'reddit', label: 'Reddit', reachable: false, via: null, note: 'No API credentials.', unlock: 'Log in via the browser hand-off.', detail: '' },
    ],
  });
  assert.match(text, /Reddit: ⚫ blocked/);
  assert.match(text, /To unlock: Log in via the browser hand-off/);
  assert.match(text, /browser session is not active/);
});
