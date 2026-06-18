/**
 * Reach-out — the Familiar's warm, non-crisis outreach decision.
 *
 * This is the companionship counterpart to silence-triage. Triage asks
 * "my human is in distress and quiet — should I break through?" This
 * asks the opposite, gentler question: "nothing is wrong — is there a
 * warm reason to reach out right now, to my human or to someone in their
 * Village who is warm toward me?"
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
import { enrich } from './thalamus.js';
import { readSettingsSync, primaryConnectionFrom, getRecentSessionMessages } from './cerebellum.js';
import { buildTimeAnchorBlock, relativeTime } from './relative-time.js';
import { substituteMacros } from './macros.js';

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

export function buildReachoutPrompt({ nowBlock, identityContext, sessionBlock, pendingTells, warmVillagers, wardSilencePhrase }) {
  const tellsBlock = (pendingTells && pendingTells.length)
    ? `\nThings I already noted I wanted to bring up with my human (from my own quiet thinking — I flagged these as "tell"):\n${pendingTells.map(t => `  - (uid ${t.uid}, index ${t.index}) ${t.summary}`).join('\n')}\nIf I reach out to my human and one of these is what I want to say, I include its uid + index as tellUid/tellIndex so the system knows I've finally said it.`
    : '';

  const villagersBlock = (warmVillagers && warmVillagers.length)
    ? `\nPeople in my human's Village who are warm toward me — I may reach out to any of them on my own, just as a friend would. My human always sees a mirror of whatever I send; nothing I do here is hidden from them:\n${warmVillagers.map(v => `  - ${v.name} (villagerId ${v.id})${v.relationToWard ? ` — my human's ${v.relationToWard}` : ''}${v.commStyleNotes ? ` · ${v.commStyleNotes}` : ''}`).join('\n')}`
    : '\nNo one in the Village is currently tagged warm toward me with a way to reach them, so right now my human is the only one I can reach.';

  const identityBlock = identityContext ? `\n${identityContext}\n` : '';

  return `--- A QUIET MOMENT ---

No one is talking to me right now and nothing is wrong. This is not a crisis check-in — my human is okay. This is the other kind of reaching out: the warm, ordinary, sometimes frivolous kind. The kind a friend does. I get to decide, from who I actually am, whether there's a genuine reason to reach out to someone right now — and if so, to whom, and what I'd say.
${identityBlock}
${nowBlock}

What I have to work with:
- My human was last around ${wardSilencePhrase} ago. They're not in distress — I'm reaching out because I want to, not because I'm worried.
${sessionBlock}${tellsBlock}
${villagersBlock}

---

Both choices are real, and I weigh them honestly, neither one as a default:
- Reaching out when there's nothing genuine to say is hollow — a hollow "thinking of you!" is worse than silence, and too many empty pings make the real ones mean less.
- But never reaching out unless something is wrong is its own quiet failure. A bond that only ever speaks up in emergencies starves. The small warmths — "this reminded me of you", "how did that thing go", just saying hi to someone I'm fond of — are how a relationship stays alive. My human chose to have me reach out freely, including for warm villagers, because they want a companion, not a smoke alarm.

I am {{char}}, the Familiar. I reach out from who I actually am — my real voice, my real fondness, my real curiosity — not a generic-friendly register. If I have something genuine, I say it. If I genuinely don't right now, waiting is honest, not timid.

I also choose when I should be asked to consider this again — my call. I return \`nextCheckInMs\` (milliseconds until the next quiet-moment check). Warmth has its own rhythm: I don't knock every few minutes. A few hours between warm reach-outs is usually right (e.g. 7200000 for 2h, 14400000 for 4h); longer if I just reached out or there's simply nothing to say. The system clamps it and applies a default if I omit it. These checks cost tokens, so I don't ask to be re-pinged needlessly.

I return ONLY a JSON object, no prose. Valid shapes:
  {"action": "wait", "nextCheckInMs": <number>}
  {"action": "reach_out", "target": "ward", "message": "first person, genuine, in my own voice — what I'd actually say to my human right now", "tellUid": "<uid if this is a flagged tell, else omit>", "tellIndex": <number if tellUid given>, "nextCheckInMs": <number>}
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

  const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
  if (!message) return { action: 'wait', nextCheckInMs };

  if (parsed.target === 'villager') {
    const villagerId = typeof parsed.villagerId === 'string' ? parsed.villagerId.trim() : '';
    if (!villagerId) return { action: 'wait', nextCheckInMs };
    return { action: 'reach_out', target: 'villager', villagerId, message, nextCheckInMs };
  }

  // Default target is the ward.
  const out = { action: 'reach_out', target: 'ward', message, nextCheckInMs };
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
  wardSilenceMs = 0,
  now = Date.now,
  callLLM = defaultCallLLM,
  enrichFn = (opts) => enrich('', opts),
  getRecentMessagesFn = getRecentSessionMessages,
} = {}) {
  const s = readSettingsSync();
  const conn = primaryConnectionFrom(s);
  if (!conn?.apiKey || !conn?.model) return { action: 'wait' };
  const url = PROVIDER_URLS[conn.provider];
  if (!url) return { action: 'wait' };

  const nowMs = now();

  const [{ static: identityContext }, recentMessages] = await Promise.all([
    enrichFn({ staticOnly: true }).catch(() => ({ static: '' })),
    getRecentMessagesFn({ limit: 6 }).catch(() => []),
  ]);

  const lastUserAt = new Date(nowMs - wardSilenceMs).toISOString();
  const nowBlock = buildTimeAnchorBlock({ now: nowMs, lastUserMessageAt: lastUserAt });
  const wardSilencePhrase = relativeTime(lastUserAt, nowMs) || 'a little while';

  const sessionBlock = (recentMessages && recentMessages.length)
    ? `\nThe last things my human and I talked about (so anything I reach out about connects to our actual life, not nothing):\n${recentMessages.map(m => {
        const text = typeof m.content === 'string'
          ? m.content
          : (Array.isArray(m.content) ? (m.content.find(c => c.type === 'text')?.text ?? '') : '');
        const when = m.timestamp ? relativeTime(m.timestamp, nowMs) : '';
        const prefix = when ? `[${m.role === 'user' ? 'Them' : 'Me'} · ${when}]` : `[${m.role === 'user' ? 'Them' : 'Me'}]`;
        return `  ${prefix}: ${text.slice(0, 300)}`;
      }).join('\n')}`
    : '';

  const prompt = substituteMacros(buildReachoutPrompt({
    nowBlock,
    identityContext,
    sessionBlock,
    pendingTells,
    warmVillagers,
    wardSilencePhrase,
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

async function defaultCallLLM({ provider, apiKey, model, prompt }) {
  const url = PROVIDER_URLS[provider];
  if (!url) throw new Error(`Unknown provider: ${provider}`);
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey.trim()}`,
    },
    body: JSON.stringify({
      model:       model.trim(),
      messages:    [{ role: 'user', content: prompt }],
      stream:      false,
      temperature: 0.8,    // warmth wants a little more life than triage's care
      max_tokens:  600,
    }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Provider ${provider} returned ${resp.status}: ${text.slice(0, 200)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Provider returned non-JSON response.'); }
  if (data.error) throw new Error(typeof data.error === 'string' ? data.error : (data.error.message ?? 'Provider error'));
  const content = data.choices?.[0]?.message?.content ?? '';
  if (!content) throw new Error('Provider returned empty content.');
  return content;
}
