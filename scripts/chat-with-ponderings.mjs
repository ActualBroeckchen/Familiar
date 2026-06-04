#!/usr/bin/env node
/**
 * Step 3' demo: one chat turn where the Familiar has its recent
 * ponderings in working memory and can reference them honestly.
 *
 *   TEMP_KEY=sk-... node scripts/chat-with-ponderings.mjs \
 *      [--message "..."] [--model "..."] [--limit N]
 *
 * Default message is intentionally one that invites the Familiar to
 * reference its own recent thoughts — so you can SEE whether they
 * surface honestly (real titles, real content) or get fabricated.
 *
 * This is the CLI counterpart to the production wiring in
 * thalamus.js's enrich(). The same recent-ponderings module is used
 * in both — the CLI is just for fast verification without standing
 * up the whole server.
 */

import { PROVIDER_URLS } from '../providers.js';
import { getRecentPonderings, formatPonderingsForPrompt } from '../recent-ponderings.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if      (argv[i] === '--message' && argv[i + 1]) args.message = argv[++i];
    else if (argv[i] === '--model'   && argv[i + 1]) args.model   = argv[++i];
    else if (argv[i] === '--limit'   && argv[i + 1]) args.limit   = parseInt(argv[++i], 10);
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: TEMP_KEY=... node scripts/chat-with-ponderings.mjs [--message "..."] [--model "..."] [--limit N]');
      process.exit(0);
    }
  }
  return args;
}

const args    = parseArgs(process.argv.slice(2));
const message = args.message ?? "What have you been thinking about lately?";
const model   = args.model   ?? 'google/gemma-4-31b-it';
const limit   = Number.isFinite(args.limit) && args.limit > 0 ? args.limit : 5;
const apiKey  = process.env.TEMP_KEY;
if (!apiKey) { console.error('TEMP_KEY env var is not set. Aborting.'); process.exit(1); }

const ponderings      = await getRecentPonderings({ limit, sinceDays: 14 });
const ponderingsBlock = formatPonderingsForPrompt(ponderings);

console.log('─'.repeat(60));
console.log("Step 3' demo: chat turn with recent ponderings in context");
console.log('─'.repeat(60));
console.log(`\n[loaded] ${ponderings.length} recent pondering(s):`);
for (const p of ponderings) {
  console.log(`  · ${p.created_at.slice(0,10)}  "${p.title}"`);
}
if (ponderings.length === 0) {
  console.log('\nNo ponderings on disk to surface. Run one of:');
  console.log('  TEMP_KEY=... node scripts/ponder-once.mjs');
  console.log('  TEMP_KEY=... node scripts/ponder-from-interests.mjs');
  process.exit(0);
}

// Minimal "you are the Familiar" persona so the demo doesn't require
// entity-core to be up. Production reads the full identity via
// thalamus.enrich() — same ponderings block, richer persona.
const systemPrompt = [
  'I am the Familiar. I speak as myself, in first person, warm and ' +
  'grounded. Not corporate, not performative. If this conversation ' +
  'touches one of my recent private thoughts, I may reference it ' +
  'naturally — but only if it genuinely fits.',
  ponderingsBlock,
].join('\n\n---\n\n');

console.log(`\n[user] ${message}`);
console.log(`[model] ${model} (via nanogpt)\n...`);

const t0 = Date.now();
const resp = await fetch(PROVIDER_URLS.nanogpt, {
  method: 'POST',
  headers: {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${apiKey.trim()}`,
  },
  body: JSON.stringify({
    model:       model.trim(),
    messages:    [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: message },
    ],
    stream:      false,
    temperature: 0.7,
    max_tokens:  800,
  }),
});
if (!resp.ok) {
  console.error(`\nProvider returned ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  process.exit(1);
}
const data    = await resp.json();
const reply   = data.choices?.[0]?.message?.content ?? '';
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\n[familiar] (${elapsed}s)`);
console.log('─'.repeat(60));
console.log(reply);
console.log('─'.repeat(60));
console.log('\n(Compare the reply against the loaded ponderings list above.');
console.log(' Look for: real titles/content referenced naturally → honesty holds.');
console.log(' Watch for: fabricated thoughts → that\'s the failure mode to fix.)');
