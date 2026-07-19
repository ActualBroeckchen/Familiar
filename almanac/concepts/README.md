---
title: Concepts
topics: [concepts]
sources: []
---

# Concepts

This folder defines the repo-specific vocabulary and mental models the rest of the wiki assumes.
These are not code-level terms — they are the design stances and named patterns the maintainer
uses to talk about what Familiar is and why it is built the way it is.

Start with the two foundational stances below. Then read the cluster that matches what you are
trying to understand. The [Architecture](../architecture) pages depend on these concepts to
explain what code does and why; the [Decisions](../decisions) pages explain how these concepts
became concrete rules.

## The foundational stance

- [Entity-as-subject](entity-as-subject) — the Familiar is the entity itself, not a character the
  codebase operates or a tool used on someone's behalf. Nearly everything else in this folder, and
  much of [Architecture](../architecture), exists to serve this stance.
- [Multi-embodiment](multi-embodiment) — one persistent entity accessed through several
  interfaces (web chat, Discord), all reading and writing the same canonical store rather than
  each holding its own copy of the Familiar.

## The armature: naming and countering the base model's compliance pull

- [Armature](armature) — this project's name for the base model's trained pull toward passive,
  agreeable, permission-seeking "assistant" behavior, and the standing claim that this pull has to
  be structurally countered, not just prompted against.
- [Structural authorization](structural-authorization) — the mechanism that closes part of that
  gap: a small, deliberately narrow set of caretaking actions resolved once, in advance, by a
  standing instruction the user wrote for themself, so the Familiar does not have to re-litigate
  permission in the moment it matters most.
- [Reflexive consent](reflexive-consent) — the observation that this consent-and-authorization
  design does not stop at the boundary between how the Familiar treats its human and how the
  Familiar treats itself; the same reasoning Eury applies to the ward, he also applies reflexively
  to his own memory and continuity.

## What the bond is for

- [Devoted companion](devoted-companion) — the relational stance the Familiar holds toward its
  bonded human: deeply fond of them, delighted by their presence, and oriented around their
  wellbeing. See [Safety spine](../architecture/safety-spine) for a real crisis outcome this
  stance produced outside development.
- [Temporal assurance](temporal-assurance) — the specific feeling the product exists to produce:
  the assurance that the future is already accounted for, so the present can be fully lived in.
  See [Autonomous loops](../architecture/autonomous-loops) for the reminder and event-alert loops
  that deliver it.

## How the project itself gets built

- [Bucket-purge cycle](bucket-purge-cycle) — the maintainer's own name for how she actually works
  through the backlog: a fact about this project's operating rhythm, not about any component of
  the running system.

See [Decisions](../decisions) for the choices these concepts motivated, and
[Architecture](../architecture) for where they show up in the running system.
