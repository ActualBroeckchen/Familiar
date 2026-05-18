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
      description: 'I save a piece of knowledge or a fact I learned during this conversation into my persistent Tome knowledge base. I use this when {{user}} shares something important about themselves, their relationships, their preferences, or their situation that I should remember across future conversations. I do NOT use this for trivial, transient, or already-known information.',
      parameters: {
        type: 'object',
        properties: {
          title:    { type: 'string', description: 'Short descriptive label for this entry (e.g. "{{user}} stress about lateness").' },
          content:  { type: 'string', description: 'The knowledge to store. I write it as my own first-person notes to myself, concise but detailed enough to be useful as injected context in future conversations.' },
          keywords: { type: 'array', items: { type: 'string' }, description: 'Two to eight trigger keywords or short phrases — things {{user}} would literally say when this situation recurs. The entry will be injected into my prompt whenever these appear in conversation.' },
        },
        required: ['title', 'content', 'keywords'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'I write a new memory entry to my long-term memory system. I use this to record important events, emotional patterns, or significant moments from this conversation in my durable, time-stamped store. I prefer "daily" for routine session events; I use "significant" for major milestones.',
      parameters: {
        type: 'object',
        properties: {
          content:     { type: 'string', description: 'Memory content I write in first-person perspective. I use bullet points prefixed with [chat:auto] for individual facts.' },
          granularity: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly', 'significant'], description: 'Memory tier.' },
        },
        required: ['content', 'granularity'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_identity',
      description: 'I append a new durable fact to one of my persistent identity files. I use this for facts about {{user}} (category: user, filename: user_notes.md) or about my relationship with them (category: relationship, filename: relationship_notes.md). I do NOT use this for session-specific or transient information. When to choose append vs. rewrite_identity_section: I APPEND when adding a new fact that complements what is already there; I REWRITE a section when an existing section is now misleading or incomplete and a partial correction would leave it confusing.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['user', 'relationship'], description: 'Identity file category.' },
          filename: { type: 'string', description: 'Target filename within the category, e.g. user_notes.md or relationship_notes.md.' },
          content:  { type: 'string', description: 'Content to append to the identity file, written in my own first-person voice.' },
        },
        required: ['category', 'filename', 'content'],
      },
    },
  },
  // ── Knowledge-editing tools ───────────────────────────────────────────
  // The Familiar can correct stale or wrong information in memory / identity
  // / graph instead of letting it pile up. Each destructive op auto-snapshots
  // entity-core first, so the user can roll back via the Knowledge editor.
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
      description: 'I overwrite an existing memory entry to correct an inaccuracy. I use this when the entry is incomplete or partially wrong but the core record (this date, this granularity) is still the right place for the fact. I do NOT use this to record new information — that is save_memory. I do NOT use this to remove information — that is delete_memory. When the change is "X was true, now Y is true," prefer save_memory with today\'s date so the history is preserved.',
      parameters: {
        type: 'object',
        properties: {
          granularity: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly', 'significant'], description: 'Memory tier of the entry to overwrite.' },
          date:        { type: 'string', description: 'Date of the entry, in the same format the entry was stored (e.g. YYYY-MM-DD for daily).' },
          content:     { type: 'string', description: 'The full new contents. This REPLACES the entry — include everything I want to keep, not just the diff.' },
        },
        required: ['granularity', 'date', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_memory',
      description: 'I permanently delete a memory entry. I use this only when the entry is fully wrong or no longer relevant, and keeping it would mislead future-me. If the change has historical value ("they were on vacation last week, back now"), I do NOT delete — I write a new contradicting memory with save_memory instead, and let recency-decay demote the stale one. Entity-core auto-snapshots before each delete so a mistake is recoverable from the Knowledge editor.',
      parameters: {
        type: 'object',
        properties: {
          granularity: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly', 'significant'], description: 'Memory tier of the entry to delete.' },
          date:        { type: 'string', description: 'Date of the entry, in the same format the entry was stored.' },
        },
        required: ['granularity', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rewrite_identity_section',
      description: 'I replace one section of an identity file with new content. I use this when an existing section is now misleading or has accumulated stale notes and a clean rewrite serves future-me better than appending a correction. For NEW facts that just need to land somewhere, I use update_identity (append). For removing only a small piece, prefer rewriting the whole section over deletion.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['self', 'user', 'relationship', 'custom'], description: 'Identity file category.' },
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
      description: 'I delete an entity from my knowledge graph along with its edges. I use this only when the node is clearly an error (duplicate, wrong entity entirely) or refers to something that no longer exists in any meaningful sense. For "this relationship is no longer true" (e.g. they\'re no longer on vacation), I delete the EDGE, not the node — the person/place still exists. If the entity\'s id isn\'t in the graph block\'s ids legend, I call find_graph_node first to resolve the label.',
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
      description: 'I change the relationship type or strength of an existing edge in my knowledge graph. I use this when the relationship still holds but is mis-typed or its confidence has shifted ("acquaintance" → "close friend"). For a relationship that USED to be true and is now false, I delete the edge instead. Edge ids are listed in the graph block under "edges:" with the form `from -rel-> to = <id>`. If the edge I want isn\'t there, I call find_graph_edges with one endpoint\'s node id to look it up.',
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
      description: 'I delete a single relationship between two graph entities while keeping the entities themselves. This is the right tool for "X is no longer at Y" or "X no longer works with Y." The connection vanishes; both entities remain available for future relationships. Edge ids are listed in the graph block under "edges:" with the form `from -rel-> to = <id>`; if the edge I need isn\'t there, I call find_graph_edges with one endpoint\'s node id to look it up. Entity-core auto-snapshots before each delete.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The id of the edge to delete.' },
        },
        required: ['id'],
      },
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

  save_to_tome: async ({ title, content, keywords }) => {
    try {
      const res = await fetch('/api/tomes/default/entries', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comment:   title,
          content,
          keys:      Array.isArray(keywords) ? keywords : String(keywords ?? '').split(',').map(s => s.trim()).filter(Boolean),
          learnedAt: new Date().toISOString(),
        }),
      });
      const data = await res.json();
      if (!res.ok) return `Failed to save to Tome: ${data.error ?? res.status}`;
      return `Saved to Tome (entry: ${data.uid ?? 'unknown'}).`;
    } catch (err) {
      return `Failed to save to Tome: ${err.message}`;
    }
  },

  save_memory: async ({ content, granularity }) => {
    try {
      const res = await fetch('/api/entity/memory', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, granularity }),
      });
      const data = await res.json();
      if (!res.ok) return `Failed to save memory: ${data.error ?? res.status}`;
      return data.ok ? 'Memory saved.' : `Memory save failed: ${data.error ?? 'unknown error'}`;
    } catch (err) {
      return `Failed to save memory: ${err.message}`;
    }
  },

  update_identity: async ({ category, filename, content }) => {
    try {
      const res = await fetch('/api/entity/identity', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, filename, content, mode: 'append' }),
      });
      const data = await res.json();
      if (!res.ok) return `Failed to update identity: ${data.error ?? res.status}`;
      return data.ok ? 'Identity file updated.' : `Identity update failed: ${data.error ?? 'unknown error'}`;
    } catch (err) {
      return `Failed to update identity: ${err.message}`;
    }
  },

  // ── Knowledge-editing executors ────────────────────────────────────
  // Each one calls a server endpoint that auto-snapshots entity-core before
  // the destructive op. Return strings the model can read back.

  update_memory: async ({ granularity, date, content }) => {
    try {
      const res = await fetch(`/api/entity/memories/${encodeURIComponent(granularity)}/${encodeURIComponent(date)}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ content, editedBy: 'familiar-toolcall' }),
      });
      const data = await res.json();
      if (!res.ok) return `Failed to update memory: ${data.error ?? res.status}`;
      return `Memory ${granularity}/${date} updated.`;
    } catch (err) { return `Failed to update memory: ${err.message}`; }
  },

  delete_memory: async ({ granularity, date }) => {
    try {
      const res = await fetch(`/api/entity/memories/${encodeURIComponent(granularity)}/${encodeURIComponent(date)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) return `Failed to delete memory: ${data.error ?? res.status}`;
      return `Memory ${granularity}/${date} deleted (snapshot saved — recoverable from the Knowledge editor).`;
    } catch (err) { return `Failed to delete memory: ${err.message}`; }
  },

  rewrite_identity_section: async ({ category, filename, section, content }) => {
    try {
      const path = `/api/entity/identity/${encodeURIComponent(category)}/${encodeURIComponent(filename)}/sections/${encodeURIComponent(section)}`;
      const res  = await fetch(path, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ content }),
      });
      const data = await res.json();
      if (!res.ok) return `Failed to rewrite section: ${data.error ?? res.status}`;
      return `Section "${section}" of ${category}/${filename} rewritten.`;
    } catch (err) { return `Failed to rewrite section: ${err.message}`; }
  },

  find_graph_node: async ({ query, type, limit }) => {
    try {
      const params = new URLSearchParams({ q: query });
      if (type)  params.set('type', type);
      if (limit) params.set('limit', String(limit));
      const res = await fetch(`/api/entity/graph/search?${params}`);
      const data = await res.json();
      if (!res.ok) return `Failed to search graph: ${data.error ?? res.status}`;
      const items = (data.results ?? []).map(r => r.node ? r.node : r).filter(n => n && n.id);
      if (!items.length) return `No graph nodes matched "${query}".`;
      return items.map(n => `${n.label ?? '(no label)'} (id=${n.id}, type=${n.type ?? '?'})${n.description ? ' — ' + n.description : ''}`).join('\n');
    } catch (err) { return `Failed to search graph: ${err.message}`; }
  },

  find_graph_edges: async ({ nodeId, depth }) => {
    try {
      const params = new URLSearchParams();
      if (depth) params.set('depth', String(depth));
      const url = `/api/entity/graph/nodes/${encodeURIComponent(nodeId)}/subgraph` + (params.toString() ? `?${params}` : '');
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) return `Failed to list edges: ${data.error ?? res.status}`;
      const nodes = data.nodes ?? [];
      const edges = data.edges ?? [];
      if (!edges.length) return `Node ${nodeId} has no edges in scope.`;
      const labelOf = id => nodes.find(n => n.id === id)?.label ?? id;
      return edges.map(e => `${labelOf(e.fromId)} -${e.type}-> ${labelOf(e.toId)} (id=${e.id})`).join('\n');
    } catch (err) { return `Failed to list edges: ${err.message}`; }
  },

  update_graph_node: async ({ id, label, description, type }) => {
    try {
      const body = {};
      if (label       !== undefined) body.label       = label;
      if (description !== undefined) body.description = description;
      if (type        !== undefined) body.type        = type;
      const res = await fetch(`/api/entity/graph/nodes/${encodeURIComponent(id)}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return `Failed to update graph node: ${data.error ?? res.status}`;
      return `Graph node ${id} updated.`;
    } catch (err) { return `Failed to update graph node: ${err.message}`; }
  },

  delete_graph_node: async ({ id }) => {
    try {
      const res = await fetch(`/api/entity/graph/nodes/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) return `Failed to delete graph node: ${data.error ?? res.status}`;
      return `Graph node ${id} deleted (snapshot saved).`;
    } catch (err) { return `Failed to delete graph node: ${err.message}`; }
  },

  update_graph_edge: async ({ id, type, weight }) => {
    try {
      const body = {};
      if (type   !== undefined) body.type   = type;
      if (weight !== undefined) body.weight = weight;
      const res = await fetch(`/api/entity/graph/edges/${encodeURIComponent(id)}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return `Failed to update graph edge: ${data.error ?? res.status}`;
      return `Graph edge ${id} updated.`;
    } catch (err) { return `Failed to update graph edge: ${err.message}`; }
  },

  delete_graph_edge: async ({ id }) => {
    try {
      const res = await fetch(`/api/entity/graph/edges/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) return `Failed to delete graph edge: ${data.error ?? res.status}`;
      return `Graph edge ${id} deleted (snapshot saved).`;
    } catch (err) { return `Failed to delete graph edge: ${err.message}`; }
  },
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
async function executeToolCall(name, argsJson) {
  if (Object.prototype.hasOwnProperty.call(BUILTIN_EXECUTORS, name)) {
    try {
      const args = argsJson ? JSON.parse(argsJson) : {};
      const t0   = performance.now();
      const out  = String(await BUILTIN_EXECUTORS[name](args));
      debugRecord('tool', `${name} ok in ${Math.round(performance.now() - t0)}ms`);
      return out;
    } catch (err) {
      debugRecord('tool', `${name} FAILED: ${err.message}`);
      return `Error executing ${name}: ${err.message}`;
    }
  }
  debugRecord('tool', `${name} (no client-side impl)`);
  return `Tool "${name}" has no client-side implementation. No result available.`;
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
  userName:          'User',
  charName:          'Assistant',
  systemPrompt:      '',
  characterProfile:  '',
  userProfile:       '',
  postHistoryPrompt: '',
  sessionId:               null,   // UUID, created at init or on clear
  sessionStartedAt:        null,   // ISO timestamp
  sessionEndedAt:          null,   // ISO timestamp — set when session is auto-ended
  previousSessionEndedAt:  null,   // ISO timestamp of the most recent prior session's endedAt — drives {{timeSinceLastSession}}
  lastMessage:             null,   // ISO timestamp — mirrors the module-level lastMessage
  messages:                [],     // { role, content, timestamp }[]
  // ── Tool calling ──────────────────────────────────────────
  toolsEnabled:      true,   // whether to send tools array with each request
  customTools:       '',     // JSON array string of user-defined tool definitions
  // ── Topics & tomes (lorebook) ───────────────────────────
  tomeScanDepth:         4,      // how many recent messages to scan for keyword matches
  tomeRecursive:         false,  // enable recursive tome entry activation
  tomeMaxRecursionSteps: 3,      // max recursive passes
  tomeCaseSensitive:     false,  // global case-sensitive keyword matching
  tomeMatchWholeWords:   false,  // global whole-word keyword matching
  turnCount:             0,      // conversation turn counter (used by entry.delay)
  generationMode:        'normal', // current generation mode (used by entry.triggers[])
  lorebook:          { entries: {} }, // legacy field kept for compatibility
  tomeCache:         {},         // { [tomeId]: tomeObject } — not persisted
  tomeRegistry:      [],         // array of { id, name, enabled, entryCount } — not persisted
  topics:            [],         // session-level; stored under pf_topics_{sessionId}
  // ── Saved connections (primary + fallbacks) ─────────────
  connections:           [],     // [{ id, name, provider, apiKey, model }]
  primaryConnectionId:   null,   // id of the active/primary connection
  fallbackConnectionIds: [],     // ordered ids tried when primary fails/returns empty
  maxEmptyRetries:       2,      // retries per connection when response is empty
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
  'systemPrompt', 'characterProfile', 'userProfile', 'postHistoryPrompt',
  'toolsEnabled', 'customTools',
  'tomeScanDepth', 'tomeRecursive', 'tomeMaxRecursionSteps',
  'tomeCaseSensitive', 'tomeMatchWholeWords',
  'connections', 'primaryConnectionId', 'fallbackConnectionIds', 'maxEmptyRetries',
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
    const isPrimary = conn.id === state.primaryConnectionId;
    const fbIdx     = state.fallbackConnectionIds.indexOf(conn.id);
    const isFallback = fbIdx >= 0 && !isPrimary;

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
    const badgeHtml = isPrimary
      ? '<span class="conn-badge">primary</span>'
      : (isFallback ? `<span class="conn-badge fb">fallback #${fbIdx + 1}</span>` : '');
    info.innerHTML =
      `<div class="conn-name">${esc(conn.name)}${badgeHtml}</div>` +
      `<div class="conn-meta">${esc(conn.provider)} / ${esc(conn.model || '—')}</div>`;

    // Actions column
    const actions = document.createElement('div');
    actions.className = 'conn-actions';

    const fbBtn = document.createElement('button');
    fbBtn.type = 'button';
    fbBtn.textContent = isFallback ? '✓ fallback' : '+ fallback';
    fbBtn.title = isPrimary ? 'Primary connection cannot also be a fallback' : 'Toggle fallback';
    fbBtn.disabled = isPrimary;
    fbBtn.addEventListener('click', () => toggleFallback(conn.id, !isFallback));
    actions.appendChild(fbBtn);

    if (isFallback) {
      const upBtn = document.createElement('button');
      upBtn.type = 'button'; upBtn.textContent = '▲'; upBtn.title = 'Try earlier in fallback order';
      upBtn.disabled = fbIdx === 0;
      upBtn.addEventListener('click', () => moveFallback(conn.id, -1));
      const dnBtn = document.createElement('button');
      dnBtn.type = 'button'; dnBtn.textContent = '▼'; dnBtn.title = 'Try later in fallback order';
      dnBtn.disabled = fbIdx === state.fallbackConnectionIds.length - 1;
      dnBtn.addEventListener('click', () => moveFallback(conn.id, +1));
      actions.appendChild(upBtn);
      actions.appendChild(dnBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.textContent = '✕'; delBtn.title = 'Delete connection';
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
function elapsedBetweenUserMessages() {
  const stamps = [];
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
    .replace(/\{\{user\}\}/gi, state.userName || 'User')
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
  if (state.userProfile.trim())    pushSeg('user-profile',     '[User Profile]\n' + applyNameVars(state.userProfile.trim()));
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
  msgs.push({ role: 'user', content: userInput });

  // ── Post-history prompt ───────────────────────────────────────
  if (state.postHistoryPrompt.trim())
    msgs.push({ role: 'user', content: applyNameVars(state.postHistoryPrompt.trim()) });

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
        const html = renderMarkdown(content);
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
  refreshTopicGutter();
  scrollToBottom();
}

// ── API communication ────────────────────────────────────────────
let abortController = null;

/** The last messages array sent to /api/chat (client-side, pre-enrichment). */
let lastSentMessages = null;
/** Per-segment provenance for the system message of the last build. See buildApiMessages. */
let lastBuildSegments = null;
/** The entity-core block that the server actually prepended to the last request's system message. */
let lastThalamusContext = null;

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
  lastThalamusContext = null; // wait for the live answer to populate this

  // Optimistic UI
  appendUserMessage(userInput, userTimestamp);
  setInputLocked(true);
  setTyping(true);
  setStatus('busy');

  const sendStart = performance.now();
  debugRecord('send', `provider=${state.provider} model=${state.model} streaming=${state.streaming} msgs=${apiMessages.length} input=${userInput.length}ch`);
  try {
    if (state.streaming) {
      await doStreamingRequest(apiMessages, userInput, userTimestamp);
    } else {
      await doNonStreamingRequest(apiMessages, userInput, userTimestamp);
    }
    setStatus('ok');
    state.turnCount = (state.turnCount ?? 0) + 1;
    debugRecord('recv', `ok in ${Math.round(performance.now() - sendStart)}ms thalamus=${lastThalamusContext ? lastThalamusContext.length + 'ch' : 'none'}`);
  } catch (err) {
    setTyping(false);
    if (err.name !== 'AbortError') {
      appendErrorMessage(err.message || 'Request failed.');
      setStatus('err');
      debugRecord('recv', `FAILED after ${Math.round(performance.now() - sendStart)}ms: ${err.message}`);
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
 * One streaming attempt against a single connection. Runs the tool-call loop
 * to completion. DOM side effects (assistant shell, tool-use blocks) accumulate
 * during the attempt and are returned so the caller can roll them back on a
 * failed attempt before retrying. Throws on HTTP / network / abort errors.
 */
async function attemptStreamingOnce(conn, apiMessages, activeTools, domArtifacts) {
  const pendingMsgs = [];   // tool_call + tool_result messages to commit
  const toolUseEls  = domArtifacts; // shared array — caller can roll back on error
  let   currentMsgs = apiMessages;
  let   finalShell  = null;
  let   finalContent = '';

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
        provider:    conn.provider,
        apiKey:      conn.apiKey,
        model:       conn.model,
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
    let toolCallsAcc = {};
    let finishReason = null;
    let shell        = null;

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
          if (parsed._thalamus) {
            lastThalamusContext = parsed._thalamus.entityContext ?? null;
            continue;
          }
          const choice = parsed.choices?.[0];
          const delta  = choice?.delta;
          if (choice?.finish_reason) finishReason = choice.finish_reason;

          if (typeof delta?.content === 'string' && delta.content.length > 0) {
            if (!shell) {
              setTyping(false);
              shell = appendAssistantShell(new Date().toISOString());
            }
            fullContent += delta.content;
            shell.bubble.innerHTML = renderMarkdown(fullContent);
            scrollToBottom();
          }

          for (const tc of (delta?.tool_calls ?? [])) {
            const acc = (toolCallsAcc[tc.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
            if (tc.id)                  acc.id                 += tc.id;
            if (tc.function?.name)      acc.function.name      += tc.function.name;
            if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
          }
        } catch { /* malformed chunk */ }
      }
    }

    if (finishReason === 'tool_calls' && round < MAX_TOOL_ROUNDS) {
      const toolCalls   = Object.values(toolCallsAcc);
      const roundTs     = new Date().toISOString();
      const toolResults = await Promise.all(toolCalls.map(async tc => ({
        role:         'tool',
        tool_call_id: tc.id,
        content:      await executeToolCall(tc.function.name, tc.function.arguments),
        timestamp:    roundTs,
        _toolName:    tc.function.name,
      })));
      pendingMsgs.push({ role: 'assistant', content: fullContent || null, tool_calls: toolCalls, timestamp: roundTs });
      pendingMsgs.push(...toolResults);

      setTyping(false);
      const tEl = appendToolUseEl(toolCalls, toolResults);
      if (tEl) toolUseEls.push(tEl);
      setTyping(true);

      currentMsgs = [
        ...currentMsgs,
        { role: 'assistant', content: fullContent || null, tool_calls: toolCalls },
        ...toolResults.map(({ timestamp: _t, _toolName: _n, ...m }) => m),
      ];
      continue;
    }

    finalShell   = shell;
    finalContent = fullContent;
    break;
  }

  return { content: finalContent, pendingMsgs, finalShell };
}

async function doStreamingRequest(apiMessages, userInput, userTimestamp) {
  const activeTools = state.toolsEnabled ? getActiveTools() : [];
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
        result = await attemptStreamingOnce(conn, apiMessages, activeTools, domArtifacts);
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

      const { content, pendingMsgs, finalShell } = result;
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
        shell.bubble.innerHTML = renderMarkdown(content);
      }
      const ts = shell.timeEl?.getAttribute('datetime') || new Date().toISOString();

      state.messages.push({ role: 'user',      content: userInput, timestamp: userTimestamp });
      state.messages.push(...pendingMsgs);
      state.messages.push({ role: 'assistant', content,            timestamp: ts });
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

async function attemptNonStreamingOnce(conn, apiMessages, activeTools, domArtifacts) {
  const pendingMsgs = [];
  let   currentMsgs = apiMessages;
  let   finalContent = '';
  let   finalTimestamp = new Date().toISOString();

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
        provider:    conn.provider,
        apiKey:      conn.apiKey,
        model:       conn.model,
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
    if (data._thalamus) lastThalamusContext = data._thalamus.entityContext ?? null;

    const choice       = data.choices?.[0];
    const message      = choice?.message;
    const finishReason = choice?.finish_reason;

    if (finishReason === 'tool_calls' && Array.isArray(message?.tool_calls) && round < MAX_TOOL_ROUNDS) {
      const toolCalls   = message.tool_calls;
      const toolResults = await Promise.all(toolCalls.map(async tc => ({
        role:         'tool',
        tool_call_id: tc.id,
        content:      await executeToolCall(tc.function.name, tc.function.arguments),
        timestamp:    roundTs,
        _toolName:    tc.function.name,
      })));
      pendingMsgs.push({ role: 'assistant', content: message.content || null, tool_calls: toolCalls, timestamp: roundTs });
      pendingMsgs.push(...toolResults);

      const tEl = appendToolUseEl(toolCalls, toolResults);
      if (tEl) domArtifacts.push(tEl);
      setTyping(true);

      currentMsgs = [
        ...currentMsgs,
        { role: 'assistant', content: message.content || null, tool_calls: toolCalls },
        ...toolResults.map(({ timestamp: _t, _toolName: _n, ...m }) => m),
      ];
      continue;
    }

    finalContent   = message?.content ?? '';
    finalTimestamp = roundTs;
    break;
  }

  return { content: finalContent, pendingMsgs, timestamp: finalTimestamp };
}

async function doNonStreamingRequest(apiMessages, userInput, userTimestamp) {
  const activeTools = state.toolsEnabled ? getActiveTools() : [];
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
        result = await attemptNonStreamingOnce(conn, apiMessages, activeTools, domArtifacts);
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

      const { content, pendingMsgs, timestamp } = result;
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

      const { bubble, copyBtn } = appendAssistantShell(timestamp);
      bubble.innerHTML = renderMarkdown(content);
      scrollToBottom();

      state.messages.push({ role: 'user',      content: userInput, timestamp: userTimestamp });
      state.messages.push(...pendingMsgs);
      state.messages.push({ role: 'assistant', content,            timestamp });
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
  state.userName          = $('user-name').value.trim() || 'User';
  state.charName          = $('char-name').value.trim() || 'Assistant';
  state.systemPrompt      = $('system-prompt').value;
  state.characterProfile  = $('char-profile').value;
  state.userProfile       = $('user-profile').value;
  state.postHistoryPrompt = $('post-history-prompt').value;
  state.toolsEnabled      = $('tools-enabled').checked;
  state.customTools       = $('custom-tools').value;
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
  setIfNotFocused($('temperature'),     'value',   state.temperature);
  $('temp-display').textContent = state.temperature;
  setIfNotFocused($('max-tokens'),         'value',   state.maxTokens);
  setIfNotFocused($('user-name'),          'value',   state.userName ?? 'User');
  setIfNotFocused($('char-name'),          'value',   state.charName ?? 'Assistant');
  setIfNotFocused($('system-prompt'),      'value',   state.systemPrompt);
  setIfNotFocused($('char-profile'),       'value',   state.characterProfile);
  setIfNotFocused($('user-profile'),       'value',   state.userProfile);
  setIfNotFocused($('post-history-prompt'),'value',   state.postHistoryPrompt);
  setIfNotFocused($('tools-enabled'),      'checked', state.toolsEnabled ?? true);
  setIfNotFocused($('custom-tools'),       'value',   state.customTools ?? '');
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
  lastMessage            = null;
  state.lastMessage      = null;
  elapsedTime            = 0;
  saveSettings();
  try { localStorage.setItem('pf_history', JSON.stringify([])); } catch { /* ignore */ }
  $('messages').innerHTML = '';
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
    // Remember when this session ended so {{timeSinceLastSession}} reads
    // correctly from the new session that's about to start.
    state.previousSessionEndedAt = state.sessionEndedAt;
    saveSettings();
    await saveToServer();
    memorizeViaBeacon(sessionMessages, sessionId, { scope: 'session' });
    state._beaconedSessionId = sessionId;
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
    const { jobId } = await resp.json();
    return jobId;
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

// ── Prompt inspector modal ───────────────────────────────────

// Human-readable labels for each prompt-segment source. The CSS class
// `pi-src-<source>` controls the chip + left-rule colour.
const PI_SOURCE_LABELS = {
  'thalamus':          'Entity-Core (Thalamus)',
  'lore-sys-top':      'Lore · system top',
  'lore-before-char':  'Lore · before character',
  'lore-after-char':   'Lore · after character',
  'lore-sys-bottom':   'Lore · system bottom',
  'lore-at-depth':     'Lore · injected at depth',
  'system-prompt':     'System prompt',
  'character-profile': 'Character profile',
  'user-profile':      'User profile',
  'post-history':      'Post-history prompt',
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
  for (const src of ['thalamus', 'system-prompt', 'character-profile', 'user-profile',
                     'lore-sys-top', 'lore-before-char', 'lore-after-char', 'lore-sys-bottom',
                     'lore-at-depth', 'post-history']) {
    const chip = document.createElement('span');
    chip.className = `pi-chip pi-src-${src}`;
    chip.textContent = PI_SOURCE_LABELS[src];
    legend.appendChild(chip);
  }
  body.appendChild(legend);

  // Note about provenance freshness
  if (!lastThalamusContext) {
    const note = document.createElement('p');
    note.className = 'field-hint';
    note.textContent = 'No entity-core block in the last response. Thalamus may have returned empty (no enrichment), or the request hadn\'t completed yet — re-open after the next reply lands.';
    body.appendChild(note);
  }

  const atDepthSet = new Set((lastBuildSegments?.atDepthInjections ?? []).map(a => a.indexInFinal));

  lastSentMessages.forEach((msg, idx) => {
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

    // System message: split by source. Includes the entity-core block as its
    // own first segment when present, then each tracked build segment.
    if (role === 'system' && idx === 0 && lastBuildSegments?.systemSegments?.length) {
      if (lastThalamusContext) {
        wrap.appendChild(piSegmentEl('thalamus', lastThalamusContext));
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
  });

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

  // ── Settings field listeners ─────────────────────────────────
  const settingsIds = [
    'provider-select', 'api-key', 'model-input', 'streaming-toggle',
    'temperature', 'max-tokens', 'user-name', 'char-name',
    'system-prompt', 'char-profile',
    'user-profile', 'post-history-prompt', 'tools-enabled', 'custom-tools',
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
    closeTopicNameModal();
    startTopic(label);
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

  // Knowledge editor (entity-core)
  $('knowledge-btn').addEventListener('click', openKnowledgeModal);
  $('knowledge-modal-close').addEventListener('click', closeKnowledgeModal);
  // Intentionally NO backdrop-click-to-close: it fires mid-pan or while
  // dragging the resize handle past the modal edge. Only the ✕ closes it.
  document.querySelectorAll('.ke-tab').forEach(el => {
    el.addEventListener('click', () => keSwitchTab(el.dataset.tab));
  });
  $('ke-mem-refresh').addEventListener('click', keLoadMemories);
  $('ke-mem-granularity').addEventListener('change', keLoadMemories);
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
        sessionId: session.sessionId,
        scope:     'session',
        messages,
        provider:  state.provider,
        apiKey:    state.apiKey,
        model:     state.model,
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
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content ?? ''}`)
    .join('\n\n');

  const userLabel = userNamedTopicLabel(topic);
  const focusBlock = userLabel
    ? `\n\n### Focus topic\nThe user named this topic "${userLabel}". Center the entry on that topic. Skip tangential threads in the conversation that don't bear on it.`
    : '';

  const prompt = `You are writing a Tome entry for a Familiar (AI companion). The entry is the Familiar's own private notes to themselves — first-person reference material that gets injected back into the Familiar's context when its keywords appear in a future conversation. The Familiar is the voice; you are the scribe. Follow the craft rules below carefully.${focusBlock}

Return ONLY valid JSON (no markdown fences, no commentary) with exactly these fields:
{
  "title":    "Short label for the entry comment (max 60 chars).",
  "content":  "First-person notes from the Familiar to themselves. See rules below.",
  "keywords": ["conversational phrase 1", "conversational phrase 2", ...],
  "sticky":   3
}

### Content rules (most important)
Write content as the Familiar's own first-person private notes to themselves about this situation. NOT a summary of what happened.
Structure:
  1. One short framing line — what is happening and why (so I understand the situation, not just the rules).
  2. 3–5 action bullets — what I will do.
  3. 1–2 prohibition bullets — what I will NOT do. These are usually the most valuable: name the well-intentioned default response that would make things worse.
Style:
  - First person, the Familiar speaking as themselves ("I", "my", "me"). Use {{user}} wherever the user's name belongs.
  - Practical, grounded, non-clinical. Notes, not a textbook.
  - Short declarative bullets. The whole entry should be readable in 5–10 seconds.
  - Do NOT include narrative summaries of "what they said" — distil the situation and my response, not the transcript.

### Keyword rules
Keywords are TRIGGERS, not labels. They must be phrases the user would literally say when this situation recurs — not the name of the topic.
  - WRONG: "executive dysfunction", "rejection sensitive dysphoria", "hyperfocus".
  - RIGHT: "don't know where to start", "did I say something wrong", "been at this for".
Derive them by imagining what the user would actually type when the situation is happening, then extracting distinctive phrases.
  - Prefer multi-word phrases over single common words (avoid bare "tired", "can't", "hard").
  - 3–8 keywords. Each one specific enough not to fire in unrelated conversations.
  - You may use SillyTavern-style regex (e.g. "/can't (make|bring) myself/i") when a concept has 3+ predictable variants.

### Sticky rules
Pick a sticky value (integer, number of turns the entry stays active after first match):
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
  add('lastThalamusContext', lastThalamusContext ? `${lastThalamusContext.length} chars` : '(none — no enriched response captured yet)');

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
    add('thalamus injection', lastThalamusContext ? `${lastThalamusContext.length} chars` : 'none');
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

// ── Knowledge editor (entity-core: memories, identity, graph, snapshots) ─
//
// Layered UI: tabs across the top, two-pane list+detail per tab. All ops
// hit /api/entity/* endpoints; destructive ones auto-snapshot server-side
// so the Snapshots tab is the always-on undo.

const KE_TABS = ['memories', 'graph', 'identity', 'snapshots'];

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
const _resizableBound = new WeakSet();
function bindResizableModal(elId, storageKey) {
  const el = $(elId);
  if (!el) return;
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const { w, h } = JSON.parse(raw);
      if (typeof w === 'number' && w > 0) el.style.width  = `${w}px`;
      if (typeof h === 'number' && h > 0) el.style.height = `${h}px`;
    }
  } catch {/* ignore */}
  if (_resizableBound.has(el) || typeof ResizeObserver === 'undefined') return;
  _resizableBound.add(el);
  let saveT = 0;
  const ro = new ResizeObserver(entries => {
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
// Falls back to HTTP status. Surfaces 'entity-core not connected'
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
      row.innerHTML = `
        <div class="ke-row-title">${esc(m.granularity)} · ${esc(m.date)}</div>
        <div class="ke-row-sub">${esc((m.preview ?? '').slice(0, 140))}</div>`;
      row.addEventListener('click', () => keOpenMemory(m.granularity, m.date));
      list.appendChild(row);
    }
  } catch (err) { list.innerHTML = keError(err, 'Failed to load memories.'); }
}

async function keOpenMemory(granularity, date) {
  keSetDetail('ke-mem-detail', '<p class="logs-loading">Loading…</p>');
  try {
    const res = await fetch(`/api/entity/memories/${encodeURIComponent(granularity)}/${encodeURIComponent(date)}`);
    if (!res.ok) throw new Error(await keReadServerError(res));
    const data = await res.json();
    const content = data.memory?.content ?? data.content ?? '';
    const det = $('ke-mem-detail');
    det.innerHTML = `
      <div class="ke-detail-header">
        <h3>${esc(granularity)} · ${esc(date)}</h3>
      </div>
      <textarea id="ke-mem-content" rows="14" class="ke-textarea">${esc(content)}</textarea>
      <div class="ke-actions">
        <button id="ke-mem-save"    class="btn-send">Save (overwrite)</button>
        <button id="ke-mem-super"   class="btn-secondary">Supersede with today's date</button>
        <button id="ke-mem-delete"  class="btn-ghost ke-danger">Delete</button>
      </div>
      <p class="field-hint">Editing rewrites the entry in place; an auto-snapshot is taken first. "Supersede" writes a NEW dated entry that contradicts this one — recency-decay then demotes the stale entry while preserving history.</p>`;
    $('ke-mem-save').addEventListener('click', async () => {
      const body = $('ke-mem-content').value;
      const r = await fetch(`/api/entity/memories/${encodeURIComponent(granularity)}/${encodeURIComponent(date)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: body, editedBy: 'user-edit' }),
      });
      if (!r.ok) { alert(`Save failed: ${(await r.json()).error ?? r.status}`); return; }
      keLoadMemories();
      keOpenMemory(granularity, date);
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
      if (!confirm(`Delete memory ${granularity}/${date}? An auto-snapshot is taken first; you can restore via the Snapshots tab.`)) return;
      const r = await fetch(`/api/entity/memories/${encodeURIComponent(granularity)}/${encodeURIComponent(date)}`, { method: 'DELETE' });
      if (!r.ok) { alert(`Delete failed: ${(await r.json()).error ?? r.status}`); return; }
      keSetDetail('ke-mem-detail', '<p class="logs-empty">Deleted.</p>');
      keLoadMemories();
    });
  } catch (err) { keSetDetail('ke-mem-detail', keError(err, 'Failed to load memory.')); }
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
const _keGraph = {
  nodes:    [],
  edges:    [],
  nodeById: new Map(),
  // viewport transform: world = (screen - tx) / zoom
  zoom:     1,
  tx:       0,
  ty:       0,
  hover:    null,   // { kind: 'node'|'edge', ref }
  drag:     null,
  raf:      0,
  inited:   false,
};

const KE_GRAPH_NODE_R   = 6;
const KE_GRAPH_LABEL_ZOOM = 1.4;

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
    keInitGraphMapOnce();
    keLoadGraphMap();
  }
}

function keInitGraphMapOnce() {
  if (_keGraph.inited) return;
  _keGraph.inited = true;
  const canvas = $('ke-graph-canvas');

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const rect  = canvas.getBoundingClientRect();
    const mx    = e.clientX - rect.left;
    const my    = e.clientY - rect.top;
    const wx    = (mx - _keGraph.tx) / _keGraph.zoom;
    const wy    = (my - _keGraph.ty) / _keGraph.zoom;
    const scale = Math.exp(-e.deltaY * 0.0015);
    _keGraph.zoom = Math.max(0.2, Math.min(8, _keGraph.zoom * scale));
    _keGraph.tx = mx - wx * _keGraph.zoom;
    _keGraph.ty = my - wy * _keGraph.zoom;
    keGraphRequestDraw();
  }, { passive: false });

  canvas.addEventListener('mousedown', e => {
    _keGraph.drag = { x: e.clientX, y: e.clientY, tx: _keGraph.tx, ty: _keGraph.ty, moved: false };
  });
  window.addEventListener('mousemove', e => {
    if (_keGraph.drag) {
      const dx = e.clientX - _keGraph.drag.x;
      const dy = e.clientY - _keGraph.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) _keGraph.drag.moved = true;
      _keGraph.tx = _keGraph.drag.tx + dx;
      _keGraph.ty = _keGraph.drag.ty + dy;
      keGraphRequestDraw();
      return;
    }
    if (_keGraphView !== 'map') return;
    if ($('knowledge-modal').classList.contains('hidden')) return;
    if ($('ke-graph-map').classList.contains('hidden'))   return;
    keGraphUpdateHover(e);
  });
  window.addEventListener('mouseup', e => {
    if (!_keGraph.drag) return;
    const moved = _keGraph.drag.moved;
    _keGraph.drag = null;
    if (!moved) keGraphHandleClick(e);
  });

  canvas.addEventListener('mouseleave', () => {
    _keGraph.hover = null;
    $('ke-graph-tooltip').classList.add('hidden');
    keGraphRequestDraw();
  });

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('ke-graph-popover').classList.contains('hidden')) {
      keGraphClosePopover();
    }
  });

  // Keep the canvas sized to its container.
  const ro = new ResizeObserver(() => {
    keGraphResize();
    keGraphRequestDraw();
  });
  ro.observe(canvas.parentElement);
}

function keGraphResize() {
  const canvas = $('ke-graph-canvas');
  const dpr    = window.devicePixelRatio || 1;
  const rect   = canvas.getBoundingClientRect();
  canvas.width  = Math.max(1, Math.floor(rect.width  * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
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
    const data  = await res.json();
    if (gen !== _keGraphLoadGen) return;
    // Preserve existing positions for nodes that survived a reload —
    // avoids reshuffling the whole map when the user adds an edge.
    const prevById = _keGraph.nodeById;
    const nodes = (data.nodes ?? []).map(n => {
      const prev = prevById?.get(n.id);
      return prev ? { ...n, x: prev.x, y: prev.y } : { ...n };
    });
    const edges = (data.edges ?? []).slice();
    if (!nodes.length) {
      _keGraph.nodes = [];
      _keGraph.edges = [];
      _keGraph.nodeById = new Map();
      status.textContent = 'No graph nodes yet.';
      keGraphRequestDraw();
      return;
    }
    keUpdateNodeTypes(nodes);
    keUpdateEdgeTypes(edges);
    const isFreshLayout = nodes.every(n => n.x === undefined);
    _keGraph.nodes = nodes;
    _keGraph.edges = edges;
    _keGraph.nodeById = new Map(nodes.map(n => [n.id, n]));
    keGraphResize();
    const rect = $('ke-graph-canvas').getBoundingClientRect();
    keGraphLayout(rect.width || 600, rect.height || 400, { fresh: isFreshLayout });
    if (isFreshLayout) keGraphFit();
    keGraphBuildLegend();
    status.classList.add('hidden');
    keGraphRequestDraw();
  } catch (err) {
    status.textContent = 'Failed to load graph: ' + (err.message || err);
  }
}

// ── Layout (Fruchterman-Reingold) ───────────────────────────────────────
//
// `fresh` runs the full simulation; on incremental loads we only place
// nodes that don't have positions yet (near the centroid of their
// neighbors, falling back to the canvas centre) and skip iterations,
// so existing nodes stay put.
function keGraphLayout(width, height, { fresh = true } = {}) {
  const nodes = _keGraph.nodes;
  const edges = _keGraph.edges;
  if (!nodes.length) return;
  if (!fresh) {
    for (const n of nodes) {
      if (n.x !== undefined && n.y !== undefined) continue;
      // Try to place near the centroid of already-placed neighbors so
      // the new dot lands in a sensible neighborhood.
      let sx = 0, sy = 0, c = 0;
      for (const e of edges) {
        const other = e.fromId === n.id ? _keGraph.nodeById.get(e.toId)
                    : e.toId   === n.id ? _keGraph.nodeById.get(e.fromId) : null;
        if (other && other.x !== undefined) { sx += other.x; sy += other.y; c++; }
      }
      if (c > 0) {
        n.x = sx / c + (Math.random() - 0.5) * 40;
        n.y = sy / c + (Math.random() - 0.5) * 40;
      } else {
        n.x = width  / 2 + (Math.random() - 0.5) * width  * 0.3;
        n.y = height / 2 + (Math.random() - 0.5) * height * 0.3;
      }
    }
    return;
  }
  const area = width * height;
  const k    = Math.sqrt(area / nodes.length) * 0.75;
  for (const n of nodes) {
    n.x = width  / 2 + (Math.random() - 0.5) * width  * 0.6;
    n.y = height / 2 + (Math.random() - 0.5) * height * 0.6;
  }
  const iterations = nodes.length <= 60 ? 300 : nodes.length <= 200 ? 220 : 140;
  let t = Math.min(width, height) / 8;
  const cool = t / iterations;
  for (let iter = 0; iter < iterations; iter++) {
    for (const n of nodes) { n.dx = 0; n.dy = 0; }
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = dx*dx + dy*dy + 0.01; }
        const d = Math.sqrt(d2);
        const f = (k * k) / d;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.dx += fx; a.dy += fy;
        b.dx -= fx; b.dy -= fy;
      }
    }
    for (const e of edges) {
      const a = _keGraph.nodeById.get(e.fromId);
      const b = _keGraph.nodeById.get(e.toId);
      if (!a || !b) continue;
      const dx = a.x - b.x, dy = a.y - b.y;
      const d  = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f  = (d * d) / k;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.dx -= fx; a.dy -= fy;
      b.dx += fx; b.dy += fy;
    }
    for (const n of nodes) {
      const dlen = Math.sqrt(n.dx * n.dx + n.dy * n.dy) || 0.01;
      n.x += (n.dx / dlen) * Math.min(dlen, t);
      n.y += (n.dy / dlen) * Math.min(dlen, t);
      n.x += (width  / 2 - n.x) * 0.01;
      n.y += (height / 2 - n.y) * 0.01;
    }
    t = Math.max(0.5, t - cool);
  }
}

function keGraphFit() {
  const canvas = $('ke-graph-canvas');
  const rect   = canvas.getBoundingClientRect();
  if (!_keGraph.nodes.length || !rect.width) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of _keGraph.nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  }
  const pad = 40;
  const w   = (maxX - minX) || 1;
  const h   = (maxY - minY) || 1;
  const zoom = Math.min((rect.width - pad * 2) / w, (rect.height - pad * 2) / h, 2);
  _keGraph.zoom = Math.max(0.3, zoom);
  _keGraph.tx = rect.width  / 2 - ((minX + maxX) / 2) * _keGraph.zoom;
  _keGraph.ty = rect.height / 2 - ((minY + maxY) / 2) * _keGraph.zoom;
}

// ── Color encoding ──────────────────────────────────────────────────────
//
// Per-graph deterministic assignment beats hashing for a small categorical
// space: hashes happily put 10 of 16 common types into the magenta band.
// Instead, sort the live type names and walk a 24-step hue palette in
// alphabetical order. Edge types start half a palette later, so a node
// and an edge with the same sort index can't pick the same hue.

const KE_GRAPH_PALETTE = [
    0,  15,  30,  45,  60,  75,  90, 105,
  120, 135, 150, 165, 180, 195, 210, 225,
  240, 255, 270, 285, 300, 315, 330, 345,
];
const _keGraphColors = { node: new Map(), edge: new Map() };

function keGraphAssignColors() {
  const nodeTypes = Array.from(new Set(_keGraph.nodes.map(n => n.type || 'untyped'))).sort();
  const edgeTypes = Array.from(new Set(_keGraph.edges.map(e => e.type || e.customType || 'related'))).sort();
  _keGraphColors.node.clear();
  _keGraphColors.edge.clear();
  const N      = KE_GRAPH_PALETTE.length;
  // Stride coprime to N spreads adjacent indices around the wheel:
  // index 0,1,2,3,… → palette[0,7,14,21,…] = red, green, blue, purple, …
  // rather than the eye-killing 0,15,30,45 gradient.
  const stride = 7;
  const off    = Math.floor(N / 2);
  nodeTypes.forEach((t, i) => _keGraphColors.node.set(t, KE_GRAPH_PALETTE[(i * stride) % N]));
  edgeTypes.forEach((t, i) => _keGraphColors.edge.set(t, KE_GRAPH_PALETTE[((i * stride) + off) % N]));
}

function keGraphNodeHue(n) {
  return _keGraphColors.node.get(n.type || 'untyped') ?? 0;
}
function keGraphEdgeHue(e) {
  return _keGraphColors.edge.get(e.type || e.customType || 'related') ?? 0;
}
function keGraphNodeColor(n) {
  return `hsl(${keGraphNodeHue(n)}, 65%, 60%)`;
}
function keGraphEdgeColor(e) {
  const hue   = keGraphEdgeHue(e);
  const w     = Math.max(0, Math.min(1, typeof e.weight === 'number' ? e.weight : 0.5));
  const sat   = Math.round(20 + 70 * w);
  const lt    = Math.round(32 + 30 * w);
  const alpha = (0.35 + 0.55 * w).toFixed(2);
  return `hsla(${hue}, ${sat}%, ${lt}%, ${alpha})`;
}

function keGraphBuildLegend() {
  keGraphAssignColors();
  const legend = $('ke-graph-legend');
  const rows   = [];
  const nodeTypes = Array.from(_keGraphColors.node.keys()).sort();
  const edgeTypes = Array.from(_keGraphColors.edge.keys()).sort();
  if (nodeTypes.length) {
    rows.push('<div class="ke-graph-legend-section">Nodes</div>');
    for (const t of nodeTypes) {
      const hue = _keGraphColors.node.get(t);
      rows.push(`<div class="ke-graph-legend-row"><span class="ke-graph-legend-swatch" style="background:hsl(${hue},65%,60%)"></span>${esc(t)}</div>`);
    }
  }
  if (edgeTypes.length) {
    rows.push('<div class="ke-graph-legend-section">Edges</div>');
    for (const t of edgeTypes) {
      const hue = _keGraphColors.edge.get(t);
      rows.push(`<div class="ke-graph-legend-row"><span class="ke-graph-legend-swatch" style="background:hsl(${hue},75%,55%)"></span>${esc(t)}</div>`);
    }
  }
  legend.innerHTML = rows.join('');
  legend.classList.toggle('hidden', !rows.length);
}

// ── Rendering ───────────────────────────────────────────────────────────
function keGraphRequestDraw() {
  if (_keGraph.raf) return;
  _keGraph.raf = requestAnimationFrame(() => {
    _keGraph.raf = 0;
    keGraphDraw();
  });
}

function keGraphDraw() {
  const canvas = $('ke-graph-canvas');
  const ctx    = canvas.getContext('2d');
  const dpr    = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(_keGraph.tx, _keGraph.ty);
  ctx.scale(_keGraph.zoom, _keGraph.zoom);

  // Edges
  for (const e of _keGraph.edges) {
    const a = _keGraph.nodeById.get(e.fromId);
    const b = _keGraph.nodeById.get(e.toId);
    if (!a || !b) continue;
    const isHover = _keGraph.hover && _keGraph.hover.kind === 'edge' && _keGraph.hover.ref === e;
    ctx.strokeStyle = isHover ? '#ffffff' : keGraphEdgeColor(e);
    const w = Math.max(0, Math.min(1, typeof e.weight === 'number' ? e.weight : 0.5));
    ctx.lineWidth   = (0.7 + w * 1.6) / _keGraph.zoom;
    const dx  = b.x - a.x, dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const mx  = (a.x + b.x) / 2;
    const my  = (a.y + b.y) / 2;
    const cpx = mx + (-dy / len) * len * 0.12;
    const cpy = my + ( dx / len) * len * 0.12;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(cpx, cpy, b.x, b.y);
    ctx.stroke();
  }

  // Nodes
  const r = KE_GRAPH_NODE_R / _keGraph.zoom;
  for (const n of _keGraph.nodes) {
    const isHover = _keGraph.hover && _keGraph.hover.kind === 'node' && _keGraph.hover.ref === n;
    ctx.fillStyle   = keGraphNodeColor(n);
    ctx.strokeStyle = isHover ? '#ffffff' : 'rgba(0,0,0,0.45)';
    ctx.lineWidth   = (isHover ? 2 : 1) / _keGraph.zoom;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Labels — always for hovered node, and for everything when zoomed in.
  const showAll = _keGraph.zoom >= KE_GRAPH_LABEL_ZOOM;
  ctx.font         = `${12 / _keGraph.zoom}px sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle    = '#cdd6f4';
  ctx.strokeStyle  = 'rgba(0,0,0,0.7)';
  ctx.lineWidth    = 3 / _keGraph.zoom;
  for (const n of _keGraph.nodes) {
    const isHover = _keGraph.hover && _keGraph.hover.kind === 'node' && _keGraph.hover.ref === n;
    if (!showAll && !isHover) continue;
    const label = String(n.label ?? n.id);
    const x = n.x + r + 4 / _keGraph.zoom;
    ctx.strokeText(label, x, n.y);
    ctx.fillText(label,   x, n.y);
  }
}

// ── Hit testing & interaction ───────────────────────────────────────────
function keGraphClientToWorld(clientX, clientY) {
  const rect = $('ke-graph-canvas').getBoundingClientRect();
  const sx = clientX - rect.left;
  const sy = clientY - rect.top;
  return { x: (sx - _keGraph.tx) / _keGraph.zoom, y: (sy - _keGraph.ty) / _keGraph.zoom, sx, sy };
}

function keGraphHitNode(wx, wy) {
  const r = KE_GRAPH_NODE_R / _keGraph.zoom;
  const tol = Math.max(r, 8 / _keGraph.zoom);
  let best = null, bestD = tol * tol;
  for (const n of _keGraph.nodes) {
    const dx = n.x - wx, dy = n.y - wy;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestD) { bestD = d2; best = n; }
  }
  return best;
}

function keGraphHitEdge(wx, wy) {
  const tol = 6 / _keGraph.zoom;
  const tol2 = tol * tol;
  let best = null, bestD = tol2;
  for (const e of _keGraph.edges) {
    const a = _keGraph.nodeById.get(e.fromId);
    const b = _keGraph.nodeById.get(e.toId);
    if (!a || !b) continue;
    // Same quadratic the renderer draws: midpoint pushed perpendicular
    // by 12% of the chord length. Flatten into segments and take the
    // minimum point-to-segment distance — the chord approximation we
    // used before missed by up to ~12% of the edge length at the apex.
    const dx = b.x - a.x, dy = b.y - a.y;
    const L  = Math.sqrt(dx * dx + dy * dy);
    if (L < 1) continue;
    const cpx = (a.x + b.x) / 2 + (-dy / L) * L * 0.12;
    const cpy = (a.y + b.y) / 2 + ( dx / L) * L * 0.12;
    // Cheap reject: if even the chord midpoint is far enough that the
    // whole curve's bounding box can't reach the cursor, skip.
    const minX = Math.min(a.x, b.x, cpx) - tol;
    const maxX = Math.max(a.x, b.x, cpx) + tol;
    const minY = Math.min(a.y, b.y, cpy) - tol;
    const maxY = Math.max(a.y, b.y, cpy) + tol;
    if (wx < minX || wx > maxX || wy < minY || wy > maxY) continue;
    const d2 = keGraphDistSqToQuadratic(wx, wy, a.x, a.y, cpx, cpy, b.x, b.y);
    if (d2 <= bestD) { bestD = d2; best = e; }
  }
  return best;
}

// Squared distance from (px,py) to a quadratic Bézier defined by
// (x0,y0)-(cpx,cpy)-(x1,y1), via polyline flattening. 16 segments is
// plenty: at the renderer's 12% bow the chord error of an N-segment
// approximation is well under one pixel at any reasonable zoom.
function keGraphDistSqToQuadratic(px, py, x0, y0, cpx, cpy, x1, y1) {
  const SEG = 16;
  let prevX = x0, prevY = y0;
  let best  = Infinity;
  for (let i = 1; i <= SEG; i++) {
    const t   = i / SEG;
    const omt = 1 - t;
    const x   = omt * omt * x0 + 2 * omt * t * cpx + t * t * x1;
    const y   = omt * omt * y0 + 2 * omt * t * cpy + t * t * y1;
    const dx  = x - prevX, dy = y - prevY;
    const L2  = dx * dx + dy * dy;
    if (L2 > 0.0001) {
      let tt = ((px - prevX) * dx + (py - prevY) * dy) / L2;
      if (tt < 0) tt = 0; else if (tt > 1) tt = 1;
      const ix = prevX + tt * dx, iy = prevY + tt * dy;
      const ex = px - ix,         ey = py - iy;
      const d2 = ex * ex + ey * ey;
      if (d2 < best) best = d2;
    }
    prevX = x; prevY = y;
  }
  return best;
}

function keGraphUpdateHover(e) {
  const { x, y, sx, sy } = keGraphClientToWorld(e.clientX, e.clientY);
  const node = keGraphHitNode(x, y);
  let hover  = node ? { kind: 'node', ref: node } : null;
  if (!hover) {
    const edge = keGraphHitEdge(x, y);
    if (edge) hover = { kind: 'edge', ref: edge };
  }
  const changed = (hover?.ref !== _keGraph.hover?.ref);
  _keGraph.hover = hover;
  const tip = $('ke-graph-tooltip');
  // Suppress the tooltip while the editor popover is open — they'd
  // stack and the popover content is more authoritative.
  const popoverOpen = !$('ke-graph-popover').classList.contains('hidden');
  if (!hover || popoverOpen) {
    tip.classList.add('hidden');
    if (changed) keGraphRequestDraw();
    return;
  }
  if (hover.kind === 'node') {
    const n = hover.ref;
    tip.innerHTML = `<div class="ke-graph-tooltip-title">${esc(n.label ?? n.id)}</div>
      <div class="ke-graph-tooltip-sub">${esc(n.type ?? 'untyped')}</div>
      ${n.description ? `<div>${esc(String(n.description).slice(0, 160))}</div>` : ''}`;
  } else {
    const ed = hover.ref;
    const a  = _keGraph.nodeById.get(ed.fromId);
    const b  = _keGraph.nodeById.get(ed.toId);
    const w  = typeof ed.weight === 'number' ? ed.weight.toFixed(2) : '—';
    tip.innerHTML = `<div class="ke-graph-tooltip-title">${esc(ed.type ?? ed.customType ?? 'related')}</div>
      <div class="ke-graph-tooltip-sub">${esc(a?.label ?? ed.fromId)} → ${esc(b?.label ?? ed.toId)}</div>
      <div class="ke-graph-tooltip-sub">weight: ${esc(w)}</div>`;
  }
  tip.style.left = `${sx + 12}px`;
  tip.style.top  = `${sy + 12}px`;
  tip.classList.remove('hidden');
  if (changed) keGraphRequestDraw();
}

function keGraphHandleClick(e) {
  const { x, y } = keGraphClientToWorld(e.clientX, e.clientY);
  const node = keGraphHitNode(x, y);
  if (!node) { keGraphClosePopover(); return; }
  keGraphOpenPopover(node, e.clientX, e.clientY);
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
      const node = _keGraph.nodeById.get(newId);
      if (node) {
        const canvas = $('ke-graph-canvas');
        const r = canvas.getBoundingClientRect();
        // Open popover anchored to the new node's screen position.
        const sx = r.left + node.x * _keGraph.zoom + _keGraph.tx;
        const sy = r.top  + node.y * _keGraph.zoom + _keGraph.ty;
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
    pop.innerHTML = `
      <div class="ke-graph-popover-head">
        <h3>${esc(self.label ?? node.id)}</h3>
        <button class="ke-graph-popover-close" type="button" aria-label="Close" id="ke-pop-close">✕</button>
      </div>
      <div class="field"><label>Label</label><input id="ke-pop-label" type="text" value="${esc(self.label ?? '')}"></div>
      <div class="field"><label>Type</label><input  id="ke-pop-type"  type="text" value="${esc(self.type  ?? '')}" list="ke-node-types-dl"></div>
      <div class="field"><label>Description</label><textarea id="ke-pop-desc" rows="3">${esc(self.description ?? '')}</textarea></div>
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
      };
      const r = await fetch(`/api/entity/graph/nodes/${encodeURIComponent(node.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!r.ok) { alert(`Save failed: ${(await r.json()).error ?? r.status}`); return; }
      Object.assign(node, body);
      keGraphBuildLegend();
      keGraphRequestDraw();
      keGraphOpenPopover(node, clientX, clientY);
    });

    pop.querySelector('#ke-pop-delete').addEventListener('click', async () => {
      if (!confirm('Delete this node and ALL its edges? An auto-snapshot is taken first.')) return;
      const r = await fetch(`/api/entity/graph/nodes/${encodeURIComponent(node.id)}`, { method: 'DELETE' });
      if (!r.ok) { alert(`Delete failed: ${(await r.json()).error ?? r.status}`); return; }
      _keGraph.nodes = _keGraph.nodes.filter(n => n.id !== node.id);
      _keGraph.edges = _keGraph.edges.filter(e => e.fromId !== node.id && e.toId !== node.id);
      _keGraph.nodeById.delete(node.id);
      _keGraph.hover = null;
      keGraphClosePopover();
      keGraphBuildLegend();
      keGraphRequestDraw();
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
      const refreshed = _keGraph.nodeById.get(startId);
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
    for (const category of ['self', 'user', 'relationship', 'custom']) {
      const files = data[category] ?? [];
      if (!files.length) continue;
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

// ── Tome entry editor ─────────────────────────────────────────────

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


