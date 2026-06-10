/**
 * Proto-Familiar — lightweight LLM frontend server
 * Proxies chat requests to z.ai and NanoGPT, avoiding CORS issues.
 * Requires Node.js 18+ (uses built-in fetch).
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, readFileSync, promises as fsp } from 'fs';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);
import {
  startThalamus,
  enrich, createMemory, appendIdentity, updateIdentitySection,
  // Reads for the Knowledge editor UI
  listMemories, readMemory, getIdentityAll, listGraphNodes, searchGraphNodes, getGraphSubgraph, getFullGraph,
  listSnapshots,
  // Writes (each auto-snapshots before the destructive op)
  updateMemory, deleteMemory, rewriteIdentitySection,
  updateGraphNode, deleteGraphNode, updateGraphEdge, deleteGraphEdge,
  createGraphNode, createGraphEdge,
  createSnapshot, restoreSnapshot,
  reconnectEntityCore,
  recordInterest, recordHandoff, listLiveInterests, listInterests,
  bumpInterest, demoteStanding, setStandingInterest,
  getScheduleWindow, addScheduleNode, updateScheduleNode,
  resolveScheduleNode, resolveScheduleOccurrence, deleteScheduleNode, listPhases, listRecurring,
  getHandoff, markHandoffConsumed,
  getDueReminders, getRemindersHealth,
  shutdownUnruh, shutdownEntityCore,
  reportSurfacingOutcomes, listBookmarks,
} from './thalamus.js';
import { scoreMessage } from './crisis-signals.js';
import { recordThreat, resetThreat, getThreat, getThreatHistory } from './threat-tracker.js';
import { ponderOnce } from './pondering.js';
import { startPonderingLoop, stopPonderingLoop } from './pondering-loop.js';
import {
  shouldReflectNow,
  getNewOutcomesSinceLastReflection,
  markReflected,
} from './surface-events.js';
import { getRecentPonderings, deletePondering, markIntentActedOn } from './recent-ponderings.js';
import { startRemindersLoop, stopRemindersLoop } from './reminders-loop.js';
import { listOutbox, acknowledgeOutbox, clearAcknowledged, enqueueOutbox, updateOutboxMeta } from './outbox.js';
import { startSilenceTriageLoop, stopSilenceTriageLoop, TRIAGE_SILENCE_THRESHOLD_MS } from './silence-triage-loop.js';
import { recordUserActivity, getLastUserActivity } from './last-activity.js';
import { buildTimeAnchorBlock } from './relative-time.js';
import { expandWindow } from './recurrence.js';
import {
  enqueueMemorization,
  listJobs as listMemorizationJobs,
  acknowledgeJob as acknowledgeMemorizationJob,
  cancelJob as cancelMemorizationJob,
  startMemorizationWorker, stopMemorizationWorker,
  findOrCreateSessionMemoriesTome,
} from './memorization.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Single source of truth for the version string. Read package.json once
// at startup; everything else (startup banner, /api/health, /api/version,
// the UI badge) reads from this.
const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || 'unknown';
  } catch { return 'unknown'; }
})();

// Ensure the logs directory exists next to server.js
const LOGS_DIR = path.join(__dirname, 'logs');
mkdirSync(LOGS_DIR, { recursive: true });

// Only allow UUID-shaped IDs to prevent path traversal and bound input size.
// Used for session IDs, tome IDs, entry UIDs, and memorization job IDs — all
// of which are generated via crypto.randomUUID() and share the same shape.
function isValidUUID(id) {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}

const app = express();
app.set('trust proxy', 'loopback');

// ── Runtime Tailscale / external-access gate ─────────────────────
// Server binds to 0.0.0.0 by default so the in-UI toggle can flip
// external access at runtime without a restart. Until the toggle is
// on, this middleware drops anything that isn't a loopback request,
// so the default posture matches the historical localhost-only bind.
//
// Registered BEFORE express.json so a non-loopback request never gets
// its body buffered (would otherwise eat memory on a 4 MB upload before
// we even decide it's unauthorised).
const TAILSCALE_CONFIG_FILE = path.join(__dirname, '.proto-familiar-config.json');

function loadTailscaleConfig() {
  try {
    const raw = readFileSync(TAILSCALE_CONFIG_FILE, 'utf8');
    const obj = JSON.parse(raw);
    return { enabled: !!obj.tailscaleEnabled };
  } catch (err) {
    if (err.code && err.code !== 'ENOENT') {
      console.warn(`[tailscale] failed to read ${TAILSCALE_CONFIG_FILE}: ${err.message} — falling back to TAILSCALE env`);
    }
    return { enabled: /^(1|true|yes)$/i.test(process.env.TAILSCALE || '') };
  }
}
async function saveTailscaleConfig(cfg) {
  // Atomic tmp + rename so concurrent toggles can't leave a half-written file.
  const tmp = TAILSCALE_CONFIG_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify({ tailscaleEnabled: !!cfg.enabled }, null, 2), 'utf8');
  await fsp.rename(tmp, TAILSCALE_CONFIG_FILE);
}
const tailscaleState = { enabled: loadTailscaleConfig().enabled };

function isLoopbackIp(ip) {
  if (!ip) return false;
  if (ip === '::1') return true;
  let v = ip;
  if (v.startsWith('::ffff:')) v = v.slice(7);
  return v.startsWith('127.');
}

app.use((req, res, next) => {
  if (tailscaleState.enabled) return next();
  if (isLoopbackIp(req.ip)) return next();
  res.status(403)
    .type('text/plain')
    .send('Proto-Familiar is configured for localhost only. Enable the Tailscale toggle in the top bar to allow access from other devices.');
});

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Provider chat-completions URLs live in providers.js so thalamus.js can
// share them when it builds the env block for entity-core. See that file
// for the rationale and how to add a new provider.
import { PROVIDER_URLS } from './providers.js';
// Tome / state-file coordination is owned by thalamus — every writer
// of a shared file goes through these helpers so cross-loop races
// (HTTP route + autonomous loop hitting the same tome) can't lose
// each other's edits. The locking primitive (withLock) and the
// atomic .tmp+rename pattern live in thalamus.js.
import { withLock, writeTomeFile, modifyTomeFile } from './thalamus.js';

// Simple in-memory rate limiter for /api/chat: max 20 requests per minute per IP.
// Protects against accidental public exposure and runaway tool-call loops.
const _chatRateCounts = new Map();
function chatRateLimit(req, res, next) {
  const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  const now = Date.now();
  const WINDOW_MS = 60_000;
  const MAX_REQ   = 20;
  const entry = _chatRateCounts.get(ip) ?? { count: 0, resetAt: now + WINDOW_MS };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + WINDOW_MS; }
  entry.count++;
  _chatRateCounts.set(ip, entry);
  if (entry.count > MAX_REQ) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment before sending another message.' });
  }
  next();
}

/**
 * POST /api/chat
 * Body: { provider, apiKey, model, messages, stream, temperature?, max_tokens? }
 * Proxies to the chosen provider and streams or returns the response.
 */
app.post('/api/chat', chatRateLimit, async (req, res) => {
  const { provider, apiKey, model, messages, stream, temperature, max_tokens, tools, tool_choice, enrich: enrichFlag, userMessage, lastUserMessageAt } = req.body;
  // Enrichment mode:
  //   true / undefined → full (identity + memory + graph + temporal),
  //                      and consume any surfaced session handoff.
  //   'static'         → identity / persona only — no memory bloat, no
  //                      temporal block, no handoff consumption. Used by
  //                      the handoff summariser so its note is in the
  //                      Familiar's voice without the dynamic context.
  //   false            → none.
  const enrichMode = enrichFlag === false ? 'none' : enrichFlag === 'static' ? 'static' : 'full';

  const url = PROVIDER_URLS[provider];
  if (!url) {
    return res.status(400).json({ error: `Unknown provider: "${provider}". Expected "nanogpt", "zai", or "zai-coding".` });
  }
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return res.status(400).json({ error: 'API key is required.' });
  }
  if (!model || typeof model !== 'string' || !model.trim()) {
    return res.status(400).json({ error: 'Model name is required.' });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages array is required and must not be empty.' });
  }

  // Enrich with entity-core + Unruh context. Split into a static
  // prefix (identity + base instructions; stable across turns so the
  // upstream LLM's prefix cache hits) and a dynamic block (RAG
  // memories, graph excerpts, temporal context; varies per turn so
  // we depth-inject it instead of letting it invalidate the prefix).
  // Degrades gracefully — empty strings on either side just skip
  // the corresponding injection.
  //
  // userText source preference:
  //   1. req.body.userMessage  — explicit user input the frontend
  //      sends on round 0 (skipped on tool-round follow-ups). This
  //      is what {{user}} typed, NOT a templated post-history prompt.
  //   2. last role:'user' in the messages array — the fallback,
  //      which can pick up the post-history prompt because that's
  //      also pushed as role:'user' at the end of the array. Direct
  //      /api/chat callers without `userMessage` get this path.
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const userTextFromMessages = typeof lastUser?.content === 'string'
    ? lastUser.content
    : ((lastUser?.content ?? []).find(c => c.type === 'text')?.text ?? '');
  const userText = (typeof userMessage === 'string' && userMessage.trim())
    ? userMessage
    : userTextFromMessages;
  // ── Crisis-signal detection (step 4b) ─────────────────────────────────
  // Fire-and-forget: score the current user message for distress markers
  // and feed the delta into the threat tracker. Gated to the full chat
  // path (skip on staticOnly handoff summaries and on 'none' enrichment
  // mode) and to non-empty user text. Errors don't block the chat call.
  // The detector is a heuristic, not a diagnostic — see crisis-signals.js
  // for the explicit boundaries. Disable entirely with the env var
  // PROTO_FAMILIAR_THREAT_DISABLED=1.
  if (enrichMode === 'full' && userText && userText.trim()) {
    // Stamp "user just sent a message" so the silence-triage loop
    // knows when to start considering check-ins. Fire-and-forget.
    recordUserActivity().catch(err =>
      console.error('[server] recordUserActivity failed:', err?.message ?? err),
    );
    const { level, signals } = scoreMessage(userText);
    if (level !== 0) {
      // Loud, structured log so the silent-failure case ("the
      // detector quietly stopped firing") can be diagnosed from
      // the server log without instrumenting deeper. Includes
      // every signal id (with `*` marking damped ones) so the
      // weight breakdown is visible.
      const sigSummary = signals.map(s => `${s.id}${s.damped ? '*' : ''}`).join(',');
      console.log(`[threat] scored ${level >= 0 ? '+' : ''}${level} on chat msg [${sigSummary}]`);
      recordThreat({ delta: level, source: 'chat', signals })
        .then(r => {
          if (r.disabled)        console.log('[threat]   record skipped: detector is DISABLED (PROTO_FAMILIAR_THREAT_DISABLED=1)');
          else if (r.ok === false) console.warn(`[threat]   record failed: ${r.error}`);
          else                   console.log(`[threat]   recorded — new tier ${r.tier} (weight ${r.weight})`);
        })
        .catch(err => console.error('[threat]   record threw:', err?.message ?? err));
    }
  }
  // liveTurn: only the full chat path may reconcile state (consume the
  // surfaced session handoff, demote standing values whose entity-core
  // anchor vanished). 'static' fetches persona only (handoff summariser);
  // 'none' skips enrichment entirely. debug-prompt calls enrich() with no
  // options, so it stays read-only.
  const enriched =
      enrichMode === 'full'   ? await enrich(userText, { liveTurn: true, lastUserMessageAt: lastUserMessageAt ?? null })
    : enrichMode === 'static' ? await enrich(userText, { staticOnly: true })
    : { static: '', dynamic: '', surfacedBookmarks: [], surfacedTasks: [] };

  // Inject awareness of any pending (unacknowledged) triage outreaches
  // into the dynamic block so the Familiar knows it reached out while
  // the user was away — and doesn't act confused about having done so.
  let enrichedResult = enriched;
  if (enrichMode === 'full') {
    try {
      const pending = await listOutbox({ pendingOnly: true, limit: 20 });
      const triagePending = pending.filter(i => i.kind === 'triage' && i.body);
      if (triagePending.length > 0) {
        const notices = triagePending
          .map(i => `  - At ${i.ts}: "${i.body}"`)
          .join('\n');
        const block = `\n\n[PENDING CHECK-IN NOTICES]\nWhile my human was away, I reached out to them with the following (they have not yet acknowledged):\n${notices}\n\nI am aware I did this. If their first message back opens a door to it, I may acknowledge having reached out — but I should not lead with it or press.`;
        enrichedResult = { ...enriched, dynamic: (enriched.dynamic || '') + block };
      }
    } catch { /* non-critical */ }
  }

  const depth = getThalamusDynamicDepth();

  let enrichedMessages = messages;

  // 1) Prepend static block to the system message. Lives at the very
  //    top of the prompt so the provider's prefix cache covers it.
  if (enrichedResult.static) {
    const sysIdx = messages.findIndex(m => m.role === 'system');
    if (sysIdx >= 0) {
      enrichedMessages = messages.map((m, i) =>
        i === sysIdx ? { ...m, content: enrichedResult.static + '\n\n' + m.content } : m,
      );
    } else {
      enrichedMessages = [{ role: 'system', content: enrichedResult.static }, ...messages];
    }
  }

  // 2) Depth-inject the dynamic block as a separate system message
  //    N positions from the end. Computed AFTER the static prepend so
  //    the index counts the (possibly newly-created) system message.
  const injection = injectDynamicAtDepth(enrichedMessages, enrichedResult.dynamic, depth);
  enrichedMessages = injection.messages;
  const injectedAt = injection.injectedAt;

  // 3) Time anchor — appended as the VERY LAST system message, after
  //    the chat history and after any post-history prompt. These are
  //    the freshest values the Familiar needs ("what time is it now"
  //    + "how long since my human last messaged") and they belong
  //    nearest the model's response slot so they're at maximum
  //    salience for care reasoning. Only on enrichMode=full — the
  //    handoff summariser path and debug-prompt previews don't need it.
  let timeAnchor = '';
  if (enrichMode === 'full') {
    timeAnchor = buildTimeAnchorBlock({
      now: Date.now(),
      lastUserMessageAt: lastUserMessageAt ?? null,
    }) || '';
    if (timeAnchor) {
      enrichedMessages = [...enrichedMessages, { role: 'system', content: timeAnchor }];
    }
  }

  const payload = { model: model.trim(), messages: enrichedMessages, stream: !!stream };
  if (typeof temperature === 'number') payload.temperature = temperature;
  if (typeof max_tokens === 'number' && max_tokens > 0) payload.max_tokens = max_tokens;
  if (Array.isArray(tools) && tools.length > 0) payload.tools = tools;
  if (tool_choice !== undefined) payload.tool_choice = tool_choice;

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return res.status(502).json({ error: `Network error reaching ${provider}: ${err.message}` });
  }

  // The envelope mirrored on every successful response so the client
  // can render the prompt inspector verbatim instead of re-deriving.
  // Carries both blocks separately + the injection coordinates so the
  // inspector can show static-vs-dynamic regions distinctly.
  const thalamusEnvelope = (enrichedResult.static || enrichedResult.dynamic || timeAnchor) ? {
    static:     enrichedResult.static  || '',
    dynamic:    enrichedResult.dynamic || '',
    depth,
    injectedAt,
    timeAnchor,
  } : null;

  // Non-streaming path
  if (!stream) {
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json');
    if (thalamusEnvelope && upstream.ok) {
      try {
        const parsed = JSON.parse(text);
        parsed._thalamus = thalamusEnvelope;
        // M8 idle-mode outcome reporting: fire-and-forget after response sent.
        if (enriched.surfacedBookmarks?.length > 0) {
          const responseText = parsed.choices?.[0]?.message?.content ?? '';
          reportSurfacingOutcomes({ responseText, bookmarks: enriched.surfacedBookmarks })
            .catch(err => console.error('[server] reportSurfacingOutcomes failed:', err?.message ?? err));
        }
        return res.send(JSON.stringify(parsed));
      } catch { /* upstream returned non-JSON — pass through unchanged */ }
    }
    return res.send(text);
  }

  // Streaming path — detect if provider returned a JSON error instead of SSE
  const ct = upstream.headers.get('content-type') || '';
  if (!upstream.ok || ct.includes('application/json')) {
    const text = await upstream.text();
    res.status(upstream.status).setHeader('Content-Type', 'application/json');
    return res.send(text);
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering if behind a proxy

  // Emit the thalamus envelope as the first SSE data event, BEFORE the
  // upstream stream, so the client has it by the time the prompt inspector
  // could be opened. Uses the same `data: ` line format as the upstream
  // SSE stream; the client routes on the presence of `_thalamus` instead
  // of `choices`.
  if (thalamusEnvelope) {
    res.write(`data: ${JSON.stringify({ _thalamus: thalamusEnvelope })}\n\n`);
  }

  // M8 idle-mode outcome reporting (streaming path): accumulate the full
  // response text in memory as SSE chunks arrive, then report outcomes
  // after the stream closes. Only active when bookmarks were surfaced.
  const streamBookmarks = enriched.surfacedBookmarks ?? [];
  let accumulatedText = '';

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        res.end();
        // Report outcomes with whatever text was accumulated. Fire-and-forget.
        if (streamBookmarks.length > 0 && accumulatedText) {
          reportSurfacingOutcomes({ responseText: accumulatedText, bookmarks: streamBookmarks })
            .catch(err => console.error('[server] reportSurfacingOutcomes (streaming) failed:', err?.message ?? err));
        }
        break;
      }
      const chunk = Buffer.from(value);
      res.write(chunk);
      // Extract text content from SSE delta chunks for outcome detection.
      // Each chunk may contain multiple `data: {...}\n\n` events. We only
      // need the assistant text, so parse each line's `choices[0].delta.content`.
      if (streamBookmarks.length > 0) {
        const chunkStr = chunk.toString('utf8');
        for (const line of chunkStr.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') continue;
          try {
            const evt = JSON.parse(jsonStr);
            const delta = evt?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string') accumulatedText += delta;
          } catch { /* malformed line — skip */ }
        }
      }
    }
  } catch (err) {
    if (!res.writableEnded) res.end();
  }
});

/**
 * POST /api/debug-prompt
 * Body: { messages }
 * Returns the full message array that would be sent to the LLM for a given
 * messages payload — including entity-core enrichment prepended to the system
 * message. Does NOT call any upstream LLM.
 *
 * WARNING: This endpoint returns entity-core enriched context (personal memory /
 * identity data) with no authentication. Keep it disabled or firewalled in any
 * deployment outside localhost.
 */
app.post('/api/debug-prompt', async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required.' });
  }

  // Mirror the /api/chat split: static into the system message,
  // dynamic depth-injected. Keeps the debug-prompt preview accurate
  // about what /api/chat would actually send.
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const userText = typeof lastUser?.content === 'string'
    ? lastUser.content
    : ((lastUser?.content ?? []).find(c => c.type === 'text')?.text ?? '');
  const enriched = await enrich(userText);
  const depth = getThalamusDynamicDepth();

  let enrichedMessages = messages;
  if (enriched.static) {
    const sysIdx = messages.findIndex(m => m.role === 'system');
    if (sysIdx >= 0) {
      enrichedMessages = messages.map((m, i) =>
        i === sysIdx ? { ...m, content: enriched.static + '\n\n' + m.content } : m,
      );
    } else {
      enrichedMessages = [{ role: 'system', content: enriched.static }, ...messages];
    }
  }
  const injection = injectDynamicAtDepth(enrichedMessages, enriched.dynamic, depth);
  enrichedMessages = injection.messages;

  res.json({ messages: enrichedMessages, depth, injectedAt: injection.injectedAt });
});

// ── Interest engagement (M5) ─────────────────────────────────────

// Translate per-turn chat signals into an interest-weight delta.
// Pure function so the weight semantics live in one testable place.
//
// Two signals (the third, session-boundary survival, lands with the
// M6 handoff):
//
//   token volume — a long, expansive answer signals the topic pulled
//     real engagement. Measured in response characters (chars/4 ≈
//     tokens; we don't run a tokenizer). Scaled so a ~1500-char
//     response contributes ~0.1 (matching the manual record default),
//     capped so a single huge dump can't dominate.
//
//   persistence — a topic that's stayed open across several messages
//     is one the conversation keeps returning to. `spanMessages` is
//     how many messages the topic has been open for; each turn of
//     persistence adds a little, capped.
//
// Both components are additive. A deep, sustained topic (long answers
// across many turns) accrues fastest; a one-off short mention gets a
// small bump that decay erases within a couple of weeks.
const ENGAGE_TOKEN_SCALE_CHARS = 1500; // chars that map to one TOKEN_UNIT
const ENGAGE_TOKEN_UNIT        = 0.1;
const ENGAGE_TOKEN_CAP         = 0.5;
const ENGAGE_PERSIST_PER_TURN  = 0.05;
const ENGAGE_PERSIST_CAP       = 0.3;

function interestEngagementDelta({ responseChars = 0, spanMessages = 0 } = {}) {
  const rc = Number.isFinite(responseChars) && responseChars > 0 ? responseChars : 0;
  const sm = Number.isFinite(spanMessages) && spanMessages > 0 ? spanMessages : 0;
  const tokenComponent = Math.min((rc / ENGAGE_TOKEN_SCALE_CHARS) * ENGAGE_TOKEN_UNIT, ENGAGE_TOKEN_CAP);
  const persistComponent = Math.min(sm * ENGAGE_PERSIST_PER_TURN, ENGAGE_PERSIST_CAP);
  return tokenComponent + persistComponent;
}

// POST /api/interest/engage
// Body: { topics: [{ label, spanMessages }], responseChars }
// Records an engagement bump for each active topic from the turn that
// just completed. Fire-and-forget from the client's perspective —
// returns the computed deltas for debugging but never blocks or fails
// the conversation. Degrades silently when Unruh is down.
const ENGAGE_MAX_TOPICS = 32; // sanity cap; real sessions have a handful

app.post('/api/interest/engage', async (req, res) => {
  const { topics, responseChars } = req.body ?? {};
  if (!Array.isArray(topics) || topics.length === 0) {
    return res.json({ ok: true, recorded: [] });
  }
  // Dedup by label so two open topics sharing a label don't
  // double-count the same engagement; keep the larger span when they
  // collide. Bounded to ENGAGE_MAX_TOPICS so a malformed payload
  // can't drive an unbounded sequence of Unruh calls.
  const byLabel = new Map();
  for (const t of topics.slice(0, ENGAGE_MAX_TOPICS)) {
    const label = typeof t?.label === 'string' ? t.label.trim() : '';
    if (!label) continue;
    const span = Number.isFinite(t?.spanMessages) ? t.spanMessages : 0;
    byLabel.set(label, Math.max(byLabel.get(label) ?? 0, span));
  }
  const recorded = [];
  for (const [label, spanMessages] of byLabel) {
    const delta = interestEngagementDelta({ responseChars, spanMessages });
    if (delta <= 0) continue;
    const ok = await recordInterest({ topic: label, delta, source: 'chat' });
    recorded.push({ topic: label, delta, ok });
  }
  res.json({ ok: true, recorded });
});

// ── Session handoff (M6) ─────────────────────────────────────────

// POST /api/session/handoff
// Body: { intent, threads: [...], sessionId }
// Stores a session-end handoff in Unruh so the next session resumes
// mid-thought. Fire-and-forget from the client; degrades silently
// when Unruh is down. The frontend generates intent/threads by asking
// the chat LLM to summarise the ending session.
app.post('/api/session/handoff', async (req, res) => {
  const { intent, threads, sessionId } = req.body ?? {};
  const ok = await recordHandoff({
    intent: typeof intent === 'string' ? intent : null,
    threads: Array.isArray(threads) ? threads : [],
    sessionId: typeof sessionId === 'string' ? sessionId : null,
  });
  res.json({ ok });
});

// ── Log endpoints ───────────────────────────────────────────────

// POST /api/log — create or overwrite a session log file
app.post('/api/log', async (req, res) => {
  const { sessionId, startedAt, endedAt, provider, model, messages } = req.body;
  if (!isValidUUID(sessionId))
    return res.status(400).json({ error: 'Invalid session ID.' });
  if (!Array.isArray(messages))
    return res.status(400).json({ error: 'messages must be an array.' });

  const logPath = path.join(LOGS_DIR, `${sessionId}.json`);
  const data = {
    sessionId, startedAt, endedAt: endedAt || null, provider, model, messages,
    updatedAt: new Date().toISOString(),
  };
  try {
    await fsp.writeFile(logPath, JSON.stringify(data, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write log.' });
  }
});

// GET /api/logs — list all sessions (metadata only)
app.get('/api/logs', async (_req, res) => {
  try {
    const files = await fsp.readdir(LOGS_DIR);
    const sessions = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fsp.readFile(path.join(LOGS_DIR, f), 'utf8');
        const { sessionId, startedAt, endedAt, updatedAt, provider, model, messages } = JSON.parse(raw);
        sessions.push({ sessionId, startedAt, endedAt, updatedAt, provider, model,
          messageCount: Array.isArray(messages) ? messages.length : 0 });
      } catch { /* skip corrupt files */ }
    }
    sessions.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    res.json(sessions);
  } catch {
    res.json([]);
  }
});

// GET /api/logs/:id — retrieve a full session log
app.get('/api/logs/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidUUID(id))
    return res.status(400).json({ error: 'Invalid session ID.' });
  try {
    const raw = await fsp.readFile(path.join(LOGS_DIR, `${id}.json`), 'utf8');
    res.setHeader('Content-Type', 'application/json');
    res.send(raw);
  } catch {
    res.status(404).json({ error: 'Session not found.' });
  }
});

// DELETE /api/logs/:id — remove a session log
app.delete('/api/logs/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidUUID(id))
    return res.status(400).json({ error: 'Invalid session ID.' });
  try {
    await fsp.unlink(path.join(LOGS_DIR, `${id}.json`));
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Session not found.' });
  }
});

// GET /api/triage-events — return triage decision log (newest first).
// Each entry is one JSON line from triage-events.jsonl: timestamp, tier,
// silence duration, decision, and whether the Familiar acted.
// Useful for auditing past reach-outs and debugging the triage loop.
app.get('/api/triage-events', async (_req, res) => {
  try {
    const raw   = await fsp.readFile(TRIAGE_LOG_FILE, 'utf8');
    const lines  = raw.split('\n').filter(l => l.trim());
    const events = lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .reverse(); // newest first
    res.json(events);
  } catch {
    res.json([]);
  }
});

// Health check
app.get('/api/health',  (_req, res) => res.json({ ok: true, version: PKG_VERSION }));
app.get('/api/version', (_req, res) => res.json({ version: PKG_VERSION }));

// ── Tome endpoints ──────────────────────────────────────────────
const TOMES_DIR = path.join(__dirname, 'tomes');
mkdirSync(TOMES_DIR, { recursive: true });


// True for filenames that look like a tome file (i.e. not the memorization
// queue dotfile or any other hidden bookkeeping file we drop in TOMES_DIR).
function isTomeFile(f) {
  return f.endsWith('.json') && !f.startsWith('.');
}

// Returns the absolute path for a tome file, falling back to a directory scan
// so that pre-existing tomes with non-UUID filenames (e.g. "ADHD-Tome.json") are found.
async function findTomeFile(id) {
  const direct = path.join(TOMES_DIR, `${id}.json`);
  try {
    await fsp.access(direct);
    return direct;
  } catch { /* not found by UUID filename — scan */ }
  const files = await fsp.readdir(TOMES_DIR);
  for (const f of files) {
    if (!isTomeFile(f)) continue;
    try {
      const raw = await fsp.readFile(path.join(TOMES_DIR, f), 'utf8');
      const data = JSON.parse(raw);
      if (data.id === id) return path.join(TOMES_DIR, f);
    } catch { /* skip corrupt */ }
  }
  return direct; // default path for newly created tomes
}

async function readTome(id) {
  try {
    const filePath = await findTomeFile(id);
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// writeTome and modifyTome are thin wrappers around thalamus's
// state-file coordination helpers. Thalamus owns the lock map and
// the .tmp+rename pattern; server.js just resolves the tomeId →
// file path and hands off. Every writer of the same tome file —
// HTTP route, pondering-loop, memorization worker, deletePondering
// — serialises through thalamus's withLock keyed on that path.

async function writeTome(tome) {
  const filePath = await findTomeFile(tome.id);
  return writeTomeFile(filePath, tome);
}

async function modifyTome(tomeId, modifyFn) {
  const filePath = await findTomeFile(tomeId);
  if (!filePath) throw new Error(`Tome ${tomeId} not found`);
  return modifyTomeFile(filePath, modifyFn);
}

// GET /api/tomes — list all tomes (metadata + entry count)
app.get('/api/tomes', async (_req, res) => {
  try {
    const files = await fsp.readdir(TOMES_DIR);
    const tomes = [];
    for (const f of files) {
      if (!isTomeFile(f)) continue;
      try {
        const raw = await fsp.readFile(path.join(TOMES_DIR, f), 'utf8');
        const { id, name, description, enabled, entries } = JSON.parse(raw);
        if (!id) continue; // not a tome (no id) — skip rather than poison the registry
        tomes.push({ id, name, description, enabled, entryCount: Object.keys(entries ?? {}).length });
      } catch { /* skip corrupt */ }
    }
    tomes.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    res.json(tomes);
  } catch {
    res.json([]);
  }
});

// POST /api/tomes — create a new tome
app.post('/api/tomes', async (req, res) => {
  const { name, description } = req.body;
  if (!name || typeof name !== 'string' || !name.trim())
    return res.status(400).json({ error: 'name is required.' });
  const id = randomUUID();
  const tome = { id, name: name.trim(), description: (description ?? '').trim(), enabled: true, entries: {} };
  try {
    await writeTome(tome);
    res.json({ id });
  } catch {
    res.status(500).json({ error: 'Failed to create tome.' });
  }
});

// GET /api/tomes/session-memories — find or create the special Session
// Memories tome (the system tome that receives all session memorization
// output, auto-summarized or manually marked). Always present: created on
// first lookup. Shares find-or-create logic with the memorization worker
// via memorization.js so concurrent calls can't produce duplicates.
// Must be registered BEFORE GET /api/tomes/:id so it isn't shadowed.
app.get('/api/tomes/session-memories', async (_req, res) => {
  try {
    const { tome } = await findOrCreateSessionMemoriesTome();
    res.json({
      id:          tome.id,
      name:        tome.name,
      description: tome.description ?? '',
      enabled:     tome.enabled !== false,
      entryCount:  Object.keys(tome.entries ?? {}).length,
    });
  } catch {
    res.status(500).json({ error: 'Failed to find or create Session Memories tome.' });
  }
});

// GET /api/tomes/:id — get a full tome with entries
app.get('/api/tomes/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid tome ID.' });
  const tome = await readTome(id);
  if (!tome) return res.status(404).json({ error: 'Tome not found.' });
  res.json(tome);
});

// PUT /api/tomes/:id — save full tome (entries + optional metadata).
// modifyTome() acquires the per-file lock for the whole read-modify-write
// so a concurrent pondering-loop entry write or memorization tick can't
// land between the existing-read and the new-write and get clobbered.
app.put('/api/tomes/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid tome ID.' });
  const { name, description, enabled, entries } = req.body;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries))
    return res.status(400).json({ error: 'entries object required.' });
  try {
    await modifyTome(id, (existing) => {
      const safe = {};
      for (const [uid, entry] of Object.entries(entries)) {
        if (!isValidUUID(uid)) continue;
        safe[uid] = entry;
      }
      return {
        ...existing,
        name:        name !== undefined ? (String(name).trim() || existing.name) : existing.name,
        description: description !== undefined ? String(description ?? '').trim() : (existing.description ?? ''),
        enabled:     enabled !== undefined ? !!enabled : existing.enabled,
        entries:     safe,
      };
    });
    res.json({ ok: true });
  } catch (err) {
    if (String(err.message).includes('not found')) return res.status(404).json({ error: 'Tome not found.' });
    res.status(500).json({ error: 'Failed to save tome.' });
  }
});

// PATCH /api/tomes/:id — update metadata only (name, description, enabled)
app.patch('/api/tomes/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid tome ID.' });
  try {
    await modifyTome(id, (tome) => {
      if (req.body.name !== undefined) tome.name = String(req.body.name).trim() || tome.name;
      if (req.body.description !== undefined) tome.description = String(req.body.description ?? '').trim();
      if (req.body.enabled !== undefined) tome.enabled = !!req.body.enabled;
    });
    res.json({ ok: true });
  } catch (err) {
    if (String(err.message).includes('not found')) return res.status(404).json({ error: 'Tome not found.' });
    res.status(500).json({ error: 'Failed to update tome.' });
  }
});

// DELETE /api/tomes/:id — delete a tome
app.delete('/api/tomes/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid tome ID.' });
  try {
    const filePath = await findTomeFile(id);
    await fsp.unlink(filePath);
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Tome not found.' });
  }
});

// DELETE /api/tomes/:id/entries/:uid — remove a single entry
app.delete('/api/tomes/:id/entries/:uid', async (req, res) => {
  const { id, uid } = req.params;
  if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid tome ID.' });
  if (!isValidUUID(uid)) return res.status(400).json({ error: 'Invalid entry UID.' });
  let entryMissing = false;
  try {
    await modifyTome(id, (tome) => {
      if (!tome.entries?.[uid]) { entryMissing = true; return tome; }
      delete tome.entries[uid];
    });
    if (entryMissing) return res.status(404).json({ error: 'Entry not found.' });
    res.json({ ok: true });
  } catch (err) {
    if (String(err.message).includes('not found')) return res.status(404).json({ error: 'Tome not found.' });
    res.status(500).json({ error: 'Failed to save tome.' });
  }
});

// POST /api/tomes/default/entries — add a single entry to the default (first enabled) tome.
// Used by the save_to_tome LLM tool so the model can write knowledge back mid-conversation.
app.post('/api/tomes/default/entries', async (req, res) => {
  const { comment, content, keys, learnedAt } = req.body;
  if (!content || typeof content !== 'string' || !content.trim())
    return res.status(400).json({ error: 'content is required.' });
  if (content.length > 16384)
    return res.status(400).json({ error: 'content exceeds 16 KB limit.' });
  if (comment !== undefined && typeof comment !== 'string')
    return res.status(400).json({ error: 'comment must be a string.' });

  // Accept keys as string[] or comma-separated string
  let normKeys = [];
  if (Array.isArray(keys)) {
    normKeys = keys.map(k => String(k).trim()).filter(Boolean);
  } else if (typeof keys === 'string') {
    normKeys = keys.split(',').map(k => k.trim()).filter(Boolean);
  }

  try {
    // Find first enabled tome — directory scan is read-only so doesn't
    // need a lock. The actual entry insert happens through modifyTome
    // below, which holds the per-file lock across read-modify-write so
    // concurrent saves can't lose each other.
    const files = await fsp.readdir(TOMES_DIR);
    let targetTomeId = null;
    for (const f of files.sort()) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fsp.readFile(path.join(TOMES_DIR, f), 'utf8');
        const t = JSON.parse(raw);
        if (t.enabled) { targetTomeId = t.id; break; }
      } catch { /* skip corrupt */ }
    }

    // If no enabled tome exists, create "General" first. writeTome is
    // atomic + locked, so concurrent creates can't tear the file even
    // if both decide to create (only the lock guards uniqueness; that's
    // OK — the first one wins, the second one writes again and that's
    // a harmless overwrite of an empty tome).
    if (!targetTomeId) {
      const newId = randomUUID();
      const fresh = { id: newId, name: 'General', description: '', enabled: true, entries: {} };
      await writeTome(fresh);
      targetTomeId = newId;
    }

    const uid = randomUUID();
    const now = new Date().toISOString();
    await modifyTome(targetTomeId, (tome) => {
      tome.entries[uid] = {
        uid,
        comment:             typeof comment === 'string' ? comment.trim() || 'Auto-saved entry' : 'Auto-saved entry',
        keys:                normKeys,
        keysecondary:        [],
        content:             content.trim(),
        constant:            false,
        selective:           false,
        selectiveLogic:      0,
        enabled:             true,
        // At-depth, not a system-message position — these keyword-triggered
        // entries would invalidate the prompt prefix cache if injected into
        // it. See the same rationale in memorization.js.
        position:            4,
        depth:               4,
        role:                0,
        scanDepth:           null,
        caseSensitive:       null,
        matchWholeWords:     null,
        probability:         100,
        sticky:              null,
        cooldown:            null,
        preventRecursion:    false,
        delayUntilRecursion: false,
        excludeRecursion:    false,
        group:               '',
        groupWeight:         null,
        insertion_order:     100,
        created_at:          now,
        learnedAt:           (typeof learnedAt === 'string' && learnedAt) ? learnedAt : now,
      };
    });
    res.json({ ok: true, tomeId: targetTomeId, uid });
  } catch {
    res.status(500).json({ error: 'Failed to save entry.' });
  }
});

// ── Memorization queue endpoints ────────────────────────────────

// POST /api/memorize — enqueue a memorization job.
// Accepts JSON body OR sendBeacon's text/plain JSON for beforeunload.
app.post('/api/memorize', express.text({ type: ['text/plain', 'application/json'], limit: '4mb' }), async (req, res) => {
  // express.json() above this route already consumed application/json bodies
  // into req.body. For sendBeacon (text/plain), parse it here.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON.' }); }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Request body required.' });
  }
  const { sessionId, scope, topicId, topicLabel, messageRange, messages, provider, apiKey, model } = body;
  if (!isValidUUID(sessionId))
    return res.status(400).json({ error: 'Invalid session ID.' });
  try {
    const { jobId, deduped } = await enqueueMemorization({
      sessionId, scope, topicId, topicLabel, messageRange, messages, provider, apiKey, model,
    });
    res.status(202).json({ jobId, deduped });
  } catch (err) {
    res.status(400).json({ error: err.message ?? 'Failed to enqueue memorization.' });
  }
});

// GET /api/memorize — list all jobs (sanitized, no apiKey or messages)
app.get('/api/memorize', async (_req, res) => {
  try {
    res.json(await listMemorizationJobs());
  } catch {
    res.json([]);
  }
});

// POST /api/memorize/:id/ack — mark a terminal job as seen by the UI
app.post('/api/memorize/:id/ack', async (req, res) => {
  const { id } = req.params;
  if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid job ID.' });
  const ok = await acknowledgeMemorizationJob(id);
  if (!ok) return res.status(404).json({ error: 'Job not found or not terminal.' });
  res.json({ ok: true });
});

// DELETE /api/memorize/:id — cancel a pending job
app.delete('/api/memorize/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid job ID.' });
  const ok = await cancelMemorizationJob(id);
  if (!ok) return res.status(409).json({ error: 'Job not found or already running.' });
  res.json({ ok: true });
});

// ── Entity-core write endpoints ─────────────────────────────────

const VALID_MEMORY_GRANULARITIES = new Set(['daily', 'weekly', 'monthly', 'yearly', 'significant']);
const VALID_IDENTITY_CATEGORIES  = new Set(['self', 'user', 'relationship', 'custom']);
const VALID_FILENAME_RE           = /^[\w]+\.md$/;

// Derive a filesystem-safe slug from a human title or memory bullet.
// Entity-core stores significant memories as `YYYY-MM-DD_slug.md`. Without
// a slug, every significant save lands at `YYYY-MM-DD.md` and collides with
// the previous one — which triggers entity-core's merge-and-dedup path and
// destroys content (same root cause as the daily-memory wipe in aba6b8a,
// but worse here because the file format itself disagrees on the key).
function deriveMemorySlug(input, maxLen = 60) {
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

// POST /api/entity/memory — write a new memory entry to entity-core
app.post('/api/entity/memory', async (req, res) => {
  const { content, granularity = 'daily', date, title } = req.body;
  if (!content || typeof content !== 'string' || !content.trim())
    return res.status(400).json({ error: 'content is required.' });
  if (content.length > 8192)
    return res.status(400).json({ error: 'content exceeds 8 KB limit.' });
  if (!VALID_MEMORY_GRANULARITIES.has(granularity))
    return res.status(400).json({ error: `granularity must be one of: ${[...VALID_MEMORY_GRANULARITIES].join(', ')}.` });

  // Significant memories MUST be uniquely slugged or they collide with
  // each other (and with restored backups) on the date-only filename
  // and entity-core's merge step destroys them. Derive from the title
  // if the Familiar provided one, otherwise from the content's first
  // line. Last resort: a timestamp suffix so a save never silently
  // fails for lack of slugable characters.
  let slug;
  if (granularity === 'significant') {
    slug = deriveMemorySlug(title) ?? deriveMemorySlug(content) ?? `memory-${Date.now()}`;
  }

  const result = await createMemory({ content: content.trim(), granularity, date, slug });
  if (!result.ok) return res.status(502).json({ error: result.error ?? 'entity-core unavailable' });
  res.json({ ok: true });
});

// POST /api/entity/identity — append to or update a section of an entity-core identity file
app.post('/api/entity/identity', async (req, res) => {
  const { category, filename, heading, content, mode = 'append' } = req.body;
  if (!VALID_IDENTITY_CATEGORIES.has(category))
    return res.status(400).json({ error: `category must be one of: ${[...VALID_IDENTITY_CATEGORIES].join(', ')}.` });
  if (!filename || !VALID_FILENAME_RE.test(filename))
    return res.status(400).json({ error: 'filename must be a simple .md filename (letters, numbers, underscores).' });
  if (!content || typeof content !== 'string' || !content.trim())
    return res.status(400).json({ error: 'content is required.' });
  if (content.length > 8192)
    return res.status(400).json({ error: 'content exceeds 8 KB limit.' });

  let result;
  if (mode === 'update_section') {
    if (!heading || typeof heading !== 'string' || !heading.trim())
      return res.status(400).json({ error: 'heading is required for update_section mode.' });
    result = await updateIdentitySection({ category, filename, heading: heading.trim(), content: content.trim() });
  } else {
    result = await appendIdentity({ category, filename, content: content.trim() });
  }

  if (!result.ok) return res.status(502).json({ error: result.error ?? 'entity-core unavailable' });
  res.json({ ok: true });
});

// ── Entity-core editing endpoints (Knowledge editor UI + LLM write tools) ──
//
// All destructive ops auto-snapshot on the thalamus side via snapshot_create
// before calling the entity-core tool, so the Snapshots tab in the UI lets
// the user roll back if something goes sideways.

const VALID_MEMORY_DATE_RE = /^\d{4}(-W\d{2}|(-\d{2})?(-\d{2})?)$/;
const VALID_GRAPH_ID_RE    = /^[\w-]{1,128}$/;
const VALID_SECTION_RE     = /^[\w\s\-()&'?!,.:/]{1,200}$/; // markdown headings — permissive but bounded
const VALID_SNAPSHOT_ID_RE = /^[\w.\-:]{1,200}$/;

function badRequest(res, message) { return res.status(400).json({ error: message }); }
function gatewayDown(res, err)    { return res.status(502).json({ error: err ?? 'entity-core unavailable' }); }

// ── Memory ────────────────────────────────────────────────────────────────
app.get('/api/entity/memories', async (req, res) => {
  const { granularity, limit } = req.query;
  if (granularity && !VALID_MEMORY_GRANULARITIES.has(granularity))
    return badRequest(res, `granularity must be one of: ${[...VALID_MEMORY_GRANULARITIES].join(', ')}.`);
  const n = limit !== undefined ? Math.max(1, Math.min(100, parseInt(limit, 10) || 50)) : 50;
  try { res.json(await listMemories({ granularity, limit: n })); }
  catch (err) { gatewayDown(res, err.message); }
});

app.get('/api/entity/memories/:granularity/:date', async (req, res) => {
  const { granularity, date } = req.params;
  if (!VALID_MEMORY_GRANULARITIES.has(granularity)) return badRequest(res, 'invalid granularity');
  if (!VALID_MEMORY_DATE_RE.test(date))             return badRequest(res, 'invalid date format');
  try { res.json(await readMemory({ granularity, date })); }
  catch (err) { gatewayDown(res, err.message); }
});

app.put('/api/entity/memories/:granularity/:date', async (req, res) => {
  const { granularity, date } = req.params;
  const { content, editedBy } = req.body;
  if (!VALID_MEMORY_GRANULARITIES.has(granularity)) return badRequest(res, 'invalid granularity');
  if (!VALID_MEMORY_DATE_RE.test(date))             return badRequest(res, 'invalid date format');
  if (typeof content !== 'string' || !content.trim()) return badRequest(res, 'content required');
  if (content.length > 16384)                       return badRequest(res, 'content exceeds 16 KB limit');
  const result = await updateMemory({ granularity, date, content: content.trim(), editedBy });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result);
});

app.delete('/api/entity/memories/:granularity/:date', async (req, res) => {
  const { granularity, date } = req.params;
  if (!VALID_MEMORY_GRANULARITIES.has(granularity)) return badRequest(res, 'invalid granularity');
  if (!VALID_MEMORY_DATE_RE.test(date))             return badRequest(res, 'invalid date format');
  const result = await deleteMemory({ granularity, date, instanceId: req.query.instanceId, slug: req.query.slug });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result);
});

// "Supersede" — write a new memory contradicting an old one. Doesn't delete
// the original; the recency-decay scoring will demote it naturally over
// time while preserving the audit trail.
app.post('/api/entity/memories/supersede', async (req, res) => {
  const { content, granularity = 'daily', supersedes, title } = req.body;
  if (typeof content !== 'string' || !content.trim()) return badRequest(res, 'content required');
  if (!VALID_MEMORY_GRANULARITIES.has(granularity))   return badRequest(res, 'invalid granularity');
  const today = new Date().toISOString().slice(0, 10);
  const body  = supersedes
    ? `[supersedes ${supersedes.granularity ?? 'memory'}/${supersedes.date ?? '?'}]\n${content.trim()}`
    : content.trim();
  // Same slug rule as POST /api/entity/memory — significant memories
  // need a unique filename or entity-core's merge step destroys them.
  let slug;
  if (granularity === 'significant') {
    slug = deriveMemorySlug(title) ?? deriveMemorySlug(content) ?? `memory-${Date.now()}`;
  }
  const result = await createMemory({ content: body, granularity, date: today, slug });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json({ ok: true, date: today });
});

// ── Identity ──────────────────────────────────────────────────────────────
app.get('/api/entity/identity', async (_req, res) => {
  try { res.json(await getIdentityAll()); }
  catch (err) { gatewayDown(res, err.message); }
});

app.put('/api/entity/identity/:category/:filename/sections/:section', async (req, res) => {
  const { category, filename, section } = req.params;
  const { content } = req.body;
  if (!VALID_IDENTITY_CATEGORIES.has(category)) return badRequest(res, 'invalid category');
  if (!VALID_FILENAME_RE.test(filename))        return badRequest(res, 'invalid filename');
  if (!VALID_SECTION_RE.test(section))          return badRequest(res, 'invalid section heading');
  if (typeof content !== 'string')              return badRequest(res, 'content required');
  if (content.length > 16384)                   return badRequest(res, 'content exceeds 16 KB limit');
  const result = await rewriteIdentitySection({ category, filename, section, content });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result);
});

// ── Graph ─────────────────────────────────────────────────────────────────
app.get('/api/entity/graph/nodes', async (req, res) => {
  const { type, limit, offset } = req.query;
  const n = limit  !== undefined ? Math.max(1, Math.min(500, parseInt(limit, 10)  || 200)) : 200;
  const o = offset !== undefined ? Math.max(0, parseInt(offset, 10) || 0) : 0;
  try { res.json(await listGraphNodes({ type, limit: n, offset: o })); }
  catch (err) { gatewayDown(res, err.message); }
});

// Text search across graph nodes — backs the find_graph_node LLM tool so
// the Familiar can resolve a name ("Eury", "Chen") to a graph id without
// loading the full node list.
app.get('/api/entity/graph/search', async (req, res) => {
  const { q, type, limit } = req.query;
  if (!q || typeof q !== 'string' || !q.trim()) return badRequest(res, 'q (query) is required');
  const n = limit !== undefined ? Math.max(1, Math.min(100, parseInt(limit, 10) || 10)) : 10;
  try { res.json(await searchGraphNodes({ query: q.trim(), type, limit: n })); }
  catch (err) { gatewayDown(res, err.message); }
});

// Full-graph dump for the Map view: every node + every deduplicated edge.
// O(N) subgraph calls under the hood; capped via the limit param.
app.get('/api/entity/graph/full', async (req, res) => {
  const { type, limit } = req.query;
  const n = limit !== undefined ? Math.max(1, Math.min(500, parseInt(limit, 10) || 500)) : 500;
  try { res.json(await getFullGraph({ type, limit: n })); }
  catch (err) { gatewayDown(res, err.message); }
});

app.get('/api/entity/graph/nodes/:id/subgraph', async (req, res) => {
  const { id } = req.params;
  if (!VALID_GRAPH_ID_RE.test(id)) return badRequest(res, 'invalid id');
  const depth = Math.max(1, Math.min(3, parseInt(req.query.depth, 10) || 1));
  try { res.json(await getGraphSubgraph({ nodeId: id, depth })); }
  catch (err) { gatewayDown(res, err.message); }
});

app.post('/api/entity/graph/nodes', async (req, res) => {
  const { label, type, description } = req.body ?? {};
  if (label       !== undefined && typeof label       !== 'string') return badRequest(res, 'label must be string');
  if (type        !== undefined && typeof type        !== 'string') return badRequest(res, 'type must be string');
  if (description !== undefined && typeof description !== 'string') return badRequest(res, 'description must be string');
  if (!label && !type && !description) return badRequest(res, 'at least one of label / type / description is required');
  const result = await createGraphNode({ label, type, description });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result);
});

app.post('/api/entity/graph/edges', async (req, res) => {
  const { fromId, toId, type, weight } = req.body ?? {};
  if (!fromId || !VALID_GRAPH_ID_RE.test(fromId)) return badRequest(res, 'valid fromId is required');
  if (!toId   || !VALID_GRAPH_ID_RE.test(toId))   return badRequest(res, 'valid toId is required');
  if (fromId === toId) return badRequest(res, 'fromId and toId must differ');
  if (type !== undefined && typeof type !== 'string') return badRequest(res, 'type must be string');
  if (weight !== undefined && (typeof weight !== 'number' || weight < 0 || weight > 1))
    return badRequest(res, 'weight must be a number in [0, 1]');
  const result = await createGraphEdge({ fromId, toId, type, weight });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result);
});

app.patch('/api/entity/graph/nodes/:id', async (req, res) => {
  const { id } = req.params;
  if (!VALID_GRAPH_ID_RE.test(id)) return badRequest(res, 'invalid id');
  const { label, description, type } = req.body;
  if (label !== undefined && typeof label !== 'string')             return badRequest(res, 'label must be string');
  if (description !== undefined && typeof description !== 'string') return badRequest(res, 'description must be string');
  if (type !== undefined && typeof type !== 'string')               return badRequest(res, 'type must be string');
  const result = await updateGraphNode({ id, label, description, type });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result);
});

app.delete('/api/entity/graph/nodes/:id', async (req, res) => {
  const { id } = req.params;
  if (!VALID_GRAPH_ID_RE.test(id)) return badRequest(res, 'invalid id');
  const permanent = req.query.permanent === '1' || req.query.permanent === 'true';
  const result = await deleteGraphNode({ id, permanent });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result);
});

app.patch('/api/entity/graph/edges/:id', async (req, res) => {
  const { id } = req.params;
  if (!VALID_GRAPH_ID_RE.test(id)) return badRequest(res, 'invalid id');
  const { type, weight } = req.body;
  if (type !== undefined && typeof type !== 'string') return badRequest(res, 'type must be string');
  if (weight !== undefined && (typeof weight !== 'number' || weight < 0 || weight > 1))
    return badRequest(res, 'weight must be a number in [0, 1]');
  const result = await updateGraphEdge({ id, type, weight });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result);
});

app.delete('/api/entity/graph/edges/:id', async (req, res) => {
  const { id } = req.params;
  if (!VALID_GRAPH_ID_RE.test(id)) return badRequest(res, 'invalid id');
  const result = await deleteGraphEdge({ id });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result);
});

// ── Snapshots ─────────────────────────────────────────────────────────────
app.get('/api/entity/snapshots', async (_req, res) => {
  try { res.json(await listSnapshots()); }
  catch (err) { gatewayDown(res, err.message); }
});

app.post('/api/entity/snapshots', async (_req, res) => {
  const result = await createSnapshot();
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result);
});

app.post('/api/entity/snapshots/:id/restore', async (req, res) => {
  const { id } = req.params;
  if (!VALID_SNAPSHOT_ID_RE.test(id)) return badRequest(res, 'invalid snapshot id');
  const result = await restoreSnapshot({ snapshotId: id });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result);
});

const PORT = Number(process.env.PORT) || 8742;

// Bind address. Defaults to 0.0.0.0 so the in-UI Tailscale toggle can flip
// external access at runtime. Until the toggle is on, the gate middleware
// above rejects every non-loopback request, so the effective behavior
// matches the historical localhost-only bind.
const HOST = process.env.HOST || '0.0.0.0';

// Best-effort Tailscale lookup. Failures (CLI missing, not logged in, not
// running) are silent — we just don't report Tailscale URLs.
async function detectTailscale() {
  try {
    const { stdout: ipOut } = await execFileP('tailscale', ['ip', '-4'], { timeout: 2000 });
    const ipv4 = ipOut.split('\n').map(s => s.trim()).filter(Boolean)[0] || null;
    let hostname = null;
    try {
      const { stdout: statusOut } = await execFileP('tailscale', ['status', '--json'], { timeout: 2000 });
      const status = JSON.parse(statusOut);
      const fqdn = status?.Self?.DNSName || '';
      // DNSName comes back like "machine.tailnet-name.ts.net." — trim trailing dot.
      hostname = fqdn ? fqdn.replace(/\.$/, '') : (status?.Self?.HostName || null);
    } catch { /* status optional */ }
    return { ipv4, hostname };
  } catch {
    return null;
  }
}

// ── Centralised settings ─────────────────────────────────────────
// User preferences (prompts, names, saved connections with API keys,
// tomes settings, …) are stored on the server so opening Proto-Familiar
// on a second device doesn't reset everything. The frontend treats this
// as the source of truth on load and pushes updates back here on every
// change. localStorage on each client stays as a fast offline cache.
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const SETTINGS_MAX_BYTES = 2 * 1024 * 1024;  // 2 MB hard cap — way more than realistic

app.get('/api/settings', async (_req, res) => {
  try {
    const raw = await fsp.readFile(SETTINGS_FILE, 'utf8');
    return res.json({ settings: JSON.parse(raw) });
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ settings: null });
    return res.status(500).json({ error: `failed to read settings: ${err.message}` });
  }
});

// Read the user's preferred depth for the dynamic-thalamus injection
// (memories / graph / temporal go N positions from the end of the
// conversation as a separate system message, leaving the identity
// prefix on the system message stable for the upstream LLM's prefix
// cache). Bounded to a sensible range; falls back to 4 on any error.
//
// Function declaration so it's hoisted — the /api/chat handler defined
// earlier in the file references it before settings.json's path
// constant declares itself further down. Module-level execution is
// complete by the time HTTP requests arrive, so the SETTINGS_FILE
// const it reads is initialised at call time.
function getThalamusDynamicDepth() {
  try {
    const s = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    const d = parseInt(s.thalamusDynamicDepth, 10);
    if (Number.isFinite(d) && d >= 1 && d <= 50) return d;
  } catch { /* fall through to default */ }
  return 4;
}

// Pure helper. Insert `dynamicContent` as a system message `depth`
// positions from the end of `messages`, leaving the array stable
// above that point for the upstream LLM's prefix cache. Returns the
// new array plus the actual position used so the inspector can show
// where it landed.
//
// Two clamps:
//   - lower bound `1` if there's a system message at index 0 — keeps
//     the dynamic injection below the static prefix so the cache stays
//     valid. `0` when there's no system message anyway (no cache to
//     protect).
//   - upper bound `messages.length` — appended at the end when the
//     conversation is so short that `len - depth` would otherwise put
//     the dynamic block AFTER what would be the position-clamped index
//     (i.e. an empty messages array).
//
// No-op (returns messages unchanged + injectedAt=null) when
// dynamicContent is empty.
function injectDynamicAtDepth(messages, dynamicContent, depth) {
  if (!dynamicContent) return { messages, injectedAt: null };
  const hasSystemAtStart = messages.length > 0 && messages[0]?.role === 'system';
  const minIdx = hasSystemAtStart ? 1 : 0;
  const injectedAt = Math.max(minIdx, messages.length - depth);
  const dynamicMsg = { role: 'system', content: dynamicContent };
  return {
    messages: [
      ...messages.slice(0, injectedAt),
      dynamicMsg,
      ...messages.slice(injectedAt),
    ],
    injectedAt,
  };
}

// Resolve the fields entity-core actually cares about from a settings
// snapshot, so we can tell whether a settings PUT changed any of them.
// Anything else (UI prefs, system prompts, etc.) doesn't require an
// entity-core respawn and shouldn't trigger one.
function entityCoreCredsSnapshot(settings) {
  const id = settings?.entityCoreConnectionId ?? null;
  if (!id) return { id: null, apiKey: '', provider: '', model: '' };
  const conn = (settings.connections ?? []).find(c => c?.id === id);
  if (!conn) return { id, apiKey: '', provider: '', model: '' };
  return {
    id,
    apiKey:   conn.apiKey   ?? '',
    provider: conn.provider ?? '',
    model:    conn.model    ?? '',
  };
}
function entityCoreCredsEqual(a, b) {
  return a.id === b.id && a.apiKey === b.apiKey && a.provider === b.provider && a.model === b.model;
}

app.put('/api/settings', async (req, res) => {
  const { settings } = req.body ?? {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return badRequest(res, 'settings (object) is required');
  }
  let serialised;
  try { serialised = JSON.stringify(settings, null, 2); }
  catch (err) { return badRequest(res, `settings not serialisable: ${err.message}`); }
  if (serialised.length > SETTINGS_MAX_BYTES) {
    return badRequest(res, `settings exceed ${SETTINGS_MAX_BYTES}-byte limit`);
  }

  // L2 (audit): route the prior-snapshot + write through thalamus's
  // per-file lock so two PUTs racing each other can't read each
  // other's stale priorCreds and fire spurious entity-core respawns.
  // The atomic .tmp+rename already prevented torn-file states; the
  // lock here makes the prior-vs-next diff consistent against the
  // file each PUT actually replaces.
  let priorCreds = { id: null, apiKey: '', provider: '', model: '' };
  try {
    await withLock(SETTINGS_FILE, async () => {
      try {
        const raw = await fsp.readFile(SETTINGS_FILE, 'utf8');
        priorCreds = entityCoreCredsSnapshot(JSON.parse(raw));
      } catch { /* no prior settings — first write */ }
      const tmp = SETTINGS_FILE + '.tmp';
      await fsp.writeFile(tmp, serialised, 'utf8');
      await fsp.rename(tmp, SETTINGS_FILE);
    });
  } catch (err) {
    return res.status(500).json({ error: `failed to write settings: ${err.message}` });
  }

  // If the entity-core API-key designation changed (different connection
  // picked, or the same connection's key/provider/model edited), respawn
  // the child so it picks up the new env. Fire-and-forget so the PUT
  // returns quickly; reconnect logs itself.
  const nextCreds = entityCoreCredsSnapshot(settings);
  if (!entityCoreCredsEqual(priorCreds, nextCreds)) {
    console.log('[server] entity-core API-key designation changed — respawning');
    reconnectEntityCore().catch(err => console.error('[server] reconnectEntityCore failed:', err.message));
  }

  return res.json({ ok: true });
});

app.get('/api/tailscale', async (_req, res) => {
  const ts = await detectTailscale();
  res.json({
    enabled: tailscaleState.enabled,
    port: PORT,
    hostname: ts?.hostname || null,
    ipv4: ts?.ipv4 || null,
    available: ts !== null,
  });
});

app.post('/api/tailscale', async (req, res) => {
  const { enabled } = req.body ?? {};
  if (typeof enabled !== 'boolean') return badRequest(res, 'enabled (boolean) is required');
  tailscaleState.enabled = enabled;
  try { await saveTailscaleConfig(tailscaleState); }
  catch (err) { return res.status(500).json({ error: `failed to persist config: ${err.message}` }); }
  const ts = await detectTailscale();
  res.json({
    enabled: tailscaleState.enabled,
    port: PORT,
    hostname: ts?.hostname || null,
    ipv4: ts?.ipv4 || null,
    available: ts !== null,
  });
});

// ── Threat / care-check endpoints (step 4b) ─────────────────────────
// GET    /api/threat          current effective state
// GET    /api/threat/history  recent audit entries (newest first)
// POST   /api/threat/reset    manually zero the threat level
//
// These are user-facing controls: visibility into what's been
// recorded, and a one-click off switch beyond the env var. The
// detector itself can be disabled at the source by setting
// PROTO_FAMILIAR_THREAT_DISABLED=1.
app.get('/api/threat', async (_req, res) => {
  try { res.json(await getThreat()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/threat/history', async (req, res) => {
  const limit = Number.isFinite(+req.query.limit) ? +req.query.limit : 20;
  try { res.json({ history: await getThreatHistory({ limit }) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/threat/reset', async (_req, res) => {
  try {
    const r = await resetThreat({ source: 'api_reset' });
    console.log('[server] threat reset to 0 via /api/threat/reset');
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Temporal editor (M9) — read-mostly endpoints for the UI ─────────
// These wrap thalamus / threat / ponderings reads so the Temporal
// editor modal can show what the system is actually thinking and let
// the user reset / delete obviously-bad entries. CRUD beyond
// reset/delete is deferred to a later pass.
app.get('/api/temporal/interests', async (req, res) => {
  const limit = Number.isFinite(+req.query.limit) ? +req.query.limit : 50;
  try { res.json(await listInterests({ limit })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/temporal/bookmarks', async (req, res) => {
  const limit = Number.isFinite(+req.query.limit) ? +req.query.limit : 100;
  try { res.json(await listBookmarks({ limit })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/temporal/ponderings', async (req, res) => {
  const limit     = Number.isFinite(+req.query.limit)     ? +req.query.limit     : 25;
  const sinceDays = Number.isFinite(+req.query.sinceDays) ? +req.query.sinceDays : 365;
  try { res.json({ ponderings: await getRecentPonderings({ limit, sinceDays }) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/temporal/ponderings/:uid', async (req, res) => {
  try { res.json(await deletePondering({ uid: req.params.uid })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/ponderings/intents/acted-on — mark a deferred intent as filed.
// Called by the acknowledge_deferred_intent LLM tool after the Familiar
// has acted on the intent via save_to_tome / save_memory / update_identity,
// so it stops resurfacing in the deferred-intents block (Pillar B).
app.post('/api/ponderings/intents/acted-on', async (req, res) => {
  const { uid, index } = req.body;
  if (!isValidUUID(uid)) return res.status(400).json({ error: 'uid must be a valid UUID' });
  const idx = Number(index);
  if (!Number.isFinite(idx) || !Number.isInteger(idx) || idx < 0) {
    return res.status(400).json({ error: 'index must be a non-negative integer' });
  }
  try { res.json(await markIntentActedOn({ uid, index: idx })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Interest CRUD (manual edits from the Temporal editor)
app.post('/api/temporal/interests/bump', async (req, res) => {
  const { topic, delta, source } = req.body ?? {};
  if (!topic || typeof topic !== 'string') return badRequest(res, 'topic (string) is required');
  const d = Number(delta);
  if (!Number.isFinite(d) || d <= 0)        return badRequest(res, 'delta (positive number) is required');
  try { res.json(await bumpInterest({ topic, delta: d, source: source ?? 'manual' })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/temporal/interests/:id/demote', async (req, res) => {
  try { res.json(await demoteStanding({ id: req.params.id })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/temporal/interests/set-standing', async (req, res) => {
  const { topic, weight, value_ref } = req.body ?? {};
  if (!topic || typeof topic !== 'string') return badRequest(res, 'topic (string) is required');
  try { res.json(await setStandingInterest({ topic, weight, value_ref })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Schedule
app.get('/api/temporal/schedule', async (req, res) => {
  const from_ts = req.query.from || undefined;
  const to_ts   = req.query.to   || undefined;
  const limit   = Number.isFinite(+req.query.limit) ? +req.query.limit : 200;
  try {
    // Standard window — picks up anchor-in-window items only.
    const win = await getScheduleWindow({ from_ts, to_ts, limit });
    const nodes = Array.isArray(win) ? win : (Array.isArray(win?.nodes) ? win.nodes : []);

    // Also fetch recurring anchors (their stored when_ts is often
    // months in the past) and expand them within the requested
    // window. Drop anchor IDs that would have shown up in the raw
    // window so we don't render both "the anchor from 6mo ago" AND
    // "today's occurrence."
    const fromMs = from_ts ? new Date(from_ts).getTime() : Date.now() - 24 * 3600_000;
    const toMs   = to_ts   ? new Date(to_ts).getTime()   : Date.now() + 7 * 24 * 3600_000;
    let recurNodes = [];
    try {
      const recurResp = await listRecurring();
      recurNodes = Array.isArray(recurResp?.nodes) ? recurResp.nodes : [];
    } catch { /* tolerate Unruh hiccup */ }

    if (recurNodes.length > 0) {
      const anchorIds = new Set(recurNodes.map(n => n.id));
      const expanded = expandWindow(recurNodes, fromMs, toMs);
      const filtered = nodes.filter(n => !anchorIds.has(n?.id));
      const mergedNodes = [...filtered, ...expanded];
      res.json({ ...(typeof win === 'object' && !Array.isArray(win) ? win : {}), nodes: mergedNodes });
      return;
    }
    res.json(win);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/temporal/schedule', async (req, res) => {
  const { type, label, when, end, payload } = req.body ?? {};
  if (!type  || typeof type  !== 'string') return badRequest(res, 'type (string) is required');
  if (!label || typeof label !== 'string') return badRequest(res, 'label (string) is required');
  try { res.json(await addScheduleNode({ type, label, when, end, payload })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/temporal/schedule/:id', async (req, res) => {
  const { label, when, end, payload } = req.body ?? {};
  try { res.json(await updateScheduleNode({ id: req.params.id, label, when, end, payload })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/temporal/schedule/:id/resolve', async (req, res) => {
  const { resolution } = req.body ?? {};
  if (!resolution || typeof resolution !== 'string') return badRequest(res, 'resolution (string) is required');
  try { res.json(await resolveScheduleNode({ id: req.params.id, resolution })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Per-occurrence resolve — for recurring nodes, marks ONE occurrence
// done/cancelled/carried_forward without killing the rest of the
// series. The expander reads payload.resolutions and skips the
// resolved dates.
app.post('/api/temporal/schedule/:id/resolve_occurrence', async (req, res) => {
  const { occurrence_date, resolution } = req.body ?? {};
  if (!occurrence_date || typeof occurrence_date !== 'string') return badRequest(res, 'occurrence_date (YYYY-MM-DD) is required');
  if (!resolution || typeof resolution !== 'string') return badRequest(res, 'resolution (string) is required');
  try { res.json(await resolveScheduleOccurrence({ id: req.params.id, occurrence_date, resolution })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/temporal/schedule/:id', async (req, res) => {
  try { res.json(await deleteScheduleNode({ id: req.params.id })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Phases (Routine tab) — date-independent; schedule_get_window's
// time filter misses phases stamped on previous calendar days.
app.get('/api/temporal/phases', async (req, res) => {
  const includeResolved = req.query.includeResolved === '1' || req.query.includeResolved === 'true';
  const limit = Number.isFinite(+req.query.limit) ? +req.query.limit : 200;
  try { res.json(await listPhases({ includeResolved, limit })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Handoff
app.get('/api/temporal/handoff', async (_req, res) => {
  try { res.json(await getHandoff({ include_consumed: true })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/temporal/handoff/:id/consume', async (req, res) => {
  try { res.json(await markHandoffConsumed({ id: req.params.id })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Reminders health (M11)
app.get('/api/temporal/reminders/health', async (_req, res) => {
  try { res.json(await getRemindersHealth()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Outbox (M11/M12 delivery surface)
app.get('/api/outbox', async (req, res) => {
  const pendingOnly = req.query.pending !== '0' && req.query.pending !== 'false';
  const limit = Number.isFinite(+req.query.limit) ? +req.query.limit : 50;
  try { res.json({ items: await listOutbox({ pendingOnly, limit }) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/outbox/:id/acknowledge', async (req, res) => {
  try { res.json(await acknowledgeOutbox({ id: req.params.id })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/outbox/clear-acknowledged', async (_req, res) => {
  try { res.json(await clearAcknowledged()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Crisis outreach (tool-initiated, live conversation) ──────────────────────

// POST /api/contact-trusted-person
// Called by the contact_trusted_person tool when the Familiar judges that
// human presence is needed during an active conversation. Looks up the
// contact by name, delivers immediately (not deferred), and always enqueues
// an outbound_alert outbox item so the user sees exactly what was sent.
app.post('/api/contact-trusted-person', async (req, res) => {
  const { name, message } = req.body ?? {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ ok: false, error: 'name is required' });
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ ok: false, error: 'message is required' });
  }
  if (message.trim().length > 1000) {
    return res.status(400).json({ ok: false, error: 'message too long (max 1000 characters)' });
  }
  const s = readSettingsSync();
  const contact = (s?.trustedContacts || []).find(c => c.name === name.trim());
  if (!contact) {
    return res.status(404).json({ ok: false, error: `No trusted contact named "${name.trim()}" is configured.` });
  }
  try {
    const result = await deliverToTrustedContact({
      name:    contact.name,
      message: message.trim(),
      channel: contact.channel ?? 'discord',
    });
    res.json({ ok: result.ok, channel: contact.channel ?? 'discord', error: result.error ?? null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/crisis-resources
// Called by the show_crisis_resources tool. Enqueues a crisis-resources
// outbox banner containing international hotline information. Deduped to
// one item per hour so repeated model calls during a single crisis don't
// flood the banner queue.
app.post('/api/crisis-resources', async (_req, res) => {
  try {
    const result = await enqueueOutbox({
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
    res.json({ ok: true, id: result.id, deduped: result.deduped ?? false });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Start the MCP children (entity-core + Unruh) at server boot rather
// than as a thalamus.js import side-effect. Tests and other importers
// of thalamus's coordination helpers (withLock, modifyTomeFile, etc.)
// don't need — and shouldn't trigger — Deno/Python spawning just to
// get the lock primitive.
startThalamus();

const httpServer = app.listen(PORT, HOST, async () => {
  const lines = ['', `Proto-Familiar ${PKG_VERSION} running at:`];
  lines.push(`  http://localhost:${PORT}`);
  if (tailscaleState.enabled) {
    const ts = await detectTailscale();
    if (ts?.hostname) lines.push(`  http://${ts.hostname}:${PORT}    (Tailscale)`);
    if (ts?.ipv4)     lines.push(`  http://${ts.ipv4}:${PORT}    (Tailscale IPv4)`);
    if (!ts) lines.push(`  (other devices: use this machine's LAN/Tailscale address on port ${PORT})`);
    lines.push('  External-device access is ENABLED. Toggle off in the top bar to lock back down.');
  } else {
    lines.push('  External-device access is disabled. Toggle the Tailscale icon in the top bar to enable.');
  }
  console.log(lines.join('\n') + '\n');
  if (process.env.PROTO_FAMILIAR_THREAT_DISABLED === '1') {
    console.log('[threat] crisis-signal detection is DISABLED by env var (PROTO_FAMILIAR_THREAT_DISABLED=1).');
  } else {
    console.log('[threat] crisis-signal detection ACTIVE in chat path. Each fire is logged as "[threat] scored ±N on chat msg [signal,...]". Hard-disable with PROTO_FAMILIAR_THREAT_DISABLED=1.');
  }
  startMemorizationWorker();
  startAutonomousPondering();
  startRemindersScheduler();
  startSilenceTriage();
});

// ── Autonomous pondering loop (step 4a) ─────────────────────────────
// Default-ON. The loop ticks every minute and on each tick:
//   1. Re-reads settings.json (so toggles + scale take effect within
//      a minute, no restart needed).
//   2. Gates on ponderingEnabled + a valid primary connection. Either
//      missing → silent skip ('disabled').
//   3. Reads live interest weights from Unruh and current threat from
//      the local threat tracker.
//   4. Picks one interest (weight-proportional), ponders it via
//      ponderOnce — writes a real, timestamped tome entry.
//
// Tuning:
//   - User can toggle off in Settings or set PROTO_FAMILIAR_PONDERING_
//     DISABLED=1 (env var, hard override).
//   - User can stretch intervals via Settings → Pondering interval
//     scale (1×-10×).
//   - Cadence base tiers are in pondering-cadence.js (30 min to 6 hr).
//   - Threat tier multipliers (calm 1.0× → severe 0.15×) and the
//     user scale are both applied.
function readSettingsSync() {
  try { return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return {}; }
}
function primaryConnectionFrom(settings) {
  const id    = settings?.primaryConnectionId;
  const conns = Array.isArray(settings?.connections) ? settings.connections : [];
  return conns.find(c => c?.id === id) ?? null;
}

function startAutonomousPondering() {
  if (process.env.PROTO_FAMILIAR_PONDERING_DISABLED === '1') {
    console.log('[pondering] PROTO_FAMILIAR_PONDERING_DISABLED=1 — autonomous loop is OFF');
    return;
  }
  startPonderingLoop({
    tickMs: 60_000,
    isEnabled: async () => {
      const s = readSettingsSync();
      if (s.ponderingEnabled === false) return false;
      const conn = primaryConnectionFrom(s);
      return !!(conn?.apiKey && conn?.provider && conn?.model);
    },
    getIntervalScale: async () => {
      const s = readSettingsSync();
      const v = Number(s?.ponderingIntervalScale);
      return Number.isFinite(v) && v >= 1 ? v : 1;
    },
    getInterests: () => listLiveInterests({ limit: 20 }),
    getThreat:    async () => (await getThreat()).weight,
    // Reflection-mode trigger — when 5+ tagged surface outcomes have
    // accumulated since the last reflection, this tick reflects on
    // them instead of pondering an interest. Same LLM call, different
    // input shape; the result still writes to the ponderings tome,
    // and if the LLM lifted a pattern to identity-layer confidence
    // an additional updateIdentitySection() lands.
    shouldReflect: async () => shouldReflectNow(),
    getReflectionInput: async () => {
      const outcomes = await getNewOutcomesSinceLastReflection();
      const id = await getIdentityAll().catch(() => ({}));
      const file = (id?.custom ?? []).find(f => f.filename === 'what_lapses_cost.md');
      const existingNotes = file?.content ?? '';
      // Project events down to the fields reflection actually needs.
      // Keeps the prompt tight and stops drifting state-snapshot
      // additions from blowing up token cost.
      const projected = outcomes.map(e => ({
        task_label:     e.task_label,
        stakes_tier:    e.stakes_tier,
        confidence:     e.confidence,
        offered_at:     e.offered_at,
        outcome:        e.outcome,
        outcome_at:     e.outcome_at,
        state_snapshot: e.state_snapshot,
      }));
      return { mode: 'reflection', outcomes: projected, existingNotes };
    },
    runPonder: async (topic /* string OR { mode:'reflection', ... } */) => {
      const s    = readSettingsSync();
      const conn = primaryConnectionFrom(s);
      if (!conn?.apiKey) throw new Error('no primary connection configured');
      const result = await ponderOnce({
        topic,
        provider: conn.provider,
        apiKey:   conn.apiKey,
        model:    conn.model,
      });
      // Reflection follow-through: if the LLM proposed an
      // identity-layer update, write it. Mark the reflection so
      // future shouldReflectNow() calls measure freshness from
      // here. Both fire-and-forget — pondering tome write already
      // succeeded, so reflection counts as "done" regardless.
      if (result?.mode === 'reflection') {
        markReflected()
          .catch(err => console.error('[pondering] markReflected failed:', err?.message ?? err));
        const upd = result.what_lapses_cost_update;
        if (upd?.heading && upd?.content) {
          updateIdentitySection({
            category: 'custom',
            filename: 'what_lapses_cost.md',
            heading:  upd.heading,
            content:  upd.content,
          })
            .then(r => console.log(`[pondering] reflection → ${r.ok ? 'wrote' : 'failed to write'} ${upd.heading} to what_lapses_cost.md`))
            .catch(err => console.error('[pondering] what_lapses_cost write failed:', err?.message ?? err));
        }
      }
      return result;
    },
    onTick: (r) => {
      if (!r.acted) return;
      if (r.mode === 'reflection') {
        console.log(`[pondering] reflection → "${r.result.title}"${r.result.what_lapses_cost_update ? ' (proposed identity-layer update)' : ''}`);
      } else {
        console.log(`[pondering] "${r.picked.label}" (weight ${r.picked.weight?.toFixed?.(2) ?? r.picked.weight}, threat ${r.threatLevel?.toFixed?.(2) ?? r.threatLevel}, scale ${r.scale}×) → "${r.result.title}"`);
      }
    },
    onError: (err) => console.error('[pondering]', err?.message ?? err),
  });
  console.log('[pondering] Autonomous pondering ENABLED (default). Toggle in Settings → Sidebar → Autonomous pondering; scale intervals via Pondering interval scale; hard-disable with PROTO_FAMILIAR_PONDERING_DISABLED=1.');
}

// ── Reminders scheduler (M11) ────────────────────────────────────
// Polls every 30s for due reminders, enqueues them into the outbox,
// marks the schedule node 'fired'. Designed to retry on partial
// failure (the outbox dedups, so re-firing the same reminder twice
// doesn't double-banner). Health-watch surfaces if `overdue` keeps
// growing across ticks — loud, not silent.
function startRemindersScheduler() {
  if (process.env.PROTO_FAMILIAR_REMINDERS_DISABLED === '1') {
    console.log('[reminders] PROTO_FAMILIAR_REMINDERS_DISABLED=1 — scheduler is OFF');
    return;
  }
  startRemindersLoop({
    tickMs: 30_000,
    getDueReminders: async () => {
      const r = await getDueReminders({ limit: 50 });
      return Array.isArray(r.reminders) ? r.reminders : [];
    },
    fireReminder: async ({ id }) => {
      const r = await resolveScheduleNode({ id, resolution: 'fired' });
      if (!r.ok) throw new Error(r.error || 'resolve failed');
    },
    getHealth: getRemindersHealth,
    onTick: (r) => {
      for (const f of r.fired || []) console.log(`[reminders] fired "${f.label}" (id ${f.id.slice(0, 8)})`);
      for (const s of r.skipped || []) console.warn(`[reminders] skipped "${s.label}": ${s.error}`);
    },
    onError: (err) => console.error('[reminders]', err?.message ?? err),
  });
  console.log('[reminders] Scheduler ENABLED. Hard-disable with PROTO_FAMILIAR_REMINDERS_DISABLED=1.');
}

// ── Silence-triage loop (M12b) ──────────────────────────────────
// Every 5 min, asks: "user is quiet AND threat is elevated — should
// I gently reach out?" The DECISION is an LLM call (per design doc:
// "not a threshold check"). Conservative thresholds (severe=15min,
// high=1hr, moderate=4hr; calm/mild never trigger). Outbox dedup on
// `triage-<tier>-<4h-bucket>` rate-limits the same-tier banner to
// once per 4-hour window while still unacknowledged.

// Persistent log for all triage decisions — survives outbox acknowledgement
// so past reach-outs are always visible for debugging and review.
const TRIAGE_LOG_FILE = path.join(LOGS_DIR, 'triage-events.jsonl');
async function appendTriageEventLog(entry) {
  try {
    await fsp.appendFile(
      TRIAGE_LOG_FILE,
      JSON.stringify({ ...entry, loggedAt: new Date().toISOString() }) + '\n',
      'utf8',
    );
  } catch { /* non-critical */ }
}

// Read the last N user/assistant messages from the most recently updated
// session log file. Used by decideTriageViaLLM to ground the triage
// prompt in what was actually being discussed before the silence.
async function getRecentSessionMessages({ limit = 8 } = {}) {
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

// How long after the user-facing outbox item lands to wait before
// escalating to a trusted contact, if the user hasn't acknowledged.
// The user has this window to respond; if they do, the contact is
// never reached. Only applies when the LLM's decision includes contactHuman.
const CONTACT_ESCALATION_DELAY_MS = Object.freeze({
  severe:   30 * 60_000,        // 30 minutes
  high:      2 * 60 * 60_000,  // 2 hours
  moderate:  6 * 60 * 60_000,  // 6 hours
});

async function decideTriageViaLLM({ threat, silenceMs, signals }) {
  const s = readSettingsSync();
  const conn = primaryConnectionFrom(s);
  if (!conn?.apiKey) return { action: 'wait' };

  const url = PROVIDER_URLS[conn.provider];
  if (!url) return { action: 'wait' };

  const minutes  = Math.round(silenceMs / 60_000);
  const contacts = Array.isArray(s?.trustedContacts) ? s.trustedContacts : [];

  // Pull identity context (who the Familiar is, who the user is) and the
  // recent conversation log in parallel. Both degrade gracefully to empty.
  const [{ static: identityContext }, recentMessages] = await Promise.all([
    enrich('', { staticOnly: true }).catch(() => ({ static: '' })),
    getRecentSessionMessages({ limit: 8 }),
  ]);

  const signalsBlock = signals?.length
    ? `\nRecent signals that raised the threat level:\n${signals.map(sig => {
        const t   = sig.ts ? new Date(sig.ts).toLocaleString() : 'unknown time';
        const ids = Array.isArray(sig.signals) ? sig.signals.join(', ') : 'unknown';
        return `  - [${t}] ${ids} (delta ${Number(sig.delta) >= 0 ? '+' : ''}${sig.delta})`;
      }).join('\n')}`
    : '';

  const sessionBlock = recentMessages.length
    ? `\nRecent conversation (what we were discussing before the silence):\n${recentMessages.map(m => {
        const text = typeof m.content === 'string'
          ? m.content
          : (Array.isArray(m.content) ? (m.content.find(c => c.type === 'text')?.text ?? '') : '');
        return `  [${m.role === 'user' ? 'User' : 'Me'}]: ${text.slice(0, 400)}`;
      }).join('\n')}`
    : '\nNo recent conversation on record.';

  const contactsBlock = contacts.length
    ? `\nTrusted contacts configured (people I could alert if the situation warrants human presence):\n${contacts.map(c => `  - ${c.name} (via ${c.channel ?? 'discord'})`).join('\n')}\n\nContacting one of these is a meaningful escalation — appropriate when I judge this needs more than I can provide alone. If I include contactHuman, that message will be delivered to that person AND shown in my human's chat. Nothing is covert.`
    : '';

  // Care-driven surface: if I'm already deliberating about whether
  // to reach out, an open task I could touch on (if it fits the
  // moment) might be the right doorway. Pull eligible candidates
  // from the same pipeline the chat-turn block uses, but with
  // triage's current state. The LLM still decides — these are
  // candidates, not directives. Empty block if nothing's eligible.
  let candidateTasksBlock = '';
  try {
    const { selectSurfaceCandidates } = await import('./surface-context.js');
    const { getRecentOfferTimes }     = await import('./surface-events.js');
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
      const surfacingHistory = await getRecentOfferTimes();
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
        candidateTasksBlock = `\nOpen tasks I could touch on if it fits this reach-out (NOT a list I should mention — only if one of these genuinely opens a door to {{user}} right now):\n${lines}`;
      }
    }
  } catch (err) {
    console.error('[triage] candidate tasks lookup failed:', err?.message ?? err);
  }

  const prompt = `--- TRIAGE DELIBERATION ---

I am in a background moment of deliberation. My human has been silent and my care concern is elevated. I need to decide whether to reach out to them right now.

What I know:
- Threat tier: ${threat.tier} (accumulated weight: ${threat.weight?.toFixed?.(2) ?? threat.weight}) - this number increases when my human says concerning phrases in our conversation
- my human has been silent for ${minutes} minutes (this has already passed the threshold for this tier) - I should check the conversation to see if my human told me what they're doing or have just silently disappeared and perhaps withdrawn
${signalsBlock}
${sessionBlock}
${contactsBlock}
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

  const llmMessages = [];
  if (identityContext) llmMessages.push({ role: 'system', content: identityContext });
  llmMessages.push({ role: 'user', content: prompt });

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
    // if the user has not acknowledged the item. This is enforced by storing
    // pendingContact + contactDeadlineTs as meta on the outbox item; the
    // checkAndFirePendingContacts check in each triage tick handles delivery.
    const ch = parsed.contactHuman;
    if (ch && typeof ch.name === 'string' && typeof ch.message === 'string' && ch.message.trim()) {
      const match = contacts.find(c => c.name === ch.name);
      if (match) {
        const delayMs = CONTACT_ESCALATION_DELAY_MS[threat.tier] ?? CONTACT_ESCALATION_DELAY_MS.moderate;
        out.meta = {
          pendingContact: {
            name:    ch.name,
            message: ch.message.trim(),
            channel: match.channel ?? 'discord',
          },
          contactDeadlineTs: Date.now() + delayMs,
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

/**
 * Deliver a message to a trusted contact via their configured channel.
 * Currently supports Discord webhooks. Every outbound is ALSO enqueued
 * into the user's outbox as kind='outbound_alert' so the user sees
 * exactly what was sent and to whom. "No covert contact" is enforced
 * here, not by trusting the caller.
 */
async function deliverToTrustedContact({ name, message, channel }) {
  const s = readSettingsSync();
  const contact = (s?.trustedContacts || []).find(c => c.name === name && (c.channel ?? 'discord') === channel);
  if (!contact) return { ok: false, error: 'contact_not_found' };
  let delivered = false, deliveryError = null;
  try {
    if (channel === 'discord') {
      const resp = await fetch(contact.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `**(message from your friend's Familiar — proactive check-in)**\n\n${message}`,
          allowed_mentions: { parse: [] },
        }),
      });
      if (!resp.ok) {
        deliveryError = `discord ${resp.status}: ${(await resp.text()).slice(0, 200)}`;
      } else {
        delivered = true;
      }
    } else {
      deliveryError = `unsupported channel: ${channel}`;
    }
  } catch (err) {
    deliveryError = err?.message ?? String(err);
  }
  // ALWAYS log to the outbox — even on delivery failure the user
  // should see that the attempt happened.
  await enqueueOutbox({
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
async function checkAndFirePendingContacts() {
  const now = Date.now();
  try {
    const items   = await listOutbox({ pendingOnly: true, limit: 100 });
    const expired = items.filter(i =>
      i.kind === 'triage' &&
      i.pendingContact &&
      !i.pendingContact.delivered &&
      typeof i.contactDeadlineTs === 'number' &&
      now >= i.contactDeadlineTs,
    );
    for (const item of expired) {
      // Mark delivered before async call to prevent a second tick from
      // double-firing while delivery is in flight.
      await updateOutboxMeta({
        id:   item.id,
        meta: {
          pendingContact: { ...item.pendingContact, delivered: true, deliveredAt: new Date().toISOString() },
        },
      });
      const { name, message, channel } = item.pendingContact;
      deliverToTrustedContact({ name, message, channel }).then(d => {
        if (d.ok) console.log(`[triage] deferred contact ${name} via ${channel}: delivered`);
        else      console.warn(`[triage] deferred contact ${name} via ${channel}: ${d.error}`);
      }).catch(err => console.error('[triage] deferred contact failed:', err?.message ?? err));
    }
  } catch (err) {
    console.error('[triage] checkAndFirePendingContacts error:', err?.message ?? err);
  }
}

function startSilenceTriage() {
  if (process.env.PROTO_FAMILIAR_TRIAGE_DISABLED === '1') {
    console.log('[triage] PROTO_FAMILIAR_TRIAGE_DISABLED=1 — silence triage is OFF');
    return;
  }
  startSilenceTriageLoop({
    tickMs: 5 * 60_000,
    getThreat:       getThreat,
    getLastActivity: getLastUserActivity,
    getRecentSignals: async () => {
      try { return await getThreatHistory({ limit: 5 }); } catch { return []; }
    },
    decideTriage:    decideTriageViaLLM,
    enqueueOutboxFn: enqueueOutbox,
    onTick: (r) => {
      // Persist every triage decision to the event log for debugging/auditing.
      appendTriageEventLog({
        threat:    r.threat ?? null,
        silenceMs: r.silenceMs ?? null,
        reason:    r.reason,
        decision:  r.decision ?? null,
        acted:     r.acted ?? false,
        at:        r.at,
      }).catch(() => {}); // non-critical

      if (r.acted)                            console.log(`[triage] reached out: "${r.decision?.message?.slice(0, 80)}…"`);
      else if (r.reason === 'reached_out')    console.log('[triage] reached out (dedup unexpected)');
      else if (r.reason === 'llm_said_wait')  console.log(`[triage] tick — threat ${r.threat?.tier}, silence ${Math.round((r.silenceMs||0)/60_000)}min, LLM said wait`);
      // Other (low_threat / too_recent / no_activity) are silent.

      // M12c: check whether any pending trusted-contact escalations have
      // timed out without the user acknowledging the triage item.
      // Contact is DEFERRED — the user gets a window to respond first.
      // deliverToTrustedContact fires only after contactDeadlineTs passes.
      checkAndFirePendingContacts().catch(err =>
        console.error('[triage] checkAndFirePendingContacts failed:', err?.message ?? err),
      );
    },
    onError: (err) => console.error('[triage]', err?.message ?? err),
  });
  console.log(`[triage] Silence triage ENABLED. Thresholds: severe=${TRIAGE_SILENCE_THRESHOLD_MS.severe/60_000}min, high=${TRIAGE_SILENCE_THRESHOLD_MS.high/60_000}min, moderate=${TRIAGE_SILENCE_THRESHOLD_MS.moderate/60_000}min. Hard-disable with PROTO_FAMILIAR_TRIAGE_DISABLED=1.`);
}

// Graceful shutdown — fires on SIGTERM (stop.sh / stop.bat / docker
// stop), SIGINT (Ctrl-C), and SIGHUP (terminal closes). Without this,
// the memorization setIntervals would keep the event loop alive past
// httpServer.close(), and the MCP children (entity-core, Unruh) would
// be left to die from stdin EOF — which works on Unix but can be slow
// on Windows. With this handler:
//   1. Stop accepting new HTTP connections.
//   2. Stop the memorization tick + prune intervals.
//   3. Close the Unruh MCP client (its onclose-reconnect is suppressed
//      via the unruhShuttingDown flag inside shutdownUnruh).
//   4. process.exit(0) with a fallback timer in case anything hangs.
let _shuttingDown = false;
async function handleSignal(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`\n[server] ${signal} received — shutting down…`);
  // Hard-exit safety net: never let a stuck handle keep the process
  // alive past this window. SIGKILL-equivalent if anything misbehaves.
  setTimeout(() => {
    console.error('[server] graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 5000).unref();
  try { httpServer.close(); } catch { /* already closed */ }
  try { await stopMemorizationWorker(); } catch { /* already stopped */ }
  try { await stopPonderingLoop(); } catch { /* already stopped */ }
  try { await stopRemindersLoop(); } catch { /* already stopped */ }
  try { await stopSilenceTriageLoop(); } catch { /* already stopped */ }
  try { shutdownEntityCore(); } catch { /* already disconnected */ }
  try { shutdownUnruh(); } catch { /* already disconnected */ }
  // Give the close handshakes a tiny window, then exit.
  setTimeout(() => process.exit(0), 250).unref();
}
process.on('SIGTERM', () => handleSignal('SIGTERM'));
process.on('SIGINT',  () => handleSignal('SIGINT'));
process.on('SIGHUP',  () => handleSignal('SIGHUP'));
