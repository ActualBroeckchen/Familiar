// discord-gif-embeds.js — Tenor/Giphy gifv embeds → watchable media references.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isGifEmbed, directMediaUrl, labelFromGifPage, mediaFilename,
  gifEmbedMedia, parseGifEmbeds, gifEmbedsDisabled,
} from '../src/discord/discord-gif-embeds.js';

// A realistic Tenor gifv embed as Discord delivers it.
const tenor = {
  type: 'gifv',
  url: 'https://tenor.com/view/cat-flopping-over-gif-12345678',
  provider: { name: 'Tenor', url: 'https://tenor.com' },
  thumbnail: { url: 'https://media.tenor.com/abc/cat.png', proxy_url: 'https://media.discordapp.net/external/h1/https/media.tenor.com/abc/cat.png', width: 220, height: 220 },
  video: { url: 'https://media.tenor.com/abc/cat.mp4', proxy_url: 'https://media.discordapp.net/external/h2/https/media.tenor.com/abc/cat.mp4', width: 220, height: 220 },
};

// A plain article link preview — must NEVER be ingested as a gif.
const article = {
  type: 'article',
  url: 'https://example.com/news/story',
  provider: { name: 'Example News' },
  thumbnail: { url: 'https://example.com/hero.jpg', proxy_url: 'https://media.discordapp.net/external/h3/https/example.com/hero.jpg' },
};

// ── isGifEmbed ──────────────────────────────────────────────────────
test('isGifEmbed: gifv, Tenor/Giphy provider, and direct .gif images are gifs; an article is not', () => {
  assert.equal(isGifEmbed(tenor), true, 'type gifv');
  assert.equal(isGifEmbed({ type: 'image', provider: { name: 'Giphy' } }), true, 'provider Giphy');
  assert.equal(isGifEmbed({ type: 'image', url: 'https://x.test/a.gif', thumbnail: { url: 'https://x.test/a.gif' } }), true, 'a direct .gif rendered as an image');
  assert.equal(isGifEmbed({ url: 'https://tenor.com/view/x-gif-1' }), true, 'a tenor host');
  assert.equal(isGifEmbed(article), false, 'an article preview is not a gif');
  assert.equal(isGifEmbed(null), false);
  assert.equal(isGifEmbed({ type: 'image', url: 'https://x.test/photo.png' }), false, 'a plain image link is not a gif');
});

// ── directMediaUrl ──────────────────────────────────────────────────
test('directMediaUrl: prefers proxy_url; a bare url only when it points at media (not a page)', () => {
  assert.equal(directMediaUrl(tenor.video), tenor.video.proxy_url, 'proxied direct media wins');
  assert.equal(directMediaUrl({ url: 'https://media.tenor.com/abc/cat.mp4' }), 'https://media.tenor.com/abc/cat.mp4', 'a media url is fetchable');
  assert.equal(directMediaUrl({ url: 'https://tenor.com/view/cat-gif-1' }), '', 'a page url is NOT fetched as bytes');
  assert.equal(directMediaUrl(null), '');
});

// ── labelFromGifPage ────────────────────────────────────────────────
test('labelFromGifPage: recovers the descriptive slug, strips the trailing id', () => {
  assert.equal(labelFromGifPage('https://tenor.com/view/cat-flopping-over-gif-12345678'), 'cat flopping over');
  assert.equal(labelFromGifPage('https://giphy.com/gifs/happy-dance-l0HlvtIPzPdt2usKs'), 'happy dance', 'giphy trailing id dropped');
  assert.equal(labelFromGifPage('https://tenor.com/view/'), '', 'nothing meaningful → empty');
  assert.equal(labelFromGifPage('not a url'), '');
});

// ── mediaFilename ───────────────────────────────────────────────────
test('mediaFilename: the url basename when it has a media ext, else the fallback', () => {
  assert.equal(mediaFilename('https://media.tenor.com/abc/cat.mp4', 'gif.mp4'), 'cat.mp4');
  assert.equal(mediaFilename('https://media.discordapp.net/external/h2/https/media.tenor.com/abc/cat.mp4', 'gif.mp4'), 'cat.mp4');
  assert.equal(mediaFilename('https://tenor.com/view/cat-gif-1', 'gif.mp4'), 'gif.mp4', 'a page url falls back');
});

// ── gifEmbedMedia / parseGifEmbeds ──────────────────────────────────
test('gifEmbedMedia: pulls the mp4 and the still poster from a gifv embed', () => {
  const m = gifEmbedMedia(tenor);
  assert.equal(m.videoUrl, tenor.video.proxy_url);
  assert.equal(m.imageUrl, tenor.thumbnail.proxy_url);
  assert.equal(m.page, tenor.url);
  assert.equal(m.width, 220);
  assert.equal(gifEmbedMedia(article), null, 'an article yields no media');
});

test('parseGifEmbeds: every distinct gif in a message, deduped, article ignored', () => {
  const msg = { embeds: [tenor, article, tenor] };   // the duplicate + the article both drop out
  const got = parseGifEmbeds(msg);
  assert.equal(got.length, 1);
  assert.equal(got[0].videoUrl, tenor.video.proxy_url);
  assert.deepEqual(parseGifEmbeds({}), [], 'no embeds → []');
});

// ── off-switch ──────────────────────────────────────────────────────
test('gifEmbedsDisabled: setting false or the env flag turns it off', () => {
  assert.equal(gifEmbedsDisabled({}), false);
  assert.equal(gifEmbedsDisabled({ discordGifEmbedsEnabled: false }), true);
  process.env.PROTO_FAMILIAR_DISCORD_GIF_EMBEDS_DISABLED = '1';
  try { assert.equal(gifEmbedsDisabled({}), true); }
  finally { delete process.env.PROTO_FAMILIAR_DISCORD_GIF_EMBEDS_DISABLED; }
});
