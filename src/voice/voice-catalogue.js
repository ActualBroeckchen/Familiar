/**
 * The voice catalogue — which reference clips ship with me, and on what terms
 * (voice spec §6.5, and the licensing question it never answered).
 *
 * PocketTTS clones a voice zero-shot from a short reference clip, so "my
 * voice" is a *wav file*, not a model weight. That makes voice selection a
 * licensing question the moment we ship any of them, and it makes the
 * licence a property of each voice rather than a footnote about the project.
 *
 * ── Why this is code and not a note in a README ─────────────────────────
 * Proto-Familiar is GPL-3.0-or-later. A GPL distribution may not carry a
 * component whose licence forbids commercial use: the NC restriction would
 * propagate a limit on what recipients may do with the whole thing, which is
 * exactly what the GPL exists to prevent. That rule is easy to state and easy
 * to forget six months later when someone adds "just one more nice voice."
 * So `shippableSources()` filters on the licence field and a test asserts no
 * non-redistributable source can reach the shipped set. The rule enforces
 * itself.
 *
 * Attribution is handled the same way: a voice that requires credit carries
 * who to credit, and `attributionNotice()` generates the NOTICE text from the
 * catalogue — so a credit cannot be silently dropped by editing prose.
 *
 * (Not legal advice — this encodes the terms each upstream source states.
 * Where a source's own wording is uncertain, we treat it as unusable.)
 */

/**
 * Licences we understand, and what each permits us to do.
 *
 * `redistributable` is the gate: false means the file may not ship with a
 * GPL distribution at all, whatever its other merits.
 */
export const LICENSES = Object.freeze({
  CC0: { id: 'CC0-1.0', label: 'CC0 1.0', redistributable: true, requiresAttribution: false, commercialOk: true },
  CC_BY_4: { id: 'CC-BY-4.0', label: 'CC BY 4.0', redistributable: true, requiresAttribution: true, commercialOk: true },
  CC_BY_NC_4: { id: 'CC-BY-NC-4.0', label: 'CC BY-NC 4.0', redistributable: false, requiresAttribution: true, commercialOk: false },
  UNCLEAR: { id: 'unclear', label: 'unclear', redistributable: false, requiresAttribution: true, commercialOk: false },
});

/**
 * The upstream voice sources, as documented at
 * https://huggingface.co/kyutai/tts-voices (read 2026-07).
 *
 * Every entry records the licence its own source states. Entries we cannot
 * ship stay in this table on purpose — deleting them would only mean someone
 * rediscovering them later and having to re-derive why they were rejected.
 */
export const VOICE_SOURCES = Object.freeze([
  {
    key: 'voice-zero',
    label: 'Voice-Zero (LibriVox selections)',
    license: LICENSES.CC0,
    note: 'The default selection PocketTTS itself ships with — the voices it was tuned against.',
    upstream: 'https://huggingface.co/kyutai/tts-voices/tree/main/voice-zero',
  },
  {
    key: 'voice-donations',
    label: 'Unmute Voice Donation Project',
    license: LICENSES.CC0,
    note: '228 voices donated by volunteers who consented to CC0. Credit is not required, but the project is worth naming anyway.',
    creditAnyway: 'Unmute Voice Donation Project (Volhejn, 2025) — https://unmute.sh/voice-donation',
    upstream: 'https://huggingface.co/kyutai/tts-voices/tree/main/voice-donations',
  },
  {
    key: 'alba-mackenna',
    label: 'Alba MacKenna character voices',
    license: LICENSES.CC_BY_4,
    attribution: 'Character voices by Alba MacKenna, CC BY 4.0.',
    note: 'Voice-acted with distinct characters (casual, merchant, announcer) rather than neutral reading — closest thing here to a Familiar who sounds like someone.',
    upstream: 'https://huggingface.co/kyutai/tts-voices/tree/main/alba-mackenna',
  },
  {
    key: 'vctk',
    label: 'VCTK (Voice Cloning Toolkit)',
    license: LICENSES.CC_BY_4,
    attribution: 'VCTK Corpus, University of Edinburgh, CC BY 4.0 — https://datashare.ed.ac.uk/handle/10283/3443',
    note: 'Accent variety across many speakers.',
    upstream: 'https://huggingface.co/kyutai/tts-voices/tree/main/vctk',
  },
  {
    key: 'cml-tts-fr',
    label: 'CML-TTS (French)',
    license: LICENSES.CC_BY_4,
    attribution: 'CML-TTS Dataset, CC BY 4.0 — https://openslr.org/146/',
    note: 'French voices. Only relevant once a French-speaking ward exists.',
    upstream: 'https://huggingface.co/kyutai/tts-voices/tree/main/cml-tts/fr',
  },
  {
    key: 'expresso',
    label: 'Expresso',
    license: LICENSES.CC_BY_NC_4,
    rejected: 'Non-commercial only. An NC restriction cannot ride inside a GPL distribution — it would limit what recipients may do with the whole of me.',
    upstream: 'https://huggingface.co/kyutai/tts-voices/tree/main/expresso',
  },
  {
    key: 'ears',
    label: 'EARS',
    license: LICENSES.CC_BY_NC_4,
    rejected: 'Non-commercial only, same as Expresso. The per-speaker emotion clips are genuinely appealing and still cannot ship.',
    upstream: 'https://huggingface.co/kyutai/tts-voices/tree/main/ears',
  },
  {
    key: 'unmute-degaulle',
    label: 'Appeal of 18 June recording',
    license: LICENSES.UNCLEAR,
    rejected: "Upstream says outright it does not know how the licence works and is assuming public domain. An assumption is not a licence. It is also a real historical political figure, which is separately wrong for a companion's voice.",
    upstream: 'https://huggingface.co/kyutai/tts-voices/tree/main/unmute-prod-website',
  },
]);

/**
 * The voice that ships in the box.
 *
 * Chosen by ear (ward decision, 2026-07) from the VCTK corpus: clear, and
 * androgynous enough to be a reasonable thing to hand someone before they have
 * any opinion about what their Familiar should sound like. 12.8 s of reference
 * with 59% of it actually speech — a good clone source.
 *
 * Its measured pitch is 145 Hz, which is LOWER than several clips that read as
 * more masculine. That is the whole argument for not deriving a voice's
 * character from its pitch: timbre carries what a number cannot, and only ears
 * settle it.
 *
 * NOTE THE LICENCE. This is CC BY 4.0, not CC0, so shipping it obliges us to
 * carry the VCTK credit — see `attributionNotice()`. That obligation is real
 * whether or not anyone remembers it, which is why the credit is generated
 * from the catalogue rather than written into a file by hand.
 */
export const DEFAULT_VOICE = Object.freeze({
  key: 'vctk/p255_023/enhanced',
  source: 'vctk',
  id: 'p255_023',
  variant: 'enhanced',
  label: 'The voice I start with',
  why: 'Clear and androgynous — a reasonable thing to sound like before my human has an opinion about it.',
  measuredF0Hz: 145,
});

/**
 * Why ENHANCED and not the original my human auditioned.
 *
 * Upstream is explicit: "we recommend cleaning the sample before using it with
 * Pocket TTS, because THE AUDIO QUALITY OF THE SAMPLE IS ALSO REPRODUCED."
 * Kyutai's own curated voice list uses the `_enhanced` variant for every VCTK
 * voice in it, without exception.
 *
 * Measured, rather than taken on faith — same clip, both variants:
 *
 *     original   48 kHz   145 Hz   59% voiced   zero-crossing 2662
 *     enhanced   32 kHz   145 Hz   59% voiced   zero-crossing 3271
 *
 * Identical pitch, duration and voiced fraction: it is the same person saying
 * the same words. But ~23% more high-frequency energy, which is what "less
 * muffled" measures as. The lower sample rate is not a loss here — the model
 * resamples to 24 kHz regardless, so the only thing 48 kHz bought was room
 * noise at frequencies nothing keeps.
 *
 * This does NOT change which voice my human chose. It changes which recording
 * of it the clone is built from.
 */
export const DEFAULT_VOICE_VARIANT = 'enhanced';

/**
 * The curated shortlist — the voices offered first.
 *
 * 377 catalogued voices is a library, not a choice. For the people this
 * project is built for, a wall of undifferentiated options is an access
 * barrier rather than generosity: the UI guidelines call this out, and it is
 * why the picker leads with ten and puts the rest behind a deliberate step.
 *
 * Chosen by ear (ward, 2026-07) for RANGE rather than for being individually
 * best — 79 Hz to 238 Hz, so someone hunting for "deeper" or "higher" finds
 * the shape they want inside ten clips instead of three hundred. The pitches
 * are measured, not asserted; they are recorded here so the ordering is
 * stable without needing every clip measured first.
 *
 * Every entry is CC0 or CC BY 4.0, and `validateShippingSet` covers the
 * sources they come from.
 */
export const SHORTLIST = Object.freeze([
  { key: 'vctk/p254_023/enhanced',        source: 'vctk',       id: 'p254_023',       f0: 79,  note: 'The deepest here.' },
  { key: 'voice-zero/peter_yearsley/original', source: 'voice-zero', id: 'peter_yearsley', f0: 90,  note: 'Deep, and a shorter reference than most.' },
  { key: 'voice-zero/bill_boerst/original',    source: 'voice-zero', id: 'bill_boerst',    f0: 126, note: null },
  { key: 'voice-zero/stuart_bell/original',    source: 'voice-zero', id: 'stuart_bell',    f0: 127, note: 'Moves around a lot — reads with character.' },
  { key: 'vctk/p247_023/enhanced',        source: 'vctk',       id: 'p247_023',       f0: 132, note: 'Steady.' },
  { key: 'vctk/p255_023/enhanced',        source: 'vctk',       id: 'p255_023',       f0: 145, note: 'What I sound like unless my human changes it.' },
  { key: 'voice-zero/caro_davy/original',      source: 'voice-zero', id: 'caro_davy',      f0: 155, note: null },
  { key: 'vctk/p234_023/enhanced',        source: 'vctk',       id: 'p234_023',       f0: 181, note: null },
  { key: 'vctk/p250_023/enhanced',        source: 'vctk',       id: 'p250_023',       f0: 216, note: 'Moves around a lot.' },
  { key: 'vctk/p236_023/enhanced',        source: 'vctk',       id: 'p236_023',       f0: 238, note: 'The highest here.' },
]);

export const shortlistKeys = () => new Set(SHORTLIST.map((v) => v.key));

/**
 * The enhanced recording of a voice where one exists, otherwise the original.
 *
 * Not every clip has both. The VCTK speakers do — those are studio recordings
 * with room tone that cleaning genuinely helps. The LibriVox voice-zero clips
 * and Alba MacKenna's character voices are original-only, because they were
 * already clean and upstream never produced an enhanced pass.
 *
 * So "prefer enhanced" has to be a lookup against the catalogue rather than a
 * rule applied to a key. Assuming the enhanced variant existed for everything
 * is exactly the mistake that silently pointed four shortlist entries at files
 * that were not there.
 */
export function preferEnhanced(key, catalogueKeys) {
  if (typeof key !== 'string') return key;
  const enhanced = key.replace(/\/original$/, '/enhanced');
  if (enhanced === key) return key;
  return catalogueKeys?.has?.(enhanced) ? enhanced : key;
}

/** Sources we may actually ship. The gate, not a suggestion. */
export function shippableSources() {
  return VOICE_SOURCES.filter((s) => s.license.redistributable && !s.rejected);
}

export function sourceByKey(key) {
  return VOICE_SOURCES.find((s) => s.key === key) ?? null;
}

/** Why a source was ruled out, for anyone who wonders later. */
export function rejectionReason(key) {
  const s = sourceByKey(key);
  if (!s) return 'unknown source';
  if (s.rejected) return s.rejected;
  if (!s.license.redistributable) return `${s.license.label} is not redistributable in a GPL distribution.`;
  return null;
}

/**
 * The NOTICE text, generated from the catalogue rather than maintained by
 * hand — so a credit cannot be dropped by someone tidying prose, and adding
 * an attributed source cannot silently skip its credit.
 */
export function attributionNotice(sources = shippableSources(), { bundled = null } = {}) {
  const lines = ['# Bundled voice credits', ''];

  // The clip actually committed to this repo gets named first and on its own.
  // Crediting it inside a list of sources we merely *offer* would blur the
  // line the CC BY obligation sits on: attribution is owed for what we
  // distribute, and right now that is exactly one file.
  if (bundled) {
    const s = sourceByKey(bundled.source);
    lines.push('## Shipped in this repository', '');
    lines.push(`\`${bundled.file}\` — ${bundled.key}`);
    if (s) lines.push('', `${s.label} — ${s.license.label}${s.attribution ? `. ${s.attribution}` : ''}`);
    lines.push('');
    lines.push('## Available to download', '');
  }

  lines.push('The reference clips my voice can be cloned from come from these sources.');
  lines.push('');
  for (const s of sources) {
    const credit = s.attribution ?? s.creditAnyway;
    lines.push(`- **${s.label}** — ${s.license.label}${credit ? `. ${credit}` : ''}`);
  }
  lines.push('');
  lines.push('Sources under a non-commercial licence are deliberately not bundled; see `voice-catalogue.js` for which and why.');
  lines.push('');
  return lines.join('\n');
}

// ── Ward-supplied voices ─────────────────────────────────────────────────

/**
 * Where a reference clip came from. This is not a licence field — it is a
 * *handling* field, and it governs three different questions that are easy to
 * conflate:
 *
 *   BUNDLED       Came from the catalogue above. Ships with me, may be
 *                 redistributed, appears in the NOTICE.
 *   WARD_SUPPLIED My human gave me this clip — a character they love, a
 *                 friend who volunteered, a voice that means something to
 *                 them. Ward decision: this is allowed, because it is
 *                 personal use and never leaves their machine.
 *
 * The distinction matters because a ward-supplied clip may be someone else's
 * copyrighted performance. Personal use is theirs to make; redistribution is
 * not. So a ward-supplied clip:
 *
 *   ✅ lives on their machine and is used to speak
 *   ✅ travels in THEIR OWN identity backup — that is not redistribution,
 *      it is their data moving with them, and a restored Familiar who comes
 *      back sounding like a stranger is a continuity break, not a fresh start
 *   ❌ never rides out in a diagnostic report, a bench report, a bug paste,
 *      a shared media surface, or anything sent to a third party
 *
 * That last line is the one that needs enforcing in code, because the paths
 * that would leak it are all paths built to be helpful: "attach your logs",
 * "send this report back", "here is what is on disk."
 */
export const VOICE_PROVENANCE = Object.freeze({
  BUNDLED: 'bundled',
  WARD_SUPPLIED: 'ward-supplied',
});

/**
 * May this clip leave the machine in something shared with a third party
 * (a diagnostic paste, a bench report, an issue attachment)?
 *
 * Fails CLOSED: anything whose provenance we cannot establish is treated as
 * the ward's own. Wrongly withholding a bundled clip from a bug report costs
 * a follow-up question; wrongly including a ward's clip cannot be undone.
 */
export function mayLeaveTheMachine(voice) {
  return voice?.provenance === VOICE_PROVENANCE.BUNDLED;
}

/**
 * Does this clip belong in my human's own identity backup?
 *
 * Everything does. A backup that restores my memories and my name but not my
 * voice restores something that sounds like a stranger wearing me — and the
 * voice is part of my identity (§6.5), not a preference sitting beside it.
 */
export function belongsInIdentityBackup(voice) {
  return Boolean(voice);
}

/**
 * Strip anything that must not leave the machine from a set of voices bound
 * for a shared artifact, and say what was withheld — a silent omission would
 * leave someone debugging a voice problem with no idea a voice was involved.
 */
export function redactForSharing(voices = []) {
  const shared = [];
  const withheld = [];
  for (const v of voices) {
    if (mayLeaveTheMachine(v)) shared.push(v);
    else withheld.push({ id: v?.id ?? null, reason: 'a voice my human gave me — theirs, not mine to hand out' });
  }
  return { shared, withheld };
}

/**
 * Validate a proposed shipping set. Used by the build and by the test suite:
 * a violation is a hard stop, because shipping the wrong clip is not a bug
 * that can be patched away after the fact — it is already distributed.
 */
export function validateShippingSet(keys) {
  const problems = [];
  for (const key of keys) {
    const s = sourceByKey(key);
    if (!s) { problems.push({ key, problem: 'unknown source' }); continue; }
    if (s.rejected) { problems.push({ key, problem: s.rejected }); continue; }
    if (!s.license.redistributable) { problems.push({ key, problem: `${s.license.label} may not ship` }); continue; }
    if (s.license.requiresAttribution && !s.attribution) {
      problems.push({ key, problem: `${s.license.label} requires attribution and none is recorded` });
    }
  }
  return { ok: problems.length === 0, problems };
}
