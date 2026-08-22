import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  materializeAttachments, resolveVisionCapable, findConnection,
  isModalityError, DEFAULT_MAX_LIVE_IMAGES, looksVisionCapable,
  describeAsset, resolveVisionConnection, scoreImageDescriptionThreat,
  graduateImageDescriptionToNode, ensureDescribed,
} from '../vision.js';
import { saveAsset, deleteAsset, getAssetMeta, setAssetDescription } from '../media.js';

function gif(w, h) {
  const b = Buffer.from('GIF89a\x00\x00\x00\x00\x00\x00\x00', 'binary');
  b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8);
  return b;
}

const created = [];
let _seq = 100;   // unique dimensions per call → unique bytes → unique sha (no dedup collisions)
async function mk(label, over = {}) {
  const w = over.w ?? _seq++;
  const h = over.h ?? _seq++;
  const { w: _w, h: _h, ...rest } = over;
  const m = await saveAsset({ buffer: gif(w, h), mime: 'image/gif', label, ...rest });
  created.push(m.id);
  return m;
}
after(async () => { for (const id of created) await deleteAsset(id); });

// ── Capability resolution ─────────────────────────────────────────

test("resolveVisionCapable: 'yes'/'no' are the ward's word; uncached auto follows the name heuristic (SAFE default)", async () => {
  assert.equal(await resolveVisionCapable({ visionCapable: 'yes' }, {}), true);
  assert.equal(await resolveVisionCapable({ visionCapable: 'no' }, {}), false);
  // The bug this replaced: an unknown/text-only model was waved through as
  // "optimistically capable" and got sent an image it couldn't see → it
  // hallucinated the contents. An unrecognised model is now treated as BLIND
  // (→ described), not sent live.
  assert.equal(await resolveVisionCapable({ visionCapable: 'auto', provider: 'p', model: 'glm-5.2' }, {}), false,
    'a text-only primary must NOT be assumed to see');
  assert.equal(await resolveVisionCapable({ provider: 'p', model: 'also-never' }, {}), false);
  // A recognised vision family still rides live out of the box.
  assert.equal(await resolveVisionCapable({ provider: 'p', model: 'gpt-4o' }, {}), true);
});

test('looksVisionCapable: recognises vision families, rejects their text-only siblings', () => {
  // Known vision-capable → true
  for (const m of ['gpt-4o', 'gpt-4.1-mini', 'gpt-5', 'claude-3-5-sonnet', 'claude-opus-4-8',
                   'gemini-2.0-flash', 'qwen2.5-vl-72b', 'qwen3-vl-plus', 'pixtral-12b',
                   'llama-3.2-90b-vision', 'llava-1.6', 'glm-4v', 'glm-4.6v', 'internvl2-8b',
                   'deepseek-vl-7b']) {
    assert.equal(looksVisionCapable('p', m), true, `${m} should read as vision-capable`);
  }
  // Text-only models — including vision families' non-vision siblings → false.
  // GLM 5.2 / GLM-4.6 are the exact false-positive that caused the incident.
  for (const m of ['glm-5.2', 'glm-4.6', 'glm-4-flash', 'deepseek-chat', 'deepseek-r1',
                   'qwen-plus', 'qwen2.5-72b-instruct', 'mistral-large', 'llama-3.1-70b',
                   'claude-2.1', 'gpt-3.5-turbo', 'kimi-k2', '']) {
    assert.equal(looksVisionCapable('p', m), false, `${m} must NOT read as vision-capable`);
  }
});

test('a z.ai-coding connection is NOT live-capable (chat cannot see) but IS chosen for describe', async () => {
  // Live capability: coding chat models can't take image_url → false, so the
  // materializer stands images in rather than sending them live.
  assert.equal(await resolveVisionCapable({ provider: 'zai-coding', visionCapable: 'yes' }, {}), false);
  // Describe: resolveVisionConnection still picks the coding connection (its
  // describe rides the coding-plan Vision MCP allotment).
  const settings = {
    connections: [{ id: 'coding', provider: 'zai-coding', model: 'glm-4.7', apiKey: 'k' }],
    featureConnections: { vision: 'coding' },
    primaryConnectionId: 'coding',
  };
  const conn = await resolveVisionConnection(settings);
  assert.equal(conn?.provider, 'zai-coding');
});

test('findConnection matches by provider+model', () => {
  const settings = { connections: [
    { provider: 'nanogpt', model: 'a', visionCapable: 'no' },
    { provider: 'zai', model: 'b', visionCapable: 'yes' },
  ]};
  assert.equal(findConnection(settings, { provider: 'zai', model: 'b' }).visionCapable, 'yes');
  assert.equal(findConnection(settings, { provider: 'x', model: 'y' }), null);
});

test("a ward 'no' on the saved connection is honored even via bare {provider,model}", async () => {
  const settings = { connections: [{ provider: 'nanogpt', model: 'text-only', visionCapable: 'no' }] };
  const conn = findConnection(settings, { provider: 'nanogpt', model: 'text-only' });
  assert.equal(await resolveVisionCapable(conn, settings), false);
});

// ── Materializer ──────────────────────────────────────────────────

test('no attachments anywhere → identity (same array, strings untouched)', async () => {
  const msgs = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }];
  const { messages, imagesLive, imagesStoodIn } = await materializeAttachments(msgs, { connection: { visionCapable: 'yes' } });
  assert.equal(messages, msgs);   // same reference — provably unchanged
  assert.equal(imagesLive, 0);
  assert.equal(imagesStoodIn, 0);
});

test('capable connection: image becomes a data-URL part beside the text', async () => {
  const m = await mk('a mug of tea');
  const msgs = [{ role: 'user', content: 'look', attachments: [{ id: m.id }] }];
  const { messages, imagesLive } = await materializeAttachments(msgs, { connection: { visionCapable: 'yes' } });
  assert.equal(imagesLive, 1);
  const content = messages[0].content;
  assert.ok(Array.isArray(content));
  assert.equal(content[0].type, 'text');
  assert.equal(content[0].text, 'look');
  assert.equal(content[1].type, 'image_url');
  assert.match(content[1].image_url.url, /^data:image\/gif;base64,/);
});

test('non-capable connection: content stays a string with a stand-in appended', async () => {
  const m = await mk('the sketch');
  const msgs = [{ role: 'user', content: 'look', attachments: [{ id: m.id }] }];
  const { messages, imagesLive, imagesStoodIn } = await materializeAttachments(msgs, { connection: { visionCapable: 'no' } });
  assert.equal(imagesLive, 0);
  assert.equal(imagesStoodIn, 1);
  assert.equal(typeof messages[0].content, 'string');
  assert.match(messages[0].content, /^look\n\[image the-sketch-/);
});

test('BLIND guard: an undescribed stand-in triggers the hard no-confabulation system line', async () => {
  // The trust-break: a model handed a marker for an image it cannot see invents
  // the contents (a food photo became "my human's face"). When any image stands
  // in with no description, the seam must inject the forceful don't-invent rule.
  const m = await mk('undescribed food photo');   // no description → blind
  const msgs = [{ role: 'user', content: 'what do you think?', attachments: [{ id: m.id }] }];
  const res = await materializeAttachments(msgs, { connection: { visionCapable: 'no' } });
  assert.equal(res.blindImageStandins, 1);
  const guard = res.messages.find(x => x.role === 'system' && /serious breach/.test(x.content));
  assert.ok(guard, 'a blind stand-in must carry the hard no-confabulation instruction');
  assert.match(guard.content, /don't describe them, guess their contents, or name who or what is in them/);
  // Must NOT bleed into the described case: it explicitly excludes a "what I saw
  // when I looked" description, so a model doesn't clam up about images it DOES
  // have words for (or read "text description" as "didn't really see it").
  assert.match(guard.content, /what I saw when I looked/);
  assert.match(guard.content, /text description still counts as having seen/);
});

test('BLIND guard: a DESCRIBED image does NOT trigger the hard rule (it can be talked about)', async () => {
  const m = await mk('a described mug');
  await setAssetDescription(m.id, 'a white mug of tea on a wooden table');
  const msgs = [{ role: 'user', content: 'nice?', attachments: [{ id: m.id }] }];
  const res = await materializeAttachments(msgs, { connection: { visionCapable: 'no' } });
  assert.equal(res.blindImageStandins, 0, 'a described image is not blind');
  const guard = res.messages.find(x => x.role === 'system' && /serious breach|never do it/.test(x.content));
  assert.equal(guard, undefined, 'no hard guard when the model has a real description to work from');
});

test('live budget: only the newest N ride live, older ones stand in', async () => {
  const a = await mk('one');
  const b = await mk('two');
  const c = await mk('three');
  const msgs = [
    { role: 'user', content: 'first', attachments: [{ id: a.id }] },
    { role: 'user', content: 'second', attachments: [{ id: b.id }, { id: c.id }] },
  ];
  const { messages, imagesLive, imagesStoodIn } = await materializeAttachments(msgs, {
    connection: { visionCapable: 'yes' }, maxLive: 2,
  });
  assert.equal(imagesLive, 2);        // b + c (newest)
  assert.equal(imagesStoodIn, 1);     // a (oldest) degraded
  assert.equal(typeof messages[0].content, 'string');   // 'first' message → stand-in only
  assert.match(messages[0].content, /\[image one-/);
  assert.ok(Array.isArray(messages[1].content));        // 'second' → two image parts
  assert.equal(messages[1].content.filter(p => p.type === 'image_url').length, 2);
});

test('audience gate (fail-closed): an out-of-scope asset contributes nothing', async () => {
  const priv = await mk('secret', { audienceTag: 'ward-private' });
  const roomOk = await mk('room pic', { audienceTag: 'room-42' });
  const msgs = [{ role: 'user', content: 'see', attachments: [{ id: priv.id }, { id: roomOk.id }] }];
  const { messages, imagesLive, imagesStoodIn } = await materializeAttachments(msgs, {
    connection: { visionCapable: 'yes' }, visibleAudiences: new Set(['room-42']),
  });
  // ward-private dropped entirely (no stand-in, no part); room-42 rides live.
  assert.equal(imagesLive, 1);
  assert.equal(imagesStoodIn, 0);
  const parts = messages[0].content;
  assert.ok(Array.isArray(parts));
  assert.ok(!JSON.stringify(parts).includes('secret'));   // nothing about the private asset leaked
});

test('a dangling reference degrades to a note, never throws', async () => {
  const msgs = [{ role: 'user', content: 'x', attachments: [{ id: 'gone-zz' }] }];
  const { messages, imagesStoodIn } = await materializeAttachments(msgs, { connection: { visionCapable: 'yes' } });
  assert.equal(imagesStoodIn, 1);
  assert.match(messages[0].content, /no longer available/);
});

test('outgoing provider messages never carry the internal attachments field', async () => {
  const m = await mk('leak check');
  const msgs = [{ role: 'user', content: 'hi', attachments: [{ id: m.id }] }];
  // Live path (array content) and stand-in path (string content) both strip it.
  const live = await materializeAttachments(msgs, { connection: { visionCapable: 'yes' } });
  assert.ok(!('attachments' in live.messages[0]));
  const stood = await materializeAttachments(msgs, { connection: { visionCapable: 'no' } });
  assert.ok(!('attachments' in stood.messages[0]));
});

test('a fully gated-out message drops its attachments field too', async () => {
  const priv = await mk('private', { audienceTag: 'ward-private' });
  const msgs = [{ role: 'user', content: 'x', attachments: [{ id: priv.id }] }];
  const { messages, imagesLive, imagesStoodIn } = await materializeAttachments(msgs, {
    connection: { visionCapable: 'yes' }, visibleAudiences: new Set(['room-1']),
  });
  assert.equal(imagesLive, 0);
  assert.equal(imagesStoodIn, 0);
  assert.ok(!('attachments' in messages[0]));
  assert.equal(messages[0].content, 'x');   // untouched string, nothing leaked
});

test('isModalityError classifies only modality-shaped 4xx', () => {
  assert.equal(isModalityError(400, 'this model does not support image_url content'), true);
  assert.equal(isModalityError(415, 'unsupported content type'), true);
  assert.equal(isModalityError(429, 'rate limit'), false);
  assert.equal(isModalityError(401, 'invalid api key'), false);
  assert.equal(isModalityError(400, 'temperature must be a number'), false);
});

// ── describeAsset (Pass 2, §6) — look once, keep forever ──────────

const okCompletion = (text) => ({
  ok: true, status: 200,
  text: async () => JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }),
});

test('resolveVisionConnection prefers the vision feature assignment when capable', async () => {
  const settings = {
    connections: [
      { id: 'blind', provider: 'nanogpt', model: 'text', apiKey: 'k', visionCapable: 'no' },
      { id: 'sees', provider: 'zai', model: 'v', apiKey: 'k', visionCapable: 'yes' },
    ],
    featureConnections: { vision: 'sees' },
    primaryConnectionId: 'blind',
  };
  const conn = await resolveVisionConnection(settings);
  assert.equal(conn.id, 'sees');
});

test('describeAsset caches a sanitized description via one injected call', async () => {
  const m = await mk('cluttered desk');
  let calls = 0;
  const fetchFn = async () => { calls++; return okCompletion('A mug of tea on a cluttered desk.'); };
  const settings = { connections: [{ id: 'v', provider: 'zai', model: 'x', apiKey: 'k', visionCapable: 'yes' }], primaryConnectionId: 'v' };
  const r = await describeAsset(m.id, settings, { fetchFn });
  assert.equal(calls, 1);
  assert.equal(r.description.text, 'A mug of tea on a cluttered desk.');
  // Cached — a second call never hits the provider again.
  const r2 = await describeAsset(m.id, settings, { fetchFn });
  assert.equal(calls, 1);
  assert.equal(r2.description.text, 'A mug of tea on a cluttered desk.');
});

test('ensureDescribed describes undescribed images synchronously and skips described ones', async () => {
  const a = await mk('to describe');
  const b = await mk('already described');
  await setAssetDescription(b.id, { text: 'already has words' });
  const settings = { connections: [{ id: 'v', provider: 'zai', model: 'x', apiKey: 'k', visionCapable: 'yes' }], primaryConnectionId: 'v' };
  let calls = 0;
  const fetchFn = async () => { calls++; return okCompletion('a freshly described scene'); };
  const r = await ensureDescribed(
    [{ attachments: [{ id: a.id }, { id: b.id }] }],
    settings, { fetchFn },
  );
  assert.equal(r.described, 1);                 // only the undescribed one
  assert.equal(calls, 1);                        // b was already described → no call
  assert.match((await getAssetMeta(a.id)).description.text, /a freshly described scene/);
});

test('describeAsset returns a reason (not a throw) when no connection can see', async () => {
  const m = await mk('unseen');
  const settings = { connections: [{ id: 'b', provider: 'nanogpt', model: 't', apiKey: 'k', visionCapable: 'no' }], primaryConnectionId: 'b' };
  const r = await describeAsset(m.id, settings, { fetchFn: async () => okCompletion('x') });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-vision-connection');
  assert.equal((await getAssetMeta(m.id)).description, null);   // stays null (retry later)
});

// ── Image → threat scoring (§15.1, ward-signed) ───────────────────

test('scoreImageDescriptionThreat: raises the tier on a distressing description (full weight)', async () => {
  const m = await mk('a hard image');
  await setAssetDescription(m.id, { text: 'a note with a distress message' });
  const recorded = [];
  const r = await scoreImageDescriptionThreat(m.id, {}, {
    scoreFn: () => ({ level: 6, signals: [{ id: 'crisis' }] }),   // pretend the description scored high
    recordFn: async (args) => { recorded.push(args); return { ok: true }; },
  });
  assert.equal(r.ok, true);
  assert.equal(r.raised, true);
  assert.equal(r.level, 6);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].delta, 6);          // FULL weight (no damping)
  assert.equal(recorded[0].source, 'vision');
});

test('scoreImageDescriptionThreat: RAISE-ONLY — a negative score never lowers the tier', async () => {
  const m = await mk('a calm image');
  await setAssetDescription(m.id, { text: 'a peaceful garden' });
  const recorded = [];
  const r = await scoreImageDescriptionThreat(m.id, {}, {
    scoreFn: () => ({ level: -3, signals: [] }),   // a de-escalating score
    recordFn: async (args) => { recorded.push(args); return { ok: true }; },
  });
  assert.equal(r.ok, true);
  assert.equal(r.raised, false);
  assert.equal(recorded.length, 0);   // never recorded — images can only raise
});

test('scoreImageDescriptionThreat: a villager image never moves the ward tier', async () => {
  const m = await mk('villager pic', { audienceTag: 'room-7', origin: { surface: 'discord', speaker: 'Sam' } });
  await setAssetDescription(m.id, { text: 'a distress message' });
  const recorded = [];
  const r = await scoreImageDescriptionThreat(m.id, {}, {
    scoreFn: () => ({ level: 9, signals: [] }),
    recordFn: async (args) => { recorded.push(args); return { ok: true }; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-ward-image');
  assert.equal(recorded.length, 0);
});

// ── Description → node graduation (§6.5 follow-up) ────────────────

test('graduateImageDescriptionToNode appends a dated observation to the node', async () => {
  const m = await mk('milkyway asleep');
  await setAssetDescription(m.id, { text: 'a grey tabby asleep on the windowsill' });
  let saved = null;
  const r = await graduateImageDescriptionToNode(m.id, 'milkyway-x7', {
    getNode: async () => ({ nodes: [{ id: 'milkyway-x7', label: 'Milkyway', description: 'My cat.' }] }),
    updateNode: async ({ id, description }) => { saved = { id, description }; return { ok: true }; },
  });
  assert.equal(r.graduated, true);
  assert.equal(saved.id, 'milkyway-x7');
  assert.match(saved.description, /My cat\./);                                   // kept existing
  assert.match(saved.description, /Seen in a photo .*grey tabby asleep/);        // appended
});

test('graduation is content-deduped — the same image never graduates twice', async () => {
  const m = await mk('same cat');
  await setAssetDescription(m.id, { text: 'a distinctive ginger cat' });
  let calls = 0;
  const opts = {
    getNode: async () => ({ nodes: [{ id: 'n1', description: 'Prior.\n\nSeen in a photo (today): a distinctive ginger cat' }] }),
    updateNode: async () => { calls++; return { ok: true }; },
  };
  const r = await graduateImageDescriptionToNode(m.id, 'n1', opts);
  assert.equal(r.already, true);
  assert.equal(calls, 0);   // already present → no write
});

test('graduation skips an undescribed or non-ward image', async () => {
  const undesc = await mk('no words yet');
  assert.equal((await graduateImageDescriptionToNode(undesc.id, 'n2', { getNode: async () => ({ nodes: [] }), updateNode: async () => ({ ok: true }) })).reason, 'no-description');
  const villager = await mk('theirs', { audienceTag: 'room-3' });
  await setAssetDescription(villager.id, { text: 'x' });
  assert.equal((await graduateImageDescriptionToNode(villager.id, 'n3', { getNode: async () => ({ nodes: [] }), updateNode: async () => ({ ok: true }) })).reason, 'not-ward-image');
});
