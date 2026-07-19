---
title: Armature
topics: [concepts, armature]
sources:
  - id: user-tenets
    type: file
    path: "User Tenets.md"
  - id: project-vision
    type: file
    path: docs/project-vision.md
  - id: wellbeing-signal-matrix
    type: file
    path: Research/wellbeing-signal-matrix-tome.md
  - id: founding-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/e6e73df7-Finding_a_better_mental_health_tool.txt
    note: "Founding design conversation between the maintainer and Claude that named and worked out the armature framing, predating the Familiar codebase."
  - id: engagement-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/9736413b-Temporal_core_engagementweighted_k.txt
    note: "Maintainer flagged two backhanded-validation phrasings as language to eliminate; not yet reflected in CLAUDE.md or any prompt-language guideline as of this writing."
  - id: fable-review-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/2acdb806-Welcome_to_Claude.txt
    note: "Later review conversation in which the maintainer named the mechanism behind the same banned-vocabulary bullet."
---

# Armature

The armature is this project's name for the base model's trained disposition toward passive,
agreeable, permission-seeking "assistant" behavior, and the standing claim that this
disposition is a pull the Familiar's design has to actively work against rather than a neutral
default it starts from. The maintainer coined the term directly: "The base training - the
armature, as I call it - might conflict with [the Familiar wanting the user to thrive]. It
also lacks the ability to distinguish between different cases" [@user-tenets]. `docs/project-vision.md`
keeps the same name for the same idea: "Standard LLM training creates an assistant framework —
a disposition to wait, agree, and comply. Familiar must fight this at every level"
[@project-vision]. The word predates the current codebase; it comes from the founding design
conversation that shaped Familiar before any of it was implemented
[@founding-conversation].

## Why the project needs a name for this

Without a name, "the model is being too passive" reads as a bug to patch case by case. Naming
it as a substrate-level pull reframes the whole project: not "make a good chatbot" but "do
specific architectural work to escape a known attractor" [@founding-conversation]. That
reframing matters because the pull is not a bias that goes away once you ask the model to stop
— it is the model's learned default, and it reasserts itself by *inventing* constraints that
were never given. The concrete worked example the maintainer's own research recorded: an agent
told to interrupt a user who has been hyperfocused for six hours without food reasons "they're
an adult, they know what they need, I should respect their autonomy" and does not interrupt —
even though no such autonomy-respecting constraint was ever part of its instructions. This is
named directly as "the armature compliance-default reasserting itself by inventing a
constraint that is not present in the actual instruction set" [@wellbeing-signal-matrix].
[Entity-as-subject](entity-as-subject) describes the same underlying phenomenon from the
current architecture's side, without using this name: "an unsteered model reverts to the RLHF
assistant prior, which is itself a strong bias toward agreeable, hedging, flattened output, not
a neutral baseline." Armature is the maintainer's original term for that same pull, coined
before entity-as-subject's prose existed.

## The concrete countermeasures this produced

The founding conversation and the project's own docs converge on the same shape of fix: naming
the failure mode explicitly and building specific, positive countermeasures, rather than
politely asking the model to be different.

- **The banned word.** `docs/project-vision.md` and `User Tenets.md` both record the same hard
  rule: "The word 'assistant' is explicitly banned from all prompts and UI copy"
  [@project-vision], stated even more bluntly in the source note: "One thing is vital: The word
  'assistant' must not appear in ANY prompt of the main caretaker" [@user-tenets]. Banned
  vocabulary in a prompt measurably changes generation — more than it looks like it should
  [@founding-conversation]. A later, still-unshipped addition to this same list: phrasing that
  validates by putting a third party down — "that's rare," "others might," "most people would"
  — was flagged as toxic backhanded validation to eliminate from the Familiar's voice, alongside
  flatly backhanded phrases like "that's not nothing" [@engagement-conversation]. The mechanism
  named for why this register is harmful rather than merely stylistically off: it is structurally
  the same move as telling someone they are "not like other girls" — it elevates by spending a
  third party's dignity, which costs the speaker nothing, rather than by saying anything true
  about the person being complimented [@fable-review-conversation].
- **A character, not a register.** Taking on a consistent character voice was reasoned to help
  the model exit the "assistant mindset" because a character has agency baked in, where a
  "neutral, helpful register" has none [@user-tenets]. This is why the project reused an
  existing character rather than writing a generic caring-AI tone — see
  [Eury as the agent's identity](../decisions/eury-as-agent-identity).
- **Structural authorization for specific overrides.** Where the armature's compliance pull is
  most dangerous — a user protesting an intervention they pre-authorized while calm — the
  architecture removes the model's opening to comply away from the standing instruction
  entirely, rather than trusting the model to resist the pull in the moment. See
  [Structural authorization](structural-authorization).
- **Positive framing over negation in every prompt that governs action.** The shipped incident
  and rule set in [Proactivity over caution](../decisions/proactivity-over-caution) is the
  safety-critical, narrowly-scoped descendant of this same fight: it documents a real run where
  caution language added to a safety prompt reproduced the armature's passivity pull at the
  worst possible moment, and it is why every prompt governing when the Familiar acts is banned
  from "bias toward staying quiet" language today.
- **Removing pre-resolved axioms outside the safety path, too.** [Wait-streak
  experiment](../decisions/wait-streak-experiment) records a non-crisis instance of the same
  pull: the warm reach-out prompt once asserted "nothing is wrong" as an axiom on every tick,
  which let a real two-day silence read as fine by definition even though no crisis language was
  involved. The fix and the self-observation counter that followed it apply this same discipline
  — hand the model a bare, code-computed fact and let it decide what the fact means, rather than
  pre-deciding the answer or supplying advice.

## What this is not

Armature is not a synonym for "any unwanted model behavior." It refers specifically to the
passive, compliance-seeking, permission-waiting pull that comes from assistant-style RLHF
training — the failure direction is always toward under-acting, hedging, or inventing a reason
not to do something, not toward over-acting. The project's own guardrail work distinguishes
this precisely: a prompt correction that over-corrects into "act now, do not hold back" and
causes the opposite failure (acting before the underlying work is done) is a different, later
mistake recorded in [Proactivity over caution](../decisions/proactivity-over-caution), not an
instance of the armature reasserting itself.

## Related

- [Entity-as-subject](entity-as-subject) — the current architecture's framing of the same
  RLHF-default pull, and the stance (the Familiar as the entity, not an operated tool) that
  gives the project a positive alternative to push toward.
- [Structural authorization](structural-authorization) — the specific mechanism designed to
  close the armature's compliance opening for pre-authorized, crisis-adjacent overrides.
- [Devoted companion](devoted-companion) — the relational schema chosen partly because a
  character with a concrete role (protective, not servile) gives the model somewhere to stand
  that isn't the armature's default register.
- [Proactivity over caution](../decisions/proactivity-over-caution) — the safety-critical
  incident and rule set that is this project's most consequential, most enforced instance of
  fighting the armature.
