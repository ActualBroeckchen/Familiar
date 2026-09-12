/**
 * Event lead-time alerts — the timeblindness feature.
 *
 * Reminders only ever fired `type='reminder'` nodes, while calendar sync
 * creates `type='event'` nodes — so no synced appointment ever produced a
 * proactive ping. The only surfaces an event had were passive (the chat
 * briefing, the Map), which is exactly what a timeblind human can't lean
 * on: those require *noticing time* and opening the app. This module gives
 * every unresolved event an automatic "coming up" alert a configurable
 * lead time before it starts, riding the reminders loop's existing 30s
 * tick (no new timer, no LLM call — pure code gates, CLAUDE.md "gate in
 * code").
 *
 * Selection is pure (this file, unit-testable); durable "already alerted"
 * state lives ON the schedule node's payload in Unruh (`alerted_at` for
 * one-time events, `alerts[YYYY-MM-DD]` per occurrence for recurring
 * ones), written via the atomic schedule_mark_alerted tool so a re-tick
 * can't double-ping and a restart can't forget.
 *
 * All-day events are excluded: their when_ts is midnight, so a lead-time
 * ping would land in the middle of the night — the chat briefing and the
 * Map remain their surface.
 */

import { expandOccurrences, localDateKey } from './recurrence.js';
import { relativeTime } from '../../relative-time.js';
import { forecastAtHour, isAdverseHour, formatItemWeather } from '../weather/weather-format.js';

// How long past its start an event may still alert (covers a server that
// was asleep when the lead window opened). Past this, the moment is gone
// and a stale "coming up" would be noise.
export const ALERT_GRACE_MS = 15 * 60_000;

export const DEFAULT_LEAD_MINUTES = 60;
const MIN_LEAD_MINUTES = 5;
const MAX_LEAD_MINUTES = 24 * 60;

export const MAX_LEAD_MS = MAX_LEAD_MINUTES * 60_000;

export function clampLeadMinutes(mins) {
  const n = Number(mins);
  if (!Number.isFinite(n)) return DEFAULT_LEAD_MINUTES;
  return Math.max(MIN_LEAD_MINUTES, Math.min(MAX_LEAD_MINUTES, Math.round(n)));
}

// Elapsed stamping (causal-chain fix piece 4, ward-signed): how long past an
// event's end before it's stamped "came and went without a word". Ward-
// configurable (default 24h after event end, per the ward's decision);
// clamped [1h, 30d]. Unruh clamps to the same range as a belt-and-suspenders.
export const DEFAULT_ELAPSED_STAMP_HOURS = 24;
const MIN_ELAPSED_STAMP_HOURS = 1;
const MAX_ELAPSED_STAMP_HOURS = 720;

export function clampElapsedStampHours(hours) {
  const n = Number(hours);
  if (!Number.isFinite(n)) return DEFAULT_ELAPSED_STAMP_HOURS;
  return Math.max(MIN_ELAPSED_STAMP_HOURS, Math.min(MAX_ELAPSED_STAMP_HOURS, Math.round(n)));
}

// Per-event lead (Initiative Pass 5): a node carrying payload.lead_minutes
// overrides the global default; anything else falls back to it. Clamped to
// the same [5min, 24h] range. This is what turns the one-size-fits-none
// global lead into a per-event choice the Familiar can set and calibrate.
export function effectiveLeadMs(node, defaultLeadMs) {
  const raw = node?.payload?.lead_minutes;
  if (raw == null) return defaultLeadMs;
  return clampLeadMinutes(raw) * 60_000;
}

// FRAME CONTRACT: every millisecond value in this module lives in ONE
// consistent frame — "the ward's wall clock, parsed as server-local".
// Stored when_ts is ward-local naive; `new Date(naive)` interprets it in
// the server zone. The caller passes `nowMs` built the same way
// (new Date(wardLocalNowISO(tz)).getTime()), so DIFFERENCES between the
// two are correct even when the server runs in a different zone — the
// same discipline the reminders scheduler uses, in epoch form because
// recurrence expansion needs arithmetic. Rendering back to wall-clock
// text therefore uses local getters, never toISOString().
function whenMsOf(node) {
  const t = new Date(node?.when ?? '').getTime();
  return Number.isFinite(t) ? t : null;
}

function localNaiveIso(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function inAlertWindow(whenMs, nowMs, leadMs, graceMs) {
  return whenMs - leadMs <= nowMs && nowMs <= whenMs + graceMs;
}

/** The ward-local-naive ISO bounds the schedule-window fetch should cover
 *  for one alert scan (grace behind now, lead ahead of it). */
export function alertWindowBounds({ nowMs, leadMs, graceMs = ALERT_GRACE_MS }) {
  return { fromIso: localNaiveIso(nowMs - graceMs), toIso: localNaiveIso(nowMs + leadMs) };
}

/**
 * Choose the event occurrences due for a "coming up" alert. Pure.
 *
 * @param {object} p
 * @param {Array}  p.windowNodes     schedule nodes whose stored when_ts falls
 *                                   near now (getScheduleWindow output)
 * @param {Array}  p.recurringNodes  recurring anchors (listRecurring output);
 *                                   occurrences are expanded here
 * @param {number} p.nowMs
 * @param {number} p.leadMs
 * @param {number} [p.graceMs]
 * @returns {Array<{id,label,whenMs,whenIso,occurrenceDate}>}
 *          occurrenceDate is null for one-time events, YYYY-MM-DD for a
 *          recurring occurrence (the payload.alerts key).
 */
export function selectDueEventAlerts({ windowNodes, recurringNodes, nowMs, leadMs, defaultLeadMs, maxLeadMs = MAX_LEAD_MS, graceMs = ALERT_GRACE_MS }) {
  // Back-compat: callers used to pass a single `leadMs`; it's now the DEFAULT
  // lead an event uses when it carries no per-event override (Pass 5).
  const dflt = Number.isFinite(defaultLeadMs) ? defaultLeadMs : leadMs;
  const out = [];
  const seen = new Set();

  const eligible = (n) =>
    n && n.type === 'event' && !n.resolution && !(n.payload?.all_day);

  for (const n of (Array.isArray(windowNodes) ? windowNodes : [])) {
    if (!eligible(n) || n.payload?.recurrence) continue;  // anchors handled below
    if (n.payload?.alerted_at) continue;
    const whenMs = whenMsOf(n);
    const nodeLeadMs = effectiveLeadMs(n, dflt);
    if (whenMs == null || !inAlertWindow(whenMs, nowMs, nodeLeadMs, graceMs)) continue;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push({ id: n.id, label: n.label, whenMs, whenIso: n.when, occurrenceDate: null });
  }

  for (const n of (Array.isArray(recurringNodes) ? recurringNodes : [])) {
    if (!eligible(n) || !n.payload?.recurrence) continue;
    const nodeLeadMs = effectiveLeadMs(n, dflt);
    // Expand across the widest lead any event could use, so a long custom
    // lead isn't clipped; the per-occurrence inAlertWindow uses THIS node's
    // effective lead. expandOccurrences already drops per-date-resolved ones.
    const occs = expandOccurrences(n, nowMs - graceMs, nowMs + maxLeadMs);
    const alerts = n.payload?.alerts || {};
    for (const occMs of occs) {
      if (!inAlertWindow(occMs, nowMs, nodeLeadMs, graceMs)) continue;
      const dateKey = localDateKey(occMs);
      if (Object.prototype.hasOwnProperty.call(alerts, dateKey)) continue;
      const key = `${n.id}:${dateKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: n.id, label: n.label, whenMs: occMs,
        whenIso: localNaiveIso(occMs), occurrenceDate: dateKey,
      });
    }
  }

  out.sort((a, b) => a.whenMs - b.whenMs);
  return out;
}

/**
 * The banner/push text for one alert. Code-built (never the model): the
 * clock time is the stored when_ts's own HH:MM (both whenIso forms are
 * ward-local naive), the countdown is arithmetic in the shared frame.
 */
export function formatEventAlert(alert, { nowMs = Date.now() } = {}) {
  const rel = relativeTime(alert.whenMs, nowMs) || '';
  const clock = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(alert.whenIso || '') ? alert.whenIso.slice(11, 16) : '';
  const when = [rel, clock ? `at ${clock}` : ''].filter(Boolean).join(' — ');
  return {
    title: `Coming up: ${alert.label ?? '(untitled)'}`,
    body: when ? `Starts ${when}.` : '',
  };
}

/**
 * The severe-weather heads-up (W-B, §5.4). Same shape and dedup discipline as
 * the coming-up alert, but keyed on the outside-tagged item's OCCURRENCE-hour
 * forecast turning adverse. Selection is pure: the forecast comes from the
 * read-mirror's hourly array (the CURRENT location's cache — "within lead
 * range" of an item means it's inside the ~48h the mirror covers, no fetch).
 * Weather alone (no outside item affected) never pings — this is deliberately
 * a preparation surface, not a weather report.
 */
export function selectDueWeatherAlerts({ windowNodes, recurringNodes, mirror, nowMs, leadMs, defaultLeadMs, maxLeadMs = MAX_LEAD_MS, graceMs = ALERT_GRACE_MS }) {
  if (!mirror || !Array.isArray(mirror.hourly) || !mirror.hourly.length) return [];
  const dflt = Number.isFinite(defaultLeadMs) ? defaultLeadMs : leadMs;
  const out = [];
  const seen = new Set();

  const outsideEvent = (n) =>
    n && n.type === 'event' && !n.resolution && !(n.payload?.all_day)
    && Array.isArray(n.payload?.obstacle_tags)
    && n.payload.obstacle_tags.some(t => String(t).toLowerCase() === 'outside');

  for (const n of (Array.isArray(windowNodes) ? windowNodes : [])) {
    if (!outsideEvent(n) || n.payload?.recurrence) continue;
    if (n.payload?.weather_alerted_at) continue;
    const whenMs = whenMsOf(n);
    const nodeLeadMs = effectiveLeadMs(n, dflt);
    if (whenMs == null || !inAlertWindow(whenMs, nowMs, nodeLeadMs, graceMs)) continue;
    const hour = forecastAtHour(mirror.hourly, whenMs);
    if (!hour || !isAdverseHour(hour)) continue;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push({ id: n.id, label: n.label, whenMs, whenIso: n.when, occurrenceDate: null, hour });
  }

  for (const n of (Array.isArray(recurringNodes) ? recurringNodes : [])) {
    if (!outsideEvent(n) || !n.payload?.recurrence) continue;
    const nodeLeadMs = effectiveLeadMs(n, dflt);
    const occs = expandOccurrences(n, nowMs - graceMs, nowMs + maxLeadMs);
    const wAlerts = n.payload?.weather_alerts || {};
    for (const occMs of occs) {
      if (!inAlertWindow(occMs, nowMs, nodeLeadMs, graceMs)) continue;
      const dateKey = localDateKey(occMs);
      if (Object.prototype.hasOwnProperty.call(wAlerts, dateKey)) continue;
      const hour = forecastAtHour(mirror.hourly, occMs);
      if (!hour || !isAdverseHour(hour)) continue;
      const key = `${n.id}:${dateKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: n.id, label: n.label, whenMs: occMs, whenIso: localNaiveIso(occMs), occurrenceDate: dateKey, hour });
    }
  }

  out.sort((a, b) => a.whenMs - b.whenMs);
  return out;
}

/** The banner/push text for one weather heads-up. Code-built words. */
export function formatWeatherAlert(alert, { nowMs = Date.now(), unit = 'celsius' } = {}) {
  const rel = relativeTime(alert.whenMs, nowMs) || '';
  const clock = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(alert.whenIso || '') ? alert.whenIso.slice(11, 16) : '';
  const when = [rel, clock ? `at ${clock}` : ''].filter(Boolean).join(' — ');
  const wx = formatItemWeather(alert.hour, unit) || 'rough weather then';
  return {
    title: `Weather heads-up: ${alert.label ?? '(untitled)'}`,
    body: `Outside ${when ? `${when}` : 'soon'} — ${wx}. Worth planning around while there's time.`,
  };
}
