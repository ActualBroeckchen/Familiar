import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

/**
 * The path from "fresh install" to "my Familiar speaks" must never require a
 * terminal.
 *
 * This project is built for people with executive dysfunction. "Run this
 * command" is where someone stops — my human proved it by having to do every
 * step by hand across a night. Before this, all nine entry points mentioned
 * voice ZERO times, and the download and the sidecar existed only as CLI
 * commands nobody was told about.
 *
 * These assert the WIRING, not the wording. They fail when a step falls out of
 * a launcher or an endpoint loses its caller — which is exactly how
 * `installVoice()` sat for days with tests and no caller at all.
 */

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

test('npm install alone brings the speech engine', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.optionalDependencies?.['sherpa-onnx-node'],
    'the binding must be a declared dependency, or a fresh install silently has no voice');
});

test('both installers actually run npm install', () => {
  assert.match(read('install.sh'), /npm install/);
  assert.match(read('install.bat'), /npm install/);
});

test('EVERY installer reports whether this machine can speak and listen', () => {
  // sherpa-onnx-node is OPTIONAL, so npm skips it in silence where there is no
  // prebuilt. Without this the install "succeeds" and voice just never works.
  //
  // ⚠️ Discovered, not listed. This test named only install.sh and install.bat,
  // so `scripts/win/install.ps1` — a third, real installer that runs its own
  // `npm install` — shipped without the check, and a Windows user who installed
  // that way was the only one left guessing. Any file that runs npm install
  // must also say whether voice arrived.
  const installers = ['install.sh', 'install.bat', 'scripts/win/install.ps1'];
  for (const f of installers) {
    const body = read(f);
    if (!body) continue;                       // path not present in this checkout
    if (!/npm (install|ci)/.test(body)) continue;   // not an installer
    assert.match(body, /check-voice-ready/, `${f} runs npm install but never reports whether voice works`);
  }
});

test('every updater INVOKES an installer, not merely mentions one', () => {
  // ⚠️ This asserted that the string `install.bat` appeared in update.bat — and
  // it appears in four comments, so the test passed regardless of whether the
  // call existed. Verified by hand instead, which is exactly the work a test is
  // supposed to save. It now requires an actual invocation.
  const stripComments = (body, marker) =>
    body.split('\n').filter((l) => !new RegExp(`^\\s*${marker}`, 'i').test(l)).join('\n');

  assert.match(stripComments(read('update.sh'), '#'), /bash "\$DEST\/install\.sh"|install\.sh"/,
    'update.sh does not actually run install.sh');
  assert.match(stripComments(read('update.bat'), 'REM'), /call\s+"[^"]*install\.bat"/i,
    'update.bat does not actually call install.bat — new code would land on old dependencies');
  assert.match(stripComments(read('update.command'), '#'), /bash \.\/update\.sh/,
    'update.command does not actually run update.sh');
});

test('the bundled voice ships in the repository', () => {
  // Fetched-on-demand would mean a Familiar that cannot speak offline, and
  // identity should not depend on a working connection.
  assert.ok(existsSync('voices/bundled/p255_023_enhanced.wav'));
});

test('everything a person needs is reachable over HTTP', () => {
  const srv = read('server.js');
  for (const ep of [
    '/api/voice/models',          // is the voice here?
    '/api/voice/install-models',  // get it
    '/api/voice/install-sidecar', // get the better engine
    '/api/voice/choose',          // keep a voice
    '/api/voice/status',          // which engine is really speaking
  ]) {
    assert.ok(srv.includes(ep), `${ep} is missing — that step needs a terminal again`);
  }
});

test('and each of those endpoints has a caller in the UI', () => {
  // An endpoint with no caller is the shape `installVoice()` had for days:
  // tested, working, and unreachable.
  const app = read('public/app.js');
  for (const [fn, why] of [
    ['ensureSpeechModel', 'the speak button must offer the download'],
    ['installVoiceSidecar', 'settings must install the sidecar'],
    ['onVoiceBackendChange', 'settings must switch engine'],
    ['chooseVoice', 'the picker must keep a voice'],
  ]) {
    assert.ok(app.includes(fn), why);
  }
});

test('the engine dropdown exists in the markup, not just in script', () => {
  const html = read('public/index.html');
  assert.match(html, /voice-backend-select/);
  assert.match(html, /voice-sidecar-install/);
});

test('voice notes are reachable end to end, with no terminal step for a user', () => {
  const srv = read('server.js');
  const app = read('public/app.js');
  const html = read('public/index.html');

  // The store must take audio at all. It accepted `image/*` only until Pass 1,
  // so a voice note would have been rejected by the body parser before any
  // code of ours ran. Behaviour, not exact syntax: the /api/media raw parser's
  // type list must include 'audio/*' (siblings like 'video/*' may be present too —
  // pinning the exact array broke on the video work, which is the source-text-
  // assertion anti-pattern this repo has already paid for).
  assert.match(
    srv,
    /app\.post\('\/api\/media', express\.raw\(\{ type: \[[^\]]*'audio\/\*'[^\]]*\]/,
    'the /api/media upload endpoint does not accept audio');
  assert.ok(srv.includes('/transcribe'), 'nothing can ask for a transcript');

  // The button, its handler, and the conversion the handler depends on.
  assert.match(html, /id="record-btn"/, 'there is no way to start recording');
  assert.ok(app.includes('toggleVoiceNote'), 'the record button has no handler');
  assert.ok(app.includes('attachVoiceNote'), 'a recording never becomes an attachment');
  // No toggle by design: pressing the mic IS the consent, so the only thing
  // that must exist is the button. A setting here would be friction in front
  // of a deliberate act, and it hid the feature entirely while it existed.
  assert.doesNotMatch(html, /voice-enabled-toggle/, 'a gate in front of the record button is back');

  // The exact `installVoice()` failure, guarded: a module that exists, is
  // tested, and has no caller.
  const rec = read('public/voice-recorder.js');
  for (const fn of ['startRecording', 'toWav']) {
    assert.ok(rec.includes(`export async function ${fn}`), `${fn} is missing`);
    assert.ok(app.includes(fn), `${fn} exists but nothing in the UI calls it`);
  }
  // encodeWav is reached THROUGH toWav rather than from the UI — asserted here
  // so the chain is unbroken without pretending the UI calls it directly.
  assert.ok(rec.includes('export function encodeWav'));
  assert.ok(/encodeWav\(rendered/.test(rec), 'toWav does not actually encode a wav');
});

test('both surfaces hear voice notes — the RULE C cell vision missed', () => {
  // Web got ensureDescribed, Discord silently did not, and the Familiar
  // described images it had never looked at. The shared call is what makes
  // that impossible to repeat; this asserts both ends still use it.
  for (const f of ['server.js', 'src/discord/discord-gateway.js']) {
    assert.ok(read(f).includes('hearVoiceNotes'), `${f} does not listen before it answers`);
  }
  // And that the worker lives somewhere both can reach, rather than inside one.
  assert.ok(read('src/voice/voice-transcribe.js').includes('audio-worker-current.js'));
});

test('docs tell someone voice exists, and what to do when it does not work', () => {
  assert.match(read('README.md'), /talk out loud/i, 'nobody learns the feature exists otherwise');
  assert.match(read('docs/troubleshooting.md'), /Reading aloud \(voice\)/);
  // The single most expensive lesson of the milestone: a whole debugging round
  // went into the wrong backend because nobody checked the boot line.
  assert.match(read('docs/troubleshooting.md'), /speaking through/);
  // Voice notes get the same treatment: discoverable, and debuggable.
  assert.match(read('README.md'), /voice note/i, 'nobody learns they can talk instead of typing');
  assert.match(read('docs/troubleshooting.md'), /microphone button/i);
});
