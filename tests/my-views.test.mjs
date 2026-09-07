// The `me` register read-back: my own standing views reach the turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMyViewsBlock } from '../src/memory/recent-ponderings.js';

test('empty or non-me items render nothing', () => {
  assert.equal(formatMyViewsBlock([]), '');
  assert.equal(formatMyViewsBlock(null), '');
  assert.equal(formatMyViewsBlock([{ register: 'ward', content: 'about them', id: 'x' }]), '');
});

test('me items render newest-first with ids, capped, in my own voice', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ register: 'me', id: `v-${i}`, content: `view ${i}` }));
  const out = formatMyViewsBlock(items);
  assert.match(out, /^What I think/);
  assert.match(out, /view 0.*\[id: v-0\]/);
  assert.doesNotMatch(out, /view 8/, 'capped at 8');
  assert.match(out, /update_memory_by_id/);
  assert.doesNotMatch(out, /\bthe user\b/i);
});

test('long content is truncated and whitespace collapsed', () => {
  const out = formatMyViewsBlock([{ register: 'me', content: 'a\n\n' + 'b'.repeat(400) }], { maxChars: 50 });
  const line = out.split('\n')[1];
  assert.ok(line.length < 60, line);
  assert.match(line, /…$/);
});
