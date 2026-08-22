/**
 * websearch-providers.js — proper search-API adapters for web_search.
 *
 * Each adapter is a small JSON client for one provider's OFFICIAL API — no
 * scraping. They all return the same shape every search backend in
 * websearch.js uses:
 *     { rows: [{ title, url, content }, …] }   on success
 *     { error: "<calm first-person string>" }  on any failure
 * so searchWeb can dispatch to them and fall back to the keyless DuckDuckGo
 * floor on { error }. A missing key, a bad key, or a down provider therefore
 * never leaves my human without search.
 *
 * Provider hosts are trusted public endpoints (the SSRF guard governs
 * read_webpage, not these sanctioned API calls); they just need the timeout
 * that timedFetch provides.
 *
 * Signup + trade-off guidance for choosing between these lives in the
 * guide-chat tools-info block (docs/websearch-modular-build-spec.md §5b).
 */

import { timedFetch } from './web-fetch-util.js';

// Brave — independent index, header-token auth. Maps web.results[] → rows.
export async function braveSearch(query, { apiKey } = {}, { fetchFn = fetch } = {}) {
  if (!apiKey) return { error: 'I need a Brave API key set before I can search with Brave.' };
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`;
  try {
    const res = await timedFetch(url, { headers: { 'X-Subscription-Token': apiKey }, fetchFn });
    if (!res.ok) return { error: `Brave search came back with an error (HTTP ${res.status}).` };
    const data = await res.json();
    const rows = (Array.isArray(data?.web?.results) ? data.web.results : [])
      .map(r => ({ title: r?.title || '', url: r?.url || '', content: r?.description || '' }));
    return { rows };
  } catch (err) {
    if (err?.name === 'AbortError') return { error: 'My Brave search timed out before it answered.' };
    return { error: `I couldn't reach Brave search (${err.message}).` };
  }
}

// Tavily — LLM-native, POST + bearer auth. Maps results[] → rows.
export async function tavilySearch(query, { apiKey } = {}, { fetchFn = fetch } = {}) {
  if (!apiKey) return { error: 'I need a Tavily API key set before I can search with Tavily.' };
  try {
    const res = await timedFetch('https://api.tavily.com/search', {
      method:  'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body:    { query, max_results: 10 },
      fetchFn,
    });
    if (!res.ok) return { error: `Tavily search came back with an error (HTTP ${res.status}).` };
    const data = await res.json();
    const rows = (Array.isArray(data?.results) ? data.results : [])
      .map(r => ({ title: r?.title || '', url: r?.url || '', content: r?.content || '' }));
    return { rows };
  } catch (err) {
    if (err?.name === 'AbortError') return { error: 'My Tavily search timed out before it answered.' };
    return { error: `I couldn't reach Tavily search (${err.message}).` };
  }
}

// Google Programmable Search — needs BOTH an API key and a search-engine id
// (cx). Maps items[] → rows.
export async function googleSearch(query, { apiKey, cseId } = {}, { fetchFn = fetch } = {}) {
  if (!apiKey || !cseId) return { error: 'I need both a Google API key and a search-engine ID set before I can search with Google.' };
  const url = 'https://www.googleapis.com/customsearch/v1'
    + `?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cseId)}&q=${encodeURIComponent(query)}`;
  try {
    const res = await timedFetch(url, { fetchFn });
    if (!res.ok) return { error: `Google search came back with an error (HTTP ${res.status}).` };
    const data = await res.json();
    const rows = (Array.isArray(data?.items) ? data.items : [])
      .map(r => ({ title: r?.title || '', url: r?.link || '', content: r?.snippet || '' }));
    return { rows };
  } catch (err) {
    if (err?.name === 'AbortError') return { error: 'My Google search timed out before it answered.' };
    return { error: `I couldn't reach Google search (${err.message}).` };
  }
}

// Marginalia — an INDEPENDENT small-web index (its own crawler; not Google/
// Bing/DDG). A legitimate API, not scraping — and the key "public" works with
// NO account/card/registration (shared rate limit → occasional HTTP 503; an
// own key via kontakt@marginalia.nu avoids that). Deliberately favours indie /
// non-commercial pages over big commercial sites, so it's for discovery, not a
// general Google replacement. Maps results[] → rows.
export async function marginaliaSearch(query, { apiKey } = {}, { fetchFn = fetch } = {}) {
  const key = (apiKey && String(apiKey).trim()) || 'public';
  const url = 'https://api2.marginalia-search.com/search'
    + `?query=${encodeURIComponent(query)}&count=20&timeout=200`;
  try {
    const res = await timedFetch(url, { headers: { 'API-Key': key }, fetchFn });
    if (!res.ok) {
      const limited = res.status === 503 ? ' — the free shared key is rate-limited right now (an own key from kontakt@marginalia.nu avoids that)' : '';
      return { error: `Marginalia search came back with an error (HTTP ${res.status})${limited}.` };
    }
    const data = await res.json();
    const rows = (Array.isArray(data?.results) ? data.results : [])
      .map(r => ({ title: r?.title || '', url: r?.url || '', content: r?.description || '' }));
    return { rows };
  } catch (err) {
    if (err?.name === 'AbortError') return { error: 'My Marginalia search timed out before it answered.' };
    return { error: `I couldn't reach Marginalia search (${err.message}).` };
  }
}

// The provider registry searchWeb dispatches through. Adding a provider =
// one adapter + one entry here (+ its settings fields + UI).
export const API_PROVIDERS = {
  brave:      braveSearch,
  tavily:     tavilySearch,
  google:     googleSearch,
  marginalia: marginaliaSearch,
};
