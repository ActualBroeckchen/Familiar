/**
 * local-engine-adapters.js — query a running local search engine's JSON API.
 *
 * Each managed local engine speaks a slightly different JSON dialect, so each
 * gets a small adapter that turns "engine base URL + query" into the uniform
 * { rows: [{title,url,content}] } | { error } shape the rest of web search
 * uses. local-engine-service binds the active engine's adapter; websearch.js
 * uses the SearXNG one for the power-user "bring your own SearXNG" URL too.
 *
 * These talk to a sanctioned loopback (the managed engine) or the human's own
 * instance — not the SSRF-guarded read path — so they use the shared
 * timedFetch for the timeout only. A non-ok / unreachable engine returns
 * { error }, which the caller degrades to the keyless floor.
 *
 * 4get / LibreY route + response shapes are confirmed against their pinned
 * source when Part 3 wires them (see docs/websearch-modular-build-spec.md §4b).
 */

import { timedFetch } from './web-fetch-util.js';

// Local engines aggregate several upstream search engines server-side, so they
// are legitimately slower than a single fast API — the default 9s fetch timeout
// is too tight (LibreY routinely needs ~10s). Give them room before we give up
// and fall back to the keyless floor.
const LOCAL_TIMEOUT_MS = 20000;

const trimBase = (base) => String(base || '').replace(/\/+$/, '');

function abortOr(err, name) {
  if (err?.name === 'AbortError') return { error: 'My search timed out before it answered.' };
  return { error: `I couldn't reach my ${name} instance (${err.message}). It may be down.` };
}

// Build an error result that includes the engine's own response body (the
// engines return a JSON/text error on 500), so a misconfig is diagnosable
// from the [websearch] log rather than just "HTTP 500".
async function httpErr(res, name) {
  let detail = '';
  try { detail = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 300); } catch { /* body unreadable */ }
  return { error: `My ${name} search came back with an error (HTTP ${res.status})${detail ? `: ${detail}` : ''}.` };
}

// SearXNG: GET /search?q=…&format=json → { results: [{title,url,content}, …] }
// (results already carry title/url/content, so they pass through unmapped.)
export async function searxngSearch(base, q, { fetchFn = fetch } = {}) {
  const url = `${trimBase(base)}/search?q=${encodeURIComponent(q)}&format=json`;
  try {
    const res = await timedFetch(url, { fetchFn, timeoutMs: LOCAL_TIMEOUT_MS });
    if (!res.ok) return httpErr(res, 'SearXNG');
    const data = await res.json();
    return { rows: Array.isArray(data?.results) ? data.results : [] };
  } catch (err) {
    return abortOr(err, 'SearXNG');
  }
}

// Map an arbitrary engine result object to our {title,url,content} row,
// tolerating the small field-name differences between engines.
function toRow(r) {
  return {
    title:   r?.title || r?.name || '',
    url:     r?.url || r?.link || r?.href || '',
    content: r?.description || r?.desc || r?.content || r?.snippet || '',
  };
}
const keepRows = (arr) => (Array.isArray(arr) ? arr : [])
  .map(toRow)
  .filter(row => row.url && row.title);

// LibreY: GET /api.php?q=…&t=0&p=0 → a JSON ARRAY of {title,url,description}.
// `t` is the numeric search type (0=text) and `p` the page (0=first) — NOT
// `type=text` (confirmed from LibreY's api.php source). A leading infobox/
// special element may appear; keepRows drops anything without a url+title.
// API is on by default (config disable_api:false); a 500 / HTML body → {error}.
export async function libreySearch(base, q, { fetchFn = fetch } = {}) {
  const url = `${trimBase(base)}/api.php?q=${encodeURIComponent(q)}&t=0&p=0`;
  try {
    const res = await timedFetch(url, { fetchFn, timeoutMs: LOCAL_TIMEOUT_MS });
    if (!res.ok) return httpErr(res, 'LibreY');
    const data = await res.json();
    const arr = Array.isArray(data) ? data : (data?.results || data?.items);
    return { rows: keepRows(arr) };
  } catch (err) {
    return abortOr(err, 'LibreY');
  }
}

// 4get: GET /api/v1/web?s=… → JSON grouped by type, web results under `web`.
// Defensive across shapes (web / results / bare array). The API must be
// enabled in 4get's data/config.php (copied from the shipped example on
// install). Exact route/shape confirmed from the fetched source on first
// real install — see docs/websearch-modular-build-spec.md §4b.
export async function fourgetSearch(base, q, { fetchFn = fetch } = {}) {
  const url = `${trimBase(base)}/api/v1/web?s=${encodeURIComponent(q)}`;
  try {
    const res = await timedFetch(url, { fetchFn, timeoutMs: LOCAL_TIMEOUT_MS });
    if (!res.ok) return httpErr(res, '4get');
    const data = await res.json();
    const arr = data?.web || data?.results || (Array.isArray(data) ? data : []);
    return { rows: keepRows(arr) };
  } catch (err) {
    return abortOr(err, '4get');
  }
}
