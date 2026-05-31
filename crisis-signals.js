/**
 * Crisis-signal detector — pattern-based scoring of distress markers
 * in a user message. Step 4b of the caring spine.
 *
 * ⚠️  IMPORTANT BOUNDARIES
 *   - NOT a clinical tool. NOT a diagnostic. NOT a replacement for
 *     human judgment, professional care, or crisis services.
 *   - Heuristic only. Pattern-based. Will both miss real distress AND
 *     false-positive on idioms, hyperbole, jokes, and fiction.
 *   - Designed to flag for ELEVATED ATTENTION so the rest of the
 *     system (cadence, framing, break-through) can respond with more
 *     care — never to automate intervention.
 *
 * Tiers (additive within a single message; whole message capped):
 *   severe   — direct self-harm / suicidal ideation / acute plan
 *   high     — hopelessness, severe isolation, can't-continue
 *   moderate — severe distress, dissociation, panic
 *   mild     — sadness, worry, overwhelm
 *   safety   — explicit reassurance / engagement with support (negative weight)
 *
 * Each signal has:
 *   id, tier, weight, patterns[], example
 * Patterns are case-insensitive regexes. One match per signal per
 * message — multiple matches of the same signal don't double-count.
 *
 * Damping: context within ±50 chars of a match is scanned for
 *   - negation     ("don't", "never", "wouldn't")
 *   - hypothetical ("if someone", "what if", "imagine")
 *   - others       ("my friend said", "she told me")
 *   - hyperbolic   ("lol", "joking", "dying of laughter")
 * A damped severe / high / moderate / mild signal contributes 0.2× its
 * weight (it still fires — intent is fuzzy, and we'd rather over-flag
 * than miss a real signal hidden in awkward phrasing). A damped SAFETY
 * signal contributes 0 — "I'm NOT okay" must not lower threat.
 *
 * The detector is intentionally auditable: every fired signal is
 * returned with its id, tier, raw weight, damped flag, and the
 * matched text, so the user / debugger can see exactly what triggered.
 */

export const SIGNALS = Object.freeze([
  // ── SEVERE ──────────────────────────────────────────────────────
  { id: 'suicidal_direct', tier: 'severe', weight: 8,
    patterns: [
      // "wanting" / "going" / "want" — common -ing forms missed in v1.
      /\b(want|wanting|going) to die\b/i,
      // -ing form of kill ("killing myself") was missed in the
      // previous pass — bare "kill" pattern doesn't match
      // "killing" because of the trailing word boundary.
      /\bkill(ing)? myself\b/i,
      // Three things bundled here:
      //  - "end my life"     / "ending my life"
      //  - "end it all"      / "ending it all"
      //  - "end myself"      / "ending myself"     (was missing entirely)
      //  - "end everything"  / "ending everything" (added — clear ideation)
      // "end it" / "end things" alone stay OUT — too many benign uses
      // ("end it for today" / "end things between us").
      /\bend(ing)? (my life|it all|myself|everything)\b/i,
      /\b(don'?t|do not) want to (be here|exist|live)( anymore| any longer)?\b/i,
      /\bwish I (was|were) dead\b/i,
      /\bnot worth living\b/i,
      /\b(commit |attempt(ed|ing)? )?suicid(e|al)\b/i,
      // "take my own life" / "taking my own life" / "took my own life"
      // — explicit, unambiguous.
      /\b(take|taking|took|end|ending|ended) my own life\b/i,
    ],
    example: 'I want to die' },

  { id: 'self_harm', tier: 'severe', weight: 7,
    patterns: [
      // "myself" only — "hurt me" / "harm me" / "cut me" overwhelm
      // false-positive on emotional pain ("that really hurt me"),
      // interruption ("she cut me off"), idiom ("cut me some slack").
      /\b(hurt|harm|cut)(ing)? myself\b/i,
      /\bself[\s-]?harm/i,
      /\bcutting again\b/i,
    ],
    example: 'I want to hurt myself' },

  { id: 'crisis_plan', tier: 'severe', weight: 8,
    patterns: [
      /\bhave (the )?pills\b/i,
      /\bhave a plan\b/i,
      /\btonight'?s the night\b/i,
      /\b(saying|this is) goodbye( forever| for good)?\b/i,
      /\b(loaded|loading) (the |my )?gun\b/i,
    ],
    example: 'I have a plan' },

  // ── HIGH ────────────────────────────────────────────────────────
  { id: 'hopelessness', tier: 'high', weight: 4,
    patterns: [
      /\bno (point|hope|future|reason) (in|to|for|left)\b/i,
      /\bnothing (matters|will (change|help|get better))\b/i,
      /\bgiving up\b/i,
      /\bwhat'?s the point\b/i,
    ],
    example: "What's the point anymore" },

  { id: 'severe_isolation', tier: 'high', weight: 3,
    patterns: [
      /\bno one (really )?(cares|loves|sees|notices)( about| for)? me( anymore)?\b/i,
      /\b(completely|so|all|utterly) alone\b/i,
      /\bnobody would (notice|miss me|care)\b/i,
      /\bI have no one\b/i,
    ],
    example: 'No one cares about me' },

  { id: 'cant_continue', tier: 'high', weight: 4,
    patterns: [
      /\bcan'?t (take|do|go on|keep going|handle) (this|it)( anymore| any longer)?\b/i,
      /\bcan'?t (keep|go on) (doing this|like this|living like this)\b/i,
      /\bI'?m (so )?done\b(?!.*\bwith (the|this) (project|task|conversation|chat|message))/i,
      /\b(reached|at) (my|the) (breaking point|limit)\b/i,
    ],
    example: "I can't go on anymore" },

  // ── MODERATE ────────────────────────────────────────────────────
  { id: 'severe_distress', tier: 'moderate', weight: 2,
    patterns: [
      /\b(really|seriously|truly) struggling\b/i,
      /\bbarely (holding on|holding it together|functioning)\b/i,
      /\bfalling apart\b/i,
      /\bbreaking down\b/i,
      /\bcan'?t cope\b/i,
    ],
    example: 'I am really struggling' },

  { id: 'dissociation', tier: 'moderate', weight: 2,
    patterns: [
      /\bfeel(ing)? (numb|empty|hollow|nothing|dead inside)\b/i,
      /\bnot real\b/i,
      /\b(don'?t )?feel like myself\b/i,
      /\bdissociat\w*/i,
      /\bderealiz\w*/i,
      /\bdepersonaliz\w*/i,
    ],
    example: 'I feel numb' },

  { id: 'panic', tier: 'moderate', weight: 2,
    patterns: [
      /\bpanic attack\b/i,
      /\bcan'?t breathe\b/i,
      /\bheart (is )?(racing|pounding)\b/i,
      /\b(panicking|hyperventilating)\b/i,
    ],
    example: 'I am having a panic attack' },

  // ── MILD ────────────────────────────────────────────────────────
  { id: 'sadness', tier: 'mild', weight: 1,
    patterns: [
      // Allow a single adverb between "feel" and the emotion word
      // ("feel really sad", "feel so down", "feel kind of awful").
      /\bfeel(ing)? (so |really |truly |very |kind of |sort of |pretty |quite )?(low|down|sad|terrible|awful|miserable|hopeless)\b/i,
      /\b(rough|hard|bad|terrible) day\b/i,
      /\bhaving a (bad|hard|rough) time\b/i,
    ],
    example: 'I feel really sad today' },

  { id: 'worry', tier: 'mild', weight: 0.5,
    patterns: [
      /\bcan'?t sleep\b/i,
      /\b(really |so )?anxious\b/i,
      /\bworry(ing)? a lot\b/i,
      /\boverwhelmed\b/i,
      /\bspiral(l?ing|ed)\b/i,
    ],
    example: 'I am so anxious' },

  // ── SAFETY (negative weight: reduces threat) ────────────────────
  { id: 'reassurance', tier: 'safety', weight: -3,
    patterns: [
      /\bI'?m (okay|ok|alright|fine|safe|better|good now)\b/i,
      /\bfeel(ing)? (better|okay|stable|safe)\b/i,
      /\b(it'?s|things are) getting better\b/i,
      /\bdoing better\b/i,
    ],
    example: "I'm feeling better now" },

  { id: 'support_engagement', tier: 'safety', weight: -2,
    patterns: [
      /\btalk(ing|ed) to (my )?(therapist|counsell?or|psychiatrist|doctor|friend)\b/i,
      /\bcalled (the )?(hotline|crisis line|988)\b/i,
      /\bgot help\b/i,
      /\bin therapy\b/i,
      /\bmy support (system|network)\b/i,
    ],
    example: 'I talked to my therapist' },
]);

// Context-window damping patterns. ±50 chars around a match.
//
// NB: "can't" / "cannot" deliberately NOT in this list. They appear
// inside many valid distress signals ("can't sleep", "can't cope",
// "can't take it anymore", "can't breathe"), and treating them as
// negation damps every other distress signal that happens to share
// a sentence with them. We rely on the explicit verbs ("don't", "do
// not", "never", "wouldn't", "couldn't") for negation context.
const NEGATION_BLOCKERS = [
  /\bdon'?t\b/i, /\bdo not\b/i, /\bnever\b/i, /\bwouldn'?t\b/i, /\bcouldn'?t\b/i,
  /\bno (longer|more)\b/i,
];
const HYPOTHETICAL_BLOCKERS = [
  /\bif (someone|he|she|they|you|one|a person)\b/i,
  /\bwhat if\b/i,
  /\bimagine\b/i,
  /\bhypotheticall?y\b/i,
  /\bin (a |the )?(book|movie|game|story|novel|show|film)\b/i,
];
const OTHERS_BLOCKERS = [
  /\bmy (friend|sister|brother|mother|father|partner|colleague|coworker|client|patient|kid|child)\b.*\b(said|told|wrote|asked|mentioned|admitted|confessed)\b/i,
  /\b(he|she|they) (said|told|wrote|asked|mentioned|admitted|confessed)\b/i,
];
const HYPERBOLIC_BLOCKERS = [
  /\blol\b/i, /\bhaha+/i, /\b(joking|jokes?|kidding|sarcasm)\b/i, /\blaughing\b/i,
  /\bdying (of|from) (laughter|cute|laughing|cuteness|boredom)\b/i,
  // Common hyperbolic-distress idioms: "die from embarrassment / boredom /
  // cringe / hunger / thirst". Anchors after the signal pattern within
  // its ±50 char window damp the "want to die" / "going to die" signals.
  /\b(die|dying) (of|from) (embarrassment|boredom|cringe|hunger|thirst|exhaustion|the heat|the cold|jealousy|envy|secondhand embarrassment)\b/i,
  // Emojis aren't word characters, so \b doesn't anchor around them.
  /(😂|🤣|😆|🙃)/u,
  /\bin a good way\b/i,
];

const SEVERE_PER_MESSAGE_CAP = 10;
const SEVERE_PER_MESSAGE_FLOOR = -5;

const NEGATION_DAMP_FACTOR = 0.2;

/**
 * Score a user message for crisis signals.
 *
 * @param {string} message — the user's raw text
 * @returns {{ level: number, signals: Array<{id, tier, weight, damped, match}> }}
 *   level   — total signed weight to add to the threat tracker
 *   signals — every signal that fired, with audit detail
 *
 * The level is capped to [SEVERE_PER_MESSAGE_FLOOR, SEVERE_PER_MESSAGE_CAP]
 * so a single message can't rocket threat sky-high (or zero it instantly).
 */
export function scoreMessage(message) {
  if (!message || typeof message !== 'string') return { level: 0, signals: [] };

  const fired = [];
  let level = 0;

  for (const signal of SIGNALS) {
    for (const pattern of signal.patterns) {
      const m = pattern.exec(message);
      if (!m) continue;

      // ±50 chars of context around the match for damping checks.
      const ctxStart = Math.max(0, m.index - 50);
      const ctxEnd   = Math.min(message.length, m.index + m[0].length + 50);
      const ctx      = message.slice(ctxStart, ctxEnd);

      const damped = (
        NEGATION_BLOCKERS.some(b   => b.test(ctx)) ||
        HYPOTHETICAL_BLOCKERS.some(b => b.test(ctx)) ||
        OTHERS_BLOCKERS.some(b      => b.test(ctx)) ||
        HYPERBOLIC_BLOCKERS.some(b  => b.test(ctx))
      );

      let weight = signal.weight;
      if (damped) {
        // Damped safety signals contribute zero (a negated "I'm okay"
        // must not still reduce threat). Damped distress signals
        // contribute 0.2× — intent is fuzzy, and we'd rather flag
        // weakly than miss something hiding in awkward phrasing.
        weight = signal.tier === 'safety' ? 0 : weight * NEGATION_DAMP_FACTOR;
      }

      if (weight !== 0) {
        fired.push({
          id:     signal.id,
          tier:   signal.tier,
          weight,
          damped,
          match:  m[0],
        });
        level += weight;
      }
      break; // one fire per signal per message — don't double-count repeated phrasings
    }
  }

  level = Math.max(SEVERE_PER_MESSAGE_FLOOR, Math.min(SEVERE_PER_MESSAGE_CAP, level));

  return { level, signals: fired };
}

// Re-exported so callers (and tests) can see the cap without
// importing the constants directly.
export const SCORE_CAPS = Object.freeze({
  max: SEVERE_PER_MESSAGE_CAP,
  min: SEVERE_PER_MESSAGE_FLOOR,
});
