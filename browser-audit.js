// browser-audit.js — audit trail of every browser navigation and act (§5.6).
//
// The mirror of discord-write-log.js: "what did my Familiar do on the web" is
// always answerable. Append-only JSONL at logs/browser-actions.jsonl. Never
// throws — an audit-log failure must never break the browse it was recording.

import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, promises as fsp } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR  = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'browser-actions.jsonl');

/** Record one browse action. Best-effort; never throws. */
export async function logBrowserAction({ tool, target, verdict, sessionId, grant = null } = {}) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const entry = {
      at:        new Date().toISOString(),
      tool:      tool ?? null,
      target:    target ? String(target).slice(0, 500) : null,
      verdict:   verdict ? String(verdict).slice(0, 600) : null,
      sessionId: sessionId ?? null,
      grant,     // set when a §5.9 autonomy grant authorised the act (Pass 3)
    };
    await fsp.appendFile(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.warn('[browser-audit] append failed (non-fatal):', err?.message ?? err);
  }
}

/** Most-recent actions first. Never throws. */
export async function readBrowserActions({ limit = 200 } = {}) {
  try {
    const raw = await fsp.readFile(LOG_FILE, 'utf8');
    return raw.split('\n').filter(Boolean).slice(-limit).reverse()
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
