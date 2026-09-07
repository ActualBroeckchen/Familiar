/**
 * reader-doctor.js — "which gated sites can I actually read right now, and what
 * would unlock the rest?" (the Agent-Reach `doctor` idea, in-tree).
 *
 * Pure assembly: it takes the site registry, what each site has CONFIGURED
 * (credentials present? a browser session available?), and an optional live
 * probe per site, and returns a report the Familiar can read back to the ward or
 * act on. No network here — the caller supplies probes so this stays testable.
 */

import { READER_SITES } from './reader-router.js';
import { redditCredentials } from './reddit-reader.js';

/**
 * What's configured for each site, from settings/env — no network. Returns a
 * map siteId → { configured, note }.
 */
export function readerConfigStatus(settings = {}) {
  const out = {};
  for (const site of READER_SITES) {
    if (site.id === 'reddit') {
      const creds = redditCredentials(settings);
      out.reddit = creds.complete
        ? { configured: true, note: 'API credentials set (sanctioned OAuth path).' }
        : { configured: false, note: 'No API credentials; relying on the browser session or the public path.' };
    } else {
      out[site.id] = { configured: false, note: '' };
    }
  }
  return out;
}

/**
 * Build the full report. `probes` maps siteId → async () => ({ reachable, via,
 * detail }); a missing probe leaves reachability unknown. `browserUp` marks
 * whether the persistent browser context is available (the browser-session
 * backend needs it). Never throws — a probe that rejects is reported as an
 * error line, not a crash.
 */
export async function buildReaderReport({ settings = {}, probes = {}, browserUp = false } = {}) {
  const cfg = readerConfigStatus(settings);
  const sites = [];
  for (const site of READER_SITES) {
    const entry = {
      id: site.id, label: site.label, backends: site.backends,
      configured: cfg[site.id]?.configured ?? false,
      note: cfg[site.id]?.note ?? '',
      unlock: site.unlock, reachable: null, via: null, detail: '',
    };
    const probe = probes[site.id];
    if (typeof probe === 'function') {
      try { const r = await probe(); entry.reachable = !!r?.reachable; entry.via = r?.via ?? null; entry.detail = r?.detail ?? ''; }
      catch (err) { entry.reachable = false; entry.detail = `probe error: ${err?.message || err}`; }
    }
    if (site.backends.includes('browser-session') && !browserUp && entry.reachable !== true) {
      entry.detail = (entry.detail ? entry.detail + ' ' : '') + '(browser session not active — the browser-session backend is unavailable until browsing is on and the ward has logged in).';
    }
    sites.push(entry);
  }
  return { browserUp, sites };
}

/**
 * Assemble + run the live doctor: resolve whether the browser session is up,
 * build the per-site probes (reddit today), and return the report. Shared by the
 * `reader_doctor` tool and the `/api/reader-doctor` endpoint so the probe wiring
 * lives in one place. Heavy engines are dynamic-imported to stay out of the
 * static graph. `wardTurn` gates the browser-session backend (it's the ward's).
 */
export async function runReaderDoctor({ settings = {}, wardTurn = true } = {}) {
  let drv = null; try { drv = await import('./browser-driver.js'); } catch { /* engine absent */ }
  let browseOn = false;
  try { const b = await import('./browser.js'); browseOn = b.browseEnabled(settings); } catch { /* browser layer absent */ }
  const browserUp = browseOn && !!drv?.findChromium?.();
  const probes = {
    reddit: async () => {
      const rr = await import('./reddit-reader.js');
      const deps = {};
      if (wardTurn && browserUp && drv) deps.contextFetch = (u, o) => drv.contextRequest(u, o);
      const r = await rr.fetchRedditJson('https://www.reddit.com/r/popular/top.json?limit=1', { settings, deps });
      return r.ok ? { reachable: true, via: r.via } : { reachable: false, via: r.via, detail: r.error || 'blocked' };
    },
  };
  return buildReaderReport({ settings, probes, browserUp });
}

/** Render a report as first-person text the Familiar can read back. */
export function formatReaderReport(report) {
  if (!report?.sites?.length) return 'I have no gated-site readers registered yet.';
  const mark = (r) => (r.reachable === true ? '🟢 reachable' : r.reachable === false ? '⚫ blocked' : '· unknown');
  const lines = report.sites.map(s => {
    const bits = [`${s.label}: ${mark(s)}${s.via ? ` (via ${s.via})` : ''}`];
    if (s.note) bits.push(`  ${s.note}`);
    if (s.reachable !== true && s.unlock) bits.push(`  To unlock: ${s.unlock}`);
    if (s.detail) bits.push(`  ${s.detail}`);
    return bits.join('\n');
  });
  const head = report.browserUp ? 'My browser session is active.' : 'My browser session is not active right now.';
  return `Reader check — ${head}\n\n${lines.join('\n\n')}`;
}
