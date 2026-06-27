/**
 * Native Google Calendar — OAuth + the Calendar API, no CLI, no terminal.
 *
 * The authenticated source/sink the ward configures entirely from the UI
 * (build spec §1.5 advanced tier, reworked): rather than delegate to an
 * unverifiable third-party CLI that authenticates in a terminal, Proto-
 * Familiar talks to Google directly. The ward provides their OAuth client
 * once — either by uploading the Cloud-Console `credentials.json` and
 * clicking Allow (the loopback flow), or by pasting a refresh token they
 * minted on Google's side — and from then on a stored refresh token keeps a
 * fresh access token without any further interaction.
 *
 * Pure-ish + injectable: every network call takes a `fetchFn` so the OAuth
 * dance, token refresh, event normalisation, and write-back all unit-test
 * with a stub. The only state is the token store (a gitignored JSON file).
 *
 * Reads are WINDOWED (a forward time range), so — like every authenticated
 * adapter — they pass `reconcile_deletes:false`; cancellations still
 * propagate because the list call asks for deleted instances and they
 * arrive with status:'cancelled', which `gcal_ingest` resolves.
 */

import path from 'path';
import { promises as fsp } from 'fs';
import { fileURLToPath } from 'url';
import { normalizeCliEvents } from './gcal-source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOMES_DIR = path.join(__dirname, 'tomes');
const TOKEN_FILE = '.gcal-google-token.json';

const AUTH_ENDPOINT  = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const API_BASE       = 'https://www.googleapis.com/calendar/v3';
// Read + write to events (write-back needs insert). Not full-calendar scope.
export const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

// ── OAuth client config (from a Cloud-Console credentials.json) ──────

/**
 * Pull {clientId, clientSecret} out of a Cloud-Console download. A
 * "Desktop app" client nests under `installed`, a "Web application" under
 * `web`; we accept either, or a already-flat object. Returns null if it
 * can't find a client id.
 */
export function parseCredentials(jsonText) {
  let obj;
  try { obj = typeof jsonText === 'string' ? JSON.parse(jsonText) : jsonText; }
  catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const c = obj.installed || obj.web || obj;
  if (!c || !c.client_id) return null;
  return {
    clientId: c.client_id,
    clientSecret: c.client_secret || '',  // loopback/PKCE desktop clients may omit it
  };
}

/** The Google consent URL to send the ward's browser to (loopback flow). */
export function buildAuthUrl({ clientId, redirectUri, state, scope = SCOPE }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    access_type: 'offline',   // ask for a refresh token…
    prompt: 'consent',        // …and force it even on a re-auth
    include_granted_scopes: 'true',
    ...(state ? { state } : {}),
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

async function postForm(url, form, fetchFn) {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    const msg = body?.error_description || body?.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

/** Exchange an authorization code for tokens (the loopback callback). */
export async function exchangeCode({ code, clientId, clientSecret, redirectUri, fetchFn = globalThis.fetch, now = Date.now }) {
  const body = await postForm(TOKEN_ENDPOINT, {
    code, client_id: clientId, client_secret: clientSecret,
    redirect_uri: redirectUri, grant_type: 'authorization_code',
  }, fetchFn);
  return {
    refresh_token: body.refresh_token || null,
    access_token: body.access_token || null,
    expiry: now() + (Number(body.expires_in) || 3600) * 1000,
    scope: body.scope || SCOPE,
  };
}

/** Trade a refresh token for a fresh access token. */
export async function refreshAccessToken({ clientId, clientSecret, refreshToken, fetchFn = globalThis.fetch, now = Date.now }) {
  const body = await postForm(TOKEN_ENDPOINT, {
    client_id: clientId, client_secret: clientSecret,
    refresh_token: refreshToken, grant_type: 'refresh_token',
  }, fetchFn);
  return {
    access_token: body.access_token || null,
    expiry: now() + (Number(body.expires_in) || 3600) * 1000,
  };
}

/**
 * Return a valid access token for the stored credentials, refreshing it
 * (and persisting the refreshed store) when it's within 60s of expiry.
 * Returns { ok, accessToken, store } or { ok:false, error }.
 */
export async function getFreshAccessToken(store, { fetchFn = globalThis.fetch, now = Date.now, save } = {}) {
  if (!store?.refresh_token || !store?.client_id) {
    return { ok: false, error: 'not connected to Google' };
  }
  const valid = store.access_token && store.expiry && (store.expiry - now()) > 60_000;
  if (valid) return { ok: true, accessToken: store.access_token, store };
  try {
    const refreshed = await refreshAccessToken({
      clientId: store.client_id, clientSecret: store.client_secret || '',
      refreshToken: store.refresh_token, fetchFn, now,
    });
    const next = { ...store, access_token: refreshed.access_token, expiry: refreshed.expiry };
    if (typeof save === 'function') await save(next);
    return { ok: true, accessToken: refreshed.access_token, store: next };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// ── Calendar API ─────────────────────────────────────────────────────

/**
 * List events in [timeMin, timeMax] as RAW Google event resources. Expands
 * recurring series (singleEvents) and includes cancelled instances
 * (showDeleted) so deletions propagate even on a windowed read. Paginates.
 */
export async function listEvents({ accessToken, calendarId = 'primary', timeMin, timeMax, fetchFn = globalThis.fetch, maxPages = 20 }) {
  const items = [];
  let pageToken = null;
  for (let i = 0; i < maxPages; i++) {
    const params = new URLSearchParams({
      singleEvents: 'true', showDeleted: 'true', orderBy: 'startTime', maxResults: '250',
      ...(timeMin ? { timeMin } : {}), ...(timeMax ? { timeMax } : {}),
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await fetchFn(`${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = {}; }
    if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
    for (const it of (body.items || [])) items.push(it);
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }
  return items;
}

/** Google event resources → the shared normalized-event shape. Google's API
 *  shape (id, summary, start.dateTime/date, status, updated) already lines up
 *  with the normaliser, so this reuses it rather than duplicating the map. */
export function normalizeGoogleEvents(items) {
  return normalizeCliEvents(items);
}

/**
 * Build a Google event resource from an Unruh node for write-back. Sends the
 * ward's LOCAL wall-clock plus their IANA zone and lets GOOGLE do the
 * local→instant conversion — so the model never does timezone math and Node
 * doesn't either (the conversion lives at Google's boundary). All-day nodes
 * use the date-only form.
 */
export function buildEventResource(node, { timeZone } = {}) {
  const p = node?.payload || {};
  const ev = { summary: node?.label || '(untitled)' };
  if (p.location) ev.location = p.location;
  if (p.description) ev.description = p.description;
  const localPart = (iso) => String(iso || '').slice(0, 19); // strip any stray offset
  if (p.all_day) {
    ev.start = { date: localPart(node.when).slice(0, 10) };
    ev.end = { date: localPart(node.end || node.when).slice(0, 10) };
  } else {
    ev.start = { dateTime: localPart(node.when), ...(timeZone ? { timeZone } : {}) };
    if (node.end) ev.end = { dateTime: localPart(node.end), ...(timeZone ? { timeZone } : {}) };
    else ev.end = ev.start;
  }
  return ev;
}

/** Insert (ADD only) an event into the calendar. Returns { ok, id } / { ok:false }. */
export async function insertEvent({ accessToken, calendarId = 'primary', event, fetchFn = globalThis.fetch }) {
  try {
    const res = await fetchFn(`${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = {}; }
    if (!res.ok) return { ok: false, error: body?.error?.message || `HTTP ${res.status}` };
    return { ok: true, id: body.id };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// ── Token store (gitignored tomes/.gcal-google-token.json) ───────────

function tokenPath(tomesDir) { return path.join(tomesDir, TOKEN_FILE); }

export async function readToken({ tomesDir = DEFAULT_TOMES_DIR } = {}) {
  try {
    const raw = await fsp.readFile(tokenPath(tomesDir), 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch { return null; }
}

export async function writeToken(store, { tomesDir = DEFAULT_TOMES_DIR } = {}) {
  await fsp.mkdir(tomesDir, { recursive: true });
  const tmp = tokenPath(tomesDir) + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(store ?? {}, null, 2), 'utf8');
  await fsp.rename(tmp, tokenPath(tomesDir));
}

export async function clearToken({ tomesDir = DEFAULT_TOMES_DIR } = {}) {
  try { await fsp.unlink(tokenPath(tomesDir)); } catch { /* already gone */ }
}

/** Whether a usable Google connection exists (a refresh token + client id). */
export function isConnected(store) {
  return !!(store && store.refresh_token && store.client_id);
}

/** A redacted view for the status endpoint — NEVER leak tokens to the UI. */
export function publicStatus(store) {
  return {
    connected: isConnected(store),
    hasCredentials: !!(store && store.client_id),
    account: store?.account || null,
    scope: store?.scope || null,
  };
}
