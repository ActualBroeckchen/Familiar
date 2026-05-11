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
  messages:          [],   // { role: 'user'|'assistant', content: string }[]
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
}

// ── Message building ─────────────────────────────────────────────
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
function createMessageEl(role, htmlContent) {
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

  body.appendChild(bubble);
  body.appendChild(actions);
  el.appendChild(avatar);
  el.appendChild(body);

  return { el, bubble, copyBtn };
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

function appendUserMessage(text) {
  const { el, copyBtn } = createMessageEl('user', esc(text).replace(/\n/g, '<br>'));
  wireCopyButton(copyBtn, () => text);
  $('messages').appendChild(el);
  scrollToBottom();
}

function appendAssistantShell() {
  const { el, bubble, copyBtn } = createMessageEl('assistant', '');
  $('messages').appendChild(el);
  scrollToBottom();
  return { el, bubble, copyBtn };
}

function appendErrorMessage(text) {
  const { el } = createMessageEl('error', `⚠ ${esc(text)}`);
  $('messages').appendChild(el);
  scrollToBottom();
}

/** Re-render all messages from state (used at init and after clear). */
function renderAllMessages() {
  const container = $('messages');
  container.innerHTML = '';
  for (const msg of state.messages) {
    const html = msg.role === 'user'
      ? esc(msg.content).replace(/\n/g, '<br>')
      : renderMarkdown(msg.content);
    const { el, copyBtn } = createMessageEl(msg.role, html);
    const capturedContent = msg.content;
    wireCopyButton(copyBtn, () => capturedContent);
    container.appendChild(el);
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

  const apiMessages = buildApiMessages(userInput);

  // Optimistic UI
  appendUserMessage(userInput);
  setInputLocked(true);
  setTyping(true);
  setStatus('busy');

  try {
    if (state.streaming) {
      await doStreamingRequest(apiMessages, userInput);
    } else {
      await doNonStreamingRequest(apiMessages, userInput);
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

async function doStreamingRequest(apiMessages, userInput) {
  abortController = new AbortController();

  const response = await fetch('/api/chat', {
    method: 'POST',
    signal: abortController.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider:     state.provider,
      apiKey:       state.apiKey,
      model:        state.model,
      messages:     apiMessages,
      stream:       true,
      temperature:  state.temperature,
      max_tokens:   state.maxTokens,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    let msg = `API error ${response.status}`;
    try { msg = JSON.parse(body).error || msg; } catch { /* non-JSON error body */ }
    throw new Error(msg);
  }

  setTyping(false);
  const { bubble, copyBtn } = appendAssistantShell();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';   // Keep incomplete final line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') {
          fullContent += delta;
          bubble.innerHTML = renderMarkdown(fullContent);
          scrollToBottom();
        }
      } catch { /* malformed chunk — ignore */ }
    }
  }

  // Commit to state only after full response
  state.messages.push({ role: 'user',      content: userInput });
  state.messages.push({ role: 'assistant', content: fullContent });
  saveHistory();
  wireCopyButton(copyBtn, () => fullContent);
  updateRegenBtn();
}

async function doNonStreamingRequest(apiMessages, userInput) {
  abortController = new AbortController();

  const response = await fetch('/api/chat', {
    method: 'POST',
    signal: abortController.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider:    state.provider,
      apiKey:      state.apiKey,
      model:       state.model,
      messages:    apiMessages,
      stream:      false,
      temperature: state.temperature,
      max_tokens:  state.maxTokens,
    }),
  });

  setTyping(false);

  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data.error || `API error ${response.status}`);
  }

  const content = data.choices?.[0]?.message?.content ?? '';
  const { bubble, copyBtn } = appendAssistantShell();
  bubble.innerHTML = renderMarkdown(content);
  scrollToBottom();

  state.messages.push({ role: 'user',      content: userInput });
  state.messages.push({ role: 'assistant', content });
  saveHistory();
  wireCopyButton(copyBtn, () => content);
  updateRegenBtn();
}

// ── Regenerate ───────────────────────────────────────────────────
async function regenerateLastResponse() {
  if (state.messages.length < 2) return;

  // Pop last assistant + user turn
  state.messages.pop();
  const { content: lastUserInput } = state.messages.pop();
  saveHistory();
  renderAllMessages();

  const apiMessages = buildApiMessages(lastUserInput);
  appendUserMessage(lastUserInput);
  setInputLocked(true);
  setTyping(true);
  setStatus('busy');

  try {
    if (state.streaming) {
      await doStreamingRequest(apiMessages, lastUserInput);
    } else {
      await doNonStreamingRequest(apiMessages, lastUserInput);
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
    const label = msg.role === 'user' ? '**User**' : '**Assistant**';
    md += `${label}\n\n${msg.content}\n\n---\n\n`;
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

// ── Init ─────────────────────────────────────────────────────────
function init() {
  // Restore persisted state
  loadPersisted();

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
    'user-profile', 'post-history-prompt',
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
    if (!state.messages.length || confirm('Clear all chat history?')) {
      state.messages = [];
      saveHistory();
      $('messages').innerHTML = '';
      updateRegenBtn();
      setStatus('');
    }
  });

  // ── Export chat ──────────────────────────────────────────────
  $('export-chat-btn').addEventListener('click', exportChat);

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
