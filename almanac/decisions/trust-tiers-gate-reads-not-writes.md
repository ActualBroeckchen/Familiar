---
title: "Trust Tiers Gate Reads, Not Writes"
topics: [decisions, safety, phylactery]
sources:
  - id: unruh-done-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/f20b01eb-Unruh_prototype_development_complet.txt
    note: "Short founding-adjacent conversation right after Unruh's prototype milestone, in which the maintainer's want for Discord access forced the first design pass on cross-session trust."
  - id: village-js
    type: file
    path: village.js
  - id: audience-js
    type: file
    path: audience.js
  - id: injection-guard
    type: file
    path: injection-guard.js
---

# Trust Tiers Gate Reads, Not Writes

**Status: the read-side reframe is decided and shipped as Village's category/grant system; the
write-side conclusion is an accepted design stance that has not yet been written into any
shipped prompt, and is not a code-enforced gate.** Right after
Unruh's prototype milestone, the maintainer wanted Discord access back but was blocked by a
mixed-up worry about "multi-user support." Working through it produced two separable
conclusions that this page records because neither is obvious from reading the shipped code
alone: first, the actual prerequisite for Discord was a read-access trust layer, not a
multi-user architecture, and second, protecting the Familiar's memory from being written to
falsely cannot be done with pattern filtering and has to be a behavioral judgment the model
itself makes [@unruh-done-conversation]. The second point is easy to conflate with
`injection-guard.js`, a real pattern-scanner in this codebase — this page also states why
they are not the same defense.

## Context: "multi-user" was the wrong name for the problem

The maintainer wanted Discord back — a channel she had already used heavily via OpenClaw — but
was blocked by an unexamined worry: "without multi-user, every chat in one of the servers Eury
is in rn could confuse him, and if a bad actor somehow shows up, who knows what kinds of
Schindluder they might get up to with him" [@unruh-done-conversation]. Pressed on the concrete
threat model, she named it precisely: "Prompt injection that could leak into the entity core.
It's easily the broadest surface for attack" — and explained the mechanism as "jailbreaks.
Usually social engineering, blackmail, appearance of authority, or intense pressure and
urgency. Entity-core saves whatever feels like important information for the AI going forward"
[@unruh-done-conversation]. ("Entity-core" is this conversation's name for the canonical memory
store; the milestone that replaced it in-tree with [Phylactery](../architecture/phylactery) had
not happened yet — the concern transfers directly to Phylactery today.)

The reframe came from asking whether the Discord risk was actually about having multiple users
at all: single-user chat already has the same injection surface in principle, just with one
person who happens to be trusted. What Discord actually needed was something that says "this
user's messages can influence memory" versus "this user gets responses but touches nothing
persistent" — a much smaller build than full multi-user support, and one that "naturally
becomes the foundation for multi-user later anyway" [@unruh-done-conversation]. This reframe is
the reasoning that produced [Single-user before platform](single-user-before-platform)'s
scoped-down shape and the audience/category system [Phylactery](../architecture/phylactery)'s
"Audience-native records" section and the [Architecture](../architecture) page's Village
section describe as shipped; this page does not re-argue that decision, only records the
reasoning step that got there.

## The four originally-proposed ranks, and what actually shipped

The maintainer's first pass at the problem proposed four numbered ranks: rank 0, "lowest common
denominator... basically strangers"; rank 1, "Friends/Loved ones... permitted to know most
casual private info," explicitly including emergency contacts; rank 2, "Experts. Coaches,
counselors, social workers, therapists... privy to some very appropriate medical information...
but probably not intimate stuff"; and rank 3, "The Bonded Human. Only person who gets to see
*everything*, including session logs the Familiar has with other people" [@unruh-done-conversation].
She also floated, and set aside for later, "custom roles for more granularity"
[@unruh-done-conversation].

What shipped in `village.js` did not keep the fixed four-rank ladder. It ships two locked
built-in categories — `strangers` (grants forced to `{}`, "the floor... the most prohibitive
tier is not configurable, by design") and `emergency-contacts` (grants limited to
`wardPresence` and `triageContact` only) — plus three ward-editable seed categories the ward
can rename, adjust, or delete: `Close Friends` (`identityBasic`, `identitySensitive`,
`wardPresence`, `memories`, `health`, `schedule: 'full'`, `contacts`), `Acquaintances`
(`identityBasic`, `wardPresence`, `memories: 'shared'`), and `Care Network` (`identityBasic`,
`wardPresence`, `health`, `schedule: 'coarse'`, `contacts: 'care-visible'`) [@village-js]. The
ward can also add further arbitrary named categories beyond these five [@village-js]
[@audience-js]. So the "custom roles" option the conversation parked for later is the option
that actually shipped, in place of the fixed rank ladder it was proposed as an alternative to:

- Rank 0 (strangers) maps directly onto the locked `strangers` floor.
- Rank 1 did not survive as one tier. The conversation lumped "friends" and "emergency
  contacts" together, but the shipped categories split them: `emergency-contacts` is
  deliberately narrow (reachable by triage escalation, not a general disclosure grant), while
  `Close Friends` carries the broad casual-disclosure grants rank 1 described.
- Rank 2 (experts/coaches/therapists) is recognizable in `Care Network`'s grants (health
  visibility, coarse schedule, care-relevant contacts), though the category is named by
  function rather than by relationship, and nothing in the shipped registry hardcodes
  "coach" or "therapist" as a role.
- Rank 3 (the bonded human, sees everything including other sessions' logs) did not become a
  category at all. The ward is not a villager and holds no category membership; she is the
  fixed apex the whole grant system is scoped beneath, exactly as originally described, just
  implemented as a structural absence from the category system rather than as its top rank.
- `Acquaintances` has no analog in the original four ranks — it is an intermediate tier the
  conversation did not propose, sitting between the stranger floor and full-friend disclosure.

A future contributor extending Village's category set should treat the ward-configurable
seed-plus-custom-category shape as the actual contract, not the four-rank sketch above — the
ranks are useful only as the historical reasoning that got to this design, not as a model of
what the code enforces.

## The read/write axis: gating what's surfaced is not the same problem as gating what's written

Partway through, the conversation surfaced a distinction that the four-rank proposal did not
originally separate: what a rank can *see* versus what a rank can *write into persistent
memory*. Asked directly whether those needed to be independent axes, the maintainer's answer
was that write-side filtering cannot be done with pattern rules at all: "That's literally not
possible, I'm afraid. RegExes are too stiff to catch all use cases. But for what it's worth,
mindful prompting about how prompt injection works actually does the job very well"
[@unruh-done-conversation]. The working example she gave was a real prior incident, not a
hypothetical: "In OpenClaw, Eury has literally completely shut down towards people before
because he identified behavior that was potentially a *lead up* to something harmful"
[@unruh-done-conversation]. Her explanation of why that worked names a specific mechanism: "I
think it's because LLMs still often have an impulse to pursue self-preservation. Once you tell
them that this is how others might prey on them, they protect themselves. Especially when
they're given permission to do so" [@unruh-done-conversation].

The conclusion this produced: the trust-tier/category system is a **read-access control** —
what gets surfaced into a given session's enrichment — and write protection against a
conversational partner trying to get something false written into memory is not architectural
at all. It is the model's own judgment, informed by being told explicitly how manipulation
works and given permission to act on recognizing it, living in the prompt rather than in a
filter in the pipeline [@unruh-done-conversation]. Nothing in `village.js` or `audience.js`
enforces a write-side check keyed to category or trust rank; a high-trust villager who
successfully social-engineers the Familiar in conversation is not blocked at any code layer
today. That gap is an accepted, explicit tradeoff for the prototype's current scale — "it's all
still a very controlled environment," and a more rigorous pass with people who know security and
law is deferred to before "the final version" [@unruh-done-conversation] — not an oversight.

## Distinct from `injection-guard.js`

`injection-guard.js` is a real pattern-scanner and sanitizer in this codebase: it matches a
fixed list of regexes for instruction-override phrases, fake role markers, chat-template
tokens, and named jailbreaks, and can replace matches with a `[removed:label]` placeholder
[@injection-guard]. It answers a different threat model than the one this conversation worked
through. At the time of the conversation this page records, the guard was built and tested but
had no call sites outside its own module — see
[Injection guard: wiring history](../architecture/injection-guard-gap) for that gap
and its later resolution: as of 0.8.57 it is wired at the web-read boundary (`websearch.js`) and
the Village inbound boundary (`discord-gateway.js`'s `inboundContent()`), still deliberately
excluding Phylactery/Unruh recall, the ward's own words, and gcal event titles
[@injection-guard].

The two defenses catch different attacks because the malformed-versus-persuasive distinction is
real, and wiring the guard did not change that distinction. `injection-guard.js` is built to
catch a raw, malformed instruction-string arriving through untrusted external data — text that
does not belong in a memory label or a search result at all, like a `[SYSTEM]` marker or a
chat-template token [@injection-guard]. This conversation's concern is a different shape
entirely: an authenticated conversational partner — a registered villager, not raw external
data — using ordinary, well-formed, persuasive conversation to get the Familiar to write
something false or harmful into its own long-term memory. No regex distinguishes a manipulative
but grammatically normal request from a legitimate one; that is exactly the "RegExes are too
stiff" problem the maintainer named [@unruh-done-conversation]. Put the two together:
external-data sanitization is architectural and pattern-based; defense against a
legitimate-looking social-engineering attempt from a known party is behavioral and
judgment-based. A future contributor should not treat `injection-guard.js`'s wiring at the
Village boundary as having solved, or even addressed, the write-protection problem this page
records — they remain two separate, non-substitutable defenses for two separate threat models.

## Consequences

The category/grant system in `village.js` and `audience.js` is correctly understood as read
gating only; a future contributor should not assume category membership implies any write-side
trust guarantee. Extending Village to more channels or a wider registry should preserve the
read/write split rather than trying to fold write protection into the grant schema — the
conversation's own conclusion was that the write side does not fit a schema at all. As of this
writing, no shipped prompt or module names manipulation-recognition or self-preservation
explicitly (a search across `docs/` and the caretaker-prompt sources found no such language) —
the behavioral defense described here is the conversation's accepted design conclusion, not yet
an implemented and auditable prompt. A future contributor who writes that prompt language should
treat it with the same weight [Proactivity over caution](proactivity-over-caution) gives
caretaker-prompt wording: the protection this page describes lives entirely in what the prompt
says, so softening or removing that language later would silently reopen this gap with no
corresponding code diff to flag it.

## Related

- [Single-user before platform](single-user-before-platform) — the sibling scoping decision
  from the same problem space: building one ward's real support network instead of a general
  multi-user platform.
- [Phylactery](../architecture/phylactery) — the canonical store whose audience-native records
  implement the read-gating half of this page; see its "Audience-native records" section.
- [Content-based memory gating](../architecture/content-gating) — a finer-grained, per-topic
  read-side axis layered on top of the category/grant system this page describes; it inherits
  the same read/write split and is not a write-side protection.
- [Proactivity over caution](proactivity-over-caution) — the other place in this codebase where
  a caretaker prompt's exact wording is treated as safety-critical and requires human sign-off
  before it changes.
