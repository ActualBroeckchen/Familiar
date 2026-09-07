/**
 * Reminders scheduler (M11).
 *
 * Walks the schedule layer every tick looking for reminder nodes
 * whose when_ts has arrived and that haven't been resolved. For each
 * one: enqueue an outbox item (idempotent on the schedule node id)
 * and mark the node 'fired'. The "enqueue first, mark fired second"
 * order is deliberate — if either step fails, the reminder is fired
 * AGAIN next tick rather than dropped silently. The outbox dedups
 * on originId so my human doesn't see double-banners.
 *
 * Why setInterval (not cron / apscheduler / OS timers): we already
 * have the pondering-loop pattern in this codebase, it has a
 * reentrancy guard, it shuts down cleanly on SIGTERM, and adding a
 * second loop alongside is zero new dependencies. The "spike"
 * conclusion from the M11 plan: Node setInterval wins for v1. If
 * later we need second-precision OR cross-restart guarantees we can
 * swap in OS timers without changing the API.
 *
 * Health: each tick checks reminders_health and logs a warning if
 * `overdue` climbs across consecutive ticks. That's the loud-not-
 * silent failure mode the design doc called for.
 */

import { enqueueOutbox } from '../../outbox.js';

const DEFAULT_TICK_MS = 30_000;  // 30s — sub-minute precision without
                                  // the constant churn of every-second.

let _started      = false;
let _interval     = null;
let _activeTick   = null;
let _lastOverdue  = null;
let _consecutiveOverdueGrowth = 0;

/**
 * Run one reminders tick. Pure-ish — getDueReminders / fireReminder
 * are injected so tests can drive every branch.
 *
 * Also carries the event lead-time alert pass ("coming up: …" pings for
 * type='event' nodes) when the optional getDueEventAlerts /
 * markEventAlerted pair is provided — same tick, same enqueue-then-mark
 * discipline, no second timer.
 *
 * Returns { fired: [...], skipped: [...], alerted: [...] } for
 * observability.
 */
/**
 * One alert stream — enqueue first, mark second, exactly like reminders: a
 * failed mark re-alerts next tick and the outbox dedup (originId = prefix +
 * node id + occurrence) absorbs the retry. Shared by the coming-up and the
 * severe-weather passes so the two never drift apart. `mark` gets `kind` so the
 * durable stamp lands in the right dedup channel. Returns the delivered alerts.
 */
async function runAlertStream({ getDue, mark, outboxKind, originPrefix, markKind, enqueueOutboxFn, now, skipped }) {
  const delivered = [];
  if (typeof getDue !== 'function' || typeof mark !== 'function') return delivered;
  let dueAlerts = [];
  try { dueAlerts = (await getDue()) || []; }
  catch (err) { skipped.push({ id: `(${originPrefix}-scan)`, error: err?.message ?? String(err) }); return delivered; }
  for (const a of dueAlerts) {
    try {
      await enqueueOutboxFn({
        kind:     outboxKind,
        originId: `${originPrefix}:${a.id}:${a.occurrenceDate ?? 'once'}`,
        title:    a.title,
        body:     a.body,
        ts:       new Date(now()).toISOString(),
      });
      await mark({ id: a.id, occurrenceDate: a.occurrenceDate ?? null, kind: markKind });
      delivered.push(a);
    } catch (err) {
      skipped.push({ id: a.id, label: a.label, error: err?.message ?? String(err) });
    }
  }
  return delivered;
}

export async function runOneReminderTick({
  getDueReminders,
  fireReminder,           // async ({id, label}) => marks resolved=fired
  getDueEventAlerts,      // optional: async () => [{id,label,occurrenceDate,title,body}]
  markEventAlerted,       // optional: async ({id, occurrenceDate, kind}) => durable "already pinged"
  getDueWeatherAlerts,    // optional (W-B): severe-weather heads-up for outside-tagged items
  enqueueOutboxFn = enqueueOutbox,
  now             = Date.now,
}) {
  if (typeof getDueReminders !== 'function') throw new Error('getDueReminders is required');
  if (typeof fireReminder    !== 'function') throw new Error('fireReminder is required');

  const due = await getDueReminders();
  const fired   = [];
  const skipped = [];
  for (const r of (due || [])) {
    try {
      // 1. Enqueue (idempotent on originId — safe to retry).
      const body = (r.payload && (r.payload.message || r.payload.body)) || '';
      await enqueueOutboxFn({
        kind:     'reminder',
        originId: r.id,
        title:    r.label,
        body,
        ts:       new Date(now()).toISOString(),
      });
      // 2. Mark fired. If THIS fails, we'll retry the whole
      // reminder next tick — the outbox dedups so no double-banner.
      await fireReminder({ id: r.id, label: r.label });
      fired.push(r);
    } catch (err) {
      skipped.push({ id: r.id, label: r.label, error: err?.message ?? String(err) });
    }
  }

  // Coming-up alerts and the severe-weather heads-up — both ride this tick
  // through the same enqueue-then-mark helper, into separate dedup channels.
  const alerted = await runAlertStream({
    getDue: getDueEventAlerts, mark: markEventAlerted,
    outboxKind: 'event_alert', originPrefix: 'event-alert', markKind: 'event',
    enqueueOutboxFn, now, skipped,
  });
  const weatherAlerted = await runAlertStream({
    getDue: getDueWeatherAlerts, mark: markEventAlerted,
    outboxKind: 'weather_alert', originPrefix: 'weather-alert', markKind: 'weather',
    enqueueOutboxFn, now, skipped,
  });
  return { fired, skipped, alerted, weatherAlerted };
}

/**
 * Start the reminders loop. Mirrors pondering-loop's lifecycle.
 *
 *   getDueReminders     async () => array of reminder nodes
 *   fireReminder        async ({id}) => mark schedule node resolved=fired
 *   getHealth           async () => reminders_health payload (optional;
 *                        when provided, the loop watches `overdue` and
 *                        logs a warning if it grows monotonically).
 *   tickMs              poll interval (default 30s)
 *   onTick(result)      callback after each tick
 *   onError(err)        unhandled errors land here
 *   isEnabled()         optional gate (mirrors pondering-loop)
 */
export function startRemindersLoop({
  getDueReminders,
  fireReminder,
  getDueEventAlerts,
  markEventAlerted,
  getDueWeatherAlerts,
  getHealth,
  enqueueOutboxFn = enqueueOutbox,
  tickMs    = DEFAULT_TICK_MS,
  onTick    = () => {},
  onError   = () => {},
  isEnabled = async () => true,
}) {
  if (_started) throw new Error('reminders loop already running');
  _started = true;
  _lastOverdue = null;
  _consecutiveOverdueGrowth = 0;

  const fire = async () => {
    if (_activeTick) return;
    _activeTick = (async () => {
      try {
        if (!(await isEnabled())) { onTick({ skipped: true, reason: 'disabled' }); return; }
        const result = await runOneReminderTick({ getDueReminders, fireReminder, getDueEventAlerts, markEventAlerted, getDueWeatherAlerts, enqueueOutboxFn });
        // Health check (best-effort; never blocks delivery).
        if (typeof getHealth === 'function') {
          try {
            const h = await getHealth();
            if (h?.ok !== false && Number.isFinite(h?.overdue)) {
              if (_lastOverdue != null && h.overdue > _lastOverdue) {
                _consecutiveOverdueGrowth += 1;
                if (_consecutiveOverdueGrowth >= 3) {
                  console.warn(`[reminders] overdue keeps growing (${_lastOverdue} → ${h.overdue}); scheduler may be stuck`);
                }
              } else {
                _consecutiveOverdueGrowth = 0;
              }
              _lastOverdue = h.overdue;
            }
          } catch { /* health is observability, not blocking */ }
        }
        onTick(result);
      } catch (err) {
        try { onError(err); } catch { /* swallow */ }
      } finally {
        _activeTick = null;
      }
    })();
    return _activeTick;
  };

  _interval = setInterval(() => { fire(); }, tickMs);
  _interval.unref?.();
  // Run one immediate tick so a freshly-due reminder fires within
  // seconds of boot, not seconds after the next 30s mark.
  fire();

  return { stop: stopRemindersLoop };
}

export async function stopRemindersLoop() {
  if (!_started) return;
  if (_interval) { clearInterval(_interval); _interval = null; }
  const pending = _activeTick;
  _started = false;
  _lastOverdue = null;
  _consecutiveOverdueGrowth = 0;
  if (pending) { try { await pending; } catch {} }
}
