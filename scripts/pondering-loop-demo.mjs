#!/usr/bin/env node
/**
 * Step 4a demo: the autonomous pondering loop, in fast-forward.
 *
 *   TEMP_KEY=sk-... node scripts/pondering-loop-demo.mjs \
 *      [--seconds N] [--tick MS] [--required-ms MS] [--model "..."]
 *
 * The production cadence (computeRequiredInterval) is in tens of
 * minutes — far too slow for a single sitting. This demo overrides
 * the cadence with a short required interval so you can watch
 * several autonomous ponders happen in ~a minute. The picker, tier
 * logic, MCP wiring, and ponderOnce path are exactly what production
 * uses — only the cadence is sped up.
 *
 *   --seconds      how long to let the loop run    (default 75)
 *   --tick         how often the loop checks      (default 8000 ms)
 *   --required-ms  cooldown between ponders       (default 20000 ms)
 *   --model        nanogpt model                  (default gemma-4-31b-it)
 */

import { withUnruh, parseToolText }     from './_unruh-mcp.mjs';
import { ponderOnce }                    from '../pondering.js';
import { startPonderingLoop,
         stopPonderingLoop }             from '../pondering-loop.js';
import { tierForWeight }                 from '../pondering-cadence.js';

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if      (k === '--seconds'     && v) { a.seconds     = parseInt(v, 10); i++; }
    else if (k === '--tick'        && v) { a.tickMs      = parseInt(v, 10); i++; }
    else if (k === '--required-ms' && v) { a.requiredMs  = parseInt(v, 10); i++; }
    else if (k === '--model'       && v) { a.model       = v;               i++; }
    else if (k === '--help' || k === '-h') {
      console.log('Usage: TEMP_KEY=... node scripts/pondering-loop-demo.mjs [--seconds N] [--tick MS] [--required-ms MS] [--model "..."]');
      process.exit(0);
    }
  }
  return a;
}

const args        = parseArgs(process.argv.slice(2));
const seconds     = Number.isFinite(args.seconds)    && args.seconds    > 0 ? args.seconds    : 75;
const tickMs      = Number.isFinite(args.tickMs)     && args.tickMs     > 0 ? args.tickMs     : 8_000;
const requiredMs  = Number.isFinite(args.requiredMs) && args.requiredMs > 0 ? args.requiredMs : 20_000;
const model       = args.model ?? 'google/gemma-4-31b-it';
const apiKey      = process.env.TEMP_KEY;
if (!apiKey) { console.error('TEMP_KEY env var is not set. Aborting.'); process.exit(1); }

console.log('─'.repeat(60));
console.log('Step 4a demo: autonomous pondering loop (fast-forward)');
console.log('─'.repeat(60));
console.log(`  duration   : ${seconds}s`);
console.log(`  tick every : ${tickMs}ms (how often the loop wakes to ask "is it time?")`);
console.log(`  cooldown   : ${requiredMs}ms (DEMO override; prod uses ${'30-360 min'} tiers)`);
console.log(`  model      : ${model} (via nanogpt)`);
console.log('─'.repeat(60));

await withUnruh(async (client) => {
  // Verify there are interests to ponder over before we start the loop.
  const probe = await client.callTool({
    name: 'interest_list',
    arguments: { limit: 20, include_standing: false },
  });
  const live = parseToolText(probe, {}).live ?? [];
  if (live.length === 0) {
    console.log('\nNo live interests in Unruh. Seed first:');
    console.log('  node scripts/seed-test-interests.mjs');
    return;
  }
  console.log(`\n[boot] ${live.length} live interests in Unruh; top weight ${Math.max(...live.map(i => i.weight)).toFixed(2)}`);
  console.log(`[boot] loop starting…\n`);

  let acted = 0, skipped = 0, started = Date.now();

  const getInterests = async () => {
    const r = await client.callTool({
      name: 'interest_list',
      arguments: { limit: 20, include_standing: false },
    });
    return parseToolText(r, {}).live ?? [];
  };

  const runPonder = (topic) => ponderOnce({ topic, provider: 'nanogpt', apiKey, model });

  startPonderingLoop({
    tickMs,
    getInterests,
    runPonder,
    computeInterval: () => requiredMs,   // override for the demo
    onTick: (r) => {
      const t = ((Date.now() - started) / 1000).toFixed(1).padStart(5);
      if (r.acted) {
        acted++;
        const tier = tierForWeight(r.topWeight);
        console.log(`[+${t}s] PONDERED  "${r.picked.label}" (weight ${r.picked.weight.toFixed(2)}, tier ${tier})`);
        console.log(`         → "${r.result.title}"  (uid ${r.result.uid.slice(0, 8)})`);
      } else {
        skipped++;
        const detail =
          r.reason === 'too_soon'
            ? `(${(r.sinceMs/1000).toFixed(0)}s waited, ${(r.requiredMs/1000).toFixed(0)}s required, top weight ${r.topWeight?.toFixed(2)})`
            : '';
        console.log(`[+${t}s] skip      ${r.reason} ${detail}`);
      }
    },
    onError: (err) => {
      console.error(`[err] ${err.message}`);
    },
  });

  await new Promise(r => setTimeout(r, seconds * 1000));
  await stopPonderingLoop();

  console.log(`\n[done] ran for ${seconds}s — ponders: ${acted}, skips: ${skipped}`);
  console.log('       open the Ponderings tome to read what landed.');
});
