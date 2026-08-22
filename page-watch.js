/**
 * page-watch.js — the pure core of page watches (browser milestone §9 Horizon #1).
 *
 * "Tell me when the page changes." The Familiar (on my human's behalf) registers
 * a URL; a slow background loop re-reads it on a schedule and, ONLY when the
 * content actually changed, asks the LLM whether the change is worth surfacing —
 * then drops a gentle outbox banner. The discipline is gcal-ingest's: the diff is
 * pure code (a normalized hash compare), so an unchanged page costs a cheap fetch
 * and zero tokens; the LLM is consulted only on a real change (ride existing
 * requests, gate in code).
 *
 * This module is deliberately pure/injectable — the store, the hashing, the
 * due-selection and the one-tick reconcile — so it's fully unit-testable with no
 * network and no LLM. The loop singleton (page-watch-loop.js) and the real
 * fetch / LLM / outbox wiring (server.js) sit on top.
 *
 * Storage: tomes/.page-watches.json (git-ignored, same posture as the outbox and
 * the ponder budget). Watch ids are readable slugs.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { slugifyLabel } from './slug-ids.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOMES_DIR = path.join(__dirname, 'tomes');
const FILENAME = '.page-watches.json';

export const DEFAULT_WATCH_INTERVAL_MS = 6 * 60 * 60 * 1000;   // check a watched page every ~6h by default
const MIN_WATCH_INTERVAL_MS = 15 * 60 * 1000;                   // floor: never hammer a site
const SNAPSHOT_CAP = 2000;                                      // chars of normalized text kept for the LLM diff
const MAX_FETCH_FAILS = 5;                                      // give up on a URL that keeps failing, and say so

function file(tomesDir) { return path.join(tomesDir, FILENAME); }

export function readWatches(tomesDir = DEFAULT_TOMES_DIR) {
  try {
    const data = JSON.parse(fs.readFileSync(file(tomesDir), 'utf8'));
    return Array.isArray(data?.watches) ? data.watches : [];
  } catch { return []; }
}

export function writeWatches(watches, tomesDir = DEFAULT_TOMES_DIR) {
  try {
    fs.mkdirSync(tomesDir, { recursive: true });
    const tmp = file(tomesDir) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ watches }, null, 2), 'utf8');
    fs.renameSync(tmp, file(tomesDir));
    return true;
  } catch { return false; }
}

/** Normalize a URL a little so trivial variants dedup (trailing slash, #frag). */
function normalizeUrl(url) {
  const raw = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  return raw.replace(/#.*$/, '').replace(/\/+$/, '');
}

function clampInterval(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return DEFAULT_WATCH_INTERVAL_MS;
  return Math.max(MIN_WATCH_INTERVAL_MS, n);
}

/**
 * Register (or update) a watch. Deduped on the normalized URL — asking to watch
 * a page already watched updates its label/note rather than adding a twin.
 * Returns { ok, watch } or { ok:false, error }.
 */
export function addWatch({ url, label, note, createdBy = 'familiar', intervalMs } = {}, { tomesDir = DEFAULT_TOMES_DIR, now = Date.now } = {}) {
  const u = normalizeUrl(url);
  if (!u) return { ok: false, error: 'that is not a web URL I can watch' };
  const watches = readWatches(tomesDir);
  const existing = watches.find(w => w.url === u);
  const cleanLabel = (typeof label === 'string' && label.trim()) ? label.trim().slice(0, 120) : null;
  const cleanNote  = (typeof note === 'string' && note.trim()) ? note.trim().slice(0, 400) : null;
  if (existing) {
    if (cleanLabel) existing.label = cleanLabel;
    if (cleanNote)  existing.note = cleanNote;
    if (intervalMs) existing.intervalMs = clampInterval(intervalMs);
    existing.active = true;
    existing.deactivatedReason = null;
    writeWatches(watches, tomesDir);
    return { ok: true, watch: existing, updated: true };
  }
  const watch = {
    id: mintId(cleanLabel || u, watches),
    url: u,
    label: cleanLabel || u,
    note: cleanNote,
    createdBy,
    addedAt: new Date(now()).toISOString(),
    intervalMs: clampInterval(intervalMs),
    lastCheckedAt: 0,
    lastHash: null,
    lastSnapshot: null,
    lastChangedAt: null,
    fails: 0,
    active: true,
    deactivatedReason: null,
  };
  watches.push(watch);
  writeWatches(watches, tomesDir);
  return { ok: true, watch };
}

function mintId(label, watches) {
  const base = slugifyLabel(String(label).replace(/^https?:\/\//, '').slice(0, 40)) || 'watch';
  const taken = new Set(watches.map(w => w.id));
  let id = `${base}-${rand(2)}`;
  while (taken.has(id)) id = `${base}-${rand(3)}`;
  return id;
}
function rand(n) { return crypto.randomBytes(8).toString('base64url').replace(/[^a-z0-9]/gi, '').slice(0, n).toLowerCase() || 'x'; }

export function listWatches({ tomesDir = DEFAULT_TOMES_DIR, includeInactive = true } = {}) {
  const watches = readWatches(tomesDir);
  return includeInactive ? watches : watches.filter(w => w.active);
}

export function removeWatch(id, { tomesDir = DEFAULT_TOMES_DIR } = {}) {
  const watches = readWatches(tomesDir);
  const before = watches.length;
  const kept = watches.filter(w => w.id !== id && w.url !== id);   // accept id OR url
  if (kept.length === before) return { ok: false, error: 'no watch with that id' };
  writeWatches(kept, tomesDir);
  return { ok: true, removed: before - kept.length };
}

/** Normalize page text for change detection — collapse whitespace, drop the
 *  read_webpage front-matter block. Conservative on purpose: over-normalizing
 *  (stripping numbers/dates) risks MISSING a real change, which is worse here
 *  than an occasional noisy one (the LLM gate catches noise). */
export function normalizeForHash(text) {
  return String(text ?? '')
    .replace(/^---[\s\S]*?---\n/, '')     // read_webpage meta header, if present
    .replace(/\s+/g, ' ')
    .trim();
}

export function hashText(text) {
  return crypto.createHash('sha256').update(normalizeForHash(text)).digest('hex');
}

/** Watches whose interval has elapsed and that are still active. */
export function dueWatches(watches, now, defaultIntervalMs = DEFAULT_WATCH_INTERVAL_MS) {
  return (Array.isArray(watches) ? watches : []).filter(w =>
    w && w.active && (now - (w.lastCheckedAt || 0)) >= clampInterval(w.intervalMs || defaultIntervalMs));
}

/**
 * Reconcile one tick. Pure but for the injected I/O:
 *   fetchReadable(url) => { ok, text } | { ok:false, error }
 *   decideChange({ url, label, note, oldSnapshot, newText }) =>
 *     { surface:boolean, summary:string }   (the LLM step — called ONLY on a real change)
 *   enqueue({ id, url, label, summary, hash }) => Promise   (drop the outbox banner)
 *
 * Returns { checked, changed, surfaced, failed }. Never throws. Persists the
 * updated watches (hashes, snapshots, fail counts) at the end.
 */
export async function runOnePageWatchTick({
  tomesDir = DEFAULT_TOMES_DIR,
  now = Date.now,
  fetchReadable,
  decideChange,
  enqueue,
  defaultIntervalMs = DEFAULT_WATCH_INTERVAL_MS,
  maxPerTick = 3,
  log = () => {},
} = {}) {
  if (typeof fetchReadable !== 'function') throw new Error('fetchReadable is required');
  const watches = readWatches(tomesDir);
  const due = dueWatches(watches, now(), defaultIntervalMs).slice(0, maxPerTick);
  let checked = 0, changed = 0, surfaced = 0, failed = 0;

  for (const w of due) {
    checked++;
    let res;
    try { res = await fetchReadable(w.url); } catch (err) { res = { ok: false, error: err?.message ?? String(err) }; }
    w.lastCheckedAt = now();

    if (!res || !res.ok) {
      failed++;
      w.fails = (w.fails || 0) + 1;
      if (w.fails >= MAX_FETCH_FAILS) { w.active = false; w.deactivatedReason = `couldn't read the page ${w.fails}× (${res?.error ?? 'unknown'})`; }
      log(`page-watch ${w.id}: fetch failed (${res?.error ?? 'unknown'})${w.active ? '' : ' — deactivated'}`);
      continue;
    }
    w.fails = 0;
    const newHash = hashText(res.text);
    const newSnapshot = normalizeForHash(res.text).slice(0, SNAPSHOT_CAP);

    if (w.lastHash == null) {                        // first observation → baseline, never surfaced
      w.lastHash = newHash; w.lastSnapshot = newSnapshot;
      continue;
    }
    if (newHash === w.lastHash) continue;            // no change → no LLM, no banner

    changed++;
    const oldSnapshot = w.lastSnapshot;
    w.lastHash = newHash; w.lastSnapshot = newSnapshot; w.lastChangedAt = new Date(now()).toISOString();

    let decision = { surface: true, summary: '' };   // no decider → surface plainly (the loop always injects one)
    if (typeof decideChange === 'function') {
      try { decision = await decideChange({ url: w.url, label: w.label, note: w.note, oldSnapshot, newText: newSnapshot }) || decision; }
      catch (err) { log(`page-watch ${w.id}: decide failed (${err?.message ?? err}) — not surfacing`); decision = { surface: false }; }
    }
    if (decision.surface && typeof enqueue === 'function') {
      try {
        await enqueue({ id: w.id, url: w.url, label: w.label, summary: String(decision.summary || '').trim(), hash: newHash });
        surfaced++;
      } catch (err) { log(`page-watch ${w.id}: enqueue failed (${err?.message ?? err})`); }
    }
  }

  writeWatches(watches, tomesDir);
  return { checked, changed, surfaced, failed };
}

/** The LLM prompt for the on-change judgment. {{char}} is resolved by the caller's
 *  macro pass. Leak-free: it sees only the watched page's own before/after text. */
export function buildPageWatchPrompt({ url, label, note, oldSnapshot, newText }) {
  return `I've been keeping an eye on a web page for {{user}}, and it just changed.

The page: ${label}${label !== url ? ` (${url})` : ''}${note ? `\nWhy I'm watching it: ${note}` : ''}

What it showed BEFORE:
${(oldSnapshot || '(nothing captured)').slice(0, 1500)}

What it shows NOW:
${(newText || '').slice(0, 1500)}

Is this change actually worth a nudge to {{user}} right now, or is it just noise (ads, a timestamp, a view counter, reshuffled boilerplate)? I answer with JSON only:
{"surface": true/false, "summary": "one short line, in my own voice, saying what changed — only if surface is true"}
If it's noise, surface is false and I don't bother {{user}}.`;
}

export function parsePageWatchDecision(raw) {
  try {
    const m = String(raw).match(/\{[\s\S]*\}/);
    const o = m ? JSON.parse(m[0]) : {};
    return { surface: o.surface === true, summary: typeof o.summary === 'string' ? o.summary.trim() : '' };
  } catch { return { surface: false, summary: '' }; }
}
