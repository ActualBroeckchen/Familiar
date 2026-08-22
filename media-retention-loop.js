/**
 * media-retention-loop.js — the singleton driver for voice-clip curation (§9).
 *
 * Thin wrapper around media-retention.js's runMediaRetention: paces a slow tick
 * and applies the standard background-loop contract — never overlaps, defers
 * during a live call and at moderate+ threat (triage owns the moment), unrefs
 * its timer, never throws.
 *
 * DEFAULT ON — the ward asked for curation as the default (spec review 2). The
 * transcript always survives; this only decides whether the SOUND is kept, so
 * the downside of a wrong "let go" is disk saved, not memory lost. Hard
 * off-switch PROTO_FAMILIAR_MEDIA_RETENTION_DISABLED=1 + the `mediaRetentionEnabled`
 * Settings toggle. This is Pass 4's new (thirteenth) background worker.
 */

import { isCallActiveFromFile } from './call-engine.js';
import { readSettingsSync } from './cerebellum.js';
import { getThreat } from './threat-tracker.js';
import { runMediaRetention } from './media-retention.js';

const DEFAULT_TICK_MS = 6 * 60 * 60_000;   // ~daily-ish (6 h); aged audio is in no hurry
const STAND_DOWN_TIERS = new Set(['moderate', 'high', 'severe']);

let _started = false;
let _interval = null;
let _active = null;

function hardDisabled() {
  return process.env.PROTO_FAMILIAR_MEDIA_RETENTION_DISABLED === '1';
}

function isEnabled(settings = readSettingsSync()) {
  if (hardDisabled()) return false;
  return settings?.mediaRetentionEnabled !== false;   // default ON
}

export async function runTick({ threat = getThreat, callActive = isCallActiveFromFile } = {}) {
  const settings = readSettingsSync() || {};
  if (!isEnabled(settings)) return { reason: 'disabled' };
  // Governor: never curate mid-call (§4.3) or during a crisis moment.
  if (await callActive().catch(() => false)) return { reason: 'call-active' };
  const t = await threat().catch(() => null);
  if (t && STAND_DOWN_TIERS.has(t.tier)) return { reason: 'stood-down', tier: t.tier };

  const summary = await runMediaRetention({ settings });
  if (summary.considered) {
    console.log(`[media-retention] considered ${summary.considered}, kept ${summary.kept}, let go ${summary.stripped}`);
  }
  return summary;
}

export function startMediaRetentionLoop({ tickMs = DEFAULT_TICK_MS } = {}) {
  if (_started) return { stop: stopMediaRetentionLoop };
  if (hardDisabled()) {
    console.log('[media-retention] hard-disabled via PROTO_FAMILIAR_MEDIA_RETENTION_DISABLED=1');
    return { stop: () => {} };
  }
  _started = true;
  console.log('[media-retention] voice-clip curation loop armed (default on; keeps the words, curates the sound)');
  _interval = setInterval(() => {
    if (_active) return;
    _active = runTick()
      .catch(err => console.warn('[media-retention] tick error:', err?.message ?? err))
      .finally(() => { _active = null; });
  }, tickMs);
  _interval.unref?.();
  return { stop: stopMediaRetentionLoop };
}

export async function stopMediaRetentionLoop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  if (_active) { try { await _active; } catch { /* already logged */ } }
  _started = false;
}
