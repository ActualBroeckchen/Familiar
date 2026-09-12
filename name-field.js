/**
 * name-field.js — the shared OpenAI `name`-field machinery for user-role turns.
 *
 * A person's turn in a `user` role can carry a `name` field: a code-minted,
 * charset-safe handle (my human → `ward-<slug>`, a villager → their slug, an
 * archived log → `session-archive`) so the model gets a first-class sender id,
 * not just an inline `[Name]:` label. The Familiar's own turns (assistant) get
 * none — the role already carries them.
 *
 * Policy (ward decision): OPTIMISTIC by default — attempt the `name` field, and
 * if a provider rejects it with a 400, retry the same call bare ONCE, learn
 * that this `provider:model` can't take the field, and fall back to bare from
 * then on. The learned verdict persists across restarts (a cap-cache file,
 * keyed `provider:model`), so a model change is a NEW key → the field is
 * re-attempted (re-probe on model change, for free). The ward's explicit
 * per-connection `nameFieldCapable: 'yes'|'no'` tri-state always wins over the
 * learned verdict.
 *
 * This mirrors the vision capability cache (vision.js `readCapCache` /
 * `cacheVisionCapability`, `.vision-capability.json`). If a third capability
 * cache ever lands, that's the signal to extract one shared cap-cache helper;
 * two small parallel copies don't yet earn the abstraction.
 *
 * Persistence is OFF until `hydrateNameFieldCache()` is called (at server boot).
 * Tests never call it, so `recordNameFieldResult` stays pure in-memory there —
 * no stray cap-cache file written during a test run.
 */

import path from 'path';
import { promises as fsp, readFileSync } from 'fs';

import { REPO_ROOT } from './repo-root.js';
import { slugifyLabel } from './slug-ids.js';

const DEFAULT_NAME_CAP_FILE = path.join(REPO_ROOT, 'tomes', '.name-field-capability.json');

// ── The handle a user turn carries ───────────────────────────────────

// The OpenAI `name` field value for a turn — a CODE-MINTED handle, so a real
// name's spaces/unicode can never trip the field's charset and 400 the whole
// request (the reason we slug rather than pass a raw name). The Familiar's own
// turns (assistant) get none — the role already carries them. A villager or
// stranger gets their slugified name; the ward (a user turn with no speaker)
// gets `ward-<slug>` — the `ward-` prefix marks the bond, the name keeps them a
// specific person, never flattened into a bare role (CLAUDE.md: name the human).
// Material with no live speaker (an archived log dropped on a user turn) gets
// `session-archive`, so it can't read as someone addressing the Familiar.
export function speakerNameField({ role, speaker, wardName = 'My human', material = false } = {}) {
  if (role !== 'user') return undefined;              // assistant = the Familiar
  if (material) return 'session-archive';
  const name = String(speaker ?? '').trim();
  if (name) return slugifyLabel(name) || undefined;   // villager / stranger
  const w = slugifyLabel(wardName);                    // no speaker → the ward
  return w ? `ward-${w}` : 'ward';
}

// Stamp `name` on the person-bearing user turns of an already-built message
// array, returning a COPY (system blocks and assistant turns untouched). A user
// turn's speaker comes from its own `speaker` field (a villager/stranger) or, if
// absent, the ward (→ `ward-<slug>`); an archived-material turn is marked with
// `material: true`. `stamp:false` returns the array unchanged (the bare arm of
// the fallback). Idempotent and pure — safe to call on the same array twice.
export function stampNamesOnTurns(messages, { wardName = 'My human', stamp = true } = {}) {
  if (!Array.isArray(messages)) return messages;
  if (!stamp) return messages.map(m => { const { name, ...rest } = m || {}; return rest; });
  return messages.map(m => {
    if (!m || m.role !== 'user') return m;
    const name = speakerNameField({ role: 'user', speaker: m.speaker, wardName, material: m.material === true });
    return name ? { ...m, name } : m;
  });
}

// ── The capability cache (provider:model → 'yes' | 'no') ──────────────

const _cache = new Map();          // `${provider}:${model}` → 'yes' | 'no'
let _persistFile = null;           // null = persistence off (tests); set at boot

const nameCapKey = (job = {}) => `${job.provider ?? ''}:${job.model ?? ''}`;

/**
 * Enable persistence and load any learned verdicts from disk. Called once at
 * server boot. Safe to call with no file yet (nothing learned → empty cache).
 * Synchronous read so the cache is warm before the first turn resolves it.
 */
export function hydrateNameFieldCache(file = DEFAULT_NAME_CAP_FILE) {
  _persistFile = file;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        if (v === 'yes' || v === 'no') _cache.set(k, v);
      }
    }
  } catch { /* no cache file yet — optimistic path is safe */ }
}

async function _persistNameCache() {
  if (!_persistFile) return;
  try {
    await fsp.mkdir(path.dirname(_persistFile), { recursive: true });
    const tmp = `${_persistFile}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(Object.fromEntries(_cache), null, 2), 'utf8');
    await fsp.rename(tmp, _persistFile);
  } catch { /* the cache is advisory — a failed write just re-learns next time */ }
}

/**
 * Whether to stamp `name` fields for this provider:model. The ward's explicit
 * per-connection tri-state wins (`nameFieldCapable: 'yes'|'no'`); else the
 * learned verdict; else OPTIMISTIC (attempt + learn). `job` is { provider,
 * model, baseUrl }.
 */
export function nameFieldEnabledFor(job = {}, settings = {}) {
  const conns = Array.isArray(settings?.connections) ? settings.connections : [];
  const conn = conns.find(c =>
    c?.provider === job.provider &&
    c?.model === job.model &&
    (c?.baseUrl ?? null) === (job.baseUrl ?? null));
  if (conn?.nameFieldCapable === 'yes') return true;
  if (conn?.nameFieldCapable === 'no')  return false;
  const learned = _cache.get(nameCapKey(job));
  if (learned === 'yes') return true;
  if (learned === 'no')  return false;
  return true;   // optimistic: attempt + learn (a name-field 400 caches 'no' and retries bare)
}

// Record what a real turn taught us about this provider:model, so the next turn
// skips the wasted attempt (and it survives a restart once persistence is on).
export function recordNameFieldResult(job = {}, result) {
  if (result !== 'yes' && result !== 'no') return;
  const key = nameCapKey(job);
  if (_cache.get(key) === result) return;             // no change → no write
  _cache.set(key, result);
  // Fire-and-forget in production (callers don't await); the returned promise is
  // only there so tests can await the write before reading the file back.
  return _persistNameCache();
}

/** Clear the in-process cache and disable persistence. Tests only. */
export function _resetNameFieldCache() { _cache.clear(); _persistFile = null; }

/**
 * Run an LLM call with `name` fields on, degrading gracefully if the provider
 * rejects the field: on a 400 while names were on, retry ONCE without them — a
 * success proves the name field was the culprit (learn 'no'); a second failure
 * is a real error and propagates untouched. `callProviderFn(messages)` and
 * `buildMessages(bool)` are injected so this is unit-testable without a real
 * provider. `onLearn('yes'|'no')` is the hook the caller wires to
 * recordNameFieldResult for the resolved job.
 */
export async function withNameFieldFallback({ withNames, buildMessages, callProviderFn, onLearn }) {
  try {
    const res = await callProviderFn(buildMessages(withNames));
    if (withNames) onLearn?.('yes');
    return res;
  } catch (err) {
    if (withNames && /returned 400\b/.test(err?.message ?? '')) {
      const res = await callProviderFn(buildMessages(false));   // retry bare; a throw here is a real error
      onLearn?.('no');
      return res;
    }
    throw err;
  }
}

// The one-call seam every user-role SURFACE uses: resolve the policy (off-switch
// → ward tri-state → learned → optimistic), stamp the messages, run the 400
// fallback, and learn the outcome for this provider:model. `send(messages)` is
// the surface's own provider call, which MUST throw an error whose message
// contains "returned 400" on a name-field rejection (a bare-field retry then
// fires). `job` is { provider, model, baseUrl }. Returns whatever `send` returns
// (a parsed body, or a streaming upstream Response to pipe — the caller's call).
export async function sendWithNames({
  job = {}, settings = {}, messages, wardName = 'My human', send,
  disabled = process.env.PROTO_FAMILIAR_NAME_FIELDS_DISABLED === '1',
}) {
  const withNames = !disabled && nameFieldEnabledFor(job, settings);
  return withNameFieldFallback({
    withNames,
    buildMessages: (names) => stampNamesOnTurns(messages, { wardName, stamp: names }),
    callProviderFn: send,
    onLearn: (v) => recordNameFieldResult(job, v),
  });
}
