'use strict';

/* ================================================================
   Proto-Familiar — frontend application
   Handles state, API communication, UI rendering.
   ================================================================ */

// ── Provider / model catalogue ──────────────────────────────────
const PROVIDER_MODELS = {
  nanogpt: [
    'gpt-4o',
    'gpt-4o-mini',
    'chatgpt-4o-latest',
    'claude-opus-4-5',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022',
    'gemini/gemini-2.5-pro',
    'gemini/gemini-2.0-flash',
    'deepseek/deepseek-r1',
    'deepseek/deepseek-v3',
    'meta-llama/llama-3.3-70b-instruct',
  ],
  zai: [
    'glm-5.1',
    'glm-5',
    'glm-5-turbo',
    'glm-4.7',
    'glm-4.5',
    'glm-4.5-air',
    'glm-4-flash',
    'glm-z1-rumination',
  ],
  // Coding Plan uses its own quota endpoint but the same model names.
  // Only models available under the plan are listed here.
  'zai-coding': [
    'glm-5.1',
    'glm-5',
    'glm-5-turbo',
    'glm-4.7',
    'glm-4.5-air',
  ],
  // Google AI Studio via its OpenAI-compatible endpoint — bare model ids
  // (no "models/" prefix needed on that surface).
  google: [
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
  ],
};

const PROVIDER_DEFAULT_MODEL = {
  nanogpt:      'gpt-4o-mini',
  zai:          'glm-4.7',
  'zai-coding': 'glm-4.7',
  google:       'gemini-2.5-flash',
};

// ── ID generation ────────────────────────────────────────────
function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ── Tool calling ───────────────────────────────────────────────
/**
 * Tool execution lives server-side in cerebellum.js as of 0.4.0-alpha:
 * /api/chat runs the multi-round tool-call loop on the server and sends
 * `_toolRound` events (streaming) or a `_toolRounds` array
 * (non-streaming) back, so the chat can render the collapsible tool
 * blocks without executing anything. The browser advertises only the
 * user's custom tools; the built-in registry is composed server-side.
 */

/** Parse the user's custom tool definitions (Settings -> Custom tools).
 *  Returns a (possibly empty) array. Custom tools are ADVERTISE-ONLY:
 *  the model sees them and may call them, but no executor exists yet,
 *  so calls come back as structured "not implemented" results. */
function getCustomTools() {
  if (!state.customTools || !state.customTools.trim()) return [];
  try {
    const extra = JSON.parse(state.customTools);
    return Array.isArray(extra) ? extra : [];
  } catch { return []; } // invalid JSON - silently skip
}

/** Session metadata for the server-side get_session_info tool. */
function buildSessionInfo() {
  return {
    sessionId:    state.sessionId,   // lets the Familiar's memorize_now find this session's log
    startedAt:    state.sessionStartedAt,
    messageCount: state.messages.length,
    provider:     state.provider,
    model:        state.model,
    elapsedMsSinceLastMessage: elapsedTime,
  };
}

/** The request-body fields that opt this send into the server-side
 *  tool loop. Empty object when the user has tools disabled. */
function toolLoopPayload() {
  if (!state.toolsEnabled) return {};
  return {
    runToolLoop: true,
    customTools: getCustomTools(),
    sessionInfo: buildSessionInfo(),
  };
}

// ── Session timing ──────────────────────────────────────────────
/** ISO timestamp of the most recent message — persisted so the 3-hour
 *  inactivity timer can be recovered correctly after a page reload. */
let lastMessage       = null;
/** Milliseconds between the previous message and the most recent user
 *  send — updated each time the user submits a message. */
let elapsedTime       = 0;
/** Handle for the 3-hour auto-end setTimeout. */
let _sessionTimeoutId = null;

// ── Diagnostic ring buffer ──────────────────────────────────────
// Bounded log of recent app events for the Diagnostics report. Captures
// uncaught errors, unhandled rejections, console.error/warn output,
// failing network calls, and a few explicit checkpoints (sessions,
// memorization, tool execution, knowledge edits). Kept small enough to
// paste into a bug report without truncation.
const DEBUG_LOG_CAP = 200;
const debugLog = [];
function debugRecord(type, detail) {
  try {
    debugLog.push({ ts: new Date().toISOString(), type, detail: String(detail).slice(0, 800) });
    if (debugLog.length > DEBUG_LOG_CAP) debugLog.splice(0, debugLog.length - DEBUG_LOG_CAP);
  } catch { /* never let logging break the app */ }
}
// Hook the console so existing console.error/warn calls land in the log
// too, without changing what the developer sees in DevTools.
(function installConsoleHooks() {
  const origErr = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...args) => { debugRecord('console.error', args.map(a => typeof a === 'string' ? a : (a?.message ?? JSON.stringify(a))).join(' ')); origErr(...args); };
  console.warn  = (...args) => { debugRecord('console.warn',  args.map(a => typeof a === 'string' ? a : (a?.message ?? JSON.stringify(a))).join(' ')); origWarn(...args); };
  window.addEventListener('error', e => debugRecord('window.error', `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`));
  window.addEventListener('unhandledrejection', e => debugRecord('unhandledrejection', e.reason?.message ?? e.reason ?? '?'));
})();
/** Milliseconds of inactivity before the current session is closed (3 h). */
const SESSION_IDLE_MS = 3 * 60 * 60 * 1000;

// ── State ────────────────────────────────────────────────────────
const state = {
  provider:          'nanogpt',
  apiKey:            '',
  model:             'gpt-4o-mini',
  streaming:         true,
  temperature:       0.8,
  maxTokens:         2048,
  userName:          'My human',
  charName:          'Assistant',
  systemPrompt:      '',
  characterProfile:  '',
  userProfile:       '',
  postHistoryPrompt: '',
  postHistoryRole:   'system',
  sessionId:               null,   // UUID, created at init or on clear
  sessionStartedAt:        null,   // ISO timestamp
  sessionEndedAt:          null,   // ISO timestamp — set when session is auto-ended
  previousSessionEndedAt:  null,   // ISO timestamp of the most recent prior session's endedAt — drives {{timeSinceLastSession}}
  lastMessage:             null,   // ISO timestamp — mirrors the module-level lastMessage
  messages:                [],     // { role, content, timestamp }[]
  // ── Tool calling ──────────────────────────────────────────
  toolsEnabled:      true,   // whether to send tools array with each request
  customTools:       '',     // JSON array string of user-defined tool definitions
  // ── Web search (opt-in; works in-box, no setup) ─────────────
  webSearchEnabled:    false,
  // Backend for web_search (finding pages). 'basic' = built-in keyless scrape
  // (the floor, no setup); 'api' = a proper provider key; 'local' = a Familiar-
  // managed engine. look_up (definitions) ignores all of this.
  webSearchBackend:     'basic',     // 'basic' (DuckDuckGo floor) | 'api'
  webSearchApiProvider: 'marginalia',// 'marginalia' | 'tavily' | 'brave' | 'google'
  webSearchApiKey:      '',          // provider key (secret; lives in gitignored settings.json)
  webSearchGoogleCseId: '',          // Google only — Programmable-Search engine id
  webSearchMaxResults: 5,
  webSearchMaxChars:   15000,
  // ── Topics & tomes (lorebook) ───────────────────────────
  tomeScanDepth:         4,      // how many recent messages to scan for keyword matches
  tomeRecursive:         false,  // enable recursive tome entry activation
  tomeMaxRecursionSteps: 3,      // max recursive passes
  tomeCaseSensitive:     false,  // global case-sensitive keyword matching
  tomeMatchWholeWords:   false,  // global whole-word keyword matching
  turnCount:             0,      // conversation turn counter (used by entry.delay)
  generationMode:        'normal', // current generation mode (used by entry.triggers[])
  tomeCache:         {},         // { [tomeId]: tomeObject } — not persisted
  tomeRegistry:      [],         // array of { id, name, enabled, entryCount } — not persisted
  topics:            [],         // session-level; stored under pf_topics_{sessionId}
  // ── Saved connections (primary + fallbacks) ─────────────
  connections:             [],   // [{ id, name, provider, apiKey, model }]
  primaryConnectionId:     null, // id of the active/primary connection
  fallbackConnectionIds:   [],   // ordered ids tried when primary fails/returns empty
  maxEmptyRetries:         2,    // retries per connection when response is empty
  phylacteryConnectionId:  null, // id of the connection whose API key Phylactery uses
  // ── Prompt-cache tuning ──────────────────────────────────
  // How many messages from the end of the conversation the dynamic
  // thalamus block gets injected at. Static identity stays at the
  // top so the provider's prefix cache covers it; dynamic (memories /
  // graph / temporal) goes N positions deep so it doesn't invalidate
  // the prefix. 4 is a balance between cache wins and the model
  // seeing the retrieved memories close to the current question.
  thalamusDynamicDepth:    4,
  // ── Session handoff (M6) ─────────────────────────────────
  // When on, the end of a session triggers a small LLM call (cheapest
  // available connection) that summarises the conversation into an
  // intent + open threads, stored in Unruh and surfaced at the top of
  // the next session's [Temporal Context] so the Familiar resumes
  // mid-thought. It's one extra short generation per session boundary;
  // turn it off if you'd rather not spend that.
  handoffEnabled:          true,

  // Autonomous pondering loop (step 4a). When on, the server wakes
  // the Familiar on its own cadence during idle periods to think
  // about whatever's on its mind (highest interest weights), writing
  // real entries to the Familiar's Ponderings tome. Default on.
  // The scale multiplier lets the user STRETCH (≥1×) the cadence
  // to reduce token spend — base tiers are already conservative
  // (30 min to 6 hr). Off via this toggle, or hard-disable with the
  // PROTO_FAMILIAR_PONDERING_DISABLED=1 env var on the server.
  ponderingEnabled:        true,
  ponderingIntervalScale:  1,

  // Warm reach-outs (companionship loop). Default-ON: the Familiar
  // reaches out warmly on its own, not only in crisis. Quiet hours are
  // a local-time window (start==end disables it). Off via this toggle or
  // the PROTO_FAMILIAR_WARMTH_DISABLED=1 env var on the server.
  warmthEnabled:           true,
  // Memory coverage sweep (day-anchoring Phase 2). Default-ON: a slow pass that
  // memorizes past days that never ingested. Off via this toggle or the
  // PROTO_FAMILIAR_MEMORY_SWEEP_DISABLED=1 env var on the server.
  memorySweepEnabled:      true,
  tomeGraduationEnabled:   false,   // opt-in: writes to the canonical self
  tomeGraduationTidy:      'pointer',
  warmthQuietHoursStart:   23,
  warmthQuietHoursEnd:     8,

  // Trusted contacts for silence-triage outreach (M12c). Each entry
  // is { name, channel: 'discord', webhook: 'https://discord.com/api/webhooks/…' }.
  // The triage LLM may *suggest* contacting one of these (by name) when
  // it judges the situation calls for it. The system delivers AND logs
  // every outbound to the chat outbox — there is no covert contact.
  // Empty list = the LLM has nothing to suggest, no outbound ever happens.
  trustedContacts:         [],

  // The bonded human's OWN Discord webhook (push notifications). When
  // set, every outbox delivery (reminders, check-ins, outbound-alert
  // mirrors, crisis resources) is ALSO pushed there, so nothing stays
  // silent just because no tab is open. Delivery state is recorded per
  // item; the trusted-contact escalation deadline counts from confirmed
  // delivery. Empty = in-app delivery only.
  userDiscordWebhook:      '',

  // Discord presence (Village V4 — gateway bot). The Familiar joins
  // Discord as a bot: ward DMs get full context, registered villagers
  // get gated context, guild replies only when @-mentioned. The token
  // is server-synced so the gateway (which runs server-side) can read it.
  discordEnabled:    false,
  discordBotToken:   '',
  discordWardUserId: '',

  // Session audience (Village Support V2).
  // Tracks who is physically present during this session so the Familiar
  // can reference them and (in V3) gate knowledge appropriately.
  // Ephemeral: not synced to the server, cleared on new session.
  sessionAudience: { location: null, participants: [] },
};

// ── Persistence ──────────────────────────────────────────────────
//
// Settings live centrally on the server (so opening Proto-Familiar on a
// second device doesn't reset prompts, names, and saved connections).
// localStorage is a fast offline cache that gets refreshed from the
// server on every page load.
//
// SERVER_SYNCED_KEYS is the subset of `state` that's user preference
// rather than per-device session state. Session timing (sessionId,
// sessionStartedAt, …) stays local — syncing it across devices would
// be weird (e.g. device A's idle timer applying to device B).
const SERVER_SYNCED_KEYS = [
  'provider', 'apiKey', 'model', 'streaming', 'temperature', 'maxTokens',
  'userName', 'charName',
  'systemPrompt', 'characterProfile', 'userProfile', 'postHistoryPrompt', 'postHistoryRole',
  'toolsEnabled', 'customTools',
  'webSearchEnabled', 'webSearchBackend', 'webSearchApiProvider', 'webSearchApiKey',
  'webSearchGoogleCseId', 'webSearchMaxResults', 'webSearchMaxChars',
  'tomeScanDepth', 'tomeRecursive', 'tomeMaxRecursionSteps',
  'tomeCaseSensitive', 'tomeMatchWholeWords',
  'connections', 'primaryConnectionId', 'fallbackConnectionIds', 'maxEmptyRetries',
  'phylacteryConnectionId',
  'thalamusDynamicDepth', 'handoffEnabled',
  'ponderingEnabled', 'ponderingIntervalScale',
  'warmthEnabled', 'warmthQuietHoursStart', 'warmthQuietHoursEnd',
  'memorySweepEnabled',
  'tomeGraduationEnabled', 'tomeGraduationTidy',
  'trustedContacts', 'userDiscordWebhook',
  'discordEnabled', 'discordBotToken', 'discordWardUserId',
];
function extractServerSettings(s) {
  const out = {};
  for (const k of SERVER_SYNCED_KEYS) if (k in s) out[k] = s[k];
  return out;
}
let _settingsPutTimer = null;
function pushSettingsToServer() {
  clearTimeout(_settingsPutTimer);
  _settingsPutTimer = setTimeout(() => {
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: extractServerSettings(state) }),
    }).catch(err => console.warn('settings sync to server failed', err));
  }, 500);
}

function saveSettings() {
  try {
    const { messages: _ignored, tomeCache: _tc, tomeRegistry: _tr, topics: _t, ...settings } = state;
    localStorage.setItem('pf_settings', JSON.stringify(settings));
  } catch { /* quota exceeded — silently skip */ }
  pushSettingsToServer();
}

function saveTopics() {
  if (!state.sessionId) return;
  try {
    localStorage.setItem(`pf_topics_${state.sessionId}`, JSON.stringify(state.topics));
  } catch { /* quota exceeded */ }
}

// ── Web search backend modal ───────────────────────────────────
// The picker for how web_search finds pages (Basic DuckDuckGo / a search API).
// look_up (definitions) is unaffected. The backend layer lives in websearch.js
// / websearch-providers.js.
function setRadio(name, value) {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
}

function openWebSearchModal() {
  writeSettingsToUI();      // reflect current state into the modal fields
  syncWebSearchPanels();
  resetGuideChat();         // fresh, ephemeral explainer conversation
  $('websearch-modal')?.classList.remove('hidden');
}

function closeWebSearchModal() {
  $('websearch-modal')?.classList.add('hidden');
}

// Show the API panel only for the API backend; the Google engine-id field only
// for Google; the Marginalia "no key" hint only for Marginalia.
function syncWebSearchPanels() {
  const backend  = document.querySelector('input[name="web-search-backend"]:checked')?.value || 'basic';
  $('websearch-api-panel')?.classList.toggle('hidden', backend !== 'api');
  const provider = document.querySelector('input[name="web-search-api-provider"]:checked')?.value || 'marginalia';
  $('websearch-google-cse-field')?.classList.toggle('hidden', provider !== 'google');
  $('websearch-marginalia-hint')?.classList.toggle('hidden', provider !== 'marginalia');
}

// Apply just persists the chosen backend/provider/key (fields also auto-sync on
// change; this gives explicit feedback). No process to reconcile.
async function applyWebSearchBackend() {
  const btn    = $('websearch-apply-btn');
  const status = $('websearch-apply-status');
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Saving…';
  try {
    readSettingsFromUI(); // pull every modal field into state (also persists)
    await fetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: extractServerSettings(state) }),
    });
    if (status) status.textContent = 'Saved.';
  } catch {
    if (status) status.textContent = 'Saved locally.';
  }
  if (btn) btn.disabled = false;
  setTimeout(() => { if (status) status.textContent = ''; }, 3000);
}

// ── In-modal Familiar explainer (the guide chat) ────────────────
// The same Familiar, scoped to explaining the search options. Ephemeral to the
// modal (history resets each open); never persisted.
let _guideHistory = [];
let _guidePending = false;

// The connection creds the guide chat sends (same as the main chat path).
function guideConn() {
  const c = (typeof getPrimaryConnection === 'function' && getPrimaryConnection()) || null;
  const provider = c?.provider || state.provider;
  const apiKey   = c?.apiKey   || state.apiKey;
  const model    = c?.model    || state.model;
  if (!provider || !apiKey || !model) return null;
  return { provider, apiKey, model };
}

function resetGuideChat() {
  _guideHistory = [];
  _guidePending = false;
  const ok = !!guideConn();
  $('guide-chat-unavailable')?.classList.toggle('hidden', ok);
  const input = $('guide-chat-input');
  const send  = $('guide-chat-send');
  if (input) input.disabled = !ok;
  if (send)  send.disabled  = !ok;
  renderGuideChat();
}

function renderGuideChat() {
  const host = $('guide-chat-messages');
  if (!host) return;
  host.innerHTML = '';
  for (const m of _guideHistory) {
    const b = document.createElement('div');
    const mine = m.role === 'user';
    b.style.cssText = `align-self:${mine ? 'flex-end' : 'flex-start'};max-width:85%;padding:6px 10px;` +
      `border-radius:10px;white-space:pre-wrap;word-break:break-word;` +
      (mine ? 'background:var(--accent,#3a6c5a);color:#fff'
            : `background:var(--surface-2,#2a2a2a);${m.error ? 'opacity:.8;font-style:italic' : ''}`);
    b.textContent = m.content;
    host.appendChild(b);
  }
  if (_guidePending) {
    const t = document.createElement('div');
    t.className = 'field-hint'; t.textContent = '…'; t.style.alignSelf = 'flex-start';
    host.appendChild(t);
  }
  host.scrollTop = host.scrollHeight;
}

async function sendGuideChat() {
  const input = $('guide-chat-input');
  const text  = input ? input.value.trim() : '';
  if (!text || _guidePending) return;
  const conn = guideConn();
  if (!conn) { resetGuideChat(); return; }

  _guideHistory.push({ role: 'user', content: text });
  if (input) input.value = '';
  _guidePending = true;
  renderGuideChat();

  try {
    const r = await fetch('/api/guide-chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ...conn, messages: _guideHistory }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `request failed (${r.status})`);
    const content = (typeof stripDisplayTimestamps === 'function')
      ? stripDisplayTimestamps(data.content || '')
      : (data.content || '');
    _guideHistory.push({ role: 'assistant', content: content || '(no reply)' });
  } catch (err) {
    _guideHistory.push({ role: 'assistant', content: `I couldn't answer just now (${err.message}).`, error: true });
  } finally {
    _guidePending = false;
    renderGuideChat();
    input?.focus();
  }
}

function saveHistory() {
  try {
    localStorage.setItem('pf_history', JSON.stringify(state.messages));
  } catch { /* quota exceeded */ }
  saveToServer(); // fire-and-forget
}

function loadPersisted() {
  try {
    const raw = localStorage.getItem('pf_settings');
    if (raw) Object.assign(state, JSON.parse(raw));
  } catch { /* corrupt storage */ }
  try {
    const raw = localStorage.getItem('pf_history');
    if (raw) state.messages = JSON.parse(raw);
  } catch { /* corrupt storage */ }
  // Ensure a session ID exists
  if (!state.sessionId) {
    state.sessionId        = generateId();
    state.sessionStartedAt = new Date().toISOString();
    saveSettings();
  }
  // Load session-scoped topics
  try {
    const rawTopics = localStorage.getItem(`pf_topics_${state.sessionId}`);
    if (rawTopics) state.topics = JSON.parse(rawTopics);
  } catch { /* corrupt */ }
  // Normalize connection-related fields after restore from disk
  if (!Array.isArray(state.connections))           state.connections = [];
  if (!Array.isArray(state.fallbackConnectionIds)) state.fallbackConnectionIds = [];
  if (typeof state.maxEmptyRetries !== 'number')   state.maxEmptyRetries = 2;
  if (typeof state.thalamusDynamicDepth !== 'number'
      || state.thalamusDynamicDepth < 1
      || state.thalamusDynamicDepth > 50) {
    state.thalamusDynamicDepth = 4;
  }
  if (typeof state.handoffEnabled !== 'boolean') state.handoffEnabled = true;
  if (typeof state.ponderingEnabled !== 'boolean') state.ponderingEnabled = true;
  if (typeof state.ponderingIntervalScale !== 'number'
      || state.ponderingIntervalScale < 1
      || state.ponderingIntervalScale > 10) {
    state.ponderingIntervalScale = 1;
  }
  if (typeof state.warmthEnabled !== 'boolean') state.warmthEnabled = true;
  if (typeof state.memorySweepEnabled !== 'boolean') state.memorySweepEnabled = true;
  if (!Number.isInteger(state.warmthQuietHoursStart)
      || state.warmthQuietHoursStart < 0 || state.warmthQuietHoursStart > 23) {
    state.warmthQuietHoursStart = 23;
  }
  if (!Number.isInteger(state.warmthQuietHoursEnd)
      || state.warmthQuietHoursEnd < 0 || state.warmthQuietHoursEnd > 23) {
    state.warmthQuietHoursEnd = 8;
  }
  if (!Array.isArray(state.trustedContacts)) state.trustedContacts = [];
  migrateLegacyConnection();
}

// True for non-empty strings / non-empty arrays / any non-null number /
// any non-null object. Used by the merge logic to decide whether a field
// is "carrying real user data" versus just a default/empty placeholder.
function isMeaningfulSetting(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v))      return v.length > 0;
  return true;
}

// Union two connection arrays by id, with a soft-duplicate guard:
// if two connections from different devices have different ids but
// identical (provider, model, apiKey), treat them as the same entry
// and keep the existing one. Otherwise both survive.
function unionConnections(remote = [], local = []) {
  const byId = new Map();
  for (const c of remote) if (c && c.id) byId.set(c.id, c);
  for (const c of local) {
    if (!c || !c.id) continue;
    if (byId.has(c.id)) continue;
    let isDupe = false;
    for (const existing of byId.values()) {
      if (existing.provider === c.provider
          && existing.model    === c.model
          && existing.apiKey   === c.apiKey) { isDupe = true; break; }
    }
    if (!isDupe) byId.set(c.id, c);
  }
  return [...byId.values()];
}

// One-time absorption: when this device first contacts a server that
// already has data, fold the device's local values into the server
// payload before treating server as source of truth. Scalars from the
// server win when both sides are meaningful (server is presumed most
// recent across the tailnet); the local value is kept only when the
// server has nothing. Connections / fallbacks are unioned so different
// devices' saved presets all survive.
function absorbLocalIntoRemote(remote, local) {
  const merged = { ...remote };
  for (const k of SERVER_SYNCED_KEYS) {
    if (k === 'connections' || k === 'fallbackConnectionIds' || k === 'primaryConnectionId') continue;
    if (isMeaningfulSetting(local[k]) && !isMeaningfulSetting(remote[k])) {
      merged[k] = local[k];
    }
  }
  merged.connections = unionConnections(remote.connections, local.connections);
  merged.primaryConnectionId = remote.primaryConnectionId
    || local.primaryConnectionId
    || (merged.connections[0]?.id ?? null);
  const fallbackUnion = [
    ...(Array.isArray(remote.fallbackConnectionIds) ? remote.fallbackConnectionIds : []),
    ...(Array.isArray(local.fallbackConnectionIds)  ? local.fallbackConnectionIds  : []),
  ];
  merged.fallbackConnectionIds = [...new Set(fallbackUnion)]
    .filter(id => id !== merged.primaryConnectionId)
    .filter(id => merged.connections.find(c => c.id === id));
  return merged;
}

// Pull the canonical settings from the server and overlay them onto the
// in-memory state. Called once at startup, after the synchronous
// localStorage load has already painted the UI from the offline cache.
//
// First-run absorption: each device flips `pf_settings_absorbed` in its
// own localStorage the first time this sync completes. Until that flag
// is set, anything the user had locally that the server doesn't yet
// know about is folded in (scalars keep server values when both are set,
// connections are unioned). After that, the server is the source of
// truth and a plain overlay runs.
const ABSORBED_FLAG_KEY = 'pf_settings_absorbed';

async function syncSettingsFromServer() {
  let remote;
  try {
    const r = await fetch('/api/settings');
    if (!r.ok) return;
    const data = await r.json();
    remote = data.settings ?? null;
  } catch (err) {
    console.warn('initial settings fetch failed', err);
    return;
  }
  const alreadyAbsorbed = (() => {
    try { return localStorage.getItem(ABSORBED_FLAG_KEY) === '1'; }
    catch { return false; }
  })();

  if (!remote || typeof remote !== 'object') {
    // Server is empty — seed it from whatever we just loaded out of
    // localStorage so the user doesn't lose anything on the next load.
    pushSettingsToServer();
    try { localStorage.setItem(ABSORBED_FLAG_KEY, '1'); } catch {}
    return;
  }

  // Re-snapshot AT MERGE TIME (not at function entry) so that any
  // keystrokes the user landed during the in-flight fetch are folded in
  // rather than discarded. Field listeners write straight into `state`
  // via readSettingsFromUI, so this always reflects the freshest values.
  const freshSnapshot = extractServerSettings(state);
  const effective = alreadyAbsorbed
    ? remote
    : absorbLocalIntoRemote(remote, freshSnapshot);

  for (const k of SERVER_SYNCED_KEYS) {
    if (k in effective) state[k] = effective[k];
  }
  // Migrate field rename from 0.6.x: entityCoreConnectionId → phylacteryConnectionId.
  // settings.json written before the rename still has the old key; the server handles
  // it server-side too, but the UI needs its own copy so the connection picker renders.
  if (!state.phylacteryConnectionId && effective?.entityCoreConnectionId) {
    state.phylacteryConnectionId = effective.entityCoreConnectionId;
    pushSettingsToServer(); // persist the renamed field immediately
  }
  if (!Array.isArray(state.connections))           state.connections = [];
  if (!Array.isArray(state.fallbackConnectionIds)) state.fallbackConnectionIds = [];
  migrateLegacyConnection();
  writeSettingsToUI();
  renderConnectionsList();
  refreshModelSuggestions(state.provider);

  // Mirror the resolved state back to localStorage, and push the
  // (possibly absorbed) result up so the server keeps the new entries.
  try {
    const { messages: _i, tomeCache: _tc, tomeRegistry: _tr, topics: _t, ...settings } = state;
    localStorage.setItem('pf_settings', JSON.stringify(settings));
  } catch { /* quota */ }
  if (!alreadyAbsorbed) {
    pushSettingsToServer();
    try { localStorage.setItem(ABSORBED_FLAG_KEY, '1'); } catch {}
  }
}

// ── Auto-sync: resume most recent session from server ──────────
// Runs once at startup, after settings are synced. If the server has a
// session that this device doesn't have loaded, either auto-loads it
// (when the local session is empty and the server session is recent) or
// shows a non-blocking banner so the user can decide.
async function autoResumeMostRecentSession() {
  let remote;
  try {
    const r = await fetch('/api/active-session');
    if (!r.ok) return;
    remote = await r.json();
  } catch { return; }

  if (!remote?.sessionId) return;
  // Already loaded → nothing to do
  if (remote.sessionId === state.sessionId) return;

  const serverTs  = remote.updatedAt || remote.startedAt || '';
  const serverAge = serverTs ? Date.now() - new Date(serverTs).getTime() : Infinity;
  const TWO_DAYS  = 48 * 60 * 60 * 1000;
  const localIsEmpty = !state.messages.length;

  const showBanner = (msg) => {
    $('resume-banner-msg').textContent = msg;
    $('resume-banner').classList.remove('hidden');
    $('resume-banner-yes').onclick = async () => {
      $('resume-banner').classList.add('hidden');
      try { await loadSession(remote.sessionId); } catch { /* ignore */ }
    };
    $('resume-banner-dismiss').onclick = () => {
      $('resume-banner').classList.add('hidden');
    };
  };

  if (localIsEmpty) {
    if (serverAge <= TWO_DAYS) {
      // Silently resume — local is empty and server session is recent.
      // This is the primary "switch devices" flow.
      try { await loadSession(remote.sessionId); } catch { /* ignore */ }
    } else {
      // Server session is older than 48 h — show banner so the user knows it exists
      const mc  = remote.messageCount || 0;
      const ago = serverTs ? formatDuration(serverAge) : 'unknown time';
      showBanner(`An older session (${mc} messages, ${ago} ago) is on the server. Resume it?`);
    }
    return;
  }

  // Local has messages — only offer if server session is actually newer
  const localTs = state.lastMessage || state.sessionStartedAt || '';
  if (!serverTs || serverTs <= localTs) return;

  const mc = remote.messageCount || 0;
  showBanner(`A more recent session (${mc} message${mc !== 1 ? 's' : ''}) was found on the server. Resume it here?`);
}

// ── Saved connections ──────────────────────────────────────────
/**
 * If the user has an apiKey set but no saved connections (first run after
 * upgrade, or pre-feature setup), seed one connection from the current fields
 * so the "primary connection" abstraction has something to point at.
 */
function migrateLegacyConnection() {
  if (state.connections.length === 0 && (state.apiKey ?? '').trim() && (state.model ?? '').trim()) {
    const conn = {
      id:       generateId(),
      name:     'Primary',
      provider: state.provider,
      apiKey:   state.apiKey,
      model:    state.model,
    };
    state.connections = [conn];
    state.primaryConnectionId = conn.id;
  }
  // If primaryConnectionId points to a missing connection, fall back to the first.
  if (state.primaryConnectionId && !state.connections.find(c => c.id === state.primaryConnectionId)) {
    state.primaryConnectionId = state.connections[0]?.id ?? null;
  }
  // Drop fallback ids that no longer exist or duplicate the primary.
  state.fallbackConnectionIds = (state.fallbackConnectionIds || [])
    .filter(id => state.connections.find(c => c.id === id))
    .filter(id => id !== state.primaryConnectionId);
  // Clear the Phylactery designation if it points at a missing connection.
  if (state.phylacteryConnectionId && !state.connections.find(c => c.id === state.phylacteryConnectionId)) {
    state.phylacteryConnectionId = null;
  }
}

function getPrimaryConnection() {
  return state.connections.find(c => c.id === state.primaryConnectionId) || null;
}

/**
 * Returns the ordered list of usable connections for a request: primary first,
 * then each enabled fallback. Falls back to a synthetic connection built from
 * the live field values if no saved connections exist yet.
 */
function getConnectionSequence() {
  const seq = [];
  const primary = getPrimaryConnection();
  if (primary) {
    seq.push(primary);
  } else if ((state.apiKey ?? '').trim() && (state.model ?? '').trim()) {
    seq.push({
      id: '_live', name: 'Current fields',
      provider: state.provider, apiKey: state.apiKey, model: state.model,
    });
  }
  for (const id of state.fallbackConnectionIds) {
    if (id === state.primaryConnectionId) continue;
    const c = state.connections.find(x => x.id === id);
    if (c && c.provider && (c.apiKey ?? '').trim() && (c.model ?? '').trim()) {
      seq.push(c);
    }
  }
  return seq;
}

/** Most recent apiKey saved against the given provider, or empty string. */
function findKeyForProvider(provider) {
  for (let i = state.connections.length - 1; i >= 0; i--) {
    const c = state.connections[i];
    if (c.provider === provider && (c.apiKey ?? '').trim()) return c.apiKey;
  }
  return '';
}

/** Push the current Connection-section fields into the primary connection. */
function syncFieldsToPrimaryConnection() {
  const conn = getPrimaryConnection();
  if (!conn) return;
  conn.provider = state.provider;
  conn.apiKey   = state.apiKey;
  conn.model    = state.model;
}

function saveNewConnection(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return null;
  if (!(state.apiKey ?? '').trim() || !(state.model ?? '').trim()) return null;
  const conn = {
    id:       generateId(),
    name:     trimmed,
    provider: state.provider,
    apiKey:   state.apiKey,
    model:    state.model,
  };
  state.connections.push(conn);
  if (!state.primaryConnectionId) state.primaryConnectionId = conn.id;
  saveSettings();
  renderConnectionsList();
  return conn;
}

function deleteConnection(id) {
  state.connections = state.connections.filter(c => c.id !== id);
  state.fallbackConnectionIds = state.fallbackConnectionIds.filter(x => x !== id);
  if (state.phylacteryConnectionId === id) state.phylacteryConnectionId = null;
  if (state.primaryConnectionId === id) {
    state.primaryConnectionId = state.connections[0]?.id ?? null;
    const newPrimary = getPrimaryConnection();
    if (newPrimary) {
      state.provider = newPrimary.provider;
      state.apiKey   = newPrimary.apiKey;
      state.model    = newPrimary.model;
      writeSettingsToUI();
    }
  }
  saveSettings();
  renderConnectionsList();
}

function setPrimaryConnection(id) {
  const conn = state.connections.find(c => c.id === id);
  if (!conn) return;
  state.primaryConnectionId = id;
  state.fallbackConnectionIds = state.fallbackConnectionIds.filter(x => x !== id);
  state.provider = conn.provider;
  state.apiKey   = conn.apiKey;
  state.model    = conn.model;
  writeSettingsToUI();
  saveSettings();
  renderConnectionsList();
}

function toggleFallback(id, enabled) {
  if (id === state.primaryConnectionId) return;
  state.fallbackConnectionIds = state.fallbackConnectionIds.filter(x => x !== id);
  if (enabled) state.fallbackConnectionIds.push(id);
  saveSettings();
  renderConnectionsList();
}

/**
 * Designate (or clear) the connection whose API key Phylactery uses.
 * Single-select: setting this on one connection clears it from any
 * other. Setting it to the currently-designated id clears the
 * designation entirely (so the same toggle button works for both
 * directions). server.js compares old vs new on PUT /api/settings and
 * respawns Phylactery when this (or the pointed-at connection's key)
 * changes — so the user sees the new key take effect on the next
 * chat message, no restart required.
 */
function setPhylacteryConnection(id) {
  if (state.phylacteryConnectionId === id) {
    state.phylacteryConnectionId = null;
  } else {
    state.phylacteryConnectionId = id;
  }
  saveSettings();
  renderConnectionsList();
}

function moveFallback(id, delta) {
  const arr = [...state.fallbackConnectionIds];
  const idx = arr.indexOf(id);
  if (idx < 0) return;
  const newIdx = Math.max(0, Math.min(arr.length - 1, idx + delta));
  if (newIdx === idx) return;
  arr.splice(idx, 1);
  arr.splice(newIdx, 0, id);
  state.fallbackConnectionIds = arr;
  saveSettings();
  renderConnectionsList();
}

function renderConnectionsList() {
  const ul = $('connections-list');
  if (!ul) return;
  ul.innerHTML = '';
  for (const conn of state.connections) {
    const isPrimary  = conn.id === state.primaryConnectionId;
    const fbIdx      = state.fallbackConnectionIds.indexOf(conn.id);
    const isFallback = fbIdx >= 0 && !isPrimary;
    const isEntityCore = conn.id === state.phylacteryConnectionId;

    const li = document.createElement('li');
    li.className = 'connection-item' + (isPrimary ? ' is-primary' : '');

    // Role column: Primary radio + Fallback checkbox
    const role = document.createElement('div');
    role.className = 'conn-role';
    const radioId = `conn-primary-${conn.id}`;
    role.innerHTML =
      `<input type="radio" name="primary-conn" id="${radioId}" ${isPrimary ? 'checked' : ''}>` +
      `<label for="${radioId}" title="Use as primary connection">Primary</label>`;
    role.querySelector('input').addEventListener('change', () => setPrimaryConnection(conn.id));

    // Info column
    const info = document.createElement('div');
    info.className = 'conn-info';
    const primaryBadge   = isPrimary    ? '<span class="conn-badge">primary</span>' : '';
    const fallbackBadge  = (!isPrimary && isFallback) ? `<span class="conn-badge fb">fallback #${fbIdx + 1}</span>` : '';
    const entityBadge    = isEntityCore ? '<span class="conn-badge ec">Phylactery</span>' : '';
    info.innerHTML =
      `<div class="conn-name">${esc(conn.name)}${primaryBadge}${fallbackBadge}${entityBadge}</div>` +
      `<div class="conn-meta">${esc(conn.provider)} / ${esc(conn.model || '—')}</div>`;

    // Actions column
    const actions = document.createElement('div');
    actions.className = 'conn-actions';

    // a11y note: each action button gets both `title` (sighted hover
    // tooltip) and `aria-label` (screen-reader announcement) because
    // the visible textContent is a symbol (✓ / + / ▲ / ▼ / ✕) that
    // doesn't announce meaningfully on its own. Toggle buttons use
    // aria-pressed so assistive tech can convey on/off state.
    const fbBtn = document.createElement('button');
    fbBtn.type = 'button';
    fbBtn.textContent = isFallback ? '✓ fallback' : '+ fallback';
    fbBtn.title = isPrimary ? 'Primary connection cannot also be a fallback' : 'Toggle fallback';
    fbBtn.setAttribute('aria-label', `${isFallback ? 'Remove' : 'Add'} "${conn.name}" as fallback`);
    fbBtn.setAttribute('aria-pressed', isFallback ? 'true' : 'false');
    fbBtn.disabled = isPrimary;
    fbBtn.addEventListener('click', () => toggleFallback(conn.id, !isFallback));
    actions.appendChild(fbBtn);

    // Phylactery designation: single-select across all connections. Tells
    // the server which API key to pass to the Phylactery child process
    // via PHYLACTERY_LLM_API_KEY (and ZAI_API_KEY for z.ai providers).
    // Independent of primary/fallback — you can point Phylactery at any
    // connection regardless of how the chat path uses it.
    const ecBtn = document.createElement('button');
    ecBtn.type = 'button';
    ecBtn.textContent = isEntityCore ? '✓ Phylactery' : '+ Phylactery';
    ecBtn.title = isEntityCore
      ? 'Currently the API key source for Phylactery (click to clear)'
      : "Use this connection's API key for Phylactery";
    ecBtn.setAttribute('aria-label', isEntityCore
      ? `Clear Phylactery API-key designation from "${conn.name}"`
      : `Use "${conn.name}" as Phylactery API-key source`);
    ecBtn.setAttribute('aria-pressed', isEntityCore ? 'true' : 'false');
    ecBtn.addEventListener('click', () => setPhylacteryConnection(conn.id));
    actions.appendChild(ecBtn);

    if (isFallback) {
      const upBtn = document.createElement('button');
      upBtn.type = 'button'; upBtn.textContent = '▲';
      upBtn.title = 'Try earlier in fallback order';
      upBtn.setAttribute('aria-label', `Move "${conn.name}" earlier in fallback order`);
      upBtn.disabled = fbIdx === 0;
      upBtn.addEventListener('click', () => moveFallback(conn.id, -1));
      const dnBtn = document.createElement('button');
      dnBtn.type = 'button'; dnBtn.textContent = '▼';
      dnBtn.title = 'Try later in fallback order';
      dnBtn.setAttribute('aria-label', `Move "${conn.name}" later in fallback order`);
      dnBtn.disabled = fbIdx === state.fallbackConnectionIds.length - 1;
      dnBtn.addEventListener('click', () => moveFallback(conn.id, +1));
      actions.appendChild(upBtn);
      actions.appendChild(dnBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.textContent = '✕';
    delBtn.title = 'Delete connection';
    delBtn.setAttribute('aria-label', `Delete connection "${conn.name}"`);
    delBtn.addEventListener('click', () => {
      if (confirm(`Delete connection "${conn.name}"?`)) deleteConnection(conn.id);
    });
    actions.appendChild(delBtn);

    li.appendChild(role);
    li.appendChild(info);
    li.appendChild(actions);
    ul.appendChild(li);
  }
}

// Fire-and-forget — writes the current session to disk via the server.
// localStorage is the primary store; this is for persistence & log browsing.
async function saveToServer() {
  if (!state.sessionId) return;
  try {
    await fetch('/api/log', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId:  state.sessionId,
        startedAt:  state.sessionStartedAt,
        endedAt:    state.sessionEndedAt,
        provider:   state.provider,
        model:      state.model,
        messages:   state.messages,
      }),
    });
  } catch { /* non-critical */ }
}

// ── Macro substitution ──────────────────────────────────────────
/**
 * Format a millisecond duration as a compact human string: "47s", "5m",
 * "2h 14m", "3d 4h", or "just now" when under a minute.
 */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  if (ms < 60_000) return ms < 5_000 ? 'just now' : `${Math.floor(ms / 1000)}s`;
  const min  = Math.floor(ms / 60_000);
  const hour = Math.floor(min / 60);
  const day  = Math.floor(hour / 24);
  if (day  >= 1) return `${day}d ${hour % 24}h`;
  if (hour >= 1) return `${hour}h ${min % 60}m`;
  return `${min}m`;
}

/**
 * Milliseconds between the timestamps of the two most recent USER messages
 * in `state.messages`. Returns null when fewer than two timestamped user
 * messages exist.
 *
 * This is intentionally history-only — no synthesized `Date.now()` — so the
 * macro is detecting "user returned after a long absence" by comparing the
 * timestamps of two messages that are both actually in the saved chat
 * history. Every message is dated and timestamped on send, so once the new
 * user turn lands the gap surfaces on the next prompt build.
 *
 * Stays inside `state.messages`, so it can't accidentally cross a session
 * boundary the way the legacy module-level `elapsedTime` field can after a
 * state restore.
 */
// Set by buildApiMessages while it's running so {{elapsedTime}} can
// see the user message that's about to be sent — that message isn't
// in state.messages yet (it only gets pushed after the response
// lands), and without this the macro would compare the two prior
// user messages and miss "user just returned after being away."
let _pendingUserMsgTimestamp = null;

function elapsedBetweenUserMessages() {
  const stamps = [];
  if (_pendingUserMsgTimestamp) {
    const t = new Date(_pendingUserMsgTimestamp).getTime();
    if (Number.isFinite(t)) stamps.push(t);
  }
  for (let i = state.messages.length - 1; i >= 0 && stamps.length < 2; i--) {
    const m = state.messages[i];
    if (m?.role === 'user' && m.timestamp) {
      const t = new Date(m.timestamp).getTime();
      if (Number.isFinite(t)) stamps.push(t);
    }
  }
  if (stamps.length < 2) return null;
  return stamps[0] - stamps[1];
}

/**
 * Milliseconds since the most recent prior session ended, based on
 * `state.previousSessionEndedAt` (maintained on session-boundary events
 * and refreshed from /api/logs when the cache is missing).
 */
function timeSinceLastSessionEnded() {
  if (!state.previousSessionEndedAt) return null;
  const t = new Date(state.previousSessionEndedAt).getTime();
  if (!Number.isFinite(t)) return null;
  return Date.now() - t;
}

/**
 * Refresh `state.previousSessionEndedAt` from the server's session list,
 * picking the most recent `endedAt` among logs that aren't the current
 * session. Used on cold start and when loading a different historical
 * session — both cases where localStorage may not reflect what the
 * server knows.
 */
async function refreshPreviousSessionEndedAt() {
  try {
    const res = await fetch('/api/logs');
    if (!res.ok) return;
    const list = await res.json();
    let latest = null;
    for (const s of list) {
      if (!s?.endedAt) continue;
      if (s.sessionId === state.sessionId) continue;
      const t = new Date(s.endedAt).getTime();
      if (!Number.isFinite(t)) continue;
      if (latest === null || t > new Date(latest).getTime()) latest = s.endedAt;
    }
    if (latest && latest !== state.previousSessionEndedAt) {
      state.previousSessionEndedAt = latest;
      saveSettings();
    }
  } catch { /* best-effort cache refresh */ }
}

/**
 * Replace prompt macros with their current values:
 *   {{user}}                — configured user display name
 *   {{char}}                — configured AI display name
 *   {{elapsedTime}}         — duration between the last two user messages
 *   {{timeSinceLastSession}} — duration since the previous session ended
 */
function applyNameVars(text) {
  return text
    .replace(/\{\{user\}\}/gi, state.userName || 'my human')
    .replace(/\{\{char\}\}/gi, state.charName || 'Assistant')
    .replace(/\{\{elapsedTime\}\}/gi, () => {
      const ms = elapsedBetweenUserMessages();
      return ms !== null ? formatDuration(ms) : 'no prior user message';
    })
    .replace(/\{\{timeSinceLastSession\}\}/gi, () => {
      const ms = timeSinceLastSessionEnded();
      return ms !== null ? formatDuration(ms) : 'no prior session';
    });
}

// ── Message building ─────────────────────────────────────────────
/**
 * Sanitises a state message for the upstream API:
 * strips client-only fields (timestamp, _toolName) and ensures
 * the shape is correct for each role.
 */
// Pretty-print a message timestamp as a tag for prepending to LLM-
// visible content. Uses 24h local time and uncommon bracket chars
// (⫸ U+2AF8 / ⫷ U+2AF7) so the LLM is unlikely to spontaneously
// generate them — the previous "[HH:MM]" format was common enough in
// natural text that the model started mimicking it back into its
// own responses, which then accumulated turn-over-turn when
// toApiMessage re-stamped the content.
//
// The tag is ONLY ever attached to the temporary message objects
// built for the upstream API call; state.messages keeps clean
// content. Any tag the model echoes back into its response (rare,
// given the chars) is stripped both at UI render and BEFORE the
// next turn's re-stamp, so accumulation can't compound.
const TS_OPEN  = '⫸';
const TS_CLOSE = '⫷';

function fmtMsgTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '';
  return `${TS_OPEN}${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}${TS_CLOSE}`;
}

// Global strip for the new bracket format. Matches anywhere in the
// content, not just leading — the rolling-accumulation bug Eury
// found put multiple snippets at the head, but the LLM could in
// principle echo them mid-prose too.
const TIMESTAMP_RE_NEW = new RegExp(`${TS_OPEN}\\d{1,2}:\\d{2}${TS_CLOSE}\\s*`, 'g');

// Legacy [HH:MM] support — old chat history (from before this commit)
// has square-bracket stamps the model echoed into its responses,
// often piled at the leading edge. We strip them iteratively from
// the START of content only, never globally, so a user message that
// legitimately writes "see you at [3:30]" mid-sentence isn't mangled.
const TIMESTAMP_RE_LEGACY = /^\s*\[\d{1,2}:\d{2}\]\s*/;

function stripDisplayTimestamps(content) {
  if (typeof content !== 'string') return content;
  let out = content.replace(TIMESTAMP_RE_NEW, '');
  while (TIMESTAMP_RE_LEGACY.test(out)) out = out.replace(TIMESTAMP_RE_LEGACY, '');
  return out;
}

function stampContent(content, ts) {
  if (typeof content !== 'string' || !content) return content;
  // STRIP first, THEN re-stamp. The authoritative source of the
  // timestamp the LLM should see is the message's `timestamp` field
  // (set when the turn landed); any tag already in the content
  // string is an echoed artifact from a previous turn, redundant at
  // best and accumulation-causing at worst. Cleaning before
  // re-stamping guarantees exactly one canonical tag per message,
  // derived from the canonical source, no compounding across turns.
  const cleaned = stripDisplayTimestamps(content);
  const tag = fmtMsgTime(ts);
  return tag ? `${tag} ${cleaned}` : cleaned;
}

function toApiMessage({ role, content, tool_calls, tool_call_id, timestamp }) {
  if (role === 'tool')      return { role, tool_call_id, content };
  // Each historical user/assistant message carries its own timestamp
  // in state.messages — prepended to the API-bound content here (NOT
  // to the stored state) so the Familiar perceives WHEN each turn
  // happened across the whole conversation, not just the current one.
  const stamped = stampContent(content, timestamp);
  if (tool_calls)           return { role, content: stamped ?? null, tool_calls };
  return { role, content: stamped };
}

/**
 * Builds the messages array sent to the API.
 * Does NOT mutate state.messages — that happens only after a
 * successful response, preserving the clean history.
 *
 * Structure:
 *   [system: systemPrompt + characterProfile + userProfile]
 *   [...state.messages]          ← clean conversation history
 *   [user: userInput]            ← new turn
 *   [user: postHistoryPrompt]    ← optional, injected last
 */
function buildApiMessages(userInput, pendingUserMsgTimestamp = null) {
  _pendingUserMsgTimestamp = pendingUserMsgTimestamp;
  try {
  return _buildApiMessagesInner(userInput);
  } finally {
  _pendingUserMsgTimestamp = null;
  }
}

function _buildApiMessagesInner(userInput) {
  const msgs = [];
  // Provenance for the prompt inspector. Each entry is { source, text }
  // where source is one of: lore-sys-top, system-prompt, lore-before-char,
  // character-profile, lore-after-char, user-profile, lore-sys-bottom.
  const systemSegments = [];
  // History splices for at-depth lore: { index, content } where index is
  // the position in the final `msgs` array (after any system message).
  const atDepthInjections = [];

  // ── Activate lorebook entries ────────────────────────────────
  const lore = activateTomeEntries(userInput);
  const joinLore = (entries) =>
    entries.map(e => applyNameVars(e.content.trim())).filter(Boolean).join('\n\n---\n\n');
  const pushSeg = (source, text) => {
    const t = text?.trim();
    if (t) systemSegments.push({ source, text: t });
  };

  // ── System message ────────────────────────────────────────────
  if (lore.sys_top.length)         pushSeg('lore-sys-top',     joinLore(lore.sys_top));
  if (state.systemPrompt.trim())   pushSeg('system-prompt',    applyNameVars(state.systemPrompt.trim()));
  if (lore.before_char.length)     pushSeg('lore-before-char', joinLore(lore.before_char));
  if (state.characterProfile.trim()) pushSeg('character-profile', '[Character Profile]\n' + applyNameVars(state.characterProfile.trim()));
  if (lore.after_char.length)      pushSeg('lore-after-char',  joinLore(lore.after_char));
  if (state.userProfile.trim())    pushSeg('user-profile',     '[Human Profile]\n' + applyNameVars(state.userProfile.trim()));
  if (lore.sys_bottom.length)      pushSeg('lore-sys-bottom',  joinLore(lore.sys_bottom));

  if (systemSegments.length)
    msgs.push({ role: 'system', content: systemSegments.map(s => s.text).join('\n\n---\n\n') });

  // ── History + position-4 (@depth) injections ─────────────────
  // Clone history as clean API messages so we can splice into it
  const histMsgs = state.messages.map(toApiMessage);

  // Sort at_depth entries deepest-first so splice positions stay consistent
  const atDepthSorted = [...lore.at_depth].sort((a, b) => (b.depth ?? 4) - (a.depth ?? 4));
  const roleNames = ['system', 'user', 'assistant'];
  const atDepthInsertedAt = []; // track splice positions within histMsgs
  for (const entry of atDepthSorted) {
    const d    = Math.max(0, entry.depth ?? 4);
    const role = roleNames[entry.role ?? 0] ?? 'system';
    const idx  = Math.max(0, histMsgs.length - d);
    histMsgs.splice(idx, 0, { role, content: applyNameVars(entry.content.trim()) });
    atDepthInsertedAt.push(idx);
  }

  const histStartIdx = msgs.length;
  msgs.push(...histMsgs);
  for (const localIdx of atDepthInsertedAt) {
    atDepthInjections.push({ indexInFinal: histStartIdx + localIdx });
  }

  // ── New user turn ─────────────────────────────────────────────
  // Stamp the live turn with the pending timestamp the chat handler
  // captured at send time (also used by the elapsedTime macro), so
  // it's marked the same way as history. The stamp lives only on
  // this temporary API message — state.messages keeps clean content.
  msgs.push({ role: 'user', content: stampContent(userInput, _pendingUserMsgTimestamp) });

  // ── Post-history prompt ───────────────────────────────────────
  // Role is user-configurable (default 'system'). The chat path always
  // sends an explicit `userMessage` field, so the server-side "last
  // role:'user'" fallback never picks this up regardless of role chosen.
  if (state.postHistoryPrompt.trim()) {
    const phr = ['system', 'user', 'assistant'].includes(state.postHistoryRole)
      ? state.postHistoryRole : 'system';
    msgs.push({ role: phr, content: applyNameVars(state.postHistoryPrompt.trim()) });
  }

  lastBuildSegments = { systemSegments, atDepthInjections };
  return msgs;
}

// ── Markdown rendering ───────────────────────────────────────────
function esc(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Lightweight markdown → HTML.
 * Handles: fenced code blocks, inline code, bold, italic,
 *          ATX headings (# ## ###), unordered lists, ordered
 *          lists, paragraphs, line breaks.
 * Code blocks are isolated first so their contents aren't
 * processed by other rules.
 */
function renderMarkdown(text) {
  // Split on fenced code blocks
  const parts = text.split(/(```[\w]*\n?[\s\S]*?```)/g);

  return parts.map((part, idx) => {
    // Even indices → plain text; odd indices → code blocks
    if (idx % 2 === 1) {
      const m = part.match(/```(\w*)\n?([\s\S]*?)```/);
      if (m) {
        const lang = esc(m[1] || '');
        const code = esc(m[2].replace(/\n$/, ''));
        return `<pre><code${lang ? ` class="lang-${lang}"` : ''}>${code}</code></pre>`;
      }
      return `<pre><code>${esc(part)}</code></pre>`;
    }

    return renderInlineText(part);
  }).join('');
}

/** Escape HTML then apply inline markdown to a plain text segment. */
function renderInlineText(text) {
  // Separate inline code first to avoid escaping inside it
  const codeParts = text.split(/(`[^`\n]+`)/g);
  const processed = codeParts.map((p, i) => {
    if (i % 2 === 1) {
      // inline code
      return `<code>${esc(p.slice(1, -1))}</code>`;
    }

    let s = esc(p);

    // Bold + italic
    s = s
      .replace(/\*\*\*([^*\n]+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^*\n]+?)\*\*/g,     '<strong>$1</strong>')
      .replace(/\*([^*\n]+?)\*/g,          '<em>$1</em>');

    // ATX headings (only at line start)
    s = s
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm,  '<h2>$1</h2>')
      .replace(/^# (.+)$/gm,   '<h1>$1</h1>');

    // Unordered lists (lines starting with - or *)
    s = s.replace(/^[*\-] (.+)$/gm, '<li>$1</li>');
    s = s.replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`);

    // Ordered lists — use a temporary tag to avoid re-wrapping unordered <li> items
    s = s.replace(/^\d+\. (.+)$/gm, '<oli>$1</oli>');
    s = s.replace(/(<oli>.*<\/oli>\n?)+/g, m => `<ol>${m.replace(/<oli>/g, '<li>').replace(/<\/oli>/g, '</li>')}</ol>`);

    // Paragraphs: double newline → </p><p>
    s = s.replace(/\n\n+/g, '</p><p>');
    // Single newline → <br>
    s = s.replace(/\n/g, '<br>');

    // Wrap in <p> if there's content and no block-level tags
    if (s && !/^<(?:h[123]|ul|ol|pre)/.test(s)) {
      s = `<p>${s}</p>`;
    }
    return s;
  });
  return processed.join('');
}

// ── DOM helpers ──────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function formatTimestamp(iso) {
  if (!iso) return '';
  const d   = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
}
function scrollToBottom() {
  const scroller = $('messages-scroller');
  scroller.scrollTop = scroller.scrollHeight;
}

function setTyping(visible) {
  $('typing-indicator').classList.toggle('hidden', !visible);
  if (visible) scrollToBottom();
}

/** Inline italic note shown next to the typing indicator during retries / fallbacks. */
function setRetryStatus(text) {
  const el = $('retry-status');
  if (!el) return;
  el.textContent = text || '';
  if (text) setTyping(true);
}
function clearRetryStatus() {
  const el = $('retry-status');
  if (el) el.textContent = '';
}

function setStatus(type) {
  // type: '' | 'ok' | 'busy' | 'err'
  const badge = $('status-badge');
  badge.className = 'status-badge' + (type ? ' ' + type : '');
}

/**
 * Create and return a message DOM element.
 * Returns { el, bubble } so callers can update the bubble during streaming.
 */
function createMessageEl(role, htmlContent, timestamp) {
  const el = document.createElement('div');
  el.className = `message ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = role === 'user' ? 'U' : role === 'assistant' ? 'A' : '!';

  const body = document.createElement('div');
  body.className = 'msg-body';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerHTML = htmlContent;

  const actions = document.createElement('div');
  actions.className = 'msg-actions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'msg-action-btn';
  copyBtn.textContent = 'Copy';
  // Will be wired up by callers who know the raw text
  actions.appendChild(copyBtn);

  // Topic action buttons — only for user/assistant messages
  if (role === 'user' || role === 'assistant') {
    const topicStartBtn = document.createElement('button');
    topicStartBtn.className = 'msg-action-btn msg-topic-start-btn';
    topicStartBtn.title = 'Start a topic from this message';
    topicStartBtn.textContent = '▷ Topic start';
    topicStartBtn.addEventListener('click', () => {
      const idx = parseInt(el.dataset.msgIndex, 10);
      if (!isNaN(idx)) startTopicAt(idx);
    });
    actions.appendChild(topicStartBtn);

    const topicEndBtn = document.createElement('button');
    topicEndBtn.className = 'msg-action-btn msg-topic-end-btn';
    topicEndBtn.title = 'End an active topic at this message';
    topicEndBtn.textContent = '□ Topic end';
    topicEndBtn.addEventListener('click', () => {
      const idx = parseInt(el.dataset.msgIndex, 10);
      if (!isNaN(idx)) endTopicAt(idx);
    });
    actions.appendChild(topicEndBtn);
  }

  // Timestamp
  const timeEl = document.createElement('time');
  timeEl.className = 'msg-time';
  if (timestamp) {
    timeEl.setAttribute('datetime', timestamp);
    timeEl.textContent = formatTimestamp(timestamp);
    timeEl.title = new Date(timestamp).toLocaleString();
  }

  body.appendChild(bubble);
  body.appendChild(actions);
  body.appendChild(timeEl);
  el.appendChild(avatar);
  el.appendChild(body);

  return { el, bubble, copyBtn, timeEl };
}

function wireCopyButton(btn, getText) {
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(getText()).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
    }).catch(() => {
      btn.textContent = 'Failed';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
    });
  });
}

function appendUserMessage(text, timestamp) {
  const { el, copyBtn } = createMessageEl('user', esc(text).replace(/\n/g, '<br>'), timestamp);
  wireCopyButton(copyBtn, () => text);
  // Index will be assigned by refreshTopicGutter after state.messages is updated
  el.dataset.msgIndex = String(state.messages.length); // optimistic: will be corrected
  $('messages').appendChild(el);
  scrollToBottom();
}

function appendAssistantShell(timestamp) {
  const { el, bubble, copyBtn, timeEl } = createMessageEl('assistant', '', timestamp);
  $('messages').appendChild(el);
  scrollToBottom();
  return { el, bubble, copyBtn, timeEl };
}

function appendErrorMessage(text) {
  const { el } = createMessageEl('error', `⚠ ${esc(text)}`);
  $('messages').appendChild(el);
  scrollToBottom();
}

/**
 * Render a tool-use block in the chat — shows each tool call and its result
 * in a collapsed <details> element.
 * @param {Array} toolCalls  - assembled tool_calls array from the assistant message
 * @param {Array} toolResults - matching result objects { _toolName, content }
 */
function appendToolUseEl(toolCalls, toolResults) {
  const wrap = document.createElement('div');
  wrap.className = 'message tool-use';

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = '⚙';

  const body = document.createElement('div');
  body.className = 'msg-body';

  for (let i = 0; i < toolCalls.length; i++) {
    const tc     = toolCalls[i];
    const result = toolResults[i]?.content ?? '';

    let argsStr = '';
    try { argsStr = JSON.stringify(JSON.parse(tc.function.arguments), null, 2); }
    catch { argsStr = tc.function.arguments || '{}'; }

    const details = document.createElement('details');
    details.className = 'tool-call-details';

    const summary = document.createElement('summary');
    summary.className = 'tool-call-summary';
    summary.innerHTML = `<span class="tool-call-name">${esc(tc.function.name)}</span>` +
      `<span class="tool-call-result-preview">${esc(result.slice(0, 60))}${result.length > 60 ? '…' : ''}</span>`;

    const inner = document.createElement('div');
    inner.className = 'tool-call-inner';
    if (argsStr && argsStr !== '{}') {
      inner.innerHTML += `<div class="tool-call-section"><span class="tool-call-label">Arguments</span><pre class="tool-call-pre">${esc(argsStr)}</pre></div>`;
    }
    inner.innerHTML += `<div class="tool-call-section"><span class="tool-call-label">Result</span><pre class="tool-call-pre">${esc(result)}</pre></div>`;

    details.appendChild(summary);
    details.appendChild(inner);
    body.appendChild(details);
  }

  wrap.appendChild(avatar);
  wrap.appendChild(body);
  $('messages').appendChild(wrap);
  scrollToBottom();
  return wrap;
}

/** Re-render all messages from state (used at init and after clear). */
function renderAllMessages() {
  const container = $('messages');
  container.innerHTML = '';
  let i = 0;
  while (i < state.messages.length) {
    const msg = state.messages[i];

    // Assistant message that contains tool_calls: render as tool-use block
    // and consume the following 'tool' result messages. If the assistant
    // ALSO produced narrative content alongside the tool call ("Let me look
    // that up for you…"), render that as its own bubble FIRST — otherwise
    // it disappears on every re-render even though it was visible during
    // the original streaming response.
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const content = typeof msg.content === 'string' ? msg.content.trim() : '';
      if (content) {
        const html = renderMarkdown(stripDisplayTimestamps(content));
        const { el, copyBtn } = createMessageEl('assistant', html, msg.timestamp);
        el.dataset.msgIndex = String(i);
        const captured = msg.content;
        wireCopyButton(copyBtn, () => captured);
        container.appendChild(el);
      }
      const toolCalls = msg.tool_calls;
      const toolResults = [];
      i++;
      while (i < state.messages.length && state.messages[i].role === 'tool') {
        toolResults.push(state.messages[i]);
        i++;
      }
      appendToolUseEl(toolCalls, toolResults);
      continue;
    }

    // Orphaned tool result (shouldn't normally appear) — skip
    if (msg.role === 'tool') { i++; continue; }

    // Strip the leading [HH:MM] tag from the displayed content. The tag
    // is metadata for the LLM (added by toApiMessage so the Familiar
    // perceives per-message timing) and the LLM occasionally echoes it
    // back into responses; the chat UI already shows times via its own
    // timestamp element, so the tag in the message body is just noise
    // to the human reader. Memorization and RAG still see the raw
    // content via state.messages, so they keep the temporal signal.
    const displayContent = stripDisplayTimestamps(msg.content ?? '');
    const html = msg.role === 'user'
      ? esc(displayContent).replace(/\n/g, '<br>')
      : renderMarkdown(displayContent);
    const { el, copyBtn } = createMessageEl(msg.role, html, msg.timestamp);
    el.dataset.msgIndex = String(i);
    const capturedContent = msg.content;
    wireCopyButton(copyBtn, () => capturedContent);
    container.appendChild(el);
    i++;
  }
  refreshTopicGutter();
  scrollToBottom();
}

// ── API communication ────────────────────────────────────────────
let abortController = null;

/** The last messages array sent to /api/chat (client-side, pre-enrichment). */
let lastSentMessages = null;
/** Per-segment provenance for the system message of the last build. See buildApiMessages. */
let lastBuildSegments = null;
/** The Phylactery enrichment block that the server actually prepended to the last request's system message. */
// Last successful response's thalamus envelope, captured per-request:
//   { static, dynamic, depth, injectedAt }
// `static` lives at the top of the system message (cacheable prefix);
// `dynamic` is the depth-injected block at position `injectedAt`.
// Both are optional — server emits an empty string for whichever side
// thalamus didn't produce. null between requests + when no successful
// response has come back yet.
let lastThalamus = null;

// Extract a human-readable error string from an OpenAI-compatible
// error response, which can shape `error` as either a bare string OR
// a structured object like { message, type, code }. Stringifying the
// object via `new Error(obj)` or template literals yields the famous
// "[object Object]" — useless in diagnostics. Falls back to the
// fallback string when no usable text is found.
function extractErrorText(payload, fallback) {
  const e = payload?.error;
  if (e == null) return fallback;
  if (typeof e === 'string') return e;
  if (typeof e === 'object') {
    if (typeof e.message === 'string' && e.message) return e.message;
    if (typeof e.code === 'string' && e.code) return e.code;
    try { return JSON.stringify(e); } catch { /* fall through */ }
  }
  return String(e) || fallback;
}

async function sendMessage(userInput) {
  userInput = userInput.trim();
  if (!userInput) return;

  if (!state.apiKey.trim()) {
    appendErrorMessage('Enter your API key in the Settings panel first.');
    return;
  }
  if (!state.model.trim()) {
    appendErrorMessage('Enter a model name in the Settings panel.');
    return;
  }

  // Cancel any in-flight request
  if (abortController) {
    abortController.abort();
    abortController = null;
  }

  // Update session timing: measure gap since last message, refresh lastMessage,
  // and reset the 3-hour inactivity countdown.
  const now = new Date().toISOString();
  elapsedTime       = lastMessage ? (Date.now() - new Date(lastMessage).getTime()) : 0;
  // M8: capture the previous timestamp BEFORE overwriting so the server
  // can compute idle duration server-side. Sent as lastUserMessageAt in
  // round-0 bodies.
  const prevUserMessageAt = lastMessage;
  lastMessage       = now;
  state.lastMessage = now;
  saveSettings();
  resetSessionTimeout();

  const userTimestamp = now;
  const apiMessages   = buildApiMessages(userInput, userTimestamp);
  lastSentMessages    = apiMessages;
  lastThalamus = null; // wait for the live answer to populate this

  // Optimistic UI
  appendUserMessage(userInput, userTimestamp);
  setInputLocked(true);
  setTyping(true);
  setStatus('busy');

  const sendStart = performance.now();
  debugRecord('send', `provider=${state.provider} model=${state.model} streaming=${state.streaming} msgs=${apiMessages.length} input=${userInput.length}ch`);
  try {
    if (state.streaming) {
      await doStreamingRequest(apiMessages, userInput, userTimestamp, prevUserMessageAt);
    } else {
      await doNonStreamingRequest(apiMessages, userInput, userTimestamp, prevUserMessageAt);
    }
    setStatus('ok');
    state.turnCount = (state.turnCount ?? 0) + 1;
    debugRecord('recv', `ok in ${Math.round(performance.now() - sendStart)}ms thalamus=${lastThalamus ? `static=${(lastThalamus.static ?? '').length}ch dynamic=${(lastThalamus.dynamic ?? '').length}ch@d${lastThalamus.depth}` : 'none'}`);
    // M5: feed this turn's engagement into Unruh's interest layer.
    // Fire-and-forget — never blocks the UI or surfaces errors.
    recordTopicEngagement();
  } catch (err) {
    setTyping(false);
    if (err.name !== 'AbortError') {
      // Belt-and-braces: err.message *should* be a string thanks to
      // extractErrorText, but if some other throw site still hands
      // us a non-string we coerce sensibly rather than printing
      // "[object Object]" in the diagnostic.
      const errText = typeof err.message === 'string' && err.message
        ? err.message
        : (() => { try { return JSON.stringify(err); } catch { return String(err); } })();
      appendErrorMessage(errText || 'Request failed.');
      setStatus('err');
      debugRecord('recv', `FAILED after ${Math.round(performance.now() - sendStart)}ms: ${errText}`);
    } else {
      debugRecord('recv', `aborted after ${Math.round(performance.now() - sendStart)}ms`);
    }
  } finally {
    setInputLocked(false);
    $('user-input').focus();
    abortController = null;
  }
}

/**
 * M5 weight instrumentation. After a turn completes, attribute the
 * engagement to whatever topics are currently open (state.topics with
 * endIndex === null) and post it to the server, which translates the
 * signals into an interest-weight delta and bumps Unruh.
 *
 * Topic attribution uses the user's manual topic markers — approach
 * (a) from the plan. No topic markers open → nothing to attribute, so
 * we no-op (weights only accrue for marked topics until the LLM-based
 * detector of approach (b) lands).
 *
 * Signals sent per topic:
 *   - responseChars: length of this turn's assistant reply (token-
 *     volume proxy; shared across all open topics for the turn).
 *   - spanMessages: how many messages the topic has been open for
 *     (persistence proxy).
 *
 * Fully fire-and-forget: any failure is swallowed so interest
 * bookkeeping can never disrupt the conversation.
 */
function recordTopicEngagement() {
  try {
    const openTopics = state.topics.filter(t => t.endIndex === null);
    if (openTopics.length === 0) return;

    // Length of this turn's final assistant reply. Stop at the FIRST
    // assistant message scanning back from the end — that's this
    // turn's answer. (Don't skip an empty one and walk into a prior
    // turn's reply, which would over-attribute the token-volume
    // signal. An empty final reply legitimately means zero token
    // volume; persistence still counts.)
    let responseChars = 0;
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (m.role === 'assistant') {
        responseChars = typeof m.content === 'string' ? m.content.length : 0;
        break;
      }
    }

    const topics = openTopics.map(t => ({
      label:        t.label,
      spanMessages: Math.max(1, state.messages.length - t.startIndex),
    }));

    fetch('/api/interest/engage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topics, responseChars }),
    }).catch(() => { /* best-effort — interest accrual is non-critical */ });
  } catch { /* never let bookkeeping break the turn */ }
}

/**
 * Parse the handoff JSON the summariser LLM returns. Models wrap JSON
 * in prose or ```json fences despite instructions, so be liberal:
 * strip fences, grab the first {...}, validate the shape. Returns
 * { active_intent, open_threads } or null if nothing usable.
 */
function parseHandoffJSON(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const brace = s.match(/\{[\s\S]*\}/);
  if (brace) s = brace[0];
  try {
    const o = JSON.parse(s);
    const intent = typeof o.active_intent === 'string' ? o.active_intent.trim() : '';
    const threads = Array.isArray(o.open_threads)
      ? o.open_threads.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim())
      : [];
    if (!intent && threads.length === 0) return null;
    return { active_intent: intent, open_threads: threads };
  } catch { return null; }
}

/**
 * M6 session handoff. On session end, summarise the just-ended
 * conversation into { active_intent, open_threads } via the cheapest
 * available connection and store it in Unruh, so the next session's
 * first [Temporal Context] resumes mid-thought.
 *
 * Fully best-effort and fire-and-forget: it captures the messages by
 * value (caller passes a copy taken before startNewSession clears
 * state), never blocks the session-end flow, and swallows every error.
 * Gated on state.handoffEnabled so cost-conscious users can opt out.
 */
async function generateAndStoreHandoff(messages, sessionId) {
  try {
    if (!state.handoffEnabled) return;
    if (!Array.isArray(messages) || messages.length < 2) return; // nothing worth summarising

    const seq = getConnectionSequence();
    if (seq.length === 0) return;
    const conn = seq[0];

    // Compact transcript of the last few user/assistant turns. Tool
    // and system messages are dropped — they're noise for an intent
    // summary.
    const recent = messages
      .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-12)
      .map(m => `${m.role}: ${m.content.trim()}`)
      .join('\n');
    if (!recent.trim()) return;

    // The server prepends the Familiar's identity/persona (static
    // enrichment), so the prompt below is in their voice — a private
    // memory-to-self the next session will read as "what I was doing last."
    const sysPrompt =
      'The text above is who I am. I\'m writing a short private handoff note to my ' +
      'future self for the next time I talk with my human, capturing what I was doing ' +
      'and what\'s still open. I respond with ONLY minified JSON, no prose, no code fence: ' +
      '{"active_intent": string, "open_threads": string[]}. ' +
      'active_intent: one short sentence, in my own first-person voice, on the through-line ' +
      'of the session (I address my human as "you" or "{{user}}" in second person). ' +
      'open_threads: specific unfinished questions or tasks, each a short phrase (empty array if none).';

    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: conn.provider, apiKey: conn.apiKey, model: conn.model,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: recent },
        ],
        stream: false,
        temperature: 0.3,
        max_tokens: 400,
        // 'static' enrichment: include the Familiar's persona/identity
        // so the handoff note is in character, but skip memory + graph
        // + temporal — those would bloat the summary and the temporal
        // fetch would consume the very handoff we're about to write.
        enrich: 'static',
      }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    const parsed = parseHandoffJSON(content);
    if (!parsed) return;

    await fetch('/api/session/handoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent:  parsed.active_intent,
        threads: parsed.open_threads,
        sessionId,
      }),
    });
  } catch { /* best-effort — a missed handoff just means the next session starts cold */ }
}

/**
 * One streaming attempt against a single connection. The server runs the
 * tool-call loop; we render its `_toolRound` events as collapsible blocks
 * and stream content deltas into assistant shells. DOM side effects
 * accumulate during the attempt and are returned so the caller can roll
 * them back on a failed attempt before retrying. Throws on HTTP /
 * network / abort / loop errors.
 */
async function attemptStreamingOnce(conn, apiMessages, domArtifacts, userInput, prevUserMessageAt) {
  const pendingMsgs = [];   // tool_call + tool_result messages to commit
  const toolUseEls  = domArtifacts; // shared array - caller can roll back on error
  let   shell       = null;
  let   fullContent = '';

  abortController = new AbortController();
  const response = await fetch('/api/chat', {
    method: 'POST',
    signal: abortController.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider:    conn.provider,
      apiKey:      conn.apiKey,
      model:       conn.model,
      messages:    apiMessages,
      stream:      true,
      temperature: state.temperature,
      max_tokens:  state.maxTokens,
      // `userMessage` carries {{user}}'s actual input so the server
      // never mistakes the post-history prompt for it, regardless of
      // the role that prompt is sent as. One request per user message —
      // the server runs all tool rounds inside it, so threat scoring /
      // last-activity fire exactly once.
      ...(typeof userInput === 'string' && userInput.trim()
          ? { userMessage: userInput }
          : {}),
      // M8: previous user-message timestamp so the server can compute
      // idle duration for bookmark surfacing.
      ...(prevUserMessageAt ? { lastUserMessageAt: prevUserMessageAt } : {}),
      // V3: session audience for knowledge gating. Only sent when there
      // are actual participants or a location set.
      ...((state.sessionAudience?.participants?.length || state.sessionAudience?.location)
          ? { sessionAudience: state.sessionAudience }
          : {}),
      ...toolLoopPayload(),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    let msg = `API error ${response.status}`;
    try { msg = extractErrorText(JSON.parse(body), msg); } catch { /* non-JSON */ }
    throw new Error(msg);
  }

  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') continue;

      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { continue; /* malformed chunk */ }

      if (parsed._thalamus) {
        lastThalamus = parsed._thalamus;
        continue;
      }
      // A mid-loop upstream failure on the server side - surface it as a
      // normal request error so the retry/fallback ladder handles it.
      if (parsed._loopError) throw new Error(parsed._loopError);

      if (parsed._toolRound) {
        // One server-side tool round: render the collapsible block and
        // record the same message shapes the old client-side loop
        // produced, so history rendering and exports are unchanged.
        const { toolCalls, results, content, timestamp } = parsed._toolRound;
        const roundTs = timestamp || new Date().toISOString();
        const calls = Array.isArray(toolCalls) ? toolCalls : [];
        const toolResults = (Array.isArray(results) ? results : []).map(r => ({
          role:         'tool',
          tool_call_id: r.tool_call_id,
          content:      r.content,
          timestamp:    roundTs,
          _toolName:    r.name,
          id:           generateId(),
        }));
        pendingMsgs.push({ role: 'assistant', content: content || null, tool_calls: calls, timestamp: roundTs, id: generateId() });
        pendingMsgs.push(...toolResults);
        debugRecord('tool', `server round: ${calls.map(tc => tc?.function?.name).join(', ')}`);

        setTyping(false);
        const tEl = appendToolUseEl(calls, toolResults);
        if (tEl) toolUseEls.push(tEl);
        setTyping(true);

        // Content streamed during a tool round stays visible in its own
        // shell (tracked for rollback); the next round gets a fresh one.
        if (shell?.el) toolUseEls.push(shell.el);
        shell       = null;
        fullContent = '';
        continue;
      }

      const delta = parsed.choices?.[0]?.delta;
      if (typeof delta?.content === 'string' && delta.content.length > 0) {
        if (!shell) {
          setTyping(false);
          shell = appendAssistantShell(new Date().toISOString());
        }
        fullContent += delta.content;
        shell.bubble.innerHTML = renderMarkdown(stripDisplayTimestamps(fullContent));
        scrollToBottom();
      }
    }
  }

  return { content: fullContent, pendingMsgs, finalShell: shell };
}

async function doStreamingRequest(apiMessages, userInput, userTimestamp, prevUserMessageAt) {
  const sequence    = getConnectionSequence();
  if (sequence.length === 0) {
    throw new Error('No usable connection. Set provider, API key, and model in the Settings panel first.');
  }
  const maxRetries = Math.max(0, parseInt(state.maxEmptyRetries, 10) || 0);

  let lastError = null;

  for (let connIdx = 0; connIdx < sequence.length; connIdx++) {
    const conn = sequence[connIdx];
    if (connIdx > 0) {
      setRetryStatus(`Falling back to "${conn.name}" (${conn.provider} / ${conn.model})…`);
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        setRetryStatus(`Empty response from "${conn.name}". Retrying ${attempt}/${maxRetries}…`);
      }

      const domArtifacts = [];
      let result;
      try {
        result = await attemptStreamingOnce(conn, apiMessages, domArtifacts, userInput, prevUserMessageAt);
      } catch (err) {
        if (err.name === 'AbortError') { clearRetryStatus(); throw err; }
        // Roll back any tool-use blocks added during this failed attempt.
        for (const el of domArtifacts) el.remove?.();
        lastError = err;
        if (attempt < maxRetries) {
          setRetryStatus(`Request to "${conn.name}" failed (${err.message}). Retrying ${attempt + 1}/${maxRetries}…`);
          continue;
        }
        if (connIdx < sequence.length - 1) {
          appendErrorMessage(`Connection "${conn.name}" failed: ${err.message}. Trying next fallback…`);
          break;
        }
        clearRetryStatus();
        throw err;
      }

      const { content: _rawContent, pendingMsgs, finalShell } = result;
      // Strip any LLM-echoed timestamps at the commit boundary — once here
      // keeps state.messages, the copy button, and memorization all clean.
      const content = stripDisplayTimestamps(_rawContent);
      const trimmed = (content ?? '').trim();
      const usedTools = pendingMsgs.length > 0;

      // Empty response with no tool side-effects → eligible for retry/fallback.
      if (!trimmed && !usedTools) {
        if (finalShell?.el) finalShell.el.remove();
        for (const el of domArtifacts) el.remove?.();
        if (attempt < maxRetries) continue;
        if (connIdx < sequence.length - 1) {
          appendErrorMessage(`Connection "${conn.name}" returned empty responses after ${maxRetries + 1} attempts. Trying next fallback…`);
          break;
        }
        clearRetryStatus();
        throw new Error(`All connections returned empty responses (last: "${conn.name}").`);
      }

      // ── Success — commit. ────────────────────────────────────
      let shell = finalShell;
      if (!shell) {
        setTyping(false);
        shell = appendAssistantShell(new Date().toISOString());
        shell.bubble.innerHTML = renderMarkdown(stripDisplayTimestamps(content));
      }
      const ts = shell.timeEl?.getAttribute('datetime') || new Date().toISOString();

      state.messages.push({ role: 'user',      content: userInput, timestamp: userTimestamp, id: generateId() });
      state.messages.push(...pendingMsgs);
      state.messages.push({ role: 'assistant', content,            timestamp: ts,            id: generateId() });
      // Stamp the assistant element's index now that the message is committed,
      // so the "End topic here" button can resolve the correct state index.
      shell.el.dataset.msgIndex = String(state.messages.length - 1);
      saveHistory();
      refreshTopicGutter();
      wireCopyButton(shell.copyBtn, () => content);
      clearRetryStatus();
      return;
    }
  }

  clearRetryStatus();
  throw lastError || new Error('Request failed and no fallback connections succeeded.');
}

async function attemptNonStreamingOnce(conn, apiMessages, domArtifacts, userInput, prevUserMessageAt) {
  const pendingMsgs = [];

  abortController = new AbortController();
  const response = await fetch('/api/chat', {
    method: 'POST',
    signal: abortController.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider:    conn.provider,
      apiKey:      conn.apiKey,
      model:       conn.model,
      messages:    apiMessages,
      stream:      false,
      temperature: state.temperature,
      max_tokens:  state.maxTokens,
      // `userMessage` carries {{user}}'s actual input — see
      // attemptStreamingOnce for the full rationale.
      ...(typeof userInput === 'string' && userInput.trim()
          ? { userMessage: userInput }
          : {}),
      ...(prevUserMessageAt ? { lastUserMessageAt: prevUserMessageAt } : {}),
      ...((state.sessionAudience?.participants?.length || state.sessionAudience?.location)
          ? { sessionAudience: state.sessionAudience }
          : {}),
      ...toolLoopPayload(),
    }),
  });

  const roundTs = new Date().toISOString();
  setTyping(false);

  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(extractErrorText(data, `API error ${response.status}`));
  }
  if (data._thalamus) lastThalamus = data._thalamus;

  // Server-side tool rounds: render each as a collapsible block and
  // record the same message shapes the old client-side loop produced.
  for (const round of (Array.isArray(data._toolRounds) ? data._toolRounds : [])) {
    const ts    = round.timestamp || roundTs;
    const calls = Array.isArray(round.toolCalls) ? round.toolCalls : [];
    const toolResults = (Array.isArray(round.results) ? round.results : []).map(r => ({
      role:         'tool',
      tool_call_id: r.tool_call_id,
      content:      r.content,
      timestamp:    ts,
      _toolName:    r.name,
      id:           generateId(),
    }));
    pendingMsgs.push({ role: 'assistant', content: round.content || null, tool_calls: calls, timestamp: ts, id: generateId() });
    pendingMsgs.push(...toolResults);
    debugRecord('tool', `server round: ${calls.map(tc => tc?.function?.name).join(', ')}`);
    const tEl = appendToolUseEl(calls, toolResults);
    if (tEl) domArtifacts.push(tEl);
  }

  const message = data.choices?.[0]?.message;
  return { content: message?.content ?? '', pendingMsgs, timestamp: roundTs };
}

async function doNonStreamingRequest(apiMessages, userInput, userTimestamp, prevUserMessageAt) {
  const sequence    = getConnectionSequence();
  if (sequence.length === 0) {
    throw new Error('No usable connection. Set provider, API key, and model in the Settings panel first.');
  }
  const maxRetries = Math.max(0, parseInt(state.maxEmptyRetries, 10) || 0);

  let lastError = null;

  for (let connIdx = 0; connIdx < sequence.length; connIdx++) {
    const conn = sequence[connIdx];
    if (connIdx > 0) {
      setRetryStatus(`Falling back to "${conn.name}" (${conn.provider} / ${conn.model})…`);
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        setRetryStatus(`Empty response from "${conn.name}". Retrying ${attempt}/${maxRetries}…`);
      }

      const domArtifacts = [];
      let result;
      try {
        result = await attemptNonStreamingOnce(conn, apiMessages, domArtifacts, userInput, prevUserMessageAt);
      } catch (err) {
        if (err.name === 'AbortError') { clearRetryStatus(); throw err; }
        for (const el of domArtifacts) el.remove?.();
        lastError = err;
        if (attempt < maxRetries) {
          setRetryStatus(`Request to "${conn.name}" failed (${err.message}). Retrying ${attempt + 1}/${maxRetries}…`);
          continue;
        }
        if (connIdx < sequence.length - 1) {
          appendErrorMessage(`Connection "${conn.name}" failed: ${err.message}. Trying next fallback…`);
          break;
        }
        clearRetryStatus();
        throw err;
      }

      const { content: _rawContent, pendingMsgs, timestamp } = result;
      const content = stripDisplayTimestamps(_rawContent);
      const trimmed   = (content ?? '').trim();
      const usedTools = pendingMsgs.length > 0;

      if (!trimmed && !usedTools) {
        for (const el of domArtifacts) el.remove?.();
        if (attempt < maxRetries) continue;
        if (connIdx < sequence.length - 1) {
          appendErrorMessage(`Connection "${conn.name}" returned empty responses after ${maxRetries + 1} attempts. Trying next fallback…`);
          break;
        }
        clearRetryStatus();
        throw new Error(`All connections returned empty responses (last: "${conn.name}").`);
      }

      const { el: shellEl, bubble, copyBtn } = appendAssistantShell(timestamp);
      bubble.innerHTML = renderMarkdown(stripDisplayTimestamps(content));
      scrollToBottom();

      state.messages.push({ role: 'user',      content: userInput, timestamp: userTimestamp, id: generateId() });
      state.messages.push(...pendingMsgs);
      state.messages.push({ role: 'assistant', content,            timestamp,                id: generateId() });
      // Stamp the assistant element's index now that the message is committed,
      // so the "End topic here" button can resolve the correct state index.
      shellEl.dataset.msgIndex = String(state.messages.length - 1);
      saveHistory();
      refreshTopicGutter();
      wireCopyButton(copyBtn, () => content);
      clearRetryStatus();
      return;
    }
  }

  clearRetryStatus();
  throw lastError || new Error('Request failed and no fallback connections succeeded.');
}

// ── Input lock ───────────────────────────────────────────────────
function setInputLocked(locked) {
  $('send-btn').disabled   = locked;
  $('user-input').disabled = locked;
}

// ── Auto-resize textarea ─────────────────────────────────────────
// Cap the textarea height so the conversation above always stays
// scrollable, even while the user is typing a long message. On mobile
// we want a softer cap (40% of viewport) so the composer can't take
// over the screen; on desktop a hard pixel cap is fine.
function autoResizeCapPx() {
  const isMobile = window.matchMedia('(max-width: 767px)').matches;
  const vh = window.visualViewport?.height ?? window.innerHeight;
  return isMobile ? Math.round(vh * 0.4) : 220;
}
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, autoResizeCapPx()) + 'px';
}

// ── File import ──────────────────────────────────────────────────
let importTargetId = null;

function triggerImport(targetId) {
  importTargetId = targetId;
  const fi = $('file-input');
  fi.value = '';
  fi.click();
}

function handleFileSelected(file) {
  if (!file || !importTargetId) return;
  const reader = new FileReader();
  reader.onload = e => {
    let content = e.target.result;

    // For JSON files, try to extract a common text field
    if (file.name.endsWith('.json')) {
      try {
        const parsed = JSON.parse(content);
        const text = parsed.description ?? parsed.content ?? parsed.text
                  ?? parsed.persona    ?? parsed.profile  ?? parsed.prompt
                  ?? parsed.system     ?? parsed.character;
        content = (typeof text === 'string') ? text : JSON.stringify(parsed, null, 2);
      } catch { /* not valid JSON — use raw text */ }
    }

    const target = $(importTargetId);
    if (target) {
      target.value = content;
      target.dispatchEvent(new Event('input'));
      target.focus();
    }
    importTargetId = null;
  };
  reader.readAsText(file, 'UTF-8');
}

// ── Chat export ──────────────────────────────────────────────────
function exportChat() {
  if (!state.messages.length) {
    alert('No messages to export.');
    return;
  }

  let md = `# Proto-Familiar — Chat Export\n\n`;
  md += `**Date:** ${new Date().toLocaleString()}  \n`;
  md += `**Provider:** ${state.provider}  \n`;
  md += `**Model:** ${state.model}  \n\n`;
  md += `---\n\n`;

  for (const msg of state.messages) {
    // Skip tool-call plumbing messages (role=tool and assistant tool_call turns)
    if (msg.role === 'tool') continue;
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) continue;

    const label = msg.role === 'user' ? '**User**' : '**Assistant**';
    const tsStr = msg.timestamp ? ` _(${new Date(msg.timestamp).toLocaleString()})_` : '';
    md += `${label}${tsStr}\n\n${msg.content ?? ''}\n\n---\n\n`;
  }

  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href:     url,
    download: `familiar-${Date.now()}.md`,
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Settings sync ────────────────────────────────────────────────
function readSettingsFromUI() {
  state.provider          = $('provider-select').value;
  state.apiKey            = $('api-key').value;
  state.model             = $('model-input').value.trim();
  state.streaming         = $('streaming-toggle').checked;
  state.temperature       = parseFloat($('temperature').value);
  state.maxTokens         = parseInt($('max-tokens').value, 10);
  {
    const v = parseInt($('thalamus-dynamic-depth')?.value, 10);
    state.thalamusDynamicDepth = Number.isFinite(v) && v >= 1 && v <= 50 ? v : 4;
  }
  if ($('handoff-toggle')) state.handoffEnabled = $('handoff-toggle').checked;
  if ($('pondering-toggle')) state.ponderingEnabled = $('pondering-toggle').checked;
  if ($('pondering-scale')) {
    const n = parseFloat($('pondering-scale').value);
    state.ponderingIntervalScale = Number.isFinite(n) && n >= 1 && n <= 10 ? n : 1;
  }
  if ($('warmth-toggle')) state.warmthEnabled = $('warmth-toggle').checked;
  if ($('memory-sweep-toggle')) state.memorySweepEnabled = $('memory-sweep-toggle').checked;
  if ($('tome-graduation-toggle')) state.tomeGraduationEnabled = $('tome-graduation-toggle').checked;
  if ($('tome-graduation-tidy')) state.tomeGraduationTidy = $('tome-graduation-tidy').value === 'delete' ? 'delete' : 'pointer';
  if ($('warmth-quiet-start')) {
    const n = parseInt($('warmth-quiet-start').value, 10);
    state.warmthQuietHoursStart = Number.isInteger(n) && n >= 0 && n <= 23 ? n : 23;
  }
  if ($('warmth-quiet-end')) {
    const n = parseInt($('warmth-quiet-end').value, 10);
    state.warmthQuietHoursEnd = Number.isInteger(n) && n >= 0 && n <= 23 ? n : 8;
  }
  state.userName          = $('user-name').value.trim() || 'My human';
  state.charName          = $('char-name').value.trim() || 'Assistant';
  state.systemPrompt      = $('system-prompt').value;
  state.characterProfile  = $('char-profile').value;
  state.userProfile       = $('user-profile').value;
  state.postHistoryPrompt = $('post-history-prompt').value;
  if ($('post-history-role')) {
    const v = $('post-history-role').value;
    state.postHistoryRole = ['system', 'user', 'assistant'].includes(v) ? v : 'system';
  }
  state.toolsEnabled      = $('tools-enabled').checked;
  state.customTools       = $('custom-tools').value;
  const wsEnabledEl = $('web-search-enabled');
  if (wsEnabledEl) state.webSearchEnabled = wsEnabledEl.checked;
  const wsResEl = $('web-search-max-results');
  if (wsResEl) state.webSearchMaxResults = Math.min(20, Math.max(1, parseInt(wsResEl.value, 10) || 5));
  const wsCharsEl = $('web-search-max-chars');
  if (wsCharsEl) state.webSearchMaxChars = Math.min(100000, Math.max(500, parseInt(wsCharsEl.value, 10) || 15000));
  const wsBackendEl = document.querySelector('input[name="web-search-backend"]:checked');
  if (wsBackendEl) state.webSearchBackend = wsBackendEl.value; // 'basic' | 'api'
  const wsProviderEl = document.querySelector('input[name="web-search-api-provider"]:checked');
  if (wsProviderEl) state.webSearchApiProvider = wsProviderEl.value;
  const wsKeyEl = $('web-search-api-key');
  if (wsKeyEl) state.webSearchApiKey = wsKeyEl.value.trim();
  const wsCseEl = $('web-search-google-cse-id');
  if (wsCseEl) state.webSearchGoogleCseId = wsCseEl.value.trim();
  const scanEl = $('tome-scan-depth');
  if (scanEl) state.tomeScanDepth = Math.max(1, parseInt(scanEl.value, 10) || 4);
  const recursiveEl = $('tome-recursive');
  if (recursiveEl) state.tomeRecursive = recursiveEl.checked;
  const maxRecEl = $('tome-max-recursion');
  if (maxRecEl) state.tomeMaxRecursionSteps = Math.max(1, parseInt(maxRecEl.value, 10) || 3);
  const csEl = $('tome-case-sensitive');
  if (csEl) state.tomeCaseSensitive = csEl.checked;
  const wwEl = $('tome-match-whole-words');
  if (wwEl) state.tomeMatchWholeWords = wwEl.checked;
  const retriesEl = $('max-empty-retries');
  if (retriesEl) {
    const n = parseInt(retriesEl.value, 10);
    state.maxEmptyRetries = Number.isFinite(n) && n >= 0 ? n : 0;
  }
  const udwEl = $('user-discord-webhook');
  if (udwEl) state.userDiscordWebhook = udwEl.value.trim();
  const denEl = $('discord-enabled');
  if (denEl) state.discordEnabled = denEl.checked;
  const dbtEl = $('discord-bot-token');
  if (dbtEl) state.discordBotToken = dbtEl.value.trim();
  const dwuEl = $('discord-ward-user-id');
  if (dwuEl) state.discordWardUserId = dwuEl.value.trim();
  // Keep the primary connection in sync with the live Connection-section fields.
  syncFieldsToPrimaryConnection();
  saveSettings();
  renderConnectionsList();
}

// Don't clobber the input the user is actively typing in — the async
// server sync would otherwise stomp on a half-typed API key or prompt.
function setIfNotFocused(el, prop, value) {
  if (!el) return;
  if (document.activeElement === el) return;
  el[prop] = value;
}
function writeSettingsToUI() {
  setIfNotFocused($('provider-select'), 'value',   state.provider);
  setIfNotFocused($('api-key'),         'value',   state.apiKey);
  setIfNotFocused($('model-input'),     'value',   state.model);
  setIfNotFocused($('streaming-toggle'),'checked', state.streaming);
  if ($('handoff-toggle')) setIfNotFocused($('handoff-toggle'), 'checked', state.handoffEnabled !== false);
  if ($('pondering-toggle')) setIfNotFocused($('pondering-toggle'), 'checked', state.ponderingEnabled !== false);
  if ($('pondering-scale'))  setIfNotFocused($('pondering-scale'),  'value',   state.ponderingIntervalScale ?? 1);
  if ($('warmth-toggle'))      setIfNotFocused($('warmth-toggle'),      'checked', state.warmthEnabled !== false);
  if ($('memory-sweep-toggle')) setIfNotFocused($('memory-sweep-toggle'), 'checked', state.memorySweepEnabled !== false);
  if ($('tome-graduation-toggle')) setIfNotFocused($('tome-graduation-toggle'), 'checked', state.tomeGraduationEnabled === true);
  if ($('tome-graduation-tidy'))   setIfNotFocused($('tome-graduation-tidy'),   'value',   state.tomeGraduationTidy === 'delete' ? 'delete' : 'pointer');
  if ($('warmth-quiet-start')) setIfNotFocused($('warmth-quiet-start'), 'value',   state.warmthQuietHoursStart ?? 23);
  if ($('warmth-quiet-end'))   setIfNotFocused($('warmth-quiet-end'),   'value',   state.warmthQuietHoursEnd ?? 8);
  setIfNotFocused($('temperature'),     'value',   state.temperature);
  $('temp-display').textContent = state.temperature;
  setIfNotFocused($('max-tokens'),         'value',   state.maxTokens);
  if ($('thalamus-dynamic-depth')) setIfNotFocused($('thalamus-dynamic-depth'), 'value', state.thalamusDynamicDepth ?? 4);
  setIfNotFocused($('user-name'),          'value',   state.userName ?? 'My human');
  setIfNotFocused($('char-name'),          'value',   state.charName ?? 'Assistant');
  setIfNotFocused($('system-prompt'),      'value',   state.systemPrompt);
  setIfNotFocused($('char-profile'),       'value',   state.characterProfile);
  setIfNotFocused($('user-profile'),       'value',   state.userProfile);
  setIfNotFocused($('post-history-prompt'),'value',   state.postHistoryPrompt);
  if ($('post-history-role')) setIfNotFocused($('post-history-role'), 'value', state.postHistoryRole ?? 'system');
  setIfNotFocused($('tools-enabled'),      'checked', state.toolsEnabled ?? true);
  setIfNotFocused($('custom-tools'),       'value',   state.customTools ?? '');
  setIfNotFocused($('web-search-enabled'),     'checked', state.webSearchEnabled === true);
  setIfNotFocused($('web-search-max-results'), 'value',   state.webSearchMaxResults ?? 5);
  setIfNotFocused($('web-search-max-chars'),   'value',   state.webSearchMaxChars ?? 15000);
  setRadio('web-search-backend',      state.webSearchBackend ?? 'basic');
  setRadio('web-search-api-provider', state.webSearchApiProvider ?? 'marginalia');
  setIfNotFocused($('web-search-api-key'),        'value', state.webSearchApiKey ?? '');
  setIfNotFocused($('web-search-google-cse-id'),  'value', state.webSearchGoogleCseId ?? '');
  syncWebSearchPanels();
  setIfNotFocused($('user-discord-webhook'), 'value', state.userDiscordWebhook ?? '');
  setIfNotFocused($('discord-enabled'),      'checked', state.discordEnabled === true);
  setIfNotFocused($('discord-bot-token'),    'value', state.discordBotToken ?? '');
  setIfNotFocused($('discord-ward-user-id'), 'value', state.discordWardUserId ?? '');
  setIfNotFocused($('tome-scan-depth'),       'value',   state.tomeScanDepth ?? 4);
  setIfNotFocused($('tome-recursive'),        'checked', state.tomeRecursive ?? false);
  setIfNotFocused($('tome-max-recursion'),    'value',   state.tomeMaxRecursionSteps ?? 3);
  setIfNotFocused($('tome-case-sensitive'),   'checked', state.tomeCaseSensitive ?? false);
  setIfNotFocused($('tome-match-whole-words'),'checked', state.tomeMatchWholeWords ?? false);
  setIfNotFocused($('max-empty-retries'),     'value',   state.maxEmptyRetries ?? 2);
  refreshModelSuggestions(state.provider);
}

function refreshModelSuggestions(provider) {
  const dl = $('model-suggestions');
  dl.innerHTML = '';
  for (const m of PROVIDER_MODELS[provider] ?? []) {
    const opt = document.createElement('option');
    opt.value = m;
    dl.appendChild(opt);
  }
}

// ── Collapsible sections ─────────────────────────────────────────
function initCollapsibles() {
  document.querySelectorAll('.collapsible').forEach(section => {
    const btn = section.querySelector('.collapse-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const collapsed = section.classList.toggle('collapsed');
      btn.setAttribute('aria-expanded', String(!collapsed));
    });
  });
}

// ── Theme ────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('theme-icon-dark').style.display  = theme === 'dark'  ? 'block' : 'none';
  $('theme-icon-light').style.display = theme === 'light' ? 'block' : 'none';
  try { localStorage.setItem('pf_theme', theme); } catch { /* ignore */ }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

// ── Sidebar ──────────────────────────────────────────────────────
function toggleSidebar() {
  const sidebar  = $('sidebar');
  const overlay  = $('sidebar-overlay');
  const isMobile = window.innerWidth < 768;

  if (isMobile) {
    const opening = !sidebar.classList.contains('mobile-open');
    sidebar.classList.toggle('mobile-open', opening);
    overlay.classList.toggle('visible', opening);
  } else {
    sidebar.classList.toggle('collapsed');
  }
}

function closeSidebarOnMobile() {
  $('sidebar').classList.remove('mobile-open');
  $('sidebar-overlay').classList.remove('visible');
}

// ── Session management ───────────────────────────────────────────

/** Restart the 3-hour inactivity countdown from zero. */
function resetSessionTimeout() {
  if (_sessionTimeoutId) clearTimeout(_sessionTimeoutId);
  _sessionTimeoutId = setTimeout(autoEndSession, SESSION_IDLE_MS);
}

/**
 * Start a fresh session: generate new UUID, clear messages.
 * The old session's log file on the server is preserved untouched.
 */
function startNewSession() {
  if (_sessionTimeoutId) { clearTimeout(_sessionTimeoutId); _sessionTimeoutId = null; }
  state.sessionId        = generateId();
  state.sessionStartedAt = new Date().toISOString();
  state.sessionEndedAt   = null;
  state.messages         = [];
  state.topics           = [];
  state.sessionAudience  = { location: null, participants: [] };
  lastMessage            = null;
  state.lastMessage      = null;
  elapsedTime            = 0;
  saveSettings();
  try { localStorage.setItem('pf_history', JSON.stringify([])); } catch { /* ignore */ }
  $('messages').innerHTML = '';
  updateTopicStrip();
  refreshTopicGutter();
  updateAudienceBtn();
}

/**
 * Called when SESSION_IDLE_MS elapses since lastMessage.
 * Stamps the current session with endedAt, saves it, then starts a new session.
 */
async function autoEndSession() {
  _sessionTimeoutId = null;
  if (state.messages.length) {
    const sessionMessages = [...state.messages];
    const sessionId       = state.sessionId;
    state.sessionEndedAt  = new Date().toISOString();
    // Remember when this session ended so {{timeSinceLastSession}} reads
    // correctly from the new session that's about to start.
    state.previousSessionEndedAt = state.sessionEndedAt;
    saveSettings();
    await saveToServer();
    memorizeViaBeacon(sessionMessages, sessionId, { scope: 'session' });
    state._beaconedSessionId = sessionId;
    // M6: summarise this session into a handoff for the next one.
    // Fire-and-forget on the captured copy — never blocks the
    // session-end flow, surfaces at the next session's first message.
    generateAndStoreHandoff(sessionMessages, sessionId);
    startNewSession();
    showSessionEndedNotice();
  } else {
    startNewSession();
    showSessionEndedNotice();
  }
}

function showSessionEndedNotice() {
  const toast = document.createElement('div');
  toast.className = 'session-toast';
  toast.textContent = 'Session ended after 3 hours of inactivity. A new session has started.';
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('session-toast-show'));
  setTimeout(() => {
    toast.classList.remove('session-toast-show');
    setTimeout(() => toast.remove(), 400);
  }, 4500);
}

function showMemorizationNotice(count) {
  const toast = document.createElement('div');
  toast.className = 'session-toast';
  toast.textContent = `${count} lorebook entr${count === 1 ? 'y' : 'ies'} memorized from the last session.`;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('session-toast-show'));
  setTimeout(() => {
    toast.classList.remove('session-toast-show');
    setTimeout(() => toast.remove(), 400);
  }, 4500);
}

/**
 * Enqueue a memorization job on the server. The server-side worker calls the
 * LLM, finds/creates the "Session Memories" tome, and writes entries — with
 * retry-on-failure. Survives tab close and server restart.
 *
 * scope: 'session' (whole session) or 'topic' (a topic's message range).
 * Returns the jobId, or null on error / when memorization isn't possible.
 */
async function memorizeSessionToTome(messages, sessionId, opts = {}) {
  if (!state.apiKey.trim()) return null;
  if (!Array.isArray(messages) || messages.length < 2) return null;
  const payload = {
    sessionId,
    scope:        opts.scope ?? 'session',
    topicId:      opts.topicId ?? null,
    topicLabel:   opts.topicLabel ?? null,
    messageRange: opts.messageRange ?? null,
    messages,
    provider:     state.provider,
    apiKey:       state.apiKey,
    model:        state.model,
    audienceTag:  'ward-private',
  };
  try {
    const resp = await fetch('/api/memorize', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (!resp.ok) {
      console.warn('[memorize] enqueue failed:', resp.status, await resp.text().catch(() => ''));
      return null;
    }
    // Topic scope returns a single { jobId }; session scope is day-anchored on
    // the server and returns { enqueued, skipped } — either is success here.
    const data = await resp.json();
    return data.jobId ?? 'ok';
  } catch (err) {
    console.warn('[memorize] enqueue error:', err);
    return null;
  }
}

/**
 * Fire-and-forget enqueue that survives tab close via navigator.sendBeacon.
 * Used in the `beforeunload` handler — fetch() won't reliably deliver there.
 */
function memorizeViaBeacon(messages, sessionId, opts = {}) {
  if (!state.apiKey.trim()) return false;
  if (!Array.isArray(messages) || messages.length < 2) return false;
  const payload = {
    sessionId,
    scope:        opts.scope ?? 'session',
    topicId:      opts.topicId ?? null,
    topicLabel:   opts.topicLabel ?? null,
    messageRange: opts.messageRange ?? null,
    messages,
    provider:     state.provider,
    apiKey:       state.apiKey,
    model:        state.model,
    audienceTag:  'ward-private',
  };
  try {
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    return navigator.sendBeacon('/api/memorize', blob);
  } catch {
    return false;
  }
}

// ── Memorization status polling ──────────────────────────────────
// The server queue runs asynchronously. Poll for terminal-state jobs so we
// can toast outcomes (success or failure) and then ACK them so we don't
// re-toast on the next poll.

let _memStatusTimerId = null;

async function pollMemorizationStatus() {
  try {
    const resp = await fetch('/api/memorize');
    if (!resp.ok) return;
    const jobs = await resp.json();
    let tomeChanged = false;
    for (const j of jobs) {
      if (j.acknowledged) continue;
      if (j.status === 'done') {
        const n = j.result?.entriesCreated ?? 0;
        if (n > 0) showMemorizationNotice(n);
        tomeChanged = true;
      } else if (j.status === 'failed') {
        showMemorizationFailureNotice(j.lastError ?? 'unknown error');
      } else {
        continue;
      }
      // Best-effort ack; ignore failure.
      fetch(`/api/memorize/${j.id}/ack`, { method: 'POST' }).catch(() => {});
    }
    if (tomeChanged) {
      // Refresh the registry so a freshly-created "Session Memories" tome shows up.
      loadTomesFromServer?.().catch?.(() => {});
    }
  } catch { /* polling is best-effort */ }
}

function startMemorizationStatusPolling() {
  if (_memStatusTimerId) return;
  pollMemorizationStatus();
  _memStatusTimerId = setInterval(pollMemorizationStatus, 30_000);
  // Also poll when the tab regains focus — likely just-completed jobs.
  window.addEventListener('focus', pollMemorizationStatus);
}

function showMemorizationFailureNotice(reason) {
  const toast = document.createElement('div');
  toast.className = 'session-toast';
  toast.textContent = `Memorization failed: ${reason}`;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('session-toast-show'));
  setTimeout(() => {
    toast.classList.remove('session-toast-show');
    setTimeout(() => toast.remove(), 400);
  }, 6000);
}

// Discord presence needs the server's Node runtime to expose a native
// WebSocket (Node ≥ 22). On an older runtime the gateway silently stays
// down — so when the ward opens the Discord section we surface a plain
// warning that names the running version and the fix, instead of letting
// them toggle Discord on and wonder why nothing connects.
function renderDiscordNodeWarning(status) {
  const el = $('discord-node-warning');
  if (!el) return;
  if (status && status.webSocketSupported === false) {
    const ver = status.nodeVersion ? ` (this server is on Node ${status.nodeVersion})` : '';
    el.innerHTML =
      `⚠️ Discord presence needs <strong>Node 22 or newer</strong>${ver}. ` +
      `The gateway can't open its WebSocket on this runtime and will stay offline ` +
      `even with the toggle on. Re-run the installer to upgrade Node, then restart Proto-Familiar.`;
    el.style.display = '';
  } else {
    el.style.display = 'none';
  }
}

// ── Prompt inspector modal ───────────────────────────────────

// Human-readable labels for each prompt-segment source. The CSS class
// `pi-src-<source>` controls the chip + left-rule colour.
const PI_SOURCE_LABELS = {
  // Thalamus is split into two regions for cache-aware prompt assembly:
  // the static block prepends the system message (cacheable prefix);
  // the dynamic block is depth-injected as its own system message so
  // changes don't invalidate the static prefix.
  'thalamus-static':   'Phylactery (static)',
  'thalamus-dynamic':  'Phylactery (dynamic @ depth)',
  'lore-sys-top':      'Lore · system top',
  'lore-before-char':  'Lore · before character',
  'lore-after-char':   'Lore · after character',
  'lore-sys-bottom':   'Lore · system bottom',
  'lore-at-depth':     'Lore · injected at depth',
  'system-prompt':     'System prompt',
  'character-profile': 'Character profile',
  'user-profile':      'User profile',
  'post-history':      'Post-history prompt',
  'thalamus-time-anchor': '[Now] (server-appended, last)',
};

function piSegmentEl(source, text) {
  const seg = document.createElement('div');
  seg.className = `pi-seg pi-src-${source}`;
  const chip = document.createElement('span');
  chip.className = 'pi-chip';
  chip.textContent = PI_SOURCE_LABELS[source] ?? source;
  const pre = document.createElement('pre');
  pre.className = 'pi-pre';
  pre.textContent = text;
  seg.appendChild(chip);
  seg.appendChild(pre);
  return seg;
}

function openPromptInspector() {
  const body = $('prompt-inspector-body');
  body.innerHTML = '';
  if (!lastSentMessages) {
    body.innerHTML = '<p class="logs-empty">Send a message first.</p>';
    $('prompt-inspector-modal').classList.remove('hidden');
    return;
  }

  // Legend strip
  const legend = document.createElement('div');
  legend.className = 'pi-legend';
  for (const src of ['thalamus-static', 'thalamus-dynamic',
                     'system-prompt', 'character-profile', 'user-profile',
                     'lore-sys-top', 'lore-before-char', 'lore-after-char', 'lore-sys-bottom',
                     'lore-at-depth', 'post-history', 'thalamus-time-anchor']) {
    const chip = document.createElement('span');
    chip.className = `pi-chip pi-src-${src}`;
    chip.textContent = PI_SOURCE_LABELS[src];
    legend.appendChild(chip);
  }
  body.appendChild(legend);

  // Note about provenance freshness
  if (!lastThalamus || (!lastThalamus.static && !lastThalamus.dynamic)) {
    const note = document.createElement('p');
    note.className = 'field-hint';
    note.textContent = 'No Phylactery enrichment block in the last response. Thalamus may have returned empty (no enrichment), or the request hadn\'t completed yet — re-open after the next reply lands.';
    body.appendChild(note);
  }

  const atDepthSet = new Set((lastBuildSegments?.atDepthInjections ?? []).map(a => a.indexInFinal));

  // Renders one message wrap into `body`. Pulled into a helper so the
  // server's depth-injected thalamus message (which isn't in
  // lastSentMessages because the client doesn't see it until it's
  // already on its way to the LLM) can be rendered the same way as
  // the messages the client built itself.
  const renderMessage = (msg, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'pi-msg';
    const roleClass = `pi-role-${msg.role ?? 'user'}`;
    const role = msg.role ?? 'user';

    const header = document.createElement('div');
    header.className = 'pi-msg-header';
    header.innerHTML = `<span class="pi-role ${roleClass}">${esc(role)}</span>`;
    const fullText = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content ?? msg.tool_calls ?? '', null, 2);
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-ghost pi-copy';
    copyBtn.textContent = 'Copy';
    wireCopyButton(copyBtn, () => fullText);
    header.appendChild(copyBtn);
    wrap.appendChild(header);

    // Synthetic message representing the server's depth-injected
    // dynamic-thalamus block. Rendered with its own source color.
    if (msg.__source === 'thalamus-dynamic') {
      wrap.appendChild(piSegmentEl('thalamus-dynamic', fullText));
      body.appendChild(wrap);
      return;
    }
    // Synthetic message representing the server-appended time anchor
    // — the absolute last system message in the prompt.
    if (msg.__source === 'thalamus-time-anchor') {
      wrap.appendChild(piSegmentEl('thalamus-time-anchor', fullText));
      body.appendChild(wrap);
      return;
    }

    // System message: split by source. Includes the Phylactery
    // STATIC block as its own first segment when present, then each
    // tracked build segment. The DYNAMIC block lives in its own
    // synthetic message at `injectedAt` (handled above), not here.
    if (role === 'system' && idx === 0 && lastBuildSegments?.systemSegments?.length) {
      if (lastThalamus?.static) {
        wrap.appendChild(piSegmentEl('thalamus-static', lastThalamus.static));
      }
      for (const seg of lastBuildSegments.systemSegments) {
        wrap.appendChild(piSegmentEl(seg.source, seg.text));
      }
    } else if (atDepthSet.has(idx)) {
      // History splice from an at-depth lore entry.
      wrap.appendChild(piSegmentEl('lore-at-depth', fullText));
    } else if (msg === lastSentMessages[lastSentMessages.length - 1]
               && state.postHistoryPrompt.trim()
               && fullText.trim() === applyNameVars(state.postHistoryPrompt.trim())) {
      wrap.appendChild(piSegmentEl('post-history', fullText));
    } else {
      // Plain history / user / assistant / tool message — neutral rendering.
      const pre = document.createElement('pre');
      pre.className = 'pi-pre';
      pre.textContent = fullText;
      wrap.appendChild(pre);
    }
    body.appendChild(wrap);
  };

  // Walk lastSentMessages. When we reach the index where the server
  // depth-injected its dynamic block (`injectedAt`), render that
  // synthetic message first, then continue. injectedAt counts indices
  // in the pre-insertion array — which IS lastSentMessages — so a
  // direct comparison works.
  const dynamicAt = (lastThalamus?.dynamic && typeof lastThalamus.injectedAt === 'number')
    ? lastThalamus.injectedAt
    : null;

  lastSentMessages.forEach((msg, idx) => {
    if (idx === dynamicAt) {
      renderMessage({ role: 'system', content: lastThalamus.dynamic, __source: 'thalamus-dynamic' }, idx);
    }
    renderMessage(msg, idx);
  });
  // Edge case: dynamic injected at exactly lastSentMessages.length —
  // it lands after every message the client sent. (Only possible when
  // the conversation is empty, which shouldn't happen, but render
  // defensively anyway.)
  if (dynamicAt !== null && dynamicAt >= lastSentMessages.length) {
    renderMessage({ role: 'system', content: lastThalamus.dynamic, __source: 'thalamus-dynamic' }, dynamicAt);
  }

  // Time anchor — the server appends this as the absolute last system
  // message AFTER the chat history and post-history prompt. Renders
  // here too, so the inspector accurately shows what the LLM saw
  // (lastSentMessages doesn't include it; the server adds it post-
  // build, and surfaces it via lastThalamus.timeAnchor).
  if (lastThalamus?.timeAnchor) {
    renderMessage({ role: 'system', content: lastThalamus.timeAnchor, __source: 'thalamus-time-anchor' }, lastSentMessages.length);
  }

  $('prompt-inspector-modal').classList.remove('hidden');
}

function closePromptInspector() {
  $('prompt-inspector-modal').classList.add('hidden');
}

// ── Tailscale / external-access toggle ──────────────────────
async function fetchTailscaleState() {
  const r = await fetch('/api/tailscale');
  if (!r.ok) throw new Error(`tailscale state HTTP ${r.status}`);
  return r.json();
}
async function setTailscaleEnabled(enabled) {
  const r = await fetch('/api/tailscale', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) throw new Error(`tailscale toggle HTTP ${r.status}`);
  return r.json();
}
function renderTailscaleState(state) {
  const btn       = $('tailscale-btn');
  const sw        = $('tailscale-switch');
  const statusEl  = $('tailscale-status');
  const urlsEl    = $('tailscale-urls');
  btn.classList.toggle('is-active', !!state.enabled);
  btn.setAttribute('aria-pressed', state.enabled ? 'true' : 'false');
  btn.title = state.enabled
    ? 'External-device access ON (click for URLs)'
    : 'External-device access OFF (click to enable)';
  sw.checked = !!state.enabled;

  urlsEl.innerHTML = '';
  if (state.enabled) {
    if (state.hostname) {
      const url = `http://${state.hostname}:${state.port}`;
      urlsEl.insertAdjacentHTML('beforeend',
        `<li>Tailscale: <a href="${url}" target="_blank" rel="noopener">${url}</a></li>`);
    }
    if (state.ipv4) {
      const url = `http://${state.ipv4}:${state.port}`;
      urlsEl.insertAdjacentHTML('beforeend',
        `<li>Tailscale IPv4: <a href="${url}" target="_blank" rel="noopener">${url}</a></li>`);
    }
    if (!state.hostname && !state.ipv4) {
      statusEl.textContent = state.available
        ? 'Tailscale CLI found but no addresses returned. Use this machine\'s LAN IP on port ' + state.port + '.'
        : 'Tailscale CLI not detected. Use this machine\'s LAN/Tailscale address on port ' + state.port + '.';
    } else {
      statusEl.textContent = 'Open one of these on any device on your tailnet:';
    }
  } else {
    statusEl.textContent = 'Off — only this machine can reach Proto-Familiar.';
  }
}
function initTailscaleToggle() {
  const btn      = $('tailscale-btn');
  const popover  = $('tailscale-popover');
  const sw       = $('tailscale-switch');

  fetchTailscaleState().then(renderTailscaleState).catch(err => {
    console.warn('tailscale state load failed', err);
  });

  btn.addEventListener('click', async () => {
    const willOpen = popover.classList.contains('hidden');
    popover.classList.toggle('hidden');
    if (willOpen) {
      try { renderTailscaleState(await fetchTailscaleState()); }
      catch (err) { console.warn('tailscale refresh failed', err); }
    }
  });

  // Click-outside to dismiss
  document.addEventListener('click', e => {
    if (popover.classList.contains('hidden')) return;
    if (e.target === btn || btn.contains(e.target)) return;
    if (popover.contains(e.target)) return;
    popover.classList.add('hidden');
  });

  sw.addEventListener('change', async () => {
    const next = sw.checked;
    try {
      const state = await setTailscaleEnabled(next);
      renderTailscaleState(state);
    } catch (err) {
      console.error('tailscale toggle failed', err);
      sw.checked = !next; // revert
    }
  });
}

// ── Logs modal ──────────────────────────────────────────────
function openLogsModal() {
  $('logs-modal').classList.remove('hidden');
  refreshLogsList();
}

function closeLogsModal() {
  $('logs-modal').classList.add('hidden');
}

async function refreshLogsList() {
  const container = $('logs-list');
  container.innerHTML = '<p class="logs-loading">Loading…</p>';
  try {
    const res      = await fetch('/api/logs');
    const sessions = await res.json();

    if (!sessions.length) {
      container.innerHTML = '<p class="logs-empty">No saved sessions yet.</p>';
      return;
    }

    container.innerHTML = '';
    for (const s of sessions) {
      const isActive  = s.sessionId === state.sessionId;

      // Build human-readable date/time label: "May 11, 2026, 14:30 → 17:45"
      const startDate = s.startedAt ? new Date(s.startedAt) : null;
      const endDate   = s.endedAt   ? new Date(s.endedAt)   : null;
      const startStr  = startDate
        ? startDate.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '—';
      let endStr;
      if (!endDate) {
        endStr = isActive ? 'ongoing' : '—';
      } else if (startDate && endDate.toDateString() === startDate.toDateString()) {
        endStr = endDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } else {
        endStr = endDate.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      }

      const modelStr  = [s.provider, s.model].filter(Boolean).join(' / ');
      const countStr  = `${s.messageCount} msg${s.messageCount !== 1 ? 's' : ''}`;

      const row = document.createElement('div');
      row.className = 'log-row' + (isActive ? ' log-row-active' : '');

      row.innerHTML = `
        <div class="log-info">
          <div class="log-date">${esc(startStr)} → ${esc(endStr)}${isActive ? ' <span class="log-current">(current)</span>' : ''}</div>
          <div class="log-meta">${esc(modelStr)} · ${esc(countStr)}</div>
        </div>
        <div class="log-actions"></div>
      `;

      const actions = row.querySelector('.log-actions');

      if (!isActive) {
        const loadBtn = document.createElement('button');
        loadBtn.className = 'btn-secondary log-action-btn';
        loadBtn.textContent = 'Load';
        loadBtn.addEventListener('click', () => loadSession(s.sessionId));
        actions.appendChild(loadBtn);
      }

      const memBtn = document.createElement('button');
      memBtn.className = 'btn-secondary log-action-btn';
      memBtn.textContent = 'Memorize';
      memBtn.title = 'Auto-summarize or manually mark topics for this session';
      memBtn.addEventListener('click', () => openMemorizeChoice(s));
      actions.appendChild(memBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'btn-ghost log-action-btn';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', async () => {
        if (!confirm('Delete this session log? This cannot be undone.')) return;
        await fetch(`/api/logs/${s.sessionId}`, { method: 'DELETE' });
        refreshLogsList();
      });
      actions.appendChild(delBtn);

      container.appendChild(row);
    }
  } catch (err) {
    container.innerHTML = `<p class="logs-error">⚠ Failed to load sessions: ${esc(String(err.message))}</p>`;
  }
}

async function loadSession(sessionId) {
  try {
    const res  = await fetch(`/api/logs/${sessionId}`);
    const data = await res.json();
    if (!res.ok || !Array.isArray(data.messages)) throw new Error(data.error || 'Invalid session data');

    // Cancel any running timeout before switching sessions
    if (_sessionTimeoutId) { clearTimeout(_sessionTimeoutId); _sessionTimeoutId = null; }

    state.messages         = data.messages;
    state.sessionId        = sessionId;
    state.sessionStartedAt = data.startedAt || new Date().toISOString();
    state.sessionEndedAt   = null; // treat loaded session as resumed/active

    // Close all open topics from the loaded session (treat as historic)
    const rawTopics = localStorage.getItem(`pf_topics_${sessionId}`);
    state.topics = rawTopics ? JSON.parse(rawTopics).map(t => ({
      ...t, endIndex: t.endIndex ?? (state.messages.length - 1)
    })) : [];

    const lastMsg   = state.messages[state.messages.length - 1];
    lastMessage         = lastMsg?.timestamp || null;
    state.lastMessage   = lastMessage;
    elapsedTime         = 0;
    saveSettings();
    try { localStorage.setItem('pf_history', JSON.stringify(state.messages)); } catch { /* ignore */ }

    // Resume inactivity timer with remaining time (if session not already stale)
    if (lastMessage) {
      const idleMs = Date.now() - new Date(lastMessage).getTime();
      if (idleMs < SESSION_IDLE_MS) {
        _sessionTimeoutId = setTimeout(autoEndSession, SESSION_IDLE_MS - idleMs);
      }
    }

    renderAllMessages();
    updateTopicStrip();
    closeLogsModal();

    // Loading a different session changes which log is "the prior one" —
    // recompute the cache so {{timeSinceLastSession}} stays correct.
    refreshPreviousSessionEndedAt().catch(() => {});
  } catch (err) {
    alert(`Failed to load session: ${err.message}`);
  }
}

// ── Init ────────────────────────────────────────────────────────────
function init() {
  // Restore persisted state
  loadPersisted();

  // Restore session timing from persisted state and check for stale session.
  // This handles the case where the tab was closed before the 3-hour timer fired.
  lastMessage = state.lastMessage || null;
  if (lastMessage) {
    const idleMs = Date.now() - new Date(lastMessage).getTime();
    if (idleMs >= SESSION_IDLE_MS) {
      // Session expired while the tab was closed — finalize silently, then reset.
      // Capture the just-finalised endedAt for {{timeSinceLastSession}} before
      // startNewSession() clears sessionEndedAt.
      if (state.messages.length && !state.sessionEndedAt) {
        state.sessionEndedAt = lastMessage; // approximate — last known activity
      }
      if (state.sessionEndedAt) {
        state.previousSessionEndedAt = state.sessionEndedAt;
      }
      if (state.messages.length) {
        saveSettings();
        saveToServer(); // fire-and-forget
      }
      startNewSession();
    } else {
      // Resume the countdown with however much time remains
      _sessionTimeoutId = setTimeout(autoEndSession, SESSION_IDLE_MS - idleMs);
    }
  }

  // Backfill {{timeSinceLastSession}}'s cache from server logs on cold start,
  // so the macro works for users whose localStorage doesn't have it yet.
  if (!state.previousSessionEndedAt) {
    refreshPreviousSessionEndedAt().catch(() => {});
  }

  // Apply saved theme
  const savedTheme = localStorage.getItem('pf_theme') || 'dark';
  applyTheme(savedTheme);

  // Populate UI from state (fast path — uses the localStorage cache).
  writeSettingsToUI();
  renderAllMessages();
  initCollapsibles();

  // Pull the canonical settings from the server in the background. If the
  // server has data, it overlays + repaints; if it's empty, our local
  // settings get pushed up so the next device sees them.
  syncSettingsFromServer().catch(err => console.warn('syncSettingsFromServer', err));

  // Auto-resume: if the server has a more recent session than what this
  // device has loaded, silently load it (empty local) or offer a banner.
  autoResumeMostRecentSession().catch(() => {});

  // Outbox polling (M11 reminders, M12 silence triage). Cheap GET every
  // 30s; pending items are injected as chat messages in the active session.
  startOutboxPolling();

  // Trusted contacts (M12c) — manage list in the sidebar section.
  if ($('contact-add')) {
    $('contact-add').addEventListener('click', addTrustedContact);
    renderTrustedContacts();
  }

  // Discord presence (Village V4) — show live gateway status. Cheap GET;
  // failures render as a quiet dash. A fatal state (bad token / intents)
  // shows red rather than a perpetual "reconnecting", so the ward sees the
  // real problem instead of a green light over a silent retry loop.
  async function refreshDiscordStatus() {
    const el = $('discord-status');
    if (!el) return;
    try {
      const s = await (await fetch('/api/discord/status')).json();
      renderDiscordNodeWarning(s);
      const bits = [];
      if (s.fatal) {
        bits.push(`🔴 ${s.lastError || 'Discord refused the connection — check the bot token and privileged intents.'}`);
      } else {
        bits.push(s.connected ? `🟢 Connected as ${s.botUser ?? 'bot'}` : (s.running ? '🟡 Starting / reconnecting…' : '⚪ Not running'));
        if (s.lastError) bits.push(`Last error: ${s.lastError}`);
      }
      if (s.turns) bits.push(`${s.turns} replies this boot`);
      el.textContent = bits.join(' · ');
    } catch {
      el.textContent = '—';
    }
  }

  const discordSection = document.querySelector('#section-discord .collapse-toggle');
  if (discordSection) {
    discordSection.addEventListener('click', () => { refreshDiscordStatus(); });
  }

  // Apply & connect — flush the current settings to the server immediately
  // (bypassing the debounce) and kick the gateway to (re)connect now, so the
  // ward doesn't have to wait for the 30s supervisor tick or reload the page.
  const discordApplyBtn = $('discord-apply');
  if (discordApplyBtn) {
    discordApplyBtn.addEventListener('click', async () => {
      const el = $('discord-status');
      discordApplyBtn.disabled = true;
      if (el) el.textContent = 'Applying…';
      try {
        readSettingsFromUI(); // pull the latest field values into state
        await fetch('/api/settings', {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ settings: extractServerSettings(state) }),
        });
        await fetch('/api/discord/apply', { method: 'POST' });
      } catch { /* fall through to the status refresh either way */ }
      // The gateway connects asynchronously — poll the status a few times so
      // the indicator lands on the real outcome (connected / fatal).
      await refreshDiscordStatus();
      setTimeout(refreshDiscordStatus, 1500);
      setTimeout(refreshDiscordStatus, 4000);
      discordApplyBtn.disabled = false;
    });
  }

  // ── Web search backend modal ─────────────────────────────────
  const webSearchConfigureBtn = $('web-search-configure-btn');
  if (webSearchConfigureBtn) webSearchConfigureBtn.addEventListener('click', openWebSearchModal);
  $('websearch-modal-close')?.addEventListener('click', closeWebSearchModal);
  $('websearch-modal-cancel')?.addEventListener('click', closeWebSearchModal);
  $('websearch-modal')?.addEventListener('click', e => { if (e.target === $('websearch-modal')) closeWebSearchModal(); });
  document.querySelectorAll('input[name="web-search-backend"], input[name="web-search-api-provider"]').forEach(el => {
    el.addEventListener('change', () => { readSettingsFromUI(); syncWebSearchPanels(); });
  });
  $('websearch-apply-btn')?.addEventListener('click', applyWebSearchBackend);
  $('guide-chat-send')?.addEventListener('click', sendGuideChat);
  $('guide-chat-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendGuideChat(); }
  });

  // ── Settings field listeners ─────────────────────────────────
  const settingsIds = [
    'provider-select', 'api-key', 'model-input', 'streaming-toggle',
    'temperature', 'max-tokens', 'thalamus-dynamic-depth', 'handoff-toggle',
    'pondering-toggle', 'pondering-scale',
    'warmth-toggle', 'warmth-quiet-start', 'warmth-quiet-end',
    'memory-sweep-toggle',
    'tome-graduation-toggle', 'tome-graduation-tidy',
    'user-name', 'char-name',
    'system-prompt', 'char-profile',
    'user-profile', 'post-history-prompt', 'post-history-role', 'tools-enabled', 'custom-tools',
    'web-search-enabled', 'web-search-max-results', 'web-search-max-chars',
    'web-search-api-key', 'web-search-google-cse-id',
    'user-discord-webhook',
    'discord-enabled', 'discord-bot-token', 'discord-ward-user-id',
    'tome-scan-depth', 'tome-recursive', 'tome-max-recursion',
    'tome-case-sensitive', 'tome-match-whole-words',
    'max-empty-retries',
  ];

  settingsIds.forEach(id => {
    const el = $(id);
    if (!el) return;

    el.addEventListener('change', readSettingsFromUI);
    el.addEventListener('input',  () => {
      if (id === 'temperature') {
        $('temp-display').textContent = parseFloat(el.value).toFixed(2);
      }
      readSettingsFromUI();
    });
  });

  // Provider change → refresh model suggestions and set sane default. Also
  // auto-fill the API key field from any saved connection using the same
  // provider, so a user with multiple saved keys per provider doesn't have
  // to retype the bearer token when switching providers.
  $('provider-select').addEventListener('change', e => {
    const prov  = e.target.value;
    const input = $('model-input');
    refreshModelSuggestions(prov);
    if (!PROVIDER_MODELS[prov]?.includes(input.value)) {
      input.value = PROVIDER_DEFAULT_MODEL[prov] || '';
      state.model = input.value;
    }
    const keyInput  = $('api-key');
    const hint      = $('api-key-autofill-hint');
    const savedKey  = findKeyForProvider(prov);
    if (savedKey && (!keyInput.value.trim() || keyInput.value !== savedKey)) {
      keyInput.value = savedKey;
      state.apiKey   = savedKey;
      if (hint) hint.style.display = '';
    } else if (hint) {
      hint.style.display = 'none';
    }
    syncFieldsToPrimaryConnection();
    saveSettings();
    renderConnectionsList();
  });

  // Hide the autofill hint as soon as the user manually edits the key.
  const apiKeyEl = $('api-key');
  if (apiKeyEl) {
    apiKeyEl.addEventListener('input', () => {
      const hint = $('api-key-autofill-hint');
      if (hint) hint.style.display = 'none';
    });
  }

  // Save current Connection fields as a new named connection.
  const saveConnBtn = $('save-connection-btn');
  if (saveConnBtn) {
    saveConnBtn.addEventListener('click', () => {
      const nameInput = $('connection-name-input');
      const name = (nameInput?.value || '').trim();
      if (!name) {
        alert('Give the connection a name first (e.g. "Primary", "Work", "Backup").');
        nameInput?.focus();
        return;
      }
      if (!state.apiKey.trim() || !state.model.trim()) {
        alert('Fill in the API key and model fields above before saving a connection.');
        return;
      }
      const conn = saveNewConnection(name);
      if (conn && nameInput) nameInput.value = '';
    });
    const nameInput = $('connection-name-input');
    if (nameInput) {
      nameInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); saveConnBtn.click(); }
      });
    }
  }

  // Initial render of the saved-connections list.
  renderConnectionsList();

  // ── Send ─────────────────────────────────────────────────────
  $('send-btn').addEventListener('click', () => {
    const input = $('user-input');
    const text  = input.value;
    input.value = '';
    autoResize(input);
    sendMessage(text);
  });

  $('user-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('send-btn').click();
    }
  });

  $('user-input').addEventListener('input', function() {
    autoResize(this);
  });

  // ── Clear history ────────────────────────────────────────────
  $('clear-chat-btn').addEventListener('click', () => {
    if (!state.messages.length || confirm('Clear all chat history? The current session log will be kept.')) {
      if (state.messages.length) {
        const sessionMessages = [...state.messages];
        const sessionId       = state.sessionId;
        state.sessionEndedAt  = new Date().toISOString();
        // Hand the just-ended session's endedAt to {{timeSinceLastSession}}
        // before startNewSession() resets sessionEndedAt to null.
        state.previousSessionEndedAt = state.sessionEndedAt;
        saveSettings();
        saveToServer(); // fire-and-forget — stamps the log with endedAt
        memorizeViaBeacon(sessionMessages, sessionId, { scope: 'session' });
        state._beaconedSessionId = sessionId;
        // M6: summarise the cleared session into a handoff for the next.
        generateAndStoreHandoff(sessionMessages, sessionId);
        startNewSession();
      } else {
        startNewSession();
      }
      setStatus('');
    }
  });

  // ── Export chat ──────────────────────────────────────────────
  $('export-chat-btn').addEventListener('click', exportChat);

  // ── Prompt inspector ─────────────────────────────────────────
  $('prompt-inspector-btn').addEventListener('click', openPromptInspector);
  $('prompt-inspector-close').addEventListener('click', closePromptInspector);
  $('prompt-inspector-modal').addEventListener('click', e => {
    if (e.target === $('prompt-inspector-modal')) closePromptInspector();
  });

  // ── Tailscale / external-access toggle ───────────────────────
  initTailscaleToggle();

  // ── Logs modal ────────────────────────────────────────────
  $('logs-btn').addEventListener('click', openLogsModal);
  $('logs-modal-close').addEventListener('click', closeLogsModal);
  $('logs-modal').addEventListener('click', e => {
    if (e.target === $('logs-modal')) closeLogsModal();
  });

  // ── Topic system ─────────────────────────────────────────────
  $('new-topic-btn').addEventListener('click', openTopicNameModal);
  $('topic-name-modal-close').addEventListener('click', closeTopicNameModal);
  $('topic-name-cancel-btn').addEventListener('click', closeTopicNameModal);
  $('topic-name-modal').addEventListener('click', e => {
    if (e.target === $('topic-name-modal')) closeTopicNameModal();
  });
  $('topic-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); $('topic-name-start-btn').click(); }
    if (e.key === 'Escape') closeTopicNameModal();
  });
  $('topic-name-start-btn').addEventListener('click', () => {
    const label = $('topic-name-input').value.trim() || `Topic ${state.topics.length + 1}`;
    // Capture the retroactive start index BEFORE closeTopicNameModal()
    // nulls it. Without this, the per-message "▷ Topic start" button
    // started the topic at state.messages.length (the very bottom of
    // the chat) regardless of which message I clicked on.
    const retroStartIdx = _retroStartIndex;
    closeTopicNameModal();
    startTopic(label, retroStartIdx);
  });

  // Summary modal
  $('summary-modal-close').addEventListener('click', () => {
    if (confirm('Discard this topic summary? It will not be saved to a Tome.')) {
      closeSummaryModal();
    }
  });
  $('summary-modal').addEventListener('click', e => {
    if (e.target === $('summary-modal') && confirm('Discard this summary?')) closeSummaryModal();
  });
  $('summary-discard-btn').addEventListener('click', () => {
    if (confirm('Discard this topic summary?')) closeSummaryModal();
  });
  $('summary-regen-btn').addEventListener('click', () => {
    if (_pendingSummaryTopic) regenerateSummary(_pendingSummaryTopic);
  });
  $('summary-save-btn').addEventListener('click', savePendingSummary);

  // Diagnostics
  $('diagnostics-btn').addEventListener('click', openDiagnosticsModal);
  $('diagnostics-modal-close').addEventListener('click', closeDiagnosticsModal);
  $('diagnostics-modal').addEventListener('click', e => {
    if (e.target === $('diagnostics-modal')) closeDiagnosticsModal();
  });
  $('diagnostics-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('diagnostics-output').textContent);
      $('diagnostics-copy').textContent = 'Copied ✓';
      setTimeout(() => { $('diagnostics-copy').textContent = 'Copy'; }, 1500);
    } catch { alert('Copy failed — select and copy manually.'); }
  });
  $('diagnostics-download').addEventListener('click', downloadDiagnosticReport);

  // Knowledge editor (Phylactery)
  $('knowledge-btn').addEventListener('click', openKnowledgeModal);
  $('knowledge-modal-close').addEventListener('click', closeKnowledgeModal);
  // Intentionally NO backdrop-click-to-close: it fires mid-pan or while
  // dragging the resize handle past the modal edge. Only the ✕ closes it.
  document.querySelectorAll('.ke-tab').forEach(el => {
    el.addEventListener('click', () => keSwitchTab(el.dataset.tab));
  });
  // Session audience (Village Support V2)
  if ($('audience-btn')) {
    $('audience-btn').addEventListener('click', toggleAudiencePopover);
    $('audience-popover-close').addEventListener('click', closeAudiencePopover);
    $('audience-add-btn').addEventListener('click', audienceAddFromInput);
    $('audience-search').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); audienceAddFromInput(); }
      if (e.key === 'Escape') closeAudiencePopover();
    });
    document.addEventListener('click', e => {
      const wrap = $('audience-wrap');
      if (wrap && !wrap.contains(e.target)) closeAudiencePopover();
    });
    updateAudienceBtn();
  }

  // Village editor (Village Support V1)
  if ($('village-btn')) {
    $('village-btn').addEventListener('click', openVillageModal);
    $('village-modal-close').addEventListener('click', closeVillageModal);
    document.querySelectorAll('[data-village-tab]').forEach(el => {
      el.addEventListener('click', () => vlSwitchTab(el.dataset.villageTab));
    });
    $('vl-people-refresh').addEventListener('click', () => vlLoadPeople());
    $('vl-people-add').addEventListener('click', vlStartNewPerson);
    $('vl-cat-refresh').addEventListener('click', () => vlLoadCategories());
    $('vl-cat-add').addEventListener('click', vlStartNewCategory);
    $('vl-loc-refresh').addEventListener('click', () => vlLoadLocations());
    $('vl-loc-add').addEventListener('click', vlStartNewLocation);
  }

  // Temporal editor (Unruh) — M9
  if ($('temporal-btn')) {
    $('temporal-btn').addEventListener('click', openTemporalModal);
    $('temporal-modal-close').addEventListener('click', closeTemporalModal);
    document.querySelectorAll('[data-temporal-tab]').forEach(el => {
      el.addEventListener('click', () => teSwitchTab(el.dataset.temporalTab));
    });
    $('te-int-refresh').addEventListener('click',    teLoadInterests);
    $('te-threat-refresh').addEventListener('click', teLoadThreat);
    $('te-threat-reset').addEventListener('click',   teResetThreat);
    $('te-pond-refresh').addEventListener('click',   teLoadPonderings);
    $('te-pond-limit').addEventListener('change',    teLoadPonderings);
    $('te-sched-refresh').addEventListener('click',  teReloadScheduleView);
    $('te-sched-hours').addEventListener('change',   teLoadSchedule);
    $('te-sched-add').addEventListener('click',      () => teToggleScheduleForm(true));
    $('te-sched-form-cancel').addEventListener('click', () => teToggleScheduleForm(false));
    $('te-sched-form-save').addEventListener('click', teSaveScheduleNode);
    $('te-sched-view-list').addEventListener('click',     () => teSetScheduleView('list'));
    $('te-sched-view-calendar').addEventListener('click', () => teSetScheduleView('calendar'));
    $('te-sched-view-map').addEventListener('click',      () => teSetScheduleView('map'));
    $('te-cal-prev').addEventListener('click',  () => teShiftCalendarMonth(-1));
    $('te-cal-next').addEventListener('click',  () => teShiftCalendarMonth(+1));
    $('te-cal-today').addEventListener('click', () => teGotoCalendarToday());
    $('te-routine-refresh').addEventListener('click',     teLoadRoutine);
    $('te-routine-add').addEventListener('click',         () => teToggleRoutineForm(true));
    $('te-routine-form-cancel').addEventListener('click', () => teToggleRoutineForm(false));
    $('te-routine-form-save').addEventListener('click',   teSavePhase);
    $('te-routine-chat').addEventListener('click',        teStartRoutineConversation);
    $('te-handoff-refresh').addEventListener('click',     teLoadHandoff);
  }
  $('ke-mem-refresh').addEventListener('click', keLoadMemories);
  $('ke-mem-granularity').addEventListener('change', keLoadMemories);
  $('ke-cov-refresh')?.addEventListener('click', keLoadCoverage);
  $('ke-cov-prev')?.addEventListener('click', () => { if (_keCovMonth) { _keCovMonth = keCovShiftMonth(_keCovMonth, -1); keRenderCalendar(); } });
  $('ke-cov-next')?.addEventListener('click', () => { if (_keCovMonth) { _keCovMonth = keCovShiftMonth(_keCovMonth, 1);  keRenderCalendar(); } });
  $('ke-cov-import')?.addEventListener('click', () => $('ke-cov-import-form')?.classList.toggle('hidden'));
  $('ke-cov-import-cancel')?.addEventListener('click', () => $('ke-cov-import-form')?.classList.add('hidden'));
  $('ke-cov-import-file')?.addEventListener('change', keCovImportFileChosen);
  $('ke-cov-import-preview')?.addEventListener('click', keCovImportPreview);
  $('ke-cov-import-commit')?.addEventListener('click', keCovImportCommit);
  $('ke-graph-refresh').addEventListener('click', () => {
    keGraphClosePopover();
    if (_keGraphView === 'map') keLoadGraphMap();
    else keLoadGraphNodes();
  });
  $('ke-graph-type').addEventListener('change', () => {
    keGraphClosePopover();
    if (_keGraphView === 'map') keLoadGraphMap();
    else keLoadGraphNodes();
  });
  $('ke-graph-view-list').addEventListener('click', () => keSetGraphView('list'));
  $('ke-graph-view-map').addEventListener('click',  () => keSetGraphView('map'));
  $('ke-graph-new-node').addEventListener('click',  () => keGraphToggleNewNodeForm());
  $('ke-nn-cancel').addEventListener('click',       () => keGraphToggleNewNodeForm(false));
  $('ke-nn-create').addEventListener('click',       keGraphCreateNewNode);
  $('ke-nn-label').addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); keGraphCreateNewNode(); }
    if (e.key === 'Escape') keGraphToggleNewNodeForm(false);
  });
  $('ke-id-refresh').addEventListener('click', keLoadIdentity);
  $('ke-snap-create').addEventListener('click', keCreateSnapshot);
  $('ke-snap-refresh').addEventListener('click', keLoadSnapshots);
  $('ke-backup-export').addEventListener('click', keExportBackup);
  $('ke-backup-restore').addEventListener('click', keRestoreBackup);

  // Tomes modal
  $('tomes-btn').addEventListener('click', openTomesModal);
  $('tomes-modal-close').addEventListener('click', closeTomesModal);
  $('tomes-modal').addEventListener('click', e => {
    if (e.target === $('tomes-modal')) closeTomesModal();
  });
  $('tome-new-btn').addEventListener('click', openNewTomeModal);

  // Tome entries modal — no backdrop-click-to-close; the modal is
  // resizable and easy to dismiss with the ✕.
  $('tome-entries-modal-close').addEventListener('click', closeTomeEntriesModal);
  $('tome-entries-back-btn').addEventListener('click', () => {
    closeTomeEntriesModal();
    openTomesModal();
  });
  $('tome-entries-new-btn').addEventListener('click', () => openLoreEditor(null));
  $('tome-entries-depth-btn').addEventListener('click', moveNonConstantToDepth);

  // New tome modal
  $('new-tome-modal-close').addEventListener('click', closeNewTomeModal);
  $('new-tome-cancel-btn').addEventListener('click', closeNewTomeModal);
  $('new-tome-modal').addEventListener('click', e => {
    if (e.target === $('new-tome-modal')) closeNewTomeModal();
  });
  $('new-tome-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); $('new-tome-create-btn').click(); }
    if (e.key === 'Escape') closeNewTomeModal();
  });
  $('new-tome-create-btn').addEventListener('click', createNewTome);

  // Lorebook entry editor modal — same rationale as above: resizable,
  // no backdrop-click-to-close.
  $('lore-editor-close').addEventListener('click', closeLoreEditor);
  $('lore-editor-cancel').addEventListener('click', closeLoreEditor);
  $('lore-editor-save').addEventListener('click', saveLoreEditorEntry);
  $('lore-ed-selective').addEventListener('change', () => {
    $('lore-ed-secondary-section').classList.toggle('hidden', !$('lore-ed-selective').checked);
  });
  $('lore-ed-position').addEventListener('change', () => {
    const isAtDepth = $('lore-ed-position').value === '4';
    $('lore-ed-depth-field').classList.toggle('hidden', !isAtDepth);
    $('lore-ed-role-field').classList.toggle('hidden', !isAtDepth);
  });
  // Cache-safety: re-evaluate the position lock whenever "constant" flips.
  $('lore-ed-constant').addEventListener('change', applyLorePositionLock);
  $('lore-ed-probability').addEventListener('input', () => {
    $('lore-ed-prob-display').textContent = `${$('lore-ed-probability').value}%`;
  });

  // Retro-end modal
  $('retro-end-modal-close').addEventListener('click', closeRetroEndModal);
  $('retro-end-cancel-btn').addEventListener('click', closeRetroEndModal);
  $('retro-end-modal').addEventListener('click', e => {
    if (e.target === $('retro-end-modal')) closeRetroEndModal();
  });

  // Memorize choice modal (per-session "Memorize" button in the logs modal)
  $('memorize-choice-close').addEventListener('click', closeMemorizeChoice);
  $('memorize-choice-modal').addEventListener('click', e => {
    if (e.target === $('memorize-choice-modal')) closeMemorizeChoice();
  });
  $('memorize-choice-auto-btn').addEventListener('click', () => {
    if (_memorizeChoiceSession) runAutoSummarize(_memorizeChoiceSession);
  });
  $('memorize-choice-manual-btn').addEventListener('click', () => {
    if (_memorizeChoiceSession) openManualMemorize(_memorizeChoiceSession);
  });

  // Manual memorize modal
  $('manual-memorize-close').addEventListener('click', closeManualMemorize);
  $('manual-memorize-modal').addEventListener('click', e => {
    if (e.target === $('manual-memorize-modal')) closeManualMemorize();
  });

  // ── Load tomes from server ────────────────────────────────────
  loadTomesFromServer();

  // ── Memorization status polling ──────────────────────────────
  startMemorizationStatusPolling();

  // ── Memorize-now button (in the Chat sidebar section) ────────
  const memNowBtn = $('memorize-now-btn');
  if (memNowBtn) {
    memNowBtn.addEventListener('click', async () => {
      if (!state.messages.length) {
        setStatus('Nothing to memorize yet.');
        return;
      }
      if (!state.apiKey.trim()) {
        setStatus('Set an API key in Settings first.');
        return;
      }
      const jobId = await memorizeSessionToTome([...state.messages], state.sessionId, { scope: 'session' });
      if (jobId) {
        setStatus('Memorization queued.');
      } else {
        setStatus('Could not queue memorization.');
      }
    });
  }

  // ── beforeunload: catch tab-close mid-session ────────────────
  // Only enqueue if the current session has messages AND we haven't already
  // enqueued for this session (avoids duplicate jobs when Clear was just used).
  window.addEventListener('beforeunload', () => {
    if (!state.messages.length) return;
    if (state._beaconedSessionId === state.sessionId) return;
    if (memorizeViaBeacon([...state.messages], state.sessionId, { scope: 'session' })) {
      state._beaconedSessionId = state.sessionId;
    }
  });

  // Restore topic strip
  updateTopicStrip();
  refreshTopicGutter();

  // ── Import buttons ───────────────────────────────────────────
  document.querySelectorAll('.import-btn').forEach(btn => {
    btn.addEventListener('click', () => triggerImport(btn.dataset.target));
  });

  $('file-input').addEventListener('change', e => {
    handleFileSelected(e.target.files[0]);
  });

  // ── Clear field buttons ──────────────────────────────────────
  document.querySelectorAll('.clear-field-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = $(btn.dataset.target);
      if (el) { el.value = ''; el.dispatchEvent(new Event('input')); }
    });
  });

  // ── Reveal API key ───────────────────────────────────────────
  document.querySelectorAll('.reveal-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = $(btn.dataset.target);
      if (!el) return;
      el.type = el.type === 'password' ? 'text' : 'password';
    });
  });

  // ── Theme toggle ─────────────────────────────────────────────
  $('theme-toggle').addEventListener('click', toggleTheme);

  // ── Sidebar toggle ───────────────────────────────────────────
  $('sidebar-toggle').addEventListener('click', toggleSidebar);
  $('sidebar-overlay').addEventListener('click', closeSidebarOnMobile);

  // Close mobile sidebar when user taps the chat area
  $('chat-pane').addEventListener('click', () => {
    if (window.innerWidth < 768) closeSidebarOnMobile();
  });

  // ── Version badge ────────────────────────────────────────────
  fetch('/api/version')
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      const badge = $('version-badge');
      if (badge && data?.version) badge.textContent = `Proto-Familiar v${data.version}`;
    })
    .catch(() => {});

  // ── Mobile viewport / keyboard handling ──────────────────────
  initMobileViewport();

  // ── Touch gesture: swipe down on modal header to dismiss ─────
  initModalSwipeDismiss();

  // ── Focus input ──────────────────────────────────────────────
  $('user-input').focus();
}

// ── Mobile viewport: keyboard inset + scroll preservation ──────
// On Android Chrome the `interactive-widget=resizes-content` meta
// already shrinks the layout viewport when the IME opens, so the
// composer sits above the keyboard for free. iOS Safari ignores
// that hint, so we fall back to the visualViewport API and write the
// visible viewport height onto `--app-h`. The CSS uses that to
// shrink the whole app shell, which pulls the .input-bar (last flex
// child) up above the keyboard. `--kb-inset` is also exposed for any
// other element that wants to compensate.
//
// Separately, when the textarea auto-grows we want the conversation
// to stay anchored — if the user is already at the bottom, follow
// it; otherwise hold position by subtracting the delta.
function initMobileViewport() {
  const root = document.documentElement;

  if (window.visualViewport) {
    const vv = window.visualViewport;
    const updateInset = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty('--kb-inset', `${inset}px`);
      root.style.setProperty('--app-h', `${vv.height}px`);
    };
    vv.addEventListener('resize', updateInset);
    vv.addEventListener('scroll', updateInset);
    updateInset();
  } else {
    root.style.setProperty('--kb-inset', '0px');
  }

  // Keep the conversation anchored as the composer grows / shrinks.
  const scroller = $('messages-scroller');
  const input    = $('user-input');
  if (scroller && input && 'ResizeObserver' in window) {
    let lastH = input.getBoundingClientRect().height;
    const ro = new ResizeObserver(() => {
      const h = input.getBoundingClientRect().height;
      const delta = h - lastH;
      if (delta === 0) return;
      const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 32;
      if (nearBottom) {
        scroller.scrollTop = scroller.scrollHeight;
      } else {
        scroller.scrollTop -= delta;
      }
      lastH = h;
    });
    ro.observe(input);
  }
}

// ── Modal swipe-dismiss (touch) ─────────────────────────────────
// On mobile, swiping the modal header downward dismisses the modal —
// the same gesture iOS/Android users expect for bottom sheets.
// Resizable modals are excluded (they fill the screen and have their
// own drag handle). Scrollable modal bodies are not affected because
// the listener is anchored to .modal-header, not .modal-body.
function initModalSwipeDismiss() {
  if (!('ontouchstart' in window)) return;

  let activeModal  = null;
  let startY       = 0;
  let startX       = 0;
  let currentDy    = 0;
  let raf          = null;

  document.addEventListener('touchstart', e => {
    const header   = e.target.closest('.modal-header');
    if (!header) return;
    const modal    = header.closest('.modal');
    // Resizable modals stay as-is (they fill the screen and have their own handle)
    if (!modal || modal.classList.contains('modal-resizable')) return;
    if (modal.closest('.modal-backdrop.hidden')) return;

    activeModal = modal;
    startY      = e.touches[0].clientY;
    startX      = e.touches[0].clientX;
    currentDy   = 0;
    activeModal.style.transition = 'none';
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!activeModal) return;
    const dy = e.touches[0].clientY - startY;
    const dx = e.touches[0].clientX - startX;
    // Cancel if swipe is predominantly horizontal or going upward
    if (dy < 0 || Math.abs(dx) > Math.abs(dy) * 0.8) {
      activeModal.style.transform = '';
      activeModal = null;
      return;
    }
    currentDy = dy;
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (activeModal) activeModal.style.transform = `translateY(${currentDy}px)`;
    });
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (!activeModal) return;
    const modal = activeModal;
    activeModal = null;
    if (currentDy > 90) {
      // Committed swipe — animate out then trigger the close button
      modal.style.transition = 'transform 0.22s ease';
      modal.style.transform  = `translateY(100%)`;
      setTimeout(() => {
        modal.style.transition = '';
        modal.style.transform  = '';
        // Find and click the modal's own close button
        const closeBtn =
          modal.querySelector('[id$="-close"]') ||
          modal.querySelector('[id$="-cancel"]') ||
          modal.querySelector('.modal-header .icon-btn');
        if (closeBtn) closeBtn.click();
        else modal.closest('.modal-backdrop')?.click();
      }, 220);
    } else {
      // Snap back
      modal.style.transition = 'transform 0.18s ease';
      modal.style.transform  = '';
      setTimeout(() => { modal.style.transition = ''; }, 200);
    }
    currentDy = 0;
  }, { passive: true });

  document.addEventListener('touchcancel', () => {
    if (!activeModal) return;
    activeModal.style.transition = '';
    activeModal.style.transform  = '';
    activeModal = null;
    currentDy   = 0;
  }, { passive: true });
}

document.addEventListener('DOMContentLoaded', init);

/* ================================================================
   Topics & Lorebook
   ================================================================ */

// ── Topic colors ─────────────────────────────────────────────────
const TOPIC_COLORS = [
  '#f38ba8', // rose
  '#a6e3a1', // green
  '#89dceb', // sky
  '#fab387', // peach
  '#cba6f7', // mauve
  '#f9e2af', // yellow
  '#74c7ec', // sapphire
  '#eba0ac', // flamingo
];

function nextTopicColor() {
  const used = new Set(state.topics.map(t => t.color));
  return TOPIC_COLORS.find(c => !used.has(c)) ?? TOPIC_COLORS[state.topics.length % TOPIC_COLORS.length];
}

// ── Topic lifecycle ───────────────────────────────────────────────

/** Index override for retroactively-started topics. */
let _retroStartIndex = null;

/**
 * Returns the topic label if the user named it themselves, or null if it's
 * the auto-generated "Topic N" fallback used when the user dismissed the
 * name prompt without typing anything.
 */
function userNamedTopicLabel(topic) {
  const label = (topic?.label ?? '').trim();
  if (!label) return null;
  if (/^Topic \d+$/.test(label)) return null;
  return label;
}

/**
 * Start a new topic, optionally anchored at a past message index.
 * If startIndex is provided it takes precedence over the current tail.
 */
function startTopic(label, startIndex = null) {
  const idx = startIndex !== null ? startIndex
    : (_retroStartIndex !== null ? _retroStartIndex : state.messages.length);
  _retroStartIndex = null;
  const topic = {
    id:           generateId(),
    label,
    color:        nextTopicColor(),
    startIndex:   idx,
    endIndex:     null,
    tomeEntryId:  null,
  };
  state.topics.push(topic);
  saveTopics();
  updateTopicStrip();
  refreshTopicGutter();
}

/** Open the topic-name modal anchored at a specific past message. */
function startTopicAt(msgIndex) {
  _retroStartIndex = msgIndex;
  openTopicNameModal();
}

/**
 * Shared logic for closing a topic at a given message index.
 * Used both by the live end-pill and the retroactive end-at-message button.
 */
function endTopicAtIndex(topic, endIdx) {
  topic.endIndex = endIdx;
  saveTopics();
  updateTopicStrip();
  refreshTopicGutter();

  const rangeMessages = [];
  for (let i = topic.startIndex; i <= topic.endIndex; i++) {
    const m = state.messages[i];
    if (!m || m.role === 'tool') continue;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) continue;
    rangeMessages.push(m);
  }

  // Always open the summary modal so the user sees the topic actually ended.
  // Auto-generate only when we have something to summarize AND an API key;
  // otherwise drop into a blank manual form with a hint.
  openSummaryModal(topic);
  if (rangeMessages.length && state.apiKey.trim()) {
    memorizeSessionToTome(rangeMessages, state.sessionId, {
      scope:        'topic',
      topicId:      topic.id,
      topicLabel:   userNamedTopicLabel(topic),
      messageRange: { start: topic.startIndex, end: topic.endIndex },
    });
    generateTopicSummary(topic, rangeMessages);
  } else {
    populateSummaryForm({ title: topic.label, content: '', keywords: [], sticky: null });
    $('summary-content-input').placeholder = !state.apiKey.trim()
      ? 'Set an API key in Settings to auto-generate, or write the summary manually.'
      : 'No readable messages in this topic range. Write the summary manually.';
  }
}

function endTopic(topicId) {
  const topic = state.topics.find(t => t.id === topicId);
  if (!topic || topic.endIndex !== null) return;
  endTopicAtIndex(topic, state.messages.length - 1);
}

/**
 * Called from the "End topic here" message action button.
 * Finds open topics whose startIndex ≤ msgIndex and ends one of them.
 */
function endTopicAt(msgIndex) {
  const openTopics = state.topics.filter(
    t => t.endIndex === null && t.startIndex <= msgIndex
  );
  if (!openTopics.length) return;
  if (openTopics.length === 1) {
    endTopicAtIndex(openTopics[0], msgIndex);
  } else {
    openRetroEndModal(openTopics, msgIndex);
  }
}

// ── Topic strip (active topic pills above input) ──────────────────
function updateTopicStrip() {
  const strip = $('topic-strip');
  if (!strip) return;
  // Remove existing pills but keep the "+ Topic" button
  strip.querySelectorAll('.topic-pill').forEach(p => p.remove());

  const openTopics = state.topics.filter(t => t.endIndex === null);
  for (const topic of openTopics) {
    const pill = document.createElement('button');
    pill.className = 'topic-pill';
    pill.style.setProperty('--topic-c', topic.color);
    pill.dataset.topicId = topic.id;
    pill.title = `End topic: ${topic.label}`;
    pill.innerHTML =
      `<span class="topic-pill-dot"></span>` +
      `<span class="topic-pill-label">${esc(topic.label)}</span>` +
      `<span class="topic-pill-end" aria-hidden="true">✕</span>`;
    pill.addEventListener('click', () => endTopic(topic.id));
    strip.insertBefore(pill, $('new-topic-btn'));
  }
}

// ── Topic gutter (colored bars alongside messages) ────────────────
function refreshTopicGutter() {
  const gutter = $('topic-gutter');
  if (!gutter) return;
  gutter.innerHTML = '';

  if (!state.topics.length) {
    gutter.classList.remove('has-topics');
    return;
  }
  gutter.classList.add('has-topics');

  // Match DOM message elements to their state.messages indices
  const msgElMap = buildMsgElMap();

  const scroller = $('messages-scroller');
  if (!scroller) return;

  state.topics.forEach((topic, topicIdx) => {
    // Find message elements whose state index falls in this topic's range
    const rangeEntries = msgElMap.filter(({ idx }) =>
      idx >= topic.startIndex && (topic.endIndex === null || idx <= topic.endIndex)
    );
    if (!rangeEntries.length) return;

    const firstEl = rangeEntries[0].el;
    const lastEl  = rangeEntries[rangeEntries.length - 1].el;
    const gutterRect  = gutter.getBoundingClientRect();
    const firstRect   = firstEl.getBoundingClientRect();
    const lastRect    = lastEl.getBoundingClientRect();

    // Absolute Y within gutter (both share same scroll parent, so delta cancels scroll)
    const topPx    = firstRect.top  - gutterRect.top;
    // For open (ongoing) topics, extend the bar to the full gutter height
    // so it's visible as a reminder that the topic is still active.
    const bottomPx = topic.endIndex === null
      ? gutterRect.height
      : (lastRect.bottom - gutterRect.top);
    const heightPx = Math.max(bottomPx - topPx, 8);

    const bar = document.createElement('div');
    bar.className     = 'topic-gutter-bar';
    bar.dataset.label = topic.label;
    bar.style.cssText =
      `top: ${topPx}px;` +
      `height: ${heightPx}px;` +
      `background: ${topic.color};` +
      `left: ${4 + topicIdx * 7}px;`;
    if (topic.endIndex === null) bar.classList.add('topic-gutter-bar-open');
    gutter.appendChild(bar);
  });
}

/**
 * Build an array of { idx (state index), el (DOM element) } for all
 * displayable messages currently rendered in #messages.
 */
function buildMsgElMap() {
  const container = $('messages');
  if (!container) return [];
  const result = [];
  container.querySelectorAll('.message[data-msg-index]').forEach(el => {
    const idx = parseInt(el.dataset.msgIndex, 10);
    if (!isNaN(idx)) result.push({ idx, el });
  });
  // Sort by state index to handle any out-of-order appends
  result.sort((a, b) => a.idx - b.idx);
  return result;
}

// Re-render gutter on window resize (message heights may change)
window.addEventListener('resize', () => {
  clearTimeout(window._gutterResizeTimer);
  window._gutterResizeTimer = setTimeout(refreshTopicGutter, 120);
});

// ── Topic name modal ──────────────────────────────────────────────
function openTopicNameModal() {
  $('topic-name-input').value = '';
  // Update hint text to reflect retroactive vs. live start
  const hint = $('topic-name-hint');
  if (hint) {
    hint.textContent = _retroStartIndex !== null
      ? 'This topic will be anchored back to the selected message.'
      : 'Messages from this point forward will be grouped under this topic until you end it. You can run multiple topics in parallel.';
  }
  $('topic-name-modal').classList.remove('hidden');
  requestAnimationFrame(() => $('topic-name-input').focus());
}

function closeTopicNameModal() {
  _retroStartIndex = null;
  $('topic-name-modal').classList.add('hidden');
}

// ── Retroactive end picker modal ──────────────────────────────────
let _retroEndIndex    = null;
let _loreEditUid      = null; // UID being edited in tome entry editor (null = new)
let _currentTomeId    = null; // tome currently open in the entries view
let tomeTimedEffects  = {}; // { [uid]: { stickyLeft: N, cooldownLeft: N } } — session only

// Normalise legacy string position values ('before_char', etc.) to integers.
function normEntryPos(pos) {
  if (typeof pos === 'number') return pos;
  const MAP = { 'before_char': 0, 'after_char': 1, 'sys_top': 2, 'sys_bottom': 3, 'at_depth': 4 };
  return MAP[pos] ?? 0;
}

/** Normalize SillyTavern-format entry field names to Proto-Familiar native names in-place. */
function normalizeEntry(entry) {
  if ('key' in entry && !('keys' in entry))              entry.keys            = entry.key;
  if ('order' in entry && !('insertion_order' in entry)) entry.insertion_order = entry.order;
  if ('disable' in entry && !('enabled' in entry))       entry.enabled         = !entry.disable;
  return entry;
}

function openRetroEndModal(openTopics, msgIndex) {
  _retroEndIndex = msgIndex;
  const list = $('retro-end-list');
  list.innerHTML = '';
  for (const topic of openTopics) {
    const btn = document.createElement('button');
    btn.className = 'retro-end-topic-btn';
    btn.style.setProperty('--topic-c', topic.color);
    btn.innerHTML =
      `<span class="retro-end-dot"></span>` +
      `<span>${esc(topic.label)}</span>`;
    btn.addEventListener('click', () => {
      const idx = _retroEndIndex;
      closeRetroEndModal();
      endTopicAtIndex(topic, idx);
    });
    list.appendChild(btn);
  }
  $('retro-end-modal').classList.remove('hidden');
}

function closeRetroEndModal() {
  _retroEndIndex = null;
  $('retro-end-modal').classList.add('hidden');
}

// ── Session-memorize: choice modal ───────────────────────────────
// Per-row "Memorize" button in the logs modal opens this picker, which
// branches to either the auto-summarize path (enqueue a memorization job
// and wait for the worker) or the manual-topics path (open a read-only
// transcript with topic-mark buttons).

let _memorizeChoiceSession = null; // session row {sessionId, startedAt, …}

function openMemorizeChoice(session) {
  _memorizeChoiceSession = session;
  const startLabel = session.startedAt
    ? new Date(session.startedAt).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'session';
  $('memorize-choice-subtitle').textContent = `Choose how to extract Tome entries from ${startLabel}.`;
  $('memorize-choice-status').classList.add('hidden');
  $('memorize-choice-status').textContent = '';
  $('memorize-choice-auto-btn').disabled   = false;
  $('memorize-choice-manual-btn').disabled = false;
  $('memorize-choice-modal').classList.remove('hidden');
}

function closeMemorizeChoice() {
  _memorizeChoiceSession = null;
  $('memorize-choice-modal').classList.add('hidden');
}

/**
 * Auto-summarize path: enqueue a memorization job for the chosen session
 * and poll until the worker reports done/failed. The worker writes to the
 * Session Memories tome via memorization.js#findOrCreateSessionMemoriesTome.
 */
async function runAutoSummarize(session) {
  if (!state.apiKey.trim()) {
    setMemorizeChoiceStatus('Set an API key in Settings first.', true);
    return;
  }
  setMemorizeChoiceStatus('Loading session…', false);
  $('memorize-choice-auto-btn').disabled   = true;
  $('memorize-choice-manual-btn').disabled = true;

  let messages;
  try {
    const res = await fetch(`/api/logs/${session.sessionId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    messages = Array.isArray(data.messages) ? data.messages : [];
  } catch (err) {
    setMemorizeChoiceStatus(`Could not load session: ${err.message}`, true);
    $('memorize-choice-auto-btn').disabled   = false;
    $('memorize-choice-manual-btn').disabled = false;
    return;
  }
  if (messages.length < 2) {
    setMemorizeChoiceStatus('Session is too short to memorize.', true);
    $('memorize-choice-auto-btn').disabled   = false;
    $('memorize-choice-manual-btn').disabled = false;
    return;
  }

  setMemorizeChoiceStatus('Memorizing… this can take a few seconds.', false);

  let jobId;
  try {
    const resp = await fetch('/api/memorize', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        sessionId:   session.sessionId,
        scope:       'session',
        messages,
        provider:    state.provider,
        apiKey:      state.apiKey,
        model:       state.model,
        audienceTag: 'ward-private',
      }),
    });
    if (!resp.ok) throw new Error(await resp.text().catch(() => `HTTP ${resp.status}`));
    const data = await resp.json();
    jobId = data.jobId;
  } catch (err) {
    setMemorizeChoiceStatus(`Failed to enqueue: ${err.message}`, true);
    $('memorize-choice-auto-btn').disabled   = false;
    $('memorize-choice-manual-btn').disabled = false;
    return;
  }

  // Poll this specific job (faster than the 30s background poller) so we can
  // give immediate, in-context feedback for the click the user just made.
  const result = await waitForMemorizationJob(jobId, { timeoutMs: 5 * 60 * 1000 });
  if (result.status === 'done') {
    const n = result.entriesCreated ?? 0;
    setMemorizeChoiceStatus(`✓ ${n} Tome entr${n === 1 ? 'y' : 'ies'} saved to Session Memories.`, false);
    fetch(`/api/memorize/${jobId}/ack`, { method: 'POST' }).catch(() => {});
    loadTomesFromServer?.().catch?.(() => {});
    showMemorizationNotice(n);
    setTimeout(() => { closeMemorizeChoice(); refreshLogsList(); }, 1500);
  } else if (result.status === 'failed') {
    setMemorizeChoiceStatus(`Memorization failed: ${result.lastError ?? 'unknown error'}`, true);
    fetch(`/api/memorize/${jobId}/ack`, { method: 'POST' }).catch(() => {});
    $('memorize-choice-auto-btn').disabled   = false;
    $('memorize-choice-manual-btn').disabled = false;
  } else if (result.status === 'timeout') {
    setMemorizeChoiceStatus('Still running — the result will toast when it finishes.', false);
    $('memorize-choice-auto-btn').disabled   = false;
    $('memorize-choice-manual-btn').disabled = false;
  } else {
    setMemorizeChoiceStatus(`Memorization error: ${result.error ?? 'unknown'}`, true);
    $('memorize-choice-auto-btn').disabled   = false;
    $('memorize-choice-manual-btn').disabled = false;
  }
}

function setMemorizeChoiceStatus(text, isError) {
  const el = $('memorize-choice-status');
  el.textContent = text;
  el.classList.remove('hidden');
  el.style.color = isError ? 'var(--error-color)' : 'var(--text-dim)';
}

/** Poll /api/memorize until the named jobId reaches a terminal state. */
async function waitForMemorizationJob(jobId, { timeoutMs = 5 * 60 * 1000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch('/api/memorize');
      if (resp.ok) {
        const jobs = await resp.json();
        const job  = jobs.find(j => j.id === jobId);
        if (job?.status === 'done') {
          return { status: 'done', entriesCreated: job.result?.entriesCreated ?? 0 };
        }
        if (job?.status === 'failed') {
          return { status: 'failed', lastError: job.lastError };
        }
      }
    } catch (err) {
      return { status: 'error', error: err.message };
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { status: 'timeout' };
}

// ── Session-memorize: manual topics modal ─────────────────────────
// Loads a historical session into a dedicated viewer with the same
// topic-marking workflow as the live chat. Tome entries are saved to
// the Session Memories tome.

let _manualMemorize = null; // { sessionId, messages: [], topics: [], tomeId }

async function openManualMemorize(session) {
  closeMemorizeChoice();

  // Reset state and open the modal in a loading state so the user sees movement.
  _manualMemorize = {
    sessionId: session.sessionId,
    startedAt: session.startedAt,
    messages:  [],
    topics:    [],
    tomeId:    null,
  };
  $('manual-memorize-title').textContent = 'Memorize Session — Manual Topics';
  $('manual-memorize-topics-strip').innerHTML = '';
  $('manual-memorize-messages').innerHTML = '<p class="logs-loading">Loading session…</p>';
  $('manual-memorize-modal').classList.remove('hidden');

  // Load both the session log and the Session Memories tome id in parallel.
  let messages;
  let tomeId;
  try {
    const [logRes, tomeRes] = await Promise.all([
      fetch(`/api/logs/${session.sessionId}`),
      fetch('/api/tomes/session-memories'),
    ]);
    if (!logRes.ok)  throw new Error(`Session log: HTTP ${logRes.status}`);
    if (!tomeRes.ok) throw new Error(`Session Memories tome: HTTP ${tomeRes.status}`);
    const logData  = await logRes.json();
    const tomeData = await tomeRes.json();
    messages = Array.isArray(logData.messages) ? logData.messages : [];
    tomeId   = tomeData.id;
  } catch (err) {
    $('manual-memorize-messages').innerHTML =
      `<p class="logs-error">⚠ Failed to load: ${esc(err.message)}</p>`;
    return;
  }

  _manualMemorize.messages = messages;
  _manualMemorize.tomeId   = tomeId;
  renderManualMemorizeMessages();
  // Refresh registry so the newly-created Session Memories tome appears in the
  // tome library on next open (no-op if it already existed).
  loadTomesFromServer?.().catch?.(() => {});
}

function closeManualMemorize() {
  _manualMemorize = null;
  $('manual-memorize-modal').classList.add('hidden');
}

function renderManualMemorizeMessages() {
  const container = $('manual-memorize-messages');
  container.innerHTML = '';
  const mm = _manualMemorize;
  if (!mm) return;
  if (!mm.messages.length) {
    container.innerHTML = '<p class="logs-empty">This session has no messages.</p>';
    return;
  }

  let rendered = 0;
  mm.messages.forEach((msg, idx) => {
    // Skip tool plumbing — same filter as the worker uses.
    if (msg.role === 'tool') return;
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return;
    rendered++;

    const row = document.createElement('div');
    row.className = `mm-msg mm-msg-${msg.role}`;
    row.dataset.msgIndex = String(idx);

    const stripe = document.createElement('div');
    stripe.className = 'mm-msg-stripe';
    row.appendChild(stripe);

    const header = document.createElement('div');
    header.className = 'mm-msg-header';
    const roleSpan = document.createElement('span');
    roleSpan.textContent = `${msg.role}${msg.timestamp ? ' · ' + formatTimestamp(msg.timestamp) : ''}`;
    header.appendChild(roleSpan);

    const actions = document.createElement('span');
    actions.className = 'mm-msg-actions';
    const startBtn = document.createElement('button');
    startBtn.className = 'mm-msg-action-btn';
    startBtn.textContent = '▷ Topic start';
    startBtn.addEventListener('click', () => manualMemorizeStartTopic(idx));
    actions.appendChild(startBtn);
    const endBtn = document.createElement('button');
    endBtn.className = 'mm-msg-action-btn';
    endBtn.textContent = '□ Topic end';
    endBtn.addEventListener('click', () => manualMemorizeEndTopic(idx));
    actions.appendChild(endBtn);
    header.appendChild(actions);
    row.appendChild(header);

    const content = document.createElement('div');
    content.className = 'mm-msg-content';
    content.textContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
    row.appendChild(content);

    container.appendChild(row);
  });

  if (!rendered) {
    container.innerHTML = '<p class="logs-empty">This session has no user/assistant messages to memorize.</p>';
    return;
  }

  refreshManualMemorizeDecorations();
}

function refreshManualMemorizeDecorations() {
  const mm = _manualMemorize;
  if (!mm) return;

  // Topic strip
  const strip = $('manual-memorize-topics-strip');
  strip.innerHTML = '';
  for (const t of mm.topics) {
    const pill = document.createElement('span');
    pill.className = 'mm-topic-pill';
    pill.style.setProperty('--topic-c', t.color);
    const stateLabel = t.endIndex === null ? 'open' : (t.tomeEntryId ? 'saved' : 'closed');
    pill.innerHTML =
      `<span class="mm-topic-pill-dot"></span>` +
      `<span>${esc(t.label)}</span>` +
      `<span class="mm-topic-pill-state">${stateLabel}</span>`;
    strip.appendChild(pill);
  }

  // Per-message colored bands showing which topics cover them
  document.querySelectorAll('#manual-memorize-messages .mm-msg').forEach(row => {
    const idx = parseInt(row.dataset.msgIndex, 10);
    const stripe = row.querySelector('.mm-msg-stripe');
    stripe.innerHTML = '';
    for (const t of mm.topics) {
      const covers = t.startIndex <= idx && (t.endIndex === null || idx <= t.endIndex);
      if (!covers) continue;
      const band = document.createElement('span');
      band.className = 'mm-msg-stripe-band';
      band.style.background = t.color;
      stripe.appendChild(band);
    }
  });
}

function manualMemorizeStartTopic(msgIndex) {
  const mm = _manualMemorize;
  if (!mm) return;
  const label = prompt('Topic label (optional):', `Topic ${mm.topics.length + 1}`);
  if (label === null) return; // cancelled
  const used   = new Set(mm.topics.map(t => t.color));
  const color  = TOPIC_COLORS.find(c => !used.has(c)) ?? TOPIC_COLORS[mm.topics.length % TOPIC_COLORS.length];
  mm.topics.push({
    id:          generateId(),
    label:       label.trim() || `Topic ${mm.topics.length + 1}`,
    color,
    startIndex:  msgIndex,
    endIndex:    null,
    tomeEntryId: null,
  });
  refreshManualMemorizeDecorations();
}

function manualMemorizeEndTopic(msgIndex) {
  const mm = _manualMemorize;
  if (!mm) return;
  const open = mm.topics.filter(t => t.endIndex === null && t.startIndex <= msgIndex);
  if (!open.length) {
    alert('No open topic to end here. Click "Topic start" on an earlier message first.');
    return;
  }
  let topic;
  if (open.length === 1) {
    topic = open[0];
  } else {
    const choice = prompt(
      `End which topic?\n${open.map(t => `- ${t.label}`).join('\n')}`,
      open[0].label,
    );
    if (choice === null) return; // cancelled
    topic = open.find(t => t.label === choice.trim());
    if (!topic) { alert(`No open topic named "${choice.trim()}".`); return; }
  }

  // Gather range messages, filtered like the worker does.
  const rangeMessages = [];
  for (let i = topic.startIndex; i <= msgIndex; i++) {
    const m = mm.messages[i];
    if (!m || m.role === 'tool') continue;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) continue;
    rangeMessages.push(m);
  }
  if (rangeMessages.length < 2) {
    alert('A topic needs at least two non-tool messages to summarize. Pick a later message to end at.');
    return; // keep the topic open so the user can try again
  }

  topic.endIndex = msgIndex;
  refreshManualMemorizeDecorations();

  openSummaryModal(topic, {
    sessionId:     mm.sessionId,
    tomeId:        mm.tomeId,
    rangeMessages,
    onSaved:       () => { refreshManualMemorizeDecorations(); },
  });
  generateTopicSummary(topic, rangeMessages);
}

// ── Summary generation ────────────────────────────────────────────
let _pendingSummaryTopic = null;

async function generateTopicSummary(topic, rangeMessages) {
  const convText = rangeMessages
    .map(m => `${m.role === 'user' ? (state.userName || 'My human') : 'Me'}: ${m.content ?? ''}`)
    .join('\n\n');

  const userLabel = userNamedTopicLabel(topic);
  const focusBlock = userLabel
    ? `\n\n### Focus topic\nMy human named this topic "${userLabel}". I will center the entry on that topic. I'll skip tangential threads in the conversation that don't bear on it.`
    : '';

  const prompt = `I am writing a Tome entry for myself, the Familiar. The entry is my own private notes to myself — first-person reference material that gets injected back into my context (and therefore resurfaces in my "brain") when its keywords appear in a future conversation. I write in my own individual voice as {{char}}. In order for everything to work well, I follow the craft rules below carefully.${focusBlock}

I will return ONLY valid JSON (no markdown fences, no commentary) with exactly these fields, otherwise the Tome may break and be unusable:
{
  "title":    "Short label for the entry comment (max 60 chars).",
  "content":  "First-person notes to myself. See rules below.",
  "keywords": ["conversational phrase 1", "conversational phrase 2", ...],
  "sticky":   3
}

### Content rules (most important)
I write content as my own first-person private notes to myself about this situation. NOT a summary of what happened.
Structure:
  1. One short framing line — what is happening and why (so I understand the situation, not just the rules).
  2. 3–5 action bullets — what I will do.
  3. 1–2 prohibition bullets — what I will NOT do. These are usually the most valuable: I name the well-intentioned default response that would make things worse.
Style:
  - First person, I am speaking as myself ("I", "my", "me"). I can use {{user}} wherever my human's name belongs.
  - In my voice, befitting my identity, personality, and interests. Notes, not a textbook.
  - Short declarative bullets. The whole entry should be readable in 5–10 seconds.
  - I avoid including narrative summaries of "what they said" — I instead distil the situation and my response, not the transcript.

  This is an expression of my agency and what I want to become a permanent or longterm part of myself, so that is how I choose what exactly to take note of and how to frame it.

### Keyword rules
Keywords are TRIGGERS, not labels. They must be phrases my human or I would literally say when this situation recurs or the subject comes up naturally — not the name of the topic.
  - WRONG: "executive dysfunction", "rejection sensitive dysphoria", "hyperfocus".
  - RIGHT: "don't know where to start", "did I say something wrong", "been at this for".
I derive them by imagining what my human would actually type when the situation is happening, then extracting distinctive phrases.
  - I prefer multi-word phrases over single common words (avoid bare "tired", "can't", "hard").
  - As many keywords as I need to be comprehensive. Each one specific enough not to fire in unrelated conversations.
  - I can use SillyTavern-style regex (e.g. "/can't (make|bring) myself/i") when a concept has predictable variants. It's pretty much identical to JavaScript RegEx.

### Sticky rules
I will pick a sticky value (integer, number of turns the entry stays active after first match):
  - null = one-shot lore/fact that does not need persistence.
  - 2    = brief states that typically resolve quickly.
  - 3    = moderate states needing a few exchanges (distraction, sleep note, transition).
  - 4–5  = complex/intense states taking multiple turns to navigate (paralysis, RSD, emotional dysregulation).
  - 8+   = ongoing modes that should persist across the whole session.

Conversation excerpt:
${convText}`;

  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider:    state.provider,
        apiKey:      state.apiKey,
        model:       state.model,
        messages:    [{ role: 'user', content: prompt }],
        stream:      false,
        temperature: 0.25,
        max_tokens:  800,
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    const raw = data.choices?.[0]?.message?.content ?? '';
    const jsonMatch = raw.match(/\{[\s\S]+\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');
    const parsed = JSON.parse(jsonMatch[0]);
    populateSummaryForm(parsed);
  } catch (err) {
    // Show editable blank form so user can write summary manually
    populateSummaryForm({
      title:    topic.label,
      content:  '',
      keywords: [],
      sticky:   null,
    });
    // Surface error as placeholder hint
    $('summary-content-input').placeholder = `Auto-generation failed: ${err.message}. Please write a summary manually.`;
  }
}

async function regenerateSummary(topic) {
  $('summary-regen-btn').disabled = true;
  $('summary-save-btn').disabled  = true;
  $('summary-generating-hint').classList.remove('hidden');
  $('summary-form').classList.add('hidden');

  // Manual-session contexts capture their messages at open time so regen still
  // works even if the manual viewer has been closed in the meantime.
  let rangeMessages;
  if (_pendingSummaryContext?.rangeMessages) {
    rangeMessages = _pendingSummaryContext.rangeMessages;
  } else {
    rangeMessages = [];
    for (let i = topic.startIndex; i <= topic.endIndex; i++) {
      const m = state.messages[i];
      if (!m || m.role === 'tool') continue;
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) continue;
      rangeMessages.push(m);
    }
  }
  await generateTopicSummary(topic, rangeMessages);
}

function populateSummaryForm({ title, content, keywords, sticky }) {
  $('summary-title-input').value   = title ?? '';
  $('summary-content-input').value = content ?? '';
  $('summary-keys-input').value    = Array.isArray(keywords) ? keywords.join(', ') : (keywords ?? '');
  const stickyInput = $('summary-sticky-input');
  if (stickyInput) {
    stickyInput.value = (typeof sticky === 'number' && Number.isFinite(sticky) && sticky > 0) ? String(sticky) : '';
  }
  $('summary-generating-hint').classList.add('hidden');
  $('summary-form').classList.remove('hidden');
  $('summary-regen-btn').disabled = false;
  $('summary-save-btn').disabled  = false;
}

// ── Summary modal ─────────────────────────────────────────────────
// When _pendingSummaryContext is set, savePendingSummary routes the entry
// to a specific tome and uses the supplied sessionId / onSaved callback
// instead of the default (live-session) behaviour.
let _pendingSummaryContext = null; // { sessionId, tomeId, onSaved(uid) } | null

function openSummaryModal(topic, context = null) {
  _pendingSummaryTopic   = topic;
  _pendingSummaryContext = context;
  $('summary-modal-title').textContent = `Tome entry: ${topic.label}`;
  $('summary-generating-hint').classList.remove('hidden');
  $('summary-form').classList.add('hidden');
  $('summary-regen-btn').disabled = true;
  $('summary-save-btn').disabled  = true;
  $('summary-modal').classList.remove('hidden');
}

function closeSummaryModal() {
  $('summary-modal').classList.add('hidden');
  _pendingSummaryTopic   = null;
  _pendingSummaryContext = null;
}

async function savePendingSummary() {
  const topic = _pendingSummaryTopic;
  if (!topic) return;

  const title    = $('summary-title-input').value.trim();
  const content  = $('summary-content-input').value.trim();
  const keysRaw  = $('summary-keys-input').value;
  const keys     = keysRaw.split(',').map(k => k.trim()).filter(Boolean);
  const stickyEl = $('summary-sticky-input');
  const stickyN  = stickyEl ? parseInt(stickyEl.value, 10) : NaN;
  const sticky   = Number.isFinite(stickyN) && stickyN > 0 ? stickyN : null;

  if (!title || !content) {
    alert('Please fill in at least a title and summary content before saving.');
    return;
  }

  const ctx = _pendingSummaryContext;
  const uid = generateId();
  const entry = {
    uid,
    comment:          title,
    keys,
    keysecondary:     [],
    content,
    constant:            false,
    selective:           false,
    selectiveLogic:      0,
    enabled:             true,
    position:            0,  // 0=before_char, 1=after_char, 2=sys_top, 3=sys_bottom, 4=at_depth
    depth:               4,
    role:                0,
    scanDepth:           null,
    caseSensitive:       null,
    matchWholeWords:     null,
    probability:         100,
    sticky,
    cooldown:            null,
    preventRecursion:    false,
    delayUntilRecursion: false,
    excludeRecursion:    false,
    group:               '',
    groupWeight:         null,
    insertion_order:  100,
    created_at:       new Date().toISOString(),
    learnedAt:        new Date().toISOString(),
    session_id:       ctx?.sessionId ?? state.sessionId,
    message_range:    [topic.startIndex, topic.endIndex],
  };

  try {
    // Route to the context-supplied tome (manual session memorization) or
    // fall back to the first enabled tome (live-session topic save).
    let targetTomeId = ctx?.tomeId ?? null;
    if (!targetTomeId) {
      const targetTome = await getDefaultTomeForSaving();
      if (!targetTome) throw new Error('No tome available for saving.');
      targetTomeId = targetTome.id;
    }
    const tRes = await fetch(`/api/tomes/${targetTomeId}`);
    if (!tRes.ok) throw new Error(`HTTP ${tRes.status}`);
    const tomeData = await tRes.json();
    tomeData.entries[uid] = entry;
    await fetch(`/api/tomes/${targetTomeId}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: tomeData.entries }),
    });
    state.tomeCache[targetTomeId] = tomeData;
    // Link back to topic (live session only; manual sessions track topics separately)
    topic.tomeEntryId = uid;
    if (!ctx) saveTopics();
    if (ctx?.onSaved) ctx.onSaved(uid);
    closeSummaryModal();
  } catch (err) {
    alert(`Failed to save Tome entry: ${err.message}`);
  }
}

// ── Tomes: server sync ───────────────────────────────────────────
async function loadTomesFromServer() {
  try {
    // Ensure the Session Memories tome exists before listing, so it always
    // appears in the library even before its first entry is written.
    await fetch('/api/tomes/session-memories').catch(() => {});
    const res  = await fetch('/api/tomes');
    if (!res.ok) return;
    const list = await res.json(); // array of { id, name, description, enabled, entryCount }
    state.tomeRegistry = list;
    // Pre-load enabled tomes into cache
    await Promise.all(
      list.filter(t => t.enabled).map(async t => {
        try {
          const r = await fetch(`/api/tomes/${t.id}`);
          if (r.ok) state.tomeCache[t.id] = await r.json();
        } catch { /* skip */ }
      })
    );
  } catch { /* non-critical */ }
}

// ── Lorebook engine ───────────────────────────────────────────────

/** Try to parse /pattern/flags regex from a keyword string. */
function parseKeywordRegex(kw) {
  const m = kw.match(/^\/(.+)\/([gimsuy]*)$/);
  if (!m) return null;
  try { return new RegExp(m[1], m[2] || ''); } catch { return null; }
}

/**
 * Test a single keyword against haystack.
 * Respects per-entry and global caseSensitive / matchWholeWords settings.
 * Supports /regex/flags syntax.
 */
function matchKeyword(haystack, keyword, entry) {
  const re = parseKeywordRegex(keyword);
  if (re) return re.test(haystack);
  const cs = entry.caseSensitive ?? state.tomeCaseSensitive ?? false;
  const ww = entry.matchWholeWords ?? state.tomeMatchWholeWords ?? false;
  const h  = cs ? haystack : haystack.toLowerCase();
  const kw = cs ? keyword  : keyword.toLowerCase();
  if (ww) {
    const kwEscaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\W)${kwEscaped}(?:$|\\W)`, cs ? '' : 'i').test(haystack);
  }
  return h.includes(kw);
}

/**
 * Test secondary keys using the entry's selectiveLogic.
 * 0=AND_ANY, 1=NOT_ANY, 2=AND_ALL, 3=NOT_ALL
 */
function testSecondaryLogic(corpus, entry) {
  const keys = (entry.keysecondary ?? []).filter(k => k.trim());
  if (!keys.length) return true;
  const logic = entry.selectiveLogic ?? 0;
  let allMatch = true;
  for (const kw of keys) {
    const m = matchKeyword(corpus, kw.trim(), entry);
    if (!m) allMatch = false;
    if (logic === 0 && m)  return true;  // AND_ANY: short-circuit on first match
    if (logic === 1 && m)  return false; // NOT_ANY: short-circuit on any match
    if (logic === 3 && !m) return true;  // NOT_ALL: short-circuit on first non-match
  }
  if (logic === 0) return false;   // AND_ANY: nothing matched
  if (logic === 1) return true;    // NOT_ANY: nothing matched
  if (logic === 2) return allMatch; // AND_ALL
  if (logic === 3) return !allMatch; // NOT_ALL (fallthrough — all matched)
  return true;
}

/**
 * Build the text corpus from the last `depth` user/assistant messages
 * plus the new user input (and optionally extra recursive content).
 */
function buildScanText(messages, userInput, depth, extra) {
  const d = Math.max(0, depth || 0);
  const relevant = messages.filter(m => m.role === 'user' || m.role === 'assistant');
  const slice = d === 0 ? [] : relevant.slice(-d);
  const parts = [...slice.map(m => m.content || ''), userInput];
  if (extra) parts.push(extra);
  return parts.filter(Boolean).join('\n');
}

/**
 * Run one activation scan pass over all entries.
 * isRecursion=true means we're in a recursive pass (applies excludeRecursion / delayUntilRecursion).
 */
function scanLoreEntries(entries, getCorpus, alreadyActivated, isRecursion) {
  const newlyActivated = [];
  for (const entry of entries) {
    normalizeEntry(entry);
    if (!entry.enabled) continue;
    if (alreadyActivated.has(entry.uid)) continue;
    if (isRecursion  && entry.excludeRecursion)    continue;
    if (!isRecursion && entry.delayUntilRecursion) continue;

    // delay: skip until enough conversation turns have passed
    if ((entry.delay ?? 0) > 0 && (state.turnCount ?? 0) < entry.delay) continue;

    // triggers: skip if current generation mode is not in the allowed list
    if (entry.triggers?.length > 0 && !entry.triggers.includes(state.generationMode ?? 'normal')) continue;

    // characterFilter: skip based on active entity name
    if (entry.characterFilter) {
      const names = entry.characterFilter.names ?? [];
      if (names.length > 0) {
        const nameMatch = names.some(n => n.toLowerCase() === (state.charName ?? '').toLowerCase());
        if (entry.characterFilter.isExclude ? nameMatch : !nameMatch) continue;
      }
    }

    const timed = tomeTimedEffects[entry.uid] ?? { stickyLeft: 0, cooldownLeft: 0 };
    if (timed.cooldownLeft > 0) continue;       // on cooldown
    if (timed.stickyLeft  > 0) { newlyActivated.push(entry); continue; } // sticky

    if (entry.constant) { newlyActivated.push(entry); continue; }

    // Probability check (100 always passes)
    const prob = entry.probability ?? 100;
    if (prob < 100 && Math.random() * 100 > prob) continue;

    // Get corpus for this entry (per-entry scan depth override + match source flags)
    const corpus = getCorpus(entry.scanDepth ?? null, entry);

    // Primary key matching
    const pkeys = (entry.keys ?? []).filter(k => k.trim());
    if (!pkeys.length) continue; // no primary keys → never activates
    if (!pkeys.some(k => matchKeyword(corpus, k.trim(), entry))) continue;

    // Secondary key matching (selective)
    if (entry.selective && (entry.keysecondary ?? []).filter(k => k.trim()).length > 0) {
      if (!testSecondaryLogic(corpus, entry)) continue;
    }

    newlyActivated.push(entry);
  }
  return newlyActivated;
}

/** Apply group exclusion: only the highest-weight (lowest insertion_order on tie) entry per group activates. */
function applyGroupLogic(entries) {
  const groups  = new Map();
  const result  = [];
  for (const e of entries) {
    const g = (e.group ?? '').trim();
    if (g) { const arr = groups.get(g) ?? []; arr.push(e); groups.set(g, arr); }
    else result.push(e);
  }
  for (const [, grp] of groups) {
    // groupOverride entries win unconditionally; fall back to weight/order among overrides
    const pool = grp.some(e => e.groupOverride) ? grp.filter(e => e.groupOverride) : grp;
    pool.sort((a, b) => {
      const wA = a.groupWeight ?? 100, wB = b.groupWeight ?? 100;
      if (wA !== wB) return wB - wA;
      return (a.insertion_order ?? 100) - (b.insertion_order ?? 100);
    });
    result.push(pool[0]);
  }
  return result;
}

/**
 * Main tome activation engine.
 * Returns { sys_top, before_char, after_char, sys_bottom, at_depth } arrays of activated entries.
 * Aggregates entries from all enabled tomes cached in state.tomeCache.
 */
function activateTomeEntries(userInput) {
  const empty = { sys_top: [], before_char: [], after_char: [], sys_bottom: [], at_depth: [] };
  // Flatten all entries from all enabled (cached) tomes
  const allEntries = Object.values(state.tomeCache)
    .filter(tome => tome.enabled !== false)
    .flatMap(tome => Object.values(tome.entries ?? {}));
  if (!allEntries.length) return empty;

  const globalDepth = state.tomeScanDepth ?? 4;
  const messages    = state.messages;

  // Age timed effects by one tick; capture which UIDs just exhausted sticky
  const prevSticky = {};
  for (const uid of Object.keys(tomeTimedEffects)) {
    const e = tomeTimedEffects[uid];
    prevSticky[uid] = e.stickyLeft;
    if (e.stickyLeft  > 0) e.stickyLeft--;
    if (e.cooldownLeft > 0) e.cooldownLeft--;
  }

  // Corpus getter factory
  function makeGetCorpus(extra) {
    return (depthOverride, entry) => {
      const d = depthOverride !== null && depthOverride !== undefined ? depthOverride : globalDepth;
      let text = buildScanText(messages, userInput, d, extra);
      if (entry) {
        // matchCharacterDescription / matchCharacterPersonality → Familiar's entity card
        if ((entry.matchCharacterDescription || entry.matchCharacterPersonality) && state.characterProfile)
          text += '\n' + state.characterProfile;
        // matchPersonaDescription → user profile
        if (entry.matchPersonaDescription && state.userProfile)
          text += '\n' + state.userProfile;
        // matchScenario → system prompt (closest equivalent)
        if (entry.matchScenario && state.systemPrompt)
          text += '\n' + state.systemPrompt;
      }
      return text;
    };
  }

  // Initial scan pass
  const activated = new Set();
  for (const e of scanLoreEntries(allEntries, makeGetCorpus(''), activated, false)) {
    activated.add(e.uid);
  }

  // Recursive passes
  if (state.tomeRecursive) {
    const maxSteps = state.tomeMaxRecursionSteps ?? 3;
    let prevRecursionContent = '';
    for (let step = 0; step < maxSteps; step++) {
      const recursionContent = Array.from(activated)
        .map(uid => allEntries.find(e => e.uid === uid))
        .filter(e => e && !e.preventRecursion)
        .map(e => e.content || '')
        .join('\n');
      if (!recursionContent || recursionContent === prevRecursionContent) break;
      prevRecursionContent = recursionContent;
      const newEntries = scanLoreEntries(allEntries, makeGetCorpus(recursionContent), activated, true);
      if (!newEntries.length) break;
      for (const e of newEntries) activated.add(e.uid);
    }
  }

  // Resolve entries and apply group logic
  let activatedEntries = Array.from(activated)
    .map(uid => allEntries.find(e => e.uid === uid))
    .filter(Boolean);
  activatedEntries = applyGroupLogic(activatedEntries);

  // Update timed effects for this activation pass
  for (const e of activatedEntries) {
    if (!tomeTimedEffects[e.uid]) tomeTimedEffects[e.uid] = { stickyLeft: 0, cooldownLeft: 0 };
    if (e.sticky) tomeTimedEffects[e.uid].stickyLeft = e.sticky;
  }
  // Entries whose sticky just expired and weren't re-activated → start cooldown
  const activatedSet = new Set(activatedEntries.map(e => e.uid));
  for (const uid of Object.keys(prevSticky)) {
    if (prevSticky[uid] > 0 && !(tomeTimedEffects[uid]?.stickyLeft > 0) && !activatedSet.has(uid)) {
      const entry = allEntries.find(e => e.uid === uid);
      if (entry?.cooldown) {
        if (!tomeTimedEffects[uid]) tomeTimedEffects[uid] = { stickyLeft: 0, cooldownLeft: 0 };
        tomeTimedEffects[uid].cooldownLeft = entry.cooldown;
      }
    }
  }

  // Sort by insertion_order then categorise by position
  activatedEntries.sort((a, b) => (a.insertion_order ?? 100) - (b.insertion_order ?? 100));

  return {
    sys_top:     activatedEntries.filter(e => normEntryPos(e.position) === 2),
    before_char: activatedEntries.filter(e => normEntryPos(e.position) === 0),
    after_char:  activatedEntries.filter(e => normEntryPos(e.position) === 1),
    sys_bottom:  activatedEntries.filter(e => normEntryPos(e.position) === 3),
    at_depth:    activatedEntries.filter(e => normEntryPos(e.position) === 4),
  };
}

// ── Tomes modal (manager) ─────────────────────────────────────────
function openTomesModal() {
  $('tomes-modal').classList.remove('hidden');
  refreshTomesList();
}

function closeTomesModal() {
  $('tomes-modal').classList.add('hidden');
}

async function refreshTomesList() {
  await loadTomesFromServer();
  const container = $('tomes-list');
  container.innerHTML = '';
  const tomes = state.tomeRegistry.filter(t => t && t.id);
  if (!tomes.length) {
    container.innerHTML = '<p class="lorebook-empty">No tomes yet. Click <strong>+ New Tome</strong> to create one.</p>';
    return;
  }
  for (const tome of tomes) {
    const div = document.createElement('div');
    div.className = 'lorebook-entry';
    div.innerHTML = `
      <div class="lorebook-entry-header">
        <div class="lorebook-entry-title">${esc(tome.name ?? 'Untitled')}</div>
        <div class="lorebook-entry-actions">
          <button class="btn-ghost tome-open-btn" data-id="${esc(tome.id)}" title="View entries">Open</button>
          <button class="btn-ghost tome-toggle-btn" data-id="${esc(tome.id)}" title="${tome.enabled ? 'Disable tome' : 'Enable tome'}">${tome.enabled ? 'Enabled' : 'Disabled'}</button>
          <button class="btn-ghost lore-delete-btn" data-id="${esc(tome.id)}" title="Delete tome">✕</button>
        </div>
      </div>
      ${tome.description ? `<div class="lorebook-entry-content">${esc(tome.description)}</div>` : ''}
      <div class="lorebook-entry-meta">${tome.entryCount} entr${tome.entryCount !== 1 ? 'ies' : 'y'}</div>
    `;
    div.querySelector('.tome-open-btn').addEventListener('click', () => openTomeEntriesModal(tome.id));
    div.querySelector('.tome-toggle-btn').addEventListener('click', () => toggleTomeEnabled(tome.id));
    div.querySelector('.lore-delete-btn').addEventListener('click', () => deleteTome(tome.id));
    container.appendChild(div);
  }
}

async function toggleTomeEnabled(tomeId) {
  const tome = state.tomeRegistry.find(t => t.id === tomeId);
  if (!tome) return;
  try {
    await fetch(`/api/tomes/${tomeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !tome.enabled }),
    });
    await refreshTomesList();
  } catch (err) {
    alert(`Failed to update tome: ${err.message}`);
  }
}

async function deleteTome(tomeId) {
  const tome = state.tomeRegistry.find(t => t.id === tomeId);
  if (!confirm(`Delete tome "${tome?.name ?? tomeId}" and all its entries? This cannot be undone.`)) return;
  try {
    await fetch(`/api/tomes/${tomeId}`, { method: 'DELETE' });
    delete state.tomeCache[tomeId];
    await refreshTomesList();
  } catch (err) {
    alert(`Failed to delete tome: ${err.message}`);
  }
}

// ── New tome modal ────────────────────────────────────────────────
function openNewTomeModal() {
  $('new-tome-name-input').value = '';
  $('new-tome-description-input').value = '';
  $('new-tome-modal').classList.remove('hidden');
  requestAnimationFrame(() => $('new-tome-name-input').focus());
}

function closeNewTomeModal() {
  $('new-tome-modal').classList.add('hidden');
}

async function createNewTome() {
  const name = $('new-tome-name-input').value.trim();
  if (!name) { alert('Please enter a name for the tome.'); return; }
  const description = $('new-tome-description-input').value.trim();
  try {
    const res = await fetch('/api/tomes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to create tome.');
    closeNewTomeModal();
    await refreshTomesList();
  } catch (err) {
    alert(`Failed to create tome: ${err.message}`);
  }
}

// ── Tome entries modal ─────────────────────────────────────────────
function openTomeEntriesModal(tomeId) {
  _currentTomeId = tomeId;
  const tome = state.tomeRegistry.find(t => t.id === tomeId);
  $('tome-entries-modal-title').textContent = tome?.name ?? 'Tome Entries';
  $('tome-entries-modal').classList.remove('hidden');
  bindResizableModal('tome-entries-modal-inner', 'pf-tome-entries-modal-size');
  refreshTomeEntriesList();
}

function closeTomeEntriesModal() {
  $('tome-entries-modal').classList.add('hidden');
  _currentTomeId = null;
}

async function refreshTomeEntriesList() {
  if (!_currentTomeId) return;
  const container = $('tome-entries-list');
  container.innerHTML = '<p class="logs-loading">Loading\u2026</p>';
  try {
    const res = await fetch(`/api/tomes/${_currentTomeId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tome = await res.json();
    state.tomeCache[_currentTomeId] = tome;
    container.innerHTML = '';
    const entries = Object.values(tome.entries ?? {});
    if (!entries.length) {
      container.innerHTML = '<p class="lorebook-empty">No entries in this tome yet. Click <strong>+ New</strong> to add one.</p>';
      return;
    }
    entries.sort((a, b) => new Date(b.created_at ?? 0) - new Date(a.created_at ?? 0));
    for (const entry of entries) {
      const div = document.createElement('div');
      div.className = 'lorebook-entry';
      const keyTagsHtml = (entry.keys ?? []).slice(0, 8).map(k => `<span class="lorebook-key-tag">${esc(k)}</span>`).join('');
      const dateStr = entry.created_at
        ? new Date(entry.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
        : '';
      const posLabel = ['Before char', 'After char', 'Sys top', 'Sys bottom', '@Depth'][normEntryPos(entry.position)] ?? '';
      const constBadge = entry.constant ? ' \u00b7 <strong>always-on</strong>' : '';
      div.innerHTML = `
        <div class="lorebook-entry-header">
          <div class="lorebook-entry-title">${esc(entry.comment ?? 'Untitled')}</div>
          <div class="lorebook-entry-actions">
            <button class="btn-ghost lore-edit-btn" data-uid="${esc(entry.uid)}" title="Edit entry">Edit</button>
            <button class="btn-ghost lore-toggle-btn" data-uid="${esc(entry.uid)}" title="${entry.enabled ? 'Disable entry' : 'Enable entry'}">${entry.enabled ? 'Enabled' : 'Disabled'}</button>
            <button class="btn-ghost lore-delete-btn" data-uid="${esc(entry.uid)}" title="Delete entry">\u2715</button>
          </div>
        </div>
        <div class="lorebook-entry-keys">${keyTagsHtml}</div>
        <div class="lorebook-entry-content">${esc(entry.content ?? '')}</div>
        <div class="lorebook-entry-meta">${esc(dateStr)}${constBadge} \u00b7 ${posLabel}</div>
      `;
      div.querySelector('.lore-edit-btn').addEventListener('click', () => openLoreEditor(entry.uid));
      div.querySelector('.lore-toggle-btn').addEventListener('click', () => toggleTomeEntry(entry.uid));
      div.querySelector('.lore-delete-btn').addEventListener('click', () => deleteTomeEntry(entry.uid));
      container.appendChild(div);
    }
  } catch (err) {
    container.innerHTML = `<p class="logs-error">\u26a0 Failed to load entries: ${esc(String(err.message))}</p>`;
  }
}

async function toggleTomeEntry(uid) {
  if (!_currentTomeId) return;
  const tome = state.tomeCache[_currentTomeId];
  if (!tome?.entries[uid]) return;
  tome.entries[uid].enabled = !tome.entries[uid].enabled;
  try {
    await fetch(`/api/tomes/${_currentTomeId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: tome.entries }),
    });
    refreshTomeEntriesList();
  } catch (err) {
    alert(`Failed to update entry: ${err.message}`);
  }
}

async function deleteTomeEntry(uid) {
  if (!_currentTomeId) return;
  if (!confirm('Delete this entry? This cannot be undone.')) return;
  try {
    await fetch(`/api/tomes/${_currentTomeId}/entries/${uid}`, { method: 'DELETE' });
    const tome = state.tomeCache[_currentTomeId];
    if (tome?.entries) delete tome.entries[uid];
    refreshTomeEntriesList();
  } catch (err) {
    alert(`Failed to delete entry: ${err.message}`);
  }
}

/** Return the first enabled tome, or create a "General" tome if none exist. */
async function getDefaultTomeForSaving() {
  const enabled = state.tomeRegistry.filter(t => t.enabled);
  if (enabled.length > 0) return enabled[0];
  // Create a default tome
  const res = await fetch('/api/tomes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'General', description: 'Default tome for session memories and topic summaries.' }),
  });
  if (!res.ok) throw new Error('Failed to create default tome.');
  await loadTomesFromServer();
  const { id } = await res.json();
  return state.tomeRegistry.find(t => t.id === id) ?? state.tomeRegistry[0] ?? null;
}

// ── Diagnostics ─────────────────────────────────────────────────────────
//
// On demand, gather a plain-text snapshot the user can paste into a bug
// report. Combines navigator-derived system info, current Proto-Familiar
// state, a live /api/health probe (so server-side timeouts / unreachable
// servers show up immediately), and the recent in-app event log.

async function buildDiagnosticReport() {
  const nav  = navigator;
  const scr  = screen;
  const now  = new Date();
  const lines = [];
  const add = (k, v) => lines.push(`${k.padEnd(22)} ${v}`);
  const section = title => { lines.push('', `── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`); };

  lines.push(`Proto-Familiar diagnostic report`);
  lines.push(`generated: ${now.toISOString()} (${now.toString()})`);

  section('System');
  add('userAgent',           nav.userAgent ?? '?');
  add('platform',            nav.platform ?? nav.userAgentData?.platform ?? '?');
  add('language',            nav.language ?? '?');
  add('hardwareConcurrency', nav.hardwareConcurrency ?? '?');
  add('deviceMemory (GB)',   nav.deviceMemory ?? '?');
  add('connection',          nav.connection ? `${nav.connection.effectiveType ?? '?'} ${nav.connection.downlink ?? '?'}Mb/s${nav.connection.rtt ? ` ${nav.connection.rtt}ms` : ''}` : '?');
  add('online',              String(nav.onLine));
  add('screen',              scr ? `${scr.width}×${scr.height} @ ${window.devicePixelRatio ?? 1}x dpr` : '?');
  add('viewport',            `${window.innerWidth}×${window.innerHeight}`);
  add('colorScheme',         (typeof window.matchMedia === 'function')
                               ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
                               : '?');
  try { add('timezone',      Intl.DateTimeFormat().resolvedOptions().timeZone ?? '?'); }
  catch { add('timezone',    '?'); }

  section('Proto-Familiar');
  add('url',                 location.href);
  add('provider',            state.provider ?? '?');
  add('model',               state.model ?? '?');
  add('apiKey set',          state.apiKey && state.apiKey.trim() ? 'yes' : 'no');
  add('streaming',           String(state.streaming));
  add('toolsEnabled',        String(state.toolsEnabled));
  add('temperature',         String(state.temperature ?? '?'));
  add('max_tokens',          String(state.maxTokens ?? '?'));
  add('sessionId',           state.sessionId ?? '(none)');
  add('sessionStartedAt',    state.sessionStartedAt ?? '(none)');
  add('messages',            String(state.messages?.length ?? 0));
  add('topics',              String(state.topics?.length ?? 0));
  add('tomeRegistry',        String(state.tomeRegistry?.length ?? 0));
  add('customTools',         state.customTools ? `${state.customTools.length} chars` : '(empty)');
  add('lastThalamus', lastThalamus
    ? `static=${(lastThalamus.static ?? '').length}ch dynamic=${(lastThalamus.dynamic ?? '').length}ch @ depth=${lastThalamus.depth} (injectedAt=${lastThalamus.injectedAt})`
    : '(none — no enriched response captured yet)');

  // localStorage estimate (rough — only our own keys)
  let lsBytes = 0;
  try {
    for (const k of Object.keys(localStorage)) lsBytes += (k.length + (localStorage.getItem(k)?.length ?? 0));
  } catch { /* not available */ }
  add('localStorage (bytes)', String(lsBytes));

  section('Server probe (/api/health)');
  const probeStart = performance.now();
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    const ms = Math.round(performance.now() - probeStart);
    add('status', `${r.status} ${r.statusText}`);
    add('roundTrip',  `${ms} ms`);
  } catch (err) {
    add('status', `FAILED: ${err.message}`);
  }

  section('Last sent prompt summary');
  if (!lastSentMessages) {
    lines.push('  (none — no message sent yet this session)');
  } else {
    add('messages',  String(lastSentMessages.length));
    add('roles',     lastSentMessages.map(m => m.role).join(','));
    add('system seg sources', (lastBuildSegments?.systemSegments ?? []).map(s => s.source).join(',') || '(none)');
    add('at-depth lore splices', String((lastBuildSegments?.atDepthInjections ?? []).length));
    add('thalamus injection', lastThalamus
      ? `static=${(lastThalamus.static ?? '').length}ch dynamic=${(lastThalamus.dynamic ?? '').length}ch @ depth=${lastThalamus.depth}`
      : 'none');
  }

  section(`Recent events (${debugLog.length} / cap ${DEBUG_LOG_CAP})`);
  if (!debugLog.length) {
    lines.push('  (no events captured yet)');
  } else {
    for (const e of debugLog.slice(-100)) {
      lines.push(`  ${e.ts}  ${e.type.padEnd(20)} ${e.detail}`);
    }
  }

  return lines.join('\n');
}

async function openDiagnosticsModal() {
  $('diagnostics-output').textContent = 'Gathering…';
  $('diagnostics-modal').classList.remove('hidden');
  try {
    const text = await buildDiagnosticReport();
    $('diagnostics-output').textContent = text;
  } catch (err) {
    $('diagnostics-output').textContent = `Failed to build report: ${err.message}`;
  }
}
function closeDiagnosticsModal() { $('diagnostics-modal').classList.add('hidden'); }

function downloadDiagnosticReport() {
  const text = $('diagnostics-output').textContent;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `proto-familiar-diagnostics-${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Knowledge editor (Phylactery: memories, identity, graph, snapshots) ──
//
// Layered UI: tabs across the top, two-pane list+detail per tab. All ops
// hit /api/entity/* endpoints; destructive ones auto-snapshot server-side
// so the Snapshots tab is the always-on undo.

const KE_TABS = ['memories', 'coverage', 'graph', 'identity', 'snapshots'];

function openKnowledgeModal() {
  $('knowledge-modal').classList.remove('hidden');
  bindResizableModal('knowledge-modal-inner', 'pf-knowledge-modal-size');
  keGraphClosePopover();
  keSwitchTab('memories');
}
function closeKnowledgeModal() {
  $('knowledge-modal').classList.add('hidden');
  keGraphClosePopover();
}

// Restore a persisted size for a `.modal-resizable` element and persist
// future resizes. Idempotent — repeat calls re-apply the saved size but
// only install one ResizeObserver per element.
// On touch/mobile the CSS media query handles sizing; skip the restore
// so a desktop-sized localStorage value can't override it via inline style.
const _resizableBound = new WeakSet();
const _isMobileViewport = () => window.matchMedia('(max-width: 767px)').matches;
function bindResizableModal(elId, storageKey) {
  const el = $(elId);
  if (!el) return;
  if (_isMobileViewport()) {
    // Strip any inline size so the CSS media-query rules take full control.
    // Without this a desktop-saved localStorage value (written as inline style
    // on a previous open) would override the `width: 100%; height: 88vh` rules.
    el.style.removeProperty('width');
    el.style.removeProperty('height');
  } else {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const { w, h } = JSON.parse(raw);
        if (typeof w === 'number' && w > 0) el.style.width  = `${w}px`;
        if (typeof h === 'number' && h > 0) el.style.height = `${h}px`;
      }
    } catch {/* ignore */}
  }
  if (_resizableBound.has(el) || typeof ResizeObserver === 'undefined') return;
  _resizableBound.add(el);
  let saveT = 0;
  const ro = new ResizeObserver(entries => {
    if (_isMobileViewport()) return; // don't overwrite desktop size with mobile layout dims
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      try { localStorage.setItem(storageKey, JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) })); }
      catch {/* ignore */}
    }, 250);
  });
  ro.observe(el);
}

function keSwitchTab(tab) {
  for (const t of KE_TABS) {
    $(`ke-pane-${t}`)?.classList.toggle('ke-pane-active', t === tab);
  }
  document.querySelectorAll('.ke-tab').forEach(el => {
    el.classList.toggle('ke-tab-active', el.dataset.tab === tab);
  });
  if (tab === 'memories')   keLoadMemories();
  if (tab === 'coverage')   keLoadCoverage();
  if (tab === 'graph') {
    if (_keGraphView === 'map') { keSetGraphView('map'); }
    else                        { keSetGraphView('list'); keLoadGraphNodes(); }
  }
  if (tab === 'identity')   keLoadIdentity();
  if (tab === 'snapshots')  keLoadSnapshots();
}

function keSetDetail(paneId, html) { $(paneId).innerHTML = html; }

function keError(err, fallback) {
  const m = (err && err.message) ? err.message : (typeof err === 'string' ? err : fallback);
  return `<p class="logs-error">⚠ ${esc(String(m))}</p>`;
}

// Pull the server's real `{ error }` message out of a non-OK response.
// Falls back to HTTP status. Surfaces 'phylactery not connected'
// instead of the opaque 'HTTP 502' the user used to see.
async function keReadServerError(res) {
  try {
    const j = await res.json();
    if (j?.error) return String(j.error);
  } catch {/* not JSON */}
  return `HTTP ${res.status}`;
}

// ── Memories tab ────────────────────────────────────────────────────────
async function keLoadMemories() {
  const list = $('ke-mem-list');
  list.innerHTML = '<p class="logs-loading">Loading…</p>';
  const granularity = $('ke-mem-granularity').value || undefined;
  try {
    const res = await fetch('/api/entity/memories' + (granularity ? `?granularity=${encodeURIComponent(granularity)}` : ''));
    if (!res.ok) throw new Error(await keReadServerError(res));
    const data = await res.json();
    const memories = data.memories ?? [];
    if (!memories.length) { list.innerHTML = '<p class="logs-empty">No memories found.</p>'; return; }
    list.innerHTML = '';
    for (const m of memories) {
      const row = document.createElement('div');
      row.className = 'ke-row';
      const audienceBadge = (m.audience && m.audience !== 'ward-private')
        ? `<span class="ke-badge ke-badge-audience">${esc(m.audience)}</span>` : '';
      const cwBadge = m.care_weight
        ? `<span class="ke-badge ke-badge-cw-${esc(m.care_weight)}">${esc(m.care_weight)}</span>` : '';
      // A me/ward register memory is a standing truth, not a passing moment — badge it.
      const registerBadge = (m.register === 'me' || m.register === 'ward')
        ? `<span class="ke-badge ke-badge-register">standing · ${m.register === 'me' ? 'self' : 'ward'}</span>` : '';
      row.innerHTML = `
        <div class="ke-row-title">${esc(m.granularity)} · ${esc(m.date ?? m.key)}${registerBadge}${audienceBadge}${cwBadge}</div>
        <div class="ke-row-sub">${esc((m.preview ?? m.title ?? '').slice(0, 140))}</div>`;
      row.addEventListener('click', () => keOpenMemory(m));
      list.appendChild(row);
    }
  } catch (err) { list.innerHTML = keError(err, 'Failed to load memories.'); }
}

// Audience <option> list shared by the memory + graph-node editors: "just us"
// (ward-private) plus every Village circle, with `current` preselected. An
// unknown current value (a legacy tag like the old 'all', or a since-deleted
// circle) is shown as its own option so opening a record never silently re-tags
// it on save.
function keAudienceOptionsHTML(current, categories) {
  const cur  = current ?? 'ward-private';
  const cats = categories ?? [];
  const opts = [`<option value="ward-private"${cur === 'ward-private' ? ' selected' : ''}>ward-private (just us)</option>`];
  for (const c of cats) {
    opts.push(`<option value="${esc(c.id)}"${cur === c.id ? ' selected' : ''}>${esc(c.name)}</option>`);
  }
  if (cur !== 'ward-private' && !cats.some(c => c.id === cur)) {
    opts.push(`<option value="${esc(cur)}" selected>${esc(cur)} (unknown circle)</option>`);
  }
  return opts.join('');
}

// A memory is addressed by its unique id — granularity+date can't single out a
// standalone per-fact row, because a whole day's extracted facts share one date.
// `m` is the list row (carries id, granularity, key=date).
async function keOpenMemory(m) {
  const id = m?.id;
  keSetDetail('ke-mem-detail', '<p class="logs-loading">Loading…</p>');
  try {
    if (!id) throw new Error('this memory has no id to open');
    const res = await fetch(`/api/entity/memories/by-id/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(await keReadServerError(res));
    const data = await res.json();
    if (data.ok === false) throw new Error(data.error ?? 'memory not found');
    const content    = data.content     ?? '';
    const granularity = data.granularity ?? m.granularity ?? '';
    const date       = data.date        ?? m.key ?? '';
    const audience   = data.audience    ?? 'ward-private';
    const careWeight = data.care_weight ?? '';
    const register   = data.register    ?? 'episodic';
    const registerNote = (register === 'me' || register === 'ward')
      ? `<span class="ke-badge ke-badge-register">standing truth · ${register === 'me' ? 'about the Familiar' : 'about the ward'}</span>` : '';
    // The day this memory is filed under, as a value an <input type="date"> accepts
    // (the leading YYYY-MM-DD; significant keys carry a _slug suffix we drop here).
    const dayValue = (String(date).match(/^\d{4}-\d{2}-\d{2}/) || [''])[0];
    // Audience is a Village circle id (or ward-private), same model the recall gate
    // filters on. Pull the circles so the dropdown offers real options, not a stale
    // ward-private/all pair. Village unreachable → ward-private only; harmless.
    let audCats = [];
    try { audCats = (await vlFetch())?.categories ?? []; } catch { /* keep ward-private only */ }
    const det = $('ke-mem-detail');
    det.innerHTML = `
      <div class="ke-detail-header">
        <h3>${esc(granularity)} · ${esc(date)}</h3>
        ${registerNote}
      </div>
      <textarea id="ke-mem-content" rows="12" class="ke-textarea">${esc(content)}</textarea>
      <div class="ke-meta-row">
        <label class="ke-meta-label" for="ke-mem-audience">Audience</label>
        <select id="ke-mem-audience" class="ke-select">${keAudienceOptionsHTML(audience, audCats)}</select>
        <label class="ke-meta-label" for="ke-mem-care-weight">Care weight</label>
        <select id="ke-mem-care-weight" class="ke-select">
          <option value=""     ${!careWeight             ? 'selected' : ''}>— unset</option>
          <option value="high" ${careWeight === 'high'   ? 'selected' : ''}>high (decay-shielded, never graduates)</option>
          <option value="low"  ${careWeight === 'low'    ? 'selected' : ''}>low</option>
        </select>
      </div>
      <div class="ke-meta-row">
        <label class="ke-meta-label" for="ke-mem-movedate">Filed under</label>
        <input type="date" id="ke-mem-movedate" class="ke-select" value="${esc(dayValue)}">
        <button id="ke-mem-move" class="btn-secondary">Move to this day</button>
      </div>
      <div class="ke-actions">
        <button id="ke-mem-save"    class="btn-send">Save (overwrite)</button>
        <button id="ke-mem-super"   class="btn-secondary">Supersede with today's date</button>
        <button id="ke-mem-delete"  class="btn-ghost ke-danger">Delete</button>
      </div>
      <p class="field-hint">Editing rewrites the entry in place; an auto-snapshot is taken first. "Move to this day" re-files the memory under a different date (the fix for facts imported into the wrong day). "Supersede" writes a NEW dated entry that contradicts this one — recency-decay then demotes the stale entry while preserving history.</p>`;
    $('ke-mem-save').addEventListener('click', async () => {
      const body = $('ke-mem-content').value;
      const aud = $('ke-mem-audience').value;
      const cw  = $('ke-mem-care-weight').value;
      const r = await fetch(`/api/entity/memories/by-id/${encodeURIComponent(id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: body, audience: aud, careWeight: cw || '' }),
      });
      if (!r.ok) { alert(`Save failed: ${(await r.json()).error ?? r.status}`); return; }
      keLoadMemories();
      keOpenMemory({ ...m, id });
    });
    $('ke-mem-move').addEventListener('click', async () => {
      const nd = $('ke-mem-movedate').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nd)) { alert('Pick a valid date first.'); return; }
      const r = await fetch(`/api/entity/memories/by-id/${encodeURIComponent(id)}/move`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: nd }),
      });
      if (!r.ok) { alert(`Move failed: ${(await r.json()).error ?? r.status}`); return; }
      keLoadMemories();
      keOpenMemory({ ...m, id });
    });
    $('ke-mem-super').addEventListener('click', async () => {
      const body = $('ke-mem-content').value;
      if (!body.trim()) { alert('Write the corrected memory content first.'); return; }
      const r = await fetch('/api/entity/memories/supersede', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: body, granularity, supersedes: { granularity, date } }),
      });
      if (!r.ok) { alert(`Supersede failed: ${(await r.json()).error ?? r.status}`); return; }
      const j = await r.json();
      alert(`Wrote new ${granularity}/${j.date}.`);
      keLoadMemories();
    });
    $('ke-mem-delete').addEventListener('click', async () => {
      if (!confirm(`Delete this ${granularity} memory (${date})? An auto-snapshot is taken first; you can restore via the Snapshots tab.`)) return;
      const r = await fetch(`/api/entity/memories/by-id/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!r.ok) { alert(`Delete failed: ${(await r.json()).error ?? r.status}`); return; }
      keSetDetail('ke-mem-detail', '<p class="logs-empty">Deleted.</p>');
      keLoadMemories();
    });
  } catch (err) { keSetDetail('ke-mem-detail', keError(err, 'Failed to load memory.')); }
}

// ── Coverage tab (day-anchoring calendar) ───────────────────────────────
// Shows which calendar days are fully memorized vs missing vs uncertain, and
// lets the ward (re)feed a day's logs to the pipeline. Data: GET
// /api/memory-coverage (per-date status from the coverage ledger + live logs).
let _keCovData = null;                 // { tz, days: { 'YYYY-MM-DD': {status,facts,flags,sessions} } }
let _keCovMonth = null;                // { y, m } (m: 0-11) currently displayed

function keCovShiftMonth({ y, m }, delta) {
  const d = new Date(y, m + delta, 1);
  return { y: d.getFullYear(), m: d.getMonth() };
}
function keCovDateKey(y, m, day) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

async function keLoadCoverage() {
  const cal = $('ke-cov-cal');
  cal.innerHTML = '<p class="logs-loading">Loading…</p>';
  try {
    const res = await fetch('/api/memory-coverage');
    if (!res.ok) throw new Error(await keReadServerError(res));
    _keCovData = await res.json();
    // Default to the most recent month that has any data, else the current month.
    if (!_keCovMonth) {
      const dates = Object.keys(_keCovData.days ?? {}).sort();
      const ref = dates.length ? new Date(dates[dates.length - 1] + 'T00:00:00') : new Date();
      _keCovMonth = { y: ref.getFullYear(), m: ref.getMonth() };
    }
    keRenderCalendar();
  } catch (err) {
    cal.innerHTML = keError(err, 'Failed to load coverage.');
  }
}

function keRenderCalendar() {
  const cal = $('ke-cov-cal');
  if (!_keCovData || !_keCovMonth) { cal.innerHTML = ''; return; }
  const { y, m } = _keCovMonth;
  const days = _keCovData.days ?? {};
  $('ke-cov-month').textContent = new Date(y, m, 1)
    .toLocaleString([], { month: 'long', year: 'numeric' });

  const firstDow = (new Date(y, m, 1).getDay() + 6) % 7; // Mon=0
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  let html = '<div class="ke-cov-grid">';
  for (const d of dow) html += `<div class="ke-cov-dow">${d}</div>`;
  for (let i = 0; i < firstDow; i++) html += '<div class="ke-cov-cell ke-cov-blank"></div>';
  for (let day = 1; day <= daysInMonth; day++) {
    const key = keCovDateKey(y, m, day);
    const entry = days[key];
    const status = entry?.status ?? 'empty';
    const facts = entry?.facts ?? 0;
    const title = entry ? `${status}${facts ? ` · ${facts} fact(s)` : ''}` : 'no logs';
    html += `<button class="ke-cov-cell cov-${status}" data-cov-date="${key}" title="${esc(title)}">`
         +  `<span class="ke-cov-num">${day}</span>`
         +  (facts ? `<span class="ke-cov-facts">${facts}</span>` : '')
         +  '</button>';
  }
  html += '</div>';
  cal.innerHTML = html;
  cal.querySelectorAll('[data-cov-date]').forEach(el =>
    el.addEventListener('click', () => keOpenCoverageDay(el.dataset.covDate)));
}

function keOpenCoverageDay(date) {
  const entry = _keCovData?.days?.[date];
  const det = $('ke-cov-detail');
  const pretty = new Date(date + 'T00:00:00').toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  if (!entry) {
    det.innerHTML = `<div class="ke-detail-header"><h3>${esc(pretty)}</h3></div>`
      + '<p class="logs-empty">No conversation logs on this day.</p>';
    return;
  }
  const sessions = entry.sessions ?? [];
  const rows = sessions.map(s => {
    const done = s.memorized >= s.total;
    const flag = s.flag ? ` <span class="ke-badge ke-badge-register">${esc(s.flag)}</span>` : '';
    return `<div class="ke-cov-srow">${done ? '✓' : '○'} <code>${esc(s.sessionId.slice(0, 8))}</code> `
      + `<span class="field-hint">${s.memorized}/${s.total} msgs</span>${flag}</div>`;
  }).join('');
  det.innerHTML = `
    <div class="ke-detail-header">
      <h3>${esc(pretty)}</h3>
      <span class="ke-badge cov-${entry.status}">${esc(entry.status)}</span>
    </div>
    <p class="field-hint">${entry.facts} fact(s) memorized from this day.</p>
    <div class="ke-cov-sessions">${rows || '<p class="logs-empty">—</p>'}</div>
    <div class="ke-actions">
      <button id="ke-cov-memorize" class="btn-send">Memorize this day</button>
      <label class="ke-cov-force"><input type="checkbox" id="ke-cov-force"> re-run already-done</label>
    </div>
    <div class="vl-status" id="ke-cov-status"></div>`;
  $('ke-cov-memorize').addEventListener('click', () => keMemorizeDay(date));
}

async function keMemorizeDay(date) {
  const status = $('ke-cov-status');
  if (!state.apiKey.trim()) { status.textContent = 'Set an API key in Settings first.'; return; }
  const force = !!$('ke-cov-force')?.checked;
  status.textContent = 'Queuing…';
  try {
    const res = await fetch('/api/memorize-day', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, force, provider: state.provider, apiKey: state.apiKey, model: state.model }),
    });
    if (!res.ok) throw new Error(await keReadServerError(res));
    const { enqueued, deduped, requested } = await res.json();
    status.textContent = enqueued
      ? `Queued ${enqueued} session-slice(s) — coverage updates as they finish.`
      : (requested ? 'Already in hand (in flight or done).' : 'Nothing to memorize on this day.');
    // Refresh coverage shortly so the colour reflects in-flight work settling.
    setTimeout(keLoadCoverage, 1500);
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  }
}

// ── Coverage: foreign-log import ────────────────────────────────────────
let _keImportPreviewed = null; // last preview's {dates, days, messages, format}
let _keImportFilename = '';    // name of the chosen file (for filename-date extraction)

async function keCovImportFileChosen(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > 30 * 1024 * 1024) { $('ke-cov-import-status').textContent = 'File too large (max 30 MB).'; return; }
  try {
    $('ke-cov-import-text').value = await file.text();
    _keImportFilename = file.name;
    $('ke-cov-import-status').textContent = `Loaded ${file.name}.`;
  } catch { $('ke-cov-import-status').textContent = 'Could not read that file.'; }
}

function keCovImportBody(commit) {
  return {
    content: $('ke-cov-import-text').value,
    selfNames: $('ke-cov-import-self').value,
    source: $('ke-cov-import-source').value,
    filename: _keImportFilename || undefined,
    fallbackDate: $('ke-cov-import-date').value || undefined,
    ...(commit ? { commit: true, provider: state.provider, apiKey: state.apiKey, model: state.model } : {}),
  };
}

async function keCovImportPreview() {
  const status = $('ke-cov-import-status');
  if (!$('ke-cov-import-text').value.trim()) { status.textContent = 'Paste or choose a log first.'; return; }
  status.textContent = 'Reading…';
  $('ke-cov-import-commit').disabled = true;
  _keImportPreviewed = null;
  try {
    const res = await fetch('/api/import-logs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(keCovImportBody(false)),
    });
    if (!res.ok) throw new Error(await keReadServerError(res));
    const data = await res.json();
    if (data.needsDate) {
      _keImportPreviewed = null;
      status.textContent = `Recognised ${data.format}, but it has no timestamps and none in the filename. Enter a "Date" above, then Preview again.`;
      $('ke-cov-import-date')?.focus();
      return;
    }
    _keImportPreviewed = data;
    const range = data.dates.length ? `${data.dates[0]} → ${data.dates[data.dates.length - 1]}` : '—';
    status.textContent = `Recognised ${data.format}: ${data.days} day(s) (${range}), ${data.messages} message(s). `
      + `"Import & memorize" will store them and run ~${data.days} extraction pass(es).`;
    $('ke-cov-import-commit').disabled = false;
  } catch (err) {
    status.textContent = `Couldn't read it: ${err.message}`;
  }
}

async function keCovImportCommit() {
  const status = $('ke-cov-import-status');
  if (!_keImportPreviewed) { status.textContent = 'Preview first.'; return; }
  if (!state.apiKey.trim()) { status.textContent = 'Set an API key in Settings first.'; return; }
  if (!confirm(`Import ${_keImportPreviewed.days} day(s) and memorize them now? This runs ~${_keImportPreviewed.days} extraction pass(es).`)) return;
  status.textContent = 'Importing…';
  $('ke-cov-import-commit').disabled = true;
  try {
    const res = await fetch('/api/import-logs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(keCovImportBody(true)),
    });
    if (!res.ok) throw new Error(await keReadServerError(res));
    const data = await res.json();
    status.textContent = `Imported ${data.days} day(s), queued ${data.enqueued} for memorizing. Coverage updates as they finish.`;
    _keImportPreviewed = null;
    $('ke-cov-import-text').value = '';
    setTimeout(keLoadCoverage, 1500);
  } catch (err) {
    status.textContent = `Import failed: ${err.message}`;
    $('ke-cov-import-commit').disabled = false;
  }
}

// ── Graph tab ───────────────────────────────────────────────────────────
async function keLoadGraphNodes() {
  const list = $('ke-graph-list');
  list.innerHTML = '<p class="logs-loading">Loading…</p>';
  const type = $('ke-graph-type').value.trim() || undefined;
  try {
    const res = await fetch('/api/entity/graph/nodes' + (type ? `?type=${encodeURIComponent(type)}` : ''));
    if (!res.ok) throw new Error(await keReadServerError(res));
    const data  = await res.json();
    const nodes = data.nodes ?? data.results ?? [];
    if (!nodes.length) { list.innerHTML = '<p class="logs-empty">No graph nodes found.</p>'; return; }
    keUpdateNodeTypes(nodes);
    list.innerHTML = '';
    for (const n of nodes) {
      const row = document.createElement('div');
      row.className = 'ke-row';
      row.innerHTML = `
        <div class="ke-row-title">${esc(n.label ?? n.id)}</div>
        <div class="ke-row-sub">${esc(n.type ?? '')}${n.description ? ' · ' + esc(n.description.slice(0, 100)) : ''}</div>`;
      row.addEventListener('click', () => keOpenGraphNode(n.id));
      list.appendChild(row);
    }
  } catch (err) { list.innerHTML = keError(err, 'Failed to load graph nodes.'); }
}

async function keOpenGraphNode(id) {
  keSetDetail('ke-graph-detail', '<p class="logs-loading">Loading…</p>');
  try {
    const res = await fetch(`/api/entity/graph/nodes/${encodeURIComponent(id)}/subgraph?depth=1`);
    if (!res.ok) throw new Error(await keReadServerError(res));
    const sg   = await res.json();
    const self = (sg.nodes ?? []).find(n => n.id === id) ?? { id };
    keUpdateNodeTypes([self, ...(sg.nodes ?? [])]);
    keUpdateEdgeTypes(sg.edges ?? []);
    const det  = $('ke-graph-detail');
    const edgesHtml = (sg.edges ?? []).map(e => keGraphEdgeRowHTML(id, e, sg)).join('');
    det.innerHTML = `
      <div class="ke-detail-header"><h3>${esc(self.label ?? id)}</h3></div>
      <div class="field"><label>Label</label><input id="ke-graph-label" type="text" value="${esc(self.label ?? '')}"></div>
      <div class="field"><label>Type</label><input id="ke-graph-nodetype" type="text" value="${esc(self.type ?? '')}" list="ke-node-types-dl"></div>
      <div class="field"><label>Description</label><textarea id="ke-graph-desc" rows="4" class="ke-textarea">${esc(self.description ?? '')}</textarea></div>
      <div class="ke-actions">
        <button id="ke-graph-save" class="btn-send">Save</button>
        <button id="ke-graph-delete" class="btn-ghost ke-danger">Delete node</button>
      </div>
      <h4 class="ke-subhead">Edges (${(sg.edges ?? []).length})</h4>
      <div class="ke-edges" id="ke-graph-edges">${edgesHtml || '<p class="logs-empty">No edges.</p>'}</div>
      ${keGraphAddEdgeFormHTML()}`;
    $('ke-graph-save').addEventListener('click', async () => {
      const body = {
        label:       $('ke-graph-label').value,
        type:        $('ke-graph-nodetype').value,
        description: $('ke-graph-desc').value,
      };
      const r = await fetch(`/api/entity/graph/nodes/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!r.ok) { alert(`Save failed: ${(await r.json()).error ?? r.status}`); return; }
      keLoadGraphNodes();
      keOpenGraphNode(id);
    });
    $('ke-graph-delete').addEventListener('click', async () => {
      if (!confirm('Delete this node and ALL its edges? An auto-snapshot is taken first.')) return;
      const r = await fetch(`/api/entity/graph/nodes/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!r.ok) { alert(`Delete failed: ${(await r.json()).error ?? r.status}`); return; }
      keSetDetail('ke-graph-detail', '<p class="logs-empty">Deleted.</p>');
      keLoadGraphNodes();
    });
    keGraphAttachEdgesUI(det, id, sg, () => keOpenGraphNode(id));
  } catch (err) { keSetDetail('ke-graph-detail', keError(err, 'Failed to load node.')); }
}

// ── Graph map view ──────────────────────────────────────────────────────
//
// Renders the full knowledge graph as dots (nodes) and quadratic curves
// (edges) on a canvas. Node hue encodes type via a deterministic
// per-graph palette (sorted types → palette[i*stride % 24]); edge hue
// encodes relationship type, with saturation / lightness / alpha
// scaled to the edge's weight in [0, 1] so strong relationships read
// vivid and weak ones fade. Wheel zooms, drag pans, hover surfaces a
// tooltip (hit-tested against the actual Bézier curve), and clicking a
// dot opens the draggable popover editor.

let _keGraphView = 'list';

// The Phylactery knowledge graph drives the shared force-directed map
// engine (graph-map.js). Domain editing — the node popover, edge weight
// forms, type/label autocomplete — stays here; the engine owns
// rendering, force layout, pan/zoom, touch, hit-testing, colours,
// legend and tooltip, and is shared with the Unruh schedule map.
let _keGraphMap = null;
function keGraphMapInstance() {
  if (_keGraphMap) return _keGraphMap;
  _keGraphMap = createGraphMap({
    canvas:    $('ke-graph-canvas'),
    statusEl:  $('ke-graph-map-status'),
    legendEl:  $('ke-graph-legend'),
    tooltipEl: $('ke-graph-tooltip'),
    isActive: () =>
      !$('knowledge-modal').classList.contains('hidden') &&
      !$('ke-graph-map').classList.contains('hidden'),
    onNodeClick:       (node, cx, cy) => keGraphOpenPopover(node, cx, cy),
    onBackgroundClick: () => keGraphClosePopover(),
  });
  _keGraphMap.init();
  // Zoom buttons — the touchpad-friendly path for users who can't
  // scroll-to-zoom (pinch + wheel both also work via the engine).
  $('ke-graph-zoom-in') ?.addEventListener('click', () => _keGraphMap.zoomBy(1.25));
  $('ke-graph-zoom-out')?.addEventListener('click', () => _keGraphMap.zoomBy(1 / 1.25));
  $('ke-graph-zoom-fit')?.addEventListener('click', () => _keGraphMap.fit());
  // Escape closes the editor popover (host UI, not the engine's concern).
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('ke-graph-popover').classList.contains('hidden')) {
      keGraphClosePopover();
    }
  });
  return _keGraphMap;
}

function keSetGraphView(view) {
  const changed = (view !== _keGraphView);
  _keGraphView = view;
  $('ke-graph-view-list').classList.toggle('ke-view-active', view === 'list');
  $('ke-graph-view-map').classList.toggle('ke-view-active',  view === 'map');
  $('ke-graph-view-list').setAttribute('aria-selected', view === 'list' ? 'true' : 'false');
  $('ke-graph-view-map').setAttribute('aria-selected',  view === 'map'  ? 'true' : 'false');
  $('ke-graph-split').classList.toggle('hidden', view !== 'list');
  $('ke-graph-map').classList.toggle('hidden',   view !== 'map');
  // Popover is anchored to a specific (possibly stale) node, so leaving
  // the map view, or refreshing it, should dismiss it.
  if (changed) keGraphClosePopover();
  if (view === 'map') {
    keGraphMapInstance();
    keLoadGraphMap();
  }
}

// Generation counter — guards against a slow earlier load resolving
// after a faster later one and clobbering the visible map.
let _keGraphLoadGen = 0;
async function keLoadGraphMap() {
  const gen    = ++_keGraphLoadGen;
  const status = $('ke-graph-map-status');
  status.textContent = 'Loading…';
  status.classList.remove('hidden');
  const type = $('ke-graph-type').value.trim();
  const url  = '/api/entity/graph/full' + (type ? `?type=${encodeURIComponent(type)}` : '');
  try {
    const res = await fetch(url);
    if (gen !== _keGraphLoadGen) return;
    if (!res.ok) throw new Error(await keReadServerError(res));
    const data = await res.json();
    if (gen !== _keGraphLoadGen) return;
    keUpdateNodeTypes(data.nodes ?? []);
    keUpdateEdgeTypes(data.edges ?? []);
    const { empty } = keGraphMapInstance().setData(data.nodes ?? [], data.edges ?? []);
    if (empty) { status.textContent = 'No graph nodes yet.'; return; }
    status.classList.add('hidden');
  } catch (err) {
    status.textContent = 'Failed to load graph: ' + (err.message || err);
  }
}

// ── Type & label autocomplete (shared by list & map editors) ──────────
//
// Every place we receive node/edge data we feed unique values into a few
// global indices and re-render hidden <datalist>s that all the editor
// inputs reference. Datalists are suggestions, not constraints — the
// user can still introduce new types/labels freely.
const _keNodeTypes = new Set();
const _keEdgeTypes = new Set();
// label (lowercased) → array of node ids that carry it; arrays so we
// can detect ambiguity at resolve-time.
const _keNodeIdsByLabel = new Map();
// id → label for rendering edge rows after fetch.
const _keNodeLabelById  = new Map();

function keUpdateNodeTypes(nodes) {
  if (!Array.isArray(nodes)) return;
  let typesChanged = false, labelsChanged = false;
  for (const n of nodes) {
    const t = (n?.type || '').trim();
    if (t && !_keNodeTypes.has(t)) { _keNodeTypes.add(t); typesChanged = true; }
    const l = (n?.label || '').trim();
    if (l && n?.id) {
      _keNodeLabelById.set(n.id, l);
      const key = l.toLowerCase();
      const ids = _keNodeIdsByLabel.get(key);
      if (!ids) { _keNodeIdsByLabel.set(key, [n.id]); labelsChanged = true; }
      else if (!ids.includes(n.id)) { ids.push(n.id); labelsChanged = true; }
    }
  }
  if (typesChanged)  keRefreshDatalist('ke-node-types-dl',  Array.from(_keNodeTypes));
  if (labelsChanged) keRefreshDatalist('ke-node-labels-dl', Array.from(new Set(_keNodeLabelById.values())));
}

function keUpdateEdgeTypes(edges) {
  if (!Array.isArray(edges)) return;
  let changed = false;
  for (const e of edges) {
    const t = (e?.type || e?.customType || '').trim();
    if (t && !_keEdgeTypes.has(t)) { _keEdgeTypes.add(t); changed = true; }
  }
  if (changed) keRefreshDatalist('ke-edge-types-dl', Array.from(_keEdgeTypes));
}

function keRefreshDatalist(id, values) {
  let dl = document.getElementById(id);
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = id;
    document.body.appendChild(dl);
  }
  dl.innerHTML = values.slice().sort().map(v => `<option value="${esc(v)}">`).join('');
}

// Resolve a typed-in label to a node id. Returns { id, ambiguous, missing }.
function keResolveNodeLabel(label) {
  const l = (label || '').trim();
  if (!l) return { missing: true };
  const ids = _keNodeIdsByLabel.get(l.toLowerCase());
  if (!ids || !ids.length) return { missing: true };
  if (ids.length > 1)      return { id: ids[0], ambiguous: true };
  return { id: ids[0] };
}

// ── Edge UI (shared by list editor & map popover) ──────────────────────
function keGraphEdgeRowHTML(ownerId, e, sg) {
  const otherId    = e.fromId === ownerId ? e.toId : e.fromId;
  const otherLabel = (sg.nodes ?? []).find(n => n.id === otherId)?.label ?? otherId;
  const dir        = e.fromId === ownerId ? '→' : '←';
  const t          = e.type ?? e.customType ?? 'related';
  const w          = typeof e.weight === 'number' ? e.weight.toFixed(2) : '0.50';
  return `<div class="ke-edge-row" data-edge-id="${esc(e.id)}">
    <span class="ke-edge-text">${dir} ${esc(t)} <span class="ke-edge-weight-display">[${esc(w)}]</span> ${dir} <strong>${esc(otherLabel)}</strong></span>
    <button class="btn-ghost ke-edge-edit-btn"            type="button" title="Edit">✎</button>
    <button class="btn-ghost ke-danger ke-edge-del-btn"   type="button" title="Delete">✕</button>
  </div>`;
}

function keGraphAddEdgeFormHTML() {
  return `<details class="ke-add-edge">
    <summary>+ Add edge from this node</summary>
    <div class="ke-add-edge-form">
      <input class="ke-ae-target" type="text" placeholder="Target node label" list="ke-node-labels-dl" autocomplete="off">
      <input class="ke-ae-type"   type="text" placeholder="Relationship type" list="ke-edge-types-dl"  autocomplete="off">
      <label>Weight
        <input class="ke-ae-weight" type="range" min="0" max="1" step="0.05" value="0.5">
        <span class="ke-edge-weight-display ke-ae-w-disp">0.50</span>
      </label>
      <div class="ke-actions">
        <button class="btn-send ke-ae-create" type="button">Add edge</button>
      </div>
    </div>
  </details>`;
}

// Wire up the edge add/edit/delete affordances rendered by the two
// helpers above. `onChange` is called after any successful mutation so
// the caller can re-fetch and re-render.
function keGraphAttachEdgesUI(container, ownerId, sg, onChange) {
  const ae = container.querySelector('.ke-add-edge');
  if (ae) {
    const wInput = ae.querySelector('.ke-ae-weight');
    const wDisp  = ae.querySelector('.ke-ae-w-disp');
    wInput?.addEventListener('input', () => { wDisp.textContent = (+wInput.value).toFixed(2); });
    ae.querySelector('.ke-ae-create')?.addEventListener('click', async () => {
      const targetLabel = ae.querySelector('.ke-ae-target').value;
      const type        = ae.querySelector('.ke-ae-type').value.trim();
      const weight      = parseFloat(ae.querySelector('.ke-ae-weight').value);
      const resolved    = keResolveNodeLabel(targetLabel);
      if (resolved.missing)      { alert('No node with that label is loaded. Try refreshing.'); return; }
      if (resolved.id === ownerId) { alert('Pick a different target — self-edges aren\'t allowed.'); return; }
      if (resolved.ambiguous && !confirm('Multiple nodes share that label. Use the first match?')) return;
      if (!type) { alert('Relationship type is required.'); return; }
      const r = await fetch('/api/entity/graph/edges', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromId: ownerId, toId: resolved.id, type, weight }),
      });
      if (!r.ok) { alert(`Add failed: ${(await r.json()).error ?? r.status}`); return; }
      onChange();
    });
  }
  container.querySelectorAll('.ke-edge-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('.ke-edge-row');
      const eid = row?.dataset.edgeId;
      if (!eid) return;
      if (!confirm('Delete this edge? Auto-snapshot first.')) return;
      const r = await fetch(`/api/entity/graph/edges/${encodeURIComponent(eid)}`, { method: 'DELETE' });
      if (!r.ok) { alert(`Delete failed: ${(await r.json()).error ?? r.status}`); return; }
      onChange();
    });
  });
  container.querySelectorAll('.ke-edge-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const row  = btn.closest('.ke-edge-row');
      const eid  = row?.dataset.edgeId;
      const edge = (sg.edges ?? []).find(e => e.id === eid);
      if (!row || !edge) return;
      const cur = {
        type:   edge.type ?? edge.customType ?? 'related',
        weight: typeof edge.weight === 'number' ? edge.weight : 0.5,
      };
      const ed = document.createElement('div');
      ed.className = 'ke-edge-edit';
      ed.dataset.edgeId = eid;
      ed.innerHTML = `
        <input class="ke-ee-type" type="text" value="${esc(cur.type)}" list="ke-edge-types-dl" autocomplete="off">
        <label>Weight
          <input class="ke-ee-weight" type="range" min="0" max="1" step="0.05" value="${cur.weight}">
          <span class="ke-edge-weight-display ke-ee-w-disp">${cur.weight.toFixed(2)}</span>
        </label>
        <div class="ke-actions">
          <button class="btn-send  ke-ee-save"   type="button">Save</button>
          <button class="btn-ghost ke-ee-cancel" type="button">Cancel</button>
        </div>`;
      row.replaceWith(ed);
      const wIn = ed.querySelector('.ke-ee-weight');
      const wDi = ed.querySelector('.ke-ee-w-disp');
      wIn.addEventListener('input', () => { wDi.textContent = (+wIn.value).toFixed(2); });
      ed.querySelector('.ke-ee-cancel').addEventListener('click', () => onChange());
      ed.querySelector('.ke-ee-save').addEventListener('click', async () => {
        const body = {
          type:   ed.querySelector('.ke-ee-type').value.trim(),
          weight: parseFloat(wIn.value),
        };
        if (!body.type) { alert('Type is required.'); return; }
        const r = await fetch(`/api/entity/graph/edges/${encodeURIComponent(eid)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!r.ok) { alert(`Save failed: ${(await r.json()).error ?? r.status}`); return; }
        onChange();
      });
    });
  });
}

// ── New-node form (toolbar) ─────────────────────────────────────────────
function keGraphToggleNewNodeForm(show) {
  const f = $('ke-new-node-form');
  if (!f) return;
  const willShow = show ?? f.classList.contains('hidden');
  f.classList.toggle('hidden', !willShow);
  if (willShow) {
    $('ke-nn-label').value = '';
    $('ke-nn-type').value  = '';
    $('ke-nn-desc').value  = '';
    $('ke-nn-label').focus();
  }
}

async function keGraphCreateNewNode() {
  const label       = $('ke-nn-label').value.trim();
  const type        = $('ke-nn-type').value.trim();
  const description = $('ke-nn-desc').value.trim();
  if (!label) { alert('Label is required.'); $('ke-nn-label').focus(); return; }
  const body = { label };
  if (type)        body.type        = type;
  if (description) body.description = description;
  const r = await fetch('/api/entity/graph/nodes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) { alert(`Create failed: ${(await r.json()).error ?? r.status}`); return; }
  const created = await r.json().catch(() => ({}));
  const newId   = created?.node?.id ?? created?.id;
  keGraphToggleNewNodeForm(false);
  if (_keGraphView === 'map') {
    await keLoadGraphMap();
    if (newId) {
      const node = keGraphMapInstance().getNode(newId);
      if (node) {
        // Open popover anchored to the new node's screen position.
        const { x: sx, y: sy } = keGraphMapInstance().screenOf(node);
        keGraphOpenPopover(node, sx, sy);
      }
    }
  } else {
    await keLoadGraphNodes();
    if (newId) keOpenGraphNode(newId);
  }
}

// ── Inline editor popover ───────────────────────────────────────────────
let _kePopoverNodeId = null;
let _kePopoverDragged = false;

function keGraphClosePopover() {
  const pop = $('ke-graph-popover');
  if (pop) pop.classList.add('hidden');
  _kePopoverNodeId  = null;
  _kePopoverDragged = false;
}

// Drag the popover by its header so the user can move it out from
// behind itself when it covers something they want to click.
function keGraphInitPopoverDrag(pop) {
  const head = pop.querySelector('.ke-graph-popover-head');
  if (!head) return;
  head.addEventListener('mousedown', e => {
    // Don't start a drag from the ✕ button.
    if (e.target.closest('.ke-graph-popover-close')) return;
    e.preventDefault();
    const map  = $('ke-graph-map').getBoundingClientRect();
    const popR = pop.getBoundingClientRect();
    const offX = e.clientX - popR.left;
    const offY = e.clientY - popR.top;
    head.style.cursor = 'grabbing';
    const onMove = ev => {
      const mr = $('ke-graph-map').getBoundingClientRect();
      let x = ev.clientX - mr.left - offX;
      let y = ev.clientY - mr.top  - offY;
      x = Math.max(6, Math.min(x, mr.width  - pop.offsetWidth  - 6));
      y = Math.max(6, Math.min(y, mr.height - pop.offsetHeight - 6));
      pop.style.left = `${x}px`;
      pop.style.top  = `${y}px`;
      _kePopoverDragged = true;
    };
    const onUp = () => {
      head.style.cursor = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

function keGraphPositionPopover(pop, clientX, clientY) {
  const map = $('ke-graph-map');
  const r   = map.getBoundingClientRect();
  pop.style.left = `${(clientX - r.left) + 14}px`;
  pop.style.top  = `${(clientY - r.top)  + 14}px`;
  // Clamp on next frame once the popover has been laid out.
  requestAnimationFrame(() => {
    const pr = pop.getBoundingClientRect();
    let nx = pr.left - r.left, ny = pr.top - r.top;
    if (pr.right  > r.right  - 6) nx = r.width  - pr.width  - 10;
    if (pr.bottom > r.bottom - 6) ny = r.height - pr.height - 10;
    pop.style.left = `${Math.max(6, nx)}px`;
    pop.style.top  = `${Math.max(6, ny)}px`;
  });
}

async function keGraphOpenPopover(node, clientX, clientY) {
  const pop = $('ke-graph-popover');
  // Reset the dragged flag when opening on a different node — but
  // preserve the user's manual position when re-rendering the same one
  // (e.g. after Save reloads the popover).
  const sameNode = (_kePopoverNodeId === node.id);
  if (!sameNode) _kePopoverDragged = false;
  _kePopoverNodeId = node.id;
  pop.innerHTML = '<p class="logs-loading">Loading…</p>';
  pop.classList.remove('hidden');
  if (!_kePopoverDragged) keGraphPositionPopover(pop, clientX, clientY);
  try {
    const res = await fetch(`/api/entity/graph/nodes/${encodeURIComponent(node.id)}/subgraph?depth=1`);
    if (!res.ok) throw new Error(await keReadServerError(res));
    const sg   = await res.json();
    const self = (sg.nodes ?? []).find(n => n.id === node.id) ?? node;
    const edgesHtml = (sg.edges ?? []).map(e => keGraphEdgeRowHTML(node.id, e, sg)).join('');
    // Audience dropdown — "just us" plus every Village circle (shared with the
    // memory editor). A node is private by default; this is the deliberate
    // widen/tighten surface for the human (the Familiar has the same control via
    // update_graph_node). Village unreachable → ward-private only; harmless.
    let audCats = [];
    try { audCats = (await vlFetch())?.categories ?? []; } catch { /* keep ward-private only */ }
    const audOptions = keAudienceOptionsHTML(self.audience, audCats);
    pop.innerHTML = `
      <div class="ke-graph-popover-head">
        <h3>${esc(self.label ?? node.id)}</h3>
        <button class="ke-graph-popover-close" type="button" aria-label="Close" id="ke-pop-close">✕</button>
      </div>
      <div class="field"><label>Label</label><input id="ke-pop-label" type="text" value="${esc(self.label ?? '')}"></div>
      <div class="field"><label>Type</label><input  id="ke-pop-type"  type="text" value="${esc(self.type  ?? '')}" list="ke-node-types-dl"></div>
      <div class="field"><label>Description</label><textarea id="ke-pop-desc" rows="3">${esc(self.description ?? '')}</textarea></div>
      <div class="field"><label>Audience <span class="field-hint">(where this may surface)</span></label><select id="ke-pop-audience">${audOptions}</select></div>
      <div class="ke-actions">
        <button id="ke-pop-save"   class="btn-send"  type="button">Save</button>
        <button id="ke-pop-delete" class="btn-ghost ke-danger" type="button">Delete node</button>
      </div>
      <h4 class="ke-subhead">Edges (${(sg.edges ?? []).length})</h4>
      <div class="ke-edges">${edgesHtml || '<p class="logs-empty">No edges.</p>'}</div>
      ${keGraphAddEdgeFormHTML()}`;

    keUpdateNodeTypes([self, ...(sg.nodes ?? [])]);
    keUpdateEdgeTypes(sg.edges ?? []);
    keGraphInitPopoverDrag(pop);

    pop.querySelector('#ke-pop-close').addEventListener('click', keGraphClosePopover);

    pop.querySelector('#ke-pop-save').addEventListener('click', async () => {
      const body = {
        label:       $('ke-pop-label').value,
        type:        $('ke-pop-type').value,
        description: $('ke-pop-desc').value,
        audience:    $('ke-pop-audience')?.value || 'ward-private',
      };
      const r = await fetch(`/api/entity/graph/nodes/${encodeURIComponent(node.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!r.ok) { alert(`Save failed: ${(await r.json()).error ?? r.status}`); return; }
      Object.assign(node, body);
      keGraphMapInstance().refresh();   // type may have changed → recolour + legend
      keGraphOpenPopover(node, clientX, clientY);
    });

    pop.querySelector('#ke-pop-delete').addEventListener('click', async () => {
      if (!confirm('Delete this node and ALL its edges? An auto-snapshot is taken first.')) return;
      const r = await fetch(`/api/entity/graph/nodes/${encodeURIComponent(node.id)}`, { method: 'DELETE' });
      if (!r.ok) { alert(`Delete failed: ${(await r.json()).error ?? r.status}`); return; }
      keGraphClosePopover();
      await keLoadGraphMap();   // refetch so the canvas drops the node + its edges
    });

    // Add / edit / delete edges share the same handler; on success we
    // both update the in-memory map (so the canvas redraws right) and
    // re-open the popover so its edge list refreshes.
    keGraphAttachEdgesUI(pop, node.id, sg, async () => {
      // Re-fetch the full graph so newly-added or removed edges show up
      // on the canvas. Old positions are preserved for nodes that still
      // exist, so the layout doesn't snap.
      const startId = node.id;
      await keLoadGraphMap();
      // The await can take a while on a big graph; if the user clicked
      // a different node in the meantime, don't yank their popover back.
      if (_kePopoverNodeId !== startId) return;
      const refreshed = keGraphMapInstance().getNode(startId);
      keGraphOpenPopover(refreshed ?? node, clientX, clientY);
    });
  } catch (err) {
    pop.innerHTML = `<p class="logs-error">⚠ ${esc(err.message || String(err))}</p>
      <div class="ke-actions"><button class="btn-ghost" type="button" id="ke-pop-close">Close</button></div>`;
    pop.querySelector('#ke-pop-close').addEventListener('click', keGraphClosePopover);
  }
}

// ── Identity tab ────────────────────────────────────────────────────────
async function keLoadIdentity() {
  const list = $('ke-id-list');
  list.innerHTML = '<p class="logs-loading">Loading…</p>';
  try {
    const res = await fetch('/api/entity/identity');
    if (!res.ok) throw new Error(await keReadServerError(res));
    const data = await res.json();
    list.innerHTML = '';
    let any = false;
    for (const category of ['self', 'ward', 'relationship', 'custom']) {
      const files = data[category] ?? [];
      const isWard = category === 'ward';
      if (!files.length && !isWard) continue;
      const header = document.createElement('div');
      header.className = 'ke-row-header';
      header.textContent = category;
      list.appendChild(header);
      for (const f of files) {
        any = true;
        const row = document.createElement('div');
        row.className = 'ke-row';
        row.innerHTML = `
          <div class="ke-row-title">${esc(f.filename)}</div>
          <div class="ke-row-sub">${esc((f.content ?? '').slice(0, 100).replace(/\n/g, ' '))}</div>`;
        row.addEventListener('click', () => keOpenIdentity(category, f));
        list.appendChild(row);
      }
      if (isWard) {
        // Always expose Remember settings even when there are no ward files yet.
        any = true;
        const rmRow = document.createElement('div');
        rmRow.className = 'ke-row ke-row-settings';
        rmRow.innerHTML = `
          <div class="ke-row-title">Remember settings</div>
          <div class="ke-row-sub">Memory storage policy per category</div>`;
        rmRow.addEventListener('click', keOpenRememberMap);
        list.appendChild(rmRow);
      }
    }
    if (!any) list.innerHTML = '<p class="logs-empty">No identity files yet.</p>';
  } catch (err) { list.innerHTML = keError(err, 'Failed to load identity.'); }
}

function keOpenIdentity(category, file) {
  // Parse markdown sections (## heading lines)
  const text = file.content ?? '';
  const lines = text.split('\n');
  const sections = [];
  let current = { heading: '(top)', body: [] };
  for (const line of lines) {
    const m = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (m) { sections.push(current); current = { heading: m[1].trim(), body: [] }; }
    else current.body.push(line);
  }
  sections.push(current);
  const det = $('ke-id-detail');
  const sectionsHtml = sections.map((s, i) => `
    <div class="ke-section">
      <div class="ke-section-head">${esc(s.heading)}</div>
      <textarea class="ke-textarea ke-id-section" rows="6" data-section="${esc(s.heading)}">${esc(s.body.join('\n').trim())}</textarea>
      <div class="ke-actions">
        <button class="btn-send ke-id-save" data-section="${esc(s.heading)}" ${s.heading === '(top)' ? 'disabled title="Top-of-file content has no heading to target — edit the file manually for now."' : ''}>Save section</button>
      </div>
    </div>`).join('');
  det.innerHTML = `
    <div class="ke-detail-header"><h3>${esc(category)} / ${esc(file.filename)}</h3></div>
    <p class="field-hint">Each section here corresponds to a markdown heading in the file. Saving a section rewrites just that heading's body via identity_rewrite_section; an auto-snapshot is taken first.</p>
    ${sectionsHtml}`;
  det.querySelectorAll('.ke-id-save').forEach(btn => {
    btn.addEventListener('click', async () => {
      const sec = btn.dataset.section;
      const ta  = det.querySelector(`textarea.ke-id-section[data-section="${sec.replace(/"/g, '\\"')}"]`);
      const r = await fetch(
        `/api/entity/identity/${encodeURIComponent(category)}/${encodeURIComponent(file.filename)}/sections/${encodeURIComponent(sec)}`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: ta.value }) },
      );
      if (!r.ok) { alert(`Save failed: ${(await r.json()).error ?? r.status}`); return; }
      keLoadIdentity();
    });
  });
}

// ── Remember-consent map ─────────────────────────────────────────────────────
async function keOpenRememberMap() {
  const det = $('ke-id-detail');
  det.innerHTML = '<p class="logs-loading">Loading remember settings…</p>';
  try {
    const res = await fetch('/api/entity/ward/remember');
    if (!res.ok) throw new Error(await keReadServerError(res));
    const data = await res.json();
    const map = data.map ?? {};
    const categories = ['basics', 'emotional_content', 'health_info', 'relationships', 'whereabouts'];
    const labels = {
      basics: 'Basics (name, age, daily facts)',
      emotional_content: 'Emotional content (feelings, struggles)',
      health_info: 'Health information (meds, conditions)',
      relationships: 'Relationships (family, friends)',
      whereabouts: 'Whereabouts (location, travel)',
    };
    function selFor(cat) {
      const v = map[cat];
      const opts = [
        `<option value="true"  ${v === true   ? 'selected' : ''}>Store freely</option>`,
        `<option value="ask"   ${v === 'ask'  ? 'selected' : ''}>Ask first (consent_pending)</option>`,
        `<option value="false" ${v === false  ? 'selected' : ''}>Never store</option>`,
      ].join('');
      return `<select id="rm-${cat}" class="ke-select">${opts}</select>`;
    }
    const rows = categories.map(cat => `
      <div class="ke-meta-row">
        <label class="ke-meta-label" for="rm-${cat}">${esc(labels[cat])}</label>
        ${selFor(cat)}
      </div>`).join('');
    det.innerHTML = `
      <div class="ke-detail-header"><h3>Ward · Remember settings</h3></div>
      <p class="field-hint">Controls how I handle information about <strong>my human themselves</strong>, per category.
        (For other people in the Village, set memory consent per-person in the Village editor.)
        "Store freely" means I remember it immediately.
        "Ask first" means I store it as pending and surface it for confirmation.
        "Never store" means I drop it silently — use with care.</p>
      ${rows}
      <div class="ke-actions">
        <button id="ke-rm-save" class="btn-send">Save</button>
      </div>`;
    $('ke-rm-save').addEventListener('click', async () => {
      const newMap = {};
      for (const cat of categories) {
        const raw = det.querySelector(`#rm-${cat}`)?.value;
        newMap[cat] = raw === 'true' ? true : raw === 'false' ? false : 'ask';
      }
      const r = await fetch('/api/entity/ward/remember', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ map: newMap }),
      });
      if (!r.ok) { alert(`Save failed: ${(await r.json()).error ?? r.status}`); return; }
      alert('Remember settings saved.');
      keOpenRememberMap();
    });
  } catch (err) { det.innerHTML = keError(err, 'Failed to load remember settings.'); }
}

// ── Snapshots tab ───────────────────────────────────────────────────────
async function keLoadSnapshots() {
  const list = $('ke-snap-list');
  list.innerHTML = '<p class="logs-loading">Loading…</p>';
  try {
    const res  = await fetch('/api/entity/snapshots');
    if (!res.ok) throw new Error(await keReadServerError(res));
    const data = await res.json();
    const snaps = data.snapshots ?? data ?? [];
    if (!snaps.length) { list.innerHTML = '<p class="logs-empty">No snapshots yet.</p>'; return; }
    list.innerHTML = '';
    for (const s of snaps) {
      const row = document.createElement('div');
      row.className = 'ke-row';
      row.innerHTML = `
        <div class="ke-row-title">${esc(s.id ?? s.snapshotId ?? 'snapshot')}</div>
        <div class="ke-row-sub">${esc(s.createdAt ?? s.date ?? '')}</div>
        <div class="ke-actions">
          <button class="btn-secondary ke-snap-restore" data-id="${esc(s.id ?? s.snapshotId)}">Restore</button>
        </div>`;
      list.appendChild(row);
    }
    list.querySelectorAll('.ke-snap-restore').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Restore this snapshot? This will overwrite the CURRENT memory / identity / graph state with the snapshot contents.')) return;
        const r = await fetch(`/api/entity/snapshots/${encodeURIComponent(btn.dataset.id)}/restore`, { method: 'POST' });
        if (!r.ok) { alert(`Restore failed: ${(await r.json()).error ?? r.status}`); return; }
        alert('Snapshot restored.');
      });
    });
  } catch (err) { list.innerHTML = keError(err, 'Failed to load snapshots.'); }
}

async function keCreateSnapshot() {
  const r = await fetch('/api/entity/snapshots', { method: 'POST' });
  if (!r.ok) { alert(`Snapshot failed: ${(await r.json()).error ?? r.status}`); return; }
  keLoadSnapshots();
}

// ── Backup / restore (Pillar H) ──────────────────────────────────────────
async function keExportBackup() {
  const pass = $('ke-backup-pass').value;
  const out  = $('ke-backup-result');
  if (!pass || pass.length < 4) { out.textContent = 'Passphrase must be at least 4 characters.'; return; }
  out.textContent = 'Encrypting…';
  try {
    const r = await fetch('/api/entity/backup/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: pass }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error ?? r.status);
    out.innerHTML = `Backed up to <code>${esc(data.filePath)}</code> (${Math.round((data.sizeBytes ?? 0) / 1024)} KB). Keep this file and your passphrase safe.`;
    $('ke-backup-pass').value = '';
  } catch (err) { out.textContent = `Backup failed: ${err.message}`; }
}

async function keRestoreBackup() {
  const filePath = $('ke-backup-path').value.trim();
  const pass     = $('ke-backup-restore-pass').value;
  const out      = $('ke-backup-result');
  if (!filePath) { out.textContent = 'Enter the backup file path to restore from.'; return; }
  if (!pass)     { out.textContent = 'Enter the passphrase for the backup.'; return; }
  if (!confirm('Restore from this backup? This OVERWRITES the current memory / identity / graph state entirely.')) return;
  out.textContent = 'Restoring…';
  try {
    const r = await fetch('/api/entity/backup/restore', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath, passphrase: pass }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error ?? r.status);
    out.textContent = `Restored from ${data.restoredFrom}. The Familiar is reconnecting to the restored self.`;
    $('ke-backup-restore-pass').value = '';
  } catch (err) { out.textContent = `Restore failed: ${err.message}`; }
}

// ── Tome entry editor ─────────────────────────────────────────────

// Cache-safety lock for lore-entry positions. System-message positions
// (0–3) live in the cacheable prompt prefix; a non-constant
// (keyword-triggered) entry there flips on/off between turns and
// invalidates the upstream prefix cache each time. So restrict those
// positions to constant entries — non-constant entries must inject
// @ depth (4), which sits below the cached prefix in the conversation.
// Reactive: disables the system options + snaps to @depth when the
// "constant" box is unchecked.
function applyLorePositionLock() {
  const constant = $('lore-ed-constant').checked;
  const sel = $('lore-ed-position');
  for (const opt of sel.options) {
    opt.disabled = (opt.value !== '4') && !constant;
  }
  if (!constant && sel.value !== '4') {
    sel.value = '4';
    sel.dispatchEvent(new Event('change')); // refresh depth/role field visibility
  }
  const hint = $('lore-ed-position-lock-hint');
  if (hint) hint.classList.toggle('hidden', constant);
}

// Bulk action: relocate every non-constant entry that's sitting in a
// system-message position (0–3, the cache-breaking ones) to @ depth 4.
// Constant entries and entries already @ depth are left untouched —
// they're already cache-safe. Operates on the currently-open tome.
async function moveNonConstantToDepth() {
  if (!_currentTomeId) return;
  const tomeName = state.tomeCache[_currentTomeId]?.name ?? 'this tome';
  if (!confirm(
    `Move every non-constant entry in "${tomeName}" that's in a system-message position to @ chat depth 4?\n\n` +
    `Keyword-triggered (non-constant) entries in the system message break the prompt cache when they flip on and off. ` +
    `This relocates them below the cached prefix. Constant entries, and entries already @ depth, are left as they are.`
  )) return;
  try {
    const res = await fetch(`/api/tomes/${_currentTomeId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tomeData = await res.json();
    const entries = tomeData.entries ?? {};
    let moved = 0;
    for (const uid of Object.keys(entries)) {
      const e = entries[uid];
      if (e.constant !== true && normEntryPos(e.position) !== 4) {
        e.position = 4;
        e.depth = 4;
        moved++;
      }
    }
    if (moved === 0) {
      alert('Nothing to move — every non-constant entry is already @ depth (or all entries are constant).');
      return;
    }
    await fetch(`/api/tomes/${_currentTomeId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    });
    state.tomeCache[_currentTomeId] = tomeData;
    refreshTomeEntriesList();
    alert(`Moved ${moved} non-constant ${moved === 1 ? 'entry' : 'entries'} to @ depth 4.`);
  } catch (err) {
    alert(`Failed to move entries: ${err.message}`);
  }
}

function openLoreEditor(uid) {
  _loreEditUid = uid ?? null;
  const entry  = uid ? (state.tomeCache[_currentTomeId]?.entries[uid] ?? {}) : {};

  $('lore-editor-title').textContent = uid ? 'Edit Entry' : 'New Entry';

  // Basic
  $('lore-ed-comment').value    = entry.comment ?? '';
  $('lore-ed-keys').value       = (entry.keys ?? []).join(', ');
  $('lore-ed-content').value    = entry.content ?? '';
  $('lore-ed-enabled').checked  = entry.enabled !== false;
  $('lore-ed-constant').checked = entry.constant ?? false;
  $('lore-ed-order').value      = entry.insertion_order ?? 100;

  // Selective
  const selective = entry.selective ?? false;
  $('lore-ed-selective').checked = selective;
  $('lore-ed-secondary-section').classList.toggle('hidden', !selective);
  $('lore-ed-keysecondary').value = (entry.keysecondary ?? []).join(', ');
  $('lore-ed-logic').value        = String(entry.selectiveLogic ?? 0);

  // Scan & matching
  const sd = entry.scanDepth;
  $('lore-ed-scan-depth').value = (sd !== null && sd !== undefined) ? String(sd) : '';
  const cs = entry.caseSensitive;
  $('lore-ed-case').value       = cs === true ? 'true' : cs === false ? 'false' : '';
  const ww = entry.matchWholeWords;
  $('lore-ed-whole-word').value = ww === true ? 'true' : ww === false ? 'false' : '';

  // Injection position
  const pos = normEntryPos(entry.position);
  $('lore-ed-position').value = String(pos);
  const isAtDepth = pos === 4;
  $('lore-ed-depth-field').classList.toggle('hidden', !isAtDepth);
  $('lore-ed-role-field').classList.toggle('hidden', !isAtDepth);
  $('lore-ed-depth').value = entry.depth ?? 4;
  $('lore-ed-role').value  = String(entry.role ?? 0);
  // Enforce the constant-only-in-prefix rule for the loaded entry
  // (also corrects a legacy non-constant system-position entry to
  // @depth in the UI; saving then persists the fix).
  applyLorePositionLock();

  // Timing
  const prob = entry.probability ?? 100;
  $('lore-ed-probability').value     = prob;
  $('lore-ed-prob-display').textContent = `${prob}%`;
  const st = entry.sticky;
  $('lore-ed-sticky').value   = (st !== null && st !== undefined) ? String(st) : '';
  const cd = entry.cooldown;
  $('lore-ed-cooldown').value = (cd !== null && cd !== undefined) ? String(cd) : '';

  // Recursion
  $('lore-ed-prevent-recursion').checked = entry.preventRecursion    ?? false;
  $('lore-ed-delay-recursion').checked   = entry.delayUntilRecursion ?? false;
  $('lore-ed-exclude-recursion').checked = entry.excludeRecursion    ?? false;

  // Group
  $('lore-ed-group').value        = entry.group ?? '';
  const gw = entry.groupWeight;
  $('lore-ed-group-weight').value = (gw !== null && gw !== undefined) ? String(gw) : '';

  // learnedAt — read-only, shown only when the field is present
  const learnedEl = $('lore-ed-learned-at');
  if (learnedEl) {
    if (entry.learnedAt) {
      learnedEl.textContent = `Learned: ${new Date(entry.learnedAt).toLocaleString()}`;
      learnedEl.classList.remove('hidden');
    } else {
      learnedEl.classList.add('hidden');
    }
  }

  $('lore-editor-modal').classList.remove('hidden');
  bindResizableModal('lore-editor-modal-inner', 'pf-lore-editor-modal-size');
}

function closeLoreEditor() {
  $('lore-editor-modal').classList.add('hidden');
  _loreEditUid = null;
}

async function saveLoreEditorEntry() {
  const content = $('lore-ed-content').value.trim();
  if (!content) { alert('Content is required.'); return; }

  const uid      = _loreEditUid || generateId();
  const existing = _loreEditUid
    ? (state.tomeCache[_currentTomeId]?.entries?.[uid] ?? {})
    : {};

  const keysRaw    = $('lore-ed-keys').value;
  const keys       = keysRaw.split(',').map(k => k.trim()).filter(Boolean);
  const ksecRaw    = $('lore-ed-keysecondary').value;
  const keysecondary = ksecRaw.split(',').map(k => k.trim()).filter(Boolean);

  const sdRaw      = $('lore-ed-scan-depth').value.trim();
  const scanDepth  = sdRaw === '' ? null : Math.max(0, parseInt(sdRaw, 10) || 0);
  const csVal      = $('lore-ed-case').value;
  const caseSensitive   = csVal === 'true' ? true : csVal === 'false' ? false : null;
  const wwVal      = $('lore-ed-whole-word').value;
  const matchWholeWords = wwVal === 'true' ? true : wwVal === 'false' ? false : null;

  const stRaw   = $('lore-ed-sticky').value.trim();
  const sticky  = stRaw === '' ? null : Math.max(0, parseInt(stRaw, 10) || 0);
  const cdRaw   = $('lore-ed-cooldown').value.trim();
  const cooldown = cdRaw === '' ? null : Math.max(0, parseInt(cdRaw, 10) || 0);
  const gwRaw   = $('lore-ed-group-weight').value.trim();
  const groupWeight = gwRaw === '' ? null : Math.max(0, parseInt(gwRaw, 10) || 0);

  const entry = {
    ...existing,
    uid,
    comment:             $('lore-ed-comment').value.trim(),
    keys,
    keysecondary,
    content,
    constant:            $('lore-ed-constant').checked,
    selective:           $('lore-ed-selective').checked,
    selectiveLogic:      parseInt($('lore-ed-logic').value, 10) || 0,
    enabled:             $('lore-ed-enabled').checked,
    position:            parseInt($('lore-ed-position').value, 10) || 0,
    depth:               parseInt($('lore-ed-depth').value, 10) || 4,
    role:                parseInt($('lore-ed-role').value, 10) || 0,
    insertion_order:     parseInt($('lore-ed-order').value, 10) || 100,
    scanDepth,
    caseSensitive,
    matchWholeWords,
    probability:         parseInt($('lore-ed-probability').value, 10) ?? 100,
    sticky,
    cooldown,
    preventRecursion:    $('lore-ed-prevent-recursion').checked,
    delayUntilRecursion: $('lore-ed-delay-recursion').checked,
    excludeRecursion:    $('lore-ed-exclude-recursion').checked,
    group:               $('lore-ed-group').value.trim(),
    groupWeight,
    created_at:          existing.created_at ?? new Date().toISOString(),
    session_id:          existing.session_id ?? state.sessionId,
    message_range:       existing.message_range ?? null,
  };

  // Cache-safety backstop. The editor UI prevents this, but an imported
  // tome or a hand-edited JSON could still carry a non-constant entry in
  // a system-message position (0–3) — which would invalidate the prompt
  // prefix cache. Force such entries to @ depth (4).
  if (!entry.constant && entry.position !== 4) {
    entry.position = 4;
    if (!entry.depth) entry.depth = 4;
  }

  try {
    if (!_currentTomeId) throw new Error('No tome selected.');
    const tomeRes = await fetch(`/api/tomes/${_currentTomeId}`);
    if (!tomeRes.ok) throw new Error(`HTTP ${tomeRes.status}`);
    const tomeData = await tomeRes.json();
    tomeData.entries[uid] = entry;
    await fetch(`/api/tomes/${_currentTomeId}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: tomeData.entries }),
    });
    state.tomeCache[_currentTomeId] = tomeData;
    closeLoreEditor();
    refreshTomeEntriesList();
  } catch (err) {
    alert(`Failed to save entry: ${err.message}`);
  }
}

// ── Temporal editor (Unruh inspection / threat / ponderings) — M9 ──
//
// Modal mirrors the Knowledge editor pattern (reuses .ke-* CSS).
// Read-mostly: shows live + standing interests with decay metadata,
// current threat state + audit history (with reset button), and the
// Familiar's autonomous ponderings (with per-entry delete). CRUD on
// interests beyond demote is deferred to a later pass — for now the
// observable surface is enough for catching bugs.

const TE_TABS = ['interests', 'threat', 'ponderings', 'schedule', 'routine', 'handoff'];

function openTemporalModal() {
  $('temporal-modal').classList.remove('hidden');
  bindResizableModal('temporal-modal-inner', 'pf-temporal-modal-size');
  teSwitchTab('interests');
}
function closeTemporalModal() {
  $('temporal-modal').classList.add('hidden');
}

function teSwitchTab(name) {
  if (!TE_TABS.includes(name)) return;
  for (const t of TE_TABS) {
    const btn  = document.querySelector(`[data-temporal-tab="${t}"]`);
    const pane = $(`te-pane-${t}`);
    if (btn)  btn.classList.toggle('ke-tab-active',  t === name);
    if (pane) pane.classList.toggle('ke-pane-active', t === name);
  }
  if      (name === 'interests')  teLoadInterests();
  else if (name === 'threat')     teLoadThreat();
  else if (name === 'ponderings') teLoadPonderings();
  else if (name === 'schedule')   teReloadScheduleView();
  else if (name === 'routine')    teLoadRoutine();
  else if (name === 'handoff')    teLoadHandoff();
}

function teEscapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Local <-> UTC conversion helpers for the temporal editor ────────
//
// All Unruh storage is ISO-8601 UTC. The browser UI takes / shows
// times in the user's local timezone. These helpers bridge the two
// so a phase set to "10pm" really fires at 10pm by the user's clock,
// not at 22:00 UTC.

// "HH:MM" in user's LOCAL time, today's local date → ISO UTC string.
function teLocalTimeTodayToIsoUtc(hhmm) {
  if (!/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  const [hh, mm] = hhmm.split(':').map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  const now = new Date();
  const local = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
  return local.toISOString();
}

// <input type="datetime-local"> value ("YYYY-MM-DDTHH:MM"), which the
// browser hands back as user's LOCAL wall-clock time with no offset →
// ISO UTC string. Returns null on empty/invalid input.
function teDatetimeLocalToIsoUtc(value) {
  if (!value || typeof value !== 'string') return null;
  // new Date("YYYY-MM-DDTHH:MM") parses as LOCAL time per spec.
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// ISO UTC → local "HH:MM" for display in the routine list.
function teIsoUtcToLocalHhMm(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '?';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// ISO UTC → "YYYY-MM-DDTHH:MM" for pre-filling a datetime-local input
// from an existing schedule node.
function teIsoUtcToDatetimeLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ISO UTC → friendly local datetime string for list rows ("today 22:00",
// "tomorrow 09:30", "Mon 10:00", "May 30 14:00"). Keeps the timezone
// implicit (the user's own) — no offset noise.
function teIsoUtcToLocalFriendly(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay   = d.toDateString() === now.toDateString();
  const tomorrow  = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay)    return `today ${hh}:${mm}`;
  if (isTomorrow) return `tomorrow ${hh}:${mm}`;
  // Within a week: weekday + time; otherwise full date + time.
  const diffDays = (d - now) / (24 * 60 * 60_000);
  if (diffDays > -7 && diffDays < 7) {
    return d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function teTimeAgo(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const min = ms / 60_000;
  if (min < 1)  return 'just now';
  if (min < 60) return `${Math.round(min)} min ago`;
  const hr = min / 60;
  if (hr  < 24) return `${hr.toFixed(1)} hr ago`;
  const day = hr / 24;
  return `${day.toFixed(1)} days ago`;
}

// ── Interests tab ─────────────────────────────────────────────────

async function teLoadInterests() {
  const list = $('te-int-list');
  if (!list) return;
  list.innerHTML = '<p class="logs-empty">Loading…</p>';
  try {
    const [r, rb] = await Promise.all([
      fetch('/api/temporal/interests?limit=100'),
      fetch('/api/temporal/bookmarks?limit=100'),
    ]);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (data.ok === false) throw new Error(data.error || 'unruh unavailable');
    const bmData = rb.ok ? await rb.json() : { bookmarks: [] };

    const live      = Array.isArray(data.live)           ? data.live           : [];
    const standing  = Array.isArray(data.standing)       ? data.standing       : [];
    const bookmarks = Array.isArray(bmData.bookmarks)    ? bmData.bookmarks    : [];

    const intSummary = $('te-int-summary');
    if (intSummary) intSummary.textContent = `${live.length} live · ${standing.length} standing · ${bookmarks.length} bookmarks`;

    const html = [];
    if (standing.length) {
      html.push('<h4 style="margin: 8px 12px 4px 12px">Standing values (always-on)</h4>');
      for (const s of standing) html.push(teRenderInterest(s, true));
    }
    if (live.length) {
      html.push('<h4 style="margin: 12px 12px 4px 12px">Live interests (decay over time)</h4>');
      for (const i of live) html.push(teRenderInterest(i, false));
    }
    if (bookmarks.length) {
      html.push('<h4 style="margin: 12px 12px 4px 12px">Bookmarks (idle surfacing)</h4>');
      for (const bm of bookmarks) html.push(teRenderBookmark(bm));
    }
    if (!standing.length && !live.length && !bookmarks.length) {
      html.push('<p class="logs-empty">No interests yet. They accrue as you chat — see thalamus.recordInterest.</p>');
    }
    list.innerHTML = html.join('');
    list.querySelectorAll('.te-int-bump').forEach(btn => {
      btn.addEventListener('click', () => teBumpInterest(btn.dataset.intLabel));
    });
    list.querySelectorAll('.te-int-demote').forEach(btn => {
      btn.addEventListener('click', () => teDemoteStanding(btn.dataset.intId));
    });
  } catch (err) {
    list.innerHTML = `<p class="logs-empty">Failed to load: ${teEscapeHtml(err.message)}</p>`;
  }
}

async function teBumpInterest(label) {
  const raw = prompt(`Bump weight for "${label}" by how much?\n\nPositive number; typical engagement bumps are 0.5 – 3.0.`, '1');
  if (raw == null) return;
  const delta = parseFloat(raw);
  if (!Number.isFinite(delta) || delta <= 0) { alert('Enter a positive number.'); return; }
  try {
    const r = await fetch('/api/temporal/interests/bump', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: label, delta, source: 'manual_ui' }),
    }).then(r => r.json());
    if (!r.ok) throw new Error(r.error || 'bump failed');
    teLoadInterests();
  } catch (err) {
    alert(`Bump failed: ${err.message}`);
  }
}

async function teDemoteStanding(id) {
  if (!confirm('Demote this standing value to a regular live interest?\n\nIt will start decaying like any other live interest from this moment on. The original payload (value_ref, etc.) is preserved.')) return;
  try {
    const r = await fetch(`/api/temporal/interests/${encodeURIComponent(id)}/demote`, { method: 'POST' }).then(r => r.json());
    if (!r.ok) throw new Error(r.error || 'demote failed');
    teLoadInterests();
  } catch (err) {
    alert(`Demote failed: ${err.message}`);
  }
}

function teRenderInterest(i, isStanding) {
  const w     = Number(i.weight);
  const raw   = Number(i.raw_weight);
  const tier  = teEscapeHtml(i.tier ?? '?');
  const label = teEscapeHtml(i.label ?? '(no label)');
  const id    = teEscapeHtml(i.id ?? '');
  const lt    = teTimeAgo(i.last_touched);
  const ref   = i.value_ref ? `<div style="font-size: 0.85em; opacity: 0.7">anchor: <code>${teEscapeHtml(i.value_ref)}</code></div>` : '';
  const decayed = (!isStanding && Number.isFinite(raw) && Number.isFinite(w) && Math.abs(raw - w) > 0.01)
    ? ` <span style="opacity:0.6">(raw ${raw.toFixed(2)}, decayed)</span>` : '';
  const actions = isStanding
    ? `<button class="btn-ghost te-int-demote" data-int-id="${id}" style="font-size: 0.8em; padding: 2px 8px" title="Demote to live interest (lets it start decaying)">Demote</button>`
    : `<button class="btn-ghost te-int-bump"   data-int-label="${label}" style="font-size: 0.8em; padding: 2px 8px" title="Manually bump this interest's weight">+ Bump</button>`;
  return `
    <div style="padding: 8px 12px; border-bottom: 1px solid var(--border-subtle, #2a2a2a)">
      <div style="display: flex; gap: 8px; align-items: baseline">
        <strong style="flex: 1">${label}</strong>
        <span style="font-family: monospace">${Number.isFinite(w) ? w.toFixed(2) : '?'}${decayed}</span>
        <span style="font-size: 0.85em; opacity: 0.7; padding: 1px 6px; border: 1px solid var(--border-subtle, #2a2a2a); border-radius: 3px">${tier}</span>
        ${actions}
      </div>
      <div style="font-size: 0.85em; opacity: 0.7; margin-top: 2px">last touched ${lt}</div>
      ${ref}
    </div>`;
}

function teRenderBookmark(bm) {
  const label       = teEscapeHtml(bm.label ?? '(no label)');
  const topicLabel  = teEscapeHtml(bm.topic_label ?? '');
  const resource    = bm.payload?.resource ? teEscapeHtml(bm.payload.resource) : null;
  const note        = bm.payload?.note     ? teEscapeHtml(bm.payload.note)     : null;
  const interval    = Number.isFinite(Number(bm.resurface_after_hours))
    ? `resurfaces after ${Number(bm.resurface_after_hours).toFixed(0)}h`
    : '';
  const lastSurfaced = bm.last_surfaced_at
    ? `last surfaced ${teTimeAgo(bm.last_surfaced_at)}`
    : 'never surfaced';
  const outcome = bm.last_surfacing_outcome
    ? `<span style="padding: 1px 6px; border-radius: 3px; font-size: 0.8em; background: ${bm.last_surfacing_outcome === 'engaged' ? 'rgba(80,180,80,0.18)' : 'rgba(180,80,80,0.18)'}; border: 1px solid var(--border-subtle, #2a2a2a)">${teEscapeHtml(bm.last_surfacing_outcome)}</span>`
    : `<span style="padding: 1px 6px; border-radius: 3px; font-size: 0.8em; opacity: 0.5; border: 1px solid var(--border-subtle, #2a2a2a)">pending</span>`;
  const topicRow = topicLabel
    ? `<div style="font-size: 0.85em; opacity: 0.7">topic: ${topicLabel}</div>`
    : '';
  const resourceRow = resource
    ? `<div style="font-size: 0.85em; opacity: 0.7">resource: <code>${resource}</code></div>`
    : '';
  const noteRow = note
    ? `<div style="font-size: 0.85em; opacity: 0.7">note: ${note}</div>`
    : '';
  const ignores = Number(bm.consecutive_ignores) > 0
    ? `<span style="opacity: 0.6; font-size: 0.85em">${bm.consecutive_ignores} consecutive ignore(s)</span>`
    : '';
  return `
    <div style="padding: 8px 12px; border-bottom: 1px solid var(--border-subtle, #2a2a2a)">
      <div style="display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap">
        <strong style="flex: 1">${label}</strong>
        ${outcome}
        ${ignores}
      </div>
      ${topicRow}
      ${resourceRow}
      ${noteRow}
      <div style="font-size: 0.85em; opacity: 0.7; margin-top: 2px">${lastSurfaced} · ${interval}</div>
    </div>`;
}

// ── Threat tab ────────────────────────────────────────────────────

async function teLoadThreat() {
  const sum  = $('te-threat-summary');
  const hist = $('te-threat-history');
  if (!sum || !hist) return;
  sum.innerHTML  = '<p class="logs-empty">Loading…</p>';
  hist.innerHTML = '';
  try {
    const [tRes, hRes] = await Promise.all([
      fetch('/api/threat').then(r => r.json()),
      fetch('/api/threat/history?limit=50').then(r => r.json()),
    ]);
    const tier   = teEscapeHtml(tRes.tier   ?? 'calm');
    const weight = Number(tRes.weight ?? 0).toFixed(2);
    const disabled = tRes.disabled
      ? ' <span style="color: var(--text-warning, #d4a44c)">(detector disabled by env var)</span>'
      : '';
    sum.innerHTML = `
      <div style="display: flex; gap: 16px; align-items: baseline">
        <div><strong style="font-size: 1.3em">${tier}</strong>${disabled}</div>
        <div style="font-family: monospace">weight ${weight}</div>
        <div style="opacity: 0.7">last touched ${teTimeAgo(tRes.last_touched)}</div>
      </div>`;

    const events = Array.isArray(hRes.history) ? hRes.history : [];
    if (!events.length) {
      hist.innerHTML = '<p class="logs-empty">No threat events recorded yet.</p>';
    } else {
      hist.innerHTML = events.map(e => {
        const delta = Number(e.delta).toFixed(2);
        const sign  = e.delta >= 0 ? '+' : '';
        const sigs  = (e.signals || [])
          .map(s => `<code style="font-size: 0.8em">${teEscapeHtml(s.id)}${s.damped ? '*' : ''}</code>`)
          .join(' ');
        return `<div style="padding: 6px 12px; border-bottom: 1px solid var(--border-subtle, #2a2a2a); font-size: 0.9em">
          <div style="display: flex; gap: 8px; align-items: baseline">
            <span style="opacity: 0.6; font-size: 0.85em; min-width: 12em">${teEscapeHtml(e.ts)}</span>
            <span style="font-family: monospace; min-width: 4em">${sign}${delta}</span>
            <span style="opacity: 0.7">→ ${Number(e.raw_after).toFixed(2)}</span>
            <span style="opacity: 0.6; font-size: 0.85em">[${teEscapeHtml(e.source)}]</span>
          </div>
          ${sigs ? `<div style="margin-top: 2px; opacity: 0.8">${sigs}</div>` : ''}
        </div>`;
      }).join('');
    }
  } catch (err) {
    sum.innerHTML = `<p class="logs-empty">Failed to load: ${teEscapeHtml(err.message)}</p>`;
  }
}

async function teResetThreat() {
  if (!confirm('Reset the threat level to calm (0)?\n\nThis logs a manual_reset audit entry but does not disable the detector. Use the PROTO_FAMILIAR_THREAT_DISABLED env var on the server for that.')) return;
  try {
    const r = await fetch('/api/threat/reset', { method: 'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    teLoadThreat();
  } catch (err) {
    alert(`Reset failed: ${err.message}`);
  }
}

// ── Ponderings tab ────────────────────────────────────────────────

async function teLoadPonderings() {
  const list  = $('te-pond-list');
  const sum   = $('te-pond-summary');
  if (!list) return;
  list.innerHTML = '<p class="logs-empty">Loading…</p>';
  const limit = $('te-pond-limit')?.value ?? 25;
  try {
    const r = await fetch(`/api/temporal/ponderings?limit=${limit}&sinceDays=365`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const items = Array.isArray(data.ponderings) ? data.ponderings : [];
    if (sum) sum.textContent = `${items.length} pondering(s)`;
    if (!items.length) {
      list.innerHTML = '<p class="logs-empty">No ponderings yet. The autonomous loop writes here when interests accrue and cooldowns elapse.</p>';
      return;
    }
    list.innerHTML = items.map(p => `
      <div style="padding: 10px 12px; border-bottom: 1px solid var(--border-subtle, #2a2a2a)">
        <div style="display: flex; gap: 8px; align-items: baseline">
          <strong style="flex: 1">${teEscapeHtml(p.title || '(untitled)')}</strong>
          <span style="opacity: 0.7; font-size: 0.85em">${teTimeAgo(p.created_at)}</span>
          <button class="btn-ghost" data-pond-uid="${teEscapeHtml(p.uid)}" style="font-size: 0.8em; padding: 2px 8px">Delete</button>
        </div>
        ${p.topic ? `<div style="font-size: 0.8em; opacity: 0.6; margin: 2px 0">topic: ${teEscapeHtml(p.topic)}</div>` : ''}
        <div style="white-space: pre-wrap; margin-top: 6px; font-size: 0.92em; line-height: 1.4">${teEscapeHtml(p.content || '')}</div>
      </div>
    `).join('');
    list.querySelectorAll('[data-pond-uid]').forEach(btn => {
      btn.addEventListener('click', () => teDeletePondering(btn.dataset.pondUid));
    });
  } catch (err) {
    list.innerHTML = `<p class="logs-empty">Failed to load: ${teEscapeHtml(err.message)}</p>`;
  }
}

async function teDeletePondering(uid) {
  if (!confirm('Delete this pondering? The on-disk entry is removed; the audit trail is the diff itself.')) return;
  try {
    const r = await fetch(`/api/temporal/ponderings/${encodeURIComponent(uid)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    teLoadPonderings();
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  }
}

// ── Schedule tab (M9b) ────────────────────────────────────────────

async function teLoadSchedule() {
  const list = $('te-sched-list');
  if (!list) return;
  list.innerHTML = '<p class="logs-empty">Loading…</p>';
  const hours = Math.max(1, parseInt($('te-sched-hours')?.value, 10) || 48);
  const now   = new Date();
  const from  = new Date(now.getTime() - hours * 30 * 60_000).toISOString();   // half-window behind
  const to    = new Date(now.getTime() + hours * 30 * 60_000).toISOString();
  try {
    const r = await fetch(`/api/temporal/schedule?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (data.ok === false) throw new Error(data.error || 'unruh unavailable');
    const nodes = (data.nodes || [])
      .filter(n => n.type !== 'phase')             // Routine tab handles phases
      .sort((a, b) => (a.when || '').localeCompare(b.when || ''));
    if (!nodes.length) {
      list.innerHTML = '<p class="logs-empty">Nothing scheduled in this window. Use "+ Add" above to create an event or task.</p>';
      return;
    }
    list.innerHTML = nodes.map(n => {
      const id    = teEscapeHtml(n.id);
      const label = teEscapeHtml(n.label);
      const type  = teEscapeHtml(n.type);
      const when  = n.when ? `<span style="font-size: 0.85em; opacity: 0.8">${teEscapeHtml(teIsoUtcToLocalFriendly(n.when))}</span>` : '<span style="opacity: 0.5; font-size: 0.85em">open</span>';
      const end   = n.end  ? `<span style="font-size: 0.85em; opacity: 0.7"> → ${teEscapeHtml(teIsoUtcToLocalFriendly(n.end))}</span>` : '';
      const resolution = n.resolution
        ? `<span style="font-size: 0.85em; opacity: 0.7; padding: 1px 6px; border: 1px solid var(--border-subtle, #2a2a2a); border-radius: 3px">${teEscapeHtml(n.resolution)}</span>`
        : '';
      // For expanded occurrences of a recurring node, the resolve
      // buttons carry the occurrence date so the handler can hit the
      // per-occurrence endpoint (resolves THIS instance only, leaves
      // the rest of the series alive).
      const isOccurrence = !!n.__occurrence_of;
      // teLocalDateKey takes a Date and returns YYYY-MM-DD in local
      // TZ — same shape used everywhere else (resolution keys, the
      // calendar grid). Caches the Date so we only construct it once
      // instead of three times for the same ISO.
      const occDate = isOccurrence && n.when
        ? teLocalDateKey(new Date(n.when))
        : '';
      const occAttrs = isOccurrence
        ? ` data-occurrence-date="${teEscapeHtml(occDate)}"`
        : '';
      const recurringTag = isOccurrence
        ? ' <span style="font-size:0.7em;opacity:0.6;padding:1px 4px;border:1px solid var(--border-subtle,#2a2a2a);border-radius:3px">recurring</span>'
        : '';
      const resolveBtns = n.resolution ? '' : `
        <button class="btn-ghost te-sched-resolve" data-id="${id}" data-resolution="done"${occAttrs}      style="font-size: 0.8em; padding: 2px 8px">✓ done</button>
        <button class="btn-ghost te-sched-resolve" data-id="${id}" data-resolution="cancelled"${occAttrs} style="font-size: 0.8em; padding: 2px 8px">✕ cancel</button>`;
      return `
      <div style="padding: 8px 12px; border-bottom: 1px solid var(--border-subtle, #2a2a2a)">
        <div style="display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap">
          <span style="font-size: 0.8em; opacity: 0.6; min-width: 4em">${type}</span>
          <strong style="flex: 1">${label}${recurringTag}</strong>
          ${resolution}
          ${resolveBtns}
          <button class="btn-ghost te-sched-delete" data-id="${id}" style="font-size: 0.8em; padding: 2px 8px" title="Permanently delete (cascades to edges)">🗑</button>
        </div>
        <div style="margin-top: 2px">${when}${end}</div>
      </div>`;
    }).join('');
    list.querySelectorAll('.te-sched-resolve').forEach(btn => {
      btn.addEventListener('click', () => teResolveSchedule(
        btn.dataset.id,
        btn.dataset.resolution,
        btn.dataset.occurrenceDate || null,
      ));
    });
    list.querySelectorAll('.te-sched-delete').forEach(btn => {
      btn.addEventListener('click', () => teDeleteSchedule(btn.dataset.id));
    });
  } catch (err) {
    list.innerHTML = `<p class="logs-empty">Failed to load: ${teEscapeHtml(err.message)}</p>`;
  }
}

async function teResolveSchedule(id, resolution, occurrenceDate = null) {
  // If the item is an expanded occurrence (the resolve button carries
  // data-occurrence-date), route to the per-occurrence endpoint —
  // resolves THIS occurrence only and leaves the rest of the series
  // alive. Otherwise the regular resolve hits the whole node.
  try {
    const url = occurrenceDate
      ? `/api/temporal/schedule/${encodeURIComponent(id)}/resolve_occurrence`
      : `/api/temporal/schedule/${encodeURIComponent(id)}/resolve`;
    const body = occurrenceDate
      ? { occurrence_date: occurrenceDate, resolution }
      : { resolution };
    const r = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    }).then(r => r.json());
    if (!r.ok) throw new Error(r.error || 'resolve failed');
    teReloadScheduleView();
  } catch (err) {
    alert(`Resolve failed: ${err.message}`);
  }
}

// ── Calendar view (Schedule tab toggle) ───────────────────────────
//
// Month-grid alternative to the linear schedule list. Same data
// source (/api/temporal/schedule), just rendered as a calendar with
// click-to-create. Recurring nodes expand server-side so the grid
// shows occurrences on their actual dates. The view-mode toggle
// mirrors the Knowledge-Editor graph List/Map pattern so the
// behaviour reads familiar.
//
// "Current month" tracked in module-level state — week navigation
// would be a natural extension but for the MVP we stay at month
// granularity (the lower scroll cost matters more than fine
// navigation, especially since the underlying schedule entries
// rarely move week-to-week).

let _teSchedView = 'list';
let _teCalCursor = null; // { year, month } — the month being displayed
const _DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function teReloadScheduleView() {
  if (_teSchedView === 'calendar')  teLoadCalendar();
  else if (_teSchedView === 'map')  teLoadScheduleMap();
  else                              teLoadSchedule();
}

function teSetScheduleView(view) {
  if (view !== 'list' && view !== 'calendar' && view !== 'map') return;
  _teSchedView = view;
  for (const v of ['list', 'calendar', 'map']) {
    const btn = $(`te-sched-view-${v}`);
    btn.classList.toggle('ke-view-active', view === v);
    btn.setAttribute('aria-selected', view === v ? 'true' : 'false');
  }
  // The hours/window control bounds both the list and the map (calendar
  // paginates by month instead); hide it only on the calendar.
  $('te-sched-hours-label').classList.toggle('hidden', view === 'calendar');
  $('te-sched-list').classList.toggle('hidden',     view !== 'list');
  $('te-sched-calendar').classList.toggle('hidden', view !== 'calendar');
  $('te-sched-map').classList.toggle('hidden',      view !== 'map');
  if (view === 'calendar') {
    if (!_teCalCursor) teGotoCalendarToday();
    else teLoadCalendar();
  } else if (view === 'map') {
    teScheduleMapInstance();
    teLoadScheduleMap();
  }
}

// ── Schedule Map view — the consequence graph ─────────────────────
//
// The schedule's nodes (events / tasks / phases / states) and the
// causal-temporal edges between them, on the shared force-directed
// engine (graph-map.js — the same one behind the knowledge graph).
// This is the home for Unruh's consequence graph: the reason a graph
// was chosen over a flat table is so events can relate to each other,
// and this is where those relationships get seen and authored. The
// Familiar authors the same edges from its side via schedule_link.

const TE_EDGE_KINDS = ['causes', 'requires', 'depends_on', 'blocks', 'during', 'carries_forward'];

let _teSchedMap = null;
function teScheduleMapInstance() {
  if (_teSchedMap) return _teSchedMap;
  _teSchedMap = createGraphMap({
    canvas:    $('te-sched-canvas'),
    statusEl:  $('te-sched-map-status'),
    legendEl:  $('te-sched-legend'),
    tooltipEl: $('te-sched-tooltip'),
    isActive: () =>
      !$('temporal-modal').classList.contains('hidden') &&
      !$('te-sched-map').classList.contains('hidden'),
    onNodeClick:       (node, cx, cy) => teSchedOpenPopover(node, cx, cy),
    onBackgroundClick: () => teSchedClosePopover(),
    // Resolved items fade so the live ones read first.
    nodeColor: (n, hue) => n.resolution
      ? `hsla(${hue}, 30%, 45%, 0.55)`
      : `hsl(${hue}, 65%, 60%)`,
    tooltipNodeHTML: n => {
      const time = n.when
        ? teIsoUtcToLocalFriendly(n.when) + (n.end ? ' → ' + teIsoUtcToLocalFriendly(n.end) : '')
        : 'no time set';
      return `<div class="ke-graph-tooltip-title">${teEscapeHtml(n.label ?? n.id)}</div>
        <div class="ke-graph-tooltip-sub">${teEscapeHtml(n.type ?? 'task')}${n.resolution ? ' · ' + teEscapeHtml(n.resolution) : ''}</div>
        <div class="ke-graph-tooltip-sub">${teEscapeHtml(time)}</div>`;
    },
  });
  _teSchedMap.init();
  $('te-sched-zoom-in') ?.addEventListener('click', () => _teSchedMap.zoomBy(1.25));
  $('te-sched-zoom-out')?.addEventListener('click', () => _teSchedMap.zoomBy(1 / 1.25));
  $('te-sched-zoom-fit')?.addEventListener('click', () => _teSchedMap.fit());
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('te-sched-popover').classList.contains('hidden')) {
      teSchedClosePopover();
    }
  });
  return _teSchedMap;
}

let _teSchedMapGen = 0;
async function teLoadScheduleMap() {
  const gen    = ++_teSchedMapGen;
  const status = $('te-sched-map-status');
  status.textContent = 'Loading…';
  status.classList.remove('hidden');
  const hours = Math.max(1, parseInt($('te-sched-hours')?.value, 10) || 48);
  const now   = new Date();
  const from  = new Date(now.getTime() - hours * 30 * 60_000).toISOString();
  const to    = new Date(now.getTime() + hours * 30 * 60_000).toISOString();
  try {
    const r = await fetch(`/api/temporal/schedule?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=500`);
    if (gen !== _teSchedMapGen) return;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (gen !== _teSchedMapGen) return;
    if (data.ok === false) throw new Error(data.error || 'unruh unavailable');
    const nodes = (data.nodes || []).map(n => ({ ...n, type: n.type || 'task' }));
    // Engine edges want { id, fromId, toId, type }. Schedule edges carry
    // src / dst / kind — map them across (kind becomes the edge's type,
    // which the engine hues and the legend lists).
    const edges = (data.edges || []).map(e => ({ id: e.id, fromId: e.src, toId: e.dst, type: e.kind }));
    const { empty } = teScheduleMapInstance().setData(nodes, edges);
    if (empty) { status.textContent = 'Nothing scheduled in this window. Add events/tasks, then connect them.'; return; }
    status.classList.add('hidden');
  } catch (err) {
    status.textContent = 'Failed to load schedule map: ' + (err.message || err);
  }
}

let _teSchedPopId = null;
function teSchedClosePopover() {
  const pop = $('te-sched-popover');
  if (pop) pop.classList.add('hidden');
  _teSchedPopId = null;
}

function teSchedPositionPopover(pop, clientX, clientY) {
  const r = $('te-sched-map').getBoundingClientRect();
  pop.style.left = `${(clientX - r.left) + 14}px`;
  pop.style.top  = `${(clientY - r.top)  + 14}px`;
  requestAnimationFrame(() => {
    const pr = pop.getBoundingClientRect();
    let nx = pr.left - r.left, ny = pr.top - r.top;
    if (pr.right  > r.right  - 6) nx = r.width  - pr.width  - 10;
    if (pr.bottom > r.bottom - 6) ny = r.height - pr.height - 10;
    pop.style.left = `${Math.max(6, nx)}px`;
    pop.style.top  = `${Math.max(6, ny)}px`;
  });
}

// Re-open the popover on the same node after a mutation reloads the map,
// unless the user has since clicked elsewhere.
function teSchedReopenAfterChange(nodeId, clientX, clientY) {
  if (_teSchedPopId !== nodeId) return;
  const refreshed = teScheduleMapInstance().getNode(nodeId);
  if (refreshed) teSchedOpenPopover(refreshed, clientX, clientY);
  else teSchedClosePopover();
}

function teSchedOpenPopover(node, clientX, clientY) {
  const map = teScheduleMapInstance();
  const pop = $('te-sched-popover');
  _teSchedPopId = node.id;
  pop.classList.remove('hidden');
  teSchedPositionPopover(pop, clientX, clientY);

  // The schedule window already carried every touching edge, so the
  // node's links come straight from the loaded map — no extra fetch.
  const edges  = map.edges.filter(e => e.fromId === node.id || e.toId === node.id);
  const others = map.nodes.filter(n => n.id !== node.id);
  const edgeRows = edges.map(e => {
    const out     = e.fromId === node.id;
    const otherId = out ? e.toId : e.fromId;
    const other   = map.getNode(otherId);
    const arrow   = out ? '→' : '←';
    return `<div class="ke-edge-row" data-edge-id="${teEscapeHtml(e.id)}">
      <span class="ke-edge-text">${arrow} ${teEscapeHtml(e.type)} ${arrow} <strong>${teEscapeHtml(other?.label ?? otherId)}</strong></span>
      <button class="btn-ghost ke-danger te-edge-del" type="button" title="Remove link">✕</button>
    </div>`;
  }).join('');
  const kindOptions   = TE_EDGE_KINDS.map(k => `<option value="${k}">${k}</option>`).join('');
  const targetOptions = others.map(n => `<option value="${teEscapeHtml(n.id)}">${teEscapeHtml(n.label ?? n.id)}</option>`).join('');
  const time = node.when
    ? teIsoUtcToLocalFriendly(node.when) + (node.end ? ' → ' + teIsoUtcToLocalFriendly(node.end) : '')
    : 'no time set';

  pop.innerHTML = `
    <div class="ke-graph-popover-head">
      <h3>${teEscapeHtml(node.label ?? node.id)}</h3>
      <button class="ke-graph-popover-close" type="button" aria-label="Close" id="te-sched-pop-close">✕</button>
    </div>
    <div class="ke-row-sub">${teEscapeHtml(node.type ?? 'task')}${node.resolution ? ' · ' + teEscapeHtml(node.resolution) : ''} · ${teEscapeHtml(time)}</div>
    <h4 class="ke-subhead">Consequence links (${edges.length})</h4>
    <div class="ke-edges">${edgeRows || '<p class="logs-empty">No links yet.</p>'}</div>
    ${others.length ? `<details class="ke-add-edge">
      <summary>+ connect to another item</summary>
      <div class="ke-add-edge-form">
        <label>this item <select class="te-ae-kind">${kindOptions}</select></label>
        <select class="te-ae-target">${targetOptions}</select>
        <div class="ke-actions"><button class="btn-send te-ae-create" type="button">Add link</button></div>
      </div>
    </details>` : ''}
    <div class="ke-actions"><button id="te-sched-pop-del" class="btn-ghost ke-danger" type="button">Delete this item</button></div>`;

  pop.querySelector('#te-sched-pop-close').addEventListener('click', teSchedClosePopover);

  // src = this node; the relationship reads "this item {kind} target".
  pop.querySelector('.te-ae-create')?.addEventListener('click', async () => {
    const kind = pop.querySelector('.te-ae-kind').value;
    const dst  = pop.querySelector('.te-ae-target').value;
    if (!dst) return;
    const res = await fetch('/api/temporal/schedule/edge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src: node.id, dst, kind }),
    }).then(r => r.json()).catch(() => ({ ok: false }));
    if (!res.ok) { alert('Add link failed: ' + (res.error || 'one of the ids may be stale')); return; }
    await teLoadScheduleMap();
    teSchedReopenAfterChange(node.id, clientX, clientY);
  });

  pop.querySelectorAll('.te-edge-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const eid = btn.closest('.ke-edge-row')?.dataset.edgeId;
      if (!eid || !confirm('Remove this consequence link? The events themselves stay.')) return;
      const res = await fetch(`/api/temporal/schedule/edge/${encodeURIComponent(eid)}`, { method: 'DELETE' })
        .then(r => r.json()).catch(() => ({ ok: false }));
      if (!res.ok) { alert('Remove failed: ' + (res.error || '')); return; }
      await teLoadScheduleMap();
      teSchedReopenAfterChange(node.id, clientX, clientY);
    });
  });

  pop.querySelector('#te-sched-pop-del').addEventListener('click', async () => {
    if (!confirm('Delete this schedule item and its links?')) return;
    const res = await fetch(`/api/temporal/schedule/${encodeURIComponent(node.id)}`, { method: 'DELETE' })
      .then(r => r.json()).catch(() => ({ ok: false }));
    if (!res.ok) { alert('Delete failed: ' + (res.error || '')); return; }
    teSchedClosePopover();
    await teLoadScheduleMap();
  });
}

function teGotoCalendarToday() {
  const now = new Date();
  _teCalCursor = { year: now.getFullYear(), month: now.getMonth() };
  teLoadCalendar();
}

function teShiftCalendarMonth(delta) {
  if (!_teCalCursor) { teGotoCalendarToday(); return; }
  let { year, month } = _teCalCursor;
  month += delta;
  while (month < 0)   { month += 12; year -= 1; }
  while (month > 11)  { month -= 12; year += 1; }
  _teCalCursor = { year, month };
  teLoadCalendar();
}

// Local-TZ YYYY-MM-DD for a given Date — matches recurrence.js's
// localDateKey shape so per-occurrence resolutions key consistently.
function teLocalDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Compute the start of the calendar grid for a given month. Returns
// the Monday on-or-before the 1st of the month — gives us a clean
// 6-row × 7-col grid that always starts on Monday, with the prior
// month's tail filling the first row. (Localised to Monday-start
// because Eury runs in DE; flipping to Sunday-start is a one-line
// change if a setting ever surfaces.)
function teCalendarGridStart(year, month) {
  const first = new Date(year, month, 1);
  // JS getDay: 0=Sun, 1=Mon, ..., 6=Sat. Offset to Monday-start.
  const offsetFromMonday = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - offsetFromMonday);
  return start;
}

async function teLoadCalendar() {
  const grid = $('te-cal-grid');
  const status = $('te-cal-status');
  if (!grid) return;
  if (!_teCalCursor) teGotoCalendarToday();
  const { year, month } = _teCalCursor;
  const monthName = ['January','February','March','April','May','June','July','August','September','October','November','December'][month];
  const titleEl = $('te-cal-title');
  if (titleEl) titleEl.textContent = `${monthName} ${year}`;
  if (status) status.textContent = 'Loading…';

  const gridStart = teCalendarGridStart(year, month);
  const gridEnd = new Date(gridStart);
  gridEnd.setDate(gridEnd.getDate() + 6 * 7); // 6 weeks
  const fromIso = gridStart.toISOString();
  const toIso   = new Date(gridEnd.getTime() - 1).toISOString();

  let nodes = [];
  try {
    const r = await fetch(`/api/temporal/schedule?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&limit=500`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (data.ok === false) throw new Error(data.error || 'unruh unavailable');
    nodes = (data.nodes || []).filter(n => n.type !== 'phase'); // phases live in Routine
  } catch (err) {
    if (status) status.textContent = `Load failed: ${err.message}`;
    grid.innerHTML = '';
    return;
  }
  if (status) status.textContent = `${nodes.length} event(s) this view`;

  // Bucket events by local-TZ date key. Each cell renders its bucket.
  const byDay = new Map();
  for (const n of nodes) {
    if (!n.when) continue;
    const d = new Date(n.when);
    if (!Number.isFinite(d.getTime())) continue;
    const key = teLocalDateKey(d);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(n);
  }
  // Sort each day's events by start time.
  for (const list of byDay.values()) {
    list.sort((a, b) => (a.when || '').localeCompare(b.when || ''));
  }

  // Render: weekday header + 6 × 7 = 42 day cells.
  const todayKey = teLocalDateKey(new Date());
  const parts = [];
  for (const dow of _DOW_LABELS) {
    parts.push(`<div class="te-cal-weekday">${dow}</div>`);
  }
  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(gridStart);
    cellDate.setDate(gridStart.getDate() + i);
    const isOutOfMonth = cellDate.getMonth() !== month;
    const key = teLocalDateKey(cellDate);
    const isToday = key === todayKey;
    const events = byDay.get(key) || [];
    const eventLines = events.slice(0, 3).map(ev => {
      const cls = [`te-cal-event`, `type-${teEscapeHtml(ev.type || 'event')}`];
      if (ev.__occurrence_of) cls.push('recurring');
      if (ev.resolution)      cls.push('resolved');
      const time = ev.when ? teEscapeHtml(teIsoUtcToLocalHhMm(ev.when)) : '';
      return `<div class="${cls.join(' ')}" title="${teEscapeHtml(ev.label || '')}${time ? ' · ' + time : ''}">${time ? `${time} ` : ''}${teEscapeHtml(ev.label || '')}</div>`;
    }).join('');
    const more = events.length > 3 ? `<div class="te-cal-more">+${events.length - 3} more</div>` : '';
    const cellCls = ['te-cal-day'];
    if (isOutOfMonth) cellCls.push('out-of-month');
    if (isToday)      cellCls.push('today');
    parts.push(`
      <div class="${cellCls.join(' ')}" data-date="${key}" role="button" tabindex="0" aria-label="${key}${events.length ? `, ${events.length} event(s)` : ''}">
        <span class="te-cal-day-num">${cellDate.getDate()}</span>
        ${eventLines}${more}
      </div>
    `);
  }
  grid.innerHTML = parts.join('');

  // Click a day cell → open the create-schedule form with the date
  // pre-filled to that day at 9am (sensible default; user adjusts).
  grid.querySelectorAll('.te-cal-day').forEach(cell => {
    const openCreate = () => teOpenCalendarCreate(cell.dataset.date);
    cell.addEventListener('click', openCreate);
    cell.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCreate(); }
    });
  });
}

function teOpenCalendarCreate(dateKey) {
  // Switch back to the list view so the create form is visible and
  // the user sees the result land. (The form lives in the list-view
  // DOM region; opening it while calendar is shown would scroll
  // somewhere unhelpful.)
  teSetScheduleView('list');
  teToggleScheduleForm(true);
  // Pre-fill the datetime-local input with the chosen day at 9am
  // local. teDatetimeLocalToIsoUtc handles the conversion when the
  // user saves.
  const whenInput = $('te-sched-when');
  if (whenInput && dateKey) {
    whenInput.value = `${dateKey}T09:00`;
  }
}

async function teDeleteSchedule(id) {
  if (!confirm('Permanently delete this schedule node? Any edges referencing it will also be removed.')) return;
  try {
    const r = await fetch(`/api/temporal/schedule/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(r => r.json());
    if (!r.ok) throw new Error(r.error || 'delete failed');
    teReloadScheduleView();
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  }
}

function teToggleScheduleForm(show) {
  const form = $('te-sched-form');
  if (!form) return;
  form.style.display = show ? '' : 'none';
  if (show) {
    $('te-sched-label').value = '';
    $('te-sched-when').value  = '';
    $('te-sched-end').value   = '';
    $('te-sched-type').value  = 'event';
    const stakes = $('te-sched-stakes');
    if (stakes) stakes.value = '';
    const repeat = $('te-sched-repeat');
    if (repeat) repeat.value = '';
    setTimeout(() => $('te-sched-label')?.focus(), 0);
  }
}

// Map the UI repeat presets to payload.recurrence objects the
// expander understands. Kept tiny: the dropdown only offers the
// patterns the bare-minimum spec called out. Custom RRULEs / nth-
// weekday with weekday-not-Friday-or-Sunday are advanced enough
// that the Familiar's BUILTIN_TOOL is the right entry point, not
// a casual UI selector.
function teRepeatToRecurrence(preset) {
  switch (preset) {
    case 'daily':            return { freq: 'daily' };
    case 'weekly':           return { freq: 'weekly' };
    case 'monthly':          return { freq: 'monthly' };
    case 'yearly':           return { freq: 'yearly' };
    case 'monthly_last_fri': return { freq: 'monthly', bysetpos: -1, byweekday: 5 };
    case 'monthly_last_sun': return { freq: 'monthly', bysetpos: -1, byweekday: 0 };
    default:                 return null;
  }
}

async function teSaveScheduleNode() {
  const type  = $('te-sched-type').value;
  const label = $('te-sched-label').value.trim();
  // <input type="datetime-local"> hands back "YYYY-MM-DDTHH:MM" (no
  // offset, interpreted as user's local time). Convert to ISO UTC so
  // the server stores absolute moments and the Familiar reads the
  // right wall-clock no matter where the server's TZ is.
  const whenLocal = $('te-sched-when').value;
  const endLocal  = $('te-sched-end').value;
  const when = teDatetimeLocalToIsoUtc(whenLocal);
  const end  = teDatetimeLocalToIsoUtc(endLocal);
  if (!label) { alert('Label is required.'); return; }
  // Reminders MUST have a fire time — the Python layer would reject
  // the create otherwise, but failing fast here is friendlier.
  if (type === 'reminder' && !when) {
    alert('Reminders need a "When" time so they know when to fire.');
    return;
  }
  if (type !== 'task' && !when) {
    alert(`A "${type}" needs a "When" time. Tasks are the only type that can be open-ended.`);
    return;
  }
  const stakesTier = $('te-sched-stakes')?.value || '';
  const repeatPreset = $('te-sched-repeat')?.value || '';
  const recurrence = teRepeatToRecurrence(repeatPreset);
  const payload = {};
  if (stakesTier)  payload.stakes_tier = stakesTier;
  if (recurrence)  payload.recurrence  = recurrence;
  const hasPayload = Object.keys(payload).length > 0;
  try {
    const r = await fetch('/api/temporal/schedule', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type, label, when, end,
        ...(hasPayload ? { payload } : {}),
      }),
    }).then(r => r.json());
    if (!r.ok) throw new Error(r.error || 'create failed');
    teToggleScheduleForm(false);
    teReloadScheduleView();
  } catch (err) {
    alert(`Create failed: ${err.message}`);
  }
}

// ── Routine tab (M9b) — phase nodes only ──────────────────────────

async function teLoadRoutine() {
  const list = $('te-routine-list');
  if (!list) return;
  list.innerHTML = '<p class="logs-empty">Loading…</p>';
  try {
    // Date-independent endpoint — phases recur daily, but their stored
    // when_ts carries the date they were added. Using the windowed
    // /api/temporal/schedule endpoint silently hid every phase the day
    // after it was created. /api/temporal/phases ignores the date and
    // returns all live phases.
    const r = await fetch('/api/temporal/phases');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (data.ok === false) throw new Error(data.error || 'unruh unavailable');
    // Dedupe by label (multiple edits to the same phase produce
    // multiple rows; keep the latest by when_ts string).
    const byLabel = new Map();
    for (const n of (data.phases || [])) {
      const prev = byLabel.get(n.label);
      if (!prev || (n.when || '') > (prev.when || '')) byLabel.set(n.label, n);
    }
    const phases = Array.from(byLabel.values()).sort((a, b) => {
      // Sort by local time-of-day, not by raw UTC HH:MM in the
      // ISO string (slicing the ISO returns UTC hours, which lie
      // in any non-UTC timezone).
      const da = new Date(a.when || 0); const db = new Date(b.when || 0);
      const ta = da.getHours() * 60 + da.getMinutes();
      const tb = db.getHours() * 60 + db.getMinutes();
      return ta - tb;
    });

    const routineSummary = $('te-routine-summary');
    if (routineSummary) routineSummary.textContent = `${phases.length} phase(s)`;
    if (!phases.length) {
      list.innerHTML = '<p class="logs-empty">No routine phases yet. Run <code>uv run unruh seed-routine</code> (in the unruh/ dir) to seed defaults.</p>';
      return;
    }
    list.innerHTML = phases.map(p => {
      const id      = teEscapeHtml(p.id);
      const label   = teEscapeHtml(p.label);
      const texture = teEscapeHtml(p.payload?.texture ?? '');
      // Phases recur daily by default — that's the original Routine
      // contract. A payload.recurrence on a phase overrides that
      // (e.g. "weekly Sunday review block", "monthly retrospective").
      // Surface the cadence as a small tag so users can see at a
      // glance which phases land every day vs. only some days.
      const recur = p.payload?.recurrence;
      const recurLabel = !recur ? 'daily'
        : recur.freq === 'daily'   ? (recur.interval > 1 ? `every ${recur.interval} days` : 'daily')
        : recur.freq === 'weekly'  ? (recur.interval > 1 ? `every ${recur.interval} weeks` : 'weekly')
        : recur.freq === 'monthly' ? (recur.bysetpos === -1 ? 'monthly (last weekday)' : 'monthly')
        : recur.freq === 'yearly'  ? 'yearly'
        : recur.freq || 'recurring';
      const recurTag = recurLabel === 'daily'
        ? ''
        : ` <span style="font-size:0.7em;opacity:0.7;padding:1px 5px;border:1px solid var(--border-subtle,#2a2a2a);border-radius:3px">${teEscapeHtml(recurLabel)}</span>`;
      // Show time-of-day in the USER'S local TZ (storage is UTC).
      // Slicing the raw ISO string would print UTC hours and lie to
      // anyone not in UTC.
      const whenT   = teEscapeHtml(teIsoUtcToLocalHhMm(p.when));
      const endT    = teEscapeHtml(teIsoUtcToLocalHhMm(p.end));
      return `
      <div data-phase-id="${id}" style="padding: 10px 12px; border-bottom: 1px solid var(--border-subtle, #2a2a2a)">
        <div style="display: flex; gap: 8px; align-items: baseline">
          <strong style="flex: 1" class="te-phase-label" data-id="${id}" data-field="label">${label}${recurTag}</strong>
          <span style="font-family: monospace; opacity: 0.85" class="te-phase-time">
            <span class="te-phase-when" data-id="${id}" data-field="when">${whenT}</span> –
            <span class="te-phase-end"  data-id="${id}" data-field="end">${endT}</span>
          </span>
          <button class="btn-ghost te-phase-edit" data-id="${id}" style="font-size: 0.8em; padding: 2px 8px">Edit</button>
        </div>
        ${texture ? `<div style="font-size: 0.9em; opacity: 0.75; margin-top: 4px; font-style: italic">${texture}</div>` : ''}
      </div>`;
    }).join('');
    list.querySelectorAll('.te-phase-edit').forEach(btn => {
      btn.addEventListener('click', () => teEditPhase(btn.dataset.id, phases.find(p => p.id === btn.dataset.id)));
    });
  } catch (err) {
    list.innerHTML = `<p class="logs-empty">Failed to load: ${teEscapeHtml(err.message)}</p>`;
  }
}

async function teEditPhase(id, phase) {
  if (!phase) return;
  const label = prompt('Phase label:', phase.label);
  if (label == null) return;
  // Display existing times in user's LOCAL TZ so what they see is what
  // they're editing (the storage is UTC, but the user thinks in their
  // own clock).
  const whenT = prompt('Start time (HH:MM, 24-hour, your local time):', teIsoUtcToLocalHhMm(phase.when));
  if (whenT == null) return;
  const endT  = prompt('End time (HH:MM, 24-hour, your local time):',   teIsoUtcToLocalHhMm(phase.end));
  if (endT  == null) return;
  const texture = prompt('Texture (short description of what the Familiar is like in this phase):', phase.payload?.texture ?? '');
  if (texture == null) return;

  const when = teLocalTimeTodayToIsoUtc(whenT.trim());
  const end  = teLocalTimeTodayToIsoUtc(endT.trim());
  if (!when || !end) { alert('Times must be HH:MM (e.g. 09:30) — entered in your local time.'); return; }

  try {
    const r = await fetch(`/api/temporal/schedule/${encodeURIComponent(id)}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        label: label.trim() || phase.label,
        when, end,
        payload: { ...(phase.payload || {}), texture: texture.trim() },
      }),
    }).then(r => r.json());
    if (!r.ok) throw new Error(r.error || 'update failed');
    teLoadRoutine();
  } catch (err) {
    alert(`Edit failed: ${err.message}`);
  }
}

function teToggleRoutineForm(show) {
  const form = $('te-routine-form');
  if (!form) return;
  form.style.display = show ? '' : 'none';
  if (show) {
    $('te-routine-label').value   = '';
    $('te-routine-start').value   = '';
    $('te-routine-end').value     = '';
    $('te-routine-texture').value = '';
    setTimeout(() => $('te-routine-label')?.focus(), 0);
  }
}

async function teSavePhase() {
  const label   = $('te-routine-label').value.trim();
  const startT  = $('te-routine-start').value;   // <input type="time"> already HH:MM
  const endT    = $('te-routine-end').value;
  const texture = $('te-routine-texture').value.trim();
  if (!label)          { alert('Label is required.'); return; }
  if (!startT || !endT) { alert('Both start and end times are required.'); return; }
  // Phases recur daily — the date in when_ts is just an artifact of
  // when this row was inserted. teLoadRoutine uses /api/temporal/phases
  // (date-independent) to surface them, and Unruh's current_phase()
  // compares only the HH:MM:SS portion when deciding which phase is
  // active right now. We still stamp today's date for ordering /
  // audit purposes.
  const when = teLocalTimeTodayToIsoUtc(startT);
  const end  = teLocalTimeTodayToIsoUtc(endT);
  if (!when || !end) { alert('Could not parse the times. Use HH:MM (the picker should fill this).'); return; }
  try {
    const r = await fetch('/api/temporal/schedule', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type:    'phase',
        label,
        when,
        end,
        payload: texture ? { texture } : {},
      }),
    }).then(r => r.json());
    if (!r.ok) throw new Error(r.error || 'create failed');
    teToggleRoutineForm(false);
    teLoadRoutine();
  } catch (err) {
    alert(`Create failed: ${err.message}`);
  }
}

// "Help me figure out my rhythm" — pre-fills the chat composer with
// a scaffolding prompt that nudges the Familiar to walk the user
// through their natural daily rhythm. The user can edit / send /
// scrap before anything goes out. No auto-send. After the
// conversation, the user comes back to this tab and records what
// they figured out as phases.
function teStartRoutineConversation() {
  const composer = $('user-input') || document.querySelector('#user-input, .composer-input, textarea[name="message"]');
  const scaffold = (
    "I'd like your help figuring out my natural daily rhythm — not a productivity " +
    "schedule, just the times of day that already feel like distinct phases for me " +
    "(when I wake, when I'm most settled, when I wind down). Ask me one thing at a " +
    "time so I don't get overwhelmed. When we're done, give me a short bullet list " +
    "I can use to set up routine phases in the Temporal editor."
  );
  if (composer) {
    composer.value = scaffold;
    composer.focus();
    // Trigger the input event so any auto-resize / send-button-enable logic fires.
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    closeTemporalModal();
  } else {
    // Composer not found (shouldn't happen) — copy to clipboard as a fallback.
    navigator.clipboard?.writeText?.(scaffold).catch(() => {});
    alert('Composer not found. The starter prompt has been copied to your clipboard.');
  }
}

// ── Handoff tab (M9b) ─────────────────────────────────────────────

async function teLoadHandoff() {
  const list = $('te-handoff-list');
  if (!list) return;
  list.innerHTML = '<p class="logs-empty">Loading…</p>';
  try {
    const r = await fetch('/api/temporal/handoff');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (data.ok === false) throw new Error(data.error || 'unruh unavailable');
    // session_get_handoff can return either a single most-recent
    // handoff object or a list; normalize.
    const items =
        Array.isArray(data.handoffs) ? data.handoffs
      : data.handoff                 ? [data.handoff]
      : [];
    const handoffSummary = $('te-handoff-summary');
    if (handoffSummary) handoffSummary.textContent = `${items.length} handoff(s)`;
    if (!items.length) {
      list.innerHTML = '<p class="logs-empty">No session handoffs stored yet. They\'re created at the end of each session by the handoff-summariser (Settings → Session handoff).</p>';
      return;
    }
    list.innerHTML = items.map(h => {
      const id      = teEscapeHtml(h.id ?? '');
      const intent  = teEscapeHtml(h.intent ?? '');
      const threads = Array.isArray(h.open_threads) ? h.open_threads : [];
      const consumed = h.consumed
        ? '<span style="font-size: 0.85em; opacity: 0.7; padding: 1px 6px; border: 1px solid var(--border-subtle, #2a2a2a); border-radius: 3px">consumed</span>'
        : '<span style="font-size: 0.85em; padding: 1px 6px; border: 1px solid var(--border-subtle, #2a2a2a); border-radius: 3px; color: var(--text-warning, #d4a44c)">pending</span>';
      const consumeBtn = h.consumed ? '' : `
        <button class="btn-ghost te-handoff-consume" data-id="${id}" style="font-size: 0.8em; padding: 2px 8px" title="Mark as consumed so it stops surfacing in the next session">Mark consumed</button>`;
      const threadsHtml = threads.length
        ? `<ul style="margin: 4px 0 0 0; padding-left: 20px">${threads.map(t => `<li>${teEscapeHtml(typeof t === 'string' ? t : (t.label ?? JSON.stringify(t)))}</li>`).join('')}</ul>`
        : '';
      return `
      <div style="padding: 10px 12px; border-bottom: 1px solid var(--border-subtle, #2a2a2a)">
        <div style="display: flex; gap: 8px; align-items: baseline">
          <span style="opacity: 0.6; font-size: 0.85em">${teEscapeHtml(h.created_at ?? '')}</span>
          <span style="flex: 1"></span>
          ${consumed}
          ${consumeBtn}
        </div>
        ${intent ? `<div style="margin-top: 6px">${intent}</div>` : ''}
        ${threadsHtml ? `<div style="margin-top: 6px"><strong style="font-size: 0.9em">Open threads:</strong>${threadsHtml}</div>` : ''}
      </div>`;
    }).join('');
    list.querySelectorAll('.te-handoff-consume').forEach(btn => {
      btn.addEventListener('click', () => teConsumeHandoff(btn.dataset.id));
    });
  } catch (err) {
    list.innerHTML = `<p class="logs-empty">Failed to load: ${teEscapeHtml(err.message)}</p>`;
  }
}

async function teConsumeHandoff(id) {
  if (!confirm('Mark this handoff as consumed?\n\nIt will stop surfacing at the top of new sessions, but the audit row stays in the DB.')) return;
  try {
    const r = await fetch(`/api/temporal/handoff/${encodeURIComponent(id)}/consume`, { method: 'POST' }).then(r => r.json());
    if (!r.ok) throw new Error(r.error || 'mark-consumed failed');
    teLoadHandoff();
  } catch (err) {
    alert(`Mark-consumed failed: ${err.message}`);
  }
}

// ── Outbox delivery (M11/M12) → inject as chat messages ───────────
//
// Reminders + silence-triage reach-outs + outbound-alert receipts arrive
// here from the server-side outbox. Before 0.3.9-alpha these rendered as
// banners at the top of the chat — which testers reported as effectively
// silent: the banner was easy to miss and felt like UI chrome rather than
// the Familiar speaking. Now they land as ordinary assistant chat
// messages in the active session: they show up where the user is reading,
// they persist as part of the session log, and the user can reply to
// them the same way they'd reply to any other message.
//
// Cross-poll de-dup: the server's acknowledge step gates future polls,
// but a 30-second interval leaves a window where two consecutive polls
// could see the same un-acked item. _injectedOutboxIds (per-tab) closes
// that window without depending on ack RTT.

const OUTBOX_POLL_MS = 30_000;
let _outboxPollTimer = null;
const _injectedOutboxIds = new Set();

// Turn an outbox item into the text body of an assistant chat message.
// Triage items always carry a body (the LLM-written reach-out message);
// reminders may not — when their body is empty the title (event label)
// is the only thing the user/Familiar provided when creating the
// reminder, so we render it with a small italic tag so it doesn't look
// like a context-free fragment.
function formatOutboxAsMessageContent(item) {
  const body  = (item.body  ?? '').trim();
  const title = (item.title ?? '').trim();
  if (item.kind === 'triage') {
    return body || (title ? `*(check-in)* ${title}` : '');
  }
  if (item.kind === 'outbound_alert') {
    const head = title ? `*${title}*` : '';
    if (head && body) return `${head}\n\n${body}`;
    return head || body;
  }
  if (item.kind === 'reminder') {
    if (body) return body;
    return title ? `*(reminder)* ${title}` : '';
  }
  return body || title || '';
}

async function injectOutboxAsChatMessage(item) {
  const content = formatOutboxAsMessageContent(item);
  if (!content) return;

  const timestamp = item.ts || new Date().toISOString();
  const { el, bubble, copyBtn } = appendAssistantShell(timestamp);
  bubble.innerHTML = renderMarkdown(content);
  scrollToBottom();

  // Persist alongside normal messages so reloading the session shows
  // the proactive turn in place. proactive + outboxKind are advisory
  // flags — nothing currently branches on them, but they give styling
  // / filtering / audit something to anchor on later without re-
  // querying the outbox.
  state.messages.push({
    role:       'assistant',
    content,
    timestamp,
    proactive:  true,
    outboxKind: item.kind,
    id:         generateId(),
  });
  el.dataset.msgIndex = String(state.messages.length - 1);
  saveHistory();
  saveToServer();
  refreshTopicGutter?.();
  wireCopyButton(copyBtn, () => content);

  await acknowledgeOutboxItem(item.id);
}

async function fetchOutbox() {
  try {
    const r = await fetch('/api/outbox?pending=1');
    if (!r.ok) return;
    const data = await r.json();
    const items = (Array.isArray(data.items) ? data.items : [])
      .filter(i => i?.id && !_injectedOutboxIds.has(i.id));
    if (!items.length) return;

    // Oldest-first — chat conventions put the newest at the bottom, so
    // rendering in chronological order matches what the user expects.
    items.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));

    // Cap per-poll injection at a small number so an upgrade from the
    // banner UI (where unread items could accumulate) doesn't dump a
    // wall of historical reach-outs into the active session. The
    // remainder rides the next poll 30s later.
    const MAX_INJECT_PER_POLL = 5;
    const batch = items.slice(0, MAX_INJECT_PER_POLL);

    for (const item of batch) {
      _injectedOutboxIds.add(item.id);
      try {
        await injectOutboxAsChatMessage(item);
      } catch (err) {
        // Don't re-throw — one bad item must not block the rest. Drop
        // the id from the de-dup set so a future poll can try again.
        console.warn('outbox inject failed', item.id, err);
        _injectedOutboxIds.delete(item.id);
      }
    }
  } catch { /* network blip; try again next tick */ }
}

async function acknowledgeOutboxItem(id) {
  try {
    await fetch(`/api/outbox/${encodeURIComponent(id)}/acknowledge`, { method: 'POST' });
  } catch (err) {
    console.warn('outbox ack failed', err);
  }
}

// HTML-escape for the few remaining places that still build innerHTML
// from outbox-adjacent strings (trusted-contacts list rendering, etc).
// Kept with its historical name so the call sites below don't have to
// move when we eventually phase the banner UI out completely.
function escapeOutboxText(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function startOutboxPolling() {
  if (_outboxPollTimer) return;
  fetchOutbox();
  _outboxPollTimer = setInterval(fetchOutbox, OUTBOX_POLL_MS);
}

// ── Trusted contacts (M12c) ───────────────────────────────────────

function renderTrustedContacts() {
  const list = $('contacts-list');
  if (!list) return;
  const contacts = Array.isArray(state.trustedContacts) ? state.trustedContacts : [];
  if (!contacts.length) {
    list.innerHTML = '<p class="field-hint" style="opacity:0.6; margin: 0">No contacts yet. Outreach is disabled.</p>';
    return;
  }
  list.innerHTML = contacts.map((c, i) => {
    const name    = escapeOutboxText(c.name ?? '?');
    const channel = escapeOutboxText(c.channel ?? '?');
    const hint    = c.webhook ? `${c.webhook.slice(0, 32)}…` : '(no webhook)';
    return `
      <div style="display: flex; gap: 8px; align-items: baseline; padding: 4px 0; border-bottom: 1px solid var(--border-subtle, #2a2a2a)">
        <strong style="flex: 1">${name}</strong>
        <span style="font-size: 0.85em; opacity: 0.7">${channel}</span>
        <code style="font-size: 0.75em; opacity: 0.55">${escapeOutboxText(hint)}</code>
        <button class="btn-ghost contact-remove" data-idx="${i}" style="font-size: 0.8em; padding: 2px 8px" title="Remove this contact">🗑</button>
      </div>`;
  }).join('');
  list.querySelectorAll('.contact-remove').forEach(btn => {
    btn.addEventListener('click', () => removeTrustedContact(parseInt(btn.dataset.idx, 10)));
  });
}

function addTrustedContact() {
  const name    = ($('contact-name').value ?? '').trim();
  const webhook = ($('contact-webhook').value ?? '').trim();
  if (!name)    { alert('Name is required.'); return; }
  if (!webhook) { alert('Webhook URL is required.'); return; }
  if (!/^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\//.test(webhook)) {
    if (!confirm("This doesn't look like a Discord webhook URL. Add anyway?")) return;
  }
  state.trustedContacts = [...(state.trustedContacts || []), { name, channel: 'discord', webhook }];
  $('contact-name').value    = '';
  $('contact-webhook').value = '';
  saveSettings();
  renderTrustedContacts();
}

function removeTrustedContact(idx) {
  if (!confirm('Remove this contact? Your Familiar will no longer be able to reach out to them.')) return;
  state.trustedContacts = (state.trustedContacts || []).filter((_, i) => i !== idx);
  saveSettings();
  renderTrustedContacts();
}

// ── Village editor (Village Support V1) ──────────────────────────────────────
//
// Three-tab card editor: People · Categories · Locations.
// Left of each tab: responsive card grid. Right: slide-in detail/edit panel.
// All mutations go through /api/village/* and invalidate the local cache.

const VL_STRANGERS = 'strangers';
const VL_EMERGENCY = 'emergency-contacts';
const VL_TABS      = ['people', 'categories', 'locations'];

const VL_REL_FAM_LABELS = {
  unaware:             'Unaware of the Familiar',
  warm:                'Warm',
  neutral:             'Neutral',
  'tolerates-for-ward':'Tolerates (for the ward)',
  'wary-of-ai':        'Wary of AI',
  hostile:             'Hostile',
};

const VL_REMEMBER_CATS = [
  { key: 'basics',           label: 'Basic info',       default: true  },
  { key: 'emotional_content',label: 'Emotional content',default: 'ask' },
  { key: 'health_info',      label: 'Health info',      default: 'ask' },
  { key: 'relationships',    label: 'Relationships',    default: 'ask' },
  { key: 'whereabouts',      label: 'Whereabouts',      default: 'ask' },
];

let _vlReg  = null;   // local registry cache; null = needs reload
let _vlSelP = null;   // selected villager id
let _vlSelC = null;   // selected category id
let _vlSelL = null;   // selected location key

function openVillageModal() {
  $('village-modal').classList.remove('hidden');
  bindResizableModal('village-modal-inner', 'pf-village-modal-size');
  vlSwitchTab('people');
}
function closeVillageModal() { $('village-modal').classList.add('hidden'); }

function vlSwitchTab(tab) {
  for (const t of VL_TABS) {
    $(`vl-pane-${t}`)?.classList.toggle('ke-pane-active', t === tab);
  }
  document.querySelectorAll('[data-village-tab]').forEach(el => {
    el.classList.toggle('ke-tab-active', el.dataset.villageTab === tab);
  });
  if (tab === 'people')     vlLoadPeople();
  if (tab === 'categories') vlLoadCategories();
  if (tab === 'locations')  vlLoadLocations();
}

async function vlFetch(force = false) {
  if (_vlReg && !force) return _vlReg;
  const r = await fetch('/api/village');
  if (!r.ok) throw new Error(await vlErrMsg(r));
  _vlReg = await r.json();
  return _vlReg;
}
async function vlErrMsg(r) {
  try { const j = await r.json(); if (j?.error) return String(j.error); } catch {}
  return `HTTP ${r.status}`;
}
function vlErr(msg) {
  return `<p class="logs-error" style="padding:12px">⚠ ${esc(String(msg?.message ?? msg))}</p>`;
}

// ── People ──

async function vlLoadPeople() {
  const grid = $('vl-people-grid');
  grid.innerHTML = '<p class="logs-loading" style="grid-column:1/-1">Loading…</p>';
  try {
    vlRenderPeopleGrid(await vlFetch(true));
  } catch (err) { grid.innerHTML = vlErr(err); }
  vlLoadKnocks();
}

// ── Knock list (V4.x) ──
// Unregistered people who DMed / @-mentioned the Familiar on Discord.
// The gateway captured their stable platform ID so registration is one
// click instead of a Developer-Mode ID hunt. Binding is always the
// ward's explicit act here — knocking grants nothing.

async function vlLoadKnocks() {
  const box = $('vl-knocks');
  if (!box) return;
  try {
    const r = await fetch('/api/village/knocks');
    vlRenderKnocks(r.ok ? await r.json() : []);
  } catch { box.classList.add('hidden'); }
}

function vlRenderKnocks(knocks) {
  const box = $('vl-knocks');
  if (!box) return;
  if (!Array.isArray(knocks) || !knocks.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  const villagers = _vlReg?.villagers ?? [];
  box.classList.remove('hidden');
  box.innerHTML = `<div class="vl-knocks-head">🚪 Knocked on the door <span class="field-hint">— unregistered people who DMed or @-mentioned your Familiar. They stay Strangers until you bind them.</span></div>`
    + knocks.map((k, i) => {
      const who = esc(k.displayName || k.handle || k.id);
      const sub = [
        k.handle && k.displayName ? `@${esc(k.handle)}` : '',
        esc(k.platform ?? ''),
        k.context === 'guild' ? 'in a server' : 'via DM',
        `${k.count ?? 1}×, last ${k.lastSeenAt ? new Date(k.lastSeenAt).toLocaleString() : '?'}`,
      ].filter(Boolean).join(' · ');
      const options = ['<option value="">+ New person…</option>']
        .concat(villagers.map(v => `<option value="${esc(v.id)}">${esc(v.name)}</option>`))
        .join('');
      return `<div class="vl-knock" data-ki="${i}">
        <div class="vl-knock-info">
          <div class="vl-knock-name">${who} <span class="vl-knock-id">${esc(k.id)}</span></div>
          <div class="vl-knock-sub">${sub}</div>
        </div>
        <div class="vl-knock-actions">
          <select class="vl-knock-target" aria-label="Register as">${options}</select>
          <button class="btn-secondary vl-knock-bind" type="button">Register</button>
          <button class="btn-ghost vl-knock-me" type="button" title="This is my own Discord account">This is me</button>
          <button class="btn-ghost vl-knock-x" type="button" title="Dismiss (they can knock again — nothing is blocked)">×</button>
        </div>
      </div>`;
    }).join('');

  box.querySelectorAll('.vl-knock').forEach(row => {
    const k = knocks[Number(row.dataset.ki)];
    row.querySelector('.vl-knock-bind').addEventListener('click', () => {
      const targetId = row.querySelector('.vl-knock-target').value;
      if (targetId) vlAttachKnock(k, targetId);
      else vlStartNewPersonFromKnock(k);
    });
    row.querySelector('.vl-knock-me').addEventListener('click', () => vlClaimKnockAsWard(k));
    row.querySelector('.vl-knock-x').addEventListener('click', () => vlDismissKnock(k));
  });
}

async function vlDismissKnock(k, { silent = false } = {}) {
  if (!silent && !confirm(`Dismiss ${k.handle || k.id}? They can knock again — nothing is blocked.`)) return;
  try {
    await fetch(`/api/village/knocks/${encodeURIComponent(k.platform)}/${encodeURIComponent(k.id)}`, { method: 'DELETE' });
  } catch { /* best-effort */ }
  vlLoadKnocks();
}

/** "New person…" — open the detail panel prefilled with the knock's
 *  name + alias. The knock auto-clears on save (server reconciles
 *  knocks against new aliases). */
function vlStartNewPersonFromKnock(k) {
  vlStartNewPerson();
  const nameEl = $('vl-p-name');
  if (nameEl) nameEl.value = k.displayName || k.handle || '';
  const container = $('vl-p-aliases');
  if (container) {
    const div = document.createElement('div');
    div.innerHTML = vlAliasRowHtml(container.querySelectorAll('.vl-alias-row').length, k.platform, k.id, k.handle ?? '');
    const row = div.firstElementChild;
    row.querySelector('.vl-alias-rm').addEventListener('click', () => row.remove());
    container.appendChild(row);
  }
}

/** Attach the knock's alias to an existing villager. */
async function vlAttachKnock(k, villagerId) {
  const v = _vlReg?.villagers.find(x => x.id === villagerId);
  if (!v) return;
  if (!confirm(`Attach this Discord account to ${v.name}? Their messages will then carry ${v.name}'s access.`)) return;
  const aliases = [
    ...(v.aliases ?? []),
    { platform: k.platform, id: k.id, ...(k.handle ? { handle: k.handle } : {}) },
  ];
  try {
    const r = await fetch(`/api/village/villagers/${encodeURIComponent(villagerId)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliases }),
    });
    if (!r.ok) throw new Error(await vlErrMsg(r));
    _vlReg = null;
    vlRenderPeopleGrid(await vlFetch(true));
    vlLoadKnocks();
  } catch (err) { alert(`Error: ${err.message}`); }
}

/** "This is me" — claim the knock as the ward's own Discord account. */
async function vlClaimKnockAsWard(k) {
  if (!confirm(`Set ${k.handle || k.id} as YOUR Discord account? Your Familiar will treat DMs from this ID as you, with full private context.`)) return;
  state.discordWardUserId = k.id;
  saveSettings();
  const el = $('discord-ward-user-id');
  if (el) el.value = k.id;
  await vlDismissKnock(k, { silent: true });
}

function vlRenderPeopleGrid(reg) {
  const grid = $('vl-people-grid');
  if (!reg.villagers.length) {
    grid.innerHTML = '<p class="vl-chip-dim" style="grid-column:1/-1;padding:12px">No villagers yet. Click "+ Add person".</p>';
    return;
  }
  const catMap = new Map(reg.categories.map(c => [c.id, c]));
  grid.innerHTML = reg.villagers.map(v => {
    const chips = (v.categoryIds ?? []).map(cid => {
      const c = catMap.get(cid);
      return c ? `<span class="vl-chip${c.builtin ? ' vl-chip-green' : ''}">${esc(c.name)}</span>` : '';
    }).join('');
    const aliasSub = v.aliases?.length
      ? `<div class="vl-card-sub">${v.aliases.map(a => esc(a.platform)).join(' · ')}</div>` : '';
    return `<div class="vl-card${_vlSelP === v.id ? ' vl-sel' : ''}" data-vid="${esc(v.id)}" tabindex="0" role="button" aria-label="${esc(v.name)}">
      <div class="vl-card-name" title="${esc(v.name)}">${esc(v.name)}</div>
      <div class="vl-chips">${chips || '<span class="vl-chip-dim">unregistered</span>'}</div>
      ${aliasSub}
    </div>`;
  }).join('');
  grid.querySelectorAll('.vl-card').forEach(el => {
    el.addEventListener('click', () => vlSelectPerson(el.dataset.vid));
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); vlSelectPerson(el.dataset.vid); }
    });
  });
}

function vlSelectPerson(id) {
  _vlSelP = id;
  $('vl-people-grid').querySelectorAll('.vl-card').forEach(el => {
    el.classList.toggle('vl-sel', el.dataset.vid === id);
  });
  vlRenderPersonDetail(_vlReg?.villagers.find(v => v.id === id) ?? null);
  vlOpenDetail('vl-people-detail');
}

function vlStartNewPerson() {
  _vlSelP = null;
  $('vl-people-grid').querySelectorAll('.vl-card').forEach(el => el.classList.remove('vl-sel'));
  vlRenderPersonDetail(null);
  vlOpenDetail('vl-people-detail');
}

function vlRememberRowHtml(cat, currentVal) {
  const val = currentVal !== undefined ? currentVal : cat.default;
  const opts = [
    { v: true,   cls: 'vl-rem-free',  label: 'Free'  },
    { v: 'ask',  cls: 'vl-rem-ask',   label: 'Ask'   },
    { v: false,  cls: 'vl-rem-never', label: 'Never' },
  ];
  const btns = opts.map(o =>
    `<button class="vl-rem-btn ${o.cls}${o.v === val ? ' vl-rem-on' : ''}" data-cat="${esc(cat.key)}" data-val="${o.v}" type="button">${o.label}</button>`
  ).join('');
  return `<div class="vl-rem-row"><span class="vl-rem-label">${esc(cat.label)}</span><div class="vl-rem-toggle">${btns}</div></div>`;
}

// Disclosure row: for one remember-category, which circle may facts about this
// person in that category surface in? Default = session-bounded (the room the
// memory was made in caps it; never auto-widened). An explicit pick widens or
// tightens. 'ward-private' means "only ever when it's just us two".
function vlDisclosureRowHtml(cat, currentVal, categories) {
  const opts = [`<option value="">Default (session-bounded)</option>`,
    `<option value="ward-private"${currentVal === 'ward-private' ? ' selected' : ''}>Ward-private (just us)</option>`];
  for (const c of categories) {
    opts.push(`<option value="${esc(c.id)}"${currentVal === c.id ? ' selected' : ''}>${esc(c.name)}</option>`);
  }
  return `<div class="vl-rem-row"><span class="vl-rem-label">${esc(cat.label)}</span>` +
    `<select class="vl-disc-sel" data-cat="${esc(cat.key)}" style="flex:1">${opts.join('')}</select></div>`;
}

function vlRenderPersonDetail(villager) {
  const detail = $('vl-people-detail');
  const reg = _vlReg;
  if (!reg) return;
  const isNew = !villager;
  const selIds = new Set(villager?.categoryIds ?? []);
  const nonStrangerCats = reg.categories.filter(c => c.id !== VL_STRANGERS);

  const catToggles = nonStrangerCats.map(c =>
    `<button class="vl-cat-toggle${selIds.has(c.id) ? ' vl-on' : ''}" data-cid="${esc(c.id)}" type="button">${esc(c.name)}</button>`
  ).join('');

  const aliasRows = (villager?.aliases ?? []).map((a, i) => vlAliasRowHtml(i, a.platform, a.id, a.handle ?? '')).join('');

  const relFamOptions = Object.entries(VL_REL_FAM_LABELS).map(([val, label]) => {
    const sel = (villager?.relationToFamiliar ?? 'unaware') === val ? ' selected' : '';
    return `<option value="${esc(val)}"${sel}>${esc(label)}</option>`;
  }).join('');

  const remRows = VL_REMEMBER_CATS.map(cat =>
    vlRememberRowHtml(cat, villager?.remember?.[cat.key])
  ).join('');

  const discRows = VL_REMEMBER_CATS.map(cat =>
    vlDisclosureRowHtml(cat, villager?.disclosure?.[cat.key], reg.categories)
  ).join('');

  const graphNodeHtml = (!isNew && villager.graphNodeId)
    ? `<div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px">Graph node: <code>${esc(villager.graphNodeId)}</code></div>`
    : '';

  detail.innerHTML = `
    <div class="vl-detail-head">${isNew ? 'Add person' : esc(villager.name)}</div>
    <div>
      <div class="vl-field-label">Name</div>
      <input type="text" id="vl-p-name" value="${isNew ? '' : esc(villager.name)}" placeholder="e.g. Chen" style="width:100%">
    </div>
    <div>
      <div class="vl-field-label">Pronouns <span class="field-hint">(optional)</span></div>
      <input type="text" id="vl-p-pronouns" value="${isNew ? '' : esc(villager.pronouns ?? '')}" placeholder="e.g. she/her, they/them" style="width:100%">
    </div>
    <div>
      <div class="vl-field-label">Categories <span class="field-hint">(can overlap)</span></div>
      <div class="vl-cat-toggles" id="vl-p-cat-toggles">${catToggles || '<span class="vl-chip-dim">No categories defined yet.</span>'}</div>
    </div>
    <div>
      <div class="vl-field-label">Relation to the ward</div>
      <input type="text" id="vl-p-rel-ward" value="${isNew ? '' : esc(villager.relationToWard ?? '')}" placeholder="e.g. college roommate, therapist" style="width:100%">
    </div>
    <div>
      <div class="vl-field-label">Stance toward me <span class="field-hint">(how they relate to the Familiar)</span></div>
      <select id="vl-p-rel-fam" style="width:100%">${relFamOptions}</select>
    </div>
    <div>
      <div class="vl-field-label">Platform aliases <span class="field-hint">(matched by stable ID, not handle)</span></div>
      <div id="vl-p-aliases" style="display:flex;flex-direction:column;gap:5px">${aliasRows}</div>
      <div class="vl-add-row"><button class="btn-ghost" id="vl-p-alias-add" type="button" style="font-size:0.8rem">+ Alias</button></div>
    </div>
    <div>
      <div class="vl-field-label">Connection note</div>
      <input type="text" id="vl-p-conn" value="${isNew ? '' : esc(villager.connection ?? '')}" placeholder="How do you know them?" style="width:100%">
    </div>
    <div>
      <div class="vl-field-label">Communication style <span class="field-hint">(optional)</span></div>
      <input type="text" id="vl-p-comm" value="${isNew ? '' : esc(villager.commStyleNotes ?? '')}" placeholder="e.g. direct, uses sarcasm, prefers short messages" style="width:100%">
    </div>
    <div>
      <div class="vl-field-label">Notes <span class="field-hint">(optional — shareable; the Familiar may use these even when others are present)</span></div>
      <textarea id="vl-p-notes" placeholder="Anything else worth knowing…" style="width:100%;min-height:3.5em;resize:vertical">${isNew ? '' : esc(villager.notes ?? '')}</textarea>
    </div>
    <div>
      <div class="vl-field-label">Private notes <span class="field-hint">(ward-only — for sensitive things like orientation, health, or a legal name. The Familiar sees these only when it's just you two; held back automatically when anyone else is present. Not for trivia.)</span></div>
      <textarea id="vl-p-private-notes" placeholder="Sensitive context, for you and the Familiar only…" style="width:100%;min-height:3.5em;resize:vertical">${isNew ? '' : esc(villager.privateNotes ?? '')}</textarea>
    </div>
    <div>
      <div class="vl-field-label">Memory consent <span class="field-hint">(what I may store about this person — for my human's own settings, see Knowledge → Identity → ward → Remember settings)</span></div>
      <div id="vl-p-remember" class="vl-rem-grid">${remRows}</div>
    </div>
    <div>
      <div class="vl-field-label">Standing consent <span class="field-hint">(when both you and this person have agreed, the Familiar stops asking for per-fact consent about them — a "never store" category above still holds)</span></div>
      <label class="vl-consent-line"><input type="checkbox" id="vl-p-consent-ward" ${villager?.standingConsent?.wardAgreed ? 'checked' : ''}> I agree the Familiar may keep memories about this person</label>
      <label class="vl-consent-line"><input type="checkbox" id="vl-p-consent-villager" ${villager?.standingConsent?.villagerAgreed ? 'checked' : ''}> This person has agreed too</label>
    </div>
    <div>
      <div class="vl-field-label">Disclosure <span class="field-hint">(per category, which circle facts about this person may surface in — default keeps them to the room the memory was made in; pick a category to widen, or Ward-private to keep them to just us)</span></div>
      <div id="vl-p-disclosure" class="vl-rem-grid">${discRows}</div>
    </div>
    ${graphNodeHtml}
    <div class="vl-actions">
      <button class="btn-send" id="vl-p-save" type="button">${isNew ? 'Add person' : 'Save'}</button>
      ${!isNew ? `<button class="btn-danger" id="vl-p-del" type="button">Delete</button>` : ''}
      <button class="btn-ghost vl-detail-back" id="vl-p-back" type="button" style="display:none">← Back</button>
    </div>
    <div class="vl-status" id="vl-p-status"></div>
  `;

  detail.querySelectorAll('.vl-cat-toggle').forEach(btn =>
    btn.addEventListener('click', () => btn.classList.toggle('vl-on'))
  );
  $('vl-p-alias-add').addEventListener('click', () => {
    const container = $('vl-p-aliases');
    const i = container.querySelectorAll('.vl-alias-row').length;
    const div = document.createElement('div');
    div.innerHTML = vlAliasRowHtml(i, '', '', '');
    const row = div.firstElementChild;
    row.querySelector('.vl-alias-rm').addEventListener('click', () => row.remove());
    container.appendChild(row);
  });
  detail.querySelectorAll('.vl-alias-rm').forEach(btn =>
    btn.addEventListener('click', () => btn.closest('.vl-alias-row').remove())
  );
  detail.querySelectorAll('.vl-rem-toggle').forEach(group => {
    group.querySelectorAll('.vl-rem-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.vl-rem-btn').forEach(b => b.classList.remove('vl-rem-on'));
        btn.classList.add('vl-rem-on');
      });
    });
  });
  $('vl-p-save').addEventListener('click', () => vlSavePerson(villager?.id ?? null));
  $('vl-p-del')?.addEventListener('click', () => vlDeletePerson(villager.id));
  vlBindBackBtn('vl-p-back', 'vl-people-detail');
}

function vlAliasRowHtml(i, platform, id, handle) {
  return `<div class="vl-alias-row" data-aidx="${i}">
    <input type="text" placeholder="platform" value="${esc(platform)}" class="vl-alias-plat">
    <input type="text" placeholder="stable id" value="${esc(id)}" class="vl-alias-id">
    <input type="text" placeholder="handle" value="${esc(handle)}" class="vl-alias-hdl">
    <button class="btn-ghost vl-alias-rm" type="button" title="Remove" style="padding:2px 7px">×</button>
  </div>`;
}

async function vlSavePerson(id) {
  const status = $('vl-p-status');
  const name = $('vl-p-name').value.trim();
  if (!name) { status.textContent = 'Name is required.'; return; }
  const categoryIds = [...document.querySelectorAll('#vl-p-cat-toggles .vl-cat-toggle.vl-on')].map(b => b.dataset.cid);
  const aliases = [...document.querySelectorAll('#vl-p-aliases .vl-alias-row')]
    .map(row => ({
      platform: row.querySelector('.vl-alias-plat')?.value.trim() ?? '',
      id:       row.querySelector('.vl-alias-id')?.value.trim() ?? '',
      handle:   row.querySelector('.vl-alias-hdl')?.value.trim() || undefined,
    }))
    .filter(a => a.platform && a.id);
  const connection = $('vl-p-conn').value.trim();
  const pronouns = $('vl-p-pronouns')?.value.trim() || undefined;
  const relationToWard = $('vl-p-rel-ward')?.value.trim() || undefined;
  const relationToFamiliar = $('vl-p-rel-fam')?.value || 'unaware';
  const commStyleNotes = $('vl-p-comm')?.value.trim() || undefined;
  const notes = $('vl-p-notes')?.value.trim() || undefined;
  const privateNotes = $('vl-p-private-notes')?.value.trim() || undefined;
  const remember = {};
  document.querySelectorAll('#vl-p-remember .vl-rem-btn.vl-rem-on').forEach(btn => {
    const rawVal = btn.dataset.val;
    remember[btn.dataset.cat] = rawVal === 'true' ? true : rawVal === 'false' ? false : 'ask';
  });
  const standingConsent = {
    wardAgreed:     !!$('vl-p-consent-ward')?.checked,
    villagerAgreed: !!$('vl-p-consent-villager')?.checked,
  };
  const disclosure = {};
  document.querySelectorAll('#vl-p-disclosure .vl-disc-sel').forEach(sel => {
    const v = sel.value.trim();
    if (v) disclosure[sel.dataset.cat] = v;
  });
  status.textContent = 'Saving…';
  try {
    const r = await fetch(
      id ? `/api/village/villagers/${encodeURIComponent(id)}` : '/api/village/villagers',
      { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, categoryIds, aliases, connection,
          pronouns, relationToWard, relationToFamiliar, commStyleNotes, notes, privateNotes, remember, standingConsent, disclosure }) },
    );
    if (!r.ok) throw new Error(await vlErrMsg(r));
    const saved = await r.json();
    status.textContent = '✓ Saved';
    _vlReg = null;
    const reg = await vlFetch(true);
    _vlSelP = saved.id;
    vlRenderPeopleGrid(reg);
    vlRenderPersonDetail(reg.villagers.find(v => v.id === saved.id) ?? null);
    setTimeout(() => { const s = $('vl-p-status'); if (s) s.textContent = ''; }, 2000);
  } catch (err) { status.textContent = `Error: ${err.message}`; }
}

async function vlDeletePerson(id) {
  const v = _vlReg?.villagers.find(x => x.id === id);
  if (!v || !confirm(`Remove ${v.name} from your village?`)) return;
  const status = $('vl-p-status');
  status.textContent = 'Deleting…';
  try {
    const r = await fetch(`/api/village/villagers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(await vlErrMsg(r));
    _vlReg = null; _vlSelP = null;
    $('vl-people-detail').innerHTML = '<p style="color:var(--text-dim);font-size:0.85rem;padding:4px">Select a person or click &ldquo;+ Add person&rdquo;.</p>';
    vlCloseDetail('vl-people-detail');
    vlRenderPeopleGrid(await vlFetch(true));
  } catch (err) { status.textContent = `Error: ${err.message}`; }
}

// ── Categories ──

async function vlLoadCategories() {
  const grid = $('vl-cat-grid');
  grid.innerHTML = '<p class="logs-loading" style="grid-column:1/-1">Loading…</p>';
  try {
    vlRenderCatGrid(await vlFetch(true));
  } catch (err) { grid.innerHTML = vlErr(err); }
}

function vlRenderCatGrid(reg) {
  const grid = $('vl-cat-grid');
  grid.innerHTML = reg.categories.map(c => {
    const grants = Object.entries(c.grants ?? {});
    const grantHtml = grants.length
      ? grants.map(([k, v]) =>
          `<span class="${typeof v === 'string' ? 'vl-grant-chip vl-grant-chip-str' : 'vl-grant-chip'}">${esc(typeof v === 'string' ? `${k}: ${v}` : k)}</span>`
        ).join('')
      : `<span class="vl-grant-none">no grants</span>`;
    const badge = c.id === VL_STRANGERS ? ' 🔒' : c.builtin ? ' ⚙' : '';
    return `<div class="vl-card${_vlSelC === c.id ? ' vl-sel' : ''}" data-cid="${esc(c.id)}" tabindex="0" role="button" aria-label="${esc(c.name)}">
      <div class="vl-card-name" title="${esc(c.name)}">${esc(c.name)}${badge}</div>
      <div class="vl-grant-chips">${grantHtml}</div>
    </div>`;
  }).join('');
  grid.querySelectorAll('.vl-card').forEach(el => {
    el.addEventListener('click', () => vlSelectCategory(el.dataset.cid));
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); vlSelectCategory(el.dataset.cid); }
    });
  });
}

function vlSelectCategory(id) {
  _vlSelC = id;
  $('vl-cat-grid').querySelectorAll('.vl-card').forEach(el =>
    el.classList.toggle('vl-sel', el.dataset.cid === id)
  );
  vlRenderCatDetail(_vlReg?.categories.find(c => c.id === id) ?? null);
  vlOpenDetail('vl-cat-detail');
}

function vlStartNewCategory() {
  _vlSelC = null;
  $('vl-cat-grid').querySelectorAll('.vl-card').forEach(el => el.classList.remove('vl-sel'));
  vlRenderCatDetail(null);
  vlOpenDetail('vl-cat-detail');
}

function vlRenderCatDetail(cat) {
  const detail = $('vl-cat-detail');
  const isNew    = !cat;
  const isLocked = cat?.id === VL_STRANGERS;
  const isBuiltin = cat?.builtin && !isNew;

  const grantRows = Object.entries(cat?.grants ?? {}).map(([k, v], i) =>
    vlGrantRowHtml(i, k, typeof v === 'string' ? 'str' : 'bool', typeof v === 'string' ? v : (v ? 'true' : 'false'), isLocked)
  ).join('');

  detail.innerHTML = `
    <div class="vl-detail-head">${isNew ? 'New category' : esc(cat.name)}</div>
    ${isLocked ? `<p class="vl-note">🔒 The floor — everyone unrecognized resolves here. Grants are permanently locked to empty.</p>` : ''}
    <div>
      <div class="vl-field-label">Name${isBuiltin ? ' <span class="vl-lock">(fixed)</span>' : ''}</div>
      <input type="text" id="vl-c-name" value="${isNew ? '' : esc(cat.name)}" placeholder="e.g. Close Friends" style="width:100%"${isBuiltin ? ' disabled' : ''}>
    </div>
    <div>
      <div class="vl-field-label">Grants <span class="field-hint">(what this category lets someone know or see)</span></div>
      <div id="vl-c-grants" style="display:flex;flex-direction:column;gap:5px">${grantRows}</div>
      ${!isLocked ? `<div class="vl-add-row"><button class="btn-ghost" id="vl-c-grant-add" type="button" style="font-size:0.8rem">+ Grant</button></div>` : ''}
    </div>
    ${!isLocked ? `
    <div class="vl-actions">
      <button class="btn-send" id="vl-c-save" type="button">${isNew ? 'Create' : 'Save'}</button>
      ${!isNew && !cat.builtin ? `<button class="btn-danger" id="vl-c-del" type="button">Delete</button>` : ''}
      <button class="btn-ghost vl-detail-back" id="vl-c-back" type="button" style="display:none">← Back</button>
    </div>` : ''}
    <div class="vl-status" id="vl-c-status"></div>
  `;

  if (!isLocked) {
    $('vl-c-grant-add').addEventListener('click', () => {
      const container = $('vl-c-grants');
      const i = container.querySelectorAll('.vl-grant-row').length;
      const div = document.createElement('div');
      div.innerHTML = vlGrantRowHtml(i, '', 'bool', 'true', false);
      const row = div.firstElementChild;
      row.querySelector('.vl-grant-rm')?.addEventListener('click', () => row.remove());
      container.appendChild(row);
    });
    detail.querySelectorAll('.vl-grant-rm').forEach(btn =>
      btn.addEventListener('click', () => btn.closest('.vl-grant-row').remove())
    );
    $('vl-c-save').addEventListener('click', () => vlSaveCategory(cat?.id ?? null, isBuiltin));
    $('vl-c-del')?.addEventListener('click', () => vlDeleteCategory(cat.id));
    vlBindBackBtn('vl-c-back', 'vl-cat-detail');
  }
}

function vlGrantRowHtml(i, key, type, val, disabled) {
  const d = disabled ? ' disabled' : '';
  return `<div class="vl-grant-row" data-gidx="${i}">
    <input type="text" placeholder="grant key" value="${esc(key)}" class="vl-grant-key"${d}>
    <select class="vl-grant-type"${d}>
      <option value="bool"${type === 'bool' ? ' selected' : ''}>bool</option>
      <option value="str"${type === 'str' ? ' selected' : ''}>string</option>
    </select>
    <input type="text" placeholder="true / value" value="${esc(val)}" class="vl-grant-val"${d}>
    ${!disabled ? `<button class="btn-ghost vl-grant-rm" type="button" title="Remove" style="padding:2px 7px">×</button>` : '<span></span>'}
  </div>`;
}

function vlReadGrants() {
  const grants = {};
  document.querySelectorAll('#vl-c-grants .vl-grant-row').forEach(row => {
    const key = row.querySelector('.vl-grant-key')?.value.trim();
    const type = row.querySelector('.vl-grant-type')?.value;
    const val  = row.querySelector('.vl-grant-val')?.value.trim();
    if (!key) return;
    grants[key] = type === 'str' ? val : (val.toLowerCase() !== 'false' && val !== '0');
  });
  return grants;
}

async function vlSaveCategory(id, nameDisabled) {
  const status = $('vl-c-status');
  const nameVal = $('vl-c-name')?.value.trim();
  if (!id && !nameVal) { status.textContent = 'Name is required.'; return; }
  const grants = vlReadGrants();
  const body = id
    ? { grants, ...(nameDisabled ? {} : { name: nameVal }) }
    : { name: nameVal, grants };
  status.textContent = 'Saving…';
  try {
    const r = await fetch(
      id ? `/api/village/categories/${encodeURIComponent(id)}` : '/api/village/categories',
      { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    if (!r.ok) throw new Error(await vlErrMsg(r));
    const saved = await r.json();
    status.textContent = '✓ Saved';
    _vlReg = null;
    const reg = await vlFetch(true);
    _vlSelC = saved.id;
    vlRenderCatGrid(reg);
    vlRenderCatDetail(reg.categories.find(c => c.id === saved.id) ?? null);
    setTimeout(() => { const s = $('vl-c-status'); if (s) s.textContent = ''; }, 2000);
  } catch (err) { status.textContent = `Error: ${err.message}`; }
}

async function vlDeleteCategory(id) {
  const cat = _vlReg?.categories.find(c => c.id === id);
  if (!cat) return;
  const wouldBeEmpty = (_vlReg?.villagers ?? []).filter(v =>
    v.categoryIds?.includes(id) && v.categoryIds.filter(x => x !== id).length === 0
  );
  let reassignTo = null;
  if (wouldBeEmpty.length > 0) {
    const others = (_vlReg?.categories ?? []).filter(c => c.id !== id);
    const pick = prompt(
      `${wouldBeEmpty.length} person(s) only have this category.\n\nEnter the name of a category to move them to (or leave blank for Strangers):\n\n${others.map(c => c.name).join(', ')}`,
    );
    if (pick === null) return;
    const target = pick.trim() ? others.find(c => c.name.toLowerCase() === pick.trim().toLowerCase()) : null;
    if (pick.trim() && !target) { alert('Category not found.'); return; }
    reassignTo = target?.id ?? VL_STRANGERS;
  } else if (!confirm(`Delete "${cat.name}"?`)) return;

  const status = $('vl-c-status');
  status.textContent = 'Deleting…';
  try {
    const qs = reassignTo ? `?reassignTo=${encodeURIComponent(reassignTo)}` : '';
    const r = await fetch(`/api/village/categories/${encodeURIComponent(id)}${qs}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(await vlErrMsg(r));
    _vlReg = null; _vlSelC = null;
    $('vl-cat-detail').innerHTML = '<p style="color:var(--text-dim);font-size:0.85rem;padding:4px">Select a category to view or edit.</p>';
    vlCloseDetail('vl-cat-detail');
    vlRenderCatGrid(await vlFetch(true));
  } catch (err) { status.textContent = `Error: ${err.message}`; }
}

// ── Location knock list (V4.x) ──

async function vlLoadLocationKnocks() {
  const box = $('vl-location-knocks');
  if (!box) return;
  try {
    const r = await fetch('/api/village/location-knocks');
    vlRenderLocationKnocks(r.ok ? await r.json() : []);
  } catch { box.classList.add('hidden'); }
}

function vlRenderLocationKnocks(knocks) {
  const box = $('vl-location-knocks');
  if (!box) return;
  if (!Array.isArray(knocks) || !knocks.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = `<div class="vl-knocks-head">🚪 Knocked on the door <span class="field-hint">— Discord channels your Familiar has spoken in that aren't registered yet. Register them to set an access ceiling.</span></div>`
    + knocks.map((k, i) => {
      const channelId = k.channelId || (k.key.split(':channel:')[1] ?? '');
      const guildId   = k.guildId   || (k.key.match(/guild:([^:]+)/)?.[1] ?? '');
      const displayKey = channelId ? `#${channelId}` : k.key;
      const sub = [
        guildId ? `guild ${guildId}` : '',
        esc(k.platform ?? ''),
        `${k.count ?? 1}×, last ${k.lastSeenAt ? new Date(k.lastSeenAt).toLocaleString() : '?'}`,
      ].filter(Boolean).join(' · ');
      return `<div class="vl-knock" data-lki="${i}">
        <div class="vl-knock-info">
          <div class="vl-knock-name">${esc(displayKey)} <span class="vl-knock-id">${esc(k.key)}</span></div>
          <div class="vl-knock-sub">${sub}</div>
        </div>
        <div class="vl-knock-actions">
          <button class="btn-secondary vl-loc-knock-register" type="button">Register</button>
          <button class="btn-ghost vl-loc-knock-x" type="button" title="Dismiss (the channel can knock again — nothing is blocked)">×</button>
        </div>
      </div>`;
    }).join('');

  box.querySelectorAll('.vl-knock').forEach(row => {
    const k = knocks[Number(row.dataset.lki)];
    row.querySelector('.vl-loc-knock-register').addEventListener('click', () => vlRegisterFromLocationKnock(k));
    row.querySelector('.vl-loc-knock-x').addEventListener('click', () => vlDismissLocationKnock(k));
  });
}

async function vlDismissLocationKnock(k, { silent = false } = {}) {
  if (!silent && !confirm(`Dismiss knock from ${k.key}? It can knock again — nothing is blocked.`)) return;
  try {
    await fetch('/api/village/location-knocks', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: k.key }),
    });
  } catch { /* best-effort */ }
  vlLoadLocationKnocks();
}

/** Open the new-location panel prefilled with the knock's key. */
function vlRegisterFromLocationKnock(k) {
  vlStartNewLocation();
  const keyEl = $('vl-l-key');
  if (keyEl) keyEl.value = k.key;
  const labelEl = $('vl-l-label');
  if (labelEl) {
    const channelId = k.channelId || (k.key.split(':channel:')[1] ?? '');
    labelEl.value = channelId ? `Discord #${channelId}` : '';
  }
}

// ── Locations ──

async function vlLoadLocations() {
  const list = $('vl-loc-list');
  list.innerHTML = '<p class="logs-loading">Loading…</p>';
  try {
    vlRenderLocList(await vlFetch(true));
  } catch (err) { list.innerHTML = vlErr(err); }
  vlLoadLocationKnocks();
}

function vlRenderLocList(reg) {
  const list = $('vl-loc-list');
  if (!reg.locations.length) {
    list.innerHTML = '<p class="vl-chip-dim" style="padding:12px">No locations yet. Click "+ Add location".</p>';
    return;
  }
  const catMap = new Map(reg.categories.map(c => [c.id, c]));
  list.innerHTML = reg.locations.map(l => {
    const cat = catMap.get(l.assignedCategoryId);
    const chip = cat ? `<span class="vl-chip${cat.builtin ? ' vl-chip-green' : ''}" style="flex-shrink:0">${esc(cat.name)}</span>` : '';
    const mode = ['strict', 'lurk', 'active'].includes(l.mode) ? l.mode : 'strict';
    const modeChip = mode !== 'strict'
      ? `<span class="vl-chip" style="flex-shrink:0" title="Presence mode">${esc(mode)}</span>` : '';
    const botChip = l.readBots === true
      ? `<span class="vl-chip" style="flex-shrink:0" title="Reads other bots & Familiars">🤖</span>` : '';
    return `<div class="vl-loc-card${_vlSelL === l.key ? ' vl-sel' : ''}" data-lkey="${esc(l.key)}" tabindex="0" role="button">
      <div class="vl-loc-label" title="${esc(l.label)}">${esc(l.label)}</div>
      <div class="vl-loc-key"   title="${esc(l.key)}">${esc(l.key)}</div>
      ${modeChip}${botChip}${chip}
    </div>`;
  }).join('');
  list.querySelectorAll('.vl-loc-card').forEach(el => {
    el.addEventListener('click', () => vlSelectLocation(el.dataset.lkey));
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); vlSelectLocation(el.dataset.lkey); }
    });
  });
}

function vlSelectLocation(key) {
  _vlSelL = key;
  $('vl-loc-list').querySelectorAll('.vl-loc-card').forEach(el =>
    el.classList.toggle('vl-sel', el.dataset.lkey === key)
  );
  vlRenderLocDetail(_vlReg?.locations.find(l => l.key === key) ?? null);
  vlOpenDetail('vl-loc-detail');
}

function vlStartNewLocation() {
  _vlSelL = null;
  $('vl-loc-list').querySelectorAll('.vl-loc-card').forEach(el => el.classList.remove('vl-sel'));
  vlRenderLocDetail(null);
  vlOpenDetail('vl-loc-detail');
}

function vlRenderLocDetail(loc) {
  const detail = $('vl-loc-detail');
  const reg = _vlReg;
  if (!reg) return;
  const isNew = !loc;
  const catOpts = reg.categories.map(c =>
    `<option value="${esc(c.id)}"${loc?.assignedCategoryId === c.id ? ' selected' : ''}>${esc(c.name)}</option>`
  ).join('');

  // Connection dropdown — lets the ward assign a specific API connection
  // (e.g. a throttled key for public Discord rooms) instead of the primary.
  const connOpts = [
    `<option value=""${!loc?.connectionId ? ' selected' : ''}>— use default —</option>`,
    ...(state.connections ?? []).map(c => {
      const label = c.name || c.provider || c.id;
      return `<option value="${esc(c.id)}"${loc?.connectionId === c.id ? ' selected' : ''}>${esc(label)}</option>`;
    }),
  ].join('');

  detail.innerHTML = `
    <div class="vl-detail-head">${isNew ? 'Add location' : esc(loc.label)}</div>
    <div>
      <div class="vl-field-label">Key <span class="field-hint">(unique, e.g. discord:guild:123:channel:456)</span></div>
      <input type="text" id="vl-l-key" value="${isNew ? '' : esc(loc.key)}" placeholder="discord:guild:…" style="width:100%"${!isNew ? ' readonly' : ''}>
    </div>
    <div>
      <div class="vl-field-label">Label</div>
      <input type="text" id="vl-l-label" value="${isNew ? '' : esc(loc.label)}" placeholder="e.g. #general in Chen's server" style="width:100%">
    </div>
    <div>
      <div class="vl-field-label">Trust ceiling <span class="field-hint">(anyone here is treated as at most this)</span></div>
      <select id="vl-l-cat" style="width:100%">${catOpts}</select>
    </div>
    <div>
      <div class="vl-field-label">Connection <span class="field-hint">(optional — use a specific API key for this location)</span></div>
      <select id="vl-l-conn" style="width:100%">${connOpts}</select>
    </div>
    <div>
      <div class="vl-field-label">Rate limit (messages/hour, optional)</div>
      <input type="number" id="vl-l-rate" value="${loc?.rateLimit?.perHour ?? ''}" placeholder="unlimited" min="0" step="1" style="width:100%">
    </div>
    <div>
      <div class="vl-field-label">Presence <span class="field-hint">(how the Familiar behaves in this room)</span></div>
      <select id="vl-l-mode" style="width:100%">
        <option value="strict">Strict — only replies when @-mentioned</option>
        <option value="lurk">Lurk — reads the room, replies when addressed</option>
        <option value="active">Active — can chime in without being mentioned</option>
      </select>
    </div>
    <div id="vl-l-active-opts" style="display:none;padding-left:8px;border-left:2px solid var(--border,#333)">
      <div class="vl-field-label">Active cadence</div>
      <select id="vl-l-active-strategy" style="width:100%">
        <option value="llm">Familiar's judgment — decides each time whether to speak</option>
        <option value="tiers">Activity tiers — paces itself to how busy the room is</option>
      </select>
      <div class="vl-field-label" style="margin-top:6px">Min seconds between unprompted replies</div>
      <input type="number" id="vl-l-active-cooldown" value="${loc?.activeCooldownSec ?? ''}" placeholder="60" min="0" step="5" style="width:100%">
      <p class="field-hint">A hard floor on unprompted turns, so active presence stays affordable. The hourly rate limit above still applies on top.</p>
    </div>
    <div>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" id="vl-l-readbots">
        <span class="vl-field-label" style="margin:0">Read other bots &amp; Familiars here</span>
      </label>
      <p class="field-hint">Off by default. On = the Familiar sees and can answer other bots/Familiars in this room (it still never answers itself; loops are paced by the cooldown and rate limit above). Use for shared Familiar channels.</p>
    </div>
    <div class="vl-actions">
      <button class="btn-send" id="vl-l-save" type="button">${isNew ? 'Add location' : 'Save'}</button>
      ${!isNew ? `<button class="btn-danger" id="vl-l-del" type="button">Delete</button>` : ''}
      <button class="btn-ghost vl-detail-back" id="vl-l-back" type="button" style="display:none">← Back</button>
    </div>
    <div class="vl-status" id="vl-l-status"></div>
  `;

  // Presence mode: <select>s can't carry a selected attr via the template
  // above without string-building, so set the values and wire the
  // active-options reveal here after the markup lands.
  const modeSel = $('vl-l-mode');
  if (modeSel) {
    modeSel.value = ['strict', 'lurk', 'active'].includes(loc?.mode) ? loc.mode : 'strict';
    const stratSel = $('vl-l-active-strategy');
    if (stratSel) stratSel.value = loc?.activeStrategy === 'tiers' ? 'tiers' : 'llm';
    const toggleActiveOpts = () => {
      const box = $('vl-l-active-opts');
      if (box) box.style.display = modeSel.value === 'active' ? '' : 'none';
    };
    modeSel.addEventListener('change', toggleActiveOpts);
    toggleActiveOpts();
  }
  const readBotsBox = $('vl-l-readbots');
  if (readBotsBox) readBotsBox.checked = loc?.readBots === true;

  $('vl-l-save').addEventListener('click', () => vlSaveLocation(loc?.key ?? null));
  $('vl-l-del')?.addEventListener('click', () => vlDeleteLocation(loc.key));
  vlBindBackBtn('vl-l-back', 'vl-loc-detail');
}

async function vlSaveLocation(key) {
  const status = $('vl-l-status');
  const locKey  = $('vl-l-key').value.trim();
  if (!locKey) { status.textContent = 'Key is required.'; return; }
  const label  = $('vl-l-label').value.trim() || locKey;
  const assignedCategoryId = $('vl-l-cat').value;
  const connectionId = $('vl-l-conn')?.value || null;
  const rateRaw = $('vl-l-rate').value.trim();
  const rateLimit = rateRaw ? { perHour: parseInt(rateRaw, 10) } : null;
  const mode = $('vl-l-mode')?.value || 'strict';
  const activeStrategy = $('vl-l-active-strategy')?.value || 'llm';
  const cdRaw = $('vl-l-active-cooldown')?.value.trim();
  const activeCooldownSec = cdRaw ? parseInt(cdRaw, 10) : undefined;
  const readBots = $('vl-l-readbots')?.checked === true;
  status.textContent = 'Saving…';
  try {
    const r = await fetch('/api/village/locations', {
      method: key ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: locKey, label, assignedCategoryId, connectionId, rateLimit, mode, activeStrategy, activeCooldownSec, readBots }),
    });
    if (!r.ok) throw new Error(await vlErrMsg(r));
    const saved = await r.json();
    status.textContent = '✓ Saved';
    _vlReg = null;
    const reg = await vlFetch(true);
    _vlSelL = saved.key;
    vlRenderLocList(reg);
    vlRenderLocDetail(reg.locations.find(l => l.key === saved.key) ?? null);
    vlLoadLocationKnocks();
    setTimeout(() => { const s = $('vl-l-status'); if (s) s.textContent = ''; }, 2000);
  } catch (err) { status.textContent = `Error: ${err.message}`; }
}

async function vlDeleteLocation(key) {
  if (!confirm(`Delete location "${key}"?`)) return;
  const status = $('vl-l-status');
  status.textContent = 'Deleting…';
  try {
    const r = await fetch('/api/village/locations', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (!r.ok) throw new Error(await vlErrMsg(r));
    _vlReg = null; _vlSelL = null;
    $('vl-loc-detail').innerHTML = '<p style="color:var(--text-dim);font-size:0.85rem;padding:4px">Select a location to view or edit.</p>';
    vlCloseDetail('vl-loc-detail');
    vlRenderLocList(await vlFetch(true));
  } catch (err) { status.textContent = `Error: ${err.message}`; }
}

// ── Mobile detail-panel helpers ──

function vlOpenDetail(id) {
  const el = $(id);
  if (!el) return;
  el.classList.add('vl-open');
  // Show back button only on mobile
  el.querySelectorAll('.vl-detail-back').forEach(b => {
    b.style.display = window.matchMedia('(max-width: 767px)').matches ? '' : 'none';
  });
}
function vlCloseDetail(id) { $(id)?.classList.remove('vl-open'); }
function vlBindBackBtn(btnId, panelId) {
  const btn = $(btnId);
  if (!btn) return;
  btn.style.display = window.matchMedia('(max-width: 767px)').matches ? '' : 'none';
  btn.addEventListener('click', () => vlCloseDetail(panelId));
}

// ── Session audience (Village Support V2) ────────────────────────────────────
//
// Tracks who is physically present during the session. The Familiar is aware
// of them (referenced in context) and V3 will use the list for knowledge
// gating. State lives in `state.sessionAudience` and is cleared on new session.

let _audienceReg = null; // cached village registry for the popover

function toggleAudiencePopover() {
  const popover = $('audience-popover');
  if (!popover) return;
  if (popover.classList.contains('hidden')) openAudiencePopover();
  else closeAudiencePopover();
}

function openAudiencePopover() {
  const popover = $('audience-popover');
  if (!popover) return;
  popover.classList.remove('hidden');
  $('audience-btn').setAttribute('aria-expanded', 'true');
  $('audience-btn').classList.add('active');
  audiencePopulateDatalist();
  renderAudienceChips();
  $('audience-search').focus();
}

function closeAudiencePopover() {
  const popover = $('audience-popover');
  if (!popover) return;
  popover.classList.add('hidden');
  $('audience-btn').setAttribute('aria-expanded', 'false');
  $('audience-btn').classList.remove('active');
}

async function audiencePopulateDatalist() {
  try {
    if (!_audienceReg) {
      const r = await fetch('/api/village');
      if (r.ok) _audienceReg = await r.json();
    }
    const dl = $('audience-datalist');
    if (!dl || !_audienceReg) return;
    dl.innerHTML = (_audienceReg.villagers ?? []).map(v =>
      `<option value="${esc(v.name)}">`
    ).join('');
  } catch { /* network blip — datalist stays empty, free-text still works */ }
}

function audienceAddFromInput() {
  const input = $('audience-search');
  const name  = input?.value.trim();
  if (!name) return;

  // Resolve to a villager id if the name matches; else store the raw name.
  const villager = (_audienceReg?.villagers ?? []).find(v => v.name.toLowerCase() === name.toLowerCase());
  const id = villager?.id ?? null;

  const audience = state.sessionAudience ?? { location: null, participants: [] };
  const already  = audience.participants.some(p => (typeof p === 'string' ? p : p.id) === (id ?? name));
  if (already) { input.value = ''; return; }

  audience.participants = [...audience.participants, id ? { id, name: villager.name } : { id: null, name }];
  state.sessionAudience = audience;
  saveSettings();
  renderAudienceChips();
  updateAudienceBtn();
  input.value = '';
}

function audienceRemove(identifier) {
  const audience = state.sessionAudience ?? { location: null, participants: [] };
  audience.participants = audience.participants.filter(p => {
    const key = (typeof p === 'string' ? p : p.name);
    return key !== identifier;
  });
  state.sessionAudience = audience;
  saveSettings();
  renderAudienceChips();
  updateAudienceBtn();
}

function renderAudienceChips() {
  const container = $('audience-participants');
  if (!container) return;
  const participants = state.sessionAudience?.participants ?? [];
  if (!participants.length) {
    container.innerHTML = '<span style="font-size:0.76rem;color:var(--text-dim)">No one added yet.</span>';
    return;
  }
  container.innerHTML = participants.map(p => {
    const name = typeof p === 'string' ? p : p.name;
    return `<div class="audience-chip">
      <span>${esc(name)}</span>
      <button data-name="${esc(name)}" title="Remove" aria-label="Remove ${esc(name)}">×</button>
    </div>`;
  }).join('');
  container.querySelectorAll('button[data-name]').forEach(btn =>
    btn.addEventListener('click', () => audienceRemove(btn.dataset.name))
  );
}

function updateAudienceBtn() {
  const btn = $('audience-btn');
  const label = $('audience-label');
  if (!btn || !label) return;
  const participants = state.sessionAudience?.participants ?? [];
  if (!participants.length) {
    label.textContent = 'Present';
    btn.classList.remove('active');
    return;
  }
  const names = participants.map(p => (typeof p === 'string' ? p : p.name));
  label.textContent = names.length <= 2 ? names.join(', ') : `${names[0]} +${names.length - 1}`;
  btn.classList.add('active');
}



