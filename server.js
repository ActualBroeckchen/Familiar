/**
 * Proto-Familiar — lightweight LLM frontend server
 * Proxies chat requests to z.ai and NanoGPT, avoiding CORS issues.
 * Requires Node.js 18+ (uses built-in fetch).
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Provider base URLs — all use OpenAI-compatible chat completions format
// zai-coding uses the Coding Plan endpoint (separate quota from the standard API)
const PROVIDER_URLS = {
  nanogpt:     'https://nano-gpt.com/api/v1/chat/completions',
  zai:         'https://api.z.ai/api/paas/v4/chat/completions',
  'zai-coding': 'https://api.z.ai/api/coding/paas/v4/chat/completions',
};

/**
 * POST /api/chat
 * Body: { provider, apiKey, model, messages, stream, temperature?, max_tokens? }
 * Proxies to the chosen provider and streams or returns the response.
 */
app.post('/api/chat', async (req, res) => {
  const { provider, apiKey, model, messages, stream, temperature, max_tokens } = req.body;

  const url = PROVIDER_URLS[provider];
  if (!url) {
    return res.status(400).json({ error: `Unknown provider: "${provider}". Expected "nanogpt", "zai", or "zai-coding".` });
  }
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return res.status(400).json({ error: 'API key is required.' });
  }
  if (!model || typeof model !== 'string' || !model.trim()) {
    return res.status(400).json({ error: 'Model name is required.' });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages array is required and must not be empty.' });
  }

  const payload = { model: model.trim(), messages, stream: !!stream };
  if (typeof temperature === 'number') payload.temperature = temperature;
  if (typeof max_tokens === 'number' && max_tokens > 0) payload.max_tokens = max_tokens;

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return res.status(502).json({ error: `Network error reaching ${provider}: ${err.message}` });
  }

  // Non-streaming path
  if (!stream) {
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json');
    return res.send(text);
  }

  // Streaming path — detect if provider returned a JSON error instead of SSE
  const ct = upstream.headers.get('content-type') || '';
  if (!upstream.ok || ct.includes('application/json')) {
    const text = await upstream.text();
    res.status(upstream.status).setHeader('Content-Type', 'application/json');
    return res.send(text);
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering if behind a proxy

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { res.end(); break; }
      res.write(Buffer.from(value));
    }
  } catch (err) {
    if (!res.writableEnded) res.end();
  }
});

// Health check
app.get('/api/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nProto-Familiar running at http://localhost:${PORT}\n`);
});
