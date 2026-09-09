// Provider URL resolution + connection readiness — the core that lets a local
// (no-key) or custom OpenAI-compatible endpoint be a first-class connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVIDER_URLS, PROVIDER_KEYLESS, normalizeBaseUrl, resolveProviderUrl,
  providerRequiresKey, connectionReady, authHeader,
} from '../providers.js';

test('the popular OpenAI-compatible presets are present', () => {
  for (const p of ['openai', 'openrouter', 'deepseek', 'groq', 'mistral', 'ollama', 'lmstudio']) {
    assert.ok(PROVIDER_URLS[p], `${p} preset URL exists`);
  }
});

test('normalizeBaseUrl: bare host, versioned base, and full endpoint', () => {
  assert.equal(normalizeBaseUrl('http://localhost:11434'), 'http://localhost:11434/v1/chat/completions');
  assert.equal(normalizeBaseUrl('http://localhost:1234/v1'), 'http://localhost:1234/v1/chat/completions');
  assert.equal(normalizeBaseUrl('https://x.test/v1/chat/completions'), 'https://x.test/v1/chat/completions');
  assert.equal(normalizeBaseUrl('http://localhost:11434/'), 'http://localhost:11434/v1/chat/completions', 'trailing slash trimmed');
  assert.equal(normalizeBaseUrl(''), '');
  assert.equal(normalizeBaseUrl(null), '');
});

test('resolveProviderUrl: static map, custom baseUrl, and local override', () => {
  assert.equal(resolveProviderUrl({ provider: 'openrouter' }), PROVIDER_URLS.openrouter);
  // custom needs a baseUrl; without one it can't resolve
  assert.equal(resolveProviderUrl({ provider: 'custom' }), null);
  assert.equal(resolveProviderUrl({ provider: 'custom', baseUrl: 'http://box:8080' }), 'http://box:8080/v1/chat/completions');
  // a local preset falls back to its default, or takes a baseUrl override
  assert.equal(resolveProviderUrl({ provider: 'ollama' }), PROVIDER_URLS.ollama);
  assert.equal(resolveProviderUrl({ provider: 'ollama', baseUrl: 'http://nas:11434' }), 'http://nas:11434/v1/chat/completions');
  assert.equal(resolveProviderUrl({ provider: 'nope' }), null);
});

test('providerRequiresKey: local/custom are keyless, cloud needs a key', () => {
  assert.equal(providerRequiresKey('ollama'), false);
  assert.equal(providerRequiresKey('lmstudio'), false);
  assert.equal(providerRequiresKey('custom'), false);
  assert.equal(providerRequiresKey('openrouter'), true);
  assert.equal(providerRequiresKey('nanogpt'), true);
  assert.ok(PROVIDER_KEYLESS.has('ollama'));
});

test('connectionReady: model + key-unless-keyless (URL is checked at the call site, not here)', () => {
  assert.equal(connectionReady({ provider: 'ollama', model: 'llama3' }), true, 'local needs no key');
  assert.equal(connectionReady({ provider: 'custom', model: 'm', baseUrl: 'http://box:1234' }), true, 'custom with a url + model, no key');
  // custom is keyless, so it's "ready" by key/model; a MISSING baseUrl is caught
  // at the call site (resolveProviderUrl → null), not by connectionReady.
  assert.equal(connectionReady({ provider: 'custom', model: 'm' }), true, 'keyless custom passes the key/model gate');
  assert.equal(connectionReady({ provider: 'openrouter', model: 'm' }), false, 'cloud without a key is not ready');
  assert.equal(connectionReady({ provider: 'openrouter', model: 'm', apiKey: 'sk-x' }), true);
  assert.equal(connectionReady({ provider: 'openrouter', apiKey: 'sk-x' }), false, 'no model is not ready');
  // A provider-less connection defaults to needing a key (the safe direction).
  assert.equal(connectionReady({ model: 'm', apiKey: 'k' }), true);
  assert.equal(connectionReady({ model: 'm' }), false);
  assert.equal(connectionReady({}), false);
});

test('authHeader: present only when a key is', () => {
  assert.deepEqual(authHeader('sk-abc'), { Authorization: 'Bearer sk-abc' });
  assert.deepEqual(authHeader('  '), {}, 'blank key → no header (local servers reject a malformed one)');
  assert.deepEqual(authHeader(null), {});
});
