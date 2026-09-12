/**
 * browser-cdp-arm.js — the per-task grant that lets the Familiar drive the
 * ward's OWN logged-in Chrome over CDP (docs/browser-cdp-mode-build-spec.md).
 *
 * This is the highest-stakes surface in the browser milestone: the blast radius
 * is the ward's authenticated life. Two independent human gates make it inert by
 * default (§3): (1) the ward launched Chrome with `--remote-debugging-port=9222`
 * themselves — outside the app entirely — and (2) the ward armed a scoped,
 * time-boxed grant in the UI immediately before the task. The MODEL has no tool
 * to arm; arming is a ward-only HTTP action. This module owns gate (2).
 *
 * In-memory ONLY, never persisted: a time-boxed grant must not silently survive
 * a restart. If the process restarts, the arm is gone (fail-safe).
 */

export const DEFAULT_ARM_MINUTES = 15;
export const ARM_CEILING_MINUTES = 60;
/** Always loopback — never a remote CDP endpoint (that would be its own attack surface). */
export const CDP_ENDPOINT = 'http://127.0.0.1:9222';

export function cdpHardDisabled() { return process.env.PROTO_FAMILIAR_BROWSER_CDP_DISABLED === '1'; }

let _arm = null;           // { domain, armedAt, expiresAt } | null
let _expiredNote = false;  // set once when an arm clears due to TIME (not a manual disarm)

/** A private/loopback/metadata host literal — never a valid arm target or request host. */
export function isPrivateOrLoopbackHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === 'metadata.google.internal' || h === '169.254.169.254') return true;
  if (h === '0.0.0.0' || h === '::1' || h === '::') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;    // fc00::/7 unique-local IPv6
  if (/^fe80:/.test(h)) return true;                // link-local IPv6
  return false;
}

/**
 * Normalise a ward-supplied domain to a bare public hostname (strip scheme,
 * path, port, leading www). Returns null for anything that isn't a plausible
 * public registrable hostname — IPs and private/loopback literals are refused,
 * because the armed domain becomes the request allowlist and must be a real host.
 */
export function normalizeArmDomain(input) {
  let d = String(input ?? '').trim().toLowerCase();
  if (!d) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(d)) { try { d = new URL(d).hostname; } catch { return null; } }
  d = d.replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/^www\./, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) return null;
  if (!/\.[a-z]{2,}$/.test(d)) return null;          // needs a real TLD
  if (isPrivateOrLoopbackHost(d)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(d)) return null;   // bare IPv4 is not a domain
  return d;
}

/** Create the arm. Ward-initiated only (the endpoint is the ward's action). */
export function armCdp({ domain, minutes } = {}) {
  if (cdpHardDisabled()) return { ok: false, error: 'CDP mode is turned off (PROTO_FAMILIAR_BROWSER_CDP_DISABLED=1).' };
  const d = normalizeArmDomain(domain);
  if (!d) return { ok: false, error: 'That isn\'t a valid public domain to arm (give a bare hostname like github.com).' };
  let m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) m = DEFAULT_ARM_MINUTES;
  m = Math.min(Math.round(m), ARM_CEILING_MINUTES);
  const now = Date.now();
  _arm = { domain: d, armedAt: now, expiresAt: now + m * 60_000 };
  _expiredNote = false;
  return { ok: true, domain: d, minutes: m, expiresAt: _arm.expiresAt };
}

/** Drop the arm deliberately (ward button, off-domain refusal, shutdown). */
export function disarmCdp(reason = 'ward') {
  const wasArmed = !!_arm;
  _arm = null;
  _expiredNote = false;          // a deliberate disarm is not the "lapsed" note
  return { ok: true, wasArmed, reason };
}

/** True iff an arm is live right now. Clears + flags a note if it just expired. */
export function cdpArmActive() {
  if (cdpHardDisabled() || !_arm) return false;
  if (Date.now() >= _arm.expiresAt) { _arm = null; _expiredNote = true; return false; }
  return true;
}

/** The current arm for the UI/status/audit ({armed:false} when none). */
export function cdpArmState() {
  if (!cdpArmActive()) return { armed: false };
  return { armed: true, domain: _arm.domain, expiresAt: _arm.expiresAt, remainingMs: _arm.expiresAt - Date.now() };
}

/**
 * Does a request URL's host fall inside the armed domain (host or subdomain)?
 * This is the whole network gate under CDP (§2): the armed domain IS the
 * allowlist. Off-domain — including every private/loopback literal, which can
 * never match a public armed domain — is refused. Fail-closed: no arm → false.
 */
export function armAllowsHost(host) {
  if (!cdpArmActive()) return false;
  const h = String(host ?? '').toLowerCase().replace(/^www\./, '');
  if (!h || isPrivateOrLoopbackHost(h)) return false;
  return h === _arm.domain || h.endsWith('.' + _arm.domain);
}

/** Consume the one-shot "the arm lapsed" flag (RULE B: the Familiar is told). */
export function consumeCdpExpiryNote() { const n = _expiredNote; _expiredNote = false; return n; }

/** Test-only reset. */
export function _resetCdpArm() { _arm = null; _expiredNote = false; }
