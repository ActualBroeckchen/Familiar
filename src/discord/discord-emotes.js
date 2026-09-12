/**
 * discord-emotes.js — custom Discord emotes become readable alt-text.
 *
 * A custom emote arrives in message content as `<:name:id>` (static) or
 * `<a:name:id>` (animated) — an opaque token the Familiar can't read. This
 * views each custom emote through my vision ONCE, caches the description by its
 * emote id, and rewrites the token so I read a tired cat as a tired cat:
 *
 *   <:tiredcat:123>  →  :tiredcat: [= a very tired-looking cat]
 *
 * Until an emote has been described, it degrades to the plain `:name:` shorthand
 * (still readable), and the description lands for the next time it's used —
 * "viewed once, then saved," never blocking a turn on a vision call.
 *
 * Reuse, not reinvention: the describe rides the existing media pipeline
 * (`saveAsset` + `describeAsset`), so it inherits content-dedup, the
 * injection-guard on the description, the z.ai-coding routing, and the
 * describe-once cache for free. This module only fetches the emote image, keeps
 * the `emote-id → description` map for the text rewrite, and owns the parsing.
 *
 * Unicode emoji (😺) need none of this — the model reads them directly. Only
 * CUSTOM emotes (the `<:name:id>` tokens) are handled here.
 *
 * Off-switch: settings `discordEmotesEnabled` (default ON) or
 * PROTO_FAMILIAR_DISCORD_EMOTES_DISABLED=1. Fail-soft everywhere — a fetch or
 * describe failure leaves the plain `:name:` shorthand, never breaks a turn.
 */

import path from 'path';
import { promises as fsp } from 'fs';
import { REPO_ROOT } from '../../repo-root.js';

const EMOTES_FILE = path.join(REPO_ROOT, 'tomes', '.discord-emotes.json');

// <:name:id> (static) or <a:name:id> (animated). Emote names are 2–32 word
// chars; ids are Discord snowflakes (long digit runs). Global + case-sensitive.
const EMOTE_RE = /<(a)?:([A-Za-z0-9_]{2,32}):(\d{5,25})>/g;

const MAX_EMOTE_BYTES = 512 * 1024;   // a custom emote is tiny; cap defensively.

export function emotesDisabled(settings = {}) {
  return process.env.PROTO_FAMILIAR_DISCORD_EMOTES_DISABLED === '1'
    || settings?.discordEmotesEnabled === false;
}

/**
 * The distinct custom emotes in a message's text. Pure. Deduped by id (a message
 * spamming the same emote yields one entry). Returns [{ raw, animated, name, id }].
 */
export function parseEmotes(content) {
  const out = [];
  if (typeof content !== 'string' || !content) return out;
  const seen = new Set();
  for (const m of content.matchAll(EMOTE_RE)) {
    const id = m[3];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ raw: m[0], animated: !!m[1], name: m[2], id });
  }
  return out;
}

/** The Discord CDN URL for an emote image. Animated → gif, static → png. Pure. */
export function emoteCdnUrl(id, animated = false, { size = 64 } = {}) {
  const ext = animated ? 'gif' : 'png';
  return `https://cdn.discordapp.com/emojis/${encodeURIComponent(String(id))}.${ext}?size=${size}`;
}

/**
 * Rewrite emote tokens in text so the model reads them. A described emote
 * becomes `:name: [= description]`; an as-yet-undescribed one becomes the plain
 * `:name:` shorthand. Pure given the cache map ({ [id]: { description } }).
 */
export function rewriteEmotes(content, cache = {}) {
  if (typeof content !== 'string' || !content) return content;
  return content.replace(EMOTE_RE, (_raw, _animated, name, id) => {
    const desc = cache?.[id]?.description;
    return desc ? `:${name}: [= ${desc}]` : `:${name}:`;
  });
}

// ── The persisted emote-id → { name, assetId, description } cache ─────

export async function readEmoteCache(file = EMOTES_FILE) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

async function writeEmoteCache(cache, file = EMOTES_FILE) {
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
    await fsp.rename(tmp, file);
  } catch { /* the cache is advisory — a failed write just re-describes next time */ }
}

/** Fetch one emote image, bounded by a timeout + byte cap. Returns {buffer,mime}|null. */
export async function fetchEmoteImage(emote, { fetchFn = fetch, timeoutMs = 8000 } = {}) {
  try {
    const url = emoteCdnUrl(emote.id, emote.animated);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try { res = await fetchFn(url, { signal: ac.signal }); }
    finally { clearTimeout(timer); }
    if (!res?.ok) return null;
    const mime = (res.headers?.get?.('content-type') || (emote.animated ? 'image/gif' : 'image/png')).split(';')[0].trim();
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_EMOTE_BYTES) return null;
    return { buffer: buf, mime };
  } catch { return null; }
}

/**
 * View + cache the description of each not-yet-described emote, ONCE. The caller
 * AWAITS this before assembling the turn (bounded, so a slow describe can't hang
 * it) — mirroring `ensureDescribed` for images — so the FIRST message carrying a
 * new emote already reads its alt-text, not a bare `:name:`. Cached forever after
 * (the media store + this map), so only a brand-new emote ever pays the describe.
 *
 * Each emote's bytes ride the shared media pipeline (`saveAsset` →
 * `describeAsset`), inheriting content-dedup, the injection-guard on the
 * description, z.ai-coding routing, and the describe-once cache; this only keeps
 * the id → description map the text rewrite reads. Deps injected for tests.
 *
 * Observable, not silent (CLAUDE.md: failures that matter are observable): every
 * describe outcome — success, or the reason it produced nothing — is logged, so a
 * "why don't my emotes get described" is answerable from the logs instead of a
 * dead `catch {}`. Never throws; a failure leaves the plain `:name:` shorthand.
 */
export async function describeUnseenEmotes(emotes, {
  settings = {}, cacheFile = EMOTES_FILE,
  fetchEmote = fetchEmoteImage, saveAsset, describeAsset,
  max = 6, timeoutMs = 20000, log = console,
} = {}) {
  if (!Array.isArray(emotes) || !emotes.length) return;
  if (typeof saveAsset !== 'function' || typeof describeAsset !== 'function') {
    log?.warn?.('[discord-emotes] describe skipped — media pipeline unavailable');
    return;
  }
  const cache = await readEmoteCache(cacheFile);
  const todo = emotes.filter(e => !cache[e.id]?.description).slice(0, max);
  let changed = false;
  for (const e of todo) {
    try {
      const got = await fetchEmote(e, { settings });
      if (!got?.buffer) { log?.warn?.(`[discord-emotes] :${e.name}: (${e.id}) — image fetch failed; leaving bare shorthand`); continue; }
      const meta = await saveAsset({
        buffer: got.buffer, mime: got.mime,
        origin: { surface: 'discord-emote', speaker: null },
        audienceTag: 'ward-private',
        label: `:${e.name}:`,
      });
      const assetId = meta?.slugs?.[0] ?? meta?.id;
      if (!assetId) { log?.warn?.(`[discord-emotes] :${e.name}: — saveAsset returned no id`); continue; }
      // Bound the describe so a slow/hung vision call never stalls the turn; a
      // timeout leaves it bare this turn and it retries next time (uncached). The
      // timer is cleared + unref'd on the winning branch — an uncleared race timer
      // leaks the event loop (the 25s test-hang lesson).
      let timer;
      const desc = await Promise.race([
        Promise.resolve(describeAsset(assetId, settings)).then((r) => { clearTimeout(timer); return r; }),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, reason: 'describe-timeout' }), timeoutMs); timer.unref?.(); }),
      ]);
      const text = desc?.description?.text
        ?? (typeof desc?.description === 'string' ? desc.description : null);
      if (!text) {
        // The most useful line for "why don't emotes work": the describe ran but
        // produced nothing — usually no vision connection assigned, or a reject.
        log?.warn?.(`[discord-emotes] :${e.name}: not described (${desc?.reason ?? 'no description returned'}) — is a vision connection configured?`);
        continue;
      }
      cache[e.id] = { name: e.name, assetId, description: text, at: new Date().toISOString() };
      changed = true;
      log?.log?.(`[discord-emotes] described :${e.name}: → "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`);
    } catch (err) {
      log?.warn?.(`[discord-emotes] :${e.name}: describe threw (${err?.message ?? err}) — leaving bare shorthand`);
    }
  }
  if (changed) await writeEmoteCache(cache, cacheFile);
}
