import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IMAGE_MIME_EXT, AUDIO_MIME_EXT, VIDEO_MIME_EXT, MEDIA_KINDS, mediaKindFor, readImageSize,
} from '../src/vision/media.js';

/**
 * The store was written for images and hard-coded `kind: 'image'` while looking
 * the extension up from a separate map. Audio reaching it would have been
 * stored as an image carrying an audio extension — the kind of disagreement
 * that only shows up much later, in whatever tries to read it back.
 */

test('kind and extension come from the same lookup, so they cannot disagree', () => {
  for (const [mime, { kind, ext }] of Object.entries(MEDIA_KINDS)) {
    const fromImages = IMAGE_MIME_EXT[mime];
    const fromAudio = AUDIO_MIME_EXT[mime];
    const fromVideo = VIDEO_MIME_EXT[mime];
    assert.equal(ext, fromImages ?? fromAudio ?? fromVideo, `${mime} extension disagrees`);
    assert.equal(kind, fromImages ? 'image' : fromAudio ? 'audio' : 'video', `${mime} kind disagrees`);
  }
});

test('every image type still resolves as an image', () => {
  for (const mime of Object.keys(IMAGE_MIME_EXT)) {
    assert.equal(mediaKindFor(mime), 'image', mime);
  }
});

test('the audio types browsers actually record are accepted', () => {
  // webm and ogg are what MediaRecorder produces; wav and m4a are what phones
  // and desktop tools hand over.
  for (const mime of ['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/mpeg']) {
    assert.equal(mediaKindFor(mime), 'audio', mime);
  }
});

test('the wav aliases all land on the same extension', () => {
  // Browsers and OSes disagree about what to call a wav; the store should not.
  const exts = new Set(['audio/wav', 'audio/x-wav', 'audio/wave'].map((m) => MEDIA_KINDS[m].ext));
  assert.deepEqual([...exts], ['wav']);
});

test('anything not on the list is refused rather than guessed at', () => {
  // video/mp4 is now an accepted kind (the video patch); it's no longer here.
  for (const mime of ['application/pdf', 'text/plain', 'video/x-flv', '', null, undefined, 'image/svg+xml']) {
    assert.equal(mediaKindFor(mime), null, String(mime));
  }
});

test('no mime is claimed by both maps', () => {
  const overlap = Object.keys(IMAGE_MIME_EXT).filter((m) => m in AUDIO_MIME_EXT);
  assert.deepEqual(overlap, [], 'a type in both maps makes the kind arbitrary');
});

test('image dimension reading is unchanged, and never throws on audio bytes', () => {
  // A wav header parsed as a png one must yield nothing, not an exception —
  // saveAsset only skips this for audio because it knows the kind, and
  // defence in depth is cheap here.
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(4), Buffer.from('IHDR'),
    Buffer.from([0, 0, 0x01, 0x2c, 0, 0, 0, 0x64]),
  ]);
  assert.deepEqual(readImageSize(png), { width: 300, height: 100 });

  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')]);
  assert.doesNotThrow(() => readImageSize(wav));
});
