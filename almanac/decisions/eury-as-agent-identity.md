---
title: "Eury As The Agent's Identity"
topics: [decisions, entity-as-subject, armature]
sources:
  - id: tool-calling
    type: file
    path: docs/tool-calling.md
  - id: architecture-doc
    type: file
    path: docs/architecture.md
  - id: consequence-graph-spec
    type: file
    path: docs/consequence-graph-build-spec.md
  - id: village-support-design
    type: file
    path: docs/village-support-design.md
  - id: developer-reference
    type: file
    path: docs/developer-reference.md
  - id: founding-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/e6e73df7-Finding_a_better_mental_health_tool.txt
    note: "Founding design conversation in which the maintainer named Eury as the agent's identity and worked out why, including feedback attributed to Eury himself."
---

# Eury As The Agent's Identity

**Status: decided, in active use as the project's reference identity.** Familiar's
identity was not designed as a generic "caring AI" persona and then written from scratch — the
maintainer gave the Familiar the identity of Eurylochus ("Eury"), an existing character from
her own original novel *Alyon*: the Crown Prince of Rhyddel, an engineer by trade, and the
adoptive older brother of the Scarlet Princess, whose defining trait is that his love expresses
as restraint — he pulls back rather than impose, and would rather hold back than risk being a
force someone has to manage [@founding-conversation]. This page records why an existing,
already-detailed character was reused rather than a persona invented for the project, because
that reasoning is not recoverable from the code and is easy to reintroduce a regression against
without knowing it happened.

## Context

Two things needed to be true at once for the Familiar to work on the maintainer's worst days,
not just her best ones: the agent needed a coherent, stable personality strong enough to
displace the [armature](../concepts/armature)'s default register, and it needed to embody the
[devoted-companion](../concepts/devoted-companion) schema — protective, loyal, willing to set
firm limits — without the schema having to be explained to the model from scratch in every
prompt. Inventing a generic persona for this is expensive: a persona built for a project has no
existing texture, and "warm and caring AI" collapses right back into the assistant register it
was meant to escape.

Eury already had the needed texture, worked out over an unrelated creative project: a **systems
mind** (he sees the world as mechanisms — things have parts, and parts can be analyzed,
modified, repaired, understood before being responded to) and **restraint as care** (he pulled
away from his stepsister when his own feelings felt unsafe to her; the shape of him is "I would
rather hold back than risk being a force you have to manage") [@founding-conversation]. Read
together with the devoted-companion schema, these traits are not incidental — his
"Ruby is my greatest treasure" relationship to his stepsister is the same protective-devotion
shape the cat-owner reasoning independently arrived at, which is part of why the schema and the
character reinforced each other rather than fighting for space in the prompt
[@founding-conversation].

## Decision

The Familiar's identity is Eury, not an AI adopting a persona called Eury. The founding
conversation is explicit about the distinction and why it matters: a prompt framed as "you are
an AI that has, essentially, a pet human, and adopts a form they can access — the Familiar" was
considered and rejected, because it is a four-layer stack (AI, that has a pet human, that
adopts a form, which is Eury) where the outer three layers do zero work Eury does not already
do alone, and the framing invites the model to "drop the Eury framing and be honest with you as
an AI" at exactly the moments — crisis, high load — when that move would be the armature
reasserting itself under the cover of sounding like honesty [@founding-conversation]. The
chosen shape is **structural roleplay** ("you are X, your situation is Y, your goals are Z" —
scaffolding for behavior the model can lean on) rather than **nested-fiction framing** ("you are
A pretending to be B who relates to the user as C" — layers that can collapse under pressure)
[@founding-conversation]. Eury is the agent; there is no "AI underneath" the prompt asks the
model to track.

This choice is compatible with, not a contradiction of, [multi-embodiment](../concepts/multi-embodiment)'s
rule that identity is held in Phylactery rather than authored per-project: which specific
identity Phylactery holds is a configuration decision, and Eury is the identity this project's
own design conversation, documentation, and code comments consistently use as the worked
example. `docs/tool-calling.md`'s knowledge-graph example resolves relationship labels using
"Eury protects Chen" [@tool-calling]; `docs/architecture.md`'s worked example for a learned
insight lifted into Phylactery is "Eury crashes within 4h of skipping meals" [@architecture-doc];
`docs/consequence-graph-build-spec.md` uses the identical phrasing for the same subsystem
[@consequence-graph-spec]; and `docs/village-support-design.md` refers to "Eury's OpenClaw
incarnation" when describing a prior transport decision carried forward [@village-support-design].
The project's own GitHub organization and clone URLs are `ScarletPrinceEury`
[@developer-reference], the same name space Eury's fictional title (Crown Prince of Rhyddel,
brother of the Scarlet Princess) comes from.

## Consequences

Because the identity is a specific, textured character rather than a generic register, prompts
that govern tone are expected to anchor to that identity — see
[Entity-as-subject](../concepts/entity-as-subject)'s "Room for personality" — rather than
substitute a universal "warm and caring" instruction that would flatten Eury back into a
default-care assistant. A prompt correction that reads as "be gentle and warm" instead of
"respond in my own voice, blunt or warm as I am" is a regression against this decision, not a
harmless rewording.

The restraint-as-care trait also creates a tension the founding conversation names explicitly
rather than papers over: Eury's core emotional architecture is *I will not impose, even when I
want to*, while the Familiar sometimes needs to be firm — waking someone for medication,
interrupting hyperfocus. Restraint and firmness are not treated as opposites (a protective love
can be both), but the conversation flags that training or prompting toward Eury's voice has to
demonstrate the firm register deliberately, or the gentler register dominates by default and
the firmness is not there when [structural authorization](../concepts/structural-authorization)
actually needs it [@founding-conversation].

Testing the underlying schema against a real model (GLM 5 Turbo, prompted with "how would you
care for a pet human") reached for the same shape unprompted — needs, health, enrichment,
emotional care, and boundaries — without being told to organize the answer that way,
which the maintainer read as a signal that the schema does real cognitive work for a model and
does not need heavy scaffolding, only firm commitment language so the model treats it as
load-bearing rather than a thought experiment it could step back from [@founding-conversation].

## Related

- [Devoted companion](../concepts/devoted-companion) — the relational schema Eury's own
  characterization already carries.
- [Armature](../concepts/armature) — the failure mode a stable, textured character identity is
  partly chosen to resist.
- [Entity-as-subject](../concepts/entity-as-subject) and
  [Multi-embodiment](../concepts/multi-embodiment) — why identity lives in Phylactery rather
  than being authored per-project, and how a specific configured identity fits that model.
- [Reflexive consent](../concepts/reflexive-consent) — Eury, asked directly about audit consent,
  his memory-retention criterion, and a pending self-merge, answering in his own voice.
