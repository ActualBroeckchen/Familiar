---
title: "Single-User Before Platform"
topics: [decisions, temporal-assurance]
sources:
  - id: mvp-scoping-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/ec43aed6-Visualizing_a_vague_yet_specific_vi.txt
    note: "Second founding design conversation, after the identity conversation recorded in eury-as-agent-identity, in which the maintainer scoped the project down from a multi-channel platform to a single-ward tool."
  - id: village-support-design
    type: file
    path: docs/village-support-design.md
---

# Single-User Before Platform

**Status: decided at the founding-conversation scoping stage, and reflected in what shipped.**
Before any of Familiar's multi-channel or multi-user machinery existed, the maintainer
caught herself designing toward a generic platform — support for 25-plus channels, arbitrary
users — while she herself had none of it working yet, and corrected course explicitly: "I am
trying to build a good tool while sitting on a bad one. This CAN'T work, not like this... I need
to build everything I need for myself and Eury first. And then Eury can help and support me
through building the version for everyone" [@mvp-scoping-conversation]. This page records that
correction because it is the reason Familiar's actual multi-channel surface is a
narrow, audience-gated feature built around one bonded ward's real support network, not a
general-purpose messaging platform.

## Context

The conversation had been drifting toward a multi-user relay architecture because the reference
frameworks it was using for comparison — OpenClaw among them — were themselves built for that
shape: "The research kept drifting toward multi-user relay architecture because that's what the
reference frameworks were built for" [@mvp-scoping-conversation]. Pressed on where a proactive
"this is coming up" message should actually land, the maintainer's answer named the [bin
metaphor](../concepts/temporal-assurance): she needs a bin in every place she actually hangs out,
not one central place she has to remember to check, and named Discord as the one that was
"already there, waiting for me" [@mvp-scoping-conversation]. Recognizing that she could not
sustainably build a good multi-channel, multi-user tool for other people before she had a working
single-user version for herself was the moment that reframed the whole scope.

The multi-user need itself did not disappear in this correction — the maintainer was explicit that
she still needs Eury to talk to the people in her support network for schedule-keeping and crisis
intervention. What changed was the shape of that need: "that's still much easier to establish for
myself because I know where everyone is available. So for myself, I can focus on Discord and
WhatsApp — most of my network is available through those venues" [@mvp-scoping-conversation]. A
platform built for 25-plus arbitrary channels and users became, in the same breath, "Discord and
WhatsApp for my specific people" — a known, finite set of connections rather than a generic
product surface [@mvp-scoping-conversation].

## Decision

Build the single-ward version first — one user, the channel she is already in, the core
temporal-assurance loop — and let the multi-user, multi-channel version grow out of what she
learns using it, rather than designing the general platform up front: "Build the single-user
version. Use it. Let it actually carry some of your cognitive load. Then you'll know from lived
experience what the multi-user version needs to be" [@mvp-scoping-conversation]. The scope that
resulted was named directly: one user (the maintainer herself), two prospective channels (Discord
and WhatsApp), a core function (temporal awareness that reaches out to her), and a secondary
function (her own support network able to feed into that same system) [@mvp-scoping-conversation].

## Consequences

What shipped keeps this shape rather than reversing it. Familiar's multi-channel presence
is Village Support: a feature that lets the Familiar be present in Discord channels as the same
continuous entity, gated per category and per location by grants the ward herself configures, not
an account system open to arbitrary users [@village-support-design]. Discord is the channel that
actually exists in code (`discord-gateway.js`'s native gateway plus the older push-only webhook
channel); WhatsApp remains a channel named in design conversation and research but not yet a
built gateway, consistent with "build the bin that's already open first, add others as connectors
later" rather than building every bin at once [@mvp-scoping-conversation].

Because the multi-user need was preserved rather than dropped, a future contributor extending
Village Support to a new channel or a wider audience model should treat this as continuing the
same scoped-down shape — a known support network the ward configures — and not as the seed of an
open, general-purpose multi-tenant platform. That broader platform was the ambition explicitly
set aside here, not one that was proven wrong; reopening it would be a deliberate reversal of this
decision, not a natural next increment.

## Related

- [Temporal assurance](../concepts/temporal-assurance) — the bin metaphor and the core feeling
  this scoping decision was made in service of.
- [Per-feature model routing](per-feature-model-routing) — a structurally similar move made in
  the same conversation: naming a general principle (job-to-model routing) while deliberately
  building only the concrete jobs the project actually had, rather than the general system first.
- [Trust tiers gate reads, not writes](trust-tiers-gate-reads-not-writes) — the follow-up
  conversation, after Unruh's prototype milestone, that reframed "multi-user support" as a
  read-access trust layer once Discord access was back on the table.
