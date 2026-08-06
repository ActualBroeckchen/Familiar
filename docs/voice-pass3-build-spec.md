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
so the ward never runs `npm install`. **Pure-JS/WASM to avoid a native
compiler** on the ward's machine (the reason `@discordjs/opus` / `sodium-native`
are rejected):

- `@discordjs/voice` — the voice connection state machine + UDP/ICE + RTP.
- `opusscript` — pure-JS Opus encode/decode (slower than native, fine for one
  channel; `@discordjs/voice` picks it up automatically when native is absent).
- `libsodium-wrappers` — WASM xsalsa20/aead for voice packet encryption.

All three degrade gracefully: if any fail to install, Discord voice is
unavailable with a loud, honest log, and everything else keeps working
(the no-module-may-break-the-chat-path rule).

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
- **3b — multi-speaker + the Discord turn path.** Per-speaker audience
  resolution, reply spoken with the speaker's clearance, roster → audience set,
  threat scoring ward-only.
- **3c — control surfaces.** The per-location mode dropdown, the join/leave tools
  + natural-language join, the commands.

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
