/**
 * Google Calendar source adapters — the FETCH half of inbound sync.
 *
 * Network + the calendar URL live in Node (consistent with every other
 * adapter: websearch, the Discord token), so Unruh stays pure
 * parse-and-store and unit-tests against fixture `.ics` strings with no
 * network (build spec §1.5). This module only fetches bytes; Unruh's
 * `gcal_ingest` does all parsing and reconciliation.
 *
 * Pass 1 ships the link adapter (an out-of-the-box iCal URL — Google's
 * "secret address in iCal format"). The authenticated gogcli/gcalcli
 * adapters (Pass 4) are interchangeable behind the same one seam: each
 * produces input for `gcal_ingest`, neither forks the pipeline.
 */

import { exec } from 'child_process';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';

const FETCH_TIMEOUT_MS = 20_000;
const CLI_TIMEOUT_MS = 30_000;
const CLI_MAX_BUFFER = 8 * 1024 * 1024;  // 8 MB — a big calendar export still fits

/**
 * Normalise a user-pasted calendar address to an https URL we can fetch.
 * Google offers the secret iCal address as `https://…/basic.ics`, but
 * calendar apps frequently hand out the `webcal://` scheme — same bytes,
 * different prefix. Returns null for anything that isn't an http(s)/webcal
 * URL so a fat-fingered value fails fast instead of throwing mid-fetch.
 */
export function normalizeIcalUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('webcal://')) return 'https://' + trimmed.slice('webcal://'.length);
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  return null;
}

/**
 * Fetch the raw `.ics` text from an iCal URL. Returns
 * `{ ok: true, icsText }` or `{ ok: false, error }` — it never throws, so
 * the sync loop degrades silently (CLAUDE.md graceful-degradation): a bad
 * URL, a network blip, an HTTP error, or a body that isn't iCal all become
 * a structured `ok:false` the loop logs and moves past, never a crash and
 * never a chat-path error.
 *
 * @param {string} url             the iCal / webcal URL from settings
 * @param {object} [opts]
 * @param {Function} [opts.fetchFn] injectable fetch (tests pass a stub)
 * @param {number} [opts.timeoutMs]
 */
export async function fetchIcal(url, { fetchFn = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const normalized = normalizeIcalUrl(url);
  if (!normalized) return { ok: false, error: 'invalid or empty iCal URL' };
  if (typeof fetchFn !== 'function') return { ok: false, error: 'fetch unavailable in this runtime' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetchFn(normalized, {
      signal: controller.signal,
      headers: { Accept: 'text/calendar, text/plain, */*' },
      redirect: 'follow',
    });
    if (!res || !res.ok) {
      return { ok: false, error: `fetch failed: HTTP ${res?.status ?? '??'}` };
    }
    const text = await res.text();
    // Cheap sanity gate: a real feed contains a VCALENDAR. An auth wall or
    // an error page (HTML) must NOT be treated as "the calendar is empty"
    // — that would let the deletion-reconcile cancel everything (§1.3).
    if (!text || !/BEGIN:VCALENDAR/i.test(text)) {
      return { ok: false, error: 'response is not an iCalendar feed' };
    }
    return { ok: true, icsText: text };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (err?.message ?? String(err));
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

// ── Authenticated CLI adapters (advanced tier, §1.5) ─────────────────
//
// gogcli (full Workspace) and gcalcli (calendar-only, lighter) are
// interchangeable behind this one seam — and so is any other tool the ward
// already trusts to read their calendar. Rather than hardcode one tool's
// flags (which vary by version and can't be verified here), the ward
// supplies a command that prints their calendar to stdout as either an
// `.ics` feed or a JSON array of events. An `.ics` command reuses Unruh's
// parser verbatim (no second parser); a JSON command is normalised here.
//
// These are WINDOWED/partial reads by nature (an authenticated read usually
// covers a forward window), so they always pass reconcile_deletes:false —
// they can't cancel events outside the window they fetched (§1.3).

const CLI_PRESETS = {
  // Documented starting points — the ward overrides the command to match
  // their installed tool/version. Both default to an iCal export so the
  // bytes route straight through Unruh's existing parser.
  gogcli:  { hint: 'gogcli calendar events --ics', format: 'ics' },
  gcalcli: { hint: 'gcalcli --nocolor agenda --details=all', format: 'json' },
};

export function cliPresetHint(name) { return CLI_PRESETS[name]?.hint ?? ''; }

/**
 * Map a loose JSON event (whatever a CLI emits) to the normalized-event
 * shape Unruh's gcal_ingest(events=[…]) expects. Defensive about field
 * names because different tools spell them differently. An entry with no
 * stable id/uid is dropped — without it reconcile can't be idempotent.
 */
export function normalizeCliEvents(raw) {
  const arr = Array.isArray(raw) ? raw : (Array.isArray(raw?.events) ? raw.events : []);
  const out = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const uid = e.uid ?? e.id ?? e.iCalUID ?? e.ical_uid ?? null;
    if (!uid) continue;
    const start = e.start?.dateTime ?? e.start?.date ?? e.start ?? e.when ?? e.begin ?? null;
    const end = e.end?.dateTime ?? e.end?.date ?? e.end ?? null;
    const allDay = !!(e.all_day ?? e.allDay ?? (e.start && e.start.date && !e.start.dateTime));
    out.push({
      uid: String(uid),
      summary: e.summary ?? e.title ?? e.text ?? '(untitled)',
      start: start ? String(start) : null,
      end: end ? String(end) : null,
      all_day: allDay,
      recurrence: null,  // a recurring CLI series is expected to arrive pre-expanded per occurrence
      location: e.location ?? null,
      description: e.description ?? e.details ?? null,
      status: String(e.status ?? '').toLowerCase() === 'cancelled' ? 'cancelled' : 'confirmed',
      last_modified: e.last_modified ?? e.updated ?? e.lastModified ?? null,
    });
  }
  return out;
}

/** Default runner: run a shell command, resolve { code, stdout, stderr }. */
function defaultCliRunner(command, { timeoutMs = CLI_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    exec(command, { timeout: timeoutMs, maxBuffer: CLI_MAX_BUFFER, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '', failed: !!err });
    });
  });
}

/**
 * Run a ward-configured calendar command and shape its output for the sync
 * loop. Never throws — a missing binary, an auth failure (non-zero exit), or
 * empty output all degrade to ok:false so the loop skips and NEVER
 * reconciles deletions on a blip.
 *
 * @param {object} p
 * @param {string} p.command   the full command line to run
 * @param {'ics'|'json'} [p.format='ics']
 * @param {Function} [p.runner] injectable (tests); default spawns via exec
 */
export async function fetchViaCli({ command, format = 'ics', runner = defaultCliRunner } = {}) {
  const cmd = typeof command === 'string' ? command.trim() : '';
  if (!cmd) return { ok: false, error: 'no calendar command configured' };
  let res;
  try {
    res = await runner(cmd);
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
  if (!res || res.failed || res.code !== 0) {
    const tail = (res?.stderr || '').trim().split('\n').slice(-1)[0] || `exit ${res?.code ?? '??'}`;
    return { ok: false, error: `calendar command failed: ${tail}` };
  }
  const stdout = res.stdout ?? '';
  if (format === 'json') {
    let parsed;
    try { parsed = JSON.parse(stdout); }
    catch { return { ok: false, error: 'calendar command did not emit valid JSON' }; }
    const events = normalizeCliEvents(parsed);
    // An authenticated read is windowed → never reconcile deletes.
    return { ok: true, events, reconcileDeletes: false };
  }
  // Default: treat stdout as an `.ics` feed (reuses Unruh's parser).
  if (!/BEGIN:VCALENDAR/i.test(stdout)) {
    return { ok: false, error: 'calendar command did not emit an iCalendar feed' };
  }
  return { ok: true, icsText: stdout, reconcileDeletes: false };
}

// ── Write-back (the only path that mutates the real calendar, §6/§7-5) ──
//
// The Familiar pushes a Proto-Familiar schedule node TO Google by importing
// its generated `.ics` through the same authenticated CLI. We reuse the
// export `.ics` (icalwrite) rather than constructing per-field CLI args —
// code generates the calendar artifact, never the model (§3) — and we only
// ADD (never edit an existing Google event, §8). Explicit + confirmed: it's
// gated behind a ward setting, and the Familiar confirms before calling.

const WRITE_PRESETS = {
  // {file} is replaced with the path to the generated .ics; appended if absent.
  gogcli:  'gogcli calendar import {file}',
  gcalcli: 'gcalcli import {file}',
};

export function writePresetCommand(source) { return WRITE_PRESETS[source] ?? ''; }

/** Resolve the write/import command: the ward's override, else the preset. */
export function resolveWriteCommand({ source, override } = {}) {
  const o = typeof override === 'string' ? override.trim() : '';
  return o || writePresetCommand(source) || '';
}

/**
 * Import an `.ics` into the real calendar via the ward's configured command.
 * Writes the bytes to a temp file, substitutes {file} (or appends the path),
 * runs the command, and always cleans up the temp file. Never throws —
 * returns { ok } / { ok:false, error }. This is the one place Proto-Familiar
 * changes the ward's actual Google calendar.
 *
 * @param {object} p
 * @param {string} p.icsText  the generated calendar artifact (from icalwrite)
 * @param {string} p.command  the import command ({file} placeholder optional)
 * @param {Function} [p.runner] injectable (tests); default spawns via exec
 */
export async function pushIcsViaCli({ icsText, command, runner = defaultCliRunner } = {}) {
  const cmd = typeof command === 'string' ? command.trim() : '';
  if (!cmd) return { ok: false, error: 'no calendar write command configured' };
  if (!icsText || !/BEGIN:VCALENDAR/i.test(icsText)) return { ok: false, error: 'nothing valid to import' };

  let tmpFile = '';
  try {
    tmpFile = path.join(os.tmpdir(), `pf-gcal-${process.pid}-${Date.now()}.ics`);
    await fsp.writeFile(tmpFile, icsText, 'utf8');
    const full = cmd.includes('{file}') ? cmd.replaceAll('{file}', tmpFile) : `${cmd} ${tmpFile}`;
    const res = await runner(full);
    if (!res || res.failed || res.code !== 0) {
      const tail = (res?.stderr || '').trim().split('\n').slice(-1)[0] || `exit ${res?.code ?? '??'}`;
      return { ok: false, error: `calendar import failed: ${tail}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  } finally {
    if (tmpFile) { try { await fsp.unlink(tmpFile); } catch { /* best-effort cleanup */ } }
  }
}

/**
 * Probe whether a ward-configured command is runnable at all (installed +
 * on PATH). Used for the "is the CLI there?" status surface — a non-zero
 * exit or a throw means "not available / not set up". Best-effort; the real
 * authed read is fetchViaCli.
 */
export async function detectCli({ command, runner = defaultCliRunner } = {}) {
  const cmd = typeof command === 'string' ? command.trim() : '';
  if (!cmd) return { ok: true, available: false, reason: 'no command configured' };
  // Probe with the configured command's first token + a benign --version /
  // --help so we don't trigger a full calendar read just to check presence.
  const bin = cmd.split(/\s+/)[0];
  try {
    const res = await runner(`${bin} --version`);
    if (res && !res.failed && res.code === 0) return { ok: true, available: true };
    const res2 = await runner(`${bin} --help`);
    return { ok: true, available: !!(res2 && !res2.failed && res2.code === 0), reason: res2?.stderr?.trim()?.split('\n').slice(-1)[0] };
  } catch (err) {
    return { ok: true, available: false, reason: err?.message ?? String(err) };
  }
}
