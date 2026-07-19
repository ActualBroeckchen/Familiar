---
title: "Naming Thalamus: Mediator, Not Generator"
topics: [decisions, architecture]
sources:
  - id: naming-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/6ad1c817-Naming_a_new_entitycore_module.txt
    note: "Founding design conversation in which the maintainer named Thalamus, worked out its relationship to entity-core, and repeatedly had to correct the assistant's drift into treating Familiar as an identity rather than the frontend."
  - id: thalamus-js
    type: file
    path: thalamus.js
---

# Naming Thalamus: Mediator, Not Generator

**Status: decided, in active use.** `thalamus.js` is named after the brain structure, not chosen
as a generic-sounding label — the maintainer picked it after rejecting several other candidates
specifically because "Thalamus" was the one whose etymology and function both matched what the
module was designed to do: sit between [Phylactery](../architecture/phylactery) (then
entity-core) and the LLM, and assemble context without doing the thinking itself
[@naming-conversation]. This page records the naming reasoning and two things that are not
otherwise recoverable from the code: a vocabulary-confusion incident worth treating as a standing
gotcha, and the fact that Thalamus's context-selection logic was, at the time, and remains today,
purely mechanical rather than judgment-driven.

## Rejected names and why

The maintainer's first instinct was **Carbuncle** or the Germanized **Karbunkel** — a name with a
genuinely magical heraldic meaning (a radiant, self-luminous gem) and a beloved *Final Fantasy*
summon, but rejected because in everyday English it lands on "skin abscess" for most readers, and
germanizing the spelling does not remove the association [@naming-conversation]. **Nucleus** was
considered next — it captures "core identity, everything organized around it" — but was set aside
for reading as "science lab" rather than the "witchy/magicky" register the maintainer wanted
[@naming-conversation]. **Omphalos** (the mythological navel of the world, where everything
connects outward from), **Nexus** (rejected as too corporate-tech), **Nodus** (Latin for knot),
and **Ganglion** (a nerve cluster, rejected for reading as biologically unpleasant in the same way
Carbuncle did) were named and considered in the same pass, before the conversation converged on
the thalamus specifically [@naming-conversation].

## Why thalamus won

The winning name came from asking what the module's *relationship* to the rest of the system
actually was, not from browsing synonyms for "core." The maintainer described the intended role
as: "It's more something that stores and connects their self to all the other parts. The bit that
sits between knowledge, senses and voice and filters everything" [@naming-conversation]. That
description matches, almost exactly, what the thalamus does in the brain: it routes and filters
sensory information before it reaches consciousness, without generating any of the content itself
— it mediates, it does not think. The Greek etymology, *thalamos* ("inner chamber" or "bridal
chamber" — the secret room where the self lives), reinforced the same idea from a different angle
[@naming-conversation]. The name was chosen specifically because it does real work for a reader:
"anyone who looks it up goes 'oh, that's what this thing is'" [@naming-conversation]. This is why
the module's job, as documented in [Architecture](../architecture), is still described the same
way years later — thalamus assembles context and never executes actions, exactly the
routes-filters-mediates-not-generates shape the name was chosen for.

## Gotcha: Familiar is not an identity

The naming conversation repeatedly drifted into treating "Familiar" as if it were itself an agent
with a self and a data folder — at one point proposing that Familiar's own `user/` and `self/`
folders should hold data, as though Familiar were a second character alongside whatever the AI
turned out to be [@naming-conversation]. The maintainer had to correct this twice, first gently
("Familiar doesn't really have an identity yet... it's just a very simple main prompt") and then
directly: "Familiar is not an identity or self. Familiar is the name I gave the software, the
frontend... You're still talking and thinking about it as if, say, you'd go 'So SillyTavern gets a
folder and Eury gets a folder'" [@naming-conversation]. The corrected vocabulary, which is the
vocabulary the shipped project actually uses, is:

| Term | What it is |
|---|---|
| Familiar | The software — the frontend Familiar itself. It has no identity or self of its own. |
| Thalamus | The context-assembly layer inside Familiar's server process. |
| entity-core (now [Phylactery](../architecture/phylactery)) | The data store: identity, memories, values. |
| Eury | The actual AI character — the identity the data store holds and the one who talks to the ward. See [Eury as the agent's identity](eury-as-agent-identity). |

This is exactly the kind of category error a future contributor or agent could make again from a
casual reading of the code — "Familiar" appears in file names, commit messages, and the product
name, and it is easy to slide from "the software called Familiar" into "the entity called
Familiar" without noticing the substitution. When writing about this codebase, keep the four
terms in the table distinct.

## Thalamus began — and remains — purely mechanical

At the point this conversation specified the first `thalamus.js` implementation, its `enrich()`
function was designed to do exactly three things on every message: query entity-core for memories
relevant to the user's message, query entity-core for the character's own values/voice, and
assemble both into a labelled context block — with no LLM call of its own deciding *which*
categories were worth fetching for a given message [@naming-conversation]. The conversation named
this as a known limitation and a future direction in the same breath: "Long term, I hope I can
implement tool call commands as tomes... injected post-history only when the agent needs them,"
reasoning that a fixed, always-fetch list "burns tokens on every message" compared to selective
injection [@naming-conversation].

That evolution has not happened for Thalamus's own core queries. Reading the current
`enrich(userMessage, opts)` in `thalamus.js` shows it still unconditionally requests
`identity_get_all`, `memory_search`, and `graph_node_search` from Phylactery plus `temporal_context`
from Unruh on every non-`staticOnly` turn — the only things that can suppress a category are
audience-based gating (V3's `fetchEligibility`), `staticOnly` mode, and idle-mode's extra bookmark
fetch, none of which read the *content* of the user's message to decide what is worth asking for
[@thalamus-js]. The `query: userMessage` argument passed to `memory_search` and `graph_node_search`
shapes what comes *back* from a fixed category, not whether that category is asked for at all. The
tome-based selective-injection idea named in this same conversation shipped as a different feature
— [Session memorization](../architecture/session-memorization)'s Tomes are keyword-activated, not
always-injected — but Thalamus's own fixed four-category fetch is the one piece of the original
design that is still exactly as mechanical as it was on day one.

## Related

- [Naming Cerebellum: executes, does not decide](cerebellum-naming) — the parallel naming
  decision for thalamus's outward-facing sibling, worked out in a separate conversation but
  following the same "the name does interpretive work" philosophy.
- [Architecture](../architecture) — thalamus's current `enrich()` contract, its `Promise.allSettled`
  fan-out, and the strict split from `cerebellum.js`.
- [Multi-embodiment](../concepts/multi-embodiment) — why entity-core (now Phylactery) is the
  canonical store Thalamus mediates access to, rather than storing anything itself.
- [Eury as the agent's identity](eury-as-agent-identity) — the actual identity Phylactery holds,
  as distinct from Familiar or Thalamus.
- [Unruh](../architecture/unruh) — the schedule/temporal specialist that grew out of the same
  founding conversation, recorded separately.
