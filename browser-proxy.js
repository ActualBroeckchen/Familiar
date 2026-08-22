/**
 * browser-proxy.js — the SSRF enforcement floor for the browser (spec §5.1).
 *
 * WHY A PROXY AND NOT `context.route`. Chromium does its OWN DNS resolution, so
 * the two obvious designs both fail:
 *   - A pre-`goto` host check (`assertPublicUrl`) races a DNS rebind: our
 *     `dns.lookup` sees a public IP, the browser's own resolver sees a private
 *     one on the actual connection. Classic TOCTOU.
 *   - Playwright's `context.route` handler only exposes `request.url()`, never
 *     the resolved socket IP, so it structurally cannot "block by resolved IP".
 *
 * So Chromium is launched through THIS proxy (`launch({ proxy })`). The proxy is
 * the single point that resolves a host, checks the resolved address with the
 * existing `isBlockedIp` (reused verbatim from websearch.js — no second copy of
 * the range logic), and — crucially — CONNECTS TO THE EXACT IP IT CHECKED, so
 * the browser and the guard can never disagree. Every request the browser makes
 * (top-level navigation and every subresource) goes through it, closing
 * main-nav, subresources, and rebinding in one place.
 *
 * Pure-ish and testable: an injectable `lookupFn` lets a unit test force a host
 * to resolve to a private address and assert the CONNECT is refused, with no
 * real network and no live browser.
 */

import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';

import { isBlockedIp } from './websearch.js';

const defaultLookup = (host) => dns.lookup(host, { all: true });

/**
 * Resolve a host to a single allowed IP, or throw. Returns the first public
 * address; throws if the host resolves to any blocked range (fail-closed: a
 * host that resolves to BOTH a public and a private IP is refused, since a
 * rebind could pick the private one).
 */
async function resolveAllowed(host, lookupFn) {
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error(`blocked address ${host}`);
    return host;
  }
  let looked;
  try { looked = await lookupFn(host); }
  catch { throw new Error(`cannot resolve ${host}`); }
  const addrs = (Array.isArray(looked) ? looked : [looked]).map(a => a.address).filter(Boolean);
  if (addrs.length === 0) throw new Error(`cannot resolve ${host}`);
  for (const a of addrs) if (isBlockedIp(a)) throw new Error(`blocked address ${a} for ${host}`);
  return addrs[0];
}

/**
 * Create a guarded forward proxy. Returns { server, port, close, blocked } where
 * `blocked` is a live count of refused connections (surfaced in browser status
 * and useful in tests). Call `listen()` (awaitable) before use.
 */
export function createGuardedProxy({ lookupFn = defaultLookup, onBlock = null } = {}) {
  let blocked = 0;
  const note = (host, reason) => { blocked++; try { onBlock?.(host, reason); } catch {} };

  const server = http.createServer((req, res) => {
    // Plain-HTTP forward request (absolute-URI GET/POST). Rare (most sites are
    // https → CONNECT below), but check + forward it the same way.
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(400).end('bad request'); return; }
    if (u.protocol !== 'http:') { res.writeHead(403).end('scheme blocked'); return; }
    resolveAllowed(u.hostname, lookupFn).then((ip) => {
      const opts = {
        host: ip, port: Number(u.port) || 80, method: req.method, path: u.pathname + u.search,
        headers: { ...req.headers, host: u.host },
      };
      const upstream = http.request(opts, (up) => { res.writeHead(up.statusCode || 502, up.headers); up.pipe(res); });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('upstream error'); });
      req.pipe(upstream);
    }).catch((err) => { note(u.hostname, err.message); res.writeHead(403).end('blocked'); });
  });

  // HTTPS (and any tunnelled protocol): CONNECT host:port. This is the main path.
  server.on('connect', (req, clientSocket, head) => {
    const [host, portStr] = String(req.url || '').split(':');
    const port = Number(portStr) || 443;
    resolveAllowed(host, lookupFn).then((ip) => {
      // Connect to the EXACT IP we checked (pins against rebinding), then blind-
      // tunnel the client's TLS bytes through — we never see plaintext.
      const upstream = net.connect(port, ip, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    }).catch((err) => {
      note(host, err.message);
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
    });
  });

  const listen = () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const close = () => new Promise((resolve) => server.close(() => resolve()));

  return { server, listen, close, stats: () => ({ blocked }) };
}
