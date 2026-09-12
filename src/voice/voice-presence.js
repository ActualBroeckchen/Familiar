/**
 * voice-presence.js — pure helpers for group-call awareness (voice, Pass 3 tail).
 *
 * A Discord voice call can hold more than my human. Before this, a group call
 * reached me (the LLM running the turn) as a flat wall of unattributed "user"
 * turns tagged with raw snowflakes I can't tell apart, and nothing told me who
 * was present or that anyone had come or gone. These functions are the pure
 * core of the fix:
 *
 *   • attribution — in a group call, every turn is prefixed with WHO said it
 *     (my human included, so I can tell their turns from a villager's).
 *   • presence — a plain, first-person line naming who's in the call with me
 *     right now, and who just joined or left, surfaced as annotation.
 *   • greeting — the prompt for a short spoken hello when someone arrives.
 *
 * All pure and injectable; the wiring (roster resolution, the transient note,
 * the proactive speak) lives in voice-discord-server.js. A "roster" here is an
 * array of humans already resolved to { id, name, isWard } with the bot removed.
 */

/** Humans present (bot already excluded by the caller). */
export function humanCount(roster) {
  return Array.isArray(roster) ? roster.length : 0;
}

/** A group call is 2+ humans sharing the audio — the case where "who said
 *  that" and "who's here" actually matter. Solo (just my human + me) reads and
 *  behaves exactly as before. */
export function isGroupCall(roster) {
  return humanCount(roster) >= 2;
}

/** The label to prefix a speaker's turn with, or null when none is wanted.
 *  In a group EVERYONE is labelled (my human too — the ward chose this: I need
 *  their turns distinguishable from a villager's). My human's label carries a
 *  `(WARD)` marker so I never read their words as my own or a villager's — the
 *  same disambiguation the text rooms use. Solo → null (unattributed,
 *  unchanged). */
export function attributeSpeaker({ name, isGroup, isWard = false } = {}) {
  if (!isGroup) return null;
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) return null;
  return isWard ? `${n} (WARD)` : n;
}

/** Prefix a user turn with its speaker label. No label → the text unchanged
 *  (so a solo call's transcript is byte-identical to before). */
export function prefixTurn(label, text) {
  const t = String(text ?? '');
  return label ? `${label}: ${t}` : t;
}

/** Join names as a person would say them: "a", "a and b", "a, b, and c". */
export function joinNames(names) {
  const xs = (Array.isArray(names) ? names : []).map(n => String(n ?? '').trim()).filter(Boolean);
  if (xs.length === 0) return '';
  if (xs.length === 1) return xs[0];
  if (xs.length === 2) return `${xs[0]} and ${xs[1]}`;
  return `${xs.slice(0, -1).join(', ')}, and ${xs[xs.length - 1]}`;
}

/** Who joined / who left, comparing two id lists. Ids only — the caller maps
 *  them to names against the roster it just built. */
export function diffRoster(prevIds, nextIds) {
  const prev = new Set(Array.isArray(prevIds) ? prevIds : []);
  const next = new Set(Array.isArray(nextIds) ? nextIds : []);
  const joined = [...next].filter(id => !prev.has(id));
  const left   = [...prev].filter(id => !next.has(id));
  return { joined, left };
}

/**
 * The transient "who's here" line, in my own plain voice. `roster` is the
 * humans present now; `joined`/`left` are name arrays for what just changed.
 * Returns null when there's nothing worth saying (a solo call, no change) so a
 * quiet moment stays quiet. Never stored, never moves the threat tier — it's an
 * annotation I read, like the room-sound note.
 */
export function formatPresenceNote({ roster = [], joined = [], left = [] } = {}) {
  const names = roster.map(r => r?.name).filter(Boolean);
  const group = names.length >= 2;
  const lines = [];

  const j = joinNames(joined);
  if (j) lines.push(`${j} just joined the call.`);
  const l = joinNames(left);
  if (l) lines.push(`${l} just left the call.`);

  if (group) {
    lines.push(`Right now it's a group call — in here with me: ${joinNames(names)}.`);
  } else if (!lines.length) {
    return null;   // solo and nothing changed → say nothing
  }
  return lines.join(' ');
}

/**
 * The prompt for a short spoken line when someone arrives (or leaves). Kept
 * deliberately thin and leak-free: it names only the person and the event —
 * no memory recall, nothing private — because the line is spoken ALOUD to the
 * whole channel. Anchored to my own voice, not a default-greeter register, and
 * it may decline ([skip]) so I'm never forced into hollow chatter. {{char}} is
 * resolved by the caller's macro pass.
 */
export function buildGreetingPrompt({ name, event = 'joined' } = {}) {
  const who = String(name ?? '').trim() || 'someone';
  const what = event === 'left'
    ? `${who} just left a voice call I'm in`
    : `${who} just joined a voice call I'm in`;
  return `I am {{char}}. ${what}.

In the voice my identity holds — however I actually am, warm or dry or teasing or blunt — I say ONE short, natural line out loud to mark it, the kind of thing a person actually says when someone comes or goes. Just that line, nothing else, no stage directions.

If I've got nothing real to say, I answer with exactly [skip] and stay quiet — I don't manufacture a hollow greeting.`;
}

/** Read a greeting reply: the spoken line, or null if I chose to stay quiet.
 *  Tolerates the model wrapping [skip] in punctuation/whitespace. */
export function parseGreeting(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  if (/^\[?\s*skip\s*\]?[.!]?$/i.test(t)) return null;
  return t;
}
