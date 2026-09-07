/**
 * reader-router.js — the registry of gated sites and how the Familiar reads
 * each one (spec: docs/reader-router-build-spec.md).
 *
 * The lesson from Reddit — and from every "AI can't read this site" write-up —
 * is that a single fetch strategy loses: sites block server-side fetches at the
 * network layer, gate content behind login, or render client-side. The durable
 * shape is per-site "primary + fallback" backends, and a way to SEE which door
 * is open. This module owns the registry (data, not behaviour); the concrete
 * readers live in their own modules (reddit-reader.js …), and the doctor
 * (reader-doctor.js) reads this table to report reachability.
 *
 * Backends, in the order a site prefers them:
 *   - `oauth`           a sanctioned API with the ward's credentials.
 *   - `browser-session` fetch through the persistent browser context — the
 *                       ward's real browser fingerprint + logged-in cookies
 *                       (browser-driver.contextRequest). The generalisable key
 *                       to network-blocked / login-gated sites.
 *   - `public-json`     a plain server-side JSON fetch (best-effort).
 *   - `browser-read`    read the live, authenticated, JS-rendered DOM
 *                       (browseRead + shadow-DOM piercing).
 *   - `static-fetch`    the plain HTML→markdown floor (websearch).
 */

/** Every gated site the Familiar has a considered strategy for. */
export const READER_SITES = [
  {
    id: 'reddit',
    label: 'Reddit',
    hosts: ['reddit.com'],
    backends: ['oauth', 'browser-session', 'public-json'],
    unlock: 'Log in to Reddit once via the browser hand-off, or set Reddit API credentials in Settings → Reddit reading.',
    zeroConfig: false, // Reddit's anonymous path is network-blocked (2023 API lockdown)
  },
  // Future passes (docs/reader-router-build-spec.md): linkedin, quora, medium,
  // substack, twitter — all read via `browser-session` / `browser-read` off the
  // ward's logged-in profile. Registered here as they land so the doctor and the
  // read path stay in sync.
];

/** hostname (any case, optional leading www.) → site record, or null. */
export function readerSiteFor(url) {
  let host;
  try { host = new URL(String(url ?? '')).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return null; }
  for (const site of READER_SITES) {
    if (site.hosts.some(h => host === h || host.endsWith('.' + h))) return site;
  }
  return null;
}

/**
 * Run an ordered backend chain, returning the first success. `runners` maps a
 * backend name → async () => ({ ok, text?, detail? }); unknown/omitted backends
 * are skipped. Returns { ok, text, via, tried } — `tried` records every
 * attempt so a failure is legible (the doctor and the honest-degradation path
 * both use it). Never throws.
 */
export async function runReaderChain(backends, runners) {
  const tried = [];
  for (const name of backends || []) {
    const run = runners?.[name];
    if (typeof run !== 'function') { tried.push({ backend: name, ok: false, detail: 'unavailable' }); continue; }
    let r;
    try { r = await run(); } catch (err) { r = { ok: false, detail: err?.message || 'threw' }; }
    tried.push({ backend: name, ok: !!r?.ok, detail: r?.detail || '' });
    if (r?.ok) return { ok: true, text: r.text ?? '', via: name, tried };
  }
  return { ok: false, text: '', via: null, tried };
}
