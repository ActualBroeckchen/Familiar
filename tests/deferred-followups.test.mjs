// Deferred follow-ups — docs/deferred-followups-build-spec.md.
//
// The mirror of the deferred-"tell" bug (0.9.32): there I said a thing and
// forgot the bookkeeping; here I promise a thing ("I'll do that later") and
// never actually use a tool to make it real. Memorization catches the open
// commitment from the session transcript and re-surfaces it via the same
// deferred-intents surface ponderings already use, until I act on it (and
// acknowledge) or drop it. Unlike a tell, it is NOT auto-consumed by being
// shown — a follow-up has a real action to perform, not just a saying.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { mkdtempSync, rmSync } from 'fs';

import { parseFollowups, followupsFeatureEnabled, buildPrompt } from '../src/memory/memorization.js';
import {
  createSessionFollowup,
  getUnactedIntents,
  getRecentPonderings,
  formatDeferredIntentsBlock,
  FOLLOWUP_MAX_AGE_DAYS,
} from '../src/memory/recent-ponderings.js';

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'followups-'));
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

const MSGS = [
  { role: 'user', content: "Can you remind me to call the vet tomorrow?" },
  { role: 'assistant', content: "Of course — I'll remind you tomorrow." },
];

// ── parseFollowups ────────────────────────────────────────────────────────

test('parseFollowups: valid array parsed', () => {
  const raw = JSON.stringify({ facts: [], relations: [], follow_ups: [
    "I said I'd remind my human about the vet call tomorrow and never set it up.",
    "I told my human I'd look up that recipe and didn't.",
  ] });
  const out = parseFollowups(raw);
  assert.equal(out.length, 2);
  assert.match(out[0], /vet call/);
});

test('parseFollowups: malformed JSON → []', () => {
  assert.deepEqual(parseFollowups('not json at all'), []);
  assert.deepEqual(parseFollowups('{"facts": [1,2,'), []); // truncated
});

test('parseFollowups: missing field / non-commitment (blank) lines omitted', () => {
  assert.deepEqual(parseFollowups(JSON.stringify({ facts: [] })), []); // no follow_ups key
  const raw = JSON.stringify({ follow_ups: ['', '   ', 'a real one', null, 42] });
  const out = parseFollowups(raw);
  assert.deepEqual(out, ['a real one', '42']);
});

// ── followupsFeatureEnabled ───────────────────────────────────────────────

test('followupsFeatureEnabled: default ON, env kill-switch wins, ward can turn off', () => {
  delete process.env.PROTO_FAMILIAR_FOLLOWUPS_DISABLED;
  assert.equal(followupsFeatureEnabled({}), true);
  assert.equal(followupsFeatureEnabled({ followupsEnabled: false }), false);
  process.env.PROTO_FAMILIAR_FOLLOWUPS_DISABLED = '1';
  assert.equal(followupsFeatureEnabled({ followupsEnabled: true }), false);
  delete process.env.PROTO_FAMILIAR_FOLLOWUPS_DISABLED;
});

// ── buildPrompt: follow_ups section gated ────────────────────────────────

test('buildPrompt: includes follow_ups section when enabled (default)', () => {
  const p = buildPrompt(MSGS, null, 'Chen');
  assert.match(p, /follow_ups/);
  assert.match(p, /Field rules — follow_ups/);
});

test('buildPrompt: omits follow_ups section when disabled', () => {
  const p = buildPrompt(MSGS, null, 'Chen', [], false);
  assert.doesNotMatch(p, /follow_ups/);
  assert.doesNotMatch(p, /Field rules — follow_ups/);
});

// ── createSessionFollowup + surfacing ─────────────────────────────────────

test('createSessionFollowup surfaces as kind:"followup" via getUnactedIntents; getRecentPonderings excludes it', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const r = await createSessionFollowup({ summary: "I said I'd set a reminder for the dentist and didn't.", tomesDir: dir });
    assert.equal(r.ok, true);
    assert.equal(r.created, true);

    const intents = await getUnactedIntents({ tomesDir: dir, markSurfaced: false });
    assert.equal(intents.length, 1);
    assert.equal(intents[0].kind, 'followup');
    assert.match(intents[0].summary, /dentist/);

    // Bookkeeping artifact, not a real thought — never shows as "recent ponderings".
    const ponderings = await getRecentPonderings({ tomesDir: dir });
    assert.deepEqual(ponderings, []);
  } finally { cleanup(); }
});

test('createSessionFollowup: dedup skips a lexically-containing duplicate', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const first = await createSessionFollowup({ summary: "I'll set a reminder for the dentist on Tuesday.", tomesDir: dir });
    assert.equal(first.created, true);
    // Same commitment, slightly different phrasing/casing/punctuation — the
    // kind of restatement two overlapping memorization slices could produce.
    const second = await createSessionFollowup({ summary: "set a reminder for the dentist on tuesday", tomesDir: dir });
    assert.equal(second.created, false);

    const intents = await getUnactedIntents({ tomesDir: dir });
    assert.equal(intents.length, 1);
  } finally { cleanup(); }
});

test('createSessionFollowup: a genuinely different commitment is NOT deduped', async () => {
  const { dir, cleanup } = tempDir();
  try {
    await createSessionFollowup({ summary: "I'll set a reminder for the dentist.", tomesDir: dir });
    const second = await createSessionFollowup({ summary: "I'll look up that recipe my human asked about.", tomesDir: dir });
    assert.equal(second.created, true);
    const intents = await getUnactedIntents({ tomesDir: dir });
    assert.equal(intents.length, 2);
  } finally { cleanup(); }
});

// ── persistence: NOT auto-consumed like a tell ────────────────────────────

test('a follow-up survives repeated markSurfaced surfaces (unlike a tell)', async () => {
  const { dir, cleanup } = tempDir();
  try {
    await createSessionFollowup({ summary: "I'll email the landlord about the leak.", tomesDir: dir });

    const first = await getUnactedIntents({ tomesDir: dir, markSurfaced: true });
    assert.equal(first.length, 1);
    const second = await getUnactedIntents({ tomesDir: dir, markSurfaced: true });
    assert.equal(second.length, 1, 'still shown — a follow-up needs the real action, not just being surfaced');
    const third = await getUnactedIntents({ tomesDir: dir, markSurfaced: false });
    assert.equal(third.length, 1);
  } finally { cleanup(); }
});

// ── aging: drop-on-read past followupMaxAgeDays ───────────────────────────

test('aging: a follow-up past followupMaxAgeDays is dropped with disposition:"aged-out"', async () => {
  const { dir, cleanup } = tempDir();
  try {
    await createSessionFollowup({ summary: "I'll set that reminder later.", tomesDir: dir });

    // Not yet aged out at exactly the default (7 days).
    assert.equal(FOLLOWUP_MAX_AGE_DAYS, 7);
    const stillOpen = await getUnactedIntents({ tomesDir: dir, followupMaxAgeDays: 7 });
    assert.equal(stillOpen.length, 1);

    // Simulate "past the window" with a tight age limit instead of waiting a
    // real week — the live surface (markSurfaced:true) persists the drop.
    const aged = await getUnactedIntents({ tomesDir: dir, markSurfaced: true, followupMaxAgeDays: 0 });
    assert.equal(aged.length, 0, 'aged-out follow-up is not shown');

    // The drop is honest, not a claim it was done.
    const stillHidden = await getUnactedIntents({ tomesDir: dir, followupMaxAgeDays: 7 });
    assert.equal(stillHidden.length, 0, 'once aged-out and persisted, it stays gone even under the normal window');
  } finally { cleanup(); }
});

// ── formatDeferredIntentsBlock: the followup branch ───────────────────────

test('formatDeferredIntentsBlock: followup renders as "follow through now", not a tell/tool-only line', () => {
  const block = formatDeferredIntentsBlock([
    { uid: 'abc', kind: 'followup', summary: "I said I'd remind my human about the vet call", index: 0 },
  ]);
  assert.match(block, /\[followup\].*vet call/);
  assert.match(block, /I follow through NOW with the right tool/);
  assert.match(block, /Saying I'll do it is not doing it/);
  assert.match(block, /acknowledge_deferred_intent\(uid="abc", index=0\)/);
});

// ── PIPELINE: a stubbed memorization extraction → surfaces in the next
//    deferred-intents read, the same two calls thalamus.enrich() makes
//    (getUnactedIntents({ limit: 5, markSurfaced: true }) then
//    formatDeferredIntentsBlock(intents)). ─────────────────────────────────

test('PIPELINE: an un-toolnamed commitment in a stubbed provider response lands as a follow-up and appears in the next deferred-intents block', async () => {
  const { dir, cleanup } = tempDir();
  try {
    // What a real callProvider() would have handed back for a ward-private
    // session where the Familiar said "I'll set that reminder later" and
    // never actually called a schedule/reminder tool.
    const stubbedProviderRaw = JSON.stringify({
      facts: [],
      relations: [],
      follow_ups: ["I told my human I'd set a reminder for their vet appointment tomorrow and never actually called the tool."],
    });

    // The extraction step processJob runs on the SAME response (no extra
    // LLM call) — this is the real parser, not a stand-in.
    const followups = parseFollowups(stubbedProviderRaw, null);
    assert.equal(followups.length, 1);

    // The storage step processJob runs per extracted follow-up.
    for (const summary of followups) {
      const r = await createSessionFollowup({ summary, tomesDir: dir });
      assert.equal(r.ok, true);
    }

    // The next live turn: enrich()'s exact deferred-intents surface.
    const intents = await getUnactedIntents({ tomesDir: dir, limit: 5, markSurfaced: true });
    assert.equal(intents.length, 1);
    assert.equal(intents[0].kind, 'followup');

    const block = formatDeferredIntentsBlock(intents);
    assert.match(block, /\[Deferred intents from my free time\]/);
    assert.match(block, /\[followup\].*vet appointment/);
    assert.match(block, /I follow through NOW with the right tool/);

    // A THIRD-turn read still shows it — not auto-consumed like a tell.
    const nextTurn = await getUnactedIntents({ tomesDir: dir, limit: 5, markSurfaced: true });
    assert.equal(nextTurn.length, 1, 'a follow-up persists until acted+acknowledged or dropped, not spent by surfacing');

    // And it never pollutes "things I've been quietly thinking about."
    const ponderings = await getRecentPonderings({ tomesDir: dir });
    assert.deepEqual(ponderings, []);
  } finally { cleanup(); }
});

// ── off-switch: no extraction / no surface ────────────────────────────────

test('off-switch: PROTO_FAMILIAR_FOLLOWUPS_DISABLED=1 → buildPrompt has no follow_ups, nothing to parse', () => {
  process.env.PROTO_FAMILIAR_FOLLOWUPS_DISABLED = '1';
  try {
    const settings = {};
    const on = followupsFeatureEnabled(settings);
    assert.equal(on, false);
    const p = buildPrompt(MSGS, null, 'Chen', [], on);
    assert.doesNotMatch(p, /follow_ups/);
  } finally {
    delete process.env.PROTO_FAMILIAR_FOLLOWUPS_DISABLED;
  }
});
