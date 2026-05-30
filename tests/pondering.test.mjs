import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fsp, mkdtempSync, rmSync } from 'fs';

import {
  ponderOnce,
  buildPonderPrompt,
  parsePondering,
  findOrCreatePonderingsTome,
  PONDERINGS_TOME_NAME,
} from '../pondering.js';

function tempTomesDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ponder-test-'));
  return {
    dir,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

function fakeLLM({ title = 'A quiet thought', content = 'I was thinking about it.' } = {}) {
  return async () => JSON.stringify({ title, content });
}

test('buildPonderPrompt embeds the topic verbatim', () => {
  const prompt = buildPonderPrompt('the way the user phrased their request');
  assert.match(prompt, /the way the user phrased their request/);
  assert.match(prompt, /first-person/i);
});

test('parsePondering accepts a clean JSON object', () => {
  const { title, content } = parsePondering('{"title":"hello","content":"world"}');
  assert.equal(title, 'hello');
  assert.equal(content, 'world');
});

test('parsePondering tolerates surrounding prose (extracts the JSON object)', () => {
  const { title, content } = parsePondering(
    'Here is your JSON:\n\n{"title":"a","content":"b"}\n\nHope that helps!'
  );
  assert.equal(title, 'a');
  assert.equal(content, 'b');
});

test('parsePondering rejects missing fields', () => {
  assert.throws(() => parsePondering('{"title":""}'), /title/i);
  assert.throws(() => parsePondering('{"title":"ok","content":""}'), /content/i);
});

test('parsePondering rejects non-JSON', () => {
  assert.throws(() => parsePondering('no braces here'), /No JSON object/i);
  assert.throws(() => parsePondering('{not really json}'), /not valid JSON/i);
});

test('findOrCreatePonderingsTome creates the tome on first call, reuses on second', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    const first  = await findOrCreatePonderingsTome(dir);
    const second = await findOrCreatePonderingsTome(dir);
    assert.equal(first.file, second.file);
    assert.equal(first.tome.name, PONDERINGS_TOME_NAME);
    assert.deepEqual(first.tome.entries, {});
    const files = await fsp.readdir(dir);
    assert.equal(files.filter(f => f.endsWith('.json')).length, 1);
  } finally { cleanup(); }
});

test('ponderOnce writes one entry to the ponderings tome', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    const result = await ponderOnce({
      topic:    'whether the loop should run at all',
      provider: 'nanogpt',
      apiKey:   'fake',
      model:    'fake',
      callLLM:  fakeLLM({ title: 'On running at all', content: 'I think it should.' }),
      tomesDir: dir,
    });

    assert.ok(result.uid);
    assert.equal(result.title,   'On running at all');
    assert.equal(result.content, 'I think it should.');

    const raw  = await fsp.readFile(result.tomeFile, 'utf8');
    const tome = JSON.parse(raw);
    const entries = Object.values(tome.entries);
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(e.comment,        'On running at all');
    assert.equal(e.content,        'I think it should.');
    assert.equal(e.scope,          'pondering');
    assert.equal(e.topic_pondered, 'whether the loop should run at all');
    assert.equal(e.enabled,        false, 'pondering entries must not auto-inject into chat');
    assert.deepEqual(e.keys,       [],    'pondering entries have no keyword triggers');
    assert.ok(e.created_at, 'entry is timestamped');
  } finally { cleanup(); }
});

test('ponderOnce appends — does not overwrite — when called twice', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    await ponderOnce({
      topic: 'first', provider: 'nanogpt', apiKey: 'k', model: 'm',
      callLLM: fakeLLM({ title: 'one', content: 'A' }),
      tomesDir: dir,
    });
    const second = await ponderOnce({
      topic: 'second', provider: 'nanogpt', apiKey: 'k', model: 'm',
      callLLM: fakeLLM({ title: 'two', content: 'B' }),
      tomesDir: dir,
    });

    const raw  = await fsp.readFile(second.tomeFile, 'utf8');
    const tome = JSON.parse(raw);
    const entries = Object.values(tome.entries);
    assert.equal(entries.length, 2);
    const titles = entries.map(e => e.comment).sort();
    assert.deepEqual(titles, ['one', 'two']);
  } finally { cleanup(); }
});

test('ponderOnce surfaces LLM failures', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    await assert.rejects(
      ponderOnce({
        topic: 'x', provider: 'nanogpt', apiKey: 'k', model: 'm',
        callLLM: async () => { throw new Error('provider down'); },
        tomesDir: dir,
      }),
      /provider down/,
    );
    // And no entry was written.
    const files = await fsp.readdir(dir);
    // The tome file may or may not exist (created lazily inside ponderOnce
    // depending on order). Either way, no entries should be present.
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const tome = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
      assert.deepEqual(tome.entries, {});
    }
  } finally { cleanup(); }
});

test('ponderOnce validates required inputs', async () => {
  await assert.rejects(ponderOnce({ provider: 'nanogpt', apiKey: 'k', model: 'm', callLLM: fakeLLM() }), /topic/i);
  await assert.rejects(ponderOnce({ topic: 't',           apiKey: 'k', model: 'm', callLLM: fakeLLM() }), /provider/i);
  await assert.rejects(ponderOnce({ topic: 't', provider: 'nanogpt',  model: 'm', callLLM: fakeLLM() }), /apiKey/i);
  await assert.rejects(ponderOnce({ topic: 't', provider: 'nanogpt', apiKey: 'k', callLLM: fakeLLM() }), /model/i);
});
