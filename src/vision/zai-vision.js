/**
 * z.ai Vision MCP client (vision build spec — coding-plan vision allotment).
 *
 * On the GLM Coding Plan, vision is NOT available through the chat-completions
 * endpoint — it's delivered only through z.ai's "Vision Understanding" MCP
 * server (`@z_ai/mcp-server`, powered by GLM-4.6V) with its OWN quota pool,
 * separate from the coding-prompt allotment. So to spend that allotment we
 * spawn that MCP server as a stdio child (the same SDK Phylactery/Unruh use)
 * and call its `analyze_image` tool for describeAsset.
 *
 * This is DESCRIBE-only: the coding chat models (GLM-4.6/5.2) can't take live
 * image parts, so a z.ai-coding vision setup always describes-then-stands-in
 * (the Pass 2 path). The client is:
 *   - lazily spawned, keyed by API key (a new key tears down + respawns);
 *   - gated (only used when a z.ai-coding connection is assigned to vision);
 *   - graceful — any spawn/call failure returns {ok:false}, so describeAsset
 *     leaves the description null (retried later) and nothing breaks.
 *
 * Off-switch: PROTO_FAMILIAR_ZAI_VISION_DISABLED=1.
 */

import os from 'os';
import path from 'path';
import { promises as fsp } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { shortSlug } from '../../slug-ids.js';
import { IMAGE_MIME_EXT } from './media.js';

// The command that starts the server. Overridable for odd installs / testing.
// Default: `npx -y @z_ai/mcp-server` (bin `zai-mcp-server`, build/index.js).
function zaiMcpSpawn() {
  const override = (process.env.PROTO_FAMILIAR_ZAI_MCP_COMMAND ?? '').trim();
  if (override) {
    const parts = override.split(/\s+/);
    return { command: parts[0], args: parts.slice(1) };
  }
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return { command: npx, args: ['-y', '@z_ai/mcp-server'] };
}

export function zaiVisionDisabled() {
  return process.env.PROTO_FAMILIAR_ZAI_VISION_DISABLED === '1';
}

// ── Pure adaptation helpers (exported for tests) ──────────────────

// z.ai's vision tools are task-specific; `analyze_image` is the general one.
// Fall back to any tool whose name reads as general image analysis.
export function pickAnalyzeTool(tools = []) {
  const names = tools.map(t => t?.name).filter(Boolean);
  if (names.includes('analyze_image')) return 'analyze_image';
  const general = names.find(n => /analyze.*image|image.*analyz|describe.*image/i.test(n));
  return general || names.find(n => /image/i.test(n)) || null;
}

// Build the tool arguments from its inputSchema, adapting to whatever the
// server names its image + prompt params. The real z.ai schema is
// `analyze_image({ image_source: string (local path OR remote url), prompt })` —
// note `image_source` matches neither "path" nor "url", which is exactly what
// the old regex-guessing missed (it sent NO image arg → -32602 Invalid params).
//
// The rule now: find the image-bearing field, then pick the representation its
// NAME implies — base64 for a base64/b64 field, a data URL for a url/data
// field, and otherwise a real file path (the universally-accepted form; a field
// that takes "a path or a url" is happiest with an on-disk absolute path).
// Pure — returns { args, needsFile, imageKey }; needsFile signals the caller
// must materialize a temp file and drop its path in for us.
export function buildAnalyzeArgs(inputSchema, { filePath, dataUrl, base64, prompt } = {}) {
  const props = (inputSchema && typeof inputSchema === 'object' && inputSchema.properties) || {};
  const keys = Object.keys(props);
  const args = {};
  let needsFile = false;

  // Prompt / instruction param, when the tool accepts one.
  const promptKey = keys.find(k => /prompt|query|question|instruction|task|describe/i.test(k)) || null;
  if (promptKey && prompt) args[promptKey] = prompt;

  // The image-bearing param: any non-prompt field whose name reads as an image
  // source. Broadened to catch `image_source`/`source`/`src`/`photo`/`picture`
  // as well as the path/url/base64 shapes. Last resort: the sole other field.
  const imageKey =
    keys.find(k => k !== promptKey && /image|source|src|photo|picture|path|file|url|base64|b64|data/i.test(k)) ||
    keys.find(k => k !== promptKey) ||
    null;

  if (imageKey) {
    if (/base64|b64/i.test(imageKey) && base64 !== undefined) {
      args[imageKey] = base64;
    } else if (/url|data/i.test(imageKey) && dataUrl !== undefined) {
      args[imageKey] = dataUrl;
    } else if (filePath !== undefined) {
      args[imageKey] = filePath; needsFile = true;   // path-or-url field → real file path
    } else if (dataUrl !== undefined) {
      args[imageKey] = dataUrl;                       // no path to hand it — try the data URL
    }
  }

  return { args, needsFile, imageKey };
}

// Pull the assistant text out of an MCP tool result ({content:[{type:'text',text}]}).
export function textFromToolResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n').trim();
  return text;
}

// ── Client lifecycle (lazy, keyed by API key) ─────────────────────

let _client = null;
let _clientKey = null;
let _toolName = null;     // cached analyze tool name
let _toolSchema = null;   // cached inputSchema
let _connecting = null;

async function teardown() {
  const c = _client;
  _client = null; _clientKey = null; _toolName = null; _toolSchema = null;
  if (c) { try { await c.close(); } catch { /* ignore */ } }
}

async function ensureClient(apiKey) {
  const key = String(apiKey ?? '').trim();
  if (!key) return null;
  if (_client && _clientKey === key) return _client;
  if (_client && _clientKey !== key) await teardown();   // key changed → respawn
  if (_connecting) { try { await _connecting; } catch { /* fall through */ } if (_client && _clientKey === key) return _client; }

  _connecting = (async () => {
    const { command, args } = zaiMcpSpawn();
    const transport = new StdioClientTransport({
      command, args,
      env: { ...process.env, Z_AI_API_KEY: key, Z_AI_MODE: 'ZAI' },
    });
    const client = new Client({ name: 'proto-familiar', version: '0' }, { capabilities: {} });
    client.onclose = () => { if (_client === client) { _client = null; _clientKey = null; _toolName = null; _toolSchema = null; } };
    // Bound the spawn+connect (first run does an npx install) so a stuck child
    // can't hang the caller forever — the describe just falls back to null.
    let connectTimer;
    try {
      await Promise.race([
        client.connect(transport),
        new Promise((_, rej) => { connectTimer = setTimeout(() => rej(new Error('connect timed out')), 45_000); }),
      ]);
    } finally { clearTimeout(connectTimer); }
    // Discover the analyze tool + its schema once per client.
    const listed = await client.listTools().catch(() => ({ tools: [] }));
    const tools = Array.isArray(listed?.tools) ? listed.tools : [];
    _toolName = pickAnalyzeTool(tools);
    _toolSchema = tools.find(t => t?.name === _toolName)?.inputSchema ?? null;
    _client = client;
    _clientKey = key;
    // Log the discovered schema's param names — the arg-building adapts to
    // these, so seeing them makes a future "Invalid params" self-diagnosing.
    const schemaKeys = Object.keys(_toolSchema?.properties ?? {});
    console.log(`[zai-vision] connected to @z_ai/mcp-server (tool: ${_toolName ?? 'none found'}; params: ${schemaKeys.join(', ') || 'unknown'})`);
    return client;
  })();
  try { return await _connecting; }
  catch (err) { console.error('[zai-vision] spawn/connect failed:', err?.message ?? err); await teardown(); return null; }
  finally { _connecting = null; }
}

/**
 * Describe an image through the z.ai coding-plan vision MCP. Returns
 * { ok:true, text } or { ok:false, reason }. Never throws.
 *
 * @param {object} p
 * @param {string} p.apiKey   the z.ai coding-plan API key
 * @param {Buffer} p.buffer   the image bytes
 * @param {string} p.mime     the image mime
 * @param {string} p.prompt   the describe instruction (first person, from vision.js)
 */
export async function describeViaZaiVision({ apiKey, buffer, mime, prompt } = {}) {
  if (zaiVisionDisabled()) return { ok: false, reason: 'zai-vision-disabled' };
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { ok: false, reason: 'no-bytes' };
  const client = await ensureClient(apiKey);
  if (!client) return { ok: false, reason: 'zai-mcp-unavailable' };
  if (!_toolName) return { ok: false, reason: 'no-analyze-tool' };

  const base64 = buffer.toString('base64');
  const dataUrl = `data:${mime || 'image/jpeg'};base64,${base64}`;
  const { args, needsFile, imageKey } = buildAnalyzeArgs(_toolSchema, { filePath: '__PENDING__', dataUrl, base64, prompt });

  // Guard the failure the -32602 was: if we couldn't find an image param to
  // fill, don't fire a doomed call — report it with the schema we saw.
  if (!imageKey || args[imageKey] === undefined) {
    const schemaKeys = Object.keys(_toolSchema?.properties ?? {});
    console.error(`[zai-vision] no image param matched in ${_toolName} schema (params: ${schemaKeys.join(', ') || 'unknown'})`);
    return { ok: false, reason: 'no-image-param' };
  }

  // If the tool wants a file path, materialize a temp file (absolute path) and
  // clean it up after — the server (Claude-Code-native) reads images off disk.
  let tmpPath = null;
  try {
    if (needsFile) {
      const ext = IMAGE_MIME_EXT?.[mime] || 'jpg';
      tmpPath = path.join(os.tmpdir(), `pf-zai-${shortSlug(8)}.${ext}`);
      await fsp.writeFile(tmpPath, buffer);
      for (const k of Object.keys(args)) if (args[k] === '__PENDING__') args[k] = tmpPath;
    }
    // Log the arg SHAPE (keys + which representation carries the image, never
    // any of the bytes) so a rejected call shows what we sent vs. what the
    // schema wanted — without leaking a fragment of the image into the logs.
    const imageRepr = needsFile ? 'file-path' : /^data:/.test(args[imageKey] ?? '') ? 'data-url' : 'base64';
    console.log(`[zai-vision] calling ${_toolName} (image param: ${imageKey}=<${imageRepr}>; keys: ${Object.keys(args).join(', ')})`);
    let callTimer;
    let result;
    try {
      result = await Promise.race([
        client.callTool({ name: _toolName, arguments: args }),
        new Promise((_, rej) => { callTimer = setTimeout(() => rej(new Error('analyze_image timed out')), 40_000); }),
      ]);
    } finally { clearTimeout(callTimer); }
    const text = textFromToolResult(result);
    if (!text) return { ok: false, reason: 'empty-result' };
    return { ok: true, text, by: { provider: 'zai-coding', model: 'glm-4.6v(vision-mcp)' } };
  } catch (err) {
    // Loud: the full error text (carries the JSON-RPC code, e.g. -32602 Invalid
    // params or a tier "vision not supported" message) so this is diagnosable
    // from the terminal without a rebuild.
    console.error(`[zai-vision] ${_toolName} call failed:`, err?.message ?? err);
    return { ok: false, reason: `zai-vision-call-failed: ${err?.message ?? err}` };
  } finally {
    if (tmpPath) fsp.rm(tmpPath, { force: true }).catch(() => {});
  }
}

// Clean shutdown (server teardown).
export async function shutdownZaiVision() { await teardown(); }
