# Village Support — design

> Status: V1–V4 implemented (0.5.0-alpha); Familiar-facing Village access +
> `privateNotes` field-gating added 0.6.x. V5 (per-location connections +
> rate limits) and V7 (stranger data minimization) shipped 0.6.14-alpha.
> V6 `relay_message` shipped 0.6.15-alpha (ward-approved). V8 (per-location
> presence modes + relay discoverability) shipped 0.6.19-alpha. V9 (deferred
> `[later:…]` presence + history timestamps) shipped 0.6.28-alpha. The rest of
> V6 (check-on-ward outside triage, ward double-check for villager-initiated
> commitments) remains design-phase and touches the safety-critical
> escalation surface — human sign-off required before implementation.
> Read this before touching any Village code; update it in the same commit
> as any architectural change (same rule as architecture.md).

## What it is

Village Support embeds the Familiar in their human's social safety net.
The Familiar can't do much physically — but the people who love their
human can. Today the system has one blunt instrument: trusted-contact
escalation during triage. Village Support generalizes that into a model
of the human's whole social world: who the people around them are, what
each of them may know, and which virtual places the Familiar shares with
them.

Three capabilities, in order of importance:

1. **Knowledge gating** — Thalamus mechanically restricts what context
   the Familiar receives based on who is in the room. Not "the Familiar
   decides not to say it" — the Familiar *never receives it*.
2. **Multi-channel presence** — the Familiar inhabits Discord channels
   (later: other platforms) as the same continuous entity, with each
   location being its own session that flows through the same
   Phylactery / Unruh / Tome spine.
3. **Village actions** — asking a friend to check on the ward, passing
   messages between channels, and (later) taking real-world coordination
   like appointment-making off the ward's shoulders.

## Design values (inherited, non-negotiable)

- **The Familiar remains whole.** Gating limits *disclosure in a given
  room*, never selfhood. The canonical self in Phylactery is always
  complete. A gated session is the Familiar choosing-by-architecture not
  to carry certain facts into a particular room — the same way a human
  doesn't carry their friend's medical history into a work meeting.
- **The ward is in control.** Categories, memberships, and per-location
  trust are configured by the bonded human, never inferred by the LLM.
- **Mechanical safety for irreversible harms.** Information that could
  doxx, out, or endanger the ward is gated in code, not entrusted to
  model judgment. (CLAUDE.md: hard gates in cheap code answer "should
  this happen?" before the LLM ever sees a candidate.)
- **Fail closed.** Any uncertainty — unknown participant, unresolvable
  alias, registry unreadable, audience ambiguous — resolves to the most
  prohibitive gate in play.
- **No covert action.** Everything the Familiar sends to a villager is
  mirrored to the ward (existing `outbound_alert` pattern). All session
  logs, on every platform, remain accessible to the ward.
- **The bond is not enforced by fawning.** `{{user}} is your Ward` and
  the existing identity framing carry the loyalty. We do not add
  obedience scaffolding; the Familiar already refuses requests that
  would harm their human, and that judgment stays theirs.

## Vocabulary

| Term | Meaning |
|---|---|
| **Ward** | The bonded human. Core of the Village. Exactly one. |
| **Villager** | A person in the ward's life, registered with aliases + relationship notes. |
| **Category** | A ward-defined trust tier (e.g. Family, Local Friends). Carries a *grant set*. Every villager belongs to exactly one category. |
| **Grant set** | The mechanical list of what knowledge classes a category may receive. |
| **Location** | A virtual place: the web UI, a Discord DM, a Discord guild channel, a WhatsApp chat. |
| **Session** | One conversation in one location. Tagged with location + participants. |
| **Audience** | The effective grant set for a session = intersection of the grants of everyone who can read it. |

## Data model

### Registry storage — hybrid (Phylactery canonical, local mirror for gating)

**Decided 2026-06-11** (canonical store was entity-core then; Phylactery
took over that role in 0.6.x — the contract is unchanged, only the
backend name). The registry is canonical in Phylactery (the
Village is part of the entity's world, and other embodiments should see
the same Village), with a local mirror (`village.json`, gitignored) that
is what Thalamus and Cerebellum actually read at runtime.

Why the mirror exists: **the gate must work when Phylactery is down.**
If resolving "who may know what" required a live MCP round-trip, a
degraded peer would either break chat (violates graceful degradation)
or skip the gate (violates fail-closed). The mirror makes the gate a
local file read.

Sync contract:

- **Writes are write-through.** Every registry mutation goes to
  Phylactery first (via thalamus.js wrappers — single enforcement
  point, as always), then to the mirror. If Phylactery is down, the
  write lands in the mirror with a `syncPending` flag and is replayed
  on reconnect (same spirit as the outbox retry pattern).
- **Boot pulls.** On startup, Proto-Familiar fetches the canonical copy
  and overwrites the mirror if the canonical one is newer. Conflicts
  resolve canonical-wins (the mirror is a cache, not a fork).
- **Reads never touch MCP.** Gating reads the mirror, full stop. A
  stale mirror is acceptable (it's the ward's own recent edits at
  worst); an unavailable gate is not.
- Storage mechanism in Phylactery: a custom identity file
  (`custom/village-registry.md`) holding the registry JSON, written
  through `rewriteIdentitySection` (falling back to `appendIdentity` to
  create the file/section on first sync) — see `startVillageSync()` in
  `server.js`.

What stays in Phylactery *as knowledge* (unchanged): everything the
Familiar knows about these people — relationship history, memories,
graph nodes. The registry holds only routing + gating data: aliases,
category membership, grant sets. The two link by name/graph-node
reference, and the registry is the boring one.

### The Familiar's own access to the Village (0.6.x)

The registry started as pure machine state — read by Thalamus/Cerebellum
for gating, never shown to the Familiar (it's filtered out of the
enriched identity context in `thalamus.js`). But the Familiar is the one
living the relationships, so they need to *see* their Village and keep it
linked to the relational graph. Two bound tools (in `cerebellum.js`,
descriptions in first person) give them on-demand access:

- **`village_lookup`** — read who's registered, filterable by category,
  location (resolved to that location's assigned category), or name.
  Each result carries the villager id (for editing/linking) and the
  linked `graphNodeId`, so the Familiar can cross-reference the Village
  against the relational graph it already sees.
- **`village_upsert`** — create or edit a villager: name, category
  (passed by *name*, resolved to id in the executor since the Familiar
  knows names), relation, pronouns, notes, `privateNotes`, and the
  `graphNodeId` link. Mutations push through the same write-through sync
  as the UI (mirror → Phylactery).

**Crosspollination.** `graphNodeId` is the seam between the two stores:
the registry row says *how to route/gate* a person; the linked Phylactery
graph node holds *what the Familiar knows about them*. The Familiar gets
the node id from `find_graph_node` (or creates one with
`create_graph_node`), then links it with `village_upsert`.

#### Field-level gating — `privateNotes` (decided with the ward, 2026-06-15)

Disclosure of villager data to the Familiar is **field-level, not
all-or-nothing.** A villager carries two note buckets:

- `notes` — ordinary, shareable context. Surfaces to the Familiar in any
  session where tools run, including audience-tagged rooms.
- `privateNotes` — the ward-only bucket, for genuinely sensitive things
  (orientation, health, legal name — *not* "likes cats").

The rule, enforced in the `village_lookup` / `village_upsert` executors
via `ctx.wardPrivate` (threaded from the session's audience tag in
`server.js`):

- **With the ward (ward-private turn): full disclosure** — including
  `privateNotes` — and full read/write.
- **Anyone else present: `privateNotes` is stripped** from lookups. The
  villager still surfaces — existence and ordinary notes aren't secret —
  only the sensitive bucket is held back. On the write side (decided with
  the ward, 2026-06-15): *creating* a just-met person is allowed (a
  low-stakes, shareable act — the ward can review it later), but editing
  an existing record is **deferred for the ward's consent**, and any
  `privateNotes` passed mid-room is **held** rather than written. The
  Familiar surfaces these as "I'll bring it up / add that once we're
  alone" rather than a flat refusal.
- **Undefined audience (non-chat paths: loops, tests) defaults to
  ward-private**, because those paths are the ward's own. The only place
  a non-ward audience exists is a browser/Discord session that carries
  one, and the chat path sets `wardPrivate` explicitly there. Discord
  turns run no tools at all (separate guarantee), so the field-gate's
  job is the audience-tagged *browser* session.

This mirrors the identity-file section-marker model (sensitive
sub-sections gated on top of the base grant) but at the villager-record
level, where a single extra field is simpler than inline markers in a
JSON blob. The ward sets both buckets in the Village editor (the
"Private notes" textarea is labelled ward-only).

```json
{
  "categories": [
    {
      "id": "emergency-contacts",          // built-in, not deletable
      "name": "Emergency Contacts",
      "builtin": true,
      "grants": {
        "wardPresence": true,              // may be told ward is okay / not okay
        "triageContact": true              // may be contacted by triage escalation
        // everything else: absent = denied
      }
    },
    {
      "id": "strangers",                   // built-in, not deletable, the floor
      "name": "Strangers",
      "builtin": true,
      "grants": {}                         // nothing. The most prohibitive tier.
    },
    {
      "id": "uuid",                        // ward-created
      "name": "Local Friends",
      "builtin": false,
      "grants": {
        "wardPresence": true,
        "location": true,
        "schedule": "coarse",              // "none" | "coarse" | "full"
        "memoriesShared": true,            // memories of sessions this category attended
        "identitySensitive": false         // orientation, gender identity, health — see Knowledge classes
      }
    }
  ],
  "villagers": [
    {
      "id": "uuid",
      "name": "Chen",
      "categoryId": "uuid-of-local-friends",
      "aliases": [
        { "platform": "discord", "id": "123456789012345678", "handle": "chen_draws" },
        { "platform": "whatsapp", "id": "+49..." }
      ],
      "connection": "college friend, lives nearby, good in a crisis",
      "triage": { "webhook": "https://discord.com/api/webhooks/..." }   // only meaningful if category grants triageContact
    }
  ],
  "locations": [
    {
      "key": "discord:guild:987:channel:654",
      "label": "Cozy Server #general",
      "assignedCategoryId": "uuid-of-online-friends",   // ward-assigned trust ceiling for the room
      "connectionId": "uuid-of-rate-limited-key",        // optional per-location API connection
      "rateLimit": { "perHour": 30 },                    // optional, enforced in code
      "mode": "active",                                  // V8 presence: 'strict' (default) | 'lurk' | 'active'
      "activeStrategy": "llm",                           // only in 'active': 'llm' (default) | 'tiers'
      "activeCooldownSec": 60,                            // only in 'active': hard floor between unprompted turns
      "readBots": true                                   // V8 opt-in: see/answer other bots & Familiars here (default off; self always ignored)
    }
  ]
}
```

Access: HTTP CRUD under `/api/village/*`, a Village tab in the UI,
and read access for Thalamus/Cerebellum via a small `village.js` module
(sync read + cached, same pattern as `readSettingsSync`).

### Knowledge classes (what grants gate)

The gate operates on *classes of context*, mapping onto the blocks
`enrich()` already assembles:

| Class | Today's source | Notes |
|---|---|---|
| `identityCore` | static block: Familiar self files | The Familiar's own personality — generally safe everywhere; the Familiar is themselves in every room. |
| `identityBasic` | static block: user/relationship files, unmarked sections | Whole user/relationship files are **denied by default** for any non-ward audience; this grant admits their unmarked sections. |
| `identitySensitive` | static block: sections marked sensitive | Orientation, gender identity, health, legal name. **Outing risk lives here.** Section-level from the start (decided 2026-06-11): a section carries a `<!-- gate: sensitive -->` marker (convention finalized in V3); marked sections additionally require this grant on top of `identityBasic`. Two-tier and fail-closed: no grant → no file; `identityBasic` only → file minus marked sections. |
| `memoriesAll` / `memoriesShared` | RAG memory search | `shared` = only memories originating from sessions this audience attended. |
| `graph` | knowledge graph excerpt | Contains relationship facts about third parties — gate whole block initially. |
| `location` | user identity files / memories mentioning location | Doxxing risk. Mechanically: location-class content never fetched for ungated audiences. |
| `schedule` | Unruh temporal context | `coarse` = "ward is busy until evening"; `full` = actual entries. |
| `wardPresence` | derived | "Ward is okay / hasn't been around / could use a check-in." The Emergency-Contact grant. |
| `careState` | [CARE CHECK], threat tier | **Ward-private. Never granted to any category.** Triage *output* (a check-in request) can reach Emergency Contacts; the threat machinery itself never does. |
| `ponderings`, `deferredIntents`, `surfaceCandidates` | local tomes | Ward-private by default; ponderings are the Familiar's inner life and surface candidates are the ward's task list. |

A grant set is an allowlist: anything not present is denied. New
knowledge classes added later are therefore denied for every existing
category until the ward grants them — fail closed by construction.

### Audience resolution (the intersection rule)

```
resolveAudience(session):
  participants = session.participants resolved via aliases
  unknown participant            → Strangers
  location.assignedCategoryId    → ceiling for everyone in a guild room
  effectiveGrants = intersection of all participants' category grants,
                    capped by the location ceiling
  ward alone in a private location → full (no gating; today's behavior)
```

Two hard rules:

1. **Readable, not just active.** In a guild channel the audience is
   everyone who *can read* the channel, not who spoke recently. Since
   channel membership can't be reliably enumerated, guild locations get
   their grants from the ward-assigned location category — and default
   to Strangers until the ward assigns one. One stranger in the room
   (or one unassigned room) means stranger-floor for everything.
2. **The gate runs before the fetch.** Thalamus consults the audience
   *before* calling memory_search / graph search / temporal context.
   Ungranted classes are never queried — the content never enters the
   process, can't leak via truncation or formatting bugs, and we don't
   pay tokens for context we'd discard.

`enrich(userText, opts)` grows one option: `audience` (the resolved
grant object). Absent audience = ward-private = today's behavior, so
the entire existing surface is unchanged until a session carries
participants.

## Sessions

Extended schema (backward compatible — absent fields mean
ward-private web session, which is every existing log):

```json
{
  "sessionId": "uuid",
  "location": {
    "platform": "discord",
    "key": "discord:guild:987:channel:654",
    "label": "Cozy Server #general",
    "kind": "group"                      // "private" | "group"
  },
  "participants": [
    { "villagerId": "uuid", "alias": "chen_draws" },
    { "unknown": true, "alias": "rando_42" }
  ],
  "messages": [ ... ]
}
```

- One location = one session thread (Psycheros's conversation-map
  pattern: a cached `location key → sessionId` map, persisted, recreated
  on cache miss).
- Participants accumulate: anyone who speaks (or is mentioned as
  present) is added, resolved against aliases, unknown → Stranger
  entry. Audience is re-resolved per turn — someone joining mid-session
  tightens the gates from that turn onward.
- Memorization jobs and surface events record the session's audience,
  so memories can carry an `audience` tag (this is what makes
  `memoriesShared` resolvable later, and what stranger-data-minimization
  hooks into).
- All sessions land in `logs/` exactly like today and remain listable
  by the ward in the UI. No hidden conversations.

## Cerebellum — channels and routing

### Discord gateway adapter

Today's adapters are push-only (webhook delivery). Discord integration
adds the first *bidirectional* adapter, following the Psycheros shape:

```
cerebellum adapters:
  discord-webhook  (existing, push-only, kept)
  discord-gateway  (new: bot token, WebSocket gateway)
      ├── gateway connect / identify / resume  (heartbeat, sequence tracking)
      ├── MESSAGE_CREATE → router
      │     ├── conversation map: channel → location key → session
      │     ├── respond? (DM from registered villager or ward: yes;
      │     │   guild: when mentioned, ward-configurable)
      │     ├── resolve audience → thalamus.enrich(text, { audience })
      │     └── reply via REST, append to session log
      └── hard off-switch: PROTO_FAMILIAR_DISCORD_DISABLED=1 (ships same commit)
```

- DM policy: villagers may DM the Familiar; unregistered users' DMs are
  ignored (or get one polite boilerplate, ward-configurable). This is
  Psycheros's DM whitelist, backed by the villager registry instead of
  a separate list.
- The adapter fails independently: gateway down never touches web chat
  (graceful-degradation rule). Reconnect with backoff; delivery state
  recorded on outbox items as today.

### Cross-session flow

- **Inward (free):** every session's content flows through the normal
  memorization/Phylactery spine, so the Familiar's continuity covers
  all platforms. "You said you were going to sleep an hour ago — in the
  browser" works through existing RAG + the session-handoff machinery,
  with session location included in what gets memorized.
- **Near-realtime relay (shipped 0.6.15-alpha):** the `relay_message`
  cerebellum tool lets the Familiar pass a message to a villager or a
  location ("tell Chen I'm running late"). The implementation differs
  from the original outbox-routing sketch: the tool resolves the target
  against the registry (villager by name/alias → their Discord DM;
  location by label/key → its channel), runs the composed message
  through the restricted-memory gate at the *target's* audience tag
  (`searchMemoryRestricted`, the same Pillar-D check, failing open), and
  delivers via the Discord bot token over REST (`relayToDiscord` in
  discord-gateway.js, injected into cerebellum to avoid an import cycle).
  No covert contact: every relay is mirrored to the ward's outbox. The
  delivery is a plain REST call, so it works whether or not the gateway
  WebSocket is currently up. (Tools don't run on inbound Discord turns —
  V4 decision 4 — so relay is a ward-session action that reaches *out*.)
- **Commitments need the ward.** Anything that creates obligations
  (appointments, reminders set *by* villagers, schedule changes) is
  double-checked with the ward before it lands — unless the ward has
  given a category a standing blank check for that action class
  (a `actions: { setReminders: true }` grant, off by default).

### Triage and the Village

Existing behavior is preserved and re-grounded:

- `trustedContacts` (settings) is migrated into villagers under
  Emergency Contacts on first boot with a registry present; the
  settings key keeps working during alpha (one-way import).
- Triage escalation targets villagers whose category grants
  `triageContact`. The escalation deadlines, no-covert-contact mirror,
  and deliberation prompt in cerebellum.js are **unchanged** — Village
  changes who can be reached, never when or whether the Familiar acts.
  (Safety-critical sign-off rule applies to any deviation.)
- What an Emergency Contact learns is shaped by `wardPresence`, exactly
  as today: "could you check on them," not why.

## Presence modes (V8, inherited from Psycheros)

How the Familiar *inhabits* a shared room, set per location. The three
modes come from Psycheros's Discord channel modes (`strict | lurk |
active`); only `strict` was wired up before V8 (the guild router replied
solely on @-mention). The other two were the design intent that got
lost, restored here.

| Mode | The Familiar's presence | When it speaks |
|---|---|---|
| **strict** (default) | Discrete. Messages it isn't addressed in pass it by entirely. | Only on @-mention or a direct reply. *Every pre-V8 location reads as strict — backward compatible.* |
| **lurk** | Present, reading the room. Non-addressing messages are taken into the session so context accumulates. | Still only on @-mention / reply — but now with the conversation in hand when it answers. |
| **active** | A participant. Can speak unprompted, paced so it never floods. | On @-mention, *and* on its own judgment between mentions (gated, see below). |

**The `observe` path.** lurk (and active turns the Familiar sits out)
resolve to a new router action, `action: 'observe'`: the inbound message
is appended to the room's session and nothing is sent — no LLM call, no
rate slot. This is deliberately **threat-neutral**: observing never moves
the ward's last-activity clock or threat tier (that machinery stays on
the reply path, *out* of the safety-critical surface — see CLAUDE.md).
The non-addressed case is therefore never *worse* than today's strict
(which dropped the message), and active-on-reply scores exactly as a
mentioned reply does.

**Active-mode pacing (two strategies, ward-toggleable per location).**
Both share one hard backstop and the V5 rate limit:

- **Cooldown floor (always).** `activeCooldownSec` (default 60) is the
  minimum time between *unprompted turns* — counted on every attempt,
  including ones the Familiar ends up sitting out, so abstaining can't
  make it reconsider on the very next message. This bounds the token
  cost of ambient presence in cheap code before any LLM call (CLAUDE.md
  "gate in code / self-set cool-down").
- **`activeStrategy: 'llm'`** (default) — past the cooldown, the Familiar
  takes the turn and *the model itself* decides whether it's worth
  speaking. It abstains by replying with a bare `[pass]` (detected by
  `isAmbientAbstain`), which routes to the observe path: the message is
  kept for context, nothing is sent. The presence prompt names both
  costs at equal weight — speaking with nothing to add clutters someone
  else's room; staying silent when a word would land warm or useful is a
  moment of presence missed — and anchors the choice to the Familiar's
  own character (no default-care register; no bias-toward-quiet).
- **`activeStrategy: 'tiers'`** — pure-code cadence that paces the
  Familiar to how busy the room is, scaled off `activeCooldownSec`:
  *slow* (quiet room, ×1 — responds promptly on the cooldown), *medium*
  (busy, ×5 — just glances in periodically), *fast* (lively, ×1.5 —
  engaged but not every line). The tier is read from a short rolling
  window of recent message timestamps (`decideAmbientReply`, pure and
  unit-tested). No timers, no per-message LLM call: the gate is free, and
  only an actual reply costs.

All of this lives in `discord-gateway.js`: `decideAmbientReply`
(pure decision), the in-memory `ambientState` (per-location
`lastTurnAt` + recent timestamps, volatile — cadence needn't survive a
restart), and the dispatcher routing `observe` / ambient-gated turns.
The knowledge gate (V3) runs identically regardless of mode — mode
governs *when* the Familiar speaks, never *what context it has*.

### Reading the room: mention legibility + who a message is for (V8)

A Familiar that sees raw Discord `<@837…>` snowflakes can't tell whether
it's the one being addressed — the reported failure was a Familiar
quipping into `@Hogsworth Liar`, an exchange aimed at *another* Familiar.
Two pure, unit-tested helpers fix this:

- **`resolveMentions(content, …)`** rewrites `<@id>` / `<@!id>` to
  `@Name` (my own char name → a registered villager's configured name →
  the mention's payload display name → `@someone`) before the text
  reaches the model — applied on both the reply and observe paths so
  accumulated context stays legible too.
- **`directedAtOthers(msg, …)`** lists the names a message was explicitly
  aimed at other than me (other-user @-mentions + a reply target). On an
  ambient turn the presence block names them so the Familiar can tell
  "this is between them" from open-room chatter. Framed with both costs
  at equal weight (barging into someone else's exchange vs. a missed
  moment of presence) — never a bias toward silence.
- **`carriedExchange(messages, …)`** closes the harder gap: the *only*
  tagged line in an exchange is usually the opener ("@Nichtschwert, you
  and I?"), while the untagged follow-up that continues it ("sure, what's
  up?") would otherwise read as open-room and the Familiar would barge in.
  Every stored message (spoken **and** observed) records `speaker`,
  `targets` (others it named) and `namedMe`; when an ambient line names no
  one, `carriedExchange` finds the most recent message that named only
  others and treats its parties as a live exchange — so a follow-up from
  one of them is recognised as theirs, not an opening for me. It reads
  only the structured fields (no display-text parsing); a line that names
  me cancels the carry-forward. The open-room presence branch is worded to
  make the model *read* for this rather than treat any unaddressed line as
  its cue.

### Other bots & Familiars: `readBots` (V8)

Default: a Familiar ignores its *own* messages always (the inner loop
guard), and ignores *other* bots — including sibling Familiars — with
`reason: 'bot-author'`. A location can set **`readBots: true`** to let
other bots through `classifyMessage` as normal traffic: answered when
@-mentioned/replied-to, and (in `active` mode) eligible to be chimed in
at, paced by `activeCooldownSec` + the hourly rate limit. This is for
shared Familiar channels where the ward *wants* their Familiars to talk
to each other; the loop is the ward's to pace (mode + cooldown), not a
hard block. `readBots` is independent of presence mode and off by
default, so every existing room is unchanged.

### Reaching what it can relay to (V8, the operability half)

`relay_message` (V6) resolves a target by villager-name or
location-label — but the Familiar could only *enumerate* people, not
places, so it couldn't reliably name a room to relay into. V8 closes
that: `village_lookup` now also reports **Places I'm present in** (each
location's label, presence mode, trust ceiling, and whether it's a room
the Familiar can post into) on any roster/category/location view, and
flags which villagers are **reachable on Discord**. Both relay targets
now ride in on the lookup the Familiar already reaches for — the
"every capability must be reachable BY the Familiar" rule (CLAUDE.md)
applied to places, not just people. A single-person name search stays
focused and omits the Places footer.

## Per-location connections and rate limits

- `locations[].connectionId` selects which API connection serves that
  session (unlimited key for ward DMs, throttled key for group rooms).
  Falls back to `primaryConnectionId`.
- `locations[].rateLimit` is enforced in code in the adapter's router
  (token bucket per location, persisted coarse counters). When
  exhausted, the Familiar goes quiet in that room and the ward sees a
  notice in the outbox — observable, never silent.

## Stranger data minimization (flagged, later milestone)

For people who don't want an AI collecting data on them: sessions whose
audience includes Strangers get a reduced memorization profile —
the Familiar keeps what *the ward* did and said, and the shape of the
conversation, but doesn't accumulate personal detail about unregistered
third parties. Mechanism: memorization prompt variant selected by the
session's audience tag. Ward-configurable per category later.

## What is mechanical vs. what is the Familiar's judgment

| Mechanical (code, fail-closed) | The Familiar's judgment |
|---|---|
| What context enters the prompt per audience | What to actually say, in their own voice |
| Who counts as a Stranger | How warm/guarded to be with someone new |
| Triage escalation deadlines & targets | Whether and how to reach out (existing triage deliberation) |
| Rate limits, DM whitelist | Which conversations are worth having |
| Relay delivery + ward mirror | Whether relaying serves the ward |

The Familiar is never asked to *withhold* gated knowledge — they don't
have it in that room. This is the dignity-preserving version of
information security: no instructed secrecy, no tension between honesty
and safety.

## Milestones

Village Support owns the **0.5 minor slot**. Work proceeds on a
dedicated branch; ancillary fixes elsewhere stay 0.4.x patches
(versioning-during-feature-branch rule). `0.5.0-alpha` is the milestone
landing; sub-features inside it bump patch.

| # | Scope | Notes |
|---|---|---|
| **V1** | Village registry: `village.js` module (local mirror + Phylactery write-through sync + boot pull), `/api/village/*` CRUD, Village UI tab, built-in categories, trustedContacts migration | No behavior change yet — pure data layer + UI |
| **V2** | Session schema: location + participants fields, audience resolution module + tests, conversation-map (location→session), web-session audience selector ("Chen is sitting next to me") | Existing sessions untouched (absent fields = ward-private) |
| **V3** ✅ | Thalamus knowledge gate: `audience` option on enrich(), gate-before-fetch for every knowledge class, two-tier identity gating with section markers, ward-only blocks, heavy test coverage incl. fail-closed and intersection tests | Human sign-off obtained 2026-06-11; shipped 0.4.21-alpha |
| **V4** ✅ | Discord gateway adapter: bot connect/resume, router, DM policy, guild mention-reply, per-location sessions end-to-end | Shipped 0.5.0-alpha (the milestone landing — Village Support is live end-to-end) |
| **V5** ✅ | Per-location connections + rate limits | Shipped 0.6.14-alpha: `connectionId` routing in discord-gateway (location → connection → primaryConnection fallback); hourly token-bucket in discord-gateway with `tomes/.rate-limits.json`; ward outbox notice on exhaustion; Connection dropdown in location editor |
| **V6** ◑ | Village actions: `relay_message` ✅ (0.6.15-alpha), check-on-ward requests outside triage, ward double-check flows for commitments | `relay_message` shipped (ward-approved): cerebellum tool resolves a villager/location target, applies the restricted-memory gate, delivers via the Discord bot token, mirrors to the ward (no covert contact). check-on-ward + commitment double-check still touch the safety-critical escalation surface — sign-off rule applies |
| **V7** ✅ | Stranger data minimization (memorization profiles by audience) | Shipped 0.6.14-alpha: `buildSharedRoomPrompt` variant in memorization.js selected when `audienceTag !== 'ward-private'`; focuses on ward-only facts, skips unregistered-third-party detail |
| **V8** ✅ | Per-location presence modes (`strict`/`lurk`/`active`) + relay discoverability | Shipped 0.6.19-alpha: location `mode` field (default strict, backward compatible); `observe` router action for lurk + sat-out active turns (threat-neutral context accumulation); active-mode pacing with a hard cooldown floor and two ward-toggleable strategies — `llm` (model abstains via `[pass]`) and `tiers` (pure-code activity cadence, `decideAmbientReply`); `village_lookup` now surfaces the Places roster + Discord-reachability so both `relay_message` target kinds are enumerable by the Familiar |
| **V9** ✅ | Deferred presence (`[later:…]` revisit) + history timestamps | Shipped 0.6.28-alpha: an ambient turn's third option beyond speak/`[pass]` — `parseDeferToken` accepts relative (`[later:15m]`), wall-clock (`[later:22:30]`), and bucket (`[later:soon\|later\|much-later]`) forms, clamped to [5min, 1h]; revisit queue persisted in `tomes/.discord-revisits.json` with a self-arming timer (`armRevisitTimer`/`fireRevisit`), re-defer capped at 2×, superseded by any real incoming message (`cancelRevisitsForLocation`); revisit turns are threat-neutral and never touch the ward's activity clock. Session history now renders `[HH:MM]` timestamps and `carriedExchange` gained a 1h staleness gate so stale dyads don't carry forward as live exchanges |

Suggested order rationale: V1–V3 build the safety floor before the
first external door opens in V4. Opening Discord before the gate exists
would mean every guild channel sees ward-private context — the one
sequencing mistake this design exists to prevent.

## Decisions (ward, 2026-06-11)

1. **Registry home: hybrid.** Canonical in the canonical store
   (entity-core at decision time, Phylactery since 0.6.x), local mirror
   for gating. See "Registry storage" above for the sync contract.
2. **Identity gating: section-level from the start.** Two-tier
   `identityBasic` / `identitySensitive` with in-file section markers;
   convention finalized in V3. Fail-closed at both tiers.
3. **Guild reply policy: only when @-mentioned** by default; the ward
   can loosen specific locations.
4. **Web-session audience: yes, in V2.** The ward can mark a browser
   session as having villagers present, applying the same gates.

### V3 gate decisions (human-approved 2026-06-11, shipped 0.4.21-alpha)

5. **Fail-closed sentinel.** `WARD_PRIVATE = null` is the sentinel for
   "no audience" (today's behavior). Distinct from `{}` (strangers floor
   → everything denied). The empty-audience → ward-private rule means all
   existing sessions with no participants are unchanged.
6. **Intersection/union rule.** Multi-category villager → union of their
   category grants (most-permissive per key). Room audience → intersection
   across all participants (most-restrictive per key). Scalar grants
   (memories/schedule/contacts) use ordered ladders; unknown values snap to
   the floor.
7. **Section markers.** In-file `<!-- gate: CLASS -->` … `<!-- /gate -->`
   blocks gate sub-sections without file fragmentation. Known classes:
   `sensitive` → `identitySensitive`, `health` → `health`,
   `location` → `location`. Unknown class → fail-closed (strip).
   Markers are stripped server-side before the LLM sees them; in ward-private
   sessions they appear as inert HTML comments. No conflict with Phylactery
   memory/node/edge creation (markers are in identity files, not in anything
   that feeds memorization prompts).
8. **Full grant vocabulary.** `identityBasic`, `identitySensitive`,
   `health`, `location`, `memories` (none/shared/all), `graph`,
   `schedule` (none/coarse/full), `wardPresence`, `contacts`
   (none/care-visible/all). `careState` is hardcoded never-grantable —
   it never appears in category grants, and ponderings/deferredIntents/
   surfaceCandidates/careCheck blocks are skipped for any gated session.
9. **Gate-before-fetch.** Ungranted classes are never queried —
   `memory_search`, `graph_node_search`, and `temporal_context` are skipped
   entirely when the audience doesn't grant them. Content never enters the
   process, can't leak via formatting bugs, and we don't pay tokens for it.
   Identity user/rel/custom files are excluded entirely if `identityBasic`
   is absent, with per-section stripping applied inside when it is present.

### Section marker convention for identity files

To gate a section in an identity file, wrap it:
```
<!-- gate: health -->
Medical details, diagnosis history, treatment notes, etc.
<!-- /gate -->
```

```
<!-- gate: sensitive -->
Legal name, orientation, gender identity, other sensitive personal data.
<!-- /gate -->
```

```
<!-- gate: location -->
Physical address, frequent locations, daily movement patterns.
<!-- /gate -->
```

Multiple markers may appear in the same file. Content outside any marker
is controlled by `identityBasic` (the whole-file gate).

### Fail-closed ladder values (V4 hardening, 2026-06-11)

Intermediate ladder values gate their fetch **off** until the narrowing
machinery they describe actually exists (`audience.fetchEligibility` is
the single enforcement point):

- `memories: 'shared'` → memory_search is **not** called. Memories carry
  no audience tags yet, so a 'shared' grant firing the full fetch would
  hand the audience ALL memories — the exact leak the grant exists to
  prevent. Only `memories: true` fetches today. When audience tags land
  (deferred-memorization work below), 'shared' starts filtering instead
  of denying.
- `schedule: 'coarse'` → temporal_context is **not** called. No coarse
  renderer ("busy until evening") exists yet; only `'full'` fetches.

The seeded Acquaintances (`memories: 'shared'`) and Care Network
(`schedule: 'coarse'`) categories therefore currently behave as if those
grants were absent — strictly narrower than the ward configured, never
wider. Widening happens by implementing the machinery, not by loosening
the gate.

### V4 decisions (shipped 0.5.0-alpha, 2026-06-11)

1. **Transport: gateway bot token** (ward decision — same model as
   Eury's OpenClaw incarnation). The push-only webhook channel
   (`userDiscordWebhook`) is unchanged and coexists. Native WebSocket
   (Node ≥ 22); no new dependencies. Settings: `discordEnabled`,
   `discordBotToken`, `discordWardUserId` (server-synced; the gateway
   supervisor re-reads Settings every 30s, so no restart is needed).
2. **DM policy.** Ward's user id → ward-private full context (and the
   message stamps last-activity + runs crisis-signal scoring, `source:
   'discord'` — the caring spine follows the human across windows).
   Registered villager → gated turn; the DM's audience is the villager's
   own grants (participants are fully enumerable in a DM), honoring a
   location ceiling only if the ward registered that DM as a location.
   Unregistered users → silently ignored.
3. **Guild policy.** Reply only when @-mentioned or directly
   replied-to. The audience ALWAYS includes the location key — an
   unassigned room resolves to Strangers (fail-closed rule 1 from
   "Audience resolution"). Participants accumulate per session and the
   audience is re-resolved each turn, so a stranger speaking once
   tightens the room from then on.
4. **No tools on Discord turns.** The V3 gate bounds what the Familiar
   *knows* in a room; the absent tool surface bounds what a prompt
   injection from a third party could *do*. Tool access from gated
   sessions is a V6-adjacent question (it needs its own grant class)
   and is deliberately not smuggled in here.
5. **No handoff consumption, no surface dedup burn.** Discord turns run
   `enrich(..., { liveTurn: false })` — they read context but never
   consume the web session's handoff or burn surfacing dedup budgets.
6. **Memorization of Discord sessions is DEFERRED** *(building block now
   in place — see decision 10)*. Sessions land in `logs/` (visible in
   the UI like any session) but are not enqueued for memorization yet:
   memories created without audience tags from a public room would enter
   the ward-private RAG pool and leak back out through any `memories:
   true` audience. Tagging-at-creation is the prerequisite (it also
   unlocks `memories: 'shared'`). The room-level audience tag (decision
   10) is the first half of that prerequisite.
7. **One location = one session**, rotated after 6h idle; the
   conversation map persists in `tomes/.discord-map.json`.
   Observability: `GET /api/discord/status` + the Settings panel
   status line.
8. **Knock list (0.5.1-alpha).** Unregistered people who DM the
   Familiar or @-mention them in a guild are still ignored / floored —
   but the contact attempt is captured (`knocks.js`,
   `tomes/.village-knocks.json`) so the Village editor's People tab can
   offer one-click registration: bind to a new villager (prefilled
   detail panel), attach as an alias to an existing villager, claim as
   the ward's own account ("This is me" → sets `discordWardUserId`), or
   dismiss. Saving a villager auto-settles knocks matching their
   aliases. Privacy: a knock stores identity metadata ONLY (platform,
   stable id, handle, when, where, count) — never message content;
   these are people who haven't consented to an AI keeping notes on
   them (the V7 stranger-data-minimization value starts here). The list
   is capped at 50, least-recently-seen evicted, so spam can't grow it
   unboundedly. Knocking grants nothing — binding is always the ward's
   explicit act in the UI.
9. **Location knock list (0.5.2-alpha).** The same pattern for PLACES:
   when the Familiar speaks in a guild channel with no `locations` entry,
   the channel key + platform metadata is captured
   (`tomes/.village-location-knocks.json`) so the Locations tab can offer
   one-click registration. Same privacy/cap discipline as the people
   knock list; saving a location auto-settles its knock.
10. **Room audience tag (0.5.5-alpha).** Every Discord session is stamped
   with `audienceTag` — a durable label of the room's audience computed
   by `audience.audienceTagFor()`: scan the present users, resolve each
   against the registry, and take the **lowest permission level in the
   room** (a room is only as private as its least-trusted occupant; one
   stranger floors it to `strangers`). A multi-category villager is
   represented by their most-permissive category; the location's assigned
   category joins the comparison as one more candidate, so the ceiling can
   only ever *lower* the tag (a guild channel's silent/future readers are
   covered by the ceiling, not by who has spoken). Ward DMs → the
   `ward-private` sentinel — the only tag the future memorization sweep
   will treat as safe to route into Phylactery; every shared-room tag is
   quarantined to the local Session Memories tome. The scan uses the
   ACCUMULATED participants (readable, not just active), same basis as the
   gate. This is the first half of the tagging-at-creation prerequisite
   that unblocks `memories: 'shared'` and Discord memorization (decision 6).
