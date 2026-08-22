---
title: Voice
topics: [architecture, voice]
sources:
  - id: voice-build-spec
    type: file
    path: docs/voice-build-spec.md
  - id: architecture-doc
    type: file
    path: docs/architecture.md
  - id: voice-bench-results
    type: file
    path: docs/voice-bench-results.md
  - id: pr-voice-pass-0
    type: file
    path: PR-voice-pass-0.md
  - id: voice-models
    type: file
    path: voice-models.js
  - id: voice-footprint
    type: file
    path: voice-footprint.js
  - id: voice-fetch
    type: file
    path: voice-fetch.js
  - id: voice-extract
    type: file
    path: voice-extract.js
  - id: voice-catalogue
    type: file
    path: voice-catalogue.js
  - id: voice-bench
    type: file
    path: voice-bench.js
  - id: voice-speech
    type: file
    path: voice-speech.js
  - id: voice-generation
    type: file
    path: voice-generation.js
  - id: voice-backend
    type: file
    path: voice-backend.js
  - id: media
    type: file
    path: media.js
  - id: server
    type: file
    path: server.js
  - id: claude-md
    type: file
    path: CLAUDE.md
  - id: audio-worker-current
    type: file
    path: audio-worker-current.js
  - id: app-js
    type: file
    path: public/app.js
  - id: voice-audio-tags
    type: file
    path: voice-audio-tags.js
  - id: voice-tagging
    type: file
    path: voice-tagging.js
  - id: voice-presence-js
    type: file
    path: voice-presence.js
  - id: voice-discord-server-js
    type: file
    path: voice-discord-server.js
  - id: voice-discord-adapter-js
    type: file
    path: voice-discord-adapter.js
  - id: call-engine-js
    type: file
    path: call-engine.js
  - id: discord-gateway-js
    type: file
    path: discord-gateway.js
  - id: village-js
    type: file
    path: village.js
  - id: media-retention-loop
    type: file
    path: media-retention-loop.js
---

# Voice

Voice is its own multi-pass milestone (`docs/voice-build-spec.md`), built as a sequence of
passes rather than one feature, and each pass ships something independently useful rather
than half of a call [@voice-build-spec]. **Pass 0** shipped no speech at all — it is the
measuring pass, and it built the supply chain, the disk-footprint budget, and a benchmark tool
a ward can run themselves to replace the spec's `~` estimates with numbers from their own
machine [@pr-voice-pass-0] [@architecture-doc]. **Pass 1**, built on Pass 0's supply chain,
shipped the first thing that actually speaks: per-message read-aloud text-to-speech
[@architecture-doc]. Later passes have since shipped live conversation and voiceprint enrolment
(Pass 4, through 0.10.102-alpha) [@voice-tagging]; this page documents Pass 0 and Pass 1 in
depth and does not yet cover Pass 2–4 in full. Three later pieces are covered on this page in
their own sections below: group-call presence, speaker naming, and join/leave awareness on the
Discord call path (0.11.8-alpha) [@voice-presence-js]; room-sound tagging
(`voice-tagging.js`, `voice-audio-tags.js`), which ships **annotation-only** by deliberate
design — see [Safety spine](safety-spine)'s deferred-work section for why it stops short of using
room sounds for care detection, and what a future ward-signed spec would need to decide
[@voice-audio-tags]; and a shared-heap decode bug in the `opusscript` Opus decoder that silenced
one Familiar whenever a second one joined the same Discord call, fixed in 0.11.10-alpha
[@voice-discord-adapter-js]; and media retention (Pass 4 §9), the default-on background worker
that curates aged voice-clip sounds without ever touching their transcripts
[@media-retention-loop]. See [Vision and media](vision-and-media) for the sibling
multimodal-input milestone that voice's media storage reuses.

## The footprint budget: disk as an accessibility constraint

§0.7 of the build spec treats disk differently from the compute and latency budgets elsewhere
in the spec: a ward who needs a Familiar most is disproportionately likely to be running it on
a cheap or hand-me-down machine with a nearly-full small SSD, where "free up 3 GB first" is not
a step they can be assumed to complete [@voice-build-spec]. A feature that cannot be installed
is not a feature they have. Bandwidth is explicitly not the binding constraint — a slow
download that finishes is fine — so the budget governs disk, not transfer time
[@voice-build-spec].

The budget splits voice into **two independent axes** rather than one quality ladder:
capability (`read-aloud` / `listening` / `listening-plus` — does the Familiar listen at all)
and voice engine (`pocket` / `piper` — what it sounds like) [@voice-models]
[@architecture-doc]. Collapsing these into one ladder would hand the ward with the smallest
disk the Familiar that sounds least like themselves. **PocketTTS (Kyutai CALM) is the default
at every capability tier, including read-aloud only**, because prosody is treated as part of
identity (§6.5), not a quality setting a poorer ward is quietly downgraded on
[@voice-build-spec]. `piper`/VITS is a fallback the pre-flight check offers, with the exact
megabytes it frees named in the offer, when PocketTTS genuinely will not fit — never assigned
silently [@voice-build-spec].

`evaluatePlan()` in `voice-models.js` checks a composed tier×engine plan against §0.7's
ceilings [@voice-models] [@architecture-doc]. Pass 0's bench measured all six tier×engine
combinations on the reference machine (a ThinkPad X380 Yoga) and found every one inside its
ceiling, with the tightest margin — 132/150 MB — filled by the English ASR decoder
[@voice-bench-results]. The default plan (listening, PocketTTS, English) measures 218 MB
download and 326 MB installed [@voice-bench-results].

## Three numbers that are not the same: download, disk, and peak

Pass 0's benchmark measures three different sizes, and the difference between them is
load-bearing, not pedantic. §0.7's ceilings are checked against **installed disk size**; the
pre-flight free-space check in `voice-footprint.js` is checked against **peak usage**, because
during install an archive and its unpacked copy both exist on disk at once
[@architecture-doc] [@voice-footprint]. Measured on the default plan: a 218 MB download peaks
at 542 MB of free space needed mid-install — two and a half times the download figure
[@voice-bench-results] [@pr-voice-pass-0]. A ward with 600 MB free would have been quoted
218 MB and then run out mid-install, on precisely the machine the budget exists to protect,
if the pre-flight had sized the download instead of the peak [@pr-voice-pass-0].

Archive expansion is not a uniform ratio either — it ranges from 1.00× (Silero VAD, not an
archive) to 2.07× (PocketTTS: 94 MB download, 194 MB on disk) [@voice-bench-results]. This is
why `voice-model-pins.json` records both the download and the on-disk byte count instead of
deriving one from the other — a guessed uniform ratio of "about 1.3×" would have understated
PocketTTS by roughly 100 MB, more than the entire German ASR decoder
[@voice-bench-results] [@pr-voice-pass-0]. One consequence Pass 0 surfaced: PocketTTS looks
cheaper than the English decoder by download size (94 vs 122 MB) but is actually larger on
disk (194 vs 130 MB) — it remains the right default because it fits and matters, not because
it is cheap [@voice-bench-results].

Pass 0's bench also measured the app's total install footprint end-to-end: 393 MB on the
reference machine, of which 389 MB is machine artifacts (voice models, `node_modules`, and —
the largest single cost at 228 MB combined — the [Phylactery](phylactery) and
[Unruh](unruh) Python venvs) and 4.4 MB, about 1%, is the Familiar's own identity, memory, and
graph [@voice-bench-results]. §0.7 was written as though voice were what makes an install
heavy; measurement showed the Python runtimes already cost more than the entire default voice
plan [@voice-bench-results] [@pr-voice-pass-0].

## Module map (Pass 0 — the supply chain and bench)

Five modules, all pure or file-local, none on the chat path [@architecture-doc]:

| module | owns |
|---|---|
| `voice-models.js` | The manifest, tier×engine composition, and `evaluatePlan()` against the §0.7 ceilings. ASR languages are a table with three states (below); `availableAsrLangs()` returns only curated **and** pinned languages, so a menu cannot offer a language that cannot be fetched [@voice-models] [@architecture-doc]. |
| `voice-footprint.js` | Per-category on-disk measurement and the free-space pre-flight. Fails **closed**: unreadable free space refuses a download rather than guessing. Splits re-fetchable MACHINE artifacts from the Familiar's own SELF (memories, tomes, graph, kept media) — only machine artifacts are ever reclaimable in the Storage view [@voice-footprint] [@architecture-doc]. |
| `voice-fetch.js` | Pre-flight → refuse-unpinned → stream-and-hash → verify → content-addressed install. Blobs are stored once and hardlinked, so reclaiming one model can never take a blob another model still needs [@voice-fetch] [@architecture-doc]. |
| `voice-extract.js` | Archive unpacking: verify-then-unpack, two independent path-traversal defences, temp-then-rename so a failed unpack leaves no half-installed directory. `.installed.json` records which archive produced a given model directory [@voice-extract] [@architecture-doc]. |
| `voice-catalogue.js` | Which reference voice clips may ship, and on what licensing terms [@voice-catalogue] [@architecture-doc]. |
| `voice-bench.js` | WER, RTF at one and two streams, TTS time-to-first-chunk, and the §4 interference phase; renders a report to markdown and JSON [@voice-bench] [@architecture-doc]. |
| `voice-bench-run.js` | Start/poll/cancel state machine for a benchmark run that takes minutes; plain-language `STAGE_LABELS` a ward reads while waiting [@architecture-doc] [@pr-voice-pass-0]. |

Ward-facing surface: a **Voice benchmark** button under Settings → Debug, and
`scripts/voice-bench.mjs` as a CLI wrapper calling the identical `voice-bench.js` core, so a
developer's run and a ward's run produce the same report from the same code
[@pr-voice-pass-0]. `POST /api/diagnostics/voice-bench` starts a run, `GET
/api/diagnostics/voice-bench` polls it, and `/cancel`/`/reset` variants stop or clear one
[@server]. `GET /api/voice/plan` and `GET /api/voice/footprint` expose the composed plan and
measured footprint to the settings UI [@server].

## The three-way supply chain (§0.8)

Voice ships through three different mechanisms depending on what the artifact is
[@architecture-doc]:

1. **The engine binding is code, vendored via npm.** `sherpa-onnx-node` is an
   `optionalDependency`; npm resolves one platform-specific binary per ward at install time
   [@voice-build-spec] [@architecture-doc].
2. **Models are fetched on first enable, from pinned URLs with a sha256 hash.** `voice-fetch.js`
   refuses to fetch anything not already pinned [@voice-fetch]. Pins are **machine-written,
   never typed**: `scripts/pin-audio-models.mjs` downloads a candidate, hashes it in flight,
   and — for archives — unpacks it to record the disk size it actually occupies, writing the
   result to `voice-model-pins.json` [@architecture-doc]. `applyPins()` accepts only whole
   records (an `https` URL, a 64-hex sha256, a positive byte count), so a half-pin can never
   become a fetchable model — the [exact-values rule](../decisions/exact-values-in-code) made
   structural: there is no line of source code for anyone to type a hash into
   [@architecture-doc].
3. **Bench fixtures are vendored in-tree**, so WER is comparable across wards' hardware rather
   than depending on whatever audio happened to be fetched [@voice-build-spec]
   [@architecture-doc].

Upstream ships every model as `.tar.bz2`; two small pure-JS dependencies, `tar` and
`unbzip2-stream`, were added because Node has no built-in bzip2 support
[@pr-voice-pass-0].

## Licensing and ward-supplied clips

**Licensing is enforced in code, not remembered.** `shippableSources()` in `voice-catalogue.js`
gates on each source's licence field, so a non-commercial source (Expresso, EARS) structurally
cannot reach the shipped set of a GPL distribution [@voice-catalogue] [@architecture-doc].
Rejected sources stay listed with their rejection reasons, so a future maintainer does not
rediscover and re-litigate them; the NOTICE text is generated from the catalogue rather than
hand-maintained, so a credit cannot be silently dropped by editing prose
[@pr-voice-pass-0] [@architecture-doc].

Ward-supplied voice clips are allowed and treated as personal use — PocketTTS clones zero-shot
from roughly a 10-second reference clip, so a ward can use a voice that means something to
them [@architecture-doc]. Two functions answer two **orthogonal** questions about such a clip:
`mayLeaveTheMachine()` fails closed, so a ward-supplied clip never rides out in a diagnostic,
bench report, or any shared surface; `belongsInIdentityBackup()` is true for every voice
regardless of source, because a restored Familiar that comes back sounding like a stranger is a
continuity break [@voice-catalogue] [@architecture-doc]. Backup includes precisely what sharing
excludes, and a test asserts the two functions diverge [@pr-voice-pass-0].

## Three language states, not two

`voice-models.js` tracks ASR languages in a table with three distinct states: not in the table
(unsupported, and reported as such), in the table but unpinned (curated as a future candidate,
never offered to a ward), and in the table and pinned (offered) [@pr-voice-pass-0]
[@voice-models]. `availableAsrLangs()` returns only the third state, so a settings menu cannot
offer a language it cannot actually fetch [@architecture-doc]. English is the default language;
nothing else is fetched unless a ward asks for it. As of Pass 0, French, Korean, and Chinese are
curated but unpinned, and correctly not offered [@pr-voice-pass-0].

## The interference budget: why §14's acceptance bar was rewritten

§4 of the build spec argues that a live call must not starve the rest of the Familiar's
cognition — a concurrent text-chat turn's `enrich()` call into
[Phylactery](phylactery) and [Unruh](unruh) has to stay fast even while audio is being
processed [@voice-build-spec]. Pass 0 measured the **quiet baseline** for that call — a real
`mem_search` through the live thalamus — at 39 ms median, 40 ms p90 over 12 samples on the
reference machine [@voice-bench-results]. That measurement is well inside §4.4's 1200 ms soft
latency budget, but it also broke the acceptance criterion §14 had been written against
[@pr-voice-pass-0].

The original §14 bar was a flat "±20% of normal." Against a 39 ms baseline that is an
approximately 8 ms window: a test that fails on timing shifts nobody could perceive, and one
that gets *harder* to pass the faster the machine already is — a bar that punishes a good
baseline is measuring the wrong thing [@voice-bench-results] [@pr-voice-pass-0]. §14 now uses
`interferenceBudgetMs(quietMedianMs)` in `voice-bench.js`, defined as the more generous of two
ideas: stay under an absolute 250 ms (below which an enrichment read is imperceptible inside a
turn already waiting on a network LLM call), or stay under the baseline plus 20% with a 25 ms
floor, for a machine already slower than that [@voice-bench] [@voice-build-spec]. The bench
report names which half of the formula was binding for a given run, because "you stayed
imperceptible" and "you did not make a slow machine worse" are different claims
[@voice-build-spec]. This is a case of the wiki's general evidence principle in miniature: a
spec-stage acceptance number was an estimate, and the first real measurement, not further
argument, is what corrected it.

## Two bugs Pass 0 found by running the pipeline, not by unit-testing it

Both bugs surfaced only once the pipeline ran against a real content-addressed store and a
real disk, and neither was reachable from a pure-function test:

- **Archive kind was read from the blob's path.** Blobs are content-addressed, so a path like
  `blobs/9e/9e27b78…` carries no file extension, and every archive looked like a plain file
  until the naming diverged inside the real content-addressed store [@pr-voice-pass-0].
- **The pre-flight sized the download, not the peak.** Left uncorrected, it would have started
  fetches that could not finish, on precisely the nearly-full machines the footprint budget
  exists to protect [@pr-voice-pass-0].

Both are named in the PR as the pipeline-test discipline in CLAUDE.md's 0.9 vision
post-mortem being paid again — pure-function tests structurally cannot catch orchestration bugs
that only exist once real assembly code runs end to end [@claude-md] [@pr-voice-pass-0]. Pass
0's 133 tests across seven files include real `.tar.bz2` fixtures built at test time (not
mocks), a live local HTTP origin exercising the fetcher's streaming and hashing path, an
asserted path-traversal attack that writes nothing outside the destination, and pipeline tests
that run through the real benchmark-run manager [@pr-voice-pass-0].

## Cancelling a benchmark writes nothing

A benchmark run can be cancelled mid-flight; `voice-bench-run.js` guarantees a cancelled run
writes no report, on the reasoning that a half-measured report that looks whole is worse than
no report [@pr-voice-pass-0]. Conversely, a completed report is saved to `logs/` **before**
the run state flips to done, so closing the browser window can never lose a run a ward waited
several minutes for [@pr-voice-pass-0].

## Pass 1: read-aloud, and why it took four attempts

Read-aloud text-to-speech runs as a **two-step HTTP flow** so planning what to say and paying
to generate the audio are separated [@architecture-doc]:

| endpoint | cost | what it does |
|---|---|---|
| `POST /api/voice/speech-plan` | none | markdown → speakable text, returns a short-lived `say-xxxxxx` id |
| `GET /api/voice/tts/:id` | a model + generation | streams a wav from ONE generation |

The browser gets the full shape of a message immediately, then points an `<audio>` element at
the streaming URL. Responsiveness comes from **streaming out of a single generation call**,
never from splitting a message into pieces and generating each separately — the build spec
calls that distinction the entire Pass 1 story [@architecture-doc].

Four distinct bugs surfaced while building Pass 1, each initially mistaken for the previous
fix having failed [@architecture-doc]:

1. **No seed.** PocketTTS re-seeds its sampler per sentence inside one `generate` call, and
   upstream's default seed is `-1` (random every time), so three sentences of one reply came
   out as three different-sounding speakers. The seed lives in an untyped `extra` map absent
   from the JS typedefs — only the C++ header documents it. `voice-generation.js` now fixes
   the seed and refuses `-1` rather than forwarding "surprise me" [@voice-generation]
   [@architecture-doc].
2. **The runt fragment.** Upstream's `SplitLongSentence` splits at a max character length and
   drops the remainder into its own chunk, after sentence-merging has already run, so the
   remainder never gets merged back in. A 205-character sentence produced a final chunk of a
   single word, which hit end-of-stream at generation step 0 — a case upstream's `eos_step > 0`
   check never handles — running the model's full frame budget as up to 40 seconds of
   degenerating noise. Fixed by raising the split thresholds and adding a minimum piece size,
   plus a `runawaySampleLimit` safety clamp as containment [@architecture-doc].
3. **The reference recording.** Kyutai's upstream documentation notes that the reference
   clip's own audio quality is reproduced in the output; the voice picker defaulted to the
   `original` VCTK recording instead of the `_enhanced` one Kyutai uses for every built-in
   voice. Measured: same pitch and duration, roughly 23% more high-frequency energy in the
   enhanced version. The bundled clip is now the enhanced one [@architecture-doc].
4. **LM state resets per utterance.** Upstream's `GenerateSingleSentence` reinitializes
   language-model state at the start of each call; merging sentences into larger chunks makes
   resets rarer (drift moved from per-sentence to per-paragraph) but the ported engine offers
   no way to carry a generation trajectory across an entire call — that gap is what the
   Python sidecar backend exists to close [@architecture-doc].

### Two backends, one framed protocol

`voice-backend.js` chooses which process actually speaks. Both backends speak the same framed
stdio protocol defined in `audio-frame.js`, so `audio-worker-host.js` supervises either one
identically — parking, backoff, and idle unload were written once rather than per backend
[@voice-backend] [@architecture-doc]:

| | `sherpa` (default) | `pocket` (opt-in) |
|---|---|---|
| worker process | `audio-worker.mjs` | `voicebox/` (Python) |
| install cost | ships with the app; ~216 MB | ~600 MB installed |
| model | `2026-01` (the only ONNX export available) | `english_2026-04` |
| continuity across turns | resets per utterance | `copy_state=False` carries the KV cache forward |

`sherpa` stays the default because 600 MB is real cost on the hardware this project targets.
Choosing `pocket` without it installed falls back to `sherpa` and says so — in the log and on
`GET /api/voice/status` — carrying the exact command that fixes it [@architecture-doc]
[@server]. The `pocket` worker is built on first use rather than at boot, because voice engine
is a per-ward setting, not a fixed install; the running engine is stopped before a new one
starts so two engines never hold models in memory at once [@architecture-doc]. Installation is
`node scripts/ensure-voicebox.mjs --install`, deliberately **not** wired into the prestart
hook the way [Phylactery](phylactery) is — unlike Phylactery, `pocket` is optional, and
downloading 600 MB because someone ran `npm start` would be hostile on a nearly-full laptop
[@architecture-doc].

### Reliability: pocket falling back to sherpa instead of going silent

A pocket install can have every file in place and still fail to speak, because `inspectBackends` only checks that the venv's interpreter and worker files exist — it reports pocket "available" even when torch cannot actually be imported, so the ordinary reinstall path never fires for a present-but-broken install [@voice-backend]. The most common cause on Windows is an environment gap, not a code bug: torch's Windows wheels are built against the Microsoft Visual C++ runtime, and `uv`'s standalone Python does not ship it the way conda does (astral-sh/uv#18413) [@voice-backend]. A developer's machine usually already has the redistributable from other software; a ward's clean machine does not, so torch's `c10.dll` cannot load its dependency and torch import fails with `OSError: [WinError 126]` — "same hardware, mine works, theirs doesn't" [@voice-backend].

The fix revealed a Windows-specific loader detail: on Python 3.8+, a native DLL's own dependencies (such as the runtime DLLs that `c10.dll` needs) are searched only in the DLL's own directory, in `os.add_dll_directory` folders, and in the system paths — never on `PATH` or in `sys.prefix` [@voice-backend]. Installing `msvc-runtime` to `sys.prefix/Scripts` (where the wheel places its DLLs) therefore does nothing for torch, which loads `c10.dll` from `torch/lib` and searches only within that folder and registered directories for its dependencies [@voice-backend].

Three layers close this gap, from prevention to graceful degradation:

- **`ensureWindowsMsvcRuntime` (`voice-backend.js`) installs the runtime and copies it to the right place** instead of sending the ward to Microsoft: it installs cgohlke's `msvc-runtime` wheel into the voicebox venv (to acquire the DLLs), then calls `placeMsvcRuntimeBesideTorch` to copy those DLLs into `torch/lib` where the native loader actually searches — no admin rights and no system-wide redistributable needed [@voice-backend]. It runs from every install/repair path (`ensure-voicebox.mjs`, the first-use auto-install it shells out to, and `rebuildVoicebox`) [@voice-backend]. It is best-effort: `msvc-runtime` only ships wheels for Python 3.11+, so on an older interpreter it logs and moves on rather than failing the install, and it is a no-op off Windows [@voice-backend]. The official `vc_redist` download is now only the last-resort hint shown after this automatic fix has already been tried.
- **"Fix Kyutai" (`rebuildVoicebox` in `voice-backend.js`, `POST /api/voice/fix-kyutai`) repairs a present-but-broken install.** It stops the audio worker first (so Windows can delete the venv's `python.exe`, which a running worker holds open), deletes the venv, runs `uv sync --reinstall`, calls `ensureWindowsMsvcRuntime`, and then proves `import torch` actually works before declaring success — never trusting file presence the way `inspectBackends` does [@voice-backend]. It runs as a background job (started + polled), mirroring the shape of the sidecar-install flow.
- **`currentAudioWorker` (`audio-worker-current.js`) falls back to sherpa at runtime instead of answering `no-engine` and going silent.** The first time a pocket worker is built, `currentAudioWorker` verifies it actually loads with one `ping` — which runs the torch import and model load, so the check doubles as a warm-up — and if that fails, it rebuilds transparently on the built-in sherpa engine (which needs no torch and always ships) and tags the result `fellBackFrom: 'pocket'` [@audio-worker-current]. Every speaking surface (web read-aloud, Discord, voice call) calls through this one seam, so all of them get a working voice without individually knowing pocket failed. The verdict is cached in a module-level `pocketBroken` flag so a known-bad pocket install is not re-verified and respawned on every turn, and `stopAudioWorker` clears that cache so a Fix Kyutai repair gets a fresh verification instead of a permanent demotion [@audio-worker-current]. A test hook, `__setVoiceTestHooks`, injects a fake resolver and worker builder so the fallback path can be exercised without spawning real processes [@audio-worker-current]. Net effect: a missing Visual C++ runtime now costs a *lesser voice*, not silence.

The Fix Kyutai button itself surfaced a general [Update](update) gap: a ward who updated the files but had not restarted the server saw the new button 404, because Express routes are registered at boot while static assets refresh live. `public/app.js` now recognizes that 404 shape and tells the ward to restart rather than showing a cryptic error [@app-js] — see [Update](update)'s two-speed-updates section for the mechanism, which applies to any future endpoint, not just this one.

### Voice settings: speed and expressiveness differ by engine

`voiceTts.speed` and `voiceTts.temperature` are ward-tunable under Settings → Chat → Voice, consolidated there along with the rest of voice settings (only the Voice benchmark stays in Diagnostics). The two engines honour them differently, and the UI says so rather than shipping a control that silently no-ops for one engine [@voice-backend]:

- **sherpa** takes both `speed` and `temperature` per request.
- **pocket** has no speed control at all — `generate_audio_stream` accepts none, and the setting is reported `unsupported` for that engine — and bakes `temperature` in at model-load time rather than per request [@voice-backend]. `resolveBackend` threads the chosen temperature into the pocket worker's spawn environment as `PF_TTS_TEMPERATURE` [@voice-backend]. Because that value is fixed at load time, `currentAudioWorker` compares the spawn environment of the resolved backend against the running worker's and respawns the worker whenever it differs, rather than reusing a stale process — which is why changing expressiveness takes effect on the *next* spoken message, not mid-utterance [@audio-worker-current].

The installers provision voice on a fresh install (Kyutai, the Windows runtime fix, and the listening models), skippable with `PF_SKIP_VOICE_INSTALL=1`, with every step non-fatal so a failed step degrades rather than aborting the install.

### Text preparation and media storage

`voice-speech.js` turns markdown written to be read into text meant to be heard — spoken
verbatim, markdown syntax becomes "asterisk asterisk careful asterisk asterisk," so the
translation is deliberately lossy [@voice-speech] [@architecture-doc]. Code blocks are
summarized (for example, "(py code block, 4 lines)") rather than spelled out character by
character. An LLM-emitted `[HH:MM]` timestamp is stripped before speech, the same
[exact-values rule](../decisions/exact-values-in-code) enforced elsewhere: speaking a
fabricated time asserts it as real [@voice-speech] [@architecture-doc]. Curly quotes and
ellipses are normalized to plain ASCII, because the TTS tokenizer's 4000-token vocabulary
contains no token for them, and an un-normalized apostrophe falls back to three rarely-seen
byte-level tokens [@architecture-doc].

`media.js`, the same content-addressed store the vision milestone built for images (see
[Vision and media](vision-and-media)), now holds audio as well. `MEDIA_KINDS` derives kind and
file extension from one shared lookup table, so a voice note can no longer be stored as an
image carrying an audio file extension, and the audience tag, dedup, and slug-id machinery
built for images cover voice notes for free [@media] [@architecture-doc].

## Group-call presence, speaker names, and join/leave (0.11.8-alpha)

A live Discord voice call can hold more than the ward, and the call path did not originally
account for that: transcripts arrived as a flat wall of unattributed `user` turns tagged with raw
Discord snowflakes the model cannot tell apart, and nothing told the Familiar who was present or
who had joined or left [@voice-presence-js]. Three fixes, layered on top of the live-conversation
call path, close this gap without touching audience gating, threat scoring, or what gets stored
at each clearance [@voice-presence-js].

**Names now resolve.** `nameForVoiceUser()` in `discord-gateway.js` previously special-cased only
the ward and returned a literal `user-<snowflake>` for anyone else, even though Discord's own
`member.user` payload arrives on every `VOICE_STATE_UPDATE` and `GUILD_CREATE` event
[@discord-gateway-js]. A module-level `gw.userInfo` cache, seeded from `GUILD_CREATE` members and
each voice state's `member`, and kept current on `VOICE_STATE_UPDATE`, now backs name resolution:
the ward's configured name, then a cached Discord display name, then a short `guest-xxxxxx` tag
only when Discord has not named the user yet [@discord-gateway-js]. `village.js`'s existing
`findVillagerByAlias()` was split so a pure `villagerByAlias(reg, {platform, id})` can run against
an already-loaded registry [@village-js]. This lets the roster builder resolve many ids from one
registry read, where a registered villager's own name always outranks the raw Discord display
name.

**Speaker labels reach the turn, not just the memory write.** `voice-presence.js` is a new pure
module: `isGroupCall(roster)` is true once 2 or more humans share the call, and only then does
`attributeSpeaker()` return a label; `prefixTurn(label, text)` prepends `"Name: "` to a turn only
when a label exists, so a solo call's transcript stays byte-identical to before
[@voice-presence-js]. In a group call every turn is labelled, the ward's own turns included — a
ward decision, made so the model can tell the ward's turns apart from a villager's rather than
inferring it from context [@voice-presence-js]. `attributeSpeaker()` gained an `isWard` parameter
(0.11.18) that appends a `(WARD)` marker to the ward's own group-call label (`"Zara (WARD)"`, not
just `"Zara"`), after a live report that the Familiar kept reading the ward's words as its own or
a villager's; the same disambiguation, `attributeUserContent()` in `discord-gateway.js`, covers
multi-party **text** rooms — a villager's guild turn is prefixed `[Name]:`, the ward's is
`[Name (WARD)]:`, and a one-on-one ward DM stays unprefixed, since there is only the two of them
to tell apart [@voice-presence-js] [@discord-gateway-js]. `voice-discord-server.js` wires this into
`runTurn()`: it resolves the speaker's name, computes `isGroupCall(roster)`, and prefixes the
transcript before it reaches the model, while the memory write for the turn still carries the
speaker as its own structured field rather than folding it into the text [@voice-discord-server-js].

**A presence signal now exists.** `call-engine.js`'s `rosterChanged` hook used to be a dead
no-op stub with a comment that Pass 3 would consume it [@call-engine-js]. `voice-discord-adapter.js`
now calls it from `onVoiceStateChange()` whenever a user's presence in the call's channel flips
[@voice-discord-adapter-js]. `voice-presence.js`'s `diffRoster()` compares the previous and next
id lists to find who joined and left, and `formatPresenceNote()` renders a first-person "who's
here / who just joined or left" line — returning `null` for a solo call with no change, so a quiet
moment stays quiet [@voice-presence-js]. Like the room-sound tagging note covered in
[Safety spine](safety-spine)'s deferred-work section, this presence note is **annotation only**:
it is never stored, never moves the threat tier, and never touches the audience gate described in
[Content-Based Memory Gating](content-gating) — it only changes what the Familiar reads about who
is in the room [@voice-presence-js].

**A proactive spoken greeting rides the existing quiet-gap mechanism.** `greetArrival()` in
`voice-discord-server.js` builds a short greeting via `voice-presence.js`'s
`buildGreetingPrompt()`/`parseGreeting()` and speaks it through the call engine's existing
`speakProactive()`, which only fires at the next `PROACTIVE_QUIET_MS` gap with nobody already
speaking [@voice-discord-server-js] [@call-engine-js]. Riding that existing mechanism gets "never
talk over a mid-sentence join" for free, without a bespoke wait-for-quiet implementation. The
greeting prompt is deliberately leak-free — it names only the arriving person and the join/leave
event, no memory recall — because the line is spoken aloud to the whole channel at any clearance
[@voice-presence-js]. It is deduped per stay (a rejoin clears the dedup so a second arrival gets
greeted again), stands down entirely at moderate-or-higher threat because triage owns distress
moments, is never offered to the ward's own presence (the call itself is not a guest to greet),
and is recorded into call history once actually spoken so the Familiar does not repeat it
[@voice-discord-server-js].

This work is scoped to the Discord voice call path, where raw snowflakes and multi-human calls
occur; the web call path already diarizes named guests and did not need the fix
[@voice-presence-js]. Settings: `voiceProactiveGreetings` (default on). Off-switches:
`PROTO_FAMILIAR_VOICE_PRESENCE_DISABLED=1` reverts the whole layer to the old unlabelled
transcript, and `PROTO_FAMILIAR_VOICE_GREETINGS_DISABLED=1` silences only the spoken hello
[@voice-presence-js].

## Two Familiars in one call: the opusscript shared-heap decode bug (0.11.9–0.11.10)

A live test with two Familiars in the same Discord voice call left one of them silent, with
the terminal flooded by `opus decode failed for <speaker>: memory access out of bounds`
[@voice-discord-adapter-js]. The root cause is a property of the `opusscript` WASM binding,
not of this repo's code: `opusscript` keeps **one** emscripten heap shared across every
`OpusScript` decoder instance and caches its heap views (`inOpus`/`outPCM`) at construction
time. `voice-discord-adapter.js` allocates one decoder per speaker (`ensureSpeaker()`), so a
second speaker joining the call allocates a second decoder — and if that allocation grows the
shared heap, every already-existing decoder's cached views detach, so the first speaker's
decoder throws "memory access out of bounds" on its very next packet [@voice-discord-adapter-js].
This is why the ward's own Familiar went quiet the instant a second one joined the call: the
newcomer's decoder allocation, not anything about the newcomer's audio, broke the existing one.

The first attempt at a fix (0.11.9-alpha) treated the symptom instead of the cause: it added a
`shouldHear(userId)` loop guard mirroring the text path's `author.bot` + `readBots` check, so a
second bot's audio was never subscribed or decoded at all, plus a five-consecutive-failure
teardown as a blunt self-heal. That shipped, then was reverted one commit later
[@voice-discord-adapter-js] — the goal is two Familiars *hearing* each other, so skipping a
second bot's audio sidesteps the bug rather than fixing it, and the underlying decoder still
wedges for any two-decoder roster, bot or human.

0.11.10-alpha replaces both with a fix at the actual fault line. `decodeOpus(entry, speakerRef,
opusPacket)` in `voice-discord-adapter.js` tries the existing decoder first; on a throw, it
deletes that decoder, calls `deps.makeOpusDecoder()` again to get a fresh instance with views
bound to the *current* heap, and retries the same packet once — no audio is lost, and the
subscription stays open throughout [@voice-discord-adapter-js]. Once the roster stops changing,
the heap stops growing and no more rebuilds happen; a packet that fails even the rebuilt decoder
is a genuinely bad packet, not a heap issue, and is skipped with a per-speaker rate-limited log
line rather than flooding the terminal on every subsequent packet [@voice-discord-adapter-js]. A
separate, unrelated guard — `MAX_OPUS_PACKET = 3828` bytes, opusscript's WASM input buffer size
— drops any packet too large to decode before it can overflow `inOpus.set(buffer)`; normal voice
frames are well under 1 KB, so this is a defensive floor, not the fix for the silence bug
[@voice-discord-adapter-js]. The `shouldHear` loop guard and the gateway's per-user bot-flag
cache from 0.11.9 were both reverted along with the old fail-counting teardown: with the real bug
fixed, filtering out other bots is no longer needed, and **all speakers, including other bots,
are decoded** — two Familiars conversing by voice over Discord is supported
[@voice-discord-adapter-js].

## Media retention: curating aged voice clips (Pass 4 §9)

§9 of the build spec is the other later piece this page covers: `media-retention-loop.js` (see
[Autonomous loops](autonomous-loops)) is a default-on, ~6-hour-tick background worker that
decides whether an old voice clip's SOUND is worth keeping, never whether the conversation is
[@media-retention-loop]. Code gates pick candidates first — audio past
`voiceNoteRetentionDays` (default 14), not already stripped, not flagged `keep`, and carrying a
transcript — then one batched LLM judgment per tick names which sounds to keep; everything else
goes through `media.stripAudio`, which deletes only the bytes: the transcript, metadata, and
slugs survive, and a stand-in renders `[audio let go — transcript kept]` wherever the clip used
to play [@media-retention-loop]. The transcript always surviving is the load-bearing property —
it means a wrong "let go" costs disk, not memory, so the loop can run unattended. It fails soft
in the same spirit: an LLM error or an unparseable response keeps *everything* that pass, because
`parseKeepRefs` returns `null` on no-JSON, a state the loop deliberately treats as distinct from
a valid "keep none" [@media-retention-loop]. Like the noticing loop, it stands down during a live
call and at moderate-or-higher threat — curation can always wait for a calmer tick.

## What Pass 0 flagged for later passes

Three findings from Pass 0's measurement are not solved by Pass 0 and are named as open
questions for the passes that follow [@pr-voice-pass-0]:

- **The Python runtimes, not voice, are the largest cost on disk** — 173 MB for Phylactery's
  venv plus 55 MB for Unruh's, together larger than the entire default voice plan. §0.7 was
  written as though voice were what makes an install heavy; measurement says otherwise, and if
  disk is genuinely an access barrier the next look belongs at the Python venvs.
- **PocketTTS may be English-only.** Upstream ships and documents it as English; `voice-models.js`
  records its language as `'en'` rather than `'multi'` until measured otherwise. If it turns
  out to be English-only, "expressive voice at every tier" quietly stops being true for a
  German-speaking ward — flagged as worth resolving before the voice menu was wired (Pass 1
  wired read-aloud without yet resolving this).
- **`piper`'s fallback now has an exact number**: choosing it over PocketTTS saves 154 MB of
  disk and cuts peak install requirement by 248 MB. §0.7 requires that a cost-bearing offer
  name what it costs; Pass 0's recommendation was that the offer quote this figure rather than
  say "smaller."

## Where to go next

- [ONNX Runtime: shared budget, not shared process](../decisions/onnx-runtime-shared-budget) —
  why the audio worker and Phylactery's embedder stay in separate processes with static thread
  caps instead of one shared ONNX Runtime instance, and the two rejected alternatives.
- [Phylactery](phylactery) and [Unruh](unruh) — the two Python services whose venvs turned out
  to be the largest disk cost measured in Pass 0.
- [Vision and media](vision-and-media) — the sibling multimodal-input milestone whose
  content-addressed media store (`media.js`) Pass 1 extended to cover audio.
- [Exact values are code's job](../decisions/exact-values-in-code) — the general rule that
  voice's machine-written pins, stripped LLM timestamps, and manifest-sourced download-size
  copy are all specific applications of.
- [Update](update) — the self-update mechanism whose static-assets-vs-registered-routes gap
  produced the "Fix Kyutai" 404 incident above, and applies to any future endpoint the same way.
- [Safety spine](safety-spine) — why Pass 4's room-sound tagging is annotation-only, and the
  ward decisions a future care-detection spec would need to answer; the same annotation-only
  discipline shapes the group-call presence note above.
- [Content-Based Memory Gating](content-gating) — the audience-gate and content-tag machinery
  group-call presence deliberately leaves untouched.
- [Autonomous loops](autonomous-loops) — where media retention sits alongside the rest of the
  loop set, and the shared off-switch/degradation contract it follows.
