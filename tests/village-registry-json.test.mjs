// village-registry-json.js — tolerant canonical-registry parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeJsonControlChars, parseRegistryJson } from '../src/village/village-registry-json.js';

test('clean JSON parses unchanged, repaired:false', () => {
  const text = JSON.stringify({ villagers: [{ name: 'Ada', note: 'likes tea' }] }, null, 2);
  const { value, repaired } = parseRegistryJson(text);
  assert.equal(repaired, false);
  assert.equal(value.villagers[0].name, 'Ada');
});

test('a raw newline inside a string literal is repaired and recovered', () => {
  // A control char sitting inside a string value — invalid JSON as-is.
  const broken = '{"note":"line one\nline two"}';
  assert.throws(() => JSON.parse(broken));           // baseline: really is invalid
  const { value, repaired } = parseRegistryJson(broken);
  assert.equal(repaired, true);
  assert.equal(value.note, 'line one\nline two');    // the newline is preserved, not dropped
});

test('raw tab and bell inside strings are escaped too', () => {
  const broken = '{"a":"x\ty","b":"zw"}';
  const { value, repaired } = parseRegistryJson(broken);
  assert.equal(repaired, true);
  assert.equal(value.a, 'x\ty');
  assert.equal(value.b, 'zw');
});

test('control chars OUTSIDE strings (structural whitespace) are left alone', () => {
  // Newlines between tokens are valid JSON whitespace — must not be altered.
  const pretty = '{\n  "k": 1,\n  "s": "v"\n}';
  const out = sanitizeJsonControlChars(pretty);
  assert.equal(out, pretty);                          // untouched
  assert.deepEqual(parseRegistryJson(pretty).value, { k: 1, s: 'v' });
});

test('an escaped \\n (backslash-n) is not double-processed', () => {
  const text = '{"note":"already\\nescaped"}';        // valid JSON, literal \n escape
  const { value, repaired } = parseRegistryJson(text);
  assert.equal(repaired, false);
  assert.equal(value.note, 'already\nescaped');
});

test('a quote escaped inside a string does not end the string early', () => {
  const broken = '{"q":"she said \\"hi\\"\nthen left"}'; // escaped quotes + a raw newline
  const { value, repaired } = parseRegistryJson(broken);
  assert.equal(repaired, true);
  assert.equal(value.q, 'she said "hi"\nthen left');
});

test('genuinely malformed JSON still throws the original error', () => {
  const garbage = '{"villagers": [ {name: unquoted } ]';  // not a control-char problem
  assert.throws(() => parseRegistryJson(garbage));
});

test('sanitizeJsonControlChars: non-string / empty inputs pass through', () => {
  assert.equal(sanitizeJsonControlChars(''), '');
  assert.equal(sanitizeJsonControlChars(null), null);
  assert.equal(sanitizeJsonControlChars(undefined), undefined);
});
