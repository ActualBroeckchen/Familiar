#!/usr/bin/env node
/**
 * Seed the Unruh interest layer with a handful of realistic test
 * topics so the ponder-from-interests demo has something to pick.
 *
 * Uses the live MCP path (interest_record) — same call the chat
 * loop uses to accrue weight from real conversation. Re-running
 * this is safe; it just adds more bumps (which is what would
 * happen in real life if the topics kept coming up).
 *
 *   node scripts/seed-test-interests.mjs
 *
 * After seeding, the topics will be returned by interest_list with
 * the bumped weights (subject to Unruh's gentle decay over time).
 */
import { withUnruh } from './_unruh-mcp.mjs';

// [topic label, weight delta, source tag]
// Weights chosen so the distribution is interesting: one clear
// favourite, a middle band, and a quieter long tail.
const SEEDS = [
  ['proactive care vs surveillance — where the line is',  8.0, 'pondering'],
  ["the user's experience of building me",                6.5, 'chat'],
  ['owl feather aerodynamics & biomimetic engineering',   4.0, 'chat'],
  ['how to honour the honesty rule as memory grows',      3.0, 'chat'],
  ['the difference between presence and intrusion',       2.0, 'chat'],
];

await withUnruh(async (client) => {
  console.log(`Seeding ${SEEDS.length} test interests into Unruh...\n`);
  for (const [topic, weight, source] of SEEDS) {
    await client.callTool({
      name: 'interest_record',
      arguments: { topic, delta: weight, source },
    });
    console.log(`  + ${topic.padEnd(56)} +${weight}  (${source})`);
  }
  console.log('\nDone. Try:');
  console.log('  TEMP_KEY=... node scripts/ponder-from-interests.mjs');
});
