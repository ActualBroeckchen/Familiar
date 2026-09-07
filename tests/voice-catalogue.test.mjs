import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VOICE_SOURCES, LICENSES, shippableSources, sourceByKey,
  rejectionReason, attributionNotice, validateShippingSet,
  VOICE_PROVENANCE, mayLeaveTheMachine, belongsInIdentityBackup, redactForSharing,
  DEFAULT_VOICE, SHORTLIST, shortlistKeys,
} from '../src/voice/voice-catalogue.js';

test('no non-commercial source can ever reach the shipped set', () => {
  for (const s of shippableSources()) {
    assert.equal(s.license.commercialOk, true, `${s.key} carries an NC restriction and must not ship in a GPL distribution`);
    assert.equal(s.license.redistributable, true);
  }
});

test('the NC sources are present in the catalogue but rejected — so nobody rediscovers them and re-litigates', () => {
  for (const key of ['expresso', 'ears']) {
    const s = sourceByKey(key);
    assert.equal(s.license.id, 'CC-BY-NC-4.0');
    assert.ok(s.rejected, `${key} must carry its reason`);
    assert.ok(!shippableSources().some((x) => x.key === key));
    assert.match(rejectionReason(key), /commercial/i);
  }
});

test('a source whose own upstream is unsure of its licence is treated as unusable', () => {
  const s = sourceByKey('unmute-degaulle');
  assert.equal(s.license.redistributable, false);
  assert.match(rejectionReason('unmute-degaulle'), /assumption is not a licence/i);
});

test('every shippable source under an attribution licence records who to credit', () => {
  for (const s of shippableSources()) {
    if (s.license.requiresAttribution) {
      assert.ok(s.attribution, `${s.key} needs attribution and records none`);
    }
  }
});

test('the CC0 sources carry no attribution obligation, but the catalogue still knows the courtesy credit', () => {
  const donations = sourceByKey('voice-donations');
  assert.equal(donations.license.requiresAttribution, false);
  assert.ok(donations.creditAnyway, 'volunteers who donated a voice deserve naming even when not required');
});

test('the default PocketTTS voice set is available to us — CC0, no strings', () => {
  const vz = sourceByKey('voice-zero');
  assert.equal(vz.license.id, 'CC0-1.0');
  assert.ok(shippableSources().some((s) => s.key === 'voice-zero'));
});

test('validateShippingSet refuses an NC source, an unknown one, and an uncredited attributed one', () => {
  assert.equal(validateShippingSet(['voice-zero', 'voice-donations']).ok, true);
  assert.equal(validateShippingSet(['voice-zero', 'alba-mackenna', 'vctk']).ok, true);

  const bad = validateShippingSet(['voice-zero', 'ears']);
  assert.equal(bad.ok, false);
  assert.equal(bad.problems[0].key, 'ears');

  assert.equal(validateShippingSet(['nope']).ok, false);
  assert.equal(validateShippingSet(['unmute-degaulle']).ok, false);
});

test('the NOTICE text is generated from the catalogue, so a credit cannot be dropped by editing prose', () => {
  const notice = attributionNotice();
  assert.match(notice, /Alba MacKenna/);
  assert.match(notice, /VCTK/);
  assert.match(notice, /CC BY 4\.0/);
  assert.match(notice, /Voice Donation/);
  assert.doesNotMatch(notice, /Expresso/, 'a source we do not ship must not be credited as if we did');
  assert.doesNotMatch(notice, /EARS/);
});

test('adding an attributed source without its credit fails the notice contract rather than shipping quietly', () => {
  const rogue = { key: 'rogue', label: 'Rogue', license: LICENSES.CC_BY_4 };
  assert.equal(validateShippingSet([...shippableSources().map((s) => s.key), 'rogue']).ok, false);
  // and the generated notice would name it with no credit — visible, not silent
  assert.match(attributionNotice([rogue]), /\*\*Rogue\*\* — CC BY 4\.0$/m);
});

// ── Ward-supplied voices (ward decision: allowed, personal use only) ─────

test('a ward-supplied clip never leaves the machine in a shared artifact', () => {
  const mine = { id: 'v1', provenance: VOICE_PROVENANCE.WARD_SUPPLIED };
  assert.equal(mayLeaveTheMachine(mine), false);
  const bundled = { id: 'v2', provenance: VOICE_PROVENANCE.BUNDLED };
  assert.equal(mayLeaveTheMachine(bundled), true);
});

test('unknown provenance fails closed — withholding costs a question, leaking cannot be undone', () => {
  for (const v of [{ id: 'x' }, { id: 'y', provenance: 'who-knows' }, null, undefined, {}]) {
    assert.equal(mayLeaveTheMachine(v), false);
  }
});

test('redaction says what it withheld — a silent omission would strand someone debugging a voice', () => {
  const { shared, withheld } = redactForSharing([
    { id: 'bundled-1', provenance: VOICE_PROVENANCE.BUNDLED },
    { id: 'wards-own', provenance: VOICE_PROVENANCE.WARD_SUPPLIED },
  ]);
  assert.deepEqual(shared.map((v) => v.id), ['bundled-1']);
  assert.equal(withheld.length, 1);
  assert.equal(withheld[0].id, 'wards-own');
  assert.match(withheld[0].reason, /theirs, not mine to hand out/);
});

test("EVERY voice belongs in my human's own backup — including the one they gave me", () => {
  // Their own data moving with them is not redistribution. A restored
  // Familiar who comes back sounding like a stranger is a continuity break.
  assert.equal(belongsInIdentityBackup({ id: 'wards-own', provenance: VOICE_PROVENANCE.WARD_SUPPLIED }), true);
  assert.equal(belongsInIdentityBackup({ id: 'bundled-1', provenance: VOICE_PROVENANCE.BUNDLED }), true);
});

test('the two questions are genuinely separate — backup includes what sharing excludes', () => {
  const mine = { id: 'wards-own', provenance: VOICE_PROVENANCE.WARD_SUPPLIED };
  assert.notEqual(mayLeaveTheMachine(mine), belongsInIdentityBackup(mine));
});

test('every catalogue entry names where it came from, so a licence claim can be re-checked', () => {
  for (const s of VOICE_SOURCES) {
    assert.match(s.upstream, /^https:\/\//, `${s.key} has no upstream url`);
    assert.ok(s.license, `${s.key} has no licence recorded`);
  }
});

test('the voice that ships in the box comes from a source we are allowed to ship', () => {
  const src = sourceByKey(DEFAULT_VOICE.source);
  assert.ok(src, 'the default voice names a real catalogue source');
  assert.equal(src.license.redistributable, true);
  assert.equal(src.license.commercialOk, true, 'the bundled voice cannot carry an NC restriction');
  assert.ok(shippableSources().some((s) => s.key === DEFAULT_VOICE.source));
});

test('the bundled voice is CC BY, so its credit must actually appear in the NOTICE', () => {
  const src = sourceByKey(DEFAULT_VOICE.source);
  assert.equal(src.license.requiresAttribution, true);
  assert.ok(src.attribution, 'and the credit is recorded');
  assert.match(attributionNotice(), /VCTK/, 'a credit we are obliged to carry must be carried');
});

test('the default voice is a real catalogue entry, not a name someone hoped existed', async () => {
  const { loadCatalogue, _resetCatalogue } = await import('../src/voice/voice-clips.js');
  _resetCatalogue();
  const cat = loadCatalogue(process.cwd());
  const found = (cat.clips ?? []).find(
    (c) => c.source === DEFAULT_VOICE.source && c.id === DEFAULT_VOICE.id && c.variant === DEFAULT_VOICE.variant,
  );
  assert.ok(found, `${DEFAULT_VOICE.key} is not in voice-clips.json`);
  assert.match(found.sha256, /^[0-9a-f]{64}$/, 'and it is pinned, so it can actually be installed');
  _resetCatalogue();
});

test('the shortlist spans deep to high, so "lower" and "higher" are both reachable in ten', () => {
  const f0s = SHORTLIST.map((v) => v.f0);
  assert.ok(Math.min(...f0s) < 100, 'something genuinely deep is offered');
  assert.ok(Math.max(...f0s) > 220, 'and something genuinely high');
  assert.deepEqual(f0s, [...f0s].sort((a, b) => a - b), 'ordered deepest to highest');
});

test('the shortlist is small enough to be a choice rather than a library', () => {
  assert.ok(SHORTLIST.length <= 12, `${SHORTLIST.length} options is a wall, not a shortlist`);
  assert.ok(SHORTLIST.length >= 5);
});

test('the default voice is in the shortlist — it cannot be the one option nobody is offered', () => {
  assert.ok(shortlistKeys().has(DEFAULT_VOICE.key));
});

test('every shortlisted voice comes from a source we may ship', () => {
  const allowed = new Set(shippableSources().map((s) => s.key));
  for (const v of SHORTLIST) {
    assert.ok(allowed.has(v.source), `${v.key} comes from ${v.source}, which we may not ship`);
  }
});

test('every shortlisted voice is a real pinned clip', async () => {
  const { loadCatalogue, _resetCatalogue } = await import('../src/voice/voice-clips.js');
  _resetCatalogue();
  const clips = loadCatalogue(process.cwd()).clips ?? [];
  for (const v of SHORTLIST) {
    // Compare the WHOLE key, variant included. This used to build the key with
    // '/original' hard-coded, which quietly stopped checking anything the
    // moment the shortlist moved to the enhanced recordings.
    const found = clips.find((c) => `${c.source}/${c.id}/${c.variant}` === v.key);
    assert.ok(found, `${v.key} is not in the catalogue`);
    assert.match(found.sha256, /^[0-9a-f]{64}$/);
  }
  _resetCatalogue();
});
