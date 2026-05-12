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
};

const PROVIDER_DEFAULT_MODEL = {
  nanogpt:      'gpt-4o-mini',
  zai:          'glm-4.7',
  'zai-coding': 'glm-4.7',
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
 * Maximum tool-call rounds per send before giving up.
 * Prevents infinite loops if a model repeatedly calls tools.
 */
const MAX_TOOL_ROUNDS = 5;

/**
 * Tool definitions sent to the LLM for built-in tools.
 * The format matches the OpenAI function-calling spec.
 */
const BUILTIN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_datetime',
      description: 'Returns the current local date, time, and timezone. Use this any time the user asks what time or date it is.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_session_info',
      description: 'Returns metadata about the current chat session: when it started, how many messages it contains, which provider and model are in use.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

/** Client-side implementations of the built-in tools. */
const BUILTIN_EXECUTORS = {
  get_datetime: () => new Date().toLocaleString([], {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }),
  get_session_info: () => JSON.stringify({
    startedAt:    state.sessionStartedAt,
    messageCount: state.messages.length,
    provider:     state.provider,
    model:        state.model,
    elapsedMsSinceLastMessage: elapsedTime,
  }, null, 2),
};

/** Returns the full tools array (built-ins + valid user-defined tools). */
function getActiveTools() {
  const tools = [...BUILTIN_TOOLS];
  if (state.customTools && state.customTools.trim()) {
    try {
      const extra = JSON.parse(state.customTools);
      if (Array.isArray(extra)) tools.push(...extra);
    } catch { /* invalid JSON — silently skip */ }
  }
  return tools;
}

/** Execute a tool by name. Returns the result string. */
function executeToolCall(name, argsJson) {
  if (Object.prototype.hasOwnProperty.call(BUILTIN_EXECUTORS, name)) {
    try {
      const args = argsJson ? JSON.parse(argsJson) : {};
      return String(BUILTIN_EXECUTORS[name](args));
    } catch (err) {
      return `Error executing ${name}: ${err.message}`;
    }
  }
  return `Tool "${name}" has no client-side implementation. No result available.`;
}

/**
 * Sanitise a state message into the shape the upstream API expects.
 * Strips client-only fields: timestamp, _toolName.
 */
function toApiMessage({ role, content, tool_calls, tool_call_id }) {
  if (role === 'tool')  return { role, tool_call_id, content };
  if (tool_calls)       return { role, content: content ?? null, tool_calls };
  return { role, content };
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
  userName:          'User',
  charName:          'Assistant',
  systemPrompt:      '',
  characterProfile:  '',
  userProfile:       '',
  postHistoryPrompt: '',
  sessionId:         null,   // UUID, created at init or on clear
  sessionStartedAt:  null,   // ISO timestamp
  sessionEndedAt:    null,   // ISO timestamp — set when session is auto-ended
  lastMessage:       null,   // ISO timestamp — mirrors the module-level lastMessage
  messages:          [],     // { role, content, timestamp }[]
  // ── Tool calling ──────────────────────────────────────────
  toolsEnabled:      true,   // whether to send tools array with each request
  customTools:       '',     // JSON array string of user-defined tool definitions
  // ── Topics & lorebook ────────────────────────────────────
  lorebookScanDepth:         4,      // how many recent messages to scan for keyword matches
  lorebookRecursive:         false,  // enable recursive lorebook activation
  lorebookMaxRecursionSteps: 3,      // max recursive passes
  lorebookCaseSensitive:     false,  // global case-sensitive keyword matching
  lorebookMatchWholeWords:   false,  // global whole-word keyword matching
  lorebook:          { entries: {} }, // cached from server; NOT persisted in localStorage
  topics:            [],     // session-level; stored under pf_topics_{sessionId}
};

// ── Persistence ──────────────────────────────────────────────────
function saveSettings() {
  try {
    const { messages: _ignored, lorebook: _lb, topics: _t, ...settings } = state;
    localStorage.setItem('pf_settings', JSON.stringify(settings));
  } catch { /* quota exceeded — silently skip */ }
}

function saveTopics() {
  if (!state.sessionId) return;
  try {
    localStorage.setItem(`pf_topics_${state.sessionId}`, JSON.stringify(state.topics));
  } catch { /* quota exceeded */ }
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

// ── Name variable substitution ──────────────────────────────────
/**
 * Replace {{user}} and {{char}} in a prompt string with the
 * configured user/AI display names.
 */
function applyNameVars(text) {
  return text
    .replace(/\{\{user\}\}/gi, state.userName || 'User')
    .replace(/\{\{char\}\}/gi, state.charName || 'Assistant');
}

// ── Message building ─────────────────────────────────────────────
/**
 * Sanitises a state message for the upstream API:
 * strips client-only fields (timestamp, _toolName) and ensures
 * the shape is correct for each role.
 */
function toApiMessage({ role, content, tool_calls, tool_call_id }) {
  if (role === 'tool')      return { role, tool_call_id, content };
  if (tool_calls)           return { role, content: content ?? null, tool_calls };
  return { role, content };
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
function buildApiMessages(userInput) {
  const msgs = [];

  // ── Activate lorebook entries ────────────────────────────────
  const lore = activateLorebookEntries(userInput);
  const joinLore = (entries) =>
    entries.map(e => applyNameVars(e.content.trim())).filter(Boolean).join('\n\n---\n\n');

  // ── System message ────────────────────────────────────────────
  const systemParts = [];

  // Position 2 — top of system message
  if (lore.sys_top.length) systemParts.push(joinLore(lore.sys_top));

  if (state.systemPrompt.trim())
    systemParts.push(applyNameVars(state.systemPrompt.trim()));

  // Position 0 — before character profile
  if (lore.before_char.length) systemParts.push(joinLore(lore.before_char));

  if (state.characterProfile.trim())
    systemParts.push('[Character Profile]\n' + applyNameVars(state.characterProfile.trim()));

  // Position 1 — after character profile
  if (lore.after_char.length) systemParts.push(joinLore(lore.after_char));

  if (state.userProfile.trim())
    systemParts.push('[User Profile]\n' + applyNameVars(state.userProfile.trim()));

  // Position 3 — bottom of system message
  if (lore.sys_bottom.length) systemParts.push(joinLore(lore.sys_bottom));

  if (systemParts.length)
    msgs.push({ role: 'system', content: systemParts.join('\n\n---\n\n') });

  // ── History + position-4 (@depth) injections ─────────────────
  // Clone history as clean API messages so we can splice into it
  const histMsgs = state.messages.map(toApiMessage);

  // Sort at_depth entries deepest-first so splice positions stay consistent
  const atDepthSorted = [...lore.at_depth].sort((a, b) => (b.depth ?? 4) - (a.depth ?? 4));
  const roleNames = ['system', 'user', 'assistant'];
  for (const entry of atDepthSorted) {
    const d    = Math.max(0, entry.depth ?? 4);
    const role = roleNames[entry.role ?? 0] ?? 'system';
    const idx  = Math.max(0, histMsgs.length - d);
    histMsgs.splice(idx, 0, { role, content: applyNameVars(entry.content.trim()) });
  }

  msgs.push(...histMsgs);

  // ── New user turn ─────────────────────────────────────────────
  msgs.push({ role: 'user', content: userInput });

  // ── Post-history prompt ───────────────────────────────────────
  if (state.postHistoryPrompt.trim())
    msgs.push({ role: 'user', content: applyNameVars(state.postHistoryPrompt.trim()) });

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

    // Inline code (before other inline rules)
    let s = part.replace(/`([^`\n]+)`/g, (_, c) => `<code>${esc(c)}</code>`);

    // Bold and italic (non-greedy, no newlines)
    s = s
      .replace(/\*\*\*([^\n*]+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^\n*]+?)\*\*/g,     '<strong>$1</strong>')
      .replace(/\*([^\n*]+?)\*/g,          '<em>$1</em>');

    // Escape HTML in non-code text (done after inline code to avoid double-escaping)
    // Note: esc() was already applied above via replace, we need a different strategy.
    // Redo: escape first, then apply markdown.
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

    // Ordered lists
    s = s.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    // (wrap already done above via same pattern)

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
}

/** Re-render all messages from state (used at init and after clear). */
function renderAllMessages() {
  const container = $('messages');
  container.innerHTML = '';
  let i = 0;
  while (i < state.messages.length) {
    const msg = state.messages[i];

    // Assistant message that contains tool_calls: render as tool-use block
    // and consume the following 'tool' result messages.
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
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

    const html = msg.role === 'user'
      ? esc(msg.content ?? '').replace(/\n/g, '<br>')
      : renderMarkdown(msg.content ?? '');
    const { el, copyBtn } = createMessageEl(msg.role, html, msg.timestamp);
    el.dataset.msgIndex = String(i);
    const capturedContent = msg.content;
    wireCopyButton(copyBtn, () => capturedContent);
    container.appendChild(el);
    i++;
  }
  updateRegenBtn();
  refreshTopicGutter();
  scrollToBottom();
}

function updateRegenBtn() {
  const last = state.messages[state.messages.length - 1];
  $('regen-btn').disabled = !last || last.role !== 'assistant';
}

// ── API communication ────────────────────────────────────────────
let abortController = null;

/** The last messages array sent to /api/chat (client-side, pre-enrichment). */
let lastSentMessages = null;

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
  lastMessage       = now;
  state.lastMessage = now;
  saveSettings();
  resetSessionTimeout();

  const userTimestamp = now;
  const apiMessages   = buildApiMessages(userInput);
  lastSentMessages    = apiMessages;

  // Optimistic UI
  appendUserMessage(userInput, userTimestamp);
  setInputLocked(true);
  setTyping(true);
  setStatus('busy');

  try {
    if (state.streaming) {
      await doStreamingRequest(apiMessages, userInput, userTimestamp);
    } else {
      await doNonStreamingRequest(apiMessages, userInput, userTimestamp);
    }
    setStatus('ok');
  } catch (err) {
    setTyping(false);
    if (err.name !== 'AbortError') {
      appendErrorMessage(err.message || 'Request failed.');
      setStatus('err');
    }
  } finally {
    setInputLocked(false);
    $('user-input').focus();
    abortController = null;
  }
}

async function doStreamingRequest(apiMessages, userInput, userTimestamp) {
  const activeTools     = state.toolsEnabled ? getActiveTools() : [];
  const pendingMsgs     = []; // tool_call + tool_result messages accumulated across rounds
  let   currentMsgs     = apiMessages;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    abortController = new AbortController();

    const extraPayload = activeTools.length > 0
      ? { tools: activeTools, tool_choice: 'auto' }
      : {};

    const response = await fetch('/api/chat', {
      method: 'POST',
      signal: abortController.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider:    state.provider,
        apiKey:      state.apiKey,
        model:       state.model,
        messages:    currentMsgs,
        stream:      true,
        temperature: state.temperature,
        max_tokens:  state.maxTokens,
        ...extraPayload,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      let msg = `API error ${response.status}`;
      try { msg = JSON.parse(body).error || msg; } catch { /* non-JSON */ }
      throw new Error(msg);
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer       = '';
    let fullContent  = '';
    let toolCallsAcc = {};  // index → {id, type, function:{name,arguments}}
    let finishReason = null;
    let shell        = null; // assistant bubble, created lazily on first content delta

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

        try {
          const parsed = JSON.parse(raw);
          const choice = parsed.choices?.[0];
          const delta  = choice?.delta;
          if (choice?.finish_reason) finishReason = choice.finish_reason;

          // Content delta
          if (typeof delta?.content === 'string' && delta.content.length > 0) {
            if (!shell) {
              setTyping(false);
              shell = appendAssistantShell(new Date().toISOString());
            }
            fullContent += delta.content;
            shell.bubble.innerHTML = renderMarkdown(fullContent);
            scrollToBottom();
          }

          // Tool-call deltas
          for (const tc of (delta?.tool_calls ?? [])) {
            const acc = (toolCallsAcc[tc.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
            if (tc.id)                    acc.id                   += tc.id;
            if (tc.function?.name)        acc.function.name        += tc.function.name;
            if (tc.function?.arguments)   acc.function.arguments   += tc.function.arguments;
          }
        } catch { /* malformed chunk */ }
      }
    }

    // ── Tool-call round ──────────────────────────────────────────
    if (finishReason === 'tool_calls' && round < MAX_TOOL_ROUNDS) {
      const toolCalls  = Object.values(toolCallsAcc);
      const roundTs    = new Date().toISOString();
      const toolResults = toolCalls.map(tc => ({
        role:         'tool',
        tool_call_id: tc.id,
        content:      executeToolCall(tc.function.name, tc.function.arguments),
        timestamp:    roundTs,
        _toolName:    tc.function.name,
      }));

      // Record in pending (for state.messages commit at the end)
      pendingMsgs.push({ role: 'assistant', content: fullContent || null, tool_calls: toolCalls, timestamp: roundTs });
      pendingMsgs.push(...toolResults);

      // Show compact tool-use block in chat
      setTyping(false);
      appendToolUseEl(toolCalls, toolResults);
      setTyping(true);

      // Extend apiMessages for next round
      currentMsgs = [
        ...currentMsgs,
        { role: 'assistant', content: fullContent || null, tool_calls: toolCalls },
        ...toolResults.map(({ timestamp: _t, _toolName: _n, ...m }) => m),
      ];
      continue;
    }

    // ── Final response ───────────────────────────────────────────
    if (!shell) {
      setTyping(false);
      shell = appendAssistantShell(new Date().toISOString());
    }
    const assistantTimestamp = shell.timeEl?.getAttribute('datetime') || new Date().toISOString();

    state.messages.push({ role: 'user',      content: userInput,   timestamp: userTimestamp });
    state.messages.push(...pendingMsgs);
    state.messages.push({ role: 'assistant', content: fullContent, timestamp: assistantTimestamp });
    saveHistory();
    refreshTopicGutter();
    wireCopyButton(shell.copyBtn, () => fullContent);
    updateRegenBtn();
    break;
  }
}

async function doNonStreamingRequest(apiMessages, userInput, userTimestamp) {
  const activeTools = state.toolsEnabled ? getActiveTools() : [];
  const pendingMsgs = [];
  let   currentMsgs = apiMessages;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    abortController = new AbortController();

    const extraPayload = activeTools.length > 0
      ? { tools: activeTools, tool_choice: 'auto' }
      : {};

    const response = await fetch('/api/chat', {
      method: 'POST',
      signal: abortController.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider:    state.provider,
        apiKey:      state.apiKey,
        model:       state.model,
        messages:    currentMsgs,
        stream:      false,
        temperature: state.temperature,
        max_tokens:  state.maxTokens,
        ...extraPayload,
      }),
    });

    const roundTs = new Date().toISOString();
    setTyping(false);

    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || `API error ${response.status}`);
    }

    const choice      = data.choices?.[0];
    const message     = choice?.message;
    const finishReason = choice?.finish_reason;

    // ── Tool-call round ──────────────────────────────────────────
    if (finishReason === 'tool_calls' && Array.isArray(message?.tool_calls) && round < MAX_TOOL_ROUNDS) {
      const toolCalls   = message.tool_calls;
      const toolResults = toolCalls.map(tc => ({
        role:         'tool',
        tool_call_id: tc.id,
        content:      executeToolCall(tc.function.name, tc.function.arguments),
        timestamp:    roundTs,
        _toolName:    tc.function.name,
      }));

      pendingMsgs.push({ role: 'assistant', content: message.content || null, tool_calls: toolCalls, timestamp: roundTs });
      pendingMsgs.push(...toolResults);

      appendToolUseEl(toolCalls, toolResults);
      setTyping(true);

      currentMsgs = [
        ...currentMsgs,
        { role: 'assistant', content: message.content || null, tool_calls: toolCalls },
        ...toolResults.map(({ timestamp: _t, _toolName: _n, ...m }) => m),
      ];
      continue;
    }

    // ── Final response ───────────────────────────────────────────
    const content = message?.content ?? '';
    const { bubble, copyBtn } = appendAssistantShell(roundTs);
    bubble.innerHTML = renderMarkdown(content);
    scrollToBottom();

    state.messages.push({ role: 'user',      content: userInput, timestamp: userTimestamp });
    state.messages.push(...pendingMsgs);
    state.messages.push({ role: 'assistant', content,            timestamp: roundTs });
    saveHistory();
    refreshTopicGutter();
    wireCopyButton(copyBtn, () => content);
    updateRegenBtn();
    break;
  }
}

// ── Regenerate ───────────────────────────────────────────────────
async function regenerateLastResponse() {
  if (state.messages.length < 2) return;

  // Pop last assistant + user turn, preserve the original user timestamp
  state.messages.pop();
  const { content: lastUserInput, timestamp: origUserTimestamp } = state.messages.pop();
  saveHistory();
  renderAllMessages();

  const userTimestamp = origUserTimestamp || new Date().toISOString();
  const apiMessages   = buildApiMessages(lastUserInput);
  lastSentMessages    = apiMessages;
  appendUserMessage(lastUserInput, userTimestamp);
  setInputLocked(true);
  setTyping(true);
  setStatus('busy');

  try {
    if (state.streaming) {
      await doStreamingRequest(apiMessages, lastUserInput, userTimestamp);
    } else {
      await doNonStreamingRequest(apiMessages, lastUserInput, userTimestamp);
    }
    setStatus('ok');
  } catch (err) {
    setTyping(false);
    if (err.name !== 'AbortError') {
      appendErrorMessage(err.message || 'Regeneration failed.');
      setStatus('err');
    }
  } finally {
    setInputLocked(false);
    $('user-input').focus();
  }
}

// ── Input lock ───────────────────────────────────────────────────
function setInputLocked(locked) {
  $('send-btn').disabled   = locked;
  $('regen-btn').disabled  = locked;
  $('user-input').disabled = locked;
}

// ── Auto-resize textarea ─────────────────────────────────────────
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
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
  state.userName          = $('user-name').value.trim() || 'User';
  state.charName          = $('char-name').value.trim() || 'Assistant';
  state.systemPrompt      = $('system-prompt').value;
  state.characterProfile  = $('char-profile').value;
  state.userProfile       = $('user-profile').value;
  state.postHistoryPrompt = $('post-history-prompt').value;
  state.toolsEnabled      = $('tools-enabled').checked;
  state.customTools       = $('custom-tools').value;
  const scanEl = $('lorebook-scan-depth');
  if (scanEl) state.lorebookScanDepth = Math.max(1, parseInt(scanEl.value, 10) || 4);
  const recursiveEl = $('lorebook-recursive');
  if (recursiveEl) state.lorebookRecursive = recursiveEl.checked;
  const maxRecEl = $('lorebook-max-recursion');
  if (maxRecEl) state.lorebookMaxRecursionSteps = Math.max(1, parseInt(maxRecEl.value, 10) || 3);
  const csEl = $('lorebook-case-sensitive');
  if (csEl) state.lorebookCaseSensitive = csEl.checked;
  const wwEl = $('lorebook-match-whole-words');
  if (wwEl) state.lorebookMatchWholeWords = wwEl.checked;
  saveSettings();
}

function writeSettingsToUI() {
  $('provider-select').value    = state.provider;
  $('api-key').value            = state.apiKey;
  $('model-input').value        = state.model;
  $('streaming-toggle').checked = state.streaming;
  $('temperature').value        = state.temperature;
  $('temp-display').textContent = state.temperature;
  $('max-tokens').value         = state.maxTokens;
  $('user-name').value          = state.userName ?? 'User';
  $('char-name').value          = state.charName ?? 'Assistant';
  $('system-prompt').value      = state.systemPrompt;
  $('char-profile').value       = state.characterProfile;
  $('user-profile').value       = state.userProfile;
  $('post-history-prompt').value = state.postHistoryPrompt;
  $('tools-enabled').checked    = state.toolsEnabled ?? true;
  $('custom-tools').value       = state.customTools ?? '';
  const scanEl = $('lorebook-scan-depth');
  if (scanEl) scanEl.value = state.lorebookScanDepth ?? 4;
  const recursiveEl = $('lorebook-recursive');
  if (recursiveEl) recursiveEl.checked = state.lorebookRecursive ?? false;
  const maxRecEl = $('lorebook-max-recursion');
  if (maxRecEl) maxRecEl.value = state.lorebookMaxRecursionSteps ?? 3;
  const csEl = $('lorebook-case-sensitive');
  if (csEl) csEl.checked = state.lorebookCaseSensitive ?? false;
  const wwEl = $('lorebook-match-whole-words');
  if (wwEl) wwEl.checked = state.lorebookMatchWholeWords ?? false;
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
  lastMessage            = null;
  state.lastMessage      = null;
  elapsedTime            = 0;
  saveSettings();
  try { localStorage.setItem('pf_history', JSON.stringify([])); } catch { /* ignore */ }
  $('messages').innerHTML = '';
  updateRegenBtn();
  updateTopicStrip();
  refreshTopicGutter();
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
    saveSettings();
    await saveToServer();
    startNewSession();
    showSessionEndedNotice();
    memorizeSessionToLorebook(sessionMessages, sessionId); // fire-and-forget
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
 * Automatically memorize a finished session into lorebook entries.
 * Fires-and-forgets after session close — never blocks the UI.
 * Calls the configured LLM to split the conversation into distinct topics
 * and creates a lorebook entry for each one.
 */
async function memorizeSessionToLorebook(messages, sessionId) {
  if (!state.apiKey.trim()) return;

  // Filter to user/assistant only — skip tool-call plumbing and empty turns
  const readable = messages.filter(m => {
    if (m.role === 'tool') return false;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return false;
    return m.content?.trim();
  });
  if (readable.length < 4) return;

  const convText = readable
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content ?? ''}`)
    .join('\n\n');

  const prompt =
`Analyze this conversation and identify the distinct topics discussed. For each topic produce a lorebook entry.

Return ONLY valid JSON with this exact shape (no markdown fences, no commentary):
{
  "topics": [
    {
      "title": "Concise descriptive title (max 60 chars)",
      "content": "Comprehensive third-person summary: key facts, decisions, and details worth remembering in future conversations.",
      "keywords": ["keyword1", "keyword2", "keyword3"]
    }
  ]
}

Rules:
- Identify 1–8 genuinely distinct topics. Merge closely related messages rather than over-splitting.
- keywords: 3–8 terms per topic that would signal relevance when mentioned in a future conversation (names, concepts, places, medications, decisions, etc.).
- Each entry must be self-contained and useful as a standalone memory.

Conversation:
${convText}`;

  try {
    const resp = await fetch('/api/chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider:    state.provider,
        apiKey:      state.apiKey,
        model:       state.model,
        messages:    [{ role: 'user', content: prompt }],
        stream:      false,
        temperature: 0.2,
        max_tokens:  2000,
      }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.error) return;

    const raw       = data.choices?.[0]?.message?.content ?? '';
    const jsonMatch = raw.match(/\{[\s\S]+\}/);
    if (!jsonMatch) return;
    const parsed = JSON.parse(jsonMatch[0]);
    const topics = parsed.topics;
    if (!Array.isArray(topics) || !topics.length) return;

    // Fetch the current lorebook fresh from the server so we don't overwrite
    // concurrent changes made in the new session that started after this one closed.
    let lorebookData = { entries: {} };
    try {
      const lbRes = await fetch('/api/lorebook');
      if (lbRes.ok) lorebookData = await lbRes.json();
    } catch { /* fall back to empty */ }

    const now = new Date().toISOString();
    let created = 0;
    for (const t of topics) {
      const title   = (t.title   ?? '').trim();
      const content = (t.content ?? '').trim();
      if (!title || !content) continue;
      const uid = generateId();
      lorebookData.entries[uid] = {
        uid,
        comment:             title,
        keys:                Array.isArray(t.keywords) ? t.keywords.map(k => String(k).trim()).filter(Boolean) : [],
        keysecondary:        [],
        content,
        constant:            false,
        selective:           false,
        selectiveLogic:      0,
        enabled:             true,
        position:            0,
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
        session_id:          sessionId,
        message_range:       null,
      };
      created++;
    }
    if (!created) return;

    await fetch('/api/lorebook', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: lorebookData.entries }),
    });

    // Merge into active state so the lorebook modal reflects new entries immediately.
    state.lorebook = lorebookData;
    showMemorizationNotice(created);
  } catch { /* non-critical — silently swallow any error */ }
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
      // Session expired while the tab was closed — finalize silently, then reset
      if (state.messages.length && !state.sessionEndedAt) {
        state.sessionEndedAt = lastMessage; // approximate — last known activity
        saveSettings();
        saveToServer(); // fire-and-forget
      }
      startNewSession();
    } else {
      // Resume the countdown with however much time remains
      _sessionTimeoutId = setTimeout(autoEndSession, SESSION_IDLE_MS - idleMs);
    }
  }

  // Apply saved theme
  const savedTheme = localStorage.getItem('pf_theme') || 'dark';
  applyTheme(savedTheme);

  // Populate UI from state
  writeSettingsToUI();
  renderAllMessages();
  initCollapsibles();

  // ── Settings field listeners ─────────────────────────────────
  const settingsIds = [
    'provider-select', 'api-key', 'model-input', 'streaming-toggle',
    'temperature', 'max-tokens', 'user-name', 'char-name',
    'system-prompt', 'char-profile',
    'user-profile', 'post-history-prompt', 'tools-enabled', 'custom-tools',
    'lorebook-scan-depth', 'lorebook-recursive', 'lorebook-max-recursion',
    'lorebook-case-sensitive', 'lorebook-match-whole-words',
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

  // Provider change → refresh model suggestions and set sane default
  $('provider-select').addEventListener('change', e => {
    const prov  = e.target.value;
    const input = $('model-input');
    refreshModelSuggestions(prov);
    // Only switch if the current model name doesn't exist in the new list
    if (!PROVIDER_MODELS[prov]?.includes(input.value)) {
      input.value = PROVIDER_DEFAULT_MODEL[prov] || '';
      state.model = input.value;
    }
    saveSettings();
  });

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

  // ── Regenerate ───────────────────────────────────────────────
  $('regen-btn').addEventListener('click', regenerateLastResponse);

  // ── Clear history ────────────────────────────────────────────
  $('clear-chat-btn').addEventListener('click', () => {
    if (!state.messages.length || confirm('Clear all chat history? The current session log will be kept.')) {
      if (state.messages.length) {
        const sessionMessages = [...state.messages];
        const sessionId       = state.sessionId;
        state.sessionEndedAt  = new Date().toISOString();
        saveSettings();
        saveToServer(); // fire-and-forget — stamps the log with endedAt
        startNewSession();
        memorizeSessionToLorebook(sessionMessages, sessionId); // fire-and-forget
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
    closeTopicNameModal();
    startTopic(label);
  });

  // Summary modal
  $('summary-modal-close').addEventListener('click', () => {
    if (confirm('Discard this topic summary? It will not be saved to the lorebook.')) {
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

  // Lorebook modal
  $('lorebook-btn').addEventListener('click', openLorebookModal);
  $('lorebook-modal-close').addEventListener('click', closeLorebookModal);
  $('lorebook-modal').addEventListener('click', e => {
    if (e.target === $('lorebook-modal')) closeLorebookModal();
  });
  $('lorebook-new-btn').addEventListener('click', () => openLoreEditor(null));

  // Lorebook entry editor modal
  $('lore-editor-close').addEventListener('click', closeLoreEditor);
  $('lore-editor-cancel').addEventListener('click', closeLoreEditor);
  $('lore-editor-modal').addEventListener('click', e => {
    if (e.target === $('lore-editor-modal')) closeLoreEditor();
  });
  $('lore-editor-save').addEventListener('click', saveLoreEditorEntry);
  $('lore-ed-selective').addEventListener('change', () => {
    $('lore-ed-secondary-section').classList.toggle('hidden', !$('lore-ed-selective').checked);
  });
  $('lore-ed-position').addEventListener('change', () => {
    const isAtDepth = $('lore-ed-position').value === '4';
    $('lore-ed-depth-field').classList.toggle('hidden', !isAtDepth);
    $('lore-ed-role-field').classList.toggle('hidden', !isAtDepth);
  });
  $('lore-ed-probability').addEventListener('input', () => {
    $('lore-ed-prob-display').textContent = `${$('lore-ed-probability').value}%`;
  });

  // Retro-end modal
  $('retro-end-modal-close').addEventListener('click', closeRetroEndModal);
  $('retro-end-cancel-btn').addEventListener('click', closeRetroEndModal);
  $('retro-end-modal').addEventListener('click', e => {
    if (e.target === $('retro-end-modal')) closeRetroEndModal();
  });

  // ── Load lorebook from server ─────────────────────────────────
  loadLorebookFromServer();

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

  // ── Focus input ──────────────────────────────────────────────
  $('user-input').focus();
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
 * Start a new topic, optionally anchored at a past message index.
 * If startIndex is provided it takes precedence over the current tail.
 */
function startTopic(label, startIndex = null) {
  const idx = startIndex !== null ? startIndex
    : (_retroStartIndex !== null ? _retroStartIndex : state.messages.length);
  _retroStartIndex = null;
  const topic = {
    id:         generateId(),
    label,
    color:      nextTopicColor(),
    startIndex: idx,
    endIndex:   null,
    lorebookEntryId: null,
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
  if (!rangeMessages.length || !state.apiKey.trim()) return;
  openSummaryModal(topic);
  generateTopicSummary(topic, rangeMessages);
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
let _loreEditUid      = null; // UID being edited in lorebook entry editor (null = new)
let lorebookTimedEffects = {}; // { [uid]: { stickyLeft: N, cooldownLeft: N } } — session only

// Normalise legacy string position values ('before_char', etc.) to integers.
function normEntryPos(pos) {
  if (typeof pos === 'number') return pos;
  const MAP = { 'before_char': 0, 'after_char': 1, 'sys_top': 2, 'sys_bottom': 3, 'at_depth': 4 };
  return MAP[pos] ?? 0;
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

// ── Summary generation ────────────────────────────────────────────
let _pendingSummaryTopic = null;

async function generateTopicSummary(topic, rangeMessages) {
  const convText = rangeMessages
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content ?? ''}`)
    .join('\n\n');

  const prompt = `Analyze the following conversation excerpt and produce a structured lorebook entry as a JSON object.

Return ONLY valid JSON with exactly these fields:
{
  "title": "Concise descriptive title (max 60 chars)",
  "content": "A comprehensive third-person summary capturing key facts, decisions, and important details from the exchange.",
  "keywords": ["keyword1", "keyword2", "keyword3"]
}

The keywords array should contain 3–8 terms that would signal this entry is relevant when mentioned in a future conversation (names, concepts, topics discussed, medications, places, etc.).

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

  const rangeMessages = [];
  for (let i = topic.startIndex; i <= topic.endIndex; i++) {
    const m = state.messages[i];
    if (!m || m.role === 'tool') continue;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) continue;
    rangeMessages.push(m);
  }
  await generateTopicSummary(topic, rangeMessages);
}

function populateSummaryForm({ title, content, keywords }) {
  $('summary-title-input').value   = title ?? '';
  $('summary-content-input').value = content ?? '';
  $('summary-keys-input').value    = Array.isArray(keywords) ? keywords.join(', ') : (keywords ?? '');
  $('summary-generating-hint').classList.add('hidden');
  $('summary-form').classList.remove('hidden');
  $('summary-regen-btn').disabled = false;
  $('summary-save-btn').disabled  = false;
}

// ── Summary modal ─────────────────────────────────────────────────
function openSummaryModal(topic) {
  _pendingSummaryTopic = topic;
  $('summary-modal-title').textContent = `Summary: ${topic.label}`;
  $('summary-generating-hint').classList.remove('hidden');
  $('summary-form').classList.add('hidden');
  $('summary-regen-btn').disabled = true;
  $('summary-save-btn').disabled  = true;
  $('summary-modal').classList.remove('hidden');
}

function closeSummaryModal() {
  $('summary-modal').classList.add('hidden');
  _pendingSummaryTopic = null;
}

async function savePendingSummary() {
  const topic = _pendingSummaryTopic;
  if (!topic) return;

  const title   = $('summary-title-input').value.trim();
  const content = $('summary-content-input').value.trim();
  const keysRaw = $('summary-keys-input').value;
  const keys    = keysRaw.split(',').map(k => k.trim()).filter(Boolean);

  if (!title || !content) {
    alert('Please fill in at least a title and summary content before saving.');
    return;
  }

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
    sticky:              null,
    cooldown:            null,
    preventRecursion:    false,
    delayUntilRecursion: false,
    excludeRecursion:    false,
    group:               '',
    groupWeight:         null,
    insertion_order:  100,
    created_at:       new Date().toISOString(),
    session_id:       state.sessionId,
    message_range:    [topic.startIndex, topic.endIndex],
  };

  try {
    // Merge into cached lorebook and push to server
    state.lorebook.entries[uid] = entry;
    await fetch('/api/lorebook', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: state.lorebook.entries }),
    });
    // Link back to topic
    topic.lorebookEntryId = uid;
    saveTopics();
    closeSummaryModal();
  } catch (err) {
    alert(`Failed to save lorebook entry: ${err.message}`);
  }
}

// ── Lorebook: server sync ─────────────────────────────────────────
async function loadLorebookFromServer() {
  try {
    const res  = await fetch('/api/lorebook');
    const data = await res.json();
    if (data.entries) state.lorebook = data;
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
  const cs = entry.caseSensitive ?? state.lorebookCaseSensitive ?? false;
  const ww = entry.matchWholeWords ?? state.lorebookMatchWholeWords ?? false;
  const h  = cs ? haystack : haystack.toLowerCase();
  const kw = cs ? keyword  : keyword.toLowerCase();
  if (ww) {
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\W)${esc}(?:$|\\W)`, cs ? '' : 'i').test(haystack);
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
    if (!entry.enabled) continue;
    if (alreadyActivated.has(entry.uid)) continue;
    if (isRecursion  && entry.excludeRecursion)    continue;
    if (!isRecursion && entry.delayUntilRecursion) continue;

    const timed = lorebookTimedEffects[entry.uid] ?? { stickyLeft: 0, cooldownLeft: 0 };
    if (timed.cooldownLeft > 0) continue;       // on cooldown
    if (timed.stickyLeft  > 0) { newlyActivated.push(entry); continue; } // sticky

    if (entry.constant) { newlyActivated.push(entry); continue; }

    // Probability check (100 always passes)
    const prob = entry.probability ?? 100;
    if (prob < 100 && Math.random() * 100 > prob) continue;

    // Get corpus for this entry (per-entry scan depth override)
    const corpus = getCorpus(entry.scanDepth ?? null);

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
    grp.sort((a, b) => {
      const wA = a.groupWeight ?? 100, wB = b.groupWeight ?? 100;
      if (wA !== wB) return wB - wA;
      return (a.insertion_order ?? 100) - (b.insertion_order ?? 100);
    });
    result.push(grp[0]);
  }
  return result;
}

/**
 * Main lorebook activation engine.
 * Returns { sys_top, before_char, after_char, sys_bottom, at_depth } arrays of activated entries.
 * at_depth entries carry the full entry object (use entry.depth and entry.role for injection).
 */
function activateLorebookEntries(userInput) {
  const empty = { sys_top: [], before_char: [], after_char: [], sys_bottom: [], at_depth: [] };
  const allEntries = Object.values(state.lorebook.entries ?? {});
  if (!allEntries.length) return empty;

  const globalDepth = state.lorebookScanDepth ?? 4;
  const messages    = state.messages;

  // Age timed effects by one tick; capture which UIDs just exhausted sticky
  const prevSticky = {};
  for (const uid of Object.keys(lorebookTimedEffects)) {
    const e = lorebookTimedEffects[uid];
    prevSticky[uid] = e.stickyLeft;
    if (e.stickyLeft  > 0) e.stickyLeft--;
    if (e.cooldownLeft > 0) e.cooldownLeft--;
  }

  // Corpus getter factory
  function makeGetCorpus(extra) {
    return (depthOverride) => {
      const d = depthOverride !== null && depthOverride !== undefined ? depthOverride : globalDepth;
      return buildScanText(messages, userInput, d, extra);
    };
  }

  // Initial scan pass
  const activated = new Set();
  for (const e of scanLoreEntries(allEntries, makeGetCorpus(''), activated, false)) {
    activated.add(e.uid);
  }

  // Recursive passes
  if (state.lorebookRecursive) {
    const maxSteps = state.lorebookMaxRecursionSteps ?? 3;
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
    if (!lorebookTimedEffects[e.uid]) lorebookTimedEffects[e.uid] = { stickyLeft: 0, cooldownLeft: 0 };
    if (e.sticky) lorebookTimedEffects[e.uid].stickyLeft = e.sticky;
  }
  // Entries whose sticky just expired and weren't re-activated → start cooldown
  const activatedSet = new Set(activatedEntries.map(e => e.uid));
  for (const uid of Object.keys(prevSticky)) {
    if (prevSticky[uid] > 0 && !(lorebookTimedEffects[uid]?.stickyLeft > 0) && !activatedSet.has(uid)) {
      const entry = allEntries.find(e => e.uid === uid);
      if (entry?.cooldown) {
        if (!lorebookTimedEffects[uid]) lorebookTimedEffects[uid] = { stickyLeft: 0, cooldownLeft: 0 };
        lorebookTimedEffects[uid].cooldownLeft = entry.cooldown;
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

// ── Lorebook modal ────────────────────────────────────────────────
function openLorebookModal() {
  $('lorebook-modal').classList.remove('hidden');
  refreshLorebookList();
}

function closeLorebookModal() {
  $('lorebook-modal').classList.add('hidden');
}

// ── Lorebook entry editor ─────────────────────────────────────────

function openLoreEditor(uid) {
  _loreEditUid = uid ?? null;
  const entry  = uid ? (state.lorebook.entries[uid] ?? {}) : {};

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

  $('lore-editor-modal').classList.remove('hidden');
}

function closeLoreEditor() {
  $('lore-editor-modal').classList.add('hidden');
  _loreEditUid = null;
}

async function saveLoreEditorEntry() {
  const content = $('lore-ed-content').value.trim();
  if (!content) { alert('Content is required.'); return; }

  const uid      = _loreEditUid || generateId();
  const existing = _loreEditUid ? (state.lorebook.entries[uid] ?? {}) : {};

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

  try {
    state.lorebook.entries[uid] = entry;
    await fetch('/api/lorebook', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: state.lorebook.entries }),
    });
    closeLoreEditor();
    refreshLorebookList();
  } catch (err) {
    alert(`Failed to save entry: ${err.message}`);
  }
}

async function refreshLorebookList() {
  await loadLorebookFromServer();
  const container = $('lorebook-list');
  container.innerHTML = '';

  const entries = Object.values(state.lorebook.entries ?? {});
  if (!entries.length) {
    container.innerHTML = '<p class="lorebook-empty">No lorebook entries yet. End a topic to create one, or click <strong>+ New</strong>.</p>';
    return;
  }

  // Sort newest first
  entries.sort((a, b) => new Date(b.created_at ?? 0) - new Date(a.created_at ?? 0));

  for (const entry of entries) {
    const div = document.createElement('div');
    div.className = 'lorebook-entry';

    const keyTagsHtml = (entry.keys ?? [])
      .slice(0, 8)
      .map(k => `<span class="lorebook-key-tag">${esc(k)}</span>`)
      .join('');

    const dateStr     = entry.created_at
      ? new Date(entry.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
      : '';
    const posLabel = ['Before char', 'After char', 'Sys top', 'Sys bottom', '@Depth'][normEntryPos(entry.position)] ?? '';
    const constBadge  = entry.constant ? ' · <strong>always-on</strong>' : '';
    const positionBadge = ` · ${posLabel}`;

    div.innerHTML = `
      <div class="lorebook-entry-header">
        <div class="lorebook-entry-title">${esc(entry.comment ?? 'Untitled')}</div>
        <div class="lorebook-entry-actions">
          <button class="btn-ghost lore-edit-btn" data-uid="${esc(entry.uid)}" title="Edit entry">Edit</button>
          <button class="btn-ghost lore-toggle-btn" data-uid="${esc(entry.uid)}" title="${entry.enabled ? 'Disable entry' : 'Enable entry'}">
            ${entry.enabled ? 'Enabled' : 'Disabled'}
          </button>
          <button class="btn-ghost lore-delete-btn" data-uid="${esc(entry.uid)}" title="Delete entry">✕</button>
        </div>
      </div>
      <div class="lorebook-entry-keys">${keyTagsHtml}</div>
      <div class="lorebook-entry-content">${esc(entry.content ?? '')}</div>
      <div class="lorebook-entry-meta">${esc(dateStr)}${constBadge}${positionBadge}</div>
    `;

    div.querySelector('.lore-edit-btn').addEventListener('click', () => openLoreEditor(entry.uid));
    div.querySelector('.lore-toggle-btn').addEventListener('click', () => toggleLorebookEntry(entry.uid));
    div.querySelector('.lore-delete-btn').addEventListener('click', () => deleteLorebookEntry(entry.uid));

    container.appendChild(div);
  }
}

async function toggleLorebookEntry(uid) {
  const entry = state.lorebook.entries[uid];
  if (!entry) return;
  entry.enabled = !entry.enabled;
  try {
    await fetch('/api/lorebook', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: state.lorebook.entries }),
    });
    refreshLorebookList();
  } catch (err) {
    alert(`Failed to update entry: ${err.message}`);
  }
}

async function deleteLorebookEntry(uid) {
  if (!confirm('Delete this lorebook entry? This cannot be undone.')) return;
  delete state.lorebook.entries[uid];
  try {
    await fetch(`/api/lorebook/${uid}`, { method: 'DELETE' });
    refreshLorebookList();
  } catch (err) {
    alert(`Failed to delete entry: ${err.message}`);
  }
}
