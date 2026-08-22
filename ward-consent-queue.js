/**
 * ward-consent-queue.js — the `!queue` command over the ward's Discord DM.
 *
 * The web UI surfaces a `[PENDING MEMORY CONSENT]` block: memory records I
 * heard but haven't kept, waiting for my human's yes/no (things from a group
 * room, or about a third person's private life). This gives my human that same
 * queue from Discord — a small menu to keep the ones I should remember and drop
 * the rest, one by one or all at once — the ward-facing twin of the villager
 * `!consent` menu.
 *
 * Pure functions here; the gateway wires the I/O (reading the queue, settling
 * via memory_confirm_consent / memory_drop_pending, pruning the queue file) and
 * gates the whole surface to the ward. No LLM call — a consent decision must be
 * exact, so it is code, not judgment.
 */
import { EMBED_COLOR, btn, row } from './discord-menu-kit.js';

export const QUEUE_CID = 'pfqueue';
export const QUEUE_PAGE_SIZE = 6;

/** Is this message the queue command? (leading `!queue`) */
export function isQueueCommand(text) {
  return /^\s*!queue\b/i.test(String(text ?? ''));
}

// Why each item needs a check-in rather than being kept on implied consent —
// mirrors the wording of the web [PENDING MEMORY CONSENT] block.
function whyFor(reason) {
  return reason === 'shared-room' ? 'from a group conversation'
    : reason === 'third-party' ? "about someone else's private life"
    : 'flagged for review';
}

const briefOf = (item, max = 120) => {
  const b = String(item?.brief ?? '').trim();
  return b.length > max ? b.slice(0, max - 1) + '…' : (b || '(no summary)');
};

// One item as a plain descriptive line (shared by the list and the text menu).
function itemLine(item) {
  const when = item?.date ? ` (from ${item.date})` : '';
  const kind = item?.standing ? ', a standing fact' : '';
  const cat  = item?.category ?? 'unknown category';
  return `About ${item?.villagerName || 'someone'}${when} [${cat}${kind}] — ${whyFor(item?.reason)}: ${briefOf(item)}`;
}

/** Home view: a page of the queue with a picker + keep-all / drop-all. */
export function buildQueueHomeView({ items = [], page = 0, note = '' } = {}) {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / QUEUE_PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = items.slice(p * QUEUE_PAGE_SIZE, (p + 1) * QUEUE_PAGE_SIZE);

  const listing = slice.length
    ? slice.map((it, i) => `**${p * QUEUE_PAGE_SIZE + i + 1}.** ${itemLine(it)}`).join('\n')
    : 'Nothing waiting for your OK right now.';

  const embed = {
    title: `Pending memory consent (${total})`,
    color: EMBED_COLOR,
    description:
      `${note ? note + '\n\n' : ''}` +
      `These are things I heard but haven't kept — from group rooms, or about someone else's private life. ` +
      `Anything you told me directly about yourself I already keep; I don't ask about those.\n\n` +
      `${listing}` +
      (pages > 1 ? `\n\n_Page ${p + 1} of ${pages}_` : ''),
    footer: { text: 'Pick one to keep or drop it, or keep/drop the whole queue.' },
  };

  const components = [];
  if (slice.length) {
    components.push(row({
      type: 3,
      custom_id: `${QUEUE_CID}:pick`,
      placeholder: 'Review one item…',
      options: slice.map((it, i) => ({
        label: `${p * QUEUE_PAGE_SIZE + i + 1}. ${briefOf(it, 90)}`.slice(0, 100),
        value: String(it.id),
        description: `${it.date ? it.date + ' · ' : ''}${it.category ?? ''}`.slice(0, 100) || undefined,
      })),
    }));
  }
  if (pages > 1) {
    components.push(row(
      btn(`${QUEUE_CID}:page:${p - 1}`, '‹ Newer', 2, p === 0),
      btn(`${QUEUE_CID}:page:${p + 1}`, 'Older ›', 2, p >= pages - 1),
    ));
  }
  components.push(row(
    btn(`${QUEUE_CID}:all:keep`, `Keep all (${total})`, 3, total === 0),
    btn(`${QUEUE_CID}:all:drop`, `Drop all (${total})`, 4, total === 0),
    btn(`${QUEUE_CID}:done`, 'Done', 1),
  ));
  return { embeds: [embed], components };
}

/** One item in full, with Keep / Drop / Back. */
export function buildQueueItemView({ item }) {
  if (!item) {
    return {
      embeds: [{ color: EMBED_COLOR, description: 'That item is no longer waiting — it may already be settled.' }],
      components: [row(btn(`${QUEUE_CID}:home`, '← Back to the queue', 2))],
    };
  }
  const when = item.date ? ` (from ${item.date})` : '';
  const kind = item.standing ? ', a standing fact' : '';
  return {
    embeds: [{
      title: 'Waiting for your OK',
      color: EMBED_COLOR,
      description:
        `About **${item.villagerName || 'someone'}**${when}\n` +
        `[${item.category ?? 'unknown category'}${kind}] — ${whyFor(item.reason)}\n\n` +
        `${briefOf(item, 500)}\n\n` +
        `**Keep it** — I'll remember this.\n**Drop it** — I let it go and won't keep it.`,
    }],
    components: [
      row(
        btn(`${QUEUE_CID}:set:${item.id}:keep`, 'Keep it', 3),
        btn(`${QUEUE_CID}:set:${item.id}:drop`, 'Drop it', 4),
        btn(`${QUEUE_CID}:home`, '← Back', 2),
      ),
    ],
  };
}

/** Closing view — controls removed. */
export function buildQueueDoneView() {
  return {
    embeds: [{
      title: 'Memory consent',
      color: EMBED_COLOR,
      description: 'All set. Type `!queue` any time to review what I\'m holding for your OK.',
    }],
    components: [],
  };
}

/** Plain-text fallback for when component sends fail (API/permissions). */
export function buildQueueText({ items = [] } = {}) {
  if (!items.length) return 'Nothing is waiting for your OK right now.';
  const lines = [`**Pending memory consent (${items.length})** — things I heard but haven't kept:`];
  for (const it of items.slice(0, 10)) lines.push(`• ${itemLine(it)}  [id: ${it.id}]`);
  if (items.length > 10) lines.push(`…and ${items.length - 10} more.`);
  lines.push('');
  lines.push('Open the menu with `!queue` to keep or drop them (or use the web app\'s Knowledge panel).');
  return lines.join('\n');
}
