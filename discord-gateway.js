// discord-gateway.js — bidirectional Discord presence (Village V4)
//
// I inhabit Discord through this adapter: DMs with my human and with
// registered villagers, and guild channels when I'm @-mentioned. Each
// location is its own session flowing through the same enrich() spine
// as the web chat — with the V3 knowledge gate deciding what context
// I receive in each room before anything is fetched.
//
// Design contract: docs/village-support-design.md "Discord gateway
// adapter". Key properties:
//   - Fails independently: nothing here can take down the web chat
//     path. Every handler is wrapped; a dead gateway logs and retries.
//   - Hard off-switch: PROTO_FAMILIAR_DISCORD_DISABLED=1 (env), plus
//     the discordEnabled settings toggle the ward controls in the UI.
//   - DM policy: my human (discordWardUserId) → ward-private full
//     context. Registered villagers → gated context per their
//     categories. Unregistered users → silently ignored.
//   - Guild policy: I reply only when @-mentioned (or directly
//     replied-to). Audience = location ceiling ∩ accumulated
//     participants — fail-closed, an unassigned room is Strangers.
//   - No tools on Discord turns (V4): the gate bounds what I know;
//     no tool surface bounds what a prompt-injection could do.
//   - Memorization: when a session idles past SESSION_IDLE_ROTATE_MS
//     and a fresh session is created, the old session is enqueued for
//     autonomous memorization (Pillar C). The stored audienceTag on the
//     session log gates what context each fact carries into Phylactery.
//
// Transport: native WebSocket (Node ≥ 22; stable global). If the
// runtime lacks it, the adapter logs loudly and stays down — degraded,
// never crashing.

import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsp } from 'fs';
import { randomUUID } from 'crypto';

import { enrich, withLock } from './thalamus.js';
import { getRegistry, DEFAULT_LOCATION_MODE, DEFAULT_ACTIVE_STRATEGY, DEFAULT_ACTIVE_COOLDOWN_SEC } from './village.js';
import { resolveAudience, audienceTagFor } from './audience.js';
import { readSettingsSync, primaryConnectionFrom } from './cerebellum.js';
import { enqueueMemorization } from './memorization.js';
import { PROVIDER_URLS } from './providers.js';
import { scoreMessage } from './crisis-signals.js';
import { recordThreat } from './threat-tracker.js';
import { recordUserActivity } from './last-activity.js';
import { recordKnock, recordLocationKnock } from './knocks.js';
import { filterOutgoingReply } from './outgoing-filter.js';
import { enqueueOutbox } from './outbox.js';
import { substituteMacros } from './macros.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR  = path.join(__dirname, 'logs');
const MAP_FILE  = path.join(__dirname, 'tomes', '.discord-map.json');

const API_BASE = 'https://discord.com/api/v10';

// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
// MESSAGE_CONTENT is a privileged intent — the ward must enable it on
// the bot's application page (Developer Portal → Bot → Privileged
// Gateway Intents) or guild messages arrive with empty content.
export const GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

const DISCORD_REPLY_LIMIT   = 1900;       // hard API limit 2000; headroom
const HISTORY_LIMIT         = 30;         // messages of session history per turn
const INPUT_CHAR_CAP        = 4000;       // per inbound message
const SESSION_IDLE_ROTATE_MS = 6 * 3600_000; // idle gap that starts a fresh session
const SUPERVISOR_TICK_MS    = 30_000;
const MAX_BACKOFF_MS        = 60_000;

// Close codes after which re-identifying is pointless (bad token, bad
// intents, sharding required). We stop and wait for a config change.
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

// ── Per-location rate-limit bucket (V5) ──────────────────────────
// Simple hourly token bucket persisted to tomes/.rate-limits.json.
// { [locationKey]: { count: N, windowStartMs: T } }
const RATE_LIMITS_FILE = path.join(__dirname, 'tomes', '.rate-limits.json');
let _rl = {};
let _rlLoaded = false;

async function loadRateLimits() {
  if (_rlLoaded) return;
  try {
    const raw = await fsp.readFile(RATE_LIMITS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    _rl = (typeof parsed === 'object' && parsed !== null) ? parsed : {};
  } catch { _rl = {}; }
  _rlLoaded = true;
}

async function saveRateLimits() {
  try {
    const tmp = RATE_LIMITS_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(_rl, null, 2), 'utf8');
    await fsp.rename(tmp, RATE_LIMITS_FILE);
  } catch (err) {
    console.warn('[discord] rate-limits save failed:', err?.message ?? err);
  }
}

// Returns { ok: true } or { ok: false, resetAt: epochMs }.
// Does NOT consume a slot — call consumeRateSlot() after delivery.
export function checkRateLimit(locationKey, perHour) {
  if (!Number.isFinite(perHour) || perHour <= 0) return { ok: true };
  const now = Date.now();
  const WINDOW_MS = 3_600_000;
  const bucket = _rl[locationKey];
  if (!bucket || now - bucket.windowStartMs >= WINDOW_MS) {
    _rl[locationKey] = { count: 0, windowStartMs: now };
    return { ok: true };
  }
  if (bucket.count >= perHour) return { ok: false, resetAt: bucket.windowStartMs + WINDOW_MS };
  return { ok: true };
}

export function consumeRateSlot(locationKey) {
  if (_rl[locationKey]) _rl[locationKey].count++;
}

export function resetRateLimitState() { _rl = {}; }

// ── Timestamp formatting ──────────────────────────────────────────

function formatMsgTime(isoString) {
  try {
    const d = new Date(isoString);
    if (isNaN(d)) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch { return ''; }
}

// ── Deferred presence — [later:…] revisit token (V9) ─────────────

const REVISIT_FILE    = path.join(__dirname, 'tomes', '.discord-revisits.json');
const REVISIT_MIN_MS  = 5  * 60_000;   // 5-minute floor
const REVISIT_MAX_MS  = 60 * 60_000;   // 1-hour ceiling
const REVISIT_MAX_DEFER = 2;           // may re-defer this many times total

let revisitTimer = null;

/** Parse a [later:…] token. Returns ms until the revisit, or null. */
export function parseDeferToken(text) {
  const m = String(text ?? '').trim().match(/^\[later:([^\]]+)\]$/i);
  if (!m) return null;
  const val = m[1].trim().toLowerCase();
  // Named buckets
  if (val === 'soon')       return 15 * 60_000;
  if (val === 'later')      return 45 * 60_000;
  if (val === 'much-later') return REVISIT_MAX_MS;
  // Relative duration: 15m, 30min, 1h, 2h etc.
  const rel = val.match(/^(\d+)\s*(m(?:in)?|h(?:rs?)?)$/);
  if (rel) {
    const n    = parseInt(rel[1], 10);
    const isH  = rel[2].startsWith('h');
    const ms   = n * (isH ? 3_600_000 : 60_000);
    return Math.min(Math.max(ms, REVISIT_MIN_MS), REVISIT_MAX_MS);
  }
  // Absolute wall-clock: 21:30 or 21:30:00 (server local time)
  const abs = val.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (abs) {
    const now    = new Date();
    const target = new Date(now);
    target.setHours(parseInt(abs[1], 10), parseInt(abs[2], 10), 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    const ms = target - now;
    return Math.min(Math.max(ms, REVISIT_MIN_MS), REVISIT_MAX_MS);
  }
  return null;
}

export function isDeferToken(text) {
  return parseDeferToken(text) !== null;
}

async function readRevisits() {
  try { return JSON.parse(await fsp.readFile(REVISIT_FILE, 'utf8')); }
  catch (err) {
    // ENOENT is the normal empty-queue case — silent. A parse error means a
    // corrupt file (e.g. a crash mid-write): pending revisits would vanish
    // silently, so log it loudly rather than swallow the diagnostic.
    if (err?.code !== 'ENOENT') {
      console.warn('[discord] revisits file unreadable — treating queue as empty:', err?.message ?? err);
    }
    return [];
  }
}

async function writeRevisits(list) {
  await fsp.mkdir(path.dirname(REVISIT_FILE), { recursive: true });
  const tmp = `${REVISIT_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8');
  await fsp.rename(tmp, REVISIT_FILE);
}

async function cancelRevisitsForLocation(locationKey) {
  try {
    const list = await readRevisits();
    const pruned = list.filter(r => r.locationKey !== locationKey);
    if (pruned.length !== list.length) {
      await writeRevisits(pruned);
      // The live timer may have been pointing at an entry we just pruned —
      // re-arm so it reflects the current queue and a superseded revisit
      // can't fire from a stale closure.
      armRevisitTimer().catch(() => {});
    }
  } catch { /* best-effort */ }
}

async function armRevisitTimer() {
  if (revisitTimer) { clearTimeout(revisitTimer); revisitTimer = null; }
  try {
    const list = await readRevisits();
    if (!list.length) return;
    const next = list.slice().sort((a, b) => a.dueAt - b.dueAt)[0];
    const delay = Math.max(1000, next.dueAt - Date.now());
    // A concurrent arm may have set a timer during the await above — clear it
    // before replacing it so we never leave an orphaned timeout firing from a
    // stale closure (the fireRevisit claim guard backstops this too).
    if (revisitTimer) clearTimeout(revisitTimer);
    revisitTimer = setTimeout(() => { fireRevisit(next).catch(err => console.error('[discord] fireRevisit failed:', err?.message ?? err)); }, delay);
    revisitTimer.unref?.();
  } catch (err) {
    console.warn('[discord] armRevisitTimer failed:', err?.message ?? err);
  }
}

async function fireRevisit(item) {
  // The gateway may have been torn down between when this timer was set and
  // when it fired — clearTimeout can't stop a callback already queued on the
  // event loop. Speaking through a closed/stale gw would post with an invalid
  // token (or throw). If we're no longer running, stand down silently.
  if (!gw.running) return;
  // Claim the item. If it's no longer in the queue, a real incoming message
  // (or a re-arm) already superseded this revisit — honour the supersession
  // and stand down rather than speaking from a stale timer closure.
  try {
    const list = await readRevisits();
    if (!list.some(r => r.id === item.id)) {
      console.log(`[discord] revisit: ${item.locationKey} already superseded — standing down`);
      armRevisitTimer().catch(() => {});
      return;
    }
    await writeRevisits(list.filter(r => r.id !== item.id));
  } catch { /* read/write failed — fall through and still attempt the turn */ }
  armRevisitTimer().catch(() => {});

  const settings  = readSettingsSync();
  const registry  = await getRegistry();
  const regLoc    = (registry.locations ?? []).find(l => l.key === item.locationKey);
  if (!regLoc) { console.log(`[discord] revisit: location ${item.locationKey} no longer registered — dropping`); return; }

  const locConnId = regLoc?.connectionId;
  const conn = (locConnId
    ? (settings.connections ?? []).find(c => c?.id === locConnId && c?.apiKey && c?.model)
    : null) ?? primaryConnectionFrom(settings);
  if (!conn?.apiKey || !conn?.model) { console.log('[discord] revisit: no connection — dropping'); return; }

  const channelId = discordChannelIdFromKey(item.locationKey);
  if (!channelId) { console.log(`[discord] revisit: can't resolve a channel from ${item.locationKey} — dropping`); return; }

  const label   = regLoc.label ?? `Discord channel`;
  const session = await sessionForLocation(item.locationKey, label, 'group');

  // Same knowledge gate the live path applies: a revisit speaks into a
  // SHARED room, so it must never carry ward-private context. The gate is
  // resolved from the room + accumulated participants, identical to handleTurn.
  const audienceInput = { location: item.locationKey, participants: session.participants };
  const { audienceGrants, audienceTag } = resolveLocationGate(audienceInput, registry);

  const enriched = await enrich('', { audience: audienceGrants, liveTurn: false })
    .catch(() => ({ static: '', dynamic: '' }));

  const directedAt = carriedExchange(session.messages);
  const preamble   = presenceBlock({
    kind: 'guild', locationLabel: label, speakerName: null,
    participants: session.participants, settings,
    ambient: true, ambientStrategy: regLoc.activeStrategy ?? DEFAULT_ACTIVE_STRATEGY,
    directedAt, revisitNote: true,
  });

  const systemContent = [enriched.static, preamble].filter(Boolean).join('\n\n---\n\n');
  const history = (session.messages ?? [])
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-HISTORY_LIMIT)
    .map(m => ({
      role: m.role,
      content: m.timestamp ? `[${formatMsgTime(m.timestamp)}] ${m.content}` : m.content,
    }));

  const apiMessages = [
    ...(systemContent ? [{ role: 'system', content: systemContent }] : []),
    ...history,
    ...(enriched.dynamic ? [{ role: 'system', content: enriched.dynamic }] : []),
    { role: 'user', content: '[— quiet moment, checking back —]' },
  ];

  const rawReply = await callChat({ conn, messages: apiMessages, settings });

  if (isAmbientAbstain(rawReply)) {
    console.log(`[discord] revisit: dropped (abstained) in ${item.locationKey}`);
    return;
  }

  if (isDeferToken(rawReply) && item.deferCount < REVISIT_MAX_DEFER) {
    const ms = parseDeferToken(rawReply);
    const newEntry = { id: randomUUID(), locationKey: item.locationKey, dueAt: Date.now() + ms, deferCount: item.deferCount + 1, queuedAt: new Date().toISOString() };
    const list = await readRevisits();
    await writeRevisits([...list.filter(r => r.locationKey !== item.locationKey), newEntry]);
    armRevisitTimer().catch(() => {});
    console.log(`[discord] revisit: re-deferred (${item.deferCount + 1}/${REVISIT_MAX_DEFER}) in ${item.locationKey} — next in ${Math.round(ms/60_000)}min`);
    return;
  }

  // If somehow a defer-token came back but we've exhausted re-defers, treat as abstain.
  if (isDeferToken(rawReply)) {
    console.log(`[discord] revisit: defer cap reached in ${item.locationKey} — dropping`);
    return;
  }

  // Same delivery spine as the live path: Pillar D filter, send, persist,
  // rate slot, status. No new incoming message, so priorMessages is empty.
  await deliverReply(gw, {
    rawReply, audienceTag, apiMessages, conn, settings,
    channelId, session, locationKey: item.locationKey, regLoc, priorMessages: [],
  });
  console.log(`[discord] revisit: spoke in ${item.locationKey}`);
}

// ── Active-presence pacing (Village V8) ──────────────────────────
//
// In 'active' rooms I can speak without being addressed. Two backstops
// keep that from running away with the token budget or flooding a room:
//   1. A hard cooldown (the location's activeCooldownSec) between the
//      unprompted TURNS I take — counted on every attempt, including
//      ones where I end up staying quiet, so abstaining can't make me
//      reconsider on the very next message.
//   2. The V5 hourly rate limit, enforced in handleTurn as usual.
// Activity rate (for the 'tiers' strategy) is tracked from a short
// rolling window of recent inbound messages per location. All of this
// is in-memory and volatile — cadence doesn't need to survive a
// restart, and starting fresh just means one prompt re-evaluation.
const ACTIVITY_WINDOW_MS = 600_000;            // 10 min of recent messages kept
const ACTIVITY_MAX_SAMPLES = 60;
const DEFAULT_TIER_CONFIG = {
  windowMs:    300_000,   // 5 min rate window for tiering
  mediumMin:   4,         // ≥ this many msgs/window → at least 'medium'
  fastMin:     12,        // ≥ this many → 'fast'
  slowMult:    1,         // effective cooldown = activeCooldownSec × mult
  mediumMult:  5,         // a busy-but-not-frantic room: I just glance in
  fastMult:    1.5,       // lively discussion: engaged, still not every line
};

const ambientState = new Map(); // locationKey → { lastTurnAt, recentTs: number[] }

function ambientFor(locationKey) {
  let st = ambientState.get(locationKey);
  if (!st) { st = { lastTurnAt: 0, recentTs: [] }; ambientState.set(locationKey, st); }
  return st;
}

/** Record an inbound message timestamp for activity-rate tiering. */
export function recordGuildActivity(locationKey, now = Date.now()) {
  const st = ambientFor(locationKey);
  st.recentTs.push(now);
  const cutoff = now - ACTIVITY_WINDOW_MS;
  st.recentTs = st.recentTs.filter(t => t >= cutoff).slice(-ACTIVITY_MAX_SAMPLES);
}

/** Stamp that an unprompted turn was just attempted (starts the cooldown). */
export function markAmbientTurn(locationKey, now = Date.now()) {
  ambientFor(locationKey).lastTurnAt = now;
}

export function resetAmbientState() { ambientState.clear(); }

/**
 * Decide whether to take an unprompted turn in an active room. Pure:
 * all state comes in as arguments so it's unit-testable.
 *
 *   - 'llm' strategy: a single cooldown gate. When it passes I make the
 *     turn and the model itself chooses whether to speak (it can abstain).
 *   - 'tiers' strategy: the busier the room, the longer I hold off
 *     (effective cooldown = activeCooldownSec × the tier's multiplier),
 *     so I pace myself to the room instead of answering every line.
 *
 * @returns {{ act: boolean, reason: string, tier?: string }}
 */
export function decideAmbientReply({
  strategy = DEFAULT_ACTIVE_STRATEGY, now = Date.now(), lastTurnAt = 0,
  recentMsgTimestamps = [], cooldownMs = DEFAULT_ACTIVE_COOLDOWN_SEC * 1000,
  tierConfig = DEFAULT_TIER_CONFIG,
} = {}) {
  const since = lastTurnAt ? now - lastTurnAt : Infinity;
  if (strategy === 'tiers') {
    const rate = recentMsgTimestamps.filter(t => now - t <= tierConfig.windowMs).length;
    let tier, mult;
    if (rate >= tierConfig.fastMin)        { tier = 'fast';   mult = tierConfig.fastMult; }
    else if (rate >= tierConfig.mediumMin) { tier = 'medium'; mult = tierConfig.mediumMult; }
    else                                   { tier = 'slow';   mult = tierConfig.slowMult; }
    return since < cooldownMs * mult
      ? { act: false, reason: 'tier-cooldown', tier }
      : { act: true,  reason: 'tier', tier };
  }
  // 'llm' (default): a plain cooldown; the model decides whether to speak.
  return since < cooldownMs ? { act: false, reason: 'cooldown' } : { act: true, reason: 'llm' };
}

// ── Pure helpers (unit-tested in tests/discord-gateway.test.mjs) ──

/** Location key for a MESSAGE_CREATE payload — matches the registry's
 *  locations[].key convention from the design doc. */
export function discordLocationKey(msg) {
  if (msg?.guild_id) return `discord:guild:${msg.guild_id}:channel:${msg.channel_id}`;
  return `discord:dm:${msg?.channel_id}`;
}

/**
 * Decide what to do with an inbound message. Pure: registry, ward id,
 * and bot id come in as arguments. Fail-closed: anything unrecognized
 * is ignored (DMs) or floored (guilds, via the audience resolver).
 *
 * Returns { action: 'ignore', reason } or
 * { action: 'respond', kind: 'ward-dm'|'villager-dm'|'guild',
 *   isWard, villager: villager|null, speakerName, locationKey,
 *   audience: null | { location, participants } }.
 */
export function classifyMessage(msg, { registry, botUserId, wardUserId }) {
  if (!msg || typeof msg !== 'object') return { action: 'ignore', reason: 'malformed' };
  const author = msg.author ?? {};
  // My own messages are ALWAYS ignored — a Familiar never answers itself,
  // whatever a location's settings say. This is the inner loop guard and
  // sits above the readBots opt-in deliberately.
  if (author.id && author.id === botUserId) return { action: 'ignore', reason: 'own-message' };
  // Other bots (including other Familiars) are ignored by default — the
  // outer loop guard. A location can opt in via readBots, in which case
  // the bot's message flows through normal classification below: answered
  // when addressed, paced by the room's mode/cooldown otherwise.
  if (author.bot) {
    const loc = (registry?.locations ?? []).find(l => l.key === discordLocationKey(msg));
    if (loc?.readBots !== true) return { action: 'ignore', reason: 'bot-author' };
  }
  const content = typeof msg.content === 'string' ? msg.content.trim() : '';
  if (!content) return { action: 'ignore', reason: 'no-content' };

  const isWard = !!(wardUserId && author.id === wardUserId);
  const villager = isWard ? null : (registry?.villagers ?? []).find(v =>
    v.aliases.some(a => a.platform === 'discord' && a.id === author.id),
  ) ?? null;
  const speakerName = villager?.name
    ?? (isWard ? null : (author.global_name || author.username || 'someone'));
  const locationKey = discordLocationKey(msg);

  if (!msg.guild_id) {
    // ── DM ──
    if (isWard) {
      return { action: 'respond', kind: 'ward-dm', isWard: true, villager: null, speakerName: null, locationKey, audience: null };
    }
    if (villager) {
      // A DM's readers are fully enumerable (the villager + me), so the
      // participant grants gate it. Include the location only when the
      // ward has registered this DM as a location (an assigned ceiling
      // is honored; an unregistered DM must not auto-floor a known
      // villager the way an unenumerable guild room must).
      const registered = (registry?.locations ?? []).some(l => l.key === locationKey);
      return {
        action: 'respond', kind: 'villager-dm', isWard: false, villager, speakerName, locationKey,
        audience: {
          location: registered ? locationKey : null,
          participants: [{ id: villager.id, name: villager.name }],
        },
      };
    }
    return { action: 'ignore', reason: 'unregistered-dm' };
  }

  // ── Guild channel ──
  const mentioned = Array.isArray(msg.mentions) && msg.mentions.some(u => u?.id === botUserId);
  const repliedTo = msg.referenced_message?.author?.id === botUserId;
  const addressed = mentioned || repliedTo;

  // Audience: ALWAYS the location key (unassigned room → Strangers via
  // the resolver) plus the speaker. The ward never appears as a
  // participant — the gate intersects the room, not its owner.
  const participants = isWard ? [] : [
    villager ? { id: villager.id, name: villager.name } : { id: null, name: speakerName },
  ];
  const audience = { location: locationKey, participants };
  const base = { kind: 'guild', isWard, villager, speakerName, locationKey, audience };

  // Being addressed always earns a reply, whatever the room's mode.
  if (addressed) return { action: 'respond', ambient: false, ...base };

  // Not addressed → the location's presence mode decides (V8).
  const loc = (registry?.locations ?? []).find(l => l.key === locationKey);
  const mode = (loc?.mode === 'lurk' || loc?.mode === 'active') ? loc.mode : DEFAULT_LOCATION_MODE;
  if (mode === 'active') {
    return {
      action: 'respond', ambient: true, ...base,
      activeStrategy: loc?.activeStrategy ?? DEFAULT_ACTIVE_STRATEGY,
      activeCooldownSec: Number.isFinite(loc?.activeCooldownSec) ? loc.activeCooldownSec : DEFAULT_ACTIVE_COOLDOWN_SEC,
    };
  }
  if (mode === 'lurk') return { action: 'observe', ...base };
  return { action: 'ignore', reason: 'not-mentioned' };
}

/** Split a reply into Discord-sized chunks, preferring newline/space breaks. */
export function chunkReply(text, limit = DISCORD_REPLY_LIMIT) {
  const out = [];
  let rest = String(text ?? '').trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/** Merge a speaker into a session's accumulated participants (by id,
 *  falling back to case-insensitive name for unknowns). Ward excluded
 *  by callers. Returns a new array; never mutates. */
export function mergeParticipant(participants, entry) {
  const list = Array.isArray(participants) ? [...participants] : [];
  if (!entry) return list;
  const exists = list.some(p =>
    (entry.id && p.id === entry.id) ||
    (!entry.id && !p.id && p.name?.toLowerCase() === entry.name?.toLowerCase()),
  );
  if (!exists) list.push(entry);
  return list;
}

/** Resolve Discord user-mention tokens (<@id>, <@!id>) in message text to
 *  readable @Name form, so a multi-party room stays legible to me. Raw
 *  snowflakes make it impossible to tell who a message is aimed at — the
 *  difference between "<@837…> Liar" and "@Hogsworth Liar" is the
 *  difference between butting into an exchange and recognising it isn't
 *  mine. Names resolve in priority: my own character name for my id, a
 *  registered villager's configured name, then the mentioned user's
 *  display name from the payload, then a plain @someone. */
export function resolveMentions(content, { mentions = [], botUserId = null, charName = 'the Familiar', villagers = [] } = {}) {
  const text = String(content ?? '');
  if (!/<@!?\d+>/.test(text)) return text;
  const villagerName = (id) => (villagers ?? []).find(v =>
    (v.aliases ?? []).some(a => a.platform === 'discord' && a.id === id))?.name ?? null;
  const fromPayload = new Map();
  for (const u of (Array.isArray(mentions) ? mentions : [])) {
    if (u?.id) fromPayload.set(u.id, u.global_name || u.username || null);
  }
  const nameFor = (id) => {
    if (botUserId && id === botUserId) return charName || 'the Familiar';
    return villagerName(id) ?? fromPayload.get(id) ?? 'someone';
  };
  return text.replace(/<@!?(\d+)>/g, (_m, id) => `@${nameFor(id)}`);
}

/** Names this message is explicitly aimed at, other than me — @-mentions
 *  of other users (people OR other Familiars) plus a reply to someone
 *  else's message. Lets an active-mode Familiar tell "this is between
 *  them" from open-room chatter, so it doesn't barge into an exchange
 *  pointed at another participant. Villager names preferred; de-duped. */
// The name I actually use for a Discord user: their Village name if I
// know them, else their Discord display name. One basis everywhere, so a
// person reads the same across @-mentions, name-prefixes, and the
// carried-exchange logic below.
function nameForUser(user, villagers = []) {
  const byVillager = (villagers ?? []).find(v =>
    (v.aliases ?? []).some(a => a.platform === 'discord' && a.id === user?.id))?.name;
  return byVillager ?? user?.global_name ?? user?.username ?? null;
}

export function directedAtOthers(msg, { botUserId = null, villagers = [] } = {}) {
  const names = [];
  const add = (user) => {
    if (!user?.id || user.id === botUserId) return;
    const name = nameForUser(user, villagers);
    if (name && !names.includes(name)) names.push(name);
  };
  for (const u of (Array.isArray(msg?.mentions) ? msg.mentions : [])) add(u);
  if (msg?.referenced_message?.author) add(msg.referenced_message.author);
  return names;
}

/** Did this message pull me in — @-mention me, or reply to something I
 *  said? If so, an exchange that was running between other people has
 *  turned toward the room (or me), and must NOT be carried forward as
 *  "not mine" on the next untagged line. */
export function messageNamesBot(msg, botUserId) {
  if (!botUserId) return false;
  if ((Array.isArray(msg?.mentions) ? msg.mentions : []).some(u => u?.id === botUserId)) return true;
  if (msg?.referenced_message?.author?.id === botUserId) return true;
  return false;
}

/** An ambient turn's triggering line often carries no structured pointer
 *  — "@Nichtschwert, you and I?" is tagged, but Nichtschwert's untagged
 *  "sure, what's up?" that follows is not, even though it plainly belongs
 *  to the same two-person thread. I read the recent room to carry that
 *  forward: the most recent message that named only other people (and did
 *  not pull me in) marks a live exchange; its parties are the speaker plus
 *  the people they named. If the person speaking now is one of them, this
 *  line continues their thread, not an opening for me. Built on the
 *  structured per-message `targets`/`namedMe` recorded at persist time —
 *  no parsing of display text, so it stays reliable code, not a guess
 *  about tone. Returns the other parties' names, or [] if the room reads
 *  as open. */
export function carriedExchange(messages, { currentSpeaker = null, lookback = 5, maxAgeMs = 60 * 60_000 } = {}) {
  const now    = Date.now();
  const recent = (Array.isArray(messages) ? messages : [])
    .filter(m => m?.role === 'user')
    .filter(m => !m?.timestamp || (now - new Date(m.timestamp).getTime()) < maxAgeMs)
    .slice(-lookback);
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    if (m?.namedMe) return [];
    const targets = Array.isArray(m?.targets) ? m.targets.filter(Boolean) : [];
    if (targets.length === 0) continue;
    const party = [...new Set([m.speaker, ...targets].filter(Boolean))];
    if (currentSpeaker && party.includes(currentSpeaker)) {
      return party.filter(n => n !== currentSpeaker);
    }
    return party;
  }
  return [];
}

// ── Presence preamble (my own orientation, first person) ─────────

function presenceBlock({ kind, locationLabel, speakerName, participants, settings, ambient = false, ambientStrategy = DEFAULT_ACTIVE_STRATEGY, directedAt = [], revisitNote = false }) {
  const lines = ['[Discord Presence]'];
  if (kind === 'ward-dm') {
    lines.push(
      'I am in a private Discord DM with {{user}} — same bond, different window. ' +
      'I am still myself here: same voice, same temperament, same continuity.',
    );
  } else if (kind === 'villager-dm') {
    lines.push(
      `I am in a private Discord DM with ${speakerName} — someone from {{user}}'s Village, not {{user}} themselves. ` +
      'I am still myself: same voice, same temperament. The context I carry into this room is what my human has granted this person; whatever I don\'t find in my context, I simply don\'t have here.',
    );
  } else {
    const present = (participants ?? []).map(p => p.name).filter(Boolean).join(', ');
    lines.push(
      `I am speaking in ${locationLabel} — a shared Discord channel, not my private chat with {{user}}. ` +
      (present ? `People I've seen here this session: ${present}. ` : '') +
      'Anyone in this room can read what I say. I am still myself: same voice, same temperament.',
    );
  }
  lines.push(
    'I keep replies Discord-sized — well under 1800 characters, usually a few sentences. ' +
    'I write as a person in the conversation, not as a service announcing itself.',
  );
  // Ambient turn (active mode): no one @-mentioned me, but people know
  // I'm around. I get to choose whether to speak. `directedAt` carries the
  // people whose exchange this is when there is one — either named on this
  // line or carried forward from a thread they already established (see
  // carriedExchange). Absence of a tag on one line is NOT proof the room is
  // open: two people mid-conversation are still mid-conversation. So the
  // open branch makes me read for that, rather than treating any untagged
  // line as an opening. How talkative or reserved I am is my personality's
  // to decide, not a default-care register, and never a bias toward silence.
  if (ambient) {
    const aimedAt = (directedAt ?? []).filter(Boolean).join(', ');
    if (revisitNote) {
      lines.push('I asked to check back here. I can now speak, stay quiet with [pass], or re-defer once more with [later:…].');
    }
    if (ambientStrategy === 'llm') {
      if (aimedAt) {
        lines.push(
          `The recent messages are an exchange between ${aimedAt} — not pointed at me. ` +
          'I read whether this scene has a natural place for me: is there something here that would genuinely move me to speak, given who I am, or is this theirs to have? ' +
          'My options: I can speak; reply [pass] to stay out; or reply [later:…] to check back — ' +
          'e.g. [later:soon] (~15min), [later:20m], [later:22:30] — useful if the exchange might wrap up soon and I\'d rather see how it lands.',
        );
      } else {
        lines.push(
          'No one named me just now. Before I decide, I read the room: if two or more people are clearly in a back-and-forth with each other, that exchange is theirs even without a tag — I do not read an unaddressed line as an opening meant for me. ' +
          'If the room is genuinely open — idle, scattered, or a remark anyone could pick up — I ask whether this scene has a natural place for me, given who I am. ' +
          'My options: I can speak; reply [pass] to stay quiet; or reply [later:…] to revisit — ' +
          '[later:soon] (~15min), [later:later] (~45min), [later:much-later] (~1h), or [later:20m] / [later:22:30]. ' +
          'A revisit is for "not right now but I\'d like to see where this goes," not a default fallback.',
        );
      }
    } else {
      if (aimedAt) {
        lines.push(
          `The recent messages are an exchange between ${aimedAt} — not pointed at me. ` +
          'I consider whether there is a natural place for me here before I decide whether to speak; if there is, I join as myself. ' +
          'If not: [pass] to drop it, or [later:soon|later|much-later] / [later:Nm] to revisit.',
        );
      } else {
        lines.push(
          'No one named me just now. I read the room first: if people are clearly mid-conversation with each other, that thread is theirs even without a tag. ' +
          'If the room is open, I chime in the way a person actually does — reacting to what was said, a tangent, something from my own interests, an observation, a take. ' +
          'I keep it Discord-sized; whether I\'m talkative or hang back depends on my personality, mood, and the moment. ' +
          'If there\'s no natural place for me here: [pass] to drop it, or [later:soon|later|much-later] / [later:Nm] to revisit.',
        );
      }
    }
  }
  return substituteMacros(lines.join('\n'), settings);
}

// An ambient reply where I chose to stay quiet. Matches [pass] / pass /
// [silence] / silence (optionally bracketed) and nothing else. Bare words
// like "nothing", "quiet", "skip" are valid chat replies and are NOT caught.
const AMBIENT_ABSTAIN_RE = /^\s*[[(]?\s*(pass|silence)\s*[\])]?\s*[.!]?\s*$/i;
export function isAmbientAbstain(text) {
  const t = (text ?? '').trim();
  return t === '' || AMBIENT_ABSTAIN_RE.test(t);
}

// ── Conversation map (location key → session id), persisted ──────

async function readMap() {
  try { return JSON.parse(await fsp.readFile(MAP_FILE, 'utf8')); }
  catch { return {}; }
}

async function writeMap(map) {
  await fsp.mkdir(path.dirname(MAP_FILE), { recursive: true });
  const tmp = `${MAP_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(map, null, 2), 'utf8');
  await fsp.rename(tmp, MAP_FILE);
}

async function readSessionLog(sessionId) {
  try { return JSON.parse(await fsp.readFile(path.join(LOGS_DIR, `${sessionId}.json`), 'utf8')); }
  catch { return null; }
}

async function writeSessionLog(data) {
  await fsp.mkdir(LOGS_DIR, { recursive: true });
  const file = path.join(LOGS_DIR, `${data.sessionId}.json`);
  const tmp  = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

/** Get (or rotate) the session for a location. One location = one live
 *  session thread; a long idle gap starts a fresh session so logs stay
 *  bounded and "sessions" keep meaning something. */
async function sessionForLocation(locationKey, locationLabel, kind) {
  return withLock('discord:session-map', async () => {
    const map = await readMap();
    const entry = map[locationKey];
    const nowMs = Date.now();
    if (entry?.sessionId) {
      const elapsedMs = nowMs - new Date(entry.lastTurnAt ?? 0).getTime();
      if (elapsedMs < SESSION_IDLE_ROTATE_MS) {
        const log = await readSessionLog(entry.sessionId);
        if (log) return log;
      } else {
        // session idled out — memorize it before rotating
        const oldLog = await readSessionLog(entry.sessionId);
        if (oldLog?.messages?.length >= 2) {
          const settings = readSettingsSync();
          const conn = primaryConnectionFrom(settings);
          if (conn?.apiKey && conn?.model) {
            enqueueMemorization({
              sessionId: oldLog.sessionId,
              messages:  oldLog.messages,
              provider:  conn.provider,
              apiKey:    conn.apiKey,
              model:     conn.model,
              audienceTag: oldLog.audienceTag ?? 'ward-private',
            }).catch(err => console.warn('[discord] memorize on rotate failed:', err.message));
          }
        }
      }
    }
    const fresh = {
      sessionId: randomUUID(),
      startedAt: new Date(nowMs).toISOString(),
      endedAt: null,
      provider: null,
      model: null,
      audienceTag: null,
      messages: [],
      location: { platform: 'discord', key: locationKey, label: locationLabel, kind },
      participants: [],
      updatedAt: new Date(nowMs).toISOString(),
    };
    map[locationKey] = { sessionId: fresh.sessionId, lastTurnAt: fresh.startedAt };
    await writeMap(map);
    return fresh;
  });
}

async function touchLocation(locationKey, sessionId) {
  await withLock('discord:session-map', async () => {
    const map = await readMap();
    map[locationKey] = { sessionId, lastTurnAt: new Date().toISOString() };
    await writeMap(map);
  });
}

// ── LLM call ──────────────────────────────────────────────────────

async function callChat({ conn, messages, settings }) {
  const url = PROVIDER_URLS[conn.provider];
  if (!url) throw new Error(`unknown provider: ${conn.provider}`);
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${conn.apiKey.trim()}`,
    },
    body: JSON.stringify({
      model:       conn.model.trim(),
      messages,
      stream:      false,
      temperature: Number.isFinite(settings?.temperature) ? settings.temperature : 0.8,
      max_tokens:  1024,
    }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`provider ${conn.provider} returned ${resp.status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  if (data.error) throw new Error(typeof data.error === 'string' ? data.error : (data.error.message ?? 'provider error'));
  const content = data.choices?.[0]?.message?.content ?? '';
  if (!content.trim()) throw new Error('provider returned empty content');
  return content;
}

// ── Discord REST ──────────────────────────────────────────────────

async function discordRest(token, route, { method = 'GET', body } = {}) {
  const resp = await fetch(`${API_BASE}${route}`, {
    method,
    headers: {
      'Authorization': `Bot ${token}`,
      'Content-Type':  'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`discord ${method} ${route} → ${resp.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function sendChannelMessage(token, channelId, content) {
  for (const chunk of chunkReply(content)) {
    await discordRest(token, `/channels/${channelId}/messages`, {
      method: 'POST',
      body: { content: chunk },
    });
  }
}

/** Build the knowledge-gate input from a classified message + the room's
 *  accumulated participants. Null means the ward's own DM (ward-private, no
 *  gating). One source of truth for this shape so the spoken path and the
 *  observe path can never compute the gate from different inputs — the shape
 *  this returns is exactly what the privacy gate keys on. */
function audienceInputFor(decision, participants) {
  return decision.audience === null
    ? null
    : { location: decision.audience.location, participants };
}

/** Resolve the knowledge gate for a location turn. `audienceInput` is null
 *  for the ward's own DM (ward-private — no gating) or { location,
 *  participants } for any other room. Returns the grants enrich() fetches
 *  against and the durable audience tag stamped on the session. Shared by
 *  the live path and the deferred-revisit path so the gate can never differ
 *  between them. */
function resolveLocationGate(audienceInput, registry) {
  return {
    audienceGrants: audienceInput === null ? null : resolveAudience(audienceInput, registry),
    audienceTag:    audienceTagFor(audienceInput, registry),
  };
}

/** Deliver a reply I composed into a Discord channel and persist the turn.
 *  Shared by the live chat path (handleTurn) and the deferred-revisit path
 *  (fireRevisit) so BOTH run the same Pillar D outgoing gate, session
 *  persistence, rate-limit accounting, and status bookkeeping — neither can
 *  drift from the other or quietly skip a safety step. `priorMessages` are
 *  appended before my reply (the incoming user turn for a live turn; empty
 *  for a revisit, where there is no new incoming message). */
async function deliverReply(gw, { rawReply, audienceTag, apiMessages, conn, settings, channelId, session, locationKey, regLoc, priorMessages = [] }) {
  // Pillar D semantic outgoing gate. Ward-private (the ward's own DM)
  // fast-paths; every other room is filtered before I say anything.
  let reply = rawReply;
  if (audienceTag !== 'ward-private' && rawReply) {
    const filtered = await filterOutgoingReply({
      draftText:    rawReply,
      audienceTag,
      callUpstream: async (msgs) => callChat({ conn, messages: msgs, settings }),
      baseMessages: apiMessages,
    }).catch(err => {
      console.error('[discord] outgoing filter failed (passing through):', err?.message ?? err);
      return { text: rawReply, blocked: false };
    });
    reply = filtered.text;
    if (filtered.blocked)        console.log(`[discord] outgoing filter exhausted budget — safe refusal sent (audience=${audienceTag})`);
    else if (reply !== rawReply) console.log(`[discord] outgoing filter rewrote reply (audience=${audienceTag})`);
  }

  await sendChannelMessage(gw.config.token, channelId, reply);

  // Persist the turn. Sessions land in logs/ exactly like web sessions
  // and stay listable by the ward in the UI — no hidden conversations.
  const now = new Date().toISOString();
  session.messages = [
    ...(session.messages ?? []),
    ...priorMessages,
    { id: randomUUID(), role: 'assistant', content: reply, timestamp: now },
  ];
  session.provider    = conn.provider;
  session.model       = conn.model;
  session.audienceTag = audienceTag;
  session.updatedAt   = now;
  await writeSessionLog(session);
  await touchLocation(locationKey, session.sessionId);

  // V5: consume one rate-limit slot after successful delivery. Hydrate the
  // bucket state first — a revisit can reach here (after a restart, armed on
  // READY) before any inbound message has loaded it, and saving an unloaded
  // {} would clobber the persisted buckets. loadRateLimits is idempotent.
  if (regLoc?.rateLimit?.perHour) {
    await loadRateLimits();
    consumeRateSlot(locationKey);
    saveRateLimits().catch(() => {});
  }

  gw.status.turns += 1;
  gw.status.lastTurnAt = session.updatedAt;
  return reply;
}

/** Channel id embedded in a registry location key, or null if the key
 *  isn't a Discord location. `discord:guild:G:channel:C` → C;
 *  `discord:dm:C` → C. Exported + pure for tests. */
export function discordChannelIdFromKey(key) {
  if (typeof key !== 'string') return null;
  const guild = key.match(/^discord:guild:\d+:channel:(\d+)$/);
  if (guild) return guild[1];
  const dm = key.match(/^discord:dm:(\d+)$/);
  if (dm) return dm[1];
  return null;
}

/**
 * Relay a message the Familiar composed into a Discord channel or to a
 * villager's DM. This is the V6 relay_message delivery half — cerebellum
 * owns the target resolution + ward mirror + the restricted-memory gate;
 * this function only knows Discord.
 *
 * Provide exactly one of:
 *   - channelId       — send straight to that channel (guild room or known DM).
 *   - recipientUserId — open/create a DM with that Discord user, then send.
 *
 * Reads the bot token from Settings (so it works whether or not the
 * gateway's WebSocket is currently up — delivery is a plain REST call).
 * Never throws: returns { ok: false, error } on any failure so the tool
 * path stays clean.
 */
export async function relayToDiscord({ channelId, recipientUserId, message } = {}) {
  try {
    if (!message || typeof message !== 'string' || !message.trim()) {
      return { ok: false, error: 'no message to relay' };
    }
    const settings = readSettingsSync();
    const token = typeof settings?.discordBotToken === 'string' ? settings.discordBotToken.trim() : '';
    if (!token) return { ok: false, error: 'Discord is not configured (no bot token)' };
    if (settings?.discordEnabled === false) return { ok: false, error: 'Discord is turned off in Settings' };

    let targetChannel = channelId ?? null;
    if (!targetChannel && recipientUserId) {
      const dm = await discordRest(token, '/users/@me/channels', {
        method: 'POST',
        body: { recipient_id: String(recipientUserId) },
      });
      targetChannel = dm?.id ?? null;
    }
    if (!targetChannel) return { ok: false, error: 'could not resolve a Discord channel for the target' };

    await sendChannelMessage(token, targetChannel, message);
    return { ok: true, channelId: targetChannel };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// ── Turn handler ──────────────────────────────────────────────────

// Serialize turns per location so concurrent messages can't interleave
// session-log writes.
const turnChains = new Map();

function enqueueTurn(locationKey, fn) {
  const prev = turnChains.get(locationKey) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // The stored link swallows rejections — the caller of enqueueTurn gets
  // the real `next` and handles the error; the chain must never become
  // an unhandled rejection.
  const stored = next.catch(() => {}).then(() => {
    if (turnChains.get(locationKey) === stored) turnChains.delete(locationKey);
  });
  turnChains.set(locationKey, stored);
  return next;
}

// Presence without speaking (V8 lurk, and active turns I choose to sit
// out): I take the message INTO the room's session so the conversation
// accumulates, but I send nothing and spend no LLM call. This is what
// "reading the room" means — when someone finally turns to me, I have
// what was said. Deliberately threat-neutral: observing never moves the
// ward's last-activity clock or threat tier (that stays on the reply
// path, out of the safety-critical surface).
async function observeMessage(gw, msg, decision) {
  const registry = await getRegistry();
  const regLoc = (registry.locations ?? []).find(l => l.key === decision.locationKey);
  const label  = regLoc?.label ?? `Discord channel ${msg.channel_id}`;

  if (decision.kind === 'guild' && !regLoc) {
    recordLocationKnock({
      key: decision.locationKey, platform: 'discord',
      guildId: msg.guild_id, channelId: msg.channel_id,
    }).catch(() => { /* best-effort */ });
  }

  const session = await sessionForLocation(decision.locationKey, label, 'group');
  if (!decision.isWard && decision.speakerName) {
    session.participants = mergeParticipant(session.participants, {
      id: decision.villager?.id ?? null,
      name: decision.speakerName,
    });
  }
  const audienceTag = audienceTagFor(audienceInputFor(decision, session.participants), registry);
  // Resolve mention tokens here too so what I read back later is legible.
  const content = resolveMentions(String(msg.content), {
    mentions: msg.mentions, botUserId: gw.botUserId,
    charName: readSettingsSync()?.charName, villagers: registry.villagers,
  }).slice(0, INPUT_CHAR_CAP);
  const userContent = decision.isWard ? content : `[${decision.speakerName}]: ${content}`;
  // Same structured signals as a spoken turn, so a lurked-then-active room
  // can still see whose exchange a later untagged line continues.
  const turnSpeaker = nameForUser(msg.author, registry.villagers) ?? decision.speakerName ?? null;
  const msgTargets  = directedAtOthers(msg, { botUserId: gw.botUserId, villagers: registry.villagers });
  const msgNamedMe  = messageNamesBot(msg, gw.botUserId);
  session.messages = [
    ...(session.messages ?? []),
    { id: randomUUID(), role: 'user', content: userContent, timestamp: new Date().toISOString(), speaker: turnSpeaker, targets: msgTargets, namedMe: msgNamedMe },
  ];
  session.audienceTag = audienceTag;
  session.updatedAt   = new Date().toISOString();
  await writeSessionLog(session);
  await touchLocation(decision.locationKey, session.sessionId);
  gw.status.observed = (gw.status.observed ?? 0) + 1;
}

async function handleTurn(gw, msg, decision) {
  const settings = readSettingsSync();
  const registry = await getRegistry();
  await loadRateLimits();

  // V5: per-location connection routing. Use the location's designated
  // connection if one is configured and valid; fall back to primary.
  const regLoc = (registry.locations ?? []).find(l => l.key === decision.locationKey);
  const locConnId = regLoc?.connectionId;
  const conn = (locConnId
    ? (settings.connections ?? []).find(c => c?.id === locConnId && c?.apiKey && c?.model)
    : null)
    ?? primaryConnectionFrom(settings);

  if (!conn?.apiKey || !conn?.model) {
    gw.status.lastError = 'no connection configured — cannot reply';
    console.warn('[discord] inbound message but no connection configured; staying silent');
    return;
  }

  // V5: rate-limit enforcement. When exhausted, stay quiet and enqueue
  // one outbox notice per hour so the ward can see what happened.
  if (regLoc?.rateLimit?.perHour) {
    const rl = checkRateLimit(decision.locationKey, regLoc.rateLimit.perHour);
    if (!rl.ok) {
      const resetMins = Math.ceil((rl.resetAt - Date.now()) / 60_000);
      console.log(`[discord] rate limit hit for ${decision.locationKey} — silent until ${new Date(rl.resetAt).toISOString()}`);
      enqueueOutbox({
        kind: 'rate-limit',
        originId: `rate-limit:${decision.locationKey}:${Math.floor(Date.now() / 3_600_000)}`,
        title: `Rate limit reached in ${regLoc.label ?? decision.locationKey}`,
        body: `I've reached the hourly message limit for this location (${regLoc.rateLimit.perHour}/hr). I'll stay quiet there until the window resets in about ${resetMins} minute${resetMins === 1 ? '' : 's'}.`,
      }).catch(() => {});
      return;
    }
  }

  // Resolve <@id> mention tokens to @Name BEFORE truncation so the room
  // stays legible to me — I can tell who each message is aimed at instead
  // of seeing raw snowflakes. (registry resolved at the top of handleTurn.)
  const content  = resolveMentions(String(msg.content), {
    mentions: msg.mentions, botUserId: gw.botUserId,
    charName: settings?.charName, villagers: registry.villagers,
  }).slice(0, INPUT_CHAR_CAP);
  const nowIso   = new Date().toISOString();

  // Ward speech counts as ward activity wherever it happens — the
  // silence-triage clock and the threat detector follow my human, not
  // a particular window. Villager speech must never move either.
  if (decision.isWard) {
    recordUserActivity().catch(err =>
      console.error('[discord] recordUserActivity failed:', err?.message ?? err));
    try {
      const { level, signals } = scoreMessage(content);
      if (level !== 0) {
        console.log(`[discord] threat scored ${level >= 0 ? '+' : ''}${level} on ward message`);
        recordThreat({ delta: level, source: 'discord', signals })
          .catch(err => console.error('[discord] recordThreat failed:', err?.message ?? err));
      }
    } catch (err) {
      console.error('[discord] threat scoring failed:', err?.message ?? err);
    }
  }

  // Session: load-or-rotate, accumulate the speaker, derive the label.
  // (regLoc already resolved at the top of handleTurn for V5 routing)
  const label  = regLoc?.label
    ?? (decision.kind === 'guild' ? `Discord channel ${msg.channel_id}` : `Discord DM`);

  // Location knock — capture unregistered guild channels for one-click
  // registration in the Locations tab. Fire-and-forget; registration
  // grants nothing.
  if (decision.kind === 'guild' && !regLoc) {
    recordLocationKnock({
      key: decision.locationKey,
      platform: 'discord',
      guildId: msg.guild_id,
      channelId: msg.channel_id,
    }).catch(() => { /* best-effort */ });
  }
  const session = await sessionForLocation(decision.locationKey, label, decision.kind === 'guild' ? 'group' : 'private');
  // A real incoming message supersedes any pending revisit for this location.
  cancelRevisitsForLocation(decision.locationKey).catch(() => {});
  if (!decision.isWard && decision.speakerName) {
    session.participants = mergeParticipant(session.participants, {
      id: decision.villager?.id ?? null,
      name: decision.speakerName,
    });
  }

  // Audience re-resolved per turn from ACCUMULATED participants — a
  // stranger who spoke earlier in this session still tightens the gate
  // now ("readable, not just active"). Ward-private stays null. The tag
  // is the LOWEST permission level among everyone present; it's stamped on
  // the session so the memorization sweep can route ward-private content
  // into Phylactery while quarantining shared-room content to the tome.
  const audienceInput = audienceInputFor(decision, session.participants);
  const { audienceGrants, audienceTag } = resolveLocationGate(audienceInput, registry);

  const enriched = await enrich(content, { audience: audienceGrants, liveTurn: false })
    .catch(err => {
      console.error('[discord] enrich failed (degrading to bare turn):', err?.message ?? err);
      return { static: '', dynamic: '' };
    });

  // Structured signals for who this message names — recorded on every
  // message so a later untagged line can still see the exchange it belongs
  // to (carriedExchange). One naming basis (Village name ?? Discord
  // display) so speaker and targets compare cleanly across turns.
  const turnSpeaker = nameForUser(msg.author, registry.villagers) ?? decision.speakerName ?? null;
  const msgTargets  = directedAtOthers(msg, { botUserId: gw.botUserId, villagers: registry.villagers });
  const msgNamedMe  = messageNamesBot(msg, gw.botUserId);

  // On an ambient turn, whom is this exchange actually between? If this
  // line named others, that's it; if it named no one, I carry forward the
  // thread other people already established (so their untagged follow-ups
  // don't read as openings for me). Not silence-by-default — I weigh it.
  const directedAt = decision.ambient
    ? (msgTargets.length
        ? msgTargets
        : carriedExchange(session.messages, { currentSpeaker: turnSpeaker }))
    : [];

  const preamble = presenceBlock({
    kind: decision.kind,
    locationLabel: label,
    speakerName: decision.speakerName,
    participants: session.participants,
    settings,
    ambient: !!decision.ambient,
    ambientStrategy: decision.activeStrategy ?? DEFAULT_ACTIVE_STRATEGY,
    directedAt,
  });

  const systemContent = [enriched.static, preamble].filter(Boolean).join('\n\n---\n\n');
  const history = (session.messages ?? [])
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-HISTORY_LIMIT)
    .map(m => ({
      role: m.role,
      content: m.timestamp ? `[${formatMsgTime(m.timestamp)}] ${m.content}` : m.content,
    }));

  // Non-ward speakers are name-prefixed so multi-party rooms stay
  // legible to me across turns. The ward's own words stay raw, same
  // as the web chat.
  const userContent = decision.isWard ? content : `[${decision.speakerName}]: ${content}`;

  const apiMessages = [
    ...(systemContent ? [{ role: 'system', content: systemContent }] : []),
    ...history,
    ...(enriched.dynamic ? [{ role: 'system', content: enriched.dynamic }] : []),
    { role: 'user', content: userContent },
  ];

  const rawReply = await callChat({ conn, messages: apiMessages, settings });

  // Ambient 'llm' turn where I chose to stay quiet: accumulate the
  // message into the room (so the context is there next time) and send
  // nothing. No rate slot is spent and the turn isn't counted — the
  // cooldown already started when the dispatcher marked this attempt.
  // Both strategies can now return [pass] — code paces eligibility,
  // model still decides if this specific moment is worth speaking into.
  if (decision.ambient && isAmbientAbstain(rawReply)) {
    session.messages = [
      ...(session.messages ?? []),
      { id: randomUUID(), role: 'user', content: userContent, timestamp: nowIso, speaker: turnSpeaker, targets: msgTargets, namedMe: msgNamedMe },
    ];
    session.audienceTag = audienceTag;
    session.updatedAt   = new Date().toISOString();
    await writeSessionLog(session);
    await touchLocation(decision.locationKey, session.sessionId);
    console.log(`[discord] ambient abstain in ${decision.locationKey} — stayed quiet`);
    return;
  }

  // Ambient turn where I chose to revisit later rather than speak or drop.
  if (decision.ambient && isDeferToken(rawReply)) {
    const ms = parseDeferToken(rawReply);
    const existing = await readRevisits();
    await writeRevisits([
      ...existing.filter(r => r.locationKey !== decision.locationKey),
      { id: randomUUID(), locationKey: decision.locationKey, dueAt: Date.now() + ms, deferCount: 0, queuedAt: nowIso },
    ]);
    armRevisitTimer().catch(() => {});
    session.messages = [
      ...(session.messages ?? []),
      { id: randomUUID(), role: 'user', content: userContent, timestamp: nowIso, speaker: turnSpeaker, targets: msgTargets, namedMe: msgNamedMe },
    ];
    session.audienceTag = audienceTag;
    session.updatedAt   = new Date().toISOString();
    await writeSessionLog(session);
    await touchLocation(decision.locationKey, session.sessionId);
    console.log(`[discord] ambient defer in ${decision.locationKey} — revisit in ${Math.round(ms / 60_000)}min`);
    return;
  }

  // Pillar D filter → send → persist → rate slot → status, all shared with
  // the deferred-revisit path so neither can skip a step the other runs.
  await deliverReply(gw, {
    rawReply, audienceTag, apiMessages, conn, settings,
    channelId: msg.channel_id, session, locationKey: decision.locationKey, regLoc,
    priorMessages: [
      { id: randomUUID(), role: 'user', content: userContent, timestamp: nowIso, speaker: turnSpeaker, targets: msgTargets, namedMe: msgNamedMe },
    ],
  });
  console.log(`[discord] replied in ${decision.locationKey} (${decision.kind}, audience=${audienceTag})`);
}

// ── Gateway connection ────────────────────────────────────────────

const gw = {
  ws: null,
  config: { token: '', wardUserId: '' },
  running: false,           // supervisor wants us up
  connected: false,
  fatal: false,             // hit a non-recoverable close code; wait for config change
  botUserId: null,
  sessionId: null,
  resumeUrl: null,
  seq: null,
  heartbeatTimer: null,
  heartbeatAcked: true,
  reconnectAttempts: 0,
  reconnectTimer: null,
  supervisorTimer: null,
  status: { running: false, connected: false, botUser: null, lastError: null, lastEventAt: null, turns: 0, failures: 0 },
};

function clearTimers() {
  if (gw.heartbeatTimer) { clearInterval(gw.heartbeatTimer); gw.heartbeatTimer = null; }
  if (gw.reconnectTimer) { clearTimeout(gw.reconnectTimer); gw.reconnectTimer = null; }
}

function wsSend(payload) {
  try { gw.ws?.send(JSON.stringify(payload)); }
  catch (err) { console.error('[discord] ws send failed:', err?.message ?? err); }
}

function startHeartbeat(intervalMs) {
  clearInterval(gw.heartbeatTimer);
  gw.heartbeatAcked = true;
  // First beat jittered per the gateway spec.
  setTimeout(() => wsSend({ op: 1, d: gw.seq }), Math.floor(Math.random() * intervalMs)).unref?.();
  gw.heartbeatTimer = setInterval(() => {
    if (!gw.heartbeatAcked) {
      // Zombie connection: no ACK since our last beat. Tear down and resume.
      console.warn('[discord] heartbeat not acked — reconnecting');
      try { gw.ws?.close(4009); } catch { /* already gone */ }
      return;
    }
    gw.heartbeatAcked = false;
    wsSend({ op: 1, d: gw.seq });
  }, intervalMs);
  gw.heartbeatTimer.unref?.();
}

function identify() {
  wsSend({
    op: 2,
    d: {
      token: gw.config.token,
      intents: GATEWAY_INTENTS,
      properties: { os: 'linux', browser: 'proto-familiar', device: 'proto-familiar' },
    },
  });
}

function resume() {
  wsSend({ op: 6, d: { token: gw.config.token, session_id: gw.sessionId, seq: gw.seq } });
}

function scheduleReconnect() {
  if (!gw.running || gw.fatal || gw.reconnectTimer) return;
  const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** gw.reconnectAttempts);
  gw.reconnectAttempts += 1;
  console.log(`[discord] reconnecting in ${Math.round(delay / 1000)}s (attempt ${gw.reconnectAttempts})`);
  gw.reconnectTimer = setTimeout(() => {
    gw.reconnectTimer = null;
    connect().catch(err => {
      console.error('[discord] reconnect failed:', err?.message ?? err);
      gw.status.lastError = err?.message ?? String(err);
      scheduleReconnect();
    });
  }, delay);
  gw.reconnectTimer.unref?.();
}

function onDispatch(t, d) {
  gw.status.lastEventAt = new Date().toISOString();
  if (t === 'READY') {
    gw.botUserId = d.user?.id ?? null;
    gw.sessionId = d.session_id ?? null;
    gw.resumeUrl = d.resume_gateway_url ?? null;
    gw.connected = true;
    gw.status.connected = true;
    gw.status.botUser = d.user ? `${d.user.username} (${d.user.id})` : null;
    gw.reconnectAttempts = 0;
    console.log(`[discord] gateway READY as ${gw.status.botUser}`);
    // Re-arm any pending revisits on every successful connect — covers a
    // disable→enable cycle and a fresh boot alike, and guarantees the bot
    // token is populated before a revisit timer could fire.
    armRevisitTimer().catch(() => {});
    return;
  }
  if (t === 'RESUMED') {
    gw.connected = true;
    gw.status.connected = true;
    gw.reconnectAttempts = 0;
    console.log('[discord] gateway session resumed');
    return;
  }
  if (t === 'MESSAGE_CREATE') {
    // Everything below is wrapped: a bad turn logs and increments the
    // failure counter; it never tears the gateway down and can never
    // reach the web chat path.
    (async () => {
      try {
        const settings = readSettingsSync();
        const registry = await getRegistry();
        const decision = classifyMessage(d, {
          registry,
          botUserId: gw.botUserId,
          wardUserId: (settings.discordWardUserId ?? '').trim(),
        });
        // Knock capture: unregistered people who deliberately contacted
        // me (DMed, or @-mentioned me in a guild) get their identity
        // METADATA recorded — platform id + handle, never message
        // content — so the ward can register them with one click in the
        // Village editor instead of hunting IDs through Developer Mode.
        // Fire-and-forget; recording grants nothing.
        const isUnknownGuildSpeaker = decision.action === 'respond'
          && decision.kind === 'guild' && !decision.isWard && !decision.villager;
        if (decision.reason === 'unregistered-dm' || isUnknownGuildSpeaker) {
          recordKnock({
            platform: 'discord',
            id: d.author?.id,
            handle: d.author?.username,
            displayName: d.author?.global_name,
            context: d.guild_id ? 'guild' : 'dm',
            locationKey: discordLocationKey(d),
          }).catch(() => { /* best-effort */ });
        }

        // V8 lurk: read the room without replying.
        if (decision.action === 'observe') {
          recordGuildActivity(decision.locationKey);
          await enqueueTurn(decision.locationKey, () => observeMessage(gw, d, decision));
          return;
        }
        if (decision.action !== 'respond') return;

        // V8 active: an unprompted turn. Pace it (cooldown / activity
        // tier) before spending a turn; if it's not time, still take the
        // message into the room so context keeps accumulating.
        if (decision.ambient) {
          recordGuildActivity(decision.locationKey);
          const st = ambientFor(decision.locationKey);
          const gate = decideAmbientReply({
            strategy: decision.activeStrategy,
            lastTurnAt: st.lastTurnAt,
            recentMsgTimestamps: st.recentTs,
            cooldownMs: (decision.activeCooldownSec ?? DEFAULT_ACTIVE_COOLDOWN_SEC) * 1000,
          });
          if (!gate.act) {
            await enqueueTurn(decision.locationKey, () => observeMessage(gw, d, decision));
            return;
          }
          markAmbientTurn(decision.locationKey);
        }
        await enqueueTurn(decision.locationKey, () => handleTurn(gw, d, decision));
      } catch (err) {
        gw.status.failures += 1;
        gw.status.lastError = err?.message ?? String(err);
        console.error('[discord] turn failed:', err?.message ?? err);
      }
    })();
  }
}

async function connect() {
  if (!gw.running || gw.fatal) return;
  const WS = globalThis.WebSocket;
  if (typeof WS !== 'function') {
    gw.fatal = true;
    gw.status.lastError = 'WebSocket unavailable — Discord gateway requires Node ≥ 22';
    console.error('[discord] no global WebSocket (Node ≥ 22 required) — gateway stays down');
    return;
  }

  // Resume to the resume URL when we have a live session; otherwise
  // fetch the gateway URL (also validates the token before connecting).
  let url = gw.sessionId && gw.resumeUrl ? gw.resumeUrl : null;
  const resuming = !!url;
  if (!url) {
    const info = await discordRest(gw.config.token, '/gateway/bot');
    url = info?.url;
    if (!url) throw new Error('gateway URL missing from /gateway/bot');
  }

  const ws = new WS(`${url}?v=10&encoding=json`);
  gw.ws = ws;

  ws.onmessage = (ev) => {
    let payload;
    try { payload = JSON.parse(ev.data); } catch { return; }
    const { op, t, s, d } = payload;
    if (s != null) gw.seq = s;
    switch (op) {
      case 10: // HELLO
        startHeartbeat(d.heartbeat_interval);
        if (resuming) resume(); else identify();
        break;
      case 11: // HEARTBEAT_ACK
        gw.heartbeatAcked = true;
        break;
      case 1:  // server requests immediate heartbeat
        wsSend({ op: 1, d: gw.seq });
        break;
      case 7:  // RECONNECT — close and resume
        console.log('[discord] server requested reconnect');
        try { ws.close(4000); } catch { /* already gone */ }
        break;
      case 9:  // INVALID_SESSION — d=true means resumable
        console.warn(`[discord] invalid session (resumable: ${!!d})`);
        if (!d) { gw.sessionId = null; gw.resumeUrl = null; gw.seq = null; }
        try { ws.close(4000); } catch { /* already gone */ }
        break;
      case 0:  // DISPATCH
        try { onDispatch(t, d); }
        catch (err) { console.error('[discord] dispatch handler error:', err?.message ?? err); }
        break;
      default: break;
    }
  };

  ws.onclose = (ev) => {
    clearInterval(gw.heartbeatTimer); gw.heartbeatTimer = null;
    gw.connected = false;
    gw.status.connected = false;
    if (gw.ws === ws) gw.ws = null;
    if (FATAL_CLOSE_CODES.has(ev.code)) {
      gw.fatal = true;
      gw.status.lastError = `gateway closed with fatal code ${ev.code} (check bot token + privileged intents)`;
      console.error(`[discord] FATAL close ${ev.code} — check the bot token and that MESSAGE_CONTENT intent is enabled. Gateway stays down until settings change.`);
      return;
    }
    if (gw.running) {
      console.warn(`[discord] gateway closed (${ev.code ?? 'no code'}) — will reconnect`);
      scheduleReconnect();
    }
  };

  ws.onerror = (ev) => {
    const message = ev?.message ?? 'websocket error';
    gw.status.lastError = message;
    console.error('[discord] ws error:', message);
  };
}

// ── Supervisor (settings-driven lifecycle) ────────────────────────
//
// Every tick: compare desired state (env off-switch, settings toggle,
// token) with actual. Start when newly configured, stop when disabled,
// full restart when the token changed, retry after fatal once config
// changes. This makes the adapter self-healing without a settings-route
// hook — the ward edits Settings and the gateway follows within 30s.

function desiredConfig() {
  if (process.env.PROTO_FAMILIAR_DISCORD_DISABLED === '1') return null;
  const s = readSettingsSync();
  if (s.discordEnabled !== true) return null;
  const token = typeof s.discordBotToken === 'string' ? s.discordBotToken.trim() : '';
  if (!token) return null;
  return { token, wardUserId: typeof s.discordWardUserId === 'string' ? s.discordWardUserId.trim() : '' };
}

function teardown() {
  clearTimers();
  if (revisitTimer) { clearTimeout(revisitTimer); revisitTimer = null; }
  gw.running = false;
  gw.status.running = false;
  gw.connected = false;
  gw.status.connected = false;
  try { gw.ws?.close(1000); } catch { /* already gone */ }
  gw.ws = null;
  gw.sessionId = null;
  gw.resumeUrl = null;
  gw.seq = null;
  gw.reconnectAttempts = 0;
}

function superviseTick() {
  try {
    const want = desiredConfig();
    if (!want) {
      if (gw.running) {
        console.log('[discord] disabled (settings/env) — shutting gateway down');
        teardown();
      }
      return;
    }
    const tokenChanged = gw.config.token !== want.token;
    gw.config = want;
    if (tokenChanged && gw.running) {
      console.log('[discord] bot token changed — restarting gateway');
      teardown();
    }
    if (tokenChanged) gw.fatal = false; // new credentials → try again
    if (!gw.running) {
      gw.running = true;
      gw.status.running = true;
      connect().catch(err => {
        console.error('[discord] connect failed:', err?.message ?? err);
        gw.status.lastError = err?.message ?? String(err);
        scheduleReconnect();
      });
    }
  } catch (err) {
    console.error('[discord] supervisor tick failed:', err?.message ?? err);
  }
}

/**
 * Boot the Discord gateway supervisor. Safe to call when unconfigured —
 * it idles until the ward enables Discord in Settings. Never throws.
 */
export function startDiscordGateway() {
  if (gw.supervisorTimer) return;
  if (process.env.PROTO_FAMILIAR_DISCORD_DISABLED === '1') {
    console.log('[discord] hard-disabled via PROTO_FAMILIAR_DISCORD_DISABLED=1');
    return;
  }
  superviseTick();
  gw.supervisorTimer = setInterval(superviseTick, SUPERVISOR_TICK_MS);
  gw.supervisorTimer.unref?.();
  // Revisit timers are armed on READY (every successful connect), so the bot
  // token is guaranteed present before any revisit could fire.
  console.log('[discord] gateway supervisor started');
}

export function stopDiscordGateway() {
  if (gw.supervisorTimer) { clearInterval(gw.supervisorTimer); gw.supervisorTimer = null; }
  teardown();
}

/** Observability for /api/discord/status and the UI. */
export function getDiscordStatus() {
  return { ...gw.status };
}
