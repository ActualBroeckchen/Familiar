/**
 * web-fetch-util.js — a small timed fetch shared by the search backends.
 *
 * Both the keyless DuckDuckGo floor (websearch.js) and the proper-API adapters
 * (websearch-providers.js) need the same thing: a fetch with a hard
 * AbortController timeout, sensible JSON defaults, and optional method /
 * headers / body. Extracting it here keeps that logic in ONE place rather
 * than copy-pasted into each backend (CLAUDE.md: no copy-paste of
 * substantial logic).
 *
 * This is NOT the SSRF guard. These backends talk to FIXED, known endpoints
 * (DuckDuckGo's host, or the selected provider's own public API host) — never
 * an arbitrary URL — so they don't route through the public-only guard that
 * governs read_webpage. They DO need a timeout so one hung host can't stall a
 * tool round.
 */

const WEB_FETCH_TIMEOUT_MS = 9000;

/**
 * Fetch with a hard timeout. Returns the Response (callers do res.ok /
 * res.json()). Throws an AbortError on timeout — callers translate that
 * into a calm first-person string.
 */
export async function timedFetch(url, {
  method    = 'GET',
  headers   = {},
  body      = null,
  timeoutMs = WEB_FETCH_TIMEOUT_MS,
  fetchFn   = fetch,
} = {}) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const opts = { method, signal: ctrl.signal, headers: { Accept: 'application/json', ...headers } };
    if (body != null) {
      opts.body = typeof body === 'string' ? body : JSON.stringify(body);
      opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
    }
    return await fetchFn(url, opts);
  } finally {
    clearTimeout(timer);
  }
}
