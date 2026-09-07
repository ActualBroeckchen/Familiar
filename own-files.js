// own-files.js
//
// Sandboxed read access to my own folder — the Proto-Familiar checkout.
// This is how I (the Familiar) can look things up on purpose: re-read a
// Tome, scan a session log, check a doc. It is READ-ONLY and fenced:
//
//   - Every path resolves inside the repo root. Anything that escapes
//     (`..`, absolute paths, a symlink pointing out) is refused.
//   - Secrets and noise are denied outright: settings.json (API keys,
//     bot token, contact webhooks), .env files, node_modules, .git, the
//     Python venvs, caches, backups. Reading an API key into my context
//     would be a real harm — so the gate is mechanical, not my judgement.
//   - Reads are size-capped and text-only; binaries report as binary
//     rather than dumping bytes into my context.
//
// The audience gate (ward-private only) lives in cerebellum's executors;
// this module is the pure sandbox so it can be unit-tested in isolation.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { sessionLocationLabel } from './src/sessions/session-log.js';

// This file sits at the repo root, so its dir IS the root.
import { REPO_ROOT } from './repo-root.js';

const MAX_READ_BYTES   = 64 * 1024;
const MAX_LIST_ENTRIES = 500;

// Path segments that are never traversed or listed — secrets + noise.
const DENY_SEGMENTS = new Set([
  'node_modules', '.git', '.venv', '__pycache__', '.pf-backups',
]);
// Filenames denied wherever they appear — these hold credentials.
const DENY_FILES = [
  /^\.env(\..*)?$/i,                 // .env, .env.local, …
  /^settings\.json$/i,               // API keys, Discord bot token, webhooks
  /^\.proto-familiar-config\.json$/i,// tailscale/runtime config
  /^credentials-vault\.json$/i,      // browser §5.9: passwords the model must NEVER read
  /^autonomy-grants\.json$/i,        // browser §5.9: the ward's hand-signed grant file
];

function denied(relPath) {
  const parts = String(relPath).split(/[/\\]/).filter(Boolean);
  for (const seg of parts) if (DENY_SEGMENTS.has(seg)) return true;
  const base = parts[parts.length - 1] ?? '';
  return DENY_FILES.some(re => re.test(base));
}

// Resolve a user-supplied relative path inside root, or null if it
// escapes. Uses realpath on the *parent* so a symlink can't tunnel out.
function safeResolve(root, rel) {
  const cleaned = String(rel ?? '').trim();
  // Reject absolute inputs up front; everything is relative to root.
  if (path.isAbsolute(cleaned)) return null;
  const resolved = path.resolve(root, cleaned || '.');
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function relFromRoot(root, abs) {
  const r = path.relative(root, abs);
  return r === '' ? '.' : r;
}

/**
 * List the entries directly under a repo-relative directory.
 * @returns {Promise<{ok:true, dir, entries:Array}|{ok:false,error}>}
 */
export async function listOwnFiles(relDir = '.', { root = REPO_ROOT } = {}) {
  const abs = safeResolve(root, relDir);
  if (abs == null) return { ok: false, error: 'that path is outside my own folder' };
  const rel = relFromRoot(root, abs);
  if (rel !== '.' && denied(rel)) return { ok: false, error: 'that path is off-limits (secrets or build noise)' };

  let dirents;
  try {
    const st = await fs.stat(abs);
    if (!st.isDirectory()) return { ok: false, error: 'that is a file, not a folder — use read_file' };
    dirents = await fs.readdir(abs, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, error: 'no such folder' };
    return { ok: false, error: err.message };
  }

  const entries = [];
  for (const d of dirents) {
    const childRel = rel === '.' ? d.name : `${rel}/${d.name}`;
    if (denied(childRel)) continue;
    const isDir = d.isDirectory();
    let size = null;
    if (!isDir) {
      try { size = (await fs.stat(path.join(abs, d.name))).size; } catch { /* ignore */ }
    }
    entries.push({ name: d.name, path: childRel, type: isDir ? 'dir' : 'file', ...(size != null ? { size } : {}) });
    if (entries.length >= MAX_LIST_ENTRIES) break;
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { ok: true, dir: rel, entries };
}

/**
 * Read a repo-relative text file (size-capped, text-only).
 * @returns {Promise<{ok:true, path, content, truncated}|{ok:false,error}>}
 */
export async function readOwnFile(relPath, { root = REPO_ROOT, maxBytes = MAX_READ_BYTES } = {}) {
  const abs = safeResolve(root, relPath);
  if (abs == null) return { ok: false, error: 'that path is outside my own folder' };
  const rel = relFromRoot(root, abs);
  if (rel === '.' || denied(rel)) return { ok: false, error: 'that file is off-limits (secrets or build noise) or not a file' };

  let buf;
  try {
    const st = await fs.stat(abs);
    if (st.isDirectory()) return { ok: false, error: 'that is a folder — use list_files' };
    const fh = await fs.open(abs, 'r');
    try {
      const len = Math.min(st.size, maxBytes);
      buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, 0);
    } finally { await fh.close(); }
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, error: 'no such file' };
    return { ok: false, error: err.message };
  }

  // Binary guard: a NUL byte in the sampled head means "not text".
  if (buf.includes(0)) return { ok: false, error: 'that looks like a binary file — I only read text' };

  let truncated = false;
  try {
    const fullSize = (await fs.stat(abs)).size;
    truncated = fullSize > buf.length;
  } catch { /* ignore */ }

  return { ok: true, path: rel, content: buf.toString('utf8'), truncated };
}

// ── Searching my own session logs ─────────────────────────────────────
// The "let me glance back and find where that was said" capability. A content
// search across logs/*.json — every past conversation, web or Discord, DM or
// group room — so I can locate a moment without already knowing which log holds
// it. Read-only; the same denylist applies (a secret file can never surface).
// The audience gate (ward-private only) lives in cerebellum's executor, like
// read_file — this is the pure searcher so it can be unit-tested in isolation.

const MAX_SNIPPET_LEN = 240;

function _msTime(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

// A short window of the message around the first matched term, whitespace
// collapsed, with ellipses where it's clipped — enough to recognise the moment.
function _snippet(content, terms) {
  const flat = String(content).replace(/\s+/g, ' ').trim();
  const lc = flat.toLowerCase();
  let at = -1;
  for (const t of terms) { const i = lc.indexOf(t); if (i !== -1 && (at === -1 || i < at)) at = i; }
  if (at === -1) return flat.slice(0, MAX_SNIPPET_LEN) + (flat.length > MAX_SNIPPET_LEN ? '…' : '');
  const half = Math.floor((MAX_SNIPPET_LEN - 40) / 2);
  const start = Math.max(0, at - half);
  const end = Math.min(flat.length, at + (MAX_SNIPPET_LEN - half));
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

/**
 * Search my session logs for where something was said.
 * @param {string} query  plain words; all whitespace-separated terms must appear
 *   in the same message (case-insensitive) for it to match.
 * @returns {Promise<{ok:true, hits:Array, truncated:boolean}|{ok:false,error}>}
 *   hits (newest-first): { path, sessionId, locationLabel, when, snippets:[{role,speaker,when,text}] }.
 *   `path` is the log to open next with read_file. Never throws.
 */
export async function searchSessions(query, {
  root = REPO_ROOT, logsDir = 'logs', limit = 12, maxSnippetsPerFile = 3,
} = {}) {
  const q = String(query ?? '').trim();
  if (!q) return { ok: false, error: 'I need something to look for' };
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);

  const abs = safeResolve(root, logsDir);
  if (abs == null) return { ok: false, error: 'that path is outside my own folder' };

  let files;
  try { files = await fs.readdir(abs); }
  catch { return { ok: true, hits: [], truncated: false }; }  // no logs yet — not an error

  const results = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    if (denied(`${logsDir}/${f}`)) continue;   // never surface a secret, even here
    let log;
    try { log = JSON.parse(await fs.readFile(path.join(abs, f), 'utf8')); }
    catch { continue; }                         // corrupt/unreadable — skip, never throw
    if (!log || !Array.isArray(log.messages)) continue;

    const snippets = [];
    for (const m of log.messages) {
      const content = typeof m?.content === 'string' ? m.content : '';
      if (!content) continue;
      const lc = content.toLowerCase();
      if (!terms.every((t) => lc.includes(t))) continue;
      snippets.push({
        role: m.role || 'unknown',
        speaker: m.speaker || null,
        when: m.timestamp || null,
        text: _snippet(content, terms),
      });
      if (snippets.length >= maxSnippetsPerFile) break;
    }
    if (!snippets.length) continue;

    const when = log.updatedAt || log.endedAt || log.startedAt ||
      snippets[snippets.length - 1].when || null;
    results.push({
      path: `${logsDir}/${f}`,
      sessionId: log.sessionId || f.replace(/\.json$/, ''),
      locationLabel: sessionLocationLabel(log.location, log.origin),
      when,
      snippets,
    });
  }

  results.sort((a, b) => _msTime(b.when) - _msTime(a.when));
  return { ok: true, hits: results.slice(0, limit), truncated: results.length > limit };
}

// ── Reading a session log as a token-economical transcript ────────────
// A raw session log is JSON: per-message UUIDs, quoted keys, full ISO
// timestamps, braces — heavy to read and, worse, the byte cap truncates it
// mid-JSON into something malformed. When the Familiar opens one, it wants the
// CONVERSATION, not the wire format. So a `logs/*.json` read is rendered to a
// compact markdown transcript instead: a one-line header, a date divider only
// when the day changes, then `[HH:MM] speaker: text` lines. Markdown is far
// denser, so the same budget carries much more of the actual talk, and a trim
// keeps the MOST RECENT part (what a glance-back usually wants).

const MAX_SESSION_MD = 48 * 1024;

// Session-log paths only — a plain `logs/<id>.json`. Other files (tomes, docs)
// keep the raw read.
export function isSessionLogPath(rel) {
  return /^logs\/[^/\\]+\.json$/.test(String(rel ?? '').replace(/\\/g, '/'));
}

// Wall-clock fields pulled straight from the ISO string (no timezone maths — the
// same value the raw JSON already showed, just far cheaper). Tolerant of legacy
// forms; returns null when there's nothing clock-like.
function _isoDate(ts) { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(ts ?? '')); return m ? m[1] : null; }
function _isoHM(ts)   { const m = /[T ](\d{2}:\d{2})/.exec(String(ts ?? ''));    return m ? m[1] : null; }

function _speakerFor(m) {
  if (m?.speaker) return m.speaker;
  if (m?.role === 'assistant') return 'me';
  if (m?.role === 'user') return 'my human';
  return m?.role || 'unknown';
}

/**
 * Render a parsed session log to a compact markdown transcript. Pure; keeps the
 * most recent messages when the rendered text would exceed `maxChars`, and
 * reports whether it trimmed. Never throws on odd shapes.
 */
export function renderSessionMarkdown(log, { maxChars = MAX_SESSION_MD } = {}) {
  const msgs = Array.isArray(log?.messages) ? log.messages : [];
  const dates = msgs.map((m) => _isoDate(m?.timestamp)).filter(Boolean);
  const first = dates[0], last = dates[dates.length - 1];
  const range = !first ? '' : (first === last ? first : `${first} → ${last}`);
  const loc = sessionLocationLabel(log?.location, log?.origin);
  const sid = log?.sessionId || '';
  const header = ['Session', sid, '·', loc, range ? `· ${range}` : '', `· ${msgs.length} message${msgs.length === 1 ? '' : 's'}`]
    .filter(Boolean).join(' ');

  // Build per-message lines, keyed with their date so the trimmer can re-emit a
  // day divider if it drops the one a kept block belonged under.
  const rows = [];
  for (const m of msgs) {
    const content = typeof m?.content === 'string' ? m.content.trim() : '';
    const attach = Array.isArray(m?.attachments) && m.attachments.length
      ? ' ' + m.attachments.map((a) => `[${a?.kind || 'file'}]`).join(' ')
      : '';
    if (!content && !attach) continue;
    const hm = _isoHM(m?.timestamp);
    rows.push({
      date: _isoDate(m?.timestamp),
      text: `${hm ? `[${hm}] ` : ''}${_speakerFor(m)}: ${content}${attach}`,
    });
  }

  // Emit newest-kept-first budget: walk from the end, keep rows until the budget
  // is spent, then restore chronological order. A date divider is inserted
  // whenever the day changes across kept rows.
  let used = header.length + 1;
  const keptReversed = [];
  let trimmed = false;
  for (let i = rows.length - 1; i >= 0; i--) {
    const cost = rows[i].text.length + 1;
    if (used + cost > maxChars && keptReversed.length) { trimmed = true; break; }
    used += cost;
    keptReversed.push(rows[i]);
  }
  const kept = keptReversed.reverse();

  const lines = [header, ''];
  let curDate = null;
  for (const r of kept) {
    if (r.date && r.date !== curDate) { lines.push(`— ${r.date} —`); curDate = r.date; }
    lines.push(r.text);
  }
  return { markdown: lines.join('\n'), trimmed };
}

/**
 * Read a session log and return it as a compact markdown transcript. Goes
 * through the same sandbox + secret denylist as readOwnFile (via a larger byte
 * read so the JSON parses whole), then renders. If the file isn't a parseable
 * session log (corrupt, or not session-shaped), returns { ok:false, fallback:true }
 * so the caller can fall back to the raw read. Never throws.
 * @returns {Promise<{ok:true, path, content, truncated}|{ok:false, fallback?:boolean, error}>}
 */
export async function readSessionLog(relPath, { root = REPO_ROOT, maxBytes = 4 * 1024 * 1024, maxChars = MAX_SESSION_MD } = {}) {
  const abs = safeResolve(root, relPath);
  if (abs == null) return { ok: false, error: 'that path is outside my own folder' };
  const rel = relFromRoot(root, abs);
  if (rel === '.' || denied(rel)) return { ok: false, error: 'that file is off-limits (secrets or build noise) or not a file' };

  let raw;
  try {
    const st = await fs.stat(abs);
    if (st.isDirectory()) return { ok: false, error: 'that is a folder — use list_files' };
    if (st.size > maxBytes) return { ok: false, fallback: true, error: 'session log too large to render' };
    raw = await fs.readFile(abs, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, error: 'no such file' };
    return { ok: false, error: err.message };
  }

  let log;
  try { log = JSON.parse(raw); }
  catch { return { ok: false, fallback: true, error: 'not parseable as a session log' }; }
  if (!log || typeof log !== 'object' || !Array.isArray(log.messages)) {
    return { ok: false, fallback: true, error: 'not a session log' };
  }

  const { markdown, trimmed } = renderSessionMarkdown(log, { maxChars });
  return { ok: true, path: rel, content: markdown, truncated: trimmed };
}
