/**
 * The Pass 1 audit findings, each locked so it cannot come back.
 *
 * My human, after the fourth voice-note bug: "how about you do a full audit of
 * your work on the voice spec so we don't have to hunt down ten more small
 * oversights?" This is what that turned up. Every test below names a real
 * defect that was live in shipped code, found by walking the spec against the
 * source rather than by anyone hitting it.
 *
 * The recurring shape: a function written, tested, documented — and never
 * wired to anything. `installVoice()` was the first. It was not the last.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => fs.readFile(path.join(ROOT, f), 'utf8');

// ── A3: the browse-all list was serving the muffled cut ───────────

test('browsing voices offers every voice once, at the best available quality', async () => {
  const { listClips } = await import('../src/voice/voice-clips.js');
  const opts = { rootDir: ROOT, limit: 2000 };

  const best = listClips({ ...opts, variant: 'best' });
  const original = listClips({ ...opts, variant: 'original' });
  const enhanced = listClips({ ...opts, variant: 'enhanced' });

  // The bug: /api/voice/clips passed `variant: 'original'`, so a ward browsing
  // past the curated ten was handed the un-enhanced recording — audibly
  // muffled, and the exact complaint that started the enhanced investigation.
  // A plain 'enhanced' filter is not the fix either: it HIDES the clips
  // upstream never enhanced.
  assert.equal(best.total, original.total, 'best mode drops or duplicates voices');
  assert.ok(enhanced.total < original.total, 'expected some voices to have no enhanced cut');

  const bestEnhanced = best.rows.filter((c) => c.variant === 'enhanced').length;
  assert.equal(bestEnhanced, enhanced.total, 'a voice with an enhanced cut is being offered muffled');

  // Every offered key must actually resolve to a file in the catalogue.
  const all = new Set(listClips({ ...opts, variant: 'any' }).rows.map((c) => c.key));
  for (const row of best.rows) assert.ok(all.has(row.key), `offered a key with no clip: ${row.key}`);
});

test('the endpoint no longer overrides the module default with the wrong value', async () => {
  const srv = await read('server.js');
  assert.doesNotMatch(srv, /variant: req\.query\.variant \|\| 'original'/,
    'the browse list is serving the muffled variant again');
  assert.match(srv, /variant: req\.query\.variant \|\| 'best'/);
});

// ── A1: a README promise with no path through the app ─────────────

test("a ward's own voice clip is reachable, not just implemented", async () => {
  const srv = await read('server.js');
  const app = await read('public/app.js');
  const html = await read('public/index.html');
  const readme = await read('README.md');

  // The README has promised this the whole time.
  assert.match(readme, /voice clip of your own/i);

  // ⚠️ `saveWardVoice` shipped with tests and NO caller — the same shape as
  // `installVoice` before it, in the same file.
  assert.match(srv, /app\.post\('\/api\/voice\/ward-voice'/, 'no endpoint to hand over a clip');
  assert.match(srv, /saveWardVoice\(/, 'the endpoint does not call the function that saves it');
  assert.match(html, /id="voice-own-btn"/, 'no control in the picker');
  assert.match(app, /useMyOwnVoiceClip/, 'the control has no handler');
  // Quote-agnostic: the call site uses a template literal for the query string,
  // and asserting on the quote character rather than the path is how a correct
  // implementation fails a test.
  assert.match(app, /\/api\/voice\/ward-voice/, 'the handler never reaches the endpoint');
});

test('the ward-voice endpoint measures the clip — the import was missing', async () => {
  const srv = await read('server.js');
  // `measureVoiceClip` was called inside a try/catch WITHOUT being imported, so
  // the ReferenceError was swallowed and no clip would ever have been measured.
  // A silent catch around an unimported name is invisible forever.
  assert.match(srv, /measureVoiceClip.*from '[^']*voice-audio-features\.js'/,
    'measureVoiceClip is used but not imported — the catch would hide it');
});

test('listLocalVoices has a surface too', async () => {
  const srv = await read('server.js');
  assert.match(srv, /app\.get\('\/api\/voice\/local'/);
  assert.match(srv, /listLocalVoices\(/);
});

// ── D1: an accessibility feature the spec put in Pass 1 ───────────

test('readAloudByDefault exists — it was spec Pass 1 and had zero references', async () => {
  const app = await read('public/app.js');
  const html = await read('public/index.html');
  const spec = await read('docs/voice-build-spec.md');

  assert.match(spec, /readAloudByDefault/, 'the spec no longer asks for it');

  // It matters most to the people who cannot comfortably read the screen:
  // pressing 🔊 on every message is not an accessible alternative to text.
  assert.match(app, /readAloudByDefault: false/, 'not in state');
  assert.match(app, /'readAloudByDefault'/, 'not synced to the server, so it will not persist');
  assert.match(html, /id="read-aloud-default-toggle"/, 'no way to switch it on');
  assert.match(app, /function speakLatestReply\(/, 'nothing speaks the new reply');
  assert.match(app, /if \(state\.readAloudByDefault\) speakLatestReply\(/,
    'the toggle is not consulted when a turn completes');
  // ...and it must pass the pre-turn baseline, or a failed turn re-reads the
  // PREVIOUS reply aloud, which sounds like the failure having succeeded.
  assert.match(app, /speakLatestReply\(_speakButtonsBeforeTurn\)/,
    'read-aloud-by-default can speak a reply that is not from this turn');

  // Barge-in by typing, also spec'd and also missing.
  assert.match(app, /if \(speech\.audio \|\| speech\.btn\) stopSpeaking\(\);/,
    'typing does not interrupt the reading');
});

test('read-aloud-by-default reuses the button rather than a parallel path', async () => {
  const app = await read('public/app.js');
  const fn = app.slice(app.indexOf('function speakLatestReply('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  // The button owns the download offer, the stop label, and every failure
  // message. A second way to start speaking is a second way to get those wrong.
  assert.match(body, /msg-speak-btn/);
  assert.match(body, /\.click\(\)/);
});

// ── C3: voice notes were uncapped per message ─────────────────────

test('voice notes are capped per message, and the cap matches what I can hear', async () => {
  const app = await read('public/app.js');
  const src = await read('src/voice/voice-transcribe.js');

  // Uncapped, this uploaded before checking anything — twenty notes at up to
  // 24 MB is half a gigabyte from one message, and only the newest four would
  // ever have been transcribed.
  assert.match(app, /VOICE_NOTES_MAX_PER_MESSAGE = (\d+)/);
  const cap = Number(app.match(/VOICE_NOTES_MAX_PER_MESSAGE = (\d+)/)[1]);
  const budget = Number(src.match(/max = (\d+), perNoteTimeoutMs/)[1]);
  assert.equal(cap, budget,
    `the composer accepts ${cap} notes but only ${budget} get transcribed — the excess is accepted and never heard`);

  assert.match(app, /notes >= VOICE_NOTES_MAX_PER_MESSAGE/, 'the cap is declared but not enforced');
});

// ── B: config I could not verify, so stopped relying on ───────────

test('the recogniser states its feature config instead of inheriting one', async () => {
  // Behaviour, not source text: the config the worker feeds sherpa must STATE
  // the 16 kHz / 80-dim fbank rather than inherit it (an absent featConfig may
  // leave the C++ defaults or zero them; a zeroed sample rate produces garbage,
  // not an error). Assert the pure builder's output for every model family,
  // since that is what the worker now wraps (offline-asr-models.js). The old
  // version scraped buildRecognizer's source for the literal and broke the
  // moment the config moved into the shared builder, though nothing real changed.
  const { offlineRecognizerConfig } = await import('../src/voice/offline-asr-models.js');
  const filesByKind = {
    sensevoice: ['model.int8.onnx', 'tokens.txt'],
    whisper:    ['enc-encoder.onnx', 'dec-decoder.onnx', 'tokens.txt'],
    parakeet:   ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'],
  };
  for (const [kind, files] of Object.entries(filesByKind)) {
    const cfg = offlineRecognizerConfig({ kind, files, at: (f) => f });
    assert.deepEqual(cfg.featConfig, { sampleRate: 16000, featureDim: 80 }, `${kind} states featConfig`);
  }
});

// ── The meta-check: no new orphans ────────────────────────────────

test('nothing in the voice surface is documented as working while being unreachable', async () => {
  // Not a general orphan sweep — those have false positives for pure helpers
  // and worker-only code. This is the specific list the audit resolved, so a
  // regression re-breaks a named promise rather than a generic rule.
  const surfaces = (await Promise.all(
    ['server.js', 'public/app.js', 'src/voice/voice-clips.js', 'src/voice/voice-transcribe.js'].map(read),
  )).join('\n');

  for (const [name, promise] of [
    ['saveWardVoice', 'README: a voice clip of your own'],
    ['listLocalVoices', 'the picker marks what is already here'],
    ['preferEnhanced', 'voices are offered at their best quality'],
    ['ensureTranscribed', 'a note is heard before the prompt is built'],
  ]) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(surfaces), `${name} is unreachable again — ${promise}`);
  }
});

// ── The checker itself must stay honest ───────────────────────────

test('the wiring audit runs clean, and the script it runs still exists', async () => {
  // A checker nobody runs is the same as no checker — which is the whole
  // lesson of this milestone, applied to the tool written to catch it.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const pkg = JSON.parse(await read('package.json'));
  assert.ok(pkg.scripts['audit:wiring'], 'npm run audit:wiring is gone, so nobody will run it');

  let out;
  try {
    out = (await run(process.execPath, ['scripts/audit-wiring.mjs'], { cwd: ROOT })).stdout;
  } catch (err) {
    // Non-zero exit means findings; show them rather than a bare failure.
    assert.fail(`the wiring audit found problems:\n${err.stdout ?? err.message}`);
  }
  assert.match(out, /0 finding\(s\)/);
});

// ── Comment and copy accuracy ─────────────────────────────────────

test('the model download prompts quote the download size, not the unpacked one', async () => {
  // ⚠️ The listening model was quoted as ~230 MB in the README, ~158 MB in
  // Settings, and ~230 MB by the installer — 158 is the DOWNLOAD, 233 is the
  // disk figure. The voice had the mirror problem: the button read "Get the
  // voice (194 MB)", its unpacked size, on a label about fetching. Someone
  // short of disk got a different number from every surface.
  //
  // Scoped to the four prompts that name a model download. A blanket sweep of
  // every "N MB" in the repo was tried first and matched upload caps, sidecar
  // parts and an illustrative figure in a comment — three rounds of widening an
  // allowlist, which is the test being wrong rather than the copy.
  const pins = JSON.parse(await read('voice-model-pins.json'));
  const mb = (b) => Math.round(b / 1024 / 1024);
  const dl = { asr: mb(pins['asr-offline'].files[0].bytes), tts: mb(pins['tts-pocket'].files[0].bytes) };
  const disk = { asr: mb(pins['asr-offline'].files[0].diskBytes), tts: mb(pins['tts-pocket'].files[0].diskBytes) };
  assert.notEqual(dl.asr, disk.asr, 'the two figures must differ or this proves nothing');

  const app = await read('public/app.js');
  const html = await read('public/index.html');
  const readme = await read('README.md');
  const ready = await read('scripts/check-voice-ready.mjs');

  // The read-aloud button: download size on a fetch label.
  assert.match(app, new RegExp(`Get the voice \\(${dl.tts} MB\\)`),
    `the button should say ${dl.tts} MB (download), not ${disk.tts} MB (unpacked)`);

  // Every surface that describes the listening download must state BOTH, so
  // neither number can stand alone and be mistaken for the other.
  for (const [name, body] of [['index.html', html], ['README.md', readme], ['check-voice-ready', ready]]) {
    const line = body.split(/\n/).find((l) => new RegExp(`${dl.asr}[^0-9]{0,12}MB`).test(l));
    assert.ok(line, `${name} does not mention the ${dl.asr} MB download at all`);
    assert.ok(new RegExp(`${disk.asr}`).test(line),
      `${name} quotes the download without the ${disk.asr} MB unpacked size: "${line.trim().slice(0, 110)}"`);
  }
});

test('no comment claims a file or function that does not exist', async () => {
  // Two stale names found by sweep: a comment referenced `shippableVoices()`
  // (the function is `shippableSources`) and another the manifest field
  // `upstreamAsset` (it is `upstream.asset`). Both would send a reader looking
  // for something that was never there.
  const cat = await read('src/voice/voice-catalogue.js');
  assert.doesNotMatch(cat, /`shippableVoices\(\)`/, 'stale function name is back');
  assert.match(cat, /`shippableSources\(\)`/);

  const pin = await read('scripts/pin-audio-models.mjs');
  assert.doesNotMatch(pin, /`upstreamAsset`/, 'stale field name is back');

  // The audit script's own header must count its own checks correctly — it
  // said "Five checks" while listing seven.
  const audit = await read('scripts/audit-wiring.mjs');
  const claimed = audit.match(/\* (\w+) checks, each mapping/)?.[1];
  const listed = [...audit.matchAll(/^ \*\s+\d\. /gm)].length;
  const words = { Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 };
  assert.equal(words[claimed], listed, `header claims ${claimed} checks but lists ${listed}`);
});
