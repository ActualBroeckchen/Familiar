/**
 * Tests for injectDynamicAtDepth() — the helper that inserts the
 * dynamic-thalamus block as a system message N positions from the
 * end of the conversation. The goal is cache stability: by NOT
 * gluing dynamic content into the system-message prefix (where it
 * would invalidate the upstream LLM's prefix cache every turn), we
 * keep the static identity prefix stable and let only the
 * depth-injected slot churn.
 *
 * server.js isn't importable as an ES module (it has side effects at
 * module load — Express server boot, MCP connect, etc.) so we
 * vm-extract the function the same way tests/extract-error.test.mjs
 * does for app.js. Single source of truth stays in server.js.
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
  let depth = 0;
  let inBraces = false;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') { depth++; inBraces = true; }
    else if (text[i] === '}') {
      depth--;
      if (inBraces && depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const fnSrc = extractFunctionSource(src, 'injectDynamicAtDepth');
const ctx = {};
runInNewContext(`${fnSrc};\nresult = injectDynamicAtDepth;`, ctx);
const injectDynamicAtDepth = ctx.result;
assert.equal(typeof injectDynamicAtDepth, 'function');

const SYS = (c) => ({ role: 'system', content: c });
const USR = (c) => ({ role: 'user',   content: c });
const ASS = (c) => ({ role: 'assistant', content: c });

// ── Empty cases ──────────────────────────────────────────────────────

test('no-op when dynamic is empty string', () => {
  const msgs = [SYS('identity'), USR('hi')];
  const out = injectDynamicAtDepth(msgs, '', 4);
  assert.equal(out.messages, msgs);  // same reference — no rebuild
  assert.equal(out.injectedAt, null);
});

test('no-op when dynamic is null', () => {
  const msgs = [SYS('identity'), USR('hi')];
  const out = injectDynamicAtDepth(msgs, null, 4);
  assert.equal(out.injectedAt, null);
});

// ── Position math ────────────────────────────────────────────────────

test('inserts at len - depth for long conversations', () => {
  // 12 messages, depth=4 → inject at index 8.
  const msgs = [SYS('s'), USR('u1'), ASS('a1'), USR('u2'), ASS('a2'),
                USR('u3'), ASS('a3'), USR('u4'), ASS('a4'), USR('u5'),
                ASS('a5'), USR('u6')];
  const out = injectDynamicAtDepth(msgs, 'DYN', 4);
  assert.equal(out.injectedAt, 8);
  assert.equal(out.messages[8].role, 'system');
  assert.equal(out.messages[8].content, 'DYN');
  assert.equal(out.messages.length, msgs.length + 1);
});

test('clamps to 1 when depth exceeds conversation length', () => {
  // Only 2 messages, depth=4 → would compute -2, clamps to 1.
  const msgs = [SYS('identity'), USR('first message')];
  const out = injectDynamicAtDepth(msgs, 'DYN', 4);
  assert.equal(out.injectedAt, 1);
  // Order: [system-identity, system-dynamic, user]
  assert.equal(out.messages[0].content, 'identity');
  assert.equal(out.messages[1].content, 'DYN');
  assert.equal(out.messages[2].content, 'first message');
});

test('depth=1 inserts right before the last message', () => {
  const msgs = [SYS('s'), USR('u1'), ASS('a1'), USR('u2')];
  const out = injectDynamicAtDepth(msgs, 'DYN', 1);
  assert.equal(out.injectedAt, 3);
  assert.equal(out.messages[3].content, 'DYN');
  assert.equal(out.messages[4].content, 'u2'); // last user msg stays last
});

test('large depth never lands above index 1', () => {
  // No matter how huge depth is, dynamic must land below the system
  // prefix so it doesn't accidentally land at index 0 (which would
  // replace or precede the system message, breaking the cache).
  const msgs = [SYS('s'), USR('u1'), ASS('a1'), USR('u2')];
  const out = injectDynamicAtDepth(msgs, 'DYN', 100);
  assert.equal(out.injectedAt, 1);
  assert.equal(out.messages[0].role, 'system');
  assert.equal(out.messages[0].content, 's');   // system still at 0
  assert.equal(out.messages[1].content, 'DYN'); // dynamic at 1
});

// ── Static prefix stability (the whole point) ────────────────────────

test('system-message prefix is unchanged by injection', () => {
  // The cache-stability invariant: messages[0..injectedAt-1] must
  // be identical to msgs[0..injectedAt-1]. Any difference here
  // would invalidate the upstream LLM's prefix cache.
  const msgs = [SYS('huge identity ~20KB'), USR('u1'), ASS('a1'),
                USR('u2'), ASS('a2'), USR('u3')];
  const out = injectDynamicAtDepth(msgs, 'DYN', 2);
  for (let i = 0; i < out.injectedAt; i++) {
    assert.equal(out.messages[i], msgs[i],
      `index ${i} must be the SAME reference as the input to keep the prefix cache hot`);
  }
});

test('injection is a system role (not user/assistant)', () => {
  const msgs = [SYS('s'), USR('u1'), ASS('a1'), USR('u2')];
  const out = injectDynamicAtDepth(msgs, 'DYN', 2);
  assert.equal(out.messages[out.injectedAt].role, 'system');
});

// ── Edge: empty messages array (defensive) ───────────────────────────

test('empty messages array still places dynamic at index 1 clamp', () => {
  const out = injectDynamicAtDepth([], 'DYN', 4);
  // Math.max(1, 0 - 4) = 1, but the array is empty so slice(0,1)
  // gives [], slice(1) gives []. Result is [dynamic-msg].
  assert.equal(out.injectedAt, 1);
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].content, 'DYN');
});
