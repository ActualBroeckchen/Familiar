# Voice Pass 3 — Discord voice calls (build spec)

> Status: **planning**. Discord voice cannot be exercised in CI (no gateway, no
> voice UDP, no mic), so this doc is the reference the build is verified against
> — the same posture as Pass 2b. The engine is already tested; new transport
> code is unit-tested against fakes and verified live by the ward.

## 1. Goal

A live voice conversation in a Discord **voice channel**, reusing the Pass 2
call engine unchanged. Decisions the ward made for this pass:

- **Both join modes**, chosen per-location via a **call-mode dropdown** (the
  same location mechanic the presence modes use — strict/lurk/active).
- **The Familiar can join and leave a call itself.** "Hey, we're hanging out in
  #voice right now" in chat should make it join; it can also decide to leave.
- **Multi-speaker**: everyone in the channel is heard, per-speaker, through the
  existing Discord **audience gate**. **Threat scoring stays ward-only** — a
  villager's voice never moves the ward's tier (Pass 2 D2, already gated on
  `speakerRef === 'ward'`).

## 2. What is reused, untouched

The whole point of the `CallAdapter` contract (Pass 2b) was that a second
transport is a drop-in. Reused as-is:

- `call-engine.js` — per-speaker ASR streams (`streams: Map<speakerRef,…>`),
  `onTurn`, `finalizeUtterance`, the always-emit/asr-final path, threat scoring.
- The streaming-ASR worker (`asrStream` / `sendPcm` / `asrStreamStop`), TTS
  synth, `speakableText`.
- The proactive-during-a-call union point (noticing/triage/reminders spoken, not
  bannered — parent §7, spec §2.1). A Discord call registers on the same
  call-state file, so the ward-active gate and "speak, don't banner" already
  apply.

New code implements the transport **behind** the contract; it does not change
the engine.

## 3. New pieces

### 3.1 Dependencies (pure-JS / WASM only)

Declared in `package.json` → auto-installed by `ensure-node-deps.mjs` on start,
so the ward never runs `npm install`. **Prefer pure-JS/WASM to avoid a native
compiler** on the ward's machine (the reason `@discordjs/opus` / `sodium-native`
are rejected):

- `@discordjs/voice` (**≥0.19.2**) — the voice connection state machine +
  UDP/ICE + RTP. **Must be ≥0.19**: 0.18 uses an older voice gateway version with
  no DAVE support and can no longer complete the current Discord voice handshake
  (it stalls `connecting → signalling` and times out — the live-3a bug). 0.19.0
  moved to **voice gateway v8** + DAVE; 0.19.1 fixed simultaneous state
  transitions (the `connecting → connecting → signalling` symptom) and pins Davey.
- `opusscript` — pure-JS Opus encode/decode (slower than native, fine for one
  channel; `@discordjs/voice` picks it up automatically when native is absent).
  **Not needed for the connection handshake** — Opus only matters once audio
  flows, after Ready — so its absence never blocks a join.
- `@noble/ciphers` — pure-JS transport-packet encryption
  (`aead_xchacha20_poly1305_rtpsize`), the reliable primary. `libsodium-wrappers`
  stays as a WASM fallback but its ESM build is broken on current installs
  (Windows AND Linux), so `@discordjs/voice`'s loader skips it and lands on noble.
- `@snazzah/davey` — **DAVE end-to-end encryption**, now a hard dependency of
  `@discordjs/voice` because Discord is making DAVE required. It is a native
  (napi-rs) module, but ships **prebuilt platform binaries** (Windows/macOS/Linux
  × x64/arm64), so it installs **without a compiler** on the ward's machine —
  which is why it's an acceptable exception to the pure-JS rule (there is no
  pure-JS MLS/E2EE alternative, and DAVE is no longer optional). Pulled in
  transitively by `@discordjs/voice`; not listed in our own `dependencies`.

All degrade gracefully: if a required lib fails to load, `loadDiscordVoiceDeps`
returns null and the join reports `deps-unavailable` with an honest log, and
everything else keeps working (the no-module-may-break-the-chat-path rule).

### 3.2 Gateway voice bridge (`discord-gateway.js`)

The gateway is a **custom raw WebSocket**, not discord.js, so `@discordjs/voice`
is plugged in via its documented no-discord.js path — a
`DiscordGatewayAdapterCreator`:

- Add the **`GUILD_VOICE_STATES`** intent (bit 7) to `GATEWAY_INTENTS`.
- **Join/leave**: send the Voice State Update (`wsSend({ op: 4, d: { guild_id,
  channel_id, self_mute:false, self_deaf:false } })`); `channel_id: null`
  leaves.
- **Forward** the two dispatch events `@discordjs/voice` needs into its adapter:
  `VOICE_STATE_UPDATE` (our own session) and `VOICE_SERVER_UPDATE` (endpoint +
  token). Both are new cases in the dispatch switch; they call the adapter
  methods `@discordjs/voice` handed us at join time.
- One voice connection at a time (a single ward, a single Familiar embodiment).

### 3.3 The Discord call adapter (`voice-discord-adapter.js`)

Implements the `CallAdapter` contract (mirrors `voice-web-adapter.js`):

- `capabilities: { perSpeakerStreams: true, roster: true, ring: false }`.
- **`joinCall(channel)`** → `joinVoiceChannel({ channelId, guildId,
  adapterCreator })`, wait for `Ready`.
- **Receive (per speaker)**: on the receiver's `speaking` **start** for a user,
  `receiver.subscribe(userId, { end: manual })` → an Opus stream → decode to
  48 kHz stereo PCM → downmix + downsample to **16 kHz mono s16le** → the engine
  hook `pushAudio({ callId, speakerRef, pcm })`. `speakerRef` is a readable slug
  from the display name (`slug-ids.js`), with `ward` reserved for
  `discordWardUserId`. On the receiver's `speaking` **end** for that user →
  `endUtterance({ callId, speakerRef })`. **Discord's own speaking events are
  the utterance boundary** — no push-to-talk, no VAD guessing (cleaner than the
  web adapter).
- **Play**: the engine's reply PCM (24 kHz mono) → resample to 48 kHz →
  `createAudioResource` (raw s16le) → an `AudioPlayer` subscribed to the
  connection. `speak-start`/`speak-end` map to player `playing`/`idle`. Barge-in
  (2c) stops the player.
- **Roster**: `VOICE_STATE_UPDATE` join/leave in the channel → `rosterChanged`,
  so the engine/turn path knows who is present (feeds the audience set).
- `leaveCall()` → destroy the connection + send op 4 with `channel_id: null`.

### 3.4 The turn path is the DISCORD turn, not the web turn

The web adapter's `onTurn` runs a **ward-private** `/api/chat`. Discord voice is
multi-speaker, so its `onTurn` routes through the **existing Discord turn
machinery** (`discord-gateway.js` `handleTurn` + the V3 audience gate in
`audience.js` + `composeDiscordTools`), with:

- the **transcript** standing in for the inbound message,
- the speaker resolved to their **clearance** exactly as a text message would be
  (ward → full; registered villager → their granted subset; stranger → refused),
- the reply **spoken** through the adapter instead of `sendChannelMessage`
  (LLM-timestamp stripping still applies before TTS).

This keeps one audience/gate/tools story for Discord, spoken or typed. It is the
integration seam that needs the most care and its own tests.

### 3.5 Control surfaces (all required for it to be reachable)

- **Per-location call-mode dropdown** (Discord location settings UI, beside the
  presence-mode control): `off` (default — never joins) / `auto` (join when the
  ward enters a VC in this guild) / `summon` (join only on command or the
  Familiar's own decision). Stored per-location like `presenceMode`.
- **Familiar-facing tools** (`composeDiscordTools`, first-person descriptions —
  the entity acts as itself): `join_voice_call` (…"I use this to go join my
  human in a voice channel when they've asked me to hang out there") and
  `leave_voice_call`. So "we're in #voice" in chat → the Familiar reaches for
  `join_voice_call`. Discoverable AND operable: the channel id rides in on the
  roster / the message's mention, so the Familiar can name the argument (the
  every-capability-reachable rule).
- **Commands**: `!call` / `!join` in a text channel → join the caller's current
  VC; `!leave` → leave. A plain non-tool path for when the ward would rather
  type than talk.

> **Notepad — easier location setup (post-3, ward request).** Registering a
> Discord voice location today means hand-entering the `guild:…:channel:…`
> syntax in the Village modal, which is unintuitive. Better: when a location
> from a NEW Discord server first **knocks** and gets registered, also let the
> ward name the **server** (stored against its guild id). Then new locations are
> a dropdown — pick the server by name, then enter/pick the channel by name or
> id. Turns the raw-id syntax into two friendly pickers. Not blocking Pass 3;
> queued for a setup-UX pass afterwards.

### 3.6 Off-switches (graceful degradation, same commit as the feature)

- `PROTO_FAMILIAR_DISCORD_VOICE_DISABLED=1` — hard off.
- Per-location mode `off` — the soft default; nothing joins until the ward opts a
  location in.
- Any dep missing / any voice-connection failure → Discord voice unavailable,
  logged, everything else unaffected.

## 4. Slices

- **3a — transport spine.** Deps + gateway bridge + adapter join/leave + audio
  IN (a speaker's Opus → transcript logged) + audio OUT (a canned reply spoken).
  Proves the Discord voice protocol end to end with the least logic. Ward-tested
  live.
  - **Landed (transport core):** the deps (`@discordjs/voice`, `opusscript`,
    `libsodium-wrappers` — pure-JS/WASM); `voice-discord-adapter.js` (join/leave,
    per-speaker Opus decode → 16 kHz mono → `pushAudio`, speaking-end →
    `endUtterance`, roster, `playAudio` 24 kHz→48 kHz → `AudioResource(Raw)`,
    barge via `stopPlayback`) with pure resample helpers; the gateway bridge in
    `discord-gateway.js` (`GUILD_VOICE_STATES` intent, `discordVoiceAdapterCreator`,
    `VOICE_STATE_UPDATE`/`VOICE_SERVER_UPDATE` forwarding, `setVoiceRosterListener`).
    Unit-tested against a fake connection (`tests/voice-discord-adapter.test.mjs`).
  - **Landed (engine wiring + trigger):** `voice-discord-server.js`
    (`attachDiscordVoice`) owns a call engine, shares the web path's ASR/TTS
    workers (extracted into `voice-synthesize.js` — no copy-paste), registers the
    adapter per join, forwards the gateway roster, and guards one-call-at-a-time
    across BOTH transports via `isCallActiveFromFile`. Its `onTurn` is the canned
    3a acknowledgement (audio OUT proof). Off-switch
    `PROTO_FAMILIAR_DISCORD_VOICE_DISABLED=1`. Reachable via a ward-only
    `!call`/`!join` (join the ward's current VC, found from tracked
    `VOICE_STATE_UPDATE`s) and `!leave`, wired into the gateway's MESSAGE_CREATE
    ahead of any turn; `server.js` attaches it at boot and hands the controller to
    the gateway (`setDiscordVoiceController`). **3a is now ward-testable live.**
  - **Next:** ward tests 3a live, then 3b (the real Discord turn path through the
    audience gate — a ward-sign-off privacy path) and 3c (call-mode dropdown, the
    `join_voice_call`/`leave_voice_call` Familiar tools + natural-language join).
- **3b — multi-speaker + the Discord turn path.** Reply spoken with the
  clearance of everyone who can HEAR it, roster → audience set, threat scoring
  ward-only.
  - **⚠️ Correction (ward-signed): the WHOLE call gates to the room, NOT
    per-speaker.** The original 3b gated the ward's own voice turn to
    `ward-private` — but a voice call is a SHARED audio space, so that reply is
    spoken ALOUD to every villager in the channel: it leaked my human's private
    recall to whoever could hear. Fixed to match the TEXT model, where a shared
    guild channel is room-gated regardless of speaker (`audienceInputFor` returns
    ward-private only for the ward's own DM). Now every turn — ward or villager —
    resolves its audience from the live VC roster (`roomAudienceInput`, now also
    excluding the bot's own id): **ward alone in the channel → ward-private (like a
    ward DM); any villager present → the room's tag (the lowest clearance
    present).** ONE shared call history at the current clearance, RESET when the
    clearance changes (a roster change), so a more-private stretch never
    re-surfaces to a newcomer. WHO spoke still drives only attribution + the
    stranger fail-close + ward-only threat scoring — never what the reply may say.
    A non-ward speaker is transcribed but answered only if a registered villager;
    a stranger is fail-closed. The per-turn decision is a pure, injected function
    (`voice-call-audience.js` `resolveCallAudience`) so the safety cases are
    unit-tested (`voice-call-audience.test.mjs`, watched-fail): ward alone →
    ward-private, bot-not-a-listener, villager present → room tag, stranger →
    strangers ceiling, mid-call join → tag change (the history-reset signal).
  - **Landed (ward signed off, §5):** a REGISTERED VILLAGER's voice runs a turn
    gated to the ROOM's audience. `voice-discord-server` resolves the speaker slug
    → user id (`refToUser`, from the wrapped `nameForUser`) → villager
    (`findVillagerByAlias`); builds the audience input `{location, participants}`
    from the COMPLETE VC roster (`discordVoiceChannelMembers`, seeded from
    `GUILD_CREATE` voice_states so a silently-present villager still counts — an
    undercount would loosen the gate); and passes that object as `sessionAudience`
    to `/api/chat`, which scopes recall (`audiences`/`topicGrants` → enrich),
    withholds ward-private, and tags storage. Guarantees: the villager turn carries
    **no ward-private history** and its recall is audience-scoped, so it cannot
    leak my human's private content; memorization is split per audience tag
    (`memSessions`) so nothing stores above its clearance; a STRANGER
    (unregistered speaker) is transcribed but never answered/stored (fail-closed);
    threat scoring stays ward-only. The gated turn carries **no tools** (a villager
    can't drive tool writes by voice — the safe bound; text keeps its tool gate).
- **3c — control surfaces.** The per-location mode dropdown, the join/leave tools
  + natural-language join, the commands.
  - **Landed:** the `!call`/`!join`/`!leave` commands (3a) and the ward-only
    `join_voice_call`/`leave_voice_call` Familiar tools (`VOICE_CALL_TOOLS`,
    appended for the ward in `composeDiscordTools`, hard-switch-gated). The gateway
    injects `voiceJoin`/`voiceLeave` into the ward turn's tool ctx and resolves the
    target channel from the ward's current VC or a `<#id>` they mentioned, so the
    Familiar names no argument (every-capability-operable). Tested in
    `discord-tools.test.mjs`. So "come hang out in #voice" → she joins.
  - **Landed:** the per-location call-mode dropdown (`village.js` `callMode`:
    `off`/`summon`/`auto`, stored like `mode`; the Village location editor UI; both
    `/api/village/locations` endpoints). Default **summon** (not off) — the
    proactivity-sensitive part is auto-join, which stays opt-in; refusing an
    explicit `!call` because an unconfigured dropdown said off would just break the
    ward's own command. `off` fully disables (even `!call`/the tool, gated via
    `locationCallModeFor`); `auto` adds hands-free join when the ward ENTERS a VC
    (gateway `maybeAutoJoinVoice` off `VOICE_STATE_UPDATE`, ward-only, only on a
    real entry, never mid-call).
- **3d — group-call presence & speaker attribution (Pass 3 tail, ward-requested).**
  Before this, a group Discord call reached the Familiar (an LLM) as a flat wall of
  unattributed "user" turns tagged with raw snowflakes it can't tell apart, and
  nothing told it more than one person was present, who they were, or who
  joined/left. Three coordinated pieces close it:
  - **Real names.** `discord-gateway.js` now caches every user object it sees
    (GUILD_CREATE members + seeded `voice_states[].member`, and every
    `VOICE_STATE_UPDATE.member`) in `gw.userInfo`, and `nameForVoiceUser` resolves
    ward → configured name, else the cached Discord display name, else a short
    `guest-xxxxxx` — never the bare `user-<snowflake>` again. `discordVoiceDisplayName`
    exports the cached name; `villagerByAlias` (a pure split of `findVillagerByAlias`)
    lets the roster builder name many ids in ONE registry read (villager name wins).
  - **Attributed transcript.** In a **group** call (2+ humans), every turn — my
    human's included (ward decision: the LLM needs them distinguishable from a
    villager) — is prefixed with the speaker's name in both the live transcript and
    the stored call history. A **solo** call is byte-identical to before (no prefix).
    The MEMORY write is unchanged: it still takes the raw text with the speaker as
    its own field, not a prefix.
  - **Presence + greeting** (`voice-presence.js`, pure). A first-person "who's here /
    who came or went" note is surfaced once after each roster change (and at call
    start), then goes quiet — annotation only, exactly like the §8.4 room-sound note
    (never stored, never moves the threat tier, never touches the audience gate).
    And, opt-in-ON (`voiceProactiveGreetings`), a short **spoken hello** when a
    non-ward arrival joins: composed by a lean, **leak-free** LLM call (names only
    the arrival — no recall, safe to speak aloud at any clearance), spoken via the
    engine's existing `speakProactive`, which **rides the next silence gap** so it
    never talks over someone mid-sentence as the join lands (the ward's explicit
    ask). Deduped per stay, **stood down at moderate+ threat** (triage owns those
    moments), recorded into call history once spoken so it isn't repeated.
  - **Off-switches (same commit):** `PROTO_FAMILIAR_VOICE_PRESENCE_DISABLED=1`
    reverts the whole layer to the old unlabelled transcript;
    `PROTO_FAMILIAR_VOICE_GREETINGS_DISABLED=1` + the `voiceProactiveGreetings`
    toggle silence only the spoken hello (presence/labels stay). Tests:
    `voice-presence.test.mjs`, `villagerByAlias` in `village.test.mjs`.
  - **Not a ward-sign-off safety path:** the audience gate, threat scoring, and what
    is stored-per-clearance are all untouched — this only changes what the Familiar
    *reads* about who's in the room, plus one leak-free spoken greeting.
  - **opusscript shared-heap decode fix (0.11.10, live-testing — two Familiars in
    one call).** With a second speaker in the channel, the terminal flooded with
    `opus decode failed … memory access out of bounds` and one Familiar went
    silent. Root cause: `opusscript` keeps ONE emscripten WASM heap across every
    `OpusScript` instance and caches heap VIEWS (`inOpus`/`outPCM`) at construction.
    Allocating a new per-speaker decoder (a second speaker joining) can GROW that
    shared heap, which **detaches** the cached views of the decoders that already
    exist — so an existing speaker's decoder throws OOB on its very next packet
    (why the ward's own audio died the moment another speaker arrived). Fix in
    `voice-discord-adapter.js`: `decodeOpus` rebuilds the speaker's decoder on the
    CURRENT heap and retries the same packet once, so no audio is lost and the
    stream stays open; once the roster stops changing the heap stabilises and no
    more rebuilds happen. A genuinely undecodable packet fails the retry and is
    skipped (skip-warning rate-limited to one line per speaker), and packets larger
    than opusscript's `MAX_PACKET_SIZE` (3828 B) are dropped before they can
    overflow its input buffer. Other bots are heard normally — nothing is filtered
    out (two Familiars conversing by voice is a supported scenario). Tests in
    `voice-discord-adapter.test.mjs`.
- **Noise/silence polish (Pass 3, live-testing feedback).** Two engine options:
  `transcriptFilter` drops ambient-noise transcripts (traffic/fan the multilingual
  recogniser guessed as CJK — `isLikelyNoiseTranscript` in `voice-speech.js`, a
  non-CJK speaker's mostly-CJK result is noise), and `turnSettleMs` coalesces
  utterances within a pause into ONE turn so the Familiar doesn't answer over a
  longer thought (ward-tunable `voiceCallSettleMs`, default 1.5s; Discord always,
  web open-mic only — push-to-talk's release is the definitive end). A settle
  flush also waits for the mic to actually go quiet (`SETTLE_MIN_QUIET_MS`).

## 5. Ward sign-off items

- **The voice audience gate is a privacy path.** Who the Familiar hears,
  responds to, and stores per speaker mirrors the text audience gate; any change
  to when/whether a villager's voice is processed or a memory is formed from it
  needs ward sign-off, exactly like the text gate.
- **Threat scoring stays ward-only.** A villager's spoken words never move the
  ward's tier (Pass 2 D2). Do not extend threat scoring to villager voice
  without sign-off.

## 6. Testing

- Adapter unit tests against a **fake voice connection + fake gateway** (join,
  per-speaker subscribe → pushAudio, speaking-end → endUtterance, play → resource,
  roster → rosterChanged, leave/teardown). The seam discipline that let the web
  adapter be tested without a socket.
- At least one **pipeline** test: a fake speaker's PCM through the real engine +
  the Discord adapter (fake transport) → transcript → `onTurn` → spoken reply,
  including a villager whose clearance gates the turn.
- Everything mic/UDP/Opus-real is **ward-verified live** — noted in the PR, no
  pretending CI covered it.
