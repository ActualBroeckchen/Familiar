/**
 * gemini-file-api.js — the File-API path for LONGER video (docs/video-build-spec.md §4).
 *
 * A clip too big to inline as base64 can't ride the OpenAI-compat chat endpoint
 * the rest of the app uses. Google's answer is the File API + a native
 * `generateContent` call that references the uploaded file — a DIFFERENT endpoint
 * and request shape. This module is that path, kept ENTIRELY isolated from the
 * main chat flow: it is reached only through its own endpoint, is default-OFF,
 * and every failure returns { ok:false } so the caller falls back to the inline
 * / stand-in behaviour. It never touches `llm-call.js` or the tool loop.
 *
 * ⚠️ Verification boundary: the live upload + generate cannot run in CI (no
 * Google key, no egress). Every function takes an injectable `fetchFn`, and the
 * request shaping is unit-tested against a stubbed Google; the LIVE round-trip
 * needs the ward's key — same posture as the CDP desktop shakeout.
 *
 * Protocol (Google Generative Language File API, key-auth):
 *   1. resumable-upload START → an upload URL (x-goog-upload-url header)
 *   2. upload+finalize the bytes → { file:{ name, uri, state, mimeType } }
 *   3. poll files.get until state === 'ACTIVE' (video needs processing)
 *   4. models/<model>:generateContent with a file_data part → candidates[].text
 */

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com';

/** Provider ids whose chat model can take the Gemini File-API video path. */
export function isGeminiVideoProvider(provider, model) {
  const p = String(provider ?? '').toLowerCase();
  const m = String(model ?? '').toLowerCase();
  return (p === 'google' || p === 'gemini') && /gemini/.test(m);
}

/** Strip a leading `models/` and return the bare model id for the URL. */
export function bareModel(model) {
  return String(model ?? '').replace(/^models\//, '').trim();
}

/**
 * Upload bytes to the File API and wait until ACTIVE. Returns
 * { ok, uri, mimeType, name } or { ok:false, error }. Never throws.
 */
export async function uploadVideoToGemini({
  buffer, mime, displayName = 'clip', apiKey, baseUrl = DEFAULT_BASE,
  fetchFn = fetch, pollMs = 1500, maxWaitMs = 120_000, now = Date.now,
} = {}) {
  if (!apiKey) return { ok: false, error: 'no api key' };
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { ok: false, error: 'no bytes' };
  const key = encodeURIComponent(apiKey);
  try {
    // 1) START a resumable upload — the reply carries the upload URL in a header.
    const start = await fetchFn(`${baseUrl}/upload/v1beta/files?key=${key}`, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(buffer.length),
        'X-Goog-Upload-Header-Content-Type': mime,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
    });
    if (!start.ok) return { ok: false, error: `upload start http ${start.status}` };
    const uploadUrl = start.headers.get('x-goog-upload-url') || start.headers.get('X-Goog-Upload-URL');
    if (!uploadUrl) return { ok: false, error: 'no upload url returned' };

    // 2) Upload + finalize the bytes.
    const up = await fetchFn(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': String(buffer.length),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: buffer,
    });
    if (!up.ok) return { ok: false, error: `upload http ${up.status}` };
    const upJson = await up.json();
    let file = upJson?.file || upJson;
    if (!file?.name) return { ok: false, error: 'upload returned no file name' };

    // 3) Poll until the video finishes processing.
    const deadline = now() + maxWaitMs;
    let state = String(file.state || '').toUpperCase();
    while (state && state !== 'ACTIVE') {
      if (state === 'FAILED') return { ok: false, error: 'file processing failed' };
      if (now() >= deadline) return { ok: false, error: 'timed out waiting for ACTIVE' };
      await new Promise(r => setTimeout(r, pollMs));
      const id = String(file.name).replace(/^files\//, '');
      const g = await fetchFn(`${baseUrl}/v1beta/files/${encodeURIComponent(id)}?key=${key}`, { method: 'GET' });
      if (!g.ok) return { ok: false, error: `files.get http ${g.status}` };
      file = await g.json();
      state = String(file?.state || '').toUpperCase();
    }
    if (!file?.uri) return { ok: false, error: 'active file has no uri' };
    return { ok: true, uri: file.uri, mimeType: file.mimeType || mime, name: file.name };
  } catch (err) {
    return { ok: false, error: err?.message || 'upload failed' };
  }
}

/**
 * Convert plain {role,text} history (OpenAI-ish) to Gemini `contents`. system
 * turns are pulled out as `system_instruction`; assistant→model. The video's
 * file_data part is appended to the FINAL user turn (creating one if needed).
 */
export function toGeminiRequest({ history = [], prompt = '', fileUri, mimeType }) {
  const systemParts = [];
  const contents = [];
  for (const m of history) {
    const role = m?.role;
    const text = typeof m?.content === 'string' ? m.content : (typeof m?.text === 'string' ? m.text : '');
    if (!text) continue;
    if (role === 'system') { systemParts.push({ text }); continue; }
    contents.push({ role: role === 'assistant' ? 'model' : 'user', parts: [{ text }] });
  }
  // The turn that carries the video: the caller's prompt + the file part.
  const parts = [];
  if (prompt) parts.push({ text: prompt });
  if (fileUri) parts.push({ file_data: { mime_type: mimeType, file_uri: fileUri } });
  contents.push({ role: 'user', parts });
  const body = { contents };
  if (systemParts.length) body.system_instruction = { parts: systemParts };
  return body;
}

/** Pull the answer text out of a generateContent response. */
export function extractGeminiText(json) {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(p => (typeof p?.text === 'string' ? p.text : '')).join('').trim();
}

/**
 * One native generateContent call referencing an uploaded file. Returns
 * { ok, text } or { ok:false, error }. Never throws.
 */
export async function generateWithGeminiFile({
  model, apiKey, baseUrl = DEFAULT_BASE, history = [], prompt, fileUri, mimeType, fetchFn = fetch,
} = {}) {
  if (!apiKey) return { ok: false, error: 'no api key' };
  const mdl = bareModel(model);
  if (!mdl) return { ok: false, error: 'no model' };
  try {
    const body = toGeminiRequest({ history, prompt, fileUri, mimeType });
    const res = await fetchFn(`${baseUrl}/v1beta/models/${encodeURIComponent(mdl)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: `generateContent http ${res.status}` };
    const json = await res.json();
    const text = extractGeminiText(json);
    if (!text) return { ok: false, error: 'empty answer' };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err?.message || 'generate failed' };
  }
}

/**
 * The orchestrator: upload a clip, wait ACTIVE, ask about it. Returns
 * { ok, text } or { ok:false, error }. Never throws — the caller falls back.
 */
export async function answerAboutVideo({
  buffer, mime, displayName, model, apiKey, baseUrl = DEFAULT_BASE,
  history = [], prompt, fetchFn = fetch, pollMs, maxWaitMs,
} = {}) {
  const up = await uploadVideoToGemini({ buffer, mime, displayName, apiKey, baseUrl, fetchFn, pollMs, maxWaitMs });
  if (!up.ok) return { ok: false, error: `upload: ${up.error}` };
  return generateWithGeminiFile({ model, apiKey, baseUrl, history, prompt, fileUri: up.uri, mimeType: up.mimeType, fetchFn });
}
