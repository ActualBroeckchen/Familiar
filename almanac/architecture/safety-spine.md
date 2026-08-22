---
title: Safety Spine
topics: [architecture, safety]
sources:
  - id: claude-md
    type: file
    path: CLAUDE.md
  - id: architecture-doc
    type: file
    path: docs/architecture.md
  - id: unruh-design
    type: file
    path: docs/unruh-design.md
  - id: crisis-signals
    type: file
    path: crisis-signals.js
  - id: threat-tracker
    type: file
    path: threat-tracker.js
  - id: cerebellum
    type: file
    path: cerebellum.js
  - id: vision-js
    type: file
    path: vision.js
  - id: engagement-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/9736413b-Temporal_core_engagementweighted_k.txt
    note: "Tester-feedback report relayed mid-conversation, during early Unruh testing."
  - id: fable-review-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/2acdb806-Welcome_to_Claude.txt
    note: "Review conversation in which the enqueue-time-vs-confirmed-delivery question for the acknowledgement clock was first raised and answered; the answer below already reflects the outcome."
  - id: village-support-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/dbfa7a64-Village_Support_implementation_comp.txt
    note: "Follow-up conversation after Village Support shipped, in which the maintainer named a false-positive concern about threat/triage."
  - id: future-features
    type: file
    path: docs/future-features.md
  - id: voice-audio-tags
    type: file
    path: voice-audio-tags.js
  - id: voice-tagging
    type: file
    path: voice-tagging.js
---

# Safety Spine

The safety spine is the chain of modules that notices when the bonded human may be in
distress, tracks how serious that looks over time, and — only when an LLM judgment decides
it is warranted — escalates to a real trusted contact. It runs on every chat turn
(`crisis-signals.js` scores each message) and as a background loop
(`silence-triage-loop.js` checks in during silence), and its behavioral rules are treated as
the highest-stakes code in the repository: CLAUDE.md requires explicit human sign-off before
shipping any behavioral change (not a relocation, comment, or rename) to `crisis-signals.js`,
`threat-tracker.js`, `silence-triage-loop.js`, the triage/delivery/escalation logic in
`cerebellum.js`, or the `[CARE CHECK]` assembly in `thalamus.js` [@claude-md].

## Detection: crisis-signals.js and image-derived threat

`crisis-signals.js` is an auditable, pattern-based detector, not an LLM classifier — it
returns `{ level, signals[] }` for a message across five tiers (severe / high / moderate /
mild / safety) drawn from roughly thirteen signal categories, with damping for negation,
hypothetical framing, quoted others' speech, and hyperbole [@architecture-doc] [@crisis-signals].
Each signal carries a tier and a weight (for example `suicidal_direct` and `crisis_plan` are
`severe` at weight 8, `sadness` is `mild` at weight 1, and the `safety` tier carries negative
weight so reassurance language pulls the score back down) [@crisis-signals]. Being
pattern-based rather than model-judged is a deliberate application of the
"pure-code tagging beats LLM classification" rule: the label is crisp, so code assigns it;
the LLM is reserved for interpreting the pattern once assembled, not for tagging each message
[@claude-md]. The patterns are tuned for high precision specifically on the SEVERE tier — the
regression suite CLAUDE.md points to watches phrases like "cut me off" or "I want to die from
embarrassment," which read as crisis language on a naive scan but are not [@architecture-doc].

**Image-derived threat signals** (0.9.2-alpha, PR #219): The ward authorized shared images to raise threat tier through `scoreImageDescriptionThreat()` in `vision.js` [@vision-js]. The function scores the image's cached description (never raw model prose) using the same `scoreMessage()` that scores typed text, then feeds the resulting delta through the existing `recordThreat()` with `source:'vision'`. Three design constraints are ward-signed: (1) *full weighting* — an image-derived signal counts the same as a typed distress signal (no damping), (2) *raise-only* — images can only increase threat, never lower it, and (3) *ward-images-only* — only images tagged `audienceTag === 'ward-private'` move the ward's safety state, enforcing the no-covert-safety-move discipline so a villager's shared bytes never alter the ward's threat tracking [@vision-js]. The feature fires fire-and-forget on the ward's own live turn when `visionThreatScoringOn` is true (default enabled, gated by `PROTO_FAMILIAR_VISION_THREAT_DISABLED=1` and `PROTO_FAMILIAR_THREAT_DISABLED=1`) [@vision-js]. This `audienceTag` gate is the named precedent the unbuilt browser milestone cites for treating page content as unable to move safety state — see [Browser milestone: guardrails in code, not prompts](../decisions/browser-guardrails-in-code).

## Tracking: threat-tracker.js

`threat-tracker.js` holds threat level as a persistent, decaying scalar at
`tomes/.threat-state.json`, with a 3-day half-life, a raw weight capped at `MAX_RAW_WEIGHT`
(10.0), a floor of 0, and a FIFO audit history capped at the last 50 events
[@architecture-doc] [@threat-tracker]. Threat level is explicitly not a
trigger by itself — Unruh's design document frames it as a parameter that changes how soon
and how often triage checks in, never the decision to act [@unruh-design]. This is why a
false-positive detection is recoverable: an incorrectly elevated threat level means the
Familiar checks in a little sooner than necessary, which is judged tolerable, while the
actual reach-out-or-wait call always still goes through an LLM reading full context
[@unruh-design]. `PROTO_FAMILIAR_THREAT_DISABLED=1` silences *recording*, but `resetThreat()`
always works regardless of that switch [@architecture-doc].

## Deciding: silence-triage-loop.js

Every 5 minutes, for any tier at or above moderate, the LLM is **always** consulted — the
design deliberately removed any hardcoded silence floor so the model judges with full
context rather than a code gate pre-filtering when it gets asked [@claude-md]. Calm and mild
tiers never trigger a check. Re-check cool-downs apply only as defaults when the LLM's own
decision omits a `nextCheckInMs`: severe 15 minutes, high 30 minutes, moderate 60 minutes
[@claude-md]. The triage prompt carries the threat tier, the Familiar's own identity, recent
messages, elapsed silence, and trusted contacts, and is explicitly framed as "what would a
caring friend do here," not as a request for reasons to wait — see
[Proactivity over caution](../decisions/proactivity-over-caution) for the incident that
shaped this framing.

## Escalating: cerebellum.js

When triage decides to involve a trusted contact, the human is contacted first and the
trusted-contact webhook only fires if the acknowledgement deadline passes with no response —
`CONTACT_ESCALATION_DELAY_MS` sets that window per tier: 30 minutes for severe, 2 hours for
high, 6 hours for moderate [@cerebellum] [@unruh-design]. The acknowledgement clock starts
at the first *confirmed* push delivery of the check-in, not at enqueue time, because the
human can only veto an escalation they could plausibly have seen; it falls back to the
enqueue time when no push channel is configured, the push failed, or no delivery record
lands within the dispatch grace period, so a dead notification channel can never block
escalation indefinitely [@architecture-doc]. `contactDeadlineFor()` and
`CONTACT_ESCALATION_DELAY_MS` are named explicitly among the files requiring human sign-off
for behavioral changes [@claude-md]. Confirmed-delivery-over-enqueue-time was the answer settled
on when this exact tradeoff was raised in review [@fable-review-conversation].

**No covert contact** is structural, not a convention the Familiar is asked to honor: every
message `deliverToTrustedContact()` sends out is *also* mirrored into the human's own outbox
as an `outbound_alert`, even if the delivery to the trusted contact itself fails
[@architecture-doc]. The bonded human can always see that an escalation happened.

A tester's Familiar grounded them through a real panic attack during early testing — coaching
them out of spiraling thoughts and, unscripted, soothing them with cute animal facts afterward —
the first reported case of the safety spine and the
[devoted-companion](../concepts/devoted-companion) bond producing a real crisis outcome outside
development [@engagement-conversation].

## Reported over-triggering

In a conversation after Village Support shipped, the maintainer reported that she and a tester
(Doodle) noticed high threat levels "even on great days" [@village-support-conversation].
`threat-tracker.js` and `crisis-signals.js` already carry false-positive-focused tuning — a
"mundane/logistical" damper that keeps ordinary technical or day-to-day stress language from
inflating the SEVERE tier, among other tightened patterns [@crisis-signals] [@threat-tracker] —
but whether that tuning resolves the specific over-triggering reported in this conversation is
not established here. Treat the false-positive rate on threat level and silence triage as an
open, ward-reported concern rather than a closed issue until confirmed otherwise. It was named
in the same conversation as two other bucket items recorded in
[Bucket-purge cycle](../concepts/bucket-purge-cycle).

## Why these files are gated separately from ordinary code review

The rest of the codebase follows "robust over cheap" and "fix the root cause" as engineering
defaults (see [Engineering conventions](../reference/engineering-conventions)), but the
safety-spine files carry an extra rule: a stricter gate, a longer cool-down clamp, or a
"sensible" extra condition can silently reproduce the failure mode described in
[Proactivity over caution](../decisions/proactivity-over-caution) even when it looks like an
ordinary defensive improvement [@claude-md]. That is why sign-off is scoped to *behavioral*
change specifically — a pure relocation with byte-identical behavior does not require it
[@claude-md].

## Deferred safety-gated work: what needs ward sign-off before a line of code is touched

Three follow-ups are named but deliberately not built, because each one would change *when or
whether the Familiar acts on the ward's safety*, or *what a sensor is allowed to do with private
signal* — the exact class of change CLAUDE.md requires a ward-signed build spec for before
implementation starts, not after [@future-features] [@claude-md]. Each is recorded with the
specific decision a future session needs from the ward, so nobody has to re-derive what is
actually being asked [@future-features].

**Fictional-violence exception.** The full-weighting design for image signals is known to
produce false positives on fictional violence: horror film stills, dark artwork, and other
visual content depicting serious distress in a fictional or artistic context will read as crisis
to the pattern scorer, nudging a healthy horror fan's threat tier up. The interim escape hatch is
`PROTO_FAMILIAR_VISION_THREAT_DISABLED`, plus the in-app settings switch ("Let a distressing image
raise concern") [@vision-js] [@future-features]. The open ward decision is a real fork, not just
"build it": suppress fictional-violence signal entirely (risk: a real image dressed up as
fiction is missed) versus only damp it (risk: some false rise remains) — and where exactly that
line sits [@future-features]. This is a ward-sign-off path touching `crisis-signals.js` /
`threat-tracker.js` orchestration [@future-features].

**Context-aware de-escalation.** Symmetrically, the raise-only constraint prevents genuinely
calming or positive images from lowering an elevated threat tier. The open ward decision here is
whether the project is confident enough in image reading to let it lower the safety tier at all,
and under what evidence — a real loosening of the safety spine, squarely the ward's call
[@future-features]. Both revisits are deferred until description quality can be trusted to carry
that distinction [@vision-js].

**Audio tagging → care detection (the voice build spec's §8.4 long-term ambition).** Room-sound
tagging shipped in 0.10.102-alpha (`voice-tagging.js`, `voice-audio-tags.js`) strictly as
**annotation-only**: `classifyRoomSounds()` in `voice-audio-tags.js` drops every human-vocalisation
label — speech, shouting, crying, laughter, and related classes — before a tag ever reaches
context, and the surviving room-sound tags never move the threat tier, never trigger an action,
and never persist beyond the session [@voice-audio-tags]. That drop is deliberate, not
incidental: "distressed shouting" and "crying" are exactly the sound classes the long-term
ambition names, so reading them into context here would let that feature arrive quietly as a side
effect [@voice-audio-tags]. The ambition itself is the opposite of annotation-only — sound
classes like distressed shouting, breaking objects, or the acoustic pattern of purging could
inform the care the ward is owed, which is detection that changes when the Familiar acts on
safety, safety-critical by the same definition as the rest of this page [@future-features]. It
needs its own spec with evidence-informed thresholds and honest false-positive/false-negative
accounting before a single tag touches the caring spine, because both failure directions cost:
missing real distress, or reacting to a TV drama as if it were the ward's life
[@future-features]. The open ward decisions: build it at all, for which sound classes, and what a
firing tag should do — a gentle check-in, a note-to-self only, or escalation [@future-features].
Two mechanisms keep the shipped feature short of that ambition: the hard off-switch
`PROTO_FAMILIAR_AUDIO_TAGGING_DISABLED` (checked in `audioTaggingDisabled()`, which also honors
`PROTO_FAMILIAR_VOICE_DISABLED`) [@voice-tagging], and the classifier's human-vocal denylist
itself, which no ward setting can reach around [@voice-audio-tags] [@future-features].

## Related

- [Proactivity over caution](../decisions/proactivity-over-caution) — the incident and the
  rules it produced for every prompt in this chain.
- [Autonomous loops](autonomous-loops) — where silence-triage sits among the other background
  workers, and which loops defer to it under moderate+ threat.
- [Unruh](unruh) — where threat level is stored and how it interacts with the rest of the
  temporal model.
- [Vision and media input](vision-and-media) — where images are described and cached before
  threat scoring consumes their descriptions.
- [Voice](voice) — where room-sound tagging's shipped, annotation-only scope is built; this page
  covers why that scope stops short of the care-detection ambition and what a future ward-signed
  spec would need to decide.
