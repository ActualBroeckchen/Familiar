import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composePlan, planSize, evaluatePlan, describePlanForConsent, formatBytes,
  isPinned, modelById, AUDIO_MODELS, CEILINGS, CAPABILITY_TIERS, VOICE_ENGINES, applyPins,
  supportedAsrLangs, availableAsrLangs, ASR_LANGUAGES, DEFAULT_ASR_LANG,
} from '../src/voice/voice-models.js';

const roles = (plan) => plan.all.map((m) => m.role).sort();
const ids = (plan) => plan.all.map((m) => m.id).sort();

test('the default plan is listening + the expressive voice (§0.7: pocket is default at every tier)', () => {
  const plan = composePlan();
  assert.equal(plan.capabilityTier, 'listening');
  assert.equal(plan.voiceEngine, 'pocket');
  assert.equal(plan.voice.id, 'tts-pocket');
  assert.deepEqual(roles(plan), ['asr-streaming', 'tts', 'vad']);
});

test('read-aloud fetches a voice and no ASR — it is not a listening surface', () => {
  const plan = composePlan({ capabilityTier: 'read-aloud' });
  assert.deepEqual(ids(plan), ['tts-pocket']);
  assert.equal(plan.capability.length, 0);
});

test('read-aloud still defaults to the expressive voice — the disk-poor ward is not given the flat one', () => {
  const plan = composePlan({ capabilityTier: 'read-aloud' });
  assert.equal(plan.voice.id, 'tts-pocket');
});

test('piper is reachable only by naming it', () => {
  const plan = composePlan({ voiceEngine: 'piper' });
  assert.equal(plan.voice.id, 'tts-piper');
  // and it is never what an unspecified choice lands on
  assert.equal(composePlan({}).voice.id, 'tts-pocket');
});

test('listening-plus adds enhancement and speaker embedding, nothing else', () => {
  const plan = composePlan({ capabilityTier: 'listening-plus' });
  assert.deepEqual(roles(plan), ['asr-streaming', 'enhance', 'speaker', 'tts', 'vad']);
});

test('English is what an unconfigured install listens in — nothing else is fetched unless asked for', () => {
  const plan = composePlan();
  assert.deepEqual(plan.asrLangs, ['en']);
  assert.equal(plan.capability.filter((m) => m.role === 'asr-streaming').length, 1);
  assert.ok(!plan.all.some((m) => m.lang === 'de'), 'no other language may ride along');
});

test('a ward who wants only German gets only German — the default is not bundled alongside', () => {
  const plan = composePlan({ asrLangs: ['de'] });
  assert.deepEqual(plan.asrLangs, ['de']);
  assert.equal(plan.all.filter((m) => m.role === 'asr-streaming').length, 1);
});

test('adding a language is a table row, not a code change', () => {
  for (const l of supportedAsrLangs()) {
    const plan = composePlan({ asrLangs: [l] });
    assert.deepEqual(plan.asrLangs, [l], `${l} did not resolve to a model`);
    assert.equal(plan.unavailableLangs.length, 0);
  }
  assert.ok(supportedAsrLangs().includes('en'));
  assert.ok(supportedAsrLangs().length >= 2);
});

test('a curated-but-unpinned language is not offered — a menu must not contain what cannot be fetched', () => {
  const available = availableAsrLangs();
  const supported = supportedAsrLangs();
  assert.ok(available.every((l) => supported.includes(l)), 'available is a subset of curated');
  for (const l of available) {
    assert.equal(isPinned(modelById(`asr-streaming-${l}`)), true, `${l} is offered but not pinned`);
  }
  for (const l of supported.filter((x) => !available.includes(x))) {
    assert.equal(isPinned(modelById(`asr-streaming-${l}`)), false);
  }
});

test('the default language is one a ward can actually get', () => {
  assert.ok(availableAsrLangs().includes(DEFAULT_ASR_LANG),
    'the default must be pinned, or a stock install offers ears it cannot fetch');
});

test('every language row names the upstream asset, so the table and the pin URL cannot drift apart', () => {
  for (const l of ASR_LANGUAGES) {
    assert.match(l.upstream.asset, /^sherpa-onnx-.*\.tar\.bz2$/, `${l.lang} has no upstream asset recorded`);
    assert.equal(l.upstream.tag, 'asr-models');
    assert.deepEqual(modelById(`asr-streaming-${l.lang}`).upstream, l.upstream);
  }
});

test('an unsupported language is REPORTED, never silently swapped for English', () => {
  const plan = composePlan({ asrLangs: ['en', 'xx'] });
  assert.deepEqual(plan.requestedLangs, ['en', 'xx']);
  assert.deepEqual(plan.unavailableLangs, ['xx']);
  assert.deepEqual(plan.asrLangs, ['en'], 'the supported half still resolves');
});

test('a request for ONLY unsupported languages still yields working ears, and still says what was missed', () => {
  const plan = composePlan({ asrLangs: ['xx'] });
  assert.deepEqual(plan.unavailableLangs, ['xx']);
  assert.deepEqual(plan.asrLangs, ['en'], 'a listening tier with no decoder would be worse');
  assert.equal(plan.capability.filter((m) => m.role === 'asr-streaming').length, 1);
});

test('language input is normalized rather than trusted — case and whitespace do not create a phantom language', () => {
  const plan = composePlan({ asrLangs: [' EN ', 'en', 'De'] });
  assert.deepEqual(plan.asrLangs.sort(), ['de', 'en']);
  assert.equal(plan.unavailableLangs.length, 0);
});

test('a second ASR language pulls in language ID, and it shows up in the plan rather than being bundled silently', () => {
  const plan = composePlan({ asrLangs: ['en', 'de'] });
  const asr = plan.capability.filter((m) => m.role === 'asr-streaming');
  assert.equal(asr.length, 2);
  assert.ok(plan.extras.some((m) => m.role === 'lid'), 'LID must be listed as an extra, not hidden');
});

test('one language does not pull in LID', () => {
  const plan = composePlan({ asrLangs: ['de'] });
  assert.equal(plan.extras.length, 0);
  assert.equal(plan.capability.find((m) => m.role === 'asr-streaming').lang, 'de');
});

test('extras are only what the ward named; unknown extras are dropped, not guessed', () => {
  const plan = composePlan({ extras: ['punct', 'tagging', 'nonsense'] });
  assert.deepEqual(plan.extras.map((m) => m.role).sort(), ['punct', 'tagging']);
});

test('a malformed setting falls back to defaults instead of making voice un-configurable', () => {
  const plan = composePlan({ capabilityTier: 'wat', voiceEngine: 'kazoo', asrLangs: [] });
  assert.equal(plan.capabilityTier, 'listening');
  assert.equal(plan.voiceEngine, 'pocket');
  assert.deepEqual(plan.asrLangs, ['en']);
});

test('an unpinned plan is sized as an estimate, never as a measurement', () => {
  const unpinnedOnly = AUDIO_MODELS.filter((m) => !isPinned(m));
  if (unpinnedOnly.length === 0) return; // everything pinned; nothing to assert here
  const { estimated, bytes } = planSize(unpinnedOnly);
  assert.equal(estimated, true);
  assert.ok(bytes > 0);
});

test('applyPins accepts only whole, well-formed records — a half-pin must not become a fetchable model', () => {
  const base = [{ id: 'x', label: 'X', estBytes: 10, files: [] }];
  const good = { x: { files: [{ name: 'a.onnx', url: 'https://e.test/a', sha256: 'a'.repeat(64), bytes: 12 }] } };
  assert.equal(isPinned(applyPins(base, good)[0]), true);

  const rejects = [
    { x: { files: [{ name: 'a', url: 'https://e.test/a', sha256: 'a'.repeat(63), bytes: 12 }] } }, // short hash
    { x: { files: [{ name: 'a', url: 'http://e.test/a', sha256: 'a'.repeat(64), bytes: 12 }] } },  // not https
    { x: { files: [{ name: 'a', url: 'https://e.test/a', sha256: 'a'.repeat(64) }] } },            // no size
    { x: { files: [{ name: '', url: 'https://e.test/a', sha256: 'a'.repeat(64), bytes: 12 }] } },  // no name
    { x: { files: [{ url: 'https://e.test/a', sha256: 'Z'.repeat(64), bytes: 12 }] } },            // non-hex
  ];
  for (const bad of rejects) {
    assert.equal(applyPins(base, bad)[0].files.length, 0, `accepted a malformed pin: ${JSON.stringify(bad)}`);
  }
});

test('a malformed pins file degrades to unpinned rather than throwing at module load', () => {
  const base = [{ id: 'x', label: 'X', estBytes: 10, files: [] }];
  for (const junk of [null, undefined, 'nonsense', 42, [], { x: { files: 'nope' } }, { x: null }]) {
    const merged = applyPins(base, junk);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].files.length, 0);
  }
});

test('pinning one model leaves the others alone', () => {
  const base = [
    { id: 'a', label: 'A', estBytes: 1, files: [] },
    { id: 'b', label: 'B', estBytes: 1, files: [] },
  ];
  const merged = applyPins(base, { a: { files: [{ name: 'f', url: 'https://e.test/f', sha256: 'c'.repeat(64), bytes: 5 }] } });
  assert.equal(isPinned(merged[0]), true);
  assert.equal(isPinned(merged[1]), false);
});

test('an entry with a url but no checksum is NOT fetchable — unverified is not a smaller risk, it is a silent one', () => {
  const fake = { files: [{ name: 'x.onnx', url: 'https://example.invalid/x.onnx', sha256: null, bytes: 10 }] };
  assert.equal(isPinned(fake), false);
  const short = { files: [{ name: 'x.onnx', url: 'https://example.invalid/x.onnx', sha256: 'abc', bytes: 10 }] };
  assert.equal(isPinned(short), false, 'a truncated hash must not pass');
});

test('the default plan sits inside the §0.7 ceilings', () => {
  const ev = evaluatePlan(composePlan());
  assert.equal(ev.withinBudget, true, JSON.stringify(ev.violations));
  assert.ok(ev.voice.bytes <= CEILINGS.voice.pocket);
  assert.ok(ev.capability.bytes <= CEILINGS.capability.listening);
});

test('every tier × engine combination sits inside its ceilings on current estimates', () => {
  for (const capabilityTier of CAPABILITY_TIERS) {
    for (const voiceEngine of VOICE_ENGINES) {
      const ev = evaluatePlan(composePlan({ capabilityTier, voiceEngine }));
      assert.equal(ev.withinBudget, true, `${capabilityTier}/${voiceEngine}: ${JSON.stringify(ev.violations)}`);
    }
  }
});

test('evaluatePlan reports a breach rather than throwing — a ward spending disk they have is not an error', () => {
  const plan = composePlan();
  // An oversized voice, expressed as a real pin so the check runs against a
  // measurement rather than an estimate — the ceiling has to bind on the
  // figures that actually matter.
  plan.voice = {
    ...plan.voice,
    files: [{ name: 'huge.onnx', url: 'https://e.test/h', sha256: 'a'.repeat(64), bytes: CEILINGS.voice.pocket + 1 }],
  };
  const ev = evaluatePlan(plan);
  assert.equal(ev.withinBudget, false);
  assert.equal(ev.violations[0].axis, 'voice');
  assert.equal(ev.estimated, false, 'a breach measured from real pins is not hedged');
});

test('extras are excluded from the capability ceiling — they are priced separately, not smuggled in', () => {
  const bare = evaluatePlan(composePlan());
  const loaded = evaluatePlan(composePlan({ extras: ['asr-offline', 'tagging', 'punct'] }));
  assert.equal(loaded.capability.bytes, bare.capability.bytes);
  assert.ok(loaded.extras.bytes > 0);
  assert.ok(loaded.totalBytes > bare.totalBytes);
  assert.equal(loaded.withinBudget, true);
});

test('the consent sentence hedges only when the figure is an estimate — "about 200 MB" and "200 MB" are different promises', () => {
  const d = describePlanForConsent(composePlan());
  assert.match(d.text, /PocketTTS/);
  assert.equal(d.models.length, 3);
  if (d.estimated) assert.match(d.text, /^This downloads about /);
  else assert.match(d.text, /^This downloads \d/, 'a measured figure is stated plainly, not hedged');

  // An unpinned plan must always hedge, whatever the manifest currently holds.
  const unpinned = { ...composePlan(), voice: { id: 'x', label: 'X', estBytes: 5, files: [] }, capability: [], extras: [] };
  unpinned.all = [unpinned.voice];
  const u = describePlanForConsent(unpinned);
  assert.equal(u.estimated, true);
  assert.match(u.text, /^This downloads about /);
});

test('formatBytes never invents precision it does not have', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MB');
  assert.equal(formatBytes(200 * 1024 * 1024), '200 MB');
  assert.equal(formatBytes(1.5 * 1024 * 1024 * 1024), '1.50 GB');
  assert.equal(formatBytes(NaN), 'unknown');
  assert.equal(formatBytes(-1), 'unknown');
});

test('modelById is the only lookup path and returns null rather than undefined-ish surprises', () => {
  assert.equal(modelById('tts-pocket').role, 'tts');
  assert.equal(modelById('nope'), null);
});
