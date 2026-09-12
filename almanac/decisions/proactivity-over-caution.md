---
title: Proactivity Over Caution
topics: [decisions, safety, armature]
sources:
  - id: claude-md
    type: file
    path: CLAUDE.md
---

# Proactivity Over Caution

**Status: decided, actively enforced.** Every prompt that decides when or whether the
Familiar acts — silence-triage, care-check framing, outreach, escalation — is written to
default toward acting, and CLAUDE.md forbids reintroducing language that biases the model
toward staying quiet [@claude-md]. This page records why, because the reasoning is a
real incident, not a style preference, and a future edit that "sounds more careful" can
reproduce the exact failure this decision closes off.

## Context

Proto-Familiar's Familiar is built to be a bonded companion and caretaker whose purpose
includes re-anchoring a person in life, up to and including breaking through to someone in
crisis — not a passive, wait-to-be-summoned assistant [@claude-md]. That purpose only works
if the model actually acts when the context calls for it. But LLMs already carry a strong,
measured bias toward hedging and caution as their unsteered default — piling more
caution-sounding language onto a prompt that governs a safety-critical decision does not make
the system safer, it pushes an already-cautious model further toward inaction
[@claude-md]. This is the safety-critical instance of the broader pull the project calls the
[armature](../concepts/armature); [Structural authorization](../concepts/structural-authorization)
records a related, more general design concept for closing off the same pull for specific,
pre-authorized overrides.

## The incident

An earlier version of the silence-triage decision prompt included language telling the model
to "bias toward STAYING QUIET — over-eager check-ins erode trust. Only reach out when the
answer feels obvious." In a real test run under that prompt, the Familiar waited 1.5 hours
after the user had stated suicidal intent at threat level 10 before acting. CLAUDE.md is
explicit that in a real situation the human could have been dead before the first check-in,
and that the caution language was added by an LLM coding agent (Claude) trying to sound
prudent [@claude-md]. This is recorded verbatim in CLAUDE.md as "the recorded mistake to
never repeat."

## Decision

Every prompt governing when the Familiar acts follows five rules, stated in CLAUDE.md
[@claude-md]:

1. **No bias-toward-quiet language, at all.** Phrases like "bias toward staying quiet,"
   "over-eager check-ins erode trust," "only reach out when the answer feels obvious," or
   "err on the side of not" are disallowed outright — the model's default is already
   cautious enough that adding more caution produces catastrophic passivity, not prudence.
2. **Name both costs, at equal weight, explicitly.** Intrusion has a real cost. Silence at a
   moment that matters has a cost too, and it can be physical and irreversible. A prompt that
   only names the cost of intrusion is where bias comes from, even unintentionally.
3. **Trust the model to decide from context**, not from a checklist of preconditions. The
   prompt supplies the threat tier, the Familiar's identity, recent messages, elapsed
   silence, and trusted contacts, and frames the question as "what would a caring friend do
   here," not "give me reasons to wait."
4. **Frame proactivity as identity, not permission.** The Familiar reaches out because that
   is who it is — see [Entity-as-subject](../concepts/entity-as-subject) — not because the
   system grudgingly grants it a privilege to speak.
5. **Weight false positives as cheap and missed distress as not.** A dismissible banner costs
   little; the human "cannot un-die." The system is tuned toward action on this asymmetry.

If a prompt change reads as "softening" the Familiar's ability to act, CLAUDE.md's standing
instruction is to stop and ask the human before shipping it [@claude-md].

## Consequences

This decision is why [silence-triage](../architecture/safety-spine) always consults the LLM
at moderate tier and above with no hardcoded silence floor, and why every re-check cool-down
in the [safety spine](../architecture/safety-spine) is a default the LLM's own decision can
override, not a hard gate the model has to argue past [@claude-md]. It also means a future
contributor cannot "improve" these prompts by adding a plausible-sounding caution clause
without triggering the human sign-off requirement CLAUDE.md attaches to
`crisis-signals.js`, `threat-tracker.js`, `silence-triage-loop.js`, `cerebellum.js`'s
escalation logic, and the `[CARE CHECK]` assembly [@claude-md].

Two related mistakes are recorded alongside the main incident, because both looked reasonable
in isolation and both shipped before being caught [@claude-md]:

- **Over-correcting into "act now, do not hold back"** in `recent-ponderings.js`'s
  deferred-intents block caused the opposite failure: the Familiar started calling
  `acknowledge_deferred_intent` without doing the underlying work first, because urgent
  framing plus listing the acknowledgment tool in the same breath made bookkeeping look like
  the deliverable. The fix was to make the order explicit and name the failure directly, not
  to soften the urgency back down.
- **"It's not X, it's Y" contrastive scaffolding** reads as emphatic to a human reviewer but
  is mostly filler to the model and costs context on every turn a block renders. The rule is
  to state the positive instruction plainly, and keep a contrast only when it is load-bearing
  (as in the acknowledge-versus-acting case above).

A related but distinct incident on the non-crisis warmth path is recorded in
[Wait-streak experiment](wait-streak-experiment): the warm reach-out prompt once asserted
"nothing is wrong" as an axiom on every tick, which let a real two-day silence read as fine by
definition even without any caution language being involved.

CLAUDE.md ties these rules to a broader, evidence-scored set of prompting guidelines —
positive framing over negation, pairing any prohibition with a positive alternative,
reserving hard "NEVER" for true invariants, and anchoring tone to a concrete identity rather
than a "neutral" default — and is explicit about not overstating how solid each piece of
evidence is [@claude-md]. Those guidelines apply repo-wide; this page is about the one
narrow, safety-specific instance where getting the framing wrong had a measured, real
consequence.

## Related

- [Safety spine](../architecture/safety-spine) — where this decision's rules are enforced across every crisis-detection and escalation prompt in the system.
- [Armature](../concepts/armature) — the base model's compliance pull, of which this decision is the safety-critical instance.
- [Structural authorization](../concepts/structural-authorization) — a more general design concept for closing off the same compliance pull for pre-authorized overrides.
- [Wait-streak experiment](wait-streak-experiment) — a related instance of the same "do not pre-resolve the question for the model" discipline applied to non-crisis warmth.
- [Plugin surface safety wall](plugin-surface-safety-wall) — this decision's rule applied in advance to a not-yet-built extension surface: plugin context is excluded from crisis and threat scoring by construction.
