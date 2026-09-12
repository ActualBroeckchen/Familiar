/**
 * voice-audio-tags.js — turn an audio-tagging model's raw AudioSet events into a
 * plain "what I can hear in the room" line (voice spec §8.4).
 *
 * ANNOTATION-ONLY, this milestone. These tags make the Familiar a better listener
 * to the room it's in — nothing more. They NEVER move the threat tier, NEVER
 * trigger an action, and NEVER persist beyond the session; that would be
 * detection-that-changes-care, which §8.4 says gets its own spec and its own ward
 * sign-off. So this module deliberately does two safety-shaped things:
 *
 *   1. It DROPS human-vocalisation labels — speech, shouting, crying, laughter.
 *      "Distressed shouting" and "crying" are exactly the sound classes the
 *      long-term care ambition names, and reading them into context here would be
 *      that feature arriving quietly as a side effect. The room's sounds, not the
 *      people in it.
 *   2. It DROPS bare acoustic-environment labels (silence, "inside, small room")
 *      that say nothing a listener would remark on.
 *
 * What survives is a salient, non-human room sound above a confidence floor,
 * phrased plainly. Pure — the model produced the events upstream; here we only
 * classify + phrase, so the whole gate is unit-testable without a model.
 */

export const TAG_DEFAULTS = Object.freeze({
  floor: 0.5,   // a sound has to be at least this likely before I'd mention it
  topN: 3,      // never list more than a few — a wall of tags is noise, not listening
});

// Human vocalisations — dropped on purpose (see the header). Matched as substrings
// against the lowercased AudioSet label, so "Male speech, man speaking" and
// "Children shouting" both fall out.
const HUMAN_VOCAL = [
  'speech', 'speaking', 'conversation', 'narration', 'monologue', 'whisper',
  'shout', 'yell', 'scream', 'screaming', 'crying', 'sobbing', 'wail', 'sob',
  'laughter', 'laugh', 'giggle', 'chuckle', 'singing', 'humming', 'chant',
  'baby', 'infant', 'child singing', 'children', 'groan', 'grunt', 'gasp',
  'chatter', 'babble', 'sigh', 'cough', 'sneeze', 'sniff', 'breathing', 'snoring',
];

// Bare acoustic-environment / non-informative labels — nothing a listener remarks on.
const GENERIC = [
  'silence', 'inside, small room', 'inside, large room', 'inside, public space',
  'outside, urban', 'outside, rural', 'outside, natural', 'sound effect',
  'sounds of things', 'generic impact sounds', 'environmental noise', 'noise',
  'background noise', 'white noise', 'pink noise', 'echo', 'reverberation',
  'mains hum', 'hum', 'static', 'field recording', 'quiet',
];

// Friendly phrasings for the most common salient sounds. Keyed by a substring of
// the lowercased label; first match wins. Anything salient but unmapped falls back
// to "the sound of <label>", so an unusual real sound is still surfaced honestly
// rather than dropped for want of a hand-written phrase.
const PHRASINGS = [
  [['dog', 'bark'],                 'a dog barking'],
  [['cat', 'meow'],                 'a cat'],
  [['bird'],                        'birdsong'],
  [['television', 'tv'],            'a television in the background'],
  [['radio'],                       'a radio'],
  [['music'],                       'music playing'],
  [['doorbell', 'ding-dong'],       'a doorbell'],
  [['knock'],                       'knocking'],
  [['telephone bell', 'ringtone', 'telephone'], 'a phone ringing'],
  [['alarm', 'smoke detector', 'siren', 'buzzer', 'beep'], 'an alarm or beeping'],
  [['glass', 'shatter', 'smash'],   'breaking glass'],
  [['water tap', 'faucet', 'running water', 'sink (filling or washing)'], 'running water'],
  [['toilet flush'],                'a toilet flushing'],
  [['vacuum cleaner'],              'a vacuum cleaner'],
  [['blender', 'food processor'],   'a kitchen appliance'],
  [['microwave oven'],              'a microwave'],
  [['dishes', 'cutlery', 'silverware'], 'dishes clattering'],
  [['typing', 'computer keyboard'], 'typing'],
  [['printer'],                     'a printer'],
  [['applause', 'clapping'],        'applause'],
  [['rain'],                        'rain'],
  [['wind'],                        'wind'],
  [['thunder'],                     'thunder'],
  [['traffic', 'car passing', 'vehicle', 'engine'], 'traffic'],
  [['train'],                       'a train'],
  [['aircraft', 'airplane', 'helicopter'], 'an aircraft'],
  [['keys jangling'],               'keys'],
  [['clock', 'tick-tock', 'tick'],  'a ticking clock'],
  [['fire'],                        'a fire crackling'],
];

const norm = (s) => String(s ?? '').toLowerCase().trim();
const includesAny = (hay, needles) => needles.some((n) => hay.includes(n));

/** A stable, dedup-friendly key for a phrased sound (so the caller can mention it once). */
function phraseFor(label) {
  const l = norm(label);
  for (const [keys, phrase] of PHRASINGS) if (includesAny(l, keys)) return phrase;
  // Unmapped but salient: surface it plainly rather than inventing a phrase.
  return `the sound of ${l.split(',')[0].trim()}`;
}

/**
 * Classify a model's AudioSet events into at most one "what I can hear" line.
 *
 * @param {Array<{name:string, prob:number}>} events  raw AudioTagging output
 * @param {object} [o]
 * @param {number} [o.floor]  confidence floor (default 0.5)
 * @param {number} [o.topN]   cap on how many sounds to mention (default 3)
 * @param {Set<string>} [o.seen]  phrases already mentioned this call — skipped so a
 *   TV on the whole time isn't re-announced every utterance. NOT mutated (pure).
 * @returns {{ line: string|null, phrases: string[] }}  `line` is null when nothing
 *   salient survives; `phrases` are the NEW ones (the caller adds them to `seen`).
 */
export function classifyRoomSounds(events, { floor = TAG_DEFAULTS.floor, topN = TAG_DEFAULTS.topN, seen } = {}) {
  const list = Array.isArray(events) ? events : [];
  const seenSet = seen instanceof Set ? seen : new Set();
  const kept = [];
  const phrases = [];
  for (const e of list) {
    const name = norm(e?.name);
    const prob = Number(e?.prob);
    if (!name || !Number.isFinite(prob) || prob < floor) continue;
    if (includesAny(name, HUMAN_VOCAL)) continue;          // the room, not the people (safety boundary)
    if (GENERIC.includes(name)) continue;                  // nothing a listener would remark on
    const phrase = phraseFor(name);
    if (seenSet.has(phrase) || phrases.includes(phrase)) continue;   // mention each sound once
    phrases.push(phrase);
    kept.push(phrase);
    if (kept.length >= Math.max(1, topN)) break;
  }
  if (!kept.length) return { line: null, phrases: [] };
  return { line: `[I can hear ${joinPhrases(kept)} in the room with my human]`, phrases };
}

/** "a" / "a and b" / "a, b and c" — a plain human list, not a comma dump. */
function joinPhrases(items) {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
