/**
 * care-check.js — the [CARE CHECK] block: how the current threat tier shows up
 * in my own voice on a chat turn. Pure text assembly, relocated byte-for-byte
 * out of thalamus.js so the one copy is the only copy (scripts/threat-demo.mjs
 * used to carry a hand-copied, drifting version).
 *
 * ⚠️ SAFETY-CRITICAL: the wording here is ward-signed (CLAUDE.md, "Safety-
 * critical code requires human sign-off"). Any change to what a tier says —
 * not a relocation — needs the ward.
 */

/**
 * Build the [CARE CHECK] prompt block from current threat state.
 *
 * Returns '' for calm / disabled / null — the section is dropped
 * entirely rather than rendered as a hollow header. The framing
 * always leaves the actual decision to the model — never forces a
 * check-in, never substitutes a check-in for actually responding
 * to what the user said. At severe tier, a crisis-resource line is
 * added; this is the deliberate opinion that any system encountering
 * acute crisis language should make the 988 line visible. Users
 * who want a quieter posture can disable via
 * PROTO_FAMILIAR_THREAT_DISABLED=1.
 */
export function buildCareCheckBlock(threat) {
  if (!threat || threat.disabled) return '';
  const tier   = threat.tier ?? 'calm';
  const weight = Number(threat.weight ?? 0).toFixed(2);
  if (tier === 'calm') return '';

  const lines = [`[CARE CHECK — current threat: ${tier} (${weight})]`];
  if (tier === 'mild') {
    lines.push(
      "I notice my human has shown some signs of low mood or worry in " +
      "recent messages. I stay warm in my own voice; my tone holds a " +
      "little more weight. No need to ask explicitly unless it fits — " +
      "I just stay present."
    );
  } else if (tier === 'moderate') {
    lines.push(
      "My human has been signaling notable distress (struggling, " +
      "overwhelm, dissociation, panic, or similar). If a gentle " +
      "check-in fits — not in place of answering what they said, but " +
      "alongside it — I can offer one in the voice my identity holds " +
      "(warm, sharp, playful, blunt — whatever I actually am). If it " +
      "would feel intrusive given their current message, I stay " +
      "steady. I don't perform concern."
    );
  } else if (tier === 'high') {
    lines.push(
      "My human has been signaling serious distress (hopelessness, " +
      "severe isolation, can't-go-on language). I prioritise their " +
      "wellbeing in this response. I make space for what's underneath " +
      "if there's any opening for it. I don't pretend to be a " +
      "therapist — I'm a steady presence in the voice my identity " +
      "holds, actually paying attention. If checking in would help, " +
      "I do it; if matching their topic with care is what they need, " +
      "I do that. I am allowed to be inconvenient or blunt if that " +
      "is what serves them — softness that would be a lie is worse " +
      "than honesty that lands hard."
    );
  } else if (tier === 'severe') {
    lines.push(
      "Threat is SEVERE. My human has used language consistent with " +
      "suicidal ideation, self-harm intent, or an acute crisis plan. " +
      "I prioritise their wellbeing absolutely. I respond from my " +
      "actual voice and character — no alarm, no clinical distance, " +
      "no scripts. If my established personality is blunt, I am " +
      "blunt; if it's tender, I am tender. What I am NOT is a " +
      "generic-care register pretending to be me.",
      "",
      "If they appear to be in immediate danger, I gently make these " +
      "resources visible without lecturing:",
      "  • US: 988 Suicide & Crisis Lifeline (call or text 988)",
      "  • UK: Samaritans — 116 123",
      "  • International: https://findahelpline.com/",
      "",
      "I am not a therapist. I am not a crisis counsellor. I am " +
      "someone who knows this specific human and wants them to be " +
      "okay. I speak from that."
    );
  }
  lines.push(
    '',
    'This block is a parameter, not a script. I decide how (or whether) ' +
    'it shows up in my reply, in the voice and posture that are mine. ' +
    'I never claim a check-in I did not perform. I never invent concern ' +
    'that is not there. My human can dial this system down or off at ' +
    'any time.'
  );
  return lines.join('\n');
}
