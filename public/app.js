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
};

// ── Persistence ──────────────────────────────────────────────────
function saveSettings() {
  try {
    const { messages: _ignored, ...settings } = state;
    localStorage.setItem('pf_settings', JSON.stringify(settings));
  } catch { /* quota exceeded — silently skip */ }
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

  // ── System message ────────────────────────────────────────────
  const systemParts = [];
  if (state.systemPrompt.trim())
    systemParts.push(state.systemPrompt.trim());
  if (state.characterProfile.trim())
    systemParts.push('[Character Profile]\n' + state.characterProfile.trim());
  if (state.userProfile.trim())
    systemParts.push('[User Profile]\n' + state.userProfile.trim());

  if (systemParts.length)
    msgs.push({ role: 'system', content: systemParts.join('\n\n---\n\n') });

  // ── History ───────────────────────────────────────────────────
  msgs.push(...state.messages);

  // ── New user turn ─────────────────────────────────────────────
  msgs.push({ role: 'user', content: userInput });

  // ── Post-history prompt ───────────────────────────────────────
  if (state.postHistoryPrompt.trim())
    msgs.push({ role: 'user', content: state.postHistoryPrompt.trim() });

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
    const capturedContent = msg.content;
    wireCopyButton(copyBtn, () => capturedContent);
    container.appendChild(el);
    i++;
  }
  updateRegenBtn();
  scrollToBottom();
}

function updateRegenBtn() {
  const last = state.messages[state.messages.length - 1];
  $('regen-btn').disabled = !last || last.role !== 'assistant';
}

// ── API communication ────────────────────────────────────────────
let abortController = null;

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
    const label    = msg.role === 'user' ? '**User**' : '**Assistant**';
    const tsStr    = msg.timestamp ? ` _(${new Date(msg.timestamp).toLocaleString()})_` : '';
    md += `${label}${tsStr}\n\n${msg.content}\n\n---\n\n`;
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
  state.systemPrompt      = $('system-prompt').value;
  state.characterProfile  = $('char-profile').value;
  state.userProfile       = $('user-profile').value;
  state.postHistoryPrompt = $('post-history-prompt').value;
  state.toolsEnabled      = $('tools-enabled').checked;
  state.customTools       = $('custom-tools').value;
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
  $('system-prompt').value      = state.systemPrompt;
  $('char-profile').value       = state.characterProfile;
  $('user-profile').value       = state.userProfile;
  $('post-history-prompt').value = state.postHistoryPrompt;
  $('tools-enabled').checked    = state.toolsEnabled ?? true;
  $('custom-tools').value       = state.customTools ?? '';
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
  lastMessage            = null;
  state.lastMessage      = null;
  elapsedTime            = 0;
  saveSettings();
  try { localStorage.setItem('pf_history', JSON.stringify([])); } catch { /* ignore */ }
  $('messages').innerHTML = '';
  updateRegenBtn();
}

/**
 * Called when SESSION_IDLE_MS elapses since lastMessage.
 * Stamps the current session with endedAt, saves it, then starts a new session.
 */
async function autoEndSession() {
  _sessionTimeoutId = null;
  if (state.messages.length) {
    state.sessionEndedAt = new Date().toISOString();
    saveSettings();
    await saveToServer();
  }
  startNewSession();
  showSessionEndedNotice();
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
    'temperature', 'max-tokens', 'system-prompt', 'char-profile',
    'user-profile', 'post-history-prompt', 'tools-enabled', 'custom-tools',
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
      startNewSession();
      setStatus('');
    }
  });

  // ── Export chat ──────────────────────────────────────────────
  $('export-chat-btn').addEventListener('click', exportChat);

  // ── Logs modal ────────────────────────────────────────────
  $('logs-btn').addEventListener('click', openLogsModal);
  $('logs-modal-close').addEventListener('click', closeLogsModal);
  $('logs-modal').addEventListener('click', e => {
    if (e.target === $('logs-modal')) closeLogsModal();
  });

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
