#!/usr/bin/env node
/**
 * Fetch the audio models a plan needs — the CLI over `voice-fetch.js`.
 *
 * Thin on purpose. The pre-flight check, the checksum discipline and the
 * content-addressed store all live in the module, so this path and the
 * ward-facing button behave identically. A rule that holds only on the
 * surface a developer happens to use is not a rule.
 *
 * Usage:
 *   node scripts/ensure-audio-models.mjs                          # default plan
 *   node scripts/ensure-audio-models.mjs --tier=listening-plus --voice=piper
 *   node scripts/ensure-audio-models.mjs --lang=de,en --extras=punct
 *   node scripts/ensure-audio-models.mjs --check                  # report only
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { composePlan, formatBytes, evaluatePlan } from '../src/voice/voice-models.js';
import { fetchPlan, inspectInstalled, consentSummary, MODELS_SUBDIR } from '../src/voice/voice-fetch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = path.join(ROOT, MODELS_SUBDIR);

function arg(name, fallback = null) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const plan = composePlan({
  capabilityTier: arg('tier', undefined) ?? undefined,
  voiceEngine: arg('voice', undefined) ?? undefined,
  asrLangs: (arg('lang', 'en') || 'en').split(',').map((s) => s.trim()).filter(Boolean),
  extras: (arg('extras', '') || '').split(',').map((s) => s.trim()).filter(Boolean),
});

const ev = evaluatePlan(plan);
process.stderr.write(`Plan: ${plan.capabilityTier} / ${plan.voiceEngine} / ${plan.asrLangs.join('+')}\n`);
process.stderr.write(`Size: ${ev.estimated ? '~' : ''}${formatBytes(ev.totalBytes)}${ev.withinBudget ? '' : `  ⚠ over the §0.7 ceiling: ${JSON.stringify(ev.violations)}`}\n`);

const summary = await consentSummary({ plan, modelsDir: MODELS_DIR });
process.stderr.write(`${summary.text}\n`);
if (summary.alreadyHeldBytes > 0) {
  process.stderr.write(`Already held: ${formatBytes(summary.alreadyHeldBytes)}; still to fetch: ${formatBytes(summary.outstandingBytes)}\n`);
}

if (process.argv.includes('--check')) {
  const state = await inspectInstalled({ plan, modelsDir: MODELS_DIR, deep: process.argv.includes('--deep') });
  for (const m of state.models) {
    process.stdout.write(`${m.id.padEnd(20)} ${m.complete ? 'installed' : m.pinned ? 'not installed' : 'unpinned'}\n`);
  }
  process.exit(state.allComplete ? 0 : 1);
}

if (!summary.preflight.ok) {
  process.stderr.write(`\n${summary.preflight.message}\n`);
  if (Number.isFinite(summary.preflight.freeBytes)) {
    process.stderr.write(`Free on this drive: ${formatBytes(summary.preflight.freeBytes)}; this needs ${formatBytes(summary.outstandingBytes)} and wants ${formatBytes(summary.preflight.reserveBytes)} left over.\n`);
  }
  process.exit(1);
}

const result = await fetchPlan({
  plan,
  modelsDir: MODELS_DIR,
  onProgress: (e) => {
    if (e.phase === 'download' && e.receivedBytes) {
      process.stderr.write(`\r  ${e.label} ${e.index}/${e.total}: ${formatBytes(e.receivedBytes)}${e.totalBytes ? ` / ${formatBytes(e.totalBytes)}` : ''}   `);
    } else if (e.phase === 'verified' || e.phase === 'reused') {
      process.stderr.write(`\r  ${e.label} ${e.index}/${e.total}: ${e.phase}                    \n`);
    }
  },
});

if (!result.ok) {
  process.stderr.write(`\n${result.message ?? `Failed: ${result.reason}`}\n`);
  process.exit(1);
}
process.stdout.write(`\nInstalled ${result.installed.length} file(s).\n`);
