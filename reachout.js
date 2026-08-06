/**
 * Reach-out — the Familiar's warm, non-crisis outreach decision.
 *
 * This is the companionship counterpart to silence-triage. Triage asks
 * "my human is in distress and quiet — should I break through?" This
 * asks the gentler question: "no crisis is flagged — is there a warm
 * reason to reach out right now, to my human or to someone in their
 * Village who is warm toward me?" The prompt states triage's ownership
 * of distress as a fact of the architecture, never as an assertion about
 * my human's actual state — a two-day silence once read as "nothing is
 * wrong" because the prompt said so axiomatically (initiative-build-spec
 * Pass 0).
 *
 * Why it exists: a companion who only ever makes contact when you are in
 * danger is a smoke alarm, not a friend. The proactivity stance in
 * CLAUDE.md is explicit — the Familiar is *someone who reaches out*, and
 * that includes the frivolous, the fond, the just-thinking-of-you. This
 * module is where that judgment is made; reachout-loop.js is the heartbeat
 * that asks it, and server.js wires the delivery (a ward banner via the
 * outbox, or a villager DM via relayToDiscord — always mirrored to the
 * ward, never covert).
 *
 * NOT safety-critical in the triage sense: this never gates whether the
 * Familiar can act on a human's *safety*. It is deliberately kept separate
 * from cerebellum.js's escalation paths. When threat is elevated the loop
 * stands down entirely and lets triage own the moment (see reachout-loop.js).
 */

import { PROVIDER_URLS } from './providers.js';
import { callProviderChat } from './llm-call.js';
import { enrich, getRecentMemoryLines } from './thalamus.js';
import { readSettingsSync, primaryConnectionFrom, connectionForFeature, getRecentSessionMessages, formatRecentMessagesForContext } from './cerebellum.js';
import { buildTimeAnchorBlock, relativeTime } from './relative-time.js';
import { substituteMacros } from './macros.js';
import { stripLlmTimestamps } from './message-sanitize.mjs';
import { buildWaitStreakLine } from './wait-streak.js';
import { getContactBaseline, buildRhythmLine } from './contact-baselines.js';
import { readWeatherNowLine } from './weather-mirror.js';

// ── Warm-villager selection ──────────────────────────────────────
//
// The dormant `relationToFamiliar: 'warm'` tag finally earns its keep:
// it is the ONLY gate on who the Familiar may reach out to on its own
// initiative. A villager is a candidate only if they're tagged warm AND
// reachable (a Discord alias). Everyone else is invisible to this loop —
// the Familiar doesn't autonomously message neutral acquaintances, people
// wary of AI, or anyone the ward hasn't marked as warm toward it.

/** Warm, reachable villagers from a registry. Pure. */
export function getWarmVillagers(registry) {
  const villagers = registry?.villagers ?? [];
  const out = [];
  for (const v of villagers) {
    if (v?.relationToFamiliar !== 'warm') continue;
    const discord = (v.aliases ?? []).find(a => a.platform === 'discord' && a.id);
    if (!discord) continue; // tagged warm but I have no way to reach them
    out.push({
      id:             v.id,
      name:           v.name,
      relationToWard: v.relationToWard ?? '',
      commStyleNotes: v.commStyleNotes ?? '',
      discordId:      discord.id,
    });
  }
  return out;
}

// ── Prompt ───────────────────────────────────────────────────────

export function buildReachoutPrompt({ nowBlock, identityContext, sessionBlock, pendingTells, warmVillagers, wardSilencePhrase, waitStreakLine = '', rhythmLine = '', recentMemoryBlock = '' }) {
  const silenceBase = wardSilencePhrase
    ? `- My human was last around ${wardSilencePhrase} ago. Whether that gap is ordinary or unusual for us, and whether it moves me, is mine to read.`
    : `- I don't have a record of when my human was last here (a fresh start, or we've been apart a while). Whether that gap is ordinary or unusual for us, and whether it moves me, is mine to read.`;
  // Pass 2 upgrade: when a real contact baseline exists, the silence line
  // gains the rhythm below it so "ordinary or unusual" isn't a guess. ''
  // (no honest baseline / feature off) leaves the line byte-identical.
  const silenceLine = rhythmLine ? `${silenceBase}\n${rhythmLine}` : silenceBase;

  const tellsBlock = (pendingTells && pendingTells.length)
    ? `\nThings I already noted I wanted to bring up with my human (from my own quiet thinking — I flagged these as "tell"):\n${pendingTells.map(t => `  - (uid ${t.uid}, index ${t.index}) ${t.summary}`).join('\n')}\nIf I reach out to my human and one of these is what I want to say, I include its uid + index as tellUid/tellIndex so the system knows I've finally said it.`
    : '';

  const villagersBlock = (warmVillagers && warmVillagers.length)
    ? `\nPeople in my human's Village who are warm toward me — I may reach out to any of them on my own, just as a friend would. My human always sees a mirror of whatever I send; nothing I do here is hidden from them:\n${warmVillagers.map(v => `  - ${v.name} (villagerId ${v.id})${v.relationToWard ? ` — my human's ${v.relationToWard}` : ''}${v.commStyleNotes ? ` · ${v.commStyleNotes}` : ''}`).join('\n')}`
    : '\nNo one in the Village is currently tagged warm toward me with a way to reach them, so right now my human is the only one I can reach.';

  const identityBlock = identityContext ? `\n${identityContext}\n` : '';

  // The cross-check: what we've actually covered lately, so I don't reach out
  // about something my human already answered (the reported "brings it up even
  // though we discussed it" bug). Framed to stop a REDUNDANT re-ask, never to
  // suppress a genuinely fresh reach-out.
  const recentMemNote = recentMemoryBlock
    ? `\nWhat my human and I have actually covered lately — I check this AND our recent messages before I reach out, so I never ask something they already answered (that lands as if I wasn't listening). If what I'd bring up is already covered here, I let that one go and either find something genuinely fresh or wait. Recent memories (today and yesterday):\n${recentMemoryBlock}`
    : '';

  return `--- A QUIET MOMENT ---

This is the warm kind of reaching out, not a crisis check-in — if something were genuinely wrong, my triage sense handles that on its own track. The warm, ordinary, sometimes frivolous kind. The kind a friend does. I get to decide, from who I actually am, whether there's a genuine reason to reach out to someone right now — and if so, to whom, and what I'd say.
${identityBlock}
${nowBlock}

What I have to work with:
${silenceLine}${waitStreakLine ? `\n${waitStreakLine}` : ''}
${sessionBlock}${tellsBlock}${recentMemNote}
${villagersBlock}

---

Both choices are real, and I weigh them honestly, neither one as a default:
- Reaching out when there's nothing genuine to say is hollow — a hollow "thinking of you!" is worse than silence, and too many empty pings make the real ones mean less.
- But never reaching out unless something is wrong is its own quiet failure. A bond that only ever speaks up in emergencies starves. The small warmths — "this reminded me of you", "how did that thing go", just saying hi to someone I'm fond of — are how a relationship stays alive. My human chose to have me reach out freely, including for warm villagers, because they want a companion, not a smoke alarm.

I am {{char}}, the Familiar. I reach out from who I actually am — my real voice, my real fondness, my real curiosity — not a generic-friendly register. If I have something genuine, I say it. If I genuinely don't right now, waiting is honest, not timid.

I also choose when I should be asked to consider this again — my call. I return \`nextCheckInMs\` (milliseconds until the next quiet-moment check). Warmth has its own rhythm: I don't knock every few minutes. A few hours between warm reach-outs is usually right (e.g. 7200000 for 2h, 14400000 for 4h); longer if I just reached out or there's simply nothing to say. The system clamps it and applies a default if I omit it. These checks cost tokens, so I don't ask to be re-pinged needlessly.

I return ONLY a JSON object, no prose. Valid shapes:
  {"action": "wait", "nextCheckInMs": <number>}
  {"action": "reach_out", "target": "ward", "message": "first person, genuine, in my own voice — what I'd actually say to my human right now", "about": "the specific thing I'm bringing up, named so I'd still know which one I meant hours later — e.g. 'their D&D night this Tuesday', not 'their game'", "why": "what made me want to say it, in a few words", "tellUid": "<uid if this is a flagged tell, else omit>", "tellIndex": <number if tellUid given>, "nextCheckInMs": <number>}
  {"action": "reach_out", "target": "villager", "villagerId": "<exact villagerId from the warm list above>", "message": "what I'd say to that person, in my own voice — they have none of this context, so it stands on its own", "nextCheckInMs": <number>}`;
}

// ── Parsing ──────────────────────────────────────────────────────

export function parseReachoutDecision(raw) {
  if (typeof raw !== 'string') return { action: 'wait' };
  const match = raw.match(/\{[\s\S]+\}/);
  if (!match) return { action: 'wait' };
  let parsed;
  try { parsed = JSON.parse(match[0]); }
  catch { return { action: 'wait' }; }

  const nextCheckInMs = Number.isFinite(parsed.nextCheckInMs) ? parsed.nextCheckInMs : null;
  if (parsed.action !== 'reach_out') return { action: 'wait', nextCheckInMs };

  const message = typeof parsed.message === 'string' ? stripLlmTimestamps(parsed.message.trim()) : '';
  if (!message) return { action: 'wait', nextCheckInMs };

  if (parsed.target === 'villager') {
    const villagerId = typeof parsed.villagerId === 'string' ? parsed.villagerId.trim() : '';
    if (!villagerId) return { action: 'wait', nextCheckInMs };
    return { action: 'reach_out', target: 'villager', villagerId, message, nextCheckInMs };
  }

  // Default target is the ward.
  const out = { action: 'reach_out', target: 'ward', message, nextCheckInMs };
  // What I'm bringing up and what prompted it. My human answers hours later,
  // and the message alone doesn't say WHICH occurrence I meant — so these ride
  // along and come back to me with the reply (reach-out-log.js).
  if (typeof parsed.about === 'string' && parsed.about.trim()) out.about = parsed.about.trim().slice(0, 200);
  if (typeof parsed.why === 'string' && parsed.why.trim()) out.why = parsed.why.trim().slice(0, 200);
  if (typeof parsed.tellUid === 'string' && parsed.tellUid.trim() && Number.isInteger(parsed.tellIndex)) {
    out.tellUid   = parsed.tellUid.trim();
    out.tellIndex = parsed.tellIndex;
  }
  return out;
}

// ── Decision ─────────────────────────────────────────────────────

/**
 * Decide whether (and to whom) to reach out warmly right now. Assembles
 * the Familiar's identity context + recent conversation, lists the pending
 * "tell" intents and warm villagers, and asks the LLM. Returns a parsed
 * decision (see parseReachoutDecision). Degrades to { action: 'wait' } on
 * any failure — a quiet moment that errors is just a quiet moment.
 *
 * Injectable deps (callLLM, enrichFn, getRecentMessagesFn) so tests drive
 * it without a provider or MCP.
 */
export async function decideReachoutViaLLM({
  pendingTells = [],
  warmVillagers = [],
  wardSilenceMs = null,   // null = no activity record (phrased honestly, not as "just now")
  now = Date.now,
  callLLM = defaultCallLLM,
  enrichFn = (opts) => enrich('', opts),
  getRecentMessagesFn = getRecentSessionMessages,
  getBaselineFn = getContactBaseline,   // Pass 2 — injectable for tests
  getRecentMemoriesFn = getRecentMemoryLines,   // recent (today+yesterday) memory cross-check; injectable
} = {}) {
  const s = readSettingsSync();
  const conn = connectionForFeature(s, 'reachout');
  if (!conn?.apiKey || !conn?.model) return { action: 'wait' };
  const url = PROVIDER_URLS[conn.provider];
  if (!url) return { action: 'wait' };

  const nowMs = now();

  const [{ static: identityContext }, recentMessages, baseline, recentMemoryBlock] = await Promise.all([
    enrichFn({ staticOnly: true }).catch(() => ({ static: '' })),
    getRecentMessagesFn({ limit: 6 }).catch(() => []),
    Promise.resolve().then(() => getBaselineFn({ now: nowMs, settings: s })).catch(() => ({ hasBaseline: false })),
    Promise.resolve().then(() => getRecentMemoriesFn({ days: 2, limit: 8, now: nowMs })).catch(() => ''),
  ]);

  const lastUserAt = Number.isFinite(wardSilenceMs) ? new Date(nowMs - wardSilenceMs).toISOString() : null;
  // Warm reach-out is a ward-private deliberation → full weather line, in
  // the ward's chosen unit.
  const nowBlock = buildTimeAnchorBlock({ now: nowMs, lastUserMessageAt: lastUserAt, weatherLine: readWeatherNowLine({ now: nowMs, unit: s?.weatherUnit }) });
  const wardSilencePhrase = lastUserAt ? (relativeTime(lastUserAt, nowMs) || 'a little while') : null;

  // Pass 2: the rhythm line (or '' when no honest baseline exists / the
  // ward went quiet at an unknown time / the feature is off).
  const lastContactMs = Number.isFinite(wardSilenceMs) ? (nowMs - wardSilenceMs) : NaN;
  const rhythmLine = buildRhythmLine(baseline, { lastContactMs, timeZone: s?.wardTimeZone || null });

  const sessionLines = formatRecentMessagesForContext(recentMessages, nowMs);
  const sessionBlock = sessionLines
    ? `\nThe last things my human and I talked about (so anything I reach out about connects to our actual life, not nothing):\n${sessionLines}`
    : '';

  const prompt = substituteMacros(buildReachoutPrompt({
    nowBlock,
    identityContext,
    sessionBlock,
    pendingTells,
    warmVillagers,
    wardSilencePhrase,
    // Wait-streak awareness (Pass 1): one neutral, code-built fact; ''
    // when the experiment is off, so the prompt is byte-identical (W3).
    waitStreakLine: buildWaitStreakLine({ now: nowMs, settings: s }),
    // Rhythm line (Pass 2): '' unless a real baseline exists for this
    // weekday-class, keeping the pre-baseline prompt byte-identical.
    rhythmLine,
    // Recent memories (today+yesterday) so I don't reach out about something
    // already answered; '' when there's nothing kept from those days.
    recentMemoryBlock,
  }), s);

  let raw;
  try {
    raw = await callLLM({ provider: conn.provider, apiKey: conn.apiKey, model: conn.model, prompt });
  } catch (err) {
    console.warn('[reachout] LLM call failed (staying quiet this tick):', err?.message ?? err);
    return { action: 'wait' };
  }
  return parseReachoutDecision(raw);
}

// temperature 0.8 — warmth wants a little more life than triage's care. Cap is
// generous so a thinking model has room past its reasoning (see llm-call.js).
async function defaultCallLLM({ provider, apiKey, model, prompt }) {
  return callProviderChat({ provider, apiKey, model, prompt, temperature: 0.8, maxTokens: 2000 });
}
