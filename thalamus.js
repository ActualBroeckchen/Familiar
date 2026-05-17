/**
 * thalamus.js — entity-core bridge for Proto-Familiar
 *
 * Mirrors Psycheros's context-building approach (src/entity/context.ts +
 * src/rag/context-builder.ts):
 *
 *   1. All identity categories (self, user, relationship, custom), each file
 *      wrapped in its promptLabel XML tags and sorted in canonical order.
 *   2. base_instructions.md placed first if present (no section header).
 *   3. Relevant memories formatted with score and source.
 *   4. Knowledge graph context via node search + 1-hop edge traversal.
 *
 * If entity-core is unreachable for any reason, enrich() logs the error
 * and returns '' so the request continues without enrichment.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the entity-core entry point. The Psycheros repo became a Deno
// workspace at entity-core-v0.2.x, with entity-core living at
// packages/entity-core/. Older sibling checkouts kept it at the repo root.
// Honour $ENTITY_CORE_PATH first, then probe the workspace path, then fall
// back to the legacy top-level path.
const ENTITY_CORE_ALPHA = path.resolve(__dirname, '../entity-core-alpha');
const ENTITY_CORE_WORKSPACE_ENTRY = path.join(ENTITY_CORE_ALPHA, 'packages', 'entity-core', 'src', 'mod.ts');
const ENTITY_CORE_LEGACY_ENTRY    = path.join(ENTITY_CORE_ALPHA, 'src', 'mod.ts');

const ENTITY_CORE_ENTRY = process.env.ENTITY_CORE_PATH
  ?? (existsSync(ENTITY_CORE_WORKSPACE_ENTRY) ? ENTITY_CORE_WORKSPACE_ENTRY
      : existsSync(ENTITY_CORE_LEGACY_ENTRY)  ? ENTITY_CORE_LEGACY_ENTRY
      : ENTITY_CORE_WORKSPACE_ENTRY); // default to the current layout in the error

// Project root of entity-core (parent of src/).
// entity-core resolves its ./data directory relative to cwd, so we must
// start it from its own root, not from wherever node server.js was launched.
const ENTITY_CORE_ROOT = path.dirname(path.dirname(ENTITY_CORE_ENTRY));

/** @type {import('@modelcontextprotocol/sdk/client/index.js').Client | null} */
let mcpClient = null;

// ── Canonical file orderings (mirrors Psycheros src/entity/context.ts) ───────

const SELF_ORDER = [
  'my_identity.md', 'my_persona.md', 'my_personhood.md',
  'my_wants.md', 'my_mechanics.md',
];
const USER_ORDER = [
  'user_identity.md', 'user_life.md', 'user_beliefs.md',
  'user_preferences.md', 'user_patterns.md', 'user_notes.md',
];
const RELATIONSHIP_ORDER = [
  'relationship_dynamics.md', 'relationship_history.md', 'relationship_notes.md',
];

// ── Connection ────────────────────────────────────────────────────────────────

async function connect() {
  const transport = new StdioClientTransport({
    command: 'deno',
    args: ['run', '-A', '--unstable-cron', ENTITY_CORE_ENTRY],
    cwd: ENTITY_CORE_ROOT,
  });

  const client = new Client(
    { name: 'proto-familiar', version: '1.0.0' },
    { capabilities: {} },
  );

  client.onclose = () => {
    console.error('[thalamus] entity-core connection closed');
    mcpClient = null;
  };

  await client.connect(transport);
  mcpClient = client;
  console.log('[thalamus] Connected to entity-core at', ENTITY_CORE_ENTRY);
}

connect().catch(err => {
  console.error('[thalamus] Failed to start entity-core:', err.message);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseToolText(result, fallback) {
  const text = result?.content?.find(c => c.type === 'text')?.text;
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/** Wrap a file's content in its promptLabel XML tags. */
function wrapFile(filename, content, promptLabel) {
  const label = promptLabel ?? filename.replace(/\.md$/, '');
  return `<${label}>\n${content.trim()}\n</${label}>`;
}

/** Sort identity files by a predefined order, alphabetical for unknowns. */
function sortFiles(files, order) {
  return [...files].sort((a, b) => {
    const ai = order.indexOf(a.filename);
    const bi = order.indexOf(b.filename);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.filename.localeCompare(b.filename);
  });
}

/**
 * Convert an array of identity file objects to a string.
 * Each non-empty file is XML-wrapped and joined with --- separators.
 */
function identitySection(files, order) {
  if (!files?.length) return '';
  const sorted = sortFiles(files.filter(f => f.content?.trim()), order);
  if (!sorted.length) return '';
  return sorted
    .map(f => wrapFile(f.filename, f.content, f.promptLabel))
    .join('\n\n---\n\n');
}

// ── enrich ────────────────────────────────────────────────────────────────────

/**
 * Build the full entity-core context for a user message.
 * Fires identity, memory, and graph queries in parallel then assembles:
 *
 *   <base_instructions>…</base_instructions>          (if present)
 *   ---
 *   My self files …                                   (XML-wrapped, ordered)
 *   ---
 *   User files …
 *   ---
 *   Relationship files …
 *   ---
 *   Custom files …
 *   ---
 *   Relevant Memories via RAG:                        (scored excerpts)
 *   ---
 *   Relevant Knowledge from Graph:                    (nodes + edges)
 *
 * Returns '' on any error so the request degrades gracefully.
 *
 * @param {string} userMessage
 * @returns {Promise<string>}
 */
export async function enrich(userMessage) {
  if (!mcpClient) return '';

  try {
    // Fire all three queries in parallel but independently — a failure in
    // memory_search or graph_node_search must not prevent identity from being
    // injected. Promise.allSettled never rejects.
    const [idSettled, memSettled, graphSettled] = await Promise.allSettled([
      mcpClient.callTool({ name: 'identity_get_all', arguments: {} }),
      mcpClient.callTool({
        name: 'memory_search',
        arguments: { query: userMessage, instanceId: 'proto-familiar', maxResults: 5 },
      }),
      mcpClient.callTool({
        name: 'graph_node_search',
        arguments: { query: userMessage, limit: 10, minScore: 0.3 },
      }),
    ]);

    if (idSettled.status    === 'rejected') console.error('[thalamus] identity_get_all failed:', idSettled.reason?.message ?? idSettled.reason);
    if (memSettled.status   === 'rejected') console.error('[thalamus] memory_search failed:',    memSettled.reason?.message ?? memSettled.reason);
    if (graphSettled.status === 'rejected') console.error('[thalamus] graph_node_search failed:', graphSettled.reason?.message ?? graphSettled.reason);

    const idResult    = idSettled.status    === 'fulfilled' ? idSettled.value    : null;
    const memResult   = memSettled.status   === 'fulfilled' ? memSettled.value   : null;
    const graphResult = graphSettled.status === 'fulfilled' ? graphSettled.value : null;

    // ── Identity ──────────────────────────────────────────────────────────
    const id = parseToolText(idResult, {});

    // base_instructions.md goes first without a section header
    const baseFile = (id.self ?? []).find(f => f.filename === 'base_instructions.md');
    const baseContent = baseFile?.content?.trim()
      ? wrapFile(baseFile.filename, baseFile.content, baseFile.promptLabel)
      : '';

    const selfFiles   = (id.self ?? []).filter(f => f.filename !== 'base_instructions.md');
    const selfContent = identitySection(selfFiles, SELF_ORDER);
    const userContent = identitySection(id.user ?? [], USER_ORDER);
    const relContent  = identitySection(id.relationship ?? [], RELATIONSHIP_ORDER);
    const custContent = identitySection(id.custom ?? [], []);

    // ── Memories ──────────────────────────────────────────────────────────
    const mem = parseToolText(memResult, {});
    const memLines = (mem.results ?? [])
      .map((r, i) => {
        const score  = ((r.score ?? r.vectorScore ?? 0) * 100).toFixed(0);
        const source = [r.granularity, r.date].filter(Boolean).join('/');
        return `[${i + 1}] (from ${source}, ${score}% relevant)\n${(r.excerpt ?? '').trim()}`;
      })
      .filter(s => s.length > 5)
      .join('\n\n');

    // ── Knowledge graph ───────────────────────────────────────────────────
    const graphData  = parseToolText(graphResult, {});
    // graph_node_search returns { results: [{ node: {...}, score }, ...] }.
    // Older / alternate shapes return { nodes: [...] } with flat nodes.
    // Normalise to flat nodes so n.id / n.label / n.type are always defined —
    // otherwise the standalone-nodes branch below renders "undefined (type:
    // undefined)" for every result, and the graph_subgraph traversal calls
    // get nodeId=undefined and return nothing.
    const rawGraphItems = graphData.results ?? graphData.nodes ?? [];
    const graphNodes = rawGraphItems
      .map(item => (item && item.node) ? item.node : item)
      .filter(n => n && n.id);
    let graphLines = '';

    if (graphNodes.length > 0) {
      // Traverse 1 hop from top-3 nodes; ignore individual failures
      const traversals = await Promise.allSettled(
        graphNodes.slice(0, 3).map(n =>
          mcpClient.callTool({
            name: 'graph_subgraph',
            arguments: { nodeId: n.id, depth: 1 },
          })
        )
      );

      const nodeLabels = new Map(graphNodes.map(n => [n.id, n.label]));
      const nodeDescs  = new Map(graphNodes.map(n => [n.id, n.description ?? '']));
      const seenEdges  = new Set();
      const edgeNodeIds = new Set();
      const lines = [];
      // Track id ↔ label for the in-prompt legend so the Familiar can resolve
      // "Eury protects Chen" to the underlying graph IDs without a tool call.
      const idLegendNodes = new Map(); // id → label
      const idLegendEdges = [];        // { id, fromLabel, rel, toLabel }

      for (const r of traversals) {
        if (r.status !== 'fulfilled') continue;
        const sg = parseToolText(r.value, {});
        for (const node of sg.nodes ?? []) {
          if (!nodeLabels.has(node.id)) {
            nodeLabels.set(node.id, node.label);
            nodeDescs.set(node.id, node.description ?? '');
          }
        }
        for (const edge of sg.edges ?? []) {
          if (seenEdges.has(edge.id)) continue;
          seenEdges.add(edge.id);
          edgeNodeIds.add(edge.fromId);
          edgeNodeIds.add(edge.toId);
          const from = nodeLabels.get(edge.fromId) ?? edge.fromId;
          const to   = nodeLabels.get(edge.toId)   ?? edge.toId;
          const rel  = edge.customType ?? edge.type;
          const desc = nodeDescs.get(edge.toId);
          lines.push(desc ? `${from} ${rel} ${to} (${desc})` : `${from} ${rel} ${to}`);
          if (edge.fromId && nodeLabels.has(edge.fromId)) idLegendNodes.set(edge.fromId, nodeLabels.get(edge.fromId));
          if (edge.toId   && nodeLabels.has(edge.toId))   idLegendNodes.set(edge.toId,   nodeLabels.get(edge.toId));
          if (edge.id) idLegendEdges.push({ id: edge.id, fromLabel: from, rel, toLabel: to });
        }
      }

      // Standalone nodes (no edges in this context). Skip nodes whose
      // label is missing — a labelless node has nothing meaningful to
      // contribute to the prompt and would render as a noise line.
      for (const n of graphNodes) {
        if (edgeNodeIds.has(n.id)) continue;
        const label = n.label;
        if (!label) continue;
        const type = n.type ? ` (type: ${n.type})` : '';
        const desc = n.description ? ` — ${n.description}` : '';
        lines.push(`${label}${type}${desc}`);
        idLegendNodes.set(n.id, label);
      }

      // Compact ID legend at the end of the block — the Familiar uses these
      // strings as `id` arguments to update_graph_node / delete_graph_node /
      // update_graph_edge / delete_graph_edge. Kept compact (one entry per
      // line, no surrounding prose) to bound the token cost. For anything
      // not in this list, the Familiar can use find_graph_node /
      // find_graph_edges to look ids up on demand.
      if (idLegendNodes.size || idLegendEdges.length) {
        const legendLines = ['', '[graph ids — pass these strings to update_graph_node / delete_graph_node / update_graph_edge / delete_graph_edge]'];
        if (idLegendNodes.size) {
          legendLines.push('nodes:');
          for (const [id, label] of idLegendNodes) legendLines.push(`  ${label} = ${id}`);
        }
        if (idLegendEdges.length) {
          legendLines.push('edges:');
          for (const e of idLegendEdges) legendLines.push(`  ${e.fromLabel} -${e.rel}-> ${e.toLabel} = ${e.id}`);
        }
        lines.push(legendLines.join('\n'));
      }

      graphLines = lines.join('\n');
    }

    // ── Assemble (mirrors Psycheros buildSystemMessage) ───────────────────
    const sections = [];

    if (baseContent) sections.push(baseContent);
    if (selfContent) sections.push(`---\nMy self files (from identity/self/ directory):\n\n${selfContent}`);
    if (userContent) sections.push(`---\nUser files (from identity/user/ directory):\n\n${userContent}`);
    if (relContent)  sections.push(`---\nRelationship files (from identity/relationship/ directory):\n\n${relContent}`);
    if (custContent) sections.push(`---\nCustom files (from identity/custom/ directory):\n\n${custContent}`);
    if (memLines)    sections.push(`---\nRelevant Memories via RAG:\n\n${memLines}`);
    if (graphLines)  sections.push(`---\nRelevant Knowledge from Graph:\n${graphLines}`);

    if (sections.length === 0) {
      console.warn('[thalamus] enrich() produced no content — identity files may be empty and no memories found');
    } else {
      console.log(`[thalamus] enrich() injecting ${sections.length} section(s), ~${sections.join('\n').length} chars`);
    }

    return sections.join('\n');
  } catch (err) {
    console.error('[thalamus] enrich failed:', err.message);
    return '';
  }
}

// ── Write operations ──────────────────────────────────────────────────────────

/**
 * Create a new memory entry in entity-core.
 * @param {{ content: string, granularity: string, date?: string, instanceId?: string }} opts
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function createMemory({ content, granularity = 'daily', date, instanceId = 'proto-familiar' }) {
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
  try {
    const today = new Date().toISOString().slice(0, 10);
    await mcpClient.callTool({
      name: 'memory_create',
      arguments: { content, granularity, date: date ?? today, instanceId },
    });
    console.log(`[thalamus] createMemory() saved ${granularity} memory`);
    return { ok: true };
  } catch (err) {
    console.error('[thalamus] createMemory failed:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Append content to an entity-core identity file.
 * @param {{ category: string, filename: string, content: string }} opts
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function appendIdentity({ category, filename, content }) {
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
  try {
    await mcpClient.callTool({
      name: 'identity_append',
      arguments: { category, filename, content },
    });
    console.log(`[thalamus] appendIdentity() updated ${category}/${filename}`);
    return { ok: true };
  } catch (err) {
    console.error('[thalamus] appendIdentity failed:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Append content to a specific markdown section of an entity-core identity file.
 * Auto-creates the section if the heading doesn't exist.
 * @param {{ category: string, filename: string, heading: string, content: string }} opts
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function updateIdentitySection({ category, filename, heading, content }) {
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
  try {
    await mcpClient.callTool({
      name: 'identity_update_section',
      arguments: { category, filename, heading, content },
    });
    console.log(`[thalamus] updateIdentitySection() updated ${category}/${filename} § ${heading}`);
    return { ok: true };
  } catch (err) {
    console.error('[thalamus] updateIdentitySection failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// ── Knowledge editing (memory, identity, graph) ──────────────────────────────
//
// Every destructive op (update / delete / rewrite) auto-snapshots first via
// snapshot_create so the user has a one-click undo path through the
// snapshot_restore tool. Snapshots themselves are pruned by entity-core's own
// retention policy (ENTITY_CORE_SNAPSHOT_RETENTION_DAYS, default 30 days),
// so this doesn't leak storage.

const PROTO_INSTANCE_ID = 'proto-familiar';

async function callTool(name, args = {}) {
  if (!mcpClient) throw new Error('entity-core not connected');
  const result = await mcpClient.callTool({ name, arguments: args });
  return parseToolText(result, {});
}

async function autoSnapshot(reason) {
  try {
    await callTool('snapshot_create', {});
    console.log(`[thalamus] auto-snapshot before ${reason}`);
  } catch (err) {
    // Don't block the destructive op on snapshot failure — log and continue.
    console.warn(`[thalamus] auto-snapshot failed before ${reason}: ${err.message}`);
  }
}

// ── Reads (used by the Knowledge editor UI) ──────────────────────────────────

export async function listMemories({ granularity, limit = 50, offset = 0 } = {}) {
  return callTool('memory_list', { granularity, limit, offset });
}

export async function readMemory({ granularity, date }) {
  return callTool('memory_read', { granularity, date });
}

export async function getIdentityAll() {
  return callTool('identity_get_all', {});
}

export async function listGraphNodes({ type, limit = 200, offset = 0 } = {}) {
  return callTool('graph_node_list', { type, limit, offset });
}

export async function searchGraphNodes({ query, type, limit = 10, minScore } = {}) {
  return callTool('graph_node_search', { query, type, limit, minScore });
}

export async function getGraphSubgraph({ nodeId, depth = 1 }) {
  return callTool('graph_subgraph', { nodeId, depth });
}

// Aggregate every node and every edge into one payload for the Map view.
// entity-core has no "list all edges" tool, so we walk each node's 1-hop
// subgraph and deduplicate edges by id. Concurrency is capped so we don't
// open hundreds of simultaneous tool calls against the MCP server, and
// edges to nodes outside the (possibly type-filtered) visible set are
// dropped so the legend matches what's actually drawn.
export async function getFullGraph({ type, limit = 500, concurrency = 16 } = {}) {
  const nodeResp = await listGraphNodes({ type, limit });
  const nodes    = nodeResp.nodes ?? nodeResp.results ?? [];
  const nodeIds  = new Set(nodes.map(n => n.id));
  const edgeMap  = new Map();

  let cursor = 0;
  const worker = async () => {
    while (cursor < nodes.length) {
      const i = cursor++;
      const sg = await getGraphSubgraph({ nodeId: nodes[i].id, depth: 1 }).catch(() => null);
      if (!sg) continue;
      for (const e of sg.edges ?? []) {
        if (!e || !e.id || edgeMap.has(e.id)) continue;
        if (!nodeIds.has(e.fromId) || !nodeIds.has(e.toId)) continue;
        edgeMap.set(e.id, e);
      }
    }
  };
  const workers = Array.from(
    { length: Math.min(concurrency, nodes.length) || 1 },
    () => worker(),
  );
  await Promise.all(workers);

  return { nodes, edges: Array.from(edgeMap.values()) };
}

export async function listSnapshots() {
  return callTool('snapshot_list', {});
}

// ── Writes (auto-snapshot before destructive) ────────────────────────────────

export async function updateMemory({ granularity, date, content, editedBy = PROTO_INSTANCE_ID }) {
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
  await autoSnapshot(`memory_update ${granularity}/${date}`);
  try {
    const result = await callTool('memory_update', { granularity, date, content, editedBy });
    console.log(`[thalamus] updateMemory ${granularity}/${date}`);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] updateMemory failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function deleteMemory({ granularity, date, instanceId, slug }) {
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
  await autoSnapshot(`memory_delete ${granularity}/${date}`);
  try {
    const result = await callTool('memory_delete', { granularity, date, instanceId, slug });
    console.log(`[thalamus] deleteMemory ${granularity}/${date}`);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] deleteMemory failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function rewriteIdentitySection({ category, filename, section, content, instanceId = PROTO_INSTANCE_ID }) {
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
  await autoSnapshot(`identity_rewrite_section ${category}/${filename}#${section}`);
  try {
    const result = await callTool('identity_rewrite_section', { category, filename, section, content, instanceId });
    console.log(`[thalamus] rewriteIdentitySection ${category}/${filename} § ${section}`);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] rewriteIdentitySection failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function createGraphNode({ label, type, description, instanceId = PROTO_INSTANCE_ID }) {
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
  try {
    const args = { instanceId };
    if (label       !== undefined) args.label       = label;
    if (description !== undefined) args.description = description;
    if (type        !== undefined) args.type        = type;
    const result = await callTool('graph_node_create', args);
    console.log(`[thalamus] createGraphNode (${label ?? '?'})`);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] createGraphNode failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function createGraphEdge({ fromId, toId, type, weight, instanceId = PROTO_INSTANCE_ID }) {
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
  try {
    const args = { fromId, toId, instanceId };
    if (type   !== undefined) args.type   = type;
    if (weight !== undefined) args.weight = weight;
    const result = await callTool('graph_edge_create', args);
    console.log(`[thalamus] createGraphEdge ${fromId} -${type ?? '?'}-> ${toId}`);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] createGraphEdge failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function updateGraphNode({ id, label, description, type, instanceId = PROTO_INSTANCE_ID }) {
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
  await autoSnapshot(`graph_node_update ${id}`);
  try {
    const args = { id, instanceId };
    if (label       !== undefined) args.label       = label;
    if (description !== undefined) args.description = description;
    if (type        !== undefined) args.type        = type;
    const result = await callTool('graph_node_update', args);
    console.log(`[thalamus] updateGraphNode ${id}`);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] updateGraphNode failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function deleteGraphNode({ id, permanent = false }) {
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
  await autoSnapshot(`graph_node_delete ${id}`);
  try {
    const result = await callTool('graph_node_delete', { id, permanent });
    console.log(`[thalamus] deleteGraphNode ${id}${permanent ? ' (permanent)' : ''}`);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] deleteGraphNode failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function updateGraphEdge({ id, type, weight, instanceId = PROTO_INSTANCE_ID }) {
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
  await autoSnapshot(`graph_edge_update ${id}`);
  try {
    const args = { id, instanceId };
    if (type   !== undefined) args.type   = type;
    if (weight !== undefined) args.weight = weight;
    const result = await callTool('graph_edge_update', args);
    console.log(`[thalamus] updateGraphEdge ${id}`);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] updateGraphEdge failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function deleteGraphEdge({ id }) {
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
  await autoSnapshot(`graph_edge_delete ${id}`);
  try {
    const result = await callTool('graph_edge_delete', { id });
    console.log(`[thalamus] deleteGraphEdge ${id}`);
    return { ok: true, result };
  } catch (err) {
    console.error('[thalamus] deleteGraphEdge failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// ── Snapshots (used by the Knowledge editor's safety-net UI) ────────────────

export async function createSnapshot() {
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
  try {
    const result = await callTool('snapshot_create', {});
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function restoreSnapshot({ snapshotId }) {
  if (!mcpClient) return { ok: false, error: 'entity-core not connected' };
  try {
    const result = await callTool('snapshot_restore', { snapshotId });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
