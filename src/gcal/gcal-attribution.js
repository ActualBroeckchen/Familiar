/**
 * Calendar attribution (Google multi-calendar support).
 *
 * Every synced calendar — an account's own, a calendar shared INTO it, a
 * separate iCal feed, or a CLI calendar — is an attributable *source*. The
 * ward or the Familiar can say whose it is: the ward themselves, a Villager,
 * a Phylactery node (a friend, family member, the sports club), or leave it
 * unassigned; or mark it `ignore` to skip syncing it. Each synced event then
 * carries that attribution so the Familiar reads whose event it is instead of
 * treating everyone's calendar as one undifferentiated blur.
 *
 * The map is ward state (settings.gcalCalendarAttribution, keyed by the
 * calendar's identity string). The discovered-calendars cache
 * (tomes/.gcal-calendars.json) is what the sync last saw, so the ward/Familiar
 * can see what's there to attribute. Pure helpers + never-throwing state I/O.
 */
import path from 'path';
import { promises as fsp } from 'fs';
import { fileURLToPath } from 'url';

import { REPO_ROOT } from '../../repo-root.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOMES_DIR = path.join(REPO_ROOT, 'tomes');
const CAL_CACHE = '.gcal-calendars.json';

export const ATTRIBUTION_KINDS = ['ward', 'villager', 'phylactery', 'unassigned', 'ignore'];

/**
 * Resolve a calendar's attribution from the ward-set map. Never throws.
 * Returns { kind, ref, label }. An unmapped PRIMARY calendar defaults to the
 * ward (it's their own account); any other unmapped calendar is `unassigned`
 * — still synced (per "sync everything"), labeled by its own name until the
 * ward/Familiar says whose it is.
 */
export function resolveAttribution(cal = {}, attributionMap = {}) {
  const id = cal?.id;
  const entry = (id && attributionMap && typeof attributionMap === 'object') ? attributionMap[id] : null;
  if (entry && typeof entry === 'object' && ATTRIBUTION_KINDS.includes(entry.kind)) {
    return {
      kind: entry.kind,
      ref: entry.ref ?? null,
      label: (entry.label && String(entry.label).trim()) || cal?.summary || id || '',
    };
  }
  if (cal?.primary) return { kind: 'ward', ref: null, label: cal?.summary || id || 'my calendar' };
  return { kind: 'unassigned', ref: null, label: cal?.summary || id || '' };
}

/** Is this calendar marked to skip? (attribution kind 'ignore'.) */
export function isIgnored(cal = {}, attributionMap = {}) {
  return resolveAttribution(cal, attributionMap).kind === 'ignore';
}

/** The ward's own calendar id, if any calendar is attributed 'ward' (or is the
 *  primary). That calendar adopts the pre-multi-calendar legacy rows. */
export function wardCalendarId(calendars = [], attributionMap = {}) {
  const mappedWard = calendars.find(c => resolveAttribution(c, attributionMap).kind === 'ward');
  if (mappedWard) return mappedWard.id;
  const primary = calendars.find(c => c?.primary);
  return primary?.id ?? null;
}

// ── discovered-calendars cache (never throws) ──────────────────────────
export async function readCalendarCache(tomesDir = DEFAULT_TOMES_DIR) {
  try { return JSON.parse(await fsp.readFile(path.join(tomesDir, CAL_CACHE), 'utf8')) || {}; }
  catch { return {}; }
}

export async function writeCalendarCache(calendars, tomesDir = DEFAULT_TOMES_DIR) {
  const file = path.join(tomesDir, CAL_CACHE);
  await fsp.mkdir(tomesDir, { recursive: true }).catch(() => {});
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify({ calendars: Array.isArray(calendars) ? calendars : [] }, null, 2), 'utf8');
  await fsp.rename(tmp, file);
  return { ok: true };
}

/**
 * Validate + normalize an attribution entry the Familiar/ward is setting for a
 * calendar. Returns { ok, entry } or { ok:false, error }. `ref` is required
 * for villager/phylactery (the villager id / graph-node id), forbidden-or-null
 * otherwise.
 */
export function normalizeAttributionEntry({ kind, ref, label } = {}) {
  const k = String(kind ?? '').trim().toLowerCase();
  if (!ATTRIBUTION_KINDS.includes(k)) {
    return { ok: false, error: `kind must be one of ${ATTRIBUTION_KINDS.join(', ')}` };
  }
  const entry = { kind: k };
  if (k === 'villager' || k === 'phylactery') {
    const r = String(ref ?? '').trim();
    if (!r) return { ok: false, error: `a ${k} attribution needs a ref (the ${k === 'villager' ? 'villager id' : 'graph-node id'})` };
    entry.ref = r;
  }
  const l = String(label ?? '').trim();
  if (l) entry.label = l.slice(0, 120);
  return { ok: true, entry };
}
