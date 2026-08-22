/**
 * voice-pin.js — pin a model from its upstream and install it, in one call.
 *
 * The normal supply chain ships PINS in the repo (a sha256 + size recorded by
 * `scripts/pin-audio-models.mjs` against a live download) so a fetch can verify
 * bytes before they touch disk. But the OPTIONAL speaker models (CAM++ /
 * TitaNet-Large) aren't shipped pinned — the ward chooses one at runtime. This
 * lets that choice download in-UI: the ward's explicit "install" IS the trust
 * decision (like running the CLI pin), so we download from the model's recorded
 * `upstream`, compute the sha256, WRITE the pin, then hand off to the proven
 * `fetchPlan` to verify + place the file. Reusing fetchPlan (rather than
 * re-implementing install + markers) is deliberate: the install path is already
 * tested and correct.
 *
 * Only models that are already in BASE_MODELS with a recorded `upstream` can be
 * pinned this way — never an arbitrary URL from a request.
 */

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BASE_MODELS, applyPins, upstreamUrl } from './voice-models.js';
import { fetchPlan, MODELS_SUBDIR } from './voice-fetch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PINS_FILE = path.join(__dirname, 'voice-model-pins.json');

async function readPins() {
  try { return JSON.parse(await fsp.readFile(PINS_FILE, 'utf8')); } catch { return {}; }
}
async function writePins(pins) {
  const tmp = `${PINS_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(pins, null, 2), 'utf8');
  await fsp.rename(tmp, PINS_FILE);
}

/** Stream a URL, returning its sha256 + byte count without keeping the body. */
async function measure(url, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const h = createHash('sha256');
  let bytes = 0, lastPct = -1;
  for await (const chunk of res.body) {
    h.update(chunk);
    bytes += chunk.length;
    if (total > 0 && typeof onProgress === 'function') {
      const pct = Math.floor((bytes / total) * 10) * 10;
      if (pct > lastPct) { lastPct = pct; onProgress({ phase: 'measuring', receivedBytes: bytes, totalBytes: total }); }
    }
  }
  return { sha256: h.digest('hex'), bytes };
}

/**
 * Pin a known model from its upstream and install it. Never throws.
 * @param {string} modelId  a BASE_MODELS id that has a recorded `upstream`
 * @returns {Promise<{ok:boolean, reason?:string, detail?:string, sha256?:string, bytes?:number}>}
 */
export async function pinAndInstallModel(modelId, { rootDir = __dirname, onProgress = () => {} } = {}) {
  try {
    const known = BASE_MODELS.find((m) => m.id === modelId);
    if (!known) return { ok: false, reason: 'unknown-model' };
    const url = upstreamUrl(known.upstream);
    const name = known.upstream?.asset;
    if (!url || !name) return { ok: false, reason: 'no-upstream', detail: `${modelId} has no recorded upstream asset` };

    // 1) Download to measure → record the pin (sha256 is trust-on-first-install).
    let measured;
    try { measured = await measure(url, onProgress); }
    catch (err) { return { ok: false, reason: 'download-failed', detail: String(err?.message ?? err) }; }
    const pins = await readPins();
    pins[modelId] = { files: [{ name, url, sha256: measured.sha256, bytes: measured.bytes, diskBytes: measured.bytes }] };
    await writePins(pins);

    // 2) Install via the proven, verified fetch path (re-download + sha check +
    //    place). A second download of a one-time opt-in model is an acceptable
    //    cost for reusing tested install code instead of re-implementing it.
    const model = applyPins(BASE_MODELS, pins).find((m) => m.id === modelId);
    const plan = { all: [model], voice: null, capability: [], extras: [] };
    const result = await fetchPlan({ plan, modelsDir: path.join(rootDir, MODELS_SUBDIR), onProgress });
    if (result?.ok === false) {
      return { ok: false, reason: 'install-failed', detail: result.message ?? result.reason ?? 'unknown' };
    }
    return { ok: true, sha256: measured.sha256, bytes: measured.bytes };
  } catch (err) {
    return { ok: false, reason: 'pin-failed', detail: String(err?.message ?? err) };
  }
}
