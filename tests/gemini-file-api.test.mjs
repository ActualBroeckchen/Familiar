import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isGeminiVideoProvider, bareModel, toGeminiRequest, extractGeminiText,
  uploadVideoToGemini, generateWithGeminiFile, answerAboutVideo,
} from '../src/vision/gemini-file-api.js';

function res(status, { json = {}, headers = {} } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null }, json: async () => json };
}
const buf = Buffer.from('fake-video-bytes');

test('isGeminiVideoProvider / bareModel', () => {
  assert.equal(isGeminiVideoProvider('google', 'gemini-1.5-pro'), true);
  assert.equal(isGeminiVideoProvider('gemini', 'gemini-2.0-flash'), true);
  assert.equal(isGeminiVideoProvider('zai', 'glm-4.6v'), false);
  assert.equal(isGeminiVideoProvider('google', 'palm-2'), false);
  assert.equal(bareModel('models/gemini-1.5-pro'), 'gemini-1.5-pro');
  assert.equal(bareModel('gemini-1.5-pro'), 'gemini-1.5-pro');
});

test('toGeminiRequest: system→system_instruction, assistant→model, video on the final user turn', () => {
  const body = toGeminiRequest({
    history: [{ role: 'system', content: 'be kind' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hey' }],
    prompt: 'what happens here?', fileUri: 'files/abc', mimeType: 'video/mp4',
  });
  assert.deepEqual(body.system_instruction, { parts: [{ text: 'be kind' }] });
  assert.equal(body.contents[0].role, 'user');
  assert.equal(body.contents[1].role, 'model');       // assistant→model
  const last = body.contents.at(-1);
  assert.equal(last.role, 'user');
  assert.deepEqual(last.parts[0], { text: 'what happens here?' });
  assert.deepEqual(last.parts[1], { file_data: { mime_type: 'video/mp4', file_uri: 'files/abc' } });
});

test('extractGeminiText joins text parts, empty on a shapeless body', () => {
  assert.equal(extractGeminiText({ candidates: [{ content: { parts: [{ text: 'a ' }, { text: 'b' }] } }] }), 'a b');
  assert.equal(extractGeminiText({}), '');
});

test('uploadVideoToGemini: START → upload → ACTIVE returns the uri', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, cmd: opts?.headers?.['X-Goog-Upload-Command'] });
    if (url.includes('/upload/v1beta/files')) return res(200, { headers: { 'x-goog-upload-url': 'https://up.example/put' } });
    if (url === 'https://up.example/put') return res(200, { json: { file: { name: 'files/abc', uri: 'https://g/files/abc', state: 'ACTIVE', mimeType: 'video/mp4' } } });
    throw new Error('unexpected ' + url);
  };
  const r = await uploadVideoToGemini({ buffer: buf, mime: 'video/mp4', apiKey: 'k', fetchFn });
  assert.equal(r.ok, true);
  assert.equal(r.uri, 'https://g/files/abc');
  assert.equal(calls[0].cmd, 'start');
  assert.equal(calls[1].cmd, 'upload, finalize');
});

test('uploadVideoToGemini: PROCESSING then polls to ACTIVE', async () => {
  let gets = 0;
  const fetchFn = async (url) => {
    if (url.includes('/upload/v1beta/files')) return res(200, { headers: { 'x-goog-upload-url': 'https://up/put' } });
    if (url === 'https://up/put') return res(200, { json: { file: { name: 'files/xy', state: 'PROCESSING' } } });
    if (url.includes('/v1beta/files/xy')) { gets++; return res(200, { json: { name: 'files/xy', uri: 'u://xy', state: gets >= 2 ? 'ACTIVE' : 'PROCESSING' } }); }
    throw new Error('unexpected ' + url);
  };
  const r = await uploadVideoToGemini({ buffer: buf, mime: 'video/mp4', apiKey: 'k', fetchFn, pollMs: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.uri, 'u://xy');
  assert.ok(gets >= 2, 'polled until ACTIVE');
});

test('uploadVideoToGemini: failure modes → ok:false, never throws', async () => {
  assert.equal((await uploadVideoToGemini({ buffer: buf, mime: 'video/mp4', fetchFn: async () => res(200) })).ok, false); // no key
  assert.equal((await uploadVideoToGemini({ buffer: buf, mime: 'video/mp4', apiKey: 'k', fetchFn: async () => res(500) })).ok, false); // start !ok
  // no upload url header
  assert.equal((await uploadVideoToGemini({ buffer: buf, mime: 'video/mp4', apiKey: 'k', fetchFn: async () => res(200, {}) })).ok, false);
  // FAILED state
  const failFetch = async (url) => url.includes('/upload/') ? res(200, { headers: { 'x-goog-upload-url': 'u://p' } }) : res(200, { json: { file: { name: 'files/f', state: 'FAILED' } } });
  const rf = await uploadVideoToGemini({ buffer: buf, mime: 'video/mp4', apiKey: 'k', fetchFn: failFetch });
  assert.equal(rf.ok, false);
  assert.match(rf.error, /failed/);
});

test('generateWithGeminiFile: hits the native generateContent endpoint, returns text', async () => {
  let sentUrl = '', sentBody = null;
  const fetchFn = async (url, opts) => { sentUrl = url; sentBody = JSON.parse(opts.body); return res(200, { json: { candidates: [{ content: { parts: [{ text: 'a cat naps.' }] } }] } }); };
  const r = await generateWithGeminiFile({ model: 'gemini-1.5-pro', apiKey: 'k', prompt: 'what?', fileUri: 'files/abc', mimeType: 'video/mp4', fetchFn });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'a cat naps.');
  assert.match(sentUrl, /\/v1beta\/models\/gemini-1\.5-pro:generateContent\?key=k/);
  assert.equal(sentBody.contents.at(-1).parts.at(-1).file_data.file_uri, 'files/abc');
});

test('generateWithGeminiFile: non-2xx and empty answer both → ok:false', async () => {
  assert.equal((await generateWithGeminiFile({ model: 'gemini-1.5-pro', apiKey: 'k', fetchFn: async () => res(429) })).ok, false);
  assert.equal((await generateWithGeminiFile({ model: 'gemini-1.5-pro', apiKey: 'k', fetchFn: async () => res(200, { json: { candidates: [] } }) })).ok, false);
});

test('answerAboutVideo: upload failure short-circuits before generate', async () => {
  let generated = false;
  const fetchFn = async (url) => {
    if (url.includes('/upload/')) return res(500);
    if (url.includes(':generateContent')) { generated = true; return res(200, { json: {} }); }
    return res(200);
  };
  const r = await answerAboutVideo({ buffer: buf, mime: 'video/mp4', model: 'gemini-1.5-pro', apiKey: 'k', prompt: 'x', fetchFn });
  assert.equal(r.ok, false);
  assert.match(r.error, /upload:/);
  assert.equal(generated, false);
});

test('answerAboutVideo: full happy path → answer text', async () => {
  const fetchFn = async (url) => {
    if (url.includes('/upload/v1beta/files')) return res(200, { headers: { 'x-goog-upload-url': 'u://put' } });
    if (url === 'u://put') return res(200, { json: { file: { name: 'files/z', uri: 'u://z', state: 'ACTIVE' } } });
    if (url.includes(':generateContent')) return res(200, { json: { candidates: [{ content: { parts: [{ text: 'they bake bread.' }] } }] } });
    throw new Error('unexpected ' + url);
  };
  const r = await answerAboutVideo({ buffer: buf, mime: 'video/mp4', model: 'gemini-1.5-pro', apiKey: 'k', prompt: 'what happens?', fetchFn });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'they bake bread.');
});
