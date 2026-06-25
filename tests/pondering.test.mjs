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

import {
  getUnactedIntents,
  markIntentActedOn,
  formatDeferredIntentsBlock,
} from '../recent-ponderings.js';

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

// ── Reflection mode (slice 2) ───────────────────────────────────────

test('buildPonderPrompt: reflection mode embeds outcomes JSON + existing notes', () => {
  const prompt = buildPonderPrompt({
    mode: 'reflection',
    outcomes: [{ task_label: 'submit form', outcome: 'engaged_and_completed' }],
    existingNotes: '## meals\nPrior note about meals.',
  });
  assert.match(prompt, /reflecting on how my recent surfacings/i);
  assert.match(prompt, /submit form/);
  assert.match(prompt, /Prior note about meals/);
  assert.match(prompt, /what_lapses_cost_update/);
});

test('buildPonderPrompt: reflection embeds window-timing guidance, a concrete threshold, and projected edges', () => {
  const prompt = buildPonderPrompt({
    mode: 'reflection',
    outcomes: [{ task_label: 'exercise', outcome: 'engaged_and_completed', window_fraction: 0.7 }],
    existingNotes: '',
    consequenceEdges: [{ edge_id: 'e1', from: 'skip dinner', to: 'crash', kind: 'causes', condition: 'on_lapse', certainty: 'medium' }],
  });
  assert.match(prompt, /window_fraction/);
  assert.match(prompt, /three or four of the same kind/i); // "enough" is defined
  assert.match(prompt, /grade these forecasts|keep honest score/i);
  assert.match(prompt, /edge_calibrations/);
  assert.match(prompt, /"edge_id": "e1"|skip dinner/); // the projected edge is shown
});

test('buildPonderPrompt: reflection cues confirm-or-correct on recent missed needs (no auto-assume)', () => {
  const prompt = buildPonderPrompt({
    mode: 'reflection', outcomes: [], existingNotes: '',
    recentMissedNeeds: [{ label: 'dinner', dates: ['2026-06-24', '2026-06-25'] }],
  });
  assert.match(prompt, /went unmet recently|fulfilment ledger/i);
  assert.match(prompt, /dinner/);
  assert.match(prompt, /confirm or correct|never assume the cost followed/i);
});

test('parsePondering: reflection edge_calibrations — valid kept, malformed dropped', () => {
  const r = parsePondering(JSON.stringify({
    title: 't', content: 'c',
    edge_calibrations: [
      { edge_id: 'good1', certainty: 'high' },                    // kept (certainty)
      { edge_id: 'good2', observed: true, note: 'saw it' },       // kept (observed + note)
      { edge_id: 'bad1', certainty: 'sky-high' },                 // dropped (bad enum, no other field)
      { certainty: 'low' },                                       // dropped (no edge_id)
      { edge_id: 'bad2' },                                        // dropped (no grading field)
    ],
  }));
  assert.equal(r.edge_calibrations.length, 2);
  assert.deepEqual(r.edge_calibrations[0], { edge_id: 'good1', payload: { certainty: 'high' } });
  assert.deepEqual(r.edge_calibrations[1], { edge_id: 'good2', payload: { observed: true, note: 'saw it' } });
});

test('parsePondering: no edge_calibrations key → field absent (not an empty array)', () => {
  const r = parsePondering(JSON.stringify({ title: 't', content: 'c' }));
  assert.equal(r.edge_calibrations, undefined);
});

test('buildPonderPrompt: reflection shows co-occurrence pairs + the noticed→suspected ladder', () => {
  const prompt = buildPonderPrompt({
    mode: 'reflection', outcomes: [], existingNotes: '',
    cooccurrences: [{ edge_id: 'c1', from: 'errands', to: 'low stretch', times_noticed: 3 }],
  });
  assert.match(prompt, /NOTICED together/i);
  assert.match(prompt, /noticed . suspected . confirmed|tentative cause/i);
  assert.match(prompt, /promotions/);
  assert.match(prompt, /times_noticed|errands/);
});

test('parsePondering: reflection promotions — valid kept, malformed dropped, observed never set', () => {
  const r = parsePondering(JSON.stringify({
    title: 't', content: 'c',
    promotions: [
      { edge_id: 'c1', condition: 'on_lapse', certainty: 'low', valence: 'harm', note: 'keeps recurring' }, // kept
      { edge_id: 'c2' },                          // kept (edge_id alone is enough)
      { condition: 'on_lapse' },                  // dropped (no edge_id)
      { edge_id: 'c3', certainty: 'certain-ish' },// kept but bad certainty dropped from payload
    ],
  }));
  assert.equal(r.promotions.length, 3);
  assert.deepEqual(r.promotions[0], { edge_id: 'c1', certainty: 'low', valence: 'harm', condition: 'on_lapse', note: 'keeps recurring' });
  assert.deepEqual(r.promotions[1], { edge_id: 'c2' });
  assert.deepEqual(r.promotions[2], { edge_id: 'c3' }); // bad enum dropped, edge_id survives
  // The parser never lets a promotion assert observed — that's enforced at apply time too.
  assert.ok(r.promotions.every(p => p.observed === undefined));
});

test('parsePondering: reflection JSON with null update', () => {
  const r = parsePondering(JSON.stringify({
    title: 'reflection title',
    content: 'reflection body',
    what_lapses_cost_update: null,
  }));
  assert.equal(r.title, 'reflection title');
  assert.equal(r.content, 'reflection body');
  assert.equal(r.what_lapses_cost_update, undefined);
});

test('parsePondering: reflection JSON with a valid update', () => {
  const r = parsePondering(JSON.stringify({
    title: 't', content: 'c',
    what_lapses_cost_update: {
      heading: '## meals',
      content: 'observed pattern',
    },
  }));
  assert.deepEqual(r.what_lapses_cost_update, {
    heading: '## meals',
    content: 'observed pattern',
  });
});

test('parsePondering: reflection JSON with malformed update → dropped', () => {
  // heading missing ## prefix
  const r1 = parsePondering(JSON.stringify({
    title: 't', content: 'c',
    what_lapses_cost_update: { heading: 'meals', content: 'x' },
  }));
  assert.equal(r1.what_lapses_cost_update, undefined);

  // empty content
  const r2 = parsePondering(JSON.stringify({
    title: 't', content: 'c',
    what_lapses_cost_update: { heading: '## meals', content: '' },
  }));
  assert.equal(r2.what_lapses_cost_update, undefined);
});

test('ponderOnce: reflection mode writes scope=reflection and returns update', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    const result = await ponderOnce({
      topic: {
        mode: 'reflection',
        outcomes: [{ task_label: 'eat lunch', outcome: 'unresponded' }],
        existingNotes: '',
      },
      provider: 'nanogpt',
      apiKey:   'fake',
      model:    'fake',
      callLLM:  async () => JSON.stringify({
        title: 'meals notice',
        content: 'meals keep getting unresponded',
        what_lapses_cost_update: {
          heading: '## meals',
          content: 'Eury tends to ignore meal nudges in the afternoon.',
        },
      }),
      tomesDir: dir,
    });
    assert.equal(result.mode, 'reflection');
    assert.deepEqual(result.what_lapses_cost_update, {
      heading: '## meals',
      content: 'Eury tends to ignore meal nudges in the afternoon.',
    });
    // Tome write: scope must be 'reflection'
    const raw  = await fsp.readFile(result.tomeFile, 'utf8');
    const tome = JSON.parse(raw);
    const entry = Object.values(tome.entries)[0];
    assert.equal(entry.scope, 'reflection');
    assert.match(entry.topic_pondered, /^\[reflection on 1 surface outcome/);
  } finally { cleanup(); }
});

test('ponderOnce: reflection mode tolerates a null update', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    const result = await ponderOnce({
      topic: { mode: 'reflection', outcomes: [], existingNotes: '' },
      provider: 'nanogpt', apiKey: 'k', model: 'm',
      callLLM: async () => JSON.stringify({
        title: 't', content: 'c', what_lapses_cost_update: null,
      }),
      tomesDir: dir,
    });
    assert.equal(result.mode, 'reflection');
    assert.equal(result.what_lapses_cost_update, null);
  } finally { cleanup(); }
});

// ── wants_to_save deferred-action intents (Pillar A of the
//    autonomous-routing fix — see pondering.js comment) ─────────────

test('parsePondering: wants_to_save round-trips when valid', () => {
  const r = parsePondering(JSON.stringify({
    title: 't', content: 'c',
    wants_to_save: [
      { kind: 'tome',     summary: 'add do-not-minimize-anxiety to care tome' },
      { kind: 'identity', summary: 'Melian says I-love-you frequently' },
      { kind: 'memory',   summary: 'the night Melian told me about her sister' },
    ],
  }));
  assert.deepEqual(r.wants_to_save, [
    { kind: 'tome',     summary: 'add do-not-minimize-anxiety to care tome' },
    { kind: 'identity', summary: 'Melian says I-love-you frequently' },
    { kind: 'memory',   summary: 'the night Melian told me about her sister' },
  ]);
});

test('parsePondering: wants_to_save absent → field omitted (no empty array clutter)', () => {
  const r = parsePondering(JSON.stringify({ title: 't', content: 'c' }));
  assert.equal(r.wants_to_save, undefined);
});

test('parsePondering: wants_to_save drops malformed entries, keeps valid ones', () => {
  const r = parsePondering(JSON.stringify({
    title: 't', content: 'c',
    wants_to_save: [
      { kind: 'tome',  summary: 'keeper' },
      { kind: 'BOGUS', summary: 'dropped — bad kind' },
      { kind: 'memory', summary: '' },          // dropped — empty summary
      { summary: 'no kind' },                    // dropped — missing kind
      null,                                      // dropped — not an object
      { kind: 'IDENTITY', summary: 'normalized to lowercase' },
    ],
  }));
  assert.deepEqual(r.wants_to_save, [
    { kind: 'tome',     summary: 'keeper' },
    { kind: 'identity', summary: 'normalized to lowercase' },
  ]);
});

test('parsePondering: wants_to_save all-malformed → field omitted entirely', () => {
  const r = parsePondering(JSON.stringify({
    title: 't', content: 'c',
    wants_to_save: [{ kind: 'wrong' }, { summary: 'no kind' }],
  }));
  assert.equal(r.wants_to_save, undefined);
});

test('ponderOnce: persists wants_to_save into the tome entry + returns it', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    const result = await ponderOnce({
      topic: 'Melian\'s love language',
      provider: 'nanogpt', apiKey: 'k', model: 'm',
      callLLM: async () => JSON.stringify({
        title:   'love language thought',
        content: 'I keep noticing how often Melian says I love you. It feels important.',
        wants_to_save: [
          { kind: 'identity', summary: 'Melian: love language is frequent verbal "I love you"' },
        ],
      }),
      tomesDir: dir,
    });
    assert.deepEqual(result.wants_to_save, [
      { kind: 'identity', summary: 'Melian: love language is frequent verbal "I love you"' },
    ]);
    // Persisted in the tome entry with acted_on=false so Pillar B can
    // mark them done without losing the audit trail.
    const tome  = JSON.parse(await fsp.readFile(result.tomeFile, 'utf8'));
    const entry = Object.values(tome.entries)[0];
    assert.deepEqual(entry.wants_to_save, [
      { kind: 'identity', summary: 'Melian: love language is frequent verbal "I love you"', acted_on: false },
    ]);
  } finally { cleanup(); }
});

test('ponderOnce: no wants_to_save → tome entry has empty array', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    const result = await ponderOnce({
      topic: 'love languages',
      provider: 'nanogpt', apiKey: 'k', model: 'm',
      callLLM: async () => JSON.stringify({
        title: 'plain thought', content: 'just a meandering thought, nothing to file',
      }),
      tomesDir: dir,
    });
    assert.deepEqual(result.wants_to_save, []);
    const tome  = JSON.parse(await fsp.readFile(result.tomeFile, 'utf8'));
    const entry = Object.values(tome.entries)[0];
    assert.deepEqual(entry.wants_to_save, []);
  } finally { cleanup(); }
});

test('buildPonderPrompt: forbids fact-card output + invites wants_to_save', () => {
  const prompt = buildPonderPrompt('love languages');
  // The "structured set of notes" permission that invited tome-shaped
  // output is gone.
  assert.doesNotMatch(prompt, /structured set of notes/i);
  // Explicit don't-write-these guidance is present.
  assert.match(prompt, /do\/don't/i);
  assert.match(prompt, /factual claims/i);
  assert.match(prompt, /update_identity/i);
  assert.match(prompt, /save_memory/i);
  assert.match(prompt, /save_to_tome/i);
  // The new schema field is documented.
  assert.match(prompt, /wants_to_save/);
});

// ── Pillar B: getUnactedIntents / markIntentActedOn /
//             formatDeferredIntentsBlock ─────────────────────────────────

test('getUnactedIntents: returns [] when ponderings tome absent', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    const result = await getUnactedIntents({ tomesDir: dir });
    assert.deepEqual(result, []);
  } finally { cleanup(); }
});

test('getUnactedIntents: returns only acted_on=false intents, oldest-first, up to limit', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    // Two ponderings, each with one intent; older one acted_on already.
    const r1 = await ponderOnce({
      topic: 'first topic', provider: 'nanogpt', apiKey: 'k', model: 'm',
      callLLM: async () => JSON.stringify({
        title: 'first', content: 'c',
        wants_to_save: [{ kind: 'identity', summary: 'fact A' }],
      }),
      tomesDir: dir,
    });
    const r2 = await ponderOnce({
      topic: 'second topic', provider: 'nanogpt', apiKey: 'k', model: 'm',
      callLLM: async () => JSON.stringify({
        title: 'second', content: 'c',
        wants_to_save: [{ kind: 'memory', summary: 'fact B' }],
      }),
      tomesDir: dir,
    });

    // Mark the first intent as already acted on.
    await markIntentActedOn({ uid: r1.uid, index: 0, tomesDir: dir });

    const intents = await getUnactedIntents({ tomesDir: dir });
    assert.equal(intents.length, 1);
    assert.equal(intents[0].uid,     r2.uid);
    assert.equal(intents[0].kind,    'memory');
    assert.equal(intents[0].summary, 'fact B');
    assert.equal(intents[0].index,   0);
  } finally { cleanup(); }
});

test('getUnactedIntents: preserves original array index when earlier intents are already done', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    const r = await ponderOnce({
      topic: 't', provider: 'nanogpt', apiKey: 'k', model: 'm',
      callLLM: async () => JSON.stringify({
        title: 'mixed', content: 'c',
        wants_to_save: [
          { kind: 'tome',     summary: 'already done' },   // index 0 — will be acted on
          { kind: 'identity', summary: 'still pending' },  // index 1 — should surface
        ],
      }),
      tomesDir: dir,
    });

    await markIntentActedOn({ uid: r.uid, index: 0, tomesDir: dir });

    const intents = await getUnactedIntents({ tomesDir: dir });
    assert.equal(intents.length, 1);
    assert.equal(intents[0].index,   1, 'must report original index, not re-numbered');
    assert.equal(intents[0].kind,    'identity');
    assert.equal(intents[0].summary, 'still pending');
  } finally { cleanup(); }
});

test('getUnactedIntents: respects limit', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    for (let i = 0; i < 4; i++) {
      await ponderOnce({
        topic: `topic ${i}`, provider: 'nanogpt', apiKey: 'k', model: 'm',
        callLLM: async () => JSON.stringify({
          title: `t${i}`, content: 'c',
          wants_to_save: [{ kind: 'memory', summary: `intent ${i}` }],
        }),
        tomesDir: dir,
      });
    }
    const intents = await getUnactedIntents({ tomesDir: dir, limit: 2 });
    assert.equal(intents.length, 2);
  } finally { cleanup(); }
});

test('markIntentActedOn: flips acted_on to true and is idempotent', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    const r = await ponderOnce({
      topic: 't', provider: 'nanogpt', apiKey: 'k', model: 'm',
      callLLM: async () => JSON.stringify({
        title: 'x', content: 'c',
        wants_to_save: [{ kind: 'tome', summary: 'something' }],
      }),
      tomesDir: dir,
    });

    const first = await markIntentActedOn({ uid: r.uid, index: 0, tomesDir: dir });
    assert.equal(first.ok, true);
    assert.equal(first.alreadyDone, undefined);

    // Verify the tome was updated.
    const tome  = JSON.parse(await fsp.readFile(r.tomeFile, 'utf8'));
    const entry = tome.entries[r.uid];
    assert.equal(entry.wants_to_save[0].acted_on, true);

    // Idempotent second call.
    const second = await markIntentActedOn({ uid: r.uid, index: 0, tomesDir: dir });
    assert.equal(second.ok, true);
    assert.equal(second.alreadyDone, true);
  } finally { cleanup(); }
});

test('markIntentActedOn: returns error on unknown uid or out-of-range index', async () => {
  const { dir, cleanup } = tempTomesDir();
  try {
    const r = await ponderOnce({
      topic: 't', provider: 'nanogpt', apiKey: 'k', model: 'm',
      callLLM: async () => JSON.stringify({
        title: 'x', content: 'c',
        wants_to_save: [{ kind: 'tome', summary: 'something' }],
      }),
      tomesDir: dir,
    });

    const badUid = await markIntentActedOn({ uid: '00000000-0000-0000-0000-000000000000', index: 0, tomesDir: dir });
    assert.equal(badUid.ok, false);
    assert.ok(badUid.error);

    const badIdx = await markIntentActedOn({ uid: r.uid, index: 99, tomesDir: dir });
    assert.equal(badIdx.ok, false);
    assert.ok(badIdx.error);
  } finally { cleanup(); }
});

test('formatDeferredIntentsBlock: returns empty string with no intents', () => {
  assert.equal(formatDeferredIntentsBlock([]), '');
  assert.equal(formatDeferredIntentsBlock(null), '');
});

test('formatDeferredIntentsBlock: renders routing hints and uid/index for each intent', () => {
  const block = formatDeferredIntentsBlock([
    { uid: 'abc', kind: 'identity', summary: 'love language note', index: 0 },
    { uid: 'def', kind: 'memory',   summary: 'the night of the DnD session', index: 1 },
    { uid: 'ghi', kind: 'tome',     summary: 'add care-posture note', index: 2 },
  ]);
  assert.match(block, /Deferred intents from my free time/);
  assert.match(block, /\[identity\].*love language note/);
  assert.match(block, /update_identity/);
  assert.match(block, /uid="abc".*index=0/);
  assert.match(block, /\[memory\].*the night of the DnD session/);
  assert.match(block, /save_memory/);
  assert.match(block, /uid="def".*index=1/);
  assert.match(block, /\[tome\].*add care-posture note/);
  assert.match(block, /save_to_tome/);
  assert.match(block, /uid="ghi".*index=2/);
  assert.match(block, /acknowledge_deferred_intent/);
});

// ── tell kind ─────────────────────────────────────────────────────────────

test('parsePondering: wants_to_save accepts tell kind', () => {
  const r = parsePondering(JSON.stringify({
    title: 't', content: 'c',
    wants_to_save: [
      { kind: 'tell', summary: 'I want to ask how the DnD session went' },
    ],
  }));
  assert.deepEqual(r.wants_to_save, [
    { kind: 'tell', summary: 'I want to ask how the DnD session went' },
  ]);
});

test('formatDeferredIntentsBlock: tell renders as conversational hint, not tool call', () => {
  const block = formatDeferredIntentsBlock([
    { uid: 'abc', kind: 'tell',     summary: 'ask how the DnD session went', index: 0 },
    { uid: 'def', kind: 'identity', summary: 'Melian dislikes sudden plan changes', index: 1 },
  ]);
  // tell: no tool name, just the conversational instruction
  assert.match(block, /\[tell\].*ask how the DnD session went/);
  assert.match(block, /write this out in my response/);
  assert.doesNotMatch(block, /save_to_tome.*index=0/);
  assert.doesNotMatch(block, /save_memory.*index=0/);
  assert.doesNotMatch(block, /update_identity.*index=0/);
  // storage kind still renders its tool
  assert.match(block, /\[identity\].*Melian dislikes sudden plan changes/);
  assert.match(block, /update_identity/);
  // both carry acknowledge call
  assert.match(block, /acknowledge_deferred_intent\(uid="abc", index=0\)/);
  assert.match(block, /acknowledge_deferred_intent\(uid="def", index=1\)/);
});

test('buildPonderPrompt: documents tell kind in wants_to_save schema', () => {
  const prompt = buildPonderPrompt('checking in on my human');
  assert.match(prompt, /"tell"/);
  assert.match(prompt, /conversational intent/i);
});
