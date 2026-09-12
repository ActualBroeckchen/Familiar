#!/usr/bin/env node
/**
 * Run the voice benchmark from a terminal (voice spec §0.5).
 *
 * Thin wrapper over the same `voice-bench.js` the Diagnostics button uses, so
 * a developer's run and a ward's run produce the same report from the same
 * code. Convenience only — the button is the primary surface, because the
 * people who own the target machines are wards, not developers at a prompt.
 *
 * Usage:
 *   node scripts/voice-bench.mjs
 *   node scripts/voice-bench.mjs --tier=listening-plus --voice=piper --lang=de
 *   node scripts/voice-bench.mjs --samples=20 --json
 *   node scripts/voice-bench.mjs --no-save
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { runBenchmark, saveReport } from '../src/voice/voice-bench.js';
import { composePlan, evaluatePlan, formatBytes } from '../src/voice/voice-models.js';
import { STAGE_LABELS } from '../src/voice/voice-bench-run.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name, fallback = null) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.slice(2).includes(`--${name}`);

if (flag('help') || flag('h')) {
  process.stdout.write(`Usage: node scripts/voice-bench.mjs [options]

  --tier=read-aloud|listening|listening-plus   how much of voice to measure
  --voice=pocket|piper                         which voice engine
  --lang=en[,de]                               ASR language(s)
  --samples=N                                  interference samples (default 12)
  --json                                       print the raw JSON, not the report
  --no-save                                    don't write to logs/
`);
  process.exit(0);
}

const appVersion = (() => {
  try { return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; }
  catch { return null; }
})();

const plan = composePlan({
  capabilityTier: arg('tier', undefined) ?? undefined,
  voiceEngine: arg('voice', undefined) ?? undefined,
  asrLangs: (arg('lang', 'en') || 'en').split(',').map((s) => s.trim()).filter(Boolean),
});

const ev = evaluatePlan(plan);
process.stderr.write(`Plan: ${plan.capabilityTier} / ${plan.voiceEngine} / ${plan.asrLangs.join('+')}\n`);
process.stderr.write(`On disk: ${ev.diskEstimated ? '~' : ''}${formatBytes(ev.totalDiskBytes)}${ev.withinBudget ? '' : '  ⚠ over the §0.7 ceiling'}\n`);
if (plan.unavailableLangs.length) {
  process.stderr.write(`Not available: ${plan.unavailableLangs.join(', ')} — measuring without them.\n`);
}
process.stderr.write('Run on mains power; battery changes the numbers.\n\n');

const result = await runBenchmark({
  rootDir: ROOT,
  plan,
  // No engine adapter yet (Pass 0 tail): audio stages report themselves
  // missing rather than returning zeros that look like measurements.
  engine: null,
  probe: null,
  appVersion,
  samples: Number(arg('samples', '12')) || 12,
  onStage: ({ stage, detail }) => {
    process.stderr.write(`  ${STAGE_LABELS[stage] ?? stage}${detail ? ` (${detail})` : ''}\n`);
  },
});

if (flag('json')) {
  const { markdown, ...data } = result;
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
} else {
  process.stdout.write(`\n${result.markdown}\n`);
}

if (!flag('no-save')) {
  const saved = await saveReport({ rootDir: ROOT, result });
  process.stderr.write(`\nSaved ${path.relative(ROOT, saved.mdPath)} and ${path.relative(ROOT, saved.jsonPath)}\n`);
}
