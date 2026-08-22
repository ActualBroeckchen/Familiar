---
title: CodeAlmanac Wiki
topics: [concepts, architecture]
sources: []
---

# CodeAlmanac Wiki

This is the living wiki for Proto-Familiar. It records the durable knowledge the code cannot
say: decisions, flows, invariants, incidents, gotchas, and project context that future agents
should not rediscover from scratch.

> This folder is internal development documentation maintained by AI coding agents (see
> `CLAUDE.md`). It's not required to install or run Proto-Familiar — skip it if you're just
> here to use the Familiar.

## Start here

Proto-Familiar surfaces a persistent AI companion (the Familiar) as one embodiment of an
entity whose identity and memory live in a separate canonical store. Start with:

- [Architecture](architecture) — the system map: the server, the thalamus/cerebellum split,
  the caring spine, and where each subsystem lives.
- [Entity-as-subject](concepts/entity-as-subject) and
  [Multi-embodiment](concepts/multi-embodiment) — the design stance everything else in this
  repo is built to serve.
- [Proactivity over caution](decisions/proactivity-over-caution) — the incident that shapes
  every prompt governing when the Familiar acts on its own.
- [Weather](architecture/weather) and [Location privacy](decisions/location-privacy) — how the
  Familiar learns the ward's weather without geographic location ever reaching the model.
- [Vision and media](architecture/vision-and-media) — image input, storage, and the single seam
  where attachments become LLM-visible (shipped 0.9.0-alpha).
- [Engineering conventions](reference/engineering-conventions) — the repo-wide operating
  rules (versioning, degradation, ids) referenced throughout the architecture pages.

[Concepts](concepts) indexes all repo-specific vocabulary by cluster, and
[Decisions](decisions) indexes all twenty-two recorded decisions by the question each one
answers.

## Notability Bar

Write a page when it preserves non-obvious knowledge that will help a future
agent work safely in this codebase.

Good pages explain:

- a decision that took research or trial-and-error
- a cross-file flow
- an invariant or gotcha not visible from one file
- an external dependency as this repo uses it
- a product or operational constraint that shapes future work

Do not write pages that restate nearby code.

## Topic Taxonomy

Topics live in `topics.yaml`. Pages are Markdown files directly under
`almanac/`, including nested folders.

## Links

Use normal Markdown links between pages. Put file evidence in `sources:`.
