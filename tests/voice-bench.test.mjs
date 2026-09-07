import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  wordErrorRate, normalizeTranscript, tokenize, realTimeFactor,
  percentile, summarizeLatencies, machineFacts, interferencePhase,
  renderReport, runBenchmark, saveReport,
  interferenceBudgetMs, INTERFERENCE_BUDGET,
} from '../src/voice/voice-bench.js';
import { composePlan } from '../src/voice/voice-models.js';

// ── WER ──────────────────────────────────────────────────────────────────

test('a perfect transcript scores zero', () => {
  const r = wordErrorRate('the cat sat on the mat', 'the cat sat on the mat');
  assert.equal(r.wer, 0);
  assert.equal(r.substitutions + r.insertions + r.deletions, 0);
});

test('case and punctuation are not errors a listener would care about', () => {
  const r = wordErrorRate('The cat sat, on the mat.', 'the cat sat on the mat');
  assert.equal(r.wer, 0);
});

test('numbers spelled differently ARE an error — hiding that would flatter a bad decoder', () => {
  const r = wordErrorRate('I have 20 apples', 'I have twenty apples');
  assert.ok(r.wer > 0);
  assert.equal(r.substitutions, 1);
});

test('the operation mix is reported, because deletions and substitutions fail differently', () => {
  // one substitution
  let r = wordErrorRate('the cat sat', 'the dog sat');
  assert.deepEqual([r.substitutions, r.insertions, r.deletions], [1, 0, 0]);
  // one deletion
  r = wordErrorRate('the cat sat', 'the sat');
  assert.deepEqual([r.substitutions, r.insertions, r.deletions], [0, 0, 1]);
  // one insertion
  r = wordErrorRate('the cat sat', 'the big cat sat');
  assert.deepEqual([r.substitutions, r.insertions, r.deletions], [0, 1, 0]);
});

test('WER is errors over reference length, so it can exceed 1 when the decoder rambles', () => {
  const r = wordErrorRate('hello', 'hello there my old friend');
  assert.equal(r.refWords, 1);
  assert.equal(r.insertions, 4);
  assert.ok(r.wer > 1);
});

test('an empty hypothesis against real speech is total failure, not a divide-by-zero', () => {
  const r = wordErrorRate('the cat sat on the mat', '');
  assert.equal(r.wer, 1);
  assert.equal(r.deletions, 6);
});

test('an empty reference is flagged degenerate rather than silently scored', () => {
  assert.equal(wordErrorRate('', '').wer, 0);
  const r = wordErrorRate('', 'hallucinated words');
  assert.equal(r.wer, 1);
  assert.equal(r.degenerate, true);
});

test('German text with umlauts and ß survives normalization intact', () => {
  assert.equal(normalizeTranscript('Grüß dich, schöne Größe!'), 'grüß dich schöne größe');
  assert.equal(wordErrorRate('Grüß dich', 'grüß dich!').wer, 0);
  assert.deepEqual(tokenize('Können Sie das wiederholen?'), ['können', 'sie', 'das', 'wiederholen']);
});

test('apostrophes are preserved — "dont" is not the same word as "don\'t"', () => {
  assert.equal(normalizeTranscript("I don't know"), "i don't know");
  assert.ok(wordErrorRate("I don't know", 'I dont know').wer > 0);
});

test('WER is symmetric in cost but not in meaning — a long hypothesis is scored against the reference', () => {
  const a = wordErrorRate('one two three four', 'one two');
  assert.equal(a.deletions, 2);
  assert.equal(a.wer, 0.5);
});

// ── RTF and latency stats ────────────────────────────────────────────────

test('real-time factor is compute over audio, and refuses nonsense input', () => {
  assert.equal(realTimeFactor({ processingMs: 300, audioMs: 1000 }), 0.3);
  assert.equal(realTimeFactor({ processingMs: 1500, audioMs: 1000 }), 1.5);
  assert.equal(realTimeFactor({ processingMs: 10, audioMs: 0 }), null);
  assert.equal(realTimeFactor({ processingMs: NaN, audioMs: 100 }), null);
});

test('percentile uses nearest-rank rather than inventing interpolated values', () => {
  const xs = [10, 20, 30, 40, 50];
  assert.equal(percentile(xs, 50), 30);
  assert.equal(percentile(xs, 90), 50);
  assert.equal(percentile(xs, 100), 50);
  assert.equal(percentile([], 50), null);
});

test('summarizeLatencies handles an empty sample without pretending it measured something', () => {
  assert.deepEqual(summarizeLatencies([]), { n: 0, min: null, median: null, p90: null, max: null, mean: null });
  const s = summarizeLatencies([5, 1, 3]);
  assert.equal(s.n, 3);
  assert.equal(s.min, 1);
  assert.equal(s.max, 5);
  assert.equal(s.mean, 3);
});

test('machine facts are read from the running system, never supplied', () => {
  const m = machineFacts({ appVersion: '9.9.9-test' });
  assert.equal(m.appVersion, '9.9.9-test');
  assert.equal(m.nodeVersion, process.version);
  assert.equal(m.arch, os.arch());
  assert.ok(m.cpuCount >= 1);
  assert.ok(m.totalMemBytes > 0);
  assert.match(m.measuredAt, /^\d{4}-\d{2}-\d{2}T/);
});

// ── Interference ─────────────────────────────────────────────────────────

test('the interference phase reports a partial result when there is no audio load to apply', async () => {
  const r = await interferencePhase({ probe: async () => {}, samples: 3, warmup: 1 });
  assert.equal(r.skipped, false);
  assert.equal(r.partial, true);
  assert.equal(r.reason, 'no-audio-load');
  assert.equal(r.quiet.n, 3);
  assert.equal(r.loaded, null);
});

test('no probe at all is a skip with a reason, not a zero', async () => {
  const r = await interferencePhase({ probe: null });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no-probe');
});

// ── The acceptance bar ───────────────────────────────────────────────────

test('a fast baseline is judged on staying imperceptible, not on a percentage', () => {
  // The X380's real number. ±20% of 39 ms is an ~8 ms window — a bar that
  // fails on shifts nobody could feel, and that gets harder the better the
  // machine is.
  const budget = interferenceBudgetMs(39);
  assert.equal(budget, INTERFERENCE_BUDGET.ceilingMs);
  assert.ok(budget > 39 * 1.2, 'a fast machine is not held to a few milliseconds');
});

test('a slow baseline is judged on whether audio made it meaningfully worse', () => {
  // Already past the comfort ceiling: the absolute test would fail it for
  // something audio did not cause, so the relative one binds instead.
  const budget = interferenceBudgetMs(400);
  assert.equal(budget, 400 + 80);
  assert.ok(budget > INTERFERENCE_BUDGET.ceilingMs);
});

test('the floor stops a small baseline producing an absurdly tight window', () => {
  // 10 ms baseline: 20% is 2 ms. The floor lifts it to something meaningful.
  const budget = interferenceBudgetMs(10);
  assert.equal(budget, INTERFERENCE_BUDGET.ceilingMs);
  // And even without the ceiling, the relative half would never be under the floor.
  const relativeOnly = 10 + Math.max(10 * 0.2, INTERFERENCE_BUDGET.floorMs);
  assert.equal(relativeOnly, 35);
});

test('the budget is monotonic — a slower baseline never gets a stricter bar', () => {
  let prev = -Infinity;
  for (const baseline of [1, 10, 39, 100, 200, 208, 300, 500, 2000]) {
    const b = interferenceBudgetMs(baseline);
    assert.ok(b >= prev, `budget went backwards at ${baseline}`);
    assert.ok(b > baseline, `budget must leave room above the baseline at ${baseline}`);
    prev = b;
  }
});

test('an unmeasurable baseline yields no budget rather than a made-up one', () => {
  assert.equal(interferenceBudgetMs(null), null);
  assert.equal(interferenceBudgetMs(NaN), null);
  assert.equal(interferenceBudgetMs(-1), null);
});

test('the report names WHICH half of the budget was binding', () => {
  const fast = renderReport({
    machine: machineFacts(), engine: { available: true },
    interference: {
      quiet: summarizeLatencies([39]), loaded: summarizeLatencies([60]),
      deltaMs: 21, deltaPct: 53.8, budgetMs: 250, budgetBasis: 'absolute',
      withinAcceptance: true, p90WithinBudget: true,
    },
  });
  assert.match(fast, /not something anyone can feel/);
  assert.match(fast, /✅ Inside the budget/);

  const slow = renderReport({
    machine: machineFacts(), engine: { available: true },
    interference: {
      quiet: summarizeLatencies([400]), loaded: summarizeLatencies([450]),
      deltaMs: 50, deltaPct: 12.5, budgetMs: 480, budgetBasis: 'relative',
      withinAcceptance: true, p90WithinBudget: true,
    },
  });
  assert.match(slow, /already slower than the comfort ceiling/);
});

test('a passing median with a failing tail is flagged, not hidden', () => {
  const md = renderReport({
    machine: machineFacts(), engine: { available: true },
    interference: {
      quiet: summarizeLatencies([39]), loaded: summarizeLatencies([200]),
      deltaMs: 161, deltaPct: 412, budgetMs: 250, budgetBasis: 'absolute',
      withinAcceptance: true, p90WithinBudget: false,
    },
  });
  assert.match(md, /slowest turns crossed the budget/);
});

test('a load that slows the probe is measured and judged against the budget', async () => {
  let loaded = false;
  const probe = async () => { await new Promise((r) => setTimeout(r, loaded ? 30 : 5)); };
  const r = await interferencePhase({
    probe,
    load: async () => { loaded = true; return () => { loaded = false; }; },
    samples: 3, warmup: 1,
  });
  assert.equal(r.skipped, false);
  assert.ok(r.deltaMs > 0);
  assert.ok(Number.isFinite(r.budgetMs), 'the budget it was judged against is reported');
  // 5 ms quiet vs 30 ms loaded: well inside the 250 ms comfort ceiling, so
  // this now PASSES — and should. Nobody perceives 30 ms. The old percentage
  // bar called this a failure, which was the bug.
  assert.equal(r.withinAcceptance, true);
});

test('a load that pushes the peers past the point of being felt DOES fail', async () => {
  let loaded = false;
  const probe = async () => { await new Promise((r) => setTimeout(r, loaded ? 320 : 5)); };
  const r = await interferencePhase({
    probe,
    load: async () => { loaded = true; return () => { loaded = false; }; },
    samples: 3, warmup: 1,
  });
  assert.equal(r.withinAcceptance, false, 'over a third of a second is a wait my human would feel');
  assert.equal(r.budgetBasis, 'absolute');
});

test('a load that costs nothing passes the acceptance bar', async () => {
  const probe = async () => { await new Promise((r) => setTimeout(r, 10)); };
  const r = await interferencePhase({
    probe,
    load: async () => () => {},
    samples: 4, warmup: 1,
  });
  assert.equal(r.withinAcceptance, true);
});

test('the load is stopped even when probing under load throws', async () => {
  let stopped = false;
  let n = 0;
  const probe = async () => { if (++n > 2) throw new Error('probe died'); };
  await interferencePhase({
    probe,
    load: async () => async () => { stopped = true; },
    samples: 2, warmup: 1,
  });
  assert.equal(stopped, true, 'a failing probe must not leave audio load running');
});

// ── Report ───────────────────────────────────────────────────────────────

test('a report with no engine says so loudly instead of rendering zeros', () => {
  const md = renderReport({
    machine: machineFacts({ appVersion: '0.0.1' }),
    engine: { available: false, reason: 'sherpa-onnx-node is not installed' },
    asr: { skipped: true, reason: 'sherpa-onnx-node is not installed' },
    rtf: { skipped: true, reason: 'sherpa-onnx-node is not installed' },
    interference: { skipped: true, reason: 'no-probe' },
  });
  assert.match(md, /speech engine was not available/);
  assert.match(md, /sherpa-onnx-node is not installed/);
  assert.doesNotMatch(md, /\| 0\.000 \|/, 'a missing measurement must never render as a zero');
});

test('the interference verdict is spelled out in plain language either way', () => {
  const base = { machine: machineFacts(), engine: { available: true } };
  const pass = renderReport({ ...base, interference: { quiet: summarizeLatencies([100, 100, 100]), loaded: summarizeLatencies([105, 105, 105]), deltaMs: 5, deltaPct: 5, withinAcceptance: true } });
  assert.match(pass, /keep answering while a call runs/);
  const fail = renderReport({ ...base, interference: { quiet: summarizeLatencies([100]), loaded: summarizeLatencies([300]), deltaMs: 200, deltaPct: 200, withinAcceptance: false } });
  assert.match(fail, /governor needs tightening/);
});

test('the report names a footprint breach rather than quietly listing the number', () => {
  const plan = composePlan();
  const md = renderReport({
    machine: machineFacts(),
    engine: { available: true },
    plan: {
      capabilityTier: plan.capabilityTier, voiceEngine: plan.voiceEngine, asrLangs: plan.asrLangs,
      evaluation: { totalBytes: 999e6, estimated: true, withinBudget: false, violations: [{ axis: 'voice', of: 'pocket', bytes: 999e6, ceiling: 262e6 }] },
    },
  });
  assert.match(md, /Over the §0.7 ceilings/);
});

test('WER rows carry the operation breakdown into the rendered table', () => {
  const md = renderReport({
    machine: machineFacts(),
    engine: { available: true },
    asr: { skipped: false, runs: [{ fixture: 'de-1', condition: 'noisy', wer: 0.125, substitutions: 1, insertions: 0, deletions: 0 }] },
  });
  assert.match(md, /\| de-1 \| noisy \| 12\.5% \| 1 \| 0 \| 0 \|/);
});

// ── End-to-end through the real orchestrator ─────────────────────────────

test('a full run with no engine still produces a complete, honest report', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vbench-'));
  try {
    const stages = [];
    const result = await runBenchmark({
      rootDir: root,
      plan: composePlan(),
      engine: null,
      probe: async () => { await new Promise((r) => setTimeout(r, 1)); },
      appVersion: '0.9.36-alpha',
      onStage: (s) => stages.push(s.stage),
      samples: 2,
    });

    assert.equal(result.engine.available, false);
    assert.equal(result.asr.skipped, true);
    assert.equal(result.rtf.skipped, true);
    assert.equal(result.interference.partial, true, 'the quiet baseline is still measurable without an engine');
    assert.ok(result.footprint, 'disk is measurable regardless of the engine');
    assert.ok(result.markdown.includes('# Voice benchmark'));
    assert.ok(stages.includes('footprint') && stages.includes('done'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a full run with a stub engine measures every stage and scores WER from real text', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vbench-'));
  try {
    const engine = {
      available: true,
      listFixtures: async () => [{ name: 'en-1', lang: 'en', reference: 'the quick brown fox', conditions: ['clean', 'noisy'] }],
      transcribe: async ({ condition }) => ({
        text: condition === 'clean' ? 'the quick brown fox' : 'the quick brown box',
        audioMs: 2000, processingMs: 400,
      }),
      measureRtf: async ({ streams }) => ({ processingMs: streams === 1 ? 200 : 600, audioMs: 1000 }),
      measureTts: async () => ({ firstChunkMs: 210, perSentenceMs: 480 }),
      measureSpeaker: async () => ({ perUtteranceMs: 35 }),
      measureEnhance: async () => ({ perAudioSecondMs: 60 }),
      startLoad: async () => () => {},
    };

    const result = await runBenchmark({
      rootDir: root, plan: composePlan(), engine,
      probe: async () => { await new Promise((r) => setTimeout(r, 2)); },
      samples: 3,
    });

    assert.equal(result.asr.runs.length, 2);
    assert.equal(result.asr.runs.find((r) => r.condition === 'clean').wer, 0);
    assert.ok(result.asr.runs.find((r) => r.condition === 'noisy').wer > 0);
    assert.equal(result.rtf.oneStream, 0.2);
    assert.equal(result.rtf.twoStreams, 0.6);
    assert.equal(result.tts.firstChunkMs, 210);
    assert.equal(result.interference.partial, false);
    assert.match(result.markdown, /faster than real time/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('one broken engine stage does not take the run down with it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vbench-'));
  try {
    const engine = {
      available: true,
      listFixtures: async () => [{ name: 'en-1', reference: 'hello there', conditions: ['clean'] }],
      transcribe: async () => { throw new Error('decoder exploded'); },
      measureRtf: async () => { throw new Error('no models'); },
      measureTts: async () => { throw new Error('voice missing'); },
      startLoad: async () => () => {},
    };
    const result = await runBenchmark({ rootDir: root, plan: composePlan(), engine, probe: async () => {}, samples: 2 });

    assert.equal(result.asr.runs[0].failed, 'decoder exploded');
    assert.equal(result.rtf.skipped, true);
    assert.match(result.rtf.reason, /no models/);
    assert.equal(result.tts.skipped, true);
    assert.ok(result.markdown.includes('# Voice benchmark'), 'the report still renders');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('the report survives the modal — both files land in logs/', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vbench-'));
  try {
    const result = await runBenchmark({ rootDir: root, plan: composePlan(), engine: null, probe: async () => {}, samples: 1 });
    const { jsonPath, mdPath } = await saveReport({ rootDir: root, result, now: new Date('2026-07-25T10:00:00Z') });

    assert.match(jsonPath, /voice-bench-2026-07-25\.json$/);
    assert.match(mdPath, /voice-bench-2026-07-25\.md$/);
    const parsed = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
    assert.equal(parsed.markdown, undefined, 'the JSON holds data, not the rendered copy');
    assert.ok(parsed.machine.cpuCount >= 1);
    assert.ok((await fs.readFile(mdPath, 'utf8')).startsWith('# Voice benchmark'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
