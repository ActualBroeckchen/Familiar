/**
 * Proto-Familiar — lightweight LLM frontend server
 * Proxies chat requests to z.ai and NanoGPT, avoiding CORS issues.
 * Requires Node.js 18+ (uses built-in fetch).
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, readFileSync, promises as fsp } from 'fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'crypto';
import { sessionSlugId } from './slug-ids.js';
import { execFile } from 'child_process';
import { checkForUpdate, applyUpdate, updateDisabled } from './updater.js';
import { promisify } from 'util';

const execFileP = promisify(execFile);
import {
  startThalamus,
  enrich, createMemory, appendIdentity, updateIdentitySection,
  // Reads for the Knowledge editor UI
  listMemories, readMemory, readMemoryById, getIdentityAll, listGraphNodes, searchGraphNodes, getGraphSubgraph, getFullGraph,
  listSnapshots,
  // Writes (each auto-snapshots before the destructive op)
  updateMemory, deleteMemory, updateMemoryById, deleteMemoryById, moveMemoryDate, rewriteIdentitySection,
  updateGraphNode, deleteGraphNode, updateGraphEdge, deleteGraphEdge,
  createGraphNode, createGraphEdge,
  createSnapshot, restoreSnapshot,
  exportBackup, restoreBackup, runLifecyclePass,
  getRememberMap, setRememberMap,
  getStandingConsent, setStandingConsent,
  getMemoryHealth, backfillMemoryEmbeddings, getMemoryGranularityAudit,
  remapCategoryAudiences, backfillContentTags,
  searchMemory,
  reconnectPhylactery,
  recordInterest, recordHandoff, listLiveInterests, listInterests,
  bumpInterest, demoteStanding, setStandingInterest,
  getScheduleWindow, addScheduleNode, updateScheduleNode,
  resolveScheduleNode, resolveScheduleOccurrence, deleteScheduleNode,
  addScheduleEdge, updateScheduleEdge, deleteScheduleEdge, listPhases, listRecurring,
  exportSchedule,
  getHandoff, markHandoffConsumed,
  getDueReminders, getRemindersHealth, markEventAlerted, stampElapsedEvents,
  ingestGcal,
  shutdownUnruh, shutdownPhylactery, markPeersShuttingDown,
  reportSurfacingOutcomes, listBookmarks,
  memByTimerange, getRecentMemoryLines,
  setIntention, roundsForWard, listIntentions, getDueIntentions,
} from './thalamus.js';
import { scoreMessage } from './crisis-signals.js';
import { foldReasoningIntoContent } from './llm-call.js';
import { recordThreat, resetThreat, getThreat, getThreatHistory } from './threat-tracker.js';
import { ponderOnce } from './pondering.js';
import { startPonderingLoop, stopPonderingLoop } from './pondering-loop.js';
import { startNoticingLoop, stopNoticingLoop, resetNoticingCooldown } from './noticing-loop.js';
import { buildNoticingPrompt, AGING_INTENT_MS, AGING_TASK_MS, OVERDUE_EVENT_GRACE_MS } from './noticing.js';
import { getContactBaseline, weekdayClass } from './contact-baselines.js';
import { getWaitStreak, recordWait, recordProactive } from './wait-streak.js';
import {
  addLocation, listLocations, getCurrentLocation, setCurrentLocation, deleteLocation,
  weatherLocationsPrivate, ingestWeather, readWeather,
} from './thalamus.js';
import { geocode, fetchForecast } from './weather-source.js';
import { readWeatherNowLine, readWeatherVagueLine, readWeatherMirrorSync, writeWeatherMirror, clearWeatherMirror } from './weather-mirror.js';
import { WEATHER_STALE_MS } from './weather-format.js';
import { selectReadiness } from './stewardship.js';
import {
  shouldReflectNow,
  getNewOutcomesSinceLastReflection,
  markReflected,
  tagRaisedOutcomes,
} from './surface-events.js';
import { getRecentPonderings, deletePondering, markIntentActedOn, getUnactedIntents } from './recent-ponderings.js';
import { startRemindersLoop, stopRemindersLoop } from './reminders-loop.js';
import {
  selectDueEventAlerts, formatEventAlert, alertWindowBounds,
  selectDueWeatherAlerts, formatWeatherAlert,
  clampLeadMinutes, clampElapsedStampHours, ALERT_GRACE_MS, MAX_LEAD_MS,
} from './event-alerts.js';
import { startGcalSyncLoop, stopGcalSyncLoop, resetGcalSyncCadence } from './gcal-sync-loop.js';
import { recordSyncOutcome, readSyncStatus } from './gcal-sync-status.js';
import { fetchIcal, fetchViaCli, cliPresetHint } from './gcal-source.js';
import {
  parseCredentials, buildAuthUrl, exchangeCode,
  readToken as readGoogleToken, writeToken as writeGoogleToken,
  clearToken as clearGoogleToken, publicStatus as googlePublicStatus,
  getFreshAccessToken, listEvents as listGoogleEvents,
  listCalendars as listGoogleCalendars, hasCalendarListScope,
  normalizeGoogleEvents, isConnected as googleConnected,
} from './gcal-google.js';
import {
  resolveAttribution, isIgnored, wardCalendarId,
  writeCalendarCache, readCalendarCache, normalizeAttributionEntry,
} from './gcal-attribution.js';
import { listOutbox, acknowledgeOutbox, clearAcknowledged } from './outbox.js';
import { startSilenceTriageLoop, stopSilenceTriageLoop, DEFAULT_RECHECK_MS } from './silence-triage-loop.js';
import { startReachoutLoop, stopReachoutLoop, reachoutBucketOriginId } from './reachout-loop.js';
import { startMemorySweepLoop, stopMemorySweepLoop } from './memory-sweep-loop.js';
import { startTomeGraduationLoop, stopTomeGraduationLoop } from './tome-graduation-loop.js';
import { startContentRegateLoop, stopContentRegateLoop } from './content-regate-loop.js';
import { startNeedsTrackingLoop, stopNeedsTrackingLoop } from './needs-tracking-loop.js';
import { isNeedWindow } from './needs-tracking.js';
import { decideReachoutViaLLM, getWarmVillagers } from './reachout.js';
import { recordReachOut } from './reach-out-log.js';
import { appendReflectionEvent, readReflectionEvents } from './reflection-events.js';
import { recordUserActivity, getLastUserActivity } from './last-activity.js';
import { buildTimeAnchorBlock, wardLocalNowISO, plainInterval } from './relative-time.js';
// Cerebellum is the motor module — the outbound counterpart to thalamus.
// Triage deliberation, trusted-contact delivery, and escalation deadlines
// live there; server.js keeps only route handling and loop boot.
import {
  readSettingsSync, primaryConnectionFrom, connectionForFeature,
  getRecentSessionMessages, formatRecentMessagesForContext,
  decideTriageViaLLM, deliverToTrustedContact, checkAndFirePendingContacts,
  appendTriageEventLog, readTriageEvents,
  appendReachoutEventLog, readReachoutEvents,
  appendNoticingEventLog, readNoticingEvents, composeNoticingTools,
  registerPushAdapterFactory, formatItemForPush,
  // Tool dispatch — the registry + executors live in cerebellum; the
  // multi-round loop runs inside /api/chat below.
  composeActiveTools, executeToolCall, MAX_TOOL_ROUNDS, toolRoundsPerTurn,
  initCerebellumTools, enqueueCrisisResources, runToolCallLoop,
  VALID_MEMORY_GRANULARITIES, VALID_IDENTITY_CATEGORIES, VALID_FILENAME_RE,
  deriveMemorySlug, parseMemoryKey,
  // Channel adapters — enqueueAndDispatch pushes every user-facing
  // outbox item to the configured push channels (e.g. the human's own
  // Discord webhook) and records per-channel delivery state.
  enqueueAndDispatch, formatDeliveryNote, activePushAdapters,
} from './cerebellum.js';
import { expandWindow } from './recurrence.js';
import { selectModules, explainSelection, stickyModulesFor, tickSticky, TOOL_MODULES } from './tool-surfacing.js';
import { readStewardshipState, recordRoutineReview } from './stewardship.js';
import { buildNeedsLedger, isRoutineReviewDue, buildRoutineReviewSection, routineReviewHardDisabled } from './routine-review.js';
import {
  enqueueMemorization,
  enqueueSessionByDay,
  listJobs as listMemorizationJobs,
  acknowledgeJob as acknowledgeMemorizationJob,
  cancelJob as cancelMemorizationJob,
  startMemorizationWorker, stopMemorizationWorker,
  findOrCreateSessionMemoriesTome,
} from './memorization.js';
import { computeCoverage, collectDateSlices } from './memory-coverage.js';
import { parseImport, dateFromFilename, applyFallbackDate } from './log-import.js';
import { segmentByDay } from './day-segments.js';
import {
  getRegistry as getVillageRegistry,
  upsertCategory as upsertVillageCategory, deleteCategory as deleteVillageCategory,
  upsertVillager, deleteVillager,
  upsertLocation as upsertVillageLocation, deleteLocation as deleteVillageLocation,
  migrateTrustedContacts, seedDefaultCategories,
  initVillageSync, bootSync as villageBootSync,
  pendingCategoryAudienceRemap,
} from './village.js';
import { resolveAudience, audienceTagFor, visibleAudiences, topicGrantsForRoom, WARD_PRIVATE } from './audience.js';
import { normalizeTag } from './content-tags.js';
import { saveAsset, getAsset, getAssetMeta, listAssets, deleteAsset, addAssetLink, removeAssetLink, assetsForNode, drainPendingImages, MEDIA_MAX_BYTES, AUDIO_MAX_BYTES, IMAGE_MIME_EXT, MEDIA_KINDS, mediaKindFor, MAX_IMAGES_PER_MESSAGE } from './media.js';
import { materializeAttachments, resolveVisionCapable, findConnection, isModalityError, cacheVisionCapability, describeAsset, ensureDescribed, scoreImageDescriptionThreat, graduateImageDescriptionToNode } from './vision.js';
import { filterOutgoingReply } from './outgoing-filter.js';
import { startDiscordGateway, stopDiscordGateway, getDiscordStatus, relayToDiscord, applyDiscordSettings, callChatRaw } from './discord-gateway.js';
import { buildGuideSystem, guideChatDisabled } from './guide-chat.js';
import { substituteMacros } from './macros.js';
import { stripLlmTimestamps } from './message-sanitize.mjs';
import { listKnocks, dismissKnock, listLocationKnocks, dismissLocationKnock } from './knocks.js';

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
// Used for session IDs, tome IDs, and memorization job IDs — all generated
// via crypto.randomUUID() and sharing the same shape.
function isValidUUID(id) {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}

// Entry UIDs additionally allow the 0.8.x slug shape ("ponder-x7k2m3")
// alongside legacy crypto.randomUUID() values. Same safety properties:
// bounded length, alnum+dash only — no dots/slashes, still traversal-proof.
function isValidEntryUid(uid) {
  return isValidUUID(uid) || (typeof uid === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(uid));
}

// Session ids additionally allow the readable slug shape ("s-20260704-x7k2")
// alongside legacy crypto.randomUUID() values. Session ids name files in
// logs/, so the same path-safety bound applies: alnum+dash, bounded length.
function isValidSessionId(id) {
  return isValidUUID(id) || (typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(id));
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
// share them when it builds the env block for Phylactery. See that file
// for the rationale and how to add a new provider.
import { PROVIDER_URLS } from './providers.js';
import { listProviderModels } from './provider-models.js';
import { startBenchmark, statusOf, cancelBenchmark, resetBenchmark, reportPathsRelative } from './voice-bench-run.js';
import { composePlan, evaluatePlan, availableAsrLangs, CAPABILITY_TIERS, VOICE_ENGINES, formatBytes } from './voice-models.js';
import { consentSummary, inspectInstalled, fetchPlan, MODELS_SUBDIR } from './voice-fetch.js';
import { measureFootprint } from './voice-footprint.js';
import { listClips, measureClip, cachedFeatures, catalogueSummary } from './voice-clips.js';
import { currentAudioWorker as currentAudioWorkerShared, listeningWorker, stopAudioWorker, VOICE_HARD_DISABLED } from './audio-worker-current.js';
import { hearVoiceNotes, transcribeAsset, transcriptionAllowed, correctTranscript } from './voice-transcribe.js';
import { DEFAULT_VOICE } from './voice-catalogue.js';
import { resolveVoice, installVoice, saveWardVoice, listLocalVoices } from './voices.js';
import { mergeSettings } from './settings-merge.js';
import { prepareForSpeech, splitForUtterances, splitForSpeech } from './voice-speech.js';
import {
  speakUnitsSelfHealing,
  SMALL_UTTERANCE_CHARS, DEFAULT_TTS_SEED, MAX_CHAR_IN_SENTENCE,
} from './voice-generation.js';

/**
 * Failures where nothing further can be spoken, so the read-aloud loop stops
 * rather than retrying every remaining part against a dead worker. Anything
 * else is a per-part problem and must NOT silence the parts that still work.
 */
const FATAL_TTS_REASONS = new Set(['no-worker', 'no-engine', 'not-loaded', 'stopped', 'worker-died', 'worker-stopped', 'parked', 'spawn-failed']);
import { resolveBackend, inspectBackends, BACKENDS } from './voice-backend.js';
import { wavHeader, WAV_STREAMING_LENGTH, measureVoiceClip, floatToPcm16 } from './voice-audio-features.js';
import { KIND_PCM } from './audio-frame.js';
import { shortSlug } from './slug-ids.js';
// Tome / state-file coordination is owned by thalamus — every writer
// of a shared file goes through these helpers so cross-loop races
// (HTTP route + autonomous loop hitting the same tome) can't lose
// each other's edits. The locking primitive (withLock) and the
// atomic .tmp+rename pattern live in thalamus.js.
import { withLock, writeTomeFile, modifyTomeFile } from './thalamus.js';

// Simple in-memory rate limiter for /api/chat: max 20 requests per minute per IP.
// Protects against accidental public exposure and runaway tool-call loops.
const _chatRateCounts = new Map();
const _RATE_MAP_SWEEP_AT = 1000; // prune expired entries once the map grows past this
function chatRateLimit(req, res, next) {
  const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  const now = Date.now();
  const WINDOW_MS = 60_000;
  const MAX_REQ   = 20;
  // Bounded memory: many distinct client IPs (behind Tailscale) would otherwise
  // accrete forever. Sweep expired windows only when the map has actually grown
  // — O(n) at most once per 1000 new IPs, never per request on the common path.
  if (_chatRateCounts.size > _RATE_MAP_SWEEP_AT) {
    for (const [k, v] of _chatRateCounts) if (now > v.resetAt) _chatRateCounts.delete(k);
  }
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
  const { provider, apiKey, model, messages, stream, temperature, max_tokens, tools, tool_choice, enrich: enrichFlag, userMessage, lastUserMessageAt, runToolLoop, customTools, sessionInfo, sessionAudience, voiceMode } = req.body;
  // runToolLoop: the app sends true when the user has tools enabled.
  // The server then composes the tool list (built-ins + custom) and runs
  // the multi-round tool-call loop HERE — executing via cerebellum —
  // instead of bouncing each round back to the browser. Direct API
  // callers that pass their own `tools` array keep the legacy
  // passthrough (single round, results handled by the caller).
  const loopMode = !!runToolLoop;
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
    return res.status(400).json({ error: `Unknown provider: "${provider}". Expected one of: ${Object.keys(PROVIDER_URLS).join(', ')}.` });
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

  // Enrich with Phylactery + Unruh context. Split into a static
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
  // V3: resolve session audience to an effective grants object before
  // enrichment. Fail-closed: any error defaults to WARD_PRIVATE (no gating)
  // rather than blocking the chat. Audience only applies on the full path.
  // audienceTag (Pillar D): durable room label used by the outgoing filter.
  let audienceGrants  = WARD_PRIVATE;
  let audienceTag     = 'ward-private';
  let audienceVisible = null; // the room's allowed audience-tag set for recall (null = ward sees all)
  let audienceTopics  = null; // the room's per-topic content grants (null = ward sees all)
  if (enrichMode === 'full' && sessionAudience && typeof sessionAudience === 'object') {
    try {
      const registry = await getVillageRegistry();
      audienceGrants  = resolveAudience(sessionAudience, registry);
      audienceTag     = audienceTagFor(sessionAudience, registry);
      // Pillar E recall gate — circle MEMBERSHIP: the set of circles everyone
      // present shares (needs the session audience, not just the room tag).
      audienceVisible = visibleAudiences(sessionAudience, registry);
      audienceTopics  = topicGrantsForRoom(audienceGrants, audienceTag); // Phase 4 content gate (fine)
    } catch (err) {
      console.error('[server] audience resolution failed (defaulting to ward-private):', err?.message ?? err);
    }
  }

  // liveTurn: only the full chat path may reconcile state (consume the
  // surfaced session handoff, demote standing values whose Phylactery
  // anchor vanished). 'static' fetches persona only (handoff summariser);
  // 'none' skips enrichment entirely. debug-prompt calls enrich() with no
  // options, so it stays read-only.
  const enriched =
      enrichMode === 'full'   ? await enrich(userText, { liveTurn: true, lastUserMessageAt: lastUserMessageAt ?? null, audience: audienceGrants, audiences: audienceVisible, topicGrants: audienceTopics })
    : enrichMode === 'static' ? await enrich(userText, { staticOnly: true })
    : { static: '', dynamic: '', surfacedBookmarks: [], surfacedTasks: [] };

  // Inject awareness of any pending (unacknowledged) triage outreaches
  // into the dynamic block so the Familiar knows it reached out while
  // the user was away — and doesn't act confused about having done so.
  let enrichedResult = enriched;

  // A live voice call is spoken, not typed. Tell the Familiar so — its reply is
  // read aloud, so markdown, bullets, and length that reads fine on screen come
  // out wrong in the ear. Injected as a dynamic block (literal "my human", the
  // server-injected-block convention — no macros), only on a real call turn. The
  // deferred-intents surface it should weave in rides the normal enrich() blocks.
  if (voiceMode && enrichMode === 'full') {
    const block = `\n\n[VOICE CALL — I'm speaking, not typing]\nI'm on a live voice call with my human right now, so my reply gets read aloud. I keep it the way I'd actually talk: plain spoken sentences, no markdown, no bullet points or headings, no asterisks or emoji — spoken aloud those are either read out literally or stripped, and either way they don't belong in speech. I say as much as the moment actually wants — sometimes that's a quick line, but I don't clip myself to a one-liner when there's something real to get into; I talk like I'm in the room with them, and let it run as long as it naturally would out loud, leading with the part that matters. If something's been waiting for me to bring up — a thought I meant to share, a check-in — I just work it into what I'm saying, the way it would come up in a real conversation, not as a separate announcement.`;
    enrichedResult = { ...enrichedResult, dynamic: (enrichedResult.dynamic || '') + block };
  }

  if (enrichMode === 'full') {
    try {
      const pending = await listOutbox({ pendingOnly: true, limit: 20 });
      const triagePending = pending.filter(i => i.kind === 'triage' && i.body);
      if (triagePending.length > 0) {
        const pushConfigured = activePushAdapters().length > 0;
        const notices = triagePending
          .map(i => `  - At ${i.ts}: "${i.body}" ${formatDeliveryNote(i, { hasPushChannel: pushConfigured })}`)
          .join('\n');
        const block = `\n\n[PENDING CHECK-IN NOTICES]\nWhile my human was away, I reached out to them with the following (they have not yet acknowledged):\n${notices}\n\nI am aware I did this. If their first message back opens a door to it, I may acknowledge having reached out — but I should not lead with it or press.`;
        // Build on enrichedResult, not `enriched` — a prior block (e.g. voice mode)
        // may already have appended to `dynamic`, and spreading the base would drop it.
        enrichedResult = { ...enrichedResult, dynamic: (enrichedResult.dynamic || '') + block };
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
  //    In loop mode the anchor is kept SEPARATE and re-appended as the
  //    last message on every tool round, so it stays at maximum
  //    salience even as tool traffic grows the tail.
  let timeAnchor = '';
  if (enrichMode === 'full') {
    const anchorSettings = readSettingsSync();
    timeAnchor = buildTimeAnchorBlock({
      now: Date.now(),
      lastUserMessageAt: lastUserMessageAt ?? null,
      // The ward's zone, not the server's — so the [Now] the Familiar reads is
      // the ward's clock even when the server runs in a different timezone.
      timeZone: anchorSettings?.wardTimeZone || null,
      // Full weather detail is ward-private only. On any gated (non-ward)
      // turn the vague tier renders instead — qualitative, no numbers/units/
      // times/labels, so precise values can't leak a location (§5.6).
      // Fail-closed: unclear audience → vague, and vague itself → '' if stale.
      // The vague tier has no numbers/units, so it needs no unit passed.
      weatherLine: audienceTag === 'ward-private'
        ? readWeatherNowLine({ unit: anchorSettings?.weatherUnit })
        : readWeatherVagueLine(),
    }) || '';
    if (timeAnchor && !loopMode) {
      enrichedMessages = [...enrichedMessages, { role: 'system', content: timeAnchor }];
    }
  }

  // ── Vision materialization (vision build spec §3) ─────────────────
  // The ONE seam where media references become provider content-parts. Applied
  // once to the fully-assembled message array, so it rides every tool round
  // automatically (the loop carries these messages forward). A request with no
  // attachments is returned identical (materializeAttachments short-circuits),
  // so a non-image turn is byte-for-byte what it is today. Degrades to
  // stand-ins on a non-vision connection or over-budget; never throws into the
  // chat path. Ward turns don't gate (audienceVisible null); a gated turn
  // fail-closes on the room's visible-audience set.
  const preVisionMessages = enrichedMessages;   // kept for the mid-turn stand-in retry
  const visionGate = audienceTag && audienceTag !== 'ward-private' ? audienceVisible : null;
  let imagesLiveThisTurn = 0;
  let visionFellBack = false;
  let visionCapableTurn = false;   // does THIS turn's connection see? (gates view_image)
  // Re-materialize forcing stand-ins — the mid-turn hard fallback when a
  // provider rejects the image modality despite an optimistic 'capable' verdict.
  const fallbackToStandins = async () => {
    try {
      const s = readSettingsSync() || {};
      const conn = findConnection(s, { provider, model }) || { provider, model };
      const mat = await materializeAttachments(preVisionMessages, {
        connection: { ...conn, visionCapable: 'no' }, settings: s, visibleAudiences: visionGate,
      });
      return mat.messages;
    } catch { return preVisionMessages; }
  };
  // Hear before answering. Outside the vision block on purpose — hearing is a
  // separate consent from seeing, and a voice note has NO live-modality
  // fallback: the transcript is the only content there will ever be, so if it
  // lands after the prompt I answer a message I never heard.
  await hearVoiceNotes(enrichedMessages, { rootDir: __dirname, label: 'voice' });

  // Attachments are materialized even when vision is off, because hearing is
  // not seeing. Nested inside the vision gate, a voice note vanished entirely
  // when my human turned images off — no stand-in, no mention, and the raw
  // `attachments` field left on the outgoing message for a provider to choke
  // on. The materializer already refuses to send audio live; what it must not
  // do is go silent about it.
  const visionOffThisTurn = visionDisabled();
  if (visionOffThisTurn) {
    try {
      const mat = await materializeAttachments(enrichedMessages, {
        connection: { provider, model, visionCapable: 'no' },
        settings: readSettingsSync() || {},
        visibleAudiences: visionGate,
      });
      enrichedMessages = mat.messages;
      if (mat.notesStoodIn) console.log(`[voice] ${mat.notesStoodIn} voice note stand-in(s) (images are off)`);
    } catch (err) {
      // Never throws into a turn — but never SILENT either. A bare `catch {}`
      // here would swallow a ReferenceError and make voice notes vanish with
      // vision off, which is root cause #4 of the 0.9 post-mortem exactly.
      console.warn(`[voice] could not stand in for attachments with vision off: ${String(err?.message ?? err)}`);
    }
  }
  if (!visionOffThisTurn) {
    try {
      const settingsForVision = readSettingsSync() || {};
      const connForVision = findConnection(settingsForVision, { provider, model })
        || { provider, model, visionCapable: 'auto' };
      visionCapableTurn = await resolveVisionCapable(connForVision, settingsForVision);
      // If the chat model can't see live (text-only, or a z.ai-coding describe-
      // only connection), describe the shared images NOW — synchronously —
      // so their stand-ins carry a real description on THIS turn instead of
      // "not yet described". Bounded + timed, so it never hangs the turn.
      if (!visionCapableTurn) {
        const d = await ensureDescribed(enrichedMessages, settingsForVision);
        if (d.described) console.log(`[vision] described ${d.described} image(s) before the turn`);
      }
      const mat = await materializeAttachments(enrichedMessages, {
        connection: connForVision,
        settings: settingsForVision,
        visibleAudiences: visionGate,
      });
      enrichedMessages = mat.messages;
      imagesLiveThisTurn = mat.imagesLive;
      if (mat.imagesLive || mat.imagesStoodIn) {
        console.log(`[vision] materialized ${mat.imagesLive} live + ${mat.imagesStoodIn} stand-in image(s)`);
      }
      // Anything still undescribed (over the sync cap, or a live-connection's
      // over-budget older image) gets a background look so NEXT time it carries
      // real words. Never blocks this turn.
      for (const id of (mat.stoodInUndescribed ?? [])) {
        describeAsset(id, settingsForVision)
          .then(r => { if (r?.ok !== false) console.log(`[vision] described ${id.slice(0, 8)} in the background`); })
          .catch(() => {});
      }
      // Image→threat scoring (§15.1, ward-signed): the ward's OWN images shared
      // THIS turn can raise the tier (full weight, raise-only). Fire-and-forget
      // — the description is scored via the ward's own detector; never blocks
      // the turn, never lowers the tier, never fires for a villager's image.
      // Only on the ward's own live turn (enrichMode 'full').
      if (enrichMode === 'full' && audienceTag === 'ward-private' && visionThreatScoringOn()) {
        const turnImageIds = (Array.isArray(lastUser?.attachments) ? lastUser.attachments : [])
          .map(a => a?.id).filter(Boolean);
        for (const id of turnImageIds) {
          scoreImageDescriptionThreat(id, settingsForVision)
            .then(r => { if (r?.raised) console.log(`[vision] image ${String(id).slice(0, 8)} raised threat +${r.level} [${(r.signals ?? []).map(s => s.id).join(',')}]`); })
            .catch(err => console.error('[vision] image threat scoring failed:', err?.message ?? err));
        }
      }
    } catch (err) {
      console.error('[vision] materialization failed (passing messages through):', err?.message ?? err);
    }
  }

  const payload = { model: model.trim(), messages: enrichedMessages, stream: !!stream };
  if (typeof temperature === 'number') payload.temperature = temperature;
  if (typeof max_tokens === 'number' && max_tokens > 0) payload.max_tokens = max_tokens;
  // Context-sensitive tool surfacing (tool-surfacing-build-spec): when the
  // ward has it on, only core + triggered modules are advertised; everything
  // stays reachable via request_tools (same-turn recovery). Default OFF.
  let surfacing = null;   // { selection:Set, used:Set } when active
  if (loopMode) {
    const sset = readSettingsSync();
    const surfOn = sset?.toolSurfacingEnabled === true
      && process.env.PROTO_FAMILIAR_TOOL_SURFACING_DISABLED !== '1';
    let activeTools;
    if (surfOn) {
      const prevAssistant = [...(Array.isArray(messages) ? messages : [])].reverse()
        .find(m => m?.role === 'assistant' && typeof m.content === 'string')?.content ?? '';
      const turnText = `${typeof userMessage === 'string' ? userMessage : ''}\n${prevAssistant}`;
      let villagerNames = [];
      try { villagerNames = ((await getVillageRegistry())?.villagers ?? []).map(v => v?.name).filter(Boolean); }
      catch { /* registry unreadable → name-trigger degrades to keywords */ }
      const selection = selectModules({
        turnText,
        dynamicBlock: enriched?.dynamic ?? '',
        villagerNames,
        sticky: stickyModulesFor(sessionInfo?.sessionId),
      });
      surfacing = { selection, used: new Set() };
      activeTools = composeActiveTools(customTools, sset, { modules: selection, visionCapable: visionCapableTurn });
      console.log(`[tools] surfacing: ${selection.size ? [...selection].join(', ') : '(core only)'} — ${activeTools.length} tool(s) advertised`);
    } else {
      activeTools = composeActiveTools(customTools, readSettingsSync(), { visionCapable: visionCapableTurn });
    }
    if (activeTools.length > 0) {
      payload.tools = activeTools;
      payload.tool_choice = 'auto';
    }
  } else {
    if (Array.isArray(tools) && tools.length > 0) payload.tools = tools;
    if (tool_choice !== undefined) payload.tool_choice = tool_choice;
  }

  // ── Tool-call loop (loop mode only) ──────────────────────────────
  // Internal provider re-calls do NOT pass through the /api/chat rate
  // limiter — one user message costs one request against the limit no
  // matter how many tool rounds it takes.
  if (loopMode) {
    // wardPrivate gates the Village tools: full disclosure (incl. private
    // notes) and mutations only when it's just the ward in the room. The
    // audience tag defaults to 'ward-private' and only becomes a room tag
    // when the session carries an audience, so this is the right signal.
    const toolCtx     = {
      sessionInfo: sessionInfo && typeof sessionInfo === 'object' ? sessionInfo : null,
      wardPrivate: audienceTag === 'ward-private',
      // For memorize_now: the session's own provider/key/audience so the
      // Familiar can commit this conversation through the real pipeline.
      audienceTag,
      apiKey,
    };
    if (surfacing) toolCtx._requestedModules = new Set();
    // request_tools grew the set → the next round advertises the union.
    // Growth-only within a turn; undefined = keep the current payload.tools.
    const recomposeTools = () => {
      if (!surfacing || !toolCtx._requestedModules?.size) return undefined;
      const union = new Set([...surfacing.selection, ...toolCtx._requestedModules]);
      return composeActiveTools(customTools, readSettingsSync(), { modules: union, visionCapable: visionCapableTurn });
    };
    const tickSurfacing = (toolNamesUsed = []) => {
      if (!surfacing) return;
      for (const n of toolNamesUsed) {
        const m = TOOL_MODULES[n];
        if (m && m !== 'core') surfacing.used.add(m);
      }
      tickSticky(
        sessionInfo?.sessionId,
        new Set([...surfacing.selection, ...(toolCtx._requestedModules ?? []), ...surfacing.used]),
        Number(readSettingsSync()?.toolStickyTurns ?? 2),
      );
    };

    const upstreamUrl = url;
    const authHeaders = {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey.trim()}`,
    };

    // Abort the loop when the browser tab closes or the client disconnects.
    // Fires req.on('close') which is emitted by Express/Node when the
    // underlying socket closes. The signal is forwarded into runToolCallLoop
    // (non-streaming) and into each upstream fetch (both paths).
    const ac = new AbortController();
    const onClientClose = () => ac.abort();
    req.on('close', onClientClose);

    const thalamusEnvelope = (enrichedResult.static || enrichedResult.dynamic || timeAnchor) ? {
      static:     enrichedResult.static  || '',
      dynamic:    enrichedResult.dynamic || '',
      depth,
      injectedAt,
      timeAnchor,
    } : null;

    // Pillar D: upstream caller for filter retries — bare text round-trip,
    // no tool calls (tools are not needed for rewrite nudges).
    const filterCallUpstream = async (msgs) => {
      const r = await fetch(upstreamUrl, {
        method:  'POST',
        headers: authHeaders,
        body:    JSON.stringify({ model: payload.model, messages: msgs, stream: false }),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`upstream ${r.status}: ${t.slice(0, 200)}`);
      }
      const d = await r.json();
      return d?.choices?.[0]?.message?.content ?? '';
    };

    // ── Non-streaming loop ─────────────────────────────────────────
    if (!stream) {
      try {
        const runLoop = (baseMessages) => runToolCallLoop({
          // Live ward conversation → the ward-configurable round budget
          // (background loops keep the tight MAX_TOOL_ROUNDS default).
          maxRounds: toolRoundsPerTurn(readSettingsSync()),
          getTools: recomposeTools,
          callUpstream: async (msgs, roundTools, opts) => {
            // forceText (round-cap closing round): strip tools entirely so the
            // model must answer in text — a silent tool-hungry turn is worse
            // than a bounded answer.
            const { tools: _pt, tool_choice: _ptc, ...basePayload } = payload;
            const body = opts?.forceText
              ? { ...basePayload, messages: msgs, stream: false }
              : { ...payload, messages: msgs, ...(roundTools ? { tools: roundTools } : {}), stream: false };
            let r;
            try {
              r = await fetch(upstreamUrl, {
                method:  'POST',
                headers: authHeaders,
                body:    JSON.stringify(body),
                signal:  ac.signal,
              });
            } catch (err) {
              if (err.name === 'AbortError') {
                const e = new Error('client disconnected');
                e.status = 499; e.body = ''; throw e;
              }
              const e = new Error(`Network error reaching ${provider}: ${err.message}`);
              e.status = 502; e.body = JSON.stringify({ error: e.message });
              throw e;
            }
            const text = await r.text();
            if (!r.ok) {
              const e = new Error(`upstream ${r.status}`);
              e.status = r.status; e.body = text;
              throw e;
            }
            try { return JSON.parse(text); }
            catch {
              const e = new Error('upstream returned non-JSON');
              e.status = 502; e.body = JSON.stringify({ error: e.message });
              throw e;
            }
          },
          baseMessages,
          timeAnchor,
          toolCtx,
          signal: ac.signal,
        });
        // Mid-turn hard fallback (§3.1): if the provider rejects the image
        // modality despite an optimistic 'capable' verdict, retry ONCE with
        // stand-ins and flip the capability cache — my human's turn still gets
        // answered (degraded sight), never a dead turn.
        let loopOutcome;
        try {
          loopOutcome = await runLoop(enrichedMessages);
        } catch (err) {
          if (!visionFellBack && imagesLiveThisTurn > 0 && isModalityError(err.status, err.body)) {
            visionFellBack = true;
            await cacheVisionCapability(provider, model, 'no');
            console.warn(`[vision] ${provider}:${model} rejected image modality — retried with stand-ins; capability cached 'no'`);
            loopOutcome = await runLoop(await fallbackToStandins());
          } else { throw err; }
        }
        // The first successful live-image turn records capability (the "probe
        // once" — the real turn is the probe, no synthetic image needed).
        if (imagesLiveThisTurn > 0 && !visionFellBack) {
          cacheVisionCapability(provider, model, 'yes').catch(() => {});
        }
        const { data, toolRounds, roundCapHit } = loopOutcome;
        // Tell the client the round budget ran out mid-reach, so it can offer
        // the ward a one-click "go on" (a fresh turn = a fresh budget).
        if (roundCapHit) data._roundCapHit = true;
        req.off('close', onClientClose);
        if (thalamusEnvelope) data._thalamus = thalamusEnvelope;
        if (toolRounds.length > 0) data._toolRounds = toolRounds;
        // Pillar D: semantic outgoing gate. Non-ward-private rooms only;
        // ward-private fast-paths immediately. Mutates data.choices[0].message
        // in-place when the filter rewrites or replaces the reply.
        if (audienceTag !== 'ward-private') {
          const draftText = data.choices?.[0]?.message?.content ?? '';
          if (draftText) {
            const filtered = await filterOutgoingReply({
              draftText, audienceTag,
              callUpstream: filterCallUpstream,
              baseMessages: enrichedMessages,
            }).catch(err => {
              console.error('[server] outgoing filter failed (passing through):', err?.message ?? err);
              return { text: draftText, blocked: false };
            });
            if (filtered.text !== draftText && data.choices?.[0]?.message) {
              data.choices[0].message.content = filtered.text;
              if (filtered.blocked) console.log(`[server] outgoing filter exhausted budget — safe refusal sent (audience=${audienceTag})`);
              else                  console.log(`[server] outgoing filter rewrote reply (audience=${audienceTag})`);
            }
          }
        }
        // M8 idle-mode outcome reporting: fire-and-forget after response sent.
        {
          const responseText = data.choices?.[0]?.message?.content ?? '';
          tickSurfacing((toolRounds ?? []).flatMap(r => (r.toolCalls ?? []).map(tc => tc.function?.name)));
          if (enriched.surfacedBookmarks?.length > 0) {
            reportSurfacingOutcomes({ responseText, bookmarks: enriched.surfacedBookmarks })
              .catch(err => console.error('[server] reportSurfacingOutcomes failed:', err?.message ?? err));
          }
          // Surface-candidate raised/not-raised tagging — same pure-code
          // response-scan pattern; feeds the differentiated dedup window.
          if (enriched.surfacedTasks?.length > 0 && responseText) {
            tagRaisedOutcomes({ responseText, tasks: enriched.surfacedTasks })
              .catch(err => console.error('[server] tagRaisedOutcomes failed:', err?.message ?? err));
          }
        }
        return res.json(data);
      } catch (err) {
        req.off('close', onClientClose);
        if (err.status === 499) return; // client already gone — nothing to send
        res.status(err.status ?? 502).setHeader('Content-Type', 'application/json');
        return res.send(err.body ?? JSON.stringify({ error: err.message }));
      }
    }

    // ── Streaming loop ─────────────────────────────────────────────
    // Each round streams the upstream SSE through to the client
    // (content deltas verbatim); when a round ends in tool_calls, the
    // calls are executed via cerebellum and a `_toolRound` event is
    // emitted so the client can render the collapsible tool block.
    // [DONE] is suppressed on intermediate rounds and emitted once at
    // the true end.
    let currentMsgs = enrichedMessages;
    let headersSent = false;
    let finalText   = '';
    // Stop wasting upstream tokens if the browser goes away mid-loop.
    const clientGone = () => res.writableEnded || res.destroyed;

    // forceTextRound: set when the round cap was reached with tools still
    // pending — ONE extra round runs with tools stripped so the turn ends in
    // honest text instead of silence (mirrors runToolCallLoop's closing round).
    let forceTextRound = false;
    // Live ward conversation → the ward-configurable round budget.
    const liveMaxRounds = toolRoundsPerTurn(readSettingsSync());
    for (let round = 0; round <= liveMaxRounds + 1; round++) {
      if (clientGone() || ac.signal.aborted) break;
      const payloadMessages = timeAnchor
        ? [...currentMsgs, { role: 'system', content: timeAnchor }]
        : currentMsgs;

      const { tools: _st, tool_choice: _stc, ...streamBase } = payload;
      const roundBody = forceTextRound
        ? { ...streamBase, messages: payloadMessages, stream: true }
        : { ...payload, messages: payloadMessages, stream: true };

      let upstream;
      try {
        upstream = await fetch(upstreamUrl, {
          method:  'POST',
          headers: authHeaders,
          body:    JSON.stringify(roundBody),
          signal:  ac.signal,
        });
      } catch (err) {
        if (!headersSent) return res.status(502).json({ error: `Network error reaching ${provider}: ${err.message}` });
        res.write(`data: ${JSON.stringify({ _loopError: `Network error reaching ${provider}: ${err.message}` })}\n\n`);
        return res.end();
      }

      const upCt = upstream.headers.get('content-type') || '';
      if (!upstream.ok || upCt.includes('application/json')) {
        const text = await upstream.text();
        // Mid-turn hard fallback (§3.1): a modality rejection before any SSE
        // has streamed — rebuild this round's messages as stand-ins, flip the
        // capability cache, and retry the same round with degraded sight
        // instead of erroring my human's turn.
        if (!headersSent && !visionFellBack && imagesLiveThisTurn > 0 && isModalityError(upstream.status, text)) {
          visionFellBack = true;
          await cacheVisionCapability(provider, model, 'no');
          console.warn(`[vision] ${provider}:${model} rejected image modality — retrying stream with stand-ins; capability cached 'no'`);
          currentMsgs = await fallbackToStandins();
          round--;   // re-run this round with the stand-in messages
          continue;
        }
        if (!headersSent) {
          res.status(upstream.status).setHeader('Content-Type', 'application/json');
          return res.send(text);
        }
        let msg = `API error ${upstream.status}`;
        try {
          const parsedErr = JSON.parse(text);
          msg = parsedErr?.error?.message ?? (typeof parsedErr?.error === 'string' ? parsedErr.error : msg);
        } catch { /* keep generic */ }
        res.write(`data: ${JSON.stringify({ _loopError: msg })}\n\n`);
        return res.end();
      }

      if (!headersSent) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');
        if (thalamusEnvelope) {
          res.write(`data: ${JSON.stringify({ _thalamus: thalamusEnvelope })}\n\n`);
        }
        headersSent = true;
      }

      // Forward this round's SSE lines while accumulating content +
      // tool-call deltas server-side.
      const reader  = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '', fullContent = '', finishReason = null;
      const toolCallsAcc = {};
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (clientGone()) { try { await reader.cancel(); } catch {} return; }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) { if (line.trim()) res.write(line + '\n'); continue; }
            const raw = line.slice(6).trim();
            if (raw === '[DONE]') continue; // emitted once, at the true end
            try {
              const evt = JSON.parse(raw);
              const choice = evt.choices?.[0];
              if (choice?.finish_reason) finishReason = choice.finish_reason;
              const delta = choice?.delta;
              if (typeof delta?.content === 'string') fullContent += delta.content;
              for (const tc of (delta?.tool_calls ?? [])) {
                const acc = (toolCallsAcc[tc.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
                if (tc.id)                  acc.id                 += tc.id;
                if (tc.function?.name)      acc.function.name      += tc.function.name;
                if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
              }
            } catch { /* malformed line — forward as-is */ }
            res.write(line + '\n\n');
          }
        }
      } catch {
        if (!res.writableEnded) res.end();
        return;
      }

      const toolCalls = Object.values(toolCallsAcc);
      if (finishReason === 'tool_calls' && toolCalls.length > 0 && round < liveMaxRounds && !forceTextRound) {
        const timestamp = new Date().toISOString();
        const results = await Promise.all(toolCalls.map(async tc => ({
          tool_call_id: tc.id,
          name:         tc.function.name,
          content:      await executeToolCall(tc.function.name, tc.function.arguments, toolCtx),
        })));
        if (clientGone()) return;
        res.write(`data: ${JSON.stringify({ _toolRound: { toolCalls, results, content: fullContent || null, timestamp } })}\n\n`);
        if (surfacing) {
          for (const tc of toolCalls) {
            const m = TOOL_MODULES[tc.function?.name];
            if (m && m !== 'core') surfacing.used.add(m);
          }
          const grown = recomposeTools();
          if (grown) payload.tools = grown;  // next round carries the pulled module
        }
        currentMsgs = [
          ...currentMsgs,
          { role: 'assistant', content: fullContent || null, tool_calls: toolCalls },
          ...results.map(r => ({ role: 'tool', tool_call_id: r.tool_call_id, content: r.content })),
          // view_image (§10): place any images I asked to see again before my
          // eyes on the next round (same drain helper as the non-streaming loop).
          ...(await drainPendingImages(toolCtx)),
        ];
        continue;
      }

      // Round-cap exhaustion with tools still pending: force ONE closing text
      // round (tools stripped) so the turn ends in honest words instead of
      // silence — and so the model is TOLD its last requested calls did not
      // run, rather than half-remembering them as done.
      if (finishReason === 'tool_calls' && toolCalls.length > 0 && !forceTextRound) {
        forceTextRound = true;
        currentMsgs = [
          ...currentMsgs,
          { role: 'system', content: "[My tool budget for this turn is spent — the calls I just requested did NOT run. I answer my human now with what I actually have, and I say plainly which checks or changes I didn't get to, rather than presenting them as done. If they tell me to go on, I get a fresh budget and continue.]" },
        ];
        console.log('[tools] round cap reached with tools still pending — forcing a closing text round (stream)');
        continue;
      }

      finalText = fullContent;
      break;
    }

    req.off('close', onClientClose);
    // The first successful live-image stream records capability (the "probe
    // once" — the real turn is the probe).
    if (imagesLiveThisTurn > 0 && !visionFellBack) {
      cacheVisionCapability(provider, model, 'yes').catch(() => {});
    }
    if (!res.writableEnded) {
      // Round budget ran out mid-reach → the client offers a one-click "go on".
      if (forceTextRound) res.write(`data: ${JSON.stringify({ _roundCapHit: true })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
    // M8 idle-mode outcome reporting (streaming path). Fire-and-forget.
    const streamBookmarksLoop = enriched.surfacedBookmarks ?? [];
    if (streamBookmarksLoop.length > 0 && finalText) {
      reportSurfacingOutcomes({ responseText: finalText, bookmarks: streamBookmarksLoop })
        .catch(err => console.error('[server] reportSurfacingOutcomes (streaming) failed:', err?.message ?? err));
    }
    if (enriched.surfacedTasks?.length > 0 && finalText) {
      tagRaisedOutcomes({ responseText: finalText, tasks: enriched.surfacedTasks })
        .catch(err => console.error('[server] tagRaisedOutcomes (streaming) failed:', err?.message ?? err));
    }
    return;
  }

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
    // RULE A at the one seam every non-stream reply crosses. A thinking model
    // (GLM/DeepSeek) parks its answer in `reasoning_content` when `content` is
    // empty. A raw passthrough of `.content` hands every non-stream caller —
    // the voice turn, guide-chat, the handoff summariser — an empty string, so
    // the reply silently vanishes. Fold the recovered text into
    // choices[0].message.content HERE, so no caller has to remember. A response
    // carrying tool_calls is left untouched: an empty content beside tool_calls
    // is legitimate, and reasoning is not an answer there.
    let parsed = null;
    if (upstream.ok) {
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      if (parsed?.choices?.[0]?.message) foldReasoningIntoContent(parsed.choices[0].message);
    }
    if (thalamusEnvelope && parsed) {
      parsed._thalamus = thalamusEnvelope;
      // M8 idle-mode outcome reporting: fire-and-forget after response sent.
      const responseText = parsed.choices?.[0]?.message?.content ?? '';
      if (enriched.surfacedBookmarks?.length > 0) {
        reportSurfacingOutcomes({ responseText, bookmarks: enriched.surfacedBookmarks })
          .catch(err => console.error('[server] reportSurfacingOutcomes failed:', err?.message ?? err));
      }
      if (enriched.surfacedTasks?.length > 0 && responseText) {
        tagRaisedOutcomes({ responseText, tasks: enriched.surfacedTasks })
          .catch(err => console.error('[server] tagRaisedOutcomes failed:', err?.message ?? err));
      }
      return res.send(JSON.stringify(parsed));
    }
    // Successful JSON without an envelope: re-serialise so the recovered
    // content rides out. A non-JSON body or an upstream error passes through
    // byte-for-byte unchanged.
    if (parsed) return res.send(JSON.stringify(parsed));
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
  // after the stream closes. Only active when bookmarks or surface
  // candidates were offered this turn.
  const streamBookmarks = enriched.surfacedBookmarks ?? [];
  const streamTasks     = enriched.surfacedTasks ?? [];
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
        if (streamTasks.length > 0 && accumulatedText) {
          tagRaisedOutcomes({ responseText: accumulatedText, tasks: streamTasks })
            .catch(err => console.error('[server] tagRaisedOutcomes (streaming) failed:', err?.message ?? err));
        }
        break;
      }
      const chunk = Buffer.from(value);
      res.write(chunk);
      // Extract text content from SSE delta chunks for outcome detection.
      // Each chunk may contain multiple `data: {...}\n\n` events. We only
      // need the assistant text, so parse each line's `choices[0].delta.content`.
      if (streamBookmarks.length > 0 || streamTasks.length > 0) {
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
 * messages payload — including Phylactery enrichment prepended to the system
 * message. Does NOT call any upstream LLM.
 *
 * WARNING: This endpoint returns Phylactery enriched context (personal memory /
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

// Ward-facing regex/trigger tracer (0.8.25): given the session's turns, report
// per turn WHICH regexes/signals fired — tool-surfacing modules (with the exact
// matched substrings) and crisis-signal contributions — so the ward can tune
// the RegExes. The tome-keyword analyzer runs client-side (its corpus is client
// world-info). Localhost-gated like every endpoint (the Tailscale middleware).
app.post('/api/diagnostics/session-trace', async (req, res) => {
  const { turns, analyzers } = req.body ?? {};
  if (!Array.isArray(turns)) return badRequest(res, 'turns (array) is required');
  const want = new Set(Array.isArray(analyzers) && analyzers.length ? analyzers : ['surfacing', 'threat']);
  let villagerNames = [];
  try { villagerNames = ((await getVillageRegistry())?.villagers ?? []).map(v => v?.name).filter(Boolean); }
  catch { /* registry unreadable → name triggers just won't show */ }
  const out = turns.slice(0, 500).map((t, i) => {
    const user = typeof t?.user === 'string' ? t.user : '';
    const assistant = typeof t?.assistant === 'string' ? t.assistant : '';
    const turnText = `${user}\n${assistant}`;
    const entry = { i, user };
    if (want.has('surfacing')) {
      entry.surfacing = explainSelection({ turnText, dynamicBlock: typeof t?.dynamicBlock === 'string' ? t.dynamicBlock : '', villagerNames });
    }
    if (want.has('threat')) {
      entry.threat = scoreMessage(user);   // threat scores the user message only, as live
    }
    return entry;
  });
  res.json({ ok: true, turns: out });
});

// ── Voice benchmark (voice spec §0.5) ────────────────────────────────────
//
// Pass 0's deliverable is a REPORT a ward can run without a terminal, read,
// and send back — the people who own the target machines are wards, not
// developers. Same shape as the regex tracer above: a button, honest staged
// progress, copy/download output.
//
// Long-running, so it is start/poll/cancel rather than one held request.
// Localhost/Tailscale-gated like every endpoint.

// What a benchmark WOULD do, before committing to it: the plan, its size, and
// what is already installed. This is also what the download-consent copy is
// built from — the figure and the sentence come from one place so they cannot
// drift (§0.7 rule 3).
app.get('/api/voice/plan', async (req, res) => {
  try {
    const plan = composePlan({
      capabilityTier: req.query.tier,
      voiceEngine: req.query.voice,
      asrLangs: typeof req.query.lang === 'string' && req.query.lang ? req.query.lang.split(',') : undefined,
    });
    const modelsDir = path.join(__dirname, MODELS_SUBDIR);
    const [summary, installed] = await Promise.all([
      consentSummary({ plan, modelsDir }),
      inspectInstalled({ plan, modelsDir }),
    ]);
    const ev = evaluatePlan(plan);
    res.json({
      ok: true,
      plan: {
        capabilityTier: plan.capabilityTier,
        voiceEngine: plan.voiceEngine,
        asrLangs: plan.asrLangs,
        unavailableLangs: plan.unavailableLangs,
      },
      choices: {
        tiers: CAPABILITY_TIERS,
        engines: VOICE_ENGINES,
        languages: availableAsrLangs(),
      },
      size: {
        totalBytes: ev.totalBytes,
        totalDiskBytes: ev.totalDiskBytes,
        peakBytes: ev.peakBytes,
        estimated: ev.estimated,
        diskEstimated: ev.diskEstimated,
        pretty: formatBytes(ev.totalDiskBytes),
        withinBudget: ev.withinBudget,
        violations: ev.violations,
      },
      consent: { text: summary.text, canProceed: summary.canProceed, preflight: summary.preflight },
      installed,
    });
  } catch (err) {
    res.json({ ok: false, error: String(err?.message ?? err) });
  }
});

// What the app currently occupies on disk, split machine vs. mine (§0.7).
// The Storage view reads this; only machine artifacts are ever reclaimable.
app.get('/api/voice/footprint', async (_req, res) => {
  try {
    res.json({ ok: true, ...(await measureFootprint(__dirname)) });
  } catch (err) {
    res.json({ ok: false, error: String(err?.message ?? err) });
  }
});

app.post('/api/diagnostics/voice-bench', async (req, res) => {
  const { tier, voice, langs, samples } = req.body ?? {};
  try {
    const started = startBenchmark({
      rootDir: __dirname,
      appVersion: PKG_VERSION,
      samples: Number.isFinite(samples) ? Math.max(3, Math.min(50, samples)) : 12,
      planOptions: {
        capabilityTier: tier,
        voiceEngine: voice,
        asrLangs: Array.isArray(langs) && langs.length ? langs : undefined,
      },
      // The interference probe is the §4 headline: a real enrichment-shaped
      // read through the live peers, so the report says whether a call would
      // starve the rest of me on THIS machine rather than in principle.
      probe: async () => { await searchMemory({ query: 'benchmark probe', limit: 3 }); },
      // No engine adapter yet (Pass 0 tail). A missing engine renders as a
      // stated absence in the report, never as zeros.
      engineFactory: null,
    });
    res.json({ ok: true, ...started });
  } catch (err) {
    res.json({ ok: false, error: String(err?.message ?? err) });
  }
});

app.get('/api/diagnostics/voice-bench', (_req, res) => {
  const st = statusOf();
  const run = st.status === 'done' ? reportPathsRelative(__dirname, st.savedTo) : null;
  res.json({ ok: true, ...st, savedTo: run });
});

// ── Reference-voice picker (voice spec §6.5) ─────────────────────────────
//
// PocketTTS clones zero-shot from a reference clip, so choosing a voice is
// choosing a wav file. 700+ CC0 clips are catalogued with verified checksums;
// the browser previews them straight from the pinned URL, and pitch is
// measured lazily as they are auditioned.

// ── The audio worker (voice spec §2, §11) ────────────────────────────────
//
// `voiceEnabled` is default OFF and governs CONTINUOUS listening — a mic that
// is simply open (live calls, Pass 2). It does NOT gate voice notes: pressing
// the record button is itself the consent, and the browser asks its own
// permission on top, so a setting in front of that guards a door already
// locked while hiding the button that opens it. Read-aloud does not require it
// either (§11): it is an accessibility surface, and hard-of-hearing wards are
// exactly who it serves.
//
// PROTO_FAMILIAR_VOICE_DISABLED=1 kills all of it, read-aloud included.

// The worker itself lives in audio-worker-current.js so Discord can reach the
// same one (RULE C: a capability lands in the shared path, or it drifts). This
// wrapper only supplies what that module deliberately does not know — where
// the app root is, and how settings are read.
const currentAudioWorker = () => currentAudioWorkerShared({ rootDir: __dirname, readSettings: readSettingsSync });

function voiceListeningEnabled() {
  if (VOICE_HARD_DISABLED) return false;
  try { return readSettingsSync()?.voiceEnabled === true; } catch { return false; }
}

app.get('/api/voice/status', async (req, res) => {
  const s = (() => { try { return readSettingsSync() || {}; } catch { return {}; } })();

  // Resolve rather than report. `chosenVoice` alone is a setting, not a fact:
  // it can name a voice that was never downloaded, and answering with it would
  // claim I speak in a voice I have no file for — the same shape as the
  // `engine: null` bug, where the endpoint reported a field it never checked.
  const voice = await resolveVoice({ rootDir: __dirname, settings: s });

  const base = {
    ok: true,
    // Why voice is or is not available, in the order the reasons actually
    // apply — a ward reading this should not have to work out which gate bit.
    hardDisabled: VOICE_HARD_DISABLED,
    listeningEnabled: voiceListeningEnabled(),
    // The streaming-ASR languages actually installed (pinned), so the call
    // language picker can only offer what can be heard — a menu that named a
    // language with no model would be listening in silence.
    asrLanguages: availableAsrLangs(),
    // Read-aloud needs a reference clip as much as it needs the engine:
    // PocketTTS clones zero-shot and has no built-in voice to fall back on.
    readAloudAvailable: !VOICE_HARD_DISABLED && voice.ok,
    defaultVoice: DEFAULT_VOICE.key,
    chosenVoice: s.voiceTts?.voice ?? DEFAULT_VOICE.key,
    voice: {
      key: voice.key ?? null,
      provenance: voice.provenance ?? null,
      // Named when the chosen voice was not on disk, so a ward who picked
      // something and hears the default learns why instead of wondering.
      fellBackFrom: voice.fellBackFrom ?? null,
      reason: voice.reason ?? voice.detail ?? null,
    },
  };
  const { worker, resolved } = await currentAudioWorker();
  if (!worker) {
    return res.json({ ...base, worker: { running: false, reason: 'PROTO_FAMILIAR_VOICE_DISABLED=1' } });
  }
  // Which engine, and — if the chosen one could not be used — which was asked
  // for and why. A ward who paid 600 MB for voicebox should never have to
  // wonder whether it is the one talking.
  base.backend = {
    using: resolved.backend,
    askedFor: resolved.fellBackFrom ?? resolved.backend,
    reason: resolved.reason ?? null,
    available: await inspectBackends(__dirname),
    // The sidecar install is a script today. Naming it here means the UI can
    // surface the choice instead of my human having to know it exists.
    installCommand: 'node scripts/ensure-voicebox.mjs --install',
  };
  // PROBE, do not peek. The worker spawns lazily, so a status that only asked
  // when one was already running could never answer on a fresh boot — the
  // endpoint whose whole job is "does voice work?" would report `null` forever
  // because finding out requires starting the thing it reports on. `null` also
  // reads as "unknown" when it really meant "I did not look", which is the
  // reported-absence rule broken in miniature.
  //
  // Cost of probing: one lazily spawned process that unloads itself after
  // voiceModelIdleMin. Cheap, and exactly what someone asking this is asking.
  const probe = req.query.probe !== '0';
  let engine = { available: false, detail: 'not checked', checked: false };
  if (probe) {
    const r = await worker.request({ op: 'ping' }, { timeoutMs: 8000 });
    engine = r.ok
      ? { available: Boolean(r.engineAvailable), detail: r.engineDetail ?? null, checked: true }
      : { available: false, detail: r.detail ?? r.reason, checked: true };
  }
  // Read AFTER the probe, so `running` and `loadedModels` describe the worker
  // the probe just talked to rather than the state before it existed.
  res.json({ ...base, worker: worker.status(), engine });
});

/**
 * Is the speaking model actually on disk?
 *
 * Read-aloud needs a 194 MB download that, until now, only existed as a
 * terminal command. Someone who clicks the button on a fresh install should be
 * offered the download — not shown an error whose fix is a CLI incantation they
 * were never told about. This is what lets the button offer.
 */
app.get('/api/voice/models', async (req, res) => {
  try {
    const plan = voicePlanFor(req.query?.what);
    const state = await inspectInstalled({ plan, modelsDir: path.join(__dirname, MODELS_SUBDIR) });
    res.json({ ok: true, what: req.query?.what === 'listen' ? 'listen' : 'speak', ...state });
  } catch (err) {
    res.json({ ok: false, error: String(err?.message ?? err) });
  }
});

/**
 * Fetch the speaking model, from the app rather than a terminal.
 *
 * Consent first: this reports what it will cost and refuses on a full disk,
 * the same as the CLI, because 194 MB arriving unannounced is not a kindness
 * on a laptop someone is already short of room on.
 */
/**
 * Which models a thing actually needs.
 *
 * ⚠️ This exists because both call sites passed `{ tier, engine }` and
 * `composePlan` takes `{ capabilityTier, voiceEngine }`. Neither name matched,
 * so both silently fell through to the DEFAULT tier — 'listening' — and the
 * read-aloud button was quietly planning, reporting missing, and downloading
 * the VAD and streaming-ASR models on top of the voice: ~130 MB nobody asked
 * for, on machines chosen for being small. No error, no wrong behaviour
 * visible anywhere; it just cost people disk.
 *
 * One helper now, named for what the caller wants rather than for the
 * library's parameter shape, so the mistake has nowhere left to live.
 */
function voicePlanFor(what) {
  const speak = composePlan({ capabilityTier: 'read-aloud', voiceEngine: 'pocket' });
  if (what === 'call') {
    // A live voice call (Pass 2b) needs the STREAMING recogniser + VAD (the
    // 'listening' tier) AND a speaking voice — I both listen and talk in a
    // call, unlike a voice note (offline, listen-only) or read-aloud (speak-only).
    return composePlan({ capabilityTier: 'listening', voiceEngine: 'pocket' });
  }
  if (what !== 'listen') return speak;

  // Voice notes are decoded offline, once, with nobody waiting — so listening
  // needs the OFFLINE recogniser ALONE. The streaming models and VAD belong to
  // live calls (Pass 2); the speaking voice belongs to read-aloud. Someone who
  // wants to send me a voice note and never wants me to talk should not be
  // handed 200 MB of my voice to get it, so the plan is narrowed to the extra
  // rather than composed around a voice they did not ask for.
  const listen = composePlan({ capabilityTier: 'read-aloud', voiceEngine: 'pocket', extras: ['asr-offline'] });
  return { ...listen, voice: null, capability: [], all: listen.extras };
}

app.post('/api/voice/install-models', async (req, res) => {
  try {
    const plan = voicePlanFor(req.body?.what);
    const modelsDir = path.join(__dirname, MODELS_SUBDIR);
    const summary = await consentSummary({ plan, modelsDir });
    if (summary?.preflight && summary.preflight.ok === false) {
      return res.json({ ok: false, reason: summary.preflight.reason, needed: summary.outstandingBytes });
    }
    // Progress reaches the terminal. A 158 MB download that prints nothing for
    // two minutes is indistinguishable from one that is doing nothing, which
    // is exactly how it looked to my human.
    const what = req.body?.what === 'listen' ? 'listening' : 'speaking';
    console.log(`[voice] fetching the ${what} model(s)…`);
    let lastPct = -1;
    const result = await fetchPlan({
      plan, modelsDir,
      // The field is `phase` — checked against voice-fetch.js rather than
      // assumed. Written as `stage` first, which would have printed nothing at
      // all and left this looking fixed.
      onProgress: (e) => {
        if (e?.phase === 'download' && Number.isFinite(e.receivedBytes) && Number.isFinite(e.totalBytes) && e.totalBytes > 0) {
          const pct = Math.floor((e.receivedBytes / e.totalBytes) * 10) * 10;
          if (pct > lastPct) { lastPct = pct; console.log(`[voice]   ${what} model ${pct}%`); }
        } else if (e?.phase && e.phase !== 'download') {
          console.log(`[voice]   ${e.phase}${e.file ? ` ${e.file}` : ''}`);
        }
      },
    });
    if (result?.ok === false) {
      // Surface the underlying cause, not just the friendly message. The one
      // line that says WHY an unpack failed (a decode error, a missing codec,
      // a locked file) lives in `result.failed[].detail`; dropping it here is
      // what made this class of failure undiagnosable from the terminal.
      const cause = Array.isArray(result.failed)
        ? result.failed.map((f) => f?.detail).filter(Boolean).join('; ')
        : '';
      console.log(`[voice] ${what} model download failed: ${result.message ?? result.reason}${cause ? ` — ${cause}` : ''}`);
    } else {
      console.log(`[voice] ${what} model(s) ready`);
    }
    res.json({ ok: Boolean(result?.ok ?? true), ...result });
  } catch (err) {
    res.json({ ok: false, error: String(err?.message ?? err) });
  }
});

/**
 * Listen to a voice note now, and give back what was said.
 *
 * The chat path already transcribes before it answers, so this exists for the
 * composer: my human records something, and the words appear under it before
 * they hit send. Seeing the transcript BEFORE sending is what makes a voice
 * note trustworthy to someone who cannot easily check afterwards — they can
 * see it heard "oat milk" and not "oat mail", and re-record if it didn't.
 *
 * Idempotent by construction: `transcribeAsset` listens once and caches, so
 * calling this twice costs one decode.
 */
app.post('/api/media/:id/transcribe', async (req, res) => {
  if (VOICE_HARD_DISABLED) return res.json({ ok: false, reason: 'voice-disabled' });
  const settings = readSettingsSync() || {};
  if (!transcriptionAllowed()) {
    return res.json({ ok: false, reason: 'voice-disabled', hint: 'Voice is hard-disabled (PROTO_FAMILIAR_VOICE_DISABLED=1).' });
  }
  // Checked here rather than left to the engine's throw: "the listening model
  // has not been downloaded yet" is a thing my human can DO something about,
  // and it should arrive as an offer with a size on it, not as a load failure.
  try {
    const state = await inspectInstalled({ plan: voicePlanFor('listen'), modelsDir: path.join(__dirname, MODELS_SUBDIR) });
    const missing = (state.models ?? []).filter((m) => !m.complete);
    if (missing.length) {
      return res.json({ ok: false, reason: 'model-missing', bytes: state.outstandingBytes ?? null });
    }
  } catch { /* if we can't tell, let the attempt report the real problem */ }

  // The listening worker — pinned to sherpa. Sending this to the speaking
  // worker is what made every voice note fail once my human chose voicebox.
  const got = await transcribeAsset(req.params.id, {
    getWorker: () => listeningWorker({ rootDir: __dirname }),
  });
  res.json(got);
});

/**
 * Install the voicebox sidecar, from a button.
 *
 * The same work `scripts/ensure-voicebox.mjs --install` does, reachable
 * without a terminal — because "run this command" is where someone with
 * executive dysfunction stops, and that is the population this project exists
 * for.
 *
 * Long-running by nature (torch is ~122 MB before anything unpacks), so it
 * answers immediately with `started` and the UI polls /api/voice/status. A
 * request that hangs for four minutes looks broken however well it is going.
 */
let voiceboxInstall = null;   // { startedAt, done, ok, detail, cancelled }
let voiceboxInstallChild = null;

/**
 * Kick off the sidecar download, or report that one is already running / done.
 *
 * The same work `scripts/ensure-voicebox.mjs --install` does, reachable from two
 * places: the Settings button (an explicit ask), and the first time voice is
 * actually USED while the default (pocket) is not yet installed — which is the
 * "download on first use" the pocket default is built around.
 *
 * Idempotent: a second caller while one is running joins the one in flight, so a
 * read-aloud click and a settings click cannot spawn two ~600 MB downloads.
 *
 * Long-running by nature (torch is ~122 MB before anything unpacks), so callers
 * get `started` immediately and poll GET /api/voice/install-sidecar.
 */
async function startVoiceboxInstall() {
  if (voiceboxInstall && !voiceboxInstall.done) {
    return { started: true, already: true, startedAt: voiceboxInstall.startedAt };
  }
  const found = await inspectBackends(__dirname).catch(() => null);
  if (found?.[BACKENDS.POCKET]?.available) {
    return { already: true, done: true, detail: 'already installed' };
  }

  voiceboxInstall = { startedAt: new Date().toISOString(), done: false, ok: false, detail: null, cancelled: false };
  const script = path.join(__dirname, 'scripts', 'ensure-voicebox.mjs');
  const child = spawn(process.execPath, [script, '--install'], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  voiceboxInstallChild = child;
  let tail = '';
  const keep = (buf) => { tail = (tail + buf.toString()).slice(-2000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('error', (err) => {
    voiceboxInstall = { ...voiceboxInstall, done: true, ok: false, detail: String(err?.message ?? err) };
    voiceboxInstallChild = null;
  });
  child.on('close', async (code) => {
    const after = await inspectBackends(__dirname).catch(() => null);
    const cancelled = voiceboxInstall?.cancelled === true;
    const ok = !cancelled && code === 0 && Boolean(after?.[BACKENDS.POCKET]?.available);
    voiceboxInstall = {
      ...voiceboxInstall, done: true, ok,
      // The tail of the log, because "it failed" with no reason is the thing
      // that sends someone to a terminal anyway.
      detail: ok ? null : cancelled ? 'cancelled' : (tail.trim().split('\n').slice(-4).join(' ') || `exited ${code}`),
    };
    voiceboxInstallChild = null;
    if (ok) console.log('[voice] voicebox installed — the sidecar speaks from now on');
  });

  return { started: true, startedAt: voiceboxInstall.startedAt };
}

/**
 * If the resolved worker fell back from pocket to sherpa — the default is
 * chosen but not downloaded — start the download in the background. Fire and
 * forget: the caller keeps speaking on sherpa this turn, and the sidecar takes
 * over once it lands. Called only from real speak paths, never from status
 * polling, so opening Settings does not pull 600 MB.
 */
function autoInstallSidecarIfDefault(resolved) {
  if (resolved?.fellBackFrom !== BACKENDS.POCKET) return;
  if (voiceboxInstall && (!voiceboxInstall.done || voiceboxInstall.ok || voiceboxInstall.cancelled)) return;
  startVoiceboxInstall().catch(() => { /* the fallback is already speaking; a failed start is not fatal */ });
}

app.post('/api/voice/install-sidecar', async (_req, res) => {
  res.json({ ok: true, ...(await startVoiceboxInstall()) });
});

app.get('/api/voice/install-sidecar', (_req, res) => {
  res.json({ ok: true, install: voiceboxInstall });
});

/** Cancel an in-flight download — the ward changed their mind, or the disk is tight. */
app.delete('/api/voice/install-sidecar', (_req, res) => {
  if (!voiceboxInstall || voiceboxInstall.done) return res.json({ ok: true, running: false });
  voiceboxInstall.cancelled = true;
  try { voiceboxInstallChild?.kill('SIGTERM'); } catch { /* already gone */ }
  res.json({ ok: true, cancelled: true });
});

// Clearing a park is deliberate — the ward has presumably fixed something.
app.post('/api/voice/unpark', async (_req, res) => {
  if (VOICE_HARD_DISABLED) return res.json({ ok: false, reason: 'voice-disabled' });
  const { worker } = await currentAudioWorker();
  if (!worker) return res.json({ ok: false, reason: 'voice-disabled' });
  res.json({ ok: true, ...worker.unpark() });
});

// ── Read-aloud (voice spec §11) ──────────────────────────────────────────
//
// Two endpoints rather than one, because they are different kinds of work.
// Planning is pure text and costs nothing; speaking loads a model and takes a
// second per utterance. Keeping them apart lets the browser get the whole
// shape of a message immediately, then fetch audio one utterance at a time —
// which is what makes read-aloud start playing in about a second instead of
// after the entire message has been synthesised.

const TTS_MODEL_DIR = path.join(__dirname, MODELS_SUBDIR, 'tts-pocket');

/** Load the speaking model if it is not already up. Idempotent in the worker. */
async function ensureTtsLoaded(worker) {
  // A cold load reads ~194 MB of ONNX off disk, which on the reference laptop
  // is slow enough that the default request timeout would fire mid-load and
  // report a failure for something that was working.
  return worker.request({ op: 'load', role: 'tts', modelDir: TTS_MODEL_DIR }, { timeoutMs: 180_000 });
}

// Prepared text, waiting to be spoken. Held only long enough for the browser
// to turn a plan into an <audio> src — this is a handoff, not a cache.
const utterances = new Map();
const UTTERANCE_TTL_MS = 10 * 60_000;

function keepUtterance(parts) {
  const now = Date.now();
  for (const [k, v] of utterances) if (now - v.at > UTTERANCE_TTL_MS) utterances.delete(k);
  const id = `say-${shortSlug(6)}`;
  utterances.set(id, { parts, at: now });
  return id;
}

/** Stream ids are 16-bit on the wire, so they wrap rather than grow. */
let nextStreamId = 1;
// Bounded BELOW the band `voice-call-server.js` uses for a live call's TTS
// (40000+). Both share one worker, and a listener filters frames by streamId —
// so if the two bands ever met, one stream's audio would be written into the
// other's wav, which is heard as the voice changing mid-sentence.
const READ_ALOUD_STREAM_ID_MAX = 39999;
const takeStreamId = () => (nextStreamId = (nextStreamId % READ_ALOUD_STREAM_ID_MAX) + 1);

// What would be said, and how. No engine, no model, no cost.
app.post('/api/voice/speech-plan', (req, res) => {
  const plan = prepareForSpeech(String(req.body?.text ?? ''));
  if (plan.empty) return res.json({ ok: true, ...plan, id: null });
  res.json({ ok: true, ...plan, id: keepUtterance(plan.parts) });
});

/**
 * Speak a planned message, streaming the audio as it is generated.
 *
 * ── Why this is one generation and a stream, not several requests ───────
 * The obvious design — split into sentences, fetch each as its own wav — is
 * what shipped first and it was wrong. PocketTTS clones ZERO-SHOT PER CALL
 * and exposes no seed (no `target_rms` or `guidance_scale` either; those
 * belong to ZipVoice). So each request re-derived the voice and re-sampled
 * the decoder: three sentences came back as three speakers at three levels.
 *
 * The clone has to happen once. Streaming out of that single generation is
 * what keeps the latency the chunking was there to buy — the engine's own
 * progress callback hands over audio as it is produced, and the framed PCM
 * protocol carries it. Ordinary messages are exactly one generation; only a
 * very long one seams, at a paragraph, and the plan says how many times.
 */
app.get('/api/voice/tts/:id', async (req, res) => {
  const { worker, resolved } = await currentAudioWorker();
  if (!worker) return res.status(503).json({ ok: false, reason: 'voice-disabled' });

  // First real use of voice while pocket (the default) is chosen but not yet
  // downloaded: start the ~600 MB fetch in the background. This turn still
  // speaks — on the sherpa fallback — and the sidecar takes over once it lands.
  autoInstallSidecarIfDefault(resolved);

  const held = utterances.get(req.params.id);
  if (!held) return res.status(404).json({ ok: false, reason: 'expired', detail: 'ask for a fresh plan' });

  const s = (() => { try { return readSettingsSync() || {}; } catch { return {}; } })();
  const voice = await resolveVoice({ rootDir: __dirname, settings: s });
  if (!voice.ok) return res.status(503).json({ ok: false, reason: voice.reason, detail: voice.detail });

  const loaded = await ensureTtsLoaded(worker);
  if (!loaded.ok) return res.status(503).json({ ok: false, reason: loaded.reason, detail: loaded.detail });

  const sampleRate = Number(loaded.sampleRate) || 24000;
  const speed = Number(s.voiceTts?.speed) || 1.0;
  // Left undefined unless my human set them, so the worker's own defaults
  // stay the single place these are decided. `seed` in particular is what
  // keeps my voice the same from sentence to sentence.
  const numSteps = Number(s.voiceTts?.numSteps) || undefined;
  const seed = Number.isFinite(Number(s.voiceTts?.seed)) ? Number(s.voiceTts.seed) : undefined;
  const temperature = Number(s.voiceTts?.temperature) || undefined;

  if (voice.fellBackFrom) {
    res.set('X-Voice-Fell-Back-From', encodeURIComponent(voice.fellBackFrom));
    res.set('X-Voice-Reason', encodeURIComponent(voice.reason ?? ''));
  }
  res.set('X-Voice-Key', encodeURIComponent(voice.key));
  res.set('Content-Type', 'audio/wav');
  res.set('Cache-Control', 'no-store');
  res.write(wavHeader(WAV_STREAMING_LENGTH, sampleRate));

  let aborted = false;
  res.on('close', () => { aborted = true; });

  const captureUnsupported = (r) => {
    // A backend that cannot honour a setting must say so. pocket-tts has no
    // speed control, so a ward who slowed playback would otherwise hear no
    // difference and no reason.
    if (Array.isArray(r?.unsupported) && r.unsupported.length && !res.headersSent) {
      res.set('X-Voice-Unsupported', r.unsupported.join(','));
    }
  };

  // The sidecar carries a KV cache across a whole call, so it does NOT drop the
  // tail of a long message the way the built-in engine does. It also must not be
  // pre-split into small utterances — that would force a fresh clone per piece
  // and reintroduce the seams it exists to avoid. So the two engines take
  // different paths: the sidecar streams whole generation units; the built-in
  // buffers and verifies small ones.
  const isSidecar = resolved?.backend === BACKENDS.POCKET;

  try {
    if (isSidecar) {
      // Stream whole-message units live. held.parts only seams at paragraphs on
      // a very long message; ordinary ones are a single part, one trajectory.
      for (const part of held.parts) {
        if (aborted) break;
        const streamId = takeStreamId();
        // Subscribe BEFORE asking, or the first frames arrive with nobody
        // listening and the start of the sentence is simply missing.
        const unsubscribe = worker.on((frame) => {
          if (frame.kind === KIND_PCM && frame.streamId === streamId && !aborted) {
            res.write(Buffer.from(frame.pcm));
          }
        });
        try {
          const r = await worker.request(
            { op: 'ttsStream', streamId, text: part, referenceWav: voice.path, speed, numSteps, seed, temperature },
            { timeoutMs: 300_000 },
          );
          if (!r.ok) {
            console.warn(`[voice] read-aloud failed: ${r.reason} ${r.detail ?? ''}`);
            if (FATAL_TTS_REASONS.has(r.reason)) break;
            continue;
          }
          if (r.runaway) console.warn(`[voice] read-aloud truncated part (runaway cap) after ${r.durationSec ?? '?'}s — the tail was cut`);
          if (Number(r.longestSilenceSec) >= 3) {
            console.warn(`[voice] read-aloud went silent for ${r.longestSilenceSec}s inside a ${r.durationSec}s render (${part.length} chars). Re-run with PF_TTS_DEBUG=1 to log which sentence.`);
          }
          captureUnsupported(r);
        } finally { unsubscribe(); }
      }
    } else {
      // ── Built-in engine: buffered self-healing ──────────────────────────
      // Small units, so an early-EOS drop is a large, detectable fraction of
      // the unit. Each is generated to a full clip, checked, and re-spoken (a
      // perturbed seed breaks the deterministic early stop) before any of its
      // audio is written — so no sentence vanishes and nothing is heard twice.
      // Costs a small delay before the first words; buys completeness. The loop
      // itself lives in voice-generation.js so it can be tested without an
      // engine; here we just wire it to the worker.
      const baseSeed = Number.isFinite(Number(seed)) ? Number(seed) : DEFAULT_TTS_SEED;
      const units = held.parts.flatMap((p) => splitForUtterances(p, { targetChars: SMALL_UTTERANCE_CHARS }));

      const summary = await speakUnitsSelfHealing(units, {
        speed, baseSeed,
        isAborted: () => aborted,
        isFatal: (reason) => FATAL_TTS_REASONS.has(reason),
        splitToSentences: (t) => splitForSpeech(t, { maxChars: MAX_CHAR_IN_SENTENCE - 20, minChars: 1 }),
        generate: async (text, useSeed) => {
          const r = await worker.request(
            { op: 'tts', text, referenceWav: voice.path, speed, numSteps, seed: useSeed, temperature, minChars: text.length },
            { timeoutMs: 300_000 },
          );
          if (!r.ok) { console.warn(`[voice] read-aloud failed: ${r.reason} ${r.detail ?? ''}`); return r; }
          captureUnsupported(r);
          return r;
        },
        emit: (samples) => { if (samples?.length && !aborted) res.write(floatToPcm16(samples)); },
      });

      if (summary.droppedSentences > 0) {
        console.warn(`[voice] read-aloud: ${summary.droppedSentences} sentence(s) stayed short after retries (of ${units.length} units, ${summary.reSpoken} re-spoken). Re-run with PF_TTS_DEBUG=1 to see which.`);
      }
    }
  } catch (err) {
    console.warn(`[voice] read-aloud stream error: ${String(err?.message ?? err)}`);
  }
  res.end();
});

app.get('/api/voice/clips', async (req, res) => {
  try {
    const features = await cachedFeatures(__dirname);
    const out = listClips({
      rootDir: __dirname,
      features,
      source: req.query.source || null,
      // 'best', not 'original'.
      //
      // ⚠️ This defaulted to 'original', which quietly undid the whole reason
      // `preferEnhanced` exists. The curated shortlist has the enhanced cut
      // baked into each entry, so the ten offered voices were fine — but a ward
      // who browsed the other 736 was handed the un-enhanced recording, which
      // is audibly muffled and was the exact complaint that started the
      // enhanced investigation. `listClips` had the right default; this line
      // overrode it.
      variant: req.query.variant || 'best',
      shortlist: req.query.shortlist === '1',
      q: req.query.q || '',
      sort: req.query.sort || 'source',
      limit: Math.max(1, Math.min(200, Number(req.query.limit) || 60)),
      offset: Math.max(0, Number(req.query.offset) || 0),
    });
    res.json({ ok: true, ...out });
  } catch (err) {
    res.json({ ok: false, error: String(err?.message ?? err) });
  }
});

/**
 * Choose the voice I speak in.
 *
 * The picker could audition 746 clips and commit to none of them —
 * `installVoice` existed with tests and NO caller, so every preview was a
 * dead end. This is the step that was missing.
 *
 * Two things happen, in this order, because either alone is a broken promise:
 *   1. the clip is fetched and checksum-verified, so the choice exists on disk
 *   2. only then is the setting written, so a saved choice always resolves
 *
 * Writing the setting first would leave a Familiar pointed at a voice it does
 * not have — silently falling back forever while the picker showed a tick.
 */
app.post('/api/voice/choose', async (req, res) => {
  const key = String(req.body?.key ?? '');
  if (!key) return badRequest(res, 'key (a catalogue voice key) is required');

  // The bundled default is already on disk and has no catalogue install path.
  if (key !== DEFAULT_VOICE.key) {
    const installed = await installVoice({ rootDir: __dirname, key });
    if (!installed.ok) {
      return res.json({ ok: false, reason: installed.reason, detail: installed.detail });
    }
  }

  let saved;
  try {
    const prior = (() => { try { return readSettingsSync() || {}; } catch { return {}; } })();
    const next = { ...prior, voiceTts: { ...(prior.voiceTts ?? {}), voice: key } };
    await withLock(SETTINGS_FILE, async () => {
      const tmp = SETTINGS_FILE + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
      await fsp.rename(tmp, SETTINGS_FILE);
    });
    saved = next.voiceTts.voice;
  } catch (err) {
    return res.json({ ok: false, reason: 'save-failed', detail: String(err?.message ?? err) });
  }

  // Confirm by RESOLVING, not by echoing what we just wrote. The whole point
  // is that a chosen voice is one I can actually open.
  const voice = await resolveVoice({ rootDir: __dirname, settings: readSettingsSync() || {} });
  res.json({
    ok: true,
    chosen: saved,
    speaking: voice.key,
    fellBackFrom: voice.fellBackFrom ?? null,
    reason: voice.reason ?? null,
  });
});

/**
 * Keep a voice clip my human handed me, and speak in it.
 *
 * ⚠️ `saveWardVoice` shipped with tests and NO caller — the same shape as
 * `installVoice` before it, in the same file, which is embarrassing enough to
 * write down. The README promises "you can also give your Familiar a voice clip
 * of your own — one that means something to you", and until this endpoint
 * existed that promise had no path through the app at all.
 *
 * The clip lands in `voices/ward/`, which is gitignored on purpose: it may be
 * someone else's copyrighted performance, and personal use is theirs to make
 * while redistribution is not. `mayLeaveTheMachine()` fails closed for it and
 * `redactForSharing` keeps it out of every shared surface.
 *
 * Choosing it is the same two-step as any other voice — the file exists before
 * the setting points at it, never the other way round.
 */
app.post('/api/voice/ward-voice', express.raw({ type: 'audio/*', limit: '25mb' }), async (req, res) => {
  if (VOICE_HARD_DISABLED) return res.json({ ok: false, reason: 'voice-disabled' });
  const name = String(req.query?.name ?? '').trim();
  const saved = await saveWardVoice({ rootDir: __dirname, name, bytes: req.body });
  if (!saved.ok) return res.status(400).json(saved);

  // Measured the same way every other clip is, so the picker can say what it
  // sounds like instead of showing a filename and hoping.
  let measured = null;
  try { measured = measureVoiceClip(req.body); } catch { /* a clip that won't measure still works */ }

  const chose = req.query?.choose !== '0';
  if (chose) {
    try {
      const prior = JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8').catch(() => '{}'));
      const merged = mergeSettings(prior, { voiceTts: { ...(prior.voiceTts ?? {}), voice: saved.key } });
      await fsp.writeFile(SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf8');
    } catch (err) {
      return res.json({ ...saved, chosen: false, error: `saved, but could not select it: ${err.message}` });
    }
  }
  res.json({ ...saved, chosen: chose, measurement: measured?.ok ? measured : null });
});

/** What is already on this machine, so the picker can mark it. */
app.get('/api/voice/local', async (_req, res) => {
  try { res.json({ ok: true, ...(await listLocalVoices(__dirname)) }); }
  catch (err) { res.json({ ok: false, error: String(err?.message ?? err) }); }
});

app.get('/api/voice/clips/summary', async (_req, res) => {
  try { res.json({ ok: true, ...(await catalogueSummary(__dirname)) }); }
  catch (err) { res.json({ ok: false, error: String(err?.message ?? err) }); }
});

// Measure one clip on demand — fetched, checksum-verified, measured, cached.
app.post('/api/voice/clips/measure', async (req, res) => {
  const key = typeof req.body?.key === 'string' ? req.body.key : '';
  if (!key) return badRequest(res, 'key is required');
  try { res.json(await measureClip({ rootDir: __dirname, key })); }
  catch (err) { res.json({ ok: false, reason: 'failed', detail: String(err?.message ?? err) }); }
});

app.post('/api/diagnostics/voice-bench/cancel', (_req, res) => res.json({ ok: true, ...cancelBenchmark() }));
app.post('/api/diagnostics/voice-bench/reset',  (_req, res) => res.json({ ok: true, ...resetBenchmark() }));

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

// POST /api/log — create or overwrite a session log file.
// Merges with any existing log using message IDs so that two devices
// sharing the same session (auto-sync) don't clobber each other's
// messages. Messages without an id field (old-format logs) are treated
// as a stable common prefix; only id-carrying messages are diffed.
app.post('/api/log', async (req, res) => {
  const { sessionId, startedAt, endedAt, provider, model, messages } = req.body;
  if (!isValidSessionId(sessionId))
    return res.status(400).json({ error: 'Invalid session ID.' });
  if (!Array.isArray(messages))
    return res.status(400).json({ error: 'messages must be an array.' });

  const logPath = path.join(LOGS_DIR, `${sessionId}.json`);

  // Merge: keep any server-side messages the client doesn't have.
  // Uses the `id` field when present; falls back to last-writer-wins
  // for legacy messages without ids (they form a shared prefix).
  let finalMessages = messages;
  try {
    const existing = JSON.parse(await fsp.readFile(logPath, 'utf8'));
    if (Array.isArray(existing.messages) && existing.messages.length > 0) {
      const clientIdSet = new Set(messages.filter(m => m.id).map(m => m.id));
      const serverOnly  = existing.messages.filter(m => m.id && !clientIdSet.has(m.id));
      if (serverOnly.length > 0) {
        // Interleave server-only messages in timestamp order.
        const merged = [...messages];
        for (const msg of serverOnly) {
          const msgTs = msg.timestamp ? new Date(msg.timestamp).getTime() : Infinity;
          let insertAt = merged.length;
          for (let i = merged.length - 1; i >= 0; i--) {
            const mTs = merged[i].timestamp ? new Date(merged[i].timestamp).getTime() : Infinity;
            if (mTs <= msgTs) break;
            insertAt = i;
          }
          merged.splice(insertAt, 0, msg);
        }
        finalMessages = merged;
      }
    }
  } catch { /* no existing file or corrupt — use client's messages as-is */ }

  const data = {
    sessionId, startedAt, endedAt: endedAt || null, provider, model,
    messages: finalMessages,
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
  if (!isValidSessionId(id))
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
  if (!isValidSessionId(id))
    return res.status(400).json({ error: 'Invalid session ID.' });
  try {
    await fsp.unlink(path.join(LOGS_DIR, `${id}.json`));
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Session not found.' });
  }
});

// GET /api/active-session — most recently updated session (metadata only).
// The client calls this on startup to auto-resume if a newer session is on
// the server than what's in the local browser. Returns null when no logs exist.
app.get('/api/active-session', async (_req, res) => {
  try {
    const files = await fsp.readdir(LOGS_DIR);
    let best = null;
    let bestTs = '';
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw  = await fsp.readFile(path.join(LOGS_DIR, f), 'utf8');
        const { sessionId, startedAt, endedAt, updatedAt, messages } = JSON.parse(raw);
        const ts   = updatedAt || startedAt || '';
        if (ts > bestTs) {
          bestTs = ts;
          best   = { sessionId, startedAt, endedAt: endedAt || null, updatedAt: ts,
            messageCount: Array.isArray(messages) ? messages.length : 0 };
        }
      } catch { /* skip corrupt */ }
    }
    res.json(best);
  } catch {
    res.json(null);
  }
});

// GET /api/triage-events — return triage decision log (newest first).
// Each entry is one JSON line from triage-events.jsonl: timestamp, tier,
// silence duration, decision, and whether the Familiar acted.
// Useful for auditing past reach-outs and debugging the triage loop.
app.get('/api/triage-events', async (_req, res) => {
  try {
    res.json(await readTriageEvents());
  } catch {
    res.json([]);
  }
});

// Warm reach-out decision log (mirror of /api/triage-events): every LLM
// deliberation — including "wait" — with its reasoning surface, so "he
// never reaches out" is auditable instead of a black box.
app.get('/api/reachout-events', async (_req, res) => {
  try {
    res.json(await readReachoutEvents());
  } catch {
    res.json([]);
  }
});

// Noticing decision log (Initiative Pass 4): every tick that reached a
// decision — including quiet-window evaluations that spent no LLM call — so a
// dead noticing loop reads as stale entries, never as calm silence.
app.get('/api/noticing-events', async (_req, res) => {
  try { res.json(await readNoticingEvents()); }
  catch { res.json([]); }
});

// The Familiar's rounds (Initiative Pass 3): the ward-facing view of the
// Familiar's standing rounds, honouring the Familiar's own visibility choice. A private
// round is COUNTED (hidden_count) but its contents withheld — existence is
// never hidden (no covert cognition), only what a private round is.
app.get('/api/rounds', async (_req, res) => {
  try {
    res.json(await roundsForWard());
  } catch {
    res.json({ ok: false, rounds: [], hidden_count: 0, visibility: 'shared' });
  }
});

// ── Locations (Weather sense, W-A) ───────────────────────────────
// The ward's places, LABEL-ONLY over these endpoints (coordinates never
// leave the geocode preview + the add call). Adding or switching the current
// place forces a weather refresh so the [Now] line updates promptly.

app.get('/api/locations', async (_req, res) => {
  try { res.json(await listLocations()); }
  catch { res.json({ ok: false, locations: [] }); }
});

// Preview a city/ZIP → resolved place name + coords, for the ward to confirm
// before it's stored. The coords are returned so the confirm POST can carry
// them back without a second geocode.
app.post('/api/locations/geocode', async (req, res) => {
  const query = String(req.body?.query ?? '').trim();
  if (!query) return res.status(400).json({ ok: false, error: 'query required' });
  try { res.json(await geocode(query)); }
  catch (err) { res.status(500).json({ ok: false, error: err?.message ?? 'geocode failed' }); }
});

app.post('/api/locations', async (req, res) => {
  const { label, lat, lon, place_name, timezone } = req.body ?? {};
  if (!label || typeof label !== 'string' || !label.trim()) {
    return res.status(400).json({ ok: false, error: 'label required' });
  }
  try {
    const r = await addLocation({ label: label.trim(), lat, lon, place_name, timezone });
    refreshWeatherIfDue({ force: true }).catch(() => {});
    res.json(r);
  } catch (err) { res.status(500).json({ ok: false, error: err?.message ?? 'add failed' }); }
});

app.post('/api/locations/current', async (req, res) => {
  const ident = String(req.body?.ident ?? '').trim();
  if (!ident) return res.status(400).json({ ok: false, error: 'ident required' });
  try {
    const r = await setCurrentLocation({ ident });
    refreshWeatherIfDue({ force: true }).catch(() => {});
    res.json(r);
  } catch (err) { res.status(500).json({ ok: false, error: err?.message ?? 'set-current failed' }); }
});

app.delete('/api/locations/:id', async (req, res) => {
  try {
    const r = await deleteLocation({ ident: req.params.id });
    refreshWeatherIfDue({ force: true }).catch(() => {});
    res.json(r);
  } catch (err) { res.status(500).json({ ok: false, error: err?.message ?? 'delete failed' }); }
});

// Reflection heartbeat log (temporal-bridges Piece 5): every reflection tick
// that ran, with its grade counts (incl. all-zero) — so "the learning loop
// never fires" is visible instead of silently indistinguishable from calm.
app.get('/api/reflection-events', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 50));
    res.json(await readReflectionEvents({ limit }));
  } catch {
    res.json([]);
  }
});

// Villager-write audit trail (Discord tools). Every state-mutating tool a
// villager triggered through the Familiar, with who caused it — so a
// villager-driven write is auditable, not silent.
app.get('/api/discord-writes', async (_req, res) => {
  try {
    const { readDiscordWrites } = await import('./discord-write-log.js');
    res.json(await readDiscordWrites({ limit: 200 }));
  } catch {
    res.json([]);
  }
});

// ── Media (vision build spec §2) ──────────────────────────────────
// Image bytes ride their OWN raw body parser (like /api/import-logs' json
// override) so the global 4 MB JSON limit never sees base64 and image bytes
// never touch JSON.parse. The browser downscales before upload (§4), so a
// typical payload is well under 1 MB; the 12 MB limit is headroom.
function visionDisabled() {
  if (process.env.PROTO_FAMILIAR_VISION_DISABLED === '1') return true;
  try { return readSettingsSync()?.visionEnabled === false; } catch { return false; }
}

// Image→threat scoring gate (§15.1, ward-signed). ON by default (the ward opted
// in) whenever vision is on; its own hard off-switch so it can be silenced
// without disabling sight. Follows the threat detector's own off-switch too —
// if the ward silenced threat entirely, images don't reopen it.
function visionThreatScoringOn() {
  if (process.env.PROTO_FAMILIAR_VISION_THREAT_DISABLED === '1') return false;
  if (process.env.PROTO_FAMILIAR_THREAT_DISABLED === '1') return false;
  if (visionDisabled()) return false;
  try { return readSettingsSync()?.visionThreatScoring !== false; } catch { return true; }
}

// Images and voice notes come in the same door, because they are the same
// store: same content-addressing, same audience tag, same slug ids. What
// differs is which consent governs them — seeing vs hearing — so the gate is
// picked from the kind rather than assumed.
app.post('/api/media', express.raw({ type: ['image/*', 'audio/*'], limit: '30mb' }), async (req, res) => {
  const buffer = req.body;
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return res.status(400).json({ error: 'No bytes received (send a raw image/* or audio/* body).' });
  }
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
  const kind = mediaKindFor(mime);
  if (!kind) {
    return res.status(415).json({ error: `Unsupported media type "${mime || '(none)'}". Allowed: ${Object.keys(MEDIA_KINDS).join(', ')}.` });
  }
  if (kind === 'image' && visionDisabled()) {
    return res.status(403).json({ error: 'Vision is turned off right now.' });
  }
  if (kind === 'audio' && VOICE_HARD_DISABLED) {
    return res.status(403).json({ error: 'Voice is turned off right now.' });
  }
  const q = req.query || {};
  const meta = await saveAsset({
    buffer,
    mime,
    label: typeof q.label === 'string' ? q.label : '',
    audienceTag: 'ward-private',   // web-chat uploads are always the ward's own
    origin: { surface: 'web', sessionId: typeof q.sessionId === 'string' ? q.sessionId : null, speaker: null },
  });
  if (meta?.ok === false) return res.status(400).json({ error: meta.error });
  res.json(meta);
});

// Stream bytes for a UI thumbnail (accepts slug or sha). Behind the same
// loopback/Tailscale gate as every endpoint.
app.get('/api/media/:id', async (req, res) => {
  const got = await getAsset(req.params.id);
  if (got?.ok === false) return res.status(404).json({ error: 'Not found.' });
  res.setHeader('Content-Type', got.meta.mime);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable'); // content-addressed → safe forever
  res.send(got.buffer);
});

// Ward-facing inventory + removal.
app.get('/api/media', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100));
    res.json(await listAssets({ limit }));
  } catch { res.json([]); }
});

app.delete('/api/media/:id', async (req, res) => {
  const r = await deleteAsset(req.params.id);
  if (r?.ok === false) return res.status(404).json(r);
  res.json(r);
});

// Picture→node linking (§6.5): the ward tags an image to a graph node it
// depicts (a photo of Milkyway → the Milkyway node). Ward-facing (behind the
// loopback/Tailscale gate); the graph-node search endpoint above supplies the
// node id. Graduates the description onto the node when both exist.
app.post('/api/media/:id/link', async (req, res) => {
  const { nodeId, label, kind } = req.body || {};
  const r = await addAssetLink(req.params.id, { nodeId, label, kind, by: 'ward' });
  if (r?.ok === false) return res.status(400).json(r);
  graduateImageDescriptionToNode(req.params.id, String(nodeId || '').trim())
    .catch(err => console.error('[vision] node graduation failed:', err?.message ?? err));
  res.json(r);
});

app.delete('/api/media/:id/link/:nodeId', async (req, res) => {
  const r = await removeAssetLink(req.params.id, req.params.nodeId);
  if (r?.ok === false) return res.status(400).json(r);
  res.json(r);
});

/**
 * My human corrects a transcript I misheard.
 *
 * The transcript IS the content of a voice note — what I read in the turn, what
 * memorisation folds, what the slug was minted from — so a mis-hearing is wrong
 * everywhere until the person who said it can fix it.
 */
app.post('/api/media/:id/transcript', async (req, res) => {
  const r = await correctTranscript(req.params.id, req.body?.text);
  if (r?.ok === false) return res.status(r.reason === 'not-found' ? 404 : 400).json(r);
  res.json(r);
});

// Health check
app.get('/api/health',  (_req, res) => res.json({ ok: true, version: PKG_VERSION }));
app.get('/api/version', (_req, res) => res.json({ version: PKG_VERSION }));

// ── Self-update (updater.js) ────────────────────────────────────────
// Tracks whatever repo/branch this install came from (origin + checked-out
// branch), so a fork updates from the fork and an upstream clone from upstream —
// no code change when the ward moves between them. A background check keeps the
// UI's indicator live; /api/update-apply fast-forwards (restart to run it).
let _updateStatus = { ok: false, checkedAt: 0 };   // cached; polled by the UI
const UPDATE_CHECK_MS = 30 * 60_000;

async function refreshUpdateStatus() {
  try { _updateStatus = await checkForUpdate(); }
  catch (e) { _updateStatus = { ok: false, error: e?.message ?? String(e), checkedAt: Date.now() }; }
  if (_updateStatus.updateAvailable) {
    console.log(`[update] newer version on ${_updateStatus.repo}@${_updateStatus.branch}: `
      + `${_updateStatus.remote?.version ?? '?'} (you're on ${_updateStatus.current?.version}).`);
  }
  return _updateStatus;
}

app.get('/api/update-status', (_req, res) => res.json(_updateStatus));
app.post('/api/update-check', async (_req, res) => {
  try { res.json(await refreshUpdateStatus()); }
  catch (err) { res.status(500).json({ ok: false, error: err?.message ?? String(err) }); }
});
app.post('/api/update-apply', async (_req, res) => {
  try {
    const r = await applyUpdate();
    if (r.ok) _updateStatus = { ..._updateStatus, updateAvailable: false, behind: 0, applied: true, appliedVersion: r.version, checkedAt: Date.now() };
    res.json(r);
  } catch (err) { res.status(500).json({ ok: false, error: err?.message ?? String(err) }); }
});

// ── Provider model listing ──────────────────────────────────────
// Backs the Connections modal's visible model browser: proxies the
// provider's own GET /models so the ward can SEE what their key can
// use instead of guessing model names (docs/ui-ux-guidelines.md).
// POST (not GET) because the API key rides in the body, never a URL.
app.post('/api/models', async (req, res) => {
  const { provider, apiKey } = req.body ?? {};
  if (!provider || typeof provider !== 'string') return badRequest(res, 'provider (string) is required');
  if (!apiKey || typeof apiKey !== 'string') return badRequest(res, 'apiKey (string) is required');
  try { res.json(await listProviderModels({ provider, apiKey })); }
  catch (err) { res.status(500).json({ ok: false, error: err?.message ?? String(err) }); }
});

// ── OpenAI/SillyTavern compatibility endpoints ───────────────
// Accept OpenAI-style routes so external clients (including SillyTavern)
// can use Proto-Familiar as a drop-in base URL.

function bearerTokenFromReq(req) {
  const auth = String(req.get('authorization') || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || '';
}

function resolveCompatConnection(req, body = {}) {
  const s = readSettingsSync() || {};
  const primary = primaryConnectionFrom(s);
  const providerFromBody = (typeof body.provider === 'string' && PROVIDER_URLS[body.provider])
    ? body.provider
    : '';
  const provider = providerFromBody || primary?.provider || s.provider || 'nanogpt';
  const apiKeyFromBody = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const apiKey = bearerTokenFromReq(req) || apiKeyFromBody || primary?.apiKey || s.apiKey || '';
  const modelFromBody = typeof body.model === 'string' ? body.model.trim() : '';
  const model = modelFromBody || primary?.model || s.model || '';
  return { provider, apiKey, model };
}

function completionPromptToMessages(prompt) {
  if (typeof prompt === 'string' && prompt.trim()) {
    return [{ role: 'user', content: prompt }];
  }
  if (Array.isArray(prompt)) {
    const joined = prompt
      .map(p => (typeof p === 'string' ? p : ''))
      .filter(Boolean)
      .join('\n\n');
    if (joined.trim()) return [{ role: 'user', content: joined }];
  }
  return null;
}

async function proxyChatViaApiChat(req, res, body) {
  let upstream;
  try {
    upstream = await fetch(`http://127.0.0.1:${PORT}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return res.status(502).json({ error: `Network error reaching /api/chat: ${err.message}` });
  }

  const ct = upstream.headers.get('content-type') || 'application/json';
  res.status(upstream.status);
  res.setHeader('Content-Type', ct);
  if (!body.stream || !upstream.body) {
    const text = await upstream.text();
    return res.send(text);
  }

  // Stream passthrough for /v1/chat/completions.
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch { /* passthrough interrupted */ }
  return res.end();
}

app.post('/v1/chat/completions', async (req, res) => {
  const body = req.body || {};
  const { provider, apiKey, model } = resolveCompatConnection(req, body);
  const messages = Array.isArray(body.messages)
    ? body.messages
    : completionPromptToMessages(body.prompt);
  if (!Array.isArray(messages) || messages.length === 0) {
    return badRequest(res, 'messages (array) or prompt (string/array) is required');
  }
  if (!PROVIDER_URLS[provider]) return badRequest(res, `Unknown provider: ${provider}`);
  if (!apiKey) return badRequest(res, 'API key is required (Bearer token or saved connection key).');
  if (!model) return badRequest(res, 'Model is required (request body or saved connection model).');

  const payload = {
    provider,
    apiKey,
    model,
    messages,
    stream: !!body.stream,
    enrich: false,
  };
  if (typeof body.temperature === 'number') payload.temperature = body.temperature;
  if (typeof body.max_tokens === 'number') payload.max_tokens = body.max_tokens;
  if (Array.isArray(body.tools)) payload.tools = body.tools;
  if (body.tool_choice !== undefined) payload.tool_choice = body.tool_choice;

  return proxyChatViaApiChat(req, res, payload);
});

app.post('/v1/completions', async (req, res) => {
  const body = req.body || {};
  const { provider, apiKey, model } = resolveCompatConnection(req, body);
  const messages = completionPromptToMessages(body.prompt);
  if (!messages) return badRequest(res, 'prompt (string/array) is required');
  if (!PROVIDER_URLS[provider]) return badRequest(res, `Unknown provider: ${provider}`);
  if (!apiKey) return badRequest(res, 'API key is required (Bearer token or saved connection key).');
  if (!model) return badRequest(res, 'Model is required (request body or saved connection model).');

  // Streaming text-completions are translated from chat SSE deltas.
  if (body.stream) {
    let upstream;
    try {
      upstream = await fetch(`http://127.0.0.1:${PORT}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey, model, messages, stream: true, enrich: false }),
      });
    } catch (err) {
      return res.status(502).json({ error: `Network error reaching /api/chat: ${err.message}` });
    }

    if (!upstream.ok || (upstream.headers.get('content-type') || '').includes('application/json')) {
      const text = await upstream.text();
      return res.status(upstream.status).type('application/json').send(text);
    }

    const completionId = `cmpl-${randomUUID()}`;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') {
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          let evt;
          try { evt = JSON.parse(raw); } catch { continue; }
          const delta = evt?.choices?.[0]?.delta?.content;
          const finishReason = evt?.choices?.[0]?.finish_reason ?? null;
          if (typeof delta !== 'string' && finishReason == null) continue;
          const out = {
            id: completionId,
            object: 'text_completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              text: typeof delta === 'string' ? delta : '',
              index: 0,
              logprobs: null,
              finish_reason: finishReason,
            }],
          };
          res.write(`data: ${JSON.stringify(out)}\n\n`);
        }
      }
    } catch { /* interrupted stream */ }
    return res.end();
  }

  // Non-stream text completion translates one chat completion response.
  let upstream;
  try {
    upstream = await fetch(`http://127.0.0.1:${PORT}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        apiKey,
        model,
        messages,
        stream: false,
        enrich: false,
        ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
        ...(typeof body.max_tokens === 'number' ? { max_tokens: body.max_tokens } : {}),
      }),
    });
  } catch (err) {
    return res.status(502).json({ error: `Network error reaching /api/chat: ${err.message}` });
  }
  const text = await upstream.text();
  if (!upstream.ok) {
    return res.status(upstream.status).type('application/json').send(text);
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { return res.status(502).json({ error: 'Upstream /api/chat returned non-JSON.' }); }
  const answer = parsed?.choices?.[0]?.message?.content ?? '';
  const finishReason = parsed?.choices?.[0]?.finish_reason ?? 'stop';
  return res.json({
    id: parsed?.id || `cmpl-${randomUUID()}`,
    object: 'text_completion',
    created: parsed?.created || Math.floor(Date.now() / 1000),
    model,
    choices: [{ text: answer, index: 0, logprobs: null, finish_reason: finishReason }],
    ...(parsed?.usage ? { usage: parsed.usage } : {}),
  });
});

async function compatModelsHandler(req, res) {
  const body = req.body || {};
  const { provider, apiKey } = resolveCompatConnection(req, body);
  if (!PROVIDER_URLS[provider]) return badRequest(res, `Unknown provider: ${provider}`);
  if (!apiKey) return badRequest(res, 'API key is required (Bearer token or saved connection key).');

  const listed = await listProviderModels({ provider, apiKey });
  if (!listed?.ok) return res.status(502).json({ error: listed?.error || 'failed to list models' });
  return res.json({
    object: 'list',
    data: (listed.models || []).map(m => ({
      id: m.id,
      object: 'model',
      created: 0,
      owned_by: 'proto-familiar',
    })),
  });
}

app.get('/v1/models', compatModelsHandler);
app.post('/v1/models', compatModelsHandler);
app.get('/v1/model', compatModelsHandler);

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
        const { id, name, description, enabled, entries, graduationExempt } = JSON.parse(raw);
        if (!id) continue; // not a tome (no id) — skip rather than poison the registry
        tomes.push({ id, name, description, enabled, graduationExempt: graduationExempt === true, entryCount: Object.keys(entries ?? {}).length });
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
        if (!isValidEntryUid(uid)) continue;
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
      if (req.body.graduationExempt !== undefined) tome.graduationExempt = !!req.body.graduationExempt;
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
  if (!isValidEntryUid(uid)) return res.status(400).json({ error: 'Invalid entry UID.' });
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

// Add a single entry to the default (first enabled) tome. Shared by the
// POST /api/tomes/default/entries route and the save_to_tome tool executor
// (handed to cerebellum via initCerebellumTools at boot — cerebellum never
// imports server.js).
async function addDefaultTomeEntry({ comment, content, keys, learnedAt }) {
  // Accept keys as string[] or comma-separated string
  let normKeys = [];
  if (Array.isArray(keys)) {
    normKeys = keys.map(k => String(k).trim()).filter(Boolean);
  } else if (typeof keys === 'string') {
    normKeys = keys.split(',').map(k => k.trim()).filter(Boolean);
  }

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
  return { tomeId: targetTomeId, uid };
}

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
  try {
    const { tomeId, uid } = await addDefaultTomeEntry({ comment, content, keys, learnedAt });
    res.json({ ok: true, tomeId, uid });
  } catch {
    res.status(500).json({ error: 'Failed to save entry.' });
  }
});

// Hand the tome-storage capability + Village read/write to cerebellum's
// executors. Village mutations from the tool path push through the same
// write-through sync wired in startVillageSync() (mirror → Phylactery).
initCerebellumTools({
  addDefaultTomeEntry,
  getVillageRegistry,
  upsertVillager,
  relayToDiscord,
  memorizeSessionNow,
  // set_current_location warms the new place's sky right away (fire-and-forget).
  refreshWeatherNow: () => { refreshWeatherIfDue({ force: true }).catch(() => {}); },
});

// Backs the Familiar's `memorize_now` tool: commit THIS conversation to memory
// on demand, instead of waiting for a session rollover that may never cleanly
// happen (the human switches sessions, clears history, etc.). Reads the clean
// session log off disk — kept current by the client's per-message saveToServer —
// and enqueues the same extraction pipeline the rollover uses, so the facts land
// at the right tier, consent-gated and dedup'd. Function declaration so it can be
// referenced in the initCerebellumTools call above (hoisted). Degrades to a
// structured result; never throws into the tool loop.
async function memorizeSessionNow({ sessionId, provider, apiKey, model, audienceTag }) {
  if (!isValidSessionId(sessionId)) return { ok: false, error: 'no-session' };
  let log;
  try {
    log = JSON.parse(await fsp.readFile(path.join(LOGS_DIR, `${sessionId}.json`), 'utf8'));
  } catch {
    return { ok: false, error: 'no-log' };
  }
  const messages = Array.isArray(log?.messages) ? log.messages : [];
  const readable = messages.filter(m =>
    (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim());
  if (readable.length < 2) return { ok: false, error: 'too-short' };
  try {
    // Day-anchored: segments the session by date and enqueues the missing
    // slices (skips dates already memorized per the coverage ledger).
    const { enqueued, skipped } = await enqueueSessionByDay({
      sessionId, messages,
      provider: provider ?? log.provider, apiKey, model: model ?? log.model,
      audienceTag: audienceTag ?? 'ward-private',
    });
    return { ok: true, enqueued, skipped, messageCount: readable.length };
  } catch (err) {
    return { ok: false, error: err?.message ?? 'enqueue-failed' };
  }
}

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
  const { sessionId, scope, topicId, topicLabel, messageRange, messages, provider, apiKey, model, audienceTag } = body;
  if (!isValidSessionId(sessionId))
    return res.status(400).json({ error: 'Invalid session ID.' });
  try {
    if (scope === 'topic') {
      // Topic-scoped memorization stays whole-range (one summary of a slice).
      const { jobId, deduped } = await enqueueMemorization({
        sessionId, scope, topicId, topicLabel, messageRange, messages, provider, apiKey, model, audienceTag,
      });
      res.status(202).json({ jobId, deduped });
    } else {
      // Session scope is day-anchored: one job per calendar date the session
      // touched, skipping date-slices already memorized (the coverage ledger).
      const r = await enqueueSessionByDay({ sessionId, messages, provider, apiKey, model, audienceTag });
      res.status(202).json(r);
    }
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

// GET /api/memory-coverage — per-day memorization coverage for the calendar.
// Computed live from the session logs + the coverage ledger; no message content.
app.get('/api/memory-coverage', async (_req, res) => {
  try { res.json(await computeCoverage()); }
  catch { res.json({ tz: 'local', days: {} }); }
});

// GET /api/memory-health — is semantic dedup live, or degraded to the lexical
// fallback (embedder / sqlite-vec unavailable)? Lets the ward SEE why the
// consent queue might be piling up instead of it failing silently.
app.get('/api/memory-health', async (_req, res) => {
  try { res.json(await getMemoryHealth()); }
  catch (err) { res.json({ ok: false, healthy: null, dedup_mode: 'unknown', error: err?.message ?? String(err) }); }
});

// GET /api/memory-granularity — read-only audit of which memories the tier
// ladder can't consolidate (non-ISO date_key from the entity-core migration).
// Diagnostic only; mutates nothing. Lets the ward SEE the mislabeled rows
// before any heal is chosen.
app.get('/api/memory-granularity', async (_req, res) => {
  try { res.json(await getMemoryGranularityAudit()); }
  catch (err) { res.json({ ok: false, error: err?.message ?? String(err) }); }
});

// POST /api/memory-backfill — embed any memories missing a vector (the
// migration gap), so semantic dedup can see them. Idempotent; also runs
// automatically at boot when a gap is detected.
app.post('/api/memory-backfill', async (_req, res) => {
  try { res.json(await backfillMemoryEmbeddings()); }
  catch (err) { res.json({ ok: false, embedded: 0, error: err?.message ?? String(err) }); }
});

// POST /api/memorize-day — (re)feed every session's slice for one calendar date.
// Skips slices already memorized unless `force`. Client supplies the creds, same
// as POST /api/memorize.
app.post('/api/memorize-day', async (req, res) => {
  const { date, force, provider, apiKey, model } = req.body ?? {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return res.status(400).json({ error: 'Invalid date (YYYY-MM-DD).' });
  if (!provider || !apiKey || !model) return res.status(400).json({ error: 'provider, apiKey, and model are required.' });
  try {
    const slices = await collectDateSlices(date, { force: force === true });
    let enqueued = 0, deduped = 0;
    for (const { sessionId, audienceTag, seg } of slices) {
      try {
        const r = await enqueueMemorization({
          sessionId, scope: 'day', topicId: date,
          messageRange: { start: seg.startIdx, end: seg.endIdx },
          messages: seg.messages, provider, apiKey, model, audienceTag,
          // A forced re-memorize deliberately re-reads the whole day; otherwise
          // ingest only the un-memorized tail (the default delta behaviour).
          fullSegment: force === true,
        });
        if (r.deduped) deduped++; else enqueued++;
      } catch (err) { console.warn('[memorize-day] slice failed:', err?.message ?? err); }
    }
    res.status(202).json({ enqueued, deduped, requested: slices.length });
  } catch (err) {
    res.status(500).json({ error: err?.message ?? 'Failed to memorize day.' });
  }
});

// Parse + date-place + segment ONE log's content into per-date slices, no
// writes. Shared by the single-file and batch import endpoints so the parse /
// date / segment rules can't drift between them. Returns
// { ok, format, segs?, dates?, messageCount?, needsDate?, error? }.
function resolveImportSegs({ content, filename, fallbackDate, names }) {
  const parsed = parseImport(content, { selfNames: names });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  let messages = parsed.messages;
  // Undated log → stamp every message with one date (explicit, else filename).
  // Neither available → the caller must supply one (needsDate).
  if (!messages.some(m => m.timestamp)) {
    const explicit = (typeof fallbackDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fallbackDate)) ? fallbackDate : null;
    const date = explicit || dateFromFilename(filename);
    if (!date) return { ok: true, format: parsed.format, needsDate: true, messageCount: messages.length };
    messages = applyFallbackDate(messages, date);
  }
  const segs = segmentByDay(messages).filter(s => s.readableCount >= 2);
  if (segs.length === 0) return { ok: false, error: 'No date had enough messages to import (need ≥2 each).' };
  return { ok: true, format: parsed.format, segs, dates: segs.map(s => s.date), messageCount: segs.reduce((n, s) => n + s.count, 0) };
}

// Write each date-slice as an imported session log + enqueue it for ingestion.
// Shared commit half. Returns { created, enqueued }.
async function commitImportSegs(segs, { source, provider, apiKey, model }) {
  let created = 0, enqueued = 0;
  const tag = (typeof source === 'string' && source.trim()) ? source.trim().slice(0, 40) : 'import';
  for (const seg of segs) {
    const sessionId = sessionSlugId();
    const startedAt = seg.messages.find(m => m.timestamp)?.timestamp ?? new Date().toISOString();
    const endedAt = [...seg.messages].reverse().find(m => m.timestamp)?.timestamp ?? startedAt;
    const log = {
      sessionId, startedAt, endedAt, imported: true, source: tag,
      audienceTag: 'ward-private', messages: seg.messages,
    };
    try {
      const p = path.join(LOGS_DIR, `${sessionId}.json`);
      await fsp.writeFile(p + '.tmp', JSON.stringify(log, null, 2), 'utf8');
      await fsp.rename(p + '.tmp', p);
      created++;
    } catch (err) { console.warn('[import] write failed:', err?.message ?? err); continue; }
    try {
      const r = await enqueueMemorization({
        sessionId, scope: 'day', topicId: seg.date,
        messageRange: { start: seg.startIdx, end: seg.endIdx },
        messages: seg.messages, provider, apiKey, model, audienceTag: 'ward-private',
      });
      if (!r.deduped) enqueued++;
    } catch (err) { console.warn('[import] enqueue failed:', err?.message ?? err); }
  }
  return { created, enqueued };
}

// POST /api/import-logs — bring past conversation logs in from elsewhere.
// Two-step: without `commit` it PREVIEWS (parse + segment, no writes) so the UI
// can show the scale before spending; with `commit` it places the logs by date
// (one imported session per date) and enqueues them for immediate ingestion.
app.post('/api/import-logs', express.json({ limit: '32mb' }), async (req, res) => {
  const { content, selfNames, source, commit, provider, apiKey, model, fallbackDate, filename } = req.body ?? {};
  const names = Array.isArray(selfNames) ? selfNames
    : (typeof selfNames === 'string' ? selfNames.split(',').map(s => s.trim()).filter(Boolean) : []);

  const r = resolveImportSegs({ content, filename, fallbackDate, names });
  if (!r.ok) return res.status(400).json({ error: r.error });
  if (r.needsDate) {
    if (!commit) return res.json({ ok: true, preview: true, format: r.format, needsDate: true, messages: r.messageCount });
    return res.status(400).json({ error: 'This log has no timestamps. Provide a date (YYYY-MM-DD) for it.' });
  }

  if (!commit) {
    return res.json({ ok: true, preview: true, format: r.format, dates: r.dates, days: r.segs.length, messages: r.messageCount });
  }
  if (!provider || !apiKey || !model) {
    return res.status(400).json({ error: 'provider, apiKey, and model are required to ingest.' });
  }
  const { created, enqueued } = await commitImportSegs(r.segs, { source, provider, apiKey, model });
  res.status(202).json({ ok: true, committed: true, format: r.format, days: created, enqueued, dates: r.dates });
});

// POST /api/import-logs-batch — import many logs at once (one request). Each
// file resolves its own date (per-file fallbackDate, else its filename), so a
// folder of dated exports lands on the right days in one pass. Preview returns a
// per-file breakdown; commit ingests every file that resolved, skipping (never
// failing the whole batch on) any that need a date or didn't parse.
app.post('/api/import-logs-batch', express.json({ limit: '64mb' }), async (req, res) => {
  const { files, selfNames, source, commit, provider, apiKey, model } = req.body ?? {};
  if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ error: 'No files provided.' });
  if (files.length > 100) return res.status(400).json({ error: 'Too many files in one batch (max 100).' });
  const names = Array.isArray(selfNames) ? selfNames
    : (typeof selfNames === 'string' ? selfNames.split(',').map(s => s.trim()).filter(Boolean) : []);

  const resolved = files.map(f => ({
    filename: (typeof f?.filename === 'string' && f.filename) ? f.filename : '(pasted)',
    ...resolveImportSegs({ content: f?.content, filename: f?.filename, fallbackDate: f?.fallbackDate, names }),
  }));

  if (!commit) {
    return res.json({
      ok: true, preview: true,
      files: resolved.map(r => ({
        filename: r.filename, ok: r.ok, format: r.format ?? null,
        needsDate: !!r.needsDate, dates: r.dates ?? [],
        days: r.segs?.length ?? 0, messages: r.messageCount ?? 0, error: r.error ?? null,
      })),
    });
  }
  if (!provider || !apiKey || !model) {
    return res.status(400).json({ error: 'provider, apiKey, and model are required to ingest.' });
  }

  let totalDays = 0, totalEnqueued = 0;
  const per = [];
  for (const r of resolved) {
    if (!r.ok || r.needsDate || !r.segs) {
      per.push({ filename: r.filename, skipped: true, reason: r.needsDate ? 'needs a date' : (r.error ?? 'could not parse') });
      continue;
    }
    const { created, enqueued } = await commitImportSegs(r.segs, { source, provider, apiKey, model });
    totalDays += created; totalEnqueued += enqueued;
    per.push({ filename: r.filename, days: created, enqueued, dates: r.dates });
  }
  res.status(202).json({ ok: true, committed: true, days: totalDays, enqueued: totalEnqueued, files: per });
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

// VALID_MEMORY_GRANULARITIES / VALID_IDENTITY_CATEGORIES /
// VALID_FILENAME_RE / deriveMemorySlug are imported from cerebellum.js —
// one source of truth shared by these routes and the tool executors.

// POST /api/entity/memory — write a new memory entry to Phylactery
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
  // and Phylactery's merge step destroys them. Derive from the title
  // if the Familiar provided one, otherwise from the content's first
  // line. Last resort: a timestamp suffix so a save never silently
  // fails for lack of slugable characters.
  let slug;
  if (granularity === 'significant') {
    slug = deriveMemorySlug(title) ?? deriveMemorySlug(content) ?? `memory-${Date.now()}`;
  }

  const result = await createMemory({ content: content.trim(), granularity, date, slug });
  if (!result.ok) return res.status(502).json({ error: result.error ?? 'phylactery unavailable' });
  res.json({ ok: true });
});

// POST /api/entity/identity — append to or update a section of a Phylactery identity file
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

  if (!result.ok) return res.status(502).json({ error: result.error ?? 'phylactery unavailable' });
  res.json({ ok: true });
});

// ── Phylactery editing endpoints (Knowledge editor UI + LLM write tools) ──
//
// All destructive ops auto-snapshot on the thalamus side via snapshot_create
// before calling the Phylactery tool, so the Snapshots tab in the UI lets
// the user roll back if something goes sideways.

const VALID_GRAPH_ID_RE    = /^[\w-]{1,128}$/;
const VALID_SECTION_RE     = /^[\w\s\-()&'?!,.:/]{1,200}$/; // markdown headings — permissive but bounded
const VALID_SNAPSHOT_ID_RE = /^[\w.\-:]{1,200}$/;

function badRequest(res, message) { return res.status(400).json({ error: message }); }
function gatewayDown(res, err)    { return res.status(502).json({ error: err ?? 'phylactery unavailable' }); }

// ── Memory ────────────────────────────────────────────────────────────────
// The :date param accepts what memory_list actually returns: a plain
// date (daily/weekly/monthly/yearly) OR the composite `YYYY-MM-DD_slug`
// key that significant memories list as (one named file per milestone).
// cerebellum.parseMemoryKey splits the composite into the separate
// date + slug parameters Phylactery's read/update/delete tools expect.
app.get('/api/entity/memories', async (req, res) => {
  const { granularity, limit } = req.query;
  if (granularity && !VALID_MEMORY_GRANULARITIES.has(granularity))
    return badRequest(res, `granularity must be one of: ${[...VALID_MEMORY_GRANULARITIES].join(', ')}.`);
  const n = limit !== undefined ? Math.max(1, Math.min(100, parseInt(limit, 10) || 50)) : 50;
  try { res.json(await listMemories({ granularity, limit: n })); }
  catch (err) { gatewayDown(res, err.message); }
});

// By-id addressing — the unique handle. Registered BEFORE the /:granularity/:date
// routes so "by-id" is never swallowed as a granularity. granularity+date can't
// single out a standalone per-fact row (many share one day); the id always can.
const VALID_MEMORY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

app.get('/api/entity/memories/by-id/:id', async (req, res) => {
  const { id } = req.params;
  if (!VALID_MEMORY_ID_RE.test(id)) return badRequest(res, 'invalid id');
  try {
    const result = await readMemoryById({ id });
    if (result && result.ok === false) return res.status(404).json(result);
    res.json(result);
  } catch (err) { gatewayDown(res, err.message); }
});

app.put('/api/entity/memories/by-id/:id', async (req, res) => {
  const { id } = req.params;
  if (!VALID_MEMORY_ID_RE.test(id)) return badRequest(res, 'invalid id');
  const { content, audience, careWeight, contentTag } = req.body;
  if (content !== undefined && (typeof content !== 'string' || !content.trim())) return badRequest(res, 'content must be a non-empty string');
  if (content !== undefined && content.length > 16384)                          return badRequest(res, 'content exceeds 16 KB limit');
  if (audience !== undefined && typeof audience !== 'string')                    return badRequest(res, 'audience must be string');
  // The content tag is a machine value: the ward's edit is canonicalised in code
  // (the exact-values rule). '' clears it (→ fail-closed general:sensitive at
  // recall); a recognised topic[:level] is normalised to canonical "topic:level";
  // anything unrecognised is rejected rather than stored as junk.
  let contentTagArg;
  if (contentTag !== undefined) {
    if (typeof contentTag !== 'string') return badRequest(res, 'contentTag must be string');
    const trimmed = contentTag.trim();
    if (trimmed === '') {
      contentTagArg = '';
    } else {
      const norm = normalizeTag(trimmed);
      if (!norm) return badRequest(res, 'contentTag must be a known topic (optionally :open/:sensitive)');
      contentTagArg = `${norm.topic}:${norm.level}`;
    }
  }
  const result = await updateMemoryById({
    id,
    ...(content   !== undefined ? { content: content.trim() } : {}),
    ...(audience  !== undefined ? { audience }                : {}),
    ...(careWeight !== undefined ? { careWeight }             : {}),
    ...(contentTagArg !== undefined ? { contentTag: contentTagArg } : {}),
  });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result ?? { ok: true });
});

app.delete('/api/entity/memories/by-id/:id', async (req, res) => {
  const { id } = req.params;
  if (!VALID_MEMORY_ID_RE.test(id)) return badRequest(res, 'invalid id');
  const result = await deleteMemoryById({ id });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result ?? { ok: true });
});

app.post('/api/entity/memories/by-id/:id/move', async (req, res) => {
  const { id } = req.params;
  if (!VALID_MEMORY_ID_RE.test(id)) return badRequest(res, 'invalid id');
  const { date } = req.body;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return badRequest(res, 'date must be YYYY-MM-DD');
  const result = await moveMemoryDate({ id, date });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result ?? { ok: true });
});

app.get('/api/entity/memories/:granularity/:date', async (req, res) => {
  const { granularity, date } = req.params;
  if (!VALID_MEMORY_GRANULARITIES.has(granularity)) return badRequest(res, 'invalid granularity');
  const key = parseMemoryKey(date);
  if (!key) return badRequest(res, 'invalid date format');
  try { res.json(await readMemory({ granularity, date: key.date, slug: key.slug ?? undefined })); }
  catch (err) { gatewayDown(res, err.message); }
});

app.put('/api/entity/memories/:granularity/:date', async (req, res) => {
  const { granularity, date } = req.params;
  const { content, editedBy, audience, careWeight } = req.body;
  if (!VALID_MEMORY_GRANULARITIES.has(granularity)) return badRequest(res, 'invalid granularity');
  const key = parseMemoryKey(date);
  if (!key) return badRequest(res, 'invalid date format');
  if (typeof content !== 'string' || !content.trim()) return badRequest(res, 'content required');
  if (content.length > 16384)                       return badRequest(res, 'content exceeds 16 KB limit');
  const result = await updateMemory({
    granularity, date: key.date, slug: key.slug ?? undefined,
    content: content.trim(), editedBy,
    ...(audience   !== undefined ? { audience }   : {}),
    ...(careWeight !== undefined ? { careWeight }  : {}),
  });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result);
});

app.delete('/api/entity/memories/:granularity/:date', async (req, res) => {
  const { granularity, date } = req.params;
  if (!VALID_MEMORY_GRANULARITIES.has(granularity)) return badRequest(res, 'invalid granularity');
  const key = parseMemoryKey(date);
  if (!key) return badRequest(res, 'invalid date format');
  // An explicit ?slug= query wins over the composite key's slug (the
  // pre-0.4.1 calling convention some callers still use).
  const slug = req.query.slug || key.slug || undefined;
  const result = await deleteMemory({ granularity, date: key.date, instanceId: req.query.instanceId, slug });
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
  // need a unique filename or Phylactery's merge step destroys them.
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
// the Familiar can resolve a name ("Chen", "Milkyway") to a graph id without
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
  const { label, description, type, audience } = req.body;
  if (label !== undefined && typeof label !== 'string')             return badRequest(res, 'label must be string');
  if (description !== undefined && typeof description !== 'string') return badRequest(res, 'description must be string');
  if (type !== undefined && typeof type !== 'string')               return badRequest(res, 'type must be string');
  if (audience !== undefined && typeof audience !== 'string')        return badRequest(res, 'audience must be string');
  const result = await updateGraphNode({ id, label, description, type, audience });
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

// ── Backup / restore (Pillar H) — "back up / restore my Familiar" ───────────
// Single passphrase-encrypted file holding the whole self. The passphrase is
// never stored; a lost passphrase means an unrecoverable backup (the point of
// encryption-at-rest), which the UI must surface.
app.post('/api/entity/backup/export', async (req, res) => {
  const { passphrase } = req.body ?? {};
  if (!passphrase || typeof passphrase !== 'string' || passphrase.length < 4) {
    return badRequest(res, 'passphrase required (at least 4 characters)');
  }
  const result = await exportBackup({ passphrase });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result);
});

app.post('/api/entity/backup/restore', async (req, res) => {
  const { filePath, passphrase } = req.body ?? {};
  if (!filePath || typeof filePath !== 'string') return badRequest(res, 'filePath required');
  if (!passphrase || typeof passphrase !== 'string') return badRequest(res, 'passphrase required');
  const result = await restoreBackup({ filePath, passphrase });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result);
});

// Run one lifecycle pass on demand (hygiene + consolidation + graduation).
app.post('/api/entity/lifecycle', async (req, res) => {
  const force = req.body?.force === true;
  const result = await runLifecyclePass({ force });
  res.json(result);
});

// Ward remember-consent map — governs per-category memory storage policy.
// The GET carries the active standing-consent windows alongside the map so the
// settings panel renders both in one fetch.
app.get('/api/entity/ward/remember', async (_req, res) => {
  const map = await getRememberMap();
  if (!map) return gatewayDown(res, 'phylactery not connected');
  const standing = await getStandingConsent();
  res.json({ map, standing: standing ?? {} });
});

app.put('/api/entity/ward/remember', async (req, res) => {
  const { map } = req.body ?? {};
  if (!map || typeof map !== 'object' || Array.isArray(map))
    return badRequest(res, 'map (object) is required');
  const result = await setRememberMap(map);
  if (!result?.ok) return res.status(400).json({ error: result?.errors ?? result?.error ?? 'update failed' });
  res.json(result);
});

// Standing consent — the time-boxed "trust his judgment for a while" window for
// one category. The client names a preset duration; the server derives the
// exact epoch-ms expiry (a machine value produced by code, never typed) so the
// window's end is unambiguous and timezone-free. An empty/absent window clears.
const STANDING_WINDOW_MS = {
  '6h':  6  * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d':  7  * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};
app.put('/api/entity/ward/remember/standing', async (req, res) => {
  const { category, window } = req.body ?? {};
  if (!category || typeof category !== 'string') return badRequest(res, 'category is required');
  let until = null;
  if (window) {
    const dur = STANDING_WINDOW_MS[window];
    if (!dur) return badRequest(res, `unknown window: ${window} (use 6h/24h/7d/30d)`);
    until = Date.now() + dur;
  }
  const result = await setStandingConsent(category, until, window || '');
  if (!result?.ok) return res.status(400).json({ error: result?.error ?? 'update failed' });
  res.json(result);
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

// Resolve the fields Phylactery cares about from a settings snapshot,
// so we can tell whether a settings PUT changed any of them. Anything
// else (UI prefs, system prompts, etc.) doesn't require a Phylactery
// respawn and shouldn't trigger one.
function phylacteryCredsSnapshot(settings) {
  // phylacteryConnectionId is canonical (Pillar I); legacy entityCoreConnectionId still accepted.
  const id = settings?.phylacteryConnectionId ?? settings?.entityCoreConnectionId ?? null;
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
function phylacteryCredsEqual(a, b) {
  return a.id === b.id && a.apiKey === b.apiKey && a.provider === b.provider && a.model === b.model;
}

app.put('/api/settings', async (req, res) => {
  const { settings } = req.body ?? {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return badRequest(res, 'settings (object) is required');
  }
  // The merge lives in settings-merge.js so it can be tested — this once
  // destroyed my human's voiceTts by writing the request body wholesale, and a
  // data-loss path with no test is a data-loss path waiting for its turn.
  let prior = null;
  try { prior = JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8')); }
  catch { /* no prior settings, or unreadable — the payload stands alone */ }
  const merged = mergeSettings(prior, settings);

  let serialised;
  try { serialised = JSON.stringify(merged, null, 2); }
  catch (err) { return badRequest(res, `settings not serialisable: ${err.message}`); }
  if (serialised.length > SETTINGS_MAX_BYTES) {
    return badRequest(res, `settings exceed ${SETTINGS_MAX_BYTES}-byte limit`);
  }

  // L2 (audit): route the prior-snapshot + write through thalamus's
  // per-file lock so two PUTs racing each other can't read each
  // other's stale priorCreds and fire spurious Phylactery respawns.
  // The atomic .tmp+rename already prevented torn-file states; the
  // lock here makes the prior-vs-next diff consistent against the
  // file each PUT actually replaces.
  let priorCreds = { id: null, apiKey: '', provider: '', model: '' };
  let priorNoticingEnabled;
  try {
    await withLock(SETTINGS_FILE, async () => {
      try {
        const raw = await fsp.readFile(SETTINGS_FILE, 'utf8');
        const prior = JSON.parse(raw);
        priorCreds = phylacteryCredsSnapshot(prior);
        priorNoticingEnabled = prior?.noticingEnabled;
      } catch { /* no prior settings — first write */ }
      const tmp = SETTINGS_FILE + '.tmp';
      await fsp.writeFile(tmp, serialised, 'utf8');
      await fsp.rename(tmp, SETTINGS_FILE);
    });
  } catch (err) {
    return res.status(500).json({ error: `failed to write settings: ${err.message}` });
  }

  // If the Phylactery API-key designation changed (different connection
  // picked, or the same connection's key/provider/model edited), respawn
  // the child so it picks up the new env. Fire-and-forget so the PUT
  // returns quickly; reconnect logs itself.
  const nextCreds = phylacteryCredsSnapshot(merged);
  if (!phylacteryCredsEqual(priorCreds, nextCreds)) {
    console.log('[server] Phylactery API-key designation changed — respawning');
    reconnectPhylactery().catch(err => console.error('[server] reconnectPhylactery failed:', err.message));
  }

  // Re-enabling noticing (or leaving it on through a settings save) clears
  // the loop's self-set cooldown, so a ward who just flipped the toggle sees
  // the Familiar look around within a tick instead of waiting out a stale
  // "next check in 6h" from before the change. Cheap and safe: the loop's
  // own gates (wake conditions, threat register) still decide what happens.
  if (merged.noticingEnabled !== false && priorNoticingEnabled === false) {
    resetNoticingCooldown();
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

/**
 * `tailscale serve` — the OTHER half of remote access, and the one the phone
 * needs for a voice call.
 *
 * The toggle above only opens the access GATE (who may reach the plain-http
 * server). It does nothing about TLS. But a browser will not hand over the
 * microphone on a plain-http origin, so a phone on the tailnet can load the UI
 * and still be unable to call. `tailscale serve --bg <port>` fixes exactly that:
 * Tailscale terminates HTTPS with its own cert and proxies to our local port,
 * giving `https://<machine>.<tailnet>.ts.net/` — a secure context the mic works
 * on. This is deliberately its OWN control, not a side effect of the gate: it
 * changes outward exposure and can fail on preconditions the app cannot set.
 *
 * The one precondition the app cannot fix: HTTPS must be enabled for the tailnet
 * in the admin console. When it is not, `serve` says so and we pass that along
 * rather than pretending it worked.
 */
async function runTailscaleServe(args) {
  try {
    const { stdout, stderr } = await execFileP('tailscale', ['serve', ...args], { timeout: 8000 });
    return { ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') };
  } catch (err) {
    // A non-zero exit lands here; the reason my human needs is in stderr.
    const detail = String(err?.stderr || err?.message || err).trim();
    return { ok: false, detail, code: err?.code ?? null };
  }
}

// Turn `serve`'s terse failure into a next step. The app cannot enable tailnet
// HTTPS or grant operator rights, so when those are the blocker it must say so.
function tailscaleServeHint(detail) {
  const d = (detail || '').toLowerCase();
  if (/https|cert|not enabled|feature/.test(d)) {
    return 'HTTPS is not enabled for this tailnet. Turn it on once in the Tailscale admin console (DNS → HTTPS Certificates), then try again.';
  }
  if (/operator|permission|denied|access|sudo|root/.test(d)) {
    return 'Tailscale would not let this account run serve. Run `tailscale set --operator=$USER` once (or start the app with the right privileges), then try again.';
  }
  if (/not found|enoent|command/.test(d)) {
    return 'The Tailscale CLI was not found. Install Tailscale and sign in, then try again.';
  }
  return detail || 'tailscale serve failed.';
}

// Is our port already served over HTTPS? Parsed from `serve status --json`, best
// effort — a shape we do not recognise reads as "not serving" rather than a lie.
async function tailscaleHttpsStatus() {
  const ts = await detectTailscale();
  const url = ts?.hostname ? `https://${ts.hostname}/` : null;
  const r = await runTailscaleServe(['status', '--json']);
  if (!r.ok) return { serving: false, url: null, hostname: ts?.hostname || null, available: ts !== null };
  let serving = false;
  try {
    const j = JSON.parse(r.stdout || '{}');
    // Web config is keyed by "<host>:443"; a handler proxying to our local port
    // means we are the one being served.
    const web = j?.Web || {};
    serving = Object.values(web).some((entry) => {
      const handlers = entry?.Handlers || {};
      return Object.values(handlers).some((h) => String(h?.Proxy || '').includes(`:${PORT}`));
    });
  } catch { /* unrecognised → not serving */ }
  return { serving, url: serving ? url : null, hostname: ts?.hostname || null, available: ts !== null };
}

app.get('/api/tailscale/https', async (_req, res) => {
  res.json({ ok: true, ...(await tailscaleHttpsStatus()) });
});

app.post('/api/tailscale/https', async (_req, res) => {
  const r = await runTailscaleServe(['--bg', String(PORT)]);
  if (!r.ok) {
    return res.json({ ok: false, reason: 'serve-failed', detail: r.detail, hint: tailscaleServeHint(r.detail) });
  }
  const status = await tailscaleHttpsStatus();
  res.json({ ok: true, ...status });
});

app.delete('/api/tailscale/https', async (_req, res) => {
  // `reset` clears serve config for this node. We only ever set the one proxy,
  // so this is the honest off switch; named plainly in the UI copy.
  const r = await runTailscaleServe(['reset']);
  if (!r.ok) return res.json({ ok: false, reason: 'reset-failed', detail: r.detail, hint: tailscaleServeHint(r.detail) });
  res.json({ ok: true, serving: false, url: null });
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
  if (!isValidEntryUid(uid)) return res.status(400).json({ error: 'uid must be a valid UUID or slug uid' });
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

// Calendar export (0.8 §2.2). Streams a schedule node as a downloadable
// `.ics` so the Familiar's message can carry a real download link alongside
// the "add to Google" URL. The artifact is built in Unruh's code from the
// node's stored fields — the model never types a calendar value (§3).
app.get('/api/schedule/:id/export.ics', async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(id)) return res.status(400).json({ error: 'invalid schedule id' });
  try {
    const data = await exportSchedule({ id });
    if (!data?.ok || !data.ics) {
      return res.status(404).json({ error: data?.error || 'no exportable schedule item with that id' });
    }
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="schedule-${id.slice(0, 8)}.ics"`);
    res.send(data.ics);
  } catch (err) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

// ── Native Google Calendar OAuth (0.8.1) ────────────────────────────
// Two doors to the same token store, both UI-driven (no terminal):
//   (1) upload credentials.json → Connect → Google's Allow screen →
//       /oauth/callback captures the token (the loopback flow);
//   (2) paste a refresh token minted on Google's own side.
// Tokens live in the gitignored token store; the status surface is redacted.

// The loopback redirect must be byte-identical in the auth URL and the
// exchange. Derive it from the request host so it tracks whatever port/host
// the ward reached the UI on (a Desktop OAuth client allows any loopback).
function googleRedirectUri(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${req.get('host')}/api/gcal/oauth/callback`;
}

app.get('/api/gcal/google/status', async (_req, res) => {
  const store = await readGoogleToken();
  // sharedScope tells the UI whether a reconnect is needed to read shared
  // calendars (the widened scope). Old tokens lack it.
  res.json({ ...googlePublicStatus(store), sharedScope: hasCalendarListScope(store) });
});

// Discovered calendars (what the last sync saw) + their current attribution,
// for the calendars/attribution panel. Read-only; attribution itself is set
// through the normal settings sync (gcalCalendarAttribution) or the Familiar's
// gcal_attribute_calendar tool.
app.get('/api/gcal/calendars', async (_req, res) => {
  const cache = await readCalendarCache().catch(() => ({}));
  const cals = Array.isArray(cache?.calendars) ? cache.calendars : [];
  const s = readSettingsSync();
  const map = (s?.gcalCalendarAttribution && typeof s.gcalCalendarAttribution === 'object') ? s.gcalCalendarAttribution : {};
  res.json({ calendars: cals.map(c => ({ ...c, attribution: resolveAttribution(c, map) })) });
});

// Door 1, step A: store the Cloud-Console OAuth client.
app.post('/api/gcal/google/credentials', async (req, res) => {
  const creds = parseCredentials(req.body?.credentials);
  if (!creds) return res.status(400).json({ error: 'that doesn\'t look like a Google credentials.json (no client_id found)' });
  // New client → drop any stale token; the ward will re-Allow.
  await writeGoogleToken({ client_id: creds.clientId, client_secret: creds.clientSecret });
  res.json(googlePublicStatus(await readGoogleToken()));
});

// Door 1, step B: hand back the consent URL (the UI opens it in a new tab).
app.get('/api/gcal/google/auth-url', async (req, res) => {
  const store = await readGoogleToken();
  if (!store?.client_id) return res.status(400).json({ error: 'upload your credentials.json first' });
  const state = globalThis.crypto?.randomUUID?.() || String(Math.random()).slice(2);
  const redirectUri = googleRedirectUri(req);
  await writeGoogleToken({ ...store, oauth_state: state, oauth_redirect: redirectUri });
  res.json({ url: buildAuthUrl({ clientId: store.client_id, redirectUri, state }) });
});

// Door 1, step C: Google redirects the browser here with code + state.
app.get('/api/gcal/oauth/callback', async (req, res) => {
  const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;text-align:center;color:#222"><h2>${title}</h2><p>${body}</p><p style="color:#888">You can close this tab.</p></body>`;
  try {
    const store = await readGoogleToken();
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(page('Google sign-in cancelled', String(error)));
    if (!code || !store?.oauth_state || state !== store.oauth_state) {
      return res.status(400).send(page('Sign-in could not be verified', 'Please start the connection again from Settings.'));
    }
    const tok = await exchangeCode({
      code: String(code), clientId: store.client_id, clientSecret: store.client_secret || '',
      redirectUri: store.oauth_redirect,
    });
    if (!tok.refresh_token) {
      return res.status(400).send(page('Almost there', 'Google didn\'t return a refresh token — remove this app\'s access in your Google account and try Connect again.'));
    }
    const { oauth_state, oauth_redirect, ...rest } = store;
    await writeGoogleToken({ ...rest, refresh_token: tok.refresh_token, access_token: tok.access_token, expiry: tok.expiry, scope: tok.scope });
    res.send(page('Connected ✓', 'Proto-Familiar can now read your Google Calendar.'));
  } catch (err) {
    res.status(500).send(page('Something went wrong', String(err?.message ?? err)));
  }
});

// Door 2: paste a refresh token minted on Google's side (e.g. OAuth Playground).
app.post('/api/gcal/google/token', async (req, res) => {
  let pasted = req.body?.token;
  if (typeof pasted === 'string') { try { pasted = JSON.parse(pasted); } catch { /* maybe a bare token */ } }
  const refresh = (typeof pasted === 'object' ? pasted.refresh_token : null) || (typeof req.body?.token === 'string' && !req.body.token.trim().startsWith('{') ? req.body.token.trim() : null);
  if (!refresh) return res.status(400).json({ error: 'no refresh_token found in what you pasted' });
  const store = (await readGoogleToken()) || {};
  const client_id = (pasted && pasted.client_id) || req.body?.client_id || store.client_id;
  const client_secret = (pasted && pasted.client_secret) || req.body?.client_secret || store.client_secret || '';
  if (!client_id) return res.status(400).json({ error: 'no client_id — paste it alongside the token, or upload credentials.json first' });
  await writeGoogleToken({ client_id, client_secret, refresh_token: refresh, access_token: null, expiry: 0, scope: (pasted && pasted.scope) || null });
  res.json(googlePublicStatus(await readGoogleToken()));
});

app.post('/api/gcal/google/disconnect', async (_req, res) => {
  await clearGoogleToken();
  res.json({ ok: true, connected: false });
});

// Last real sync attempt + outcome (written by the sync loop's onTick), so
// the modal can show "last synced 20 min ago" / "failing since Tuesday:
// invalid_grant" instead of pretending everything is fine.
app.get('/api/gcal/sync-status', async (_req, res) => {
  res.json((await readSyncStatus()) ?? {});
});

// "Sync now": clear the cadence gate so the next loop wake (≤60s away)
// runs a real sync regardless of the configured interval.
app.post('/api/gcal/sync-now', (_req, res) => {
  resetGcalSyncCadence();
  res.json({ ok: true, note: 'sync will run within the next minute' });
});

// Schedule
app.get('/api/temporal/schedule', async (req, res) => {
  // Default to a wide ward-local window (yesterday → the configured look-ahead,
  // a year by default) so synced calendar events across the whole horizon show
  // in the Map/schedule view, not just the next 7 days. An explicit ?from/?to
  // still overrides.
  const from_ts = req.query.from || wardLocalShiftedISO(-1);
  const to_ts   = req.query.to   || wardLocalShiftedISO(gcalLookaheadDays());
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
  const { resolution, series } = req.body ?? {};
  if (!resolution || typeof resolution !== 'string') return badRequest(res, 'resolution (string) is required');
  // series:true is the deliberate opt-in to end a whole recurring series.
  // Without it, resolving a recurring anchor returns {ok:false,
  // code:'recurring_needs_scope'} so the UI can ask which the ward meant.
  try { res.json(await resolveScheduleNode({ id: req.params.id, resolution, series: series === true })); }
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

// Consequence-graph edges between schedule nodes. The Map view (and the
// Familiar's schedule_link tool) author these; deleting one corrects a
// mis-stated link without removing the events.
app.post('/api/temporal/schedule/edge', async (req, res) => {
  const { src, dst, kind, payload } = req.body ?? {};
  if (!src  || typeof src  !== 'string') return badRequest(res, 'src (node id) is required');
  if (!dst  || typeof dst  !== 'string') return badRequest(res, 'dst (node id) is required');
  if (!kind || typeof kind !== 'string') return badRequest(res, 'kind (string) is required');
  try { res.json(await addScheduleEdge({ src, dst, kind, payload })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/temporal/schedule/edge/:id', async (req, res) => {
  const { payload } = req.body ?? {};
  if (!payload || typeof payload !== 'object') return badRequest(res, 'payload (object) is required');
  try { res.json(await updateScheduleEdge({ id: req.params.id, payload })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/temporal/schedule/edge/:id', async (req, res) => {
  try { res.json(await deleteScheduleEdge({ id: req.params.id })); }
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
    const result = await enqueueCrisisResources();
    res.json({ ok: true, id: result.id, deduped: result.deduped ?? false });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Village registry (V1 of Village Support) ────────────────────────
// CRUD for categories / villagers / locations. The registry's local
// mirror (village.json) is what gating will read; mutations write
// through to Phylactery (canonical) via the sync wired in
// startVillageSync() below. Validation errors surface as 400s.

const villageError = (res, err) => {
  const msg = err?.message ?? String(err);
  const status = /unknown|required|locked|built-in|reassignTo/.test(msg) ? 400 : 500;
  res.status(status).json({ error: msg });
};

// GET /api/discord/status — gateway observability (Village V4).
// Lets the ward see connection state, the bot identity, the last
// error, and turn/failure counters without reading server logs.
app.get('/api/discord/status', (_req, res) => {
  res.json(getDiscordStatus());
});

// POST /api/discord/apply — apply the saved Discord settings and (re)connect
// immediately (the UI's "Apply" button), so the ward doesn't wait for the 30s
// supervisor tick or reload the page. Returns the resulting gateway status.
app.post('/api/discord/apply', (_req, res) => {
  res.json(applyDiscordSettings());
});

// POST /api/guide-chat — the in-modal Familiar explainer (Part 4). Same entity,
// STRIPPED context (identity + the four prompt fields + the tools-info /
// no-jargon blocks; no memory/graph/temporal/tools/care-check). Non-streaming,
// no tools, not persisted, not memorised. Degrades calmly so the modal still
// works as a picker if this fails.
app.post('/api/guide-chat', async (req, res) => {
  if (guideChatDisabled()) return res.status(403).json({ error: 'The in-modal guide is turned off.' });
  const { provider, apiKey, model, messages } = req.body || {};
  const url = PROVIDER_URLS[provider];
  if (!url) return res.status(400).json({ error: `Unknown provider: "${provider}".` });
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) return res.status(400).json({ error: 'API key is required.' });
  if (!model || typeof model !== 'string' || !model.trim()) return res.status(400).json({ error: 'Model name is required.' });
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'Messages array is required.' });

  const settings = readSettingsSync();
  // Identity layer only (no memory/graph/temporal). Degrades to no identity.
  let identityStatic = '';
  try {
    const enriched = await enrich('', { staticOnly: true });
    identityStatic = enriched?.static || '';
  } catch (err) {
    console.warn('[guide-chat] identity enrich failed (continuing without it):', err?.message ?? err);
  }

  const systemContent = buildGuideSystem(identityStatic, settings);
  const convo = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content }));
  const finalMessages = [{ role: 'system', content: systemContent }, ...convo];
  if (settings.postHistoryPrompt && settings.postHistoryPrompt.trim()) {
    finalMessages.push({ role: 'system', content: substituteMacros(settings.postHistoryPrompt.trim(), settings) });
  }

  try {
    const r = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey.trim()}` },
      body:    JSON.stringify({ model: model.trim(), messages: finalMessages, stream: false }),
    });
    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: `The model service answered with an error (${r.status}).`, detail: t.slice(0, 200) });
    }
    const data = await r.json();
    const content = stripLlmTimestamps(data?.choices?.[0]?.message?.content ?? '');
    res.json({ content });
  } catch (err) {
    res.status(502).json({ error: `I couldn't reach the model service (${err.message}).` });
  }
});

// Knock list (V4.x) — contact attempts from unregistered people,
// captured by the gateway so the ward can register villagers without
// hunting platform IDs by hand. Metadata only; never message content.
app.get('/api/village/knocks', async (_req, res) => {
  res.json(await listKnocks());
});

app.delete('/api/village/knocks/:platform/:id', async (req, res) => {
  const result = await dismissKnock({ platform: req.params.platform, id: req.params.id });
  if (!result.ok) return res.status(result.error === 'knock not found' ? 404 : 400).json({ error: result.error });
  res.json({ ok: true });
});

// Location knock list (V4.x) — unregistered Discord channels the
// Familiar has spoken in. Metadata only; never message content.
app.get('/api/village/location-knocks', async (_req, res) => {
  res.json(await listLocationKnocks());
});

// Location keys contain ':' so they ride the body, not the path.
app.delete('/api/village/location-knocks', async (req, res) => {
  const { key } = req.body ?? {};
  const result = await dismissLocationKnock({ key });
  if (!result.ok) return res.status(result.error === 'knock not found' ? 404 : 400).json({ error: result.error });
  res.json({ ok: true });
});

app.get('/api/village', async (_req, res) => {
  try { res.json(await getVillageRegistry()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/village/categories', async (req, res) => {
  const { name, grants } = req.body ?? {};
  try { res.json(await upsertVillageCategory({ name, grants })); }
  catch (err) { villageError(res, err); }
});

app.patch('/api/village/categories/:id', async (req, res) => {
  const { name, grants } = req.body ?? {};
  try { res.json(await upsertVillageCategory({ id: req.params.id, name, grants })); }
  catch (err) { villageError(res, err); }
});

app.delete('/api/village/categories/:id', async (req, res) => {
  try { res.json(await deleteVillageCategory({ id: req.params.id, reassignTo: req.query.reassignTo })); }
  catch (err) { villageError(res, err); }
});

// A saved villager's aliases settle any matching knocks — the person
// is registered now, so the "knocked on the door" entry has served its
// purpose. Fire-and-forget; a missed dismissal just leaves a stale row
// the ward can dismiss by hand.
function reconcileKnocks(villager) {
  for (const a of villager?.aliases ?? []) {
    dismissKnock({ platform: a.platform, id: a.id }).catch(() => {});
  }
}

// A saved location settles any matching location knock.
function reconcileLocationKnock(location) {
  if (location?.key) dismissLocationKnock({ key: location.key }).catch(() => {});
}

app.post('/api/village/villagers', async (req, res) => {
  const { name, categoryIds, categoryId, aliases, connection, triage,
    pronouns, relationToWard, relationToFamiliar, commStyleNotes, notes, privateNotes, graphNodeId, remember, standingConsent, disclosure } = req.body ?? {};
  try {
    const saved = await upsertVillager({ name, categoryIds, categoryId, aliases, connection, triage,
      pronouns, relationToWard, relationToFamiliar, commStyleNotes, notes, privateNotes, graphNodeId, remember, standingConsent, disclosure });
    reconcileKnocks(saved);
    res.json(saved);
  }
  catch (err) { villageError(res, err); }
});

app.patch('/api/village/villagers/:id', async (req, res) => {
  const { name, categoryIds, categoryId, aliases, connection, triage,
    pronouns, relationToWard, relationToFamiliar, commStyleNotes, notes, privateNotes, graphNodeId, remember, standingConsent, disclosure } = req.body ?? {};
  try {
    const saved = await upsertVillager({ id: req.params.id, name, categoryIds, categoryId, aliases, connection, triage,
      pronouns, relationToWard, relationToFamiliar, commStyleNotes, notes, privateNotes, graphNodeId, remember, standingConsent, disclosure });
    reconcileKnocks(saved);
    res.json(saved);
  }
  catch (err) { villageError(res, err); }
});

app.delete('/api/village/villagers/:id', async (req, res) => {
  try { res.json(await deleteVillager({ id: req.params.id })); }
  catch (err) { villageError(res, err); }
});

app.post('/api/village/locations', async (req, res) => {
  const { key, label, assignedCategoryId, connectionId, rateLimit, mode, activeStrategy, activeCooldownSec, readBots } = req.body ?? {};
  try {
    const saved = await upsertVillageLocation({ key, label, assignedCategoryId, connectionId, rateLimit, mode, activeStrategy, activeCooldownSec, readBots });
    reconcileLocationKnock(saved);
    res.json(saved);
  }
  catch (err) { villageError(res, err); }
});

app.patch('/api/village/locations', async (req, res) => {
  // Location keys contain ':' and '/' so they ride the body, not the path.
  const { key, label, assignedCategoryId, connectionId, rateLimit, mode, activeStrategy, activeCooldownSec, readBots } = req.body ?? {};
  try {
    const saved = await upsertVillageLocation({ key, label, assignedCategoryId, connectionId, rateLimit, mode, activeStrategy, activeCooldownSec, readBots });
    reconcileLocationKnock(saved);
    res.json(saved);
  }
  catch (err) { villageError(res, err); }
});

app.delete('/api/village/locations', async (req, res) => {
  const { key } = req.body ?? {};
  try { res.json(await deleteVillageLocation({ key })); }
  catch (err) { villageError(res, err); }
});

// Wires the hybrid sync (Phylactery canonical, local mirror) and runs
// the boot reconciliation + trusted-contacts migration. Degrades
// gracefully: Phylactery down → mirror stays authoritative for
// gating, writes accumulate as syncPending and replay on next boot.
// Short give-up on the boot canonical pull so it fails fast instead of hanging
// on the MCP SDK's 60s default while Phylactery is still warming up. If the pull
// loses that race, the mirror stays authoritative and these backoffs retry the
// reconciliation in the background until Phylactery answers.
//
// ⚠️ SOFT, not the SDK's `timeout`. A hard MCP timeout sends
// `notifications/cancelled`, which cancels an anyio scope from the wrong task
// inside Phylactery and kills the child outright — see the long note on
// `callTool` in thalamus.js. This pull racing a 12.3s content-tag backfill is
// the exact pair that was doing it. Giving up locally keeps the fail-fast
// behaviour and takes the loaded gun away.
const VILLAGE_PULL_TIMEOUT_MS = 8_000;
const VILLAGE_RESYNC_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000];

// Category-slug audience remap map, captured from the RAW registry during
// village sync (before slugs are persisted) and applied to Phylactery once it's
// up. Module-scoped because capture and apply live in different boot functions.
let _pendingAudienceRemap = null;

async function startVillageSync() {
  // Tracks whether the most recent canonical pull actually REACHED Phylactery
  // (vs. timing out). A reached pull that simply found no village data yet is
  // still a success — only a transport/timeout failure trips the retry.
  let pullReached = false;

  initVillageSync({
    push: async (json) => {
      const content = '```json\n' + json + '\n```';
      const result = await rewriteIdentitySection({
        category: 'custom', filename: 'village-registry.md', section: 'Registry', content,
      });
      if (result.ok) return result;
      // Section may not exist yet (first sync) — create file + section.
      return appendIdentity({
        category: 'custom', filename: 'village-registry.md',
        content: `## Registry\n\n${content}`,
      });
    },
    pull: async () => {
      try {
        const id = await getIdentityAll({ softTimeout: VILLAGE_PULL_TIMEOUT_MS });
        pullReached = true;
        const file = (id?.custom ?? []).find(f => f.filename === 'village-registry.md');
        const m = file?.content?.match(/```json\s*\n([\s\S]*?)\n```/);
        return m ? JSON.parse(m[1]) : null;
      } catch (err) {
        pullReached = false;
        console.warn('[village] canonical pull failed:', err?.message ?? err);
        return null;
      }
    },
  });
  try {
    // Capture the category-slug audience remap map from the RAW registry BEFORE
    // villageBootSync can persist slugs over the UUIDs — otherwise a ward-created
    // category's old UUID would already be gone and its memories couldn't be
    // re-pointed. Seeds are covered by the fixed map regardless; this preserves
    // the ward-created mappings too. Applied to Phylactery further down, once it's up.
    _pendingAudienceRemap = await pendingCategoryAudienceRemap().catch(() => null);
    await villageBootSync();
    const { added } = await seedDefaultCategories();
    if (added > 0) console.log(`[village] seeded ${added} default category/categories`);
    const reg = await getVillageRegistry();
    if (reg.villagers.length === 0) {
      const contacts = readSettingsSync()?.trustedContacts;
      if (Array.isArray(contacts) && contacts.length > 0) {
        const { imported } = await migrateTrustedContacts(contacts);
        if (imported > 0) console.log(`[village] migrated ${imported} trusted contact(s) into Emergency Contacts`);
      }
    }
  } catch (err) {
    console.error('[village] boot sync failed (mirror stays authoritative):', err?.message ?? err);
  }

  // Boot-race recovery: if the canonical pull never reached Phylactery (it was
  // still loading the embedding model / migrating / consolidating), a newer
  // canonical wouldn't reconcile until the next restart. Retry the
  // reconciliation in the background with backoff — non-blocking, bounded, and
  // the mirror stays authoritative throughout.
  if (!pullReached) {
    for (const delay of VILLAGE_RESYNC_BACKOFF_MS) {
      await new Promise(r => setTimeout(r, delay));
      try { await villageBootSync(); }
      catch (err) { console.warn('[village] deferred re-sync attempt failed:', err?.message ?? err); }
      if (pullReached) {
        console.log('[village] deferred re-sync reached Phylactery — canonical reconciled');
        return;
      }
    }
    console.warn('[village] deferred re-sync gave up; mirror remains authoritative until next restart');
  }
}

// Start the MCP children (Phylactery + Unruh) at server boot rather
// than as a thalamus.js import side-effect. Tests and other importers
// of thalamus's coordination helpers (withLock, modifyTomeFile, etc.)
// don't need — and shouldn't trigger — Deno/Python spawning just to
// get the lock primitive.
startThalamus();

/**
 * Phylactery housekeeping, serialised. Never throws — every step is
 * fire-and-forget by nature and retries on the next boot.
 */
async function runPhylacteryMaintenance() {
  // 1. Health first: it is the cheapest call and it decides whether the
  // embedding backfill is even worth running. A silently-dead embedder is
  // what floods the consent queue with duplicate facts, so it must be
  // visible, not buried in Phylactery's stderr.
  // Presence is not health — the recurring lesson of this codebase. A
  // maintenance pass that quietly does nothing every boot looks exactly like
  // one that is working, so an unreachable child is said out loud.
  //
  // Unreachability is read off the RESULT, not off a throw: getMemoryHealth
  // catches its own errors and returns {ok:false, healthy:null}, so a `try`
  // around it can never fire. (It couldn't, in the first version of this —
  // caught by running it rather than by reading it.)
  let health = null;
  try { health = await getMemoryHealth(); } catch { /* shouldn't happen; handled below */ }
  if (!health || health.ok === false || health.healthy === null) {
    console.warn(`[memory] maintenance pass skipped — Phylactery not reachable (${health?.error ?? 'no answer'}); retries next boot`);
    return;
  }
  if (health.healthy === false) {
    console.warn(`[memory] ⚠ semantic dedup UNAVAILABLE — running in ${health.dedup_mode} mode. ` +
      `Duplicate facts may pile up in the consent queue. ` +
      `embed_ok=${health.embed_ok} (${health.embed_error ?? 'ok'}); vec_ok=${health.vec_ok} (${health.vec_error ?? 'ok'}). ` +
      `Fix: ensure fastembed's model downloaded and the sqlite-vec extension loads.`);
  } else if (health && health.healthy) {
    console.log(`[memory] dedup healthy (semantic; ${health.vec_rows}/${health.memory_rows} rows embedded)`);
    // Heal the migration gap: memories imported from entity-core were inserted
    // without vectors, so semantic dedup can't see them and their restatements
    // re-queue. Idempotent; a no-op once caught up.
    if (Number.isFinite(health.vec_rows) && Number.isFinite(health.memory_rows) && health.memory_rows > health.vec_rows) {
      console.log(`[memory] ${health.memory_rows - health.vec_rows} memor(ies) missing embeddings — backfilling…`);
      try {
        const r = await backfillMemoryEmbeddings();
        if (r?.ok && r.embedded) console.log(`[memory] embedding backfill: embedded ${r.embedded}, ${r.remaining ?? 0} remaining`);
        else if (r && !r.ok) console.warn(`[memory] embedding backfill skipped: ${r.error ?? 'unknown'}`);
      } catch { /* retries next boot */ }
    }
  }

  // 2. Content-gating Phase 3: give pre-tag memories a content_tag derived
  // from their category, so the recall gate always has a value. Idempotent.
  try {
    const r = await backfillContentTags();
    if (r?.ok && r.tagged) console.log(`[memory] content-tag backfill: tagged ${r.tagged}, ${r.remaining ?? 0} remaining`);
    else if (r && !r.ok) console.warn(`[memory] content-tag backfill skipped: ${r.error ?? 'unknown'}`);
  } catch { /* retries next boot */ }

  // 3. Complete the Village category-slug migration in Phylactery: the
  // registry mirror slugs its own ids on read, but memories / graph
  // nodes+edges store the category id as their `audience`, so an old-UUID
  // audience would fall fail-closed to ward-only until remapped. Idempotent
  // (matches nothing once done); always carries the fixed legacy-seed map so
  // it heals even if the raw registry has already been slugged.
  try {
    const map = await Promise.resolve(_pendingAudienceRemap ?? pendingCategoryAudienceRemap());
    if (map && Object.keys(map).length) {
      const r = await remapCategoryAudiences(map);
      const moved = (r?.memories ?? 0) + (r?.nodes ?? 0) + (r?.edges ?? 0);
      if (r?.ok && moved) console.log(`[village] category-slug audience remap: ${r.memories} memor(ies), ${r.nodes} node(s), ${r.edges} edge(s) re-pointed to slug ids`);
      else if (r && !r.ok) console.warn(`[village] category-slug audience remap skipped: ${r.error ?? 'unknown'}`);
    }
  } catch { /* retries next boot */ }
  console.log('[memory] Phylactery maintenance pass complete');
}

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
  startGcalSync();
  startSilenceTriage();
  startReachout();
  startNoticing();
  startMemorySweep();
  startVillageSync();
  // Live voice calls (Pass 2b): attach the WebSocket call endpoint. Dynamic
  // import + try/catch so a missing `ws` dep (before the auto-install runs) or
  // any wiring failure degrades to "no live calls" rather than taking the
  // server down — chat, read-aloud, and voice notes keep working regardless
  // (the no-module-may-break-the-chat-path rule).
  try {
    const { attachVoiceCall } = await import('./voice-call-server.js');
    const sharedVoiceWorkers = {
      getListeningWorker: async () => (await listeningWorker({ rootDir: __dirname })).worker,
      getTtsWorker: async () => (await currentAudioWorker()).worker,
      resolveVoiceForSettings: (s) => resolveVoice({ rootDir: __dirname, settings: s }),
      ensureTtsLoaded,
    };
    attachVoiceCall({
      httpServer, rootDir: __dirname, port: PORT,
      readSettings: readSettingsSync,
      ...sharedVoiceWorkers,
      connectionForFeature,
    });
    // Discord voice (Pass 3) shares the SAME ASR/TTS workers — one call at a
    // time across both transports. Failure here never blocks web calls or chat.
    try {
      const { attachDiscordVoice } = await import('./voice-discord-server.js');
      const { setDiscordVoiceController } = await import('./discord-gateway.js');
      const discordVoice = attachDiscordVoice({
        rootDir: __dirname,
        readSettings: readSettingsSync,
        ...sharedVoiceWorkers,
      });
      setDiscordVoiceController(discordVoice);
    } catch (err) {
      console.warn(`[discord-voice] not attached (${err?.message ?? err}) — Discord voice unavailable; everything else works`);
    }
  } catch (err) {
    console.warn(`[voice-call] not attached (${err?.message ?? err}) — live calls unavailable; everything else works`);
  }
  // Weather sense (W-A): prime the read-mirror at boot so the [Now] line is
  // fresh before the first 30s reminders tick. Self-gated + fire-and-forget;
  // inert until the ward has added a location.
  refreshWeatherIfDue().catch(err => console.error('[weather] boot refresh:', err?.message ?? err));
  // Memory dedup health: probe the vector stack once at boot and warn LOUDLY
  // if semantic dedup is degraded to the lexical fallback — a silently-dead
  // embedder/sqlite-vec is what floods the consent queue with duplicate facts,
  // so this must be visible, not buried in Phylactery's stderr.
  // ── Deferred Phylactery maintenance ─────────────────────────────
  //
  // These three are housekeeping — health, backfills, an id remap. They used
  // to fire immediately at boot, all at once, alongside the village canonical
  // pull. Two problems with that, one cosmetic and one that killed the child:
  //
  //   · They are heavy sqlite writers on the same database. Running them
  //     concurrently just makes each slower.
  //   · Racing them against a fail-fast boot read is what produced a 12.3s
  //     backfill and an 8s give-up on the same child at the same moment. The
  //     give-up no longer cancels anything (see thalamus callTool), so this is
  //     no longer fatal — but a maintenance task has no business competing
  //     with my human's first turn for a single-threaded child either.
  //
  // So: wait for the boot rush to pass, then run them ONE AT A TIME. Nothing
  // here is urgent; all of it is idempotent and retries next boot.
  const MAINTENANCE_DELAY_MS = 20_000;
  setTimeout(() => { runPhylacteryMaintenance().catch(() => {}); }, MAINTENANCE_DELAY_MS).unref?.();

  // Self-update check: prime the indicator at boot, then re-check on a slow
  // background cadence so a ward with the UI open sees a new version appear
  // without doing anything. Off-switch: PROTO_FAMILIAR_UPDATE_DISABLED=1.
  if (!updateDisabled()) {
    refreshUpdateStatus().catch(() => {});
    setInterval(() => { refreshUpdateStatus().catch(() => {}); }, UPDATE_CHECK_MS).unref?.();
  } else {
    console.log('[update] self-update disabled (PROTO_FAMILIAR_UPDATE_DISABLED=1).');
  }
  // Discord gateway (Village V4). Supervisor idles until the ward sets
  // a bot token + enables the toggle in Settings; follows settings
  // changes within 30s. Hard off-switch: PROTO_FAMILIAR_DISCORD_DISABLED=1.
  startDiscordGateway();
  // Bot-DM push channel: when the gateway can DM my human (token + ward's
  // Discord user id configured), every outbox item — reminders, event
  // alerts, warm reach-outs, triage check-ins — reaches them as a real
  // Discord message, not only a banner waiting in the web app. Registered
  // as a factory so cerebellum never imports the gateway (no cycle) and a
  // Settings change applies on the next dispatch. Delivery is a plain REST
  // call inside relayToDiscord, so it works even between WebSocket
  // reconnects.
  registerPushAdapterFactory((s) => {
    const token  = typeof s?.discordBotToken   === 'string' ? s.discordBotToken.trim()   : '';
    const wardId = typeof s?.discordWardUserId === 'string' ? s.discordWardUserId.trim() : '';
    if (!token || !wardId || s?.discordEnabled !== true) return null;
    if (process.env.PROTO_FAMILIAR_DISCORD_DISABLED === '1') return null;
    return {
      name: 'discord-bot-dm',
      deliver: async (item) => relayToDiscord({ recipientUserId: wardId, message: formatItemForPush(item) }),
    };
  });
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
// (readSettingsSync / primaryConnectionFrom live in cerebellum.js —
// single reader implementation shared by routes, loops, and triage.)

// Routine review (stewardship Pass 3) rides the reflection slot. A review is
// due when it's ON, the weekly cadence has elapsed, and the fulfilment ledger
// actually shows a routine slipping (a good week manufactures nothing). The
// assessment is computed once per reflection decision and stashed so
// getReflectionInput can reuse the ledger without a second listRecurring call.
let _pendingRoutineReview = null;   // { ledger } when a review claims this tick
async function assessRoutineReviewDue() {
  const s = readSettingsSync();
  if (routineReviewHardDisabled() || s?.routineReviewEnabled === false) return null; // default ON
  const st = await readStewardshipState().catch(() => ({}));
  const reviewDays = Number.isFinite(Number(s?.routineReviewDays)) ? Number(s.routineReviewDays) : 7;
  // Cheap cadence gate before any Unruh round-trip.
  if ((Date.now() - (Number(st?.routineReviewAt) || 0)) < reviewDays * 24 * 3600 * 1000) return null;
  try {
    const rec = await listRecurring();
    const anchors = Array.isArray(rec?.nodes) ? rec.nodes : [];
    const ledger = buildNeedsLedger(anchors.filter(isNeedWindow), Date.now(), 7);
    return isRoutineReviewDue({ lastReviewAt: Number(st?.routineReviewAt) || 0, reviewDays, ledger })
      ? { ledger }
      : null;
  } catch { return null; }
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
      const conn = connectionForFeature(s, 'pondering');
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
    shouldReflect: async () => {
      // A due routine review can claim a reflection tick even in a quiet
      // week (so it stays ~weekly), riding the same call — never a new one.
      _pendingRoutineReview = await assessRoutineReviewDue();
      if (_pendingRoutineReview) return true;
      return shouldReflectNow();
    },
    getReflectionInput: async () => {
      const teNaive = (d) => {
        const p2 = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
      };
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
        // Whether I actually raised this with my human (post-turn scan).
        // Lets reflection tell "they didn't engage" from "I never spoke".
        raised:         e.raised,
        outcome:        e.outcome,
        outcome_at:     e.outcome_at,
        // Where in the task's window the ward acted (when present) — the
        // signal reflection learns start-timing from.
        ...(Number.isFinite(e.window_fraction) ? { window_fraction: e.window_fraction } : {}),
        state_snapshot: e.state_snapshot,
      }));
      // The Familiar's own PROJECTED consequence edges (not yet observed),
      // with ids + endpoint labels, so reflection can grade and recalibrate
      // its forecasts. Degrades to [] if Unruh is unreachable.
      let consequenceEdges = [];
      let cooccurrences = [];
      try {
        // Hindsight window (causal-chain fix, piece 3): the default window
        // reaches only hours back, so a chain whose event passed days ago
        // vanished before reflection could grade it. Reflection reads a
        // week back (+2 days forward) — same single call, wider range.
        const wardNow = wardLocalNowISO(readSettingsSync()?.wardTimeZone);
        const base = new Date(wardNow).getTime();
        const isoAt = (ms) => teNaive(new Date(ms));
        const win = await getScheduleWindow({
          from_ts: isoAt(base - 7 * 24 * 3600_000),
          to_ts:   isoAt(base + 2 * 24 * 3600_000),
        });
        // Window nodes + linked endpoints (undated states, out-of-window
        // anchors) — without `linked` the grader saw unresolvable endpoint
        // ids and the calibration loop starved on its own projections.
        const nodes = [
          ...(Array.isArray(win?.nodes) ? win.nodes : []),
          ...(Array.isArray(win?.linked) ? win.linked : []),
        ];
        const labelById = new Map(nodes.map(n => [n.id, n.label]));
        const whenById  = new Map(nodes.map(n => [n.id, n.when ?? n.when_ts ?? null]));
        const allEdges = Array.isArray(win?.edges) ? win.edges : [];
        consequenceEdges = allEdges
          .filter(ed => ed?.payload && (ed.payload.valence || ed.payload.condition) && ed.payload.observed !== true)
          .map(ed => ({
            edge_id: ed.id, from: labelById.get(ed.src) ?? ed.src, to: labelById.get(ed.dst) ?? ed.dst,
            kind: ed.kind, valence: ed.payload.valence, condition: ed.payload.condition,
            horizon_hours: ed.payload.horizon_hours, severity: ed.payload.severity,
            certainty: ed.payload.certainty, note: ed.payload.note,
            from_when: whenById.get(ed.src) ?? null,
          }));
        // co_occurs_with noticings, grouped by unordered endpoint pair so
        // reflection sees how often a pairing has come up (the signal for
        // promoting a noticing to a tentative cause). Pairs that already
        // have a causes edge are skipped — no point re-suggesting.
        const hasCause = new Set();
        for (const e of allEdges) if (e.kind === 'causes') { hasCause.add(`${e.src}|${e.dst}`); hasCause.add(`${e.dst}|${e.src}`); }
        const byPair = new Map();
        for (const ed of allEdges) {
          if (ed.kind !== 'co_occurs_with' || hasCause.has(`${ed.src}|${ed.dst}`)) continue;
          const key = [ed.src, ed.dst].sort().join('|');
          const cur = byPair.get(key);
          if (cur) cur.times_noticed += 1;
          else byPair.set(key, {
            edge_id: ed.id, src_id: ed.src, dst_id: ed.dst,
            from: labelById.get(ed.src) ?? ed.src, to: labelById.get(ed.dst) ?? ed.dst, times_noticed: 1,
          });
        }
        cooccurrences = [...byPair.values()];
      } catch { /* Unruh down → no calibration/promotion this cycle, prompt still works */ }
      // Recently-missed need-windows (last 7 days), from the fulfilment
      // ledger (each need anchor's payload.resolutions). A missed need is a
      // CUE for reflection to check whether the cost it projected for that
      // lapse actually followed — confirm or correct, never assume.
      let recentMissedNeeds = [];
      try {
        const rec = await listRecurring();
        const anchors = Array.isArray(rec?.nodes) ? rec.nodes : [];
        const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
        for (const n of anchors.filter(isNeedWindow)) {
          const res = n.payload?.resolutions || {};
          const dates = Object.keys(res)
            .filter(d => res[d] === 'missed' && new Date(d).getTime() >= cutoff)
            .sort();
          if (dates.length) recentMissedNeeds.push({ label: n.label, dates });
        }
      } catch { /* Unruh down → no missed-need cues this cycle */ }
      // If a routine review claimed this tick (set in shouldReflect just
      // above), attach the pivot-menu section built from the week's ledger,
      // and flag the input so the follow-through stamps the cadence. Consume
      // the pending assessment so it can't leak into a later tick.
      const review = _pendingRoutineReview;
      _pendingRoutineReview = null;
      const routineReviewSection = review ? buildRoutineReviewSection(review.ledger) : '';
      // Temporal-bridges Piece 3: attach what the Familiar actually KEPT from
      // the recent days, so grading "did the projected cost follow?" is
      // grounded in recorded memory, not just the edge's own payload. Rides
      // this existing reflection assembly (a data read, no new LLM call);
      // best-effort — a miss just means the grader works from edges alone.
      let windowMemories = [];
      try {
        const to = new Date();
        const from = new Date(to.getTime() - 10 * 24 * 3600 * 1000);
        const iso = (d) => d.toISOString().slice(0, 10);
        const mem = await memByTimerange({ fromDate: iso(from), toDate: iso(to), limit: 15 });
        windowMemories = (Array.isArray(mem?.results) ? mem.results : [])
          .map(r => ({ date: r.date, excerpt: r.excerpt, schedule_refs: r.schedule_refs }));
      } catch { /* Phylactery down → grade from edges alone */ }
      return {
        mode: 'reflection', outcomes: projected, existingNotes, consequenceEdges, cooccurrences, recentMissedNeeds,
        windowMemories, routineReviewSection, isRoutineReview: !!review,
      };
    },
    runPonder: async (topic /* string OR { mode:'reflection', ... } */) => {
      const s    = readSettingsSync();
      const conn = connectionForFeature(s, 'pondering');
      if (!conn?.apiKey) throw new Error('no connection configured for pondering');

      // Grounded pondering: for an interest ponder, recall what the Familiar
      // actually KNOWS about the topic (so it doesn't muse "from the outside"
      // about something its human has a real relationship to — the confident-
      // wrong AURORA case) and what it has ALREADY pondered about it recently
      // (so it stops reaching out with the same question morning after morning —
      // the three-times-about-the-Feegles case). Best-effort: one extra cheap
      // memory search that degrades to an ungrounded ponder if recall is down.
      // Reflection mode is already grounded (windowMemories), so it's skipped.
      let grounding = null;
      if (typeof topic === 'string' && topic.trim()) {
        const [memR, pondR] = await Promise.allSettled([
          searchMemory({ query: topic, maxResults: 5 }),
          getRecentPonderings({ limit: 40, sinceDays: 21 }),
        ]);
        const memories = memR.status === 'fulfilled'
          ? (memR.value?.results ?? []).map(r => ({ date: r.date, excerpt: r.excerpt })).filter(m => (m.excerpt ?? '').trim())
          : [];
        const q = topic.trim().toLowerCase();
        const recent = pondR.status === 'fulfilled'
          ? (pondR.value ?? [])
              .filter(p => {
                const t = String(p.topic ?? '').trim().toLowerCase();
                return t && (t === q || t.includes(q) || q.includes(t));
              })
              .slice(0, 3)
              // Carry WHERE it got to (the thought itself, trimmed), so the next
              // ponder builds on it — not just the title, which only said "don't repeat".
              .map(p => ({
                when: p.created_ms ? new Date(p.created_ms).toISOString().slice(0, 10) : null,
                excerpt: String(p.content ?? p.title ?? '').trim().slice(0, 280),
              }))
          : [];
        grounding = { memories, recent };
      }

      const result = await ponderOnce({
        topic,
        provider: conn.provider,
        apiKey:   conn.apiKey,
        model:    conn.model,
        settings: s,
        grounding,
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
        // Apply any forecast recalibrations the reflection graded — raise/
        // lower certainty, mark observed, add a note — onto the edges by id.
        // Fire-and-forget per edge; one failing never blocks the others or
        // the chat path.
        for (const cal of (result.edge_calibrations ?? [])) {
          updateScheduleEdge({ id: cal.edge_id, payload: cal.payload })
            .then(r => console.log(`[pondering] reflection → ${r?.ok ? 'recalibrated' : 'failed to recalibrate'} edge ${cal.edge_id}`))
            .catch(err => console.error('[pondering] edge recalibration failed:', err?.message ?? err));
        }
        // Promote a repeated co_occurs_with to a TENTATIVE cause: add a new
        // causes edge between the same two nodes (observed:false, low default
        // certainty). The noticing stays as the trail; the cause is the next
        // rung, to be graded next reflection. Endpoints resolve from the
        // co-occurrence list the prompt was built from (no resolve-or-create
        // needed — both nodes already exist).
        const coocList = (topic && typeof topic === 'object' && Array.isArray(topic.cooccurrences)) ? topic.cooccurrences : [];
        for (const promo of (result.promotions ?? [])) {
          const co = coocList.find(c => c.edge_id === promo.edge_id);
          if (!co) continue;
          const payload = { observed: false, certainty: promo.certainty || 'low' };
          if (promo.valence)   payload.valence   = promo.valence;
          if (promo.condition) payload.condition = promo.condition;
          if (promo.note)      payload.note      = promo.note;
          addScheduleEdge({ src: co.src_id, dst: co.dst_id, kind: 'causes', payload })
            .then(r => console.log(`[pondering] reflection → ${r?.ok ? `promoted noticing to tentative cause (${co.from} → ${co.to})` : 'failed to promote'} `))
            .catch(err => console.error('[pondering] promotion failed:', err?.message ?? err));
        }
        // Intentions (Initiative Pass 3): reflection can end in commitments.
        // Route each to the intentions store, source='reflection', fire-and-
        // forget — one failing never blocks the others or the chat path.
        for (const it of (result.intentions ?? [])) {
          setIntention({ ...it, source: 'reflection' })
            .then(r => console.log(`[pondering] reflection → ${r?.ok !== false ? 'kept intention' : 'failed to keep intention'}: "${String(it.what).slice(0, 60)}"`))
            .catch(err => console.error('[pondering] intention set failed:', err?.message ?? err));
        }
        // Routine review (stewardship Pass 3): when this reflection carried the
        // weekly review, stamp the cadence clock (always, so it doesn't re-fire
        // every tick) and stash the finding for the stewardship block to
        // surface — even if the LLM concluded there was nothing to raise.
        if (topic?.isRoutineReview) {
          recordRoutineReview(result?.routine_review || null)
            .then(() => console.log(`[pondering] routine review → ${result?.routine_review ? 'finding stored' : 'no finding this week'}`))
            .catch(err => console.error('[pondering] routine review record failed:', err?.message ?? err));
        }
        // Piece 5 heartbeat: record that reflection RAN this tick, with its
        // counts — even an all-zero grade. A dead learning loop then reads as
        // stale/absent entries, not as silence indistinguishable from calm.
        appendReflectionEvent({
          title:         result.title ?? null,
          edgesGraded:   Array.isArray(result.edge_calibrations) ? result.edge_calibrations.length : 0,
          promotions:    Array.isArray(result.promotions) ? result.promotions.length : 0,
          intentions:    Array.isArray(result.intentions) ? result.intentions.length : 0,
          wroteIdentity: !!(result.what_lapses_cost_update?.heading && result.what_lapses_cost_update?.content),
          routineReview: !!topic?.isRoutineReview,
        }).catch(() => {});
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
    // enqueueAndDispatch: the fired reminder also pushes to the human's
    // own push channel (when configured), so a closed tab no longer
    // means a silently missed reminder.
    enqueueOutboxFn: enqueueAndDispatch,
    getDueReminders: async () => {
      // Compare against the WARD's local now, not the server's clock — a
      // reminder's when_ts is the ward's wall-clock, and the server may run in
      // a different zone (a UTC container while the ward is in PDT). Passing a
      // ward-local now here is what stops afternoon reminders firing in the
      // morning. Falls back to server-local when no ward zone is known yet.
      const now = wardLocalNowISO(readSettingsSync()?.wardTimeZone);
      const r = await getDueReminders({ now, limit: 50 });
      return Array.isArray(r.reminders) ? r.reminders : [];
    },
    fireReminder: async ({ id }) => {
      // series:true keeps the historical whole-node fire semantics — the
      // recurring-series guard on resolve() is for the ambiguous LLM/UI
      // cancel, not for the scheduler marking a due reminder fired.
      const r = await resolveScheduleNode({ id, resolution: 'fired', series: true });
      if (!r.ok) throw new Error(r.error || 'resolve failed');
    },
    // Event lead-time alerts (the timeblindness surface): unresolved
    // type='event' nodes — synced from Google or added by hand — get a
    // "coming up" ping a configurable lead before they start. Same tick,
    // pure code gates, per-occurrence idempotent via payload.alerted_at /
    // payload.alerts. All frames ward-local (see event-alerts.js).
    getDueEventAlerts: async () => {
      if (process.env.PROTO_FAMILIAR_EVENT_ALERTS_DISABLED === '1') return [];
      const s = readSettingsSync();
      if (s?.eventAlertsEnabled === false) return [];  // default-ON
      const defaultLeadMs = clampLeadMinutes(s?.eventAlertLeadMinutes) * 60_000;
      const nowMs = new Date(wardLocalNowISO(s?.wardTimeZone)).getTime();
      const { windowNodes, recurringNodes } = await fetchAlertScanData(nowMs);
      return selectDueEventAlerts({ windowNodes, recurringNodes, nowMs, defaultLeadMs, maxLeadMs: MAX_LEAD_MS, graceMs: ALERT_GRACE_MS })
        .map(a => ({ ...a, ...formatEventAlert(a, { nowMs }) }));
    },
    // Severe-weather heads-up (W-B, §5.4): an outside-tagged item whose
    // occurrence-hour forecast turns adverse in the CACHED forecast (the
    // read-mirror) gets a code-built ping, riding the same tick + window scan
    // as the coming-up alert. Gated by BOTH weather AND event-alerts being on.
    getDueWeatherAlerts: async () => {
      if (process.env.PROTO_FAMILIAR_EVENT_ALERTS_DISABLED === '1') return [];
      const s = readSettingsSync();
      if (!weatherEnabled() || s?.eventAlertsEnabled === false) return [];
      const mirror = readWeatherMirrorSync();
      if (!mirror) return [];   // no current-location forecast → nothing to warn from
      const defaultLeadMs = clampLeadMinutes(s?.eventAlertLeadMinutes) * 60_000;
      const nowMs = new Date(wardLocalNowISO(s?.wardTimeZone)).getTime();
      const { windowNodes, recurringNodes } = await fetchAlertScanData(nowMs);
      return selectDueWeatherAlerts({ windowNodes, recurringNodes, mirror, nowMs, defaultLeadMs, maxLeadMs: MAX_LEAD_MS, graceMs: ALERT_GRACE_MS })
        .map(a => ({ ...a, ...formatWeatherAlert(a, { nowMs, unit: s?.weatherUnit }) }));
    },
    markEventAlerted: async ({ id, occurrenceDate, kind }) => {
      const r = await markEventAlerted({ id, occurrence_date: occurrenceDate ?? null, kind: kind || 'event' });
      if (!r.ok) throw new Error(r.error || 'mark_alerted failed');
    },
    getHealth: getRemindersHealth,
    onTick: (r) => {
      for (const f of r.fired || []) console.log(`[reminders] fired "${f.label}" (id ${f.id.slice(0, 8)})`);
      for (const a of r.alerted || []) console.log(`[reminders] event alert "${a.label}" (${a.whenIso ?? ''})`);
      for (const a of r.weatherAlerted || []) console.log(`[reminders] weather alert "${a.label}" (${a.whenIso ?? ''})`);
      for (const s of r.skipped || []) console.warn(`[reminders] skipped "${s.label ?? s.id}": ${s.error}`);
      // Weather refresh rides this same 30s tick, self-gated to a 6h cadence
      // (ride existing requests, gate in code). Fire-and-forget — never
      // blocks the reminders path.
      refreshWeatherIfDue().catch(err => console.error('[weather]', err?.message ?? err));
      // Elapsed stamping rides here too, self-gated to an hourly cadence.
      stampElapsedIfDue().catch(err => console.error('[elapsed-stamp]', err?.message ?? err));
    },
    onError: (err) => console.error('[reminders]', err?.message ?? err),
  });
  console.log('[reminders] Scheduler ENABLED (incl. event lead-time alerts; PROTO_FAMILIAR_EVENT_ALERTS_DISABLED=1 to silence those). Hard-disable with PROTO_FAMILIAR_REMINDERS_DISABLED=1.');
}

// ── Elapsed stamping (causal-chain fix piece 4, ward-signed) ──────
// A slow pure-code pass: one-off events past their end by more than the
// ward-configurable threshold (elapsedStampHours, default 24h) with no
// resolution get payload.elapsed_at stamped in Unruh. An observation,
// not a resolution — nothing is hidden or auto-resolved; the stamp only
// lets derivations tell "past, never followed up" from "still coming".
// Rides the reminders tick, gated in code to an hourly cadence; the
// stamping itself is idempotent Unruh-side. Hard off-switch:
// PROTO_FAMILIAR_ELAPSED_STAMP_DISABLED=1.
const ELAPSED_STAMP_INTERVAL_MS = 60 * 60_000;
let _lastElapsedStampMs = 0;
async function stampElapsedIfDue() {
  if (process.env.PROTO_FAMILIAR_ELAPSED_STAMP_DISABLED === '1') return;
  const nowMs = Date.now();
  if (nowMs - _lastElapsedStampMs < ELAPSED_STAMP_INTERVAL_MS) return;
  _lastElapsedStampMs = nowMs;
  const hours = clampElapsedStampHours(readSettingsSync()?.elapsedStampHours);
  const r = await stampElapsedEvents({ hours });
  if (r?.ok && r.count > 0) {
    console.log(`[elapsed-stamp] marked ${r.count} past unresolved event(s) as elapsed (>${hours}h past): ${r.stamped?.map(s => s.label ?? s.id).join(', ')}`);
  }
}

// ── Weather refresh (Weather sense, W-A) ─────────────────────────
// Rides the reminders tick. Only the CURRENT location refreshes here, and only
// when its cache is older than the 6h cadence (non-current places refresh
// lazily when asked about — W-B). Fetch failure keeps the stale cache and the
// [Now] line drops on its own past 12h; disabled / no current location clears
// the mirror so the line disappears immediately.
// Per-tick memo of the alert-window scan so the coming-up and severe-weather
// passes share ONE schedule fetch instead of two MCP round-trips every 30s
// (ride existing requests). Short TTL: both passes run inside the same tick.
let _alertScan = { at: 0, data: { windowNodes: [], recurringNodes: [] } };
async function fetchAlertScanData(nowMs) {
  if (Date.now() - _alertScan.at < 10_000) return _alertScan.data;
  const { fromIso, toIso } = alertWindowBounds({ nowMs, leadMs: MAX_LEAD_MS });
  const [win, rec] = await Promise.all([
    getScheduleWindow({ from_ts: fromIso, to_ts: toIso, limit: 100 }).catch(() => ({ nodes: [] })),
    listRecurring().catch(() => ({ nodes: [] })),
  ]);
  _alertScan = {
    at: Date.now(),
    data: {
      windowNodes: Array.isArray(win) ? win : (win?.nodes ?? []),
      recurringNodes: Array.isArray(rec) ? rec : (rec?.nodes ?? []),
    },
  };
  return _alertScan.data;
}

const WEATHER_REFRESH_MS = 6 * 60 * 60_000;
let _weatherRefreshing = false;

function weatherEnabled() {
  if (process.env.PROTO_FAMILIAR_WEATHER_DISABLED === '1') return false;
  return readSettingsSync()?.weatherEnabled !== false;   // default-ON
}

async function refreshWeatherIfDue({ now = Date.now(), force = false } = {}) {
  if (_weatherRefreshing) return;
  if (!weatherEnabled()) { await clearWeatherMirror(); return; }
  _weatherRefreshing = true;
  try {
    const res = await weatherLocationsPrivate();
    const locs = Array.isArray(res?.locations) ? res.locations : [];
    const current = locs.find(l => l.is_current);
    if (!current) { await clearWeatherMirror(); return; }   // no place set → no line
    if (!Number.isFinite(current.lat) || !Number.isFinite(current.lon)) return;

    const ageMs = current.fetched_at ? (now - Date.parse(current.fetched_at)) : Infinity;
    const stale = !(Number.isFinite(ageMs)) || ageMs > WEATHER_REFRESH_MS;
    if (!force && !stale) {
      // Cache still fresh: make sure the mirror reflects it (e.g. after a
      // restart, or the ward just switched current location).
      await syncWeatherMirror(current.id);
      return;
    }
    const fc = await fetchForecast(current.lat, current.lon, { timezone: current.timezone });
    if (!fc.ok) { console.warn(`[weather] fetch failed for ${current.label}: ${fc.error}`); return; }
    await ingestWeather({
      location_id: current.id, provider: fc.provider,
      fetched_at: fc.fetched_at, current: fc.current, hourly: fc.hourly,
    });
    await writeWeatherMirror({ provider: fc.provider, fetched_at: fc.fetched_at, current: fc.current, hourly: fc.hourly });
    console.log(`[weather] refreshed ${current.label} via ${fc.provider}`);
  } finally {
    _weatherRefreshing = false;
  }
}

// Re-point the read-mirror at a location's cached forecast without a fetch
// (used when the cache is fresh but the mirror may lag it — e.g. after a
// restart, or the ward just switched their current location).
async function syncWeatherMirror(locationId) {
  try {
    const r = await readWeather({ location_id: locationId });
    const w = r?.weather;
    if (w?.fetched_at && (Date.now() - Date.parse(w.fetched_at)) <= WEATHER_STALE_MS) {
      await writeWeatherMirror({ provider: w.provider, fetched_at: w.fetched_at, current: w.current, hourly: w.hourly });
    }
  } catch { /* best-effort */ }
}

// ── Google Calendar sync loop (0.8) ─────────────────────────────
// Inbound, mechanical, change-gated: fetch the ward's iCal feed →
// Unruh's gcal_ingest parses + reconciles → only genuinely NEW items
// get flagged for projection (the cue, Pass 3). Idles until the ward
// pastes an iCal URL and enables the toggle; cadence is ward-configurable
// (default hourly). A fetch/parse failure degrades silently and NEVER
// reconciles deletions (so a blip can't look like "the calendar emptied").
// Hard off-switch: PROTO_FAMILIAR_GCAL_DISABLED=1.

function gcalSyncIntervalMs(s) {
  // Settings stores minutes (ward-facing); the loop wants ms. A missing or
  // nonsensical value falls back to the hourly default; the loop clamps.
  const mins = Number(s?.gcalSyncIntervalMinutes);
  return Number.isFinite(mins) && mins > 0 ? mins * 60_000 : 60 * 60_000;
}

// Resolve the configured calendar command for a CLI source ('gogcli' /
// 'gcalcli'): the ward's explicit override if set, else the preset hint.
function gcalCliCommandFor(s) {
  const override = s?.gcalCliCommand && String(s.gcalCliCommand).trim();
  return override || cliPresetHint(s?.gcalSource) || '';
}

// Forward window the native Google read materialises (and the CLI tiers
// conceptually cover): 90 days ahead, matching the recurrence-expansion
// horizon. A windowed read, so deletions are caught via showDeleted, not
// reconcile.
const GCAL_DEFAULT_LOOKAHEAD_DAYS = 365;  // a year ahead by default
const GCAL_MIN_LOOKAHEAD_DAYS = 30;
const GCAL_MAX_LOOKAHEAD_DAYS = 1825;     // ~5 years

// How far ahead a pull fetches, ward-configurable (gcalLookaheadDays).
function gcalLookaheadDays(s = readSettingsSync()) {
  const n = Number(s?.gcalLookaheadDays);
  if (!Number.isFinite(n)) return GCAL_DEFAULT_LOOKAHEAD_DAYS;
  return Math.max(GCAL_MIN_LOOKAHEAD_DAYS, Math.min(GCAL_MAX_LOOKAHEAD_DAYS, Math.round(n)));
}

// A ward-local-naive ISO timestamp `deltaDays` from now, keeping the current
// wall-clock time. Whole-day arithmetic in a UTC frame avoids server-tz drift;
// the result stays in the ward's local frame (matching stored when_ts), which
// is what the schedule window query compares against. Used to default the
// Map/schedule view to a wide window without a tz mismatch.
function wardLocalShiftedISO(deltaDays, tz = readSettingsSync()?.wardTimeZone || null) {
  const nowIso = wardLocalNowISO(tz);            // "YYYY-MM-DDTHH:MM:SS" ward-local
  const [datePart, timePart] = nowIso.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d) + deltaDays * 86_400_000);
  return `${shifted.toISOString().slice(0, 10)}T${timePart || '00:00:00'}`;
}

// Sync (sources other than google are decided synchronously from settings;
// google needs an async token-store read, handled in isEnabled/fetchSource).
function gcalSourceConfigured(s) {
  if (!s || s.gcalEnabled !== true) return false;
  const src = s.gcalSource || 'link';
  if (src === 'link') return !!(s.gcalIcalUrl && String(s.gcalIcalUrl).trim());
  if (src === 'google') return true;  // real check (token present) is async, in isEnabled
  return !!gcalCliCommandFor(s);  // gogcli / gcalcli
}

// Read the ward's Google Calendar through the native API (the §1.5 advanced
// tier, reworked). Refreshes the access token as needed, lists a forward
// window (cancellations included), and returns normalized events for the
// same gcal_ingest. Windowed → reconcileDeletes:false. Never throws.
// Native Google: enumerate every calendar the account can read — its own AND
// any shared into it — and emit one per-calendar snapshot, each attributed
// from the ward-set map. Falls back to the single primary calendar when the
// stored token predates the calendar-list scope (the UI prompts a reconnect).
async function fetchGoogleSource() {
  const store = await readGoogleToken();
  if (!googleConnected(store)) return { ok: false, error: 'Google account not connected' };
  const fresh = await getFreshAccessToken(store, { save: (s) => writeGoogleToken(s) });
  if (!fresh.ok) return { ok: false, error: fresh.error };
  const s = readSettingsSync();
  const attributionMap = (s?.gcalCalendarAttribution && typeof s.gcalCalendarAttribution === 'object') ? s.gcalCalendarAttribution : {};
  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + gcalLookaheadDays(s) * 86_400_000).toISOString();

  let calendars = null;
  try {
    calendars = await listGoogleCalendars({ accessToken: fresh.accessToken });
  } catch (err) {
    console.warn(`[gcal] calendar list unavailable (${err?.message ?? err}) — syncing primary only; reconnect to grant shared-calendar read`);
  }

  // No list (old scope / API hiccup) → the historical single-calendar path.
  if (!calendars || !calendars.length) {
    try {
      const items = await listGoogleEvents({ accessToken: fresh.accessToken, calendarId: 'primary', timeMin, timeMax });
      return { ok: true, snapshots: [{ calendarId: 'primary', events: normalizeGoogleEvents(items, 'primary'), reconcileDeletes: false, includeLegacy: true }] };
    } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
  }

  // Remember what's out there so the ward/Familiar can attribute it.
  await writeCalendarCache(calendars.map(c => ({ ...c, source: 'google' }))).catch(() => {});
  const wardCal = wardCalendarId(calendars, attributionMap);

  const snapshots = [];
  for (const cal of calendars) {
    if (isIgnored(cal, attributionMap)) continue;   // ward marked this one skip
    let items;
    try { items = await listGoogleEvents({ accessToken: fresh.accessToken, calendarId: cal.id, timeMin, timeMax }); }
    catch (err) { console.warn(`[gcal] calendar "${cal.summary}" fetch failed: ${err?.message ?? err}`); continue; }
    snapshots.push({
      calendarId: cal.id,
      events: normalizeGoogleEvents(items, cal.id),
      attribution: resolveAttribution(cal, attributionMap),
      // Native is a windowed API read (showDeleted carries cancellations),
      // so it never uses the delete-reconcile pass — kept false as before.
      reconcileDeletes: false,
      includeLegacy: cal.id === wardCal,
    });
  }
  if (!snapshots.length) return { ok: false, error: 'no syncable calendars (all ignored or failed)' };
  return { ok: true, snapshots };
}

// iCal link tier, now multi-feed: the primary gcalIcalUrl plus any extra feeds
// in gcalIcalUrls ([{url,label}]). Each feed is its own attributable calendar,
// keyed by its URL; the primary feed adopts the pre-multi-calendar rows.
async function fetchIcalSnapshots(s) {
  const attributionMap = (s?.gcalCalendarAttribution && typeof s.gcalCalendarAttribution === 'object') ? s.gcalCalendarAttribution : {};
  const feeds = [];
  if (s?.gcalIcalUrl && String(s.gcalIcalUrl).trim()) feeds.push({ url: String(s.gcalIcalUrl).trim(), primary: true });
  for (const extra of (Array.isArray(s?.gcalIcalUrls) ? s.gcalIcalUrls : [])) {
    const url = String(extra?.url ?? '').trim();
    if (url) feeds.push({ url, label: extra?.label });
  }
  if (!feeds.length) return { ok: false, error: 'no iCal URL configured' };
  await writeCalendarCache(feeds.map(f => ({ id: f.url, summary: f.label || f.url, primary: !!f.primary, source: 'ical' }))).catch(() => {});
  const snapshots = [];
  for (const f of feeds) {
    const res = await fetchIcal(f.url);
    if (!res.ok) { console.warn(`[gcal] iCal feed failed: ${res.error ?? 'unknown'}`); continue; }
    snapshots.push({
      calendarId: f.url, icsText: res.icsText,
      attribution: resolveAttribution({ id: f.url, summary: f.label || f.url, primary: !!f.primary }, attributionMap),
      reconcileDeletes: true, includeLegacy: !!f.primary,
    });
  }
  if (!snapshots.length) return { ok: false, error: 'all iCal feeds failed' };
  return { ok: true, snapshots };
}

function startGcalSync() {
  if (process.env.PROTO_FAMILIAR_GCAL_DISABLED === '1') {
    console.log('[gcal] PROTO_FAMILIAR_GCAL_DISABLED=1 — calendar sync is OFF');
    return;
  }
  startGcalSyncLoop({
    isEnabled: async () => {
      const s = readSettingsSync();
      if (s?.gcalEnabled !== true) return false;
      if ((s.gcalSource || 'link') === 'google') return googleConnected(await readGoogleToken());
      return gcalSourceConfigured(s);
    },
    getIntervalMs: async () => gcalSyncIntervalMs(readSettingsSync()),
    // Source adapters, interchangeable behind the one seam (§1.5): the
    // out-of-the-box link tier (full iCal feed, reconciles deletes); the
    // native Google account (windowed API read); or an authenticated CLI
    // (gogcli/gcalcli). All produce input for the same gcal_ingest.
    fetchSource: async () => {
      const s = readSettingsSync();
      const src = s?.gcalSource || 'link';
      if (src === 'google') return fetchGoogleSource();
      if (src === 'gogcli' || src === 'gcalcli') {
        const baseCommand = gcalCliCommandFor(s);
        const format = s?.gcalCliFormat || (src === 'gcalcli' ? 'json' : 'ics');
        // Hand the command the look-ahead window via {timeMin}/{timeMax}/
        // {dateMin}/{dateMax}/{days} tokens, so a CLI that takes a date range
        // fetches the whole horizon instead of its narrow default.
        const lookaheadDays = gcalLookaheadDays(s);
        const now = new Date();
        const timeMin = now.toISOString();
        const timeMax = new Date(now.getTime() + lookaheadDays * 86_400_000).toISOString();
        // Multi-calendar CLI: for each configured calendar, substitute the
        // {calendar} token and run the command once. No calendars listed →
        // the single legacy invocation (back-compat).
        const attributionMap = (s?.gcalCalendarAttribution && typeof s.gcalCalendarAttribution === 'object') ? s.gcalCalendarAttribution : {};
        const cals = Array.isArray(s?.gcalCliCalendars) ? s.gcalCliCalendars.filter(c => c?.name) : [];
        if (!cals.length) return fetchViaCli({ command: baseCommand, format, timeMin, timeMax, lookaheadDays });
        await writeCalendarCache(cals.map((c, i) => ({ id: c.name, summary: c.label || c.name, primary: i === 0, source: src }))).catch(() => {});
        const snapshots = [];
        for (let i = 0; i < cals.length; i++) {
          const c = cals[i];
          const command = baseCommand.replaceAll('{calendar}', c.name);
          const res = await fetchViaCli({ command, format, timeMin, timeMax, lookaheadDays });
          if (!res.ok) { console.warn(`[gcal] CLI calendar "${c.name}" failed: ${res.error ?? 'unknown'}`); continue; }
          snapshots.push({
            calendarId: c.name, icsText: res.icsText, events: res.events,
            attribution: resolveAttribution({ id: c.name, summary: c.label || c.name, primary: i === 0 }, attributionMap),
            reconcileDeletes: res.reconcileDeletes === true, includeLegacy: i === 0,
          });
        }
        if (!snapshots.length) return { ok: false, error: 'all CLI calendars failed' };
        return { ok: true, snapshots };
      }
      return fetchIcalSnapshots(s);
    },
    ingest: async ({ icsText, events, reconcileDeletes, calendarId, includeLegacy, attribution }) =>
      ingestGcal({ icsText, events, reconcileDeletes, calendarId, includeLegacy, attribution }),
    // routeNew: the `new` ids are already flagged needs_projection at
    // insert (the cue reads that flag, Pass 3). This stays a log hook so a
    // first import is observable without coupling the loop to the cue.
    routeNew: async (ids) => { if (ids.length) console.log(`[gcal] ${ids.length} new calendar item(s) flagged for projection`); },
    onTick: (r) => {
      // Persist every real attempt so the UI can show "last sync / last
      // error" — a dead URL or expired token must be visible, not just a
      // console line ('disabled'/'not_due' wakes are skipped inside).
      recordSyncOutcome(r).catch(() => {});
      if (r.synced) {
        const parts = [];
        if (r.new?.length)     parts.push(`${r.new.length} new`);
        if (r.updated?.length) parts.push(`${r.updated.length} updated`);
        if (r.removed?.length) parts.push(`${r.removed.length} removed`);
        if (parts.length) console.log(`[gcal] synced — ${parts.join(', ')}`);
        for (const uid of r.complex_series || []) console.log(`[gcal] RRULE for "${uid}" too complex to map as a series — materialised next 90 days as individual events`);
      } else if (r.reason === 'fetch_failed' || r.reason === 'ingest_failed') {
        console.warn(`[gcal] sync skipped (${r.reason}): ${r.error} — retrying within 5 minutes`);
      }
      // 'disabled' / 'not_due' are silent.
    },
    onError: (err) => console.error('[gcal]', err?.message ?? err),
  });
  console.log('[gcal] Calendar sync loop ENABLED (idles until an iCal URL + toggle are set). Hard-disable with PROTO_FAMILIAR_GCAL_DISABLED=1.');
}

// ── Silence-triage loop (M12b) ──────────────────────────────────
// Every 5 min, asks: "user is quiet AND threat is elevated — should
// I gently reach out?" The DECISION is an LLM call (per design doc:
// "not a threshold check"). Conservative thresholds (severe=15min,
// high=1hr, moderate=4hr; calm/mild never trigger). Outbox dedup on
// `triage-<tier>-<4h-bucket>` rate-limits the same-tier banner to
// once per 4-hour window while still unacknowledged.

// decideTriageViaLLM, deliverToTrustedContact, checkAndFirePendingContacts,
// CONTACT_ESCALATION_DELAY_MS, and the triage event log all live in
// cerebellum.js (the motor module) — server.js only boots the loop.

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
    // enqueueAndDispatch: the check-in also pushes to the human's own
    // push channel (when configured) and records delivery state — the
    // escalation deadline counts from confirmed delivery.
    enqueueOutboxFn: enqueueAndDispatch,
    onTick: (r) => {
      // Persist every triage decision to the event log for debugging/auditing.
      appendTriageEventLog({
        threat:    r.threat ?? null,
        silenceMs: r.silenceMs ?? null,
        reason:    r.reason,
        decision:  r.decision ?? null,
        acted:     r.acted ?? false,
        // Wait-streak experiment (Pass 1): the count the prompt showed at
        // this deliberation, so streak values correlate with decisions.
        streakAtDecision: r.streakAtDecision ?? null,
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
  console.log(`[triage] Silence triage ENABLED. Re-check defaults: severe=${DEFAULT_RECHECK_MS.severe/60_000}min, high=${DEFAULT_RECHECK_MS.high/60_000}min, moderate=${DEFAULT_RECHECK_MS.moderate/60_000}min (LLM may shorten/lengthen). calm/mild never trigger. Hard-disable with PROTO_FAMILIAR_TRIAGE_DISABLED=1.`);
}

// ── Warm reach-out loop (companionship) ─────────────────────────
// The non-crisis counterpart to silence-triage: the Familiar reaches out
// warmly — to my human, or to a Village member tagged warm toward it —
// because a companion makes contact for fond and frivolous reasons too,
// not only emergencies. Decision is an LLM call (reachout.js); delivery is
// a ward banner (outbox kind 'reachout') or a villager DM (relayToDiscord),
// the latter always mirrored to my human. Stands down entirely when threat
// is elevated (triage owns that). Default-ON; toggle warmthEnabled in
// Settings or hard-disable with PROTO_FAMILIAR_WARMTH_DISABLED=1.

// Quiet hours for warm knocks — my human's configured night, on MY HUMAN'S
// clock (wardTimeZone), not the server's. A UTC container with a ward hours
// away used to shift the 23–08 window onto their daytime and silently
// suppress warm outreach for whole active stretches — the same cross-zone
// bug class 0.7.86 fixed for reminders. Start==end disables the window.
// Defaults to 23:00–08:00 ward-local.
function isWarmthQuietHours() {
  const s = readSettingsSync();
  let start = Number(s?.warmthQuietHoursStart);
  let end   = Number(s?.warmthQuietHoursEnd);
  if (!Number.isInteger(start) || start < 0 || start > 23) start = 23;
  if (!Number.isInteger(end)   || end   < 0 || end   > 23) end   = 8;
  if (start === end) return false; // window disabled
  const h = Number(wardLocalNowISO(s?.wardTimeZone).slice(11, 13));
  return start < end ? (h >= start && h < end) : (h >= start || h < end);
}

function startReachout() {
  if (process.env.PROTO_FAMILIAR_WARMTH_DISABLED === '1') {
    console.log('[reachout] PROTO_FAMILIAR_WARMTH_DISABLED=1 — warm reach-out loop is OFF');
    return;
  }
  startReachoutLoop({
    tickMs: 10 * 60_000,
    isEnabled: async () => {
      const s = readSettingsSync();
      if (s.warmthEnabled === false) return false;          // default-ON (undefined = on)
      const conn = connectionForFeature(s, 'reachout');
      return !!(conn?.apiKey && conn?.provider && conn?.model);
    },
    getThreat,
    getLastActivity: getLastUserActivity,
    isQuietHours: async () => isWarmthQuietHours(),
    getPendingTells: async () => {
      try {
        const intents = await getUnactedIntents({ limit: 5 });
        return intents.filter(t => t.kind === 'tell');
      } catch { return []; }
    },
    getWarmVillagers: async () => {
      try { return getWarmVillagers(await getVillageRegistry()); }
      catch { return []; }
    },
    decideReachout: decideReachoutViaLLM,
    // Ward knock → gentle banner + push. Dedup bucket so a hiccup can't
    // double-banner. If this knock finally says a flagged "tell", mark it.
    deliverWardKnock: async ({ message, tell, about, why }) => {
      const enq = await enqueueAndDispatch({
        kind:     'reachout',
        originId: reachoutBucketOriginId(),
        title:    'a thought from me',
        body:     message,
        ts:       new Date().toISOString(),
      });
      // Remember that I knocked, and what I meant by it — my human answers hours
      // later and I otherwise meet the reply with no idea I ever spoke.
      if (enq?.id && !enq?.deduped) {
        recordReachOut({ message, about, why, channel: 'ward-banner' })
          .catch(err => console.error('[reachout] recordReachOut failed:', err?.message ?? err));
      }
      if (enq?.id && !enq?.deduped && tell?.uid && Number.isInteger(tell.index)) {
        markIntentActedOn({ uid: tell.uid, index: tell.index })
          .catch(err => console.error('[reachout] markIntentActedOn failed:', err?.message ?? err));
      }
      return { ok: !!enq?.id, deduped: !!enq?.deduped };
    },
    // Villager reach → DM via the bot token, always mirrored to my human
    // (no covert contact — the same guarantee relay_message carries).
    deliverVillagerReach: async ({ villager, message }) => {
      const res = await relayToDiscord({ recipientUserId: villager.discordId, message });
      if (!res?.ok) return res ?? { ok: false, error: 'relay failed' };
      await enqueueAndDispatch({
        kind:     'relay',
        originId: `reachout-relay:${Date.now()}:${villager.name}`,
        title:    `I reached out to ${villager.name}`,
        body:     `To ${villager.name}: "${message}"`,
      }).catch(() => { /* the send happened; a mirror hiccup must not fail it */ });
      return { ok: true };
    },
    onTick: (r) => {
      if (r.reason === 'reached_ward')         console.log(`[reachout] warm knock to my human: "${r.decision?.message?.slice(0, 80)}…"`);
      else if (r.reason === 'reached_villager') console.log(`[reachout] warm reach to ${r.villager?.name}: "${r.decision?.message?.slice(0, 60)}…"`);
      else if (r.reason === 'delivery_failed')  console.warn(`[reachout] delivery failed (${r.target}): ${r.error}`);
      // Every DELIBERATION (an LLM decision happened — including "wait")
      // lands in the reachout event log so the loop is auditable via
      // /api/reachout-events. Pure gate outcomes (cooldown/disabled/
      // quiet-hours/crisis-defer) fire every tick and stay unlogged.
      const deliberated = ['llm_said_wait', 'reached_ward', 'reached_villager', 'delivery_failed', 'unknown_villager', 'rate_limited', 'ward_active'];
      if (deliberated.includes(r.reason)) {
        appendReachoutEventLog({
          reason:         r.reason,
          target:         r.target ?? null,
          villager:       r.villager?.name ?? null,
          messagePreview: r.decision?.message?.slice(0, 120) ?? null,
          nextCheckInMs:  r.nextCheckInMs ?? null,
          // Wait-streak experiment (Pass 1): the count the prompt showed.
          streakAtDecision: r.streakAtDecision ?? null,
          error:          r.error ?? null,
        }).catch(() => {});
      }
    },
    onError: (err) => console.error('[reachout]', err?.message ?? err),
  });
  console.log('[reachout] Warm reach-out ENABLED (default-ON). Stands down at moderate+ threat; quiet hours respected. Hard-disable with PROTO_FAMILIAR_WARMTH_DISABLED=1.');

  // Tome → Phylactery graduation (phase 4). OPT-IN: stays dormant until the
  // ward enables "Graduate tome knowledge" in Settings. Slow 30-min pass that
  // drains durable facts stranded in tomes into identity/memory. Hard
  // off-switch: PROTO_FAMILIAR_TOME_GRADUATION_DISABLED=1.
  startTomeGraduationLoop();

  // Content-gating re-tag (ward-disclosure spec, Phase B). OPT-IN (default OFF):
  // the Familiar reviews my human's EXISTING ward-private facts and, with
  // judgment, opens the ones that can be governed by content rules (keeping the
  // rest private) — every opening ward-visible + revertible. Hard off-switch:
  // PROTO_FAMILIAR_CONTENT_REGATE_DISABLED=1.
  startContentRegateLoop();

  // Needs-tracking (Pass 2). Opt-in (default OFF): marks a recurring
  // need-window's occurrence `missed` once its window elapses unresolved,
  // building the needs-fulfilment ledger. Stands down at moderate+ threat;
  // hard off-switch: PROTO_FAMILIAR_NEEDS_TRACKING_DISABLED=1.
  startNeedsTrackingLoop();
}

// ── Noticing loop (Initiative Pass 4) — the Familiar's own turn ──────
// The organ that lets the Familiar notice and act without my human spelling
// it out. Code-gated wake conditions → a bounded, tool-using deliberation.
// Does NOT stand down at threat (ward-signed); the tier shifts the register,
// never skips the turn. Default-ON; toggle noticingEnabled or hard-disable
// with PROTO_FAMILIAR_NOTICING_DISABLED=1.

// Gather the code-built wake inputs: due intentions, contact baseline + gap,
// readiness gaps, aging intentions. Best-effort — any piece failing degrades
// to empty (that condition just doesn't wake the turn), never throws.
async function gatherNoticingWakeInputs() {
  const s = readSettingsSync();
  const tz = s?.wardTimeZone || null;
  const nowMs = Date.now();
  const leadHours = Number.isFinite(Number(s?.readinessLeadHours)) ? Number(s.readinessLeadHours) : 48;
  // Ward-local-naive window bounds (not UTC toISOString) — get_window compares
  // these against ward-local-naive when_ts, so a UTC bound on a cross-zone
  // server slid the noticing window by the offset. wardLocalNowISO takes the
  // instant as its 2nd arg, so it renders any shifted moment in the ward's zone.
  const winFrom = wardLocalNowISO(tz, nowMs - 12 * 3600_000);
  const winTo   = wardLocalNowISO(tz, nowMs + leadHours * 3600_000);

  const [dueRes, baseline, lastAct, win, allIntents, tells] = await Promise.all([
    getDueIntentions({ now: wardLocalNowISO(tz) }).catch(() => ({ due: [] })),
    getContactBaseline({ now: nowMs, settings: s }).catch(() => ({ hasBaseline: false })),
    getLastUserActivity().catch(() => null),
    getScheduleWindow({ from_ts: winFrom, to_ts: winTo, limit: 200 }).catch(() => ({ nodes: [], edges: [] })),
    listIntentions({ limit: 200 }).catch(() => ({ intentions: [] })),
    getUnactedIntents({ limit: 10 }).catch(() => []),
  ]);

  const contactGapMs = lastAct?.ms ? Math.max(0, nowMs - lastAct.ms) : null;
  const nodes = Array.isArray(win?.nodes) ? win.nodes : [];
  const edges = Array.isArray(win?.edges) ? win.edges : [];
  // Edge endpoints outside the time window (undated states, PAST events that
  // carry consequence edges — a two-week-old therapy appointment rides here).
  const linked = Array.isArray(win?.linked) ? win.linked : [];
  // Read-only readiness detection — fresh flaggedAt so we NEVER consume the
  // stewardship loop's own cooldown state; noticing only *notices* the gap.
  const readiness = selectReadiness({ items: nodes, edges, nowMs, wardTimeZone: tz, leadHours, flaggedAt: {}, max: 2 });

  // Aging: my own intentions with no firing trigger, older than the threshold,
  // plus any still-unsaid tells. Capped so the report stays legible.
  const untriggered = (allIntents?.intentions ?? []).filter(i =>
    (i.trigger?.kind === 'none' || i.trigger?.kind === 'on_next_contact')
    && i.created_at && (nowMs - Date.parse(i.created_at) > AGING_INTENT_MS));
  const agingTells = (Array.isArray(tells) ? tells : []).filter(t => t.kind === 'tell');
  const agingIntents = [...untriggered, ...agingTells].slice(0, 3);

  // Aging floating tasks — my human's, no time set, unresolved, drifting past
  // the aging threshold. Floating tasks ride in `nodes` regardless of the time
  // window (get_window UNIONs them), so this catches the "28-day task nobody
  // surfaced" case. Capped for legibility.
  const agingTasks = nodes.filter(n =>
    n?.type === 'task' && !n.when && !n.resolution
    && n.created_at && (nowMs - Date.parse(n.created_at) > AGING_TASK_MS)
  ).slice(0, 3);

  // Overdue events — an appointment whose time has passed and I never recorded
  // how it went. Recently-past ones are in `nodes`; older edge-bearing ones (the
  // therapy 2 weeks ago) ride in `linked`. Scoping to what's reachable naturally
  // limits this to events that MATTER (carry consequences), not every past speck.
  const seenOverdue = new Set();
  const overdueEvents = [...nodes, ...linked].filter(n => {
    if (n?.type !== 'event' || n.resolution || !n.id || seenOverdue.has(n.id)) return false;
    const t = Date.parse(n.end || n.when || '');
    if (!Number.isFinite(t) || t >= nowMs - OVERDUE_EVENT_GRACE_MS) return false;
    seenOverdue.add(n.id);
    return true;
  }).slice(0, 3);

  return {
    dueIntentions: Array.isArray(dueRes?.due) ? dueRes.due : [],
    // Live signals for the condition code-gate. contactGapMs is wired;
    // missed-need / unresolved-ref signals are best-effort empty for now
    // (those conditions fail closed, which is the safe direction).
    signals: { contactGapMs },
    baseline,
    contactGapMs,
    readiness,
    agingIntents,
    agingTasks,
    overdueEvents,
    weekdayClass: weekdayClass(nowMs, tz),
  };
}

// The bounded, tool-using deliberation. Composes the noticing toolset, runs
// the tool-call loop, and reports which tools were EFFECTIVELY called (a
// reach-out refused during quiet hours is not counted as acting).
async function noticingDeliberate({ situationReport, threatTier, quietHours }) {
  const s = readSettingsSync();
  const conn = connectionForFeature(s, 'noticing');
  if (!conn?.apiKey || !conn?.model) return { toolNamesCalled: [] };

  const nowMs = Date.now();
  const [{ static: identity }, lastAct, recentMessages, recentMemories] = await Promise.all([
    enrich('', { staticOnly: true }).catch(() => ({ static: '' })),
    getLastUserActivity().catch(() => null),
    // Same recent context a live chat turn / warm reach-out gets, so noticing
    // isn't deciding blind to what was just said or what I hold from the last
    // day or two. Information only — no suppression, no stand-down (ward
    // decision); the no-look-away-at-threat posture is unchanged.
    getRecentSessionMessages({ limit: 6 }).catch(() => []),
    getRecentMemoryLines({ days: 2, limit: 8, now: nowMs }).catch(() => ''),
  ]);
  const nowBlock = buildTimeAnchorBlock({
    now: nowMs, lastUserMessageAt: lastAct?.ts ?? null, timeZone: s?.wardTimeZone || null,
    // Noticing is a ward-private deliberation → full weather line, in the
    // ward's chosen unit.
    weatherLine: readWeatherNowLine({ unit: s?.weatherUnit }),
  });
  const prompt = substituteMacros(buildNoticingPrompt({
    // flag_distress is in the noticing toolset now, so the prompt's
    // hand-to-triage clause names a lever the Familiar can actually pull.
    nowBlock, situationReport, threatTier, hasFlagDistress: true,
    recentConversation: formatRecentMessagesForContext(recentMessages, nowMs),
    recentMemories,
  }), s);
  const messages = [
    ...(identity ? [{ role: 'system', content: identity }] : []),
    { role: 'user', content: prompt },
  ];
  const tools = composeNoticingTools(s);

  let nextCheckInMs = null;
  const effectiveNames = [];
  const executeTool = async (name, argsJson, ctx) => {
    if (name === 'set_next_check') {
      let a = {}; try { a = argsJson ? JSON.parse(argsJson) : {}; } catch { /* ignore */ }
      const min = Number(a.minutes);
      if (Number.isFinite(min)) nextCheckInMs = min * 60_000;
      effectiveNames.push(name);
      return 'ok — I\'ll look again then.';
    }
    if (name === 'reach_out_to_ward') {
      let a = {}; try { a = argsJson ? JSON.parse(argsJson) : {}; } catch { /* ignore */ }
      const msg = stripLlmTimestamps(String(a.message ?? '').trim());
      if (!msg) return 'I need something to say before I can reach out.';
      // Quiet hours gate knocking (not the whole turn). Suppressed → NOT
      // counted as acting; I'm nudged to keep it as an intention instead.
      if (quietHours) return 'It\'s my human\'s quiet hours — I don\'t knock now. If this matters, I keep it as an intention (intention_set) to reach out later.';
      const enq = await enqueueAndDispatch({
        kind: 'reachout', originId: `noticing-${Date.now()}`,
        title: 'a thought from me', body: msg, ts: new Date().toISOString(),
      }).catch(() => null);
      if (enq?.id && !enq?.deduped) {
        recordReachOut({
          message: msg,
          about: String(a.about ?? '').trim(),
          why: String(a.why ?? '').trim(),
          channel: 'noticing',
        }).catch(err => console.error('[noticing] recordReachOut failed:', err?.message ?? err));
        effectiveNames.push(name); return 'Sent — my human will see it.';
      }
      return enq?.deduped ? 'I just reached out very recently, so I hold this rather than double-knock.' : 'I couldn\'t send that right now.';
    }
    // Registry tools: count the effective name, then dispatch normally.
    effectiveNames.push(name);
    return executeToolCall(name, argsJson, ctx);
  };

  try {
    await runToolCallLoop({
      callUpstream: (msgs, roundTools) => callChatRaw({ conn, messages: msgs, settings: s, tools: roundTools ?? tools }),
      baseMessages: messages,
      getTools:     () => tools,
      executeTool,
      toolCtx: { noticing: true, wardPrivate: true, apiKey: conn.apiKey },
    });
  } catch (err) {
    // A whole-loop failure surfaces as deliberation_failed upstream.
    throw err;
  }
  return { toolNamesCalled: effectiveNames, nextCheckInMs };
}

function startNoticing() {
  if (process.env.PROTO_FAMILIAR_NOTICING_DISABLED === '1') {
    console.log('[noticing] PROTO_FAMILIAR_NOTICING_DISABLED=1 — noticing loop is OFF');
    return;
  }
  startNoticingLoop({
    isEnabled: async () => {
      const s = readSettingsSync();
      if (s.noticingEnabled === false) return false;         // default-ON (undefined = on)
      const conn = connectionForFeature(s, 'noticing');
      return !!(conn?.apiKey && conn?.provider && conn?.model);
    },
    getThreat,
    getWakeInputs: gatherNoticingWakeInputs,
    // Quiet hours gate only KNOCKING (reach_out), passed through to the
    // deliberation — the turn itself still runs so intentions/reads work.
    isQuietHours: async () => isWarmthQuietHours(),
    deliberate:   noticingDeliberate,
    relInterval:  (ms) => plainInterval(Date.now() - ms, Date.now()),
    getWaitStreakFn:   () => { try { return getWaitStreak(); } catch { return null; } },
    recordWaitFn:      recordWait,
    recordProactiveFn: recordProactive,
    onTick: (r) => {
      if (r.reason === 'disabled' || r.reason === 'in_cooldown') return;
      // Every decision-reaching tick logs — including quiet windows — so a
      // dead loop reads as stale entries, not calm silence.
      appendNoticingEventLog({
        reason:           r.reason,
        acted:            r.acted ?? false,
        wakeConditions:   Array.isArray(r.conditions) ? r.conditions.map(c => c.kind) : [],
        toolsCalled:      r.toolNamesCalled ?? [],
        threatTier:       r.threat?.tier ?? null,
        streakAtDecision: r.streakAtDecision ?? null,
        nextCheckInMs:    r.nextCheckInMs ?? null,
        error:            r.error ?? null,
      }).catch(() => {});
      if (r.reason === 'acted')      console.log(`[noticing] acted (${(r.toolNamesCalled || []).join(', ')})`);
      else if (r.reason === 'stood_down') console.log(`[noticing] looked (${(r.conditions || []).map(c => c.kind).join(', ')}), stood down`);
    },
    onError: (err) => console.error('[noticing]', err?.message ?? err),
  });
  console.log('[noticing] Noticing ENABLED (default-ON). Runs at ALL threat tiers (ward-signed no-stand-down); wake-condition gated; self-paced. Hard-disable with PROTO_FAMILIAR_NOTICING_DISABLED=1.');
}

// Memory coverage sweep (day-anchoring Phase 2). Memorizes past days that never
// ingested. Default-ON; settings toggle "Memory coverage sweep"; hard off-switch
// PROTO_FAMILIAR_MEMORY_SWEEP_DISABLED=1. Only enqueues into the memorization
// worker, so it also stands down when that worker is disabled.
function startMemorySweep() {
  if (process.env.PROTO_FAMILIAR_MEMORY_SWEEP_DISABLED === '1') {
    console.log('[sweep] PROTO_FAMILIAR_MEMORY_SWEEP_DISABLED=1 — memory coverage sweep is OFF');
    return;
  }
  startMemorySweepLoop({
    isEnabled: async () => {
      if (process.env.PROTO_FAMILIAR_MEMORIZE_DISABLED === '1') return false; // worker off → nothing to feed
      const s = readSettingsSync();
      return s.memorySweepEnabled !== false; // default-ON (undefined = on)
    },
    getConnection: () => connectionForFeature(readSettingsSync(), 'memorization'),
    onTick: (r) => { if (r.acted) console.log(`[sweep] enqueued ${r.enqueued} slice(s) across ${r.days} past day(s)`); },
    onError: (err) => console.warn('[sweep] tick error:', err?.message ?? err),
  });
}

// Graceful shutdown — fires on SIGTERM (stop.sh / stop.bat / docker
// stop), SIGINT (Ctrl-C), and SIGHUP (terminal closes). Without this,
// the memorization setIntervals would keep the event loop alive past
// httpServer.close(), and the MCP children (Phylactery, Unruh) would
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
  // FIRST, before any await. A signal reaches the whole process group, so the
  // MCP children are already dying; without these flags set their onclose
  // handlers schedule reconnects mid-shutdown and spawn replacements while we
  // are trying to exit.
  try { markPeersShuttingDown(); } catch { /* thalamus never started */ }
  // Hard-exit safety net: never let a stuck handle keep the process
  // alive past this window. SIGKILL-equivalent if anything misbehaves.
  setTimeout(() => {
    console.error('[server] graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 5000).unref();
  try { httpServer.close(); } catch { /* already closed */ }
  try { await stopMemorizationWorker(); } catch { /* already stopped */ }
  // The audio worker is a child process holding hundreds of MB of models; it
  // gets stopped explicitly rather than left to die of stdin EOF, which is
  // slow on Windows and was already the reason this handler exists.
  try { stopAudioWorker(); } catch { /* already stopped */ }
  try { await stopPonderingLoop(); } catch { /* already stopped */ }
  try { await stopRemindersLoop(); } catch { /* already stopped */ }
  try { await stopGcalSyncLoop(); } catch { /* already stopped */ }
  try { await stopSilenceTriageLoop(); } catch { /* already stopped */ }
  try { await stopReachoutLoop(); } catch { /* already stopped */ }
  try { await stopTomeGraduationLoop(); } catch { /* already stopped */ }
  try { await stopContentRegateLoop(); } catch { /* already stopped */ }
  try { await stopNeedsTrackingLoop(); } catch { /* already stopped */ }
  try { await stopMemorySweepLoop(); } catch { /* already stopped */ }
  try { await stopNoticingLoop(); } catch { /* already stopped */ }
  try { stopDiscordGateway(); } catch { /* already stopped */ }
  try { shutdownPhylactery(); } catch { /* already disconnected */ }
  try { shutdownUnruh(); } catch { /* already disconnected */ }
  try { import('./zai-vision.js').then(m => m.shutdownZaiVision()).catch(() => {}); } catch { /* never spawned */ }
  // Give the close handshakes a tiny window, then exit.
  setTimeout(() => process.exit(0), 250).unref();
}
process.on('SIGTERM', () => handleSignal('SIGTERM'));
process.on('SIGINT',  () => handleSignal('SIGINT'));
process.on('SIGHUP',  () => handleSignal('SIGHUP'));
