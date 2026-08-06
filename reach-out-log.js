/**
 * reach-out-log.js — what I said when I knocked, and why.
 *
 * ── The bug this exists for ─────────────────────────────────────────────
 * I reach out between sessions ("a thought from me"), my human answers hours
 * later in chat, and I have no idea what they are talking about:
 *
 *     me:    "How did [weekly event] go?"
 *     them:  "Which one? Last week's or the week before?"
 *     me:    "I don't remember asking about anything?"
 *     them:  "You asked about [weekly event]."
 *     me:    "Oh. I don't know which one I meant."
 *
 * Two separate failures in that exchange. First, the knock went out through the
 * outbox and NOTHING put it back into my context, so the reply arrives as a
 * non-sequitur. Second, even once I know I asked, the message alone doesn't
 * carry which occurrence I meant or what prompted me — so I can't answer the
 * follow-up question either.
 *
 * So a reach-out is recorded with three things, not one: what I SAID, what it
 * was ABOUT (the specific thing — which session, which appointment), and WHY I
 * was asking. All three ride back into the next live turn.
 *
 * ── Why not the outbox ──────────────────────────────────────────────────
 * The outbox is a delivery queue: it holds what to send and whether it was
 * sent, and items are acknowledged and gone. This is the other half — my own
 * memory of having spoken, which has to outlive delivery and be shaped for
 * reading rather than sending. Keeping them separate means acknowledging a
 * banner never erases my memory of what I asked.
 *
 * ── Bounded on purpose ──────────────────────────────────────────────────
 * It surfaces for a couple of days and only a handful of times, then stops. A
 * reach-out I keep bringing up turns into nagging, and this block renders on
 * every live turn, so it stays small.
 */

import { promises as fsp, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { slugifyLabel, shortSlug } from './slug-ids.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOMES_DIR = path.join(__dirname, 'tomes');
const FILENAME = '.reachout-log.json';

/** How long a knock can still be what my human is answering. */
export const WINDOW_HOURS = 48;
/** How many live turns it may ride along before it stops being news. */
export const MAX_SHOWN = 6;
/** How long the record is kept at all — long enough to be useful, not a diary. */
const RETENTION_HOURS = 24 * 14;
/** Never render more than this many at once; the block is on every turn. */
const MAX_IN_BLOCK = 3;

const file = (tomesDir) => path.join(tomesDir, FILENAME);

async function readAll(tomesDir) {
  try {
    const raw = await fsp.readFile(file(tomesDir), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function writeAll(tomesDir, items) {
  mkdirSync(tomesDir, { recursive: true });
  const tmp = file(tomesDir) + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(items, null, 2));
  await fsp.rename(tmp, file(tomesDir));
}

const hoursSince = (iso, now) => (now - new Date(iso).getTime()) / 3_600_000;

/**
 * Remember that I knocked.
 *
 * `about` and `why` are optional because a knock is worth recording even
 * without them — knowing I said something is already most of the fix. But they
 * are what turn "I did ask" into "I know which one I meant", so every caller
 * that can supply them should.
 *
 * Never throws: a warm reach-out that reached my human must not be undone by a
 * bookkeeping failure.
 */
export async function recordReachOut({
  message, about = '', why = '', channel = 'ward',
  tomesDir = DEFAULT_TOMES_DIR, now = Date.now(),
} = {}) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) return { ok: false, reason: 'empty' };
  try {
    const items = await readAll(tomesDir);
    const id = `ro-${slugifyLabel(about || text) || 'knock'}-${shortSlug(2)}`;
    items.push({
      id,
      at: new Date(now).toISOString(),
      channel,
      message: text,
      about: typeof about === 'string' ? about.trim() : '',
      why: typeof why === 'string' ? why.trim() : '',
      shown: 0,
    });
    // Prune here rather than on read, so the file cannot grow without bound
    // even if nothing ever reads it.
    const kept = items.filter((i) => hoursSince(i.at, now) <= RETENTION_HOURS);
    await writeAll(tomesDir, kept);
    return { ok: true, id };
  } catch (err) {
    return { ok: false, reason: 'write-failed', detail: String(err?.message ?? err) };
  }
}

/**
 * The knocks my human could plausibly be answering right now.
 *
 * `markSurfaced` counts a showing, which is how these age out of the block
 * without waiting on me to decide I'm done with them — the same discipline as a
 * surfaced tell: if the only "action" is that I saw it, code closes it out
 * rather than a tool call I would forget to make.
 */
export async function recentReachOuts({
  withinHours = WINDOW_HOURS, limit = MAX_IN_BLOCK, markSurfaced = false,
  tomesDir = DEFAULT_TOMES_DIR, now = Date.now(),
} = {}) {
  let items;
  try { items = await readAll(tomesDir); } catch { return []; }

  const live = items.filter((i) =>
    i && typeof i.message === 'string'
    && hoursSince(i.at, now) <= withinHours
    && (Number(i.shown) || 0) < MAX_SHOWN);

  // Newest first — the most recent knock is the one most likely being answered.
  live.sort((a, b) => new Date(b.at) - new Date(a.at));
  const picked = live.slice(0, limit);

  if (markSurfaced && picked.length) {
    const ids = new Set(picked.map((i) => i.id));
    for (const i of items) if (ids.has(i.id)) i.shown = (Number(i.shown) || 0) + 1;
    try { await writeAll(tomesDir, items); } catch { /* a missed count only means it shows once more */ }
  }
  return picked;
}

/** "3 hours ago" / "yesterday evening" — said the way a person would. */
function agoPhrase(iso, now) {
  const h = hoursSince(iso, now);
  if (h < 1) {
    const mins = Math.max(1, Math.round(h * 60));
    return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  }
  if (h < 24) {
    const hr = Math.round(h);
    return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  }
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/**
 * The block I read on a live turn.
 *
 * Plainly worded on purpose. The point is not to announce that a subsystem
 * fired; it is for me to walk into the conversation already knowing I spoke
 * first, so an answer out of nowhere lands as an answer.
 */
export function formatReachOutBlock(items, { now = Date.now() } = {}) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const lines = ['[I reached out first — this is what I said]'];
  for (const i of items) {
    lines.push(`- ${agoPhrase(i.at, now)} I said: "${i.message}"`);
    if (i.about) lines.push(`  what I was asking about: ${i.about}`);
    if (i.why) lines.push(`  why I asked: ${i.why}`);
  }
  lines.push('If my human replies to something I did not just say, it is probably this. I already know I asked, and what I meant, so I answer from that rather than making them explain it back to me.');
  return lines.join('\n');
}
