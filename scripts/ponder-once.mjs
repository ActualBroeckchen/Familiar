#!/usr/bin/env node
/**
 * One-shot ponder runner (step 1 of the caring spine).
 *
 *   TEMP_KEY=sk-... node scripts/ponder-once.mjs --topic "what to think about"
 *
 * Flags:
 *   --topic "..."    Topic to ponder (default: an introspective topic about
 *                    the user's own experience of building this system).
 *   --model "..."    Model to use (default: gpt-4o-mini via nanogpt).
 *
 * Reads the API key from the TEMP_KEY environment variable so the key
 * never appears in argv (and so it isn't logged in shell history).
 *
 * Prints the resulting tome file path and entry, so you can open it and
 * read the actual thought.
 */

import { ponderOnce } from '../pondering.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--topic' && argv[i + 1] !== undefined) args.topic = argv[++i];
    else if (a === '--model' && argv[i + 1] !== undefined) args.model = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: TEMP_KEY=... node scripts/ponder-once.mjs [--topic "..."] [--model "..."]');
      process.exit(0);
    }
  }
  return args;
}

const args   = parseArgs(process.argv.slice(2));
const topic  = args.topic ?? "what my human is really asking for under the surface of 'help me build a proactive Familiar' — and how to honour that without becoming intrusive";
const model  = args.model ?? 'gpt-4o-mini';
const apiKey = process.env.TEMP_KEY;

if (!apiKey) {
  console.error('TEMP_KEY env var is not set. Aborting.');
  process.exit(1);
}

console.log('─'.repeat(60));
console.log('Free cycle — pondering:');
console.log(`  ${topic}`);
console.log(`Model: ${model} (via nanogpt)`);
console.log('─'.repeat(60));

try {
  const t0 = Date.now();
  const result = await ponderOnce({
    topic,
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
