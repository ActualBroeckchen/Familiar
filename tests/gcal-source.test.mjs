import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIcalUrl, fetchIcal } from '../gcal-source.js';

const ICS = 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:a\nDTSTART:20260101T090000Z\nSUMMARY:x\nEND:VEVENT\nEND:VCALENDAR\n';

test('normalizeIcalUrl: webcal → https, passthrough http(s), rejects junk', () => {
  assert.equal(normalizeIcalUrl('webcal://example.com/c.ics'), 'https://example.com/c.ics');
  assert.equal(normalizeIcalUrl('https://example.com/c.ics'), 'https://example.com/c.ics');
  assert.equal(normalizeIcalUrl('http://x/c.ics'), 'http://x/c.ics');
  assert.equal(normalizeIcalUrl('  https://x/c.ics  '), 'https://x/c.ics');
  assert.equal(normalizeIcalUrl('not a url'), null);
  assert.equal(normalizeIcalUrl(''), null);
  assert.equal(normalizeIcalUrl(undefined), null);
});

test('fetchIcal: returns the body on a good iCal response', async () => {
  const fetchFn = async () => ({ ok: true, status: 200, text: async () => ICS });
  const r = await fetchIcal('https://x/c.ics', { fetchFn });
  assert.equal(r.ok, true);
  assert.match(r.icsText, /BEGIN:VCALENDAR/);
});

test('fetchIcal: HTTP error degrades to ok:false (never throws)', async () => {
  const fetchFn = async () => ({ ok: false, status: 403, text: async () => 'forbidden' });
  const r = await fetchIcal('https://x/c.ics', { fetchFn });
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 403/);
});

test('fetchIcal: a non-iCal body (auth wall/HTML) is rejected, not treated as empty', async () => {
  const fetchFn = async () => ({ ok: true, status: 200, text: async () => '<html>sign in</html>' });
  const r = await fetchIcal('https://x/c.ics', { fetchFn });
  assert.equal(r.ok, false);
  assert.match(r.error, /not an iCalendar feed/);
});

test('fetchIcal: invalid URL fails fast', async () => {
  const r = await fetchIcal('nope', { fetchFn: async () => { throw new Error('should not be called'); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid or empty/);
});

test('fetchIcal: a thrown network error becomes ok:false', async () => {
  const fetchFn = async () => { throw new Error('ECONNREFUSED'); };
  const r = await fetchIcal('https://x/c.ics', { fetchFn });
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNREFUSED/);
});

import { fetchViaCli, normalizeCliEvents, detectCli, cliPresetHint } from '../gcal-source.js';

const ok = (stdout) => async () => ({ code: 0, stdout, stderr: '', failed: false });
const fail = (stderr, code = 1) => async () => ({ code, stdout: '', stderr, failed: true });

test('fetchViaCli (ics): routes stdout as ics_text, windowed → reconcileDeletes:false', async () => {
  const r = await fetchViaCli({ command: 'gogcli x', format: 'ics', runner: ok(ICS) });
  assert.equal(r.ok, true);
  assert.match(r.icsText, /BEGIN:VCALENDAR/);
  assert.equal(r.reconcileDeletes, false);
});

test('fetchViaCli (json): normalizes events, never reconciles deletes', async () => {
  const json = JSON.stringify([{ id: 'e1@g', summary: 'Meet', start: { dateTime: '2026-07-02T14:00:00Z' } }]);
  const r = await fetchViaCli({ command: 'gcalcli x', format: 'json', runner: ok(json) });
  assert.equal(r.ok, true);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].uid, 'e1@g');
  assert.equal(r.reconcileDeletes, false);
});

test('fetchViaCli: non-zero exit (auth failure / missing binary) → ok:false', async () => {
  const r = await fetchViaCli({ command: 'gogcli x', format: 'ics', runner: fail('not authenticated', 1) });
  assert.equal(r.ok, false);
  assert.match(r.error, /not authenticated|failed/);
});

test('fetchViaCli: ics output that is not iCal is rejected', async () => {
  const r = await fetchViaCli({ command: 'x', format: 'ics', runner: ok('<html>login</html>') });
  assert.equal(r.ok, false);
});

test('fetchViaCli: empty command → ok:false', async () => {
  const r = await fetchViaCli({ command: '  ', runner: ok(ICS) });
  assert.equal(r.ok, false);
});

test('normalizeCliEvents: maps loose field names, drops entries with no id', () => {
  const evs = normalizeCliEvents([
    { id: 'a', title: 'X', start: { date: '2026-07-02' }, end: { date: '2026-07-03' } },
    { summary: 'no id' },  // dropped
    { iCalUID: 'b', summary: 'Y', start: '2026-07-02T10:00:00Z', status: 'cancelled' },
  ]);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].uid, 'a');
  assert.equal(evs[0].all_day, true);
  assert.equal(evs[1].status, 'cancelled');
});

test('detectCli: present binary → available:true; missing → available:false', async () => {
  const present = await detectCli({ command: 'gogcli calendar', runner: ok('gogcli 1.2.3') });
  assert.equal(present.available, true);
  const missing = await detectCli({ command: 'nope', runner: fail('command not found') });
  assert.equal(missing.available, false);
});

test('cliPresetHint returns a default command for known presets', () => {
  assert.match(cliPresetHint('gogcli'), /gogcli/);
  assert.match(cliPresetHint('gcalcli'), /gcalcli/);
  assert.equal(cliPresetHint('unknown'), '');
});
