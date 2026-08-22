/**
 * browser-grants.js — the autonomy-grants file + credentials vault (spec §5.9).
 *
 * A ward may hand the Familiar the abilities the code gates 3–4 otherwise refuse:
 * filling logins, completing payments, attempting CAPTCHAs, submitting without a
 * fresh confirmation. The switch for this DELIBERATELY has no UI. It lives in a
 * file the ward must create and edit by hand:
 *
 *   browser/autonomy-grants.json  (git-ignored; NEVER created/written/repaired by
 *   the app — read-only from our side, re-read per browse call)
 *
 * The `acknowledgment` string must match EXACTLY, byte-for-byte, or every grant
 * reads as false. Typing that sentence by hand IS the consent ceremony — no
 * checkbox can carry it. Absent file, malformed JSON, or wrong sentence → all
 * grants off, the shipped state.
 *
 * Grants lift gates; they never route secrets through the model. Passwords come
 * from a second hand-edited file, browser/credentials-vault.json (site →
 * user/secret), git-ignored AND on the own-files denylist so no Familiar tool can
 * read it. The Familiar names a vault entry; CODE reads it and types it. The
 * model never sees the value — the exact-values rule applied to secrets.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GRANTS_FILE = path.join(__dirname, 'browser', 'autonomy-grants.json');
const VAULT_FILE  = path.join(__dirname, 'browser', 'credentials-vault.json');

// The consent sentence. Must match the file byte-for-byte (after trim) or every
// grant is false. Documented ONLY in the spec/security notes — a ward finds it
// by reading, which is the point.
export const ACK_SENTENCE =
  'I understand my Familiar will act with my authority on the web, including money and accounts, and I accept what follows from that.';

const NO_GRANTS = Object.freeze({ credentials: false, payments: false, captchas: false, autoSubmit: false, active: [] });

/**
 * Read the current grants. Re-read every call (the file can change under us and
 * a stale cache must never keep a revoked grant alive). ALWAYS returns the full
 * shape; anything wrong → NO_GRANTS. `active` lists the granted names for loud
 * visibility.
 */
export function readGrants() {
  let raw;
  try { raw = fs.readFileSync(GRANTS_FILE, 'utf8'); } catch { return NO_GRANTS; }
  let obj;
  try { obj = JSON.parse(raw); } catch { return NO_GRANTS; }
  if (!obj || typeof obj !== 'object') return NO_GRANTS;
  if (String(obj.acknowledgment ?? '').trim() !== ACK_SENTENCE) return NO_GRANTS;
  const g = {
    credentials: obj.credentials === true,
    payments:    obj.payments === true,
    captchas:    obj.captchas === true,
    autoSubmit:  obj.autoSubmit === true,
  };
  g.active = Object.keys(g).filter(k => g[k] === true);
  return g;
}

/** Whether ANY grant is active (for the loud boot/launch log + status). */
export function hasAnyGrant(g = readGrants()) { return (g.active?.length ?? 0) > 0; }

/**
 * Read ONE vault entry by name → { user, secret } or null. CODE-ONLY: this
 * result must never reach a prompt, tool result, session log, or audit entry —
 * only the driver's fill uses `secret`, and only the entry NAME is ever spoken.
 * Requires the `credentials` grant; without it the vault is inert.
 */
export function readVaultEntry(name) {
  const g = readGrants();
  if (!g.credentials && !g.payments) return null; // the driver enforces field-kind vs grant

  const key = String(name ?? '').trim();
  if (!key) return null;
  let raw;
  try { raw = fs.readFileSync(VAULT_FILE, 'utf8'); } catch { return null; }
  let obj;
  try { obj = JSON.parse(raw); } catch { return null; }
  const entry = obj?.[key];
  if (!entry || typeof entry !== 'object') return null;
  const secret = entry.secret ?? entry.password;
  if (typeof secret !== 'string' || !secret) return null;
  return { user: typeof entry.user === 'string' ? entry.user : '', secret };
}
