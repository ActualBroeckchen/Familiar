/**
 * discord-menu-kit.js — shared pure primitives for interactive Discord menus
 * (embeds + message components).
 *
 * The villager consent menu and the ward's own console menus (the pending
 * memory-consent queue, connection selection) all speak the same Discord
 * component idiom, so the builders live here once instead of each module
 * carrying its own copy (the no-copy-paste rule). Everything here is PURE —
 * the gateway does the I/O and answers interactions with UPDATE_MESSAGE.
 */

// The app's accent blue — every menu embed uses it so the surfaces read as one.
export const EMBED_COLOR = 0x89b4fa;

/** A button component. style: 1 primary, 2 secondary, 3 success, 4 danger. */
export const btn = (customId, label, style = 2, disabled = false) =>
  ({ type: 2, style, label, custom_id: customId, disabled });

/** An action row wrapping up to five components. */
export const row = (...components) => ({ type: 1, components });

/** The view shown when a control on a stale/expired message is clicked —
 *  controls stripped, a plain line telling the ward how to reopen it. */
export const expiredView = (reopenCmd) => ({
  embeds: [{ description: `That control has expired — type \`${reopenCmd}\` for a fresh menu.` }],
  components: [],
});
