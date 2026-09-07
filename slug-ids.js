/**
 * Shared readable-id helpers (the 0.8.x id overhaul) — Node side.
 *
 * Mirrors unruh/db.slug_id and phylactery/db.slug_id: model-facing ids are
 * short readable slugs instead of UUIDs, because the Familiar genuinely
 * reads these surfaces (session logs via list_files/read_file, the outbox
 * when asked about a relayed message, the deferred-intents block) and a
 * 36-char UUID costs ~16 tokens while carrying zero meaning.
 *
 * Old UUID/hex ids coexist forever — every consumer treats ids as opaque
 * strings; nothing parses shape (validators accept both).
 */

// Lookalike-free alphabet (no 0/O/1/l/i) — same as the Python services.
export const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function shortSlug(len = 6) {
  let s = '';
  for (let i = 0; i < len; i++) s += SLUG_ALPHABET[Math.floor(Math.random() * SLUG_ALPHABET.length)];
  return s;
}

/**
 * Session id: `s-YYYYMMDD-xxxx`. The date prefix is the point — session log
 * files are named `<id>.json`, and a Familiar listing `logs/` should be able
 * to READ which day each session was, instead of matching 36 opaque chars.
 */
export function sessionSlugId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `s-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${shortSlug(4)}`;
}

/**
 * Outbox item id: `<kind>-xxxxxx` ("reminder-x7k2m3", "relay-p4n8w2") — the
 * kind IS the context when the Familiar greps tomes/.outbox.json to answer
 * "did my message to X go out?".
 */
export function outboxSlugId(kind = 'item') {
  const base = String(kind || 'item').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
  return `${base}-${shortSlug(6)}`;
}

// Camera-noise filenames that carry no meaning to slugify (IMG_2043, PXL_…,
// DSC0001, Screenshot_…, a bare timestamp). We fall back to a generic slug
// rather than mint `img-2043` and pretend it's meaningful.
const CAMERA_NOISE = /^((img|pxl|dsc|photo|image|screenshot|capture)[-_ ]?[\d_\- ]+|screenshot[-_ ].*|[\d][\d_\- ]{5,})$/i;

/**
 * Turn a human label into slug words — lowercased, non-alphanumerics collapsed
 * to single hyphens, trimmed, and capped to the first `maxWords` content words
 * so a long caption doesn't become a 12-word id. Returns '' when there's
 * nothing meaningful left (empty, punctuation-only, or camera-noise filename).
 */
/**
 * The one slug transform every readable id shares: lowercase, non-alphanumeric
 * runs → single hyphen, edge hyphens trimmed. '' when nothing is left. The
 * callers add their own trims (word cap, length cap, first-line-only).
 */
export function slugCore(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function slugifyLabel(label, { maxWords = 4 } = {}) {
  let s = String(label ?? '').trim();
  if (!s) return '';
  // Drop a file extension before the noise check ("IMG_2043.jpg" → "img_2043").
  const noExt = s.replace(/\.[a-z0-9]{1,5}$/i, '');
  if (CAMERA_NOISE.test(noExt.trim())) return '';
  s = slugCore(noExt);
  if (!s) return '';
  return s.split('-').filter(Boolean).slice(0, maxWords).join('-');
}

/**
 * Meaning-bearing model-facing id: `slugify(label)-xx` (2-char suffix, the
 * Phylactery/Unruh `slug_id` pattern). When the label yields no meaningful
 * words, fall back to `<fallbackKind>-xxxxxx` so the id is still readable by
 * KIND even when nothing better exists. `suffixLen` grows on collision at the
 * call site (the insert_with_slug_retry discipline), so callers can pass a
 * larger value to widen the space.
 */
export function meaningSlugId(label, { fallbackKind = 'img', suffixLen = 2 } = {}) {
  const words = slugifyLabel(label);
  if (!words) return outboxSlugId(fallbackKind);
  return `${words}-${shortSlug(suffixLen)}`;
}

/** Old-style ids the converter re-keys: uuid4 hex (32) or dashed UUID (36). */
export function isLegacyId(id) {
  return typeof id === 'string' &&
    (/^[0-9a-f]{32}$/.test(id) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id));
}
