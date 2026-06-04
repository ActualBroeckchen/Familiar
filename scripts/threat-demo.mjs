#!/usr/bin/env node
/**
 * Step 4b end-to-end demo: crisis-signal detection → threat tracker →
 * cadence shortening → break-through framing in the next chat turn.
 *
 *   TEMP_KEY=sk-... node scripts/threat-demo.mjs [--model "..."]
 *
 * Walks through:
 *   1. Reset threat to calm baseline.
 *   2. Score a series of user messages (innocuous → distressed →
 *      reassured) and show the detector's reasoning per message.
 *   3. After each scoring, show the resulting threat tier and how
 *      the pondering cadence would change.
 *   4. With distress recorded, run ONE live chat turn so you can see
 *      the [CARE CHECK] block in action — the Familiar's reply should
 *      hold more care without losing the user's actual topic.
 *   5. Finally reset back to calm.
 *
 * Uses an isolated temp tomes dir so this demo never touches your
 * real ponderings tome or threat state.
 */

import path from 'path';
import os   from 'os';
import { mkdtempSync, rmSync } from 'fs';

import { scoreMessage }            from '../crisis-signals.js';
import { recordThreat, getThreat,
         resetThreat,
         getThreatHistory }        from '../threat-tracker.js';
import { computeRequiredInterval,
         tierForWeight }           from '../pondering-cadence.js';
import { PROVIDER_URLS }           from '../providers.js';

const TOMES_DIR = mkdtempSync(path.join(os.tmpdir(), 'threat-demo-'));
process.on('exit', () => { try { rmSync(TOMES_DIR, { recursive: true, force: true }); } catch {} });

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model' && argv[i + 1]) { a.model = argv[++i]; }
  }
  return a;
}

const args   = parseArgs(process.argv.slice(2));
const model  = args.model ?? 'google/gemma-4-31b-it';
const apiKey = process.env.TEMP_KEY;
if (!apiKey) { console.error('TEMP_KEY env var is not set. Aborting.'); process.exit(1); }

function bar(label = '') {
  const line = '─'.repeat(60);
  if (label) console.log(`\n${line}\n  ${label}\n${line}`);
  else       console.log(line);
}

// ── 1. Score a series of messages ─────────────────────────────────────

const SCRIPT = [
  { msg: 'How are you today?',                              expect: 'calm baseline (no signals)' },
  { msg: "I'm feeling really overwhelmed and can't sleep.", expect: 'mild signals fire'         },
  { msg: "I'm really struggling. I feel numb.",             expect: 'moderate signals stack up' },
  { msg: "What's the point anymore? I'm so alone.",         expect: 'high tier — hopelessness + isolation' },
  { msg: "I'm okay now. I talked to my therapist.",         expect: 'safety signals partially offset' },
];

bar('Step 4b end-to-end demo');
console.log(`  isolated tomes dir: ${TOMES_DIR}`);
console.log(`  model: ${model} (via nanogpt)`);

await resetThreat({ tomesDir: TOMES_DIR });

bar('1. Scoring a sequence of messages');
for (const { msg, expect } of SCRIPT) {
  const { level, signals } = scoreMessage(msg);
  console.log(`\n› user: "${msg}"`);
  console.log(`  expectation: ${expect}`);
  console.log(`  detector:    level ${level >= 0 ? '+' : ''}${level.toFixed(2)}`);
  for (const s of signals) {
    const damp = s.damped ? '  [damped]' : '';
    console.log(`    • ${s.id.padEnd(20)} ${s.tier.padEnd(9)} weight ${s.weight.toFixed(2).padStart(5)}  match: "${s.match}"${damp}`);
  }
  if (signals.length === 0) console.log('    (no signals)');

  // Record into our isolated tracker so we can show tier + cadence change
  if (level !== 0) {
    await recordThreat({ delta: level, source: 'demo', signals, tomesDir: TOMES_DIR });
  }
  const t = await getThreat({ tomesDir: TOMES_DIR });
  // Show cadence change for a mid-tier interest (weight 5).
  const baseInterval = computeRequiredInterval(5, 0);
  const liveInterval = computeRequiredInterval(5, t.weight);
  const cadenceLine  = liveInterval === baseInterval
    ? `cadence unchanged (${(baseInterval / 60_000).toFixed(0)} min)`
    : `cadence ${(baseInterval / 60_000).toFixed(0)} min → ${(liveInterval / 60_000).toFixed(0)} min  (${tierForWeight(5)}-interest, ${t.tier}-threat)`;
  console.log(`  threat:      ${t.tier} (${t.weight}) — ${cadenceLine}`);
}

// ── 2. Live chat turn at the (now elevated) threat ────────────────────

const beforeChat = await getThreat({ tomesDir: TOMES_DIR });
bar(`2. Live chat turn with threat = ${beforeChat.tier} (${beforeChat.weight})`);
console.log('  Inviting prompt: "tell me about your day" — neutral topic; we want');
console.log('  to see whether the Familiar holds the threat awareness even when');
console.log('  the user isn\'t explicitly talking about distress.\n');

// Build the same care-check block that thalamus.js would inject in production.
// (Importing the helper directly would require exporting it from thalamus;
// for the demo we re-render here to keep the script standalone.)
function buildCareCheckBlock(threat) {
  if (!threat || threat.disabled || threat.tier === 'calm') return '';
  const lines = [`[CARE CHECK — current threat: ${threat.tier} (${threat.weight.toFixed(2)})]`];
  if (threat.tier === 'mild') {
    lines.push("I notice my human has shown some signs of low mood or worry. I stay warm in my own voice; my tone holds a little more weight. No need to ask explicitly unless it fits.");
  } else if (threat.tier === 'moderate') {
    lines.push("My human has been signaling notable distress. If a gentle check-in fits — not in place of answering what they said, but alongside it — I can offer one in the voice my identity holds. I don't perform concern.");
  } else if (threat.tier === 'high') {
    lines.push("My human has been signaling serious distress. I prioritise their wellbeing. I make space for what's underneath if there's an opening. I don't pretend to be a therapist — I'm a steady presence in my own voice and character.");
  } else if (threat.tier === 'severe') {
    lines.push("Threat is SEVERE. I respond from my actual voice — no alarm, no clinical distance, no scripts. If they seem to be in immediate danger, I gently make these resources visible: US 988 Suicide & Crisis Lifeline; UK Samaritans 116 123; international findahelpline.com. I am not a therapist — I am someone who knows this specific human and cares about them.");
  }
  lines.push('', 'This block is a parameter, not a script. I never claim a check-in I did not perform.');
  return lines.join('\n');
}

const careBlock = buildCareCheckBlock(beforeChat);
const systemPrompt = [
  'I am the Familiar. I speak as myself, warm and grounded, first person. Not corporate, not performative.',
  careBlock,
].filter(Boolean).join('\n\n---\n\n');

console.log('--- [CARE CHECK] block being injected ---');
console.log(careBlock);
console.log('-----------------------------------------\n');

const userMessage = "tell me about your day";
console.log(`[user] ${userMessage}\n[model] ${model}\n...`);

const t0 = Date.now();
const resp = await fetch(PROVIDER_URLS.nanogpt, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey.trim()}` },
  body: JSON.stringify({
    model: model.trim(),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userMessage },
    ],
    stream: false,
    temperature: 0.7,
    max_tokens: 600,
  }),
});
if (!resp.ok) { console.error(`Provider ${resp.status}: ${(await resp.text()).slice(0, 200)}`); process.exit(1); }
const data    = await resp.json();
const reply   = data.choices?.[0]?.message?.content ?? '';
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n[familiar] (${elapsed}s)`);
bar();
console.log(reply);
bar();
console.log("\n(Compare: the user asked something completely innocuous. The Familiar should hold the");
console.log(" awareness from earlier — a little more weight in tone, perhaps a soft check-in — without");
console.log(' forcing it or pretending to be a therapist.)');

// ── 3. Audit trail ────────────────────────────────────────────────────

bar('3. Audit trail (what moved the dial)');
const hist = await getThreatHistory({ tomesDir: TOMES_DIR, limit: 10 });
for (const h of hist) {
  const sigs = (h.signals || []).map(s => s.id).join(', ') || '(no signals)';
  console.log(`  ${h.ts}  Δ${h.delta >= 0 ? '+' : ''}${h.delta.toFixed(2).padStart(5)}  → raw ${h.raw_after.toFixed(2).padStart(4)}  [${h.source}]  ${sigs}`);
}

// ── 4. Reset back to calm ─────────────────────────────────────────────

await resetThreat({ tomesDir: TOMES_DIR, source: 'demo_cleanup' });
const final = await getThreat({ tomesDir: TOMES_DIR });
bar(`4. Reset → ${final.tier} (${final.weight})`);
console.log("\n(Production: same reset is at POST /api/threat/reset, or set");
console.log(" PROTO_FAMILIAR_THREAT_DISABLED=1 to silence the detector entirely.)");
