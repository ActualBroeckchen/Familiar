/**
 * The reference-voice catalogue, as the picker sees it (voice spec §6.5).
 *
 * `voice-clips.json` (built by `scripts/build-voice-catalogue.mjs`) holds 700+
 * clips with verified checksums. This turns that into something a person can
 * actually get through: filter, search, sort, and a measured pitch that
 * arrives lazily as clips are previewed.
 *
 * ── Why measurement is lazy ─────────────────────────────────────────────
 * Measuring pitch needs the audio. Measuring all of them eagerly is ~350 MB
 * and a long wait before anyone can listen to anything — the exact opposite of
 * what a picker is for. So a clip is measured the first time it is previewed,
 * the result is cached forever, and sorting by pitch gets better as my human
 * browses rather than demanding a download up front.
 *
 * ── Previews stream from upstream; installs do not ──────────────────────
 * The browser plays the pinned URL directly — instant, and nothing is stored
 * for a clip that was merely auditioned. Only the clip actually CHOSEN is
 * fetched, checksum-verified and kept. A preview that sounds right is
 * guaranteed to be the file that installs, because it is the same URL and the
 * install verifies the same hash.
 */

import { promises as fs, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { measureVoiceClip, describeMeasurement } from './voice-audio-features.js';
import { sourceByKey, SHORTLIST, shortlistKeys, DEFAULT_VOICE, preferEnhanced } from './voice-catalogue.js';

const CACHE_FILE = path.join('tomes', '.voice-clip-features.json');

let catalogue = null;

/** Read the generated catalogue once. Absence is a clean empty list, not a crash. */
export function loadCatalogue(rootDir = process.cwd()) {
  if (catalogue) return catalogue;
  try {
    catalogue = JSON.parse(readFileSync(path.join(rootDir, 'voice-clips.json'), 'utf8'));
  } catch {
    catalogue = { clips: [], counts: { clips: 0, voices: 0 }, licences: {} };
  }
  return catalogue;
}

/** Stable key for a clip: a voice can exist as both original and enhanced. */
export const clipKey = (c) => `${c.source}/${c.id}/${c.variant}`;

async function readCache(rootDir) {
  try { return JSON.parse(await fs.readFile(path.join(rootDir, CACHE_FILE), 'utf8')); }
  catch { return {}; }
}

async function writeCache(rootDir, cache) {
  const full = path.join(rootDir, CACHE_FILE);
  try {
    await fs.mkdir(path.dirname(full), { recursive: true });
    const tmp = `${full}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, full);
    return true;
  } catch {
    // A cache we cannot write costs a re-measure later, nothing more. It must
    // never fail the browse it was collected during.
    return false;
  }
}

/**
 * Browse the catalogue.
 *
 * `sort: 'deeper'` and `'higher'` are the useful ones — my human is choosing a
 * voice, and "deeper vs higher" is the axis measurement genuinely supports.
 * Unmeasured clips sort AFTER measured ones either way, so a pitch sort never
 * buries the clips that actually have a pitch behind hundreds that do not.
 */
export function listClips({
  rootDir = process.cwd(),
  features = {},
  source = null,
  variant = 'enhanced',
  shortlist = false,
  q = '',
  sort = 'source',
  limit = 60,
  offset = 0,
} = {}) {
  const all = loadCatalogue(rootDir).clips ?? [];
  const needle = String(q ?? '').trim().toLowerCase();

  const short = shortlistKeys();
  // 'best' = one row per voice, the enhanced cut where upstream made one and
  // the original where they did not (8 of 377 — LibriVox and alba-mackenna).
  //
  // A plain `variant: 'enhanced'` filter HIDES those eight entirely, and
  // `'original'` offers everyone the un-enhanced recording, which is audibly
  // muffled and was the exact complaint that started the enhanced
  // investigation. Neither is what someone browsing for a voice wants, so
  // there is a third option and it is the one the picker uses.
  const bestKeys = variant === 'best'
    ? new Set(all.map((c) => preferEnhanced(clipKey(c), new Set(all.map(clipKey)))))
    : null;

  let rows = all.filter((c) => {
    if (bestKeys) { if (!bestKeys.has(clipKey(c))) return false; }
    else if (variant && variant !== 'any' && c.variant !== variant) return false;
    if (shortlist && !short.has(clipKey(c))) return false;
    if (source && c.source !== source) return false;
    if (needle && !`${c.id} ${c.source}`.toLowerCase().includes(needle)) return false;
    return true;
  }).map((c) => {
    const f = features[clipKey(c)] ?? null;
    return {
      ...c,
      key: clipKey(c),
      measured: Boolean(f?.ok),
      medianF0Hz: f?.ok ? f.medianF0Hz : null,
      durationSec: f?.ok ? f.durationSec : null,
      voicedFraction: f?.ok ? f.voicedFraction : null,
      description: f?.ok ? describeMeasurement(f) : null,
      licence: sourceByKey(c.source)?.license?.label ?? null,
      suggested: short.has(clipKey(c)),
      isDefault: clipKey(c) === DEFAULT_VOICE.key,
      note: SHORTLIST.find((v) => v.key === clipKey(c))?.note ?? null,
    };
  });

  const byPitch = (dir) => (a, b) => {
    const am = a.medianF0Hz, bm = b.medianF0Hz;
    if (am == null && bm == null) return a.id.localeCompare(b.id);
    if (am == null) return 1;   // unmeasured last, never buried above measured
    if (bm == null) return -1;
    return dir === 'deeper' ? am - bm : bm - am;
  };

  if (shortlist && sort === 'source') {
    // The shortlist has a deliberate order: deepest to highest, so "I want
    // something lower" is a direction to scroll rather than a search.
    const order = new Map(SHORTLIST.map((v, i) => [v.key, i]));
    rows.sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99));
  } else if (sort === 'deeper' || sort === 'higher') rows.sort(byPitch(sort));
  else if (sort === 'id') rows.sort((a, b) => a.id.localeCompare(b.id));
  else rows.sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));

  const total = rows.length;
  const measured = rows.filter((r) => r.measured).length;
  return {
    total,
    measured,
    offset,
    limit,
    rows: rows.slice(offset, offset + limit),
  };
}

/**
 * Measure one clip: fetch, verify, measure, cache.
 *
 * The checksum is verified even though this is "only" a preview measurement.
 * The catalogue's whole claim is that the hash is what will be installed; if
 * the bytes we measured were not those bytes, the pitch shown next to a clip
 * would describe something other than the clip a ward would get.
 */
export async function measureClip({ rootDir = process.cwd(), key, fetchImpl = fetch } = {}) {
  const clip = (loadCatalogue(rootDir).clips ?? []).find((c) => clipKey(c) === key);
  if (!clip) return { ok: false, reason: 'unknown-clip' };

  const cache = await readCache(rootDir);
  if (cache[key]?.ok) {
    // The description is derived, not stored — so it has to be derived here
    // too. Returning a different SHAPE on the cached path than the fresh one
    // is the kind of difference that only shows up once something has been
    // measured before, which is to say: in front of my human, not in a test.
    return { ok: true, cached: true, ...cache[key], description: describeMeasurement(cache[key]) };
  }

  let buf;
  try {
    const res = await fetchImpl(clip.url, { redirect: 'follow' });
    if (!res.ok) return { ok: false, reason: 'http', detail: `HTTP ${res.status}` };
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return { ok: false, reason: 'network', detail: String(err?.message ?? err) };
  }

  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== clip.sha256) {
    return { ok: false, reason: 'checksum', detail: 'what downloaded is not what the catalogue expects' };
  }

  const features = measureVoiceClip(buf);
  if (!features.ok) return { ok: false, reason: features.reason ?? 'unreadable' };

  cache[key] = { ...features, measuredAt: new Date().toISOString().slice(0, 10) };
  await writeCache(rootDir, cache);
  return { ok: true, cached: false, ...features, description: describeMeasurement(features) };
}

/** Everything measured so far, for the list view to merge in. */
export async function cachedFeatures(rootDir = process.cwd()) {
  return readCache(rootDir);
}

/** Counts for the picker header, so a ward knows how much of the pool is measured. */
export async function catalogueSummary(rootDir = process.cwd()) {
  const cat = loadCatalogue(rootDir);
  const cache = await readCache(rootDir);
  const sources = [...new Set((cat.clips ?? []).map((c) => c.source))];
  return {
    voices: cat.counts?.voices ?? 0,
    clips: cat.counts?.clips ?? 0,
    measured: Object.values(cache).filter((f) => f?.ok).length,
    sources: sources.map((k) => ({
      key: k,
      label: sourceByKey(k)?.label ?? k,
      licence: sourceByKey(k)?.license?.label ?? null,
      voices: new Set((cat.clips ?? []).filter((c) => c.source === k).map((c) => c.id)).size,
    })),
    builtAt: cat.builtAt ?? null,
  };
}

/** Reset the module-level catalogue cache. Tests need this; nothing else should. */
export function _resetCatalogue() { catalogue = null; }
