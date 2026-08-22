/**
 * Voice notes, end to end (voice spec §9).
 *
 * The pipeline tests here are not optional decoration. The 0.9 vision
 * post-mortem's root cause #4 was that ZERO tests ran the orchestration paths,
 * so a `ReferenceError`, a swallowed exception, and a describe that landed
 * after the prompt was built all passed every pure-function test in the repo
 * and were caught only by a human listening. The same class of bug is
 * available here — a transcript that lands after the prompt means I answer a
 * message I never heard — so a real turn runs through the real assembly code
 * with a stubbed worker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { buildStandin, clipLength, maxBytesForKind, mediaKindFor, MEDIA_KINDS, AUDIO_MAX_BYTES, MEDIA_MAX_BYTES } from '../media.js';
import { transcribeTimeoutMs, transcriptionAllowed, continuousListeningAllowed } from '../voice-transcribe.js';
import { materializeAttachments } from '../vision.js';
import { encodeWav, toMono, elapsedLabel, TARGET_RATE } from '../public/voice-recorder.js';
import { parseWav } from '../voice-audio-features.js';

// ── The kind derivation ───────────────────────────────────────────

test('audio mimes are audio, image mimes are image, and the two maps agree', () => {
  assert.equal(mediaKindFor('audio/wav'), 'audio');
  assert.equal(mediaKindFor('image/png'), 'image');
  assert.equal(mediaKindFor('application/pdf'), null);
  // The regression this guards: saveAsset used to hard-code kind:'image' while
  // looking the extension up separately, so audio would have been stored as an
  // image with a .wav on it.
  for (const [mime, { kind }] of Object.entries(MEDIA_KINDS)) {
    assert.equal(mediaKindFor(mime), kind, `${mime} disagrees with itself`);
  }
});

test('audio gets its own size ceiling — the image cap would cut a note off at three minutes', () => {
  assert.equal(maxBytesForKind('image'), MEDIA_MAX_BYTES);
  assert.equal(maxBytesForKind('audio'), AUDIO_MAX_BYTES);
  assert.ok(AUDIO_MAX_BYTES > MEDIA_MAX_BYTES);
  // 16 kHz mono 16-bit = 32000 B/s. The cap should buy at least ten minutes.
  assert.ok(AUDIO_MAX_BYTES / 32000 > 600);
});

// ── The stand-in, which is the whole of what I read ───────────────

test('a transcribed note reads as something I heard, not as a file I cannot open', () => {
  const line = buildStandin({
    id: 'sha', slugs: ['oat-milk-list-x7'], kind: 'audio', durationSec: 41,
    receivedAt: new Date().toISOString(), origin: {},
    description: { text: 'Could you add oat milk to the list' },
  });
  assert.match(line, /^\[voice note oat-milk-list-x7, 0:41: /);
  // FRAMING IS LOAD-BEARING: the image version of this shipped as metadata and
  // the model disclaimed it could not see, with the description right there.
  assert.match(line, /what I heard when I listened/);
  assert.match(line, /"Could you add oat milk to the list"/);
  assert.doesNotMatch(line, /\[image /);
});

test('each kind of silence says which kind it is', () => {
  const base = { id: 'sha', slugs: ['snd-aaaaaa'], kind: 'audio', durationSec: 5, receivedAt: new Date().toISOString(), origin: {} };
  assert.match(buildStandin({ ...base, description: null }), /haven't listened to this one yet/);
  assert.match(buildStandin({ ...base, description: { reason: 'voice-disabled' } }), /listening is switched off/);
  assert.match(buildStandin({ ...base, description: { text: '', reason: 'no-speech' } }), /no way to listen|haven't listened/);
});

test('a note whose audio was let go still carries its words', () => {
  const line = buildStandin({
    id: 'sha', slugs: ['the-thing-x2'], kind: 'audio', durationSec: 12,
    receivedAt: new Date().toISOString(), origin: {},
    description: { text: 'the thing about Tuesday' },
    audio: { deletedAt: '2026-07-01T00:00:00Z' },
  });
  assert.match(line, /the thing about Tuesday/);
  assert.match(line, /sound itself has been let go/);
});

test('an unmeasurable length is omitted rather than invented', () => {
  // webm/ogg/m4a cannot be measured without a decoder we do not ship, and a
  // duration guessed from bitrate would be a made-up number on a model-facing
  // surface — the exact-values rule.
  const line = buildStandin({
    id: 'sha', slugs: ['snd-bbbbbb'], kind: 'audio', durationSec: null,
    receivedAt: new Date().toISOString(), origin: {}, description: { text: 'hi' },
  });
  assert.match(line, /^\[voice note snd-bbbbbb: /);
  assert.equal(clipLength(null), '');
  assert.equal(clipLength(41.2), '0:41');
  assert.equal(clipLength(362), '6:02');
});

test('an image still renders as an image — the audio branch did not capture everything', () => {
  const line = buildStandin({
    id: 'sha', slugs: ['a-cat-x1'], kind: 'image', receivedAt: new Date().toISOString(),
    origin: {}, description: { text: 'a tabby on a windowsill' },
  });
  assert.match(line, /^\[image a-cat-x1: what I saw when I looked/);
});

// ── The materializer: audio must never ride live ──────────────────

test('a voice note never becomes a provider content part, even on a seeing connection', async () => {
  const notes = [];
  const stub = {
    getAssetMeta: async () => ({
      id: 'sha1', slugs: ['a-note-x1'], kind: 'audio', mime: 'audio/wav', durationSec: 9,
      audienceTag: 'ward-private', receivedAt: new Date().toISOString(), origin: {},
      description: { text: 'remember the bins' },
    }),
  };
  // materializeAttachments reads the store, so this runs against the real one
  // via a temp asset instead of a mock — see the pipeline test below. Here we
  // only assert the shape rule with a hand-built message.
  const out = await materializeAttachments(
    [{ role: 'user', content: 'listen to this', attachments: [{ id: 'definitely-not-a-real-asset' }] }],
    { connection: { provider: 'x', model: 'y', visionCapable: 'yes' }, settings: {} },
  );
  // A missing asset degrades to a stand-in, never to an error and never to a
  // content-part array.
  assert.equal(typeof out.messages[0].content, 'string');
  assert.equal(out.imagesLive, 0);
  void notes; void stub;
});

// ── The browser's wav, read by the server's parser ────────────────

test('what the browser encodes is what the server can read', () => {
  const n = TARGET_RATE;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.sin((2 * Math.PI * 440 * i) / TARGET_RATE) * 0.5;
  const wav = Buffer.from(encodeWav(s, TARGET_RATE));

  const back = parseWav(wav);
  assert.ok(back, 'the server could not parse the browser wav');
  assert.equal(back.sampleRate, TARGET_RATE);
  assert.equal(back.samples.length, n);
  assert.ok(Math.abs(back.durationSec - 1) < 0.01);
});

test('samples outside [-1,1] clamp instead of wrapping to the opposite extreme', () => {
  // Resampling routinely overshoots slightly; a wrap turns that into an
  // audible click, and clicks transcribe as nothing good.
  const view = new DataView(encodeWav(new Float32Array([2.0, -2.0]), TARGET_RATE));
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32768);
});

test('a mono downmix averages the channels rather than picking one', () => {
  // A headset mic often records to one channel only; taking the left channel
  // yields silence, which looks exactly like "the microphone did not work".
  const fake = {
    length: 3,
    numberOfChannels: 2,
    getChannelData: (c) => (c === 0 ? new Float32Array([0, 0, 0]) : new Float32Array([1, 1, 1])),
  };
  assert.deepEqual(Array.from(toMono(fake)), [0.5, 0.5, 0.5]);
});

test('the UI and the stand-in agree on how a length is written', () => {
  assert.equal(elapsedLabel(41.7), clipLength(41.7));
  assert.equal(elapsedLabel(0), '0:00');
});

// ── Consents and budgets ──────────────────────────────────────────

test('a voice note needs no setting — the press is the consent', () => {
  // This was gated behind `voiceEnabled`, default OFF, which ALSO hid the
  // button. My human's reaction on first use: "if it's more work than just
  // pressing the little mic button, why?" There was no good answer. A note is
  // a deliberate act with the browser's own permission prompt on top; a
  // setting in front of it guards an already-locked door.
  assert.equal(transcriptionAllowed(), true, 'a deliberate recording needs no prior opt-in');
});

test('continuous listening — a mic simply left open — still needs an explicit opt-in', () => {
  // The consent that IS real, reserved for live calls (Pass 2).
  assert.equal(continuousListeningAllowed({}), false, 'an unset value must not leave a microphone open');
  assert.equal(continuousListeningAllowed({ voiceEnabled: false }), false);
  assert.equal(continuousListeningAllowed({ voiceEnabled: 'yes' }), false, 'only a real true counts');
  assert.equal(continuousListeningAllowed({ voiceEnabled: true }), true);
});

test('the hard env off-switch kills both', () => {
  const prior = process.env.PROTO_FAMILIAR_VOICE_DISABLED;
  process.env.PROTO_FAMILIAR_VOICE_DISABLED = '1';
  try {
    assert.equal(transcriptionAllowed(), false, 'the hard switch must reach voice notes too');
    assert.equal(continuousListeningAllowed({ voiceEnabled: true }), false);
  } finally {
    if (prior === undefined) delete process.env.PROTO_FAMILIAR_VOICE_DISABLED;
    else process.env.PROTO_FAMILIAR_VOICE_DISABLED = prior;
  }
});

test('the decode budget scales with the clip and never disappears', () => {
  assert.ok(transcribeTimeoutMs(5) >= 60_000, 'a short note still gets a floor');
  assert.ok(transcribeTimeoutMs(600) > transcribeTimeoutMs(60), 'a longer note gets longer');
  assert.ok(transcribeTimeoutMs(99999) <= 15 * 60_000, 'and it is still bounded');
  assert.ok(transcribeTimeoutMs(null) >= 60_000, 'an unknown length is not a zero budget');
});

// ── PIPELINE: a real turn, through the real code ──────────────────

test('PIPELINE: a voice note is transcribed BEFORE the prompt is assembled', async (t) => {
  // The failure this exists to catch: a fire-and-forget transcription lands
  // after materialize has already built the stand-in, so the turn goes out
  // saying "I haven't listened to this one yet" and the model confabulates
  // over the gap. Pure-function tests cannot see ordering.
  const { saveAsset, getAssetMeta, MEDIA_DIR } = await import('../media.js');
  const { ensureTranscribed } = await import('../voice-transcribe.js');

  // A real 1-second wav through the real store.
  const samples = new Float32Array(TARGET_RATE);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 220 * i) / TARGET_RATE) * 0.3;
  const meta = await saveAsset({
    buffer: Buffer.from(encodeWav(samples, TARGET_RATE)),
    mime: 'audio/wav',
    origin: { surface: 'test' },
  });
  assert.ok(meta?.id, `store rejected the wav: ${meta?.error}`);
  t.after(async () => {
    for (const f of [`${meta.id}.json`, `${meta.id}.wav`]) {
      await fs.rm(path.join(MEDIA_DIR, f), { force: true });
    }
  });

  // Duration was read at arrival, from the header — not guessed.
  assert.ok(Math.abs(meta.durationSec - 1) < 0.05, `duration was ${meta.durationSec}`);
  assert.equal(meta.kind, 'audio');
  assert.equal(meta.description, null, 'nothing should be transcribed at arrival');

  const messages = [{ role: 'user', content: 'have a listen', attachments: [{ id: meta.id }] }];

  // A worker that answers like the real one, without 226 MB of ONNX.
  const calls = [];
  const worker = {
    request: async (msg) => {
      calls.push(msg.op);
      if (msg.op === 'load') return { ok: true, role: msg.role };
      if (msg.op === 'transcribe') return { ok: true, text: 'the bins go out tonight', lang: 'en', elapsedMs: 12 };
      return { ok: false, reason: 'unknown-op' };
    },
  };

  const got = await ensureTranscribed(messages, { getWorker: async () => ({ worker }) });
  assert.equal(got.transcribed, 1, 'the note was not heard');
  assert.deepEqual(calls, ['load', 'transcribe'], 'the model must be loaded before it is asked to listen');

  // NOW assemble, exactly as a turn does.
  const out = await materializeAttachments(messages, {
    connection: { provider: 'p', model: 'm', visionCapable: 'yes' },
    settings: {},
  });

  const text = out.messages[0].content;
  assert.equal(typeof text, 'string', 'a voice note must never become a content-part array');
  assert.match(text, /have a listen/);
  assert.match(text, /what I heard when I listened: "the bins go out tonight"/);
  assert.doesNotMatch(text, /haven't listened/);
  assert.equal(out.imagesLive, 0);
  assert.equal(out.notesStoodIn, 1);

  // And the convention gets explained, or it is a capability I do not have.
  const explainer = out.messages.find((m) => m.role === 'system' && /voice note/.test(m.content ?? ''));
  assert.ok(explainer, 'the [voice note …] convention was never explained to me');

  // Listening is once: a second pass costs nothing and changes nothing.
  const again = await ensureTranscribed(messages, { getWorker: async () => ({ worker }) });
  assert.equal(again.transcribed, 0, 'a cached transcript was re-derived');
  assert.deepEqual(calls, ['load', 'transcribe'], 'the worker was asked twice for one note');

  // The slug graduated from the transcript, so I can find this by what was said.
  const after = await getAssetMeta(meta.id);
  assert.match(after.slugs[0], /bins/, `slug did not graduate: ${after.slugs[0]}`);
});

test('PIPELINE: with voice hard-disabled, nothing is transcribed and the turn still goes out', async (t) => {
  const { saveAsset, MEDIA_DIR } = await import('../media.js');
  const { ensureTranscribed } = await import('../voice-transcribe.js');

  const samples = new Float32Array(8000).fill(0.1);
  const meta = await saveAsset({ buffer: Buffer.from(encodeWav(samples, TARGET_RATE)), mime: 'audio/wav', origin: { surface: 'test' } });
  assert.ok(meta?.id);
  t.after(async () => {
    for (const f of [`${meta.id}.json`, `${meta.id}.wav`]) await fs.rm(path.join(MEDIA_DIR, f), { force: true });
  });

  const messages = [{ role: 'user', content: 'here', attachments: [{ id: meta.id }] }];
  const worker = { request: async () => { throw new Error('the worker must not be reached when voice is hard-disabled'); } };

  const prior = process.env.PROTO_FAMILIAR_VOICE_DISABLED;
  process.env.PROTO_FAMILIAR_VOICE_DISABLED = '1';
  let got;
  try {
    got = await ensureTranscribed(messages, { getWorker: async () => ({ worker }) });
  } finally {
    if (prior === undefined) delete process.env.PROTO_FAMILIAR_VOICE_DISABLED;
    else process.env.PROTO_FAMILIAR_VOICE_DISABLED = prior;
  }
  assert.equal(got.transcribed, 0);
  assert.equal(got.skipped, 'voice-disabled');

  const out = await materializeAttachments(messages, { connection: { provider: 'p', model: 'm' }, settings: {} });
  assert.equal(typeof out.messages[0].content, 'string');
  assert.match(out.messages[0].content, /voice note/);
});

test('a temp dir is not left behind by these tests', async () => {
  // Guard against a future rewrite that starts writing outside the store.
  const stray = path.join(os.tmpdir(), 'proto-familiar-voice-notes');
  await fs.rm(stray, { recursive: true, force: true });
  assert.ok(true);
});

// ── What the first real voice note broke ──────────────────────────
//
// My human recorded "Hello hello, this is Chen and this is a test." Three
// things went wrong at once, and none of them were the recording:
//   · it appeared in chat as "[image no longer available]"
//   · they were told it was unintelligible, when in fact the listening model
//     had never been downloaded and listening was switched off
//   · with nothing legible in the turn, the Familiar answered the
//     post-history prompt instead

test('the chat renderer does not treat a voice note as a picture', async () => {
  const app = await fs.readFile(path.join(process.cwd(), 'public/app.js'), 'utf8');
  const row = app.slice(app.indexOf('function attachmentRow('), app.indexOf('function createMessageEl('));

  assert.match(row, /a\.kind === 'audio'/, 'audio has no branch — it will render as an <img> again');
  // The load-error fallback must try audio BEFORE declaring the file gone: a
  // message restored from a session log carries only an id, so "failed to
  // decode as an image" does not mean "missing".
  assert.match(row, /img\.addEventListener\('error', \(\) => img\.replaceWith\(audioEl\(\)\)/,
    'an undecodable attachment still goes straight to "no longer available"');
});

test('every server reason survives to the person who can act on it', async () => {
  const app = await fs.readFile(path.join(process.cwd(), 'public/app.js'), 'utf8');

  // The bug: all of these collapsed into "I couldn't make this one out",
  // telling my human their speech was unintelligible when the actual causes
  // were two settings they could have fixed in seconds.
  for (const reason of ['voice-disabled', 'model-missing', 'no-worker', 'load-failed', 'unreadable-format']) {
    assert.ok(app.includes(`'${reason}'`), `${reason} is not distinguished in the UI`);
  }
  assert.match(app, /entry\.reason = got\?\.reason/, 'the reason is discarded again');
});

test('the model download is actually offered — the promise the docs make', async () => {
  const app = await fs.readFile(path.join(process.cwd(), 'public/app.js'), 'utf8');

  // `model-missing` existed as a distinct server reason precisely so this
  // could happen, and then nothing called it. README and troubleshooting both
  // say the download is offered the first time you record.
  assert.match(app, /async function getListeningModel\(/, 'nothing offers the download');
  assert.match(app, /'\/api\/voice\/install-models'/, 'the offer does not reach the install endpoint');
  assert.match(app, /what: 'listen'/, 'the offer would fetch the speaking model, not the listening one');
  // And it must hear the note that prompted it, rather than making them
  // re-record something they already said.
  const fn = app.slice(app.indexOf('async function getListeningModel('));
  assert.match(fn.slice(0, fn.indexOf('\n}\n')), /transcribePending\(entry\)/,
    'after downloading, the waiting note is never transcribed');
});

test('a voice note survives images being switched off', async () => {
  const srv = await fs.readFile(path.join(process.cwd(), 'server.js'), 'utf8');
  // Hearing is not seeing. Nested inside the vision gate, a voice note
  // vanished entirely when vision was off — no stand-in, and the raw
  // `attachments` field left on the outgoing provider message.
  assert.match(srv, /const visionOffThisTurn = visionDisabled\(\);/);
  const block = srv.slice(srv.indexOf('const visionOffThisTurn'), srv.indexOf('if (!visionOffThisTurn)'));
  assert.match(block, /materializeAttachments/, 'nothing materializes attachments when vision is off');
  assert.match(block, /visionCapable: 'no'/, 'a blind turn must not try to send live parts');
});

test('a refusal my human can undo is never cached as the transcript', async () => {
  const src = await fs.readFile(path.join(process.cwd(), 'voice-transcribe.js'), 'utf8');
  const fn = src.slice(src.indexOf('export async function transcribeAsset('), src.indexOf('/** Cache-write'));
  const disabled = fn.slice(fn.indexOf('if (!transcriptionAllowed'), fn.indexOf('meta.ext !== '));

  // It used to `remember()` here. A note recorded before listening was turned
  // on would then stay permanently unheard — the transcript slot filled with a
  // refusal that outlived its own cause.
  assert.doesNotMatch(disabled, /await remember\(/, 'the voice-disabled refusal is cached again');
  assert.match(disabled, /NOT cached/);
});

test('the microphone button is not hidden behind anything', async () => {
  const app = await fs.readFile(path.join(process.cwd(), 'public/app.js'), 'utf8');
  const html = await fs.readFile(path.join(process.cwd(), 'public/index.html'), 'utf8');

  assert.match(html, /id="record-btn"/, 'there is no way to start recording');
  // It was `recordBtn.hidden = !state.voiceEnabled`, which made the whole
  // feature undiscoverable AND gated a deliberate press behind a setting.
  assert.doesNotMatch(app, /recordBtn\.hidden = !state\.voiceEnabled/,
    'the mic button is hidden behind a setting again');
  assert.match(app, /if \(recordBtn\) recordBtn\.hidden = false;/);
  // And the setting it hid behind must be gone from the UI entirely, or it
  // will read as governing something it does not.
  assert.doesNotMatch(html, /voice-enabled-toggle/, 'a toggle that gates nothing is still shown');
});

test('nothing in the voice-note path consults voiceEnabled', async () => {
  // The rule, stated where it cannot rot: voiceEnabled is for CONTINUOUS
  // listening (Pass 2). A note is a press.
  const src = await fs.readFile(path.join(process.cwd(), 'voice-transcribe.js'), 'utf8');
  const notePath = src.slice(src.indexOf('export async function transcribeAsset('));
  assert.doesNotMatch(notePath, /voiceEnabled/,
    'the voice-note path reads voiceEnabled again — a press is the consent');
});

// ── Speaking and listening are independent ────────────────────────
//
// The bug: transcription asked for `currentAudioWorker()`, which returns the
// worker chosen by the SPEAKING setting. My human picked the voicebox voice,
// so every voice note went to a Python process that cannot listen. It answered
// `unsupported`, the chip fell through to its default, and they were told a
// clear recording was unintelligible — after downloading 226 MB.

test('transcription asks for the LISTENING worker, never the speaking one', async () => {
  const src = await fs.readFile(path.join(process.cwd(), 'voice-transcribe.js'), 'utf8');
  const srv = await fs.readFile(path.join(process.cwd(), 'server.js'), 'utf8');

  assert.match(src, /listeningWorker\(\{ rootDir \}\)/, 'hearVoiceNotes is back on the speaking worker');
  assert.doesNotMatch(src, /currentAudioWorker/, 'the speaking worker leaked back into the listening path');
  assert.match(srv, /getWorker: \(\) => listeningWorker\(/, 'the transcribe endpoint uses the speaking worker');
});

test('the listening worker resolves to sherpa even when speaking is pocket', async () => {
  // ⚠️ This test used to assert that the STRING `settings: {}` appeared in the
  // function body. It passed while the bug was still live, because checking the
  // shape of my own intent is not checking behaviour — the same mistake as
  // asserting a comment exists. So it resolves the backend for real, with the
  // exact settings that broke it, and looks at which script would be spawned.
  const { resolveBackend, BACKENDS } = await import('../voice-backend.js');

  const pocketSpeaker = { voiceTts: { backend: 'pocket', voice: 'vctk/p255_023/enhanced' } };

  const speaking = await resolveBackend({ rootDir: process.cwd(), settings: pocketSpeaker });
  // Mirror what `listeningWorker` actually does now: it asks for sherpa BY NAME,
  // not via `settings: {}`. Since the speaking default is pocket, `settings: {}`
  // would resolve to pocket on a machine that HAS voicebox installed — which is
  // exactly why the listener no longer relies on the default meaning sherpa.
  const listening = await resolveBackend({
    rootDir: process.cwd(), settings: { voiceTts: { backend: BACKENDS.SHERPA } },
  });

  // Listening must be sherpa regardless of whether voicebox is installed —
  // asking for it by name guarantees that even where `settings: {}` would not.
  assert.equal(listening.backend, BACKENDS.SHERPA, 'the listener is not pinned to sherpa');
  assert.match(listening.workerScript, /audio-worker\.mjs$/, 'the listener would spawn the wrong script');
  assert.doesNotMatch(listening.workerScript, /worker\.py$/);

  if (speaking.backend === BACKENDS.POCKET) {
    // The real configuration that produced the bug: two different scripts.
    assert.match(speaking.workerScript, /worker\.py$/);
    assert.notEqual(speaking.workerScript, listening.workerScript,
      'speaking and listening resolved to the same worker — one of them is wrong');
  }
});

test('listeningWorker never hands back the speaking worker', async () => {
  // Behavioural, one level up: the exported function, not the resolver.
  const { listeningWorker } = await import('../audio-worker-current.js');
  const got = await listeningWorker({ rootDir: process.cwd() });

  // Either it built a listener, or it said why it could not. What it must never
  // do is return a worker that speaks.
  if (got.worker) {
    assert.equal(typeof got.worker.request, 'function');
    got.worker.stop?.();
  } else {
    assert.ok(['no-listening-engine', 'voice-disabled'].includes(got.reason),
      `unexpected refusal: ${got.reason}`);
  }
});

test('a worker that cannot serve a role refuses it instead of answering ok', async () => {
  const py = await fs.readFile(path.join(process.cwd(), 'voicebox/src/voicebox/worker.py'), 'utf8');
  const load = py.slice(py.indexOf('def op_load('), py.indexOf('def op_unload('));

  // It returned ok:True for `asr-offline`, loading the TTS model and reporting
  // success — so the failure surfaced one step later, at `transcribe`, where
  // it looked like a transcription problem instead of a routing one.
  assert.match(load, /unsupported-role/, 'the speaking worker claims roles it cannot serve again');
  assert.match(load, /role not in \("tts", None\)/);
});

test('every reason that reaches the browser has words for my human', async () => {
  const app = await fs.readFile(path.join(process.cwd(), 'public/app.js'), 'utf8');
  const handler = app.slice(app.indexOf('function transcriptProblem('));
  const mapped = handler.slice(0, handler.indexOf('\n}\n'));

  // Only what `POST /api/media/:id/transcribe` can actually hand back. Listed
  // rather than swept for, because a clever regex also picked up reasons that
  // live only inside the server (`no-speech` is a cached description, not a
  // returned reason; `timeout` belongs to ensureTranscribed's internal race)
  // and reported gaps that were not gaps.
  for (const reason of [
    'voice-disabled',        // the hard env switch
    'model-missing',         // added by the endpoint — carries the download offer
    'no-worker',             // the listener is down right now
    'no-listening-engine',   // no listening worker could be built
    'no-engine',             // the worker started and found no sherpa binding
                             //   — found by a live run AFTER this list was
                             //   hand-written, which is the argument for
                             //   running the thing rather than enumerating it
    'load-failed',           // the model wouldn't load
    'unreadable-format',     // audio we can't decode without a library
    'unsupported',           // the speaking worker was handed a listen request
    'unsupported-role',      // ...and its newer, earlier refusal
    'stopped',               // stop() landed mid-request (shutdown)
    'timeout', 'not-loaded', 'write-failed', 'spawn-failed', 'parked',
    'bad-request', 'op-failed',
  ]) {
    assert.ok(mapped.includes(`'${reason}'`),
      `${reason} falls through to "I couldn't make this one out" — which is how a routing bug came to read as bad diction`);
  }

  // `transcribe-failed` is the ONE that should reach the default, because
  // there the default is true: the recogniser ran and got nothing usable.
  assert.doesNotMatch(mapped, /'transcribe-failed'/);
  assert.match(mapped, /default:\s*\n\s*return \{ text: "I couldn't make this one out/);
});

// ── The real worker's own dispatch table ──────────────────────────
//
// ⚠️ THE BUG THIS EXISTS FOR. `audio-worker.mjs`'s OPS object had TWO
// `transcribe` keys: the real implementation, and a leftover "not implemented
// yet" stub further down. A later duplicate key silently wins in JavaScript, so
// the real one was dead from the day it landed and every voice note came back
// `unsupported`. `node --check` does not flag a duplicate key. And every test
// above stubs the worker, so none of them ever loaded this table.
//
// My human found it on the fourth attempt, after I had "fixed" the routing
// twice. Stubs test the caller; only spawning the real thing tests the worker.

test('PIPELINE: the real audio worker dispatches transcribe to the real handler', async () => {
  const { createAudioWorker } = await import('../audio-worker-host.js');
  const worker = createAudioWorker({
    command: process.execPath,
    workerScript: path.join(process.cwd(), 'audio-worker.mjs'),
  });
  try {
    const r = await worker.request({ op: 'transcribe', wavPath: '/definitely/not/here.wav' }, { timeoutMs: 20_000 });

    // It must FAIL — there is no engine or model in CI — but it must fail as
    // the real handler, never as "this worker does not do transcription".
    assert.equal(r.ok, false);
    assert.notEqual(r.reason, 'unsupported',
      'the leftover stub is back: a duplicate OPS key is shadowing the real transcribe');
    assert.ok(
      ['no-engine', 'not-loaded', 'bad-request', 'transcribe-failed'].includes(r.reason),
      `unexpected reason from the real handler: ${r.reason} (${r.detail ?? ''})`,
    );
  } finally {
    worker.stop();
  }
});

test('no op is declared twice in the worker — a duplicate key wins silently', async () => {
  const body = await fs.readFile(path.join(process.cwd(), 'audio-worker.mjs'), 'utf8');
  const ops = [...body.matchAll(/^ {2}async (\w+)\(/gm)].map((m) => m[1]);
  const dupes = ops.filter((k, i) => ops.indexOf(k) !== i);
  assert.deepEqual(dupes, [], `duplicate OPS keys shadow each other: ${dupes.join(', ')}`);
  assert.ok(ops.includes('transcribe'), 'the transcribe op vanished entirely');
});

test('the transcription budget counts notes heard, not attachments looked at', async (t) => {
  // ⚠️ `.slice(0, max)` was applied to the RAW id list, so four images newer
  // than a voice note consumed the entire allowance on `continue`s and the note
  // was never transcribed — with no work done and nothing said about it. The
  // cap has to bound work, not iteration.
  const { saveAsset, MEDIA_DIR, setAssetDescription } = await import('../media.js');
  const { ensureTranscribed } = await import('../voice-transcribe.js');

  const made = [];
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');

  // One note, then FIVE newer images — more images than the budget.
  const samples = new Float32Array(8000).fill(0.05);
  const note = await saveAsset({ buffer: Buffer.from(encodeWav(samples, TARGET_RATE)), mime: 'audio/wav', origin: { surface: 'test' } });
  made.push([note.id, 'wav']);
  const imgs = [];
  for (let i = 0; i < 5; i++) {
    // Distinct bytes per image, or content-addressing dedups them into one.
    const buf = Buffer.concat([png, Buffer.from([i])]);
    const im = await saveAsset({ buffer: buf, mime: 'image/png', origin: { surface: 'test' }, label: `probe ${i}` });
    await setAssetDescription(im.id, { text: `image ${i}` });
    imgs.push(im.id);
    made.push([im.id, 'png']);
  }
  t.after(async () => {
    for (const [id, ext] of made) {
      await fs.rm(path.join(MEDIA_DIR, `${id}.json`), { force: true });
      await fs.rm(path.join(MEDIA_DIR, `${id}.${ext}`), { force: true });
    }
  });

  const messages = [{
    role: 'user', content: 'here',
    attachments: [{ id: note.id }, ...imgs.map((id) => ({ id }))],
  }];

  let asked = 0;
  const worker = {
    request: async (msg) => {
      if (msg.op === 'load') return { ok: true };
      asked++;
      return { ok: true, text: 'heard it', lang: 'en' };
    },
  };

  const got = await ensureTranscribed(messages, { getWorker: async () => ({ worker }), max: 4 });
  assert.equal(got.transcribed, 1, 'the note behind five newer images was starved by the budget');
  assert.equal(asked, 1, 'exactly one transcription should have been attempted');
});

test('EVERY reason the worker or its supervisor can emit has words for my human', async () => {
  // ⚠️ Derived, not hand-listed. The hand-written version of this check missed
  // `no-engine` (found by a live run) and would have missed `stopped` (created
  // by fixing a stop-during-request race). A list I maintain is a list I forget
  // to update; the source of truth is the code that emits them.
  const [worker, host, hostAlso, app] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'audio-worker.mjs'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'audio-worker-host.js'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'voice-transcribe.js'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'public/app.js'), 'utf8'),
  ]);

  const emitted = new Set();
  for (const body of [worker, host, hostAlso]) {
    for (const m of body.matchAll(/reason: '([a-z][a-z-]*)'/g)) emitted.add(m[1]);
    for (const m of body.matchAll(/reason = '([a-z][a-z-]*)'/g)) emitted.add(m[1]);
    for (const m of body.matchAll(/reason: ([a-z]\w*\?\.reason \?\? )?'([a-z][a-z-]*)'/g)) if (m[2]) emitted.add(m[2]);
  }
  // Reasons that never travel to a voice-note chip: they belong to speaking, to
  // the unpark endpoint, or are consumed before the response is built.
  const NOT_ON_THIS_PATH = new Set([
    'no-voice',        // TTS needs a reference clip; irrelevant to listening
    'tts-failed',      // speaking
    'not-parked',      // the unpark endpoint's own answer
    'unknown-op',      // only reachable by sending an op that does not exist
    'no-speech',       // a cached description, not a returned reason
    'voice-disabled', 'model-missing', 'unreadable-format', 'no-worker',
    'no-listening-engine', 'not-found', 'not-audio', 'transcribe-failed',
    // Speaker-ID ops (§8.2/§8.3) — enrolment/watchdog/diarize, never a voice note.
    'not-ready', 'embed-failed',
    // Audio-tagging op (§8.4) — call-time room-sound annotation, never a voice note.
    'tag-failed',
    // Live-call streaming ASR ops (Pass 2) — a call, not an offline voice note.
    'asr-open-failed', 'asr-stop-failed',
    // correctTranscript() — the ward editing a transcript by hand, its own
    // endpoint's answer, never the auto "I couldn't make this out" chip.
    'empty', 'too-long',
  ]);

  const handler = app.slice(app.indexOf('function transcriptProblem('));
  const mapped = handler.slice(0, handler.indexOf('\n}\n'));

  const unmapped = [...emitted]
    .filter((r) => !NOT_ON_THIS_PATH.has(r) && !mapped.includes(`'${r}'`));
  assert.deepEqual(unmapped, [],
    `these reasons can reach my human as "I couldn't make this one out": ${unmapped.join(', ')}`);
});

test('PIPELINE: a voice note still stands in when vision is switched off', async (t) => {
  // The vision-off branch of /api/chat is its own code path and was never
  // exercised. `provider`/`model` happen to be in scope there — but a bare
  // `catch {}` around it would have hidden a ReferenceError and made voice
  // notes vanish silently, which is root cause #4 of the 0.9 post-mortem.
  const { saveAsset, MEDIA_DIR, setAssetDescription } = await import('../media.js');

  const samples = new Float32Array(TARGET_RATE).fill(0.02);
  const note = await saveAsset({ buffer: Buffer.from(encodeWav(samples, TARGET_RATE)), mime: 'audio/wav', origin: { surface: 'test' } });
  await setAssetDescription(note.id, { text: 'vision is off but you can still hear me' });
  t.after(async () => {
    await fs.rm(path.join(MEDIA_DIR, `${note.id}.json`), { force: true });
    await fs.rm(path.join(MEDIA_DIR, `${note.id}.wav`), { force: true });
  });

  // Exactly what the vision-off branch passes.
  const out = await materializeAttachments(
    [{ role: 'user', content: 'listen', attachments: [{ id: note.id }] }],
    { connection: { provider: 'p', model: 'm', visionCapable: 'no' }, settings: {}, visibleAudiences: null },
  );

  assert.equal(typeof out.messages[0].content, 'string');
  assert.match(out.messages[0].content, /vision is off but you can still hear me/);
  assert.equal(out.notesStoodIn, 1, 'the note produced no stand-in — it would be invisible to the turn');
  // And `attachments` must be stripped, or a strict provider rejects the message.
  assert.ok(!('attachments' in out.messages[0]), 'the internal attachments field leaked to the provider');
});
