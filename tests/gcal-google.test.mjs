import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCredentials, buildAuthUrl, exchangeCode, refreshAccessToken,
  getFreshAccessToken, listEvents, normalizeGoogleEvents, buildEventResource,
  insertEvent, isConnected, publicStatus, SCOPE,
} from '../gcal-google.js';

const jsonRes = (obj, ok = true, status = 200) => ({ ok, status, text: async () => JSON.stringify(obj) });

test('parseCredentials: handles installed / web / flat / junk', () => {
  assert.deepEqual(parseCredentials('{"installed":{"client_id":"a","client_secret":"s"}}'), { clientId: 'a', clientSecret: 's' });
  assert.deepEqual(parseCredentials('{"web":{"client_id":"b","client_secret":"t"}}'), { clientId: 'b', clientSecret: 't' });
  assert.deepEqual(parseCredentials({ client_id: 'c' }), { clientId: 'c', clientSecret: '' });
  assert.equal(parseCredentials('not json'), null);
  assert.equal(parseCredentials('{"nope":1}'), null);
});

test('buildAuthUrl: carries the params that get a refresh token', () => {
  const url = buildAuthUrl({ clientId: 'cid', redirectUri: 'http://localhost:8742/cb', state: 'xyz' });
  assert.match(url, /accounts\.google\.com/);
  const q = new URL(url).searchParams;
  assert.equal(q.get('client_id'), 'cid');
  assert.equal(q.get('redirect_uri'), 'http://localhost:8742/cb');
  assert.equal(q.get('access_type'), 'offline');
  assert.equal(q.get('prompt'), 'consent');
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('state'), 'xyz');
  assert.equal(q.get('scope'), SCOPE);
});

test('exchangeCode: returns refresh + access + expiry', async () => {
  const fetchFn = async () => jsonRes({ refresh_token: 'R', access_token: 'A', expires_in: 3600 });
  const t = await exchangeCode({ code: 'c', clientId: 'i', clientSecret: 's', redirectUri: 'u', fetchFn, now: () => 1000 });
  assert.equal(t.refresh_token, 'R');
  assert.equal(t.access_token, 'A');
  assert.equal(t.expiry, 1000 + 3600_000);
});

test('exchangeCode: surfaces Google error_description', async () => {
  const fetchFn = async () => jsonRes({ error: 'invalid_grant', error_description: 'bad code' }, false, 400);
  await assert.rejects(exchangeCode({ code: 'c', clientId: 'i', clientSecret: 's', redirectUri: 'u', fetchFn }), /bad code/);
});

test('getFreshAccessToken: uses a valid token without refreshing', async () => {
  let refreshed = false;
  const fetchFn = async () => { refreshed = true; return jsonRes({ access_token: 'NEW', expires_in: 3600 }); };
  const store = { client_id: 'i', refresh_token: 'R', access_token: 'GOOD', expiry: 1000 + 200_000 };
  const r = await getFreshAccessToken(store, { fetchFn, now: () => 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.accessToken, 'GOOD');
  assert.equal(refreshed, false);
});

test('getFreshAccessToken: refreshes + persists an expired token', async () => {
  let saved = null;
  const fetchFn = async () => jsonRes({ access_token: 'NEW', expires_in: 3600 });
  const store = { client_id: 'i', client_secret: 's', refresh_token: 'R', access_token: 'OLD', expiry: 500 };
  const r = await getFreshAccessToken(store, { fetchFn, now: () => 1000, save: async (s) => { saved = s; } });
  assert.equal(r.accessToken, 'NEW');
  assert.equal(saved.access_token, 'NEW');
  assert.equal(saved.refresh_token, 'R');  // refresh token preserved
});

test('getFreshAccessToken: not connected → ok:false', async () => {
  const r = await getFreshAccessToken({}, {});
  assert.equal(r.ok, false);
});

test('listEvents: sends auth header, expands + shows deleted, paginates', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    if (calls.length === 1) return jsonRes({ items: [{ id: 'e1' }], nextPageToken: 'p2' });
    return jsonRes({ items: [{ id: 'e2' }] });
  };
  const items = await listEvents({ accessToken: 'TOK', timeMin: '2026-07-01T00:00:00Z', fetchFn });
  assert.deepEqual(items.map(i => i.id), ['e1', 'e2']);
  assert.equal(calls[0].auth, 'Bearer TOK');
  assert.match(calls[0].url, /singleEvents=true/);
  assert.match(calls[0].url, /showDeleted=true/);
});

test('normalizeGoogleEvents: real Google shape → normalized, cancelled propagates', () => {
  const evs = normalizeGoogleEvents([
    { id: 'g1', summary: 'Dentist', start: { dateTime: '2026-07-02T14:00:00-07:00' }, end: { dateTime: '2026-07-02T14:45:00-07:00' }, status: 'confirmed', updated: '2026-06-20T09:00:00Z' },
    { id: 'g2', summary: 'Holiday', start: { date: '2026-07-05' }, end: { date: '2026-07-06' }, status: 'confirmed' },
    { id: 'g3', summary: 'Gone', start: { dateTime: '2026-07-03T10:00:00Z' }, status: 'cancelled' },
  ]);
  assert.equal(evs.length, 3);
  assert.equal(evs[0].uid, 'g1');
  assert.equal(evs[0].last_modified, '2026-06-20T09:00:00Z');
  assert.equal(evs[1].all_day, true);
  assert.equal(evs[2].status, 'cancelled');
});

test('buildEventResource: timed sends local + timeZone (Google does the math)', () => {
  const node = { label: 'Review', when: '2026-07-02T15:00:00', end: '2026-07-02T16:00:00', payload: { location: 'Room 4' } };
  const ev = buildEventResource(node, { timeZone: 'America/Los_Angeles' });
  assert.equal(ev.summary, 'Review');
  assert.equal(ev.location, 'Room 4');
  assert.deepEqual(ev.start, { dateTime: '2026-07-02T15:00:00', timeZone: 'America/Los_Angeles' });
  assert.deepEqual(ev.end, { dateTime: '2026-07-02T16:00:00', timeZone: 'America/Los_Angeles' });
});

test('buildEventResource: all-day uses date-only', () => {
  const ev = buildEventResource({ label: 'Off', when: '2026-07-05T00:00:00', payload: { all_day: true } });
  assert.deepEqual(ev.start, { date: '2026-07-05' });
  assert.ok(ev.end.date);
});

test('insertEvent: ok path returns the new id; error degrades', async () => {
  const okFn = async () => jsonRes({ id: 'new123' });
  assert.deepEqual(await insertEvent({ accessToken: 'T', event: {}, fetchFn: okFn }), { ok: true, id: 'new123' });
  const errFn = async () => jsonRes({ error: { message: 'insufficient permissions' } }, false, 403);
  const r = await insertEvent({ accessToken: 'T', event: {}, fetchFn: errFn });
  assert.equal(r.ok, false);
  assert.match(r.error, /insufficient/);
});

test('isConnected / publicStatus never leak tokens', () => {
  const store = { client_id: 'i', client_secret: 's', refresh_token: 'SECRET', access_token: 'SECRET2', account: 'me@x.com', scope: SCOPE };
  assert.equal(isConnected(store), true);
  const pub = publicStatus(store);
  assert.deepEqual(pub, { connected: true, hasCredentials: true, account: 'me@x.com', scope: SCOPE });
  assert.ok(!JSON.stringify(pub).includes('SECRET'));
  assert.equal(isConnected({ client_id: 'i' }), false);  // creds but no token
});
