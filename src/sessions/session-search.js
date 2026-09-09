/**
 * session-search.js — search the RAW conversation transcript (not memory).
 *
 * The companion to `recall` (which searches Phylactery's distilled memories):
 * this reads the actual session logs, so the Familiar can find what was literally
 * SAID — an outcome my human mentioned in passing that was never memorised yet.
 * The motivating case is the noticing loop closing an overdue projection: "did my
 * human already tell me how the appointment went?" The answer ("wasn't as scary")
 * often carries none of the event's keywords, so this supports TWO ways in:
 *   - a text query (words we'd likely have used), and
 *   - a time window (`sinceMs`) that returns everything said since then, keyword-
 *     free — the reliable way to read back over "since this morning".
 *
 * Ward-privacy is structural: `wardVisibleOnly` keeps the search to ward-private
 * and web sessions (audienceTag null or 'ward-private'); a villager/guild segment
 * is never read. The tool executor ALSO fail-closes on a gated turn — this flag
 * is the belt to that suspenders.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

/** Pull the text out of a message whose content is a string OR the vision-era
 *  array of parts. Empty string when there's nothing textual. */
export function messageText(m) {
  if (typeof m?.content === 'string') return m.content;
  if (Array.isArray(m?.content)) return m.content.find(c => c?.type === 'text')?.text ?? '';
  return '';
}

const wardVisibleTag = (tag) => tag == null || tag === 'ward-private';

/**
 * Search ward-visible session logs for messages matching `query` and/or falling
 * within a time window. Returns ranked matches (more query-terms first, then most
 * recent) as `[{ sessionId, who, when, score, text }]`. Pure over the filesystem;
 * never throws (an unreadable log is skipped, a missing dir yields []).
 *
 * @param {string}  query          words/phrase; matched case-insensitively (terms ≥2 chars). Optional.
 * @param {number}  sinceMs        only messages at/after this epoch-ms. Optional; overrides `days`.
 * @param {number}  days           lookback when no `sinceMs` (default 14, clamped 1–60).
 * @param {number}  limit          max matches (default 8, clamped 1–20).
 * @param {boolean} wardVisibleOnly keep to ward-private/web logs (default true).
 */
export async function searchSessionLogs({
  logsDir, query = '', sinceMs = null, days = 14, limit = 8,
  now = Date.now, wardVisibleOnly = true,
} = {}) {
  if (!logsDir) return [];
  const q = String(query ?? '').trim().toLowerCase();
  const terms = q ? q.split(/\s+/).filter(t => t.length >= 2) : [];
  const dayN = Math.min(60, Math.max(1, Number(days) || 14));
  const cutoff = Number.isFinite(sinceMs) ? sinceMs : now() - dayN * 86400_000;

  let files;
  try { files = (await fsp.readdir(logsDir)).filter(f => f.endsWith('.json')); }
  catch { return []; }

  const out = [];
  for (const f of files) {
    let log;
    try { log = JSON.parse(await fsp.readFile(path.join(logsDir, f), 'utf8')); }
    catch { continue; }
    if (wardVisibleOnly && !wardVisibleTag(log?.audienceTag)) continue;
    const sid = log?.sessionId ?? f.replace(/\.json$/, '');
    for (const m of (Array.isArray(log?.messages) ? log.messages : [])) {
      if (m?.role !== 'user' && m?.role !== 'assistant') continue;
      const text = messageText(m).trim();
      if (!text) continue;
      const t = m?.timestamp ? Date.parse(m.timestamp) : NaN;
      if (Number.isFinite(t) && t < cutoff) continue;
      let score = 0;
      if (terms.length) {
        const hay = text.toLowerCase();
        score = terms.filter(term => hay.includes(term)).length;
        if (!score) continue;   // a query with no term present is not a match
      }
      out.push({
        sessionId: sid,
        who: m.role === 'user' ? (m.speaker || 'them') : 'me',
        when: Number.isFinite(t) ? t : 0,
        score,
        text,
      });
    }
  }
  out.sort((a, b) => (b.score - a.score) || (b.when - a.when));
  return out.slice(0, Math.min(20, Math.max(1, Number(limit) || 8)));
}
