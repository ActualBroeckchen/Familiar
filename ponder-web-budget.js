/**
 * ponder-web-budget.js — the daily read budget for unattended research (§8.5).
 *
 * The Familiar can seek out sources during its own free cycles (pondering,
 * reflection), but that spends real tokens with no one watching, so it's bounded
 * hard in code: a per-day read counter shared across ALL unattended surfaces.
 * When the day's budget is spent the research tools simply aren't offered on the
 * next tick and the prompt says so honestly — never a failed call.
 *
 * Day-keyed JSON at tomes/.ponder-web-budget.json. Local calendar day (the
 * boundary the ward experiences); resets automatically when the day rolls over.
 * Never throws — a budget-file failure degrades to "no budget" (fail-closed:
 * cheaper to skip a ponder-read than to spend unbounded).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, 'tomes', '.ponder-web-budget.json');

export const PONDER_READS_PER_DAY_DEFAULT = 12;

/** Local calendar day as YYYY-MM-DD (the ward's day, not UTC). */
function today() { return new Date().toLocaleDateString('en-CA'); }

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (s && s.date === today() && Number.isFinite(s.reads)) return { date: s.date, reads: s.reads };
  } catch {}
  return { date: today(), reads: 0 };            // absent / stale / malformed → fresh day
}

function cap(settings) {
  const n = Number(settings?.ponderWebReadsPerDay);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : PONDER_READS_PER_DAY_DEFAULT;
}

/** Reads left today. */
export function readsRemaining(settings = {}) {
  return Math.max(0, cap(settings) - readState().reads);
}

/**
 * Record `n` reads against today's budget; returns the new remaining. Best-effort
 * write — if it can't persist, it still returns the computed remaining so the
 * caller stops when the in-memory count says to.
 */
export function recordReads(n = 1, settings = {}) {
  const st = readState();
  st.reads += Math.max(0, Math.floor(n));
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(st)); } catch {}
  return Math.max(0, cap(settings) - st.reads);
}
