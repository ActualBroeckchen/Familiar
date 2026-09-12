/**
 * discord-gif-embeds.js — Tenor / Giphy "gifs" become watchable media.
 *
 * On Discord, the gifs people actually use are NOT file attachments — they're
 * picked from the Tenor/Giphy picker (or pasted as a tenor.com/giphy.com link),
 * and they arrive as an EMBED on the message, not in `attachments`. Discord
 * resolves each one into a `type: 'gifv'` embed and, crucially, serves the
 * motion as an **mp4** (`embed.video`), with a still poster in `embed.thumbnail`.
 *
 * So this reads those embeds and hands the gateway a media reference it can
 * ingest exactly like an attachment: the mp4 as a `video` (so a video-capable
 * model watches the motion, same as an uploaded animated gif), or the still
 * thumbnail as an `image` when video is off or the embed only has a poster.
 *
 * Pure parsing only — the gateway owns the fetch (reusing `fetchDiscordVideo` /
 * `fetchDiscordImage`), the audience gate, the caps, and `saveAsset`. Nothing
 * here reaches the network. Fail-soft: an embed we can't read yields nothing,
 * never an error.
 *
 * Off-switch: settings `discordGifEmbedsEnabled` (default ON) or
 * PROTO_FAMILIAR_DISCORD_GIF_EMBEDS_DISABLED=1.
 */

const GIF_HOSTS = /(^|\.)(tenor\.com|giphy\.com|gfycat\.com)$/i;
const MEDIA_EXT = /\.(mp4|webm|gif|png|jpe?g|webp)(\?|$)/i;

export function gifEmbedsDisabled(settings = {}) {
  return process.env.PROTO_FAMILIAR_DISCORD_GIF_EMBEDS_DISABLED === '1'
    || settings?.discordGifEmbedsEnabled === false;
}

function hostOf(u) {
  try { return new URL(u).hostname; } catch { return ''; }
}

/**
 * Is this embed a Tenor/Giphy-style animated gif (as opposed to a link preview
 * or article card we must NOT ingest as media)? The reliable marker is Discord's
 * own `type: 'gifv'`; a Tenor/Giphy provider name, a known gif host, or a direct
 * `.gif` link rendered as an image embed are the secondary signals. Pure.
 */
export function isGifEmbed(embed) {
  if (!embed || typeof embed !== 'object') return false;
  const type = String(embed.type || '').toLowerCase();
  const provider = String(embed.provider?.name || '').toLowerCase();
  if (type === 'gifv') return true;
  if (provider === 'tenor' || provider === 'giphy') return true;
  if (type === 'image' && (/\.gif(\?|$)/i.test(embed.url || '') || /\.gif(\?|$)/i.test(embed.thumbnail?.url || ''))) return true;
  if (GIF_HOSTS.test(hostOf(embed.url))) return true;
  return false;
}

/**
 * The URL to actually FETCH BYTES from for an embed media node
 * (`embed.video` / `embed.thumbnail`). Discord's `proxy_url` is the proxied
 * DIRECT media and is preferred; a bare `url` is used only when it points at a
 * media file (a `video.url` is sometimes the tenor PAGE, which would fetch as
 * HTML). Returns '' when there's nothing safely fetchable.
 */
export function directMediaUrl(node) {
  if (!node || typeof node !== 'object') return '';
  if (typeof node.proxy_url === 'string' && node.proxy_url) return node.proxy_url;
  const u = typeof node.url === 'string' ? node.url : '';
  return MEDIA_EXT.test(u) ? u : '';
}

/**
 * A best-effort human label from a Tenor/Giphy page URL — the descriptive slug
 * (`.../view/cat-flopping-over-gif-12345` → "cat flopping over"), used for the
 * asset's meaning-bearing slug and as a hint before any describe. Strips a
 * trailing `-gif-<id>` (Tenor) or a trailing mixed letter+digit id (Giphy),
 * never a real word. Returns '' when there's nothing meaningful. Pure.
 */
export function labelFromGifPage(pageUrl) {
  try {
    const seg = new URL(pageUrl).pathname.split('/').filter(Boolean).pop() || '';
    const s = decodeURIComponent(seg)
      .replace(/-gif-\d+$/i, '')                                   // tenor: …-gif-12345
      .replace(/-(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{6,}$/i, '') // giphy trailing id (has both letters+digits)
      .replace(/[-_]+/g, ' ')
      .trim();
    // A slug-less url leaves just the path word ("view"/"gifs"): no real label.
    if (/^(view|gifs?|media|embed)$/i.test(s)) return '';
    return s.length >= 2 ? s : '';
  } catch { return ''; }
}

/** A filename (with extension) for a media URL, so a missing content-type can fall back to the ext. Pure. */
export function mediaFilename(url, fallback) {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return MEDIA_EXT.test(seg) ? seg : fallback;
  } catch { return fallback; }
}

/** The one fetchable media reference for a gif embed, or null. */
export function gifEmbedMedia(embed) {
  if (!isGifEmbed(embed)) return null;
  const videoUrl = directMediaUrl(embed.video);
  const imageUrl = directMediaUrl(embed.thumbnail) || directMediaUrl(embed.image);
  if (!videoUrl && !imageUrl) return null;
  const dim = embed.video || embed.thumbnail || embed.image || {};
  return {
    videoUrl, imageUrl,
    page: typeof embed.url === 'string' ? embed.url : '',
    width: Number(dim.width) || null,
    height: Number(dim.height) || null,
  };
}

/**
 * Every distinct Tenor/Giphy gif in a message's embeds, deduped by media URL.
 * Returns [{ videoUrl, imageUrl, page, width, height }]. Pure — the caller
 * decides video-vs-frame and does the fetching.
 */
export function parseGifEmbeds(msg) {
  const embeds = Array.isArray(msg?.embeds) ? msg.embeds : [];
  const out = [];
  const seen = new Set();
  for (const e of embeds) {
    const m = gifEmbedMedia(e);
    if (!m) continue;
    const key = m.videoUrl || m.imageUrl;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}
