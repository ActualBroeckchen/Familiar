/**
 * Shared helper for the CLI ponder scripts: spawn Unruh as an MCP
 * subprocess, run a function against it, tear it down. Mirrors the
 * pattern in thalamus.js but for one-shot use (no reconnect loop,
 * no global state). Underscore prefix so it's clear it's an internal
 * script helper, not a public module.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UNRUH_ROOT = path.resolve(__dirname, '..', 'unruh');

export async function withUnruh(fn) {
  const transport = new StdioClientTransport({
    command: 'uv',
    args:    ['run', '--no-sync', 'python', '-m', 'unruh'],
    cwd:     UNRUH_ROOT,
  });
  const client = new Client(
    { name: 'ponder-cli', version: '0.1.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    try { await client.close(); } catch { /* best-effort */ }
  }
}

/** Extract the JSON-encoded text payload from an MCP tool result. */
export function parseToolText(result, fallback = null) {
  const text = result?.content?.find(c => c.type === 'text')?.text;
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}
