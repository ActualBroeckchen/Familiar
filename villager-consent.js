/**
 * Villager consent self-service — the `!consent` command over Discord DM.
 *
 * The consent model's original intent: "ask" means ask the PERSON the fact
 * is about, not only my human — my human already has full access and
 * control through the UI. This module gives every registered villager a
 * small menu about THEMSELVES: what I remember about them, what I'm
 * holding pending review, and their own per-category consent settings —
 * which they can change directly.
 *
 * Privacy spine:
 *  - Only a REGISTERED villager, in their own DM, about THEMSELVES.
 *    (Strangers' DMs never reach this code — the router ignores them.)
 *  - Shown facts are ones where they are a recorded subject; briefs only.
 *  - Their changes touch only their own remember map, are audit-logged
 *    (discord-writes), and are visible to my human in the Village UI —
 *    no covert state changes in either direction.
 *
 * Pure functions here; the gateway wires I/O. No LLM call anywhere — a
 * consent menu must be exact, so it is code, not judgment.
 */
import { REMEMBER_CATEGORIES, setVillagerRemember, standingConsentActive } from './village.js';
import { EMBED_COLOR, btn, row } from './discord-menu-kit.js';

// Plain-language names per category — shown in the menu and accepted as
// command aliases alongside the raw keys.
export const CATEGORY_LABELS = {
  basics:            'basics (name, everyday facts)',
  emotional_content: 'feelings (moods, emotional moments)',
  health_info:       'health',
  relationships:     'relationships',
  whereabouts:       'whereabouts (places, travel)',
};
const CATEGORY_ALIASES = {
  basics: 'basics', feelings: 'emotional_content', emotions: 'emotional_content',
  emotional_content: 'emotional_content', health: 'health_info', health_info: 'health_info',
  relationships: 'relationships', whereabouts: 'whereabouts', places: 'whereabouts',
};
const GATE_WORDS = { keep: true, ask: 'ask', never: false };

/** Is this message the consent command at all? (leading `!consent`) */
export function isConsentCommand(text) {
  return /^\s*!consent\b/i.test(String(text ?? ''));
}

/**
 * Parse a `!consent …` message.
 * Returns { action:'menu' } | { action:'set', gate, categories:[…] } |
 * { action:'help', error? }.
 */
export function parseConsentCommand(text) {
  const t = String(text ?? '').trim();
  if (!isConsentCommand(t)) return null;
  const rest = t.replace(/^\s*!consent\b/i, '').trim();
  if (!rest) return { action: 'menu' };
  const [word, ...catWords] = rest.split(/\s+/);
  const gate = GATE_WORDS[word.toLowerCase()];
  if (gate === undefined) {
    return { action: 'help', error: `I don't know "${word}".` };
  }
  if (!catWords.length) return { action: 'help', error: `"${word}" needs a category (or "all").` };
  if (catWords.length === 1 && catWords[0].toLowerCase() === 'all') {
    return { action: 'set', gate, categories: [...REMEMBER_CATEGORIES] };
  }
  const categories = [];
  for (const w of catWords) {
    const cat = CATEGORY_ALIASES[w.toLowerCase()];
    if (!cat) return { action: 'help', error: `I don't have a "${w}" category.` };
    if (!categories.includes(cat)) categories.push(cat);
  }
  return { action: 'set', gate, categories };
}

const gateWord = (v) => v === true ? 'keep' : v === false ? 'never' : 'ask';

/**
 * The menu text — first person, plain, and complete: what I hold, what's
 * pending, their settings, and how to change them. All inputs are
 * pre-fetched by the caller so this stays pure.
 */
export function buildConsentMenu({ villager, memories = [], pending = [] }) {
  const lines = [];
  lines.push(`Hi ${villager.name} — this is everything I hold about you, and your say over it.`);
  lines.push('');

  if (memories.length) {
    lines.push(`**What I remember about you** (${memories.length}${memories.length >= 50 ? '+' : ''}):`);
    for (const m of memories.slice(0, 8)) {
      lines.push(`• ${m.date ? `[${m.date}] ` : ''}${m.brief}${m.brief?.length >= 160 ? '…' : ''}`);
    }
    if (memories.length > 8) lines.push(`…and ${memories.length - 8} more.`);
  } else {
    lines.push(`**What I remember about you:** nothing right now.`);
  }
  lines.push('');

  if (pending.length) {
    lines.push(`**Waiting for a yes/no** (${pending.length}) — things I heard but haven't kept:`);
    for (const p of pending.slice(0, 5)) {
      lines.push(`• ${p.date ? `[${p.date}] ` : ''}${p.brief}`);
    }
    if (pending.length > 5) lines.push(`…and ${pending.length - 5} more.`);
  } else {
    lines.push(`**Waiting for a yes/no:** nothing pending about you.`);
  }
  lines.push('');

  lines.push('**Your settings** — per kind of thing, what I do when I hear it:');
  const rem = villager.remember ?? {};
  for (const cat of REMEMBER_CATEGORIES) {
    lines.push(`• ${CATEGORY_LABELS[cat]}: **${gateWord(rem[cat] ?? 'ask')}**`);
  }
  if (standingConsentActive(villager)) {
    lines.push('• standing consent: **active** — you\'ve told me to use my judgment for now.');
  }
  lines.push('');
  lines.push('**To change:** `!consent keep|ask|never <category|all>` — e.g. `!consent never health`, `!consent keep all`.');
  lines.push('_keep_ = I may remember it · _ask_ = I check with you first · _never_ = I drop it.');
  return lines.join('\n');
}

/**
 * Apply a parsed `set` command to the villager's own remember map.
 * Returns the confirmation text. Throws on unknown villager (caller
 * surfaces a plain error).
 */
export async function applyConsentSet({ villagerId, gate, categories }) {
  const patch = {};
  for (const cat of categories) patch[cat] = gate;
  await setVillagerRemember(villagerId, patch);
  const names = categories.map(c => CATEGORY_LABELS[c].split(' (')[0]).join(', ');
  const verb = gate === true
    ? 'I\'ll remember these without asking'
    : gate === false
      ? 'I\'ll drop these when I hear them — and I won\'t keep new ones'
      : 'I\'ll check with you before keeping any of these';
  return `Done — ${names}: **${gateWord(gate)}**. ${verb}. (\`!consent\` shows the full picture.)`;
}

export function consentHelpText(error) {
  return `${error ? error + ' ' : ''}I understand: \`!consent\` (the menu), or \`!consent keep|ask|never <category|all>\`. Categories: ${Object.values(CATEGORY_LABELS).map(l => l.split(' (')[0]).join(', ')}.`;
}


// ── Visual menu (Discord message components) ─────────────────────
//
// The same consent surface as the text commands, as an embed + dropdown
// + buttons (the pattern the ward screenshotted). All builders are PURE —
// the gateway does the I/O and answers interactions with UPDATE_MESSAGE,
// so one message morphs between views instead of flooding the DM.
// custom_ids are namespaced `pfconsent:…`; the gateway re-resolves the
// interacting USER to a villager on every click (identity is never
// trusted from a custom_id).

export const CONSENT_CID = 'pfconsent';
// EMBED_COLOR, btn, row now come from discord-menu-kit.js (shared with the
// ward console menus) so there's one copy of the component idiom.

const shortCat = (cat) => CATEGORY_LABELS[cat].split(' (')[0];

/** Home view: settings at a glance + a dropdown to change one + browse buttons. */
export function buildConsentHomeView({ villager, memCount = 0, pendingCount = 0, note = '' }) {
  const rem = villager.remember ?? {};
  const gateWordFor = (cat) => rem[cat] === true ? 'keep' : rem[cat] === false ? 'never' : 'ask';
  const lines = REMEMBER_CATEGORIES.map(cat => `• **${shortCat(cat)}** — ${gateWordFor(cat)}`);
  const embed = {
    title: 'Your memory & consent',
    color: EMBED_COLOR,
    description:
      `${note ? note + '\n\n' : ''}` +
      `Hi ${villager.name} — what I keep about you is your call.\n\n` +
      `**Your settings** (what I do when I hear something about you):\n${lines.join('\n')}\n\n` +
      `_keep_ = I may remember it · _ask_ = I check with you first · _never_ = I drop it.` +
      (standingConsentActive(villager) ? '\n\nStanding consent is **active** — you\'ve told me to use my judgment for now.' : ''),
    footer: { text: 'Also works as text: !consent keep|ask|never <category|all>' },
  };
  const select = {
    type: 3,
    custom_id: `${CONSENT_CID}:cat`,
    placeholder: 'Change a setting…',
    options: REMEMBER_CATEGORIES.map(cat => ({
      label: shortCat(cat),
      value: cat,
      description: `currently: ${gateWordFor(cat)}`,
    })),
  };
  return {
    embeds: [embed],
    components: [
      row(select),
      row(
        btn(`${CONSENT_CID}:mem:0`, `What I remember (${memCount})`, 2, memCount === 0),
        btn(`${CONSENT_CID}:pending`, `Waiting for review (${pendingCount})`, 2, pendingCount === 0),
        btn(`${CONSENT_CID}:done`, 'Done', 1),
      ),
    ],
  };
}

/** One category: what it covers, the three choices as buttons. */
export function buildCategoryView({ villager, category }) {
  const cur = (villager.remember ?? {})[category];
  const curWord = cur === true ? 'keep' : cur === false ? 'never' : 'ask';
  return {
    embeds: [{
      title: shortCat(category),
      color: EMBED_COLOR,
      description:
        `${CATEGORY_LABELS[category]}\n\nRight now: **${curWord}**.\n\n` +
        `**keep** — I may remember these without asking.\n` +
        `**ask first** — I check with you before keeping one.\n` +
        `**never** — I drop them; nothing new is kept.\n\n` +
        `Choosing keep or never also settles anything already waiting for review in this category.`,
    }],
    components: [
      row(
        btn(`${CONSENT_CID}:set:${category}:keep`, 'Keep', 3),
        btn(`${CONSENT_CID}:set:${category}:ask`, 'Ask first', 2),
        btn(`${CONSENT_CID}:set:${category}:never`, 'Never', 4),
      ),
      row(btn(`${CONSENT_CID}:home`, '← Back', 2)),
    ],
  };
}

const MEM_PAGE_SIZE = 6;

/** Kept-memories browser, paginated. */
export function buildMemoriesView({ memories = [], page = 0 }) {
  const pages = Math.max(1, Math.ceil(memories.length / MEM_PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = memories.slice(p * MEM_PAGE_SIZE, (p + 1) * MEM_PAGE_SIZE);
  return {
    embeds: [{
      title: `What I remember about you (${memories.length})`,
      color: EMBED_COLOR,
      description: slice.length
        ? slice.map(m => `• ${m.date ? `\`${m.date}\` ` : ''}${m.brief}`).join('\n')
        : 'Nothing right now.',
      footer: pages > 1 ? { text: `Page ${p + 1} of ${pages}` } : undefined,
    }],
    components: [
      row(
        btn(`${CONSENT_CID}:mem:${p - 1}`, '‹ Newer', 2, p === 0),
        btn(`${CONSENT_CID}:mem:${p + 1}`, 'Older ›', 2, p >= pages - 1),
        btn(`${CONSENT_CID}:home`, '← Back', 2),
      ),
    ],
  };
}

/** Pending-review browser with the settle-all actions. */
export function buildPendingView({ pending = [] }) {
  const slice = pending.slice(0, 8);
  return {
    embeds: [{
      title: `Waiting for your yes/no (${pending.length})`,
      color: EMBED_COLOR,
      description: (slice.length
        ? slice.map(pd => `• ${pd.date ? `\`${pd.date}\` ` : ''}${pd.brief}`).join('\n')
          + (pending.length > slice.length ? `\n…and ${pending.length - slice.length} more.` : '')
        : 'Nothing pending about you.')
        + '\n\nThese are things I heard but have NOT kept. Keep all, drop all, or leave them for one-by-one asks.',
    }],
    components: [
      row(
        btn(`${CONSENT_CID}:pendall:keep`, `Keep all (${pending.length})`, 3, pending.length === 0),
        btn(`${CONSENT_CID}:pendall:drop`, `Drop all (${pending.length})`, 4, pending.length === 0),
        btn(`${CONSENT_CID}:home`, '← Back', 2),
      ),
    ],
  };
}

/** Closing view: controls removed, a plain summary left behind. */
export function buildDoneView({ villager }) {
  return {
    embeds: [{
      title: 'Your memory & consent',
      color: EMBED_COLOR,
      description: `All set, ${villager.name}. Type \`!consent\` any time to open this again.`,
    }],
    components: [],
  };
}
