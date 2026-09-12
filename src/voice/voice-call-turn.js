/**
 * voice-call-turn.js — the `onTurn` a live web call runs (voice spec §6.4 +
 * §10, Pass 2b).
 *
 * The call engine hands this a finished transcript and expects back a spoken
 * reply (an async iterable of PCM) or null. Everything platform- and
 * provider-specific is injected, so the orchestration — the ORDER of things and
 * the safety gate — is testable without a provider, a TTS model, or the threat
 * spine:
 *
 *   1. D2 (ward-signed): the ward's spoken words can raise the threat tier.
 *      We score the TRANSCRIPT — never model prose, the vision-0.9.2 discipline
 *      — and only for the ward, and only when scoring is enabled. It is
 *      fire-and-forget so a local scoring pass never delays the spoken reply,
 *      and it can never throw into the turn.
 *   2. Run the turn (the real chat path: enrich → provider → tool loop).
 *   3. `speakable()` the reply — the outgoing TTS boundary.
 *   4. Synthesize it to PCM the adapter streams to the browser.
 *
 * A missing reply (the turn had nothing to say) is a valid silent turn: null.
 * A thrown turn degrades to silence with a log, never a crash into the call.
 */

/**
 * @param {object}   deps
 * @param {function} deps.runTurn       async (transcript, ctx) => replyText   — the chat path
 * @param {function} deps.synthesize    (text) => AsyncIterable<Buffer>        — TTS worker stream
 * @param {function} [deps.speakable]   (text) => { text }                     — speakableText boundary
 * @param {function} [deps.scoreThreat] (transcript, ctx) => void|Promise      — D2: score → recordThreat
 * @param {function} [deps.threatEnabled] () => boolean                        — the D2 gate (voiceThreatScoring, off-switches)
 * @param {function} [deps.log]
 * @returns {function} onTurn(transcript, ctx) => Promise<AsyncIterable<Buffer>|null>
 */
export function createVoiceTurnRunner({
  runTurn,
  synthesize,
  speakable = (t) => ({ text: t }),
  scoreThreat = null,
  threatEnabled = () => false,
  log = () => {},
} = {}) {
  return async function onTurn(transcript, ctx) {
    const text = String(transcript ?? '').trim();
    if (!text) return null;

    // ── D2: ward voice → threat tier ────────────────────────────────────
    // Ward only (a villager's voice never moves the ward's tier — matters for
    // Pass 3; on web the speaker is always the ward), gated, and scoring the
    // transcript text. Fire-and-forget: the tier update must not sit between my
    // human finishing a sentence and hearing an answer.
    if (scoreThreat && ctx?.speakerRef === 'ward' && threatEnabled()) {
      try {
        const p = scoreThreat(text, ctx);
        if (p && typeof p.catch === 'function') p.catch((e) => log(`voice threat score failed: ${e?.message ?? e}`));
      } catch (e) { log(`voice threat score failed: ${e?.message ?? e}`); }
    }

    let replyText;
    try { replyText = await runTurn(text, ctx); }
    catch (e) { log(`voice turn failed: ${e?.message ?? e}`); return null; }

    const out = String(replyText ?? '').trim();
    if (!out) return null;

    let spokenText;
    try { spokenText = String(speakable(out)?.text ?? '').trim(); }
    catch (e) { log(`speakable() failed: ${e?.message ?? e}`); spokenText = out; }
    if (!spokenText) return null;

    try { return synthesize(spokenText); }
    catch (e) { log(`synthesize failed: ${e?.message ?? e}`); return null; }
  };
}
