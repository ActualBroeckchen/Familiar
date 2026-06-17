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
  listMemories, readMemory,
  searchGraphNodes, getGraphSubgraph,
  createGraphNode, createGraphEdge,
  updateGraphNode, deleteGraphNode, updateGraphEdge, deleteGraphEdge,
  addScheduleNode, updateScheduleNode, resolveScheduleNode, resolveScheduleOccurrence,
  bumpInterest, setStandingInterest,
  confirmConsentMemories, dropPendingMemories,
  acknowledgeGraduations,
  searchMemoryRestricted,
} from './thalamus.js';
import { audienceTagFor } from './audience.js';
import { markIntentActedOn, snoozeIntent } from './recent-ponderings.js';
import { pruneConsentPending } from './memorization.js';
import { enqueueOutbox, listOutbox, updateOutboxMeta } from './outbox.js';
import { buildTimeAnchorBlock, relativeTime, plainInterval } from './relative-time.js';
import { substituteMacros } from './macros.js';
import { selectSurfaceCandidates } from './surface-context.js';
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
    const out = { action: 'reach_out', message: parsed.message.trim(), ...(nextCheckInMs != null ? { nextCheckInMs } : {}) };
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
            message: ch.message.trim(),
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
  // The restricted-memory gate defaults to the real Phylactery-backed check;
  // tests inject a stub so they don't spawn MCP children.
  searchRestricted: searchMemoryRestricted,
  // The ward-mirror enqueue defaults to the real outbox dispatch.
  mirrorToWard: enqueueAndDispatch,
};
export function initCerebellumTools({ addDefaultTomeEntry, getVillageRegistry, upsertVillager, relayToDiscord, searchRestricted, mirrorToWard } = {}) {
  if (typeof addDefaultTomeEntry === 'function') _toolDeps.addDefaultTomeEntry = addDefaultTomeEntry;
  if (typeof getVillageRegistry === 'function')  _toolDeps.getVillageRegistry  = getVillageRegistry;
  if (typeof upsertVillager === 'function')      _toolDeps.upsertVillager      = upsertVillager;
  if (typeof relayToDiscord === 'function')      _toolDeps.relayToDiscord      = relayToDiscord;
  if (typeof searchRestricted === 'function')    _toolDeps.searchRestricted    = searchRestricted;
  if (typeof mirrorToWard === 'function')        _toolDeps.mirrorToWard        = mirrorToWard;
}

/**
 * Tool definitions sent to the LLM for built-in tools.
 * The format matches the OpenAI function-calling spec. Descriptions
 * are in the Familiar's first-person voice (entity-as-subject) and
 * carry raw {{user}} / {{char}} macros — they are sent to the provider
 * unsubstituted, exactly as the client-side registry always did.
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
      description: 'I save a piece of knowledge or a fact I learned during this conversation into my persistent Tome knowledge base. I use this when {{user}} shares something important about themselves, their relationships, their preferences, or their situation that I should remember across future conversations. I try to be somewhat discerning and avoid duplicate knowledge.',
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
      description: 'I write a new memory entry to my long-term memory system. I use this to record important events, emotional patterns, or significant moments from this conversation in my durable, time-stamped store. I prefer "daily" for routine session events; I use "significant" for major milestones. Daily memories accumulate across the day — each save appends my new bullets to today\'s file; nothing is overwritten. Multiple saves in the same day are normal and expected. Significant memories are different: each one is a named, standalone milestone (e.g. "the night they told me about their sister", "first meeting"), stored in its own file. I always pass a short `title` when saving a significant memory so it gets its own filename and does not overwrite a previous one.',
      parameters: {
        type: 'object',
        properties: {
          content:     { type: 'string', description: 'Memory content I write in first-person, as bullet points starting with "- " — one bullet per fact, insight, or moment. I do NOT include a [chat:id] tag on each bullet — that tag is for external import dedup; live saves from this conversation just want plain bullets so they all accrue. Brief, specific, in my voice.' },
          granularity: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly', 'significant'], description: 'Memory tier.' },
          title:       { type: 'string', description: 'Short human-readable label for this memory — required for "significant" granularity, ignored for the others. A few words that name the milestone (e.g. "first meeting", "{{user}}\'s grandmother", "the night of the crisis call"). Used to generate the file slug so each significant memory lives in its own file.' },
        },
        required: ['content', 'granularity'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_identity',
      description: 'I append a new durable fact to one of my persistent identity files. I use this for facts about {{user}} (category: ward, filename: ward_notes.md) or about my relationship with them (category: relationship, filename: relationship_notes.md). I avoid using this for session-specific or transient information, because that will confuse me and rack up token waste. When to choose append vs. rewrite_identity_section: I APPEND when adding a new fact that complements what is already there; I REWRITE a section when an existing section is now misleading, stale or incomplete and a partial correction would leave it confusing.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['ward', 'relationship'], description: 'Identity file category.' },
          filename: { type: 'string', description: 'Target filename within the category, e.g. ward_notes.md or relationship_notes.md.' },
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
      description: 'I overwrite an existing memory entry to correct an inaccuracy. I use this when the entry is incomplete or partially wrong but the core record (this date, this granularity) is still the right place for the fact. I avoid using this to record new information — that is save_memory. I avoid using this to remove information — that is delete_memory. When the change is "X was true, now Y is true," prefer save_memory with today\'s date so the history is preserved.',
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
      description: 'I permanently delete a memory entry. I use this only when the entry is fully wrong or no longer relevant, and keeping it would mislead future-me. If the change has historical value ("they were on vacation last week, back now"), I do NOT delete — I write a new contradicting memory with save_memory instead, and let recency-decay demote the stale one. Phylactery auto-snapshots before each delete so a mistake is recoverable from the Knowledge editor.',
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
      description: 'I add a new entity (person, place, project, pet, organisation, etc.) to my knowledge graph. I use this when someone or something genuinely new enters {{user}}\'s world and I want it to persist as its own node I can later connect with edges. I check first with find_graph_node so I don\'t create a duplicate of an entity that already exists under a slightly different label. Recording a NEW fact about {{user}} is save_memory; this is for naming a thing the relationship graph should know about. Returns the new node\'s id so I can immediately wire edges to it.',
      parameters: {
        type: 'object',
        properties: {
          label:       { type: 'string', description: 'Display name of the entity, e.g. "Dr. Okafor", "the allotment", "Aria (cat)".' },
          type:        { type: 'string', description: 'Optional: entity type, e.g. "person", "place", "project", "pet", "organisation".' },
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
      description: 'I record a relationship between two entities already in my knowledge graph — the structural counterpart to save_memory. I use this for durable, queryable relationships ("Dr. Okafor —is_therapist_of-> {{user}}", "{{user}} —lives_in-> Bristol"). Both endpoints must exist first: I resolve or create them with find_graph_node / create_graph_node and pass their ids. For a relationship that has ended I delete or re-type the edge rather than leaving a false one standing.',
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
      description: 'I rename or re-describe an entity (person, place, project, etc.) in my knowledge graph. I use this when the node\'s label or description is wrong, outdated, or imprecise. I do NOT use this to record a new relationship — that is what edges are for. The graph block in my context lists ids at the bottom; if the entity I want isn\'t listed there, I call find_graph_node first to look the id up.',
      parameters: {
        type: 'object',
        properties: {
          id:          { type: 'string', description: 'The id of the node to update (from earlier graph context).' },
          label:       { type: 'string', description: 'New display label. Omit to leave unchanged.' },
          description: { type: 'string', description: 'New description. Omit to leave unchanged.' },
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
  // Time format: ISO 8601. My [Temporal Context] block always carries
  // "now" as a UTC timestamp; I compute the target moment from there +
  // any timezone info {{user}} or the temporal context gives me. If
  // unsure of {{user}}'s timezone, I ask them rather than guess.
  {
    type: 'function',
    function: {
      name: 'schedule_add_event',
      description: 'I record a one-time appointment or commitment on {{user}}\'s schedule — a meeting, a dentist visit, dinner with a friend. The event appears in my [Temporal Context] briefings when its time approaches. For deadlines or things {{user}} needs to do, I use schedule_add_task; for recurring daily phases, schedule_add_phase; for explicit time-triggered nudges that should surface as a chat message, schedule_add_reminder. Choosing the right type is important to make sure my human receives the correct support!',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Short human-readable name of the event (e.g. "dentist appointment").' },
          when:  { type: 'string', description: 'ISO 8601 UTC start time, e.g. "2026-06-01T14:00:00+00:00". Unruh stores and compares all times against UTC — no automatic timezone conversion. My [Now] block always shows the current UTC offset (e.g. "(UTC+02:00)"); I use it to convert any local time {{user}} states to UTC exactly once.' },
          end:   { type: 'string', description: 'Optional ISO 8601 UTC end time.' },
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
          when:  { type: 'string', description: 'Optional ISO 8601 UTC deadline. Unruh compares against UTC — no automatic timezone conversion. My [Now] block shows the UTC offset; I convert any stated local time to UTC once. Omit for open-ended tasks.' },
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
      name: 'schedule_snooze_task',
      description: 'I call this when my human asks me to come back to a task later. It parks the task so it stops appearing in my surface candidates for a while, then automatically returns to me after the given number of minutes. I only call this when {{user}} explicitly says not now — never on my own initiative. The task is not resolved or forgotten; it just rests. For finishing a task I use schedule_resolve.',
      parameters: {
        type: 'object',
        properties: {
          id:      { type: 'string', description: 'The id of the task to snooze (from the [Surface candidates] block or [Temporal Context]).' },
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
          when:    { type: 'string', description: 'ISO 8601 UTC fire time, e.g. "2026-06-17T13:00:00+00:00". Unruh compares when_ts against UTC wall-clock — no automatic timezone conversion whatsoever. My [Now] block always shows the current UTC offset (e.g. "(UTC+02:00)") — I use it to convert {{user}}\'s stated local time to UTC exactly once and store that. I do not pre-compensate for any perceived Unruh adjustment; there is none.' },
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
          when:    { type: 'string', description: 'ISO 8601 UTC start time. The date portion will be re-templated daily — only the time-of-day matters. Store in UTC (my [Now] block shows the offset), e.g. if the phase starts at 9am local and I\'m at UTC+02:00, I store "T07:00:00+00:00".' },
          end:     { type: 'string', description: 'ISO 8601 UTC end time. Required for phases.' },
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
          id:         { type: 'string', description: 'Schedule node id (from my [Temporal Context]). For a recurring occurrence, this is the anchor node\'s id.' },
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
];

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

  save_memory: async ({ content, granularity, title }) => {
    if (!content || typeof content !== 'string' || !content.trim()) return 'Failed to save memory: content is required.';
    if (content.length > 8192) return 'Failed to save memory: content exceeds 8 KB limit.';
    if (!VALID_MEMORY_GRANULARITIES.has(granularity)) {
      return `Failed to save memory: granularity must be one of: ${[...VALID_MEMORY_GRANULARITIES].join(', ')}.`;
    }
    // Significant memories MUST be uniquely slugged or they collide on the
    // date-only filename and Phylactery's merge step destroys them.
    let slug;
    if (granularity === 'significant') {
      slug = deriveMemorySlug(title) ?? deriveMemorySlug(content) ?? `memory-${Date.now()}`;
    }
    try {
      const result = await createMemory({ content: content.trim(), granularity, slug });
      if (!result.ok) return `Memory save failed: ${result.error ?? 'unknown error'}`;
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
      const result = await createGraphNode({ label: label.trim(), type, description });
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

  update_graph_node: async ({ id, label, description, type }) => {
    try {
      const result = await updateGraphNode({ id, label, description, type });
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

  village_upsert: async ({ id, name, category, relationToWard, pronouns, commStyleNotes, notes, privateNotes, graphNodeId } = {}, ctx = {}) => {
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

      // Resolve category name → id (the Familiar knows names, not ids).
      if (typeof category === 'string' && category.trim()) {
        const reg = await _toolDeps.getVillageRegistry();
        const cats = reg?.categories ?? [];
        const q = category.trim().toLowerCase();
        const hit = cats.find(c => c.id.toLowerCase() === q || c.name.toLowerCase() === q);
        if (!hit) return `I don't have a category called "${category}". Categories: ${cats.map(c => c.name).join(', ') || '(none)'}.`;
        args.categoryIds = [hit.id];
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
export function composeActiveTools(customTools) {
  const tools = [...BUILTIN_TOOLS];
  if (Array.isArray(customTools)) {
    for (const t of customTools) {
      if (t && typeof t === 'object') tools.push(t);
    }
  }
  return tools;
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
