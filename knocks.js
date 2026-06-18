// knocks.js — the Village knock list (V4.x)
//
// When someone unregistered knocks — DMs the Familiar or @-mentions
// them in a guild — they are ignored (DMs) or floored to Strangers
// (guilds). But the contact ATTEMPT is worth keeping: it carries the
// stable platform ID the ward would otherwise have to dig out of
// Discord's Developer Mode by hand. The knock list captures it so the
// Village editor can offer one-click registration.
//
// Privacy by design: a knock stores identity metadata ONLY — platform,
// stable id, handle, when, where, how often. NEVER message content.
// These are people who have not consented to an AI keeping notes on
// them; the stranger-data-minimization value (design doc V7) starts
// here. Nobody gains any access by knocking — binding a knock to a
// villager is always the ward's explicit act in the UI.
//
// Storage: tomes/.village-knocks.json, capped (oldest-seen evicted) so
// a spam wave can't grow the file unboundedly. Same withLock +
// tmp/rename discipline as every other state file.

import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsp } from 'fs';
import { withLock } from './thalamus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_KNOCKS_PATH = path.join(__dirname, 'tomes', '.village-knocks.json');

export const KNOCKS_CAP = 50;

async function readKnocksFile(filePath) {
  try {
    const raw = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    return Array.isArray(raw?.knocks) ? raw.knocks : [];
  } catch {
    return [];
  }
}

async function writeKnocksFile(filePath, knocks) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ knocks }, null, 2), 'utf8');
  await fsp.rename(tmp, filePath);
}

/**
 * Record a contact attempt from an unregistered person. Upserts by
 * (platform, id): repeat knocks bump count + lastSeenAt rather than
 * piling up entries. Never throws — capture is best-effort and must
 * not affect message handling.
 *
 * @param {{ platform: string, id: string, handle?: string,
 *           displayName?: string, context?: 'dm'|'guild',
 *           locationKey?: string }} knock
 */
export async function recordKnock(knock, { filePath = DEFAULT_KNOCKS_PATH } = {}) {
  const platform = typeof knock?.platform === 'string' ? knock.platform.trim().toLowerCase() : '';
  const id       = typeof knock?.id === 'string' ? knock.id.trim() : '';
  if (!platform || !id) return { ok: false, error: 'platform and id are required' };
  const nowIso = new Date().toISOString();
  try {
    return await withLock(`knocks:${filePath}`, async () => {
      const knocks = await readKnocksFile(filePath);
      const existing = knocks.find(k => k.platform === platform && k.id === id);
      if (existing) {
        existing.count = (existing.count ?? 1) + 1;
        existing.lastSeenAt = nowIso;
        if (typeof knock.handle === 'string' && knock.handle.trim()) existing.handle = knock.handle.trim();
        if (typeof knock.displayName === 'string' && knock.displayName.trim()) existing.displayName = knock.displayName.trim();
        if (knock.context === 'dm' || knock.context === 'guild') existing.context = knock.context;
        if (typeof knock.locationKey === 'string' && knock.locationKey) existing.locationKey = knock.locationKey;
      } else {
        knocks.push({
          platform, id,
          ...(typeof knock.handle === 'string' && knock.handle.trim() ? { handle: knock.handle.trim() } : {}),
          ...(typeof knock.displayName === 'string' && knock.displayName.trim() ? { displayName: knock.displayName.trim() } : {}),
          ...(knock.context === 'dm' || knock.context === 'guild' ? { context: knock.context } : {}),
          ...(typeof knock.locationKey === 'string' && knock.locationKey ? { locationKey: knock.locationKey } : {}),
          count: 1,
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
        });
      }
      // Cap: evict the least-recently-seen first.
      knocks.sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));
      const capped = knocks.slice(0, KNOCKS_CAP);
      await writeKnocksFile(filePath, capped);
      return { ok: true };
    });
  } catch (err) {
    console.error('[knocks] recordKnock failed:', err?.message ?? err);
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** List knocks, most recently seen first. Never throws. */
export async function listKnocks({ filePath = DEFAULT_KNOCKS_PATH } = {}) {
  try {
    const knocks = await readKnocksFile(filePath);
    return knocks.sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));
  } catch {
    return [];
  }
}

/**
 * Remove a knock — after the ward binds it to a villager, claims it as
 * their own ID, or dismisses it as noise.
 */
export async function dismissKnock({ platform, id }, { filePath = DEFAULT_KNOCKS_PATH } = {}) {
  const p = typeof platform === 'string' ? platform.trim().toLowerCase() : '';
  const i = typeof id === 'string' ? id.trim() : '';
  if (!p || !i) return { ok: false, error: 'platform and id are required' };
  try {
    return await withLock(`knocks:${filePath}`, async () => {
      const knocks = await readKnocksFile(filePath);
      const remaining = knocks.filter(k => !(k.platform === p && k.id === i));
      if (remaining.length === knocks.length) return { ok: false, error: 'knock not found' };
      await writeKnocksFile(filePath, remaining);
      return { ok: true };
    });
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// ── Location knock list ────────────────────────────────────────────
//
// Mirrors the person knock list for PLACES: when the Familiar responds
// in a guild channel that has no locations entry, the channel key +
// platform metadata is captured so the ward can register it in the
// Locations tab with one click instead of hunting guild/channel IDs.
//
// Same privacy discipline: metadata only, no message content. Capped
// and evicting-oldest so a flood of new channels can't grow the file.

const DEFAULT_LOCATION_KNOCKS_PATH = path.join(__dirname, 'tomes', '.village-location-knocks.json');

export const LOCATION_KNOCKS_CAP = 50;

/**
 * Record a contact from an unregistered location. Upserts by key:
 * repeat encounters bump count + lastSeenAt rather than piling up
 * entries. Never throws — capture is best-effort.
 *
 * @param {{ key: string, platform?: string, guildId?: string, channelId?: string }} knock
 */
export async function recordLocationKnock(knock, { filePath = DEFAULT_LOCATION_KNOCKS_PATH } = {}) {
  const key = typeof knock?.key === 'string' ? knock.key.trim() : '';
  if (!key) return { ok: false, error: 'key is required' };
  const nowIso = new Date().toISOString();
  try {
    return await withLock(`location-knocks:${filePath}`, async () => {
      const knocks = await readKnocksFile(filePath);
      const existing = knocks.find(k => k.key === key);
      if (existing) {
        existing.count = (existing.count ?? 1) + 1;
        existing.lastSeenAt = nowIso;
        if (typeof knock.platform === 'string' && knock.platform) existing.platform = knock.platform;
        if (typeof knock.guildId === 'string' && knock.guildId) existing.guildId = knock.guildId;
        if (typeof knock.channelId === 'string' && knock.channelId) existing.channelId = knock.channelId;
      } else {
        knocks.push({
          key,
          ...(typeof knock.platform === 'string' && knock.platform ? { platform: knock.platform } : {}),
          ...(typeof knock.guildId === 'string' && knock.guildId ? { guildId: knock.guildId } : {}),
          ...(typeof knock.channelId === 'string' && knock.channelId ? { channelId: knock.channelId } : {}),
          count: 1,
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
        });
      }
      knocks.sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));
      const capped = knocks.slice(0, LOCATION_KNOCKS_CAP);
      await writeKnocksFile(filePath, capped);
      return { ok: true };
    });
  } catch (err) {
    console.error('[knocks] recordLocationKnock failed:', err?.message ?? err);
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** List location knocks, most recently seen first. Never throws. */
export async function listLocationKnocks({ filePath = DEFAULT_LOCATION_KNOCKS_PATH } = {}) {
  try {
    const knocks = await readKnocksFile(filePath);
    return knocks.sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));
  } catch {
    return [];
  }
}

/**
 * Remove a location knock — after the ward registers the location or
 * dismisses it as noise.
 */
export async function dismissLocationKnock({ key }, { filePath = DEFAULT_LOCATION_KNOCKS_PATH } = {}) {
  const k = typeof key === 'string' ? key.trim() : '';
  if (!k) return { ok: false, error: 'key is required' };
  try {
    return await withLock(`location-knocks:${filePath}`, async () => {
      const knocks = await readKnocksFile(filePath);
      const remaining = knocks.filter(lk => lk.key !== k);
      if (remaining.length === knocks.length) return { ok: false, error: 'knock not found' };
      await writeKnocksFile(filePath, remaining);
      return { ok: true };
    });
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
