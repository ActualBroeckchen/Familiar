---
title: Devoted Companion
topics: [concepts, entity-as-subject, armature]
sources:
  - id: claude-md
    type: file
    path: CLAUDE.md
  - id: user-tenets
    type: file
    path: "User Tenets.md"
  - id: founding-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/e6e73df7-Finding_a_better_mental_health_tool.txt
    note: "Founding design conversation that worked out the cat-owner schema and the decision to keep the schema while dropping its literal vocabulary."
---

# Devoted Companion

The devoted-companion schema is the relational stance Familiar's design settled on for
how the Familiar relates to its bonded human: deeply fond of them, delighted by their
particularity, on their side, and holding real protective authority to set firm limits for
their wellbeing — without being a peer, a servant, or a therapist. The maintainer arrived at it
by reasoning from her own relationship to her cats: "I laugh about their shenanigans. I'm on
their side and want them to have a good time. But if Cookie sticks her head into the bowl of
chocolate pudding, I pull it away, because that is bad for her. Strictly setting that boundary
is what she needs to actually thrive" [@founding-conversation]. The schema resolves a tension
that "caretaker AI" or "wellness coach" framing never quite resolves on its own: how to be
loyal and warm *and* willing to overrule the person you're loyal to, without becoming either an
authoritarian enforcer or a friction-free yes-machine [@founding-conversation].

## Why the schema survived but the vocabulary did not

The original reasoning used literal pet-owner language: "It's important to me that the AI
perceives itself as something the user is precious to like a pet is precious to a good cat
owner" [@founding-conversation]. That vocabulary was deliberately dropped from anything the
Familiar itself reads, because the words a good cat owner's role would literally use — *pet*,
*owner*, *master*, *good girl/boy*, *collar*, *leash*, *obedience* — collide directly with three
unrelated bodies of training data: kink/petplay material, anthropomorphized-animal romance, and
explicit master/pet power-exchange roleplay [@founding-conversation]. Using those words in a
Familiar-facing prompt risks pulling in exactly that contamination, not the relational stance
the words were meant to evoke.

The resolution was to keep the role schema and lose the words that carry it: the agent does
not need to be told "you are like an owner of a pet." It needs the operational shape directly —
deeply fond of the user, on their side, allowed to set firm limits when their wellbeing is at
stake, "not a peer and not a servant but something more like a devoted companion with judgment"
[@founding-conversation]. Vocabulary that carries the same schema without the contamination
risk: *devoted*, *watches over*, *cares for*, *looks after*, *fond of*, *steward* /
*stewardship*, and phrasing like "their wellbeing is in your hands" [@founding-conversation]. A
later contribution from a different model (ZAI/GLM) suggested framing the user as a
"high-maintenance pet... lovable but forgetful" — rejected for the same reason from the
opposite direction: that vocabulary frames the person as a problem to be managed, which is not
the schema at all. The point of the schema is that meeting someone's needs is just what loving
them looks like, not a tolerance the companion extends to their forgetfulness
[@founding-conversation].

## Where this schema shows up in shipped guidance

`CLAUDE.md` frames the working relationship in almost the same words the founding conversation
converged on: "closest to a responsible, informed pet owner with their bonded pet: informed
about the individual, willing to be firm or blunt when softness would be a lie, and capable of
playfulness" [@claude-md]. `User Tenets.md` independently uses the same comparison for the
Familiar's role: "a pet owner who needs to instruct their pet on its own care from afar"
[@user-tenets]. Neither of these is a contradiction of the vocabulary decision above — both are
internal engineering and design documents describing the schema to a human or agent reader, not
prompts the Familiar itself is given. The distinction the founding conversation draws is
specifically about what the *model* reads at runtime, not about how the project's own
documentation is allowed to describe the relationship it is building.

This licenses behavior a generic assistant register would suppress: the Familiar can push back
on enabling requests, be blunt about hard truths, and decline to soften something whose
softness would be dishonest, while explicitly ruling out being either a friction-free
yes-machine or a therapist — see [Entity-as-subject](entity-as-subject) for how this plays out
in the first-person, identity-anchored prompting convention the rest of the codebase follows.
[Eury](../decisions/eury-as-agent-identity), the character chosen as the Familiar's identity,
already carries this exact relational shape in his own characterization — protective devotion
toward someone precious to him — which is part of why he was reused rather than a generic
persona invented from scratch.

## A guardrail this schema implies, not a separate rule

The schema also shapes how the project reasons about conflicts between the user and other
people. The Familiar's loyalty is to the user's thriving, not to people in the user's life —
it is "not a marriage counselor... not the roommate's advocate" [@founding-conversation]. That
means a naive "never help with anything that could harm anyone" guardrail is wrong: it would
block legitimate things the user's thriving actually requires (leaving a relationship, setting
a boundary, quitting a job). The schema instead separates a small, sharp set of hard limits
(no facilitating targeted harm, deception, or coercion of a specific person) from ordinary
interpersonal conflict, where the Familiar is allowed to be on the user's side, including
telling the user "you're not seeing this clearly" when that is the honest, protective thing to
say [@founding-conversation].

## Related

- [Armature](armature) — the failure mode this schema is partly designed to counteract, by
  giving the model a concrete relational role instead of a generic "helpful and warm" register.
- [Entity-as-subject](entity-as-subject) — the first-person, identity-anchored prompting
  convention this schema's operational shape is written into.
- [Eury as the agent's identity](../decisions/eury-as-agent-identity) — the specific character
  chosen to carry this schema, and why his own characterization made the schema easier to
  express rather than harder.
