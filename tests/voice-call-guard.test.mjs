import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCallGuard, detectReleasePhrase, GUEST_NOTE_LINE } from '../voice-call-guard.js';

const WARD_PRINT = [1, 0, 0];
const wardEmb  = [0.98, 0.02, 0];   // matches the ward
const guestEmb = [0, 1, 0];         // does not

test('detectReleasePhrase catches the ward saying they are alone again', () => {
  assert.equal(detectReleasePhrase("it's just me now"), true);
  assert.equal(detectReleasePhrase('they left'), true);
  assert.equal(detectReleasePhrase('what were we saying about dinner'), false);
});

test('no ward print → the guard is inert (a call with no enrolment never guesses)', () => {
  const g = createCallGuard({ wardPrint: null, policy: 'gate' });
  assert.equal(g.active, false);
  for (let i = 0; i < 10; i++) g.observeWardSegment(guestEmb);
  assert.equal(g.guestPresent, false);
  assert.equal(g.withholdWardPrivate(), false);
});

test('gate policy: a guest present WITHHOLDS ward-private; release restores it', () => {
  let t = 0; const g = createCallGuard({ wardPrint: WARD_PRINT, policy: 'gate', now: () => t });
  assert.equal(g.withholdWardPrivate(), false, 'alone at the start');
  for (let i = 0; i < 3; i++) { t += 1000; g.observeWardSegment(guestEmb, { ts: t }); }  // 3 non-ward → enter
  assert.equal(g.guestPresent, true);
  assert.equal(g.withholdWardPrivate(), true, 'ward-private withheld while a guest is here');
  // Release: 6 ward segments AND the quiet window.
  t += 90 * 1000 + 1000;
  for (let i = 0; i < 6; i++) { t += 1000; g.observeWardSegment(wardEmb, { ts: t }); }
  assert.equal(g.withholdWardPrivate(), false, 'restored once the ward is alone again');
});

test('note policy: never withholds, but surfaces the guest note line', () => {
  const g = createCallGuard({ wardPrint: WARD_PRINT, policy: 'note', now: () => 1 });
  assert.equal(g.noteLine(), null, 'no note while alone');
  for (let i = 0; i < 3; i++) g.observeWardSegment(guestEmb);
  assert.equal(g.withholdWardPrivate(), false, 'note NEVER strips context');
  assert.equal(g.noteLine(), GUEST_NOTE_LINE);
});

test('ignore policy: detects nothing, does nothing', () => {
  const g = createCallGuard({ wardPrint: WARD_PRINT, policy: 'ignore' });
  for (let i = 0; i < 10; i++) g.observeWardSegment(guestEmb);
  assert.equal(g.guestPresent, false);
  assert.equal(g.noteLine(), null);
  assert.equal(g.withholdWardPrivate(), false);
});

test('a spoken release in a ward-matched segment clears the gate immediately', () => {
  let t = 0; const g = createCallGuard({ wardPrint: WARD_PRINT, policy: 'gate', now: () => t });
  for (let i = 0; i < 3; i++) { t += 1000; g.observeWardSegment(guestEmb, { ts: t }); }
  assert.equal(g.withholdWardPrivate(), true);
  const r = g.observeWardSegment(wardEmb, { ts: ++t, text: "it's just me now" });
  assert.equal(r.transition, 'released');
  assert.equal(g.withholdWardPrivate(), false);
});

test('forceRelease (UI) clears a gate', () => {
  const g = createCallGuard({ wardPrint: WARD_PRINT, policy: 'gate', now: () => 1 });
  for (let i = 0; i < 3; i++) g.observeWardSegment(guestEmb);
  assert.equal(g.withholdWardPrivate(), true);
  g.forceRelease('ui');
  assert.equal(g.withholdWardPrivate(), false);
});
