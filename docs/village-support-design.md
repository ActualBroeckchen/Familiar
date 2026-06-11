# Village Support — design

> Status: V1–V4 implemented (0.5.0-alpha). V5+ remain design-phase.
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
   entity-core / Unruh / Tome spine.
3. **Village actions** — asking a friend to check on the ward, passing
   messages between channels, and (later) taking real-world coordination
   like appointment-making off the ward's shoulders.

## Design values (inherited, non-negotiable)

- **The Familiar remains whole.** Gating limits *disclosure in a given
  room*, never selfhood. The canonical self in entity-core is always
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

### Registry storage — hybrid (entity-core canonical, local mirror for gating)

**Decided 2026-06-11.** The registry is canonical in entity-core (the
Village is part of the entity's world, and other embodiments should see
the same Village), with a local mirror (`village.json`, gitignored) that
is what Thalamus and Cerebellum actually read at runtime.

Why the mirror exists: **the gate must work when entity-core is down.**
If resolving "who may know what" required a live MCP round-trip, a
degraded peer would either break chat (violates graceful degradation)
or skip the gate (violates fail-closed). The mirror makes the gate a
local file read.

Sync contract:

- **Writes are write-through.** Every registry mutation goes to
  entity-core first (via thalamus.js wrappers — single enforcement
  point, as always), then to the mirror. If entity-core is down, the
  write lands in the mirror with a `syncPending` flag and is replayed
  on reconnect (same spirit as the outbox retry pattern).
- **Boot pulls.** On startup, Proto-Familiar fetches the canonical copy
  and overwrites the mirror if the canonical one is newer. Conflicts
  resolve canonical-wins (the mirror is a cache, not a fork).
- **Reads never touch MCP.** Gating reads the mirror, full stop. A
  stale mirror is acceptable (it's the ward's own recent edits at
  worst); an unavailable gate is not.
- Storage mechanism in entity-core: a custom identity file holding the
  registry JSON (written through `rewriteIdentitySection`/custom
  category) — exact shape to be finalized in V1 against entity-core's
  actual MCP surface.

What stays in entity-core *as knowledge* (unchanged): everything the
Familiar knows about these people — relationship history, memories,
graph nodes. The registry holds only routing + gating data: aliases,
category membership, grant sets. The two link by name/graph-node
reference, and the registry is the boring one.

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
      "rateLimit": { "perHour": 30 }                     // optional, enforced in code
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
  memorization/entity-core spine, so the Familiar's continuity covers
  all platforms. "You said you were going to sleep an hour ago — in the
  browser" works through existing RAG + the session-handoff machinery,
  with session location included in what gets memorized.
- **Near-realtime relay:** a `relay_message` tool lets the Familiar
  pass a message from one location to another ("tell Chen I'm running
  late"). Mechanically: tool call → outbox item targeted at a location →
  the location's adapter delivers. Gated: relaying *to* a villager is
  subject to the target audience's grants; the ward always sees the
  mirror.
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
| **V1** | Village registry: `village.js` module (local mirror + entity-core write-through sync + boot pull), `/api/village/*` CRUD, Village UI tab, built-in categories, trustedContacts migration | No behavior change yet — pure data layer + UI |
| **V2** | Session schema: location + participants fields, audience resolution module + tests, conversation-map (location→session), web-session audience selector ("Chen is sitting next to me") | Existing sessions untouched (absent fields = ward-private) |
| **V3** ✅ | Thalamus knowledge gate: `audience` option on enrich(), gate-before-fetch for every knowledge class, two-tier identity gating with section markers, ward-only blocks, heavy test coverage incl. fail-closed and intersection tests | Human sign-off obtained 2026-06-11; shipped 0.4.21-alpha |
| **V4** ✅ | Discord gateway adapter: bot connect/resume, router, DM policy, guild mention-reply, per-location sessions end-to-end | Shipped 0.5.0-alpha (the milestone landing — Village Support is live end-to-end) |
| **V5** | Per-location connections + rate limits | Small, additive |
| **V6** | Village actions: `relay_message`, check-on-ward requests outside triage, ward double-check flows for commitments | Touches outreach surface — sign-off rule applies |
| **V7** | Stranger data minimization (memorization profiles by audience) | Optional / flagged |

Suggested order rationale: V1–V3 build the safety floor before the
first external door opens in V4. Opening Discord before the gate exists
would mean every guild channel sees ward-private context — the one
sequencing mistake this design exists to prevent.

## Decisions (ward, 2026-06-11)

1. **Registry home: hybrid.** Canonical in entity-core, local mirror
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
   sessions they appear as inert HTML comments. No conflict with entity-core
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
6. **Memorization of Discord sessions is DEFERRED.** Sessions land in
   `logs/` (visible in the UI like any session) but are not enqueued
   for memorization yet: memories created without audience tags from a
   public room would enter the ward-private RAG pool and leak back out
   through any `memories: true` audience. Tagging-at-creation is the
   prerequisite (it also unlocks `memories: 'shared'`); that work is
   the natural V4.x follow-up.
7. **One location = one session**, rotated after 6h idle; the
   conversation map persists in `tomes/.discord-map.json`.
   Observability: `GET /api/discord/status` + the Settings panel
   status line.
