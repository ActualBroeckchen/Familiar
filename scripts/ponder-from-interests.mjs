#!/usr/bin/env node
/**
 * Step 2 of the caring spine.
 *
 *   1. Connect to Unruh.
 *   2. Pull the live interest weights.
 *   3. Pick one with weight-proportional sampling (high weight wins
 *      more often, never deterministic).
 *   4. Ponder it via ponderOnce — writes a real entry to the
 *      Familiar's Ponderings tome.
 *
 * If the interest layer is empty, exits without inventing a topic.
 * The whole point of step 2 is that the topic comes from real,
 * accrued interest — not from a hand-picked prompt.
 *
 *   TEMP_KEY=sk-... node scripts/ponder-from-interests.mjs [--model "..."]
 */
import { withUnruh, parseToolText } from './_unruh-mcp.mjs';
import { pickInterest }             from '../interest-picker.js';
import { ponderOnce }               from '../pondering.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if      (argv[i] === '--model' && argv[i + 1]) args.model = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: TEMP_KEY=... node scripts/ponder-from-interests.mjs [--model "..."]');
      process.exit(0);
    }
  }
  return args;
}

const args   = parseArgs(process.argv.slice(2));
const model  = args.model ?? 'google/gemma-4-31b-it';
const apiKey = process.env.TEMP_KEY;
if (!apiKey) { console.error('TEMP_KEY env var is not set. Aborting.'); process.exit(1); }

console.log('─'.repeat(60));
console.log('Step 2: ponder from Unruh interest weights');
console.log('─'.repeat(60));

let live;
try {
  live = await withUnruh(async (client) => {
    const result  = await client.callTool({
      name: 'interest_list',
      arguments: { limit: 20, include_standing: false },
    });
    const payload = parseToolText(result, {});
    return Array.isArray(payload.live) ? payload.live : [];
  });
} catch (err) {
  console.error('Could not reach Unruh:', err.message);
  process.exit(1);
}

console.log(`\n[picker] live interests from Unruh: ${live.length}`);
for (const i of live.slice(0, 10)) {
  const tier = i.tier ?? '?';
  console.log(`  • ${i.label.padEnd(56)} weight ${Number(i.weight).toFixed(2).padStart(6)}  (${tier})`);
}
if (live.length === 0) {
  console.log('\nNo live interests to ponder yet. Seed some first:');
  console.log('    node scripts/seed-test-interests.mjs');
  process.exit(0);
}

const picked = pickInterest(live);
console.log(`\n[picker] picked: "${picked.label}"  (weight ${Number(picked.weight).toFixed(2)})`);
console.log(`[ponder] model:  ${model}  (via nanogpt)\n...`);

try {
  const t0      = Date.now();
  const result  = await ponderOnce({
    topic:    picked.label,
    provider: 'nanogpt',
    apiKey,
    model,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n✓ pondering complete (${elapsed}s)\n`);
  console.log(`Title:     ${result.title}`);
  console.log(`Tome file: ${result.tomeFile}`);
  console.log(`Entry uid: ${result.uid}`);
  console.log('\n── the thought ──────────────────────────────────────────────');
  console.log(result.content);
  console.log('─────────────────────────────────────────────────────────────');
} catch (err) {
  console.error('\n✗ pondering failed:', err.message);
  process.exit(1);
}
