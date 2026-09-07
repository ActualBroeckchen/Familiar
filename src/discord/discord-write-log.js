// discord-write-log.js — audit trail of villager-caused writes.
//
// When a villager acts through the Familiar on Discord and triggers a
// state-mutating tool (a schedule change, a memory write), the causing villager
// + the tool + a truncated arg summary land here. This makes a villager-driven
// write NEVER silent: the ward can see exactly who changed what, and when — the
// observability half of "let a villager contribute, then judge the source".
//
// Append-only JSONL at logs/discord-writes.jsonl. Never throws — an audit-log
// failure must not break the tool call it was recording (graceful degradation).

import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, promises as fsp } from 'fs';

import { REPO_ROOT } from '../../repo-root.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR  = path.join(REPO_ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'discord-writes.jsonl');

/** Record one villager-caused write. Best-effort; never throws. */
export async function logDiscordWrite({ villager, tool, args, locationKey } = {}) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    let argSummary = null;
    try { argSummary = JSON.stringify(args ?? {}).slice(0, 400); } catch { argSummary = null; }
    const entry = {
      at:          new Date().toISOString(),
      villagerId:  villager?.id ?? null,
      villager:    villager?.name ?? null,
      tool:        tool ?? null,
      args:        argSummary,
      locationKey: locationKey ?? null,
    };
    await fsp.appendFile(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.warn('[discord-write-log] append failed (non-fatal):', err?.message ?? err);
  }
}

/** Most-recent villager writes first. Never throws. */
export async function readDiscordWrites({ limit = 200 } = {}) {
  try {
    const raw = await fsp.readFile(LOG_FILE, 'utf8');
    return raw.split('\n').filter(Boolean).slice(-limit).reverse()
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
