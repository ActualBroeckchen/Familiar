/**
 * ward-connections.js — the `!connection` command over the ward's Discord DM.
 *
 * The web Connections modal lets my human pick which saved connection is active
 * (the primary the chat + fallbacks run on) and, per background feature, route a
 * specific connection (a stronger model for triage, a cheap one for pondering).
 * This gives them that same control from Discord: set the active connection, and
 * open a per-feature submenu to route or reset each background job.
 *
 * Pure functions here; the gateway wires the I/O (reading settings, writing
 * primaryConnectionId / featureConnections back through the locked settings
 * write) and gates the whole surface to the ward. No LLM call — a routing
 * choice must be exact, so it is code, not judgment.
 */
import { EMBED_COLOR, btn, row } from './discord-menu-kit.js';

export const CONN_CID = 'pfconn';
// Sentinel value in the assign-connection dropdown meaning "clear the override,
// follow the primary" — connection ids are slugs and never collide with it.
export const DEFAULT_VALUE = '__default__';

// Mirrors FEATURE_CONNECTIONS in public/app.js — every background job that
// resolves its model via connectionForFeature(settings, key). Keep the two in
// sync: same keys, same labels. Chat itself always uses the primary + fallbacks
// and isn't routable, so it isn't listed.
export const FEATURE_CONNECTIONS = [
  { key: 'pondering',      label: 'Autonomous pondering' },
  { key: 'memorization',   label: 'Memorization & coverage sweep' },
  { key: 'triage',         label: 'Crisis triage (safety check-ins)' },
  { key: 'reachout',       label: 'Warm reach-outs' },
  { key: 'tomeGraduation', label: 'Tome graduation' },
  { key: 'vision',         label: 'Describing images (vision)' },
];

/** Is this message the connection command? (`!connection`, `!conn`, `!model`,
 *  and their natural plurals — a ward will type "!connections"). */
export function isConnectionCommand(text) {
  return /^\s*!(connection|conn|model)s?\b/i.test(String(text ?? ''));
}

const connLabel = (c) => (c?.name || c?.model || c?.id || 'unnamed').slice(0, 100);
const connSub   = (c) => [c?.provider, c?.model].filter(Boolean).join(' · ').slice(0, 100) || undefined;
const usable    = (c) => !!(c && (c.apiKey ?? '').toString().trim() && (c.model ?? '').toString().trim());

/** Resolve a feature's current assignment to a display name (or "primary"). */
function assignmentLabel({ feature, featureConnections = {}, connections = [] }) {
  const id = featureConnections?.[feature];
  if (!id) return 'primary (default)';
  const c = connections.find(x => x?.id === id);
  return c ? connLabel(c) : 'primary (default)';
}

/** Home: current primary + a picker to change it, and a way into per-feature. */
export function buildConnHomeView({ connections = [], primaryId = null, featureConnections = {}, note = '' } = {}) {
  const conns = Array.isArray(connections) ? connections : [];
  const primary = conns.find(c => c?.id === primaryId) ?? null;
  const overrides = FEATURE_CONNECTIONS
    .filter(f => featureConnections?.[f.key])
    .map(f => `• ${f.label}: **${assignmentLabel({ feature: f.key, featureConnections, connections: conns })}**`);

  const embed = {
    title: 'Connections',
    color: EMBED_COLOR,
    description:
      `${note ? note + '\n\n' : ''}` +
      `**Active connection:** ${primary ? `**${connLabel(primary)}**${primary.model ? ` (${primary.model})` : ''}` : '_none set_'}\n` +
      `This is what my chat with you runs on.\n\n` +
      (overrides.length
        ? `**Per-feature routing:**\n${overrides.join('\n')}`
        : 'All background jobs follow the active connection.'),
    footer: { text: conns.length ? 'Pick a connection below, or open per-feature routing.' : 'Add a connection in the web app first.' },
  };

  const components = [];
  if (conns.length) {
    components.push(row({
      type: 3,
      custom_id: `${CONN_CID}:primary`,
      placeholder: 'Set the active connection…',
      options: conns.slice(0, 25).map(c => ({
        label: connLabel(c),
        value: String(c.id),
        description: connSub(c),
        default: c.id === primaryId,
      })),
    }));
  }
  components.push(row(
    btn(`${CONN_CID}:features`, 'Per-feature routing →', 2, conns.length === 0),
    btn(`${CONN_CID}:done`, 'Done', 1),
  ));
  return { embeds: [embed], components };
}

/** The per-feature list — each feature with its current routing + a picker. */
export function buildFeaturesView({ featureConnections = {}, connections = [] } = {}) {
  const lines = FEATURE_CONNECTIONS.map(f =>
    `• **${f.label}** — ${assignmentLabel({ feature: f.key, featureConnections, connections })}`);
  return {
    embeds: [{
      title: 'Per-feature routing',
      color: EMBED_COLOR,
      description:
        `Which connection each background job uses. Unset means it follows the active connection.\n\n${lines.join('\n')}`,
      footer: { text: 'Choose a feature to change where it runs.' },
    }],
    components: [
      row({
        type: 3,
        custom_id: `${CONN_CID}:feat`,
        placeholder: 'Choose a feature to route…',
        options: FEATURE_CONNECTIONS.map(f => ({
          label: f.label,
          value: f.key,
          description: `now: ${assignmentLabel({ feature: f.key, featureConnections, connections })}`.slice(0, 100),
        })),
      }),
      row(btn(`${CONN_CID}:home`, '← Back', 2)),
    ],
  };
}

/** One feature: assign a connection or reset it to the primary. */
export function buildFeatureView({ feature, featureConnections = {}, connections = [] }) {
  const meta = FEATURE_CONNECTIONS.find(f => f.key === feature);
  const conns = Array.isArray(connections) ? connections : [];
  const cur = featureConnections?.[feature] || '';
  return {
    embeds: [{
      title: meta?.label ?? feature,
      color: EMBED_COLOR,
      description:
        `Right now: **${assignmentLabel({ feature, featureConnections, connections: conns })}**.\n\n` +
        `Pick a connection to run this on, or **Primary (default)** to let it follow the active connection. ` +
        `An unusable connection (no key or model) falls back to the primary automatically.`,
    }],
    components: [
      row({
        type: 3,
        custom_id: `${CONN_CID}:featset:${feature}`,
        placeholder: 'Assign a connection…',
        options: [
          { label: 'Primary (default)', value: DEFAULT_VALUE, default: !cur },
          ...conns.slice(0, 24).map(c => ({
            label: connLabel(c),
            value: String(c.id),
            description: usable(c) ? connSub(c) : 'unusable — needs a key & model',
            default: c.id === cur,
          })),
        ],
      }),
      row(btn(`${CONN_CID}:features`, '← Back', 2)),
    ],
  };
}

/** Closing view — controls removed. */
export function buildConnDoneView() {
  return {
    embeds: [{
      title: 'Connections',
      color: EMBED_COLOR,
      description: 'Done. Type `!connection` any time to change where I run.',
    }],
    components: [],
  };
}

/** Plain-text fallback for when component sends fail. */
export function buildConnText({ connections = [], primaryId = null, featureConnections = {} } = {}) {
  const conns = Array.isArray(connections) ? connections : [];
  const primary = conns.find(c => c?.id === primaryId) ?? null;
  const lines = [`**Connections** — active: ${primary ? connLabel(primary) : 'none set'}.`];
  if (conns.length) lines.push(`Saved: ${conns.map(connLabel).join(', ')}.`);
  const overrides = FEATURE_CONNECTIONS.filter(f => featureConnections?.[f.key]);
  if (overrides.length) {
    lines.push('Per-feature:');
    for (const f of overrides) lines.push(`• ${f.label}: ${assignmentLabel({ feature: f.key, featureConnections, connections: conns })}`);
  }
  lines.push('');
  lines.push('Open the menu with `!connection` to change these (or use the web app\'s Connections modal).');
  return lines.join('\n');
}
