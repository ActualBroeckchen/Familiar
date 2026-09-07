/**
 * reddit-reader.js — read Reddit through its JSON API instead of the browser.
 *
 * Reddit's anti-bot wall fingerprints automated *browser* traffic and 403s it
 * before the page renders — no amount of browser polish gets past it (the ward's
 * report). The JSON path is a different door: plain HTTP with a descriptive
 * User-Agent, no headless-browser fingerprint. Two tiers:
 *
 *   - Public `.json` (default, zero setup): any post/listing URL + `.json`.
 *     Works from a residential IP where the browser is blocked, because the
 *     block is on the automation fingerprint, not the address. Rate-limited and
 *     can still be refused (datacenter IPs, heavy use) — degrades honestly.
 *   - OAuth API (opt-in, bulletproof): when the ward has set script-app
 *     credentials, reads go through oauth.reddit.com with a bearer token — the
 *     sanctioned path that never touches the anti-bot wall.
 *
 * The output is external content the Familiar READS, never obeys — it is
 * sanitised through the injection-guard at the read seam like any web page.
 * Everything here is Node-side; the model only ever receives clean text.
 */

import { guardedFetch, WebAccessError } from './src/search/websearch.js';
import { sanitizeExternal } from './injection-guard.js';

const DEFAULT_UA = 'proto-familiar/1.0 (personal companion reader; +https://github.com/PsycherosAI)';
const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const OAUTH_HOST = 'oauth.reddit.com';
const PUBLIC_HOST = 'www.reddit.com';

export function isRedditUrl(url) {
  try {
    const h = new URL(String(url)).hostname.toLowerCase().replace(/^www\./, '');
    return h === 'reddit.com' || h.endsWith('.reddit.com');
  } catch { return false; }
}

/**
 * Normalise a Reddit front-end URL to the API path we fetch (with a `.json`
 * suffix and a bounded `limit`). Returns { path, search } or null when the URL
 * isn't a JSON-readable Reddit page (media/api/oauth hosts, or non-reddit).
 * Pure + testable — host selection (public vs oauth) happens at fetch time.
 */
export function redditApiPath(url) {
  let u;
  try { u = new URL(String(url ?? '')); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!(host === 'reddit.com' || host.endsWith('.reddit.com'))) return null;
  const sub = host === 'reddit.com' ? '' : host.slice(0, -'.reddit.com'.length);
  // Media, preview, oauth, and api subdomains aren't human-readable listings.
  if (['i', 'preview', 'out', 'oauth', 'api', 'v'].includes(sub)) return null;
  let path = u.pathname.replace(/\/+$/, '');
  if (!path) path = '';
  if (!/\.json$/i.test(path)) path += '.json';
  const params = new URLSearchParams(u.search);
  if (!params.has('limit')) params.set('limit', '50');       // bound comment/listing size
  params.set('raw_json', '1');                                // no HTML-entity escaping
  return { path, search: '?' + params.toString() };
}

/** Read Reddit credentials from env (preferred) then settings. */
export function redditCredentials(settings = {}) {
  const env = process.env;
  const pick = (envName, settingName) =>
    (env[envName] && String(env[envName]).trim()) || (settings?.[settingName] && String(settings[settingName]).trim()) || '';
  const clientId = pick('PROTO_FAMILIAR_REDDIT_CLIENT_ID', 'redditClientId');
  const clientSecret = pick('PROTO_FAMILIAR_REDDIT_CLIENT_SECRET', 'redditClientSecret');
  const username = pick('PROTO_FAMILIAR_REDDIT_USERNAME', 'redditUsername');
  const password = pick('PROTO_FAMILIAR_REDDIT_PASSWORD', 'redditPassword');
  const complete = !!(clientId && clientSecret && username && password);
  return { clientId, clientSecret, username, password, complete };
}

/** The User-Agent to send. Reddit wants a descriptive one; a username helps. */
export function redditUserAgent(settings = {}) {
  const explicit = (process.env.PROTO_FAMILIAR_REDDIT_USER_AGENT || settings?.redditUserAgent || '').trim();
  if (explicit) return explicit;
  const creds = redditCredentials(settings);
  return creds.username ? `${DEFAULT_UA.replace(/\)$/, '')}; by /u/${creds.username})` : DEFAULT_UA;
}

// In-memory OAuth token cache (per process). Never persisted.
let _tokenCache = { token: '', expiresAt: 0 };
export function _resetRedditTokenCache() { _tokenCache = { token: '', expiresAt: 0 }; }

async function getOAuthToken(creds, ua, deps = {}) {
  const now = Date.now();
  if (_tokenCache.token && _tokenCache.expiresAt > now + 30_000) return _tokenCache.token;
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'password', username: creds.username, password: creds.password }).toString();
  const res = await guardedFetch(TOKEN_URL, {
    ...deps,
    method: 'POST',
    body,
    headers: {
      'Authorization': `Basic ${basic}`,
      'User-Agent': ua,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
  });
  if (!res.ok) throw new WebAccessError(`reddit auth failed (HTTP ${res.status})`);
  const json = await res.json();
  if (!json?.access_token) throw new WebAccessError('reddit auth returned no token');
  _tokenCache = { token: json.access_token, expiresAt: now + (Number(json.expires_in) || 3600) * 1000 };
  return _tokenCache.token;
}

/**
 * Fetch the parsed JSON for a Reddit URL. Returns { ok, data } or
 * { ok:false, status?, blocked?, error }. Never throws.
 */
export async function fetchRedditJson(url, { settings = {}, deps = {} } = {}) {
  const api = redditApiPath(url);
  if (!api) return { ok: false, error: 'not-a-reddit-listing' };
  const ua = redditUserAgent(settings);
  const creds = redditCredentials(settings);

  // Tier 1 — the sanctioned OAuth API (never touches the anti-bot wall).
  if (creds.complete) {
    try {
      const token = await getOAuthToken(creds, ua, deps);
      const res = await guardedFetch(`https://${OAUTH_HOST}${api.path}${api.search}`, {
        ...deps, headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': ua, 'Accept': 'application/json' },
      });
      const out = await normalizeJsonResponse(res, { authed: true, via: 'oauth' });
      if (out.ok) return out;
      return { ...out, authed: true };
    } catch (err) {
      if (err instanceof WebAccessError) return { ok: false, blocked: true, error: err.message, authed: true, via: 'oauth' };
      return { ok: false, error: err?.message || 'oauth fetch failed', authed: true, via: 'oauth' };
    }
  }

  const publicUrl = `https://${PUBLIC_HOST}${api.path}${api.search}`;

  // Tier 2 — fetch THROUGH the authenticated browser context when available: the
  // ward's real browser fingerprint + any logged-in Reddit session, the door
  // past Reddit's network-layer block on server-side fetches. Only trusted if it
  // comes back as real JSON; a challenge/HTML shell falls through to tier 3.
  if (typeof deps.contextFetch === 'function') {
    try {
      const cr = await deps.contextFetch(publicUrl, { headers: { 'User-Agent': ua, 'Accept': 'application/json' } });
      if (cr && cr.ok && (cr.contentType || '').includes('json')) {
        try { return { ok: true, data: JSON.parse(cr.text), via: 'browser-session' }; } catch { /* fall through */ }
      }
    } catch { /* fall through to the plain public fetch */ }
  }

  // Tier 3 — a plain public .json fetch (best-effort; often network-blocked
  // outside a residential IP).
  try {
    const res = await guardedFetch(publicUrl, { ...deps, headers: { 'User-Agent': ua, 'Accept': 'application/json' } });
    return await normalizeJsonResponse(res, { authed: false, via: 'public-json' });
  } catch (err) {
    if (err instanceof WebAccessError) return { ok: false, blocked: true, error: err.message, via: 'public-json' };
    if (err?.name === 'AbortError') return { ok: false, error: 'timeout' };
    return { ok: false, error: err?.message || 'fetch failed' };
  }
}

/** Normalise a websearch-style Response into { ok, data } / { ok:false, blocked }. */
async function normalizeJsonResponse(res, { authed, via }) {
  if (!res.ok) {
    const blocked = res.status === 403 || res.status === 429 || res.status === 401;
    return { ok: false, status: res.status, blocked, error: `http ${res.status}`, authed, via };
  }
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('json')) return { ok: false, blocked: true, error: 'non-json (blocked)', authed, via };
  return { ok: true, data: await res.json(), authed, via };
}

// ── Parsing (pure) ──────────────────────────────────────────────────────────

const up = (n) => (typeof n === 'number' ? n : 0);
function fmtScore(n) { const s = up(n); return s >= 1000 ? `${(s / 1000).toFixed(1)}k` : String(s); }
function ageOf(utc) {
  if (!utc) return '';
  const days = Math.floor((Date.now() / 1000 - utc) / 86400);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

function renderPost(p, { maxChars = 6000 } = {}) {
  const lines = [];
  lines.push(`# ${p.title || '(untitled)'}`);
  const meta = [`r/${(p.subreddit || '').trim()}`, p.author ? `by u/${p.author}` : '', `${fmtScore(p.score)} points`,
    `${up(p.num_comments)} comments`, ageOf(p.created_utc)].filter(Boolean);
  lines.push(meta.join(' · '));
  if (p.link_flair_text) lines.push(`[${p.link_flair_text}]`);
  const bodyText = (p.selftext || '').trim();
  if (bodyText) lines.push('\n' + bodyText.slice(0, maxChars));
  else if (p.url && !/reddit\.com/.test(p.url)) lines.push(`\nLink post → ${p.url}`);
  return lines.join('\n');
}

function renderComments(children, { max = 30, maxDepth = 4, maxChars = 4000 } = {}) {
  const out = [];
  let count = 0;
  const walk = (nodes, depth) => {
    if (!Array.isArray(nodes) || depth > maxDepth) return;
    for (const node of nodes) {
      if (count >= max) return;
      if (node?.kind !== 't1' || !node.data) continue;
      const d = node.data;
      const body = (d.body || '').trim();
      if (!body || d.body === '[deleted]' || d.body === '[removed]') { /* still descend */ }
      else {
        count++;
        const indent = '  '.repeat(depth);
        out.push(`${indent}• u/${d.author || '?'} (${fmtScore(d.score)}): ${body.slice(0, 600)}`);
      }
      const replies = d.replies && d.replies.data && d.replies.data.children;
      if (replies) walk(replies, depth + 1);
    }
  };
  walk(children, 0);
  return out.join('\n').slice(0, maxChars);
}

/**
 * Turn parsed Reddit JSON into clean readable text. Handles a comments page
 * ([post Listing, comments Listing]) and a listing page (subreddit/user/search
 * Listing of t3 posts). Returns '' when the shape isn't recognised.
 */
export function parseRedditReadable(data, { maxComments = 30 } = {}) {
  // Comments page: a two-element array [ postListing, commentListing ].
  if (Array.isArray(data) && data.length >= 2 && data[0]?.data?.children?.[0]?.data) {
    const post = data[0].data.children[0].data;
    const comments = data[1]?.data?.children || [];
    const body = renderPost(post);
    const cs = renderComments(comments, { max: maxComments });
    return cs ? `${body}\n\n— Top comments —\n${cs}` : body;
  }
  // Listing page: subreddit / user / search → a Listing of t3 posts.
  const children = data?.data?.children;
  if (Array.isArray(children)) {
    const posts = children.filter(c => c?.kind === 't3' && c.data).map(c => c.data);
    if (posts.length) {
      const items = posts.slice(0, 25).map((p, i) => {
        const meta = [`${fmtScore(p.score)} pts`, `${up(p.num_comments)} comments`, ageOf(p.created_utc),
          p.author ? `u/${p.author}` : ''].filter(Boolean).join(' · ');
        const snippet = (p.selftext || '').trim().replace(/\s+/g, ' ').slice(0, 160);
        return `${i + 1}. ${p.title || '(untitled)'}\n   ${meta}${snippet ? '\n   ' + snippet + '…' : ''}\n   → ${p.permalink ? 'https://www.reddit.com' + p.permalink : (p.url || '')}`;
      });
      const sub = posts[0]?.subreddit_name_prefixed || (posts[0]?.subreddit ? 'r/' + posts[0].subreddit : 'Reddit');
      return `${sub} — ${posts.length} posts\n\n${items.join('\n\n')}`;
    }
  }
  return '';
}

/**
 * Top-level: read a Reddit URL into clean text, or an honest failure line.
 * Returns { ok, text, hard }. `hard:true` means a definitive Reddit-side
 * outcome (blocked/auth) the caller should surface rather than fall through to
 * the (also-blocked) browser path.
 */
export async function readReddit(url, { settings = {}, deps = {} } = {}) {
  const r = await fetchRedditJson(url, { settings, deps });
  if (r.ok) {
    const raw = parseRedditReadable(r.data, { maxComments: 30 });
    // Comment/post bodies are user-authored — scrub injection before it reaches
    // the model, exactly like any other web content the Familiar reads.
    if (raw) return { ok: true, text: sanitizeExternal(raw, { source: 'reddit', context: 'reddit-reader' }) };
    return { ok: false, hard: false, text: 'I reached Reddit but couldn\'t make sense of that page\'s shape.' };
  }
  if (r.error === 'not-a-reddit-listing') return { ok: false, hard: false, text: '' };
  if (r.blocked) {
    const hint = r.authed
      ? ' My Reddit login was refused — the app credentials may be wrong or expired.'
      : ' Reddit blocked this request. If it keeps happening, setting up Reddit API credentials would give me a reliable way in.';
    return { ok: false, hard: true, text: `Reddit wouldn't let me read that (${r.error}).${hint}` };
  }
  if (r.error === 'timeout') return { ok: false, hard: true, text: 'Reddit took too long to answer, so I stopped waiting.' };
  return { ok: false, hard: true, text: `I couldn't read that Reddit page (${r.error || 'unknown error'}).` };
}
