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
