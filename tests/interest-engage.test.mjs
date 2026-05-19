/**
 * Tests for interestEngagementDelta() — the M5 helper that turns
 * per-turn chat signals (response length + topic persistence) into an
 * interest-weight delta. The function is the single home of the
 * weight-accrual semantics, so the curve it produces is worth pinning
 * down: a one-off short mention should bump small (and decay away),
 * sustained deep engagement should accrue fast, and no single signal
 * should be able to run away unbounded (both components are capped).
 *
 * server.js isn't importable (Express boot side effects), so we
 * vm-extract the function the same way the other server-side tests do.
 */

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const SERVER_JS = new URL('../server.js', import.meta.url);
const src = readFileSync(SERVER_JS, 'utf8');

function extractFunctionSource(text, name) {
  const start = text.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`${name} not found in ${SERVER_JS.pathname}`);
  // Skip the parameter list first — destructuring defaults like
  // `({ a = 0 } = {})` contain braces that would otherwise be
  // mistaken for the function body's opening brace. Walk to the ')'
  // that closes the param list, THEN find the body brace.
  const parenOpen = text.indexOf('(', start);
  let pd = 0, afterParams = parenOpen;
  for (let i = parenOpen; i < text.length; i++) {
    if (text[i] === '(') pd++;
    else if (text[i] === ')') { pd--; if (pd === 0) { afterParams = i; break; } }
  }
  let depth = 0, inBraces = false;
  for (let i = text.indexOf('{', afterParams); i < text.length; i++) {
    if (text[i] === '{') { depth++; inBraces = true; }
    else if (text[i] === '}') {
      depth--;
      if (inBraces && depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// The function references module-level constants; pull those in too.
const constLines = src.split('\n').filter(l => /^const ENGAGE_[A-Z_]+\s*=/.test(l)).join('\n');
const fnSrc = extractFunctionSource(src, 'interestEngagementDelta');
const ctx = {};
runInNewContext(`${constLines}\n${fnSrc}\nresult = interestEngagementDelta;`, ctx);
const interestEngagementDelta = ctx.result;
assert.equal(typeof interestEngagementDelta, 'function');

// ── Empty / degenerate inputs ─────────────────────────────────────────

test('no signals → zero delta', () => {
  assert.equal(interestEngagementDelta(), 0);
  assert.equal(interestEngagementDelta({}), 0);
  assert.equal(interestEngagementDelta({ responseChars: 0, spanMessages: 0 }), 0);
});

test('negative / NaN inputs are treated as zero', () => {
  assert.equal(interestEngagementDelta({ responseChars: -100, spanMessages: -5 }), 0);
  assert.equal(interestEngagementDelta({ responseChars: NaN, spanMessages: NaN }), 0);
});

// ── Token-volume component ────────────────────────────────────────────

test('token volume scales linearly below the cap', () => {
  // 1500 chars → 0.1 (one TOKEN_UNIT). spanMessages=0 isolates the
  // token component.
  assert.equal(interestEngagementDelta({ responseChars: 1500, spanMessages: 0 }), 0.1);
  // Half that → half the bump.
  assert.equal(interestEngagementDelta({ responseChars: 750, spanMessages: 0 }), 0.05);
});

test('token volume is capped so one huge dump can not dominate', () => {
  // 100k chars would be 6.67 uncapped; cap is 0.5.
  assert.equal(interestEngagementDelta({ responseChars: 100_000, spanMessages: 0 }), 0.5);
});

// ── Persistence component ─────────────────────────────────────────────

test('persistence accrues per message the topic stays open', () => {
  // spanMessages=4 → 0.2, responseChars=0 isolates the component.
  assert.equal(interestEngagementDelta({ responseChars: 0, spanMessages: 4 }), 0.2);
});

test('persistence is capped', () => {
  // 100 messages would be 5.0 uncapped; cap is 0.3.
  assert.equal(interestEngagementDelta({ responseChars: 0, spanMessages: 100 }), 0.3);
});

// ── Combined behaviour / shape ────────────────────────────────────────

test('components are additive', () => {
  // 1500 chars (0.1) + 4 messages (0.2) = 0.3 (rounded to dodge
  // binary-float drift).
  const raw = interestEngagementDelta({ responseChars: 1500, spanMessages: 4 });
  assert.equal(Math.round(raw * 1e6) / 1e6, 0.3);
});

test('a one-off short mention bumps small', () => {
  // ~300-char reply, topic open 1 message: small enough that tau=5
  // decay erases it within ~2 weeks.
  const d = interestEngagementDelta({ responseChars: 300, spanMessages: 1 });
  assert.ok(d > 0 && d < 0.1, `expected small bump, got ${d}`);
});

test('sustained deep engagement accrues toward active_pursuit', () => {
  // Long answer (capped 0.5) across many turns (capped 0.3) = 0.8/turn.
  // A handful of such turns crosses the 2.0 active_pursuit threshold.
  const perTurn = interestEngagementDelta({ responseChars: 8000, spanMessages: 10 });
  assert.equal(perTurn, 0.8);
  assert.ok(perTurn * 3 > 2.0, 'three deep turns should clear active_pursuit');
});
