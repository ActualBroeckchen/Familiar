/**
 * tome-macros.js — live macros for tome (lorebook) content, server-side.
 *
 * Tome entries can contain macros that resolve at injection time so the lore
 * always reflects the CURRENT state — the point of the self-documenting manual
 * tome: "Vision is currently turned {{visionActive}}." renders "on" or "off"
 * from the actual setting. This is the server resolver (Discord / voice turns);
 * the browser mirrors the same names in `applyNameVars` (public/app.js).
 *
 * ⚠️ PARITY: keep the macro NAMES here in sync with the mirror in app.js — a
 * classic browser script can't import this ESM module, so the two are
 * hand-maintained and a test pins the shared name set.
 *
 * "Active" is read from the ward-facing SETTING (not the deployment-level
 * `PROTO_FAMILIAR_*_DISABLED` env off-switches, which the browser can't see) —
 * so web and server agree, and the manual reflects the toggle the ward can flip.
 */
import { substituteMacros } from '../../macros.js';

const onoff = (v) => (v ? 'on' : 'off');

function activeModelName(s) {
  const conns = Array.isArray(s?.connections) ? s.connections : [];
  const primary = conns.find(c => c?.id === s?.primaryConnectionId);
  return primary?.name || primary?.model || 'not set';
}

// name → (settings) => replacement string. Booleans render on/off; values are
// plain strings. Defaults here MUST match the app.js state defaults
// (visionEnabled/ponderingEnabled/warmthEnabled/noticingEnabled default ON;
// voiceEnabled/discordEnabled/gcalEnabled/browseEnabled default OFF).
export const TOME_MACROS = {
  visionActive:    s => onoff(s?.visionEnabled    !== false),
  videoActive:     s => onoff(s?.videoEnabled     !== false),
  voiceActive:     s => onoff(s?.voiceEnabled     === true),
  discordActive:   s => onoff(s?.discordEnabled   === true),
  ponderingActive: s => onoff(s?.ponderingEnabled !== false),
  warmthActive:    s => onoff(s?.warmthEnabled    !== false),
  noticingActive:  s => onoff(s?.noticingEnabled  !== false),
  calendarActive:  s => onoff(s?.gcalEnabled      === true),
  browserActive:   s => onoff(s?.browseEnabled    === true),
  charName:        s => (s?.charName || 'the Familiar'),
  userName:        s => (s?.userName  || 'my human'),
  activeModel:     s => activeModelName(s),
  scanDepth:       s => String(s?.tomeScanDepth ?? 4),
};

/** The macro names, for the app.js parity test. */
export const TOME_MACRO_NAMES = Object.keys(TOME_MACROS);

/**
 * Resolve all tome macros in `text`. First {{user}}/{{char}} (shared name
 * boundary), then the live-settings macros. Unknown `{{tokens}}` are left
 * untouched. Never throws — a macro fn that throws yields ''.
 */
export function resolveTomeMacros(text, settings = {}) {
  let out = substituteMacros(String(text ?? ''), settings);
  for (const [name, fn] of Object.entries(TOME_MACROS)) {
    out = out.replace(new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'gi'), () => {
      try { return String(fn(settings) ?? ''); } catch { return ''; }
    });
  }
  return out;
}
