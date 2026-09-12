/**
 * The Pass 0 measuring core (voice spec §0.5, §0.7).
 *
 * What this answers, on the ward's own machine rather than in the abstract:
 *
 *   - Can this laptop transcribe speech faster than it arrives? (RTF, at one
 *     and at two concurrent streams.)
 *   - How badly does a cheap microphone hurt, and does enhancement help?
 *     (WER, clean vs noisy vs noisy+enhanced.)
 *   - How long until the first sound of a reply? (TTS time-to-first-chunk.)
 *   - **Does a live call starve the rest of me?** (The interference phase —
 *     `enrich`-path latency with and without full audio load. This is the §4
 *     headline, and it is the one number the whole compute-governor design
 *     rests on.)
 *   - What does all of it cost on disk? (§0.7 footprint.)
 *
 * The report is the deliverable. A ward runs this, reads a plain summary,
 * and sends the file back; whoever holds the repo commits the aggregate as
 * `docs/voice-bench-results.md`, and those measurements replace the "~"
 * estimates this spec is currently built on.
 *
 * ── Two disciplines this module holds ────────────────────────────────────
 *
 * 1. EVERY NUMBER IS COMPUTED HERE, IN CODE. WER is a real edit distance
 *    over tokens, not a model's impression of how well it did. Machine facts
 *    are read from `os`, not typed. (CLAUDE.md: the LLM is not a source of
 *    exact machine values.)
 * 2. A MISSING ENGINE IS A REPORTED ABSENCE, NEVER A CRASH AND NEVER A GUESS.
 *    `sherpa-onnx-node` may not be installed; models may not be fetched. Each
 *    stage records `skipped` with a reason and the report still renders. A
 *    benchmark that silently omits the stage it could not run is worse than
 *    one that says so.
 */

import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promises as fs } from 'node:fs';

import { formatBytes, evaluatePlan } from './voice-models.js';
import { measureFootprint } from './voice-footprint.js';
import { inspectInstalled, MODELS_SUBDIR } from './voice-fetch.js';

// ── Word error rate ──────────────────────────────────────────────────────

/**
 * Normalize a transcript for comparison. Case, punctuation and repeated
 * whitespace are not what we are measuring — a decoder that writes "don't"
 * where the reference says "dont" has not made an error a listener would care
 * about, and counting it as one would flatter enhancement runs against clean
 * ones inconsistently.
 *
 * Deliberately NOT normalized: numbers and their spellings. "20" vs "twenty"
 * is a real difference in what a Familiar would hear, and hiding it would let
 * a bad ASR pick look fine.
 */
export function normalizeTranscript(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(text) {
  const n = normalizeTranscript(text);
  return n ? n.split(' ') : [];
}

/**
 * Levenshtein over word tokens, returning the edit operations that make up
 * the distance. Two rows rather than a full matrix — a long fixture should
 * not allocate a megabyte to be scored.
 *
 * The breakdown matters: substitutions, insertions and deletions fail
 * differently. A decoder that drops half the words (deletions) is failing at
 * endpointing; one that substitutes is failing at acoustics. The ward's
 * report should let those be told apart.
 */
export function wordErrorRate(reference, hypothesis) {
  const ref = tokenize(reference);
  const hyp = tokenize(hypothesis);

  if (ref.length === 0) {
    return {
      wer: hyp.length === 0 ? 0 : 1,
      refWords: 0, hypWords: hyp.length,
      substitutions: 0, insertions: hyp.length, deletions: 0,
      degenerate: true,
    };
  }

  // Each cell holds {d, s, i, del} so the operation mix survives the reduction.
  const mk = (d, s, i, del) => ({ d, s, i, del });
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => mk(j, 0, j, 0));
  let cur = new Array(hyp.length + 1);

  for (let i = 1; i <= ref.length; i++) {
    cur[0] = mk(i, 0, 0, i);
    for (let j = 1; j <= hyp.length; j++) {
      if (ref[i - 1] === hyp[j - 1]) {
        cur[j] = { ...prev[j - 1] };
      } else {
        const sub = prev[j - 1];
        const ins = cur[j - 1];
        const del = prev[j];
        const best = Math.min(sub.d, ins.d, del.d) + 1;
        if (sub.d <= ins.d && sub.d <= del.d) cur[j] = mk(best, sub.s + 1, sub.i, sub.del);
        else if (ins.d <= del.d) cur[j] = mk(best, ins.s, ins.i + 1, ins.del);
        else cur[j] = mk(best, del.s, del.i, del.del + 1);
      }
    }
    [prev, cur] = [cur, prev];
  }

  const end = prev[hyp.length];
  return {
    wer: end.d / ref.length,
    refWords: ref.length,
    hypWords: hyp.length,
    substitutions: end.s,
    insertions: end.i,
    deletions: end.del,
    degenerate: false,
  };
}

/** Real-time factor: seconds of compute per second of audio. Below 1.0 is faster than real time. */
export function realTimeFactor({ processingMs, audioMs }) {
  if (!Number.isFinite(processingMs) || !Number.isFinite(audioMs) || audioMs <= 0) return null;
  return processingMs / audioMs;
}

/** Percentile over a sample, for latency tails. Nearest-rank — no interpolation invented. */
export function percentile(values, p) {
  const xs = (values ?? []).filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * xs.length));
  return xs[Math.min(rank, xs.length) - 1];
}

export function summarizeLatencies(values) {
  const xs = (values ?? []).filter(Number.isFinite);
  if (xs.length === 0) return { n: 0, min: null, median: null, p90: null, max: null, mean: null };
  return {
    n: xs.length,
    min: Math.min(...xs),
    median: percentile(xs, 50),
    p90: percentile(xs, 90),
    max: Math.max(...xs),
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
  };
}

// ── Machine facts ────────────────────────────────────────────────────────

/**
 * Read, never typed. A report whose CPU model was guessed is worthless for
 * comparing across wards, which is the entire point of collecting them.
 */
export function machineFacts({ appVersion = null } = {}) {
  const cpus = os.cpus() ?? [];
  return {
    cpuModel: cpus[0]?.model?.trim() ?? 'unknown',
    cpuCount: cpus.length,
    cpuSpeedMHz: cpus[0]?.speed ?? null,
    arch: os.arch(),
    platform: os.platform(),
    release: os.release(),
    totalMemBytes: os.totalmem(),
    freeMemBytes: os.freemem(),
    nodeVersion: process.version,
    appVersion,
    measuredAt: new Date().toISOString(),
  };
}

// ── The interference phase ───────────────────────────────────────────────

/**
 * The §4 headline, measured rather than asserted: does audio load slow the
 * path that answers my human?
 *
 * `probe` is an async function that performs one real enrichment-shaped
 * operation (a `mem_search` through the live thalamus). `load` starts audio
 * work and returns a stop function. We sample the probe quiet, then under
 * load, and report both distributions plus the delta.
 *
 * Sampling is interleaved-by-phase rather than randomized because the thermal
 * story matters: sustained audio load on a 15 W laptop throttles, and a
 * randomized order would smear that into the baseline.
 */
/**
 * The acceptance bar for interference, and why it is shaped this way.
 *
 * The original §14 bar was "within ±20% of normal". The X380 measured a 39 ms
 * quiet baseline, which turns ±20% into an ~8 ms window — a test that fails on
 * a shift no human could perceive, and one that gets *harder* the faster the
 * machine is. A bar that punishes a good baseline is measuring the wrong
 * thing.
 *
 * What §4 actually promises is that Phylactery and Unruh keep answering while
 * I talk — i.e. that my human does not notice the difference. So the budget is
 * the more generous of two ideas:
 *
 *   ABSOLUTE   Stay under `ceilingMs`. Below roughly a quarter second an
 *              enrichment read is invisible inside a turn that is already
 *              waiting on a network LLM call. Whether it took 39 ms or 200 ms
 *              is not something anyone can feel.
 *   RELATIVE   Or, if the machine was ALREADY slower than that, do not make it
 *              meaningfully worse: baseline plus 20%, with an absolute floor
 *              so a fast baseline is never held to a few milliseconds.
 *
 * Taking the max means a fast machine is judged on whether it stayed
 * imperceptible, and a slow machine is judged on whether audio made it worse.
 * Neither is punished for the thing it cannot help.
 */
export const INTERFERENCE_BUDGET = Object.freeze({
  ceilingMs: 250,        // under this, an enrichment read is not perceptible in a turn
  relativeTolerance: 0.20,
  floorMs: 25,           // a fast baseline is never held to a window tighter than this
});

/**
 * The budget a loaded median must stay inside, given the quiet baseline.
 * Pure, so the bar itself is testable and cannot drift from what the report
 * claims it checked.
 */
export function interferenceBudgetMs(quietMedianMs, budget = INTERFERENCE_BUDGET) {
  if (!Number.isFinite(quietMedianMs) || quietMedianMs < 0) return null;
  const relative = quietMedianMs + Math.max(quietMedianMs * budget.relativeTolerance, budget.floorMs);
  return Math.max(budget.ceilingMs, relative);
}

export async function interferencePhase({ probe, load = null, samples = 12, warmup = 2, budget = INTERFERENCE_BUDGET } = {}) {
  const runSeries = async (n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      let ok = true;
      try { await probe(); } catch { ok = false; }
      const dt = performance.now() - t0;
      if (ok) out.push(dt);
    }
    return out;
  };

  if (typeof probe !== 'function') {
    return { skipped: true, reason: 'no-probe' };
  }

  await runSeries(warmup);                      // discard: first call pays cache/JIT costs
  const quiet = await runSeries(samples);

  if (typeof load !== 'function') {
    return {
      skipped: false, partial: true, reason: 'no-audio-load',
      quiet: summarizeLatencies(quiet), loaded: null, deltaMs: null, deltaPct: null,
    };
  }

  let stop = null;
  let loaded = [];
  try {
    stop = await load();
    loaded = await runSeries(samples);
  } finally {
    try { await stop?.(); } catch { /* a load that will not stop must not lose the measurements */ }
  }

  const q = summarizeLatencies(quiet);
  const l = summarizeLatencies(loaded);
  const deltaMs = q.median !== null && l.median !== null ? l.median - q.median : null;
  const deltaPct = deltaMs !== null && q.median > 0 ? (deltaMs / q.median) * 100 : null;

  const budgetMs = interferenceBudgetMs(q.median, budget);
  const withinAcceptance = (budgetMs === null || l.median === null) ? null : l.median <= budgetMs;

  return {
    skipped: false, partial: false,
    quiet: q, loaded: l, deltaMs, deltaPct,
    budgetMs,
    // Which half of the budget was the binding one — worth reporting, because
    // "you stayed imperceptible" and "you did not make a slow machine worse"
    // are different claims and a reader should know which was tested.
    budgetBasis: budgetMs === null ? null : (budgetMs === budget.ceilingMs ? 'absolute' : 'relative'),
    withinAcceptance,
    // The tail is what someone actually feels on a bad turn. Reported, not
    // gated: at a dozen samples a single outlier should not fail a build.
    p90WithinBudget: (budgetMs === null || l.p90 === null) ? null : l.p90 <= budgetMs,
  };
}

// ── Report assembly ──────────────────────────────────────────────────────

const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—');
const ms = (x) => (Number.isFinite(x) ? `${x.toFixed(0)} ms` : '—');
const rtf = (x) => (Number.isFinite(x) ? x.toFixed(3) : '—');

/**
 * Render the markdown a ward copies or downloads. Deliberately plain: this is
 * read by someone who may not be technical, then pasted into an issue by
 * someone who is. Every skipped stage is named with its reason — an omission
 * that looks like a pass is the failure mode this guards against.
 */
export function renderReport(result) {
  const L = [];
  const m = result.machine ?? {};

  L.push('# Voice benchmark');
  L.push('');
  L.push(`Run ${m.measuredAt ?? 'at an unknown time'} on Proto-Familiar ${m.appVersion ?? '(version unknown)'}.`);
  L.push('');
  L.push('## Machine');
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  L.push(`| CPU | ${m.cpuModel} (${m.cpuCount} logical${m.cpuSpeedMHz ? `, ${m.cpuSpeedMHz} MHz` : ''}) |`);
  L.push(`| Platform | ${m.platform} ${m.release} (${m.arch}) |`);
  L.push(`| Memory | ${formatBytes(m.totalMemBytes)} total, ${formatBytes(m.freeMemBytes)} free at start |`);
  L.push(`| Node | ${m.nodeVersion} |`);
  L.push('');

  if (result.engine?.available === false) {
    L.push('> **The speech engine was not available for this run**, so every audio measurement below is missing rather than zero.');
    L.push('> ' + (result.engine.reason ?? 'reason not recorded'));
    L.push('');
  }

  L.push('## Transcription accuracy');
  L.push('');
  if (!result.asr || result.asr.skipped) {
    L.push(`_Skipped: ${result.asr?.reason ?? 'not run'}._`);
  } else {
    L.push('| fixture | condition | WER | subs | ins | dels |');
    L.push('|---|---|---|---|---|---|');
    for (const r of result.asr.runs ?? []) {
      L.push(`| ${r.fixture} | ${r.condition} | ${pct(r.wer)} | ${r.substitutions} | ${r.insertions} | ${r.deletions} |`);
    }
  }
  L.push('');

  L.push('## Speed');
  L.push('');
  if (!result.rtf || result.rtf.skipped) {
    L.push(`_Skipped: ${result.rtf?.reason ?? 'not run'}._`);
  } else {
    L.push('| measurement | value | reads as |');
    L.push('|---|---|---|');
    L.push(`| ASR real-time factor, 1 stream | ${rtf(result.rtf.oneStream)} | ${result.rtf.oneStream < 1 ? 'faster than real time' : 'slower than real time — a call would fall behind'} |`);
    L.push(`| ASR real-time factor, 2 streams | ${rtf(result.rtf.twoStreams)} | ${result.rtf.twoStreams < 1 ? 'a two-person call keeps up' : 'a two-person call would fall behind'} |`);
    if (result.tts) L.push(`| TTS time to first sound | ${ms(result.tts.firstChunkMs)} | ${result.tts.firstChunkMs < 500 ? 'feels responsive' : 'noticeable pause before I speak'} |`);
    if (result.tts?.perSentenceMs != null) L.push(`| TTS per sentence | ${ms(result.tts.perSentenceMs)} | |`);
    if (result.speaker?.perUtteranceMs != null) L.push(`| Speaker embedding | ${ms(result.speaker.perUtteranceMs)} | per utterance |`);
    if (result.enhance?.perAudioSecondMs != null) L.push(`| Enhancement | ${ms(result.enhance.perAudioSecondMs)} | per second of audio |`);
  }
  L.push('');

  L.push('## Does a call starve the rest of me?');
  L.push('');
  const itf = result.interference;
  if (!itf || itf.skipped) {
    L.push(`_Skipped: ${itf?.reason ?? 'not run'}._`);
  } else if (itf.partial) {
    L.push(`_Partial: ${itf.reason}. Quiet-machine baseline only._`);
    L.push('');
    L.push(`Memory lookup, quiet: median ${ms(itf.quiet.median)}, 90th percentile ${ms(itf.quiet.p90)} (${itf.quiet.n} samples).`);
  } else {
    L.push(`| | median | 90th percentile |`);
    L.push('|---|---|---|');
    L.push(`| Quiet machine | ${ms(itf.quiet.median)} | ${ms(itf.quiet.p90)} |`);
    L.push(`| Under audio load | ${ms(itf.loaded.median)} | ${ms(itf.loaded.p90)} |`);
    L.push('');
    const dir = itf.deltaMs >= 0 ? 'slower' : 'faster';
    L.push(`Difference: **${ms(Math.abs(itf.deltaMs))} ${dir}** (${itf.deltaPct >= 0 ? '+' : ''}${itf.deltaPct?.toFixed(1)}%).`);
    if (Number.isFinite(itf.budgetMs)) {
      L.push('');
      L.push(itf.budgetBasis === 'absolute'
        ? `Budget: **${ms(itf.budgetMs)}** — below this, the wait is not something anyone can feel inside a turn.`
        : `Budget: **${ms(itf.budgetMs)}** — this machine was already slower than the comfort ceiling, so the test is whether audio made it meaningfully worse.`);
    }
    L.push('');
    L.push(itf.withinAcceptance
      ? '✅ Inside the budget — Phylactery and Unruh keep answering while a call runs.'
      : '⚠️ Over the budget. The compute governor needs tightening on this hardware before voice calls ship for it.');
    if (itf.p90WithinBudget === false && itf.withinAcceptance) {
      L.push('');
      L.push('Note: the typical case is fine, but the slowest turns crossed the budget. Worth a second run before trusting it.');
    }
  }
  L.push('');

  L.push('## Disk');
  L.push('');
  if (result.footprint) {
    L.push('| what | size | |');
    L.push('|---|---|---|');
    for (const i of result.footprint.items) {
      if (!i.exists) continue;
      L.push(`| ${i.label} | ${formatBytes(i.bytes)} | ${i.reclaimable ? 're-fetchable' : i.kind === 'self' ? 'mine — not a cache' : 'managed by the installer'} |`);
    }
    L.push('');
    L.push(`Total on disk: **${formatBytes(result.footprint.totals.totalBytes)}** (${formatBytes(result.footprint.totals.machineBytes)} machine, ${formatBytes(result.footprint.totals.selfBytes)} mine).`);
    if (result.footprint.volume?.ok) {
      L.push(`Free on this drive: ${formatBytes(result.footprint.volume.freeBytes)} of ${formatBytes(result.footprint.volume.totalBytes)}.`);
    }
  }
  if (result.plan) {
    L.push('');
    const ev = result.plan.evaluation;
    // Download and disk are different numbers and both matter: one is what
    // crosses the network, the other is what the ceilings are about.
    const disk = Number.isFinite(ev.totalDiskBytes) ? ev.totalDiskBytes : ev.totalBytes;
    L.push(`Plan measured: **${result.plan.capabilityTier} / ${result.plan.voiceEngine} / ${result.plan.asrLangs.join('+')}**`);
    L.push('');
    L.push(`- Download: ${ev.estimated ? 'about ' : ''}${formatBytes(ev.totalBytes)}`);
    L.push(`- On disk once unpacked: ${ev.diskEstimated ? 'about ' : ''}${formatBytes(disk)}`);
    if (Number.isFinite(ev.peakBytes) && ev.peakBytes > disk) {
      L.push(`- Free space needed while installing: ${formatBytes(ev.peakBytes)} (the archive and its unpacked copy both exist for a moment)`);
    }
    L.push(ev.withinBudget
      ? '✅ Inside the §0.7 footprint ceilings.'
      : `⚠️ Over the §0.7 ceilings: ${ev.violations.map((v) => `${v.axis} ${v.of} at ${formatBytes(v.bytes)} against ${formatBytes(v.ceiling)}`).join('; ')}.`);
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push('_Send this file back, or paste it into an issue. The estimates in the voice build spec are replaced by measurements like these._');
  L.push('');
  return L.join('\n');
}

// ── The run ──────────────────────────────────────────────────────────────

/**
 * Orchestrate a full benchmark.
 *
 * `engine` is the boundary to sherpa-onnx: an object providing the async
 * measurement primitives. It is injected rather than imported so this module
 * stays testable without the native binding, and so a missing engine is a
 * value (`{available:false, reason}`) rather than an import that throws
 * halfway through a ward-facing run.
 *
 * `onStage` reports staged progress for the UI ("ASR, two streams…").
 */
export async function runBenchmark({
  rootDir,
  plan,
  engine = null,
  probe = null,
  appVersion = null,
  onStage = null,
  samples = 12,
} = {}) {
  const stage = (name, detail = null) => { try { onStage?.({ stage: name, detail }); } catch { /* progress must not break a run */ } };

  const result = {
    machine: machineFacts({ appVersion }),
    plan: plan ? { capabilityTier: plan.capabilityTier, voiceEngine: plan.voiceEngine, asrLangs: plan.asrLangs, evaluation: evaluatePlan(plan) } : null,
    engine: { available: Boolean(engine?.available), reason: engine?.reason ?? (engine ? null : 'no speech engine was provided to this run') },
  };

  stage('models');
  if (plan && rootDir) {
    const modelsDir = path.join(rootDir, MODELS_SUBDIR);
    result.models = await inspectInstalled({ plan, modelsDir });
  }

  const engineUnavailable = !engine?.available;
  const skip = (reason) => ({ skipped: true, reason });

  stage('asr');
  result.asr = engineUnavailable
    ? skip(result.engine.reason ?? 'the speech engine is not installed')
    : await measureAsr(engine, stage);

  stage('rtf');
  result.rtf = engineUnavailable ? skip(result.engine.reason) : await measureRtf(engine, stage);

  stage('tts');
  result.tts = engineUnavailable ? skip(result.engine.reason) : await safe(() => engine.measureTts());

  stage('speaker');
  result.speaker = engineUnavailable ? skip(result.engine.reason) : await safe(() => engine.measureSpeaker?.());

  stage('enhance');
  result.enhance = engineUnavailable ? skip(result.engine.reason) : await safe(() => engine.measureEnhance?.());

  stage('interference');
  result.interference = await interferencePhase({
    probe,
    load: engineUnavailable ? null : engine.startLoad,
    samples,
  });

  stage('footprint');
  if (rootDir) result.footprint = await measureFootprint(rootDir);

  stage('done');
  result.markdown = renderReport(result);
  return result;
}

/** Any engine call may fail; a failed stage is recorded, never thrown. */
async function safe(fn) {
  if (typeof fn !== 'function') return { skipped: true, reason: 'not measured by this engine' };
  try {
    const v = await fn();
    return v ?? { skipped: true, reason: 'the engine returned nothing' };
  } catch (err) {
    return { skipped: true, reason: `failed: ${String(err?.message ?? err)}` };
  }
}

async function measureAsr(engine, stage) {
  const fixtures = await safeList(() => engine.listFixtures?.());
  if (!fixtures.length) return { skipped: true, reason: 'no fixture audio was available' };

  const runs = [];
  for (const f of fixtures) {
    for (const condition of f.conditions ?? ['clean']) {
      stage('asr', `${f.name} (${condition})`);
      try {
        const got = await engine.transcribe({ fixture: f.name, condition });
        const scored = wordErrorRate(f.reference, got?.text ?? '');
        runs.push({ fixture: f.name, lang: f.lang ?? null, condition, ...scored, audioMs: got?.audioMs ?? null, processingMs: got?.processingMs ?? null });
      } catch (err) {
        runs.push({ fixture: f.name, condition, failed: String(err?.message ?? err) });
      }
    }
  }
  return { skipped: false, runs };
}

async function measureRtf(engine, stage) {
  try {
    stage('rtf', 'one stream');
    const one = await engine.measureRtf({ streams: 1 });
    stage('rtf', 'two streams');
    const two = await engine.measureRtf({ streams: 2 });
    return {
      skipped: false,
      oneStream: realTimeFactor(one) ?? one?.rtf ?? null,
      twoStreams: realTimeFactor(two) ?? two?.rtf ?? null,
      raw: { one, two },
    };
  } catch (err) {
    return { skipped: true, reason: `failed: ${String(err?.message ?? err)}` };
  }
}

async function safeList(fn) {
  if (typeof fn !== 'function') return [];
  try { const v = await fn(); return Array.isArray(v) ? v : []; } catch { return []; }
}

/**
 * Persist a run. The report survives the modal it was rendered in — a ward
 * who closes the window before copying it has not lost their measurement.
 */
export async function saveReport({ rootDir, result, now = new Date() }) {
  const dir = path.join(rootDir, 'logs');
  const stamp = now.toISOString().slice(0, 10);
  await fs.mkdir(dir, { recursive: true });
  const jsonPath = path.join(dir, `voice-bench-${stamp}.json`);
  const mdPath = path.join(dir, `voice-bench-${stamp}.md`);
  const { markdown, ...data } = result;
  await fs.writeFile(jsonPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.writeFile(mdPath, markdown ?? renderReport(result), 'utf8');
  return { jsonPath, mdPath };
}
