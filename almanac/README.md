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

Read [Getting Started](getting-started) for a guided path through the five core pages that build a working model of the system: architecture, entity-as-subject, multi-embodiment, core prompts, and proactivity over caution.

Then use [Concepts](concepts) to look up repo-specific vocabulary by cluster, and [Decisions](decisions) to find the recorded decisions that constrain the architecture.

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
