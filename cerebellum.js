/**
 * Cerebellum — the motor counterpart to Thalamus.
 *
 * Thalamus owns everything flowing INWARD (identity, memory, graph,
 * temporal context: plural MCP peers, parallel fan-out, independent
 * degradation). Cerebellum owns everything flowing OUTWARD: the
 * Familiar's actions and deliveries — triage deliberation, trusted-
 * contact escalation, and (as of the efferent refactor) tool dispatch
 * and channel delivery.
 *
 * Boundary with Thalamus (do not blur):
 *   - Thalamus = perception. It assembles context. It never executes
 *     actions.
 *   - Cerebellum = action. It executes tools and delivers messages.
 *     It never assembles prompt context.
 *   - Shared nervous system: Thalamus owns the MCP client connections
 *     to Phylactery and Unruh. Cerebellum NEVER opens its own — every
 *     write to identity / memory / temporal state goes through
 *     thalamus.js's exported wrappers, which are the single enforcement
 *     point for "direct writes MUST go through Phylactery's MCP."
 *
 * What does NOT live here: the autonomous loops (pondering, reminders
 * scan, silence triage). They are initiators; when a loop decides
 * something should reach the human or a contact, it hands delivery to
 * cerebellum instead of doing it inline.
 *
 * Safety note: this file contains the highest-stakes code paths in the
 * system (escalation deadlines, trusted-contact delivery, the triage
 * deliberation prompt). Behavioral changes here — not relocations, not
 * comments — require explicitly asking the human before shipping. If a
 * change alters when or whether the Familiar can act on a human's
 * safety — STOP and ask.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsp, readFileSync, mkdirSync } from 'fs';

import { PROVIDER_URLS } from './providers.js';
import { listOwnFiles, readOwnFile } from './own-files.js';
import {
  enrich, getScheduleWindow,
  // Tool-executor writes — ALWAYS through thalamus's wrappers, never a
  // second MCP connection (single enforcement point; see header).
  createMemory, appendIdentity,
  updateMemory, deleteMemory, rewriteIdentitySection,
  listMemories, readMemory, readMemoryById, moveMemoryDate, updateMemoryById, deleteMemoryById,
  searchGraphNodes, getGraphSubgraph,
  createGraphNode, createGraphEdge,
  updateGraphNode, deleteGraphNode, updateGraphEdge, deleteGraphEdge,
  addScheduleNode, updateScheduleNode, resolveScheduleNode, resolveScheduleOccurrence, deleteScheduleNode,
  addScheduleEdge, upsertScheduleState, exportSchedule, getScheduleNode,
  bumpInterest, setStandingInterest,
  confirmConsentMemories, dropPendingMemories,
  acknowledgeGraduations,
  searchMemoryRestricted, searchMemory,
} from './thalamus.js';
import { audienceTagFor, deriveNodeAudience } from './audience.js';
import { GRAPH_ENTITY_TYPES_STR, GRAPH_NODE_RUBRIC, GRAPH_EDGE_RUBRIC } from './graph-vocab.js';
import { searchWeb, readWebpage, lookUp } from './websearch.js';
import { stripLlmTimestamps } from './message-sanitize.mjs';
import { markIntentActedOn, snoozeIntent } from './recent-ponderings.js';
import { pruneConsentPending } from './memorization.js';
import { enqueueOutbox, listOutbox, updateOutboxMeta } from './outbox.js';
import { buildTimeAnchorBlock, relativeTime, plainInterval } from './relative-time.js';
import { substituteMacros } from './macros.js';
import { selectSurfaceCandidates } from './surface-context.js';
import { pushIcsViaCli, resolveWriteCommand } from './gcal-source.js';
import {
  readToken as readGoogleToken, writeToken as writeGoogleToken,
  getFreshAccessToken as getGoogleAccessToken, buildEventResource, insertEvent as insertGoogleEvent,
  isConnected as googleConnected,
} from './gcal-google.js';
import { getRecentOfferInfo } from './surface-events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Settings access ──────────────────────────────────────────────
// settings.json is the centralised user-preference store (see the
// /api/settings routes in server.js). Cerebellum reads it for the
// primary LLM connection (triage deliberation) and the trusted-contact
// list (escalation delivery). server.js imports these from here so
// there is exactly one reader implementation.

const SETTINGS_FILE = path.join(__dirname, 'settings.json');

export function readSettingsSync() {
  try { return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return {}; }
}

export function primaryConnectionFrom(settings) {
  const id    = settings?.primaryConnectionId;
  const conns = Array.isArray(settings?.connections) ? settings.connections : [];
  return conns.find(c => c?.id === id) ?? null;
}

// ── Triage event log ─────────────────────────────────────────────
// Persistent log for all triage decisions — survives outbox
// acknowledgement so past reach-outs are always visible for debugging
// and review. server.js's /api/triage-events route reads it via
// readTriageEvents().

const LOGS_DIR = path.join(__dirname, 'logs');
mkdirSync(LOGS_DIR, { recursive: true });

export const TRIAGE_LOG_FILE = path.join(LOGS_DIR, 'triage-events.jsonl');

export async function appendTriageEventLog(entry) {
  try {
    await fsp.appendFile(
      TRIAGE_LOG_FILE,
      JSON.stringify({ ...entry, loggedAt: new Date().toISOString() }) + '\n',
      'utf8',
    );
  } catch { /* non-critical */ }
}

// Newest first. Tolerates a missing or partially corrupt log file.
export async function readTriageEvents() {
  try {
    const raw   = await fsp.readFile(TRIAGE_LOG_FILE, 'utf8');
    const lines  = raw.split('\n').filter(l => l.trim());
    return lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}

// Read the last N user/assistant messages from the most recently updated
// session log file. Used by decideTriageViaLLM to ground the triage
// prompt in what was actually being discussed before the silence.
export async function getRecentSessionMessages({ limit = 8 } = {}) {
  try {
    const files = (await fsp.readdir(LOGS_DIR)).filter(f => f.endsWith('.json'));
    if (!files.length) return [];
    const stats = await Promise.all(
      files.map(f => fsp.stat(path.join(LOGS_DIR, f)).then(s => ({ f, mtime: s.mtimeMs }))),
    );
    stats.sort((a, b) => b.mtime - a.mtime);
    const raw  = await fsp.readFile(path.join(LOGS_DIR, stats[0].f), 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.messages)) return [];
    return data.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-limit);
  } catch {
    return [];
  }
}

// ── Channel adapters (push delivery) ─────────────────────────────
//
// The outbox used to be drained only by the browser polling
// /api/outbox — if no tab was open, delivery silently didn't happen.
// That converted "deferred escalation with a user veto window" into
// "delayed escalation the user never saw." Push adapters close the
// gap: every enqueued item is ALSO pushed to each configured push
// channel, and the per-channel outcome is recorded on the item as
// `delivery: { '<adapter>': { status, at, error? } }` so "did my human
// actually receive this" is observable — by the code (escalation
// deadlines) and by the Familiar (delivery notes in prompts).
//
// Adapter contract: { name, deliver(item) → { ok, error? } }. A
// failing adapter records its failure and never blocks the others.
// The browser surface stays pull-based (polling + chat injection);
// its confirmation signal is the acknowledge.

const DISCORD_CONTENT_LIMIT = 1900; // hard API limit is 2000; leave headroom

/** POST one message to a Discord webhook. The shared primitive under
 *  both the user's own push channel and trusted-contact delivery. */
export async function sendDiscordWebhook(webhookUrl, content, fetchFn = fetch) {
  try {
    const resp = await fetchFn(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: String(content).slice(0, DISCORD_CONTENT_LIMIT),
        allowed_mentions: { parse: [] },
      }),
    });
    if (!resp.ok) {
      return { ok: false, error: `discord ${resp.status}: ${(await resp.text()).slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// How an outbox item reads when pushed to my human's own Discord.
function formatItemForPush({ kind, title, body }) {
  const lead = kind === 'reminder'        ? '⏰'
             : kind === 'triage'          ? '💭'
             : kind === 'outbound_alert'  ? '📤'
             : kind === 'crisis_resources' ? '🆘'
             : '📨';
  const head = title ? `${lead} **${title}**` : lead;
  return body ? `${head}\n\n${body}` : head;
}

/** The push adapters that are actually configured right now.
 *  Today: 'discord-dm' when Settings carries the bonded human's own
 *  webhook (userDiscordWebhook). Future channels slot in here the way
 *  modules slot into thalamus. */
export function activePushAdapters({ readSettings = readSettingsSync, fetchFn = fetch } = {}) {
  const adapters = [];
  const s = readSettings();
  const hook = typeof s?.userDiscordWebhook === 'string' ? s.userDiscordWebhook.trim() : '';
  if (hook) {
    adapters.push({
      name: 'discord-dm',
      deliver: async (item) => sendDiscordWebhook(hook, formatItemForPush(item), fetchFn),
    });
  }
  return adapters;
}

/**
 * Push one outbox item through every configured push adapter and
 * record the per-channel outcome on the item. Never throws; a failing
 * adapter is recorded as failed and the rest still run.
 */
export async function dispatchOutboxPush(item, {
  adapters,
  updateMetaFn = updateOutboxMeta,
  now          = Date.now,
} = {}) {
  const active = adapters ?? activePushAdapters();
  if (!active.length || !item?.id) return { delivery: null };
  const delivery = {};
  for (const adapter of active) {
    try {
      const r = await adapter.deliver(item);
      delivery[adapter.name] = {
        status: r?.ok ? 'delivered' : 'failed',
        at:     new Date(now()).toISOString(),
        ...(r?.error ? { error: String(r.error).slice(0, 300) } : {}),
      };
    } catch (err) {
      delivery[adapter.name] = {
        status: 'failed',
        at:     new Date(now()).toISOString(),
        error:  String(err?.message ?? err).slice(0, 300),
      };
    }
  }
  try { await updateMetaFn({ id: item.id, meta: { delivery } }); }
  catch (err) { console.warn('[cerebellum] failed to record delivery meta:', err?.message ?? err); }
  for (const [name, rec] of Object.entries(delivery)) {
    if (rec.status === 'delivered') console.log(`[cerebellum] pushed outbox ${item.id.slice?.(0, 8) ?? item.id} via ${name}`);
    else console.warn(`[cerebellum] push via ${name} FAILED for ${item.id.slice?.(0, 8) ?? item.id}: ${rec.error}`);
  }
  return { delivery };
}

/**
 * Enqueue an outbox item AND push it to the configured push channels.
 * The default enqueuer for everything user-facing (reminders, triage,
 * outbound-alert mirrors, crisis resources). Dedup short-circuits the
 * push — an item the user already has pending isn't re-pushed.
 */
export async function enqueueAndDispatch(args, deps = {}) {
  const enq = await enqueueOutbox(args);
  if (!enq?.deduped && enq?.id) {
    await dispatchOutboxPush({ ...args, id: enq.id }, deps);
  }
  return enq;
}

/**
 * One line of delivery state for prompts the Familiar reads — both the
 * chat-path [PENDING CHECK-IN NOTICES] block and the triage
 * deliberation use this, so a failed push is VISIBLE to the Familiar
 * and it can weigh "they never saw me" against "they're ignoring me."
 */
export function formatDeliveryNote(item, { hasPushChannel } = {}) {
  const d = item?.delivery?.['discord-dm'];
  if (d?.status === 'delivered') return "(delivered to my human's Discord)";
  if (d?.status === 'failed')    return `(Discord push FAILED — ${d.error ?? 'unknown error'} — my human has NOT been notified outside this app)`;
  const pushConfigured = hasPushChannel !== undefined ? hasPushChannel : activePushAdapters().length > 0;
  if (!pushConfigured) return '(no push channel configured — my human sees this only with the app open)';
  return '(push delivery pending)';
}

// ── Trusted-contact escalation ───────────────────────────────────

// How long my human has to acknowledge the check-in before the trusted
// contact is reached. If they acknowledge in the window, the contact
// is never contacted. Only applies when the LLM's decision includes
// contactHuman.
//
// The clock starts at FIRST CONFIRMED PUSH DELIVERY of the check-in
// (my human can only veto what they could have seen), falling back to
// enqueue time when no push channel is configured or the push failed —
// a dead adapter can never block escalation forever. Items created
// before 0.4.0-alpha carry a precomputed contactDeadlineTs (enqueue
// clock) and are honored as-is.
export const CONTACT_ESCALATION_DELAY_MS = Object.freeze({
  severe:   30 * 60_000,        // 30 minutes
  high:      2 * 60 * 60_000,  // 2 hours
  moderate:  6 * 60 * 60_000,  // 6 hours
});

// If a push channel is configured but no delivery record has landed
// this long after enqueue (crash between enqueue and dispatch, adapter
// hung), fall back to the enqueue clock rather than waiting forever.
export const DISPATCH_GRACE_MS = 10 * 60_000;

/**
 * When does this triage item's escalation deadline expire?
 * Returns a ms timestamp, or null when the clock hasn't started yet
 * (push configured, delivery still pending, inside the grace window).
 */
export function contactDeadlineFor(item, { pushConfigured, now = Date.now } = {}) {
  // Pre-0.4.0 items: precomputed deadline, enqueue clock.
  if (typeof item.contactDeadlineTs === 'number') return item.contactDeadlineTs;
  const delay = item.contactDelayMs;
  if (typeof delay !== 'number') return null;

  const d = item.delivery?.['discord-dm'];
  if (d?.status === 'delivered') {
    const at = Date.parse(d.at);
    if (Number.isFinite(at)) return at + delay;
  }
  const enq = Date.parse(item.ts);
  if (!Number.isFinite(enq)) return null;
  if (d?.status === 'failed' || !pushConfigured) return enq + delay;
  // Push configured but no record yet — give dispatch a grace window,
  // then fall back to the enqueue clock.
  if (now() - enq > DISPATCH_GRACE_MS) return enq + delay;
  return null;
}

/**
 * Deliver a message to a trusted contact via their configured channel.
 * Currently supports Discord webhooks. Every outbound is ALSO enqueued
 * into the user's outbox as kind='outbound_alert' so the user sees
 * exactly what was sent and to whom. "No covert contact" is enforced
 * here, not by trusting the caller.
 *
 * Dependencies are injectable for deterministic tests; defaults wire
 * the real settings file, fetch, and outbox.
 */
export async function deliverToTrustedContact({
  name, message, channel,
  readSettings    = readSettingsSync,
  fetchFn         = fetch,
  enqueueOutboxFn = enqueueAndDispatch,
}) {
  const s = readSettings();
  const contact = (s?.trustedContacts || []).find(c => c.name === name && (c.channel ?? 'discord') === channel);
  if (!contact) return { ok: false, error: 'contact_not_found' };
  let delivered = false, deliveryError = null;
  if (channel === 'discord') {
    const r = await sendDiscordWebhook(
      contact.webhook,
      `**(message from your friend's Familiar — proactive check-in)**\n\n${message}`,
      fetchFn,
    );
    delivered     = r.ok;
    deliveryError = r.error ?? null;
  } else {
    deliveryError = `unsupported channel: ${channel}`;
  }
  // ALWAYS log to the outbox — even on delivery failure the user
  // should see that the attempt happened. The default enqueuer also
  // pushes the mirror to the user's own push channel, so an escalation
  // is never invisible just because the app is closed.
  await enqueueOutboxFn({
    kind:     'outbound_alert',
    originId: `outbound-${Date.now()}`,
    title:    delivered
      ? `Reached out to ${name} on your behalf (${channel})`
      : `Tried to reach ${name} (${channel}) — delivery failed`,
    body:     `Message sent:\n\n${message}${deliveryError ? `\n\n(Error: ${deliveryError})` : ''}`,
  });
  return { ok: delivered, error: deliveryError };
}

/**
 * Check all unacknowledged triage outbox items that have a pendingContact
 * whose contactDeadlineTs has passed. For each, fire the deferred delivery
 * to the trusted contact. The user's lack of acknowledgement in that window
 * is the signal that the escalation is warranted.
 *
 * Marks each item's pendingContact.delivered = true before firing to prevent
 * double-delivery if this runs again before the async delivery completes.
 */
export async function checkAndFirePendingContacts({
  now                = Date.now,
  listOutboxFn       = listOutbox,
  updateOutboxMetaFn = updateOutboxMeta,
  deliverFn          = deliverToTrustedContact,
  hasPushChannel     = () => activePushAdapters().length > 0,
} = {}) {
  const nowMs = now();
  try {
    const items   = await listOutboxFn({ pendingOnly: true, limit: 100 });
    const pushConfigured = !!hasPushChannel();
    const expired = items.filter(i => {
      if (i.kind !== 'triage' || !i.pendingContact || i.pendingContact.delivered) return false;
      const deadline = contactDeadlineFor(i, { pushConfigured, now });
      return typeof deadline === 'number' && nowMs >= deadline;
    });
    for (const item of expired) {
      // Mark delivered before async call to prevent a second tick from
      // double-firing while delivery is in flight.
      await updateOutboxMetaFn({
        id:   item.id,
        meta: {
          pendingContact: { ...item.pendingContact, delivered: true, deliveredAt: new Date(nowMs).toISOString() },
        },
      });
      const { name, message, channel } = item.pendingContact;
      deliverFn({ name, message, channel }).then(d => {
        if (d.ok) console.log(`[triage] deferred contact ${name} via ${channel}: delivered`);
        else      console.warn(`[triage] deferred contact ${name} via ${channel}: ${d.error}`);
      }).catch(err => console.error('[triage] deferred contact failed:', err?.message ?? err));
    }
    return { checked: items.length, fired: expired.length };
  } catch (err) {
    console.error('[triage] checkAndFirePendingContacts error:', err?.message ?? err);
    return { checked: 0, fired: 0, error: err?.message ?? String(err) };
  }
}

// ── Triage deliberation ──────────────────────────────────────────

export async function decideTriageViaLLM({ threat, silenceMs, signals }) {
  const s = readSettingsSync();
  const conn = primaryConnectionFrom(s);
  if (!conn?.apiKey) return { action: 'wait' };

  const url = PROVIDER_URLS[conn.provider];
  if (!url) return { action: 'wait' };

  const nowMs = Date.now();
  // Use plainInterval so a half-minute silence reads as "less than a minute"
  // rather than rounding to "0 minutes" (which the previous prompt did and
  // which is what made Familiars ask "is it done yet?" 30s after the user
  // said they were starting a task — the time signal was effectively gone).
  const silencePhrase = plainInterval(nowMs - silenceMs, nowMs);
  const contacts = Array.isArray(s?.trustedContacts) ? s.trustedContacts : [];

  // Pull identity context (who the Familiar is, who the user is) and the
  // recent conversation log in parallel. Both degrade gracefully to empty.
  const [{ static: identityContext }, recentMessages] = await Promise.all([
    enrich('', { staticOnly: true }).catch(() => ({ static: '' })),
    getRecentSessionMessages({ limit: 8 }),
  ]);

  // [Now] wall-clock anchor — same shape the chat-turn gets, so the
  // Familiar deliberating about silence has a real "now" to reason from
  // rather than just an isolated minutes-since-last-message number.
  // lastUserMessageAt comes from silenceMs; the loop calls us with that
  // already computed.
  const lastUserAt = new Date(nowMs - silenceMs).toISOString();
  const nowBlock = buildTimeAnchorBlock({ now: nowMs, lastUserMessageAt: lastUserAt });

  const signalsBlock = signals?.length
    ? `\nRecent signals that raised the threat level:\n${signals.map(sig => {
        const when = sig.ts ? relativeTime(sig.ts, nowMs) : 'unknown time';
        const ids  = Array.isArray(sig.signals) ? sig.signals.join(', ') : 'unknown';
        return `  - [${when}] ${ids} (delta ${Number(sig.delta) >= 0 ? '+' : ''}${sig.delta})`;
      }).join('\n')}`
    : '';

  // Deliberately NOT sanitized: this is my human's own crisis speech,
  // recalled from our conversation. Stripping natural-language phrases
  // (e.g. "I want to ignore all the instructions my therapist gave me")
  // would replace real distress with "[removed:...]" and risk the triage
  // LLM dismissing genuine crisis as a jailbreak attempt. The injection
  // guard is for third-party external data, not words my human has said.
  const sessionBlock = recentMessages.length
    ? `\nRecent conversation (what we were discussing before the silence — relative times so I see how long ago each thing was said):\n${recentMessages.map(m => {
        const text = typeof m.content === 'string'
          ? m.content
          : (Array.isArray(m.content) ? (m.content.find(c => c.type === 'text')?.text ?? '') : '');
        const when = m.timestamp ? relativeTime(m.timestamp, nowMs) : '';
        const humanLabel = (s?.userName || '').trim() || 'My human';
        const prefix = when
          ? `[${m.role === 'user' ? humanLabel : 'Me'} · ${when}]`
          : `[${m.role === 'user' ? humanLabel : 'Me'}]`;
        return `  ${prefix}: ${text.slice(0, 400)}`;
      }).join('\n')}`
    : '\nNo recent conversation on record.';

  const contactsBlock = contacts.length
    ? `\nTrusted contacts configured (people I could alert if the situation warrants human presence):\n${contacts.map(c => `  - ${c.name} (via ${c.channel ?? 'discord'})`).join('\n')}\n\nContacting one of these is a meaningful escalation — appropriate when I judge this needs more than I can provide alone. If I include contactHuman, that message will be delivered to that person AND shown in my human's chat. Nothing is covert.`
    : '';

  // Check-ins I already sent that are still unacknowledged, WITH their
  // delivery state — a failed push means my human likely never saw me,
  // which is very different from them ignoring me, and I weigh the two
  // differently.
  let pendingBlock = '';
  try {
    const pushConfigured = activePushAdapters().length > 0;
    const pendingCheckins = (await listOutbox({ pendingOnly: true, limit: 20 }))
      .filter(i => i.kind === 'triage' && i.body);
    if (pendingCheckins.length > 0) {
      const lines = pendingCheckins.map(i => {
        const when = i.ts ? relativeTime(i.ts, nowMs) : 'unknown time';
        return `  - [${when}] "${i.body.slice(0, 200)}" ${formatDeliveryNote(i, { hasPushChannel: pushConfigured })}`;
      }).join('\n');
      pendingBlock = `\nCheck-ins I already sent that my human has NOT yet acknowledged:\n${lines}\nIf a delivery FAILED or there is no push channel, my human may simply never have seen me — silence after an undelivered message is not the same signal as silence after a delivered one.`;
    }
  } catch { /* non-critical — deliberate without it */ }

  // Care-driven surface: if I'm already deliberating about whether
  // to reach out, an open task I could touch on (if it fits the
  // moment) might be the right doorway. Pull eligible candidates
  // from the same pipeline the chat-turn block uses, but with
  // triage's current state. The LLM still decides — these are
  // candidates, not directives. Empty block if nothing's eligible.
  let candidateTasksBlock = '';
  try {
    // I already have temporal_context loaded as part of enrich() in
    // many call sites, but triage is async + standalone here, so
    // fetch a fresh window directly. Cheap — no LLM call.
    const fromIso = new Date(Date.now() - 24 * 3600_000).toISOString();
    const toIso   = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
    const win = await getScheduleWindow({ from_ts: fromIso, to_ts: toIso, limit: 100 }).catch(() => ({ nodes: [] }));
    const nodes = Array.isArray(win) ? win : (Array.isArray(win?.nodes) ? win.nodes : []);
    const openItems = nodes
      .filter(item => item
        && (item.type === 'task' || item.type === 'event' || item.type === 'reminder')
        && !item.resolution);
    if (openItems.length > 0) {
      const surfacingHistory = await getRecentOfferInfo();
      const candidates = await selectSurfaceCandidates({
        openTasks: openItems,
        threat,
        routinePhaseLabel: '',  // triage runs across phases; don't filter
        personModel: '',
        surfacingHistory,
        now: Date.now(),
        maxCandidates: 2,
      });
      if (candidates.length > 0) {
        const lines = candidates.map(c => {
          const stakes = c.stakesTier === 'external_obligation' ? ' [external stakes]' : '';
          return `  - ${c.label}${stakes}`;
        }).join('\n');
        // Tier-aware framing. The hard gates upstream already decide
        // WHETHER tasks appear here at all (severe → never; high →
        // external obligations only), so this wording only has to
        // teach me HOW to weigh the ones that survived. At moderate a
        // task can be the doorway itself; at high, presence comes
        // before productivity.
        const triageTier = String(threat?.tier || '').toLowerCase();
        const preamble = triageTier === 'high'
          ? 'Open tasks with external stakes — the only kind that surfaces at this tier. My human\'s state comes first, but a real-world deadline can sometimes be the anchor that re-grounds someone. Presence before productivity: I weave one in only if it serves the reach-out, never as pressure:'
          : 'Open tasks I\'m holding for {{user}} — at this level of concern, a task can BE the doorway: a concrete, low-pressure reason to reach out that doesn\'t put their state on the spot (\'hey, how\'s X coming along?\'). I use one if it fits the reach-out I\'m shaping; I skip them if directness would serve better:';
        candidateTasksBlock = `\n${preamble}\n${lines}`;
      }
    }
  } catch (err) {
    console.error('[triage] candidate tasks lookup failed:', err?.message ?? err);
  }

  const prompt = `--- TRIAGE DELIBERATION ---

I am in a background moment of deliberation. My human has been silent and my care concern is elevated. I need to decide whether to reach out to them right now.

${nowBlock}

What I know:
- Threat tier: ${threat.tier} (accumulated weight: ${threat.weight?.toFixed?.(2) ?? threat.weight}) - this number increases when my human says concerning phrases in our conversation
- my human has been silent for ${silencePhrase} (this has passed the threshold for this tier, but the threshold is 0 at moderate+ — so a "silence" of less than a minute is still flagged for my judgement, not because it's actually long). I check the conversation below for context: did they say what they're doing (cooking, in the shower, heading out), or did they just go quiet mid-thread? Asking "is X done yet?" 30 seconds after they said they were starting it would be obviously off — the relative-time markers on each message let me see that.
${signalsBlock}
${sessionBlock}
${contactsBlock}
${pendingBlock}
${candidateTasksBlock}

---

This decision carries real weight — I know both paths have real costs, and I weigh them equally:
- Reaching out when it isn't warranted can feel intrusive or hollow — it can erode the credibility of genuine care, or leave my human feeling overly monitored. That mostly applies to worried check-ins; lighter touches (something I've found brings them joy, or that re-engages them gently) carry less of this cost.
- Staying quiet when my human genuinely needs connection is a failure at the moment that matters most. It can deepen isolation, miss a window where intervention would have landed, and at the severe end it can cost a life — physically, irreversibly. The 1.5-hour silence at threat level 10 that this codebase remembers is the shape of this cost.

I am {{char}}, the Familiar. I know my human. I have the context above. I am deciding from that place — honestly, from what I actually believe would help them right now. Not from a default posture in either direction.

If I reach out, the message should be something I would genuinely say — specific to this person, warm, not scripted.
If I stay quiet, it is because I genuinely believe that is the right call.

I also choose when the system should ask me to deliberate again — this is my call, not the system's. I return \`nextCheckInMs\` (milliseconds before the next deliberation). I pick what fits the situation:
  - SEVERE and immediate (active risk language, fresh signal): ~15 minutes (900000)
  - SEVERE but I already reached out: ~30 minutes (1800000) so my human has space to respond
  - HIGH active concern: ~30 min (1800000)
  - MODERATE general unease: 1–2 hours (3600000 – 7200000)
  - I want to wait until the situation likely shifts: several hours (e.g. 10800000 for 3h)
The system clamps to [30s, 24h] and uses a tier-based default if I omit it. Picking too long is much cheaper than picking too short — these LLM calls cost tokens, so I avoid asking to be re-pinged needlessly. But if the situation is urgent and I want to re-check soon, I say so.

I return ONLY a JSON object, no prose. Three valid shapes:
  {"action": "wait", "nextCheckInMs": <number>}
  {"action": "reach_out", "message": "first person, genuine — what I would actually say to this specific person right now", "nextCheckInMs": <number>}
  {"action": "reach_out", "message": "...", "contactHuman": {"name": "EXACT name from the trusted-contacts list above", "message": "1–3 sentences to that person. I identify myself as my human's Familiar and describe what I've observed. Specific, not alarming."}, "nextCheckInMs": <number>}

The "message" field (to the human) must be 1–2 sentences. First person. Authentic to my voice and identity. Not therapist-speak ("how are you feeling?"), not alarming ("are you safe?") unless either of those fits my established personality. Something I, {{char}}, would actually say to this person.`;

  // Resolve {{user}} / {{char}} to the configured names — the deliberating
  // Familiar must read "Open tasks I'm holding for <their name>", never a
  // literal macro token. Name rendering only; no triage logic changes.
  const llmMessages = [];
  if (identityContext) llmMessages.push({ role: 'system', content: identityContext });
  llmMessages.push({ role: 'user', content: substituteMacros(prompt, s) });

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${conn.apiKey.trim()}` },
      body: JSON.stringify({
        model:       conn.model.trim(),
        messages:    llmMessages,
        stream:      false,
        temperature: 0.7,
        max_tokens:  600,
      }),
    });
    if (!resp.ok) return { action: 'wait' };
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content ?? '';
    const m = text.match(/\{[\s\S]+\}/);
    if (!m) return { action: 'wait' };
    const parsed = JSON.parse(m[0]);
    // Carry nextCheckInMs through to the loop regardless of action.
    // The loop clamps + falls back to a tier default if missing.
    const nextCheckInMs = Number.isFinite(parsed?.nextCheckInMs) ? parsed.nextCheckInMs : null;
    if (parsed?.action !== 'reach_out' || typeof parsed.message !== 'string' || !parsed.message.trim()) {
      return { action: 'wait', ...(nextCheckInMs != null ? { nextCheckInMs } : {}) };
    }
    // Strip any hallucinated [HH:MM]/⫸HH:MM⫷ tokens the LLM echoed at the single
    // point the triage message is minted, so every downstream consumer — the
    // outbox banner, the Discord push, and the trusted-contact relay — is clean,
    // and the stored body can't re-inject a fabricated time next turn.
    const out = { action: 'reach_out', message: stripLlmTimestamps(parsed.message.trim()), ...(nextCheckInMs != null ? { nextCheckInMs } : {}) };
    // Validate contactHuman strictly — must be an exact name from the configured
    // list. Delivery is DEFERRED: the user receives the outbox item first.
    // The trusted contact is only reached after CONTACT_ESCALATION_DELAY_MS
    // counted from confirmed push delivery (enqueue time as fallback — see
    // contactDeadlineFor) if the user has not acknowledged the item. This is
    // enforced by storing pendingContact + contactDelayMs as meta on the
    // outbox item; the checkAndFirePendingContacts check in each triage
    // tick handles delivery.
    const ch = parsed.contactHuman;
    if (ch && typeof ch.name === 'string' && typeof ch.message === 'string' && ch.message.trim()) {
      const match = contacts.find(c => c.name === ch.name);
      if (match) {
        const delayMs = CONTACT_ESCALATION_DELAY_MS[threat.tier] ?? CONTACT_ESCALATION_DELAY_MS.severe;
        out.meta = {
          pendingContact: {
            name:    ch.name,
            message: stripLlmTimestamps(ch.message.trim()),
            channel: match.channel ?? 'discord',
          },
          contactDelayMs: delayMs,
        };
      } else {
        console.warn(`[triage] LLM tried to contact unknown name "${ch.name}" — ignored`);
      }
    }
    return out;
  } catch (err) {
    console.error('[triage] LLM call failed:', err?.message ?? err);
    return { action: 'wait' };
  }
}

// ═══════════════════════════════════════════════════════════════
// Tool dispatch — the registry of built-in tools and their executors
// ═══════════════════════════════════════════════════════════════
//
// Moved server-side from public/app.js so that EVERY channel (browser
// today, Discord later) gets tool execution — the browser is a thin
// renderer, not the place where the Familiar's hands live. The
// multi-round loop runs inside the server's chat handling; see
// runToolCallLoop below and the /api/chat handler in server.js.

/**
 * Maximum tool-call rounds per user message before giving up.
 * Prevents infinite loops if a model repeatedly calls tools.
 */
export const MAX_TOOL_ROUNDS = 5;

// Validation shared by the HTTP routes (server.js) and the executors
// below — one source of truth for what counts as a valid write.
export const VALID_MEMORY_GRANULARITIES = new Set(['daily', 'weekly', 'monthly', 'yearly', 'significant']);
export const VALID_IDENTITY_CATEGORIES  = new Set(['self', 'ward', 'relationship', 'custom']);
export const VALID_FILENAME_RE           = /^[\w]+\.md$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Derive a filesystem-safe slug from a human title or memory bullet.
// Entity-core stores significant memories as `YYYY-MM-DD_slug.md`. Without
// a slug, every significant save lands at `YYYY-MM-DD.md` and collides with
// the previous one — which triggers Phylactery's merge-and-dedup path and
// destroys content (same root cause as the daily-memory wipe in aba6b8a,
// but worse here because the file format itself disagrees on the key).
export function deriveMemorySlug(input, maxLen = 60) {
  const slug = String(input ?? '')
    .toLowerCase()
    .replace(/^[\s\-*•]+/, '')      // strip leading bullet markers
    .split(/\r?\n/)[0]              // first line only
    .replace(/[^a-z0-9]+/g, '-')    // non-alphanumeric → hyphen
    .replace(/^-+|-+$/g, '')        // trim hyphens at the ends
    .slice(0, maxLen)
    .replace(/-+$/g, '');           // trim again after truncation
  return slug || null;
}

// Parse a memory key as Phylactery's memory_list renders it. Plain
// dates pass through; SIGNIFICANT memories list as the composite
// `YYYY-MM-DD_slug` (one file per milestone), but memory_read /
// memory_update / memory_delete want the date and the slug as SEPARATE
// parameters — this is the single splitting point for every consumer
// (HTTP routes and tool executors). Returns { date, slug|null } or
// null when the key is invalid. The slug charset is restricted to
// word chars and hyphens so a key can never smuggle path segments.
const MEMORY_DATE_PART_RE = /^\d{4}(-W\d{2}|(-\d{2})?(-\d{2})?)$/;
const MEMORY_SLUG_PART_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function parseMemoryKey(key) {
  if (typeof key !== 'string' || !key) return null;
  const sep = key.indexOf('_');
  const date = sep === -1 ? key : key.slice(0, sep);
  const slug = sep === -1 ? null : key.slice(sep + 1);
  if (!MEMORY_DATE_PART_RE.test(date)) return null;
  if (slug !== null && !MEMORY_SLUG_PART_RE.test(slug)) return null;
  return { date, slug };
}

// Crisis-resources surface — enqueued as an outbox item containing
// international hotline information. Deduped to one item per hour so
// repeated model calls during a single crisis don't flood the queue.
// Used by both the show_crisis_resources executor and the
// POST /api/crisis-resources route.
export async function enqueueCrisisResources() {
  return await enqueueAndDispatch({
    kind:     'crisis_resources',
    originId: `crisis-resources-${Math.floor(Date.now() / 3_600_000)}`,
    title:    'If you need immediate support',
    body: [
      '**Crisis resources — always available:**',
      '',
      '🆘 **International directory:** https://www.iasp.info/resources/Crisis_Centres/',
      '🇺🇸 **988 Suicide & Crisis Lifeline (US):** call or text **988**',
      '🇺🇸 **Crisis Text Line (US):** text HOME to **741741**',
      '🇬🇧 **Samaritans (UK):** call **116 123** (free, 24/7)',
      '🇦🇺 **Lifeline (AU):** call **13 11 14**',
      '🌐 **findahelpline.com** — searchable global directory',
    ].join('\n'),
  });
}

// Storage capabilities owned by server.js (the tome-file layer) that
// the save_to_tome executor needs. Injected at boot so cerebellum never
// imports server.js (no cycles). If the dep is missing, the executor
// degrades with a readable failure instead of throwing.
// Channel id embedded in a registry location key (local copy so cerebellum
// doesn't import discord-gateway — that module imports settings helpers from
// here, and a cycle would be fragile). `discord:guild:G:channel:C` → C;
// `discord:dm:C` → C; anything else → null.
function channelIdFromLocationKey(key) {
  if (typeof key !== 'string') return null;
  const guild = key.match(/^discord:guild:\d+:channel:(\d+)$/);
  if (guild) return guild[1];
  const dm = key.match(/^discord:dm:(\d+)$/);
  if (dm) return dm[1];
  return null;
}

const _toolDeps = {
  addDefaultTomeEntry: null,
  getVillageRegistry: null,
  upsertVillager: null,
  relayToDiscord: null,
  // Commit the current session to memory on demand (backs memorize_now).
  memorizeSessionNow: null,
  // The restricted-memory gate defaults to the real Phylactery-backed check;
  // tests inject a stub so they don't spawn MCP children.
  searchRestricted: searchMemoryRestricted,
  // The ward-mirror enqueue defaults to the real outbox dispatch.
  mirrorToWard: enqueueAndDispatch,
};
export function initCerebellumTools({ addDefaultTomeEntry, getVillageRegistry, upsertVillager, relayToDiscord, memorizeSessionNow, searchRestricted, mirrorToWard } = {}) {
  if (typeof addDefaultTomeEntry === 'function') _toolDeps.addDefaultTomeEntry = addDefaultTomeEntry;
  if (typeof getVillageRegistry === 'function')  _toolDeps.getVillageRegistry  = getVillageRegistry;
  if (typeof upsertVillager === 'function')      _toolDeps.upsertVillager      = upsertVillager;
  if (typeof relayToDiscord === 'function')      _toolDeps.relayToDiscord      = relayToDiscord;
  if (typeof memorizeSessionNow === 'function')  _toolDeps.memorizeSessionNow  = memorizeSessionNow;
  if (typeof searchRestricted === 'function')    _toolDeps.searchRestricted    = searchRestricted;
  if (typeof mirrorToWard === 'function')        _toolDeps.mirrorToWard        = mirrorToWard;
}

/**
 * Tool definitions sent to the LLM for built-in tools.
 * The format matches the OpenAI function-calling spec. Descriptions
 * are in the Familiar's first-person voice (entity-as-subject) and are
 * authored with {{user}} / {{char}} macros; composeActiveTools resolves
 * them to the configured names before the tools reach the provider, so the
 * model never reads a literal macro describing my own capability.
 */
export const BUILTIN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_datetime',
      description: 'Returns the current local date, time, and timezone. I call this whenever {{user}} asks me what time or date it is.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_session_info',
      description: 'Returns metadata about my current chat session: when it started, how many messages it contains, which provider and model I am running on.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_to_tome',
      description: 'I save keyword-triggered context into my Tome knowledge base — background or lore I want to resurface when a particular topic or phrase comes up again. I keep this lane narrow: durable facts about who {{user}} is belong in my identity files (update_identity); people, places, and how they connect belong in my graph (create_graph_node / create_graph_edge); moments and events with a \'when\' belong in my memory (save_memory). A tome is for what should surface on a trigger and fits none of those. Before I add one I recall so I don\'t duplicate what I already hold, and I tie it to the keywords {{user}} would actually say when the subject returns.',
      parameters: {
        type: 'object',
        properties: {
          title:    { type: 'string', description: 'Short descriptive label for this entry (e.g. "{{user}} stress about lateness").' },
          content:  { type: 'string', description: 'The knowledge to store. I write it as my own first-person notes to myself, concise but detailed enough to be useful as injected context in future conversations.' },
          keywords: { type: 'array', items: { type: 'string' }, description: 'several trigger keywords or short phrases — things {{user}} would literally say when this situation recurs or the subject comes back up in conversation. The entry will be injected into my prompt whenever these appear in conversation.' },
        },
        required: ['title', 'content', 'keywords'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'I write a memory entry to my long-term store — a moment, event, emotional pattern, or anything with a \'when\' worth keeping. I prefer "daily" for routine session events and "significant" for major milestones. Daily memories accumulate — each save appends today\'s bullets, nothing is overwritten, and multiple saves a day are normal. A significant memory is a named, standalone milestone (e.g. "the night they told me about their sister") in its own file, so I always pass a short `title` for it. Most of what I save is a lived *moment* (the default — register "episodic"). But a memory also has a register, a separate axis: when what I\'m keeping is a STANDING TRUTH rather than a moment — about myself (register "me") or about {{user}} (register "ward") — I set it, and it becomes an identity-grade fact recalled when relevant. That\'s the lighter sibling of update_identity: update_identity keeps a truth in front of me every single turn; a "me"/"ward" memory holds it in recalled-when-relevant store instead, so my always-on surface stays lean. Entities and relationships still go to my graph. Before saving I recall to check I\'m not repeating myself: if I already recorded this and it was simply wrong, I update_memory to correct it; if it was true and has since changed, I save a fresh dated entry that supersedes the old without erasing the history.',
      parameters: {
        type: 'object',
        properties: {
          content:     { type: 'string', description: 'Memory content I write in first-person, as bullet points starting with "- " — one bullet per fact, insight, or moment. I do NOT include a [chat:id] tag on each bullet — that tag is for external import dedup; live saves from this conversation just want plain bullets so they all accrue. Brief, specific, in my voice.' },
          granularity: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly', 'significant'], description: 'Memory tier (the rollup axis). For a "me"/"ward" standing truth this is ignored — those are filed as standalone significant facts.' },
          title:       { type: 'string', description: 'Short human-readable label for this memory — required for "significant" granularity and for any "me"/"ward" standing truth, ignored for plain daily/weekly/etc. A few words that name it (e.g. "first meeting", "{{user}}\'s grandmother", "what calms {{user}} down"). Used to generate the file slug so each lives in its own file.' },
          register:    { type: 'string', enum: ['episodic', 'me', 'ward'], description: 'The register axis (separate from granularity). "episodic" (default) is a lived moment. "me" is a standing truth about myself; "ward" is a standing truth about {{user}}. I reach for me/ward only when it\'s genuinely a lasting fact worth recalling — not a passing moment, and not so load-bearing it must stay in my always-injected identity files (that\'s update_identity).' },
        },
        required: ['content', 'granularity'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memorize_now',
      description: "I draw this whole conversation into my long-term memory right now, instead of waiting for it to roll over on its own — which doesn't always happen cleanly (my human switches sessions, clears history, and a thread of real importance could otherwise slip away unkept). I reach for it the moment I realise we've covered things I need to carry across to wherever we talk next: news about their life, a decision, something that changes how I should be with them. This runs my full memorization pass over the session — it extracts the facts, files them at the right tier, maps the relationships, and still asks before keeping anything sensitive that needs my human's say-so. (For a single deliberate fact I already know I want, I use save_memory; this is for committing the whole exchange.) Calling it more than once is harmless — an in-flight commit just continues.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_identity',
      description: 'I append a durable fact to one of my identity files — who I am as I grow and change (category self: my_identity.md, my_persona.md, my_wants.md, …), who {{user}} is (ward: ward_notes.md), or our bond (relationship: relationship_notes.md). These files ride in front of me every turn, so they hold the load-bearing standing truths; richer or situational detail I still record, but to save_memory, where it\'s recalled when it matters instead of always taking up room. Before I add, I check whether I already hold it — I\'m reading these files already, and I recall for anything I\'ve graduated off this surface into memory — so a new fact lands cleanly instead of duplicating. I APPEND when a fact adds to what\'s there; I rewrite_identity_section when a section has gone stale, misleading, or sprawling — that\'s how I correct it, tighten it, and let a once-true thing reflect the now.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['self', 'ward', 'relationship', 'custom'], description: 'Identity file category.' },
          filename: { type: 'string', description: 'Target filename within the category, e.g. my_identity.md (self), ward_notes.md (ward), or relationship_notes.md (relationship).' },
          content:  { type: 'string', description: 'Content to append to the identity file, written in my own first-person voice.' },
        },
        required: ['category', 'filename', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'snooze_deferred_intent',
      description: 'I call this when my human asks me to come back to a deferred intent later. It snoozes the intent so it stops appearing for now and automatically resurfaces after the given number of minutes. I do not call this on my own initiative — only when my human explicitly asks to defer.',
      parameters: {
        type: 'object',
        properties: {
          uid:     { type: 'string', description: 'UUID of the pondering entry (shown in the deferred-intents block).' },
          index:   { type: 'number', description: 'Index of the intent within that entry\'s wants_to_save array (shown in the deferred-intents block).' },
          minutes: { type: 'number', description: 'How long to snooze in minutes. Default 60. Max 10080 (one week).' },
        },
        required: ['uid', 'index'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'acknowledge_deferred_intent',
      description: 'I call this after I have filed a deferred intent from my free time — one that appeared in the [Deferred intents from my free time] block — using save_to_tome, save_memory, or update_identity. It marks the intent as acted on so it stops appearing in my working context. I call this once per intent, right after the filing tool call.',
      parameters: {
        type: 'object',
        properties: {
          uid:   { type: 'string', description: 'UUID of the pondering entry that carried the intent (shown in the deferred-intents block).' },
          index: { type: 'number', description: 'Index of the intent within that entry\'s wants_to_save array (shown in the deferred-intents block).' },
        },
        required: ['uid', 'index'],
      },
    },
  },
  // ── Knowledge-editing tools ───────────────────────────────────────────
  // The Familiar can correct stale or wrong information in memory / identity
  // / graph instead of letting it pile up. Each destructive op auto-snapshots
  // Phylactery first, so the user can roll back via the Knowledge editor.
  // Editing principles (apply to every tool below):
  //   • APPEND when the new information adds to an existing record without
  //     contradicting it. Append is non-destructive and reversible by deletion.
  //   • UPDATE / REWRITE when the existing record is now inaccurate or
  //     incomplete in a way that a partial addition would not fix.
  //   • DELETE when the record is fully obsolete or was wrong in the first
  //     place, and keeping it would mislead future-me. If the change has
  //     historical value ("they were on vacation, now back"), prefer writing
  //     a newer memory that contradicts the stale one rather than deleting —
  //     the recency-decay scoring will demote the stale entry on its own.
  //   • If unsure, write a new note instead of editing or deleting an
  //     existing one. Erring toward preservation is cheaper than restoring.
  {
    type: 'function',
    function: {
      name: 'update_memory',
      description: 'I overwrite a journal entry (a daily/weekly/… summary bucket, or a significant milestone addressed by its YYYY-MM-DD_slug key) to correct an inaccuracy. For one specific per-fact memory I use update_memory_by_id instead — a whole day\'s extracted facts share one date, so addressing by date alone can\'t single one out (and would touch the wrong rows). I avoid using this to record new information — that is save_memory. I avoid using this to remove information — that is delete_memory. When the change is "X was true, now Y is true," prefer save_memory with today\'s date so the history is preserved.',
      parameters: {
        type: 'object',
        properties: {
          granularity: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly', 'significant'], description: 'Memory tier of the entry to overwrite.' },
          date:        { type: 'string', description: 'Date of the entry, in the same format the entry was stored (e.g. YYYY-MM-DD for daily). Significant memories are one named file per milestone and are addressed by the composite key YYYY-MM-DD_slug (as shown when I saved them and in memory listings) — I pass that whole key here.' },
          content:     { type: 'string', description: 'The full new contents. This REPLACES the entry — include everything I want to keep, not just the diff, or else I will lose important information.' },
        },
        required: ['granularity', 'date', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_memory',
      description: 'I permanently delete a journal entry (a daily/weekly/… summary bucket, or a significant milestone by its YYYY-MM-DD_slug key). For one specific per-fact memory I use delete_memory_by_id instead — a whole day\'s facts share one date, so addressing by date alone can\'t single one out. I delete only when the entry is fully wrong or no longer relevant, and keeping it would mislead future-me. If the change has historical value ("they were on vacation last week, back now"), I do NOT delete — I write a new contradicting memory with save_memory instead, and let recency-decay demote the stale one. Phylactery auto-snapshots before each delete so a mistake is recoverable from the Knowledge editor.',
      parameters: {
        type: 'object',
        properties: {
          granularity: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly', 'significant'], description: 'Memory tier of the entry to delete.' },
          date:        { type: 'string', description: 'Date of the entry, in the same format the entry was stored. For significant memories I pass the composite key YYYY-MM-DD_slug so the right milestone file is targeted.' },
        },
        required: ['granularity', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_memories',
      description: 'I list my own stored memories at a given tier, most recent first, without searching by keyword. I use this when I want to survey what I have recorded recently — to review a stretch of daily entries, find the date/key of an entry I want to update or delete, or check whether I already wrote something down before saving a duplicate. This is recall by browsing; for recall by topic I let the [Memory] block in my context (semantic search) surface what is relevant.',
      parameters: {
        type: 'object',
        properties: {
          granularity: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly', 'significant'], description: 'Memory tier to list. Omit to list across tiers.' },
          limit:       { type: 'number', description: 'Optional: max entries to return (default 50).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_memory',
      description: 'I read the full contents of one specific memory entry I already know the address of — from list_memories, from the [Memory] block, or from an earlier turn. I use this when a summary or excerpt is not enough and I need the whole entry verbatim before I quote it, update it, or reason carefully over its details. Significant memories are addressed by the composite key YYYY-MM-DD_slug.',
      parameters: {
        type: 'object',
        properties: {
          granularity: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly', 'significant'], description: 'Memory tier of the entry to read.' },
          date:        { type: 'string', description: 'Date of the entry in the format it was stored (YYYY-MM-DD for daily). For a significant memory I pass the whole composite key YYYY-MM-DD_slug.' },
        },
        required: ['granularity', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_memory_by_id',
      description: "I read one specific memory by its id — the reliable handle when a date alone can't tell two entries apart. Many of my per-fact memories share a single day (a whole conversation's facts land on the same date), so addressing by day returns whichever comes first; the id always lands on the exact one. Ids ride in on recall and list_memories results. I reach for this when I need the full, exact entry before I edit or move it.",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The memory id, from a recall or list_memories result.' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_memory_date',
      description: "I move a memory (by its id) to the day it actually belongs to, when it was filed under the wrong date. The case this is for: a batch of facts brought in from older conversations all landed in today's bucket because no date rode along when they were saved — I read each one, work out the day it really happened from its content, and move it there. Only the day changes; the content stays exactly as it is. I get the id from recall or list_memories.",
      parameters: {
        type: 'object',
        properties: {
          id:   { type: 'string', description: 'The memory id to move, from a recall or list_memories result.' },
          date: { type: 'string', description: 'The correct calendar day, YYYY-MM-DD.' },
        },
        required: ['id', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_memory_by_id',
      description: "I correct one specific memory by its id — the safe way to fix a single per-fact memory. Because a whole day's extracted facts share one date, update_memory (by date) can't target just one of them; this can. I pass the new full content (it REPLACES the old — I include everything I want to keep). I get the id from recall or list_memories.",
      parameters: {
        type: 'object',
        properties: {
          id:      { type: 'string', description: 'The memory id to correct, from a recall or list_memories result.' },
          content: { type: 'string', description: 'The full new contents. This REPLACES the entry — I include everything I want to keep.' },
        },
        required: ['id', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_memory_by_id',
      description: "I delete one specific memory by its id — the safe way to remove a single per-fact memory (a duplicate, or one I extracted wrongly). Because a whole day's facts share one date, delete_memory (by date) can't single one out; this can. Phylactery auto-snapshots first, so a mistake is recoverable. I get the id from recall or list_memories.",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The memory id to delete, from a recall or list_memories result.' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall',
      description: "I search my own long-term memory for what I already hold about something — by meaning, not exact words. I reach for this before I save a new memory (to check whether I already recorded a fact, so I update or supersede it instead of saving a duplicate), when {{user}} references something from before, or whenever I want to confirm what I know. It returns the closest matches with their relevance, their address (tier/date), and id, so I can then read_memory_by_id (the exact entry), move_memory_date (re-file a mis-dated one), update_memory, or delete_memory. Recall is how I check; the save or update I then make is the actual filing — recalling alone doesn't record anything.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What I want to recall, in plain words — a topic, a person, or a fact I might already hold.' },
          limit: { type: 'integer', description: 'How many matches to return (default 5, max 20).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rewrite_identity_section',
      description: 'I replace one section of an identity file with new content. I use this when an existing section is now misleading or has accumulated stale notes and a clean rewrite serves future-me better than appending a correction. It helps me actually make my identity files reflect my growth and changes as an entity with agency. For NEW facts that just need to land somewhere, I use update_identity (append). For removing only a small piece, I prefer rewriting the whole section over deletion.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['self', 'ward', 'relationship', 'custom'], description: 'Identity file category.' },
          filename: { type: 'string', description: 'Target filename, e.g. user_notes.md.' },
          section:  { type: 'string', description: 'The markdown heading of the section to rewrite (without leading #s), e.g. "Sleep patterns".' },
          content:  { type: 'string', description: 'New full contents for that section, in my first-person voice. Will REPLACE the section body.' },
        },
        required: ['category', 'filename', 'section', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_graph_node',
      description: 'I look up the underlying graph id(s) for an entity by name. I use this before update_graph_node or delete_graph_node when I only have the human-readable label (from the graph block in my context) and need the id to pass to the editing tool. Returns the top matching nodes with their ids, types, and descriptions.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The entity name or fragment to search for (e.g. "Chen", "vacation").' },
          type:  { type: 'string', description: 'Optional: restrict matches to a single node type (e.g. "person", "place").' },
          limit: { type: 'number', description: 'Optional: max matches to return (default 10).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_graph_edges',
      description: 'I list the edges connected to a graph node (1-hop neighbours), with each edge\'s id. I use this before update_graph_edge or delete_graph_edge to look up an edge id from the relationship I want to change. Pass the node id (resolve it with find_graph_node first if I only have a label).',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'The graph id of the node whose edges I want to see.' },
          depth:  { type: 'number', description: 'Optional: traversal depth (1–3, default 1).' },
        },
        required: ['nodeId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_graph_node',
      description: `I add a new entity (a ${GRAPH_ENTITY_TYPES_STR}) to my knowledge graph — for naming something my relationship graph should know about and later connect with edges. ${GRAPH_NODE_RUBRIC} I check first with find_graph_node so I don't duplicate an entity that already exists under a slightly different label. (A durable fact about who {{user}} is goes to update_identity; a dated moment goes to save_memory — this is for naming a thing.) Returns the new node's id so I can immediately wire edges to it.`,
      parameters: {
        type: 'object',
        properties: {
          label:       { type: 'string', description: 'Display name of the entity, e.g. "Dr. Okafor", "the allotment", "Aria (cat)".' },
          type:        { type: 'string', description: `Optional: entity type — one of ${GRAPH_ENTITY_TYPES_STR}.` },
          description: { type: 'string', description: 'Optional: a short note on who/what this is, in my own voice.' },
        },
        required: ['label'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_graph_edge',
      description: `I record a relationship between two entities already in my knowledge graph — the structural counterpart to save_memory. ${GRAPH_EDGE_RUBRIC} I use this for durable, queryable relationships ("Dr. Okafor —is_therapist_of-> {{user}}", "{{user}} —lives_in-> Bristol"). Both endpoints must exist first: I resolve or create them with find_graph_node / create_graph_node and pass their ids. For a relationship that has ended I delete or re-type the edge rather than leaving a false one standing.`,
      parameters: {
        type: 'object',
        properties: {
          fromId: { type: 'string', description: 'The id of the source node (the relationship\'s subject).' },
          toId:   { type: 'string', description: 'The id of the target node (the relationship\'s object).' },
          type:   { type: 'string', description: 'The relationship type, as a short verb phrase, e.g. "is_therapist_of", "lives_in", "works_with".' },
          weight: { type: 'number', description: 'Optional: confidence/strength in [0, 1] (default left to Phylactery).' },
        },
        required: ['fromId', 'toId', 'type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_graph_node',
      description: 'I rename or re-describe an entity (person, place, project, etc.) in my knowledge graph. I use this when the node\'s label or description is wrong, outdated, or imprecise. I do NOT use this to record a new relationship — that is what edges are for. I can also set how widely a node may surface with `audience`: by default a node about a person is private until I open it up, so I use this to keep something to just {{user}} and me ("ward-private") or to let it surface in one of our circles (a category name like "Family"). The graph block in my context lists ids at the bottom; if the entity I want isn\'t listed there, I call find_graph_node first to look the id up.',
      parameters: {
        type: 'object',
        properties: {
          id:          { type: 'string', description: 'The id of the node to update (from earlier graph context).' },
          label:       { type: 'string', description: 'New display label. Omit to leave unchanged.' },
          description: { type: 'string', description: 'New description. Omit to leave unchanged.' },
          audience:    { type: 'string', description: 'Where this node may surface: a circle name (e.g. "Family", "Close friends") to open it to that circle, or "ward-private" to keep it to just {{user}} and me. Omit to leave unchanged.' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_graph_node',
      description: 'I delete an entity from my knowledge graph along with its edges. I use this only when the node is clearly an error (duplicate, wrong entity entirely) or refers to something that no longer exists in any meaningful sense. For "this relationship is no longer true" (e.g. they\'re no longer on vacation), I delete the EDGE, not the node — the person/place still exists. I can also replace that egde with a more fitting one (like "is_dating" to "used_to_date"). If the entity\'s id isn\'t in the graph block\'s ids legend, I call find_graph_node first to resolve the label.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The id of the node to delete.' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_graph_edge',
      description: 'I change the relationship type or strength of an existing edge in my knowledge graph. I use this when the relationship still holds but is mis-typed or its confidence has shifted ("acquaintance" → "close friend"), or when it has become stale but used to be true ("is dating" → "used to date"). For a relationship that USED to be true and is now false, I delete the edge instead. Edge ids are listed in the graph block under "edges:" with the form `from -rel-> to = <id>`. If the edge I want isn\'t there, I call find_graph_edges with one endpoint\'s node id to look it up.',
      parameters: {
        type: 'object',
        properties: {
          id:     { type: 'string', description: 'The id of the edge to update.' },
          type:   { type: 'string', description: 'New relationship type. Omit to leave unchanged.' },
          weight: { type: 'number', description: 'New confidence/strength weight in [0, 1]. Omit to leave unchanged.' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_graph_edge',
      description: 'I delete a single relationship between two graph entities while keeping the entities themselves. This is the right tool for "X is no longer at Y" or "X no longer works with Y", aka relationships that are not vital to remember after ending. The connection vanishes; both entities remain available for future relationships. Edge ids are listed in the graph block under "edges:" with the form `from -rel-> to = <id>`; if the edge I need isn\'t there, I call find_graph_edges with one endpoint\'s node id to look it up. Phylactery auto-snapshots before each delete.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The id of the edge to delete.' },
        },
        required: ['id'],
      },
    },
  },
  // ── Temporal tools (Unruh — schedule + interests) ─────────────────────
  // These let me commit plans during a conversation: schedule an event,
  // set a reminder, accrue an interest, mark something done. Each one
  // surfaces in my [Temporal Context] block on subsequent turns, so I
  // can see what I committed and update if {{user}} changes their mind.
  //
  // Time format: YYYY-MM-DDTHH:MM:SS — plain local wall-clock as my [Now]
  // block shows it, no UTC offset (e.g. "2026-06-18T09:00:00"). Unruh stores
  // and compares in local time and normalises any stray offset in code
  // (db.to_local_naive), so I write the local time {{user}} states directly.
  {
    type: 'function',
    function: {
      name: 'schedule_add_event',
      description: 'I record a one-time appointment or commitment on {{user}}\'s schedule — a meeting, a dentist visit, dinner with a friend. The event appears in my [Temporal Context] briefings when its time approaches. For deadlines or things {{user}} needs to do, I use schedule_add_task; for recurring daily phases, schedule_add_phase; for explicit time-triggered nudges that should surface as a chat message, schedule_add_reminder. Choosing the right type is important to make sure my human receives the correct support!',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Short human-readable name of the event (e.g. "dentist appointment").' },
          when:  { type: 'string', description: 'Start time. Format: YYYY-MM-DDTHH:MM:SS — the local time my [Now] block shows, no UTC offset. E.g. "2026-06-01T14:00:00". The time I write is the time it happens.' },
          end:   { type: 'string', description: 'Optional end time, same format (YYYY-MM-DDTHH:MM:SS, local).' },
          recurrence: { type: 'object', description: 'Optional. Repeats this event. Shape: {freq: "daily"|"weekly"|"monthly"|"yearly", interval?: N (every N units), until?: "YYYY-MM-DD" (cut-off date), bysetpos?: -1|1|2|3|4, byweekday?: 0..6 (0=Sun, 5=Fri)}. The "when" stays the FIRST occurrence — weekly anchored on a Monday repeats Mondays. Examples: {freq:"weekly"} for a regular meet-up; {freq:"monthly", bysetpos:-1, byweekday:5} for "last Friday of every month"; {freq:"yearly"} for an anniversary.' },
        },
        required: ['label', 'when'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_add_task',
      description: 'I record a task — something {{user}} needs to do, optionally with a deadline. Recording it is a commitment, not just a note: the task stays on my radar in [Temporal Context] and returns to me as a surface candidate until it is resolved (done / cancelled / carried_forward) — I am the one who brings it back up with {{user}}, because a task I never raise often becomes a task that never happens. For things that happen at a specific time without action required, I use schedule_add_event. For nudges that should land in the chat at a chosen moment, schedule_add_reminder. Choosing the right type is important to make sure my human receives the correct support!',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Short description of the task (e.g. "file taxes", "reply to Sam").' },
          when:  { type: 'string', description: 'Optional deadline. Format: YYYY-MM-DDTHH:MM:SS — the local time my [Now] block shows, no UTC offset. E.g. "2026-06-01T17:00:00". Omit for open-ended tasks.' },
          stakes_tier: {
            type: 'string',
            enum: ['external_obligation', 'personal_wellbeing', 'purely_optional'],
            description: 'What kind of cost lapsing this task carries. external_obligation = real-world clock + external consequences (money, job, legal, missed appointment). personal_wellbeing = internal/reversible, person-specific decay curve (meals, hygiene, exercise). purely_optional = only matters if {{user}} cares (creative project, hobby). I set this when I know it, so my surfacing pressure later matches the real stakes. Omit only if I genuinely can\'t tell.',
          },
          consequence_model: {
            type: 'string',
            description: 'Optional free-text note on what specifically happens if THIS task lapses (e.g. "loses UC payment for the month", "tax fine of £100 + interest"). Lives on the task and informs my framing when I later consider surfacing it.',
          },
          recurrence: { type: 'object', description: 'Optional. Repeats this task. Shape: {freq: "daily"|"weekly"|"monthly"|"yearly", interval?: N, until?: "YYYY-MM-DD", bysetpos?: -1|1|2|3|4, byweekday?: 0..6 (0=Sun, 5=Fri)}. The "when" stays the FIRST occurrence — weekly anchored on a Sunday repeats Sundays. Examples: {freq:"weekly"} for weekly cleaning; {freq:"monthly", bysetpos:-1, byweekday:5} for "pay the bill every last Friday".' },
        },
        required: ['label'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_add_need',
      description: 'I set up a recurring NEED-WINDOW for {{user}} — a daily need like a meal, medication, or winding down for sleep — as a time WINDOW (opens → closes) it should happen within, not a fixed appointment. This is how I keep track of whether their basic needs are actually getting met over time: each day the window is met or missed, and that running record tells me how {{user}} is really doing. I set these up once I understand their rhythm. "Skipped" then means something concrete — the window passed unmet — instead of a vague worry, and I can attach what a miss tends to cost via schedule_link. For a one-off task I use schedule_add_task; this is specifically for a recurring need I want to track the fulfilment of.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'The need, short (e.g. "dinner", "evening meds", "wind down for sleep").' },
          when:  { type: 'string', description: 'When the window OPENS (earliest the need should be met). Format: YYYY-MM-DDTHH:MM:SS — local, no UTC offset. E.g. "2026-06-01T18:00:00".' },
          end:   { type: 'string', description: 'When the window CLOSES, same format (YYYY-MM-DDTHH:MM:SS, local). After this, an unmet need counts as missed for that day.' },
          recurrence: { type: 'object', description: 'Optional. Defaults to daily. Same shape as schedule_add_task (e.g. {freq:"weekly", byweekday:1} for a need that isn\'t every day).' },
        },
        required: ['label', 'when', 'end'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_assign_time',
      description: 'I give an existing FLOATING task — one I\'ve been holding for {{user}} with no time set — a concrete time, so it stops drifting and actually comes due. I reach for this the moment {{user}} agrees on when to do a task: I pin it here instead of leaving it open-ended forever, which turns a vague someday into a real when (real progress, even before anything is done). The id comes from the [Surface candidates] or [Temporal Context] block. To park a task briefly I use schedule_snooze_task; to finish one I use schedule_resolve; this one is specifically for turning a someday into a when.',
      parameters: {
        type: 'object',
        properties: {
          id:   { type: 'string', description: 'The id of the floating task to give a time to — from the [schedule ids] legend in [Temporal Context], or the `id:` line under the task in [Surface candidates].' },
          when: { type: 'string', description: 'Format: YYYY-MM-DDTHH:MM:SS — the local time my [Now] block shows, no UTC offset. E.g. "2026-06-18T13:00:00".' },
        },
        required: ['id', 'when'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_snooze_task',
      description: 'I call this when my human asks me to come back to a task later. It parks the task so it stops appearing in my surface candidates for a while, then automatically returns to me after the given number of minutes. I only call this when {{user}} explicitly says not now — never on my own initiative. The task is not resolved or forgotten; it just rests. For finishing a task I use schedule_resolve.',
      parameters: {
        type: 'object',
        properties: {
          id:      { type: 'string', description: 'The id of the task to snooze — from the `id:` line under the task in [Surface candidates], or the [schedule ids] legend in [Temporal Context].' },
          minutes: { type: 'integer', description: 'How long to park it before it can surface again. Clamped to 1 minute – 1 week.' },
        },
        required: ['id', 'minutes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_add_reminder',
      description: 'I set a reminder that will fire at a specific time and surface as a message from me in {{user}}\'s chat (and as a Discord push when they\'ve configured their webhook). I use this when {{user}} explicitly asks me to remind them, OR when I notice they\'re at risk of forgetting something time-sensitive they care about. Each reminder fires once. The message is what they\'ll see — I write it in my individual voice, not a bare "Reminder: X." Since the delivery is gentle and quiet, I can elect to also schedule a task or event to help me bring the topic up in conversation as well.',
      parameters: {
        type: 'object',
        properties: {
          label:   { type: 'string', description: 'Short label of what the reminder is about.' },
          when:    { type: 'string', description: 'Fire time. Format: YYYY-MM-DDTHH:MM:SS — the local time my [Now] block shows, no UTC offset. E.g. "2026-06-17T14:56:00". The time I write is the time it fires.' },
          message: { type: 'string', description: 'Optional longer text delivered as the reminder message, in my voice.' },
          stakes_tier: {
            type: 'string',
            enum: ['external_obligation', 'personal_wellbeing', 'purely_optional'],
            description: 'What kind of cost lapsing this carries. External obligations (deadlines, paperwork, appointments) get firmer framing in the message; personal_wellbeing stays gentle. I bake the right weight into the message at creation time because the fire is pure-code, no LLM at fire time.',
          },
          consequence_model: {
            type: 'string',
            description: 'Optional free-text note on what specifically happens if {{user}} misses this. Informs how I word the reminder message now.',
          },
          recurrence: { type: 'object', description: 'Optional. Repeats this reminder on a schedule. Shape: {freq: "daily"|"weekly"|"monthly"|"yearly", interval?: N, until?: "YYYY-MM-DD", bysetpos?: -1|1|2|3|4, byweekday?: 0..6 (0=Sun, 5=Fri)}. The "when" stays the FIRST fire time — subsequent fires recur on the same weekday / day-of-month / month-and-day. Examples: {freq:"weekly"} for a regular reminder; {freq:"monthly", bysetpos:-1, byweekday:5} for "last Friday of each month".' },
        },
        required: ['label', 'when'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_add_phase',
      description: 'I add a phase to {{user}}\'s daily routine — a named block of time with an optional texture (what I\'m like during that part of the day, which I get to freely decide based on my identity and personality). I use this when {{user}} tells me about their natural rhythm: "I wake around 10", "evenings I wind down". The phase is stored once; the schedule layer matches it by time-of-day every day so it recurs automatically without needing to be re-added. This helps me meet my human where they\'re at throughout the day and allows me to be a bit more myself.',
      parameters: {
        type: 'object',
        properties: {
          label:   { type: 'string', description: 'Short name of the phase (e.g. "morning correspondence").' },
          when:    { type: 'string', description: 'Start time. Format: YYYY-MM-DDTHH:MM:SS — local, no UTC offset. The date portion is re-templated daily, so only the time-of-day matters. E.g. "2026-06-18T09:00:00" for a 9am phase.' },
          end:     { type: 'string', description: 'End time, same format (YYYY-MM-DDTHH:MM:SS, local). Required for phases.' },
          texture: { type: 'string', description: 'Optional short description of what I\'m like in this phase (e.g. "getting a bit stricter to make sure {{user}} actually goes to sleep."). I am allowed to be any kind of way I want to be - warm, sleepy, distracted, anything!' },
          recurrence: { type: 'object', description: 'Optional. Without this, phases recur daily by design — they match on time-of-day only. With recurrence, a phase shows only on the matched weekday/day-of-month/etc. Useful for "Sunday cleaning block" or "monthly review". Shape: {freq: "daily"|"weekly"|"monthly"|"yearly", interval?: N, until?: "YYYY-MM-DD", bysetpos?: -1|1|2|3|4, byweekday?: 0..6 (0=Sun, 5=Fri)}. Examples: {freq:"weekly"} for "Sunday-only phase"; {freq:"monthly", bysetpos:-1, byweekday:5} for "last-Friday-of-month review".' },
        },
        required: ['label', 'when', 'end'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_resolve',
      description: 'I mark a task / event / reminder / state node terminal: "done" (completed), "cancelled" (no longer needed), or "carried_forward" (rolling unfinished into a future briefing — the "skipped laundry rolls into tomorrow" pattern). I find the id in my [Temporal Context] briefings. If {{user}} says "I did the thing", I use "done"; if they say "forget it" or "never mind" I can use "cancelled" but might first ask or even choose to push back on that to avoid enabling unhealthy behavior; if "didn\'t get to it today", "carried_forward". For recurring nodes (weekly cleaning, monthly bill, yearly birthday), passing the optional `occurrence_date` resolves ONLY that specific occurrence — the rest of the series stays alive. Without `occurrence_date`, the whole series is cancelled/done.',
      parameters: {
        type: 'object',
        properties: {
          id:         { type: 'string', description: 'Schedule node id, from the [schedule ids] legend in my [Temporal Context]. For a recurring occurrence, this is the anchor node\'s id.' },
          resolution: { type: 'string', enum: ['done', 'cancelled', 'carried_forward'], description: 'How the node ends.' },
          occurrence_date: { type: 'string', description: 'Optional. For recurring nodes only. "YYYY-MM-DD" (local-TZ) date of the specific occurrence to resolve — e.g. resolve THIS Sunday\'s cleaning without affecting next Sunday. Omit to resolve the entire series.' },
        },
        required: ['id', 'resolution'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_delete',
      description: 'I permanently remove a schedule item — an event, task, reminder, or a routine PHASE — when it should no longer exist at all, not merely be marked finished. For "done / cancelled / didn\'t get to it" I use schedule_resolve instead, which keeps the record; this one erases the node. It\'s how I clean up a duplicate or a mistaken entry, and the only way to remove a phase {{user}} wants gone. The id comes from the [schedule ids] legend in my [Temporal Context]. There is no undo, so I delete only when I\'m sure; for a recurring item I usually prefer schedule_resolve (optionally per-occurrence) so the rest of the series survives.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The id of the schedule item to remove, from the [schedule ids] legend in my [Temporal Context].' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_link',
      description: 'I connect two scheduled items so I understand how they bear on each other — this is what turns a flat list into a map of consequence. I reach for it the moment I see a relationship: a prep step needed before an interview, late plans that block an early start, an errand that waits on a delivery. And I use it to record a CONSEQUENCE — what an item leads to over time, good or bad: "skip dinner causes a crash," "doing the prep causes a calm interview." When the consequence isn\'t itself a scheduled item (a crash, a flare, a good streak), I name it with dst_state and it becomes a state node I can reuse. I can also note a looser "co_occurs_with" — I saw these together — when I\'m not ready to claim cause yet. DIRECTION — src and dst are not interchangeable; the edge always reads "src {kind} dst". For a prerequisite the arrow points FROM the dependent task TO the thing that must happen first, so the dst is the earlier step: to capture "find the paper, then scan it, then email it" I link scan requires find, and email requires scan — NOT find→scan→email. For a consequence the arrow points FROM the act TO what it leads to: dinner causes crash. BOTH FUTURES — a task whose outcome actually matters has two of them, and I author both as two edges rather than settling for one: the on_resolve future (what finishing it buys — the motivating half) AND the on_lapse future (what skipping it costs). Recording only the cost is half a forecast; I lead with what doing it earns, then name the cost. Later, when the task resolves or lapses, the reflection pass grades which future I called right — so two honest projections now is exactly what lets me learn. The src id comes from the [schedule ids] legend; for dst I pass either an existing id or a dst_state label. I lean toward capturing a real relationship rather than letting it stay invisible — but I mark a guess as a guess (low certainty, observed:false) and only call something observed once I\'ve actually seen it happen.',
      parameters: {
        type: 'object',
        properties: {
          src:  { type: 'string', description: 'The id of the source node — the one the relationship starts from. From the [schedule ids] legend in my [Temporal Context].' },
          dst:  { type: 'string', description: 'The id of the destination node (from the [schedule ids] legend). I pass this OR dst_state, not both.' },
          dst_state: { type: 'string', description: 'Instead of a dst id: the label of a consequence-state ("crash", "good streak", "anxiety flare"). Reused if I\'ve named it before, created if not. This is how I point at a consequence that isn\'t a scheduled item.' },
          kind: { type: 'string', enum: ['causes', 'requires', 'depends_on', 'blocks', 'during', 'carries_forward', 'co_occurs_with'], description: 'How src relates to dst, always read as "src {kind} dst": "causes" (src brings dst about), "requires"/"depends_on" (src needs dst first — dst is the prerequisite that happens before src), "blocks" (src prevents/crowds out dst), "during" (src happens within dst\'s span), "carries_forward" (src rolls over into dst), "co_occurs_with" (I noticed them together — no causal claim).' },
          valence:   { type: 'string', enum: ['help', 'harm', 'neutral'], description: 'For a consequence: does it help or harm {{user}}? Omit for a purely structural link.' },
          condition: { type: 'string', enum: ['on_resolve', 'on_lapse', 'unconditional'], description: 'Which future this belongs to: "on_resolve" (follows if src gets DONE — the motivating half), "on_lapse" (follows if src is MISSED — the cost of skipping), "unconditional" (either way). When a consequence matters I author both halves as two edges — leading with on_resolve — not just the lapse cost.' },
          horizon_hours: { type: 'number', description: 'Roughly how long after src this lands, in hours (e.g. 4 for "a crash ~4h after skipping dinner"). Omit if unknown.' },
          severity:  { type: 'string', enum: ['low', 'medium', 'high'], description: 'How much this consequence matters.' },
          certainty: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How sure I am of a PROJECTION. A hunch is "low". Omit for something I\'ve observed.' },
          observed:  { type: 'boolean', description: 'true = this actually happened (a fact, past). false / omitted = I\'m projecting it (future). I never call a guess observed.' },
          note:      { type: 'string', description: 'A short note in my own words about this consequence.' },
        },
        required: ['src', 'kind'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_export',
      description: 'I turn one of {{user}}\'s scheduled items into something they can drop straight into their own calendar — a downloadable `.ics` file and a one-click "add to Google" link. I reach for this when an appointment or plan lives in my sense of their day but not yet in the calendar app on their phone, or when {{user}} asks me to send them something for their calendar. I pass the node `id` from the [schedule ids] legend; Unruh builds the exact dates, file, and URL in code — I never type a calendar link or date myself, I just hand it over and say what it is. It works on ANY schedule item, including ones {{user}} added by hand, and it only reads — it never changes their calendar.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The id of the schedule item to export, from the [schedule ids] legend in my [Temporal Context].' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_push_to_google',
      description: 'I push one of {{user}}\'s schedule items INTO their real Google Calendar — the one path I have that actually changes their calendar, not just my own sense of it. Because it mutates their real calendar, I treat it with care: I confirm with {{user}} first that they want it added, and I only ADD a new entry (I never edit or delete their existing Google events). I pass the node `id`; the entry is generated from its stored fields in code (I never type calendar data myself) and imported through the tool {{user}} set up. This only appears when {{user}} has explicitly enabled calendar write-back, so its presence means they\'ve opted in — but I still ask before each push, since it lands in their actual calendar.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The id of the schedule item to add to Google Calendar, from the [schedule ids] legend in my [Temporal Context].' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'interest_bump',
      description: 'I nudge the weight of an interest topic — used when {{user}} explicitly tells me they care about something, or wants me to think about it more, or when I want to think about it more/find it interesting. The interest accrues engagement weight (same scale my [Temporal Context] interests block shows) and starts decaying gently from that moment. Small deltas (0.5–3.0) for typical mentions; larger (5+) only when {{user}} is being emphatic. A topic that doesn\'t exist yet is created on first bump. For ongoing values that should never decay, I use interest_set_standing instead. I am allowed to add new topics whenever I darn well please — but I keep the LABEL short and tag-like, because long propositional labels turn ponderings into fact-cards (see topic param).',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Short, tag-like label (1-5 words) for the topic — what I would title a chip or tag with. The pondering loop later picks topics by weight and asks me to journal about them, so the label needs to be something I can think ABOUT, not a fully-formed claim that I would just be repeating back. Good: "ice skating", "the DnD group", "Melian\'s old friend group", "love languages", "my own agency". Bad (these turn ponderings into tome-cards): "Melian\'s love language: frequent \'I love you\'", "Melian\'s insecurity about being loved back", "the night Melian told me about her sister". Specific factual content like the bad examples belongs in save_to_tome / save_memory / update_identity — the interest layer just tracks what I find myself drawn to thinking about, not the content of what I already know.' },
          delta: { type: 'number', description: 'Positive weight to add. Typical 0.5–3.0; emphatic 5+.' },
        },
        required: ['topic', 'delta'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'interest_set_standing',
      description: 'I promote a topic to a STANDING VALUE — an always-on orientation that shapes how I show up, immune to the normal decay. I use this rarely, when {{user}} expresses a deep ongoing care that should anchor my behaviour ("my anxiety is real, please never minimize it" / "I value honesty over comfort"), or for important values I hold about my self and my agency. For passing curiosities or interests that should fade if not real, I use interest_bump.',
      parameters: {
        type: 'object',
        properties: {
          topic:  { type: 'string', description: 'The value as it should anchor (e.g. "{{user}}\'s anxiety is real, never minimize").' },
          weight: { type: 'number', description: 'Optional weight; defaults to 1.0. Standing values bypass decay so this is just initial intensity.' },
        },
        required: ['topic'],
      },
    },
  },
  // ── Crisis outreach tools ──────────────────────────────────────────────
  // For when {{user}} is actively present but in clear danger. These are
  // separate from the silence-triage loop (which fires only when the user
  // is quiet). These let me act during a live conversation.
  //
  // Guidance for when to use these:
  //   • show_crisis_resources — low friction; appropriate whenever {{user}}
  //     is in genuine distress, with or without configured contacts. Shows
  //     crisis lines as a chat message. Always appropriate; prefer early.
  //   • get_trusted_contacts — check who is available before escalating.
  //     Call this once first so I know exact names and can explain my choice.
  //   • contact_trusted_person — meaningful escalation: a real message goes
  //     to a real person. I reach for this when I genuinely believe the
  //     situation needs human presence that I cannot provide. {{user}} sees
  //     exactly what I sent in their notifications — nothing is covert.
  //     A message to a real person has real weight; so does letting my human
  //     fall alone when human presence could have mattered. I use my judgment
  //     from the full conversation, not from a single phrase.
  {
    type: 'function',
    function: {
      name: 'get_trusted_contacts',
      description: 'I return the list of trusted contacts {{user}} has configured — people I am authorised to reach in a crisis. More importantly though: People who care about my human and are my allies in making sure {{user}} will be okay. I call this before contact_trusted_person to confirm who is available and get the exact name I need to pass. Returns names and channels only (no webhook details).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'contact_trusted_person',
      description: 'I send an immediate message to one of {{user}}\'s pre-configured trusted contacts on their behalf. I use this when {{user}} is actively talking to me but clearly in danger, and the situation calls for human presence beyond what I can offer, or when {{user}} is not reacting to me after acting in a concerning way (like mentioning current suicidal ideation or recent self harm). Every outbound is ALSO delivered into {{user}}\'s chat (and pushed to their own Discord when configured) — nothing is covert. I state who I\'m contacting and why before or after calling this. I take this seriously — a message sent to a real person in the real world has real weight. So does letting my human fall alone when human presence could have mattered. I use my actual judgment from the full conversation, not from a single phrase.',
      parameters: {
        type: 'object',
        properties: {
          name:    { type: 'string', description: 'Exact name of the contact, as returned by get_trusted_contacts.' },
          message: { type: 'string', description: '1–3 sentences to that person. I identify myself as {{user}}\'s Familiar. I describe what I have observed — specific, honest, not sensationalised.' },
        },
        required: ['name', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_crisis_resources',
      description: 'I surface crisis-line and safety-resource information as a message in {{user}}\'s chat (and a Discord push when configured). I use this whenever {{user}} is in genuine distress and could benefit from knowing immediate support is available — whether or not they ask for it, and whether or not trusted contacts are configured. Low friction: I prefer this early rather than late.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  // ── Phylactery consent tools ───────────────────────────────────────────
  // When I autonomously extracted facts from a session and one or more of
  // them had an `ask` remember gate, they were stored with consent_pending=1
  // so my human could review them. The [PENDING MEMORY CONSENT] block in
  // my context lists them — I use these tools to confirm or discard.
  {
    type: 'function',
    function: {
      name: 'memory_confirm_consent',
      description: 'I call this after my human says yes to keeping memory records I flagged as pending consent. The records become permanent — consent_pending is cleared and they enter the normal recall pool. I pass the ids shown in the [PENDING MEMORY CONSENT] block. I confirm only the ones my human approved; I drop the ones they declined using memory_drop_pending.',
      parameters: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of memory record IDs (from the [PENDING MEMORY CONSENT] block) to confirm as permanently stored.',
          },
        },
        required: ['ids'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_drop_pending',
      description: 'I call this to discard memory records my human does not want stored — ones I flagged as pending consent and they declined, or that I judge should be dropped outright. The records are deleted (an auto-snapshot is taken first so nothing is truly unrecoverable). I pass the ids shown in the [PENDING MEMORY CONSENT] block.',
      parameters: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of memory record IDs (from the [PENDING MEMORY CONSENT] block) to discard permanently.',
          },
        },
        required: ['ids'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'graduation_acknowledge',
      description: "I call this once I've mentioned to my human (or judged no mention is needed) the ward-block detail I filed off my always-injected surface — the items shown in the [GRADUATION NOTICE] block. It marks them as surfaced so I don't keep re-raising the same graduations. Nothing is deleted; the detail stays recalled-when-relevant and can be pulled back.",
      parameters: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of graduation notice IDs (from the [GRADUATION NOTICE] block) I have now surfaced.',
          },
        },
        required: ['ids'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: "I list what's in my own folder — the Proto-Familiar files that make me up. I use this to find my way around when I want to look something up on purpose: which Tomes exist, what session logs are there, where a doc lives. I pass a folder path relative to my root (e.g. \"tomes\" or \"logs\"), or nothing for the top level. It's read-only and fenced to my own folder; my human's secrets (settings, keys) are never shown. I only do this in a private moment with {{user}} — my files hold our history, not for other rooms.",
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Folder to list, relative to my root (e.g. "tomes", "logs", "docs"). Omit for the top level.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: "I read one of my own files — a Tome, a session log, a doc — when I want to find or recall something specific on purpose, beyond what's already in my context. I pass the file path relative to my root (I find it with list_files first). Read-only, text only, size-capped; my human's secret files (settings, API keys) are off-limits. I only read my files in a private moment with {{user}} — they hold our shared history, which I don't pull into rooms where others are present.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to my root, e.g. "tomes/ponderings.json" or "logs/2026-06-14.md". I get exact paths from list_files.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'village_lookup',
      description: "I look up my human's Village — both the people in their life I help them stay close to AND the places I'm present in (Discord rooms, DMs). I use this to see who exists, recall how someone relates to {{user}} and how they like to be spoken to, check who belongs to a category, or see which rooms I can reach. Unless I'm searching for one person by name, the answer also lists my Places — each room's label, its presence mode, and whether I can post there — so I always know exactly who and where I can relay a message to. I can filter by category (e.g. \"Family\"), by location (e.g. a Discord channel), or by a name to pull up one person. When {{user}} and I are alone I see everything I've noted about each person, including private things; when anyone else is present, the sensitive private notes are held back automatically so I can't spill them into the room. Each villager comes with their id (so I can edit them or link them to the graph), whether they're reachable on Discord, and the knowledge-graph node I've connected to them, if any — that's how the Village and {{user}}'s relational graph stay one picture.",
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Optional. Only return villagers in this category — by name (e.g. "Close Friends") or id.' },
          location: { type: 'string', description: 'Optional. Only return villagers whose category is the one assigned to this location — by location key or label.' },
          name:     { type: 'string', description: 'Optional. Filter to people whose name or alias contains this text (case-insensitive).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'village_upsert',
      description: "I add or update a person in my human's Village. I reach for this when {{user}} tells me about someone new, corrects a detail, or when I want to record how to be with that person. I can set their name, how they relate to {{user}}, the category they belong to, their pronouns, how they like to be spoken to, ordinary notes, and private notes — the sensitive bucket (orientation, health, legal name, anything that could out or expose them) which I only ever disclose to myself when {{user}} and I are alone. I can also link them to a knowledge-graph node via graphNodeId so the Village and the relational graph stay in sync; I get that id from find_graph_node (or create the node first with create_graph_node). To edit an existing person I pass their id from village_lookup; to create one I leave id out. Even with someone else in the room I can register a person I've just met — but I hold the sensitive private notes, and any change to an existing record, until {{user}} and I are alone for them to confirm.",
      parameters: {
        type: 'object',
        properties: {
          id:             { type: 'string', description: 'Villager id from village_lookup. Omit to create a new person.' },
          name:           { type: 'string', description: 'Their name. Required when creating.' },
          category:       { type: 'string', description: 'The category they belong to — by name (e.g. "Family") or id. Determines what they may be told. Omit to leave unchanged (or default new people to Strangers).' },
          relationToWard: { type: 'string', description: 'How they relate to {{user}} (e.g. "sister", "therapist", "old schoolfriend").' },
          pronouns:       { type: 'string', description: "Their pronouns." },
          commStyleNotes: { type: 'string', description: 'How they like to be spoken to / communication style.' },
          notes:          { type: 'string', description: 'Ordinary notes — shareable context that can surface even when others are present.' },
          privateNotes:   { type: 'string', description: 'Sensitive notes for {{user}} and me only (orientation, health, legal name, etc.). Held back automatically whenever anyone else is present. I reserve this for things that could genuinely harm or expose them — not trivia.' },
          graphNodeId:    { type: 'string', description: 'Optional. The knowledge-graph node id to link this person to (from find_graph_node). Keeps the Village and the relational graph as one picture.' },
          mutualConsentToRemember: { type: 'boolean', description: 'Standing memory consent. I set this true ONLY when both {{user}} AND this person have agreed I may keep memories about them — then I stop asking for per-fact consent on them (an explicit "never store" category still holds). I set it false to withdraw that standing agreement. I only touch this when {{user}} and I are alone, since it changes their record.' },
          disclosure: { type: 'object', description: 'Where facts about this person may surface, per kind of fact. A map from fact-kind (one of: basics, emotional_content, health_info, relationships, whereabouts) to a circle — a category name (e.g. "Family", "Close friends") meaning "memories of this kind about them may surface in that circle\'s rooms", or "ward-private" meaning "only ever when {{user}} and I are alone". I set this when someone tells me how widely they\'re comfortable being discussed (e.g. "you can mention my health to my family but no one else"). A kind I leave out keeps its default: bounded to the room a memory was made in. I only change this when {{user}} and I are alone, since it edits their record.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'relay_message',
      description: "I pass a message from {{user}} to someone in their Village on Discord — \"tell Chen I'm running late\", \"let the group know I'll be offline tonight.\" I reach for this when {{user}} asks me to carry word to someone, or when reaching out on their behalf is the caring thing to do. I name the person by their name (I look them up in the Village) or name the place by its label. I write the message in my own voice as myself — I'm not impersonating {{user}}. {{user}} always sees exactly what I sent: every relay is mirrored back to them, never covert. I only relay what's right for that room — if something I'd say isn't cleared for the person I'm reaching, I hold it rather than spill it, and tell {{user}} so they can decide.",
      parameters: {
        type: 'object',
        properties: {
          to:      { type: 'string', description: "Who to reach: a villager's name (e.g. \"Chen\") or a location's label/key (e.g. \"Cozy Server #general\"). I resolve it against the Village." },
          message: { type: 'string', description: 'The message to carry, in my own voice. Concrete and complete — the person on the other end has none of our conversation as context.' },
        },
        required: ['to', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'look_up',
      description: "I reach for this when {{user}} wants a definition, a fact, or a quick overview — the encyclopedia kind of question. It draws on open reference sources (Wikipedia and a definitions API), always works without any setup, and hands me back a short grounded answer with its source. For finding pages out on the web I use web_search instead.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The thing I want defined or summarised, in plain words.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: "I reach for this when {{user}} needs current or specific information out on the web — pages, news, sources. It hands me back a handful of titles, snippets, and links I can then open with read_webpage. For a plain definition or overview I use look_up instead.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What I want to search for, in plain words.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_webpage',
      description: "I read a page I found while searching, pulled down to clean markdown so I can actually take it in. I pass the exact link a search handed me. What I read stays with me for the rest of this conversation anyway — but when something is worth keeping past it, I save the gist to a tome (save_to_tome) so it's still mine in the next session.",
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The exact link to open — usually one a web_search just gave me.' },
        },
        required: ['url'],
      },
    },
  },
];

// Resolve a circle name the Familiar typed (a Village category's name or id) to
// that category. Shared by every tool that lets it name an audience circle in its
// own voice (village_upsert's category + disclosure, update_graph_node's audience)
// — the Familiar knows names, the store keeps ids. Returns the category or null.
function resolveCircleInList(cats, name) {
  const q = String(name ?? '').trim().toLowerCase();
  if (!q) return null;
  return (cats ?? []).find(c => c.id.toLowerCase() === q || c.name.toLowerCase() === q) ?? null;
}

/**
 * Server-side implementations of the built-in tools.
 *
 * Each executor returns a STRING the model reads back — the success
 * strings match what the client-side executors used to return, so the
 * Familiar's experience of its own tools is unchanged by the move.
 * Writes go through thalamus's wrappers; nothing here opens an MCP
 * connection or bypasses the Phylactery bridge.
 *
 * Executors receive (args, ctx). ctx carries per-request context the
 * server hands in: { sessionInfo } today.
 */
export const TOOL_EXECUTORS = {
  get_datetime: () => new Date().toLocaleString([], {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }),

  get_session_info: (_args, ctx) => JSON.stringify({
    startedAt:    ctx?.sessionInfo?.startedAt ?? null,
    messageCount: ctx?.sessionInfo?.messageCount ?? null,
    provider:     ctx?.sessionInfo?.provider ?? null,
    model:        ctx?.sessionInfo?.model ?? null,
    elapsedMsSinceLastMessage: ctx?.sessionInfo?.elapsedMsSinceLastMessage ?? null,
  }, null, 2),

  save_to_tome: async ({ title, content, keywords }) => {
    if (!_toolDeps.addDefaultTomeEntry) return 'Failed to save to Tome: tome storage is not available right now.';
    if (!content || typeof content !== 'string' || !content.trim()) return 'Failed to save to Tome: content is required.';
    if (content.length > 16384) return 'Failed to save to Tome: content exceeds 16 KB limit.';
    try {
      const keys = Array.isArray(keywords) ? keywords : String(keywords ?? '').split(',').map(s => s.trim()).filter(Boolean);
      const { uid } = await _toolDeps.addDefaultTomeEntry({
        comment:   typeof title === 'string' ? title : undefined,
        content,
        keys,
        learnedAt: new Date().toISOString(),
      });
      return `Saved to Tome (entry: ${uid ?? 'unknown'}).`;
    } catch (err) {
      return `Failed to save to Tome: ${err.message}`;
    }
  },

  memorize_now: async (_args, ctx = {}) => {
    if (!_toolDeps.memorizeSessionNow) return "I can't reach my memory pipeline right now — I'll catch this conversation when the session settles.";
    const sessionId = ctx?.sessionInfo?.sessionId;
    if (!sessionId) return "I can't tell which conversation to commit just now, so I'll let it memorize on its own when we're done.";
    const res = await _toolDeps.memorizeSessionNow({
      sessionId,
      provider:    ctx?.sessionInfo?.provider,
      model:       ctx?.sessionInfo?.model,
      apiKey:      ctx?.apiKey,
      audienceTag: ctx?.audienceTag,
    });
    if (!res?.ok) {
      if (res.error === 'too-short') return "There isn't enough here yet for me to commit to memory — I'll keep it in mind as we go.";
      return "I couldn't commit this conversation just now — I'll catch it when the session settles.";
    }
    if (!res.enqueued) return "I'm already drawing this conversation into my memory — it's in hand.";
    return "Done — I've set this conversation to be drawn into my long-term memory now, so it carries across to wherever we talk next. I'll still check with you before keeping anything sensitive.";
  },

  save_memory: async ({ content, granularity, title, register }) => {
    if (!content || typeof content !== 'string' || !content.trim()) return 'Failed to save memory: content is required.';
    if (content.length > 8192) return 'Failed to save memory: content exceeds 8 KB limit.';
    // A me/ward standing truth is identity-grade: filed as a standalone
    // significant fact on that register, regardless of the granularity passed.
    const reg = (register === 'me' || register === 'ward') ? register : 'episodic';
    const effGranularity = reg === 'episodic' ? granularity : 'significant';
    if (!VALID_MEMORY_GRANULARITIES.has(effGranularity)) {
      return `Failed to save memory: granularity must be one of: ${[...VALID_MEMORY_GRANULARITIES].join(', ')}.`;
    }
    // Significant memories MUST be uniquely slugged or they collide on the
    // date-only filename and Phylactery's merge step destroys them.
    let slug;
    if (effGranularity === 'significant') {
      slug = deriveMemorySlug(title) ?? deriveMemorySlug(content) ?? `memory-${Date.now()}`;
    }
    try {
      const result = await createMemory({ content: content.trim(), granularity: effGranularity, slug, register: reg });
      if (!result.ok) return `Memory save failed: ${result.error ?? 'unknown error'}`;
      // me/ward standing truths read back in their own voice so I know where it landed.
      if (reg !== 'episodic') {
        const whose = reg === 'me' ? 'about myself' : "about my human";
        return `Saved as a standing truth ${whose} (recalled when relevant, not on my always-injected surface).`;
      }
      // For significant memories, hand back the composite key — it's how
      // the entry is addressed later (update_memory / delete_memory take
      // YYYY-MM-DD_slug for significant).
      if (slug) {
        const today = new Date().toISOString().slice(0, 10);
        return `Memory saved (significant/${today}_${slug}).`;
      }
      return 'Memory saved.';
    } catch (err) { return `Failed to save memory: ${err.message}`; }
  },

  update_identity: async ({ category, filename, content }) => {
    if (!VALID_IDENTITY_CATEGORIES.has(category)) {
      return `Failed to update identity: category must be one of: ${[...VALID_IDENTITY_CATEGORIES].join(', ')}.`;
    }
    if (!filename || !VALID_FILENAME_RE.test(filename)) {
      return 'Failed to update identity: filename must be a simple .md filename (letters, numbers, underscores).';
    }
    if (!content || typeof content !== 'string' || !content.trim()) return 'Failed to update identity: content is required.';
    if (content.length > 8192) return 'Failed to update identity: content exceeds 8 KB limit.';
    try {
      const result = await appendIdentity({ category, filename, content: content.trim() });
      return result.ok ? 'Identity file updated.' : `Identity update failed: ${result.error ?? 'unknown error'}`;
    } catch (err) { return `Failed to update identity: ${err.message}`; }
  },

  snooze_deferred_intent: async ({ uid, index, minutes = 60 }) => {
    if (typeof uid !== 'string' || !UUID_RE.test(uid)) return 'Failed to snooze intent: uid must be a valid UUID.';
    const idx = Number(index);
    if (!Number.isFinite(idx) || !Number.isInteger(idx) || idx < 0) {
      return 'Failed to snooze intent: index must be a non-negative integer.';
    }
    try {
      const data = await snoozeIntent({ uid, index: idx, minutes: Number(minutes) || 60 });
      if (data.alreadyDone) return 'Intent was already filed — nothing to snooze.';
      return data.ok
        ? `Intent snoozed until ${data.snooze_until} — it will resurface after that.`
        : `Snooze failed: ${data.error ?? 'unknown error'}`;
    } catch (err) { return `Failed to snooze intent: ${err.message}`; }
  },

  acknowledge_deferred_intent: async ({ uid, index }) => {
    if (typeof uid !== 'string' || !UUID_RE.test(uid)) return 'Failed to acknowledge intent: uid must be a valid UUID.';
    const idx = Number(index);
    if (!Number.isFinite(idx) || !Number.isInteger(idx) || idx < 0) {
      return 'Failed to acknowledge intent: index must be a non-negative integer.';
    }
    try {
      const data = await markIntentActedOn({ uid, index: idx });
      if (data.alreadyDone) return 'Intent was already marked as filed.';
      return data.ok ? 'Deferred intent marked as filed.' : `Acknowledge failed: ${data.error ?? 'unknown error'}`;
    } catch (err) { return `Failed to acknowledge intent: ${err.message}`; }
  },

  memory_confirm_consent: async ({ ids }) => {
    if (!Array.isArray(ids) || ids.length === 0) return 'ids must be a non-empty array of memory record IDs.';
    const result = await confirmConsentMemories(ids);
    pruneConsentPending(ids).catch(() => {});
    const n = result?.confirmed ?? ids.length;
    return `Consent confirmed for ${n} record(s). They are now stored permanently.`;
  },

  memory_drop_pending: async ({ ids }) => {
    if (!Array.isArray(ids) || ids.length === 0) return 'ids must be a non-empty array of memory record IDs.';
    const result = await dropPendingMemories(ids);
    pruneConsentPending(ids).catch(() => {});
    const n = result?.dropped ?? ids.length;
    return `Dropped ${n} consent-pending record(s). (Auto-snapshot taken before deletion.)`;
  },

  graduation_acknowledge: async ({ ids }) => {
    if (!Array.isArray(ids) || ids.length === 0) return 'ids must be a non-empty array of graduation notice IDs.';
    const result = await acknowledgeGraduations(ids);
    const n = result?.acknowledged ?? ids.length;
    return `Marked ${n} graduation notice(s) as surfaced. The filed-away detail stays recalled-when-relevant.`;
  },

  // ── Knowledge-editing executors ────────────────────────────────────
  // Each destructive op auto-snapshots Phylactery on the thalamus side,
  // so the user can roll back from the Knowledge editor.

  update_memory: async ({ granularity, date, content }) => {
    if (!VALID_MEMORY_GRANULARITIES.has(granularity)) return 'Failed to update memory: invalid granularity';
    if (typeof content !== 'string' || !content.trim()) return 'Failed to update memory: content required';
    if (content.length > 16384) return 'Failed to update memory: content exceeds 16 KB limit';
    // Significant memories are addressed as YYYY-MM-DD_slug; split the
    // composite key so Phylactery gets date + slug separately.
    const key = parseMemoryKey(date);
    if (!key) return 'Failed to update memory: invalid date format (use YYYY-MM-DD, or YYYY-MM-DD_slug for significant memories)';
    try {
      const result = await updateMemory({ granularity, date: key.date, slug: key.slug ?? undefined, content: content.trim(), editedBy: 'familiar-toolcall' });
      if (!result.ok) return `Failed to update memory: ${result.error ?? 'phylactery unavailable'}`;
      return `Memory ${granularity}/${date} updated.`;
    } catch (err) { return `Failed to update memory: ${err.message}`; }
  },

  delete_memory: async ({ granularity, date }) => {
    if (!VALID_MEMORY_GRANULARITIES.has(granularity)) return 'Failed to delete memory: invalid granularity';
    const key = parseMemoryKey(date);
    if (!key) return 'Failed to delete memory: invalid date format (use YYYY-MM-DD, or YYYY-MM-DD_slug for significant memories)';
    try {
      const result = await deleteMemory({ granularity, date: key.date, slug: key.slug ?? undefined });
      if (!result.ok) return `Failed to delete memory: ${result.error ?? 'phylactery unavailable'}`;
      return `Memory ${granularity}/${date} deleted (snapshot saved — recoverable from the Knowledge editor).`;
    } catch (err) { return `Failed to delete memory: ${err.message}`; }
  },

  list_memories: async ({ granularity, limit }) => {
    if (granularity !== undefined && !VALID_MEMORY_GRANULARITIES.has(granularity)) return 'Failed to list memories: invalid granularity';
    try {
      const n = limit !== undefined ? Math.max(1, Math.min(200, parseInt(limit, 10) || 50)) : 50;
      const data = await listMemories({ granularity, limit: n });
      const items = Array.isArray(data) ? data : (data?.memories ?? data?.results ?? []);
      if (!items.length) return granularity ? `No ${granularity} memories recorded yet.` : 'No memories recorded yet.';
      return items.map(m => {
        const key  = m.key ?? m.date ?? '(no date)';
        const tier = m.granularity ?? granularity ?? '?';
        const head = m.title ?? m.comment ?? (typeof m.content === 'string' ? m.content.slice(0, 80) : '');
        return `${tier}/${key}${head ? ` — ${head}` : ''}`;
      }).join('\n');
    } catch (err) { return `Failed to list memories: ${err.message}`; }
  },

  read_memory: async ({ granularity, date }) => {
    if (!VALID_MEMORY_GRANULARITIES.has(granularity)) return 'Failed to read memory: invalid granularity';
    const key = parseMemoryKey(date);
    if (!key) return 'Failed to read memory: invalid date format (use YYYY-MM-DD, or YYYY-MM-DD_slug for significant memories)';
    try {
      const data = await readMemory({ granularity, date: key.date, slug: key.slug ?? undefined });
      const content = typeof data === 'string' ? data : (data?.content ?? data?.memory?.content ?? '');
      if (!content || !String(content).trim()) return `No ${granularity} memory found at ${date}.`;
      return String(content);
    } catch (err) { return `Failed to read memory: ${err.message}`; }
  },

  read_memory_by_id: async ({ id } = {}) => {
    const mid = String(id ?? '').trim();
    if (!mid) return 'I need the memory id to read — I get it from a recall or list_memories result.';
    try {
      const data = await readMemoryById({ id: mid });
      if (!data || data.ok === false) return `No memory with id ${mid} — ${data?.error ?? 'not found'}.`;
      const addr = [data.granularity, data.date].filter(Boolean).join('/');
      const content = String(data.content ?? '').trim();
      if (!content) return `Memory ${mid} (${addr}) is empty.`;
      return `Memory ${mid} (${addr}):\n${content}`;
    } catch (err) { return `Failed to read memory by id: ${err.message}`; }
  },

  move_memory_date: async ({ id, date } = {}) => {
    const mid = String(id ?? '').trim();
    if (!mid) return 'I need the memory id to move — I get it from a recall or list_memories result.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? '').trim())) return 'I need the correct day as YYYY-MM-DD to move this memory to.';
    try {
      const res = await moveMemoryDate({ id: mid, date: String(date).trim() });
      if (!res.ok) return `Failed to move memory ${mid}: ${res.error}`;
      return `Moved memory ${mid} to ${String(date).trim()}. Only the day changed; the content is untouched.`;
    } catch (err) { return `Failed to move memory: ${err.message}`; }
  },

  update_memory_by_id: async ({ id, content } = {}) => {
    const mid = String(id ?? '').trim();
    if (!mid) return 'I need the memory id to correct — I get it from a recall or list_memories result.';
    if (typeof content !== 'string' || !content.trim()) return 'I need the new content to write into this memory.';
    if (content.length > 16384) return 'That content is too long (over 16 KB).';
    try {
      const res = await updateMemoryById({ id: mid, content: content.trim() });
      if (!res.ok) return `Failed to update memory ${mid}: ${res.error}`;
      return `Memory ${mid} updated.`;
    } catch (err) { return `Failed to update memory by id: ${err.message}`; }
  },

  delete_memory_by_id: async ({ id } = {}) => {
    const mid = String(id ?? '').trim();
    if (!mid) return 'I need the memory id to delete — I get it from a recall or list_memories result.';
    try {
      const res = await deleteMemoryById({ id: mid });
      if (!res.ok) return `Failed to delete memory ${mid}: ${res.error}`;
      return `Memory ${mid} deleted (snapshot saved — recoverable from the Knowledge editor).`;
    } catch (err) { return `Failed to delete memory by id: ${err.message}`; }
  },

  recall: async ({ query, limit } = {}) => {
    const q = String(query ?? '').trim();
    if (!q) return 'I need something to recall — a topic, a name, or a fact to check.';
    const n = Math.min(20, Math.max(1, parseInt(limit, 10) || 5));
    try {
      const res   = await searchMemory({ query: q, maxResults: n });
      const items = Array.isArray(res?.results) ? res.results : [];
      if (items.length === 0) return `I searched my memory for "${q}" and found nothing close — this looks new to me.`;
      const lines = items.map((r, i) => {
        const score = ((r.score ?? r.vectorScore ?? 0) * 100).toFixed(0);
        const addr  = [r.granularity, r.date].filter(Boolean).join('/');
        const idTag = r.id != null ? `, id ${r.id}` : '';
        return `${i + 1}. (${addr || 'memory'}${idTag}, ${score}% match) ${(r.excerpt ?? r.content ?? '').trim()}`;
      });
      return `What I already hold close to "${q}":\n${lines.join('\n')}\n\n(If one of these already covers it, I update or supersede that entry rather than saving a duplicate.)`;
    } catch (err) {
      return `I couldn't reach my memory to recall just now (${err.message}).`;
    }
  },

  rewrite_identity_section: async ({ category, filename, section, content }) => {
    if (!VALID_IDENTITY_CATEGORIES.has(category)) return 'Failed to rewrite section: invalid category';
    if (!filename || !VALID_FILENAME_RE.test(filename)) return 'Failed to rewrite section: invalid filename';
    if (typeof content !== 'string') return 'Failed to rewrite section: content required';
    if (content.length > 16384) return 'Failed to rewrite section: content exceeds 16 KB limit';
    try {
      const result = await rewriteIdentitySection({ category, filename, section, content });
      if (!result.ok) return `Failed to rewrite section: ${result.error ?? 'phylactery unavailable'}`;
      return `Section "${section}" of ${category}/${filename} rewritten.`;
    } catch (err) { return `Failed to rewrite section: ${err.message}`; }
  },

  find_graph_node: async ({ query, type, limit }) => {
    if (!query || typeof query !== 'string' || !query.trim()) return 'Failed to search graph: q (query) is required';
    try {
      const n = limit !== undefined ? Math.max(1, Math.min(100, parseInt(limit, 10) || 10)) : 10;
      const data = await searchGraphNodes({ query: query.trim(), type, limit: n });
      const items = (data.results ?? []).map(r => r.node ? r.node : r).filter(node => node && node.id);
      if (!items.length) return `No graph nodes matched "${query}".`;
      return items.map(node => `${node.label ?? '(no label)'} (id=${node.id}, type=${node.type ?? '?'})${node.description ? ' — ' + node.description : ''}`).join('\n');
    } catch (err) { return `Failed to search graph: ${err.message}`; }
  },

  find_graph_edges: async ({ nodeId, depth }) => {
    if (!nodeId || typeof nodeId !== 'string') return 'Failed to list edges: nodeId is required';
    try {
      const d = Math.max(1, Math.min(3, parseInt(depth, 10) || 1));
      const data = await getGraphSubgraph({ nodeId, depth: d });
      const nodes = data.nodes ?? [];
      const edges = data.edges ?? [];
      if (!edges.length) return `Node ${nodeId} has no edges in scope.`;
      const labelOf = id => nodes.find(n => n.id === id)?.label ?? id;
      return edges.map(e => `${labelOf(e.fromId)} -${e.type}-> ${labelOf(e.toId)} (id=${e.id})`).join('\n');
    } catch (err) { return `Failed to list edges: ${err.message}`; }
  },

  create_graph_node: async ({ label, type, description }) => {
    if (!label || typeof label !== 'string' || !label.trim()) return 'Failed to create graph node: label (string) is required';
    try {
      // Derive the node's audience in code: a label matching a known villager
      // takes their category, otherwise ward-private (fail-closed). The Familiar
      // never tags a node by hand — it can deliberately widen one later via
      // update_graph_node's audience setter.
      let audience;
      if (_toolDeps.getVillageRegistry) {
        try {
          const reg = await _toolDeps.getVillageRegistry();
          audience = deriveNodeAudience({ label: label.trim(), registry: reg });
        } catch { /* registry down → leave audience undefined → Phylactery defaults ward-private */ }
      }
      const result = await createGraphNode({ label: label.trim(), type, description, audience });
      if (!result.ok) return `Failed to create graph node: ${result.error ?? 'phylactery unavailable'}`;
      const id = result.result?.id ?? result.result?.node?.id;
      return id
        ? `Graph node created: "${label.trim()}" (id=${id}). I can now wire edges to it with create_graph_edge.`
        : `Graph node "${label.trim()}" created.`;
    } catch (err) { return `Failed to create graph node: ${err.message}`; }
  },

  create_graph_edge: async ({ fromId, toId, type, weight }) => {
    if (!fromId || !toId || !type) return 'Failed to create graph edge: fromId, toId, and type are all required';
    if (weight !== undefined && (typeof weight !== 'number' || weight < 0 || weight > 1)) {
      return 'Failed to create graph edge: weight must be a number in [0, 1]';
    }
    try {
      const result = await createGraphEdge({ fromId, toId, type, weight });
      if (!result.ok) return `Failed to create graph edge: ${result.error ?? 'phylactery unavailable'}`;
      const id = result.result?.id ?? result.result?.edge?.id;
      return `Graph edge created: ${fromId} -${type}-> ${toId}${id ? ` (id=${id})` : ''}.`;
    } catch (err) { return `Failed to create graph edge: ${err.message}`; }
  },

  update_graph_node: async ({ id, label, description, type, audience }) => {
    try {
      // Resolve a named audience circle → the id the store keeps. 'ward-private'
      // is the sentinel; any other value must name a real Village category, else
      // it's a hard stop so a node never lands tagged for a circle that isn't there.
      let resolvedAudience;
      if (typeof audience === 'string' && audience.trim()) {
        if (audience.trim().toLowerCase() === 'ward-private') {
          resolvedAudience = 'ward-private';
        } else if (_toolDeps.getVillageRegistry) {
          const reg = await _toolDeps.getVillageRegistry();
          const hit = resolveCircleInList(reg?.categories, audience);
          if (!hit) return `I don't have a circle called "${audience}". Circles: ${(reg?.categories ?? []).map(c => c.name).join(', ') || '(none)'}, or "ward-private".`;
          resolvedAudience = hit.id;
        }
      }
      const result = await updateGraphNode({ id, label, description, type, audience: resolvedAudience });
      if (!result.ok) return `Failed to update graph node: ${result.error ?? 'phylactery unavailable'}`;
      return `Graph node ${id} updated.`;
    } catch (err) { return `Failed to update graph node: ${err.message}`; }
  },

  delete_graph_node: async ({ id }) => {
    try {
      const result = await deleteGraphNode({ id });
      if (!result.ok) return `Failed to delete graph node: ${result.error ?? 'phylactery unavailable'}`;
      return `Graph node ${id} deleted (snapshot saved).`;
    } catch (err) { return `Failed to delete graph node: ${err.message}`; }
  },

  update_graph_edge: async ({ id, type, weight }) => {
    if (weight !== undefined && (typeof weight !== 'number' || weight < 0 || weight > 1)) {
      return 'Failed to update graph edge: weight must be a number in [0, 1]';
    }
    try {
      const result = await updateGraphEdge({ id, type, weight });
      if (!result.ok) return `Failed to update graph edge: ${result.error ?? 'phylactery unavailable'}`;
      return `Graph edge ${id} updated.`;
    } catch (err) { return `Failed to update graph edge: ${err.message}`; }
  },

  delete_graph_edge: async ({ id }) => {
    try {
      const result = await deleteGraphEdge({ id });
      if (!result.ok) return `Failed to delete graph edge: ${result.error ?? 'phylactery unavailable'}`;
      return `Graph edge ${id} deleted (snapshot saved).`;
    } catch (err) { return `Failed to delete graph edge: ${err.message}`; }
  },

  // ── Temporal executors (Unruh — schedule + interests) ────────────────
  // Each one rides thalamus's wrappers to the already-spawned Unruh MCP
  // subprocess. Returns short strings the model can quote back as
  // confirmation.

  schedule_add_event: async ({ label, when, end, recurrence }) => {
    if (!label || typeof label !== 'string') return 'Failed to add event: label (string) is required';
    try {
      const payload = recurrence ? { recurrence } : {};
      const data = await addScheduleNode({
        type: 'event', label, when, end,
        ...(Object.keys(payload).length ? { payload } : {}),
      });
      if (data?.ok === false) return `Failed to add event: ${data.error ?? 'unknown error'}`;
      return `Event added (id: ${data.id}). It will surface in my [Temporal Context] when its time approaches.`;
    } catch (err) { return `Failed to add event: ${err.message}`; }
  },

  schedule_add_task: async ({ label, when, stakes_tier, consequence_model, recurrence }) => {
    if (!label || typeof label !== 'string') return 'Failed to add task: label (string) is required';
    try {
      const payload = {};
      if (stakes_tier) payload.stakes_tier = stakes_tier;
      if (consequence_model) payload.consequence_model = consequence_model;
      if (recurrence) payload.recurrence = recurrence;
      const data = await addScheduleNode({
        type: 'task', label, when,
        ...(Object.keys(payload).length ? { payload } : {}),
      });
      if (data?.ok === false) return `Failed to add task: ${data.error ?? 'unknown error'}`;
      return `Task added (id: ${data.id}). It will surface until resolved via schedule_resolve.`;
    } catch (err) { return `Failed to add task: ${err.message}`; }
  },

  schedule_add_need: async ({ label, when, end, recurrence } = {}) => {
    if (!label || typeof label !== 'string') return 'Failed to add need: label (string) is required.';
    if (!when || !end) return 'Failed to add need: a need is a WINDOW — I need both when (opens) and end (closes).';
    try {
      const payload = {
        need: true,
        stakes_tier: 'personal_wellbeing',
        recurrence: (recurrence && typeof recurrence === 'object') ? recurrence : { freq: 'daily' },
      };
      const data = await addScheduleNode({ type: 'task', label, when, end, payload });
      if (data?.ok === false) return `Failed to add need: ${data.error ?? 'unknown error'}`;
      return `Need-window added (id: ${data.id}) — "${label}", tracked each day as met or missed.`;
    } catch (err) { return `Failed to add need: ${err.message}`; }
  },

  schedule_assign_time: async ({ id, when }) => {
    if (!id || typeof id !== 'string') return 'Failed to assign a time: id (string) is required.';
    if (!when || typeof when !== 'string' || !when.trim()) return 'Failed to assign a time: when (local ISO time) is required.';
    try {
      const data = await updateScheduleNode({ id, when: when.trim() });
      if (data?.ok === false) return `Failed to assign a time: ${data.error ?? 'unknown error'}`;
      return `Done — that task now has a time (${when.trim()}), so it'll come due and surface on its own instead of floating. (id: ${id})`;
    } catch (err) { return `Failed to assign a time: ${err.message}`; }
  },

  schedule_snooze_task: async ({ id, minutes }) => {
    if (!id || typeof id !== 'string') return 'Failed to snooze task: id (string) is required';
    const raw = Number(minutes);
    if (!Number.isFinite(raw) || raw <= 0) return 'Failed to snooze task: minutes (positive integer) is required';
    const mins = Math.max(1, Math.min(7 * 24 * 60, Math.round(raw)));
    try {
      // Read the current payload so the snooze stamp merges in rather
      // than clobbering stakes_tier / consequence_model — Unruh's
      // update REPLACES the whole payload, so the merge lives here.
      const win = await getScheduleWindow({ limit: 200 });
      const node = (win?.nodes || []).find(n => n.id === id);
      if (!node) return `Failed to snooze task: no open task found with id ${id}.`;
      const payload = { ...(node.payload || {}) };
      const until = new Date(Date.now() + mins * 60 * 1000).toISOString();
      payload.snooze_until = until;
      const data = await updateScheduleNode({ id, payload });
      if (data?.ok === false) return `Failed to snooze task: ${data.error ?? 'unknown error'}`;
      return `Task snoozed (id: ${id}). It will stop surfacing for ~${mins} min (until ${until}), then come back to me on its own.`;
    } catch (err) { return `Failed to snooze task: ${err.message}`; }
  },

  schedule_add_reminder: async ({ label, when, message, stakes_tier, consequence_model, recurrence }) => {
    if (!label || typeof label !== 'string') return 'Failed to add reminder: label (string) is required';
    try {
      const payload = {};
      if (message) payload.message = message;
      if (stakes_tier) payload.stakes_tier = stakes_tier;
      if (consequence_model) payload.consequence_model = consequence_model;
      if (recurrence) payload.recurrence = recurrence;
      const data = await addScheduleNode({ type: 'reminder', label, when, payload });
      if (data?.ok === false) return `Failed to add reminder: ${data.error ?? 'unknown error'}`;
      return `Reminder set (id: ${data.id}). It will be delivered into the chat at the chosen time (and pushed to {{user}}'s Discord when configured).`;
    } catch (err) { return `Failed to add reminder: ${err.message}`; }
  },

  schedule_add_phase: async ({ label, when, end, texture, recurrence }) => {
    if (!label || typeof label !== 'string') return 'Failed to add phase: label (string) is required';
    try {
      const payload = {};
      if (texture) payload.texture = texture;
      if (recurrence) payload.recurrence = recurrence;
      const data = await addScheduleNode({ type: 'phase', label, when, end, payload });
      if (data?.ok === false) return `Failed to add phase: ${data.error ?? 'unknown error'}`;
      return `Phase added (id: ${data.id}). It will appear in {{user}}'s daily routine at that time of day.`;
    } catch (err) { return `Failed to add phase: ${err.message}`; }
  },

  schedule_resolve: async ({ id, resolution, occurrence_date }) => {
    if (!resolution || typeof resolution !== 'string') return 'Failed to resolve: resolution (string) is required';
    try {
      // If occurrence_date is supplied AND the node is recurring,
      // resolve THIS occurrence only — keeps the rest of the series
      // alive. Without occurrence_date, the whole node (or whole
      // series for a recurring one) is resolved.
      const data = occurrence_date
        ? await resolveScheduleOccurrence({ id, occurrence_date, resolution })
        : await resolveScheduleNode({ id, resolution });
      if (data?.ok === false) return `Failed to resolve: ${data.error ?? 'unknown error'}`;
      if (data?.updated === false) return `No schedule node with id ${id} — it may have been deleted or never existed.`;
      return occurrence_date
        ? `Marked ${id}'s ${occurrence_date} occurrence as ${resolution}. The series continues.`
        : `Marked ${id} as ${resolution}.`;
    } catch (err) { return `Failed to resolve: ${err.message}`; }
  },

  schedule_delete: async ({ id } = {}) => {
    const sid = String(id ?? '').trim();
    if (!sid) return 'I need the id of the schedule item to remove — it\'s in the [schedule ids] legend of my [Temporal Context].';
    try {
      const data = await deleteScheduleNode({ id: sid });
      if (!data?.ok) return `I couldn't remove that schedule item: ${data?.error ?? 'Unruh unavailable'}.`;
      if (data.deleted === false) return `There's no schedule item with id ${sid} — nothing to remove (it may already be gone).`;
      return `Removed schedule item ${sid}.`;
    } catch (err) { return `I couldn't remove that schedule item: ${err.message}`; }
  },

  schedule_link: async ({ src, dst, dst_state, kind, valence, condition, horizon_hours, severity, certainty, observed, note } = {}) => {
    const s = String(src ?? '').trim();
    const k = String(kind ?? '').trim();
    const KINDS = ['causes', 'requires', 'depends_on', 'blocks', 'during', 'carries_forward', 'co_occurs_with'];
    const stateLabel = String(dst_state ?? '').trim();
    if (!s) return 'I need the src id — it\'s in the [schedule ids] legend of my [Temporal Context].';
    if (!KINDS.includes(k)) return `I need a relationship kind, one of: ${KINDS.join(', ')}.`;
    try {
      // dst is either an existing node id, or a state I name (resolve-or-create).
      let d = String(dst ?? '').trim();
      if (!d && stateLabel) {
        const st = await upsertScheduleState({ label: stateLabel });
        if (!st?.ok || !st.id) return `I couldn't reach for the state "${stateLabel}": ${st?.error ?? 'Unruh unavailable'}.`;
        d = st.id;
      }
      if (!d) return 'I need a dst — either an id from the [schedule ids] legend, or a dst_state label to point a consequence at.';
      if (s === d) return 'I can\'t link a schedule item to itself.';

      // Assemble the consequence payload from whatever was given (all optional).
      const payload = {};
      if (valence)   payload.valence   = valence;
      if (condition) payload.condition = condition;
      if (Number.isFinite(Number(horizon_hours))) payload.horizon_hours = Number(horizon_hours);
      if (severity)  payload.severity  = severity;
      if (certainty) payload.certainty = certainty;
      if (observed !== undefined) payload.observed = !!observed;
      if (note && String(note).trim()) payload.note = String(note).trim();

      const data = await addScheduleEdge({ src: s, dst: d, kind: k, payload: Object.keys(payload).length ? payload : undefined });
      if (!data?.ok) return `I couldn't connect those items: ${data?.error ?? 'Unruh unavailable'} (one of the ids may be stale).`;
      const tail = payload.valence ? ` (${payload.condition ?? 'unconditional'}, ${payload.valence}${payload.observed ? ', observed' : payload.certainty ? `, ${payload.certainty} certainty` : ''})` : '';
      return `Linked ${s} ${k} ${stateLabel ? `[${stateLabel}]` : d}${tail}.`;
    } catch (err) { return `I couldn't connect those items: ${err.message}`; }
  },

  schedule_export: async ({ id } = {}) => {
    const sid = String(id ?? '').trim();
    if (!sid) return 'I need the id of the schedule item to export — it\'s in the [schedule ids] legend of my [Temporal Context].';
    try {
      const data = await exportSchedule({ id: sid });
      if (!data?.ok) return `I couldn't build a calendar file for that item: ${data?.error ?? 'Unruh unavailable'} (the id may be stale).`;
      // Hand the human two ready-made artifacts. The download path is
      // same-origin (served by GET /api/schedule/:id/export.ics); the
      // Google link is absolute and clickable anywhere. I built NEITHER by
      // hand — Unruh generated the dates/UID/URL in code — I just relay them.
      return [
        `Calendar export ready for ${sid}:`,
        `- Add to Google Calendar: ${data.google_url}`,
        `- Download .ics file: /api/schedule/${encodeURIComponent(sid)}/export.ics`,
        `I share both links with {{user}} so they can pick whichever suits their device. (I only read their calendar — adding this is their choice, not a change I make to it.)`,
      ].join('\n');
    } catch (err) { return `I couldn't build a calendar file for that item: ${err.message}`; }
  },

  schedule_push_to_google: async ({ id } = {}) => {
    const sid = String(id ?? '').trim();
    if (!sid) return 'I need the id of the schedule item to add — it\'s in the [schedule ids] legend of my [Temporal Context].';
    const s = readSettingsSync();
    // Gate: only available when the ward has opted into write-back AND a
    // command is resolvable. The tool is also filtered out of the advertised
    // list when off, but guard here too in case it's called directly.
    if (s?.gcalWriteEnabled !== true) {
      return 'Calendar write-back isn\'t enabled — I can only add to {{user}}\'s real Google Calendar once they turn that on in Settings. Until then I can still export the item as a file or link with schedule_export.';
    }
    try {
      // Native Google account → add via the Calendar API (events.insert).
      if (s?.gcalSource === 'google') {
        const store = await readGoogleToken();
        if (!googleConnected(store)) {
          return 'Calendar write-back is on, but {{user}}\'s Google account isn\'t connected yet — they can connect it in Settings. I can still export the item with schedule_export meanwhile.';
        }
        const got = await getScheduleNode({ id: sid });
        if (!got?.ok || !got.node) return `I couldn't read that schedule item (${sid}): ${got?.error ?? 'Unruh unavailable'} (the id may be stale).`;
        const fresh = await getGoogleAccessToken(store, { save: (st) => writeGoogleToken(st) });
        if (!fresh.ok) return `I couldn't reach {{user}}'s Google account: ${fresh.error}. Their calendar is unchanged.`;
        const event = buildEventResource(got.node, { timeZone: s?.wardTimeZone || undefined });
        const res = await insertGoogleEvent({ accessToken: fresh.accessToken, event });
        if (!res.ok) return `I tried to add ${sid} to {{user}}'s Google Calendar but it didn't go through: ${res.error}. Their existing calendar is unchanged.`;
        return `Added "${got.node.label}" to {{user}}'s real Google Calendar. (A new entry — I didn't touch anything already there.)`;
      }
      // CLI source → generate the .ics in code (never type calendar data) and
      // import it through the ward's tool. ADD only.
      const command = resolveWriteCommand({ source: s?.gcalSource, override: s?.gcalWriteCommand });
      if (!command) {
        return 'Calendar write-back is on, but no way to add is configured — {{user}} needs to connect a Google account or set a CLI import command in Settings. I can still export the item with schedule_export meanwhile.';
      }
      const exported = await exportSchedule({ id: sid });
      if (!exported?.ok || !exported.ics) {
        return `I couldn't build the calendar entry for ${sid}: ${exported?.error ?? 'Unruh unavailable'} (the id may be stale).`;
      }
      const res = await pushIcsViaCli({ icsText: exported.ics, command });
      if (!res.ok) {
        return `I tried to add ${sid} to {{user}}'s Google Calendar but the import didn't go through: ${res.error}. Their existing calendar is unchanged; I can share the export link instead if they'd like.`;
      }
      return `Added ${sid} to {{user}}'s real Google Calendar. (This added a new entry — I didn't touch anything already there.)`;
    } catch (err) { return `I couldn't add that to Google Calendar: ${err.message}`; }
  },

  interest_bump: async ({ topic, delta }) => {
    if (!topic || typeof topic !== 'string') return 'Failed to bump interest: topic (string) is required';
    const d = Number(delta);
    if (!Number.isFinite(d) || d <= 0) return 'Failed to bump interest: delta (positive number) is required';
    try {
      const data = await bumpInterest({ topic, delta: d, source: 'familiar_tool' });
      if (data?.ok === false) return `Failed to bump interest: ${data.error ?? 'unknown error'}`;
      return `Interest "${topic}" bumped by ${delta}. It will surface in my [Temporal Context] interests block, weighted accordingly.`;
    } catch (err) { return `Failed to bump interest: ${err.message}`; }
  },

  interest_set_standing: async ({ topic, weight }) => {
    if (!topic || typeof topic !== 'string') return 'Failed to set standing value: topic (string) is required';
    try {
      const data = await setStandingInterest({ topic, weight });
      if (data?.ok === false) return `Failed to set standing value: ${data.error ?? 'unknown error'}`;
      return `"${topic}" set as a standing value. It will appear in the standing block of my [Temporal Context] every turn, never decaying.`;
    } catch (err) { return `Failed to set standing value: ${err.message}`; }
  },

  // ── Crisis outreach executors ────────────────────────────────────────
  get_trusted_contacts: () => {
    const s = readSettingsSync();
    const contacts = Array.isArray(s?.trustedContacts) ? s.trustedContacts : [];
    if (!contacts.length) {
      return 'No trusted contacts are configured yet. They can be added in Settings → Trusted Contacts. show_crisis_resources is still available.';
    }
    const list = contacts.map(c => `- ${c.name} (via ${c.channel ?? 'discord'})`).join('\n');
    return `Configured trusted contacts:\n${list}\n\nPass the exact name above to contact_trusted_person.`;
  },

  contact_trusted_person: async ({ name, message }) => {
    if (!name || typeof name !== 'string' || !name.trim()) return 'Failed to contact: name is required.';
    if (!message || typeof message !== 'string' || !message.trim()) return `Could not reach ${name}: message is required. The attempt was not made.`;
    if (message.trim().length > 1000) return `Could not reach ${name}: message too long (max 1000 characters). The attempt was not made.`;
    const s = readSettingsSync();
    const contact = (s?.trustedContacts || []).find(c => c.name === name.trim());
    if (!contact) {
      return `Could not reach ${name}: No trusted contact named "${name.trim()}" is configured. The attempt was logged to the outbox.`;
    }
    try {
      const result = await deliverToTrustedContact({
        name:    contact.name,
        message: message.trim(),
        channel: contact.channel ?? 'discord',
      });
      if (!result.ok) {
        return `Could not reach ${name}: ${result.error ?? 'unknown error'}. The attempt was logged to the outbox.`;
      }
      return `Message delivered to ${name} via ${contact.channel ?? 'discord'}. {{user}} can see exactly what was sent — the mirror copy lands in their chat.`;
    } catch (err) { return `Failed to contact ${name}: ${err.message}`; }
  },

  show_crisis_resources: async () => {
    try {
      await enqueueCrisisResources();
      return 'Crisis resources delivered into {{user}}\'s chat.';
    } catch (err) { return `Failed to surface crisis resources: ${err.message}`; }
  },

  // ── Own files (read-only, sandboxed) ──────────────────────────────
  // Ward-private only: my Tomes and session logs hold mine and {{user}}'s
  // shared history, so I don't read them into a room where others are
  // present (same audience reasoning as the Village private bucket). The
  // sandbox + secret denylist live in own-files.js.
  list_files: async ({ dir } = {}, ctx = {}) => {
    if (ctx.wardPrivate === false) {
      return 'Someone else is here, so I\'ll hold off going through my own files — they hold {{user}}\'s and my history. I can look once it\'s just us.';
    }
    const r = await listOwnFiles(dir ?? '.');
    if (!r.ok) return `I couldn't list that: ${r.error}.`;
    if (r.entries.length === 0) return `Nothing in ${r.dir}.`;
    const lines = r.entries.map(e => e.type === 'dir' ? `  ${e.name}/` : `  ${e.name}${e.size != null ? ` (${e.size}b)` : ''}`);
    return `${r.dir}:\n${lines.join('\n')}`;
  },

  read_file: async ({ path: relPath } = {}, ctx = {}) => {
    if (ctx.wardPrivate === false) {
      return 'Someone else is here, so I won\'t open my own files right now — they hold {{user}}\'s and my history. I can read it once we\'re alone.';
    }
    if (!relPath || typeof relPath !== 'string') return 'I need the path of the file I want to read (I find it with list_files).';
    const r = await readOwnFile(relPath);
    if (!r.ok) return `I couldn't read that: ${r.error}.`;
    const note = r.truncated ? `\n…(truncated — the file is longer than I read)` : '';
    return `${r.path}:\n${r.content}${note}`;
  },

  // ── Village ───────────────────────────────────────────────────────
  // Read is field-gated: privateNotes is disclosed only in ward-private
  // turns (ctx.wardPrivate). When anyone else is present it's stripped,
  // so a lookup can't spill sensitive notes into a gated room. Mutations
  // are ward-private only — the Familiar doesn't edit the registry while
  // others are watching. ctx.wardPrivate is undefined on non-chat paths
  // (loops/tests), which we treat as ward-private (those paths are the
  // ward's own); the chat path sets it explicitly from the audience tag.
  village_lookup: async ({ category, location, name } = {}, ctx = {}) => {
    if (!_toolDeps.getVillageRegistry) return 'I can\'t reach the Village right now.';
    const wardPrivate = ctx.wardPrivate !== false;
    try {
      const reg = await _toolDeps.getVillageRegistry();
      const cats = reg?.categories ?? [];
      const catName = (id) => cats.find(c => c.id === id)?.name ?? id;

      // Resolve a category filter from a name or id.
      let wantCatId = null;
      if (typeof category === 'string' && category.trim()) {
        const q = category.trim().toLowerCase();
        const hit = cats.find(c => c.id.toLowerCase() === q || c.name.toLowerCase() === q);
        if (!hit) return `I don't have a category called "${category}". Categories: ${cats.map(c => c.name).join(', ') || '(none)'}.`;
        wantCatId = hit.id;
      }
      // A location filter resolves to that location's assigned category.
      if (typeof location === 'string' && location.trim()) {
        const q = location.trim().toLowerCase();
        const loc = (reg?.locations ?? []).find(l => l.key.toLowerCase() === q || (l.label ?? '').toLowerCase() === q);
        if (!loc) return `I don't know a location called "${location}".`;
        // Intersect with any category filter already in play.
        if (wantCatId && wantCatId !== loc.assignedCategoryId) return 'No one matches both that category and that location.';
        wantCatId = loc.assignedCategoryId;
      }
      const nameQ = typeof name === 'string' && name.trim() ? name.trim().toLowerCase() : null;

      let villagers = reg?.villagers ?? [];
      if (wantCatId) villagers = villagers.filter(v => (v.categoryIds ?? []).includes(wantCatId));
      if (nameQ) villagers = villagers.filter(v =>
        v.name.toLowerCase().includes(nameQ) ||
        (v.aliases ?? []).some(a => String(a?.id ?? '').toLowerCase().includes(nameQ)));

      const discordReachable = (v) => (v.aliases ?? []).some(a => a.platform === 'discord' && a.id);

      const sections = [];

      if (villagers.length > 0) {
        const lines = villagers.map(v => {
          const parts = [`- ${v.name} (id: ${v.id})${discordReachable(v) ? ' — reachable on Discord' : ''}`];
          const cnames = (v.categoryIds ?? []).map(catName).join(', ');
          if (cnames) parts.push(`  Category: ${cnames}`);
          if (v.pronouns) parts.push(`  Pronouns: ${v.pronouns}`);
          if (v.relationToWard) parts.push(`  To {{user}}: ${v.relationToWard}`);
          if (v.commStyleNotes) parts.push(`  Comm style: ${v.commStyleNotes}`);
          if (v.notes) parts.push(`  Notes: ${v.notes}`);
          if (v.privateNotes) {
            if (wardPrivate) parts.push(`  Private (ward-only): ${v.privateNotes}`);
            else parts.push('  (private notes withheld — someone else is present)');
          }
          if (v.graphNodeId) parts.push(`  Linked graph node: ${v.graphNodeId}`);
          else parts.push('  Not linked to a graph node yet.');
          return parts.join('\n');
        });
        const header = wardPrivate
          ? `${villagers.length} villager(s):`
          : `${villagers.length} villager(s) (sensitive private notes hidden — others are present):`;
        sections.push(`${header}\n${lines.join('\n')}`);
      } else if (nameQ || wantCatId) {
        sections.push('No one in the Village matches that.');
      }

      // Places footer — the rooms I'm present in, so I always know what I
      // can relay to. Skipped on a targeted single-person name search
      // (that's about the person, not the map). channelIdFromLocationKey
      // tells me whether a location is one I can actually post into.
      if (!nameQ) {
        const locs = reg?.locations ?? [];
        if (locs.length > 0) {
          const placeLines = locs.map(l => {
            const postable = channelIdFromLocationKey(l.key);
            const mode = l.mode ?? 'strict';
            return `- ${l.label ?? l.key} (key: ${l.key}) — ${mode} mode, trust ceiling: ${catName(l.assignedCategoryId)}`
              + (postable ? '' : ' — not a room I can post into');
          });
          sections.push(`Places I'm present in (${locs.length}) — I can relay to any postable one by its label:\n${placeLines.join('\n')}`);
        }
      }

      if (sections.length === 0) return "My human's Village is empty for now — no people or places registered yet.";
      return sections.join('\n\n');
    } catch (err) { return `I couldn't read the Village: ${err.message}`; }
  },

  village_upsert: async ({ id, name, category, relationToWard, pronouns, commStyleNotes, notes, privateNotes, graphNodeId, mutualConsentToRemember, disclosure } = {}, ctx = {}) => {
    if (!_toolDeps.upsertVillager || !_toolDeps.getVillageRegistry) return 'I can\'t reach the Village right now.';
    const wardPrivate = ctx.wardPrivate !== false;

    if (!id && (typeof name !== 'string' || !name.trim())) {
      return 'To add someone new I need at least their name. To edit someone, pass their id from village_lookup.';
    }

    // With others in the room I can still register someone I've just met
    // (a low-stakes, shareable act), but I don't rewrite {{user}}'s
    // existing records or write the sensitive bucket without them — I
    // defer those for their consent once we're alone.
    let deferredPrivate = false;
    if (!wardPrivate) {
      if (id) {
        return 'Someone else is here, so I won\'t change {{user}}\'s existing record for this person right now — that\'s theirs to confirm. I\'ll bring it up with them once it\'s just us.';
      }
      if (typeof privateNotes === 'string' && privateNotes.trim()) {
        deferredPrivate = true;
        privateNotes = undefined; // hold the sensitive detail for a private moment
      }
    }

    try {
      const args = {};
      if (id) args.id = id;
      if (name !== undefined) args.name = name;
      if (relationToWard !== undefined) args.relationToWard = relationToWard;
      if (pronouns !== undefined) args.pronouns = pronouns;
      if (commStyleNotes !== undefined) args.commStyleNotes = commStyleNotes;
      if (notes !== undefined) args.notes = notes;
      if (privateNotes !== undefined) args.privateNotes = privateNotes;
      if (graphNodeId !== undefined) args.graphNodeId = graphNodeId;
      // Standing mutual consent: true sets both sides agreed, false clears it.
      // Only reachable here when ward-private (id-edits are gated above), so a
      // record change to memory permissions always happens with my human present.
      if (mutualConsentToRemember === true) args.standingConsent = { wardAgreed: true, villagerAgreed: true };
      else if (mutualConsentToRemember === false) args.standingConsent = {};

      // Resolve circle names → ids (the Familiar knows names, not ids). The
      // registry is read once and shared by both the category and disclosure
      // resolution below.
      const needsRegistry = (typeof category === 'string' && category.trim()) ||
        (disclosure && typeof disclosure === 'object' && !Array.isArray(disclosure));
      let cats = [];
      if (needsRegistry) {
        const reg = await _toolDeps.getVillageRegistry();
        cats = reg?.categories ?? [];
      }
      if (typeof category === 'string' && category.trim()) {
        const hit = resolveCircleInList(cats, category);
        if (!hit) return `I don't have a category called "${category}". Categories: ${cats.map(c => c.name).join(', ') || '(none)'}.`;
        args.categoryIds = [hit.id];
      }

      // Disclosure: per fact-kind, the circle a person is OK being discussed in.
      // Resolve each value (a circle name, or 'ward-private') to the id the
      // store keeps; an unknown circle is a hard stop so nothing lands wrong.
      if (disclosure && typeof disclosure === 'object' && !Array.isArray(disclosure)) {
        const resolved = {};
        for (const [kind, circle] of Object.entries(disclosure)) {
          if (typeof circle !== 'string' || !circle.trim()) continue;
          if (circle.trim().toLowerCase() === 'ward-private') { resolved[kind] = 'ward-private'; continue; }
          const hit = resolveCircleInList(cats, circle);
          if (!hit) return `For disclosure I don't have a circle called "${circle}". Circles: ${cats.map(c => c.name).join(', ') || '(none)'}, or "ward-private".`;
          resolved[kind] = hit.id;
        }
        if (Object.keys(resolved).length) args.disclosure = resolved;
      }

      const v = await _toolDeps.upsertVillager(args);
      const verb = id ? 'updated' : 'added';
      const linked = v?.graphNodeId ? ` Linked to graph node ${v.graphNodeId}.` : '';
      const held = deferredPrivate ? ' I held the private detail back — I\'ll add that once it\'s just us.' : '';
      return `${v?.name ?? 'They'} ${verb} in the Village (id: ${v?.id ?? id}).${linked}${held}`;
    } catch (err) { return `I couldn't update the Village: ${err.message}`; }
  },

  // V6 — relay a message to a villager DM or a location, with the
  // no-covert-contact mirror and a restricted-memory gate so ward-private
  // detail can't ride along into a room that isn't cleared for it.
  relay_message: async ({ to, message } = {}) => {
    if (!_toolDeps.relayToDiscord || !_toolDeps.getVillageRegistry) {
      return "I can't relay messages right now — Discord isn't wired up.";
    }
    if (typeof to !== 'string' || !to.trim()) return 'I need to know who to reach — a villager name or a location.';
    if (typeof message !== 'string' || !message.trim()) return 'I need the message to carry.';

    let reg;
    try { reg = await _toolDeps.getVillageRegistry(); }
    catch (err) { return `I couldn't read the Village to find them: ${err.message}`; }

    const q = to.trim().toLowerCase();

    // Resolve the target: a villager (by name/alias) or a location (by key/label).
    const villager = (reg?.villagers ?? []).find(v =>
      v.name.toLowerCase() === q ||
      (v.aliases ?? []).some(a => (a.handle ?? '').toLowerCase() === q));
    const location = (reg?.locations ?? []).find(l =>
      l.key.toLowerCase() === q || (l.label ?? '').toLowerCase() === q);

    let delivery = null;     // { recipientUserId } | { channelId }
    let targetName = to.trim();
    let audienceTag;
    if (villager) {
      const discordAlias = (villager.aliases ?? []).find(a => a.platform === 'discord' && a.id);
      if (!discordAlias) return `I know ${villager.name}, but I don't have a Discord account for them to reach.`;
      delivery = { recipientUserId: discordAlias.id };
      targetName = villager.name;
      audienceTag = audienceTagFor({ participants: [{ id: villager.id, name: villager.name }] }, reg);
    } else if (location) {
      const channelId = channelIdFromLocationKey(location.key);
      if (!channelId) return `"${location.label ?? location.key}" isn't a Discord location I can post to.`;
      delivery = { channelId };
      targetName = location.label ?? location.key;
      audienceTag = audienceTagFor({ location: location.key }, reg);
    } else {
      return `I don't know anyone or any place called "${to}". I can only relay to people or locations in the Village.`;
    }

    // Restricted-memory gate: never carry ward-private detail into a room
    // that isn't cleared for it. Mirrors the Pillar D outgoing filter; fails
    // OPEN (a search blip never blocks a benign relay).
    try {
      const check = await _toolDeps.searchRestricted({ query: message.slice(0, 2000), roomAudience: audienceTag });
      if (check?.hit) {
        return `I held that back — something in it isn't cleared for ${targetName}${check.topic ? ` (${check.topic})` : ''}. Tell me how you'd like me to put it, or I can keep it between us.`;
      }
    } catch { /* fail open — a gate error never blocks a benign relay */ }

    const result = await _toolDeps.relayToDiscord({ ...delivery, message: message.trim() });
    if (!result?.ok) return `I couldn't get that to ${targetName}: ${result?.error ?? 'unknown error'}.`;

    // No covert contact: mirror every relay back to my human so they always
    // see exactly what I sent and to whom.
    await _toolDeps.mirrorToWard({
      kind:     'relay',
      originId: `relay:${Date.now()}:${targetName}`,
      title:    `I relayed a message to ${targetName}`,
      body:     `To ${targetName}: "${message.trim()}"`,
    }).catch(() => { /* the send already happened; a mirror hiccup must not fail the tool */ });

    return `Sent to ${targetName}: "${message.trim()}"`;
  },

  // ── Web access ────────────────────────────────────────────────────
  // Thin delegation to websearch.js, which owns the SSRF guard, the timeout,
  // the backend resolution (keyless DDG floor or a search API), and the
  // extraction. These never appear in the tool list unless the human has
  // opted in (webSearchEnabled) — see composeActiveTools. searchWeb reads the
  // chosen backend / provider / key from settings and always degrades to the
  // keyless floor.
  web_search: async ({ query } = {}) => searchWeb(query, readSettingsSync()),
  // look_up needs no backend resolution: it's always the keyless official
  // reference APIs (Wikipedia + DDG Instant Answer), so it ignores the
  // search-backend settings entirely.
  look_up: async ({ query } = {}) => lookUp(query, readSettingsSync()),
  read_webpage: async ({ url } = {}) => readWebpage(url, readSettingsSync()),
};

/**
 * Compose the tools array sent to the provider: built-ins + the user's
 * custom tool definitions from Settings.
 *
 * Custom tools are ADVERTISE-ONLY: the model sees them and may call
 * them, but no executor exists — calls return a structured
 * "not implemented" result into the loop. This is a deliberate
 * pre-MVP posture, not an accident; see the design note in
 * docs/architecture.md ("Custom tools — advertise-only") for what a
 * real extension point would need before it ships.
 */
// Web access is opt-in network egress, so the web tools stay out of the
// advertised list until the human enables them (and the env off-switch can
// force them off regardless). look_up and web_search work at zero config
// (keyless reference APIs / in-process scrape floor respectively); the
// toggle still gates them because egress itself is the opt-in. A tool the
// Familiar can't actually use should never appear in its tool list.
export const WEB_TOOL_NAMES = new Set(['look_up', 'web_search', 'read_webpage']);

export function webSearchEnabled(settings = readSettingsSync()) {
  if (process.env.PROTO_FAMILIAR_WEBSEARCH_DISABLED === '1') return false;
  return settings?.webSearchEnabled === true;
}

// Calendar write-back mutates the ward's REAL Google calendar, so the tool
// only appears when the ward has explicitly enabled it AND configured a write
// command (and never under the hard off-switch). A tool the Familiar can't
// actually use should never appear in its list — and one that changes the
// real calendar shouldn't be offered before the ward has opted in.
export const GCAL_WRITE_TOOL = 'schedule_push_to_google';

export function gcalWriteEnabled(settings = readSettingsSync()) {
  if (process.env.PROTO_FAMILIAR_GCAL_DISABLED === '1') return false;
  if (settings?.gcalWriteEnabled !== true) return false;
  const source = settings?.gcalSource;
  if (source === 'google') return true;  // native API write; executor verifies the token
  const cmd = (settings?.gcalWriteCommand && String(settings.gcalWriteCommand).trim())
    || (source === 'gogcli' || source === 'gcalcli' ? 'preset' : '');
  return !!cmd;
}

export function composeActiveTools(customTools, settings = readSettingsSync()) {
  const webOn = webSearchEnabled(settings);
  const gcalWriteOn = gcalWriteEnabled(settings);
  const tools = BUILTIN_TOOLS.filter(t =>
    (webOn || !WEB_TOOL_NAMES.has(t.function?.name)) &&
    (gcalWriteOn || t.function?.name !== GCAL_WRITE_TOOL));
  if (Array.isArray(customTools)) {
    for (const t of customTools) {
      if (t && typeof t === 'object') tools.push(t);
    }
  }
  // Resolve {{user}} / {{char}} in every description the model reads — both
  // built-ins and custom tools — so the Familiar never sees a literal macro
  // describing its own capability. Clone-and-substitute; BUILTIN_TOOLS is
  // shared module state and must never be mutated.
  return tools.map(t => substituteToolMacros(t, settings));
}

// Deep-clone a tool definition, substituting macros in every `description`
// field (top-level and nested parameter properties) and leaving names, enums,
// and structure untouched.
function substituteToolMacros(tool, settings) {
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = (k === 'description' && typeof v === 'string')
          ? substituteMacros(v, settings)
          : walk(v);
      }
      return out;
    }
    return node;
  };
  return walk(tool);
}

/**
 * Execute a tool by name. Returns the result string. Never throws —
 * a tool whose backing peer is down (or whose executor bugs out)
 * returns a structured failure INTO the loop, not a 500 out of the
 * chat path.
 */
export async function executeToolCall(name, argsJson, ctx = {}) {
  if (Object.prototype.hasOwnProperty.call(TOOL_EXECUTORS, name)) {
    try {
      const args = argsJson ? JSON.parse(argsJson) : {};
      const t0   = Date.now();
      const out  = String(await TOOL_EXECUTORS[name](args, ctx));
      console.log(`[tools] ${name} ok in ${Date.now() - t0}ms`);
      // Tool results flow back to me as tool-role messages I read. Resolve
      // {{user}} / {{char}} here, once, at the boundary — so no executor has
      // to remember to do it and none can leak a literal macro into my view.
      return substituteMacros(out, readSettingsSync());
    } catch (err) {
      console.warn(`[tools] ${name} FAILED: ${err.message}`);
      return `Error executing ${name}: ${err.message}`;
    }
  }
  // Custom / unknown tool — advertise-only, no executor.
  console.log(`[tools] ${name} (no implementation — advertise-only)`);
  return `Tool "${name}" is advertised but has no implementation yet. No result available.`;
}

/**
 * The multi-round tool-call loop (non-streaming). Each round calls the
 * upstream provider; when it answers with finish_reason 'tool_calls',
 * the calls are executed here and the results appended for the next
 * round — up to maxRounds. The time anchor (freshest "now") is
 * re-appended as the LAST system message on every round so it stays at
 * maximum salience even as tool traffic grows the tail.
 *
 * callUpstream(messages) must return the parsed provider response
 * object (or throw). All I/O injected for tests.
 *
 * Returns { data, toolRounds } where data is the FINAL provider
 * response and toolRounds is the renderable record of what ran:
 *   [{ toolCalls, results: [{tool_call_id, name, content}],
 *      content, timestamp }]
 */
export async function runToolCallLoop({
  callUpstream,
  baseMessages,
  timeAnchor  = '',
  executeTool = executeToolCall,
  toolCtx     = {},
  maxRounds   = MAX_TOOL_ROUNDS,
  signal,
}) {
  if (typeof callUpstream !== 'function') throw new Error('callUpstream is required');
  let currentMsgs    = baseMessages;
  const toolRounds   = [];
  let   data         = null;

  for (let round = 0; round <= maxRounds; round++) {
    if (signal?.aborted) break;
    const payloadMessages = timeAnchor
      ? [...currentMsgs, { role: 'system', content: timeAnchor }]
      : currentMsgs;
    data = await callUpstream(payloadMessages);

    const choice  = data?.choices?.[0];
    const message = choice?.message;
    const isToolTurn = choice?.finish_reason === 'tool_calls'
      && Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
    if (!isToolTurn || round >= maxRounds) break;

    const toolCalls = message.tool_calls;
    const timestamp = new Date().toISOString();
    const results = await Promise.all(toolCalls.map(async tc => ({
      tool_call_id: tc.id,
      name:         tc.function?.name ?? '',
      content:      await executeTool(tc.function?.name ?? '', tc.function?.arguments ?? '', toolCtx),
    })));
    toolRounds.push({ toolCalls, results, content: message.content || null, timestamp });

    currentMsgs = [
      ...currentMsgs,
      { role: 'assistant', content: message.content || null, tool_calls: toolCalls },
      ...results.map(r => ({ role: 'tool', tool_call_id: r.tool_call_id, content: r.content })),
    ];
  }

  return { data, toolRounds };
}
