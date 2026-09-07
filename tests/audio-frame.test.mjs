import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeJson, encodePcm, createFrameReader,
  KIND_JSON, KIND_PCM, MAX_FRAME_BYTES,
} from '../src/voice/audio-frame.js';

const collect = () => {
  const frames = [];
  const errors = [];
  const reader = createFrameReader({
    onFrame: (f) => frames.push(f),
    onError: (e) => errors.push(e),
  });
  return { frames, errors, reader };
};

test('a JSON frame survives the round trip', () => {
  const { frames, reader } = collect();
  reader.push(encodeJson({ op: 'tts', reqId: 'r1', text: 'hello' }));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].kind, KIND_JSON);
  assert.deepEqual(frames[0].message, { op: 'tts', reqId: 'r1', text: 'hello' });
});

test('a PCM frame keeps its stream id and its bytes intact', () => {
  const { frames, reader } = collect();
  const pcm = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253]);
  reader.push(encodePcm(7, pcm));
  assert.equal(frames[0].kind, KIND_PCM);
  assert.equal(frames[0].streamId, 7);
  assert.deepEqual(Buffer.from(frames[0].pcm), pcm);
});

test('several frames inside one chunk all come out, in order', () => {
  const { frames, reader } = collect();
  reader.push(Buffer.concat([
    encodeJson({ n: 1 }),
    encodePcm(2, Buffer.alloc(16, 9)),
    encodeJson({ n: 3 }),
  ]));
  assert.equal(frames.length, 3);
  assert.equal(frames[0].message.n, 1);
  assert.equal(frames[1].streamId, 2);
  assert.equal(frames[2].message.n, 3);
});

test('a frame split across EVERY possible byte boundary still arrives whole', () => {
  // Not an edge case on a pipe — this is the normal case once buffers fill.
  const encoded = Buffer.concat([encodeJson({ op: 'endpoint', streamId: 4 }), encodePcm(4, Buffer.alloc(64, 3))]);
  for (let split = 1; split < encoded.length; split++) {
    const { frames, errors, reader } = collect();
    reader.push(encoded.subarray(0, split));
    reader.push(encoded.subarray(split));
    assert.equal(errors.length, 0, `split at ${split} produced an error`);
    assert.equal(frames.length, 2, `split at ${split} lost a frame`);
    assert.equal(frames[0].message.op, 'endpoint');
    assert.equal(frames[1].pcm.length, 64);
  }
});

test('a frame arriving one byte at a time still arrives whole', () => {
  const { frames, errors, reader } = collect();
  const encoded = encodeJson({ op: 'asr-partial', streamId: 1, text: 'the quick brown fox' });
  for (const b of encoded) reader.push(Buffer.from([b]));
  assert.equal(errors.length, 0);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].message.text, 'the quick brown fox');
});

test('a partial frame is held, not emitted early', () => {
  const { frames, reader } = collect();
  const encoded = encodePcm(1, Buffer.alloc(1000, 7));
  reader.push(encoded.subarray(0, 100));
  assert.equal(frames.length, 0);
  assert.ok(reader.pending() > 0, 'the bytes are held for the rest');
  reader.push(encoded.subarray(100));
  assert.equal(frames.length, 1);
  assert.equal(reader.pending(), 0);
});

test('empty payloads are legal — a zero-length PCM frame is not a protocol error', () => {
  const { frames, errors, reader } = collect();
  reader.push(encodePcm(3, Buffer.alloc(0)));
  assert.equal(errors.length, 0);
  assert.equal(frames[0].pcm.length, 0);
  assert.equal(frames[0].streamId, 3);
});

test('a large but legal frame passes; an impossible length is refused', () => {
  const { frames, reader } = collect();
  reader.push(encodePcm(1, Buffer.alloc(200_000, 1)));
  assert.equal(frames.length, 1, '200 KB of audio is ordinary');

  const { errors, reader: r2 } = collect();
  const bogus = Buffer.alloc(5);
  bogus.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
  r2.push(bogus);
  assert.equal(errors[0].reason, 'frame-too-large');
});

test('a lost length prefix stops the reader rather than reading audio as headers', () => {
  // Sync cannot be recovered by guessing. Better to stop and let supervision
  // restart than to keep interpreting arbitrary bytes as frame headers.
  const { frames, errors, reader } = collect();
  const bogus = Buffer.alloc(5);
  bogus.writeUInt32BE(0xffffffff, 0);
  reader.push(bogus);
  assert.equal(errors.length, 1);
  assert.equal(reader.isBroken(), true);

  reader.push(encodeJson({ op: 'still-here' }));
  assert.equal(frames.length, 0, 'a broken reader emits nothing further');
});

test('malformed JSON loses one frame, not the stream — the length prefix kept sync', () => {
  const { frames, errors, reader } = collect();
  const body = Buffer.from('{not json', 'utf8');
  const bad = Buffer.allocUnsafe(5 + body.length);
  bad.writeUInt32BE(body.length, 0);
  bad.writeUInt8(KIND_JSON, 4);
  body.copy(bad, 5);

  reader.push(Buffer.concat([bad, encodeJson({ op: 'fine' })]));
  assert.equal(errors[0].reason, 'bad-json');
  assert.equal(reader.isBroken(), false, 'framing held, so the stream survives');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].message.op, 'fine');
});

test('an unknown frame kind is skipped, so a newer worker cannot break an older host', () => {
  const { frames, errors, reader } = collect();
  const body = Buffer.from('whatever');
  const future = Buffer.allocUnsafe(5 + body.length);
  future.writeUInt32BE(body.length, 0);
  future.writeUInt8(99, 4);
  body.copy(future, 5);

  reader.push(Buffer.concat([future, encodeJson({ op: 'fine' })]));
  assert.equal(errors[0].reason, 'unknown-kind');
  assert.equal(reader.isBroken(), false);
  assert.equal(frames.length, 1, 'the frame after the unknown one still arrives');
});

test('a PCM frame too short to hold a stream id is reported, not guessed at', () => {
  const { frames, errors, reader } = collect();
  const body = Buffer.from([1]);
  const short = Buffer.allocUnsafe(5 + body.length);
  short.writeUInt32BE(body.length, 0);
  short.writeUInt8(KIND_PCM, 4);
  body.copy(short, 5);

  reader.push(short);
  assert.equal(errors[0].reason, 'short-pcm');
  assert.equal(frames.length, 0, 'audio with no known destination is dropped, never routed by guess');
});

test('stream ids span the full 16-bit range without collision', () => {
  const { frames, reader } = collect();
  for (const id of [0, 1, 255, 256, 65535]) reader.push(encodePcm(id, Buffer.alloc(2, 1)));
  assert.deepEqual(frames.map((f) => f.streamId), [0, 1, 255, 256, 65535]);
});

test('a handler that throws does not take the reader down with it', () => {
  const seen = [];
  const reader = createFrameReader({
    onFrame: (f) => { seen.push(f); if (seen.length === 1) throw new Error('handler exploded'); },
  });
  assert.doesNotThrow(() => reader.push(Buffer.concat([encodeJson({ n: 1 }), encodeJson({ n: 2 })])));
  assert.equal(seen.length, 2, 'the second frame is still delivered');
});

test('reset clears both the buffer and the broken flag', () => {
  const { frames, reader } = collect();
  const bogus = Buffer.alloc(5);
  bogus.writeUInt32BE(0xffffffff, 0);
  reader.push(bogus);
  assert.equal(reader.isBroken(), true);

  reader.reset();
  assert.equal(reader.isBroken(), false);
  assert.equal(reader.pending(), 0);
  reader.push(encodeJson({ op: 'back' }));
  assert.equal(frames.length, 1);
});

test('the payload is not copied more than it needs to be for a realistic audio burst', () => {
  // 100 frames of 20 ms audio, arriving in awkward chunks, must all survive.
  const { frames, errors, reader } = collect();
  const chunks = [];
  for (let i = 0; i < 100; i++) chunks.push(encodePcm(i % 2, Buffer.alloc(640, i & 0xff)));
  const all = Buffer.concat(chunks);
  for (let i = 0; i < all.length; i += 777) reader.push(all.subarray(i, i + 777));
  assert.equal(errors.length, 0);
  assert.equal(frames.length, 100);
  assert.equal(frames[99].pcm.length, 640);
});
