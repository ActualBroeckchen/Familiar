// voice-discord-adapter.js — the Discord CallAdapter (voice Pass 3a).
// Tested against a FAKE voice connection + fake Opus decoder: no socket, no UDP,
// no real Opus/WASM — the same seam discipline that let the web adapter be
// tested without a browser. The resample helpers are pure and asserted on
// concrete byte counts + values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createDiscordCallAdapter,
  resampleMono, downmixStereoToMono, monoToStereo,
  stereo48ToMono16, monoToStereo48,
} from '../voice-discord-adapter.js';

// ── Pure helpers ────────────────────────────────────────────────────────────

test('resampleMono: identity when rates match, else scales length by ratio', () => {
  const a = new Int16Array([1, 2, 3, 4]);
  assert.equal(resampleMono(a, 16000, 16000), a);          // same ref, no work
  assert.equal(resampleMono(a, 48000, 16000).length, 1);   // /3, floor
  assert.equal(resampleMono(a, 24000, 48000).length, 8);   // x2
});

test('downmixStereoToMono averages L+R; monoToStereo duplicates', () => {
  const stereo = new Int16Array([100, 200, 300, 500]); // frames (100,200)(300,500)
  assert.deepEqual([...downmixStereoToMono(stereo)], [150, 400]);
  assert.deepEqual([...monoToStereo(new Int16Array([7, 9]))], [7, 7, 9, 9]);
});

test('stereo48ToMono16: one 20ms Opus frame (960 stereo) → 320 mono 16k samples', () => {
  const stereo = Buffer.alloc(960 * 4);
  for (let k = 0; k < 960; k++) { stereo.writeInt16LE(1000, k * 4); stereo.writeInt16LE(1000, k * 4 + 2); }
  const out = stereo48ToMono16(stereo);
  assert.equal(out.length, 320 * 2);                 // 320 samples, s16le
  assert.equal(out.readInt16LE(0), 1000);            // constant tone preserved
});

test('monoToStereo48: 24k mono 20ms (480) → 48k stereo (960 frames = 3840 bytes)', () => {
  const mono = Buffer.alloc(480 * 2);
  for (let k = 0; k < 480; k++) mono.writeInt16LE(500, k * 2);
  const out = monoToStereo48(mono, 24000);
  assert.equal(out.length, 960 * 4);
  assert.equal(out.readInt16LE(0), 500);
  assert.equal(out.readInt16LE(2), 500);             // L and R equal (duplicated)
});

// ── Fakes for the adapter ───────────────────────────────────────────────────

function makeFakeReadable() {
  const r = new EventEmitter();
  r.destroy = () => { r.destroyed = true; };
  return r;
}

function makeFakeDeps() {
  const AudioPlayerStatus = { Idle: 'idle', Playing: 'playing' };
  const player = new EventEmitter();
  player.played = [];
  player.play = (resource) => { player.played.push(resource); };
  player.stop = () => { player.emit('idle'); return true; };
  const receiver = { speaking: new EventEmitter(), subscribed: [], subscribe(userId) { const s = makeFakeReadable(); this.subscribed.push({ userId, stream: s }); return s; } };
  const connection = Object.assign(new EventEmitter(), {
    receiver, subscribedPlayer: null, state: { status: 'ready' },
    subscribe(p) { this.subscribedPlayer = p; }, destroy() { this.destroyed = true; },
  });
  const deps = {
    joinVoiceChannel: (opts) => { deps._joinOpts = opts; return connection; },
    createAudioPlayer: () => player,
    createAudioResource: (stream, opts) => { deps._resource = { stream, opts }; return deps._resource; },
    entersState: async () => true,
    EndBehaviorType: { Manual: 0 },
    StreamType: { Raw: 'raw' },
    VoiceConnectionStatus: { Ready: 'ready' },
    AudioPlayerStatus,
    NoSubscriberBehavior: { Pause: 'pause' },
    makeOpusDecoder: () => ({ decode: (pkt) => { const b = Buffer.alloc(960 * 4); b.writeInt16LE(pkt?.[0] ?? 0, 0); return b; }, delete() {} }),
    _connection: connection, _player: player, _receiver: receiver,
  };
  return deps;
}

function makeHooks() {
  const calls = { pushAudio: [], endUtterance: [], rosterChanged: [] };
  return {
    hooks: {
      pushAudio: (f) => calls.pushAudio.push(f),
      endUtterance: (f) => calls.endUtterance.push(f),
      rosterChanged: (f) => calls.rosterChanged.push(f),
    },
    calls,
  };
}

const joinSpec = () => ({ guildId: 'g1', channelId: 'c1', adapterCreator: () => ({}), wardUserId: 'wardU', nameForUser: (id) => (id === 'wardU' ? 'Ward' : `Person ${id}`) });

// ── Adapter behaviour ───────────────────────────────────────────────────────

test('joinCall: joins, subscribes a player, wires speaking events, returns a callId', async () => {
  const deps = makeFakeDeps();
  const { hooks } = makeHooks();
  const { adapter } = createDiscordCallAdapter({ hooks, joinSpec: joinSpec(), deps });
  const { callId } = await adapter.joinCall();
  assert.match(callId, /^discord-g1-/);
  assert.equal(deps._connection.subscribedPlayer, deps._player);
  assert.equal(deps._joinOpts.selfDeaf, false);      // must hear my human
});

test('a speaker: speaking-start subscribes + decodes to 16k mono pushAudio; the ward maps to ward', async () => {
  const deps = makeFakeDeps();
  const { hooks, calls } = makeHooks();
  const { adapter } = createDiscordCallAdapter({ hooks, joinSpec: joinSpec(), deps });
  await adapter.joinCall();

  deps._receiver.speaking.emit('start', 'wardU');
  assert.equal(deps._receiver.subscribed.length, 1);
  const stream = deps._receiver.subscribed[0].stream;
  stream.emit('data', Buffer.from([42]));             // one fake Opus packet

  assert.equal(calls.pushAudio.length, 1);
  assert.equal(calls.pushAudio[0].speakerRef, 'ward');           // ward reserved
  assert.equal(calls.pushAudio[0].pcm.length, 320 * 2);          // decoded → 16k mono
});

test('speaking-end finalises the utterance and tears the subscription down', async () => {
  const deps = makeFakeDeps();
  const { hooks, calls } = makeHooks();
  const { adapter } = createDiscordCallAdapter({ hooks, joinSpec: joinSpec(), deps, slugId: (s) => s.toLowerCase().replace(/\s+/g, '-') });
  await adapter.joinCall();

  deps._receiver.speaking.emit('start', 'u2');
  const stream = deps._receiver.subscribed[0].stream;
  deps._receiver.speaking.emit('end', 'u2');

  assert.equal(calls.endUtterance.length, 1);
  assert.equal(calls.endUtterance[0].speakerRef, 'person-u2');   // display-name slug
  assert.equal(stream.destroyed, true);
});

test('roster: onVoiceStateChange add/remove drives rosterChanged with the member set', async () => {
  const deps = makeFakeDeps();
  const { hooks, calls } = makeHooks();
  const { adapter } = createDiscordCallAdapter({ hooks, joinSpec: joinSpec(), deps });
  await adapter.joinCall();

  adapter.onVoiceStateChange({ userId: 'u2', channelId: 'c1' });   // joined our channel
  adapter.onVoiceStateChange({ userId: 'u3', channelId: 'c1' });
  adapter.onVoiceStateChange({ userId: 'u2', channelId: null });   // left

  assert.equal(calls.rosterChanged.length, 3);
  assert.deepEqual(calls.rosterChanged.at(-1).members, ['u3']);
});

test('playAudio: pumps a reply, plays a Raw resource, resolves on idle', async () => {
  const deps = makeFakeDeps();
  const { hooks } = makeHooks();
  const { adapter } = createDiscordCallAdapter({ hooks, joinSpec: joinSpec(), deps });
  await adapter.joinCall();

  const reply = { sampleRate: 24000, async *[Symbol.asyncIterator]() { yield Buffer.alloc(480 * 2); } };
  const p = adapter.playAudio('id', reply);
  // Give the pump a tick, then signal the player finished.
  await new Promise((r) => setTimeout(r, 5));
  deps._player.emit('idle');
  await p;

  assert.equal(deps._resource.opts.inputType, 'raw');    // StreamType.Raw
  assert.equal(deps._player.played.length, 1);
  assert.equal(adapter.isSpeaking(), false);
});

test('playAudio(null) is a valid silent turn — no player.play, no throw', async () => {
  const deps = makeFakeDeps();
  const { hooks } = makeHooks();
  const { adapter } = createDiscordCallAdapter({ hooks, joinSpec: joinSpec(), deps });
  await adapter.joinCall();
  await adapter.playAudio('id', null);
  assert.equal(deps._player.played.length, 0);
});

test('stopPlayback (barge) stops the player, which resolves an in-flight playAudio', async () => {
  const deps = makeFakeDeps();
  const { hooks } = makeHooks();
  const { adapter } = createDiscordCallAdapter({ hooks, joinSpec: joinSpec(), deps });
  await adapter.joinCall();

  const reply = { sampleRate: 24000, async *[Symbol.asyncIterator]() { for (;;) { yield Buffer.alloc(480 * 2); await new Promise((r) => setTimeout(r, 1)); } } };
  const p = adapter.playAudio('id', reply);
  await new Promise((r) => setTimeout(r, 3));
  await adapter.stopPlayback();   // player.stop() → idle
  await p;                         // must resolve, not hang
  assert.equal(adapter.isSpeaking(), false);
});

test('leaveCall destroys the connection and clears open speakers', async () => {
  const deps = makeFakeDeps();
  const { hooks } = makeHooks();
  const { adapter } = createDiscordCallAdapter({ hooks, joinSpec: joinSpec(), deps });
  await adapter.joinCall();
  deps._receiver.speaking.emit('start', 'u2');
  const stream = deps._receiver.subscribed[0].stream;

  await adapter.leaveCall();
  assert.equal(deps._connection.destroyed, true);
  assert.equal(stream.destroyed, true);
});
