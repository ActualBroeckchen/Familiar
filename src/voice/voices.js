/**
 * Where my voice actually lives on disk (voice spec §6.5).
 *
 * PocketTTS clones zero-shot, so "my voice" is a wav file rather than a model
 * weight. Everything that wants to speak needs one question answered — *which
 * file?* — and this is the only module that answers it.
 *
 * ── Three homes, and the difference matters ─────────────────────────────
 *
 *   voices/bundled/    Ships in the repo. Committed bytes, one clip: the voice
 *                      I have before my human has an opinion about it. It is
 *                      committed rather than fetched because a voice that
 *                      depends on a network call at some arbitrary later
 *                      moment is a voice I can lose. Identity should not be
 *                      contingent on a working connection.
 *
 *   voices/installed/  Fetched from the catalogue when my human picks
 *                      something else. Gitignored — these are reproducible
 *                      from a pinned url and a checksum, so committing 8 MB of
 *                      them into every clone would be paying for choices
 *                      almost nobody makes.
 *
 *   voices/ward/       A clip my human gave me. Gitignored, and the gitignore
 *                      is load-bearing rather than tidiness: this may be
 *                      someone else's copyrighted performance, and personal
 *                      use is theirs to make while redistribution is not.
 *                      `mayLeaveTheMachine` in voice-catalogue.js is the other
 *                      half of that guard.
 *
 * ── Substitution is never silent ────────────────────────────────────────
 * If my human chose a voice and it is not on disk, speaking in the default
 * instead — quietly — would mean sounding like someone they did not choose and
 * never being told why. But refusing to speak at all would take read-aloud
 * away from the people it exists for, over a cosmetic problem. So the fallback
 * happens AND says so: `fellBackFrom` rides in the result and the caller
 * surfaces it. Same discipline as a tool-round budget running out — degrade,
 * but never pretend.
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { DEFAULT_VOICE, VOICE_PROVENANCE, sourceByKey } from './voice-catalogue.js';
import { loadCatalogue, clipKey } from './voice-clips.js';
import { isSafeSegment } from './voice-fetch.js';

export const VOICES_SUBDIR = 'voices';
export const BUNDLED_SUBDIR = path.join(VOICES_SUBDIR, 'bundled');
export const INSTALLED_SUBDIR = path.join(VOICES_SUBDIR, 'installed');
export const WARD_SUBDIR = path.join(VOICES_SUBDIR, 'ward');

/** The one clip that ships. Named here so the committed file and the catalogue cannot drift apart. */
export const BUNDLED_FILE = 'p255_023_enhanced.wav';

/**
 * A catalogue key (`vctk/p255_023/original`) as one flat filename.
 *
 * The key has separators in it, so it cannot become a path without being
 * checked first — a key is data, and data that reaches the filesystem
 * unvalidated is how a traversal happens. Every segment is verified, and an
 * unsafe key returns null rather than a sanitised guess: silently correcting a
 * malformed key would mean reading or writing a file nobody asked for.
 */
export function voiceFileName(key) {
  const parts = String(key ?? '').split('/');
  if (parts.length !== 3) return null;
  if (!parts.every(isSafeSegment)) return null;
  return `${parts.join('__')}.wav`;
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function mkdirp(dir) {
  try { await fs.mkdir(dir, { recursive: true }); return true; } catch { return false; }
}

/** Where a given catalogue key would live once installed. */
export function installedVoicePath(rootDir, key) {
  const name = voiceFileName(key);
  return name ? path.join(rootDir, INSTALLED_SUBDIR, name) : null;
}

/** The clip that ships in the box. Always this path, always present. */
export function bundledVoicePath(rootDir) {
  return path.join(rootDir, BUNDLED_SUBDIR, BUNDLED_FILE);
}

/**
 * Resolve the voice I should speak in, to an actual file.
 *
 * Never throws and never returns "no voice" while the bundled clip is on disk,
 * because the caller is usually a read-aloud button and a button that
 * sometimes explodes is worse than one that sometimes explains.
 */
export async function resolveVoice({ rootDir = process.cwd(), settings = {} } = {}) {
  const chosen = settings?.voiceTts?.voice ?? DEFAULT_VOICE.key;
  const bundled = bundledVoicePath(rootDir);

  const fallback = async (fellBackFrom, reason) => {
    if (await exists(bundled)) {
      return {
        ok: true,
        key: DEFAULT_VOICE.key,
        path: bundled,
        provenance: VOICE_PROVENANCE.BUNDLED,
        fellBackFrom,
        reason,
      };
    }
    // The committed clip is missing, which means a broken checkout or someone
    // deleting it by hand. Say which file, because "voice unavailable" sends a
    // person hunting through settings for a problem that is one missing file.
    return { ok: false, reason: 'no-voice-on-disk', detail: `expected a reference clip at ${BUNDLED_SUBDIR}/${BUNDLED_FILE}` };
  };

  // A ward-supplied clip is addressed by filename inside its own directory,
  // never by catalogue key — it has no upstream and no checksum to match.
  if (typeof chosen === 'string' && chosen.startsWith('ward:')) {
    const name = chosen.slice('ward:'.length);
    if (!isSafeSegment(name)) return fallback(chosen, 'that voice name is not a name I can open');
    const p = path.join(rootDir, WARD_SUBDIR, name);
    if (!(await exists(p))) return fallback(chosen, 'the clip my human gave me is not where it was');
    return { ok: true, key: chosen, path: p, provenance: VOICE_PROVENANCE.WARD_SUPPLIED, fellBackFrom: null, reason: null };
  }

  if (chosen === DEFAULT_VOICE.key) {
    const r = await fallback(null, null);
    return r.ok ? { ...r, fellBackFrom: null, reason: null } : r;
  }

  const p = installedVoicePath(rootDir, chosen);
  if (!p) return fallback(chosen, 'that voice key is not one I can turn into a filename');
  if (!(await exists(p))) return fallback(chosen, 'that voice is chosen but not downloaded yet');
  return { ok: true, key: chosen, path: p, provenance: VOICE_PROVENANCE.BUNDLED, fellBackFrom: null, reason: null };
}

/**
 * Download and keep a catalogue clip.
 *
 * The checksum is the whole contract: the picker let my human hear a clip at a
 * pinned url, and this verifies that the bytes kept are those same bytes. A
 * mismatch is refused rather than repaired — a voice that is nearly the one
 * they picked is not the one they picked.
 *
 * Writes to a temp file and renames, so an interrupted download cannot leave
 * something half-written sitting where a valid clip should be.
 */
export async function installVoice({ rootDir = process.cwd(), key, fetchImpl = fetch } = {}) {
  const clip = (loadCatalogue(rootDir).clips ?? []).find((c) => clipKey(c) === key);
  if (!clip) return { ok: false, reason: 'unknown-clip' };

  const source = sourceByKey(clip.source);
  if (!source) return { ok: false, reason: 'unknown-source' };
  if (source.rejected || !source.license.redistributable) {
    // The catalogue keeps unshippable sources on purpose, so this is reachable
    // by anyone crafting a key. The licence gate holds here too.
    return { ok: false, reason: 'not-permitted', detail: source.rejected ?? `${source.license.label} may not be bundled` };
  }

  const dest = installedVoicePath(rootDir, key);
  if (!dest) return { ok: false, reason: 'bad-key' };

  if (await exists(dest)) return { ok: true, alreadyInstalled: true, key, path: dest };

  let buf;
  try {
    const res = await fetchImpl(clip.url, { redirect: 'follow' });
    if (!res.ok) return { ok: false, reason: 'http', detail: `HTTP ${res.status}` };
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return { ok: false, reason: 'network', detail: String(err?.message ?? err) };
  }

  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== clip.sha256) return { ok: false, reason: 'checksum', detail: 'what downloaded is not what the catalogue expects' };

  if (!(await mkdirp(path.dirname(dest)))) return { ok: false, reason: 'mkdir-failed', detail: path.dirname(dest) };

  const tmp = `${dest}.tmp`;
  try {
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, dest);
  } catch (err) {
    try { await fs.rm(tmp, { force: true }); } catch { /* the sweep will get it */ }
    return { ok: false, reason: 'write-failed', detail: String(err?.message ?? err) };
  }

  return { ok: true, alreadyInstalled: false, key, path: dest, bytes: buf.length };
}

/**
 * Keep a clip my human handed me.
 *
 * No checksum, because there is no upstream to check against — they are the
 * authority on what this is. It lands in `voices/ward/`, which is gitignored
 * and which `redactForSharing` treats as never leaving the machine.
 */
export async function saveWardVoice({ rootDir = process.cwd(), name, bytes } = {}) {
  // Validate what was actually given. Running `basename` first would turn
  // `../escape.wav` into `escape.wav` and accept it — no traversal, but a file
  // written under a name nobody asked for, which is the same silent-correction
  // mistake `voiceFileName` refuses to make.
  const safe = typeof name === 'string' ? name : '';
  if (!isSafeSegment(safe) || !safe.toLowerCase().endsWith('.wav')) {
    return { ok: false, reason: 'bad-name', detail: 'a plain .wav filename, with no folders in it' };
  }
  if (!bytes?.length) return { ok: false, reason: 'empty' };

  const dir = path.join(rootDir, WARD_SUBDIR);
  if (!(await mkdirp(dir))) return { ok: false, reason: 'mkdir-failed', detail: dir };

  const dest = path.join(dir, safe);
  try {
    await fs.writeFile(dest, bytes);
  } catch (err) {
    return { ok: false, reason: 'write-failed', detail: String(err?.message ?? err) };
  }
  return { ok: true, key: `ward:${safe}`, path: dest, bytes: bytes.length };
}

/** Everything on disk, so the picker can mark what is already here. */
export async function listLocalVoices(rootDir = process.cwd()) {
  const read = async (sub) => {
    try { return (await fs.readdir(path.join(rootDir, sub))).filter((f) => f.toLowerCase().endsWith('.wav')); }
    catch { return []; }
  };
  const [installed, ward] = await Promise.all([read(INSTALLED_SUBDIR), read(WARD_SUBDIR)]);
  return {
    bundled: [DEFAULT_VOICE.key],
    installed: installed.map((f) => f.replace(/\.wav$/i, '').split('__').join('/')),
    ward: ward.map((f) => `ward:${f}`),
  };
}
