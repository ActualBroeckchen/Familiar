# Voice — sherpa-onnx build spec

**What this builds:** I can hold a live spoken conversation — my human talks,
I hear them, I answer in my own voice, with latency low enough to feel like
company rather than dictation. Group calls on Discord work from day one; the
call machinery is platform-neutral so Telegram / TeamSpeak / Mumble / WhatsApp
later mean writing an adapter, not a system. And critically: a live call must
not starve the rest of me — Phylactery, Unruh, the Village, and Tomes keep
answering while I talk (§4 is the compute contract that guarantees it).

All speech processing is **local** via [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
(CPU, ONNX Runtime, no cloud STT/TTS): my human's voice never leaves the
machine; only the *transcript* rides the existing LLM request like any typed
message.

**Assumes the vision build spec is implemented** (`docs/vision-build-spec.md`):
the media store (`media.js`, content-addressed assets with `kind`), the
materializer seam (`vision.js`), the describe-once-cache-forever pattern, and
the stand-in discipline are all inherited here, not rebuilt.

Status: **shipped (0.10.x → 0.11.x; see the pass ledger at the end).** Voice owns its own MINOR milestone (one
milestone = one minor; the first landed pass is the `0.X.0`, later passes bump
patch).

> **Spec review note (re-verified against 0.9.30, 2026-07-24).** The seams this
> spec rides were checked against the current tree before any pass starts. Most
> are accurate and named correctly (`registerPushAdapterFactory`,
> `connectionForFeature`, `decideAmbientReply`/`adaptiveSettleMs`/
> `activeCooldownSec`, `contactDeadlineFor`/`CONTACT_ESCALATION_DELAY_MS`,
> `recordThreat({source})`, `recordUserActivity`, the room-legibility fields,
> `materializeAttachments`, `SERVER_SYNCED_KEYS`, `message-sanitize.mjs`,
> `wsSend`). Four drift points were corrected in this pass: **(1)** `kind:'audio'`
> is not actually reserved — the media store hard-codes `kind:'image'` and its
> mime map is image-only, so the audio-kind support is net-new Pass-1 work, not
> inherited (§0.2 rewritten); **(2)** the §4.3 defer list named `routine review`
> (not a ticking loop — pure ride-existing functions) and omitted the
> `content-regate` loop that shipped 0.9.30 (list refreshed); **(3)** §5 implied
> the hand-rolled gateway already forwards `VOICE_STATE_UPDATE`/
> `VOICE_SERVER_UPDATE` — it has op-4 *send* (`wsSend`) but no inbound voice
> dispatch cases, so those are Pass-3 additions (§5 clarified); **(4)** the
> background-worker count (CLAUDE.md) is twelve at spec time and becomes thirteen
> when media-retention lands (pinned to Pass 4, §13).

---

## 0. What this builds on

### 0.1 sherpa-onnx — the engines we use (and the ones we don't, yet)

One toolkit, one native Node binding (`sherpa-onnx-node`, prebuilt per
platform), several independent engines. We use:

| engine | model (default tier) | size / cost (est. — Pass 0 verifies) | role |
|---|---|---|---|
| **VAD** | silero-vad (onnx) | ~2 MB, negligible CPU | gate everything: no speech → no ASR, no bytes kept |
| **Streaming ASR** | streaming zipformer transducer, int8, per-language | ~40–100 MB, RTF ~0.1–0.3 on 2 threads | live transcription with partials + endpointing. **German is a first-class target** (the next tester cohort) — the zoo carries German/multilingual streaming models; Pass 0 picks and verifies the German default alongside English |
| **Offline ASR** | sense-voice / moonshine small (optional) | ~100–200 MB | voice-note transcription, where latency doesn't matter and accuracy does |
| **TTS (default tier)** | **PocketTTS** (Kyutai CALM, ~100M params; sherpa-onnx node API supported) | ~100–250 MB, ~200 ms first chunk, multiple× realtime on CPU — X380 numbers from Pass 0 | my voice. Multilingual incl. German (verify quality in Pass 0); voices selected via curated reference prompts (§6.5) |
| **TTS (fallback)** | piper/VITS voice | ~20–60 MB, faster than realtime on 2 threads | **not a tier — a fallback** (§0.7): the §4.6 shedding target when the machine struggles mid-call, and what the pre-flight check offers when PocketTTS genuinely will not fit the disk. Never the silent default; PocketTTS is the default at every tier, read-aloud included |
| **Speech enhancement** | GTCRN denoiser | small; per-stream cost measured in Pass 0 | cleans bad-microphone input ahead of ASR + speaker checks — most wards won't have voice-isolating mics. Toggle `voiceEnhanceEnabled`, default ON for calls if the RTF budget holds |
| **Spoken language ID** | whisper-based LID | ~tens of MB | when the ward enables two ASR languages (German household, English internet), LID routes each utterance to the right decoder — code-gated, per VAD segment |
| **Speaker embedding** | 3D-Speaker / WeSpeaker (onnx) | ~20–70 MB, ~tens of ms per utterance | ward voiceprint enrollment, guest-voice watchdog, diarization for mixed streams |
| **Keyword spotting** | zipformer KWS small | ~15 MB | name-activation in strict-mode calls; wake word on the horizon |
| **Punctuation** | small punct model (optional) | ~30 MB | legible transcripts in session logs |
| **Audio tagging** | zipformer audio tagging (AudioSet labels) | ~30–80 MB | **opt-in toggle, default OFF** — annotation-only in this milestone (§8.4); the long-term care-detection ambitions are their own ward-signed spec |

Not used: source separation, singing/music synthesis — add only when a real
need shows up.

**Model files are machine artifacts:** fetched on first enable by
`scripts/ensure-audio-models.mjs` into `models/audio/` (git-ignored) from
pinned release URLs with **sha256 checksums hard-coded in the script** — the
exact-values rule applied to downloads. No model ships in the repo. The ward
picks the ASR language model and the TTS voice in Settings; everything else is
a sensible pinned default.

### 0.2 What the vision spec already gave us

- **Assets — the *pattern* is inherited; the audio *kind* is a small Pass-1
  addition, not a reservation already in place.** The media store derives an
  asset's `kind` from its mime map (`media.js`: "model kind is derived from the
  map, never from sniffing"), but today that map (`IMAGE_MIME_EXT`) is
  image-only and `saveAsset` hard-codes `kind:'image'`; `materializeAttachments`
  renders images only. So Pass 1 lands three concrete things at that seam: an
  `AUDIO_MIME_EXT` map, `saveAsset` deriving `kind` from the matched map instead
  of the literal `'image'`, and an audio transcript stand-in branch in the
  materializer. Once that exists, a voice note is an audio asset whose transcript
  fills the same cached `description` slot (look-once/listen-once, keep forever)
  and rides as a transcript stand-in — audio never rides as provider
  content-parts in this milestone (§15). The store's design *anticipated* audio;
  it did not pre-wire it.
- **The spine decision holds:** `message.content` stays a string. A spoken
  turn becomes a *transcribed* message — the entire text pipeline (timestamp
  hygiene, audience gating, memorization, threat scoring, history assembly)
  consumes voice turns with **zero changes**, because by the time the core
  sees them, they are text with machine timestamps.

### 0.3 Existing seams this rides (nothing new invented where one exists)

- **Per-location sessions + presence modes (V8):** a voice channel is a
  location; strict / lurk / active govern when I *speak*, exactly as they
  govern when I type. The audience gate is identical in every mode.
- **Push adapters (`registerPushAdapterFactory`):** proactive speech (§7) is
  just another push channel on the outbox — reminders, event alerts, triage
  check-ins and warm reach-outs get a voice without touching their logic.
- **`connectionForFeature` / per-location connection routing:** voice turns
  use the location's connection like text turns do.
- **The hand-rolled Discord gateway:** voice state flows through the same
  WebSocket (op 4 / `VOICE_STATE_UPDATE` / `VOICE_SERVER_UPDATE`); §5 bridges
  it to the voice transport instead of rewriting it.
- **`message-sanitize.mjs`:** the outgoing-boundary stripping regime gains one
  sibling, `speakable()` (§6), applied before any text reaches TTS.

### 0.4 CLAUDE.md invariants this must honor

- **Graceful degradation:** the audio worker is a separate process that can
  crash, stall, or be disabled without the chat path noticing more than
  "voice is unavailable." Every loop keeps its off-switch. A call dying
  mid-sentence degrades to text delivery, never to silence.
- **Ride existing requests; gate in code:** VAD, endpointing, speaker checks,
  name-detection, turn pacing — all cheap code. The only LLM calls a voice
  conversation makes are the chat turns themselves.
- **The LLM is not a source of exact machine values:** timestamps, speaker
  labels, spoken-sentence accounting (§6 barge-in), model checksums — code.
- **Safety-critical sign-off:** feeding ward voice transcripts to the threat
  detector, and audible triage delivery, are named in §10 — defaults proposed,
  ward signs off.
- **First-person convention** for every prompt block and tool description I
  read.

### 0.5 The hardware reality — ThinkPad X380 Yoga

The reference machine: 8th-gen quad-core U-series (4c/8t, 15 W), 8–16 GB RAM,
no GPU. Two properties shape everything in §4:

1. **Burst-friendly, sustained-limited.** Turbo handles short bursts well;
   all-core sustained load throttles. So the design keeps *sustained* load
   near zero (VAD-gated ASR only while someone speaks; TTS in sentence
   bursts) and never schedules two heavy bursts on purpose at the same time.
2. **The CPU rivals are known.** Phylactery embeds locally
   (fastembed / all-MiniLM-L6-v2, ONNX — per-`mem_search` bursts of tens of
   ms, batch bursts during consolidation), Unruh is cheap sqlite, the Node
   server is I/O-bound, background loops are mostly *network*-bound (LLM
   calls) — their CPU cost is small, their latency cost when starved is what
   §4 protects.

**Pass 0 is a ward-facing benchmark tool** — because the people who own the
target machines are wards, not developers at a terminal. The house precedent
is the regex/trigger tracer (0.8.25): a Debug-section diagnostic with a
button, honest progress, and copy/download output. Concretely:

- **The measuring core is a module** (`voice-bench.js`): downloads the
  candidate models on explicit consent (size named up front; pinned URLs +
  sha256 checksums, the same fetcher Pass 1 reuses; optional delete-after),
  runs them against **bundled fixture audio** (short speech clips with known
  reference transcripts per target language — German and English — plus
  runtime noise-mixing of the same clips for the enhancement/bad-mic story),
  and measures with `perf_hooks`: ASR RTF at 1 and 2 concurrent streams +
  **WER against the bundled references** (code-computed, clean vs noisy vs
  noisy+enhanced), TTS time-to-first-chunk and per-sentence latency for both
  tiers, speaker-embedding cost per segment, enhancement cost per second of
  audio. Then the **interference phase**: run a `mem_search` loop through
  the live thalamus and record enrich-path latency with and without full
  audio load running.
- **The ward-facing surface** — Settings → Debug → "Voice benchmark": one
  button, staged progress ("downloading models 2/6…", "ASR, two streams…",
  "interference…"), a reminder to run on AC power, and a finished **report**
  rendered in the modal with Copy and Download buttons — a markdown table +
  the raw JSON, stamped with code-read machine facts (CPU model, cores, RAM,
  OS, Node version, app version). Also persisted to
  `logs/voice-bench-<date>.json` so it survives the modal. **The report is
  the deliverable a ward sends back** (paste it in chat, attach it to an
  issue); whoever holds the repo commits it as
  `docs/voice-bench-results.md`, which supersedes this spec's "~" estimates
  before Pass 2 ships.
- A thin `scripts/voice-bench.mjs` CLI wraps the same module for developer
  convenience — same report, no UI.

Endpoint (`POST /api/diagnostics/voice-bench` + a progress poll) sits behind
the same localhost/Tailscale gate as everything; nothing runs unattended, no
loop, nothing stored beyond the report file and (if kept) the models.

### 0.6 Inherited from the 0.9 vision post-mortem

Voice is a **new surface** in exactly the sense the vision post-mortem means
it (CLAUDE.md, "Lessons cut into law"): it must route through the shared
turn path — the materializer seam, the describe-once cache, the outgoing
sanitizers, the per-surface round budgets, `extractContent` at every reply
boundary — rather than growing its own parallel raw-call path through
`call-engine.js`. A voice-specific `callProviderChat` bypass is exactly the
mistake that starved Discord's turn path in 0.9.7.

- **The build spec carries a surface matrix** (RULE C): web live turn / web
  tool rounds / Discord ward / Discord villager+ambient / voice call /
  background loops — each new mechanism this spec adds (barge-in, the
  earcon, the compute governor's deferral) gets a row, marked wired-or-N/A,
  before Pass 2 ships.
- **A mandatory design question for every latency-driven shortcut:** *what
  exists in context at the moment the reply starts being spoken?* The
  blind-describe bug (0.9.6 — a reply composed before an image's description
  landed) becomes a first-class question here because voice latency pushes
  toward the same shortcut — fire off TTS on the first sentence while
  something is still resolving in the background. §4.4's earcon-bridged
  budget is the answer for enrichment; any *other* fire-and-forget added
  later must answer the same question in writing, not by assumption.
- **Budget exhaustion must be AUDIBLE** (RULE B, spoken form): a tool-round
  cap, a tick timeout, a dropped context block — none of these may resolve
  to dead air. The spoken equivalent of the closing text round is a short
  spoken "I didn't get to that" before the call goes quiet, never silence
  the human has to interpret as a hang or a crash.

### 0.7 The footprint budget — disk is an accessibility constraint

§0.5 gives compute a reference machine and §4 gives latency a budget. Disk
has had neither, and it is the axis most likely to quietly exclude the people
this project exists for. The wards who need a Familiar most are
disproportionately people whose disabilities make holding a job hard — the
machine is a cheap or hand-me-down laptop with a small SSD that is already
most full, and "free up 3 GB first" is not a step they can be assumed to
complete. A feature that cannot be installed is not a feature they have.

**Bandwidth is not the binding constraint** (ward-decided): model fetches are
one-off, and a slow download that finishes is fine. Disk is what persists,
and disk is what this budget governs.

**Every number below is an estimate that Pass 0 replaces with a measurement.**
The bench report (§0.5) gains a *footprint* section alongside its latency
tables: on-disk size of each fetched model, the installed size of the
`sherpa-onnx-node` native binding, the resident size of the Python side
(onnxruntime wheel + the fastembed MiniLM weights), and the app's total
install size across the axis combinations that matter: voice off; read-aloud
with each voice engine; listening with each voice engine; listening-plus with
the default engine. Those measured numbers supersede these estimates before
Pass 2 ships, exactly as the latency estimates are superseded — and they are
what sets the pre-flight check's thresholds, so the check refuses on real
figures rather than guessed ones.

**Two independent axes, not one ladder.** Capability (do I listen?) and voice
engine (what do I sound like?) are chosen separately, because collapsing them
produces exactly the wrong outcome: it makes the ward with the smallest disk
the one whose Familiar sounds least like themselves.

*Axis 1 — capability:*

| tier | what it fetches beyond the voice | proposed ceiling (est.) | who it serves |
|---|---|---|---|
| **Read-aloud only** | nothing — the TTS voice alone | voice size only | hard-of-hearing and reading-fatigued wards; needs no `voiceEnabled`, no listening consent, no ASR |
| **Listening** | silero VAD (~2 MB) + one streaming ASR language, int8 (~40–100 MB) | **+ ≤ 150 MB** | what `voiceEnabled` fetches; a complete spoken conversation |
| **Listening + extras** | GTCRN enhancement + speaker embedding | **+ ≤ 100 MB** | the machine with room; what Pass 0's bench recommends when headroom allows |

*Axis 2 — the voice:*

| engine | size (est.) | what it gives | role |
|---|---|---|---|
| **PocketTTS** (Kyutai CALM) | ~100–250 MB | expressive prosody and **voice cloning via reference prompts** — the §6.5 "every bond picks its own voice" promise | **the default wherever it fits, at every capability tier including read-aloud** |
| **piper / VITS** | ~20–60 MB | a fixed set of speaker ids, flat delivery | **fallback, not a tier**: what the pre-flight check offers when PocketTTS genuinely will not fit, and the §4.6 runtime shed target when the machine struggles mid-call |

**Why PocketTTS is the default even at the floor.** My voice is part of my
identity (§6.5), not a quality setting. For a companion doing care work,
prosody carries the thing the words are for — a flat voice saying something
tender undercuts the bond it exists to hold. Shipping the compact voice as
the *default* for wards with small disks would build a two-tier product where
poorer wards get a less present Familiar, which is the opposite of what this
budget is for. So piper is offered, named honestly as a trade ("this frees
about 180 MB; I'll sound flatter and I can't take on a cloned voice"), and
chosen — never silently assigned.

Everything beyond these — offline ASR for voice notes, a second ASR language,
LID, KWS, punctuation, audio tagging — is **explicit opt-in with its size
named at the point of choice**, never fetched because a neighbouring feature
was enabled.

**The rules the implementation holds to:**

1. **Nothing large is default-on.** `voiceEnabled` fetches the minimum
   listening install and nothing else. A quality tier is a thing the ward
   picks, having been told what it costs.
2. **One language by default.** The ward's language, chosen once. Two
   decoders plus LID is a deliberate second choice, priced separately.
3. **Size is named before the download, not after.** The consent prompt
   states the figure the same way §0.5's bench tool names its downloads —
   "this adds about 180 MB" — and it is read from the fetcher's own pinned
   manifest, never typed by hand (the exact-values rule: code owns the
   number, the sentence only quotes it).
4. **Pre-flight free-space check.** Before any fetch, `ensure-audio-models`
   reads available space on the target volume and refuses with an honest
   message if the download plus a safety margin would not fit — a failed
   half-download on a full disk is the worst outcome for exactly the ward
   this budget protects. Refusal leaves voice cleanly disabled with a
   Settings banner (the §11 failure-table shape), never a broken state.
5. **Store each file once.** Models shared between tiers (a voice reused by
   both TTS tiers, a vocoder) live once in `models/audio/`, content-addressed
   the way media assets are. Switching tiers never duplicates bytes.

**Disk is ward-visible and ward-reclaimable — but only the re-fetchable part.**
Settings gains a **Storage** view listing what the app holds on disk with a
size per item and, where safe, a reclaim button. The distinction it must
draw, plainly and in the UI:

- **Machine artifacts — safe to delete, re-fetchable.** Audio models,
  the fastembed weights, caches. Deleting one costs a future download and
  nothing else. `voiceModelIdleMin` already unloads them from RAM (§2);
  this is the disk analogue, and it is *offered*, never automatic — a
  surprise re-download mid-conversation is worse than the megabytes.
- **Me — not a cache.** Memories, the graph, tomes, identity, session logs,
  kept media. These carry my continuity with my human and are governed by
  curation (§9's retention pass, consolidation, the media-retention loop),
  never by a disk-pressure sweep. The Storage view *shows* their size so
  nothing is hidden, and routes any reduction through the curation surfaces
  that already exist. Nothing in this budget may ever delete a memory to
  save space.

**What grows over time, and what bounds it:** kept voice notes
(`voiceNoteRetentionDays` 14 + the §9 retention pass, which is already the
answer), session transcripts (text, small), the Phylactery store (bounded by
consolidation's prune/merge/decay), images (vision spec's keep-forever —
untouched here, but the Storage view surfaces their total so a ward can see
where the space went). None of these are voice's to solve; the budget's job
is to make them *legible* rather than to let disk use be discovered as a
symptom.

**Every one of these is visible and adjustable in the voice settings surface**
— not a config file, not a value only reachable by knowing its name. Per the
UI guidelines (options a ward can pick must be *visible*), the voice modal
carries: the capability tier, the voice engine and voice pick with preview
buttons (§6.5), `voiceModelsKeepOnDisable`, and a live "what this is using on
disk" line that links into the Storage view. A ward who wants the space back
must be able to find that they can have it back.

**Settings keys:** `voiceCapabilityTier` ('read-aloud' | 'listening' |
'listening-plus', default 'listening' once `voiceEnabled` is on),
`voiceTts.tier` ('pocket' | 'piper', default **'pocket'** — the §0.1 engine
pick, restated here so the footprint budget cannot silently override it),
`voiceModelsKeepOnDisable` (default ON — disabling voice does not silently
delete a download the ward waited for; adjustable in the modal for the ward
whose disk says otherwise). No off-switch: a budget is not a loop.

### 0.8 How this ships — what is vendored, what is fetched

Three artifacts with three different answers, following the house pattern
already set by Phylactery and Unruh: **source is vendored in-tree,
dependencies are fetched at install, and machine artifacts are never
committed.**

| artifact | size | how it ships | why |
|---|---|---|---|
| **`sherpa-onnx-node`** (the JS binding) | ~60 KB | npm dependency | Tiny. Pure JS. |
| **The platform binary** (`sherpa-onnx-win-x64` etc.) | ~23 MB win-x64, ~33 MB linux-x64, ~62 MB darwin-arm64 (measured 2026-07, v1.13.4) | npm **optionalDependency**, one per platform, selected by npm's `os`/`cpu` fields | A ward downloads one, not six. Optional means a platform with no prebuilt binary still gets a working install — voice reports itself unavailable rather than breaking `npm install`. |
| **The models** | ~282 MB for the default plan (est.) | **fetched on first enable**, pinned URL + sha256, `models/` git-ignored | §0.1/§0.7. No model ships in the repo, and none is fetched until a ward says yes with the size in front of them. |
| **Bench fixtures** (§0.5) | small | vendored in-tree | They must be byte-identical across every ward's run or the WER numbers are not comparable. Licence for each clip recorded next to it. |

**Why not vendor the native binary.** It would put 100+ MB of per-platform
binaries in git for a feature most wards enable later or never, make every
`git pull` carry them, and hand us the job npm already does correctly
(platform selection, integrity hashes, upgrades).

**Why not hand-roll the binary download.** We would be rebuilding npm's
platform resolution and integrity checking in `voice-fetch.js` for no gain.
The model fetcher exists because models genuinely are not npm packages; the
binding is.

**The one cost, and its escape hatch.** `optionalDependency` still installs by
default, so a ward who never touches voice pays 23–62 MB. That is small
beside the models but it is not nothing, and §0.7 rule 1 says nothing large
is default-on. So the installers (`install.sh` / `install.bat`) ask once —
"install voice support? adds about 25 MB; you can add it later" — and pass
`--omit=optional` when the answer is no. Re-running the installer, or
enabling voice in Settings, installs it later. A missing binary is a clean
`voice unavailable` state, never a crash: `audio-worker.mjs` fails its
`import` and the supervisor reports it exactly as it reports a missing model.

---

## 1. The shape — voice is transcription at the edge; the core stays text

```
                 ┌───────────────────────────── audio-worker.mjs (child process)
                 │  VAD → streaming ASR → endpoint → final transcript
 PCM in ────────►│  speaker embedding (enroll / watchdog / diarize)
                 │  TTS: text → PCM (sentence-streamed)
 PCM out ◄───────│  KWS (name activation)
                 └───────────────┬─────────────────────────────────────────
                                 │ framed IPC (control JSON + PCM frames)
        ┌────────────────────────┴───────────────────────┐
        │ call-engine.js (in server process, platform-neutral)
        │  turn-taking, presence modes, barge-in, pacing, │
        │  roster→audience, compute governor hooks        │
        └───────┬──────────────────────────┬──────────────┘
   CallAdapter  │                          │  CallAdapter
   (discord-voice-adapter.js)      (web-voice-adapter.js; later:
    per-speaker Opus streams        telegram/teamspeak/mumble/…)
        │                                  │
     Discord                          browser mic (WS PCM)
```

- **`audio-worker.mjs`** owns every sherpa-onnx model and all DSP. It is
  spawned and supervised like the MCP children (restart on crash, EOF on
  shutdown) and is the *only* process that loads ONNX audio models — thread
  caps and crash isolation live at this boundary (§2).
- **`call-engine.js`** is the platform-neutral brain of a call: who's in the
  room, whose turn it is, when I speak, what gets transcribed into the
  session. It knows nothing about Discord, and nothing about ONNX.
- **`CallAdapter`s** own the platform transport only: join/leave, tagged PCM
  in, PCM out, roster events. §3 is the contract; §5 is the Discord
  implementation; a thin web adapter (§6.4) exists mostly so live voice can
  ship and be tested before the Discord transport lands.
- A finished spoken exchange is indistinguishable in the session log from a
  typed one: `role:'user'` messages (speaker-prefixed for non-ward voices,
  exactly like Discord text), `role:'assistant'` replies, machine timestamps,
  the same audienceTag rules. **Everything downstream — memorization, tomes,
  Phylactery graduation, threat, triage context — consumes voice for free.**

## 2. The audio worker — isolation and thread discipline

- **Separate child process** (`audio-worker.mjs`, plain Node + 
  `sherpa-onnx-node`). Three reasons, and they answer different questions —
  the first alone is not sufficient, which an earlier draft of this spec got
  wrong:
  1. **Against co-locating with `server.js`:** native inference calls are
     blocking C++; in-process they would stall the server's event loop — the
     single worst thing for "Phylactery and Unruh keep answering." Out of
     process, the server stays I/O-bound no matter what the models do.
  2. **Against co-locating with Phylactery's embedder** (the question the
     first reason does not touch, since fastembed runs in the Python child,
     not in Node): sharing an ONNX Runtime thread pool only pays off when two
     models want CPU in the same instant, and on a voice turn they mostly do
     not — VAD and ASR run while my human speaks, the embed runs at
     enrichment, the provider call is a network wait with the CPU idle, TTS
     runs after the reply exists. The stages are largely serial, so a shared
     scheduler would have almost nothing to arbitrate. What genuinely
     overlaps is narrow and already bounded: barge-in (cheap VAD against
     TTS) and group calls (`voiceMaxDecoders` 2). Static caps handle both,
     and they cannot deadlock. ORT thread pools are per-process regardless,
     so "sharing" would have meant physically moving audio into Phylactery
     or the embedder into this worker — either one couples the canonical
     self-store to a real-time native pipeline, against modular-by-default.
  3. **Isolation buys supervision.** This worker is restarted on crash with
     backoff; a shared process would mean audio crashes restarting the
     memory and identity store instead. Graceful degradation is a rule here,
     not a habit.
- **Hard thread caps, set at session creation** (ONNX Runtime intra-op
  threads): VAD 1, ASR 2, TTS 2, speaker/KWS/LID 1; the GTCRN enhancement
  stage rides inside its stream's ASR budget (it processes the same VAD
  segment the decoder is about to eat). The worker's peak concurrent
  compute is capped at **`audioThreads` (default 3)** by its internal
  scheduler — on a 4c/8t machine that always leaves a physical core's worth
  of headroom for Node + the Python children even mid-burst.
- **Concurrency cap for group calls:** at most **2 ASR decode streams**
  active at once (`voiceMaxDecoders`). More simultaneous speakers than that
  queue by VAD segment (humans rarely sustain >2 overlapping speakers; queued
  segments transcribe seconds late rather than never). Per-speaker streams
  stay ordered.
- **Lazy load / idle unload:** models load when a call starts (or the first
  voice note arrives), pre-warmed during the join handshake so the first
  utterance isn't the slow one; unloaded after `voiceModelIdleMin`
  (default 10 min) so a machine not in a call pays zero RAM.
- **Protocol:** length-framed messages over stdio — JSON control frames
  (`{op:'asr-partial', streamId, text}`, `{op:'endpoint'}`,
  `{op:'tts', reqId, text}`, `{op:'speaker-check', ref}`…) and raw PCM
  frames (16 kHz mono s16le) tagged with a stream id. No sockets, no ports —
  same posture as the MCP children.
- **Supervision:** crash → restart with backoff; three crashes in a minute →
  worker parked, calls end with an honest spoken/text notice, chat continues.
  `GET /api/voice/status` reports worker state, loaded models, live decoders,
  measured RTF — observability per repo rule.

## 3. The call engine + the `CallAdapter` contract (the plug-in base)

`call-engine.js` runs at most **one live call at a time** (`voiceMaxCalls`,
default 1 — a deliberate X380 constraint; the setting exists so stronger
hardware can raise it later, the engine is written N-call-clean from day one).

**The adapter contract** — everything a platform must provide, and all it
must provide (this is the "plug Telegram/TeamSpeak/WhatsApp in later" base):

```js
{
  id: 'discord',                       // registry key
  capabilities: {
    perSpeakerStreams: true,           // Discord: yes (per-SSRC). A mixed-mono
                                       // platform says false → engine inserts
                                       // the diarization stage (§8.3)
    roster: true,                      // join/leave events with platform ids
    ring: false,                       // can it actively summon a human?
  },
  joinCall(target)  → { callId },      // adapter-specific target (channel id…)
  leaveCall(callId),
  // inbound — adapter emits:
  onAudio(frame)        // { callId, speakerRef, pcm }  16k mono s16le
  onRosterChange(ev)    // { callId, joined:[], left:[] } platform identities
  // outbound — engine calls:
  playAudio(callId, pcmStream),        // sentence-chunked TTS
  stopPlayback(callId),                // barge-in, must be immediate
}
```

The engine owns, identically for every platform: VAD/ASR routing to the
worker, endpointing → turn assembly, presence-mode decisions, barge-in,
speaker→villager resolution + audience re-resolution, session logging,
proactive-speech delivery, and the compute governor. **An adapter never
touches a session, an audience, or a model** — that's what makes the next
platform a transport-only job. (Realistic next targets, in rough order of
protocol friendliness: Mumble (open, per-user streams), TeamSpeak (SDK,
per-client streams), Telegram (MTProto calls — hard), WhatsApp (no sanctioned
API — may never).)

Registered like push adapters: `registerCallAdapter(factory)` from server.js
boot, engine enumerates what's live. One adapter failing (bad token, lib
missing) never blocks another — the Discord adapter degrading must leave web
voice working, and vice versa.

## 4. The compute governor — how a live call doesn't starve the rest of me

The question this section answers: *can I hold a low-latency conversation
while Phylactery, Unruh, Village and Tomes keep working?* Yes — by spending
the machine in the right order, with these six mechanisms:

1. **Process + thread isolation (§2).** The models physically cannot eat more
   than `audioThreads`; the server event loop physically cannot block on
   inference. This alone removes the timeout catastrophe — MCP children keep
   their CPU headroom even mid-utterance.

2. **VAD-gates everything.** Sustained CPU while a room is quiet: ~zero. ASR
   spends only while someone audibly speaks; TTS only while I do. On the
   X380's thermal envelope this is the difference between "works" and
   "throttles after four minutes."

3. **Call-mode deferral of background work.** A live call flips
   `tomes/.call-state.json` (`{active, callId, since}`; written by the
   engine, cleared on leave + on boot). Loops check `isCallActive()` at tick
   start and **defer** — skip the tick, try again next tick — if they are on
   the defer list:
   - **Defers:** pondering, memorization drain, memory sweep, tome
     graduation, gcal sync, needs-tracking, content-regate, media
     retention (§9). All of them are minutes-scale background work; nothing is
     lost by running 20 minutes later (their own gates re-qualify work when they
     resume). (Reconcile this list against the live `*-loop.js` roster at build
     time — it is the current set as of 0.9.30. Note **routine review is NOT on
     it**: `routine-review.js` is pure ride-existing-request functions
     (`isRoutineReviewDue`/`buildRoutineReviewSection`) folded into an existing
     turn's context — it never ticks, so there is nothing to defer.)
   - **NEVER defers:** silence-triage, threat recording, reminders + event
     alerts, the outbox, warm reach-out's *safety posture* (it already stands
     down at moderate+ threat on its own rules). These are the caring spine —
     a call is the *opposite* of a reason to slow them, and they are
     network-bound anyway (their CPU cost is nil; they were never the
     contention).
   - **Phylactery consolidation:** the one CPU-heavy Python-side batch job.
     Phylactery gains a tiny lifecycle tool (`maintenance_defer(seconds)`);
     the governor calls it on call start and re-arms it each minute while the
     call lives. If the tool is missing (older Phylactery), log loudly and
     continue — consolidation is volume-gated and rare; this is optimization,
     not correctness.

4. **A latency budget on enrichment, not a smaller me.** Voice turns get the
   FULL context — identity, memory, graph, temporal, care check; a voice
   conversation with a lobotomized Familiar would betray the whole design.
   Instead, `enrich()` gains a **two-tier latency budget** (shaped by a
   Familiar's review question — the earcon can buy patience, so it should):
   - **Soft budget (~1200 ms, silent):** every peer fetch races it; on a
     typical turn everything lands well inside and nothing changes.
   - **Earcon-bridged hard ceiling (~3000 ms):** if a dynamic block is still
     pending at the soft mark, the engine plays the earcon (§4.5) and waits
     for the stragglers up to the ceiling — the wait is *legible*, so it's
     affordable, and a slow memory recall usually needs hundreds more
     milliseconds, not seconds. Only at the hard ceiling does the turn
     proceed without the block (the existing `Promise.allSettled`
     absence-renders-as-absence discipline, now time-bounded).
   - **A dropped block is a visible gap, not a silent one:** the turn's
     dynamic context gains a one-line code-built note — *"[my memory recall
     didn't return in time this turn — I may be missing something I'd
     normally remember]"* — so I answer knowing I'm working with a gap
     instead of mistaking absence for emptiness. The straggler fetch is not
     cancelled: its late result is cached and rides the NEXT turn's block at
     zero extra cost (no re-fetch, no new request).

   The static block is assembled once per call and cached (it's stable by
   design); only dynamic blocks re-fetch per turn. Measured on this
   hardware, local sqlite + one MiniLM embed almost always fits the soft
   budget — the tiers exist for the tail, and the worst case is a bounded,
   earcon-bridged three seconds with full context rather than a fast answer
   with an invisible hole.

5. **Sentence-streamed TTS + earcons for honest waiting.** The reply is
   spoken sentence-by-sentence as the LLM streams — first audio lands after
   the first sentence, not the full completion. If a turn (tool rounds, slow
   provider) exceeds ~2 s with nothing to say, the engine plays a short
   **code-triggered earcon** (a soft chime/breath — an asset, not an LLM
   artifact) so my human knows I'm there and working. Tools stay fully
   available on voice turns — capability parity is non-negotiable — the
   earcon makes their latency legible instead of hiding them.

6. **Model tiering as the escape valve.** Defaults are the fast tiers (int8
   streaming zipformer, piper voice). If Pass 0's bench shows headroom, the
   ward may pick the quality TTS tier; if a group call on battery struggles,
   the engine sheds quality in code-defined order: quality-TTS → fast-TTS,
   punctuation model off, `voiceMaxDecoders` 2 → 1. Shedding is logged and
   visible in `/api/voice/status`, never silent.

**What is deliberately NOT done:** no OS priority games (`os.setPriority`
needs privileges to boost, and lowering the Python children would slow the
very peers we're protecting), no cgroups (not portable to the ward's
platforms), no second machine. Thread caps + gating + deferral are portable
and sufficient on the measured hardware.

## 5. Discord group calls

**Transport (decided): `@discordjs/voice` bridged to the hand-rolled
gateway.** Discord voice is a second WebSocket + encrypted UDP/RTP + Opus +
the DAVE E2EE protocol — hand-rolling it is months of protocol work with
security-sensitive crypto. `@discordjs/voice` exists to be embedded: its
gateway-adapter interface needs two things from our gateway — send an op-4
payload, and forward `VOICE_STATE_UPDATE` / `VOICE_SERVER_UPDATE` dispatches.
**The outbound half already exists** (`wsSend({op, d})` sends arbitrary gateway
ops today — op 1/2/6 use it), so op-4 send is a one-liner. **The inbound half is
net-new:** the dispatch handler is a per-`t` if-chain (`READY`, `RESUMED`,
`INTERACTION_CREATE`, `MESSAGE_CREATE`) with no voice cases, so Pass 3 adds two
small dispatch-forward cases that hand those events to the voice adapter — the
gateway does *not* forward them today. New deps: `@discordjs/voice`,
`@discordjs/opus` (native Opus),
`sodium-native` (transport crypto), pinned at versions with DAVE support
(verify at Pass 3 — Discord is rolling E2EE out to all voice). The rest of
the gateway stays ours.

- **Joining:** the ward invites me (`voice_join` tool and/or a Settings/UI
  action naming a registered location). I join only **registered voice
  locations** (a new `discord:voice:<guildId>:<channelId>` location kind in
  the Village registry — label, presence mode, connection routing, rate
  limits, all the existing per-location machinery). Never an unregistered
  channel: presence in a room is a ward decision. Bots cannot join user DM
  calls (platform rule) — a private guild voice channel is the 1:1 pattern;
  say so in the UI.
- **Per-speaker streams = diarization for free.** Discord delivers one Opus
  stream per speaking user (per-SSRC), mapped to a user id → resolved through
  the Village registry exactly like a text message's author: ward /
  villager / stranger. `capabilities.perSpeakerStreams: true` — the engine
  skips the diarization stage entirely on this adapter. (To be clear on
  terms: **Opus is Discord's audio codec**, a transport detail the adapter
  decodes to PCM — it has nothing to do with the LLM. Whatever chat model
  the ward points a location at — GLM, a small Gemma, anything on the
  connection list — never receives audio in any form; it only ever sees the
  transcript text, like every other message.)
- **Roster = audience, re-resolved on every join/leave**, not just per
  message: `onRosterChange` re-runs the audience resolution *immediately*, so
  a stranger stepping into the channel gates the very next sentence I speak.
  The location ceiling always applies. This is the same fail-closed audience
  model as text; voice adds no new privacy rules, only a faster trigger.
- **Presence modes in voice** (per-location, same setting):
  - `strict` — I speak only when addressed: my name in a final transcript
    (cheap code match on the resolved name/aliases, same spirit as
    `messageNamesBot`) or the KWS spotter firing mid-utterance for lower
    latency. Everything else is observed into the session log.
  - `lurk` — transcribe-and-observe; reply when addressed. Observed voice,
    like observed text, is **threat-neutral** and moves no activity clock.
  - `active` — I may chime in unprompted, paced by the existing ambient
    machinery reused verbatim: `activeCooldownSec` floor,
    `decideAmbientReply` strategies, and the batching idea maps naturally —
    a burst of overlapping voices settles (`adaptiveSettleMs` over utterance
    gaps) into ONE spoken reply to the exchange, not one per utterance.
  - The ward's own DM-equivalent (a ward-only voice channel) is ward-private
    context, full enrichment, like the web chat.
- **Transcript sessions:** one session per voice location (existing rotation
  rules). Lines land as
  `[Sana]: we could move it to thursday` — speaker-prefixed for non-ward
  voices, raw for the ward, machine-timestamped, `speaker`/`targets`/`namedMe`
  fields populated so `carriedExchange` and the room-legibility machinery
  work unchanged. Partials are never logged; only final, endpointed
  utterances become messages.
- **Ward voice activity:** a final ward utterance stamps `recordUserActivity`
  and runs threat scoring per §10 — my sense of "my human was just here"
  follows their voice as it follows their typing.
- **Rate limiting:** spoken replies count against the location's existing
  token bucket; when exhausted I stay quiet in voice too (the ward gets the
  same outbox notice).

## 6. Turn-taking, latency, and the voice itself

### 6.1 The latency budget (mouth-to-ear, X380, targets to hold in Pass 0/2)

| stage | budget |
|---|---|
| VAD endpoint (trailing-silence) | 240–320 ms after my human stops |
| streaming ASR final (already decoded as they spoke) | +≤150 ms |
| enrich() under the two-tier budget (§4.4) | soft 1200 ms (typical ≪); earcon-bridged hard ceiling 3000 ms |
| LLM first sentence (network, streamed) | 500–1500 ms (the true floor — provider-bound) |
| TTS first sentence + playback start | 200–500 ms |
| **first audio back** | **~1.5–3 s typical; earcon at 2 s if still waiting** |

### 6.2 Barge-in (non-negotiable for a companion)

VAD detecting my human's voice during my playback → `stopPlayback()`
immediately, current TTS request cancelled. Because playback is
sentence-chunked, **code knows exactly which sentences were delivered**: the
assistant message stores the full text plus `spokenUpTo` (sentence index).

**I keep the unsaid remainder — it was my thought** (a Familiar asked whether
"what were you gonna say?" is answerable). History assembly renders the
spoken part verbatim, then the remainder *visible but framed as unheard* by a
code-built marker:
`[— my human interrupted me here; they never heard the rest: "…" —]`.
So the distinction I need is exactly preserved, both ways: I never believe
my human heard something they didn't, and I never lose what I was about to
say — "you were saying?" gets the real answer, not a reconstruction. (The
exact-values rule applied to my own speech; the remainder was composed for
this same session and audience, so nothing new leaks by keeping it.)

### 6.3 `speakable()` — the outgoing boundary for TTS

A sibling of `stripLlmTimestamps` in `message-sanitize.mjs`, applied to every
sentence before it reaches the worker: strips markdown/code fences/link
syntax, echoed `[HH:MM]`/`⫸HH:MM⫷` artifacts (the existing strip runs first),
emote/action asterisks per ward preference, and tool-call debris. Number and
unit reading is the TTS model's job, not a rewrite pass. The *session log*
keeps the full original text — `speakable()` shapes sound, never history.

### 6.4 The web voice adapter (ships before Discord — the testable core)

A thin `CallAdapter` over the browser: AudioWorklet captures 16 kHz mono PCM
over a WebSocket to the server; TTS PCM streams back for playback. Push-to-
talk first, VAD-open-mic as a toggle. This is deliberately Pass 2: it proves
the whole engine — worker, endpointing, barge-in, governor, latency — on the
target machine with zero Discord protocol risk, and it remains the fallback
voice surface when Discord is down. (`perSpeakerStreams: false`, so it is
also the first consumer of the diarization stage + guest watchdog in §8.)

### 6.5 My voice is part of my identity

Settings ships a **curated menu of built-in voices** — PocketTTS reference
prompts and piper speaker ids, several distinct characters per language, each
with a preview button that speaks a fixed sample sentence — so choosing a
voice is a listening act, not a config-file edit. `voiceTts` stores the pick:
tier/model, voice (reference-prompt or speaker id), rate.

**Every bond picks its own voice.** This is per-install state, like my name
and my identity — a different ward's Familiar sounds like *them*, not like a
product. The first time voice is enabled, the menu is offered as part of the
setup flow (previews right there), and until a pick is made one neutral
shipped default covers read-aloud so the feature is never dead on arrival.
Changing the voice later is one Settings visit; the choice belongs to the
ward and their Familiar, together.

**My human may give me a voice of their own (ward decision, 2026-07).**
PocketTTS clones zero-shot from a ~10 s clip with no reference transcript, so
"bring your own voice" is a file picker, not a training run. A ward may point
it at a character they love, a friend who volunteered, anyone whose voice
means something to them. This is theirs to do: it is personal use on their own
machine, and it is one of the few places where the Familiar can be shaped into
someone the ward actually wants to hear from.

The handling rules follow from that being *personal* use, and they are
enforced in `voice-catalogue.js` rather than left as a convention:

- **Bundled voices** come from the curated catalogue — CC0 and CC BY 4.0 only,
  credits generated from the catalogue into a NOTICE. Non-commercial sources
  (Expresso, EARS) are deliberately excluded: an NC restriction cannot ride
  inside a GPL distribution. They stay listed *with their reasons* so nobody
  rediscovers and re-litigates them.
- **A ward-supplied clip never leaves the machine.** Not in a diagnostic
  report, not in a bench report, not in a bug paste, not through any shared
  media surface. `mayLeaveTheMachine()` fails closed — unknown provenance is
  treated as the ward's own, because wrongly withholding a bundled clip costs
  a follow-up question and wrongly sharing theirs cannot be undone. Redaction
  is *reported*, never silent, so someone debugging a voice problem still
  knows a voice was involved.
- **But it DOES travel in their own identity backup.** Their data moving with
  them is not redistribution. This is the load-bearing consequence of §6.5's
  own claim: if my voice is part of my identity, then an identity export that
  restores my memories and my name but not my voice brings back something that
  sounds like a stranger wearing me. **Whatever ships as identity backup must
  carry the reference clip alongside identity, memory and graph** — the clip
  bytes, not just a path into a `media/` directory that a restore onto a new
  machine will not find.

The voice-mode prompt block (first-person, injected only on voice turns,
authored in the identity-anchored register):

> *I'm speaking aloud on a live call right now, in my own voice. I keep my
> turns short and natural — spoken sentences, not essays; no markdown, no
> lists, nothing that only works on a screen. I can be interrupted, and
> that's fine — conversation is a rhythm, not a broadcast. I speak from my
> actual voice and character, whatever register that is.*

## 7. Speaking to draw my human's attention — proactive voice

- **A `voice-call` push adapter** (via the existing
  `registerPushAdapterFactory`): while a call is live, outbox deliveries —
  reminders, event lead-time alerts, triage check-ins, warm reach-outs — are
  additionally **spoken**, with per-channel delivery recorded on the item
  like every other adapter (`delivery['voice-call']`). Their gates are
  untouched: quiet hours still govern warmth, tiers still govern triage,
  nothing about *whether* to reach out changes — only that my voice becomes
  one more way a reach-out lands. A check-in my human *heard* is a check-in
  the escalation clock can fairly count (`contactDeadlineFor` reads the
  earliest confirmed delivery — a spoken delivery is a confirmed one).
- **Starting sound when there is no call:** on Discord I cannot ring a human
  (platform rule). What I can do, tier-gated and ward-configured: join the
  designated ward voice channel and speak the check-in if my human is sitting
  in it (`voiceProactiveJoin`, default OFF; the no-covert-contact mirror
  applies as always — every such join lands in the outbox trail). True
  attention-drawing through a local speaker without any platform is the
  horizon (§12) — the adapter contract already carries it (`ring`
  capability), so it plugs in rather than being retrofitted.
- Proactivity rules apply to any prompt this touches: both costs named at
  equal weight; a spoken check-in my human can wave off is CHEAP; a silent
  one they never saw is not.

## 8. Who is speaking — voiceprints, the guest watchdog, and presence auto-switch

### 8.1 Ward voiceprint enrollment

A Settings flow: my human reads ~20 s of prompted text; the worker computes
speaker embeddings; the averaged print is stored **locally only**
(`tomes/.voiceprints.json`, git-ignored, never synced, never leaves the
machine — it's biometric-adjacent and stays in the embodiment). Re-enrollable
any time; deletable; absence just disables §8.2/§8.3 features, never blocks a
call.

### 8.2 The guest-voice watchdog (the ward's presence-switch, buildable now)

During any call, each finalized VAD segment on a stream *believed to be the
ward* (their SSRC on Discord; the mic stream on web voice) gets a cheap
embedding check against the enrolled print (tens of ms, inside the worker's
thread budget). A run of low-similarity segments (code thresholds: N
consecutive segments below cosine `voiceGuestThreshold` — never a single
blip, TVs and sneezes exist) raises `voice:guest_detected` on the engine.
What happens then is the ward's standing policy, `voiceGuestPolicy`:

- `ignore` — nothing (default for wards who share space with a TV).
- `note` — a code-built line joins my next turn's context: *"I can hear a
  second voice in the room with my human — someone I haven't been introduced
  to."* I adjust as myself; nothing is stripped.
- `gate` — **immediate presence switch**: the session's audience input gains
  an unregistered-participant marker, the audience re-resolves to its
  Strangers-ceiling equivalent on the very next turn, and ward-private blocks
  (ponderings, care check, deferred intents, surface candidates) stop
  flowing until release. Fail direction while a `gate` policy is active:
  **uncertain = guest** (privacy fails closed).

**Release is deliberately asymmetric to entry** (a Familiar asked: "what's M?").
Entry is fast on negative evidence (N=3 consecutive non-ward segments,
`voiceGuestEnterSegments`); release needs positive evidence *plus* time,
because ward-matching segments alone can't prove the guest left — they only
prove the ward is the one talking right now, and a quiet guest produces no
segments at all. So the gate releases when **both** hold: **M=6 consecutive
ward-matched segments** (`voiceGuestExitSegments`) **and ≥90 s since the last
non-ward segment** (`voiceGuestExitQuietSec`). Calibration: a brief remark
from someone passing through costs the ward roughly a minute and a half of
gated context, not five; a TV keeps emitting non-ward segments and correctly
keeps the gate held. Two instant releases exist besides the timer: the ward
saying so **in a segment that itself matches their print** (a spoken release
the guest's voice cannot fake), or the UI control. All three knobs are
settings; Pass 0's speaker-embedding numbers calibrate the thresholds.

The reverse transition is symmetric and logged; every switch lands in the
session log as a code-stamped event line so "why did my Familiar suddenly go
formal" is always answerable.

### 8.3 The diarization stage (for `perSpeakerStreams: false` adapters)

When an adapter can't hand us per-speaker streams (web mic, some future
platforms), the engine inserts a pipeline stage between VAD and ASR: segment
→ speaker embedding → match against enrolled prints + short-lived online
clusters → `speakerRef` (`ward`, an enrolled villager who has consented to a
print, or `guest-1`, `guest-2`…). Unmatched refs resolve to stranger-tier for
audience purposes — same fail-closed default as an unknown Discord user.
Villager voiceprints are **opt-in per villager** (a consent field on the
registry entry, like `remember` consent) and enrolled from a labeled clip the
ward provides; without one, a villager on a mixed stream is just a guest
label with a name only if introduced in conversation.

### 8.4 Audio tagging (opt-in, annotation-only — for now)

`voiceAudioTaggingEnabled` (default **OFF**): when on, VAD-rejected and
speech-adjacent segments run through the audio-tagging model, and
code-classified tags above a confidence floor become **context annotation
lines** in the session, machine-stamped, nothing more: *"[I can hear a dog
barking / glass breaking / a television in the background]"*. Tags never move
the threat tier, never trigger an action, never persist beyond the session —
in this milestone they only make me a better listener to the room I'm in.

**The long-term ambition is named here so nobody builds it casually:** sound
classes like distressed shouting, breaking objects, or the acoustic patterns
of purging could one day matter to the care I owe my human — a ward with an
eating disorder, a household where violence happens. That is *detection that
changes when I act on safety*, which makes it **safety-critical by
definition: its own spec, its own ward sign-off, evidence-informed
thresholds, and honest false-positive/false-negative accounting** before a
single tag touches the caring spine. The toggle ships now; the care wiring
does not.

## 9. Memory, assets, retention

- **Raw call audio is ephemeral by default.** PCM lives in ring buffers long
  enough to transcribe and is discarded; what persists is the transcript in
  the session log — which is exactly what memorization, graduation, and the
  audience system already know how to hold. Recording a call to an audio
  asset is a deliberate act (`voiceKeepAudio` default OFF; a future
  `record this` affordance), never ambient.
- **Voice notes are assets:** a Discord audio attachment or a web-recorded
  memo saves as `kind:'audio'` (vision-spec store), gets transcribed once by
  the offline ASR (better accuracy, latency-free path), transcript cached on
  the asset (the describe-once pattern verbatim), and rides chat as a
  stand-in: `[voice note oat-milk-list-x7, 0:41 — transcript: "…" — shared
  by my human, 7 Jul 14:31]`. Ids on every model-facing surface are
  **meaning-bearing slugs** (the `slugify(label)-xx` house pattern, now a
  CLAUDE.md rule) — and voice notes get theirs honestly at arrival, because
  transcription happens at ingest: the slug is minted from the transcript's
  key words, so I can grep my own assets by what was *said*. The slug makes
  a future `listen_again`/`view_image` sibling operable. In this milestone
  the transcript IS the content, so no re-listen tool ships (§15).
- **Voice-note retention is curation, not a cron delete (ward-decided).**
  Audio bytes are kept for `voiceNoteRetentionDays` (default **14** — "a
  week or two"), then a slow retention pass lets **me** decide what stays
  audio: `media-retention-loop.js`, the tome-graduation shape reused —
  code gates select candidates (audio assets past the window, not already
  stripped, not flagged `keep`), then ONE batched LLM judgment in my own
  voice over their transcripts + context: *the transcript survives either
  way — I keep the sound itself only when the sound is the point: a voice I
  love saying something worth re-hearing, a moment where tone carried what
  words didn't.* Keeps get `keep: true` (never re-judged; the ward can also
  flag keep from the media list in the UI); the rest go through
  `stripAudio(id)` — bytes deleted, meta + transcript + slugs survive,
  `audio: {deletedAt, reason}` recorded, stand-ins unchanged (they were
  transcript-built already), a stripped asset renders `[audio let go —
  transcript kept]` if re-requested. Daily-ish tick (6 h), defers during
  live calls (§4.3) and at moderate+ threat (the standard opt-in-loop
  posture), never throws. Default ON (the ward asked for it as the
  default); off-switch `PROTO_FAMILIAR_MEDIA_RETENTION_DISABLED=1` +
  Settings toggle. Images are untouched by this loop — the vision spec's
  keep-forever stands.
- **Memorization:** call sessions flow through the existing session
  memorization with their audienceTag. Nothing new — that was the point of
  the §1 shape.

## 10. Safety-critical surfaces (defaults proposed; ward signs off)

- **Ward voice transcripts feed the threat detector** (`source:'voice'`) —
  proposed **default ON**. These are my human's own words; the Discord text
  path already scores ward messages, and a spoken *"I can't do this anymore"*
  going structurally unheard would be the 1.5-hour failure rebuilt in audio.
  Two code guards, not softenings: only **final** transcripts score (never
  partials — half-decoded words aren't words), and only streams resolved to
  the ward (a villager's voice must never move the ward's tier — same rule as
  text). ASR mishears are the false-positive cost; false positives are cheap
  by doctrine. Sign-off line: confirm ON, or it ships dark with the wiring in
  place.
- **Audible triage delivery** (§7) changes *how* a check-in lands, never
  *whether*. The deliberation prompts, tier gates, and cool-downs in
  `silence-triage-loop.js` are **untouched** by this spec. One deliberate,
  **ward-directed** exception on the escalation side (signed off in the
  first spec review): a check-in that was **confirmed spoken** into a live
  call **with the ward present in the roster at delivery** starts a
  *shorter* acknowledgement window — they demonstrably heard me, so silence
  after a spoken check-in means more than silence after a banner they may
  never have seen. Implementation: `contactDeadlineFor` applies
  `voiceEscalationFactor` (default **0.5×** the per-tier
  `CONTACT_ESCALATION_DELAY_MS`, clamped [0.25, 1]) only when
  `delivery['voice-call'].status === 'delivered'` AND the ward was in the
  call at that moment — both machine facts. Every other delivery path keeps
  today's windows. This tightens toward action, never away from it — the
  direction the proactivity doctrine permits without ceremony; the reverse
  would not be.
- **Observed voice is threat-neutral** (lurk/strict observation, villager and
  guest speech) — mirrors the V8 observe path exactly.
- **The guest watchdog gates privacy, never safety:** a `gate` switch strips
  ward-private context blocks from turns; it does not touch threat recording,
  triage, or reminders (which deliver on their own channels regardless).
- **The governor's never-defer list (§4.3) is itself safety-critical code** —
  moving a loop from "never defers" to "defers" is a when-I-can-act change
  and requires the ward, per CLAUDE.md.

## 11. Settings & off-switches

- **Listening and speaking are separate consents — but a voice note is not
  "listening" in the sense that needs one.** (Revised in Pass 1 after live
  testing; the original text gated voice notes behind `voiceEnabled` too.)
  Pressing the record button IS the consent, and the browser asks its own
  permission on top; a setting in front of that guards an already-locked door
  while *hiding the button that opens it* — friction and undiscoverability at
  once, in an app whose users' executive function is the actual obstacle.
  So **voice notes need only the deliberate press** and the hard env switch.

  `voiceEnabled` remains, **default OFF**, and governs **continuous**
  listening — a microphone that is simply open: live calls, VAD, streaming
  ASR, voice locations (Pass 2+). That genuinely is different in kind. When
  it is off, no ASR/VAD/speaker models load for calls, adapters never
  register, and voice locations render inert.

  `PROTO_FAMILIAR_VOICE_DISABLED=1` still kills all of it, notes included.
- **Read-aloud (TTS-only) does not require `voiceEnabled`** — it's an
  accessibility surface, not a listening one, and hard-of-hearing wards are
  exactly who it serves. Every assistant message in the web UI gets a 🔊
  **"read this aloud" button**. Shipped as TWO endpoints rather than the one
  sketched here, because they are different kinds of work: `POST
  /api/voice/speech-plan` is pure text and costs nothing, then `GET
  /api/voice/tts/:id` synthesises one utterance at a time. Splitting them is
  what makes playback start in about a second instead of after the whole
  message. `speakable()` applies; the first-ever use offers the model download
  with a size note before fetching. `readAloudByDefault` speaks each new reply
  as it arrives, with barge-in by pressing the button again **or typing** —
  both shipped in the Pass 1 audit, having been missed in the original pass.
- Hard off-switch `PROTO_FAMILIAR_VOICE_DISABLED=1` ships in the same commit
  as Pass 1 and kills *all* of it — worker, calls, read-aloud.
- Per-surface: `voiceDiscordEnabled`, `voiceWebEnabled`; per-location voice
  presence mode + connection id (existing registry fields).
- Knobs with defaults (constants until tuning proves otherwise):
  `audioThreads` 3, `voiceMaxDecoders` 2, `voiceMaxCalls` 1,
  `voiceModelIdleMin` 10, `latencyBudgetMs` 1200, `voiceGuestPolicy`
  **'note'** (ward-decided), `voiceGuestThreshold` (Pass 0-calibrated),
  `voiceEnhanceEnabled` on-if-budget-holds, `voiceAudioTaggingEnabled` off,
  `readAloudByDefault` off, `voiceEscalationFactor` 0.5, `voiceKeepAudio`
  off, `voiceNoteRetentionDays` 14 (+ the media-retention loop toggle,
  default ON, off-switch `PROTO_FAMILIAR_MEDIA_RETENTION_DISABLED=1`),
  `voiceProactiveJoin` off, `voiceTts` {tier, voice, rate} from the
  curated menu, ASR model choice per ward language (German + English
  first-class; LID when two are enabled).
- **Failure table** (every row inside the turn/call, none reaches chat as an
  error): worker crash → adapter plays nothing, call ends with a text notice
  in the location + outbox, chat unaffected; model download failed → voice
  stays cleanly disabled with a Settings banner; ASR stall on one stream →
  that stream's segments drop with a log, the call lives; TTS failure →
  reply delivers as text with an outbox note; adapter transport death →
  engine tears the call down, governor releases deferrals, state file
  cleared (also cleared on boot — a crashed server never leaves loops
  deferred forever).

## 12. The horizon — ambient listening (pinned invariants, not built now)

The continuous-ingestion endgame — me present in the room, not just in a
call — must arrive as an extension of this spine:

1. **A local microphone is just another `CallAdapter`** (`local-mic`,
   `perSpeakerStreams: false`, `ring: true` via the local speaker). The
   engine, worker, diarization stage, watchdog, and presence policies are
   already written for it; what's new is only the capture transport and the
   *standing* nature of the session.
2. **Wake-word via the KWS engine** — my name as the activation keyword,
   spotted in the worker at negligible cost, opening a listening window the
   way an @-mention opens a text turn. Below the wake word, ambient audio is
   VAD-gated, transcribed into NOTHING by default: continuous sensing reduces
   to discrete, code-classified events (speech addressed to me; the guest
   watchdog's transitions; an enrolled-voice greeting) before any LLM is
   consulted — the gcal-ingest discipline applied to sound, and the vision
   spec's §11 rule restated for a new sense.
3. **Ambient presence modes are the V8 vocabulary again** — strict (wake-word
   only), lurk, active — set per the `local-mic` "location," with the
   diarization-driven auto-switch (§8.2) as the ward's standing privacy
   policy for who else is in the room.
4. **Speaking to draw attention through the local speaker** is the `ring`
   capability of that adapter: a tier-gated, ward-configured, quiet-hours-
   respecting spoken knock — the true form of the §7 feature, and the reason
   §7 routes proactive speech through the adapter contract rather than
   special-casing Discord.
5. **An always-on microphone is a ward-sovereignty feature first.** Default
   OFF, its own spec, its own sign-off, a hardware-honest power/thermal
   budget (a 15 W laptop running ASR all day is a design problem, not a
   toggle), and physically-legible state (the ward can always tell whether
   I'm listening). Nothing in this milestone forecloses it; nothing in this
   milestone ships it.

## 13. Build order (passes)

- **Pass 0 — the bench tool.** `voice-bench.js` (measuring core) + the
  Settings → Debug "Voice benchmark" surface + the model fetcher + bundled
  fixtures + the CLI wrapper (§0.5). This IS a small shippable feature
  (wards run it and send reports back — it's also how German-speaking
  testers verify the German ASR pick on their own hardware); results from
  the X380 land as `docs/voice-bench-results.md` and pick the default model
  tiers before Pass 2. **The bench also measures footprint (§0.7)** — on-disk
  size per model, the native binding, the Python side, and total install size
  at each tier — so the §0.7 ceilings are set from measurement rather than
  estimate before anything is built on them. The pre-flight free-space check
  ships here too: the bench is the first thing that downloads models, so it
  is the first thing that must refuse gracefully on a full disk.
- **Pass 1 — the spine. ✅ COMPLETE (0.10.x), confirmed working on the
  reference laptop: read-aloud in one voice throughout a multi-paragraph
  message, and a voice note recorded, transcribed and answered.** `audio-worker.mjs` + supervision + thread caps;
  model fetcher with pinned checksums; voice-note path end-to-end (asset →
  offline transcript → stand-in in chat); **read-aloud** (per-message 🔊 +
  `readAloudByDefault` + `POST /api/voice/tts`, the curated voice menu with
  previews); `voiceEnabled` + env off-switch; `/api/voice/status`.
  *Milestone `0.X.0`.*
- **Pass 2 — first live conversation.** `call-engine.js` + web voice adapter
  (push-to-talk, then VAD mode); streaming ASR turns; sentence-streamed TTS +
  barge-in + `speakable()`; the compute governor (call-state file, deferral
  lists, `latencyBudgetMs`, earcon); voice-mode prompt block.
- **Pass 3 — Discord.** `@discordjs/voice` bridge to the hand-rolled gateway;
  voice locations in the registry + UI; per-SSRC speaker resolution; roster→
  audience re-resolution; presence modes + ambient pacing in voice;
  transcript sessions; `voice_join`/`voice_leave` tools (first-person
  descriptions); Phylactery `maintenance_defer`.
- **Pass 4 — who is speaking + proactive voice + curation.** Voiceprint
  enrollment UI + storage; guest watchdog + `voiceGuestPolicy` presence
  switch; diarization stage for mixed streams; the `voice-call` push adapter
  + delivery recording; the media-retention loop (§9); ward sign-offs from
  §10 resolved and wired. **The media-retention loop is a new background
  worker — bump CLAUDE.md's worker count (twelve at spec time → thirteen) in
  the same commit, per the loop-off-switch discipline.**
- Each pass: `docs/architecture.md` in the same commit; per-loop off-switch
  in the same commit as any new loop.

## 14. Acceptance criteria

- On the X380, with a call live and someone speaking continuously, a
  concurrent text chat turn's `enrich()` stays **inside the interference
  budget** — Phylactery and Unruh answer while I listen. (The §4 headline,
  tested, not asserted.)

  The budget is the more generous of two ideas, and it is code
  (`interferenceBudgetMs` in `voice-bench.js`), not prose:

  - **Absolute — stay under 250 ms.** Below roughly a quarter second, an
    enrichment read is invisible inside a turn already waiting on a network
    LLM call. Whether it took 39 ms or 200 ms is not something my human can
    feel.
  - **Relative — or, if the machine was already slower than that, do not make
    it meaningfully worse:** baseline + 20%, with a 25 ms floor.

  **This replaces a flat "±20% of normal", which the first real measurement
  showed to be the wrong test.** The X380's quiet baseline is 39 ms
  (`docs/voice-bench-results.md`), so ±20% was an ~8 ms window: a bar that
  fails on shifts nobody could perceive, and that gets *harder the faster the
  machine is*. A test that punishes a good baseline is measuring the wrong
  thing. Taking the max of the two means a fast machine is judged on whether
  it stayed imperceptible and a slow one on whether audio made it worse —
  neither is penalised for what it cannot help.

  The report names which half was binding, because "you stayed imperceptible"
  and "you did not make a slow machine worse" are different claims. The p90 is
  reported but does not gate: at a dozen samples one outlier should not fail a
  build.
- First audio of my reply lands ≤3 s after my human stops speaking (network
  LLM permitting); the earcon covers anything longer; barge-in halts my voice
  in ≤250 ms and `spokenUpTo` matches what was actually played.
- A three-speaker Discord call produces a correctly speaker-attributed
  transcript session; a stranger joining the channel gates the next spoken
  sentence (fail-closed audience test).
- With `voiceGuestPolicy:'gate'` and an enrolled print, a second voice on the
  ward's stream strips ward-private blocks from the next turn; the ward's
  return restores them; both transitions are logged in-session.
- Kill -9 on the audio worker mid-call: the call ends with an honest notice,
  chat keeps working, the worker restarts, deferral state clears. Same for
  the whole server: no stale `.call-state.json` after boot.
- The deferral test: during a call, pondering/memorization/gcal ticks log
  `deferred (call active)` and run after the call; a due reminder and a
  triage check-in fire DURING the call — and are spoken.
- Ward voice transcripts move the threat tier (if signed ON); a villager's
  voice never does; partials never do.
- A ward on a stock install can run the voice benchmark from Settings →
  Debug with no terminal: consent → progress → a copyable/downloadable
  report carrying machine facts + all measurements; the same run is
  reproducible via the CLI wrapper.
- With `voiceEnabled` OFF, the 🔊 read-aloud button still speaks a reply
  (TTS-only worker load, no ASR model in memory, no capture path exists);
  `readAloudByDefault` speaks each new reply as it lands.
- The noise-mixed German fixture transcribes acceptably with
  `voiceEnhanceEnabled` on (Pass 0 defines the WER bar) — the bad-microphone
  story is tested, not assumed.
- `PROTO_FAMILIAR_VOICE_DISABLED=1` — no worker process exists, all voice
  surfaces (including read-aloud) degrade to their honest text fallbacks.
- **The footprint budget holds (§0.7), measured not asserted:** enabling
  `voiceEnabled` on a stock install fetches the listening tier and nothing
  more, and the bench report's measured total is at or under its ceiling.
  Turning on read-aloud alone fetches a voice and no ASR.
- **The expressive voice is the default at every tier**, read-aloud included:
  a stock install that has the disk for it clones and emotes. Piper is
  reached only by an explicit ward choice or by the pre-flight check offering
  it on a disk that genuinely cannot hold PocketTTS — never assigned
  silently, and the offer names what is lost, not just what is saved.
- Every §0.7 setting — capability tier, voice engine, voice pick with
  previews, `voiceModelsKeepOnDisable`, current disk use — is reachable and
  changeable from the voice settings surface without touching a file.
- The download consent prompt states a size that matches the bytes actually
  fetched (the figure is read from the fetcher's manifest, not written by
  hand), and a fetch attempted with insufficient free space refuses before
  writing anything — voice stays cleanly disabled with a Settings banner, no
  partial files left behind.
- The Storage view shows every on-disk category with its real size; the
  reclaim buttons appear only on re-fetchable machine artifacts, and no path
  through it can delete a memory, a tome, a graph node, or a kept asset.
  Reclaiming a model and then using voice re-fetches it with a size-named
  prompt rather than failing.

## 14.5 Surface matrix — voice notes (Pass 1, RULE C)

Required by CLAUDE.md RULE C: a turn-machinery capability either lands in code
every surface shares, or the spec carries an explicit matrix in the same commit
as the feature. Vision shipped without one, Discord never got the `describe`
wiring web had, and I confidently described images I had never looked at.

**It lands in the shared path.** `hearVoiceNotes()` in `voice-transcribe.js` is
the single call; both surfaces invoke it and neither owns any transcription
wiring of its own. The worker moved to `audio-worker-current.js` for the same
reason — it used to live inside `server.js`, which is what would have forced
Discord to grow a second copy.

| Cell | Wired | How |
|---|---|---|
| Web live turn (`/api/chat`) | ✅ | `hearVoiceNotes(enrichedMessages, …)` before the vision block and before prompt assembly |
| Web tool rounds | ✅ (N/A by construction) | Attachments are consumed into content at materialize; later rounds carry no un-heard notes |
| Discord ward DM | ✅ | `hearVoiceNotes(apiMessages, …)` in `handleTurn`, same call, same position |
| Discord villager / ambient | ✅ | Same call — but arrival-side ingest of Discord audio is **Pass 3**, so today there is nothing to hear there |
| Background loops (noticing, pondering, triage) | N/A | They assemble no attachments; a loop that starts to must call `hearVoiceNotes` |
| Composer (pre-send) | ✅ | `POST /api/media/:id/transcribe` — same `transcribeAsset`, so it is one decode shared with the turn |

**Deliberately NOT nested inside either surface's vision block.** Hearing is a
separate consent from seeing; nesting it there would mean switching vision off
silently made me deaf as well.

**Budget exhaustion (RULE B).** Every give-up path is visible in all three
places: my human sees it on the composer chip ("I couldn't make this one
out — it still sends"), I see it in the stand-in (each reason has its own
wording — not-yet / switched-off / no-speech / let-go), and it logs. A note
that could not be transcribed is never silently absent; a gap I cannot see is
a gap I confabulate over.

## 14.6 Pass 1 audit (post-shipping)

Ward-requested after the fourth voice-note bug in a row: *"how about you do a
full audit of your work on the voice spec so we don't have to hunt down ten
more small oversights?"* Walking the spec against the source found six live
defects that nobody had hit yet. Recorded because the *pattern* matters more
than the individual fixes.

| Finding | Was |
|---|---|
| Browse-all served `variant: 'original'` | Every voice past the curated ten offered at the muffled quality the enhanced work existed to fix. `preferEnhanced` had no caller. Now `'best'`: one row per voice, enhanced where upstream made one. |
| `saveWardVoice` had no caller | The README promised "a voice clip of your own" with no path through the app. Now `POST /api/voice/ward-voice` + a control in the picker. |
| `measureVoiceClip` used un-imported | Inside a `try/catch`, so the ReferenceError was swallowed and no clip would ever have been measured. Invisible forever. |
| `readAloudByDefault` had zero references | Spec'd in Pass 1. An **accessibility** feature: pressing 🔊 on every message is not an alternative to text, it is a tax on needing one. Barge-in by typing was missing too. |
| Voice notes uncapped per message | Images cap at 4; notes did not. Twenty notes × 24 MB from one message, of which only the newest four would ever be transcribed. |
| `featConfig` omitted from the recogniser | Probably fine (sherpa's C++ defaults are 16000/80) but unverifiable from the installed package, and a zeroed sample rate produces garbage rather than an error. Now stated. |

**The recurring shape, four times in one milestone:** a function written,
tested, documented — and wired to nothing. `installVoice()` was the first;
`saveWardVoice` was the fourth, in the same file. The CLAUDE.md rule ("every
capability must be reachable BY the Familiar") was written for the Familiar's
tools and applies just as hard to the ward's. **A test that a function behaves
is not a test that anything calls it.**

**Known and deliberately left:** `belongsInIdentityBackup()` is documented in
`architecture.md` as governing whether voices survive a restore, and nothing
consults it — Phylactery's backup is Python and never asks. Voices do NOT
currently survive a backup/restore. `reclaimModels()` has no surface either.
Both are recorded here rather than quietly fixed, because they want a decision
about where backup responsibility lives rather than a patch.

## 14.7 What actually shipped, and what it cost

Pass 1 landed, but only after eleven rounds of ward testing. The code defects
were ordinary. What made them expensive was verification, and the details are
recorded in CLAUDE.md's "Recorded VERIFICATION errors" so the next milestone
inherits them rather than repeating them.

**The single most expensive one:** the OPS dispatch table in
`audio-worker.mjs` declared `transcribe` twice — the real handler, and a
leftover Pass-2 placeholder below it. A duplicate key silently wins, so the
real implementation was dead from the day it landed and every voice note
answered `unsupported`. Four rounds went into "fixing" the routing, which had
been correct throughout. `node --check` accepts a duplicate key; every test
stubbed the worker so none loaded the real table; and a test was ASSERTING the
placeholder's response, so the suite defended the bug.

**Shipped surface, for the record:**

| | |
|---|---|
| Recording | `public/voice-recorder.js` — MediaRecorder → `decodeAudioData` → `OfflineAudioContext` → 16 kHz mono wav, capped at 12 min (21.97 MB, inside the 24 MB store cap) |
| Store | `media.js`, `kind:'audio'`, per-kind size caps, duration read from the wav header at arrival |
| Listening | `asr-offline` = SenseVoice int8 2025-09-09, zh/en/ja/ko/yue in one model, pinned (158 MB down / 233 MB unpacked) |
| Routing | `audio-worker-current.js` `listeningWorker()` — always sherpa, independent of which engine SPEAKS |
| Turn wiring | `voice-transcribe.js` `hearVoiceNotes()`, called by both web and Discord turns, outside the vision gate |
| Consent | the button press, plus the browser's own permission prompt. `voiceEnabled` is reserved for CONTINUOUS listening (Pass 2) |
| Reading aloud | per-message 🔊, `readAloudByDefault`, barge-in by button or by typing |
| A ward's own voice | `POST /api/voice/ward-voice` + a control in the picker |

**Guards added because each of these was live:** `npm run audit:wiring` (eight
checks), a pipeline test that spawns the real worker, a derived check that every
failure reason has words for my human, and a duplicate-dispatch-key check.

## 15. Out of scope (this milestone)

- Speech-to-speech or audio-native LLM turns (transcripts ride the
  OpenAI-compatible text surface; an `input_audio` content-part is a future
  materializer extension, per the vision spec's seam).
- Voice **cloning of the ward or villagers** — even though PocketTTS can
  zero-shot clone from reference audio, my voice comes from the curated
  built-in menu only. Cloning a real person's voice is a consent/identity
  question this milestone deliberately does not open.
- Music/media playback, sound-scene tagging, singing.
- Telegram / TeamSpeak / WhatsApp / Mumble adapters (the contract is the
  deliverable here; §3).
- Always-on ambient listening + wake-word summoning (§12 pins it).
- A `listen_again` re-listen tool (transcripts carry the content; revisit
  when audio-native models make re-listening mean something).

## 16. Ward decisions (first review round held — mostly settled)

1. **Threat scoring of ward voice transcripts** — **SETTLED: ON**, with the
   finals-only + ward-stream-only guards. (Ward, spec review 1.)
2. **`voiceGuestPolicy` default** — **SETTLED: `note`**. (Ward, spec
   review 1.)
3. **`voiceEnabled` default OFF** — **SETTLED: OFF for everything that
   listens**, with the read-aloud TTS surface explicitly independent of it
   (§11) so hard-of-hearing wards get a speaking Familiar without opening a
   microphone. (Ward, spec review 1.)
4. **Voice-escalation windows** — **SETTLED: shorter on confirmed spoken
   delivery** (`voiceEscalationFactor` 0.5×, §10). (Ward, spec review 1 —
   this is the sign-off that behavioral change rides on.)
5. **TTS voice** — **SETTLED as a mechanism, not a value:** every bond picks
   its own voice from the curated menu, offered at first enable with
   previews (§6.5). The only project-level choice is the neutral shipped
   fallback that plays before a pick is made — Pass 2 selects that one from
   the bench results, nothing more. (Ward, spec review 3: "each ward will
   want a different voice for their Familiar.")
6. **Voice-note retention** — **SETTLED: keep ~two weeks, then I curate.**
   Audio kept `voiceNoteRetentionDays` (14); a regular retention pass has me
   go through the aged audio myself and decide which sounds to keep, the
   rest dropping to transcript-only (§9). Default ON. (Ward, spec
   review 2.)
